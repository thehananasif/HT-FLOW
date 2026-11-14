//! One day file (`YYYY-MM-DD.trd` / `.dep`) plus its index (`….idx`).
//!
//! ```text
//! data file  = FileHeader (32 B) · Block* ;  Block = BlockHeader (36 B) · zstd(columns)
//! index file = IndexEntry (32 B)*  — one per block: min_ts, max_ts, offset, count, payload_len
//! ```
//!
//! Blocks are append-only and self-describing (magic + CRC-32 of the compressed payload), so the
//! data file is the source of truth: a missing, short or stale index is rebuilt by scanning block
//! headers, and a torn last block (crash mid-write) fails its length/CRC check and is ignored —
//! the writer truncates it away when it reopens the file.
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use htflow_core_types::TickSize;

use crate::codec::{Kind, Record};
use crate::day::Day;
use crate::{StoreError, BLOCK_RECORDS};

pub const FILE_MAGIC: &[u8; 4] = b"HTTS";
pub const FILE_VERSION: u16 = 1;
pub const FILE_HEADER_LEN: u64 = 32;
pub const BLOCK_MAGIC: u32 = 0x4B4C_4254; // "TBLK"
pub const BLOCK_HEADER_LEN: u64 = 36;
pub const INDEX_ENTRY_LEN: usize = 32;
const ZSTD_LEVEL: i32 = 3;
/// Most records a block may claim (same bound as the codec). The record count is not covered by
/// the payload CRC and sizes the decompression buffer, so a flipped bit (or a crafted file) must
/// not be able to ask for a multi-gigabyte allocation.
pub const MAX_BLOCK_RECORDS: usize = BLOCK_RECORDS * 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileHeader {
    pub kind: Kind,
    pub tick: TickSize,
    pub day: Day,
}

impl FileHeader {
    fn encode(&self) -> [u8; FILE_HEADER_LEN as usize] {
        let mut b = [0u8; FILE_HEADER_LEN as usize];
        b[0..4].copy_from_slice(FILE_MAGIC);
        b[4..6].copy_from_slice(&FILE_VERSION.to_le_bytes());
        b[6] = self.kind as u8;
        b[8..12].copy_from_slice(&self.tick.scale.to_le_bytes());
        b[12..20].copy_from_slice(&self.tick.units.to_le_bytes());
        b[20..24].copy_from_slice(&self.day.to_le_bytes());
        b
    }

    fn decode(b: &[u8]) -> Result<Self, StoreError> {
        if b.len() < FILE_HEADER_LEN as usize || &b[0..4] != FILE_MAGIC {
            return Err(StoreError::Corrupt("not a tick-store file".into()));
        }
        let version = u16::from_le_bytes([b[4], b[5]]);
        if version != FILE_VERSION {
            return Err(StoreError::Corrupt(format!(
                "unsupported version {version}"
            )));
        }
        let kind = Kind::from_u8(b[6]).ok_or_else(|| StoreError::Corrupt("bad kind".into()))?;
        let scale = u32::from_le_bytes(b[8..12].try_into().expect("4"));
        let units = i64::from_le_bytes(b[12..20].try_into().expect("8"));
        let day = i32::from_le_bytes(b[20..24].try_into().expect("4"));
        if units <= 0 || scale > 18 {
            return Err(StoreError::Corrupt("bad tick size".into()));
        }
        Ok(Self {
            kind,
            tick: TickSize { scale, units },
            day,
        })
    }
}

/// Location and time range of one block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexEntry {
    pub min_ts: i64,
    pub max_ts: i64,
    pub offset: u64,
    pub count: u32,
    pub payload_len: u32,
}

