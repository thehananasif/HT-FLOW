//! OKX v5 public market data (P05) — free, no API key.
//!
//! * Socket `wss://ws.okx.com:8443/ws/v5/public`: `trades`, `books` (400 levels), and for
//!   derivatives `funding-rate`, `open-interest` and `liquidation-orders`. Heartbeat: text `ping`
//!   every 25 s (server answers `pong`).
//! * Book: `snapshot` resets, every `update` must carry `prevSeqId == last seqId` (a no-change
//!   heartbeat repeats the same seqId); a smaller seqId is a duplicate and ignored, anything else
//!   is a gap. Every message's CRC32 `checksum` over the top 25 levels is verified against the
//!   local book; a gap or mismatch re-subscribes `books`, which makes OKX push a new snapshot.
//! * Sizes are converted from contracts to base units with the instrument's `ctVal` (linear
//!   contracts); inverse contracts keep their contract counts.
//! * REST: instruments, 400-level book, recent trades + `history-trades` paging, server time.
//!   10 requests/s token bucket (OKX public limits are 20–40 per 2 s per endpoint).
pub mod instruments;

use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use htflow_connector_common::{
    driver, hash_id, levels, num_f64, num_text, raw_levels, scale_qty, Action, BookLevels,
    ClockSkew, ConnectorError, L2Book, MarketApi, Ping, Protocol, Rest, Result, StreamConfig,
    SymbolSpec, TokenBucket, TradesBack,
};
use htflow_core_types::{
    decimals_of, Aggressor, BookSnapshot, MarketEvent, MarketStat, Side, TickSize, Trade,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

pub const REST_BASE: &str = "https://www.okx.com";
pub const WS_URL: &str = "wss://ws.okx.com:8443/ws/v5/public";
pub const BOOK_DEPTH: u32 = 400;
const CHECKSUM_DEPTH: usize = 25;

/// `SWAP`, `FUTURES` or `SPOT` from an instrument id.
pub fn inst_type(inst_id: &str) -> &'static str {
    let parts: Vec<&str> = inst_id.split('-').collect();
    match parts.as_slice() {
        [.., "SWAP"] => "SWAP",
        [_, _, d] if d.len() == 6 && d.chars().all(|c| c.is_ascii_digit()) => "FUTURES",
        [_, _, _, _, _] => "OPTION",
        _ => "SPOT",
    }
}

mod wire {
    use serde::Deserialize;
    use serde_json::Value;

