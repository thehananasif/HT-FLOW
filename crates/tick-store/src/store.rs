//! Directory layout, range reads, listing, deletion, CSV export and retention.
//!
//! ```text
//! <root>/<venue>/<SYMBOL>/meta.json          {"instrument": "binance-futures:BTCUSDT"}
//! <root>/<venue>/<SYMBOL>/coverage.json      covered time ranges (see coverage.rs)
//! <root>/<venue>/<SYMBOL>/YYYY-MM-DD.trd     trades   (+ .trd.idx)
//! <root>/<venue>/<SYMBOL>/YYYY-MM-DD.dep     depth    (+ .dep.idx)
//! ```
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use htflow_core_types::{Aggressor, TickSize};
use serde::{Deserialize, Serialize};

use crate::codec::{depth_flags, DepthRec, Kind, Record, TradeRec};
use crate::coverage::Coverage;
use crate::day::{day_name, day_of, day_start_ns, iso_utc, parse_day, Day, NS_PER_DAY};
use crate::file::{self, index_path, load_index};
use crate::StoreError;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreLimits {
    /// Keep this many days (today included). 0 = keep forever.
    pub retention_days: u32,
    /// Delete the oldest days once the store is larger than this. 0 = unlimited.
    pub max_disk_bytes: u64,
}

