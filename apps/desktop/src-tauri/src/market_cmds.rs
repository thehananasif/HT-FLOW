//! Live market data commands.
//!
//! * Venue dispatch: `binance-futures`, `bybit-linear` (one enum, one match per operation).
//! * Live Pipeline stage 5: every subscribed stream is teed into the recorder (when enabled).
//! * Live Pipeline stage 6: `market_history` reads the local tick store first, backfills only
//!   the uncovered gaps from the venue's REST API, writes the backfill to the store and
//!   de-duplicates on trade id / timestamp at the seam.
//! * Live Pipeline stage 9: coalesces connector events every 16 ms into one compact batch per
//!   window over a Tauri channel (prices already in integer ticks).
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use htflow_connector_binance::{now_ns, BinanceFutures};
use htflow_connector_bybit::BybitLinear;
use htflow_core_types::{FeedState, MarketEvent, Side, TickSize, Trade};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::{mpsc, watch};

use crate::data_cmds::{DataState, RecMsg, RecorderService};
use crate::error::{CmdError, CmdResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Venue {
    BinanceFutures,
    BybitLinear,
}

impl Venue {
    pub fn parse(s: &str) -> CmdResult<Self> {
        match s {
            "binance-futures" => Ok(Venue::BinanceFutures),
            "bybit-linear" => Ok(Venue::BybitLinear),
            _ => Err(CmdError::new(
                "market.venue",
                format!("Venue '{s}' is not available yet (see docs/BLOCKERS.md)"),
            )),
        }
    }
    pub fn id(self) -> &'static str {
        match self {
            Venue::BinanceFutures => "binance-futures",
            Venue::BybitLinear => "bybit-linear",
        }
    }
    /// REST history pages forward from a start time (Binance) vs. only the latest N trades.
    fn history_from_start(self) -> bool {
        matches!(self, Venue::BinanceFutures)
    }
}

/// Venue-neutral instrument spec.
#[derive(Debug, Clone)]
pub struct Spec {
    pub symbol: String,
    pub tick: TickSize,
    pub qty_precision: u32,
}

impl From<htflow_connector_bybit::ConnectorError> for CmdError {
    fn from(e: htflow_connector_bybit::ConnectorError) -> Self {
        CmdError::new("market.connector", e.to_string())
    }
}

#[derive(Clone, Default)]
pub struct Clients {
    binance: BinanceFutures,
    bybit: BybitLinear,
}

impl Clients {
    async fn spec(&self, venue: Venue, symbol: &str) -> CmdResult<Spec> {
        Ok(match venue {
            Venue::BinanceFutures => {
                let s = self.binance.symbol_spec(symbol).await?;
                Spec {
                    symbol: s.symbol,
                    tick: s.tick,
                    qty_precision: s.qty_precision,
                }
            }
            Venue::BybitLinear => {
                let s = self.bybit.symbol_spec(symbol).await?;
                Spec {
                    symbol: s.symbol,
                    tick: s.tick,
                    qty_precision: s.qty_precision,
                }
            }
        })
    }

    fn binance_spec(sp: &Spec) -> htflow_connector_binance::SymbolSpec {
        htflow_connector_binance::SymbolSpec {
            symbol: sp.symbol.clone(),
            tick: sp.tick,
            qty_precision: sp.qty_precision,
        }
    }

    fn bybit_spec(sp: &Spec) -> htflow_connector_bybit::SymbolSpec {
        htflow_connector_bybit::SymbolSpec {
            symbol: sp.symbol.clone(),
            tick: sp.tick,
            qty_precision: sp.qty_precision,
        }
    }

    /// Trades from `from_ms` until now (best effort: Bybit only serves the latest 1,000).
    async fn trades_since(&self, venue: Venue, sp: &Spec, from_ms: i64) -> CmdResult<Vec<Trade>> {
        Ok(match venue {
            Venue::BinanceFutures => {
                let minutes = ((now_ns() / 1_000_000 - from_ms) / 60_000 + 1).clamp(1, 24 * 60);
                self.binance
                    .recent_trades(&Self::binance_spec(sp), minutes as u32, 60)
                    .await?
            }
            Venue::BybitLinear => self.bybit.recent_trades(&Self::bybit_spec(sp)).await?,
        })
    }

