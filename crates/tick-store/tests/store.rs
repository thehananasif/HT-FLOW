use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::time::{Duration, Instant};

use htflow_core_types::{Aggressor, BookDelta, BookSnapshot, Side, TickSize, Trade};
use htflow_tick_store::file::{index_path, load_index, DayWriter};
use htflow_tick_store::*;

const DAY0: i64 = 20_396 * NS_PER_DAY; // 2025-11-04 00:00 UTC

fn tick() -> TickSize {
    TickSize::parse("0.1").unwrap()
}

fn trade(ts: i64, i: u64) -> Trade {
    Trade {
        exchange_ts_ns: ts,
        local_ts_ns: ts,
        px: 681_000 + (i % 50) as i64,
        qty: 0.001 * ((i % 13) + 1) as f64,
        aggressor: if i.is_multiple_of(2) {
            Aggressor::Buy
        } else {
            Aggressor::Sell
        },
        trade_id: 1_000_000 + i,
    }
}

fn recorder(dir: &std::path::Path) -> Recorder {
    Recorder::new(TickStore::open(dir).unwrap(), RecorderConfig::default())
}

#[test]
fn round_trip_trades_and_depth() {
    let dir = tempfile::tempdir().unwrap();
    let mut rec = recorder(dir.path());
    let id = "binance-futures:BTCUSDT";
    let trades: Vec<Trade> = (0..2_345)
        .map(|i| trade(DAY0 + i as i64 * 10_000_000, i))
        .collect();
    for chunk in trades.chunks(100) {
        rec.on_trades(id, tick(), chunk).unwrap();
        rec.flush_all().unwrap();
    }
    let snap = BookSnapshot {
        ts_ns: DAY0,
        bids: vec![(100, 1.0), (99, 2.0)],
        asks: vec![(101, 3.0)],
    };
    rec.on_snapshot(id, tick(), &snap).unwrap();
    rec.on_deltas(
        id,
        tick(),
        DAY0 + 1_000_000_000,
        &[
            BookDelta {
                side: Side::Buy,
                px: 100,
                qty: 0.0,
            },
            BookDelta {
                side: Side::Sell,
                px: 102,
                qty: 5.0,
            },
        ],
    )
    .unwrap();
    rec.sync_all().unwrap();

    let store = rec.store().clone();
    let (back, t) = store
        .read_trades(id, i64::MIN / 2, i64::MAX / 2, None)
        .unwrap();
    assert_eq!(t, Some(tick()));
    assert_eq!(back.len(), trades.len());
    for (a, b) in back.iter().zip(&trades) {
        assert_eq!(a.to_trade(), *b);
    }
    let (rows, _) = store.read_depth(id, DAY0, DAY0 + NS_PER_DAY, None).unwrap();
    let book = replay_book(&rows);
    assert_eq!(book.bids, vec![(99, 2.0)]);
    assert_eq!(book.asks, vec![(101, 3.0), (102, 5.0)]);
    // Top-of-book snapshots were sampled on the snapshot and after 250 ms.
    let tops = top_snapshots(&rows);
    assert_eq!(tops.len(), 2);
    assert_eq!(tops[1].asks, vec![(101, 3.0), (102, 5.0)]);

    // Listing + CSV export.
    let list = store.list();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].instrument, id);
    assert_eq!(list[0].trades, trades.len() as u64);
    assert_eq!(list[0].days[0].date, "2025-11-04");
    let mut csv = Vec::new();
    let n = store
        .export_csv(id, Kind::Trades, DAY0, DAY0 + 20_000_000, &mut csv)
        .unwrap();
    assert_eq!(n, 2);
    let text = String::from_utf8(csv).unwrap();
    assert_eq!(
        text.lines().nth(1).unwrap(),
        format!("{DAY0},2025-11-04T00:00:00.000Z,68100.0,0.001,buy,1000000")
    );
}

