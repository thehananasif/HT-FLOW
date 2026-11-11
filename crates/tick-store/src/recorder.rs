//! Live Pipeline stage 5 — the recorder. Appends trades, depth deltas, full snapshots (on
//! (re)sync and every 5 min) and 250 ms top-of-book snapshots to today's file per instrument.
//! Buffers are flushed every 1 s and fsynced every 10 s; closed days are compacted.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use htflow_core_types::{BookDelta, BookSnapshot, Side, TickSize, Trade};

use crate::codec::{depth_flags, DepthRec, Kind, TradeRec};
use crate::coverage::Coverage;
use crate::day::{day_of, Day};
use crate::file::DayWriter;
use crate::store::{RetentionReport, StoreLimits, TickStore};
use crate::StoreError;

#[derive(Debug, Clone, Copy)]
pub struct RecorderConfig {
    pub flush_every: Duration,
    pub fsync_every: Duration,
    /// Top-of-book snapshot interval (ns).
    pub top_every_ns: i64,
    /// Levels per side in a top-of-book snapshot.
    pub top_levels: usize,
    /// Full-book snapshot interval (ns) so book replay can start anywhere.
    pub full_every_ns: i64,
    /// How often retention + max-disk limits are enforced.
    pub retention_every: Duration,
    pub limits: StoreLimits,
}

impl Default for RecorderConfig {
    fn default() -> Self {
        Self {
            flush_every: Duration::from_secs(1),
            fsync_every: Duration::from_secs(10),
            top_every_ns: 250_000_000,
            top_levels: 25,
            full_every_ns: 300_000_000_000,
            retention_every: Duration::from_secs(600),
            limits: StoreLimits::default(),
        }
    }
}

#[derive(Default)]
struct Book {
    bids: BTreeMap<i64, f64>,
    asks: BTreeMap<i64, f64>,
}

struct InstState {
    tick: TickSize,
    trades: BTreeMap<Day, DayWriter<TradeRec>>,
    depth: BTreeMap<Day, DayWriter<DepthRec>>,
    book: Option<Book>,
    next_top_ns: i64,
    next_full_ns: i64,
    /// Open coverage interval (stream connected since `.0`, last seen at `.1`).
    cov_open: Option<(i64, i64)>,
    cov_closed: Vec<(i64, i64)>,
    cov_dirty: bool,
}

impl InstState {
    fn new(tick: TickSize) -> Self {
        Self {
            tick,
            trades: BTreeMap::new(),
            depth: BTreeMap::new(),
            book: None,
            next_top_ns: 0,
            next_full_ns: 0,
            cov_open: None,
            cov_closed: Vec::new(),
            cov_dirty: false,
        }
    }
}

/// Counters for the status UI.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RecorderStats {
    pub trades: u64,
    pub depth_rows: u64,
    pub flushes: u64,
    pub syncs: u64,
    pub errors: u64,
}

pub struct Recorder {
    store: TickStore,
    pub cfg: RecorderConfig,
    insts: HashMap<String, InstState>,
    last_flush: Instant,
    last_sync: Instant,
    last_retention: Option<Instant>,
    pub stats: RecorderStats,
}

impl Recorder {
    pub fn new(store: TickStore, cfg: RecorderConfig) -> Self {
        let now = Instant::now();
        Self {
            store,
            cfg,
            insts: HashMap::new(),
            last_flush: now,
            last_sync: now,
            last_retention: None,
            stats: RecorderStats::default(),
        }
    }

    pub fn store(&self) -> &TickStore {
        &self.store
    }

    /// Instruments with open writers.
    pub fn active(&self) -> Vec<String> {
        let mut v: Vec<String> = self.insts.keys().cloned().collect();
        v.sort();
        v
    }

    fn inst(&mut self, instrument: &str, tick: TickSize) -> Result<&mut InstState, StoreError> {
        if !self.insts.contains_key(instrument) {
            self.store.ensure_meta(instrument)?;
            self.insts
                .insert(instrument.to_string(), InstState::new(tick));
        }
        let st = self.insts.get_mut(instrument).expect("inserted");
        st.tick = tick;
        Ok(st)
    }