    async fn book(&self, venue: Venue, sp: &Spec) -> CmdResult<(Vec<(i64, f64)>, Vec<(i64, f64)>)> {
        Ok(match venue {
            Venue::BinanceFutures => {
                let (_, b, a) = self
                    .binance
                    .depth_snapshot(&Self::binance_spec(sp), 1000)
                    .await?;
                (b, a)
            }
            Venue::BybitLinear => {
                let (_, b, a) = self.bybit.depth_snapshot(&Self::bybit_spec(sp)).await?;
                (b, a)
            }
        })
    }

    fn spawn_stream(
        &self,
        venue: Venue,
        sp: &Spec,
        tx: mpsc::Sender<MarketEvent>,
        stop: watch::Receiver<bool>,
    ) {
        match venue {
            Venue::BinanceFutures => {
                tauri::async_runtime::spawn(htflow_connector_binance::run_stream(
                    self.binance.clone(),
                    Self::binance_spec(sp),
                    tx,
                    stop,
                ));
            }
            Venue::BybitLinear => {
                tauri::async_runtime::spawn(htflow_connector_bybit::run_stream(
                    self.bybit.clone(),
                    Self::bybit_spec(sp),
                    tx,
                    stop,
                ));
            }
        }
    }
}

#[derive(Default)]
pub struct MarketState {
    clients: Clients,
    subs: Mutex<HashMap<u32, watch::Sender<bool>>>,
    next: AtomicU32,
    specs: Mutex<HashMap<(Venue, String), Spec>>,
    /// Instrument → subscription that records it (one recorder per instrument).
    rec_owner: Arc<Mutex<HashMap<String, u32>>>,
}

#[derive(Debug, Serialize, Clone)]
pub struct WireStatus {
    state: FeedState,
    latency_ms: f64,
    msgs_per_sec: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    /// Book resyncs (gap or reconnect) since the subscription started.
    rs: u32,
    /// This subscription is being recorded to the tick store.
    rec: bool,
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
    /// Trades served from the local tick store / downloaded to fill gaps.
    local: usize,
    backfilled: usize,
}

async fn spec(state: &MarketState, venue: Venue, symbol: &str) -> CmdResult<Spec> {
    let key = (venue, symbol.to_string());
    if let Some(s) = state.specs.lock().expect("specs").get(&key) {
        return Ok(s.clone());
    }
    let s = state.clients.spec(venue, symbol).await?;
    state.specs.lock().expect("specs").insert(key, s.clone());
    Ok(s)
}

fn wire_trade(t: &Trade) -> (i64, i64, f64, i8, u64) {
    (
        t.exchange_ts_ns / 1_000_000,
        t.px,
        t.qty,
        t.aggressor.as_i8(),
        t.trade_id,
    )
}

/// Merges local and remote trades: sorted by time, remote rows already present locally (same
/// trade id, or same timestamp + price + size when ids are missing) are dropped.
pub fn merge_trades(local: Vec<Trade>, remote: Vec<Trade>) -> (Vec<Trade>, Vec<Trade>) {
    let ids: HashSet<u64> = local
        .iter()
        .map(|t| t.trade_id)
        .filter(|i| *i != 0)
        .collect();
    let keys: HashSet<(i64, i64, u64)> = local
        .iter()
        .map(|t| (t.exchange_ts_ns, t.px, t.qty.to_bits()))
        .collect();
    let fresh: Vec<Trade> = remote
        .into_iter()
        .filter(|t| {
            if t.trade_id != 0 {
                !ids.contains(&t.trade_id)
            } else {
                !keys.contains(&(t.exchange_ts_ns, t.px, t.qty.to_bits()))
            }
        })
        .collect();
    let mut all = local;
    all.extend(fresh.iter().cloned());
    all.sort_by_key(|t| (t.exchange_ts_ns, t.trade_id));
    (all, fresh)
}

