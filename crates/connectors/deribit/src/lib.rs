//! Deribit public market data (P05) — free, no API key, JSON-RPC 2.0 over WebSocket.
//!
//! * Socket `wss://www.deribit.com/ws/api/v2`: `public/set_heartbeat` (30 s; every
//!   `test_request` is answered with `public/test`), then `trades.<inst>.100ms`,
//!   `book.<inst>.100ms` and `ticker.<inst>.100ms`.
//! * Book: a `snapshot` resets; every `change` must carry `prev_change_id == last change_id`.
//!   Older ids are duplicates; anything else is a gap → re-subscribe the book channel (Deribit
//!   then sends a fresh snapshot). Levels are `[action, price, amount]` (`new`/`change`/`delete`).
//! * Trades carry the taker `direction`; a `liquidation` flag (`M` maker, `T` taker, `MT` both)
//!   also produces a normalised liquidation. The ticker gives funding (`funding_8h`), open
//!   interest and mark price; it is throttled to one stats update per second.
//! * Sizes stay in Deribit `amount` units (USD for inverse perpetuals/futures, base currency
//!   for linear USDC contracts and options).
//! * REST: instrument, order book, trades by time range (paged), server time, and the options
//!   chain (instruments + book summary with mark IV) for `@htflow/options`.
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use htflow_connector_common::{
    driver, f64_ticks, hash_id, num_f64, Action, BookLevels, ClockSkew, ConnectorError, Kline,
    L2Book, MarketApi, Ping, Protocol, Rest, Result, StreamConfig, SymbolSpec, TokenBucket,
};
use htflow_core_types::{
    decimals_of, Aggressor, BookSnapshot, MarketEvent, MarketStat, Side, TickSize, Trade,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

pub mod klines;

pub const REST_BASE: &str = "https://www.deribit.com";
pub const WS_URL: &str = "wss://www.deribit.com/ws/api/v2";
const STATS_EVERY_NS: i64 = 1_000_000_000;

mod wire {
    use serde::Deserialize;
    use serde_json::Value;

    #[derive(Debug, Deserialize)]
    pub struct RpcError {
        pub code: i64,
        pub message: String,
    }

    #[derive(Debug, Deserialize)]
    pub struct Rpc<T> {
        pub result: Option<T>,
        pub error: Option<RpcError>,
    }

    #[derive(Debug, Deserialize)]
    pub struct Instrument {
        pub instrument_name: String,
        pub tick_size: f64,
        #[serde(default)]
        pub min_trade_amount: f64,
        #[serde(default)]
        pub kind: String,
        #[serde(default)]
        pub strike: Option<f64>,
        #[serde(default)]
        pub option_type: Option<String>,
        #[serde(default)]
        pub expiration_timestamp: i64,
        #[serde(default)]
        pub is_active: Option<bool>,
    }

    #[derive(Debug, Deserialize)]
    pub struct TradeRow {
        pub trade_id: String,
        pub timestamp: i64,
        pub price: f64,
        pub amount: f64,
        pub direction: String,
        #[serde(default)]
        pub liquidation: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    pub struct Trades {
        pub trades: Vec<TradeRow>,
        #[serde(default)]
        pub has_more: bool,
    }

    #[derive(Debug, Deserialize)]
    pub struct Book {
        pub bids: Vec<Vec<Value>>,
        pub asks: Vec<Vec<Value>>,
    }

    #[derive(Debug, Deserialize)]
    pub struct BookSummary {
        pub instrument_name: String,
        #[serde(default)]
        pub bid_price: Option<f64>,
        #[serde(default)]
        pub ask_price: Option<f64>,
        #[serde(default)]
        pub mark_price: Option<f64>,
        #[serde(default)]
        pub mark_iv: Option<f64>,
        #[serde(default)]
        pub underlying_price: Option<f64>,
        #[serde(default)]
        pub open_interest: Option<f64>,
        #[serde(default)]
        pub volume: Option<f64>,
    }
}

fn tick_of(t: f64) -> Result<TickSize> {
    Ok(TickSize::parse(&format!("{t}"))?)
}

fn spec_from(i: &wire::Instrument) -> Result<SymbolSpec> {
    Ok(SymbolSpec::new(
        i.instrument_name.clone(),
        tick_of(i.tick_size)?,
        decimals_of(&format!("{}", i.min_trade_amount)),
    ))
}

fn trade(spec: &SymbolSpec, r: &wire::TradeRow, local_ns: Option<i64>) -> Result<Trade> {
    Ok(Trade {
        exchange_ts_ns: r.timestamp * 1_000_000,
        local_ts_ns: local_ns.unwrap_or(r.timestamp * 1_000_000),
        px: f64_ticks(&spec.tick, r.price)?,
        qty: r.amount,
        aggressor: match r.direction.as_str() {
            "buy" => Aggressor::Buy,
            "sell" => Aggressor::Sell,
            _ => Aggressor::Unknown,
        },
        trade_id: hash_id(&r.trade_id),
    })
}

/// Liquidations hidden in a trade's `liquidation` flag: `T` = the taker order was a
/// liquidation (its side is the trade direction), `M` = the maker order was (opposite side).
fn liquidations(spec: &SymbolSpec, r: &wire::TradeRow) -> Result<Vec<MarketStat>> {
    let Some(flag) = &r.liquidation else {
        return Ok(Vec::new());
    };
    let taker = if r.direction == "buy" {
        Side::Buy
    } else {
        Side::Sell
    };
    let maker = if taker == Side::Buy {
        Side::Sell
    } else {
        Side::Buy
    };
    let px = f64_ticks(&spec.tick, r.price)?;
    Ok(flag
        .chars()
        .filter_map(|c| match c {
            'T' => Some(taker),
            'M' => Some(maker),
            _ => None,
        })
        .map(|side| MarketStat::Liquidation {
            ts_ns: r.timestamp * 1_000_000,
            side,
            px,
            qty: r.amount,
        })
        .collect())
}

// ------------------------------------------------------------------ protocol

pub struct DeribitProtocol {
    spec: SymbolSpec,
    book: L2Book,
    last_change: Option<u64>,
    last_stats_ns: i64,
    pub gaps: u64,
}

impl DeribitProtocol {
    pub fn new(spec: SymbolSpec) -> Self {
        Self {
            spec,
            book: L2Book::default(),
            last_change: None,
            last_stats_ns: 0,
            gaps: 0,
        }
    }

    fn book_channel(&self) -> String {
        format!("book.{}.100ms", self.spec.symbol)
    }

    fn rpc(id: u64, method: &str, params: Value) -> String {
        json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string()
    }

    fn apply_levels(
        &mut self,
        side: Side,
        rows: &[Vec<Value>],
    ) -> Result<Vec<htflow_core_types::BookDelta>> {
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let action = r.first().and_then(Value::as_str).unwrap_or("change");
            let px = r
                .get(1)
                .and_then(num_f64)
                .ok_or_else(|| ConnectorError::Other("bad book level".into()))?;
            let qty = if action == "delete" {
                0.0
            } else {
                r.get(2).and_then(num_f64).unwrap_or(0.0)
            };
            out.push(
                self.book
                    .set(side, f64_ticks(&self.spec.tick, px)?, qty, None),
            );
        }
        Ok(out)
    }

    fn on_book(&mut self, d: &Value, local_ns: i64) -> Result<Vec<Action>> {
        let change = d.get("change_id").and_then(Value::as_u64).unwrap_or(0);
        let snapshot = d.get("type").and_then(Value::as_str) == Some("snapshot");
        let empty = Vec::new();
        let bids = d.get("bids").and_then(Value::as_array).unwrap_or(&empty);
        let asks = d.get("asks").and_then(Value::as_array).unwrap_or(&empty);
        let rows = |v: &Vec<Value>| -> Vec<Vec<Value>> {
            v.iter().filter_map(|x| x.as_array().cloned()).collect()
        };
        let (bids, asks) = (rows(bids), rows(asks));
        if snapshot {
            self.book.clear();
            self.apply_levels(Side::Buy, &bids)?;
            self.apply_levels(Side::Sell, &asks)?;
            self.last_change = Some(change);
            return Ok(vec![Action::Synced(self.book.snapshot(local_ns))]);
        }
        let Some(last) = self.last_change else {
            return Ok(Vec::new());
        };
        let prev = d.get("prev_change_id").and_then(Value::as_u64);
        if prev != Some(last) {
            if change <= last {
                return Ok(Vec::new()); // duplicate
            }
            self.gaps += 1;
            self.last_change = None;
            let ch = self.book_channel();
            return Ok(vec![Action::Resync {
                send: vec![
                    Self::rpc(10, "public/unsubscribe", json!({"channels": [ch]})),
                    Self::rpc(11, "public/subscribe", json!({"channels": [ch]})),
                ],
                rest: false,
            }]);
        }
        let mut d1 = self.apply_levels(Side::Buy, &bids)?;
        d1.extend(self.apply_levels(Side::Sell, &asks)?);
        self.last_change = Some(change);
        Ok(vec![Action::Deltas(d1)])
    }

    fn on_ticker(&mut self, d: &Value, local_ns: i64) -> Vec<MarketStat> {
        if local_ns - self.last_stats_ns < STATS_EVERY_NS {
            return Vec::new();
        }
        self.last_stats_ns = local_ns;
        let ts = d
            .get("timestamp")
            .and_then(Value::as_i64)
            .map(|t| t * 1_000_000)
            .unwrap_or(local_ns);
        let mark = d.get("mark_price").and_then(num_f64).unwrap_or(f64::NAN);
        let mut out = Vec::new();
        if let Some(rate) = d.get("funding_8h").and_then(num_f64) {
            // Deribit funds continuously; `funding_8h` is the rate over the next 8 hours.
            out.push(MarketStat::Funding {
                ts_ns: ts,
                rate,
                next_ts_ns: 0,
                mark_price: mark,
            });
        }
        if let Some(oi) = d.get("open_interest").and_then(num_f64) {
            out.push(MarketStat::OpenInterest {
                ts_ns: ts,
                oi,
                value: f64::NAN,
            });
        }
        out
    }
}

impl Protocol for DeribitProtocol {
    fn on_open(&mut self) -> Vec<String> {
        self.book.clear();
        self.last_change = None;
        let s = &self.spec.symbol;
        vec![
            Self::rpc(1, "public/set_heartbeat", json!({"interval": 30})),
            Self::rpc(
                2,
                "public/subscribe",
                json!({"channels": [format!("trades.{s}.100ms"), self.book_channel(), format!("ticker.{s}.100ms")]}),
            ),
        ]
    }

    fn on_text(&mut self, text: &str, local_ns: i64) -> Result<Vec<Action>> {
        let v: Value = serde_json::from_str(text)?;
        if let Some(e) = v.get("error") {
            let msg = format!(
                "deribit {}: {}",
                e.get("code").and_then(Value::as_i64).unwrap_or(0),
                e.get("message").and_then(Value::as_str).unwrap_or("")
            );
            return Ok(vec![Action::Fail(msg)]);
        }
        match v.get("method").and_then(Value::as_str) {
            Some("heartbeat") => {
                if v.pointer("/params/type").and_then(Value::as_str) == Some("test_request") {
                    return Ok(vec![Action::Send(Self::rpc(3, "public/test", json!({})))]);
                }
                Ok(Vec::new())
            }
            Some("subscription") => {
                let channel = v
                    .pointer("/params/channel")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let Some(data) = v.pointer("/params/data") else {
                    return Ok(Vec::new());
                };
                if channel.starts_with("trades.") {
                    let rows: Vec<wire::TradeRow> = serde_json::from_value(data.clone())?;
                    let t = rows
                        .iter()
                        .map(|r| trade(&self.spec, r, Some(local_ns)))
                        .collect::<Result<Vec<_>>>()?;
                    let mut liq = Vec::new();
                    for r in &rows {
                        liq.extend(liquidations(&self.spec, r)?);
                    }
                    let mut out = vec![Action::Trades(t)];
                    if !liq.is_empty() {
                        out.push(Action::Stats(liq));
                    }
                    Ok(out)
                } else if channel.starts_with("book.") {
                    self.on_book(data, local_ns)
                } else if channel.starts_with("ticker.") {
                    Ok(vec![Action::Stats(self.on_ticker(data, local_ns))])
                } else {
                    Ok(Vec::new())
                }
            }
            _ => Ok(Vec::new()),
        }
    }

    fn synced(&self) -> bool {
        self.last_change.is_some()
    }

    fn book_snapshot(&self, ts_ns: i64) -> BookSnapshot {
        self.book.snapshot(ts_ns)
    }
}

// ------------------------------------------------------------------ REST + options

/// One option of the live chain (prices in the underlying currency, as Deribit quotes them).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OptionQuote {
    pub instrument: String,
    pub expiry_ms: i64,
    pub strike: f64,
    pub call: bool,
    pub tick_size: f64,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub mark: Option<f64>,
    /// Mark implied volatility in percent.
    pub mark_iv: Option<f64>,
    pub underlying: Option<f64>,
    pub open_interest: Option<f64>,
    pub volume: Option<f64>,
}

