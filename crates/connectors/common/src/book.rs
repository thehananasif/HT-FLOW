//! Integer-tick L2 book (Live Pipeline stage 3) shared by the venue protocols. The venue's
//! original price / size strings are kept next to each level so CRC32 checksums (OKX, Bitget)
//! can be verified against exactly what the exchange sent.
use std::collections::BTreeMap;

use htflow_core_types::{BookDelta, BookSnapshot, Side};

use crate::util::crc32;

#[derive(Debug, Clone, PartialEq)]
pub struct Lvl {
    pub qty: f64,
    /// Original `(price, size)` strings, when the venue sends strings.
    pub raw: Option<(Box<str>, Box<str>)>,
}

#[derive(Debug, Default, Clone)]
pub struct L2Book {
    pub bids: BTreeMap<i64, Lvl>,
    pub asks: BTreeMap<i64, Lvl>,
}

impl L2Book {
    pub fn clear(&mut self) {
        self.bids.clear();
        self.asks.clear();
    }

    pub fn is_empty(&self) -> bool {
        self.bids.is_empty() && self.asks.is_empty()
    }

    pub fn best_bid(&self) -> Option<i64> {
        self.bids.keys().next_back().copied()
    }

    pub fn best_ask(&self) -> Option<i64> {
        self.asks.keys().next().copied()
    }

    /// Sets one level (qty ≤ 0 removes it) and returns the normalised delta.
    pub fn set(&mut self, side: Side, px: i64, qty: f64, raw: Option<(&str, &str)>) -> BookDelta {
        let book = match side {
            Side::Buy => &mut self.bids,
            Side::Sell => &mut self.asks,
        };
        if qty <= 0.0 {
            book.remove(&px);
        } else {
            book.insert(
                px,
                Lvl {
                    qty,
                    raw: raw.map(|(p, q)| (p.into(), q.into())),
                },
            );
        }
        BookDelta {
            side,
            px,
            qty: qty.max(0.0),
        }
    }

    /// Applies plain `(ticks, qty)` rows for both sides.
    pub fn apply(&mut self, bids: &[(i64, f64)], asks: &[(i64, f64)]) -> Vec<BookDelta> {
        let mut out = Vec::with_capacity(bids.len() + asks.len());
        for &(px, q) in bids {
            out.push(self.set(Side::Buy, px, q, None));
        }
        for &(px, q) in asks {
            out.push(self.set(Side::Sell, px, q, None));
        }
        out
    }

    /// Applies `(ticks, qty, price_str, size_str)` rows, keeping the strings.
    pub fn apply_raw(
        &mut self,
        bids: &[(i64, f64, String, String)],
        asks: &[(i64, f64, String, String)],
    ) -> Vec<BookDelta> {
        let mut out = Vec::with_capacity(bids.len() + asks.len());
        for (px, q, p, s) in bids {
            out.push(self.set(Side::Buy, *px, *q, Some((p, s))));
        }
        for (px, q, p, s) in asks {
            out.push(self.set(Side::Sell, *px, *q, Some((p, s))));
        }
        out
    }

    pub fn snapshot(&self, ts_ns: i64) -> BookSnapshot {
        BookSnapshot {
            ts_ns,
            bids: self.bids.iter().rev().map(|(p, l)| (*p, l.qty)).collect(),
            asks: self.asks.iter().map(|(p, l)| (*p, l.qty)).collect(),
        }
    }

    /// OKX / Bitget checksum: CRC32 (as i32) of the top `depth` levels interleaved
    /// `bid:size:ask:size:…` using the venue's original strings.
    pub fn crc_checksum(&self, depth: usize) -> i32 {
        let mut parts: Vec<&str> = Vec::with_capacity(depth * 4);
        let mut b = self.bids.values().rev();
        let mut a = self.asks.values();
        for _ in 0..depth {
            let (bl, al) = (b.next(), a.next());
            if bl.is_none() && al.is_none() {
                break;
            }
            for l in [bl, al].into_iter().flatten() {
                if let Some((p, q)) = &l.raw {
                    parts.push(p);
                    parts.push(q);
                }
            }
        }
        crc32(parts.join(":").as_bytes()) as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_levels_and_checksums() {
        let mut b = L2Book::default();
        let d = b.apply(&[(100, 1.0), (99, 2.0)], &[(101, 3.0)]);
        assert_eq!(d.len(), 3);
        assert_eq!((b.best_bid(), b.best_ask()), (Some(100), Some(101)));
        b.apply(&[(100, 0.0)], &[]);
        assert_eq!(b.snapshot(0).bids, vec![(99, 2.0)]);

        // Checksum string: best bid, best ask, 2nd bid, 2nd ask, … using the raw strings.
        let mut o = L2Book::default();
        let r = |px: i64, q: f64, p: &str, s: &str| (px, q, p.to_string(), s.to_string());
        o.apply_raw(
            &[r(33661, 7.0, "3366.1", "7"), r(33660, 6.0, "3366", "6")],
            &[r(33668, 9.0, "3366.8", "9"), r(33680, 8.0, "3368", "8")],
        );
        assert_eq!(
            o.crc_checksum(25),
            crc32(b"3366.1:7:3366.8:9:3366:6:3368:8") as i32
        );
    }
}
