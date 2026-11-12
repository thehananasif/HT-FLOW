//! Bitget v2 futures public market data (P05) — free, no API key.
//!
//! * Socket `wss://ws.bitget.com/v2/ws/public`: `trade`, `books` (full depth, snapshot then
//!   updates) and `ticker` (funding rate, next funding time, open interest, mark price) for the
//!   product type derived from the symbol (`BTCUSDT` → USDT-FUTURES, `BTCUSD` → COIN-FUTURES,
//!   `BTCPERP` / `…USDC` → USDC-FUTURES). Heartbeat: text `ping` every 25 s → `pong`.
//! * Book: `snapshot` resets; updates must carry `pseq == last seq` when Bitget sends `pseq`,
//!   otherwise a strictly larger `seq` (older = duplicate). Every message's CRC32 `checksum`
//!   over the top 25 levels is verified; a gap or mismatch re-subscribes `books`.
//! * The trade `snapshot` pushed on subscribe is skipped (history comes from REST).
//! * REST: contracts, merged depth, fills history (paged backwards with `idLessThan`),
//!   server time. 10 requests/s token bucket (public limit 20/s per IP).
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use htflow_connector_common::{
    driver, hash_id, levels, num_f64, num_text, raw_levels, Action, BookLevels, ClockSkew,
    ConnectorError, L2Book, MarketApi, Ping, Protocol, Rest, Result, StreamConfig, SymbolSpec,
    TokenBucket,
};
use htflow_core_types::{Aggressor, BookSnapshot, MarketEvent, MarketStat, TickSize, Trade};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

pub const REST_BASE: &str = "https://api.bitget.com";
pub const WS_URL: &str = "wss://ws.bitget.com/v2/ws/public";
const CHECKSUM_DEPTH: usize = 25;

