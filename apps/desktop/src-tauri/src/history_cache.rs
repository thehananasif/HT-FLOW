//! Size-capped on-disk cache of downloaded history (Settings → Data → Cache size).
//!
//! Lives under `<data root>/cache/history/<venue>/<SYMBOL>/`. One file per closed chunk:
//! `t-<start_ms>.bin` (one hour of REST trades) or `k<interval_ms>-<start_ms>.bin` (klines).
//! Only complete chunks that ended in the past are stored, so a hit never needs a refresh.
//! Eviction is least-recently-used: every hit touches the file's modification time (which also
//! restores the LRU order after a restart) and every write evicts the oldest files until the
//! total is under the cap.
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use htflow_connector_common::Kline;
use htflow_core_types::{Aggressor, Trade};
use serde::Serialize;

const TRADE_MAGIC: &[u8; 4] = b"HTT1";
const KLINE_MAGIC: &[u8; 4] = b"HTK1";
const TRADE_LEN: usize = 33;
const KLINE_LEN: usize = 64;

#[derive(Debug, Clone, Copy)]
struct Entry {
    size: u64,
    used: SystemTime,
}

#[derive(Debug, Default, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub bytes: u64,
    pub files: usize,
    pub max_bytes: u64,
    pub hits: u64,
    pub misses: u64,
    pub evicted: u64,
}

struct Inner {
    entries: HashMap<PathBuf, Entry>,
    total: u64,
    max: u64,
    stats: CacheStats,
}

pub struct HistoryCache {
    root: PathBuf,
    inner: Mutex<Inner>,
}

fn safe(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn scan(dir: &Path, out: &mut HashMap<PathBuf, Entry>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(md) = e.metadata() else { continue };
        if md.is_dir() {
            scan(&p, out);
        } else if p.extension().is_some_and(|x| x == "bin") {
            out.insert(
                p,
                Entry {
                    size: md.len(),
                    used: md.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                },
            );
        } else if p.extension().is_some_and(|x| x == "tmp") {
            let _ = fs::remove_file(&p); // interrupted write
        }
    }
}

impl HistoryCache {
    /// Opens (creating) the cache at `root` with a cap of `max_bytes`.
    pub fn open(root: impl Into<PathBuf>, max_bytes: u64) -> Self {
        let root = root.into();
        let _ = fs::create_dir_all(&root);
        let mut entries = HashMap::new();
        scan(&root, &mut entries);
        let total = entries.values().map(|e| e.size).sum();
        let me = Self {
            root,
            inner: Mutex::new(Inner {
                entries,
                total,
                max: max_bytes,
                stats: CacheStats::default(),
            }),
        };
        me.evict();
        me
    }

    #[cfg(test)]
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn path(&self, instrument: &str, name: &str) -> PathBuf {
        let (venue, sym) = instrument.split_once(':').unwrap_or(("misc", instrument));
        self.root.join(safe(venue)).join(safe(sym)).join(name)
    }

    pub fn set_max_bytes(&self, max: u64) -> CacheStats {
        self.inner.lock().expect("cache").max = max;
        self.evict();
        self.stats()
    }

    pub fn stats(&self) -> CacheStats {
        let i = self.inner.lock().expect("cache");
        CacheStats {
            bytes: i.total,
            files: i.entries.len(),
            max_bytes: i.max,
            ..i.stats
        }
    }

    pub fn clear(&self) -> CacheStats {
        {
            let mut i = self.inner.lock().expect("cache");
            for p in i.entries.keys() {
                let _ = fs::remove_file(p);
            }
            i.entries.clear();
            i.total = 0;
        }
        self.stats()
    }

    fn evict(&self) {
        let mut i = self.inner.lock().expect("cache");
        if i.total <= i.max {
            return;
        }
        let mut order: Vec<(PathBuf, Entry)> =
            i.entries.iter().map(|(p, e)| (p.clone(), *e)).collect();
        order.sort_by_key(|(_, e)| e.used);
        for (p, e) in order {
            if i.total <= i.max {
                break;
            }
            let _ = fs::remove_file(&p);
            i.entries.remove(&p);
            i.total = i.total.saturating_sub(e.size);
            i.stats.evicted += 1;
        }
    }

