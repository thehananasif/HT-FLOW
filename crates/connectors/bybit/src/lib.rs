//! Bybit v5 linear perpetuals connector — free public data, no API key (P05).
//!
//! Same shape as the Binance connector: one task per connection (connect → subscribe
//! `publicTrade.SYMBOL` + `orderbook.200.SYMBOL` → `{"op":"ping"}` every 20 s → reconnect with
//! exponential backoff 0.5 s → 30 s plus jitter), normalisation to integer ticks, and a
//! sequence-checked local book: a `snapshot` message resets the book, every `delta` must carry
//! `u = previous u + 1` (Bybit's update id); a jump marks the book stale and the orderbook topic
//! is re-subscribed, which makes Bybit push a fresh snapshot. A slow consumer never blocks the
//! socket: when the output channel is full deltas are dropped and a snapshot is sent instead.

pub mod instruments;

use std::collections::BTreeMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use htflow_core_types::{
    decimals_of, Aggressor, BookDelta, BookSnapshot, DecimalError, FeedState, FeedStatus,
    MarketEvent, Side, TickSize, Trade,
};
use rand::Rng;
use serde::Deserialize;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::Message;

pub const REST_BASE: &str = "https://api.bybit.com";
pub const WS_BASE: &str = "wss://stream.bybit.com";
pub const BOOK_DEPTH: u32 = 200;

#[derive(Debug, thiserror::Error)]
pub enum ConnectorError {
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("websocket: {0}")]
    Ws(Box<tokio_tungstenite::tungstenite::Error>),
    #[error("decode: {0}")]
    Json(#[from] serde_json::Error),
    #[error("price: {0}")]
    Decimal(#[from] DecimalError),
    #[error("unknown symbol {0}")]
    UnknownSymbol(String),
    #[error("bybit: {0}")]
    Api(String),
    #[error("{0}")]
    Other(String),
}

impl From<tokio_tungstenite::tungstenite::Error> for ConnectorError {
    fn from(e: tokio_tungstenite::tungstenite::Error) -> Self {
        ConnectorError::Ws(Box::new(e))
    }
}

#[derive(Debug, Clone)]
pub struct SymbolSpec {
    pub symbol: String,
    pub tick: TickSize,
    pub qty_precision: u32,
}

#[derive(Debug, Clone)]
pub struct Endpoints {
    pub rest: String,
    pub ws: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            rest: REST_BASE.into(),
            ws: WS_BASE.into(),
        }
    }
}

pub fn now_ns() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0)
}

/// Bybit trade ids are strings (UUIDs on linear). Numeric ids are kept; others are hashed
/// (FNV-1a) and masked to 53 bits so they survive the trip through JavaScript numbers.
pub fn trade_id(s: &str) -> u64 {
    const MASK: u64 = (1 << 53) - 1;
    if let Ok(v) = s.parse::<u64>() {
        if v <= MASK {
            return v;
        }
    }
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h & MASK
}

fn parse_f64(s: &str) -> Result<f64, ConnectorError> {
    s.parse()
        .map_err(|e: std::num::ParseFloatError| ConnectorError::Other(e.to_string()))
}

fn parse_levels(tick: &TickSize, l: &[[String; 2]]) -> Result<Vec<(i64, f64)>, ConnectorError> {
    l.iter()
        .map(|[p, q]| Ok((tick.parse_ticks(p)?, parse_f64(q)?)))
        .collect()
}

pub mod wire {
    use serde::Deserialize;

