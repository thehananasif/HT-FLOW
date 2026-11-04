//! Binance USDⓈ-M Futures connector — free public data, no API key (P05).
//!
//! Live Pipeline stages 1–3: one task per connection (connect → subscribe → heartbeat →
//! reconnect with exponential backoff 0.5 s → 30 s plus jitter), normalisation to ticks, and a
//! sequence-checked local L2 book. A slow consumer never blocks the socket: when the output
//! channel is full the connector drops deltas and re-sends a full snapshot once there is room.

pub mod book_sync;
pub mod wire;

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use book_sync::{BookSync, DepthUpdate, SyncOutcome};
use futures_util::{SinkExt, StreamExt};
use htflow_core_types::{
    decimals_of, Aggressor, DecimalError, FeedState, FeedStatus, MarketEvent, TickSize, Trade,
};
use rand::Rng;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::Message;

pub const REST_BASE: &str = "https://fapi.binance.com";
pub const WS_BASE: &str = "wss://fstream.binance.com";

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
    #[error("{0}")]
    Other(String),
}

impl From<tokio_tungstenite::tungstenite::Error> for ConnectorError {
    fn from(e: tokio_tungstenite::tungstenite::Error) -> Self {
        ConnectorError::Ws(Box::new(e))
    }
}

/// `(lastUpdateId, bids, asks)` from the REST depth endpoint, prices in ticks.
pub type DepthSnapshot = (u64, Vec<(i64, f64)>, Vec<(i64, f64)>);

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

fn parse_level(tick: &TickSize, l: &[String; 2]) -> Result<(i64, f64), ConnectorError> {
    Ok((
        tick.parse_ticks(&l[0])?,
        l[1].parse::<f64>()
            .map_err(|e| ConnectorError::Other(e.to_string()))?,
    ))
}

pub fn parse_depth(
    tick: &TickSize,
    w: wire::DepthUpdateWire,
) -> Result<DepthUpdate, ConnectorError> {
    Ok(DepthUpdate {
        first_id: w.first_id,
        final_id: w.final_id,
        prev_final_id: w.prev_final_id,
        event_ms: w.event_ms,
        bids: w
            .bids
            .iter()
            .map(|l| parse_level(tick, l))
            .collect::<Result<_, _>>()?,
        asks: w
            .asks
            .iter()
            .map(|l| parse_level(tick, l))
            .collect::<Result<_, _>>()?,
    })
}

pub fn parse_agg_trade(
    tick: &TickSize,
    t: &wire::AggTrade<'_>,
    local_ns: i64,
) -> Result<Trade, ConnectorError> {
    Ok(Trade {
        exchange_ts_ns: t.trade_ms * 1_000_000,
        local_ts_ns: local_ns,
        px: tick.parse_ticks(t.price)?,
        qty: t
            .qty
            .parse()
            .map_err(|e: std::num::ParseFloatError| ConnectorError::Other(e.to_string()))?,
        aggressor: if t.buyer_is_maker {
            Aggressor::Sell
        } else {
            Aggressor::Buy
        },
        trade_id: t.id,
    })
}

/// REST client for metadata, snapshots and history backfill.
#[derive(Clone)]
pub struct BinanceFutures {
    http: reqwest::Client,
    pub endpoints: Endpoints,
}

impl Default for BinanceFutures {
    fn default() -> Self {
        Self::new(Endpoints::default())
    }
}

impl BinanceFutures {
    pub fn new(endpoints: Endpoints) -> Self {
        let http = reqwest::Client::builder()
            .user_agent("HTFlow/0.1")
            .timeout(Duration::from_secs(15))
            .build()
            .expect("reqwest client");
        Self { http, endpoints }
    }