#[test]
fn range_seek_across_days_reads_only_needed_blocks() {
    let dir = tempfile::tempdir().unwrap();
    let mut rec = recorder(dir.path());
    let id = "bybit-linear:BTCUSDT";
    // 3 days, one trade per 10 s.
    let step = 10_000_000_000i64;
    let trades: Vec<Trade> = (0..(3 * 8640))
        .map(|i| trade(DAY0 + i as i64 * step, i as u64))
        .collect();
    rec.on_trades(id, tick(), &trades).unwrap();
    rec.sync_all().unwrap();
    let store = rec.store().clone();
    assert_eq!(store.list()[0].days.len(), 3);
    // From 23:00 on day 1 to 01:00 on day 3 → spans 3 files.
    let from = DAY0 + NS_PER_DAY - 3_600_000_000_000;
    let to = DAY0 + 2 * NS_PER_DAY + 3_600_000_000_000;
    let (got, _) = store.read_trades(id, from, to, None).unwrap();
    let want: Vec<&Trade> = trades
        .iter()
        .filter(|t| t.exchange_ts_ns >= from && t.exchange_ts_ns < to)
        .collect();
    assert_eq!(got.len(), want.len());
    assert_eq!(got.first().unwrap().ts_ns, want[0].exchange_ts_ns);
    assert_eq!(
        got.last().unwrap().ts_ns,
        want.last().unwrap().exchange_ts_ns
    );
    // The index allows a seek: only ~2 of the 9 blocks of day 1 overlap the last hour.
    let p = store.day_path(id, Kind::Trades, day_of(DAY0)).unwrap();
    let idx = load_index(&p).unwrap();
    let hit = idx
        .entries
        .iter()
        .filter(|e| e.max_ts >= from && e.min_ts < to)
        .count();
    assert!(hit <= 2, "{hit} blocks");
    assert_eq!(idx.entries[0].count as usize, BLOCK_RECORDS);
}

#[test]
fn crash_safety_truncated_last_block_is_ignored_and_repaired() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("2025-11-04.trd");
    let recs: Vec<TradeRec> = (0..1500)
        .map(|i| TradeRec::from(&trade(DAY0 + i, i as u64)))
        .collect();
    {
        let mut w = DayWriter::<TradeRec>::open(&p, tick(), day_of(DAY0)).unwrap();
        for r in &recs {
            w.push(*r, tick()).unwrap();
        }
        w.sync().unwrap();
    }
    let full_len = fs::metadata(&p).unwrap().len();
    // Simulate a crash mid-write of the second block: chop its tail and add junk.
    let f = OpenOptions::new().write(true).open(&p).unwrap();
    f.set_len(full_len - 7).unwrap();
    drop(f);
    let idx = load_index(&p).unwrap();
    assert_eq!(idx.records(), 1000, "torn block must be ignored");
    assert!(!idx.index_ok);
    // Reopen: the tail is truncated away, appends continue cleanly.
    {
        let mut w = DayWriter::<TradeRec>::open(&p, tick(), day_of(DAY0)).unwrap();
        w.push(recs[1499], tick()).unwrap();
        w.sync().unwrap();
    }
    let idx = load_index(&p).unwrap();
    assert!(idx.index_ok);
    assert_eq!(idx.records(), 1001);
    // A block appended to the data file without its index entry is found by scanning.
    let mut junk = OpenOptions::new().append(true).open(&p).unwrap();
    junk.write_all(&[0xAB; 20]).unwrap();
    let idx = load_index(&p).unwrap();
    assert_eq!(idx.records(), 1001);
    fs::remove_file(index_path(&p)).unwrap();
    assert_eq!(load_index(&p).unwrap().records(), 1001);
}

#[test]
fn compaction_merges_small_blocks() {
    let dir = tempfile::tempdir().unwrap();
    let mut rec = recorder(dir.path());
    let id = "okx-swap:BTC-USDT-SWAP";
    for s in 0..40 {
        let batch: Vec<Trade> = (0..60)
            .map(|i| trade(DAY0 + s * 1_000_000_000 + i * 1000, (s * 60 + i) as u64))
            .collect();
        rec.on_trades(id, tick(), &batch).unwrap();
        rec.flush_all().unwrap(); // one small block per "second"
    }
    let store = rec.store().clone();
    let p = store.day_path(id, Kind::Trades, day_of(DAY0)).unwrap();
    assert_eq!(load_index(&p).unwrap().entries.len(), 40);
    drop(rec); // closes writers
    assert_eq!(store.compact_closed(day_of(DAY0) + 1, &HashSet::new()), 1);
    let idx = load_index(&p).unwrap();
    assert_eq!(idx.entries.len(), 3);
    assert!(idx.is_compact());
    assert_eq!(
        store.read_trades(id, 0, i64::MAX, None).unwrap().0.len(),
        2400
    );
}