#[derive(Clone)]
pub struct Deribit {
    rest: Rest,
    pub ws_url: String,
}

impl Default for Deribit {
    fn default() -> Self {
        Self::new(REST_BASE, WS_URL)
    }
}

fn server_ms(text: &str) -> Option<i64> {
    serde_json::from_str::<Value>(text)
        .ok()?
        .get("result")?
        .as_i64()
}

impl Deribit {
    pub fn new(rest: &str, ws: &str) -> Self {
        // Public non-matching-engine requests: 20 burst, ~10/s sustained.
        Self {
            rest: Rest::new(rest, TokenBucket::new(20, Duration::from_secs(2))),
            ws_url: ws.into(),
        }
    }

    async fn call<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T> {
        let r: wire::Rpc<T> = self.rest.get(&format!("/api/v2/public/{path}")).await?;
        if let Some(e) = r.error {
            return Err(ConnectorError::Api(format!(
                "deribit {}: {}",
                e.code, e.message
            )));
        }
        r.result
            .ok_or_else(|| ConnectorError::Api("deribit: empty result".into()))
    }

    pub async fn symbol_spec(&self, name: &str) -> Result<SymbolSpec> {
        let i: wire::Instrument = self
            .call(&format!("get_instrument?instrument_name={name}"))
            .await
            .map_err(|e| match e {
                ConnectorError::Api(m) if m.contains("not_found") || m.contains("13020") => {
                    ConnectorError::UnknownSymbol(name.into())
                }
                e => e,
            })?;
        spec_from(&i)
    }

