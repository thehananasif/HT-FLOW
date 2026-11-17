//! CFTC Commitments of Traders (free public reporting API, no key). The WebView cannot call it
//! (CSP `connect-src 'self'`), so the UI asks the core: https to `publicreporting.cftc.gov` only,
//! no redirects, 20 s timeout, 8 MB cap. Parsed weekly rows are cached on disk in the data
//! folder and refreshed once a week (reports publish on Friday).
use std::path::PathBuf;
use std::time::Duration;

use htflow_cot::{
    build_url, cache_path, is_allowed_url, is_fresh, parse_rows, read_cache, write_cache,
    CacheFile, CotError, CotRow, Report, MAX_BODY_BYTES,
};
use serde::Serialize;
use tauri::State;

use crate::error::{CmdError, CmdResult};

const TIMEOUT: Duration = Duration::from_secs(20);
const USER_AGENT: &str = "HTFlow/0.1";

pub struct CotState {
    dir: PathBuf,
}

impl CotState {
    pub fn new(cache_root: &std::path::Path) -> Self {
        Self {
            dir: cache_root.join("cot"),
        }
    }
}

impl From<CotError> for CmdError {
    fn from(e: CotError) -> Self {
        CmdError::new(e.code, e.message)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CotResult {
    pub rows: Vec<CotRow>,
    /// Unix ms the rows were downloaded.
    pub fetched_at: i64,
    /// `network` (just downloaded), `cache` (fresh cache) or `stale-cache` (download failed).
    pub source: &'static str,
    /// Why the download failed when `source` is `stale-cache`.
    pub warning: Option<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

async fn download(url: &str) -> CmdResult<String> {
    if !is_allowed_url(url) {
        return Err(CmdError::new(
            "cot.host_not_allowed",
            "Only https://publicreporting.cftc.gov can be contacted",
        ));
    }
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| CmdError::new("cot.client", "Could not create HTTP client"))?;
    let net = |e: reqwest::Error| {
        CmdError::new(
            "cot.network",
            if e.is_timeout() {
                "Timed out after 20 s"
            } else if e.is_connect() {
                "Could not connect to the CFTC"
            } else {
                "Network error"
            },
        )
    };
    let mut resp = client.get(url).send().await.map_err(net)?;
    if !resp.status().is_success() {
        return Err(CmdError::new(
            "cot.http",
            format!("CFTC API answered HTTP {}", resp.status().as_u16()),
        ));
    }
    if resp
        .content_length()
        .is_some_and(|l| l > MAX_BODY_BYTES as u64)
    {
        return Err(CmdError::new(
            "cot.too_large",
            "Response is larger than 8 MB",
        ));
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(net)? {
        if buf.len() + chunk.len() > MAX_BODY_BYTES {
            return Err(CmdError::new(
                "cot.too_large",
                "Response is larger than 8 MB",
            ));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Weekly COT rows (oldest first) for one contract market since `from_date` (`YYYY-MM-DD`).
/// `report` is `legacy`, `disagg` or `tff`; `market_code` is the CFTC contract market code
/// (`13874A` = E-mini S&P 500). Serves the disk cache while it is newer than the latest Friday
/// release (unless `force`); when the download fails, an older cache is returned as `stale-cache`.
#[tauri::command]
pub async fn cot_fetch(
    state: State<'_, CotState>,
    report: String,
    market_code: String,
    from_date: String,
    force: Option<bool>,
) -> CmdResult<CotResult> {
    let rep = Report::parse(&report)?;
    let url = build_url(rep, &market_code, &from_date)?;
    let path = cache_path(&state.dir, rep, &market_code)?;
    let cached = read_cache(&path);
    let now = now_ms();
    if let Some(c) = &cached {
        if !force.unwrap_or(false) && is_fresh(c, &from_date, now) {
            return Ok(CotResult {
                rows: c.rows.clone(),
                fetched_at: c.fetched_at,
                source: "cache",
                warning: None,
            });
        }
    }
    let fetched = async {
        let body = download(&url).await?;
        Ok::<_, CmdError>(parse_rows(rep, &body)?)
    }
    .await;
    match fetched {
        Ok(rows) => {
            let file = CacheFile {
                fetched_at: now,
                from_date,
                rows,
            };
            if let Err(e) = write_cache(&path, &file) {
                tracing::warn!(error = %e, "COT cache write failed");
            }
            Ok(CotResult {
                rows: file.rows,
                fetched_at: now,
                source: "network",
                warning: None,
            })
        }
        Err(e) => match cached {
            Some(c) => Ok(CotResult {
                rows: c.rows,
                fetched_at: c.fetched_at,
                source: "stale-cache",
                warning: Some(e.message),
            }),
            None => Err(e),
        },
    }
}