impl IndexEntry {
    pub fn end(&self) -> u64 {
        self.offset + BLOCK_HEADER_LEN + u64::from(self.payload_len)
    }
    fn encode(&self) -> [u8; INDEX_ENTRY_LEN] {
        let mut b = [0u8; INDEX_ENTRY_LEN];
        b[0..8].copy_from_slice(&self.min_ts.to_le_bytes());
        b[8..16].copy_from_slice(&self.max_ts.to_le_bytes());
        b[16..24].copy_from_slice(&self.offset.to_le_bytes());
        b[24..28].copy_from_slice(&self.count.to_le_bytes());
        b[28..32].copy_from_slice(&self.payload_len.to_le_bytes());
        b
    }
    fn decode(b: &[u8]) -> Self {
        Self {
            min_ts: i64::from_le_bytes(b[0..8].try_into().expect("8")),
            max_ts: i64::from_le_bytes(b[8..16].try_into().expect("8")),
            offset: u64::from_le_bytes(b[16..24].try_into().expect("8")),
            count: u32::from_le_bytes(b[24..28].try_into().expect("4")),
            payload_len: u32::from_le_bytes(b[28..32].try_into().expect("4")),
        }
    }
}

struct BlockHeader {
    kind: u8,
    count: u32,
    min_ts: i64,
    max_ts: i64,
    payload_len: u32,
    crc: u32,
}

impl BlockHeader {
    fn encode(&self) -> [u8; BLOCK_HEADER_LEN as usize] {
        let mut b = [0u8; BLOCK_HEADER_LEN as usize];
        b[0..4].copy_from_slice(&BLOCK_MAGIC.to_le_bytes());
        b[4] = self.kind;
        b[8..12].copy_from_slice(&self.count.to_le_bytes());
        b[12..20].copy_from_slice(&self.min_ts.to_le_bytes());
        b[20..28].copy_from_slice(&self.max_ts.to_le_bytes());
        b[28..32].copy_from_slice(&self.payload_len.to_le_bytes());
        b[32..36].copy_from_slice(&self.crc.to_le_bytes());
        b
    }
    fn decode(b: &[u8]) -> Option<Self> {
        if b.len() < BLOCK_HEADER_LEN as usize
            || u32::from_le_bytes(b[0..4].try_into().ok()?) != BLOCK_MAGIC
        {
            return None;
        }
        Some(Self {
            kind: b[4],
            count: u32::from_le_bytes(b[8..12].try_into().ok()?),
            min_ts: i64::from_le_bytes(b[12..20].try_into().ok()?),
            max_ts: i64::from_le_bytes(b[20..28].try_into().ok()?),
            payload_len: u32::from_le_bytes(b[28..32].try_into().ok()?),
            crc: u32::from_le_bytes(b[32..36].try_into().ok()?),
        })
    }
}

pub fn index_path(data: &Path) -> PathBuf {
    let mut s = data.as_os_str().to_owned();
    s.push(".idx");
    PathBuf::from(s)
}

/// Header + valid blocks of a day file. `valid_end` is where the last intact block ends.
#[derive(Debug, Clone)]
pub struct FileIndex {
    pub header: FileHeader,
    pub entries: Vec<IndexEntry>,
    pub valid_end: u64,
    pub file_len: u64,
    /// The on-disk index matched the data file exactly.
    pub index_ok: bool,
}

impl FileIndex {
    pub fn records(&self) -> u64 {
        self.entries.iter().map(|e| u64::from(e.count)).sum()
    }
    pub fn time_range(&self) -> Option<(i64, i64)> {
        let min = self.entries.iter().map(|e| e.min_ts).min()?;
        let max = self.entries.iter().map(|e| e.max_ts).max()?;
        Some((min, max))
    }
    /// True when every block except the last is full (nothing to gain from compaction).
    pub fn is_compact(&self) -> bool {
        let n = self.entries.len();
        n <= 1
            || self.entries[..n - 1]
                .iter()
                .all(|e| e.count as usize >= BLOCK_RECORDS)
    }
}

/// Reads and validates a block (header check + CRC). Returns the compressed payload.
fn check_block(header_bytes: &[u8], payload: &[u8], kind: Kind) -> Option<(BlockHeader, u32)> {
    let h = BlockHeader::decode(header_bytes)?;
    if h.kind != kind as u8
        || payload.len() != h.payload_len as usize
        || h.count == 0
        || h.count as usize > MAX_BLOCK_RECORDS
        || h.min_ts > h.max_ts
    {
        return None;
    }
    if crc32fast::hash(payload) != h.crc {
        return None;
    }
    let crc = h.crc;
    Some((h, crc))
}