    #[derive(Debug, Deserialize)]
    pub struct Rest<T> {
        pub code: String,
        #[serde(default)]
        pub msg: String,
        #[serde(default = "Vec::new")]
        pub data: Vec<T>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Instrument {
        pub inst_id: String,
        pub tick_sz: String,
        pub lot_sz: String,
        #[serde(default)]
        pub ct_val: String,
        #[serde(default)]
        pub ct_type: String,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TradeRow {
        pub trade_id: String,
        pub px: String,
        pub sz: String,
        pub side: String,
        pub ts: String,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Book {
        #[serde(default)]
        pub asks: Vec<Vec<Value>>,
        #[serde(default)]
        pub bids: Vec<Vec<Value>>,
        #[serde(default)]
        pub checksum: Option<i64>,
        #[serde(default)]
        pub seq_id: Option<i64>,
        #[serde(default)]
        pub prev_seq_id: Option<i64>,
    }
}

fn aggressor(side: &str) -> Aggressor {
    match side {
        "buy" => Aggressor::Buy,
        "sell" => Aggressor::Sell,
        _ => Aggressor::Unknown,
    }
}

fn ms(v: &Value) -> i64 {
    num_f64(v).unwrap_or(0.0) as i64
}

fn trade(spec: &SymbolSpec, r: &wire::TradeRow, local_ns: Option<i64>) -> Result<Trade> {
    let ts: i64 =
        r.ts.parse()
            .map_err(|_| ConnectorError::Other(format!("bad ts {}", r.ts)))?;
    let qty: f64 =
        r.sz.parse()
            .map_err(|_| ConnectorError::Other(format!("bad sz {}", r.sz)))?;
    Ok(Trade {
        exchange_ts_ns: ts * 1_000_000,
        local_ts_ns: local_ns.unwrap_or(ts * 1_000_000),
        px: spec.tick.parse_ticks(&r.px)?,
        qty: scale_qty(qty, spec.contract_value, spec.qty_precision),
        aggressor: aggressor(&r.side),
        trade_id: hash_id(&r.trade_id),
    })
}

pub fn spec_from(inst: wire_pub::Instrument) -> Result<SymbolSpec> {
    let tick = TickSize::parse(&inst.tick_sz)?;
    let ct: f64 = inst.ct_val.parse().unwrap_or(1.0);
    let linear = inst.ct_type != "inverse" && !inst.ct_val.is_empty();
    let (cv, prec) = if linear {
        (ct, decimals_of(&inst.lot_sz) + decimals_of(&inst.ct_val))
    } else {
        (1.0, decimals_of(&inst.lot_sz))
    };
    Ok(SymbolSpec {
        symbol: inst.inst_id,
        tick,
        qty_precision: prec,
        contract_value: cv,
    })
}

/// Public re-export of the instrument wire type (used by tests and the desktop catalog).
pub mod wire_pub {
    pub use super::wire::Instrument;
}

// ------------------------------------------------------------------ protocol

pub struct OkxProtocol {
    spec: SymbolSpec,
    book: L2Book,
    last_seq: Option<i64>,
    pub gaps: u64,
    pub checksum_errors: u64,
}

impl OkxProtocol {
    pub fn new(spec: SymbolSpec) -> Self {
        Self {
            spec,
            book: L2Book::default(),
            last_seq: None,
            gaps: 0,
            checksum_errors: 0,
        }
    }

    fn book_arg(&self) -> Value {
        json!({"channel": "books", "instId": self.spec.symbol})
    }

    fn resync(&mut self) -> Action {
        self.last_seq = None;
        Action::Resync {
            send: vec![
                json!({"op": "unsubscribe", "args": [self.book_arg()]}).to_string(),
                json!({"op": "subscribe", "args": [self.book_arg()]}).to_string(),
            ],
            rest: false,
        }
    }

    fn scaled(&self, rows: &[Vec<Value>]) -> Result<Vec<(i64, f64, String, String)>> {
        let mut v = raw_levels(&self.spec.tick, rows)?;
        for l in &mut v {
            l.1 = scale_qty(l.1, self.spec.contract_value, self.spec.qty_precision);
        }
        Ok(v)
    }

    fn on_book(&mut self, action: &str, b: wire::Book, local_ns: i64) -> Result<Vec<Action>> {
        let seq = b.seq_id.unwrap_or(0);
        let bids = self.scaled(&b.bids)?;
        let asks = self.scaled(&b.asks)?;
        let out = if action == "snapshot" {
            self.book.clear();
            self.book.apply_raw(&bids, &asks);
            self.last_seq = Some(seq);
            None
        } else {
            let Some(last) = self.last_seq else {
                return Ok(Vec::new()); // waiting for the snapshot
            };
            match b.prev_seq_id {
                Some(p) if p == last => {}
                _ if seq <= last && seq >= 0 => return Ok(Vec::new()), // duplicate / replay
                _ => {
                    self.gaps += 1;
                    return Ok(vec![self.resync()]);
                }
            }
            let d = self.book.apply_raw(&bids, &asks);
            self.last_seq = Some(seq);
            Some(d)
        };
        if let Some(cs) = b.checksum {
            if self.book.crc_checksum(CHECKSUM_DEPTH) as i64 != cs {
                self.checksum_errors += 1;
                tracing::warn!(symbol = %self.spec.symbol, "okx book checksum mismatch");
                return Ok(vec![self.resync()]);
            }
        }
        Ok(vec![match out {
            None => Action::Synced(self.book.snapshot(local_ns)),
            Some(d) => Action::Deltas(d),
        }])
    }

    fn stats(&self, channel: &str, data: &[Value], local_ns: i64) -> Vec<MarketStat> {
        let mut out = Vec::new();
        for d in data {
            let ts = d
                .get("ts")
                .map(ms)
                .filter(|t| *t > 0)
                .map(|t| t * 1_000_000);
            match channel {
                "funding-rate" => {
                    if let Some(rate) = d.get("fundingRate").and_then(num_f64) {
                        out.push(MarketStat::Funding {
                            ts_ns: ts.unwrap_or(local_ns),
                            rate,
                            next_ts_ns: d.get("fundingTime").map(ms).unwrap_or(0) * 1_000_000,
                            mark_price: f64::NAN,
                        });
                    }
                }
                "open-interest" => {
                    let oi = d.get("oiCcy").and_then(num_f64).or_else(|| {
                        d.get("oi")
                            .and_then(num_f64)
                            .map(|o| o * self.spec.contract_value)
                    });
                    if let Some(oi) = oi {
                        out.push(MarketStat::OpenInterest {
                            ts_ns: ts.unwrap_or(local_ns),
                            oi,
                            value: d.get("oiUsd").and_then(num_f64).unwrap_or(f64::NAN),
                        });
                    }
                }
                "liquidation-orders" => {
                    if d.get("instId").and_then(Value::as_str) != Some(self.spec.symbol.as_str()) {
                        continue;
                    }
                    for x in d
                        .get("details")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        let side = match x.get("side").and_then(Value::as_str) {
                            Some("buy") => Side::Buy,
                            Some("sell") => Side::Sell,
                            _ => continue,
                        };
                        let px = x
                            .get("bkPx")
                            .and_then(num_text)
                            .and_then(|p| self.spec.tick.parse_ticks(&p).ok());
                        let qty = x.get("sz").and_then(num_f64);
                        if let (Some(px), Some(qty)) = (px, qty) {
                            out.push(MarketStat::Liquidation {
                                ts_ns: x.get("ts").map(ms).unwrap_or(0) * 1_000_000,
                                side,
                                px,
                                qty: scale_qty(
                                    qty,
                                    self.spec.contract_value,
                                    self.spec.qty_precision,
                                ),
                            });
                        }
                    }
                }
                _ => {}
            }
        }
        out
    }
}

impl Protocol for OkxProtocol {
    fn on_open(&mut self) -> Vec<String> {
        self.book.clear();
        self.last_seq = None;
        let id = &self.spec.symbol;
        let kind = inst_type(id);
        let mut args = vec![json!({"channel": "trades", "instId": id}), self.book_arg()];
        if kind == "SWAP" {
            args.push(json!({"channel": "funding-rate", "instId": id}));
        }
        if kind == "SWAP" || kind == "FUTURES" {
            args.push(json!({"channel": "open-interest", "instId": id}));
            args.push(json!({"channel": "liquidation-orders", "instType": kind}));
        }
        vec![json!({"op": "subscribe", "args": args}).to_string()]
    }

