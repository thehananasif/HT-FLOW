//! WhiteBIT public market data (P05) — free, no API key. Spot markets (`BTC_USDT`) and
//! perpetuals (`BTC_PERP`).
//!
//! * Socket `wss://api.whitebit.com/ws`: `trades_subscribe` and `depth_subscribe` (100 levels,
//!   no price grouping, multiple-subscription mode). Heartbeat: `ping` every 25 s → `pong`.
//! * Book: `depth_update` with `full_reload = true` resets the book; other updates must carry
//!   `past_update_id == last update_id` when WhiteBIT sends it (older = duplicate). A gap
//!   re-subscribes the depth channel, which makes WhiteBIT push a full reload.
//! * Funding rate and open interest are not streamed: `/api/v4/public/futures` is polled every
//!   30 s for perpetuals.
//! * REST: markets, order book, recent trades, server time. 10 requests/s token bucket.
pub mod instruments;

use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use htflow_connector_common::{
    driver, levels, num_f64, num_text, Action, BookLevels, ClockSkew, ConnectorError, Kline,
    L2Book, MarketApi, Ping, Protocol, Rest, Result, StreamConfig, SymbolSpec, TokenBucket,
};
use htflow_core_types::{Aggressor, BookSnapshot, MarketEvent, MarketStat, TickSize, Trade};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

pub mod klines;

pub const REST_BASE: &str = "https://whitebit.com";
pub const WS_URL: &str = "wss://api.whitebit.com/ws";

fn aggressor(side: &str) -> Aggressor {
    match side {
        "buy" => Aggressor::Buy,
        "sell" => Aggressor::Sell,
        _ => Aggressor::Unknown,
    }
}

fn rows(v: Option<&Value>) -> Vec<Vec<Value>> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|r| r.as_array().cloned()).collect())
        .unwrap_or_default()
}

/// ms from seconds-or-ms numbers (`1580905394.70332` s, `1700000000000` ms).
fn to_ms(x: f64) -> i64 {
    if x < 1e11 {
        (x * 1000.0).round() as i64
    } else {
        x as i64
    }
}

// ------------------------------------------------------------------ protocol

pub struct WhitebitProtocol {
    spec: SymbolSpec,
    book: L2Book,
    last_update: Option<u64>,
    synced: bool,
    pub gaps: u64,
}

impl WhitebitProtocol {
    pub fn new(spec: SymbolSpec) -> Self {
        Self {
            spec,
            book: L2Book::default(),
            last_update: None,
            synced: false,
            gaps: 0,
        }
    }

    fn depth_sub(&self, id: u64) -> String {
        json!({"id": id, "method": "depth_subscribe", "params": [self.spec.symbol, 100, "0", true]})
            .to_string()
    }

    fn on_depth(&mut self, p: &[Value], local_ns: i64) -> Result<Vec<Action>> {
        if p.get(2).and_then(Value::as_str) != Some(self.spec.symbol.as_str()) {
            return Ok(Vec::new());
        }
        let full = p.first().and_then(Value::as_bool).unwrap_or(false);
        let Some(d) = p.get(1) else {
            return Ok(Vec::new());
        };
        let upd = d.get("update_id").and_then(Value::as_u64);
        let bids = levels(&self.spec.tick, &rows(d.get("bids")))?;
        let asks = levels(&self.spec.tick, &rows(d.get("asks")))?;
        if full {
            self.book.clear();
            self.book.apply(&bids, &asks);
            self.last_update = upd;
            self.synced = true;
            return Ok(vec![Action::Synced(self.book.snapshot(local_ns))]);
        }
        if !self.synced {
            return Ok(Vec::new());
        }
        if let (Some(prev), Some(last)) = (
            d.get("past_update_id").and_then(Value::as_u64),
            self.last_update,
        ) {
            if prev != last {
                if upd.is_some_and(|u| u <= last) {
                    return Ok(Vec::new()); // duplicate
                }
                self.gaps += 1;
                self.synced = false;
                return Ok(vec![Action::Resync {
                    send: vec![
                        json!({"id": 10, "method": "depth_unsubscribe", "params": [self.spec.symbol]}).to_string(),
                        self.depth_sub(11),
                    ],
                    rest: false,
                }]);
            }
        }
        if upd.is_some() {
            self.last_update = upd;
        }
        Ok(vec![Action::Deltas(self.book.apply(&bids, &asks))])
    }
}