    pub async fn symbol_spec(&self, symbol: &str) -> Result<SymbolSpec, ConnectorError> {
        let url = format!("{}/fapi/v1/exchangeInfo", self.endpoints.rest);
        let info: wire::ExchangeInfo = self
            .http
            .get(url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let s = info
            .symbols
            .into_iter()
            .find(|s| s.symbol.eq_ignore_ascii_case(symbol))
            .ok_or_else(|| ConnectorError::UnknownSymbol(symbol.into()))?;
        let mut tick = None;
        let mut step = "1".to_string();
        for f in &s.filters {
            match f.get("filterType").and_then(|v| v.as_str()) {
                Some("PRICE_FILTER") => {
                    tick = f
                        .get("tickSize")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                }
                Some("LOT_SIZE") => {
                    if let Some(v) = f.get("stepSize").and_then(|v| v.as_str()) {
                        step = v.to_string();
                    }
                }
                _ => {}
            }
        }
        let tick = TickSize::parse(
            &tick.ok_or_else(|| ConnectorError::Other("missing PRICE_FILTER".into()))?,
        )?;
        Ok(SymbolSpec {
            symbol: s.symbol,
            tick,
            qty_precision: decimals_of(&step),
        })
    }

    pub async fn depth_snapshot(
        &self,
        spec: &SymbolSpec,
        limit: u32,
    ) -> Result<DepthSnapshot, ConnectorError> {
        let url = format!(
            "{}/fapi/v1/depth?symbol={}&limit={}",
            self.endpoints.rest, spec.symbol, limit
        );
        let w: wire::DepthSnapshotWire = self
            .http
            .get(url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let bids = w
            .bids
            .iter()
            .map(|l| parse_level(&spec.tick, l))
            .collect::<Result<_, _>>()?;
        let asks = w
            .asks
            .iter()
            .map(|l| parse_level(&spec.tick, l))
            .collect::<Result<_, _>>()?;
        Ok((w.last_update_id, bids, asks))
    }

    /// Recent aggregated trades (history backfill via REST pagination, Live Pipeline stage 6).
    pub async fn recent_trades(
        &self,
        spec: &SymbolSpec,
        minutes: u32,
        max_pages: u32,
    ) -> Result<Vec<Trade>, ConnectorError> {
        let now_ms = now_ns() / 1_000_000;
        let start = now_ms - minutes as i64 * 60_000;
        let mut out: Vec<Trade> = Vec::new();
        let mut url = format!(
            "{}/fapi/v1/aggTrades?symbol={}&startTime={}&limit=1000",
            self.endpoints.rest, spec.symbol, start
        );
        for _ in 0..max_pages {
            let rows: Vec<wire::AggTradeRest> = self
                .http
                .get(&url)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            let n = rows.len();
            for r in rows {
                out.push(Trade {
                    exchange_ts_ns: r.trade_ms * 1_000_000,
                    local_ts_ns: r.trade_ms * 1_000_000,
                    px: spec.tick.parse_ticks(&r.price)?,
                    qty: r.qty.parse().unwrap_or(0.0),
                    aggressor: if r.buyer_is_maker {
                        Aggressor::Sell
                    } else {
                        Aggressor::Buy
                    },
                    trade_id: r.id,
                });
            }
            let Some(last) = out.last() else { break };
            if n < 1000 || last.exchange_ts_ns / 1_000_000 >= now_ms - 1000 {
                break;
            }
            url = format!(
                "{}/fapi/v1/aggTrades?symbol={}&fromId={}&limit=1000",
                self.endpoints.rest,
                spec.symbol,
                last.trade_id + 1
            );
        }
        Ok(out)
    }
}

fn status(
    state: FeedState,
    latency_ms: f64,
    msgs_per_sec: f64,
    message: Option<String>,
) -> MarketEvent {
    MarketEvent::Status(FeedStatus {
        state,
        latency_ms,
        msgs_per_sec,
        message,
    })
}

/// Sends without blocking the socket. Returns false if the consumer is lagging.
fn offer(tx: &mpsc::Sender<MarketEvent>, ev: MarketEvent) -> bool {
    match tx.try_send(ev) {
        Ok(()) => true,
        Err(mpsc::error::TrySendError::Full(_)) => false,
        Err(mpsc::error::TrySendError::Closed(_)) => false,
    }
}

/// Runs the live stream until `stop` flips to true, reconnecting with backoff.
pub async fn run_stream(
    client: BinanceFutures,
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
                tracing::warn!(symbol = %spec.symbol, error = %e, "binance stream dropped; reconnecting");
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

async fn session(
    client: &BinanceFutures,
    spec: &SymbolSpec,
    tx: &mpsc::Sender<MarketEvent>,
    stop: &mut watch::Receiver<bool>,
    backoff: &mut Duration,
) -> Result<(), ConnectorError> {
    let s = spec.symbol.to_lowercase();
    let url = format!(
        "{}/stream?streams={s}@aggTrade/{s}@depth@100ms",
        client.endpoints.ws
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await?;
    let mut sync = BookSync::default();
    let mut snapshot_task: Option<tokio::task::JoinHandle<Result<DepthSnapshot, ConnectorError>>> =
        None;
    let mut need_snapshot = true;
    let mut lagging = false;
    let mut msgs: u64 = 0;
    let mut latency_ewma = 0.0f64;
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut trades: Vec<Trade> = Vec::with_capacity(64);
    let mut last_msg = tokio::time::Instant::now();

    loop {
        if need_snapshot && snapshot_task.is_none() {
            // Give the stream a moment to buffer, then fetch the REST snapshot in the background.
            let c = client.clone();
            let sp = spec.clone();
            snapshot_task = Some(tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(400)).await;
                c.depth_snapshot(&sp, 1000).await
            }));
            need_snapshot = false;
        }
        tokio::select! {
            msg = ws.next() => {
                let Some(msg) = msg else { return Err(ConnectorError::Other("connection closed".into())) };
                last_msg = tokio::time::Instant::now();
                match msg? {
                    Message::Text(text) => {
                        msgs += 1;
                        let local = now_ns();
                        let env: wire::Envelope<'_> = serde_json::from_str(&text)?;
                        if env.stream.ends_with("@aggTrade") {
                            let t: wire::AggTrade<'_> = serde_json::from_str(env.data.get())?;
                            let lat = (local / 1_000_000 - t.event_ms) as f64;
                            latency_ewma = if latency_ewma == 0.0 { lat } else { latency_ewma * 0.9 + lat * 0.1 };
                            trades.push(parse_agg_trade(&spec.tick, &t, local)?);
                            if !offer(tx, MarketEvent::Trades(std::mem::take(&mut trades))) {
                                lagging = true;
                            }
                        } else if env.stream.contains("@depth") {
                            let w: wire::DepthUpdateWire = serde_json::from_str(env.data.get())?;
                            match sync.on_update(parse_depth(&spec.tick, w)?) {
                                SyncOutcome::Applied(d) => {
                                    if lagging {
                                        if offer(tx, MarketEvent::Snapshot(sync.book.snapshot(local))) {
                                            lagging = false;
                                        }
                                    } else if !offer(tx, MarketEvent::Deltas(d)) {
                                        lagging = true;
                                        tracing::warn!(symbol = %spec.symbol, "consumer lagging; falling back to snapshots");
                                    }
                                }
                                SyncOutcome::Gap => {
                                    tracing::info!(symbol = %spec.symbol, "depth sequence gap; resyncing");
                                    need_snapshot = snapshot_task.is_none();
                                }
                                SyncOutcome::Buffered | SyncOutcome::Synced(_) => {}
                            }
                        }
                    }
                    Message::Ping(p) => ws.send(Message::Pong(p)).await?,
                    Message::Close(_) => return Err(ConnectorError::Other("server closed the connection".into())),
                    _ => {}
                }
            }
            res = async { snapshot_task.as_mut().expect("guarded").await }, if snapshot_task.is_some() => {
                snapshot_task = None;
                let (last_id, bids, asks) = res.map_err(|e| ConnectorError::Other(e.to_string()))??;
                match sync.on_snapshot(last_id, bids, asks, now_ns()) {
                    SyncOutcome::Synced(snap) => {
                        *backoff = Duration::from_millis(500);
                        let _ = tx.send(MarketEvent::Snapshot(snap)).await;
                    }
                    _ => need_snapshot = true,
                }
            }
            _ = tick.tick() => {
                if last_msg.elapsed() > Duration::from_secs(30) {
                    return Err(ConnectorError::Other("no data for 30 s".into()));
                }
                let state = if sync.is_synced() { FeedState::Live } else { FeedState::Connecting };
                offer(tx, status(state, latency_ewma.max(0.0), msgs as f64, None));
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

    #[test]
    fn parses_stream_messages() {
        let tick = TickSize::parse("0.10").unwrap();
        let text = r#"{"stream":"btcusdt@aggTrade","data":{"e":"aggTrade","E":1700000000123,"s":"BTCUSDT","a":42,"p":"68123.40","q":"0.015","f":1,"l":2,"T":1700000000120,"m":true}}"#;
        let env: wire::Envelope<'_> = serde_json::from_str(text).unwrap();
        let t: wire::AggTrade<'_> = serde_json::from_str(env.data.get()).unwrap();
        let tr = parse_agg_trade(&tick, &t, 5).unwrap();
        assert_eq!(tr.px, 681_234);
        assert_eq!(tr.qty, 0.015);
        assert_eq!(tr.aggressor, Aggressor::Sell);
        assert_eq!(tr.exchange_ts_ns, 1_700_000_000_120_000_000);

        let d = r#"{"stream":"btcusdt@depth@100ms","data":{"e":"depthUpdate","E":1,"T":1,"s":"BTCUSDT","U":10,"u":12,"pu":9,"b":[["68123.30","1.5"],["68123.20","0"]],"a":[["68123.40","2.25"]]}}"#;
        let env: wire::Envelope<'_> = serde_json::from_str(d).unwrap();
        let w: wire::DepthUpdateWire = serde_json::from_str(env.data.get()).unwrap();
        let u = parse_depth(&tick, w).unwrap();
        assert_eq!(u.bids, vec![(681_233, 1.5), (681_232, 0.0)]);
        assert_eq!(u.asks, vec![(681_234, 2.25)]);
        assert_eq!((u.first_id, u.final_id, u.prev_final_id), (10, 12, 9));
    }
}