/// Loads the index of a day file, repairing it in memory from the data file when the on-disk
/// index is missing, short, stale or longer than the data (crash between the two writes).
pub fn load_index(path: &Path) -> Result<FileIndex, StoreError> {
    let mut f = File::open(path)?;
    let file_len = f.metadata()?.len();
    let mut hb = [0u8; FILE_HEADER_LEN as usize];
    f.read_exact(&mut hb)
        .map_err(|_| StoreError::Corrupt("short file header".into()))?;
    let header = FileHeader::decode(&hb)?;

    // On-disk index: keep the longest prefix whose entries chain exactly through the data file.
    let mut entries = Vec::new();
    let mut next = FILE_HEADER_LEN;
    let idx_bytes = fs::read(index_path(path)).unwrap_or_default();
    let idx_whole = idx_bytes.len().is_multiple_of(INDEX_ENTRY_LEN);
    for chunk in idx_bytes.as_chunks::<INDEX_ENTRY_LEN>().0 {
        let e = IndexEntry::decode(chunk);
        if e.offset != next
            || e.end() > file_len
            || e.count == 0
            || e.count as usize > MAX_BLOCK_RECORDS
            || e.min_ts > e.max_ts
        {
            break;
        }
        entries.push(e);
        next = e.end();
    }
    let idx_count_ok = idx_whole && entries.len() * INDEX_ENTRY_LEN == idx_bytes.len();

    // Spot-check the last indexed block header against the data (detects a stale index).
    if let Some(last) = entries.last().copied() {
        let mut b = [0u8; BLOCK_HEADER_LEN as usize];
        f.seek(SeekFrom::Start(last.offset))?;
        let ok = f.read_exact(&mut b).is_ok()
            && BlockHeader::decode(&b).is_some_and(|h| {
                h.count == last.count
                    && h.payload_len == last.payload_len
                    && h.min_ts == last.min_ts
                    && h.max_ts == last.max_ts
            });
        if !ok {
            entries.clear();
            next = FILE_HEADER_LEN;
        }
    }

    // Scan any blocks after the indexed prefix (unindexed tail or a rebuilt index).
    let scanned_from = entries.len();
    f.seek(SeekFrom::Start(next))?;
    let mut rest = Vec::new();
    f.read_to_end(&mut rest)?;
    let mut pos = 0usize;
    while pos + BLOCK_HEADER_LEN as usize <= rest.len() {
        let hdr = &rest[pos..pos + BLOCK_HEADER_LEN as usize];
        let Some(h) = BlockHeader::decode(hdr) else {
            break;
        };
        let start = pos + BLOCK_HEADER_LEN as usize;
        let end = start + h.payload_len as usize;
        if end > rest.len() || h.count == 0 {
            break;
        }
        if check_block(hdr, &rest[start..end], header.kind).is_none() {
            break;
        }
        entries.push(IndexEntry {
            min_ts: h.min_ts,
            max_ts: h.max_ts,
            offset: next + pos as u64,
            count: h.count,
            payload_len: h.payload_len,
        });
        pos = end;
    }
    let valid_end = entries.last().map_or(FILE_HEADER_LEN, |e| e.end());
    Ok(FileIndex {
        header,
        index_ok: idx_count_ok && scanned_from == entries.len() && valid_end == file_len,
        entries,
        valid_end,
        file_len,
    })
}