/// Bitget product type of a futures symbol.
pub fn product_type(symbol: &str) -> &'static str {
    let s = symbol.to_uppercase();
    if s.ends_with("USDT") {
        "USDT-FUTURES"
    } else if s.ends_with("PERP") || s.ends_with("USDC") {
        "USDC-FUTURES"
    } else {
        "COIN-FUTURES"
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
        pub data: Option<T>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Contract {
        pub symbol: String,
        pub price_place: String,
        #[serde(default = "one")]
        pub price_end_step: String,
        pub volume_place: String,
    }

    fn one() -> String {
        "1".into()
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TradeRow {
        pub trade_id: String,
        pub price: String,
        pub size: String,
        pub side: String,
        pub ts: String,
    }

    #[derive(Debug, Deserialize)]
    pub struct Book {
        #[serde(default)]
        pub asks: Vec<Vec<Value>>,
        #[serde(default)]
        pub bids: Vec<Vec<Value>>,
        #[serde(default)]
        pub checksum: Option<i64>,
        #[serde(default)]
        pub seq: Option<u64>,
        #[serde(default)]
        pub pseq: Option<u64>,
    }
}

fn trade(spec: &SymbolSpec, r: &wire::TradeRow, local_ns: Option<i64>) -> Result<Trade> {
    let ts: i64 =
        r.ts.parse()
            .map_err(|_| ConnectorError::Other(format!("bad ts {}", r.ts)))?;
    Ok(Trade {
        exchange_ts_ns: ts * 1_000_000,
        local_ts_ns: local_ns.unwrap_or(ts * 1_000_000),
        px: spec.tick.parse_ticks(&r.price)?,
        qty: htflow_connector_common::parse_f64(&r.size)?,
        aggressor: match r.side.to_ascii_lowercase().as_str() {
            "buy" => Aggressor::Buy,
            "sell" => Aggressor::Sell,
            _ => Aggressor::Unknown,
        },
        trade_id: hash_id(&r.trade_id),
    })
}

fn spec_from(c: &wire::Contract) -> Result<SymbolSpec> {
    let scale: u32 = c
        .price_place
        .parse()
        .map_err(|_| ConnectorError::Other("bad pricePlace".into()))?;
    let units: i64 = c.price_end_step.parse().unwrap_or(1).max(1);
    Ok(SymbolSpec::new(
        c.symbol.clone(),
        TickSize { scale, units },
        c.volume_place.parse().unwrap_or(3),
    ))
}

// ------------------------------------------------------------------ protocol

pub struct BitgetProtocol {
    spec: SymbolSpec,
    book: L2Book,
    last_seq: Option<u64>,
    last_stats_ns: i64,
    pub gaps: u64,
    pub checksum_errors: u64,
}

impl BitgetProtocol {
    pub fn new(spec: SymbolSpec) -> Self {
        Self {
            spec,
            book: L2Book::default(),
            last_seq: None,
            last_stats_ns: 0,
            gaps: 0,
            checksum_errors: 0,
        }
    }

    fn arg(&self, channel: &str) -> Value {
        json!({"instType": product_type(&self.spec.symbol), "channel": channel, "instId": self.spec.symbol})
    }

    fn resync(&mut self) -> Action {
        self.last_seq = None;
        Action::Resync {
            send: vec![
                json!({"op": "unsubscribe", "args": [self.arg("books")]}).to_string(),
                json!({"op": "subscribe", "args": [self.arg("books")]}).to_string(),
            ],
            rest: false,
        }
    }

    fn on_book(&mut self, snapshot: bool, b: wire::Book, local_ns: i64) -> Result<Vec<Action>> {
        let seq = b.seq.unwrap_or(0);
        let bids = raw_levels(&self.spec.tick, &b.bids)?;
        let asks = raw_levels(&self.spec.tick, &b.asks)?;
        let delta = if snapshot {
            self.book.clear();
            self.book.apply_raw(&bids, &asks);
            None
        } else {
            let Some(last) = self.last_seq else {
                return Ok(Vec::new());
            };
            let in_order = match b.pseq {
                Some(p) => p == last,
                None => seq > last,
            };
            if !in_order {
                if seq <= last {
                    return Ok(Vec::new()); // duplicate
                }
                self.gaps += 1;
                return Ok(vec![self.resync()]);
            }
            Some(self.book.apply_raw(&bids, &asks))
        };
        self.last_seq = Some(seq);
        if let Some(cs) = b.checksum.filter(|c| *c != 0) {
            if i64::from(self.book.crc_checksum(CHECKSUM_DEPTH)) != cs {
                self.checksum_errors += 1;
                tracing::warn!(symbol = %self.spec.symbol, "bitget book checksum mismatch");
                return Ok(vec![self.resync()]);
            }
        }
        Ok(vec![match delta {
            None => Action::Synced(self.book.snapshot(local_ns)),
            Some(d) => Action::Deltas(d),
        }])
    }

    fn on_ticker(&mut self, d: &Value, local_ns: i64) -> Vec<MarketStat> {
        if local_ns - self.last_stats_ns < 1_000_000_000 {
            return Vec::new();
        }
        self.last_stats_ns = local_ns;
        let ts = d
            .get("ts")
            .and_then(num_f64)
            .map(|t| t as i64 * 1_000_000)
            .unwrap_or(local_ns);
        let mut out = Vec::new();
        if let Some(rate) = d.get("fundingRate").and_then(num_f64) {
            out.push(MarketStat::Funding {
                ts_ns: ts,
                rate,
                next_ts_ns: d
                    .get("nextFundingTime")
                    .and_then(num_f64)
                    .map(|t| t as i64 * 1_000_000)
                    .unwrap_or(0),
                mark_price: d.get("markPrice").and_then(num_f64).unwrap_or(f64::NAN),
            });
        }
        if let Some(oi) = d.get("holdingAmount").and_then(num_f64) {
            out.push(MarketStat::OpenInterest {
                ts_ns: ts,
                oi,
                value: f64::NAN,
            });
        }
        out
    }
}

impl Protocol for BitgetProtocol {
    fn on_open(&mut self) -> Vec<String> {
        self.book.clear();
        self.last_seq = None;
        vec![json!({"op": "subscribe", "args": [self.arg("trade"), self.arg("books"), self.arg("ticker")]}).to_string()]
    }

    fn on_text(&mut self, text: &str, local_ns: i64) -> Result<Vec<Action>> {
        if text == "pong" {
            return Ok(Vec::new());
        }
        let v: Value = serde_json::from_str(text)?;
        if let Some(ev) = v.get("event").and_then(Value::as_str) {
            if ev == "error" {
                let msg = format!(
                    "bitget {}: {}",
                    v.get("code").and_then(num_text).unwrap_or_default(),
                    v.get("msg").and_then(Value::as_str).unwrap_or("")
                );
                return Ok(vec![Action::Fail(msg)]);
            }
            return Ok(Vec::new());
        }
        let channel = v
            .pointer("/arg/channel")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let snapshot = v.get("action").and_then(Value::as_str) == Some("snapshot");
        let Some(Value::Array(data)) = v.get("data") else {
            return Ok(Vec::new());
        };
        match channel.as_str() {
            "trade" if !snapshot => {
                let rows: Vec<wire::TradeRow> = serde_json::from_value(Value::Array(data.clone()))?;
                let mut t = rows
                    .iter()
                    .map(|r| trade(&self.spec, r, Some(local_ns)))
                    .collect::<Result<Vec<_>>>()?;
                t.sort_by_key(|t| t.exchange_ts_ns);
                Ok(vec![Action::Trades(t)])
            }
            "books" => {
                let mut out = Vec::new();
                for d in data {
                    let b: wire::Book = serde_json::from_value(d.clone())?;
                    out.extend(self.on_book(snapshot, b, local_ns)?);
                }
                Ok(out)
            }
            "ticker" => Ok(data
                .first()
                .map(|d| vec![Action::Stats(self.on_ticker(d, local_ns))])
                .unwrap_or_default()),
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
pub struct Bitget {
    rest: Rest,
    pub ws_url: String,
}

impl Default for Bitget {
    fn default() -> Self {
        Self::new(REST_BASE, WS_URL)
    }
}

fn server_ms(text: &str) -> Option<i64> {
    let v: Value = serde_json::from_str(text).ok()?;
    v.pointer("/data/serverTime")
        .and_then(num_f64)
        .map(|x| x as i64)
}

impl Bitget {
    pub fn new(rest: &str, ws: &str) -> Self {
        Self {
            rest: Rest::new(rest, TokenBucket::new(10, Duration::from_secs(1))),
            ws_url: ws.into(),
        }
    }

    async fn get<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T> {
        let r: wire::Rest<T> = self.rest.get(path).await?;
        if r.code != "00000" {
            return Err(ConnectorError::Api(format!("bitget {}: {}", r.code, r.msg)));
        }
        r.data
            .ok_or_else(|| ConnectorError::Api("bitget: empty data".into()))
    }

    pub async fn symbol_spec(&self, symbol: &str) -> Result<SymbolSpec> {
        let s = symbol.to_uppercase();
        let list: Vec<wire::Contract> = self
            .get(&format!(
                "/api/v2/mix/market/contracts?productType={}&symbol={s}",
                product_type(&s)
            ))
            .await?;
        let c = list
            .iter()
            .find(|c| c.symbol == s)
            .ok_or_else(|| ConnectorError::UnknownSymbol(symbol.into()))?;
        spec_from(c)
    }

    pub async fn depth(&self, spec: &SymbolSpec) -> Result<BookLevels> {
        let b: wire::Book = self
            .get(&format!(
                "/api/v2/mix/market/merge-depth?productType={}&symbol={}&limit=max",
                product_type(&spec.symbol),
                spec.symbol
            ))
            .await?;
        Ok((levels(&spec.tick, &b.bids)?, levels(&spec.tick, &b.asks)?))
    }

    /// Trades in `[from_ms, to_ms]`: `fills-history` newest first, paged with `idLessThan`.
    pub async fn trades_range(
        &self,
        spec: &SymbolSpec,
        from_ms: i64,
        to_ms: i64,
        max_pages: u32,
    ) -> Result<Vec<Trade>> {
        let pt = product_type(&spec.symbol);
        let mut out = Vec::new();
        let mut before: Option<String> = None;
        for _ in 0..max_pages {
            let mut q = format!(
                "/api/v2/mix/market/fills-history?productType={pt}&symbol={}&limit=1000&startTime={from_ms}&endTime={to_ms}",
                spec.symbol
            );
            if let Some(id) = &before {
                q.push_str(&format!("&idLessThan={id}"));
            }
            let rows: Vec<wire::TradeRow> = self.get(&q).await?;
            for r in &rows {
                out.push(trade(spec, r, None)?);
            }
            let oldest = rows
                .iter()
                .min_by_key(|r| r.ts.parse::<i64>().unwrap_or(i64::MAX));
            match oldest {
                Some(o) if rows.len() >= 1000 && o.ts.parse::<i64>().unwrap_or(0) > from_ms => {
                    before = Some(o.trade_id.clone())
                }
                _ => break,
            }
        }
        out.retain(|t| t.exchange_ts_ns >= from_ms * 1_000_000);
        out.sort_by_key(|t| (t.exchange_ts_ns, t.trade_id));
        out.dedup_by_key(|t| t.trade_id);
        Ok(out)
    }
}

impl MarketApi for Bitget {
    fn venue(&self) -> &'static str {
        "bitget"
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
    fn stream(
        &self,
        spec: SymbolSpec,
        tx: mpsc::Sender<MarketEvent>,
        stop: watch::Receiver<bool>,
    ) -> BoxFuture<'static, ()> {
        let mut cfg = StreamConfig::new(
            "bitget",
            &spec.symbol,
            self.ws_url.clone(),
            Arc::clone(&self.rest.clock),
        );
        cfg.ping = Ping::Text("ping".into());
        cfg.ping_every = Duration::from_secs(25);
        cfg.time_probe = Some(self.rest.time_probe("/api/v2/public/time", server_ms));
        Box::pin(driver::run(cfg, BitgetProtocol::new(spec), tx, stop))
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
        SymbolSpec::new("BTCUSDT", TickSize::parse("0.1").unwrap(), 3)
    }

    fn msg(action: &str, channel: &str, data: &str) -> String {
        format!(
            r#"{{"action":"{action}","arg":{{"instType":"USDT-FUTURES","channel":"{channel}","instId":"BTCUSDT"}},"data":{data},"ts":1695716059516}}"#
        )
    }

    fn book(seq: u64, pseq: Option<u64>, bids: &str, asks: &str, cs: i32) -> String {
        let p = pseq.map(|p| format!(r#","pseq":{p}"#)).unwrap_or_default();
        format!(
            r#"[{{"asks":{asks},"bids":{bids},"checksum":{cs},"seq":{seq}{p},"ts":"1695716059516"}}]"#
        )
    }

    #[test]
    fn product_types_and_spec() {
        assert_eq!(product_type("BTCUSDT"), "USDT-FUTURES");
        assert_eq!(product_type("BTCUSD"), "COIN-FUTURES");
        assert_eq!(product_type("BTCPERP"), "USDC-FUTURES");
        let r: wire::Rest<Vec<wire::Contract>> = serde_json::from_str(r#"{"code":"00000","msg":"success","requestTime":1,"data":[{"symbol":"ETHUSDT","pricePlace":"2","priceEndStep":"5","volumePlace":"2","sizeMultiplier":"0.01"}]}"#).unwrap();
        let sp = spec_from(&r.data.unwrap()[0]).unwrap();
        assert_eq!(sp.tick, TickSize::parse("0.05").unwrap());
        assert_eq!(sp.qty_precision, 2);
        assert_eq!(
            server_ms(r#"{"code":"00000","msg":"success","data":{"serverTime":"1688008631614"}}"#),
            Some(1_688_008_631_614)
        );
    }

    #[test]
    fn trades_skip_snapshot() {
        let mut p = BitgetProtocol::new(spec());
        let sub = p.on_open();
        assert!(sub[0].contains(r#""channel":"ticker""#));
        let rows = r#"[{"ts":"1695716760565","price":"27000.5","size":"0.001","side":"buy","tradeId":"1111111111"},{"ts":"1695716760560","price":"27000.4","size":"0.5","side":"sell","tradeId":"1111111110"}]"#;
        assert!(p
            .on_text(&msg("snapshot", "trade", rows), 0)
            .unwrap()
            .is_empty());
        let a = p.on_text(&msg("update", "trade", rows), 0).unwrap();
        let Action::Trades(t) = &a[0] else { panic!() };
        assert_eq!(t[0].trade_id, 1_111_111_110); // sorted oldest first
        assert_eq!(t[1].aggressor, Aggressor::Buy);
        assert_eq!(t[1].px, 270_005);
    }

    #[test]
    fn book_sequence_checksum_and_errors() {
        let mut p = BitgetProtocol::new(spec());
        p.on_open();
        let cs0 = crc32(b"27000.1:2:27000.2:1") as i32;
        let snap = msg(
            "snapshot",
            "books",
            &book(
                10,
                None,
                r#"[["27000.1","2"]]"#,
                r#"[["27000.2","1"]]"#,
                cs0,
            ),
        );
        assert!(matches!(
            &p.on_text(&snap, 0).unwrap()[0],
            Action::Synced(_)
        ));
        let cs1 = crc32(b"27000.1:3:27000.2:1") as i32;
        let up = msg(
            "update",
            "books",
            &book(11, Some(10), r#"[["27000.1","3"]]"#, "[]", cs1),
        );
        assert!(matches!(&p.on_text(&up, 0).unwrap()[0], Action::Deltas(d) if d.len() == 1));
        assert!(p.on_text(&up, 0).unwrap().is_empty()); // duplicate
        let gap = msg("update", "books", &book(14, Some(13), "[]", "[]", cs1));
        assert!(matches!(
            &p.on_text(&gap, 0).unwrap()[0],
            Action::Resync { .. }
        ));
        assert_eq!(p.gaps, 1);
        p.on_text(&snap, 0).unwrap();
        let bad = msg(
            "update",
            "books",
            &book(11, None, r#"[["27000.1","9"]]"#, "[]", 42),
        );
        assert!(matches!(
            &p.on_text(&bad, 0).unwrap()[0],
            Action::Resync { .. }
        ));
        assert_eq!(p.checksum_errors, 1);
        let err = r#"{"event":"error","code":30001,"msg":"instType:USDT-FUTURES,channel:books,instId:NOPE doesn't exist"}"#;
        assert!(matches!(&p.on_text(err, 0).unwrap()[0], Action::Fail(m) if m.contains("30001")));
        assert!(p.on_text("pong", 0).unwrap().is_empty());
    }

    #[test]
    fn ticker_stats() {
        let mut p = BitgetProtocol::new(spec());
        let t = r#"[{"instId":"BTCUSDT","lastPr":"27000.5","fundingRate":"0.000068","nextFundingTime":"1695722400000","holdingAmount":"60000.5","markPrice":"27000.0","ts":"1695715383021"}]"#;
        let Action::Stats(s) = &p
            .on_text(&msg("snapshot", "ticker", t), 5_000_000_000)
            .unwrap()[0]
        else {
            panic!()
        };
        assert_eq!(s.len(), 2);
        assert!(
            matches!(s[0], MarketStat::Funding { rate, next_ts_ns, .. } if rate == 0.000068 && next_ts_ns == 1_695_722_400_000_000_000)
        );
        assert!(matches!(s[1], MarketStat::OpenInterest { oi, .. } if oi == 60000.5));
    }
}