#[test]
fn retention_by_age_and_by_size() {
    let dir = tempfile::tempdir().unwrap();
    let mut rec = recorder(dir.path());
    let id = "binance-futures:ETHUSDT";
    for d in 0..5 {
        let batch: Vec<Trade> = (0..3000)
            .map(|i| trade(DAY0 + d * NS_PER_DAY + i * 1_000_000, i as u64))
            .collect();
        rec.on_trades(id, tick(), &batch).unwrap();
    }
    rec.close_all().unwrap();
    let store = rec.store().clone();
    let today = day_of(DAY0) + 4;
    let none = HashSet::new();
    let rep = store
        .enforce_retention(
            StoreLimits {
                retention_days: 3,
                max_disk_bytes: 0,
            },
            today,
            &none,
        )
        .unwrap();
    assert_eq!(rep.files_deleted, 2);
    let days: Vec<String> = store.list()[0]
        .days
        .iter()
        .map(|d| d.date.clone())
        .collect();
    assert_eq!(days, vec!["2025-11-06", "2025-11-07", "2025-11-08"]);
    // Size cap: keep only what fits, oldest first out.
    let per_day = store.list()[0].days[0].trade_bytes;
    store
        .enforce_retention(
            StoreLimits {
                retention_days: 0,
                max_disk_bytes: per_day + per_day / 2,
            },
            today,
            &none,
        )
        .unwrap();
    let days: Vec<String> = store.list()[0]
        .days
        .iter()
        .map(|d| d.date.clone())
        .collect();
    assert_eq!(days, vec!["2025-11-08"]);
    // Delete removes the instrument completely.
    store.delete(id, None, None, &none).unwrap();
    assert!(store.list().is_empty());
}

#[test]
fn coverage_tracks_connected_time_and_backfill() {
    let dir = tempfile::tempdir().unwrap();
    let mut rec = recorder(dir.path());
    let id = "binance-futures:BTCUSDT";
    rec.on_trades(id, tick(), &[trade(DAY0 + 100, 1)]).unwrap();
    rec.on_alive(id, DAY0 + 1_000);
    rec.on_break(id);
    rec.write_backfill(id, tick(), &[trade(DAY0 - 50, 0)], DAY0 - 500, DAY0 + 100)
        .unwrap();
    let c = rec.coverage(id).unwrap();
    assert_eq!(c.intervals, vec![(DAY0 - 500, DAY0 + 1_001)]);
    rec.sync_all().unwrap();
    assert_eq!(rec.store().coverage(id).unwrap(), c);
    assert_eq!(c.gaps(DAY0 - 1000, DAY0 + 2000, 0).len(), 2);
}

/// Throughput: write ~2 M trades (one busy BTCUSDT day), read them back and aggregate a 1-minute
/// footprint. Prints rates; asserts a conservative floor so CI on slow machines still passes.
#[test]
fn read_throughput() {
    let dir = tempfile::tempdir().unwrap();
    let id = "binance-futures:BTCUSDT";
    let n: u64 = 2_000_000;
    {
        let p = TickStore::open(dir.path())
            .unwrap()
            .day_path(id, Kind::Trades, day_of(DAY0))
            .unwrap();
        let mut w = DayWriter::<TradeRec>::open(&p, tick(), day_of(DAY0)).unwrap();
        let step = NS_PER_DAY / n as i64;
        for i in 0..n {
            w.push(TradeRec::from(&trade(DAY0 + i as i64 * step, i)), tick())
                .unwrap();
        }
        w.sync().unwrap();
    }
    let store = TickStore::open(dir.path()).unwrap();
    let t0 = Instant::now();
    let (v, _) = store
        .read_trades(id, DAY0, DAY0 + NS_PER_DAY, None)
        .unwrap();
    let read = t0.elapsed();
    assert_eq!(v.len() as u64, n);
    let t1 = Instant::now();
    let mut fp: std::collections::HashMap<(i64, i64), (f64, f64)> = Default::default();
    for r in &v {
        let e = fp.entry((r.ts_ns / 60_000_000_000, r.px)).or_default();
        if r.aggressor == Aggressor::Buy {
            e.1 += r.qty;
        } else {
            e.0 += r.qty;
        }
    }
    let agg = t1.elapsed();
    let per_s = n as f64 / (read + agg).as_secs_f64();
    let bytes = store.list()[0].bytes;
    println!(
        "tick-store: {n} trades, {:.1} MB on disk ({:.1} B/trade); read {:?} ({:.1} M/s), \
         1m footprint {:?}; 30 days × 2 M ≈ {:.1} s",
        bytes as f64 / 1e6,
        bytes as f64 / n as f64,
        read,
        n as f64 / read.as_secs_f64() / 1e6,
        agg,
        30.0 * n as f64 / per_s
    );
    assert!(fp.len() > 1000);
    assert!(read + agg < Duration::from_secs(20));
}