/// Rescales a price in ticks of `from` to ticks of `to` (exact decimal math, half-up rounding).
/// Saturates at the i64 range instead of overflowing on absurd tick sizes (corrupted headers).
pub fn rescale_px(px: i64, from: TickSize, to: TickSize) -> i64 {
    if from == to {
        return px;
    }
    let s = from.scale.max(to.scale);
    let sat = |neg: bool| if neg { i64::MIN } else { i64::MAX };
    let num = 10i128.checked_pow(s - from.scale).and_then(|p| {
        i128::from(px)
            .checked_mul(i128::from(from.units))?
            .checked_mul(p)
    });
    let den = 10i128
        .checked_pow(s - to.scale)
        .and_then(|p| i128::from(to.units).checked_mul(p))
        .filter(|d| *d > 0);
    let (Some(num), Some(den)) = (num, den) else {
        return sat(px < 0);
    };
    let q = num.div_euclid(den);
    let r = num.rem_euclid(den);
    let q = if r.saturating_mul(2) >= den { q + 1 } else { q };
    i64::try_from(q).unwrap_or_else(|_| sat(q < 0))
}

/// Reads the records of `idx` whose timestamp is in `[from, to)` and appends them to `out`
/// (prices converted to `tick` when the file was written with another tick size).
pub fn read_range<R: Record>(
    path: &Path,
    idx: &FileIndex,
    from: i64,
    to: i64,
    tick: Option<TickSize>,
    out: &mut Vec<R>,
) -> Result<(), StoreError> {
    let wanted: Vec<&IndexEntry> = idx
        .entries
        .iter()
        .filter(|e| e.max_ts >= from && e.min_ts < to)
        .collect();
    if wanted.is_empty() {
        return Ok(());
    }
    let mut f = File::open(path)?;
    let mut dec = zstd::bulk::Decompressor::new()?;
    let mut buf = Vec::new();
    let mut recs: Vec<R> = Vec::with_capacity(BLOCK_RECORDS);
    let mut i = 0;
    while i < wanted.len() {
        // Coalesce runs of adjacent blocks into one read.
        let mut j = i + 1;
        while j < wanted.len() && wanted[j].offset == wanted[j - 1].end() {
            j += 1;
        }
        let start = wanted[i].offset;
        let end = wanted[j - 1].end();
        buf.resize((end - start) as usize, 0);
        f.seek(SeekFrom::Start(start))?;
        f.read_exact(&mut buf)?;
        for e in &wanted[i..j] {
            let off = (e.offset - start) as usize;
            let hdr = &buf[off..off + BLOCK_HEADER_LEN as usize];
            let payload = &buf[off + BLOCK_HEADER_LEN as usize
                ..off + BLOCK_HEADER_LEN as usize + e.payload_len as usize];
            if check_block(hdr, payload, R::KIND).is_none_or(|(h, _)| h.count != e.count) {
                tracing::warn!(file = %path.display(), offset = e.offset, "tick-store: skipping corrupt block");
                continue;
            }
            let raw = dec.decompress(payload, 16 + e.count as usize * R::MAX_ENCODED)?;
            recs.clear();
            R::decode(&raw, &mut recs)?;
            let rescale = tick.filter(|t| *t != idx.header.tick);
            let fully_inside = e.min_ts >= from && e.max_ts < to;
            for r in recs.iter().copied() {
                if fully_inside || (r.ts() >= from && r.ts() < to) {
                    out.push(match rescale {
                        Some(t) => r.with_px(rescale_px(r.px(), idx.header.tick, t)),
                        None => r,
                    });
                }
            }
        }
        i = j;
    }
    Ok(())
}

/// Append-only writer for one day file. Records are buffered and written as blocks of up to
/// [`BLOCK_RECORDS`] on [`DayWriter::flush`] (or whenever a block fills up).
pub struct DayWriter<R: Record> {
    path: PathBuf,
    data: File,
    index: File,
    header: FileHeader,
    len: u64,
    pending: Vec<R>,
    entries: Vec<IndexEntry>,
    comp: zstd::bulk::Compressor<'static>,
    scratch: Vec<u8>,
    dirty: bool,
}