impl Protocol for WhitebitProtocol {
    fn on_open(&mut self) -> Vec<String> {
        self.book.clear();
        self.synced = false;
        self.last_update = None;
        vec![
            json!({"id": 1, "method": "trades_subscribe", "params": [self.spec.symbol]})
                .to_string(),
            self.depth_sub(2),
        ]
    }

    fn on_text(&mut self, text: &str, local_ns: i64) -> Result<Vec<Action>> {
        let v: Value = serde_json::from_str(text)?;
        if let Some(e) = v.get("error").filter(|e| !e.is_null()) {
            return Ok(vec![Action::Fail(format!(
                "whitebit {}: {}",
                e.get("code").and_then(Value::as_i64).unwrap_or(0),
                e.get("message").and_then(Value::as_str).unwrap_or("")
            ))]);
        }
        let params = v.get("params").and_then(Value::as_array);
        match (v.get("method").and_then(Value::as_str), params) {
            (Some("trades_update"), Some(p)) => {
                if p.first().and_then(Value::as_str) != Some(self.spec.symbol.as_str()) {
                    return Ok(Vec::new());
                }
                let mut out = Vec::new();
                for t in p.get(1).and_then(Value::as_array).into_iter().flatten() {
                    let ms = to_ms(t.get("time").and_then(num_f64).unwrap_or(0.0));
                    let px = t
                        .get("price")
                        .and_then(num_text)
                        .ok_or_else(|| ConnectorError::Other("bad trade".into()))?;
                    out.push(Trade {
                        exchange_ts_ns: ms * 1_000_000,
                        local_ts_ns: local_ns,
                        px: self.spec.tick.parse_ticks(&px)?,
                        qty: t.get("amount").and_then(num_f64).unwrap_or(0.0),
                        aggressor: aggressor(t.get("type").and_then(Value::as_str).unwrap_or("")),
                        trade_id: t.get("id").and_then(Value::as_u64).unwrap_or(0),
                    });
                }
                out.sort_by_key(|t| t.exchange_ts_ns);
                Ok(vec![Action::Trades(out)])
            }
            (Some("depth_update"), Some(p)) => self.on_depth(p, local_ns),
            _ => Ok(Vec::new()), // subscribe / pong replies
        }
    }

    fn synced(&self) -> bool {
        self.synced
    }

    fn book_snapshot(&self, ts_ns: i64) -> BookSnapshot {
        self.book.snapshot(ts_ns)
    }
}

// ------------------------------------------------------------------ REST + MarketApi

#[derive(Clone)]
pub struct Whitebit {
    rest: Rest,
    pub ws_url: String,
}

impl Default for Whitebit {
    fn default() -> Self {
        Self::new(REST_BASE, WS_URL)
    }
}

fn server_ms(text: &str) -> Option<i64> {
    let v: Value = serde_json::from_str(text).ok()?;
    v.get("time").and_then(num_f64).map(to_ms)
}

pub fn spec_from(symbol: &str, markets: &Value) -> Result<SymbolSpec> {
    let m = markets
        .as_array()
        .into_iter()
        .flatten()
        .find(|m| {
            m.get("name")
                .and_then(Value::as_str)
                .is_some_and(|n| n.eq_ignore_ascii_case(symbol))
        })
        .ok_or_else(|| ConnectorError::UnknownSymbol(symbol.into()))?;
    let prec = |k: &str| -> u32 {
        m.get(k)
            .and_then(num_f64)
            .map(|x| x as u32)
            .unwrap_or(0)
            .min(12)
    };
    Ok(SymbolSpec::new(
        m.get("name").and_then(Value::as_str).unwrap_or(symbol),
        TickSize {
            scale: prec("moneyPrec"),
            units: 1,
        },
        prec("stockPrec"),
    ))
}

/// Funding / OI of one perpetual from `/api/v4/public/futures`.
pub fn futures_stats(symbol: &str, v: &Value, now_ns: i64) -> Vec<MarketStat> {
    let Some(row) = v
        .get("result")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|r| r.get("ticker_id").and_then(Value::as_str) == Some(symbol))
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(rate) = row.get("funding_rate").and_then(num_f64) {
        out.push(MarketStat::Funding {
            ts_ns: now_ns,
            rate,
            next_ts_ns: row
                .get("next_funding_rate_timestamp")
                .and_then(num_f64)
                .map(|t| to_ms(t) * 1_000_000)
                .unwrap_or(0),
            mark_price: row.get("mark_price").and_then(num_f64).unwrap_or(f64::NAN),
        });
    }
    if let Some(oi) = row.get("open_interest").and_then(num_f64) {
        out.push(MarketStat::OpenInterest {
            ts_ns: now_ns,
            oi,
            value: f64::NAN,
        });
    }
    out
}

