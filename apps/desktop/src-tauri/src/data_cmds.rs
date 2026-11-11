//! Live Pipeline stage 5 (recorder) and the P06 Data manager commands. The recorder runs on
//! its own thread; streamers hand it events with a non-blocking `try_send`, so a slow disk can
//! never stall a socket (events are dropped and counted instead).
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use htflow_connector_binance::now_ns;
use htflow_core_types::{BookDelta, BookSnapshot, TickSize, Trade};
use htflow_tick_store::{
    day_of, day_start_ns, parse_day, top_snapshots, InstrumentSummary, Kind, Recorder,
    RecorderConfig, RecorderStats, RetentionReport, StoreError, StoreLimits, TickStore,
    NS_PER_DAY,
};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{CmdError, CmdResult};

impl From<StoreError> for CmdError {
    fn from(e: StoreError) -> Self {
        CmdError::new("data.store", e.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecorderSettings {
    /// Record live trades + depth of subscribed instruments (default on).
    pub enabled: bool,
    /// Only these instruments (`venue:SYMBOL`); `None` = every subscribed instrument.
    pub instruments: Option<Vec<String>>,
    pub retention_days: u32,
    pub max_disk_gb: f64,
}

impl Default for RecorderSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            instruments: None,
            retention_days: 30,
            max_disk_gb: 20.0,
        }
    }
}

impl RecorderSettings {
    fn validated(mut self) -> Self {
        self.retention_days = self.retention_days.min(3650);
        if !self.max_disk_gb.is_finite() || self.max_disk_gb < 0.0 {
            self.max_disk_gb = 20.0;
        }
        self.max_disk_gb = self.max_disk_gb.min(10_000.0);
        self
    }
    fn limits(&self) -> StoreLimits {
        StoreLimits {
            retention_days: self.retention_days,
            max_disk_bytes: (self.max_disk_gb * 1024.0 * 1024.0 * 1024.0) as u64,
        }
    }
    pub fn records(&self, instrument: &str) -> bool {
        self.enabled
            && self
                .instruments
                .as_ref()
                .is_none_or(|l| l.iter().any(|i| i == instrument))
    }
}

pub enum RecMsg {
    Trades(String, TickSize, Vec<Trade>),
    Deltas(String, TickSize, i64, Vec<BookDelta>),
    Snapshot(String, TickSize, BookSnapshot),
    Alive(String),
    Break(String),
    Close(String),
}

/// Recorder thread + shared state. Commands lock `rec` briefly (list/delete/coverage).
pub struct RecorderService {
    tx: SyncSender<RecMsg>,
    pub rec: Arc<Mutex<Recorder>>,
    pub store: TickStore,
    pub settings: Mutex<RecorderSettings>,
    settings_path: PathBuf,
    pub exports: PathBuf,
    pub dropped: AtomicU64,
}