impl<R: Record> DayWriter<R> {
    /// Opens (or creates) a day file for appending. An existing file keeps its tick size;
    /// records pushed with another tick size are rescaled. A torn tail is truncated and the
    /// index is repaired.
    pub fn open(path: &Path, tick: TickSize, day: Day) -> Result<Self, StoreError> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let exists = path.exists() && fs::metadata(path)?.len() >= FILE_HEADER_LEN;
        let mut data = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        let mut index = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(index_path(path))?;
        let (header, entries, len) = if exists {
            let idx = load_index(path)?;
            if idx.header.kind != R::KIND {
                return Err(StoreError::Corrupt(format!(
                    "{} holds another record kind",
                    path.display()
                )));
            }
            if idx.valid_end < idx.file_len {
                tracing::warn!(file = %path.display(), dropped = idx.file_len - idx.valid_end, "tick-store: truncating torn tail");
                data.set_len(idx.valid_end)?;
            }
            if !idx.index_ok {
                let mut bytes = Vec::with_capacity(idx.entries.len() * INDEX_ENTRY_LEN);
                for e in &idx.entries {
                    bytes.extend_from_slice(&e.encode());
                }
                index.set_len(0)?;
                index.seek(SeekFrom::Start(0))?;
                index.write_all(&bytes)?;
            }
            (idx.header, idx.entries, idx.valid_end)
        } else {
            let header = FileHeader {
                kind: R::KIND,
                tick,
                day,
            };
            data.set_len(0)?;
            data.write_all(&header.encode())?;
            index.set_len(0)?;
            (header, Vec::new(), FILE_HEADER_LEN)
        };
        data.seek(SeekFrom::Start(len))?;
        index.seek(SeekFrom::End(0))?;
        Ok(Self {
            path: path.to_path_buf(),
            data,
            index,
            header,
            len,
            pending: Vec::new(),
            entries,
            comp: zstd::bulk::Compressor::new(ZSTD_LEVEL)?,
            scratch: Vec::new(),
            dirty: false,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn header(&self) -> FileHeader {
        self.header
    }

    pub fn pending(&self) -> usize {
        self.pending.len()
    }

    pub fn blocks(&self) -> &[IndexEntry] {
        &self.entries
    }

    /// Bytes on disk (data written so far, excluding pending records).
    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty() && self.pending.is_empty()
    }

    pub fn push(&mut self, rec: R, tick: TickSize) -> Result<(), StoreError> {
        let rec = if tick == self.header.tick {
            rec
        } else {
            rec.with_px(rescale_px(rec.px(), tick, self.header.tick))
        };
        self.pending.push(rec);
        if self.pending.len() >= BLOCK_RECORDS {
            self.write_pending()?;
        }
        Ok(())
    }

    fn write_pending(&mut self) -> Result<(), StoreError> {
        while !self.pending.is_empty() {
            let n = self.pending.len().min(BLOCK_RECORDS);
            let recs: Vec<R> = self.pending.drain(..n).collect();
            self.write_block(&recs)?;
        }
        Ok(())
    }

    fn write_block(&mut self, recs: &[R]) -> Result<(), StoreError> {
        self.scratch.clear();
        R::encode(recs, &mut self.scratch);
        let payload = self.comp.compress(&self.scratch)?;
        let min_ts = recs.iter().map(R::ts).min().unwrap_or(0);
        let max_ts = recs.iter().map(R::ts).max().unwrap_or(0);
        let h = BlockHeader {
            kind: R::KIND as u8,
            count: recs.len() as u32,
            min_ts,
            max_ts,
            payload_len: payload.len() as u32,
            crc: crc32fast::hash(&payload),
        };
        let mut block = Vec::with_capacity(BLOCK_HEADER_LEN as usize + payload.len());
        block.extend_from_slice(&h.encode());
        block.extend_from_slice(&payload);
        self.data.write_all(&block)?;
        let e = IndexEntry {
            min_ts,
            max_ts,
            offset: self.len,
            count: h.count,
            payload_len: h.payload_len,
        };
        // Data first, index second: a crash in between leaves an unindexed block, which
        // load_index() finds by scanning.
        self.index.write_all(&e.encode())?;
        self.len = e.end();
        self.entries.push(e);
        self.dirty = true;
        Ok(())
    }

    /// Writes buffered records to the OS (stage 5: every 1 s).
    pub fn flush(&mut self) -> Result<(), StoreError> {
        self.write_pending()
    }

    /// Flushes and forces data + index to disk (stage 5: every 10 s).
    pub fn sync(&mut self) -> Result<(), StoreError> {
        self.write_pending()?;
        if self.dirty {
            self.data.sync_data()?;
            self.index.sync_data()?;
            self.dirty = false;
        }
        Ok(())
    }
}

/// Rewrites a closed day file into full blocks (the recorder writes a small block every
/// second). Atomic: the new file is written next to the old one and renamed over it.
/// Returns true when the file was rewritten.
pub fn compact<R: Record>(path: &Path) -> Result<bool, StoreError> {
    let idx = load_index(path)?;
    if idx.header.kind != R::KIND || (idx.is_compact() && idx.index_ok) {
        return Ok(false);
    }
    let mut recs: Vec<R> = Vec::with_capacity(idx.records() as usize);
    read_range(path, &idx, i64::MIN, i64::MAX, None, &mut recs)?;
    recs.sort_by_key(R::ts);
    let tmp = path.with_extension("compact.tmp");
    let _ = fs::remove_file(&tmp);
    let _ = fs::remove_file(index_path(&tmp));
    {
        let mut w = DayWriter::<R>::open(&tmp, idx.header.tick, idx.header.day)?;
        for r in recs {
            w.push(r, idx.header.tick)?;
        }
        w.sync()?;
    }
    fs::rename(&tmp, path)?;
    fs::rename(index_path(&tmp), index_path(path))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::TradeRec;
    use htflow_core_types::Aggressor;

    fn tr(ts: i64, px: i64, id: u64) -> TradeRec {
        TradeRec {
            ts_ns: ts,
            px,
            qty: 1.0,
            aggressor: Aggressor::Buy,
            trade_id: id,
        }
    }

    #[test]
    fn rescales_prices_between_tick_sizes() {
        let t01 = TickSize::parse("0.1").unwrap();
        let t001 = TickSize::parse("0.01").unwrap();
        let t025 = TickSize::parse("0.25").unwrap();
        assert_eq!(rescale_px(681_234, t01, t001), 6_812_340);
        assert_eq!(rescale_px(6_812_345, t001, t01), 681_235);
        assert_eq!(rescale_px(4, t025, TickSize::parse("1").unwrap()), 1);
        assert_eq!(rescale_px(-15, t01, t001), -150);
    }

    #[test]
    fn stale_or_missing_index_is_rebuilt() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.trd");
        let tick = TickSize::parse("0.1").unwrap();
        {
            let mut w = DayWriter::<TradeRec>::open(&p, tick, 0).unwrap();
            for i in 0..2500 {
                w.push(tr(i, 10 + i, i as u64), tick).unwrap();
            }
            w.sync().unwrap();
        }
        assert!(load_index(&p).unwrap().index_ok);
        fs::remove_file(index_path(&p)).unwrap();
        let idx = load_index(&p).unwrap();
        assert!(!idx.index_ok);
        assert_eq!(idx.records(), 2500);
        assert_eq!(idx.entries.len(), 3);
        // Reopening repairs the on-disk index.
        drop(DayWriter::<TradeRec>::open(&p, tick, 0).unwrap());
        assert!(load_index(&p).unwrap().index_ok);
        // Garbage index entries are ignored.
        fs::write(index_path(&p), [7u8; 64]).unwrap();
        assert_eq!(load_index(&p).unwrap().records(), 2500);
    }