impl Whitebit {
    pub fn new(rest: &str, ws: &str) -> Self {
        Self {
            rest: Rest::new(rest, TokenBucket::new(10, Duration::from_secs(1))),
            ws_url: ws.into(),
        }
    }

    pub async fn symbol_spec(&self, symbol: &str) -> Result<SymbolSpec> {
        let v: Value = self.rest.get("/api/v4/public/markets").await?;
        spec_from(&symbol.to_uppercase(), &v)
    }

    pub async fn depth(&self, spec: &SymbolSpec) -> Result<BookLevels> {
        let v: Value = self
            .rest
            .get(&format!(
                "/api/v4/public/orderbook/{}?limit=100",
                spec.symbol
            ))
            .await?;
        Ok((
            levels(&spec.tick, &rows(v.get("bids")))?,
            levels(&spec.tick, &rows(v.get("asks")))?,
        ))
    }

    /// The latest public trades (no time-range paging), oldest first.
    pub async fn recent_trades(&self, spec: &SymbolSpec) -> Result<Vec<Trade>> {
        let v: Value = self
            .rest
            .get(&format!("/api/v4/public/trades/{}", spec.symbol))
            .await?;
        rest_trades(spec, &v)
    }
}

fn rest_trades(spec: &SymbolSpec, v: &Value) -> Result<Vec<Trade>> {
    let mut out = Vec::new();
    for t in v.as_array().into_iter().flatten() {
        let ms = to_ms(t.get("trade_timestamp").and_then(num_f64).unwrap_or(0.0));
        let px = t
            .get("price")
            .and_then(num_text)
            .ok_or_else(|| ConnectorError::Other("bad trade".into()))?;
        out.push(Trade {
            exchange_ts_ns: ms * 1_000_000,
            local_ts_ns: ms * 1_000_000,
            px: spec.tick.parse_ticks(&px)?,
            qty: t.get("base_volume").and_then(num_f64).unwrap_or(0.0),
            aggressor: aggressor(t.get("type").and_then(Value::as_str).unwrap_or("")),
            trade_id: t.get("tradeID").and_then(Value::as_u64).unwrap_or(0),
        });
    }
    out.sort_by_key(|t| (t.exchange_ts_ns, t.trade_id));
    Ok(out)
}