    fn read(&self, path: &Path, magic: &[u8; 4]) -> Option<Vec<u8>> {
        let hit = self.inner.lock().expect("cache").entries.contains_key(path);
        let bytes = if hit { fs::read(path).ok() } else { None };
        let mut i = self.inner.lock().expect("cache");
        match bytes {
            Some(b) if b.len() >= 4 && &b[..4] == magic => {
                let now = SystemTime::now();
                if let Some(e) = i.entries.get_mut(path) {
                    e.used = now;
                }
                i.stats.hits += 1;
                drop(i);
                if let Ok(f) = fs::File::options().write(true).open(path) {
                    let _ = f.set_modified(now);
                }
                Some(b)
            }
            _ => {
                i.stats.misses += 1;
                None
            }
        }
    }

    fn write(&self, path: PathBuf, data: Vec<u8>) {
        if let Some(dir) = path.parent() {
            if fs::create_dir_all(dir).is_err() {
                return;
            }
        }
        let tmp = path.with_extension("tmp");
        if fs::write(&tmp, &data).is_err() || fs::rename(&tmp, &path).is_err() {
            let _ = fs::remove_file(&tmp);
            return;
        }
        {
            let mut i = self.inner.lock().expect("cache");
            let size = data.len() as u64;
            if let Some(old) = i.entries.insert(
                path,
                Entry {
                    size,
                    used: SystemTime::now(),
                },
            ) {
                i.total = i.total.saturating_sub(old.size);
            }
            i.total += size;
        }
        self.evict();
    }

    // ---------------------------------------------------------------- trades

    pub fn get_trades(&self, instrument: &str, start_ms: i64) -> Option<Vec<Trade>> {
        let b = self.read(
            &self.path(instrument, &format!("t-{start_ms}.bin")),
            TRADE_MAGIC,
        )?;
        let mut out = Vec::with_capacity((b.len() - 4) / TRADE_LEN);
        for r in b[4..].as_chunks::<TRADE_LEN>().0 {
            let i64_at = |o: usize| i64::from_le_bytes(r[o..o + 8].try_into().expect("8"));
            let ts = i64_at(0);
            out.push(Trade {
                exchange_ts_ns: ts,
                local_ts_ns: ts,
                px: i64_at(8),
                qty: f64::from_le_bytes(r[16..24].try_into().expect("8")),
                aggressor: match r[24] as i8 {
                    1 => Aggressor::Buy,
                    -1 => Aggressor::Sell,
                    _ => Aggressor::Unknown,
                },
                trade_id: u64::from_le_bytes(r[25..33].try_into().expect("8")),
            });
        }
        Some(out)
    }

    pub fn put_trades(&self, instrument: &str, start_ms: i64, trades: &[Trade]) {
        let mut b = Vec::with_capacity(4 + trades.len() * TRADE_LEN);
        b.extend_from_slice(TRADE_MAGIC);
        for t in trades {
            b.extend_from_slice(&t.exchange_ts_ns.to_le_bytes());
            b.extend_from_slice(&t.px.to_le_bytes());
            b.extend_from_slice(&t.qty.to_le_bytes());
            b.push(t.aggressor.as_i8() as u8);
            b.extend_from_slice(&t.trade_id.to_le_bytes());
        }
        self.write(self.path(instrument, &format!("t-{start_ms}.bin")), b);
    }

    // ---------------------------------------------------------------- klines

    pub fn get_klines(
        &self,
        instrument: &str,
        interval_ms: i64,
        start_ms: i64,
    ) -> Option<Vec<Kline>> {
        let b = self.read(
            &self.path(instrument, &format!("k{interval_ms}-{start_ms}.bin")),
            KLINE_MAGIC,
        )?;
        let mut out = Vec::with_capacity((b.len() - 4) / KLINE_LEN);
        for r in b[4..].as_chunks::<KLINE_LEN>().0 {
            let i = |o: usize| i64::from_le_bytes(r[o..o + 8].try_into().expect("8"));
            let f = |o: usize| f64::from_le_bytes(r[o..o + 8].try_into().expect("8"));
            let tb = f(56);
            out.push(Kline {
                open_ms: i(0),
                span_ms: interval_ms,
                open: i(8),
                high: i(16),
                low: i(24),
                close: i(32),
                volume: f(40),
                taker_buy: (!tb.is_nan()).then_some(tb),
            });
            let _ = f(48); // reserved
        }
        Some(out)
    }

