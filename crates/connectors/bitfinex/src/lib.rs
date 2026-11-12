//! Bitfinex v2 public market data (P05) — free, no API key. Spot pairs (`tBTCUSD`) and
//! perpetuals (`tBTCF0:USTF0`).
//!
//! * Socket `wss://api-pub.bitfinex.com/ws/2`: `conf` with `SEQ_ALL` (every message carries a
//!   connection sequence number), then `trades`, `book` (P0, F0, 250 levels) and, for
//!   perpetuals, `status deriv:<sym>` (funding, open interest, mark price) plus
//!   `status liq:global` (liquidations, filtered to the symbol). WebSocket pings every 20 s;
//!   Bitfinex also sends `hb` every 15 s.
//! * Sequencing: each message's sequence must be the previous + 1 (older = duplicate). A jump
//!   means a message was lost on this connection, so the session reconnects and every channel
//!   (and the book snapshot) is re-sent. Book rows are `[price, count, amount]`: amount > 0 is a
//!   bid, < 0 an ask; count 0 removes the level.
//! * Bitfinex prices have 5 significant digits rather than a fixed tick: the tick is derived
//!   from the last price (e.g. 1 for 60 000, 0.1 for 3 000).
//! * REST: ticker (tick + symbol check), book, trade history (forward pages of up to 10 000).
//!   The public trades endpoint allows 15 requests/min, so REST is limited to 10/min.
//!   No time endpoint: the clock offset comes from the HTTP `Date` header.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use htflow_connector_common::{
    driver, f64_ticks, num_f64, Action, BookLevels, ClockSkew, ConnectorError, L2Book, MarketApi,
    Ping, Protocol, Rest, Result, StreamConfig, SymbolSpec, TokenBucket,
};
use htflow_core_types::{Aggressor, BookSnapshot, MarketEvent, MarketStat, Side, TickSize, Trade};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

pub const REST_BASE: &str = "https://api-pub.bitfinex.com";
pub const WS_URL: &str = "wss://api-pub.bitfinex.com/ws/2";
const SEQ_ALL: u64 = 65_536;

/// `BTCUSD` → `tBTCUSD`; already prefixed ids are kept.
pub fn normalise(symbol: &str) -> String {
    let s = symbol.trim();
    if s.starts_with('t') {
        s.to_string()
    } else {
        format!("t{}", s.to_uppercase())
    }
}

pub fn is_deriv(symbol: &str) -> bool {
    symbol.contains("F0:")
}