/// Live Pipeline stage 6: local tick store first, REST only for the gaps.
#[tauri::command]
pub async fn market_history(
    state: State<'_, MarketState>,
    data: State<'_, DataState>,
    venue: String,
    symbol: String,
    minutes: u32,
) -> CmdResult<WireHistory> {
    let venue = Venue::parse(&venue)?;
    let sp = spec(&state, venue, &symbol).await?;
    let inst = format!("{}:{}", venue.id(), sp.symbol);
    let now = now_ns();
    let from = now - i64::from(minutes.clamp(1, 7 * 24 * 60)) * 60_000_000_000;
    let svc: Arc<RecorderService> = data.0.clone();

    // (a) local store + coverage
    let (local, gaps) = {
        let svc = svc.clone();
        let inst = inst.clone();
        let tick = sp.tick;
        tauri::async_runtime::spawn_blocking(move || {
            let cov = svc.rec.lock().expect("recorder").coverage(&inst)?;
            let (recs, _) = svc.store.read_trades(&inst, from, now, Some(tick))?;
            let gaps = cov.gaps(from, now, 2_000_000_000);
            Ok::<_, CmdError>((recs.iter().map(|r| r.to_trade()).collect::<Vec<_>>(), gaps))
        })
        .await
        .map_err(|e| CmdError::new("market.internal", e.to_string()))??
    };

    // (b)(c) backfill the gaps
    let mut backfilled = 0;
    let mut trades = local.clone();
    let book_fut = state.clients.book(venue, &sp);
    let remote_fut = async {
        match gaps.first() {
            Some(&(g0, _)) => Some(state.clients.trades_since(venue, &sp, g0 / 1_000_000).await),
            None => None,
        }
    };
    let (book, remote) = tokio::join!(book_fut, remote_fut);
    match remote {
        Some(Ok(remote)) => {
            let first_ts = remote.first().map(|t| t.exchange_ts_ns);
            let last_ts = remote.last().map(|t| t.exchange_ts_ns);
            let in_gap: Vec<Trade> = remote
                .into_iter()
                .filter(|t| {
                    gaps.iter()
                        .any(|&(a, b)| t.exchange_ts_ns >= a && t.exchange_ts_ns < b)
                })
                .collect();
            let (all, fresh) = merge_trades(local, in_gap);
            backfilled = fresh.len();
            trades = all;
            // (d) write the backfill to the store and mark what it now covers.
            if let (Some(first), Some(last)) = (first_ts, last_ts) {
                let start_ok = venue.history_from_start();
                let tick = sp.tick;
                let inst = inst.clone();
                let gaps = gaps.clone();
                let svc = svc.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let mut r = svc.rec.lock().expect("recorder");
                    for (a, b) in gaps {
                        let lo = if start_ok { a } else { a.max(first) };
                        let hi = b.min(last + 1);
                        if lo < hi {
                            let part: Vec<Trade> = fresh
                                .iter()
                                .filter(|t| t.exchange_ts_ns >= lo && t.exchange_ts_ns < hi)
                                .cloned()
                                .collect();
                            if let Err(e) = r.write_backfill(&inst, tick, &part, lo, hi) {
                                tracing::warn!(error = %e, "backfill write failed");
                            }
                        }
                    }
                });
            }
        }
        Some(Err(e)) if trades.is_empty() => return Err(e),
        Some(Err(e)) => {
            tracing::warn!(error = %e.message, "backfill failed; serving local data only")
        }
        None => {}
    }
    let (bids, asks) = match book {
        Ok(b) => b,
        Err(e) if !trades.is_empty() => {
            tracing::warn!(error = %e.message, "book snapshot failed");
            (Vec::new(), Vec::new())
        }
        Err(e) => return Err(e),
    };
    let local_n = trades.len() - backfilled;
    Ok(WireHistory {
        tick_size: sp.tick.as_f64(),
        price_precision: sp.tick.precision(),
        qty_precision: sp.qty_precision,
        trades: trades
            .iter()
            .filter(|t| t.exchange_ts_ns >= from)
            .map(wire_trade)
            .collect(),
        book: WireBook { bids, asks },
        end: now / 1_000_000,
        local: local_n,
        backfilled,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    ok: bool,
    latency_ms: f64,
    message: String,
}

/// Connection test for the Add-connection wizard: fetches instrument metadata over REST.
#[tauri::command]
pub async fn market_test(
    state: State<'_, MarketState>,
    venue: String,
    symbol: String,
) -> CmdResult<TestResult> {
    let venue = Venue::parse(&venue)?;
    let t0 = Instant::now();
    Ok(match state.clients.spec(venue, &symbol).await {
        Ok(s) => TestResult {
            ok: true,
            latency_ms: t0.elapsed().as_secs_f64() * 1000.0,
            message: format!("{} tick {}", s.symbol, s.tick.as_f64()),
        },
        Err(e) => TestResult {
            ok: false,
            latency_ms: t0.elapsed().as_secs_f64() * 1000.0,
            message: e.message,
        },
    })
}

#[tauri::command]
pub async fn market_subscribe(
    state: State<'_, MarketState>,
    data: State<'_, DataState>,
    venue: String,
    symbol: String,
    channel: Channel<WireBatch>,
) -> CmdResult<u32> {
    let venue = Venue::parse(&venue)?;
    let sp = spec(&state, venue, &symbol).await?;
    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    let (stop_tx, stop_rx) = watch::channel(false);
    let (tx, mut rx) = mpsc::channel::<MarketEvent>(20_000);
    state.subs.lock().expect("subs").insert(id, stop_tx);
    state.clients.spawn_stream(venue, &sp, tx, stop_rx.clone());
    let inst = format!("{}:{}", venue.id(), sp.symbol);
    let svc = data.0.clone();
    let owners = state.rec_owner.clone();
    let tick = sp.tick;
    let mut stop = stop_rx;
    tauri::async_runtime::spawn(async move {
        let mut frame = tokio::time::interval(Duration::from_millis(16));
        let mut batch = WireBatch::default();
        let mut snapshots = 0u32;
        // Recording: the first live subscription of an instrument owns it.
        let owns = |owners: &Mutex<HashMap<String, u32>>| -> bool {
            let mut o = owners.lock().expect("owners");
            *o.entry(inst.clone()).or_insert(id) == id
        };
        loop {
            let recording = svc.records(&inst) && owns(&owners);
            tokio::select! {
                ev = rx.recv() => match ev {
                    None => break,
                    Some(MarketEvent::Trades(ts)) => {
                        batch.tr.extend(ts.iter().map(wire_trade));
                        if recording { svc.offer(RecMsg::Trades(inst.clone(), tick, ts)); }
                    }
                    Some(MarketEvent::Deltas(ds)) => {
                        batch.bd.extend(ds.iter().map(|d| (if d.side == Side::Buy { 1 } else { -1 }, d.px, d.qty)));
                        if recording { svc.offer(RecMsg::Deltas(inst.clone(), tick, now_ns(), ds)); }
                    }
                    Some(MarketEvent::Snapshot(s)) => {
                        snapshots += 1;
                        // A snapshot supersedes any deltas queued before it.
                        batch.bd.clear();
                        batch.snap = Some(WireBook { bids: s.bids.clone(), asks: s.asks.clone() });
                        if recording { svc.offer(RecMsg::Snapshot(inst.clone(), tick, s)); }
                    }
                    Some(MarketEvent::Status(s)) => {
                        if recording {
                            match s.state {
                                FeedState::Live => svc.offer(RecMsg::Alive(inst.clone())),
                                FeedState::Disconnected | FeedState::Error => svc.offer(RecMsg::Break(inst.clone())),
                                _ => {}
                            }
                        }
                        batch.st = Some(WireStatus {
                            state: s.state,
                            latency_ms: s.latency_ms,
                            msgs_per_sec: s.msgs_per_sec,
                            message: s.message,
                            rs: snapshots.saturating_sub(1),
                            rec: recording,
                        });
                    }
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
        let mut o = owners.lock().expect("owners");
        if o.get(&inst) == Some(&id) {
            o.remove(&inst);
            svc.offer(RecMsg::Close(inst.clone()));
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

#[cfg(test)]
mod tests {
    use super::*;
    use htflow_core_types::Aggressor;

    fn t(ts: i64, id: u64) -> Trade {
        Trade {
            exchange_ts_ns: ts,
            local_ts_ns: ts,
            px: 1,
            qty: 1.0,
            aggressor: Aggressor::Buy,
            trade_id: id,
        }
    }

    #[test]
    fn merge_dedupes_at_the_seam() {
        let local = vec![t(10, 1), t(20, 2), t(30, 3)];
        let remote = vec![t(25, 2), t(30, 3), t(40, 4), t(5, 0)];
        let (all, fresh) = merge_trades(local, remote);
        assert_eq!(
            all.iter().map(|x| x.trade_id).collect::<Vec<_>>(),
            vec![0, 1, 2, 3, 4]
        );
        assert_eq!(fresh.len(), 2);
        assert_eq!(Venue::parse("bybit-linear").unwrap(), Venue::BybitLinear);
        assert!(Venue::parse("okx-swap").is_err());
    }
}