impl Default for StoreLimits {
    fn default() -> Self {
        Self {
            retention_days: 30,
            max_disk_bytes: 20 * 1024 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaySummary {
    pub date: String,
    pub day: Day,
    pub trade_bytes: u64,
    pub depth_bytes: u64,
    pub trades: u64,
    pub depth_records: u64,
    /// ms since epoch of the first / last record of the day (0 when empty).
    pub first_ms: i64,
    pub last_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentSummary {
    pub instrument: String,
    pub venue: String,
    pub symbol: String,
    pub days: Vec<DaySummary>,
    pub bytes: u64,
    pub trades: u64,
    pub depth_records: u64,
    pub first_ms: i64,
    pub last_ms: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionReport {
    pub files_deleted: u32,
    pub bytes_freed: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct Meta {
    instrument: String,
}

/// Splits `venue:SYMBOL` and maps it to a safe relative directory.
pub fn instrument_dir(instrument: &str) -> Result<PathBuf, StoreError> {
    let (venue, symbol) = instrument
        .split_once(':')
        .ok_or_else(|| StoreError::BadInstrument(instrument.into()))?;
    let clean = |s: &str| -> Result<String, StoreError> {
        let c: String = s
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                    ch
                } else {
                    '_'
                }
            })
            .collect();
        if c.is_empty() || c.chars().all(|ch| ch == '.') {
            return Err(StoreError::BadInstrument(instrument.into()));
        }
        Ok(c)
    };
    Ok(PathBuf::from(clean(venue)?).join(clean(symbol)?))
}

/// Handle to the tick store root. Cheap to clone; reads need no lock (files are append-only
/// and readers ignore a torn tail). Writes go through [`crate::Recorder`].
#[derive(Debug, Clone)]
pub struct TickStore {
    root: PathBuf,
}

impl TickStore {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn dir(&self, instrument: &str) -> Result<PathBuf, StoreError> {
        Ok(self.root.join(instrument_dir(instrument)?))
    }

    pub fn day_path(&self, instrument: &str, kind: Kind, day: Day) -> Result<PathBuf, StoreError> {
        Ok(self
            .dir(instrument)?
            .join(format!("{}.{}", day_name(day), kind.ext())))
    }

    /// Records the instrument id next to its files (directory names are sanitised).
    pub(crate) fn ensure_meta(&self, instrument: &str) -> Result<(), StoreError> {
        let dir = self.dir(instrument)?;
        let p = dir.join("meta.json");
        if !p.exists() {
            fs::create_dir_all(&dir)?;
            fs::write(
                &p,
                serde_json::to_vec(&Meta {
                    instrument: instrument.to_string(),
                })?,
            )?;
        }
        Ok(())
    }

    /// Day files of one kind for an instrument, sorted by day.
    fn day_files(&self, dir: &Path, kind: Kind) -> Vec<(Day, PathBuf)> {
        let mut out = Vec::new();
        let Ok(rd) = fs::read_dir(dir) else {
            return out;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some(kind.ext()) {
                continue;
            }
            if let Some(day) = p.file_stem().and_then(|s| s.to_str()).and_then(parse_day) {
                out.push((day, p));
            }
        }
        out.sort();
        out
    }

    fn read_kind<R: Record>(
        &self,
        instrument: &str,
        from_ns: i64,
        to_ns: i64,
        tick: Option<TickSize>,
    ) -> Result<(Vec<R>, Option<TickSize>), StoreError> {
        let dir = self.dir(instrument)?;
        let (d0, d1) = (day_of(from_ns), day_of(to_ns.saturating_sub(1)));
        let files: Vec<(Day, PathBuf)> = self
            .day_files(&dir, R::KIND)
            .into_iter()
            .filter(|(d, _)| *d >= d0 && *d <= d1)
            .collect();
        // Prices come back in the tick size of the newest file unless one is requested.
        let mut target = tick;
        let mut indexes = Vec::with_capacity(files.len());
        for (_, p) in &files {
            match load_index(p) {
                Ok(idx) => indexes.push((p, idx)),
                Err(e) => {
                    tracing::warn!(file = %p.display(), error = %e, "tick-store: unreadable day file skipped")
                }
            }
        }
        if target.is_none() {
            target = indexes.last().map(|(_, i)| i.header.tick);
        }
        let mut out = Vec::new();
        for (p, idx) in &indexes {
            file::read_range(p, idx, from_ns, to_ns, target, &mut out)?;
        }
        Ok((out, target))
    }

    /// Trades with `from_ns <= ts < to_ns`, sorted by time, duplicates removed. Also returns the
    /// tick size the prices are expressed in (the requested one, else the newest file's).
    pub fn read_trades(
        &self,
        instrument: &str,
        from_ns: i64,
        to_ns: i64,
        tick: Option<TickSize>,
    ) -> Result<(Vec<TradeRec>, Option<TickSize>), StoreError> {
        let (mut v, t) = self.read_kind::<TradeRec>(instrument, from_ns, to_ns, tick)?;
        v.sort_by_key(|r| (r.ts_ns, r.trade_id));
        v.dedup_by(|a, b| a.ts_ns == b.ts_ns && a.trade_id == b.trade_id && a.px == b.px);
        Ok((v, t))
    }

    /// Depth rows with `from_ns <= ts < to_ns`, in write order (stable by time).
    pub fn read_depth(
        &self,
        instrument: &str,
        from_ns: i64,
        to_ns: i64,
        tick: Option<TickSize>,
    ) -> Result<(Vec<DepthRec>, Option<TickSize>), StoreError> {
        let (mut v, t) = self.read_kind::<DepthRec>(instrument, from_ns, to_ns, tick)?;
        v.sort_by_key(|r| r.ts_ns);
        Ok((v, t))
    }

    pub fn coverage(&self, instrument: &str) -> Result<Coverage, StoreError> {
        let p = self.dir(instrument)?.join("coverage.json");
        match fs::read(&p) {
            Ok(b) => Ok(serde_json::from_slice(&b).unwrap_or_default()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Coverage::default()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn save_coverage(&self, instrument: &str, c: &Coverage) -> Result<(), StoreError> {
        let dir = self.dir(instrument)?;
        fs::create_dir_all(&dir)?;
        let tmp = dir.join("coverage.json.tmp");
        fs::write(&tmp, serde_json::to_vec(c)?)?;
        fs::rename(tmp, dir.join("coverage.json"))?;
        Ok(())
    }

    fn instrument_dirs(&self) -> Vec<(String, PathBuf)> {
        let mut out = Vec::new();
        let Ok(venues) = fs::read_dir(&self.root) else {
            return out;
        };
        for v in venues.flatten() {
            if !v.path().is_dir() {
                continue;
            }
            let Ok(syms) = fs::read_dir(v.path()) else {
                continue;
            };
            for s in syms.flatten() {
                let p = s.path();
                if !p.is_dir() {
                    continue;
                }
                let id = fs::read(p.join("meta.json"))
                    .ok()
                    .and_then(|b| serde_json::from_slice::<Meta>(&b).ok())
                    .map(|m| m.instrument)
                    .unwrap_or_else(|| {
                        format!(
                            "{}:{}",
                            v.file_name().to_string_lossy(),
                            s.file_name().to_string_lossy()
                        )
                    });
                out.push((id, p));
            }
        }
        out.sort();
        out
    }

    /// Instruments stored, their days, record counts and size on disk.
    pub fn list(&self) -> Vec<InstrumentSummary> {
        let mut out = Vec::new();
        for (id, dir) in self.instrument_dirs() {
            let mut days: std::collections::BTreeMap<Day, DaySummary> = Default::default();
            for kind in [Kind::Trades, Kind::Depth] {
                for (day, p) in self.day_files(&dir, kind) {
                    let bytes = fs::metadata(&p).map(|m| m.len()).unwrap_or(0)
                        + fs::metadata(index_path(&p)).map(|m| m.len()).unwrap_or(0);
                    let (n, range) = load_index(&p)
                        .map(|i| (i.records(), i.time_range()))
                        .unwrap_or((0, None));
                    let e = days.entry(day).or_insert_with(|| DaySummary {
                        date: day_name(day),
                        day,
                        trade_bytes: 0,
                        depth_bytes: 0,
                        trades: 0,
                        depth_records: 0,
                        first_ms: 0,
                        last_ms: 0,
                    });
                    match kind {
                        Kind::Trades => {
                            e.trade_bytes += bytes;
                            e.trades += n;
                        }
                        Kind::Depth => {
                            e.depth_bytes += bytes;
                            e.depth_records += n;
                        }
                    }
                    if let Some((a, b)) = range {
                        let (a, b) = (a / 1_000_000, b / 1_000_000);
                        e.first_ms = if e.first_ms == 0 {
                            a
                        } else {
                            e.first_ms.min(a)
                        };
                        e.last_ms = e.last_ms.max(b);
                    }
                }
            }
            if days.is_empty() {
                continue;
            }
            let days: Vec<DaySummary> = days.into_values().collect();
            let (venue, symbol) = id.split_once(':').unwrap_or((&id, ""));
            out.push(InstrumentSummary {
                venue: venue.to_string(),
                symbol: symbol.to_string(),
                bytes: days.iter().map(|d| d.trade_bytes + d.depth_bytes).sum(),
                trades: days.iter().map(|d| d.trades).sum(),
                depth_records: days.iter().map(|d| d.depth_records).sum(),
                first_ms: days
                    .iter()
                    .map(|d| d.first_ms)
                    .filter(|v| *v > 0)
                    .min()
                    .unwrap_or(0),
                last_ms: days.iter().map(|d| d.last_ms).max().unwrap_or(0),
                instrument: id,
                days,
            });
        }
        out
    }

    /// Total bytes of all day files and indexes.
    pub fn disk_usage(&self) -> u64 {
        self.list().iter().map(|i| i.bytes).sum()
    }

    fn remove_day_file(&self, p: &Path) -> u64 {
        let mut freed = 0;
        for f in [p.to_path_buf(), index_path(p)] {
            if let Ok(m) = fs::metadata(&f) {
                if fs::remove_file(&f).is_ok() {
                    freed += m.len();
                }
            }
        }
        freed
    }

    /// Deletes the days `[from_day, to_day]` (both optional) of an instrument, skipping files in
    /// `open` (being written). Returns bytes freed.
    pub fn delete(
        &self,
        instrument: &str,
        from_day: Option<Day>,
        to_day: Option<Day>,
        open: &HashSet<PathBuf>,
    ) -> Result<RetentionReport, StoreError> {
        let dir = self.dir(instrument)?;
        let mut rep = RetentionReport::default();
        let lo = from_day.unwrap_or(Day::MIN);
        let hi = to_day.unwrap_or(Day::MAX);
        for kind in [Kind::Trades, Kind::Depth] {
            for (day, p) in self.day_files(&dir, kind) {
                if day < lo || day > hi || open.contains(&p) {
                    continue;
                }
                rep.bytes_freed += self.remove_day_file(&p);
                rep.files_deleted += 1;
            }
        }
        let mut cov = self.coverage(instrument)?;
        cov.remove(
            from_day.map_or(i64::MIN, day_start_ns),
            to_day.map_or(i64::MAX, |d| day_start_ns(d) + NS_PER_DAY),
        );
        self.cleanup_dir(&dir, instrument, &cov)?;
        Ok(rep)
    }

    /// Saves the trimmed coverage, or removes the directory when no day files remain.
    fn cleanup_dir(&self, dir: &Path, instrument: &str, cov: &Coverage) -> Result<(), StoreError> {
        let has_files = !self.day_files(dir, Kind::Trades).is_empty()
            || !self.day_files(dir, Kind::Depth).is_empty();
        if has_files {
            self.save_coverage(instrument, cov)?;
        } else if dir.exists() {
            fs::remove_dir_all(dir)?;
            if let Some(parent) = dir.parent() {
                if fs::read_dir(parent).is_ok_and(|mut r| r.next().is_none()) {
                    let _ = fs::remove_dir(parent);
                }
            }
        }
        Ok(())
    }

    /// Retention (stage 5): drops days older than `retention_days`, then the oldest days until
    /// the store fits in `max_disk_bytes`. Files in `open` are never touched.
    pub fn enforce_retention(
        &self,
        limits: StoreLimits,
        today: Day,
        open: &HashSet<PathBuf>,
    ) -> Result<RetentionReport, StoreError> {
        let mut rep = RetentionReport::default();
        // (day, instrument, path, bytes) for every day file.
        let mut all: Vec<(Day, String, PathBuf, u64)> = Vec::new();
        for (id, dir) in self.instrument_dirs() {
            for kind in [Kind::Trades, Kind::Depth] {
                for (day, p) in self.day_files(&dir, kind) {
                    let bytes = fs::metadata(&p).map(|m| m.len()).unwrap_or(0)
                        + fs::metadata(index_path(&p)).map(|m| m.len()).unwrap_or(0);
                    all.push((day, id.clone(), p, bytes));
                }
            }
        }
        all.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        let mut total: u64 = all.iter().map(|x| x.3).sum();
        let oldest_kept = if limits.retention_days == 0 {
            Day::MIN
        } else {
            today - limits.retention_days as Day + 1
        };
        let mut touched: HashSet<String> = HashSet::new();
        for (day, id, p, bytes) in &all {
            let too_old = *day < oldest_kept;
            let too_big = limits.max_disk_bytes > 0 && total > limits.max_disk_bytes;
            if !(too_old || too_big) || open.contains(p) {
                continue;
            }
            rep.bytes_freed += self.remove_day_file(p);
            rep.files_deleted += 1;
            total = total.saturating_sub(*bytes);
            touched.insert(id.clone());
        }
        for id in touched {
            let dir = self.dir(&id)?;
            let mut cov = self.coverage(&id)?;
            // Coverage only where day files remain.
            let remaining: HashSet<Day> = self
                .day_files(&dir, Kind::Trades)
                .into_iter()
                .map(|(d, _)| d)
                .collect();
            let days: Vec<Day> = cov
                .intervals
                .iter()
                .flat_map(|&(a, b)| day_of(a)..=day_of(b.saturating_sub(1)))
                .collect();
            for d in days {
                if !remaining.contains(&d) {
                    cov.remove(day_start_ns(d), day_start_ns(d) + NS_PER_DAY);
                }
            }
            self.cleanup_dir(&dir, &id, &cov)?;
        }
        Ok(rep)
    }

    /// Compacts every closed day file (day < `today`) that is not open. Returns files rewritten.
    pub fn compact_closed(&self, today: Day, open: &HashSet<PathBuf>) -> u32 {
        let mut n = 0;
        for (_, dir) in self.instrument_dirs() {
            for (day, p) in self.day_files(&dir, Kind::Trades) {
                if day < today && !open.contains(&p) {
                    n += u32::from(file::compact::<TradeRec>(&p).unwrap_or(false));
                }
            }
            for (day, p) in self.day_files(&dir, Kind::Depth) {
                if day < today && !open.contains(&p) {
                    n += u32::from(file::compact::<DepthRec>(&p).unwrap_or(false));
                }
            }
        }
        n
    }

    /// Writes `[from_ns, to_ns)` of one stream as CSV, one day at a time. Returns rows written.
    pub fn export_csv(
        &self,
        instrument: &str,
        kind: Kind,
        from_ns: i64,
        to_ns: i64,
        out: &mut impl Write,
    ) -> Result<u64, StoreError> {
        let dir = self.dir(instrument)?;
        let files = self.day_files(&dir, kind);
        let mut rows = 0u64;
        match kind {
            Kind::Trades => writeln!(out, "ts_ns,time_utc,price,qty,side,trade_id")?,
            Kind::Depth => writeln!(out, "ts_ns,time_utc,type,side,price,qty")?,
        }
        for (day, p) in files {
            let ds = day_start_ns(day);
            let (a, b) = (from_ns.max(ds), to_ns.min(ds + NS_PER_DAY));
            if a >= b {
                continue;
            }
            let idx = load_index(&p)?;
            let tick = idx.header.tick;
            match kind {
                Kind::Trades => {
                    let mut v: Vec<TradeRec> = Vec::new();
                    file::read_range(&p, &idx, a, b, None, &mut v)?;
                    v.sort_by_key(|r| (r.ts_ns, r.trade_id));
                    for r in v {
                        let side = match r.aggressor {
                            Aggressor::Buy => "buy",
                            Aggressor::Sell => "sell",
                            Aggressor::Unknown => "unknown",
                        };
                        writeln!(
                            out,
                            "{},{},{},{},{},{}",
                            r.ts_ns,
                            iso_utc(r.ts_ns),
                            format_price(r.px, tick),
                            r.qty,
                            side,
                            r.trade_id
                        )?;
                        rows += 1;
                    }
                }
                Kind::Depth => {
                    let mut v: Vec<DepthRec> = Vec::new();
                    file::read_range(&p, &idx, a, b, None, &mut v)?;
                    v.sort_by_key(|r| r.ts_ns);
                    for r in v {
                        let ty = if r.flags & depth_flags::TOP != 0 {
                            "top"
                        } else if r.flags & depth_flags::RESET != 0 {
                            "snapshot_start"
                        } else if r.flags & depth_flags::SNAPSHOT != 0 {
                            "snapshot"
                        } else {
                            "delta"
                        };
                        writeln!(
                            out,
                            "{},{},{},{},{},{}",
                            r.ts_ns,
                            iso_utc(r.ts_ns),
                            ty,
                            if r.is_ask() { "ask" } else { "bid" },
                            format_price(r.px, tick),
                            r.qty
                        )?;
                        rows += 1;
                    }
                }
            }
        }
        out.flush()?;
        Ok(rows)
    }
}

/// Exact decimal price from ticks, e.g. 681234 at tick 0.1 → "68123.4".
pub fn format_price(px: i64, tick: TickSize) -> String {
    let v = i128::from(px) * i128::from(tick.units);
    if tick.scale == 0 {
        return v.to_string();
    }
    let p = 10i128.pow(tick.scale);
    let sign = if v < 0 { "-" } else { "" };
    let a = v.abs();
    format!(
        "{sign}{}.{:0width$}",
        a / p,
        a % p,
        width = tick.scale as usize
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitises_instrument_dirs_and_formats_prices() {
        assert_eq!(
            instrument_dir("binance-futures:BTCUSDT").unwrap(),
            PathBuf::from("binance-futures").join("BTCUSDT")
        );
        assert_eq!(
            instrument_dir("okx-swap:BTC-USDT-SWAP").unwrap(),
            PathBuf::from("okx-swap").join("BTC-USDT-SWAP")
        );
        assert_eq!(
            instrument_dir("x:../../etc").unwrap(),
            PathBuf::from("x").join(".._.._etc")
        );
        assert!(instrument_dir("x:..").is_err());
        assert!(instrument_dir("nocolon").is_err());
        let t = TickSize::parse("0.1").unwrap();
        assert_eq!(format_price(681_234, t), "68123.4");
        assert_eq!(format_price(-5, t), "-0.5");
        assert_eq!(
            format_price(27_403, TickSize::parse("0.25").unwrap()),
            "6850.75"
        );
        assert_eq!(format_price(7, TickSize::parse("1").unwrap()), "7");
    }
}