    /// Valid two-day-ish file with a few blocks, returned as (data, index) bytes.
    fn sample(dir: &Path) -> (PathBuf, Vec<u8>, Vec<u8>) {
        let p = dir.join("s.trd");
        let tick = TickSize::parse("0.1").unwrap();
        let mut w = DayWriter::<TradeRec>::open(&p, tick, 0).unwrap();
        for i in 0..2500 {
            w.push(tr(i, 10 + i, i as u64), tick).unwrap();
        }
        w.sync().unwrap();
        drop(w);
        (
            p.clone(),
            fs::read(&p).unwrap(),
            fs::read(index_path(&p)).unwrap(),
        )
    }

    fn exercise(p: &Path) {
        if let Ok(idx) = load_index(p) {
            let mut out: Vec<TradeRec> = Vec::new();
            let _ = read_range(p, &idx, i64::MIN, i64::MAX, None, &mut out);
            let _ = read_range(
                p,
                &idx,
                0,
                i64::MAX,
                Some(TickSize::parse("0.01").unwrap()),
                &mut out,
            );
            assert!(out.len() <= 2 * idx.records() as usize);
        }
        let _ = DayWriter::<TradeRec>::open(p, TickSize::parse("0.1").unwrap(), 0);
    }

    #[test]
    fn huge_record_count_is_rejected_not_allocated() {
        let dir = tempfile::tempdir().unwrap();
        let (p, data, idx) = sample(dir.path());
        // Block count lives outside the payload CRC: set it to u32::MAX in the first block header.
        let off = FILE_HEADER_LEN as usize + 8;
        let mut d = data.clone();
        d[off..off + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        fs::write(&p, &d).unwrap();
        fs::write(index_path(&p), &idx).unwrap();
        // With the (intact) index the block is listed, but reading skips it instead of sizing
        // a buffer from the bogus count.
        let li = load_index(&p).unwrap();
        let first = li.entries[0].count as usize;
        let mut out: Vec<TradeRec> = Vec::new();
        read_range(&p, &li, i64::MIN, i64::MAX, None, &mut out).unwrap();
        assert_eq!(out.len(), 2500 - first);
        // Without the index the scan stops at the corrupt block.
        fs::remove_file(index_path(&p)).unwrap();
        assert!(load_index(&p).unwrap().entries.is_empty());
        // Same through the index file only (data intact).
        fs::write(&p, &data).unwrap();
        let mut ix = idx.clone();
        ix[24..28].copy_from_slice(&u32::MAX.to_le_bytes());
        fs::write(index_path(&p), &ix).unwrap();
        let li = load_index(&p).unwrap();
        assert_eq!(li.records(), 2500, "index rebuilt from the data file");
        // An index whose count disagrees with the block header is skipped, not trusted.
        let mut li = load_index(&p).unwrap();
        li.entries[0].count = MAX_BLOCK_RECORDS as u32;
        let mut out: Vec<TradeRec> = Vec::new();
        read_range(&p, &li, i64::MIN, i64::MAX, None, &mut out).unwrap();
        assert_eq!(out.len(), 2500 - first);
    }

    #[test]
    fn corrupted_files_never_panic() {
        let dir = tempfile::tempdir().unwrap();
        let (p, data, idx) = sample(dir.path());
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for round in 0..300 {
            let mut d = data.clone();
            let mut ix = idx.clone();
            for _ in 0..(1 + rnd() % 8) {
                let r = rnd();
                if r % 3 == 0 && !ix.is_empty() {
                    let i = (rnd() as usize) % ix.len();
                    ix[i] = rnd() as u8;
                } else {
                    // Bias towards headers: the first 32 B, and block headers.
                    let i = if r % 2 == 0 {
                        (rnd() as usize) % 200
                    } else {
                        (rnd() as usize) % d.len()
                    };
                    d[i] = rnd() as u8;
                }
            }
            match round % 5 {
                0 => d.truncate((rnd() as usize) % d.len()),
                1 => ix.truncate((rnd() as usize) % (ix.len() + 1)),
                _ => {}
            }
            fs::write(&p, &d).unwrap();
            fs::write(index_path(&p), &ix).unwrap();
            exercise(&p);
        }
        // Absurd tick sizes saturate instead of overflowing.
        let huge = TickSize {
            scale: 0,
            units: i64::MAX,
        };
        let tiny = TickSize {
            scale: 18,
            units: 1,
        };
        assert_eq!(rescale_px(i64::MAX, huge, tiny), i64::MAX);
        assert_eq!(rescale_px(i64::MIN, huge, tiny), i64::MIN);
    }
}