    pub async fn depth(&self, spec: &SymbolSpec) -> Result<BookLevels> {
        let b: wire::Book = self
            .call(&format!(
                "get_order_book?instrument_name={}&depth=1000",
                spec.symbol
            ))
            .await?;
        Ok((
            htflow_connector_common::levels(&spec.tick, &b.bids)?,
            htflow_connector_common::levels(&spec.tick, &b.asks)?,
        ))
    }

    /// Trades in `[from_ms, to_ms]`, oldest first, paged forward 1,000 at a time.
    pub async fn trades_range(
        &self,
        spec: &SymbolSpec,
        from_ms: i64,
        to_ms: i64,
        max_pages: u32,
    ) -> Result<Vec<Trade>> {
        let mut out: Vec<Trade> = Vec::new();
        let mut start = from_ms;
        for _ in 0..max_pages {
            let page: wire::Trades = self
                .call(&format!(
                    "get_last_trades_by_instrument_and_time?instrument_name={}&start_timestamp={start}&end_timestamp={to_ms}&count=1000&sorting=asc",
                    spec.symbol
                ))
                .await?;
            for r in &page.trades {
                out.push(trade(spec, r, None)?);
            }
            match page.trades.last() {
                Some(l) if page.has_more && l.timestamp >= start => start = l.timestamp,
                _ => break,
            }
        }
        out.sort_by_key(|t| (t.exchange_ts_ns, t.trade_id));
        out.dedup_by_key(|t| t.trade_id);
        Ok(out)
    }