    /// Any message on the public socket: data pushes carry `topic`, replies carry `op`.
    #[derive(Debug, Deserialize)]
    pub struct Msg<'a> {
        #[serde(default)]
        pub topic: Option<&'a str>,
        #[serde(rename = "type", default)]
        pub kind: Option<&'a str>,
        #[serde(default)]
        pub ts: Option<i64>,
        #[serde(default)]
        pub data: Option<serde_json::Value>,
        #[serde(default)]
        pub op: Option<&'a str>,
        #[serde(default)]
        pub success: Option<bool>,
        #[serde(default)]
        pub ret_msg: Option<String>,
    }

    #[derive(Debug, Deserialize)]
    pub struct TradeWire {
        #[serde(rename = "T")]
        pub ts_ms: i64,
        /// Taker side: "Buy" / "Sell".
        #[serde(rename = "S")]
        pub side: String,
        #[serde(rename = "v")]
        pub qty: String,
        #[serde(rename = "p")]
        pub price: String,
        #[serde(rename = "i")]
        pub id: String,
    }

    #[derive(Debug, Deserialize)]
    pub struct BookWire {
        #[serde(rename = "b")]
        pub bids: Vec<[String; 2]>,
        #[serde(rename = "a")]
        pub asks: Vec<[String; 2]>,
        pub u: u64,
        #[serde(default)]
        pub seq: u64,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Rest<T> {
        pub ret_code: i64,
        pub ret_msg: String,
        pub result: Option<T>,
    }

    #[derive(Debug, Deserialize)]
    pub struct List<T> {
        pub list: Vec<T>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct InstrumentInfo {
        pub symbol: String,
        pub price_filter: PriceFilter,
        pub lot_size_filter: LotSizeFilter,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct PriceFilter {
        pub tick_size: String,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct LotSizeFilter {
        pub qty_step: String,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RecentTrade {
        pub exec_id: String,
        pub price: String,
        pub size: String,
        pub side: String,
        pub time: String,
    }
}

/// A decoded socket message.
#[derive(Debug, PartialEq)]
pub enum Parsed {
    Trades(Vec<Trade>),
    Book {
        snapshot: bool,
        u: u64,
        seq: u64,
        ts_ms: i64,
        bids: Vec<(i64, f64)>,
        asks: Vec<(i64, f64)>,
    },
    /// Reply to subscribe / ping.
    Reply {
        op: String,
        success: bool,
        message: String,
    },
    Other,
}

fn aggressor(side: &str) -> Aggressor {
    match side {
        "Buy" => Aggressor::Buy,
        "Sell" => Aggressor::Sell,
        _ => Aggressor::Unknown,
    }
}

pub fn parse_message(
    spec: &SymbolSpec,
    text: &str,
    local_ns: i64,
) -> Result<Parsed, ConnectorError> {
    let m: wire::Msg<'_> = serde_json::from_str(text)?;
    if let Some(op) = m.op {
        return Ok(Parsed::Reply {
            op: op.to_string(),
            success: m.success.unwrap_or(true),
            message: m.ret_msg.unwrap_or_default(),
        });
    }
    let (Some(topic), Some(data)) = (m.topic, m.data) else {
        return Ok(Parsed::Other);
    };
    if topic.starts_with("publicTrade.") {
        let rows: Vec<wire::TradeWire> = serde_json::from_value(data)?;
        let trades = rows
            .iter()
            .map(|t| {
                Ok(Trade {
                    exchange_ts_ns: t.ts_ms * 1_000_000,
                    local_ts_ns: local_ns,
                    px: spec.tick.parse_ticks(&t.price)?,
                    qty: parse_f64(&t.qty)?,
                    aggressor: aggressor(&t.side),
                    trade_id: trade_id(&t.id),
                })
            })
            .collect::<Result<Vec<_>, ConnectorError>>()?;
        return Ok(Parsed::Trades(trades));
    }
    if topic.starts_with("orderbook.") {
        let b: wire::BookWire = serde_json::from_value(data)?;
        return Ok(Parsed::Book {
            snapshot: m.kind == Some("snapshot"),
            u: b.u,
            seq: b.seq,
            ts_ms: m.ts.unwrap_or(0),
            bids: parse_levels(&spec.tick, &b.bids)?,
            asks: parse_levels(&spec.tick, &b.asks)?,
        });
    }
    Ok(Parsed::Other)
}

#[derive(Debug, Clone, PartialEq)]
pub enum SyncOutcome {
    /// Book (re)built from a snapshot.
    Synced(BookSnapshot),
    Applied(Vec<BookDelta>),
    /// Duplicate / stale update, or waiting for a snapshot.
    Ignored,
    /// Sequence gap: the book is stale — re-subscribe to get a snapshot.
    Gap,
}

/// Local L2 book with Bybit's `u` sequence check (Live Pipeline stage 3).
#[derive(Debug, Default)]
pub struct BookSync {
    pub bids: BTreeMap<i64, f64>,
    pub asks: BTreeMap<i64, f64>,
    last_u: Option<u64>,
    last_seq: u64,
    pub gaps: u64,
}

impl BookSync {
    pub fn is_synced(&self) -> bool {
        self.last_u.is_some()
    }

    pub fn snapshot(&self, ts_ns: i64) -> BookSnapshot {
        BookSnapshot {
            ts_ns,
            bids: self.bids.iter().rev().map(|(p, q)| (*p, *q)).collect(),
            asks: self.asks.iter().map(|(p, q)| (*p, *q)).collect(),
        }
    }

    pub fn on_book(
        &mut self,
        snapshot: bool,
        u: u64,
        seq: u64,
        bids: Vec<(i64, f64)>,
        asks: Vec<(i64, f64)>,
        ts_ns: i64,
    ) -> SyncOutcome {
        if snapshot {
            self.bids = bids.into_iter().filter(|l| l.1 > 0.0).collect();
            self.asks = asks.into_iter().filter(|l| l.1 > 0.0).collect();
            self.last_u = Some(u);
            self.last_seq = seq;
            return SyncOutcome::Synced(self.snapshot(ts_ns));
        }
        let Some(last) = self.last_u else {
            return SyncOutcome::Ignored;
        };
        if u <= last || (seq != 0 && seq < self.last_seq) {
            return SyncOutcome::Ignored;
        }
        if u != last + 1 {
            self.gaps += 1;
            self.last_u = None;
            return SyncOutcome::Gap;
        }
        let mut out = Vec::with_capacity(bids.len() + asks.len());
        for (side, levels) in [(Side::Buy, bids), (Side::Sell, asks)] {
            let book = if side == Side::Buy {
                &mut self.bids
            } else {
                &mut self.asks
            };
            for (px, qty) in levels {
                if qty <= 0.0 {
                    book.remove(&px);
                } else {
                    book.insert(px, qty);
                }
                out.push(BookDelta {
                    side,
                    px,
                    qty: qty.max(0.0),
                });
            }
        }
        self.last_u = Some(u);
        self.last_seq = seq.max(self.last_seq);
        SyncOutcome::Applied(out)
    }
}

/// REST client for metadata, snapshots and recent trades.
#[derive(Clone)]
pub struct BybitLinear {
    http: reqwest::Client,
    pub endpoints: Endpoints,
}

impl Default for BybitLinear {
    fn default() -> Self {
        Self::new(Endpoints::default())
    }
}

impl BybitLinear {
    pub fn new(endpoints: Endpoints) -> Self {
        let http = reqwest::Client::builder()
            .user_agent("HTFlow/0.1")
            .timeout(Duration::from_secs(15))
            .build()
            .expect("reqwest client");
        Self { http, endpoints }
    }

    async fn get<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T, ConnectorError> {
        let url = format!("{}{}", self.endpoints.rest, path);
        let r: wire::Rest<T> = self
            .http
            .get(url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        if r.ret_code != 0 {
            return Err(ConnectorError::Api(r.ret_msg));
        }
        r.result
            .ok_or_else(|| ConnectorError::Api("empty result".into()))
    }

    pub async fn symbol_spec(&self, symbol: &str) -> Result<SymbolSpec, ConnectorError> {
        let l: wire::List<wire::InstrumentInfo> = self
            .get(&format!(
                "/v5/market/instruments-info?category=linear&symbol={symbol}"
            ))
            .await?;
        spec_from_info(symbol, l.list)
    }

    /// `(u, bids, asks)` from the REST order book, prices in ticks.
    pub async fn depth_snapshot(
        &self,
        spec: &SymbolSpec,
    ) -> Result<(u64, Vec<(i64, f64)>, Vec<(i64, f64)>), ConnectorError> {
        let b: wire::BookWire = self
            .get(&format!(
                "/v5/market/orderbook?category=linear&symbol={}&limit={BOOK_DEPTH}",
                spec.symbol
            ))
            .await?;
        Ok((
            b.u,
            parse_levels(&spec.tick, &b.bids)?,
            parse_levels(&spec.tick, &b.asks)?,
        ))
    }

    /// The latest trades (Bybit's public REST only serves the most recent 1,000), oldest first.
    pub async fn recent_trades(&self, spec: &SymbolSpec) -> Result<Vec<Trade>, ConnectorError> {
        let l: wire::List<wire::RecentTrade> = self
            .get(&format!(
                "/v5/market/recent-trade?category=linear&symbol={}&limit=1000",
                spec.symbol
            ))
            .await?;
        recent_from_rest(spec, l.list)
    }
}

pub fn spec_from_info(
    symbol: &str,
    list: Vec<wire::InstrumentInfo>,
) -> Result<SymbolSpec, ConnectorError> {
    let i = list
        .into_iter()
        .find(|i| i.symbol.eq_ignore_ascii_case(symbol))
        .ok_or_else(|| ConnectorError::UnknownSymbol(symbol.into()))?;
    Ok(SymbolSpec {
        tick: TickSize::parse(&i.price_filter.tick_size)?,
        qty_precision: decimals_of(&i.lot_size_filter.qty_step),
        symbol: i.symbol,
    })
}

pub fn recent_from_rest(
    spec: &SymbolSpec,
    rows: Vec<wire::RecentTrade>,
) -> Result<Vec<Trade>, ConnectorError> {
    let mut out = rows
        .iter()
        .map(|r| {
            let ms: i64 = r
                .time
                .parse()
                .map_err(|_| ConnectorError::Other(format!("bad time {}", r.time)))?;
            Ok(Trade {
                exchange_ts_ns: ms * 1_000_000,
                local_ts_ns: ms * 1_000_000,
                px: spec.tick.parse_ticks(&r.price)?,
                qty: parse_f64(&r.size)?,
                aggressor: aggressor(&r.side),
                trade_id: trade_id(&r.exec_id),
            })
        })
        .collect::<Result<Vec<_>, ConnectorError>>()?;
    out.sort_by_key(|t| t.exchange_ts_ns);
    Ok(out)
}

fn status(state: FeedState, latency_ms: f64, msgs: f64, message: Option<String>) -> MarketEvent {
    MarketEvent::Status(FeedStatus {
        state,
        latency_ms,
        msgs_per_sec: msgs,
        message,
    })
}

fn offer(tx: &mpsc::Sender<MarketEvent>, ev: MarketEvent) -> bool {
    tx.try_send(ev).is_ok()
}

/// Runs the live stream until `stop` flips to true, reconnecting with backoff.
pub async fn run_stream(
    client: BybitLinear,
    spec: SymbolSpec,
    tx: mpsc::Sender<MarketEvent>,
    mut stop: watch::Receiver<bool>,
) {
    let mut backoff = Duration::from_millis(500);
    loop {
        if *stop.borrow() || tx.is_closed() {
            return;
        }
        let _ = tx.send(status(FeedState::Connecting, 0.0, 0.0, None)).await;
        match session(&client, &spec, &tx, &mut stop, &mut backoff).await {
            Ok(()) => return,
            Err(e) => {
                tracing::warn!(symbol = %spec.symbol, error = %e, "bybit stream dropped; reconnecting");
                let _ = tx
                    .send(status(
                        FeedState::Disconnected,
                        0.0,
                        0.0,
                        Some(e.to_string()),
                    ))
                    .await;
            }
        }
        let jitter = Duration::from_millis(rand::thread_rng().gen_range(0..250));
        tokio::select! {
            _ = tokio::time::sleep(backoff + jitter) => {}
            _ = stop.changed() => return,
        }
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

fn sub_msg(op: &str, topics: &[String]) -> Message {
    Message::Text(serde_json::json!({ "op": op, "args": topics }).to_string())
}

async fn session(
    client: &BybitLinear,
    spec: &SymbolSpec,
    tx: &mpsc::Sender<MarketEvent>,
    stop: &mut watch::Receiver<bool>,
    backoff: &mut Duration,
) -> Result<(), ConnectorError> {
    let url = format!("{}/v5/public/linear", client.endpoints.ws);
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await?;
    let book_topic = format!("orderbook.{BOOK_DEPTH}.{}", spec.symbol);
    let trade_topic = format!("publicTrade.{}", spec.symbol);
    ws.send(sub_msg("subscribe", &[trade_topic, book_topic.clone()]))
        .await?;
    let mut sync = BookSync::default();
    let mut lagging = false;
    let mut msgs: u64 = 0;
    let mut latency = 0.0f64;
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut ping = tokio::time::interval(Duration::from_secs(20));
    let mut last_msg = tokio::time::Instant::now();
    loop {
        tokio::select! {
            msg = ws.next() => {
                let Some(msg) = msg else { return Err(ConnectorError::Other("connection closed".into())) };
                last_msg = tokio::time::Instant::now();
                match msg? {
                    Message::Text(text) => {
                        msgs += 1;
                        let local = now_ns();
                        match parse_message(spec, &text, local)? {
                            Parsed::Trades(t) => {
                                if let Some(last) = t.last() {
                                    let lat = (local - last.exchange_ts_ns) as f64 / 1e6;
                                    latency = if latency == 0.0 { lat } else { latency * 0.9 + lat * 0.1 };
                                }
                                if !offer(tx, MarketEvent::Trades(t)) { lagging = true; }
                            }
                            Parsed::Book { snapshot, u, seq, bids, asks, .. } => {
                                match sync.on_book(snapshot, u, seq, bids, asks, local) {
                                    SyncOutcome::Synced(s) => {
                                        *backoff = Duration::from_millis(500);
                                        lagging = false;
                                        let _ = tx.send(MarketEvent::Snapshot(s)).await;
                                    }
                                    SyncOutcome::Applied(d) => {
                                        if lagging {
                                            if offer(tx, MarketEvent::Snapshot(sync.snapshot(local))) { lagging = false; }
                                        } else if !offer(tx, MarketEvent::Deltas(d)) {
                                            lagging = true;
                                        }
                                    }
                                    SyncOutcome::Gap => {
                                        tracing::info!(symbol = %spec.symbol, "bybit book sequence gap; resubscribing");
                                        ws.send(sub_msg("unsubscribe", std::slice::from_ref(&book_topic))).await?;
                                        ws.send(sub_msg("subscribe", std::slice::from_ref(&book_topic))).await?;
                                    }
                                    SyncOutcome::Ignored => {}
                                }
                            }
                            Parsed::Reply { op, success, message } => {
                                if !success && op == "subscribe" {
                                    return Err(ConnectorError::Api(message));
                                }
                            }
                            Parsed::Other => {}
                        }
                    }
                    Message::Ping(p) => ws.send(Message::Pong(p)).await?,
                    Message::Close(_) => return Err(ConnectorError::Other("server closed the connection".into())),
                    _ => {}
                }
            }
            _ = ping.tick() => ws.send(Message::Text(r#"{"op":"ping"}"#.into())).await?,
            _ = tick.tick() => {
                if last_msg.elapsed() > Duration::from_secs(45) {
                    return Err(ConnectorError::Other("no data for 45 s".into()));
                }
                let state = if sync.is_synced() { FeedState::Live } else { FeedState::Connecting };
                offer(tx, status(state, latency.max(0.0), msgs as f64, None));
                msgs = 0;
            }
            _ = stop.changed() => {
                let _ = ws.close(None).await;
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> SymbolSpec {
        SymbolSpec {
            symbol: "BTCUSDT".into(),
            tick: TickSize::parse("0.10").unwrap(),
            qty_precision: 3,
        }
    }

    // Recorded from the public v5 linear socket (shape per Bybit docs).
    const TRADE: &str = r#"{"topic":"publicTrade.BTCUSDT","type":"snapshot","ts":1672304486868,"data":[{"T":1672304486865,"s":"BTCUSDT","S":"Buy","v":"0.001","p":"16578.50","L":"PlusTick","i":"20f43950-d8dd-5b31-9112-a178eb6023af","BT":false,"seq":1783284617},{"T":1672304486866,"s":"BTCUSDT","S":"Sell","v":"0.250","p":"16578.40","L":"MinusTick","i":"2290000000061666327","BT":false,"seq":1783284618}]}"#;
    const SNAP: &str = r#"{"topic":"orderbook.200.BTCUSDT","type":"snapshot","ts":1672304484978,"data":{"s":"BTCUSDT","b":[["16493.50","0.006"],["16493.00","0.100"]],"a":[["16611.00","0.029"],["16612.00","0.213"]],"u":18521288,"seq":7961638724},"cts":1672304484976}"#;
    const DELTA1: &str = r#"{"topic":"orderbook.200.BTCUSDT","type":"delta","ts":1672304485000,"data":{"s":"BTCUSDT","b":[["16493.50","0"],["16492.00","1.5"]],"a":[["16611.00","0.5"]],"u":18521289,"seq":7961638725},"cts":1672304484999}"#;
    const DELTA_GAP: &str = r#"{"topic":"orderbook.200.BTCUSDT","type":"delta","ts":1672304485100,"data":{"s":"BTCUSDT","b":[],"a":[["16612.00","0"]],"u":18521295,"seq":7961638800},"cts":1672304485099}"#;
    const PONG: &str = r#"{"success":true,"ret_msg":"pong","conn_id":"0970e817-426e-429a-a679-ff7f55e0b16a","op":"ping"}"#;
    const SUB_FAIL: &str =
        r#"{"success":false,"ret_msg":"error:handler not found","conn_id":"x","op":"subscribe"}"#;

    #[test]
    fn parses_trades() {
        let Parsed::Trades(t) = parse_message(&spec(), TRADE, 7).unwrap() else {
            panic!()
        };
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].px, 165_785);
        assert_eq!(t[0].qty, 0.001);
        assert_eq!(t[0].aggressor, Aggressor::Buy);
        assert_eq!(t[0].exchange_ts_ns, 1_672_304_486_865_000_000);
        assert!(t[0].trade_id < 1 << 53);
        assert_eq!(
            t[0].trade_id,
            trade_id("20f43950-d8dd-5b31-9112-a178eb6023af")
        );
        // Too large for a JS number → hashed into 53 bits; small numeric ids are kept.
        assert!(t[1].trade_id < 1 << 53);
        assert_eq!(trade_id("130639474"), 130_639_474);
        assert_eq!(t[1].aggressor, Aggressor::Sell);
    }

    #[test]
    fn book_snapshot_deltas_and_gap() {
        let mut s = BookSync::default();
        let feed = |text: &str, s: &mut BookSync| {
            let Parsed::Book {
                snapshot,
                u,
                seq,
                bids,
                asks,
                ..
            } = parse_message(&spec(), text, 0).unwrap()
            else {
                panic!()
            };
            s.on_book(snapshot, u, seq, bids, asks, 0)
        };
        // Deltas before a snapshot are ignored.
        assert_eq!(feed(DELTA1, &mut s), SyncOutcome::Ignored);
        let SyncOutcome::Synced(snap) = feed(SNAP, &mut s) else {
            panic!()
        };
        assert_eq!(snap.bids, vec![(164_935, 0.006), (164_930, 0.1)]);
        assert_eq!(snap.asks[0], (166_110, 0.029));
        let SyncOutcome::Applied(d) = feed(DELTA1, &mut s) else {
            panic!()
        };
        assert_eq!(d.len(), 3);
        assert_eq!(s.bids.keys().next_back(), Some(&164_930));
        assert_eq!(s.asks.get(&166_110), Some(&0.5));
        // Replayed duplicate → ignored; jump in u → gap, book stale until the next snapshot.
        assert_eq!(feed(DELTA1, &mut s), SyncOutcome::Ignored);
        assert_eq!(feed(DELTA_GAP, &mut s), SyncOutcome::Gap);
        assert!(!s.is_synced());
        assert_eq!(s.gaps, 1);
        assert!(matches!(feed(SNAP, &mut s), SyncOutcome::Synced(_)));
    }

    #[test]
    fn parses_replies_and_rest() {
        assert_eq!(
            parse_message(&spec(), PONG, 0).unwrap(),
            Parsed::Reply {
                op: "ping".into(),
                success: true,
                message: "pong".into()
            }
        );
        assert!(matches!(
            parse_message(&spec(), SUB_FAIL, 0).unwrap(),
            Parsed::Reply { success: false, .. }
        ));
        let info = r#"{"retCode":0,"retMsg":"OK","result":{"category":"linear","list":[{"symbol":"BTCUSDT","contractType":"LinearPerpetual","status":"Trading","priceScale":"2","priceFilter":{"minPrice":"0.10","maxPrice":"199999.80","tickSize":"0.10"},"lotSizeFilter":{"maxOrderQty":"100.000","minOrderQty":"0.001","qtyStep":"0.001"}}]}}"#;
        let r: wire::Rest<wire::List<wire::InstrumentInfo>> = serde_json::from_str(info).unwrap();
        let sp = spec_from_info("btcusdt", r.result.unwrap().list).unwrap();
        assert_eq!(sp.tick, TickSize::parse("0.1").unwrap());
        assert_eq!(sp.qty_precision, 3);
        let trades = r#"{"retCode":0,"retMsg":"OK","result":{"category":"linear","list":[{"execId":"b","symbol":"BTCUSDT","price":"16618.50","size":"0.012","side":"Sell","time":"1672052955759","isBlockTrade":false},{"execId":"a","symbol":"BTCUSDT","price":"16618.40","size":"0.001","side":"Buy","time":"1672052955758","isBlockTrade":false}]},"time":1672053054358}"#;
        let r: wire::Rest<wire::List<wire::RecentTrade>> = serde_json::from_str(trades).unwrap();
        let t = recent_from_rest(&sp, r.result.unwrap().list).unwrap();
        assert_eq!(t[0].px, 166_184);
        assert_eq!(t[0].trade_id, trade_id("a"));
        assert_eq!(t[1].aggressor, Aggressor::Sell);
    }
}