/// Tick for 5 significant digits at `last` (60 000 → 1, 3 000 → 0.1, 0.5 → 0.00001).
pub fn tick_for(last: f64) -> TickSize {
    if !last.is_finite() || last <= 0.0 {
        return TickSize { scale: 8, units: 1 };
    }
    let exp = last.log10().floor() as i32 - 4;
    if exp >= 0 {
        TickSize {
            scale: 0,
            units: 10i64.pow(exp as u32),
        }
    } else {
        TickSize {
            scale: (-exp).min(12) as u32,
            units: 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Chan {
    Trades,
    Book,
    Deriv,
    Liq,
}

fn trade_of(spec: &SymbolSpec, r: &[Value], local_ns: Option<i64>) -> Result<Trade> {
    let get = |i: usize| r.get(i).and_then(num_f64);
    let (Some(id), Some(ms), Some(amount), Some(price)) = (get(0), get(1), get(2), get(3)) else {
        return Err(ConnectorError::Other("bad trade row".into()));
    };
    let ms = ms as i64;
    Ok(Trade {
        exchange_ts_ns: ms * 1_000_000,
        local_ts_ns: local_ns.unwrap_or(ms * 1_000_000),
        px: f64_ticks(&spec.tick, price)?,
        qty: amount.abs(),
        aggressor: if amount > 0.0 {
            Aggressor::Buy
        } else if amount < 0.0 {
            Aggressor::Sell
        } else {
            Aggressor::Unknown
        },
        trade_id: id as u64,
    })
}

/// `[price, count, amount]` rows → `(bids, asks)` (count 0 = delete).
fn book_rows(spec: &SymbolSpec, rows: &[Value]) -> Result<BookLevels> {
    let (mut bids, mut asks) = (Vec::new(), Vec::new());
    for r in rows {
        let get = |i: usize| r.get(i).and_then(num_f64);
        let (Some(p), Some(c), Some(a)) = (get(0), get(1), get(2)) else {
            return Err(ConnectorError::Other("bad book row".into()));
        };
        let px = f64_ticks(&spec.tick, p)?;
        let qty = if c == 0.0 { 0.0 } else { a.abs() };
        if a > 0.0 {
            bids.push((px, qty));
        } else {
            asks.push((px, qty));
        }
    }
    Ok((bids, asks))
}

// ------------------------------------------------------------------ protocol

pub struct BitfinexProtocol {
    spec: SymbolSpec,
    book: L2Book,
    chans: HashMap<i64, Chan>,
    last_seq: Option<u64>,
    book_synced: bool,
    last_stats_ns: i64,
}

impl BitfinexProtocol {
    pub fn new(spec: SymbolSpec) -> Self {
        Self {
            spec,
            book: L2Book::default(),
            chans: HashMap::new(),
            last_seq: None,
            book_synced: false,
            last_stats_ns: 0,
        }
    }

    fn deriv(&mut self, d: &[Value], local_ns: i64) -> Vec<MarketStat> {
        if local_ns - self.last_stats_ns < 1_000_000_000 {
            return Vec::new();
        }
        self.last_stats_ns = local_ns;
        let get = |i: usize| d.get(i).and_then(num_f64);
        let ts = get(0).map(|t| t as i64 * 1_000_000).unwrap_or(local_ns);
        let mut out = Vec::new();
        if let Some(rate) = get(11) {
            out.push(MarketStat::Funding {
                ts_ns: ts,
                rate,
                next_ts_ns: get(7).map(|t| t as i64 * 1_000_000).unwrap_or(0),
                mark_price: get(14).unwrap_or(f64::NAN),
            });
        }
        if let Some(oi) = get(17) {
            out.push(MarketStat::OpenInterest {
                ts_ns: ts,
                oi,
                value: f64::NAN,
            });
        }
        out
    }

    fn liqs(&self, rows: &[Value]) -> Vec<MarketStat> {
        rows.iter()
            .filter_map(|r| {
                let r = r.as_array()?;
                if r.get(4)?.as_str()? != self.spec.symbol {
                    return None;
                }
                let amount = r.get(5).and_then(num_f64)?;
                let price = r
                    .get(11)
                    .and_then(num_f64)
                    .or_else(|| r.get(6).and_then(num_f64))?;
                Some(MarketStat::Liquidation {
                    ts_ns: r.get(2).and_then(num_f64)? as i64 * 1_000_000,
                    // A long position (amount > 0) is closed by a sell.
                    side: if amount > 0.0 { Side::Sell } else { Side::Buy },
                    px: f64_ticks(&self.spec.tick, price).ok()?,
                    qty: amount.abs(),
                })
            })
            .collect()
    }
}

impl Protocol for BitfinexProtocol {
    fn on_open(&mut self) -> Vec<String> {
        self.book.clear();
        self.chans.clear();
        self.last_seq = None;
        self.book_synced = false;
        let s = &self.spec.symbol;
        let mut m = vec![
            json!({"event": "conf", "flags": SEQ_ALL}).to_string(),
            json!({"event": "subscribe", "channel": "trades", "symbol": s}).to_string(),
            json!({"event": "subscribe", "channel": "book", "symbol": s, "prec": "P0", "freq": "F0", "len": "250"}).to_string(),
        ];
        if is_deriv(s) {
            m.push(
                json!({"event": "subscribe", "channel": "status", "key": format!("deriv:{s}")})
                    .to_string(),
            );
            m.push(
                json!({"event": "subscribe", "channel": "status", "key": "liq:global"}).to_string(),
            );
        }
        m
    }

    fn on_text(&mut self, text: &str, local_ns: i64) -> Result<Vec<Action>> {
        let v: Value = serde_json::from_str(text)?;
        if let Some(ev) = v.get("event").and_then(Value::as_str) {
            match ev {
                "subscribed" => {
                    let id = v.get("chanId").and_then(Value::as_i64).unwrap_or(-1);
                    let kind = match (
                        v.get("channel").and_then(Value::as_str),
                        v.get("key").and_then(Value::as_str),
                    ) {
                        (Some("trades"), _) => Some(Chan::Trades),
                        (Some("book"), _) => Some(Chan::Book),
                        (Some("status"), Some(k)) if k.starts_with("liq:") => Some(Chan::Liq),
                        (Some("status"), _) => Some(Chan::Deriv),
                        _ => None,
                    };
                    if let Some(k) = kind {
                        self.chans.insert(id, k);
                    }
                }
                "error" => {
                    return Ok(vec![Action::Fail(format!(
                        "bitfinex {}: {}",
                        v.get("code").and_then(Value::as_i64).unwrap_or(0),
                        v.get("msg").and_then(Value::as_str).unwrap_or("")
                    ))])
                }
                _ => {}
            }
            return Ok(Vec::new());
        }
        let Some(arr) = v.as_array() else {
            return Ok(Vec::new());
        };
        let Some(chan) = arr.first().and_then(Value::as_i64) else {
            return Ok(Vec::new());
        };
        // SEQ_ALL: the last element is the connection sequence number.
        if let Some(seq) = arr
            .last()
            .and_then(Value::as_u64)
            .filter(|_| arr.len() >= 3)
        {
            if let Some(last) = self.last_seq {
                if seq <= last {
                    return Ok(Vec::new());
                }
                if seq != last + 1 {
                    return Ok(vec![Action::Fail(format!(
                        "bitfinex sequence gap {last} → {seq}; reconnecting"
                    ))]);
                }
            }
            self.last_seq = Some(seq);
        }
        let Some(kind) = self.chans.get(&chan).copied() else {
            return Ok(Vec::new());
        };
        let payload = arr.get(1).unwrap_or(&Value::Null);
        if payload.as_str() == Some("hb") {
            return Ok(Vec::new());
        }
        match kind {
            Chan::Trades => {
                if payload.as_str() == Some("te") {
                    if let Some(r) = arr.get(2).and_then(Value::as_array) {
                        return Ok(vec![Action::Trades(vec![trade_of(
                            &self.spec,
                            r,
                            Some(local_ns),
                        )?])]);
                    }
                }
                Ok(Vec::new()) // snapshot (history comes from REST) and "tu" duplicates
            }
            Chan::Book => {
                let Some(p) = payload.as_array() else {
                    return Ok(Vec::new());
                };
                if p.first().is_some_and(Value::is_array) {
                    let (b, a) = book_rows(&self.spec, p)?;
                    self.book.clear();
                    self.book.apply(&b, &a);
                    self.book_synced = true;
                    return Ok(vec![Action::Synced(self.book.snapshot(local_ns))]);
                }
                if !self.book_synced {
                    return Ok(Vec::new());
                }
                let (b, a) = book_rows(&self.spec, std::slice::from_ref(payload))?;
                Ok(vec![Action::Deltas(self.book.apply(&b, &a))])
            }
            Chan::Deriv => {
                let stats = payload
                    .as_array()
                    .map(|d| self.deriv(d, local_ns))
                    .unwrap_or_default();
                Ok(vec![Action::Stats(stats)])
            }
            Chan::Liq => Ok(vec![Action::Stats(
                payload.as_array().map(|r| self.liqs(r)).unwrap_or_default(),
            )]),
        }
    }

    fn synced(&self) -> bool {
        self.book_synced
    }

    fn book_snapshot(&self, ts_ns: i64) -> BookSnapshot {
        self.book.snapshot(ts_ns)
    }
}

// ------------------------------------------------------------------ REST + MarketApi

#[derive(Clone)]
pub struct Bitfinex {
    rest: Rest,
    pub ws_url: String,
}

impl Default for Bitfinex {
    fn default() -> Self {
        Self::new(REST_BASE, WS_URL)
    }
}

fn api_error(v: &Value) -> Option<ConnectorError> {
    let a = v.as_array()?;
    if a.first()?.as_str()? == "error" {
        return Some(ConnectorError::Api(format!(
            "bitfinex {}: {}",
            a.get(1).and_then(Value::as_i64).unwrap_or(0),
            a.get(2).and_then(Value::as_str).unwrap_or("")
        )));
    }
    None
}

/// Spec from the REST ticker (`[BID, …, LAST_PRICE (6), …]`, derivatives the same layout).
pub fn spec_from_ticker(symbol: &str, v: &Value) -> Result<SymbolSpec> {
    if let Some(e) = api_error(v) {
        return Err(e);
    }
    let last = v
        .as_array()
        .filter(|a| !a.is_empty())
        .and_then(|a| a.get(6))
        .and_then(num_f64)
        .ok_or_else(|| ConnectorError::UnknownSymbol(symbol.into()))?;
    Ok(SymbolSpec::new(symbol, tick_for(last), 6))
}

impl Bitfinex {
    pub fn new(rest: &str, ws: &str) -> Self {
        Self {
            rest: Rest::new(rest, TokenBucket::new(10, Duration::from_secs(60))),
            ws_url: ws.into(),
        }
    }

    async fn get(&self, path: &str) -> Result<Value> {
        let v: Value = self.rest.get(path).await?;
        match api_error(&v) {
            Some(e) => Err(e),
            None => Ok(v),
        }
    }

    pub async fn symbol_spec(&self, symbol: &str) -> Result<SymbolSpec> {
        let s = normalise(symbol);
        let v = self.get(&format!("/v2/ticker/{s}")).await?;
        spec_from_ticker(&s, &v)
    }

    pub async fn depth(&self, spec: &SymbolSpec) -> Result<BookLevels> {
        let v = self
            .get(&format!("/v2/book/{}/P0?len=250", spec.symbol))
            .await?;
        let rows = v.as_array().cloned().unwrap_or_default();
        let (mut b, mut a) = book_rows(spec, &rows)?;
        b.sort_by_key(|x| std::cmp::Reverse(x.0));
        a.sort_by_key(|x| x.0);
        Ok((b, a))
    }

    /// Trades in `[from_ms, to_ms]`, ascending pages of up to 10 000.
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
            let v = self
                .get(&format!(
                    "/v2/trades/{}/hist?limit=10000&start={start}&end={to_ms}&sort=1",
                    spec.symbol
                ))
                .await?;
            let rows = v.as_array().cloned().unwrap_or_default();
            for r in &rows {
                if let Some(r) = r.as_array() {
                    out.push(trade_of(spec, r, None)?);
                }
            }
            match out.last() {
                Some(l) if rows.len() >= 10_000 => start = l.exchange_ts_ns / 1_000_000,
                _ => break,
            }
        }
        out.sort_by_key(|t| (t.exchange_ts_ns, t.trade_id));
        out.dedup_by_key(|t| t.trade_id);
        Ok(out)
    }
}

impl MarketApi for Bitfinex {
    fn venue(&self) -> &'static str {
        "bitfinex"
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
        Box::pin(self.trades_range(spec, from_ms, to_ms, 3))
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
            "bitfinex",
            &spec.symbol,
            self.ws_url.clone(),
            Arc::clone(&self.rest.clock),
        );
        cfg.ping = Ping::Frame;
        Box::pin(driver::run(cfg, BitfinexProtocol::new(spec), tx, stop))
    }
    fn clock(&self) -> &ClockSkew {
        &self.rest.clock
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(sym: &str) -> SymbolSpec {
        SymbolSpec::new(sym, TickSize::parse("1").unwrap(), 6)
    }

    fn subscribed(p: &mut BitfinexProtocol) {
        for m in [
            r#"{"event":"info","version":2,"serverId":"x","platform":{"status":1}}"#,
            r#"{"event":"conf","status":"OK","flags":65536}"#,
            r#"{"event":"subscribed","channel":"trades","chanId":17470,"symbol":"tBTCF0:USTF0","pair":"BTCF0:USTF0"}"#,
            r#"{"event":"subscribed","channel":"book","chanId":17471,"symbol":"tBTCF0:USTF0","prec":"P0","freq":"F0","len":"250"}"#,
            r#"{"event":"subscribed","channel":"status","chanId":17472,"key":"deriv:tBTCF0:USTF0"}"#,
            r#"{"event":"subscribed","channel":"status","chanId":17473,"key":"liq:global"}"#,
        ] {
            assert!(p.on_text(m, 0).unwrap().is_empty());
        }
    }

    #[test]
    fn ticks_and_symbols() {
        assert_eq!(tick_for(60_123.0), TickSize { scale: 0, units: 1 });
        assert_eq!(
            tick_for(123_456.0),
            TickSize {
                scale: 0,
                units: 10
            }
        );
        assert_eq!(tick_for(3_012.5), TickSize { scale: 1, units: 1 });
        assert_eq!(tick_for(0.5123), TickSize { scale: 5, units: 1 });
        assert_eq!(normalise("btcusd"), "tBTCUSD");
        assert_eq!(normalise("tBTCF0:USTF0"), "tBTCF0:USTF0");
        assert!(is_deriv("tBTCF0:USTF0"));
        let v: Value =
            serde_json::from_str("[60000,1.5,60001,2.1,-120,-0.002,60000,1234.5,61000,59000]")
                .unwrap();
        let sp = spec_from_ticker("tBTCUSD", &v).unwrap();
        assert_eq!(sp.tick.as_f64(), 1.0);
        let e: Value = serde_json::from_str(r#"["error",10020,"symbol: invalid"]"#).unwrap();
        assert!(spec_from_ticker("tFOO", &e).is_err());
        assert!(matches!(
            spec_from_ticker("tFOO", &Value::Array(vec![])),
            Err(ConnectorError::UnknownSymbol(_))
        ));
    }

    #[test]
    fn subscribes_trades_book_and_sequence() {
        let mut p = BitfinexProtocol::new(spec("tBTCF0:USTF0"));
        let open = p.on_open();
        assert_eq!(open.len(), 5);
        assert!(open[0].contains("65536"));
        subscribed(&mut p);
        // Trade snapshot skipped; seq 1.
        assert!(p
            .on_text("[17470,[[401597395,1574694478808,0.005,7245.3]],1]", 0)
            .unwrap()
            .is_empty());
        let Action::Synced(s) = &p
            .on_text("[17471,[[7254,1,0.5],[7253,2,1.5],[7255,1,-2]],2]", 0)
            .unwrap()[0]
        else {
            panic!()
        };
        assert_eq!(s.bids, vec![(7254, 0.5), (7253, 1.5)]);
        assert_eq!(s.asks, vec![(7255, 2.0)]);
        let a = p
            .on_text(r#"[17470,"te",[401597396,1574694478900,-0.25,7254],3]"#, 9)
            .unwrap();
        let Action::Trades(t) = &a[0] else { panic!() };
        assert_eq!(
            (t[0].aggressor, t[0].qty, t[0].trade_id),
            (Aggressor::Sell, 0.25, 401_597_396)
        );
        assert!(p
            .on_text(r#"[17470,"tu",[401597396,1574694478900,-0.25,7254],4]"#, 0)
            .unwrap()
            .is_empty());
        // Delete bid 7254 (count 0, amount 1 = bid side).
        let a = p.on_text("[17471,[7254,0,1],5]", 0).unwrap();
        assert!(matches!(&a[0], Action::Deltas(d) if d[0].qty == 0.0 && d[0].side == Side::Buy));
        assert!(p.on_text(r#"[17471,"hb",6]"#, 0).unwrap().is_empty());
        // Duplicate (old seq) ignored, gap → reconnect.
        assert!(p.on_text("[17471,[7250,1,9],6]", 0).unwrap().is_empty());
        assert!(
            matches!(&p.on_text("[17471,[7250,1,9],9]", 0).unwrap()[0], Action::Fail(m) if m.contains("gap"))
        );
    }

    #[test]
    fn deriv_status_and_liquidations() {
        let mut p = BitfinexProtocol::new(spec("tBTCF0:USTF0"));
        p.on_open();
        subscribed(&mut p);
        let st = "[17472,[1596124822000,null,11064.5,11059.0,null,1950000,null,1596153600000,0.0001,4,null,0.00012,null,null,11062.0,null,null,4321.5,null,null,null,null,null],1]";
        let Action::Stats(s) = &p.on_text(st, 2_000_000_000).unwrap()[0] else {
            panic!()
        };
        assert_eq!(
            s[0],
            MarketStat::Funding {
                ts_ns: 1_596_124_822_000_000_000,
                rate: 0.00012,
                next_ts_ns: 1_596_153_600_000_000_000,
                mark_price: 11062.0
            }
        );
        assert!(matches!(s[1], MarketStat::OpenInterest { oi, .. } if oi == 4321.5));
        let liq = r#"[17473,[["pos",145400868,1609144352338,null,"tBTCF0:USTF0",0.05,26580,null,1,1,null,26421]],2]"#;
        let Action::Stats(s) = &p.on_text(liq, 0).unwrap()[0] else {
            panic!()
        };
        assert_eq!(
            s,
            &vec![MarketStat::Liquidation {
                ts_ns: 1_609_144_352_338_000_000,
                side: Side::Sell,
                px: 26_421,
                qty: 0.05
            }]
        );
        let other = r#"[17473,[["pos",1,1,null,"tETHF0:USTF0",-1,1,null,1,1,null,1]],3]"#;
        assert!(matches!(&p.on_text(other, 0).unwrap()[0], Action::Stats(s) if s.is_empty()));
        let err = r#"{"event":"error","msg":"symbol: invalid","code":10300}"#;
        assert!(matches!(&p.on_text(err, 0).unwrap()[0], Action::Fail(m) if m.contains("10300")));
    }
}
