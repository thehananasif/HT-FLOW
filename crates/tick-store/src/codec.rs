//! Columnar block codec. A block holds up to [`crate::BLOCK_RECORDS`] records of one kind,
//! stored column by column (timestamps and prices as zig-zag delta varints, ids as delta varints,
//! flags as raw bytes, quantities as byte-shuffled `f64`) and then compressed with zstd.
use htflow_core_types::{Aggressor, Trade};

use crate::StoreError;

/// Which stream a file holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Kind {
    Trades = 1,
    Depth = 2,
}

impl Kind {
    pub fn ext(self) -> &'static str {
        match self {
            Kind::Trades => "trd",
            Kind::Depth => "dep",
        }
    }
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            1 => Some(Kind::Trades),
            2 => Some(Kind::Depth),
            _ => None,
        }
    }
}

/// One recorded trade. `px` is in ticks of the file's tick size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TradeRec {
    pub ts_ns: i64,
    pub px: i64,
    pub qty: f64,
    pub aggressor: Aggressor,
    pub trade_id: u64,
}

impl From<&Trade> for TradeRec {
    fn from(t: &Trade) -> Self {
        Self {
            ts_ns: t.exchange_ts_ns,
            px: t.px,
            qty: t.qty,
            aggressor: t.aggressor,
            trade_id: t.trade_id,
        }
    }
}

impl TradeRec {
    pub fn to_trade(&self) -> Trade {
        Trade {
            exchange_ts_ns: self.ts_ns,
            local_ts_ns: self.ts_ns,
            px: self.px,
            qty: self.qty,
            aggressor: self.aggressor,
            trade_id: self.trade_id,
        }
    }
}

/// Flag bits of a [`DepthRec`].
pub mod depth_flags {
    /// Ask side (bid when clear).
    pub const ASK: u8 = 1;
    /// The row is one level of a snapshot (absolute size), not an incremental delta.
    pub const SNAPSHOT: u8 = 2;
    /// First row of a full snapshot: clear the book before applying it.
    pub const RESET: u8 = 4;
    /// Row of a sampled top-of-book snapshot (every 250 ms). Redundant with deltas; used for
    /// fast heatmap history. Book replay ignores it.
    pub const TOP: u8 = 8;
}

/// One recorded depth row: a delta, a full-snapshot level or a top-N snapshot level.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DepthRec {
    pub ts_ns: i64,
    pub flags: u8,
    pub px: i64,
    pub qty: f64,
}

impl DepthRec {
    pub fn is_ask(&self) -> bool {
        self.flags & depth_flags::ASK != 0
    }
}

/// A record type that can be stored in columnar blocks.
pub trait Record: Copy + Send + 'static {
    const KIND: Kind;
    /// Upper bound of the encoded size of one record (before compression).
    const MAX_ENCODED: usize;
    fn ts(&self) -> i64;
    fn px(&self) -> i64;
    fn with_px(self, px: i64) -> Self;
    fn encode(recs: &[Self], out: &mut Vec<u8>);
    fn decode(buf: &[u8], out: &mut Vec<Self>) -> Result<(), StoreError>;
}

#[inline]
pub(crate) fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

#[inline]
pub(crate) fn get_varint(buf: &[u8], pos: &mut usize) -> Result<u64, StoreError> {
    let mut v = 0u64;
    let mut shift = 0u32;
    loop {
        let b = *buf
            .get(*pos)
            .ok_or_else(|| StoreError::Corrupt("varint past end of block".into()))?;
        *pos += 1;
        v |= u64::from(b & 0x7f) << shift;
        if b < 0x80 {
            return Ok(v);
        }
        shift += 7;
        if shift > 63 {
            return Err(StoreError::Corrupt("varint too long".into()));
        }
    }
}

#[inline]
fn zig(v: i64) -> u64 {
    ((v << 1) ^ (v >> 63)) as u64
}

#[inline]
fn unzig(u: u64) -> i64 {
    ((u >> 1) as i64) ^ -((u & 1) as i64)
}

