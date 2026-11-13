//! Kraken Futures public market data (P05) — free, no API key (flexible perpetuals `PF_*`,
//! fixed-maturity `FF_*` / `FI_*`).
//!
//! * Socket `wss://futures.kraken.com/ws/v1`: `trade`, `book`, `ticker` and `heartbeat` feeds;
//!   WebSocket pings every 30 s. Trade `type: liquidation` also produces a normalised
//!   liquidation; the ticker gives the relative funding rate, next funding time, open interest
//!   and mark price (throttled to one stats update per second).
//! * Book: `book_snapshot` resets; every `book` message (one level) must carry
//!   `seq = previous seq + 1`. Older = duplicate; a jump re-subscribes the book feed, which
//!   makes Kraken send a new snapshot. The `trade_snapshot` on subscribe is skipped.
//! * REST: instruments, order book, trade history (100 per page, paged backwards with
//!   `lastTime`), server time from `serverTime`. 5 requests/s token bucket.
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use htflow_connector_common::{
    driver, f64_ticks, hash_id, num_f64, parse_iso8601_ms, Action, BookLevels, ClockSkew,
    ConnectorError, Kline, L2Book, MarketApi, Ping, Protocol, Rest, Result, StreamConfig,
    SymbolSpec, TokenBucket,
};
use htflow_core_types::{Aggressor, BookSnapshot, MarketEvent, MarketStat, Side, TickSize, Trade};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

pub mod klines;

pub const REST_BASE: &str = "https://futures.kraken.com";
pub const WS_URL: &str = "wss://futures.kraken.com/ws/v1";

mod wire {
    use serde::Deserialize;
    use serde_json::Value;

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Instrument {
        pub symbol: String,
        #[serde(default)]
        pub tick_size: Option<f64>,
        #[serde(default)]
        pub contract_value_trade_precision: Option<i64>,
    }

    #[derive(Debug, Deserialize)]
    pub struct Instruments {
        pub result: String,
        #[serde(default)]
        pub instruments: Vec<Instrument>,
        #[serde(default)]
        pub error: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct OrderBookResp {
        pub result: String,
        #[serde(default)]
        pub order_book: Option<OrderBook>,
        #[serde(default)]
        pub error: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    pub struct OrderBook {
        pub bids: Vec<Vec<Value>>,
        pub asks: Vec<Vec<Value>>,
    }

    #[derive(Debug, Deserialize)]
    pub struct HistoryRow {
        pub time: String,
        #[serde(default)]
        pub uid: Option<String>,
        #[serde(default)]
        pub trade_id: Option<u64>,
        pub price: f64,
        pub size: f64,
        pub side: String,
    }

    #[derive(Debug, Deserialize)]
    pub struct History {
        pub result: String,
        #[serde(default)]
        pub history: Vec<HistoryRow>,
        #[serde(default)]
        pub error: Option<String>,
    }
}

fn aggressor(side: &str) -> Aggressor {
    match side {
        "buy" => Aggressor::Buy,
        "sell" => Aggressor::Sell,
        _ => Aggressor::Unknown,
    }
}

fn tick_of(t: f64) -> Result<TickSize> {
    Ok(TickSize::parse(&format!("{t}"))?)
}

fn rest_trade(spec: &SymbolSpec, r: &wire::HistoryRow) -> Result<Trade> {
    let ms = parse_iso8601_ms(&r.time)
        .ok_or_else(|| ConnectorError::Other(format!("bad time {}", r.time)))?;
    Ok(Trade {
        exchange_ts_ns: ms * 1_000_000,
        local_ts_ns: ms * 1_000_000,
        px: f64_ticks(&spec.tick, r.price)?,
        qty: r.size,
        aggressor: aggressor(&r.side),
        trade_id: match (&r.uid, r.trade_id) {
            (Some(u), _) => hash_id(u),
            (None, Some(id)) => id,
            _ => 0,
        },
    })
}

// ------------------------------------------------------------------ protocol

pub struct KrakenProtocol {
    spec: SymbolSpec,
    book: L2Book,
    last_seq: Option<u64>,
    last_stats_ns: i64,
    pub gaps: u64,
}

impl KrakenProtocol {
    pub fn new(spec: SymbolSpec) -> Self {
        Self {
            spec,
            book: L2Book::default(),
            last_seq: None,
            last_stats_ns: 0,
            gaps: 0,
        }
    }

