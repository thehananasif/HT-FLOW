//! Phemex USDT perpetuals (hedged-mode contracts, real-value `_p` API) — free, no API key (P05).
//!
//! * Socket `wss://ws.phemex.com`: `trade_p`, `orderbook_p` (full book) and
//!   `perp_market24h_pack_p` (mark price, funding rate, open interest for all symbols — the
//!   row of ours is picked by the `fields` header). Heartbeat: `server.ping` every 20 s.
//! * Book: `snapshot` resets; `incremental` messages must carry a larger `sequence` (older =
//!   duplicate, ignored). Phemex sequences are not contiguous per symbol, so a lost incremental
//!   cannot be detected from the numbers; the snapshot re-sent on every reconnect bounds the
//!   damage. Sizes of zero remove a level.
//! * Phemex publishes no trade ids: a deterministic id is derived from (ns time, price, size,
//!   side), identical for REST and WebSocket, so the history/live seam de-duplicates.
//! * REST: products, order book, recent trades (latest ~1,000), server time. 10 req/s bucket.
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use htflow_connector_common::{
    driver, levels, num_f64, num_text, synthetic_id, Action, BookLevels, ClockSkew, ConnectorError,
    Kline, L2Book, MarketApi, Ping, Protocol, Rest, Result, StreamConfig, SymbolSpec, TokenBucket,
};
use htflow_core_types::{
    decimals_of, Aggressor, BookSnapshot, MarketEvent, MarketStat, TickSize, Trade,
};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

pub mod klines;

pub const REST_BASE: &str = "https://api.phemex.com";
pub const WS_URL: &str = "wss://ws.phemex.com";

/// `[ts_ns, "Buy"|"Sell", price, size]` → trade.
fn trade_row(spec: &SymbolSpec, r: &[Value], local_ns: Option<i64>) -> Result<Trade> {
    let ts = r.first().and_then(num_f64).map(|t| t as i64);
    let side = r.get(1).and_then(Value::as_str);
    let px = r.get(2).and_then(num_text);
    let qty = r.get(3).and_then(num_f64);
    let (Some(ts), Some(side), Some(px), Some(qty)) = (ts, side, px, qty) else {
        return Err(ConnectorError::Other("bad trade row".into()));
    };
    let px = spec.tick.parse_ticks(&px)?;
    let aggressor = match side {
        "Buy" => Aggressor::Buy,
        "Sell" => Aggressor::Sell,
        _ => Aggressor::Unknown,
    };
    Ok(Trade {
        exchange_ts_ns: ts,
        local_ts_ns: local_ns.unwrap_or(ts),
        px,
        qty,
        aggressor,
        trade_id: synthetic_id(ts, px, qty, aggressor.as_i8()),
    })
}

fn book_side(v: Option<&Value>) -> Vec<Vec<Value>> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|r| r.as_array().cloned()).collect())
        .unwrap_or_default()
}

// ------------------------------------------------------------------ protocol

pub struct PhemexProtocol {
    spec: SymbolSpec,
    book: L2Book,
    last_seq: Option<u64>,
    last_stats_ns: i64,
}

impl PhemexProtocol {
    pub fn new(spec: SymbolSpec) -> Self {
        Self {
            spec,
            book: L2Book::default(),
            last_seq: None,
            last_stats_ns: 0,
        }
    }

    fn pack(&mut self, v: &Value, local_ns: i64) -> Vec<MarketStat> {
        if local_ns - self.last_stats_ns < 1_000_000_000 {
            return Vec::new();
        }
        let Some(fields) = v.get("fields").and_then(Value::as_array) else {
            return Vec::new();
        };
        let idx = |name: &str| fields.iter().position(|f| f.as_str() == Some(name));
        let (Some(sym_i), Some(rows)) = (idx("symbol"), v.get("data").and_then(Value::as_array))
        else {
            return Vec::new();
        };
        let Some(row) = rows
            .iter()
            .filter_map(Value::as_array)
            .find(|r| r.get(sym_i).and_then(Value::as_str) == Some(self.spec.symbol.as_str()))
        else {
            return Vec::new();
        };
        self.last_stats_ns = local_ns;
        let get = |name: &str| idx(name).and_then(|i| row.get(i)).and_then(num_f64);
        let ts = v
            .get("timestamp")
            .and_then(num_f64)
            .map(|t| t as i64)
            .unwrap_or(local_ns);
        let mut out = Vec::new();
        if let Some(rate) = get("fundingRateRr") {
            out.push(MarketStat::Funding {
                ts_ns: ts,
                rate,
                next_ts_ns: 0,
                mark_price: get("markRp").unwrap_or(f64::NAN),
            });
        }
        if let Some(oi) = get("openInterestRv") {
            out.push(MarketStat::OpenInterest {
                ts_ns: ts,
                oi,
                value: f64::NAN,
            });
        }
        out
    }
}