    fn on_text(&mut self, text: &str, local_ns: i64) -> Result<Vec<Action>> {
        if text == "pong" {
            return Ok(Vec::new());
        }
        let v: Value = serde_json::from_str(text)?;
        if let Some(ev) = v.get("event").and_then(Value::as_str) {
            if ev == "error" {
                let msg = format!(
                    "okx {}: {}",
                    v.get("code").and_then(num_text).unwrap_or_default(),
                    v.get("msg").and_then(Value::as_str).unwrap_or("")
                );
                // A bad trades/books subscription leaves nothing to show; optional channels
                // (liquidations on a spot id, …) are only logged.
                if !self.synced() && msg.contains("instId") {
                    return Ok(vec![Action::Fail(msg)]);
                }
                tracing::warn!("{msg}");
            }
            return Ok(Vec::new());
        }
        let Some(channel) = v.pointer("/arg/channel").and_then(Value::as_str) else {
            return Ok(Vec::new());
        };
        let channel = channel.to_string();
        let Some(Value::Array(data)) = v.get("data") else {
            return Ok(Vec::new());
        };
        match channel.as_str() {
            "trades" => {
                let rows: Vec<wire::TradeRow> = serde_json::from_value(Value::Array(data.clone()))?;
                let t = rows
                    .iter()
                    .map(|r| trade(&self.spec, r, Some(local_ns)))
                    .collect::<Result<Vec<_>>>()?;
                Ok(vec![Action::Trades(t)])
            }
            "books" => {
                let action = v
                    .get("action")
                    .and_then(Value::as_str)
                    .unwrap_or("update")
                    .to_string();
                let mut out = Vec::new();
                for d in data {
                    let b: wire::Book = serde_json::from_value(d.clone())?;
                    out.extend(self.on_book(&action, b, local_ns)?);
                }
                Ok(out)
            }
            c => Ok(vec![Action::Stats(self.stats(c, data, local_ns))]),
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
pub struct Okx {
    rest: Rest,
    pub ws_url: String,
}

impl Default for Okx {
    fn default() -> Self {
        Self::new(REST_BASE, WS_URL)
    }
}

fn server_ms(text: &str) -> Option<i64> {
    let v: Value = serde_json::from_str(text).ok()?;
    v.pointer("/data/0/ts").and_then(num_f64).map(|x| x as i64)
}

impl Okx {
    pub fn new(rest: &str, ws: &str) -> Self {
        Self {
            rest: Rest::new(rest, TokenBucket::new(10, Duration::from_secs(1))),
            ws_url: ws.into(),
        }
    }

    async fn get<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<Vec<T>> {
        let r: wire::Rest<T> = self.rest.get(path).await?;
        if r.code != "0" {
            return Err(ConnectorError::Api(format!("okx {}: {}", r.code, r.msg)));
        }
        Ok(r.data)
    }

    pub async fn symbol_spec(&self, inst_id: &str) -> Result<SymbolSpec> {
        let id = inst_id.to_uppercase();
        let list: Vec<wire::Instrument> = self
            .get(&format!(
                "/api/v5/public/instruments?instType={}&instId={id}",
                inst_type(&id)
            ))
            .await?;
        let inst = list
            .into_iter()
            .find(|i| i.inst_id == id)
            .ok_or_else(|| ConnectorError::UnknownSymbol(inst_id.into()))?;
        spec_from(inst)
    }

    pub async fn depth(&self, spec: &SymbolSpec) -> Result<BookLevels> {
        let books: Vec<wire::Book> = self
            .get(&format!(
                "/api/v5/market/books?instId={}&sz={BOOK_DEPTH}",
                spec.symbol
            ))
            .await?;
        let b = books
            .into_iter()
            .next()
            .ok_or_else(|| ConnectorError::Api("okx: empty book".into()))?;
        let scale = |rows: Vec<(i64, f64)>| {
            rows.into_iter()
                .map(|(p, q)| (p, scale_qty(q, spec.contract_value, spec.qty_precision)))
                .collect::<Vec<_>>()
        };
        Ok((
            scale(levels(&spec.tick, &b.bids)?),
            scale(levels(&spec.tick, &b.asks)?),
        ))
    }

    /// Latest trades, then `history-trades` pages (newest → oldest) until `from_ms` or the page cap.
    pub async fn trades_range(
        &self,
        spec: &SymbolSpec,
        from_ms: i64,
        to_ms: i64,
        max_pages: u32,
    ) -> Result<Vec<Trade>> {
        let mut rows: Vec<wire::TradeRow> = self
            .get(&format!(
                "/api/v5/market/trades?instId={}&limit=500",
                spec.symbol
            ))
            .await?;
        let mut out = rows
            .iter()
            .map(|r| trade(spec, r, None))
            .collect::<Result<Vec<_>>>()?;
        for _ in 0..max_pages {
            let oldest = rows
                .iter()
                .min_by_key(|r| r.ts.parse::<i64>().unwrap_or(i64::MAX));
            let Some(o) = oldest else { break };
            if o.ts.parse::<i64>().unwrap_or(0) <= from_ms {
                break;
            }
            rows = self
                .get(&format!(
                    "/api/v5/market/history-trades?instId={}&type=1&after={}&limit=100",
                    spec.symbol, o.trade_id
                ))
                .await?;
            if rows.is_empty() {
                break;
            }
            for r in &rows {
                out.push(trade(spec, r, None)?);
            }
        }
        Ok(finish_trades(out, from_ms, to_ms))
    }
}

impl Okx {
    /// Newest-first download of `[from_ms, to_ms)` (P06 "Load days"): the first
    /// `history-trades` page is anchored by timestamp (`type=2&after=to_ms`), the next pages
    /// continue by trade id (`type=1&after=<oldest id>`), 100 rows each, until `from_ms` or the
    /// page budget.
    pub async fn trades_before(
        &self,
        spec: &SymbolSpec,
        from_ms: i64,
        to_ms: i64,
        max_pages: u32,
    ) -> Result<TradesBack> {
        let mut out = TradesBack {
            covered_from_ms: to_ms,
            ..TradesBack::default()
        };
        let mut cursor = format!("type=2&after={to_ms}");
        let mut all: Vec<Trade> = Vec::new();
        while out.pages < max_pages && from_ms < to_ms {
            let rows: Vec<wire::TradeRow> = self
                .get(&format!(
                    "/api/v5/market/history-trades?instId={}&{cursor}&limit=100",
                    spec.symbol
                ))
                .await?;
            out.pages += 1;
            let oldest = rows
                .iter()
                .filter_map(|r| r.ts.parse::<i64>().ok().map(|ts| (ts, r)))
                .min_by_key(|(ts, _)| *ts);
            let Some((oldest_ms, oldest_row)) = oldest else {
                out.covered_from_ms = from_ms; // start of the available history
                break;
            };
            for r in &rows {
                all.push(trade(spec, r, None)?);
            }
            if oldest_ms < from_ms {
                out.covered_from_ms = from_ms;
                break;
            }
            out.covered_from_ms = (oldest_ms + 1).min(to_ms);
            cursor = format!("type=1&after={}", oldest_row.trade_id);
        }
        let lo = out.covered_from_ms * 1_000_000;
        all.retain(|t| t.exchange_ts_ns >= lo);
        out.trades = finish_trades(all, out.covered_from_ms, to_ms - 1);
        Ok(out)
    }
}

/// Sort oldest first, drop duplicates, keep `[from_ms, to_ms]`.
pub fn finish_trades(mut v: Vec<Trade>, from_ms: i64, to_ms: i64) -> Vec<Trade> {
    let (lo, hi) = (from_ms * 1_000_000, (to_ms + 1) * 1_000_000);
    v.retain(|t| t.exchange_ts_ns >= lo && t.exchange_ts_ns < hi);
    v.sort_by_key(|t| (t.exchange_ts_ns, t.trade_id));
    v.dedup_by_key(|t| t.trade_id);
    v
}

impl MarketApi for Okx {
    fn venue(&self) -> &'static str {
        "okx-swap"
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
        Box::pin(self.trades_range(spec, from_ms, to_ms, 60))
    }
    fn history_from_start(&self) -> bool {
        false
    }
    fn windowed_trades(&self) -> bool {
        true
    }
    fn trades_back<'a>(
        &'a self,
        spec: &'a SymbolSpec,
        from_ms: i64,
        to_ms: i64,
        max_pages: u32,
    ) -> BoxFuture<'a, Result<TradesBack>> {
        Box::pin(self.trades_before(spec, from_ms, to_ms, max_pages))
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
            "okx",
            &spec.symbol,
            self.ws_url.clone(),
            Arc::clone(&self.rest.clock),
        );
        cfg.ping = Ping::Text("ping".into());
        cfg.ping_every = Duration::from_secs(25);
        cfg.time_probe = Some(self.rest.time_probe("/api/v5/public/time", server_ms));
        Box::pin(driver::run(cfg, OkxProtocol::new(spec), tx, stop))
    }
    fn clock(&self) -> &ClockSkew {
        &self.rest.clock
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use htflow_connector_common::crc32;

    fn spec() -> SymbolSpec {
        SymbolSpec {
            symbol: "BTC-USDT-SWAP".into(),
            tick: TickSize::parse("0.1").unwrap(),
            qty_precision: 4,
            contract_value: 0.01,
        }
    }

    fn checksum(s: &str) -> i32 {
        crc32(s.as_bytes()) as i32
    }

    fn snap() -> String {
        let cs = checksum("42000.1:12:42000.2:5:42000:3:42000.5:1");
        format!(
            r#"{{"arg":{{"channel":"books","instId":"BTC-USDT-SWAP"}},"action":"snapshot","data":[{{"asks":[["42000.2","5","0","1"],["42000.5","1","0","1"]],"bids":[["42000.1","12","0","2"],["42000","3","0","1"]],"ts":"1700000000000","checksum":{cs},"prevSeqId":-1,"seqId":100}}]}}"#
        )
    }

    fn update(prev: i64, seq: i64, bids: &str, asks: &str, cs: i32) -> String {
        format!(
            r#"{{"arg":{{"channel":"books","instId":"BTC-USDT-SWAP"}},"action":"update","data":[{{"asks":{asks},"bids":{bids},"ts":"1700000000100","checksum":{cs},"prevSeqId":{prev},"seqId":{seq}}}]}}"#
        )
    }

    #[test]
    fn instrument_types() {
        assert_eq!(inst_type("BTC-USDT-SWAP"), "SWAP");
        assert_eq!(inst_type("BTC-USD-251226"), "FUTURES");
        assert_eq!(inst_type("BTC-USDT"), "SPOT");
        assert_eq!(inst_type("BTC-USD-251226-100000-C"), "OPTION");
    }

    #[test]
    fn subscribes_and_parses_trades() {
        let mut p = OkxProtocol::new(spec());
        let sub = p.on_open();
        assert!(sub[0].contains(r#""channel":"books""#));
        assert!(sub[0].contains("liquidation-orders"));
        let t = r#"{"arg":{"channel":"trades","instId":"BTC-USDT-SWAP"},"data":[{"instId":"BTC-USDT-SWAP","tradeId":"130639474","px":"42219.9","sz":"12","side":"buy","ts":"1630048897897","count":"3"}]}"#;
        let a = p.on_text(t, 5).unwrap();
        let Action::Trades(tr) = &a[0] else { panic!() };
        assert_eq!(tr[0].px, 422_199);
        assert_eq!(tr[0].qty, 0.12); // 12 contracts × 0.01 BTC
        assert_eq!(tr[0].aggressor, Aggressor::Buy);
        assert_eq!(tr[0].trade_id, 130_639_474);
        assert_eq!(tr[0].local_ts_ns, 5);
        assert!(p.on_text("pong", 0).unwrap().is_empty());
    }

    #[test]
    fn book_snapshot_update_duplicate_gap_and_checksum() {
        let mut p = OkxProtocol::new(spec());
        p.on_open();
        // Update before snapshot → ignored.
        assert!(p
            .on_text(&update(99, 100, "[]", "[]", 0), 0)
            .unwrap()
            .is_empty());
        let a = p.on_text(&snap(), 0).unwrap();
        let Action::Synced(s) = &a[0] else {
            panic!("{a:?}")
        };
        assert_eq!(s.bids, vec![(420_001, 0.12), (420_000, 0.03)]);
        assert!(p.synced());
        // In-sequence update: bid 42000.1 removed, new ask 42000.3.
        let cs = checksum("42000:3:42000.2:5:42000.3:2:42000.5:1");
        let u1 = update(
            100,
            101,
            r#"[["42000.1","0","0","0"]]"#,
            r#"[["42000.3","2","0","1"]]"#,
            cs,
        );
        let a = p.on_text(&u1, 0).unwrap();
        let Action::Deltas(d) = &a[0] else {
            panic!("{a:?}")
        };
        assert_eq!(d.len(), 2);
        // Replayed duplicate → ignored. Heartbeat update (prev == seq) → applied, empty.
        assert!(p.on_text(&u1, 0).unwrap().is_empty());
        let hb = update(101, 101, "[]", "[]", cs);
        assert!(matches!(&p.on_text(&hb, 0).unwrap()[0], Action::Deltas(d) if d.is_empty()));
        // Gap → resync (unsubscribe + subscribe books), book stale.
        let gap = update(105, 106, "[]", "[]", cs);
        let a = p.on_text(&gap, 0).unwrap();
        let Action::Resync { send, rest } = &a[0] else {
            panic!()
        };
        assert_eq!(send.len(), 2);
        assert!(!rest);
        assert!(!p.synced());
        assert_eq!(p.gaps, 1);
        // Snapshot again, then a checksum mismatch → resync.
        p.on_text(&snap(), 0).unwrap();
        let bad = update(100, 101, r#"[["42000.1","1","0","1"]]"#, "[]", 12345);
        assert!(matches!(
            &p.on_text(&bad, 0).unwrap()[0],
            Action::Resync { .. }
        ));
        assert_eq!(p.checksum_errors, 1);
    }

    #[test]
    fn stats_and_errors() {
        let mut p = OkxProtocol::new(spec());
        p.on_open();
        let f = r#"{"arg":{"channel":"funding-rate","instId":"BTC-USDT-SWAP"},"data":[{"fundingRate":"0.0001","fundingTime":"1703059200000","instId":"BTC-USDT-SWAP","instType":"SWAP","nextFundingRate":"","ts":"1703050000000"}]}"#;
        let a = p.on_text(f, 0).unwrap();
        let Action::Stats(s) = &a[0] else { panic!() };
        assert!(
            matches!(s[0], MarketStat::Funding { rate, next_ts_ns, .. } if rate == 0.0001 && next_ts_ns == 1_703_059_200_000_000_000)
        );
        let oi = r#"{"arg":{"channel":"open-interest","instId":"BTC-USDT-SWAP"},"data":[{"instId":"BTC-USDT-SWAP","instType":"SWAP","oi":"500000","oiCcy":"5000","ts":"1703050000000"}]}"#;
        let Action::Stats(s) = &p.on_text(oi, 0).unwrap()[0] else {
            panic!()
        };
        assert!(matches!(s[0], MarketStat::OpenInterest { oi, .. } if oi == 5000.0));
        let liq = r#"{"arg":{"channel":"liquidation-orders","instType":"SWAP"},"data":[{"details":[{"bkLoss":"0","bkPx":"41000.5","ccy":"","posSide":"long","side":"sell","sz":"30","ts":"1703050000100"}],"instId":"BTC-USDT-SWAP","instType":"SWAP"},{"details":[{"bkPx":"1","side":"buy","sz":"1","ts":"1"}],"instId":"ETH-USDT-SWAP"}]}"#;
        let Action::Stats(s) = &p.on_text(liq, 0).unwrap()[0] else {
            panic!()
        };
        assert_eq!(
            s,
            &vec![MarketStat::Liquidation {
                ts_ns: 1_703_050_000_100_000_000,
                side: Side::Sell,
                px: 410_005,
                qty: 0.3
            }]
        );
        let err = r#"{"event":"error","code":"60018","msg":"Wrong URL or channel:books,instId:FOO-SWAP doesn't exist."}"#;
        assert!(matches!(&p.on_text(err, 0).unwrap()[0], Action::Fail(m) if m.contains("60018")));
        let ok = r#"{"event":"subscribe","arg":{"channel":"trades","instId":"BTC-USDT-SWAP"},"connId":"a4d3ae55"}"#;
        assert!(p.on_text(ok, 0).unwrap().is_empty());
    }

    #[test]
    fn rest_shapes() {
        let i = r#"{"code":"0","msg":"","data":[{"instType":"SWAP","instId":"BTC-USDT-SWAP","ctType":"linear","ctVal":"0.01","ctValCcy":"BTC","lotSz":"0.01","tickSz":"0.1","state":"live"}]}"#;
        let r: wire::Rest<wire::Instrument> = serde_json::from_str(i).unwrap();
        let sp = spec_from(r.data.into_iter().next().unwrap()).unwrap();
        assert_eq!(sp.contract_value, 0.01);
        assert_eq!(sp.qty_precision, 4);
        let inv = r#"{"instId":"BTC-USD-SWAP","ctType":"inverse","ctVal":"100","lotSz":"1","tickSz":"0.1"}"#;
        let sp = spec_from(serde_json::from_str(inv).unwrap()).unwrap();
        assert_eq!(sp.contract_value, 1.0);
        let err = r#"{"code":"51001","msg":"Instrument ID does not exist","data":[]}"#;
        let r: wire::Rest<wire::Instrument> = serde_json::from_str(err).unwrap();
        assert_eq!(r.code, "51001");
        assert_eq!(
            server_ms(r#"{"code":"0","data":[{"ts":"1597026383085"}],"msg":""}"#),
            Some(1_597_026_383_085)
        );
        let rows: Vec<wire::TradeRow> = serde_json::from_str(r#"[{"instId":"BTC-USDT-SWAP","side":"sell","sz":"1","px":"42000","tradeId":"2","ts":"1000"},{"instId":"BTC-USDT-SWAP","side":"buy","sz":"1","px":"42000","tradeId":"1","ts":"900"}]"#).unwrap();
        let t: Vec<Trade> = rows
            .iter()
            .map(|r| trade(&spec(), r, None).unwrap())
            .collect();
        let mut dup = t.clone();
        dup.extend(t);
        let f = finish_trades(dup, 0, 2000);
        assert_eq!(f.iter().map(|t| t.trade_id).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(finish_trades(f, 950, 2000).len(), 1);
    }

    #[tokio::test]
    async fn trades_before_pages_newest_first() {
        use htflow_connector_common::mock_http::{query_param, MockServer, Reply};
        // Trade id i at ts 1000 + i * 10 ms, ids 0..1000.
        let srv = MockServer::start(|t| {
            let after: i64 = query_param(t, "after").unwrap().parse().unwrap();
            // type=2: earlier than a timestamp; type=1: earlier than a trade id.
            let end_id = if query_param(t, "type") == Some("2") {
                (after - 1000 + 9) / 10
            } else {
                after
            };
            let rows: Vec<String> = ((end_id - 100).max(0)..end_id.min(1000))
                .rev()
                .map(|i| {
                    format!(
                        r#"{{"instId":"BTC-USDT-SWAP","side":"buy","sz":"1","px":"42000","tradeId":"{i}","ts":"{}"}}"#,
                        1000 + i * 10
                    )
                })
                .collect();
            Reply::ok(format!(
                r#"{{"code":"0","msg":"","data":[{}]}}"#,
                rows.join(",")
            ))
        });
        let okx = Okx::new(&srv.base, "ws://unused");
        let sp = spec();
        // [3000, 6000): ids 200..500, newest page first.
        let r = okx.trades_before(&sp, 3000, 6000, 50).await.unwrap();
        assert_eq!(r.covered_from_ms, 3000);
        assert_eq!(r.trades.len(), 300);
        assert_eq!(r.trades[0].exchange_ts_ns, 3_000_000_000);
        let reqs = srv.requests();
        assert!(reqs[0].contains("type=2&after=6000"), "{reqs:?}");
        assert!(reqs[1].contains("type=1&after=400"), "{reqs:?}");
        // A budget of one page.
        let r = okx.trades_before(&sp, 3000, 6000, 1).await.unwrap();
        assert_eq!(r.covered_from_ms, 5001);
        assert_eq!(r.trades.len(), 99);
        assert!(okx.windowed_trades());
    }
}