impl RecorderService {
    pub fn start(data_root: &std::path::Path) -> Result<Arc<Self>, StoreError> {
        let store = TickStore::open(data_root.join("ticks"))?;
        let settings_path = data_root.join("recorder.json");
        let settings: RecorderSettings = std::fs::read(&settings_path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let settings = settings.validated();
        let cfg = RecorderConfig {
            limits: settings.limits(),
            ..RecorderConfig::default()
        };
        let rec = Arc::new(Mutex::new(Recorder::new(store.clone(), cfg)));
        let (tx, rx) = sync_channel::<RecMsg>(50_000);
        let svc = Arc::new(Self {
            tx,
            rec: rec.clone(),
            store: store.clone(),
            settings: Mutex::new(settings),
            settings_path,
            exports: data_root.join("exports"),
            dropped: AtomicU64::new(0),
        });
        std::thread::Builder::new()
            .name("tick-recorder".into())
            .spawn(move || {
                // Compact days left uncompacted by a previous run (crash / app closed).
                let n = store.compact_closed(day_of(now_ns()), &HashSet::new());
                if n > 0 {
                    tracing::info!(files = n, "tick-store: compacted closed days");
                }
                loop {
                    let first = match rx.recv_timeout(Duration::from_millis(200)) {
                        Ok(m) => Some(m),
                        Err(RecvTimeoutError::Timeout) => None,
                        Err(RecvTimeoutError::Disconnected) => break,
                    };
                    let mut r = rec.lock().expect("recorder");
                    if let Some(m) = first {
                        handle(&mut r, m);
                        // Drain a burst under one lock.
                        for m in rx.try_iter().take(2_000) {
                            handle(&mut r, m);
                        }
                    }
                    if let Err(e) = r.maintain(Instant::now(), now_ns()) {
                        r.stats.errors += 1;
                        tracing::warn!(error = %e, "tick-store maintenance failed");
                    }
                }
                let _ = rec.lock().expect("recorder").close_all();
            })
            .map_err(StoreError::Io)?;
        Ok(svc)
    }

    /// Non-blocking hand-off from a streamer.
    pub fn offer(&self, m: RecMsg) {
        if let Err(TrySendError::Full(_)) = self.tx.try_send(m) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn records(&self, instrument: &str) -> bool {
        self.settings.lock().expect("settings").records(instrument)
    }

    fn save_settings(&self, s: &RecorderSettings) {
        if let Ok(b) = serde_json::to_vec_pretty(s) {
            let _ = std::fs::write(&self.settings_path, b);
        }
    }
}

fn handle(r: &mut Recorder, m: RecMsg) {
    let res = match m {
        RecMsg::Trades(id, tick, t) => r.on_trades(&id, tick, &t),
        RecMsg::Deltas(id, tick, ts, d) => r.on_deltas(&id, tick, ts, &d),
        RecMsg::Snapshot(id, tick, s) => r.on_snapshot(&id, tick, &s),
        RecMsg::Alive(id) => {
            r.on_alive(&id, now_ns());
            Ok(())
        }
        RecMsg::Break(id) => {
            r.on_break(&id);
            Ok(())
        }
        RecMsg::Close(id) => r.close(&id),
    };
    if let Err(e) = res {
        r.stats.errors += 1;
        tracing::warn!(error = %e, "tick-store write failed");
    }
}

pub struct DataState(pub Arc<RecorderService>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderStatus {
    settings: RecorderSettings,
    recording: Vec<String>,
    disk_bytes: u64,
    trades: u64,
    depth_rows: u64,
    errors: u64,
    dropped: u64,
    root: String,
}

fn status(svc: &RecorderService) -> RecorderStatus {
    let (recording, stats): (Vec<String>, RecorderStats) = {
        let r = svc.rec.lock().expect("recorder");
        (r.active(), r.stats)
    };
    RecorderStatus {
        settings: svc.settings.lock().expect("settings").clone(),
        recording,
        disk_bytes: svc.store.disk_usage(),
        trades: stats.trades,
        depth_rows: stats.depth_rows,
        errors: stats.errors,
        dropped: svc.dropped.load(Ordering::Relaxed),
        root: svc.store.root().display().to_string(),
    }
}

/// Turns recording on/off (optionally for a list of instruments) and sets the limits.
#[tauri::command]
pub async fn recorder_set(
    state: State<'_, DataState>,
    enabled: bool,
    instruments: Option<Vec<String>>,
    retention_days: Option<u32>,
    max_disk_gb: Option<f64>,
) -> CmdResult<RecorderStatus> {
    let svc = state.0.clone();
    let s = {
        let mut s = svc.settings.lock().expect("settings");
        s.enabled = enabled;
        s.instruments = instruments.filter(|l| !l.is_empty());
        if let Some(d) = retention_days {
            s.retention_days = d;
        }
        if let Some(g) = max_disk_gb {
            s.max_disk_gb = g;
        }
        *s = s.clone().validated();
        s.clone()
    };
    svc.save_settings(&s);
    {
        let mut r = svc.rec.lock().expect("recorder");
        r.cfg.limits = s.limits();
        for id in r.active() {
            if !s.records(&id) {
                r.close(&id)?;
            }
        }
    }
    Ok(status(&svc))
}

#[tauri::command]
pub async fn recorder_status(state: State<'_, DataState>) -> CmdResult<RecorderStatus> {
    let svc = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || status(&svc))
        .await
        .map_err(|e| CmdError::new("data.internal", e.to_string()))
}

#[tauri::command]
pub async fn data_list(state: State<'_, DataState>) -> CmdResult<Vec<InstrumentSummary>> {
    let store = state.0.store.clone();
    tauri::async_runtime::spawn_blocking(move || store.list())
        .await
        .map_err(|e| CmdError::new("data.internal", e.to_string()))
}

fn day_arg(s: Option<String>) -> CmdResult<Option<i32>> {
    match s {
        None => Ok(None),
        Some(s) if s.is_empty() => Ok(None),
        Some(s) => parse_day(&s)
            .map(Some)
            .ok_or_else(|| CmdError::new("data.date", format!("Invalid date '{s}' (YYYY-MM-DD)"))),
    }
}

/// Deletes days `[from, to]` (YYYY-MM-DD, both optional = everything) of an instrument.
#[tauri::command]
pub async fn data_delete(
    state: State<'_, DataState>,
    instrument: String,
    from: Option<String>,
    to: Option<String>,
) -> CmdResult<RetentionReport> {
    let (from, to) = (day_arg(from)?, day_arg(to)?);
    let svc = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        svc.rec
            .lock()
            .expect("recorder")
            .delete(&instrument, from, to)
            .map_err(CmdError::from)
    })
    .await
    .map_err(|e| CmdError::new("data.internal", e.to_string()))?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    path: String,
    rows: u64,
}