    fn sub(&self, event: &str, feed: &str) -> String {
        json!({"event": event, "feed": feed, "product_ids": [self.spec.symbol]}).to_string()
    }

    fn price(&self, v: &Value) -> Result<i64> {
        let p = num_f64(v).ok_or_else(|| ConnectorError::Other("bad price".into()))?;
        f64_ticks(&self.spec.tick, p)
    }

    fn snapshot_levels(&self, rows: Option<&Value>) -> Result<Vec<(i64, f64)>> {
        rows.and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|l| {
                Ok((
                    self.price(l.get("price").unwrap_or(&Value::Null))?,
                    l.get("qty").and_then(num_f64).unwrap_or(0.0),
                ))
            })
            .collect()
    }

    fn on_ticker(&mut self, v: &Value, local_ns: i64) -> Vec<MarketStat> {
        if local_ns - self.last_stats_ns < 1_000_000_000 {
            return Vec::new();
        }
        self.last_stats_ns = local_ns;
        let ts = v
            .get("time")
            .and_then(num_f64)
            .map(|t| t as i64 * 1_000_000)
            .unwrap_or(local_ns);
        let mut out = Vec::new();
        if let Some(rate) = v.get("relative_funding_rate").and_then(num_f64) {
            out.push(MarketStat::Funding {
                ts_ns: ts,
                rate,
                next_ts_ns: v
                    .get("next_funding_rate_time")
                    .and_then(num_f64)
                    .map(|t| t as i64 * 1_000_000)
                    .unwrap_or(0),
                mark_price: v.get("markPrice").and_then(num_f64).unwrap_or(f64::NAN),
            });
        }
        if let Some(oi) = v.get("openInterest").and_then(num_f64) {
            out.push(MarketStat::OpenInterest {
                ts_ns: ts,
                oi,
                value: f64::NAN,
            });
        }
        out
    }
}

impl Protocol for KrakenProtocol {
    fn on_open(&mut self) -> Vec<String> {
        self.book.clear();
        self.last_seq = None;
        vec![
            json!({"event": "subscribe", "feed": "heartbeat"}).to_string(),
            self.sub("subscribe", "trade"),
            self.sub("subscribe", "book"),
            self.sub("subscribe", "ticker"),
        ]
    }

    fn on_text(&mut self, text: &str, local_ns: i64) -> Result<Vec<Action>> {
        let v: Value = serde_json::from_str(text)?;
        if let Some(ev) = v.get("event").and_then(Value::as_str) {
            if ev == "error" || ev == "subscribed_failed" {
                let msg = v
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("subscription failed");
                return Ok(vec![Action::Fail(format!("kraken: {msg}"))]);
            }
            return Ok(Vec::new());
        }
        if v.get("product_id").and_then(Value::as_str) != Some(self.spec.symbol.as_str()) {
            return Ok(Vec::new());
        }
        match v.get("feed").and_then(Value::as_str).unwrap_or("") {
            "trade" => {
                let ms = v.get("time").and_then(num_f64).unwrap_or(0.0) as i64;
                let side = v.get("side").and_then(Value::as_str).unwrap_or("");
                let px = self.price(v.get("price").unwrap_or(&Value::Null))?;
                let qty = v.get("qty").and_then(num_f64).unwrap_or(0.0);
                let t = Trade {
                    exchange_ts_ns: ms * 1_000_000,
                    local_ts_ns: local_ns,
                    px,
                    qty,
                    aggressor: aggressor(side),
                    trade_id: v
                        .get("uid")
                        .and_then(Value::as_str)
                        .map(hash_id)
                        .unwrap_or(0),
                };
                let mut out = vec![Action::Trades(vec![t])];
                if v.get("type").and_then(Value::as_str) == Some("liquidation") {
                    // The taker order was the liquidation.
                    out.push(Action::Stats(vec![MarketStat::Liquidation {
                        ts_ns: ms * 1_000_000,
                        side: if side == "buy" { Side::Buy } else { Side::Sell },
                        px,
                        qty,
                    }]));
                }
                Ok(out)
            }
            "book_snapshot" => {
                let bids = self.snapshot_levels(v.get("bids"))?;
                let asks = self.snapshot_levels(v.get("asks"))?;
                self.book.clear();
                self.book.apply(&bids, &asks);
                self.last_seq = v.get("seq").and_then(Value::as_u64).or(Some(0));
                Ok(vec![Action::Synced(self.book.snapshot(local_ns))])
            }
            "book" => {
                let Some(last) = self.last_seq else {
                    return Ok(Vec::new());
                };
                let seq = v.get("seq").and_then(Value::as_u64).unwrap_or(0);
                if seq <= last {
                    return Ok(Vec::new());
                }
                if seq != last + 1 {
                    self.gaps += 1;
                    self.last_seq = None;
                    return Ok(vec![Action::Resync {
                        send: vec![
                            self.sub("unsubscribe", "book"),
                            self.sub("subscribe", "book"),
                        ],
                        rest: false,
                    }]);
                }
                self.last_seq = Some(seq);
                let side = if v.get("side").and_then(Value::as_str) == Some("buy") {
                    Side::Buy
                } else {
                    Side::Sell
                };
                let px = self.price(v.get("price").unwrap_or(&Value::Null))?;
                let qty = v.get("qty").and_then(num_f64).unwrap_or(0.0);
                Ok(vec![Action::Deltas(vec![self
                    .book
                    .set(side, px, qty, None)])])
            }
            "ticker" => Ok(vec![Action::Stats(self.on_ticker(&v, local_ns))]),
            _ => Ok(Vec::new()),
        }
    }

