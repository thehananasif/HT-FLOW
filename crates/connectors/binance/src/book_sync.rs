//! Local order-book synchronisation (Live Pipeline stage 3) following Binance futures rules:
//! buffer stream events → fetch REST snapshot → drop events with `u < lastUpdateId` → the first
//! applied event must straddle `lastUpdateId` → every next event's `pu` must equal the previous `u`.
//! Any break marks the book stale and requests a new snapshot.
use std::collections::BTreeMap;

use htflow_core_types::{BookDelta, BookSnapshot, Side};

#[derive(Debug, Clone, PartialEq)]
pub struct DepthUpdate {
    pub first_id: u64,
    pub final_id: u64,
    pub prev_final_id: u64,
    pub event_ms: i64,
    pub bids: Vec<(i64, f64)>,
    pub asks: Vec<(i64, f64)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SyncOutcome {
    /// Waiting for a snapshot; the update was buffered.
    Buffered,
    /// Applied in sequence; forward these deltas.
    Applied(Vec<BookDelta>),
    /// Snapshot accepted and buffered updates replayed; forward the full book.
    Synced(BookSnapshot),
    /// Sequence gap (or snapshot too old): the book is stale — fetch a new snapshot.
    Gap,
}

#[derive(Debug, Default)]
pub struct L2Book {
    pub bids: BTreeMap<i64, f64>,
    pub asks: BTreeMap<i64, f64>,
}

impl L2Book {
    pub fn best_bid(&self) -> Option<i64> {
        self.bids.keys().next_back().copied()
    }
    pub fn best_ask(&self) -> Option<i64> {
        self.asks.keys().next().copied()
    }
    pub fn snapshot(&self, ts_ns: i64) -> BookSnapshot {
        BookSnapshot {
            ts_ns,
            bids: self.bids.iter().rev().map(|(p, q)| (*p, *q)).collect(),
            asks: self.asks.iter().map(|(p, q)| (*p, *q)).collect(),
        }
    }
    fn apply(&mut self, u: &DepthUpdate, out: &mut Vec<BookDelta>) {
        for &(px, qty) in &u.bids {
            if qty <= 0.0 {
                self.bids.remove(&px);
            } else {
                self.bids.insert(px, qty);
            }
            out.push(BookDelta {
                side: Side::Buy,
                px,
                qty: qty.max(0.0),
            });
        }
        for &(px, qty) in &u.asks {
            if qty <= 0.0 {
                self.asks.remove(&px);
            } else {
                self.asks.insert(px, qty);
            }
            out.push(BookDelta {
                side: Side::Sell,
                px,
                qty: qty.max(0.0),
            });
        }
    }
}

#[derive(Debug)]
pub struct BookSync {
    pub book: L2Book,
    synced_u: Option<u64>,
    buffer: Vec<DepthUpdate>,
    max_buffer: usize,
    pub gaps: u64,
}

impl Default for BookSync {
    fn default() -> Self {
        Self::new(10_000)
    }
}

impl BookSync {
    pub fn new(max_buffer: usize) -> Self {
        Self {
            book: L2Book::default(),
            synced_u: None,
            buffer: Vec::new(),
            max_buffer,
            gaps: 0,
        }
    }

    pub fn is_synced(&self) -> bool {
        self.synced_u.is_some()
    }

    pub fn on_update(&mut self, u: DepthUpdate) -> SyncOutcome {
        match self.synced_u {
            None => {
                if self.buffer.len() >= self.max_buffer {
                    self.buffer.remove(0);
                }
                self.buffer.push(u);
                SyncOutcome::Buffered
            }
            Some(last) => {
                if u.prev_final_id != last {
                    self.gaps += 1;
                    self.synced_u = None;
                    self.buffer.clear();
                    self.buffer.push(u);
                    return SyncOutcome::Gap;
                }
                let mut out = Vec::with_capacity(u.bids.len() + u.asks.len());
                self.book.apply(&u, &mut out);
                self.synced_u = Some(u.final_id);
                SyncOutcome::Applied(out)
            }
        }
    }