    /// Live options chain of a currency (`BTC`, `ETH`, …): active instruments joined with the
    /// book summary (bid/ask/mark, mark IV, underlying, OI, volume). Sorted by expiry, strike.
    pub async fn options_chain(&self, currency: &str) -> Result<Vec<OptionQuote>> {
        let cur = currency.to_uppercase();
        let q1 = format!("get_instruments?currency={cur}&kind=option&expired=false");
        let q2 = format!("get_book_summary_by_currency?currency={cur}&kind=option");
        let (insts, sums) = tokio::join!(
            self.call::<Vec<wire::Instrument>>(&q1),
            self.call::<Vec<wire::BookSummary>>(&q2),
        );
        Ok(join_chain(insts?, sums?))
    }

    pub async fn server_time(&self) -> Result<i64> {
        self.rest
            .probe_time("/api/v2/public/get_time", server_ms)
            .await
    }
}

fn join_chain(insts: Vec<wire::Instrument>, sums: Vec<wire::BookSummary>) -> Vec<OptionQuote> {
    let by_name: std::collections::HashMap<&str, &wire::BookSummary> = sums
        .iter()
        .map(|s| (s.instrument_name.as_str(), s))
        .collect();
    let mut out: Vec<OptionQuote> = insts
        .iter()
        .filter(|i| i.kind == "option" && i.is_active != Some(false))
        .map(|i| {
            let s = by_name.get(i.instrument_name.as_str());
            OptionQuote {
                instrument: i.instrument_name.clone(),
                expiry_ms: i.expiration_timestamp,
                strike: i.strike.unwrap_or(f64::NAN),
                call: i.option_type.as_deref() == Some("call"),
                tick_size: i.tick_size,
                bid: s.and_then(|s| s.bid_price),
                ask: s.and_then(|s| s.ask_price),
                mark: s.and_then(|s| s.mark_price),
                mark_iv: s.and_then(|s| s.mark_iv),
                underlying: s.and_then(|s| s.underlying_price),
                open_interest: s.and_then(|s| s.open_interest),
                volume: s.and_then(|s| s.volume),
            }
        })
        .collect();
    out.sort_by(|a, b| {
        (a.expiry_ms, a.strike, !a.call)
            .partial_cmp(&(b.expiry_ms, b.strike, !b.call))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

impl MarketApi for Deribit {
    fn venue(&self) -> &'static str {
        "deribit"
    }
    fn spec<'a>(&'a self, symbol: &'a str) -> BoxFuture<'a, Result<SymbolSpec>> {
        Box::pin(self.symbol_spec(symbol))
    }
    fn book<'a>(&'a self, spec: &'a SymbolSpec) -> BoxFuture<'a, Result<BookLevels>> {
        Box::pin(self.depth(spec))
    }
    fn trades<'a>(
        &'a self,
        spec: &'a SymbolSpec,
        from_ms: i64,
        to_ms: i64,
    ) -> BoxFuture<'a, Result<Vec<Trade>>> {
        Box::pin(self.trades_range(spec, from_ms, to_ms, 30))
    }
    fn history_from_start(&self) -> bool {
        false
    }
    /// The REST trades endpoint takes a start / end time, so past windows load directly.
    fn windowed_trades(&self) -> bool {
        true
    }
    fn kline_intervals(&self) -> &'static [i64] {
        klines::KLINE_INTERVALS
    }
    fn kline_max_bars(&self) -> i64 {
        klines::KLINE_PAGE * i64::from(klines::KLINE_PAGES)
    }
    fn klines<'a>(
        &'a self,
        spec: &'a SymbolSpec,
        interval_ms: i64,
        from_ms: i64,
        to_ms: i64,
    ) -> BoxFuture<'a, Result<Vec<Kline>>> {
        Box::pin(self.klines_range(spec, interval_ms, from_ms, to_ms, klines::KLINE_PAGES))
    }
    fn throttled(&self) -> u64 {
        self.rest.throttled_count()
    }
    fn stream(
        &self,
        spec: SymbolSpec,
        tx: mpsc::Sender<MarketEvent>,
        stop: watch::Receiver<bool>,
    ) -> BoxFuture<'static, ()> {
        let mut cfg = StreamConfig::new(
            "deribit",
            &spec.symbol,
            self.ws_url.clone(),
            Arc::clone(&self.rest.clock),
        );
        // Deribit's own heartbeat (test_request every 30 s) keeps the session alive.
        cfg.ping = Ping::None;
        cfg.idle_timeout = Duration::from_secs(75);
        cfg.time_probe = Some(self.rest.time_probe("/api/v2/public/get_time", server_ms));
        Box::pin(driver::run(cfg, DeribitProtocol::new(spec), tx, stop))
    }
    fn clock(&self) -> &ClockSkew {
        &self.rest.clock
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> SymbolSpec {
        SymbolSpec::new("BTC-PERPETUAL", TickSize::parse("0.5").unwrap(), 0)
    }

    fn sub(channel: &str, data: &str) -> String {
        format!(
            r#"{{"jsonrpc":"2.0","method":"subscription","params":{{"channel":"{channel}","data":{data}}}}}"#
        )
    }

    const SNAP: &str = r#"{"type":"snapshot","timestamp":1700000000000,"instrument_name":"BTC-PERPETUAL","change_id":100,"bids":[["new",42000.5,1200.0],["new",42000.0,50.0]],"asks":[["new",42001.0,300.0]]}"#;
    const CH1: &str = r#"{"type":"change","timestamp":1700000000100,"instrument_name":"BTC-PERPETUAL","prev_change_id":100,"change_id":101,"bids":[["delete",42000.5,0.0]],"asks":[["change",42001.0,10.0],["new",42001.5,20.0]]}"#;
    const GAP: &str = r#"{"type":"change","timestamp":1700000000200,"instrument_name":"BTC-PERPETUAL","prev_change_id":104,"change_id":105,"bids":[],"asks":[]}"#;

    #[test]
    fn subscribes_and_answers_heartbeats() {
        let mut p = DeribitProtocol::new(spec());
        let open = p.on_open();
        assert!(open[0].contains("set_heartbeat"));
        assert!(open[1].contains("book.BTC-PERPETUAL.100ms"));
        let hb = r#"{"jsonrpc":"2.0","method":"heartbeat","params":{"type":"test_request"}}"#;
        let a = p.on_text(hb, 0).unwrap();
        assert!(matches!(&a[0], Action::Send(m) if m.contains("public/test")));
        let ok = r#"{"jsonrpc":"2.0","id":2,"result":["trades.BTC-PERPETUAL.100ms"],"usIn":1,"usOut":2,"usDiff":1,"testnet":false}"#;
        assert!(p.on_text(ok, 0).unwrap().is_empty());
        let err = r#"{"jsonrpc":"2.0","id":2,"error":{"message":"Invalid params","code":-32602}}"#;
        assert!(matches!(&p.on_text(err, 0).unwrap()[0], Action::Fail(m) if m.contains("-32602")));
    }

    #[test]
    fn book_snapshot_change_duplicate_gap() {
        let mut p = DeribitProtocol::new(spec());
        p.on_open();
        let ch = "book.BTC-PERPETUAL.100ms";
        assert!(p.on_text(&sub(ch, CH1), 0).unwrap().is_empty());
        let Action::Synced(s) = &p.on_text(&sub(ch, SNAP), 0).unwrap()[0] else {
            panic!()
        };
        assert_eq!(s.bids, vec![(84_001, 1200.0), (84_000, 50.0)]);
        let Action::Deltas(d) = &p.on_text(&sub(ch, CH1), 0).unwrap()[0] else {
            panic!()
        };
        assert_eq!(d.len(), 3);
        assert_eq!(p.book.best_bid(), Some(84_000));
        assert!(p.on_text(&sub(ch, CH1), 0).unwrap().is_empty()); // duplicate
        let a = p.on_text(&sub(ch, GAP), 0).unwrap();
        assert!(matches!(&a[0], Action::Resync { send, .. } if send.len() == 2));
        assert!(!p.synced());
        assert_eq!(p.gaps, 1);
    }

    #[test]
    fn trades_liquidations_and_ticker() {
        let mut p = DeribitProtocol::new(spec());
        let t = r#"[{"trade_seq":1,"trade_id":"287469003","timestamp":1700000000123,"tick_direction":0,"price":42000.5,"mark_price":42000.1,"instrument_name":"BTC-PERPETUAL","index_price":41990.0,"direction":"sell","amount":2500.0,"liquidation":"M"}]"#;
        let a = p.on_text(&sub("trades.BTC-PERPETUAL.100ms", t), 9).unwrap();
        let Action::Trades(tr) = &a[0] else { panic!() };
        assert_eq!(
            (tr[0].px, tr[0].qty, tr[0].aggressor, tr[0].trade_id),
            (84_001, 2500.0, Aggressor::Sell, 287_469_003)
        );
        // Maker (a buy order) was liquidated.
        assert!(
            matches!(&a[1], Action::Stats(s) if matches!(s[0], MarketStat::Liquidation { side: Side::Buy, .. }))
        );
        let tk = r#"{"timestamp":1700000000000,"funding_8h":0.0001,"current_funding":0.00002,"open_interest":525000000,"mark_price":42001.2,"instrument_name":"BTC-PERPETUAL"}"#;
        let ch = "ticker.BTC-PERPETUAL.100ms";
        let Action::Stats(s) = &p.on_text(&sub(ch, tk), 2_000_000_000).unwrap()[0] else {
            panic!()
        };
        assert_eq!(s.len(), 2);
        // Throttled to one per second.
        let Action::Stats(s) = &p.on_text(&sub(ch, tk), 2_500_000_000).unwrap()[0] else {
            panic!()
        };
        assert!(s.is_empty());
    }

    #[test]
    fn rest_shapes_and_options_chain() {
        let i = r#"{"jsonrpc":"2.0","result":{"tick_size":0.5,"min_trade_amount":10.0,"kind":"future","instrument_name":"BTC-PERPETUAL","base_currency":"BTC","settlement_period":"perpetual","contract_size":10.0,"expiration_timestamp":32503708800000},"usIn":1,"usOut":2}"#;
        let r: wire::Rpc<wire::Instrument> = serde_json::from_str(i).unwrap();
        let sp = spec_from(&r.result.unwrap()).unwrap();
        assert_eq!((sp.tick.as_f64(), sp.qty_precision), (0.5, 0));
        let insts: Vec<wire::Instrument> = serde_json::from_str(r#"[
            {"instrument_name":"BTC-27DEC24-50000-P","tick_size":0.0001,"kind":"option","strike":50000.0,"option_type":"put","expiration_timestamp":1735286400000,"is_active":true},
            {"instrument_name":"BTC-27DEC24-50000-C","tick_size":0.0001,"kind":"option","strike":50000.0,"option_type":"call","expiration_timestamp":1735286400000,"is_active":true},
            {"instrument_name":"BTC-20DEC24-60000-C","tick_size":0.0001,"kind":"option","strike":60000.0,"option_type":"call","expiration_timestamp":1734681600000,"is_active":true}]"#).unwrap();
        let sums: Vec<wire::BookSummary> = serde_json::from_str(r#"[{"instrument_name":"BTC-27DEC24-50000-C","bid_price":0.05,"ask_price":0.055,"mark_price":0.052,"mark_iv":55.2,"underlying_price":52000.0,"open_interest":120.0,"volume":3.0}]"#).unwrap();
        let chain = join_chain(insts, sums);
        assert_eq!(
            chain
                .iter()
                .map(|o| o.instrument.as_str())
                .collect::<Vec<_>>(),
            vec![
                "BTC-20DEC24-60000-C",
                "BTC-27DEC24-50000-C",
                "BTC-27DEC24-50000-P"
            ]
        );
        assert_eq!(chain[1].mark_iv, Some(55.2));
        assert!(chain[1].call && !chain[2].call);
        assert_eq!(chain[2].bid, None);
        assert_eq!(
            server_ms(r#"{"jsonrpc":"2.0","result":1550147385946}"#),
            Some(1_550_147_385_946)
        );
        let err: wire::Rpc<wire::Instrument> = serde_json::from_str(
            r#"{"jsonrpc":"2.0","error":{"message":"instrument_not_found","code":13020}}"#,
        )
        .unwrap();
        assert_eq!(err.error.unwrap().code, 13020);
    }
}