    fn trade_writer<'a>(
        store: &TickStore,
        st: &'a mut InstState,
        instrument: &str,
        day: Day,
    ) -> Result<&'a mut DayWriter<TradeRec>, StoreError> {
        if !st.trades.contains_key(&day) {
            let p = store.day_path(instrument, Kind::Trades, day)?;
            st.trades.insert(day, DayWriter::open(&p, st.tick, day)?);
        }
        Ok(st.trades.get_mut(&day).expect("inserted"))
    }

    fn depth_writer<'a>(
        store: &TickStore,
        st: &'a mut InstState,
        instrument: &str,
        day: Day,
    ) -> Result<&'a mut DayWriter<DepthRec>, StoreError> {
        if !st.depth.contains_key(&day) {
            let p = store.day_path(instrument, Kind::Depth, day)?;
            st.depth.insert(day, DayWriter::open(&p, st.tick, day)?);
        }
        Ok(st.depth.get_mut(&day).expect("inserted"))
    }

    /// Appends live trades (each to the file of its own UTC day).
    pub fn on_trades(
        &mut self,
        instrument: &str,
        tick: TickSize,
        trades: &[Trade],
    ) -> Result<(), StoreError> {
        let store = self.store.clone();
        let st = self.inst(instrument, tick)?;
        let mut last = None;
        for t in trades {
            let day = day_of(t.exchange_ts_ns);
            Self::trade_writer(&store, st, instrument, day)?.push(TradeRec::from(t), tick)?;
            last = Some(t.exchange_ts_ns);
        }
        if let Some(ts) = last {
            Self::touch_coverage(st, ts);
        }
        self.stats.trades += trades.len() as u64;
        Ok(())
    }

    fn touch_coverage(st: &mut InstState, ts: i64) {
        match &mut st.cov_open {
            Some((_, end)) => *end = (*end).max(ts),
            None => st.cov_open = Some((ts, ts)),
        }
        st.cov_dirty = true;
    }

    /// The stream is connected and healthy at `now_ns` (heartbeat: extends coverage in quiet
    /// markets). Coverage starts at the first trade after a (re)connect.
    pub fn on_alive(&mut self, instrument: &str, now_ns: i64) {
        if let Some(st) = self.insts.get_mut(instrument) {
            if let Some((_, end)) = &mut st.cov_open {
                *end = (*end).max(now_ns);
                st.cov_dirty = true;
            }
        }
    }

    /// The stream dropped: close the coverage interval (trades may be missing from here on).
    pub fn on_break(&mut self, instrument: &str) {
        if let Some(st) = self.insts.get_mut(instrument) {
            if let Some(iv) = st.cov_open.take() {
                st.cov_closed.push(iv);
                st.cov_dirty = true;
            }
            st.book = None;
        }
    }

    fn write_book(
        store: &TickStore,
        st: &mut InstState,
        instrument: &str,
        ts_ns: i64,
        top: Option<usize>,
    ) -> Result<u64, StoreError> {
        let tick = st.tick;
        let Some(book) = st.book.take() else {
            return Ok(0);
        };
        let w = Self::depth_writer(store, st, instrument, day_of(ts_ns));
        let res = (|| {
            let w = w?;
            let (base, limit) = match top {
                Some(n) => (depth_flags::SNAPSHOT | depth_flags::TOP, n),
                None => (depth_flags::SNAPSHOT, usize::MAX),
            };
            let mut rows: Vec<(u8, i64, f64)> = book
                .bids
                .iter()
                .rev()
                .take(limit)
                .map(|(p, q)| (base, *p, *q))
                .chain(
                    book.asks
                        .iter()
                        .take(limit)
                        .map(|(p, q)| (base | depth_flags::ASK, *p, *q)),
                )
                .collect();
            if top.is_none() && rows.is_empty() {
                // Empty book: a lone reset row so replay still clears.
                rows.push((base, 0, 0.0));
            }
            for (i, (flags, px, qty)) in rows.iter().enumerate() {
                let flags = if i == 0 && top.is_none() {
                    flags | depth_flags::RESET
                } else {
                    *flags
                };
                w.push(
                    DepthRec {
                        ts_ns,
                        flags,
                        px: *px,
                        qty: *qty,
                    },
                    tick,
                )?;
            }
            Ok::<u64, StoreError>(rows.len() as u64)
        })();
        st.book = Some(book);
        res
    }

    fn sample(
        store: &TickStore,
        st: &mut InstState,
        instrument: &str,
        ts_ns: i64,
        cfg: &RecorderConfig,
    ) -> Result<u64, StoreError> {
        let mut n = 0;
        if st.book.is_some() && ts_ns >= st.next_full_ns {
            n += Self::write_book(store, st, instrument, ts_ns, None)?;
            st.next_full_ns = ts_ns + cfg.full_every_ns;
        }
        if st.book.is_some() && ts_ns >= st.next_top_ns {
            n += Self::write_book(store, st, instrument, ts_ns, Some(cfg.top_levels))?;
            st.next_top_ns = (ts_ns / cfg.top_every_ns + 1) * cfg.top_every_ns;
        }
        Ok(n)
    }

    /// A full book from the connector (initial sync or resync): recorded in full.
    pub fn on_snapshot(
        &mut self,
        instrument: &str,
        tick: TickSize,
        snap: &BookSnapshot,
    ) -> Result<(), StoreError> {
        let store = self.store.clone();
        let cfg = self.cfg;
        let st = self.inst(instrument, tick)?;
        st.book = Some(Book {
            bids: snap.bids.iter().copied().filter(|l| l.1 > 0.0).collect(),
            asks: snap.asks.iter().copied().filter(|l| l.1 > 0.0).collect(),
        });
        st.next_full_ns = 0; // write the full book now
        let n = Self::sample(&store, st, instrument, snap.ts_ns, &cfg)?;
        self.stats.depth_rows += n;
        Ok(())
    }

    /// Incremental book changes received at `ts_ns`. Ignored until a snapshot arrived.
    pub fn on_deltas(
        &mut self,
        instrument: &str,
        tick: TickSize,
        ts_ns: i64,
        deltas: &[BookDelta],
    ) -> Result<(), StoreError> {
        let store = self.store.clone();
        let cfg = self.cfg;
        let st = self.inst(instrument, tick)?;
        let Some(book) = st.book.as_mut() else {
            return Ok(());
        };
        for d in deltas {
            let side = match d.side {
                Side::Buy => &mut book.bids,
                Side::Sell => &mut book.asks,
            };
            if d.qty > 0.0 {
                side.insert(d.px, d.qty);
            } else {
                side.remove(&d.px);
            }
        }
        let w = Self::depth_writer(&store, st, instrument, day_of(ts_ns))?;
        for d in deltas {
            w.push(
                DepthRec {
                    ts_ns,
                    flags: if d.side == Side::Sell {
                        depth_flags::ASK
                    } else {
                        0
                    },
                    px: d.px,
                    qty: d.qty.max(0.0),
                },
                tick,
            )?;
        }
        let n = deltas.len() as u64 + Self::sample(&store, st, instrument, ts_ns, &cfg)?;
        self.stats.depth_rows += n;
        Ok(())
    }

    /// Writes backfilled trades (already de-duplicated by the caller) and marks `[from, to)`
    /// as covered (Live Pipeline stage 6 d).
    pub fn write_backfill(
        &mut self,
        instrument: &str,
        tick: TickSize,
        trades: &[Trade],
        from_ns: i64,
        to_ns: i64,
    ) -> Result<(), StoreError> {
        let store = self.store.clone();
        let st = self.inst(instrument, tick)?;
        for t in trades {
            let day = day_of(t.exchange_ts_ns);
            Self::trade_writer(&store, st, instrument, day)?.push(TradeRec::from(t), tick)?;
        }
        st.cov_closed.push((from_ns, to_ns));
        st.cov_dirty = true;
        Ok(())
    }

    /// Persisted coverage plus what is pending in memory.
    pub fn coverage(&self, instrument: &str) -> Result<Coverage, StoreError> {
        let mut c = self.store.coverage(instrument)?;
        if let Some(st) = self.insts.get(instrument) {
            for &(a, b) in &st.cov_closed {
                c.add(a, b);
            }
            if let Some((a, b)) = st.cov_open {
                c.add(a, b + 1);
            }
        }
        Ok(c)
    }

    fn persist_coverage(&mut self) -> Result<(), StoreError> {
        for (id, st) in self.insts.iter_mut() {
            if !st.cov_dirty {
                continue;
            }
            let mut c = self.store.coverage(id)?;
            for (a, b) in st.cov_closed.drain(..) {
                c.add(a, b);
            }
            if let Some((a, b)) = st.cov_open {
                c.add(a, b + 1);
            }
            self.store.save_coverage(id, &c)?;
            st.cov_dirty = false;
        }
        Ok(())
    }

    /// Writes every buffer to the OS.
    pub fn flush_all(&mut self) -> Result<(), StoreError> {
        for st in self.insts.values_mut() {
            for w in st.trades.values_mut() {
                w.flush()?;
            }
            for w in st.depth.values_mut() {
                w.flush()?;
            }
        }
        self.stats.flushes += 1;
        Ok(())
    }

    /// Flush + fsync + persist coverage.
    pub fn sync_all(&mut self) -> Result<(), StoreError> {
        for st in self.insts.values_mut() {
            for w in st.trades.values_mut() {
                w.sync()?;
            }
            for w in st.depth.values_mut() {
                w.sync()?;
            }
        }
        self.persist_coverage()?;
        self.stats.syncs += 1;
        Ok(())
    }

    /// Paths currently held open for writing.
    pub fn open_files(&self) -> HashSet<PathBuf> {
        let mut s = HashSet::new();
        for st in self.insts.values() {
            s.extend(st.trades.values().map(|w| w.path().to_path_buf()));
            s.extend(st.depth.values().map(|w| w.path().to_path_buf()));
        }
        s
    }

    /// Syncs and closes writers of days before `keep_from`, compacting them.
    fn close_days_before(&mut self, keep_from: Day) -> Result<u32, StoreError> {
        let mut closed: Vec<PathBuf> = Vec::new();
        for st in self.insts.values_mut() {
            let old: Vec<Day> = st.trades.range(..keep_from).map(|(d, _)| *d).collect();
            for d in old {
                if let Some(mut w) = st.trades.remove(&d) {
                    w.sync()?;
                    closed.push(w.path().to_path_buf());
                }
            }
            let old: Vec<Day> = st.depth.range(..keep_from).map(|(d, _)| *d).collect();
            for d in old {
                if let Some(mut w) = st.depth.remove(&d) {
                    w.sync()?;
                    closed.push(w.path().to_path_buf());
                }
            }
        }
        let mut n = 0;
        for p in closed {
            let r = if p.extension().and_then(|e| e.to_str()) == Some(Kind::Trades.ext()) {
                crate::file::compact::<TradeRec>(&p)
            } else {
                crate::file::compact::<DepthRec>(&p)
            };
            n += u32::from(r.unwrap_or(false));
        }
        Ok(n)
    }

    /// Stops recording an instrument: closes the coverage interval, syncs and closes its files.
    pub fn close(&mut self, instrument: &str) -> Result<(), StoreError> {
        self.on_break(instrument);
        self.persist_coverage()?;
        if let Some(mut st) = self.insts.remove(instrument) {
            for w in st.trades.values_mut() {
                w.sync()?;
            }
            for w in st.depth.values_mut() {
                w.sync()?;
            }
        }
        Ok(())
    }

    pub fn close_all(&mut self) -> Result<(), StoreError> {
        let ids: Vec<String> = self.insts.keys().cloned().collect();
        for id in ids {
            self.close(&id)?;
        }
        Ok(())
    }

    /// Periodic work (call often, e.g. every 100–250 ms): flush every 1 s, fsync every 10 s,
    /// close + compact yesterday's files after the day rolls (1 min grace for late trades),
    /// and enforce retention / max-disk limits.
    pub fn maintain(&mut self, now: Instant, now_ns: i64) -> Result<(), StoreError> {
        if now.duration_since(self.last_sync) >= self.cfg.fsync_every {
            self.sync_all()?;
            self.last_sync = now;
            self.last_flush = now;
        } else if now.duration_since(self.last_flush) >= self.cfg.flush_every {
            self.flush_all()?;
            self.last_flush = now;
        }
        let keep_from = day_of(now_ns - 60_000_000_000);
        if self
            .insts
            .values()
            .any(|s| s.trades.keys().chain(s.depth.keys()).any(|d| *d < keep_from))
        {
            self.close_days_before(keep_from)?;
        }
        let due = self
            .last_retention
            .is_none_or(|t| now.duration_since(t) >= self.cfg.retention_every);
        if due {
            self.last_retention = Some(now);
            self.enforce_retention(now_ns)?;
        }
        Ok(())
    }

    pub fn enforce_retention(&mut self, now_ns: i64) -> Result<RetentionReport, StoreError> {
        let open = self.open_files();
        let rep = self
            .store
            .enforce_retention(self.cfg.limits, day_of(now_ns), &open)?;
        if rep.files_deleted > 0 {
            tracing::info!(files = rep.files_deleted, bytes = rep.bytes_freed, "tick-store retention");
        }
        Ok(rep)
    }

    /// Deletes stored days of an instrument (closing its writers first).
    pub fn delete(
        &mut self,
        instrument: &str,
        from_day: Option<Day>,
        to_day: Option<Day>,
    ) -> Result<RetentionReport, StoreError> {
        let was_active = self.insts.contains_key(instrument);
        self.close(instrument)?;
        let rep = self
            .store
            .delete(instrument, from_day, to_day, &HashSet::new())?;
        if was_active {
            tracing::info!(instrument, "recording continues in new files after delete");
        }
        Ok(rep)
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        if let Err(e) = self.close_all() {
            tracing::warn!(error = %e, "tick-store: close on drop failed");
        }
    }
}

