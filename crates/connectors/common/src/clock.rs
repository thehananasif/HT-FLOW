//! Clock-skew correction: the venue's server time is measured at connect (a REST time call,
//! half the round trip assumed for the request leg) and every receive timestamp is shifted into
//! the exchange clock, so `latency = local_recv − exchange_ts` is not polluted by a wrong PC clock.
//! The HTTP `Date` header (1 s resolution) is used as a coarse fallback for venues without a
//! time endpoint; it only applies when the offset is larger than its own error (> 1 s).
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

use crate::util::now_ns;

#[derive(Debug, Default)]
pub struct ClockSkew {
    offset_ns: AtomicI64,
    rtt_ns: AtomicI64,
    precise: AtomicBool,
}

impl ClockSkew {
    /// A precise sample: `server_ms` was read between `sent_ns` and `recv_ns` (local clock).
    /// The sample with the shortest round trip wins (least uncertainty); samples older than a
    /// worse one are still accepted after the RTT doubles, so the offset can follow drift.
    pub fn record(&self, sent_ns: i64, server_ms: i64, recv_ns: i64) {
        let rtt = (recv_ns - sent_ns).max(0);
        let best = self.rtt_ns.load(Ordering::Relaxed);
        if self.precise.load(Ordering::Relaxed) && rtt > best.saturating_mul(2) {
            return;
        }
        let mid = sent_ns + rtt / 2;
        self.offset_ns
            .store(server_ms * 1_000_000 - mid, Ordering::Relaxed);
        self.rtt_ns.store(rtt, Ordering::Relaxed);
        self.precise.store(true, Ordering::Relaxed);
    }

    /// A coarse sample from an HTTP `Date` header (second resolution).
    pub fn record_coarse(&self, server_ms: i64, recv_ns: i64) {
        if self.precise.load(Ordering::Relaxed) {
            return;
        }
        // The header truncates to the second: the true server time is ~0.5 s later on average.
        let off = server_ms * 1_000_000 + 500_000_000 - recv_ns;
        let off = if off.abs() > 1_000_000_000 { off } else { 0 };
        self.offset_ns.store(off, Ordering::Relaxed);
    }

    /// Server − local, in ms.
    pub fn offset_ms(&self) -> f64 {
        self.offset_ns.load(Ordering::Relaxed) as f64 / 1e6
    }

    pub fn is_precise(&self) -> bool {
        self.precise.load(Ordering::Relaxed)
    }

    /// The local clock shifted into the exchange clock.
    pub fn now_ns(&self) -> i64 {
        now_ns() + self.offset_ns.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_offset() {
        let c = ClockSkew::default();
        // Local clock 2 s behind: request sent at 0, answered at 100 ms, server said 2 050 ms.
        c.record(0, 2_050, 100_000_000);
        assert_eq!(c.offset_ms(), 2_000.0);
        // A noisier sample (much longer RTT) is ignored.
        c.record(0, 9_000, 900_000_000);
        assert_eq!(c.offset_ms(), 2_000.0);
        // Coarse samples never override a precise one.
        c.record_coarse(99_000, 0);
        assert_eq!(c.offset_ms(), 2_000.0);

        let d = ClockSkew::default();
        d.record_coarse(10_000, 10_000_000_000); // within the header's resolution → 0
        assert_eq!(d.offset_ms(), 0.0);
        d.record_coarse(15_000, 10_000_000_000); // 5.5 s ahead
        assert_eq!(d.offset_ms(), 5_500.0);
        assert!(!d.is_precise());
    }
}