fn put_delta_col(out: &mut Vec<u8>, vals: impl Iterator<Item = i64>) {
    let mut prev = 0i64;
    for v in vals {
        put_varint(out, zig(v.wrapping_sub(prev)));
        prev = v;
    }
}

fn get_delta_col(buf: &[u8], pos: &mut usize, n: usize) -> Result<Vec<i64>, StoreError> {
    let mut out = Vec::with_capacity(n);
    let mut prev = 0i64;
    for _ in 0..n {
        prev = prev.wrapping_add(unzig(get_varint(buf, pos)?));
        out.push(prev);
    }
    Ok(out)
}

/// Byte-shuffled f64 column (all first bytes, then all second bytes, …): compresses far better.
fn put_f64_col(out: &mut Vec<u8>, vals: impl Iterator<Item = f64> + Clone) {
    let bytes: Vec<[u8; 8]> = vals.map(f64::to_le_bytes).collect();
    for k in 0..8 {
        out.extend(bytes.iter().map(|b| b[k]));
    }
}

fn get_f64_col(buf: &[u8], pos: &mut usize, n: usize) -> Result<Vec<f64>, StoreError> {
    let end = *pos + n * 8;
    let src = buf
        .get(*pos..end)
        .ok_or_else(|| StoreError::Corrupt("f64 column past end of block".into()))?;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let mut b = [0u8; 8];
        for (k, byte) in b.iter_mut().enumerate() {
            *byte = src[k * n + i];
        }
        out.push(f64::from_le_bytes(b));
    }
    *pos = end;
    Ok(out)
}

fn get_bytes<'a>(buf: &'a [u8], pos: &mut usize, n: usize) -> Result<&'a [u8], StoreError> {
    let s = buf
        .get(*pos..*pos + n)
        .ok_or_else(|| StoreError::Corrupt("byte column past end of block".into()))?;
    *pos += n;
    Ok(s)
}

fn aggressor_to_u8(a: Aggressor) -> u8 {
    a.as_i8() as u8
}

fn aggressor_from_u8(b: u8) -> Aggressor {
    match b as i8 {
        1 => Aggressor::Buy,
        -1 => Aggressor::Sell,
        _ => Aggressor::Unknown,
    }
}

impl Record for TradeRec {
    const KIND: Kind = Kind::Trades;
    const MAX_ENCODED: usize = 10 + 10 + 10 + 1 + 8;
    fn ts(&self) -> i64 {
        self.ts_ns
    }
    fn px(&self) -> i64 {
        self.px
    }
    fn with_px(mut self, px: i64) -> Self {
        self.px = px;
        self
    }
    fn encode(recs: &[Self], out: &mut Vec<u8>) {
        put_varint(out, recs.len() as u64);
        put_delta_col(out, recs.iter().map(|r| r.ts_ns));
        put_delta_col(out, recs.iter().map(|r| r.px));
        put_delta_col(out, recs.iter().map(|r| r.trade_id as i64));
        out.extend(recs.iter().map(|r| aggressor_to_u8(r.aggressor)));
        put_f64_col(out, recs.iter().map(|r| r.qty));
    }
    fn decode(buf: &[u8], out: &mut Vec<Self>) -> Result<(), StoreError> {
        let mut pos = 0;
        let n = get_varint(buf, &mut pos)? as usize;
        if n > crate::BLOCK_RECORDS * 64 {
            return Err(StoreError::Corrupt(format!("block claims {n} records")));
        }
        let ts = get_delta_col(buf, &mut pos, n)?;
        let px = get_delta_col(buf, &mut pos, n)?;
        let id = get_delta_col(buf, &mut pos, n)?;
        let ag = get_bytes(buf, &mut pos, n)?.to_vec();
        let qty = get_f64_col(buf, &mut pos, n)?;
        out.reserve(n);
        for i in 0..n {
            out.push(TradeRec {
                ts_ns: ts[i],
                px: px[i],
                qty: qty[i],
                aggressor: aggressor_from_u8(ag[i]),
                trade_id: id[i] as u64,
            });
        }
        Ok(())
    }
}

