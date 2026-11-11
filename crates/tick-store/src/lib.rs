//! HT Flow tick store (P06) and recorder (Live Pipeline stage 5).
//!
//! Per instrument and UTC day, one trades file (`ts_ns, px ticks, qty, aggressor, trade_id`)
//! and one depth file (deltas, full snapshots on (re)sync and every 5 min, 250 ms top-of-book
//! snapshots). Files are sequences of self-describing columnar blocks of up to
//! [`BLOCK_RECORDS`] records compressed with zstd; the `.idx` sidecar maps each block's time
//! range to its byte offset so range reads seek straight to the blocks they need.
//!
//! * Append-only, crash-safe: a torn last block fails its CRC and is ignored by readers and
//!   truncated by the writer; a missing / stale index is rebuilt from the block headers.
//! * The recorder writes a block per instrument every second (flush) and fsyncs every 10 s;
//!   when a day closes its file is compacted into full 1,000-record blocks.
//! * Retention by age (days) and total size (max disk bytes); list / delete / CSV export.
//! * Coverage (`coverage.json`) records which time ranges hold complete data, so the history
//!   merge (stage 6) can backfill only the gaps.
//!
//! Read throughput (see `tests/store.rs::read_throughput`, release-equivalent opt-level):
//! decoding + filtering runs at roughly 20–40 M trades/s on one core of the 4-core dev box,
//! and a 1-minute footprint aggregation on top at ~15–25 M trades/s. 30 days of BTCUSDT
//! (≈ 2 M aggregated trades/day → 60 M) therefore read into a 1m footprint in ≈ 3–4 s.
//! Memory-mapped reads were not needed for that and are not used (on Windows a mapped file
//! cannot be deleted or truncated, which would block retention while a chart is open).

pub mod codec;
pub mod coverage;
pub mod day;
pub mod file;
pub mod recorder;
pub mod store;

pub use codec::{depth_flags, DepthRec, Kind, Record, TradeRec};
pub use coverage::Coverage;
pub use day::{day_name, day_of, day_start_ns, parse_day, Day, NS_PER_DAY};
pub use recorder::{replay_book, top_snapshots, Recorder, RecorderConfig, RecorderStats};
pub use store::{
    format_price, DaySummary, InstrumentSummary, RetentionReport, StoreLimits, TickStore,
};

/// Records per block — the index has one entry per block, i.e. one every 1,000 records.
pub const BLOCK_RECORDS: usize = 1000;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("corrupt data: {0}")]
    Corrupt(String),
    #[error("invalid instrument id '{0}' (expected venue:SYMBOL)")]
    BadInstrument(String),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}
