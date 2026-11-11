//! Token bucket per venue for REST calls: `capacity` requests may burst, then requests are
//! admitted at `capacity / per`. Callers wait (never fail) so a history backfill that pages many
//! times stays under the venue's public limit instead of getting the IP banned.
use std::sync::Mutex;
use std::time::Duration;

use tokio::time::Instant;

#[derive(Debug)]
pub struct TokenBucket {
    capacity: f64,
    per_sec: f64,
    state: Mutex<(f64, Instant)>,
}

impl TokenBucket {
    /// `capacity` requests per `per` (e.g. `new(20, Duration::from_secs(2))`).
    pub fn new(capacity: u32, per: Duration) -> Self {
        let capacity = f64::from(capacity.max(1));
        Self {
            capacity,
            per_sec: capacity / per.as_secs_f64().max(1e-3),
            state: Mutex::new((capacity, Instant::now())),
        }
    }

    /// Takes a token, or says how long to wait for the next one.
    pub fn try_acquire(&self) -> Result<(), Duration> {
        let mut s = self.state.lock().expect("bucket");
        let now = Instant::now();
        let refill = now.duration_since(s.1).as_secs_f64() * self.per_sec;
        s.0 = (s.0 + refill).min(self.capacity);
        s.1 = now;
        if s.0 >= 1.0 {
            s.0 -= 1.0;
            Ok(())
        } else {
            Err(Duration::from_secs_f64((1.0 - s.0) / self.per_sec))
        }
    }

    pub async fn acquire(&self) {
        while let Err(wait) = self.try_acquire() {
            tokio::time::sleep(wait).await;
        }
    }

    /// Tokens currently available (rounded down).
    pub fn available(&self) -> u32 {
        let s = self.state.lock().expect("bucket");
        let refill = Instant::now().duration_since(s.1).as_secs_f64() * self.per_sec;
        (s.0 + refill).min(self.capacity) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn bursts_then_throttles() {
        let b = TokenBucket::new(3, Duration::from_secs(1));
        for _ in 0..3 {
            assert!(b.try_acquire().is_ok());
        }
        let wait = b.try_acquire().unwrap_err();
        assert!(wait > Duration::from_millis(300) && wait <= Duration::from_millis(334));
        let t0 = Instant::now();
        b.acquire().await;
        b.acquire().await;
        // Two more tokens at 3/s take ~2/3 s.
        let took = t0.elapsed();
        assert!(took >= Duration::from_millis(600) && took < Duration::from_millis(700));
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert_eq!(b.available(), 3);
    }
}