impl Record for DepthRec {
    const KIND: Kind = Kind::Depth;
    const MAX_ENCODED: usize = 10 + 10 + 1 + 8;
    fn ts(&self) -> i64 {
        self.ts_ns
    }
    fn px(&self) -> i64 {
        self.px
    }
    fn with_px(mut self, px: i64) -> Self {
        self.px = px;
        self
    }
    fn encode(recs: &[Self], out: &mut Vec<u8>) {
        put_varint(out, recs.len() as u64);
        put_delta_col(out, recs.iter().map(|r| r.ts_ns));
        put_delta_col(out, recs.iter().map(|r| r.px));
        out.extend(recs.iter().map(|r| r.flags));
        put_f64_col(out, recs.iter().map(|r| r.qty));
    }
    fn decode(buf: &[u8], out: &mut Vec<Self>) -> Result<(), StoreError> {
        let mut pos = 0;
        let n = get_varint(buf, &mut pos)? as usize;
        if n > crate::BLOCK_RECORDS * 64 {
            return Err(StoreError::Corrupt(format!("block claims {n} records")));
        }
        let ts = get_delta_col(buf, &mut pos, n)?;
        let px = get_delta_col(buf, &mut pos, n)?;
        let fl = get_bytes(buf, &mut pos, n)?.to_vec();
        let qty = get_f64_col(buf, &mut pos, n)?;
        out.reserve(n);
        for i in 0..n {
            out.push(DepthRec {
                ts_ns: ts[i],
                flags: fl[i],
                px: px[i],
                qty: qty[i],
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varints_and_zigzag_round_trip() {
        let mut out = Vec::new();
        let vals = [0u64, 1, 127, 128, 300, u64::MAX];
        for v in vals {
            put_varint(&mut out, v);
        }
        let mut pos = 0;
        for v in vals {
            assert_eq!(get_varint(&out, &mut pos).unwrap(), v);
        }
        for v in [0i64, -1, 1, i64::MIN, i64::MAX, -12345] {
            assert_eq!(unzig(zig(v)), v);
        }
        assert!(get_varint(&[0x80], &mut 0).is_err());
    }

    #[test]
    fn trade_block_round_trip() {
        let recs: Vec<TradeRec> = (0..500)
            .map(|i| TradeRec {
                ts_ns: 1_700_000_000_000_000_000 + i * 1_000_003,
                px: 681_234 + (i % 7) - 3,
                qty: 0.001 * (i as f64 + 1.0),
                aggressor: if i % 3 == 0 {
                    Aggressor::Buy
                } else if i % 3 == 1 {
                    Aggressor::Sell
                } else {
                    Aggressor::Unknown
                },
                trade_id: if i == 7 { u64::MAX >> 11 } else { 5_000_000_000 + i as u64 },
            })
            .collect();
        let mut buf = Vec::new();
        TradeRec::encode(&recs, &mut buf);
        assert!(buf.len() <= recs.len() * TradeRec::MAX_ENCODED + 10);
        let mut back = Vec::new();
        TradeRec::decode(&buf, &mut back).unwrap();
        assert_eq!(back, recs);
        // Truncated payloads are rejected, never mis-decoded.
        assert!(TradeRec::decode(&buf[..buf.len() - 3], &mut Vec::new()).is_err());
    }

    #[test]
    fn depth_block_round_trip() {
        let recs = vec![
            DepthRec {
                ts_ns: 5,
                flags: depth_flags::SNAPSHOT | depth_flags::RESET,
                px: 100,
                qty: 1.5,
            },
            DepthRec {
                ts_ns: 5,
                flags: depth_flags::SNAPSHOT | depth_flags::ASK,
                px: 101,
                qty: 2.0,
            },
            DepthRec {
                ts_ns: 9,
                flags: 0,
                px: 99,
                qty: 0.0,
            },
        ];
        let mut buf = Vec::new();
        DepthRec::encode(&recs, &mut buf);
        let mut back = Vec::new();
        DepthRec::decode(&buf, &mut back).unwrap();
        assert_eq!(back, recs);
    }
}
