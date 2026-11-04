//! Live Pipeline stage 9 — UI streamer: coalesces connector events per window every 16 ms and
//! ships one compact batch over a Tauri channel (prices already in integer ticks).
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use htflow_connector_binance::{now_ns, run_stream, BinanceFutures, SymbolSpec};
use htflow_core_types::{FeedState, MarketEvent, Side};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::{mpsc, watch};

use crate::error::{CmdError, CmdResult};

#[derive(Default)]
pub struct MarketState {
    client: BinanceFutures,
    subs: Mutex<HashMap<u32, watch::Sender<bool>>>,
    next: AtomicU32,
    specs: Mutex<HashMap<String, SymbolSpec>>,
}

#[derive(Debug, Serialize, Clone)]
pub struct WireStatus {
    state: FeedState,
    latency_ms: f64,
    msgs_per_sec: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct WireBook {
    bids: Vec<(i64, f64)>,
    asks: Vec<(i64, f64)>,
}

/// `tr`: [ts_ms, px_ticks, qty, side(1/-1/0), id]; `bd`: [side(1 bid/-1 ask), px_ticks, qty].
#[derive(Debug, Serialize, Clone, Default)]
pub struct WireBatch {
    t: i64,
    tr: Vec<(i64, i64, f64, i8, u64)>,
    bd: Vec<(i8, i64, f64)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    snap: Option<WireBook>,
    #[serde(skip_serializing_if = "Option::is_none")]
    st: Option<WireStatus>,
}

impl WireBatch {
    fn is_empty(&self) -> bool {
        self.tr.is_empty() && self.bd.is_empty() && self.snap.is_none() && self.st.is_none()
    }
}

#[derive(Debug, Serialize)]
pub struct WireHistory {
    tick_size: f64,
    price_precision: u32,
    qty_precision: u32,
    trades: Vec<(i64, i64, f64, i8, u64)>,
    book: WireBook,
    end: i64,
}

fn check_venue(venue: &str) -> CmdResult<()> {
    if venue == "binance-futures" {
        Ok(())
    } else {
        Err(CmdError::new(
            "market.venue",
            format!("Venue '{venue}' is not available yet (see docs/BLOCKERS.md)"),
        ))
    }
}

async fn spec(state: &MarketState, symbol: &str) -> CmdResult<SymbolSpec> {
    if let Some(s) = state.specs.lock().expect("specs").get(symbol) {
        return Ok(s.clone());
    }
    let s = state.client.symbol_spec(symbol).await?;
    state
        .specs
        .lock()
        .expect("specs")
        .insert(symbol.to_string(), s.clone());
    Ok(s)
}

#[tauri::command]
pub async fn market_history(
    state: State<'_, MarketState>,
    venue: String,
    symbol: String,
    minutes: u32,
) -> CmdResult<WireHistory> {
    check_venue(&venue)?;
    let sp = spec(&state, &symbol).await?;
    let (trades, book) = tokio::join!(
        state.client.recent_trades(&sp, minutes.clamp(1, 240), 60),
        state.client.depth_snapshot(&sp, 1000)
    );
    let (_, bids, asks) = book?;
    Ok(WireHistory {
        tick_size: sp.tick.as_f64(),
        price_precision: sp.tick.precision(),
        qty_precision: sp.qty_precision,
        trades: trades?
            .into_iter()
            .map(|t| {
                (
                    t.exchange_ts_ns / 1_000_000,
                    t.px,
                    t.qty,
                    t.aggressor.as_i8(),
                    t.trade_id,
                )
            })
            .collect(),
        book: WireBook { bids, asks },
        end: now_ns() / 1_000_000,
    })
}

#[tauri::command]
pub async fn market_subscribe(
    state: State<'_, MarketState>,
    venue: String,
    symbol: String,
    channel: Channel<WireBatch>,
) -> CmdResult<u32> {
    check_venue(&venue)?;
    let sp = spec(&state, &symbol).await?;
    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    let (stop_tx, stop_rx) = watch::channel(false);
    let (tx, mut rx) = mpsc::channel::<MarketEvent>(20_000);
    state.subs.lock().expect("subs").insert(id, stop_tx);
    let client = state.client.clone();
    tauri::async_runtime::spawn(run_stream(client, sp, tx, stop_rx.clone()));
    let mut stop = stop_rx;
    tauri::async_runtime::spawn(async move {
        let mut frame = tokio::time::interval(Duration::from_millis(16));
        let mut batch = WireBatch::default();
        loop {
            tokio::select! {
                ev = rx.recv() => match ev {
                    None => break,
                    Some(MarketEvent::Trades(ts)) => batch.tr.extend(ts.into_iter().map(|t| (t.exchange_ts_ns / 1_000_000, t.px, t.qty, t.aggressor.as_i8(), t.trade_id))),
                    Some(MarketEvent::Deltas(ds)) => batch.bd.extend(ds.into_iter().map(|d| (if d.side == Side::Buy { 1 } else { -1 }, d.px, d.qty))),
                    Some(MarketEvent::Snapshot(s)) => {
                        // A snapshot supersedes any deltas queued before it.
                        batch.bd.clear();
                        batch.snap = Some(WireBook { bids: s.bids, asks: s.asks });
                    }
                    Some(MarketEvent::Status(s)) => batch.st = Some(WireStatus { state: s.state, latency_ms: s.latency_ms, msgs_per_sec: s.msgs_per_sec, message: s.message }),
                },
                _ = frame.tick() => {
                    if !batch.is_empty() {
                        batch.t = now_ns() / 1_000_000;
                        if channel.send(std::mem::take(&mut batch)).is_err() {
                            break; // window gone
                        }
                    }
                }
                _ = stop.changed() => break,
            }
        }
    });
    Ok(id)
}

#[tauri::command]
pub async fn market_unsubscribe(state: State<'_, MarketState>, id: u32) -> CmdResult<()> {
    if let Some(tx) = state.subs.lock().expect("subs").remove(&id) {
        let _ = tx.send(true);
    }
    Ok(())
}