impl Protocol for PhemexProtocol {
    fn on_open(&mut self) -> Vec<String> {
        self.book.clear();
        self.last_seq = None;
        let s = &self.spec.symbol;
        vec![
            json!({"id": 1, "method": "trade_p.subscribe", "params": [s]}).to_string(),
            json!({"id": 2, "method": "orderbook_p.subscribe", "params": [s, true]}).to_string(),
            json!({"id": 3, "method": "perp_market24h_pack_p.subscribe", "params": []}).to_string(),
        ]
    }

    fn on_text(&mut self, text: &str, local_ns: i64) -> Result<Vec<Action>> {
        let v: Value = serde_json::from_str(text)?;
        if let Some(e) = v.get("error").filter(|e| !e.is_null()) {
            return Ok(vec![Action::Fail(format!(
                "phemex {}: {}",
                e.get("code").and_then(Value::as_i64).unwrap_or(0),
                e.get("message").and_then(Value::as_str).unwrap_or("")
            ))]);
        }
        if v.get("result").is_some() {
            return Ok(Vec::new()); // subscribe / pong replies
        }
        if v.get("method").and_then(Value::as_str) == Some("perp_market24h_pack_p.update") {
            return Ok(vec![Action::Stats(self.pack(&v, local_ns))]);
        }
        if v.get("symbol").and_then(Value::as_str) != Some(self.spec.symbol.as_str()) {
            return Ok(Vec::new());
        }
        let snapshot = v.get("type").and_then(Value::as_str) == Some("snapshot");
        if let Some(rows) = v.get("trades_p").and_then(Value::as_array) {
            if snapshot {
                return Ok(Vec::new()); // recent trades on subscribe: history comes from REST
            }
            let mut t = rows
                .iter()
                .filter_map(Value::as_array)
                .map(|r| trade_row(&self.spec, r, Some(local_ns)))
                .collect::<Result<Vec<_>>>()?;
            t.sort_by_key(|t| t.exchange_ts_ns);
            return Ok(vec![Action::Trades(t)]);
        }
        if let Some(b) = v.get("orderbook_p") {
            let seq = v.get("sequence").and_then(Value::as_u64).unwrap_or(0);
            let bids = levels(&self.spec.tick, &book_side(b.get("bids")))?;
            let asks = levels(&self.spec.tick, &book_side(b.get("asks")))?;
            if snapshot {
                self.book.clear();
                self.book.apply(&bids, &asks);
                self.last_seq = Some(seq);
                return Ok(vec![Action::Synced(self.book.snapshot(local_ns))]);
            }
            match self.last_seq {
                Some(last) if seq > last => {
                    self.last_seq = Some(seq);
                    return Ok(vec![Action::Deltas(self.book.apply(&bids, &asks))]);
                }
                _ => return Ok(Vec::new()), // duplicate, or waiting for the snapshot
            }
        }
        Ok(Vec::new())
    }

    fn synced(&self) -> bool {
        self.last_seq.is_some()
    }

    fn book_snapshot(&self, ts_ns: i64) -> BookSnapshot {
        self.book.snapshot(ts_ns)
    }
}

// ------------------------------------------------------------------ REST + MarketApi