    fn synced(&self) -> bool {
        self.last_seq.is_some()
    }

    fn book_snapshot(&self, ts_ns: i64) -> BookSnapshot {
        self.book.snapshot(ts_ns)
    }
}

// ------------------------------------------------------------------ REST + MarketApi

#[derive(Clone)]
pub struct KrakenFutures {
    rest: Rest,
    pub ws_url: String,
}

impl Default for KrakenFutures {
    fn default() -> Self {
        Self::new(REST_BASE, WS_URL)
    }
}

fn server_ms(text: &str) -> Option<i64> {
    let v: Value = serde_json::from_str(text).ok()?;
    parse_iso8601_ms(v.get("serverTime")?.as_str()?)
}

fn check(result: &str, error: &Option<String>) -> Result<()> {
    if result == "success" {
        Ok(())
    } else {
        Err(ConnectorError::Api(format!(
            "kraken: {}",
            error.as_deref().unwrap_or(result)
        )))
    }
}

impl KrakenFutures {
    pub fn new(rest: &str, ws: &str) -> Self {
        Self {
            rest: Rest::new(rest, TokenBucket::new(5, Duration::from_secs(1))),
            ws_url: ws.into(),
        }
    }

    pub async fn symbol_spec(&self, symbol: &str) -> Result<SymbolSpec> {
        let r: wire::Instruments = self.rest.get("/derivatives/api/v3/instruments").await?;
        check(&r.result, &r.error)?;
        spec_from(symbol, r.instruments)
    }

    pub async fn depth(&self, spec: &SymbolSpec) -> Result<BookLevels> {
        let r: wire::OrderBookResp = self
            .rest
            .get(&format!(
                "/derivatives/api/v3/orderbook?symbol={}",
                spec.symbol
            ))
            .await?;
        check(&r.result, &r.error)?;
        let b = r
            .order_book
            .ok_or_else(|| ConnectorError::Api("kraken: empty book".into()))?;
        let mut bids = htflow_connector_common::levels(&spec.tick, &b.bids)?;
        let mut asks = htflow_connector_common::levels(&spec.tick, &b.asks)?;
        bids.sort_by_key(|l| std::cmp::Reverse(l.0));
        asks.sort_by_key(|l| l.0);
        Ok((bids, asks))
    }