/// Rebuilds the full book at the end of `rows` (full snapshots + deltas; top-N rows ignored).
pub fn replay_book(rows: &[DepthRec]) -> BookSnapshot {
    let mut bids: BTreeMap<i64, f64> = BTreeMap::new();
    let mut asks: BTreeMap<i64, f64> = BTreeMap::new();
    let mut ts = 0;
    for r in rows {
        if r.flags & depth_flags::TOP != 0 {
            continue;
        }
        if r.flags & depth_flags::RESET != 0 {
            bids.clear();
            asks.clear();
        }
        let side = if r.is_ask() { &mut asks } else { &mut bids };
        if r.qty > 0.0 {
            side.insert(r.px, r.qty);
        } else {
            side.remove(&r.px);
        }
        ts = r.ts_ns;
    }
    BookSnapshot {
        ts_ns: ts,
        bids: bids.into_iter().rev().collect(),
        asks: asks.into_iter().collect(),
    }
}

/// Groups the sampled top-of-book rows into snapshots (for heatmap history).
pub fn top_snapshots(rows: &[DepthRec]) -> Vec<BookSnapshot> {
    let mut out: Vec<BookSnapshot> = Vec::new();
    for r in rows.iter().filter(|r| r.flags & depth_flags::TOP != 0) {
        if out.last().is_none_or(|s| s.ts_ns != r.ts_ns) {
            out.push(BookSnapshot {
                ts_ns: r.ts_ns,
                bids: Vec::new(),
                asks: Vec::new(),
            });
        }
        let s = out.last_mut().expect("pushed");
        if r.is_ask() {
            s.asks.push((r.px, r.qty));
        } else {
            s.bids.push((r.px, r.qty));
        }
    }
    out
}
