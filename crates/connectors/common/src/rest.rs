//! REST client shared by the venue crates: one token bucket and one clock per venue.
//!
//! Rate limits: every request first takes a token from the venue bucket; an HTTP 429 (or 418 /
//! 503 with `Retry-After`) answer is retried after the server's `Retry-After` (or an exponential
//! 1 s → 8 s wait) up to [`MAX_RETRIES`] times, and counted in [`Rest::throttled`] so long
//! history downloads can tell the user they are being slowed down.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;

use crate::clock::ClockSkew;
use crate::driver::Probe;
use crate::ratelimit::TokenBucket;
use crate::util::{now_ns, parse_http_date_ms};
use crate::{ConnectorError, Result};

/// Retries of a rate-limited request before the error is returned.
pub const MAX_RETRIES: u32 = 4;
/// Longest `Retry-After` honoured; a longer ban (Binance 418) fails right away.
pub const MAX_RETRY_WAIT: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct Rest {
    http: reqwest::Client,
    pub base: String,
    pub limiter: Arc<TokenBucket>,
    pub clock: Arc<ClockSkew>,
    /// Rate-limited answers (429 / 418 / 503) seen so far.
    pub throttled: Arc<AtomicU64>,
}

/// How long to wait before retrying a rate-limited answer, or `None` when it is not one.
pub fn retry_wait(status: u16, retry_after: Option<&str>, attempt: u32) -> Option<Duration> {
    if !matches!(status, 429 | 418 | 503) {
        return None;
    }
    let server = retry_after
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|s| s.is_finite() && *s >= 0.0)
        .map(Duration::from_secs_f64);
    if status == 503 && server.is_none() {
        return None; // plain outage, not a throttle
    }
    let wait = server.unwrap_or_else(|| Duration::from_secs(1u64 << attempt.min(3)));
    (wait <= MAX_RETRY_WAIT).then_some(wait)
}

impl Rest {
    pub fn new(base: impl Into<String>, limiter: TokenBucket) -> Self {
        Self::with_timeout(base, limiter, Duration::from_secs(15))
    }

    /// Same as [`Rest::new`] with another whole-request timeout (large exchange-info bodies).
    pub fn with_timeout(base: impl Into<String>, limiter: TokenBucket, timeout: Duration) -> Self {
        let http = reqwest::Client::builder()
            .user_agent("HTFlow/0.1")
            .timeout(timeout)
            .build()
            .expect("reqwest client");
        Self {
            http,
            base: base.into(),
            limiter: Arc::new(limiter),
            clock: Arc::new(ClockSkew::default()),
            throttled: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Rate-limited answers seen so far.
    pub fn throttled_count(&self) -> u64 {
        self.throttled.load(Ordering::Relaxed)
    }

    /// GET `base + path` after taking a rate-limit token. Rate-limited answers are retried (see
    /// the module docs); other non-2xx answers become `ConnectorError::Api("HTTP 404: …")` with
    /// the start of the body.
    pub async fn get_text(&self, path: &str) -> Result<String> {
        let mut attempt = 0;
        loop {
            self.limiter.acquire().await;
            let r = self
                .http
                .get(format!("{}{}", self.base, path))
                .send()
                .await?;
            if let Some(d) = r
                .headers()
                .get(reqwest::header::DATE)
                .and_then(|v| v.to_str().ok())
                .and_then(parse_http_date_ms)
            {
                self.clock.record_coarse(d, now_ns());
            }
            let status = r.status();
            let retry_after = r
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let body = r.text().await?;
            if status.is_success() {
                return Ok(body);
            }
            let wait = retry_wait(status.as_u16(), retry_after.as_deref(), attempt);
            if let Some(wait) = wait {
                self.throttled.fetch_add(1, Ordering::Relaxed);
                if attempt < MAX_RETRIES {
                    tracing::warn!(
                        status = status.as_u16(),
                        ?wait,
                        path,
                        "rate limited; retrying"
                    );
                    tokio::time::sleep(wait).await;
                    attempt += 1;
                    continue;
                }
            }
            let snippet: String = body.chars().take(200).collect();
            return Err(ConnectorError::Api(format!(
                "HTTP {}: {snippet}",
                status.as_u16()
            )));
        }
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        Ok(serde_json::from_str(&self.get_text(path).await?)?)
    }

    /// Measures the server clock with a time endpoint; `extract` reads ms from the body.
    pub async fn probe_time(&self, path: &str, extract: fn(&str) -> Option<i64>) -> Result<i64> {
        let sent = now_ns();
        let text = self.get_text(path).await?;
        let recv = now_ns();
        let ms = extract(&text)
            .ok_or_else(|| ConnectorError::Other(format!("no server time in {path}")))?;
        self.clock.record(sent, ms, recv);
        Ok(ms)
    }

    /// A driver probe that measures the clock with [`Rest::probe_time`].
    pub fn time_probe(
        &self,
        path: impl Into<String>,
        extract: fn(&str) -> Option<i64>,
    ) -> Probe<i64> {
        let me = self.clone();
        let path: Arc<str> = path.into().into();
        Arc::new(move || {
            let (me, path) = (me.clone(), Arc::clone(&path));
            Box::pin(async move { me.probe_time(&path, extract).await })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock_http::{MockServer, Reply};
    use std::sync::atomic::AtomicU32;

    #[test]
    fn retry_waits() {
        assert_eq!(retry_wait(200, None, 0), None);
        assert_eq!(retry_wait(404, Some("1"), 0), None);
        assert_eq!(retry_wait(429, Some("2"), 0), Some(Duration::from_secs(2)));
        assert_eq!(retry_wait(429, None, 0), Some(Duration::from_secs(1)));
        assert_eq!(retry_wait(429, None, 2), Some(Duration::from_secs(4)));
        assert_eq!(retry_wait(429, None, 9), Some(Duration::from_secs(8)));
        assert_eq!(retry_wait(503, None, 0), None);
        assert_eq!(retry_wait(503, Some("0"), 0), Some(Duration::ZERO));
        // An IP ban longer than a minute is not waited out.
        assert_eq!(retry_wait(418, Some("3600"), 0), None);
    }

    #[tokio::test]
    async fn retries_rate_limited_requests() {
        let hits = Arc::new(AtomicU32::new(0));
        let h = hits.clone();
        let srv = MockServer::start(move |_| {
            if h.fetch_add(1, Ordering::SeqCst) < 2 {
                Reply::status("429 Too Many Requests", "{}").header("Retry-After: 0")
            } else {
                Reply::ok("[1,2]")
            }
        });
        let rest = Rest::new(&srv.base, TokenBucket::new(100, Duration::from_secs(1)));
        let v: Vec<i32> = rest.get("/x?a=1").await.unwrap();
        assert_eq!(v, vec![1, 2]);
        assert_eq!(rest.throttled_count(), 2);
        assert_eq!(srv.requests(), vec!["/x?a=1"; 3]);

        let srv = MockServer::start(|_| Reply::status("404 Not Found", "nope"));
        let rest = Rest::new(&srv.base, TokenBucket::new(100, Duration::from_secs(1)));
        let e = rest.get_text("/y").await.unwrap_err().to_string();
        assert_eq!(e, "HTTP 404: nope");
        assert_eq!(rest.throttled_count(), 0);
    }
}