    /// Trade history pages (100 each, newest first) walked back with `lastTime` to `from_ms`.
    pub async fn trades_range(
        &self,
        spec: &SymbolSpec,
        from_ms: i64,
        to_ms: i64,
        max_pages: u32,
    ) -> Result<Vec<Trade>> {
        let mut out = Vec::new();
        let mut last_time: Option<String> = None;
        for _ in 0..max_pages {
            let mut q = format!("/derivatives/api/v3/history?symbol={}", spec.symbol);
            if let Some(t) = &last_time {
                q.push_str(&format!("&lastTime={t}"));
            }
            let r: wire::History = self.rest.get(&q).await?;
            check(&r.result, &r.error)?;
            let mut oldest: Option<(i64, String)> = None;
            for row in &r.history {
                let t = rest_trade(spec, row)?;
                let ms = t.exchange_ts_ns / 1_000_000;
                if oldest.as_ref().is_none_or(|(o, _)| ms < *o) {
                    oldest = Some((ms, row.time.clone()));
                }
                out.push(t);
            }
            match oldest {
                Some((ms, t)) if ms > from_ms && r.history.len() >= 100 => last_time = Some(t),
                _ => break,
            }
        }
        let (lo, hi) = (from_ms * 1_000_000, (to_ms + 1) * 1_000_000);
        out.retain(|t| t.exchange_ts_ns >= lo && t.exchange_ts_ns < hi);
        out.sort_by_key(|t| (t.exchange_ts_ns, t.trade_id));
        out.dedup_by_key(|t| t.trade_id);
        Ok(out)
    }
}

fn spec_from(symbol: &str, list: Vec<wire::Instrument>) -> Result<SymbolSpec> {
    let i = list
        .into_iter()
        .find(|i| i.symbol.eq_ignore_ascii_case(symbol))
        .ok_or_else(|| ConnectorError::UnknownSymbol(symbol.into()))?;
    let tick = tick_of(i.tick_size.unwrap_or(0.5))?;
    Ok(SymbolSpec::new(
        i.symbol.to_uppercase(),
        tick,
        i.contract_value_trade_precision.unwrap_or(0).clamp(0, 12) as u32,
    ))
}

impl MarketApi for KrakenFutures {
    fn venue(&self) -> &'static str {
        "kraken-futures"
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
        Box::pin(self.trades_range(spec, from_ms, to_ms, 20))
    }
    fn history_from_start(&self) -> bool {
        false
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
            "kraken-futures",
            &spec.symbol,
            self.ws_url.clone(),
            Arc::clone(&self.rest.clock),
        );
        cfg.ping = Ping::Frame;
        cfg.ping_every = Duration::from_secs(30);
        cfg.idle_timeout = Duration::from_secs(60);
        cfg.time_probe = Some(self.rest.time_probe(
            format!("/derivatives/api/v3/tickers/{}", spec.symbol),
            server_ms,
        ));
        Box::pin(driver::run(cfg, KrakenProtocol::new(spec), tx, stop))
    }
    fn clock(&self) -> &ClockSkew {
        &self.rest.clock
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> SymbolSpec {
        SymbolSpec::new("PF_XBTUSD", TickSize::parse("0.5").unwrap(), 4)
    }

    const SNAP: &str = r#"{"feed":"book_snapshot","product_id":"PF_XBTUSD","timestamp":1612269825817,"seq":326072249,"tickSize":null,"bids":[{"price":34892.5,"qty":6385},{"price":34892,"qty":10924}],"asks":[{"price":34911.5,"qty":20598}]}"#;

    fn book(seq: u64, side: &str, price: f64, qty: f64) -> String {
        format!(
            r#"{{"feed":"book","product_id":"PF_XBTUSD","side":"{side}","seq":{seq},"price":{price},"qty":{qty},"timestamp":1612269953629}}"#
        )
    }

    #[test]
    fn book_sequence() {
        let mut p = KrakenProtocol::new(spec());
        assert_eq!(p.on_open().len(), 4);
        assert!(p
            .on_text(&book(326_072_250, "buy", 34892.5, 1.0), 0)
            .unwrap()
            .is_empty());
        let Action::Synced(s) = &p.on_text(SNAP, 0).unwrap()[0] else {
            panic!()
        };
        assert_eq!(s.bids[0], (69_785, 6385.0));
        let up = book(326_072_250, "sell", 34911.5, 0.0);
        assert!(matches!(&p.on_text(&up, 0).unwrap()[0], Action::Deltas(d) if d[0].qty == 0.0));
        assert_eq!(p.book.best_ask(), None);
        assert!(p.on_text(&up, 0).unwrap().is_empty()); // duplicate
        let gap = book(326_072_260, "buy", 34890.0, 2.0);
        assert!(
            matches!(&p.on_text(&gap, 0).unwrap()[0], Action::Resync { send, .. } if send.len() == 2)
        );
        assert!(!p.synced());
        assert_eq!(p.gaps, 1);
        // Other products are ignored.
        let other = SNAP.replace("PF_XBTUSD", "PF_ETHUSD");
        assert!(p.on_text(&other, 0).unwrap().is_empty());
    }

    #[test]
    fn trades_liquidations_ticker_events() {
        let mut p = KrakenProtocol::new(spec());
        let snap = r#"{"feed":"trade_snapshot","product_id":"PF_XBTUSD","trades":[]}"#;
        assert!(p.on_text(snap, 0).unwrap().is_empty());
        let t = r#"{"feed":"trade","product_id":"PF_XBTUSD","uid":"05af78ac-a774-478c-a50c-8b9c234e071e","side":"sell","type":"liquidation","seq":653355,"time":1612266317519,"qty":15000,"price":34969.5}"#;
        let a = p.on_text(t, 7).unwrap();
        let Action::Trades(tr) = &a[0] else { panic!() };
        assert_eq!((tr[0].px, tr[0].aggressor), (69_939, Aggressor::Sell));
        assert!(
            matches!(&a[1], Action::Stats(s) if matches!(s[0], MarketStat::Liquidation { side: Side::Sell, qty, .. } if qty == 15000.0))
        );
        let tk = r#"{"time":1612270825253,"feed":"ticker","product_id":"PF_XBTUSD","funding_rate":1.18e-9,"relative_funding_rate":0.0000412,"next_funding_rate_time":1612281600000,"openInterest":28910843.0,"markPrice":34893.6}"#;
        let Action::Stats(s) = &p.on_text(tk, 3_000_000_000).unwrap()[0] else {
            panic!()
        };
        assert!(matches!(s[0], MarketStat::Funding { rate, .. } if rate == 0.0000412));
        assert!(matches!(s[1], MarketStat::OpenInterest { oi, .. } if oi == 28_910_843.0));
        assert!(p
            .on_text(r#"{"event":"info","version":1}"#, 0)
            .unwrap()
            .is_empty());
        let err = r#"{"event":"error","message":"Invalid product id"}"#;
        assert!(
            matches!(&p.on_text(err, 0).unwrap()[0], Action::Fail(m) if m.contains("Invalid product"))
        );
    }

    #[test]
    fn rest_shapes() {
        let i: wire::Instruments = serde_json::from_str(r#"{"result":"success","instruments":[{"symbol":"PF_XBTUSD","type":"flexible_futures","tradeable":true,"tickSize":0.5,"contractSize":1,"contractValueTradePrecision":4}],"serverTime":"2022-06-28T09:29:04.243Z"}"#).unwrap();
        let sp = spec_from("pf_xbtusd", i.instruments).unwrap();
        assert_eq!((sp.tick.as_f64(), sp.qty_precision), (0.5, 4));
        let h: wire::History = serde_json::from_str(r#"{"result":"success","history":[{"time":"2019-02-14T09:25:33.920Z","trade_id":100,"price":3574,"size":100,"side":"buy","type":"fill","uid":"11c3d82c-9e70-4fe9-8115-f643f1b162d4"}],"serverTime":"2019-02-14T09:25:34.000Z"}"#).unwrap();
        let t = rest_trade(&sp, &h.history[0]).unwrap();
        assert_eq!(t.exchange_ts_ns, 1_550_136_333_920_000_000);
        assert_eq!(t.trade_id, hash_id("11c3d82c-9e70-4fe9-8115-f643f1b162d4"));
        assert_eq!(
            server_ms(r#"{"result":"success","serverTime":"2019-02-14T09:25:34.000Z"}"#),
            Some(1_550_136_334_000)
        );
        assert!(check("error", &Some("apiLimitExceeded".into())).is_err());
    }
}