    pub fn on_snapshot(
        &mut self,
        last_update_id: u64,
        bids: Vec<(i64, f64)>,
        asks: Vec<(i64, f64)>,
        ts_ns: i64,
    ) -> SyncOutcome {
        self.book.bids = bids.into_iter().filter(|(_, q)| *q > 0.0).collect();
        self.book.asks = asks.into_iter().filter(|(_, q)| *q > 0.0).collect();
        let pending: Vec<DepthUpdate> = std::mem::take(&mut self.buffer)
            .into_iter()
            .filter(|u| u.final_id >= last_update_id)
            .collect();
        let mut last: Option<u64> = None;
        let mut scratch = Vec::new();
        for (i, u) in pending.into_iter().enumerate() {
            if i == 0 {
                if u.first_id > last_update_id {
                    // Snapshot is older than the stream we buffered: need a newer one.
                    self.gaps += 1;
                    self.synced_u = None;
                    self.buffer.push(u);
                    return SyncOutcome::Gap;
                }
            } else if Some(u.prev_final_id) != last {
                self.gaps += 1;
                self.synced_u = None;
                return SyncOutcome::Gap;
            }
            self.book.apply(&u, &mut scratch);
            last = Some(u.final_id);
        }
        self.synced_u = Some(last.unwrap_or(last_update_id));
        SyncOutcome::Synced(self.book.snapshot(ts_ns))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upd(
        first: u64,
        last: u64,
        prev: u64,
        bids: &[(i64, f64)],
        asks: &[(i64, f64)],
    ) -> DepthUpdate {
        DepthUpdate {
            first_id: first,
            final_id: last,
            prev_final_id: prev,
            event_ms: 0,
            bids: bids.to_vec(),
            asks: asks.to_vec(),
        }
    }

    #[test]
    fn syncs_from_buffer_and_snapshot() {
        let mut s = BookSync::default();
        assert_eq!(
            s.on_update(upd(90, 95, 89, &[(100, 1.0)], &[])),
            SyncOutcome::Buffered
        );
        assert_eq!(
            s.on_update(upd(96, 105, 95, &[(100, 2.0)], &[(102, 3.0)])),
            SyncOutcome::Buffered
        );
        assert_eq!(
            s.on_update(upd(106, 110, 105, &[(99, 4.0)], &[(102, 0.0)])),
            SyncOutcome::Buffered
        );
        // Snapshot at 100: first event (u=95) dropped, second straddles (96..105), third chains.
        let r = s.on_snapshot(
            100,
            vec![(100, 5.0), (98, 1.0)],
            vec![(101, 1.0), (102, 9.0)],
            0,
        );
        let SyncOutcome::Synced(snap) = r else {
            panic!("expected synced, got {r:?}")
        };
        assert_eq!(snap.bids, vec![(100, 2.0), (99, 4.0), (98, 1.0)]);
        assert_eq!(snap.asks, vec![(101, 1.0)]);
        assert!(s.is_synced());
        match s.on_update(upd(111, 112, 110, &[(100, 0.0)], &[])) {
            SyncOutcome::Applied(d) => assert_eq!(
                d,
                vec![BookDelta {
                    side: Side::Buy,
                    px: 100,
                    qty: 0.0
                }]
            ),
            other => panic!("{other:?}"),
        }
        assert_eq!(s.book.best_bid(), Some(99));
        assert_eq!(s.book.best_ask(), Some(101));
    }

    #[test]
    fn detects_gaps_and_stale_snapshots() {
        let mut s = BookSync::default();
        s.on_update(upd(50, 60, 49, &[], &[]));
        // Snapshot older than the buffered stream → Gap (refetch).
        assert_eq!(s.on_snapshot(40, vec![], vec![], 0), SyncOutcome::Gap);
        assert!(matches!(
            s.on_snapshot(55, vec![(1, 1.0)], vec![(2, 1.0)], 0),
            SyncOutcome::Synced(_)
        ));
        // Missing pu chain → Gap and the book is stale until the next snapshot.
        assert_eq!(s.on_update(upd(70, 80, 65, &[], &[])), SyncOutcome::Gap);
        assert!(!s.is_synced());
        assert_eq!(s.gaps, 2);
        assert!(matches!(
            s.on_snapshot(75, vec![], vec![], 0),
            SyncOutcome::Synced(_)
        ));
        assert!(matches!(
            s.on_update(upd(81, 85, 80, &[], &[])),
            SyncOutcome::Applied(_)
        ));
    }
}
