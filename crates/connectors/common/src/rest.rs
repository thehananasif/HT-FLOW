//! REST client shared by the venue crates: one token bucket and one clock per venue.
use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;

use crate::clock::ClockSkew;
use crate::driver::Probe;
use crate::ratelimit::TokenBucket;
use crate::util::{now_ns, parse_http_date_ms};
use crate::{ConnectorError, Result};

#[derive(Clone)]
pub struct Rest {
    http: reqwest::Client,
    pub base: String,
    pub limiter: Arc<TokenBucket>,
    pub clock: Arc<ClockSkew>,
}

impl Rest {
    pub fn new(base: impl Into<String>, limiter: TokenBucket) -> Self {
        let http = reqwest::Client::builder()
            .user_agent("HTFlow/0.1")
            .timeout(Duration::from_secs(15))
            .build()
            .expect("reqwest client");
        Self {
            http,
            base: base.into(),
            limiter: Arc::new(limiter),
            clock: Arc::new(ClockSkew::default()),
        }
    }

    /// GET `base + path` after taking a rate-limit token. Non-2xx answers become
    /// `ConnectorError::Api("HTTP 429: …")` with the start of the body.
    pub async fn get_text(&self, path: &str) -> Result<String> {
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
        let body = r.text().await?;
        if !status.is_success() {
            let snippet: String = body.chars().take(200).collect();
            return Err(ConnectorError::Api(format!(
                "HTTP {}: {snippet}",
                status.as_u16()
            )));
        }
        Ok(body)
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