impl MarketApi for Whitebit {
    fn venue(&self) -> &'static str {
        "whitebit"
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
            "whitebit",
            &spec.symbol,
            self.ws_url.clone(),
            Arc::clone(&self.rest.clock),
        );
        cfg.ping = Ping::Text(json!({"id": 0, "method": "ping", "params": []}).to_string());
        cfg.ping_every = Duration::from_secs(25);
        cfg.time_probe = Some(self.rest.time_probe("/api/v4/public/time", server_ms));
        if spec.symbol.ends_with("_PERP") {
            let (rest, sym) = (self.rest.clone(), spec.symbol.clone());
            cfg.poll = Some((
                Duration::from_secs(30),
                Arc::new(move || {
                    let (rest, sym) = (rest.clone(), sym.clone());
                    Box::pin(async move {
                        let v: Value = rest.get("/api/v4/public/futures").await?;
                        Ok(futures_stats(&sym, &v, rest.clock.now_ns()))
                    })
                }),
            ));
        }
        Box::pin(driver::run(cfg, WhitebitProtocol::new(spec), tx, stop))
    }
    fn clock(&self) -> &ClockSkew {
        &self.rest.clock
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> SymbolSpec {
        SymbolSpec::new("BTC_PERP", TickSize { scale: 1, units: 1 }, 4)
    }

    fn depth(full: bool, upd: u64, past: Option<u64>, bids: &str, asks: &str) -> String {
        let p = past
            .map(|p| format!(r#","past_update_id":{p}"#))
            .unwrap_or_default();
        format!(
            r#"{{"id":null,"method":"depth_update","params":[{full},{{"timestamp":1689600180.5164471,"update_id":{upd}{p},"asks":{asks},"bids":{bids}}},"BTC_PERP"]}}"#
        )
    }

    #[test]
    fn book_reload_updates_gap() {
        let mut p = WhitebitProtocol::new(spec());
        assert_eq!(p.on_open().len(), 2);
        assert!(p
            .on_text(r#"{"id":2,"result":{"status":"success"},"error":null}"#, 0)
            .unwrap()
            .is_empty());
        assert!(p
            .on_text(&depth(false, 9, Some(8), "[]", "[]"), 0)
            .unwrap()
            .is_empty());
        let full = depth(
            true,
            10,
            None,
            r#"[["42000.1","1.5"]]"#,
            r#"[["42000.2","0.5"]]"#,
        );
        let Action::Synced(s) = &p.on_text(&full, 0).unwrap()[0] else {
            panic!()
        };
        assert_eq!(s.bids, vec![(420_001, 1.5)]);
        let up = depth(false, 11, Some(10), r#"[["42000.1","0"]]"#, "[]");
        assert!(matches!(&p.on_text(&up, 0).unwrap()[0], Action::Deltas(d) if d[0].qty == 0.0));
        assert!(p.on_text(&up, 0).unwrap().is_empty()); // duplicate
        let gap = depth(false, 20, Some(19), "[]", "[]");
        assert!(
            matches!(&p.on_text(&gap, 0).unwrap()[0], Action::Resync { send, .. } if send.len() == 2)
        );
        assert!(!p.synced());
        assert_eq!(p.gaps, 1);
    }

    #[test]
    fn trades_and_errors() {
        let mut p = WhitebitProtocol::new(spec());
        let t = r#"{"id":null,"method":"trades_update","params":["BTC_PERP",[{"id":41358530,"time":1580905394.70332,"price":"42000.5","amount":"0.011","type":"sell"}]]}"#;
        let Action::Trades(tr) = &p.on_text(t, 3).unwrap()[0] else {
            panic!()
        };
        assert_eq!(
            (
                tr[0].px,
                tr[0].qty,
                tr[0].aggressor,
                tr[0].trade_id,
                tr[0].exchange_ts_ns
            ),
            (
                420_005,
                0.011,
                Aggressor::Sell,
                41_358_530,
                1_580_905_394_703_000_000
            )
        );
        let err = r#"{"id":1,"result":null,"error":{"code":2,"message":"invalid argument"}}"#;
        assert!(matches!(&p.on_text(err, 0).unwrap()[0], Action::Fail(m) if m.contains("invalid")));
    }

    #[test]
    fn rest_shapes() {
        let m: Value = serde_json::from_str(r#"[{"name":"BTC_PERP","stock":"BTC","money":"USDT","stockPrec":"4","moneyPrec":"1","feePrec":"4","makerFee":"0.01","takerFee":"0.055","minAmount":"0.0001","type":"futures","tradesEnabled":true}]"#).unwrap();
        let sp = spec_from("BTC_PERP", &m).unwrap();
        assert_eq!((sp.tick.as_f64(), sp.qty_precision), (0.1, 4));
        assert!(matches!(
            spec_from("NOPE", &m),
            Err(ConnectorError::UnknownSymbol(_))
        ));
        let f: Value = serde_json::from_str(r#"{"success":true,"message":null,"result":[{"ticker_id":"BTC_PERP","stock_currency":"BTC","money_currency":"USDT","last_price":"42000","index_price":"41990","open_interest":"321.5","funding_rate":"0.0001","next_funding_rate_timestamp":"1700006400000"}]}"#).unwrap();
        let s = futures_stats("BTC_PERP", &f, 5);
        assert!(
            matches!(s[0], MarketStat::Funding { rate, next_ts_ns, .. } if rate == 0.0001 && next_ts_ns == 1_700_006_400_000_000_000)
        );
        assert!(matches!(s[1], MarketStat::OpenInterest { oi, .. } if oi == 321.5));
        let tr: Value = serde_json::from_str(r#"[{"tradeID":2,"price":"42000.1","quote_volume":"4.2","base_volume":"0.0001","trade_timestamp":1700000000001,"type":"buy"},{"tradeID":1,"price":"42000.0","quote_volume":"4.2","base_volume":"0.0001","trade_timestamp":1700000000000,"type":"sell"}]"#).unwrap();
        let t = rest_trades(&sp, &tr).unwrap();
        assert_eq!(t[0].trade_id, 1);
        assert_eq!(server_ms(r#"{"time":1631451591}"#), Some(1_631_451_591_000));
    }
}