mod wire {
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    pub struct Products {
        pub code: i64,
        #[serde(default)]
        pub msg: String,
        pub data: Option<ProductData>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ProductData {
        #[serde(default)]
        pub perp_products_v2: Vec<Product>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Product {
        pub symbol: String,
        pub tick_size: String,
        #[serde(default)]
        pub qty_step_size: String,
    }
}

#[derive(Clone)]
pub struct Phemex {
    rest: Rest,
    pub ws_url: String,
}

impl Default for Phemex {
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

/// `/md/v2/*` envelope: `{"error":null,"id":0,"result":{…}}`.
fn md_result(v: Value) -> Result<Value> {
    if let Some(e) = v.get("error").filter(|e| !e.is_null()) {
        return Err(ConnectorError::Api(format!("phemex: {e}")));
    }
    v.get("result")
        .cloned()
        .ok_or_else(|| ConnectorError::Api("phemex: empty result".into()))
}

pub fn spec_from(symbol: &str, p: wire::Products) -> Result<SymbolSpec> {
    if p.code != 0 {
        return Err(ConnectorError::Api(format!("phemex {}: {}", p.code, p.msg)));
    }
    let prod = p
        .data
        .map(|d| d.perp_products_v2)
        .unwrap_or_default()
        .into_iter()
        .find(|x| x.symbol.eq_ignore_ascii_case(symbol))
        .ok_or_else(|| ConnectorError::UnknownSymbol(symbol.into()))?;
    Ok(SymbolSpec::new(
        prod.symbol,
        TickSize::parse(&prod.tick_size)?,
        decimals_of(&prod.qty_step_size),
    ))
}

impl Phemex {
    pub fn new(rest: &str, ws: &str) -> Self {
        Self {
            rest: Rest::new(rest, TokenBucket::new(10, Duration::from_secs(1))),
            ws_url: ws.into(),
        }
    }

    pub async fn symbol_spec(&self, symbol: &str) -> Result<SymbolSpec> {
        let p: wire::Products = self.rest.get("/public/products").await?;
        spec_from(symbol, p)
    }

    pub async fn depth(&self, spec: &SymbolSpec) -> Result<BookLevels> {
        let r = md_result(
            self.rest
                .get(&format!("/md/v2/orderbook?symbol={}", spec.symbol))
                .await?,
        )?;
        let b = r.get("orderbook_p").cloned().unwrap_or(Value::Null);
        Ok((
            levels(&spec.tick, &book_side(b.get("bids")))?,
            levels(&spec.tick, &book_side(b.get("asks")))?,
        ))
    }

    /// The latest trades Phemex serves publicly (no time-range paging), oldest first.
    pub async fn recent_trades(&self, spec: &SymbolSpec) -> Result<Vec<Trade>> {
        let r = md_result(
            self.rest
                .get(&format!("/md/v2/trade?symbol={}", spec.symbol))
                .await?,
        )?;
        let mut t = r
            .get("trades_p")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_array)
            .map(|row| trade_row(spec, row, None))
            .collect::<Result<Vec<_>>>()?;
        t.sort_by_key(|t| t.exchange_ts_ns);
        Ok(t)
    }
}

impl MarketApi for Phemex {
    fn venue(&self) -> &'static str {
        "phemex"
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
        _from_ms: i64,
        _to_ms: i64,
    ) -> BoxFuture<'a, Result<Vec<Trade>>> {
        Box::pin(self.recent_trades(spec))
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
            "phemex",
            &spec.symbol,
            self.ws_url.clone(),
            Arc::clone(&self.rest.clock),
        );
        cfg.ping = Ping::Text(json!({"id": 0, "method": "server.ping", "params": []}).to_string());
        cfg.time_probe = Some(self.rest.time_probe("/public/time", server_ms));
        Box::pin(driver::run(cfg, PhemexProtocol::new(spec), tx, stop))
    }
    fn clock(&self) -> &ClockSkew {
        &self.rest.clock
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> SymbolSpec {
        SymbolSpec::new("BTCUSDT", TickSize::parse("0.1").unwrap(), 3)
    }

    #[test]
    fn trades_book_and_replies() {
        let mut p = PhemexProtocol::new(spec());
        assert_eq!(p.on_open().len(), 3);
        assert!(p
            .on_text(r#"{"error":null,"id":1,"result":{"status":"success"}}"#, 0)
            .unwrap()
            .is_empty());
        assert!(p
            .on_text(r#"{"error":null,"id":0,"result":"pong"}"#, 0)
            .unwrap()
            .is_empty());
        let snap_tr = r#"{"sequence":1,"symbol":"BTCUSDT","trades_p":[[1700000000000000000,"Buy","42000.1","0.010"]],"type":"snapshot"}"#;
        assert!(p.on_text(snap_tr, 0).unwrap().is_empty());
        let tr = r#"{"sequence":2,"symbol":"BTCUSDT","trades_p":[[1700000000100000000,"Sell","42000.0","0.250"]],"type":"incremental"}"#;
        let Action::Trades(t) = &p.on_text(tr, 5).unwrap()[0] else {
            panic!()
        };
        assert_eq!(
            (t[0].px, t[0].qty, t[0].aggressor),
            (420_000, 0.25, Aggressor::Sell)
        );
        assert_eq!(
            t[0].trade_id,
            synthetic_id(1_700_000_000_100_000_000, 420_000, 0.25, -1)
        );
        let ob = r#"{"orderbook_p":{"asks":[["42000.2","1.5"]],"bids":[["42000.1","2.0"],["42000.0","1.0"]]},"depth":0,"sequence":100,"symbol":"BTCUSDT","timestamp":1700000000000000000,"type":"snapshot"}"#;
        let Action::Synced(s) = &p.on_text(ob, 0).unwrap()[0] else {
            panic!()
        };
        assert_eq!(s.bids[0], (420_001, 2.0));
        let inc = r#"{"orderbook_p":{"asks":[],"bids":[["42000.1","0"]]},"depth":0,"sequence":105,"symbol":"BTCUSDT","timestamp":1700000000100000000,"type":"incremental"}"#;
        assert!(matches!(&p.on_text(inc, 0).unwrap()[0], Action::Deltas(d) if d[0].qty == 0.0));
        assert!(p.on_text(inc, 0).unwrap().is_empty()); // duplicate
        assert_eq!(p.book.best_bid(), Some(420_000));
        // Other symbols ignored; errors fail the session.
        assert!(p
            .on_text(&ob.replace("BTCUSDT", "ETHUSDT"), 0)
            .unwrap()
            .is_empty());
        let err = r#"{"error":{"code":6001,"message":"invalid argument"},"id":2,"result":null}"#;
        assert!(matches!(&p.on_text(err, 0).unwrap()[0], Action::Fail(m) if m.contains("6001")));
    }

    #[test]
    fn market_pack_stats() {
        let mut p = PhemexProtocol::new(spec());
        let pack = r#"{"data":[["ETHUSDT","1","1","1","1","1","1","10","1","1","0.0002","0"],["BTCUSDT","42000","42500","41500","42100","1200","50000000","5321.5","42050","42060.5","0.0001","0.00012"]],"fields":["symbol","openRp","highRp","lowRp","lastRp","volumeRq","turnoverRv","openInterestRv","indexRp","markRp","fundingRateRr","predFundingRateRr"],"method":"perp_market24h_pack_p.update","timestamp":1700000000000000000,"type":"snapshot"}"#;
        let Action::Stats(s) = &p.on_text(pack, 2_000_000_000).unwrap()[0] else {
            panic!()
        };
        assert_eq!(
            s[0],
            MarketStat::Funding {
                ts_ns: 1_700_000_000_000_000_000,
                rate: 0.0001,
                next_ts_ns: 0,
                mark_price: 42060.5
            }
        );
        assert!(matches!(s[1], MarketStat::OpenInterest { oi, .. } if oi == 5321.5));
    }

    #[test]
    fn rest_shapes() {
        let prods: wire::Products = serde_json::from_str(r#"{"code":0,"msg":"","data":{"products":[],"perpProductsV2":[{"symbol":"BTCUSDT","tickSize":"0.1","qtyStepSize":"0.001","type":"PerpetualV2"}]}}"#).unwrap();
        let sp = spec_from("btcusdt", prods).unwrap();
        assert_eq!((sp.tick.as_f64(), sp.qty_precision), (0.1, 3));
        let r = md_result(
            serde_json::from_str(
                r#"{"error":null,"id":0,"result":{"orderbook_p":{"asks":[["1","2"]],"bids":[]}}}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert!(r.get("orderbook_p").is_some());
        assert!(md_result(
            serde_json::from_str(r#"{"error":{"code":1},"id":0,"result":null}"#).unwrap()
        )
        .is_err());
        assert_eq!(
            server_ms(r#"{"code":0,"msg":"","data":{"serverTime":1700000000123}}"#),
            Some(1_700_000_000_123)
        );
    }
}