    pub fn put_klines(&self, instrument: &str, interval_ms: i64, start_ms: i64, k: &[Kline]) {
        let mut b = Vec::with_capacity(4 + k.len() * KLINE_LEN);
        b.extend_from_slice(KLINE_MAGIC);
        for x in k {
            for v in [x.open_ms, x.open, x.high, x.low, x.close] {
                b.extend_from_slice(&v.to_le_bytes());
            }
            b.extend_from_slice(&x.volume.to_le_bytes());
            b.extend_from_slice(&0f64.to_le_bytes());
            b.extend_from_slice(&x.taker_buy.unwrap_or(f64::NAN).to_le_bytes());
        }
        self.write(
            self.path(instrument, &format!("k{interval_ms}-{start_ms}.bin")),
            b,
        );
    }
}

/// Tauri state: the app-wide history cache.
pub struct CacheState(pub std::sync::Arc<HistoryCache>);

/// Default cap until the UI applies Settings → Data → Cache size (same default, 512 MB).
pub const DEFAULT_MAX_MB: u32 = 512;

/// Settings → Data → Cache size (64 MB … 64 GB); evicts at once when shrinking.
#[tauri::command]
pub fn history_cache_set(state: tauri::State<'_, CacheState>, max_mb: u32) -> CacheStats {
    let mb = u64::from(max_mb.clamp(64, 65_536));
    state.0.set_max_bytes(mb * 1024 * 1024)
}

#[tauri::command]
pub fn history_cache_status(state: tauri::State<'_, CacheState>) -> CacheStats {
    state.0.stats()
}

#[tauri::command]
pub fn history_cache_clear(state: tauri::State<'_, CacheState>) -> CacheStats {
    state.0.clear()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("htflow-cache-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        p
    }

    fn trades(n: usize) -> Vec<Trade> {
        (0..n)
            .map(|i| Trade {
                exchange_ts_ns: i as i64 * 1_000_000,
                local_ts_ns: i as i64 * 1_000_000,
                px: 100 + i as i64,
                qty: 0.5,
                aggressor: if i % 2 == 0 {
                    Aggressor::Buy
                } else {
                    Aggressor::Sell
                },
                trade_id: i as u64 + 1,
            })
            .collect()
    }

    #[test]
    fn round_trips_and_evicts_least_recently_used() {
        let root = tmp("lru");
        // Each 10-trade file is 4 + 330 = 334 bytes; the cap holds two.
        let c = HistoryCache::open(&root, 700);
        let t = trades(10);
        c.put_trades("binance-futures:BTCUSDT", 0, &t);
        assert_eq!(c.get_trades("binance-futures:BTCUSDT", 0).unwrap(), t);
        assert!(c.get_trades("binance-futures:BTCUSDT", 1).is_none());
        let k = vec![Kline {
            open_ms: 60_000,
            span_ms: 60_000,
            open: 1,
            high: 3,
            low: 0,
            close: 2,
            volume: 4.0,
            taker_buy: None,
        }];
        let kc = HistoryCache::open(tmp("klines"), 1 << 20);
        kc.put_klines("binance-spot:ETHUSDT", 60_000, 0, &k);
        assert_eq!(kc.get_klines("binance-spot:ETHUSDT", 60_000, 0).unwrap(), k);
        let _ = fs::remove_dir_all(kc.root());
        std::thread::sleep(std::time::Duration::from_millis(20));
        // Touch chunk 0 so chunk 3600000 is the oldest, then overflow the cap.
        c.put_trades("binance-futures:BTCUSDT", 3_600_000, &t);
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert!(c.get_trades("binance-futures:BTCUSDT", 0).is_some());
        std::thread::sleep(std::time::Duration::from_millis(20));
        c.put_trades("binance-futures:BTCUSDT", 7_200_000, &t);
        let s = c.stats();
        assert!(s.bytes <= 700, "{s:?}");
        assert!(s.evicted >= 1);
        assert!(c.get_trades("binance-futures:BTCUSDT", 0).is_some());
        assert!(c.get_trades("binance-futures:BTCUSDT", 7_200_000).is_some());
        assert!(c.get_trades("binance-futures:BTCUSDT", 3_600_000).is_none());

        // Reopen: index rebuilt from disk; a smaller cap evicts at once.
        let c2 = HistoryCache::open(&root, 400);
        assert_eq!(c2.stats().files, 1);
        assert!(c2
            .get_trades("binance-futures:BTCUSDT", 7_200_000)
            .is_some());
        assert_eq!(c2.set_max_bytes(0).files, 0);
        let _ = fs::remove_dir_all(&root);
    }
}
