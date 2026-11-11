//! Time ranges (ns, half-open `[start, end)`) for which the store holds complete trade data:
//! recorded while the live stream was connected, or downloaded by a backfill. Quiet markets
//! and recorder downtime look the same in the trade files, so the history merge (Live
//! Pipeline stage 6) uses coverage — not the trades themselves — to find gaps.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Coverage {
    /// Sorted, non-overlapping, non-adjacent intervals.
    pub intervals: Vec<(i64, i64)>,
}

impl Coverage {
    pub fn add(&mut self, start: i64, end: i64) {
        if end <= start {
            return;
        }
        let mut s = start;
        let mut e = end;
        let mut out = Vec::with_capacity(self.intervals.len() + 1);
        let mut placed = false;
        for &(a, b) in &self.intervals {
            if b < s {
                out.push((a, b));
            } else if a > e {
                if !placed {
                    out.push((s, e));
                    placed = true;
                }
                out.push((a, b));
            } else {
                s = s.min(a);
                e = e.max(b);
            }
        }
        if !placed {
            out.push((s, e));
        }
        self.intervals = out;
    }

    /// Removes `[start, end)` from the covered set.
    pub fn remove(&mut self, start: i64, end: i64) {
        let mut out = Vec::with_capacity(self.intervals.len() + 1);
        for &(a, b) in &self.intervals {
            if b <= start || a >= end {
                out.push((a, b));
                continue;
            }
            if a < start {
                out.push((a, start));
            }
            if b > end {
                out.push((end, b));
            }
        }
        self.intervals = out;
    }

    /// Parts of `[from, to)` not covered, ignoring holes shorter than `min_gap`.
    pub fn gaps(&self, from: i64, to: i64, min_gap: i64) -> Vec<(i64, i64)> {
        let mut out = Vec::new();
        let mut cur = from;
        for &(a, b) in &self.intervals {
            if b <= cur {
                continue;
            }
            if a >= to {
                break;
            }
            if a > cur {
                out.push((cur, a.min(to)));
            }
            cur = cur.max(b);
            if cur >= to {
                break;
            }
        }
        if cur < to {
            out.push((cur, to));
        }
        out.retain(|(a, b)| b - a >= min_gap);
        out
    }

    pub fn covered(&self, from: i64, to: i64) -> i64 {
        self.intervals
            .iter()
            .map(|&(a, b)| (b.min(to) - a.max(from)).max(0))
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_and_finds_gaps() {
        let mut c = Coverage::default();
        c.add(10, 20);
        c.add(30, 40);
        c.add(18, 25);
        c.add(25, 26); // adjacent → merged
        assert_eq!(c.intervals, vec![(10, 26), (30, 40)]);
        assert_eq!(c.gaps(0, 50, 0), vec![(0, 10), (26, 30), (40, 50)]);
        assert_eq!(c.gaps(12, 24, 0), vec![]);
        assert_eq!(c.gaps(0, 50, 5), vec![(0, 10), (40, 50)]);
        assert_eq!(c.covered(0, 35), 16 + 5);
        c.add(0, 100);
        assert_eq!(c.intervals, vec![(0, 100)]);
        c.remove(40, 60);
        assert_eq!(c.intervals, vec![(0, 40), (60, 100)]);
        c.remove(-5, 10);
        assert_eq!(c.intervals, vec![(10, 40), (60, 100)]);
    }
}