/// Writes `<data root>/exports/<venue>_<symbol>_<from>_<to>_<kind>.csv`.
#[tauri::command]
pub async fn data_export_csv(
    state: State<'_, DataState>,
    instrument: String,
    kind: Option<String>,
    from: Option<String>,
    to: Option<String>,
) -> CmdResult<ExportResult> {
    let kind = match kind.as_deref().unwrap_or("trades") {
        "trades" => Kind::Trades,
        "depth" => Kind::Depth,
        k => return Err(CmdError::new("data.kind", format!("Unknown kind '{k}'"))),
    };
    let (fd, td) = (day_arg(from.clone())?, day_arg(to.clone())?);
    let svc = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Make what is buffered visible to the export.
        let _ = svc.rec.lock().expect("recorder").flush_all();
        std::fs::create_dir_all(&svc.exports).map_err(StoreError::Io)?;
        let safe: String = instrument
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
            .collect();
        let name = format!(
            "{safe}_{}_{}_{}.csv",
            from.unwrap_or_else(|| "start".into()),
            to.unwrap_or_else(|| "end".into()),
            kind.ext()
        );
        let path = svc.exports.join(name);
        let f = std::fs::File::create(&path).map_err(StoreError::Io)?;
        let mut w = std::io::BufWriter::new(f);
        let rows = svc.store.export_csv(
            &instrument,
            kind,
            fd.map_or(i64::MIN, day_start_ns),
            td.map_or(i64::MAX, |d| day_start_ns(d) + NS_PER_DAY),
            &mut w,
        )?;
        Ok(ExportResult {
            path: path.display().to_string(),
            rows,
        })
    })
    .await
    .map_err(|e| CmdError::new("data.internal", e.to_string()))?
}

/// Recorded data for replay (P24): trades + 250 ms top-of-book snapshots, prices in ticks.
#[derive(Debug, Serialize)]
pub struct WireReplay {
    tick_size: f64,
    price_precision: u32,
    /// [ts_ms, px, qty, side, id]
    trades: Vec<(f64, i64, f64, i8, u64)>,
    /// [ts_ms, bids, asks]
    snapshots: Vec<(f64, Vec<(i64, f64)>, Vec<(i64, f64)>)>,
}

#[tauri::command]
pub async fn data_replay(
    state: State<'_, DataState>,
    instrument: String,
    from_ms: f64,
    to_ms: f64,
    depth: Option<bool>,
) -> CmdResult<WireReplay> {
    let store = state.0.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (a, b) = ((from_ms * 1e6) as i64, (to_ms * 1e6) as i64);
        let (trades, tick) = store.read_trades(&instrument, a, b, None)?;
        let snapshots = if depth.unwrap_or(true) {
            let (rows, _) = store.read_depth(&instrument, a, b, tick)?;
            top_snapshots(&rows)
                .into_iter()
                .map(|s| (s.ts_ns as f64 / 1e6, s.bids, s.asks))
                .collect()
        } else {
            Vec::new()
        };
        let tick = tick.unwrap_or(TickSize { scale: 0, units: 1 });
        Ok(WireReplay {
            tick_size: tick.as_f64(),
            price_precision: tick.precision(),
            trades: trades
                .iter()
                .map(|t| {
                    (
                        t.ts_ns as f64 / 1e6,
                        t.px,
                        t.qty,
                        t.aggressor.as_i8(),
                        t.trade_id,
                    )
                })
                .collect(),
            snapshots,
        })
    })
    .await
    .map_err(|e| CmdError::new("data.internal", e.to_string()))?
}
