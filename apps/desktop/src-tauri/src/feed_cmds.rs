//! Real News / RSS / Economic Calendar data, fetched natively (the WebView's CSP blocks it).
//!
//! * `feed_fetch(url)` — RSS 2.0 / RSS 1.0 / Atom → typed, plain-text items. https only, 3 MB cap,
//!   15 s timeout, no cookies, host allow-list (built-in defaults + hosts the user added through
//!   `feed_allow_add`, persisted), redirects only to allow-listed https hosts. Every item is
//!   reduced to plain text (HTML tags / scripts / entities removed) and links are http(s) only, so
//!   the UI never receives raw HTML. Results are cached on disk and served (marked `stale`) when
//!   the network fails.
//! * `calendar_fetch()` — the public weekly economic-calendar JSON (no key), normalised to UTC
//!   events, cached on disk, polite minimum interval between network hits.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{CmdError, CmdResult};

const MAX_BYTES: usize = 3 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);
const USER_AGENT: &str = "HTFlow/0.1";
const SUMMARY_MAX: usize = 1200;
const TITLE_MAX: usize = 400;
const MAX_ITEMS: usize = 200;
/// A feed fetched less than this long ago is served from the disk cache unless `force` is set.
const MIN_REFETCH_SECS: i64 = 60;
/// The calendar source rate-limits aggressively: never hit it more often than this.
const CALENDAR_MIN_SECS: i64 = 15 * 60;
const MAX_USER_HOSTS: usize = 200;

/// Hosts of the built-in default feeds (each verified to answer with a valid feed).
pub const DEFAULT_FEED_HOSTS: &[&str] = &[
    "cointelegraph.com",
    "decrypt.co",
    "cryptoslate.com",
    "www.theblock.co",
    "www.coindesk.com",
    "blog.kraken.com",
    "www.federalreserve.gov",
    "www.ecb.europa.eu",
    "www.bankofengland.co.uk",
    "www.sec.gov",
    "www.cftc.gov",
    "www.eia.gov",
];

/// The public weekly calendar export (JSON, no key).
pub const CALENDAR_URL: &str = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const CALENDAR_HOST: &str = "nfs.faireconomy.media";

pub struct FeedState {
    dir: PathBuf,
    allow_path: PathBuf,
    user_hosts: Mutex<Vec<String>>,
    last_hit: Mutex<HashMap<String, i64>>,
}

impl FeedState {
    pub fn new(root: &Path) -> Self {
        let dir = root.join("cache").join("feeds");
        let allow_path = root.join("feed-hosts.json");
        let user_hosts = std::fs::read(&allow_path)
            .ok()
            .and_then(|b| serde_json::from_slice::<AllowFile>(&b).ok())
            .map(|f| {
                f.hosts
                    .into_iter()
                    .filter_map(|h| normalize_host(&h))
                    .take(MAX_USER_HOSTS)
                    .collect()
            })
            .unwrap_or_default();
        Self {
            dir,
            allow_path,
            user_hosts: Mutex::new(user_hosts),
            last_hit: Mutex::default(),
        }
    }

    fn hosts(&self) -> Vec<String> {
        let mut v: Vec<String> = DEFAULT_FEED_HOSTS.iter().map(|s| s.to_string()).collect();
        v.extend(
            self.user_hosts
                .lock()
                .map(|g| g.clone())
                .unwrap_or_default(),
        );
        v
    }

    fn persist_hosts(&self, hosts: &[String]) {
        let _ = std::fs::create_dir_all(self.allow_path.parent().unwrap_or(Path::new(".")));
        if let Ok(b) = serde_json::to_vec(&AllowFile {
            hosts: hosts.to_vec(),
        }) {
            let _ = std::fs::write(&self.allow_path, b);
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
struct AllowFile {
    #[serde(default)]
    hosts: Vec<String>,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// --------------------------------------------------------------------------- URL / host rules

fn normalize_host(h: &str) -> Option<String> {
    let h = h.trim().trim_end_matches('.').to_ascii_lowercase();
    let ok = !h.is_empty()
        && h.len() <= 253
        && h.contains('.')
        && h.split('.').all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
        && h.parse::<std::net::IpAddr>().is_err();
    ok.then_some(h)
}

/// https URL with a public DNS host (no credentials, no IP literal, not localhost).
fn validate_feed_url(raw: &str) -> CmdResult<(reqwest::Url, String)> {
    let url = reqwest::Url::parse(raw.trim())
        .map_err(|_| CmdError::new("feed.bad_url", "Not a valid URL"))?;
    if url.scheme() != "https" {
        return Err(CmdError::new(
            "feed.bad_url",
            "Only https:// feed URLs are allowed",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(CmdError::new(
            "feed.bad_url",
            "URLs with a user name or password are not allowed",
        ));
    }
    let host = url.host_str().and_then(normalize_host).ok_or_else(|| {
        CmdError::new("feed.bad_url", "The feed host must be a public domain name")
    })?;
    if crate::net_cmds::is_local_target(&url)
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        return Err(CmdError::new(
            "feed.bad_url",
            "Local network addresses are not allowed",
        ));
    }
    Ok((url, host))
}

// --------------------------------------------------------------------------- DTOs

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeedItemDto {
    pub guid: String,
    pub link: String,
    pub title: String,
    pub summary: String,
    /// Epoch ms, when the feed gives a date.
    pub published: Option<i64>,
    pub author: Option<String>,
    pub categories: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedResult {
    pub title: String,
    pub items: Vec<FeedItemDto>,
    /// Epoch ms of the network fetch these items came from.
    pub fetched_at: i64,
    pub from_cache: bool,
    /// The network failed and these are the last good items.
    pub stale: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEventDto {
    /// Epoch ms (UTC).
    pub t: i64,
    pub currency: String,
    pub title: String,
    /// "low" | "medium" | "high"
    pub impact: String,
    pub forecast: Option<String>,
    pub previous: Option<String>,
    pub actual: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarResult {
    pub events: Vec<CalendarEventDto>,
    pub fetched_at: i64,
    pub from_cache: bool,
    pub stale: bool,
    pub error: Option<String>,
    pub source_url: String,
}

// --------------------------------------------------------------------------- plain text

fn decode_entity(name: &str) -> Option<char> {
    match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" | "#39" => Some('\''),
        "nbsp" => Some(' '),
        "ndash" => Some('\u{2013}'),
        "mdash" => Some('\u{2014}'),
        "hellip" => Some('\u{2026}'),
        "lsquo" => Some('\u{2018}'),
        "rsquo" => Some('\u{2019}'),
        "ldquo" => Some('\u{201C}'),
        "rdquo" => Some('\u{201D}'),
        _ => {
            let n = name.strip_prefix('#')?;
            let cp = if let Some(h) = n.strip_prefix(['x', 'X']) {
                u32::from_str_radix(h, 16).ok()?
            } else {
                n.parse::<u32>().ok()?
            };
            char::from_u32(cp).filter(|c| !c.is_control() || c.is_whitespace())
        }
    }
}

/// HTML (or plain text) → single-spaced plain text of at most `max` characters. Tags are dropped,
/// `<script>` / `<style>` contents too, block tags become spaces, entities are decoded.
pub fn plain_text(input: &str, max: usize) -> String {
    let mut out = String::with_capacity(input.len().min(max * 2));
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    let lower_at = |i: usize, pat: &str| -> bool {
        let p: Vec<char> = pat.chars().collect();
        chars.len() >= i + p.len()
            && chars[i..i + p.len()]
                .iter()
                .zip(p.iter())
                .all(|(a, b)| a.to_ascii_lowercase() == *b)
    };
    while i < chars.len() && out.chars().count() < max * 2 {
        let c = chars[i];
        if c == '<' {
            let next = chars.get(i + 1).copied().unwrap_or(' ');
            if next.is_ascii_alphabetic() || next == '/' || next == '!' || next == '?' {
                // Skip raw-text elements entirely.
                let mut skipped = false;
                for tag in ["script", "style"] {
                    if lower_at(i + 1, tag) {
                        skipped = true;
                        let close = format!("</{tag}");
                        let mut j = i + 1;
                        while j < chars.len() && !lower_at(j, &close) {
                            j += 1;
                        }
                        while j < chars.len() && chars[j] != '>' {
                            j += 1;
                        }
                        i = j + 1;
                        out.push(' ');
                        break;
                    }
                }
                if skipped {
                    continue;
                }
                if lower_at(i, "<!--") {
                    let mut j = i + 4;
                    while j + 2 < chars.len()
                        && !(chars[j] == '-' && chars[j + 1] == '-' && chars[j + 2] == '>')
                    {
                        j += 1;
                    }
                    i = j + 3;
                    continue;
                }
                // Ordinary tag: skip to '>' (respecting quotes).
                let mut j = i + 1;
                let mut q: Option<char> = None;
                while j < chars.len() {
                    match (q, chars[j]) {
                        (None, '>') => break,
                        (None, '"' | '\'') => q = Some(chars[j]),
                        (Some(c2), c3) if c2 == c3 => q = None,
                        _ => {}
                    }
                    j += 1;
                }
                out.push(' ');
                i = j + 1;
                continue;
            }
        }
        if c == '&' {
            if let Some(end) = chars[i + 1..].iter().take(10).position(|&x| x == ';') {
                let name: String = chars[i + 1..i + 1 + end].iter().collect();
                if let Some(d) = decode_entity(&name) {
                    out.push(d);
                    i += end + 2;
                    continue;
                }
            }
        }
        out.push(if c.is_control() && !c.is_whitespace() {
            ' '
        } else {
            c
        });
        i += 1;
    }
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > max {
        let cut: String = collapsed.chars().take(max.saturating_sub(1)).collect();
        format!("{}\u{2026}", cut.trim_end())
    } else {
        collapsed
    }
}

/// Only absolute http(s) links without control characters survive.
pub fn safe_link(link: &str) -> String {
    let l = link.trim();
    let ok = (l.starts_with("https://") || l.starts_with("http://"))
        && l.len() > 8
        && l.len() < 2048
        && !l.chars().any(|c| c.is_control() || c.is_whitespace());
    if ok {
        l.to_string()
    } else {
        String::new()
    }
}

// --------------------------------------------------------------------------- feed parsing

/// Parses RSS / Atom bytes into sanitised items (newest first, capped).
pub fn parse_feed_bytes(bytes: &[u8]) -> Result<(String, Vec<FeedItemDto>), String> {
    let feed =
        feed_rs::parser::parse(bytes).map_err(|_| "Not a valid RSS / Atom feed".to_string())?;
    let title = feed
        .title
        .as_ref()
        .map(|t| plain_text(&t.content, TITLE_MAX))
        .unwrap_or_default();
    let mut items: Vec<FeedItemDto> = feed
        .entries
        .iter()
        .filter_map(|e| {
            let title = e
                .title
                .as_ref()
                .map(|t| plain_text(&t.content, TITLE_MAX))
                .unwrap_or_default();
            let link = e
                .links
                .iter()
                .find(|l| l.rel.as_deref().is_none_or(|r| r == "alternate"))
                .or_else(|| e.links.first())
                .map(|l| safe_link(&l.href))
                .unwrap_or_default();
            if title.is_empty() && link.is_empty() {
                return None;
            }
            let raw_summary = e
                .summary
                .as_ref()
                .map(|t| t.content.clone())
                .or_else(|| e.content.as_ref().and_then(|c| c.body.clone()))
                .unwrap_or_default();
            let published = e.published.or(e.updated).map(|d| d.timestamp_millis());
            let author = e
                .authors
                .first()
                .map(|a| plain_text(&a.name, 120))
                .filter(|a| !a.is_empty());
            let mut categories: Vec<String> = e
                .categories
                .iter()
                .map(|c| plain_text(c.label.as_deref().unwrap_or(&c.term), 60))
                .filter(|c| !c.is_empty())
                .collect();
            categories.dedup();
            categories.truncate(8);
            Some(FeedItemDto {
                guid: e.id.chars().take(512).collect(),
                link,
                title: if title.is_empty() {
                    "(untitled)".into()
                } else {
                    title
                },
                summary: plain_text(&raw_summary, SUMMARY_MAX),
                published,
                author,
                categories,
            })
        })
        .collect();
    items.sort_by_key(|i| std::cmp::Reverse(i.published.unwrap_or(0)));
    items.truncate(MAX_ITEMS);
    Ok((title, items))
}

// --------------------------------------------------------------------------- calendar parsing

#[derive(Deserialize)]
struct RawEvent {
    #[serde(default)]
    title: String,
    #[serde(default)]
    country: String,
    #[serde(default)]
    date: String,
    #[serde(default)]
    impact: String,
    #[serde(default)]
    forecast: Option<String>,
    #[serde(default)]
    previous: Option<String>,
    #[serde(default)]
    actual: Option<String>,
}

fn opt(v: Option<String>) -> Option<String> {
    v.map(|s| plain_text(&s, 40)).filter(|s| !s.is_empty())
}

/// Normalises the weekly calendar JSON array to UTC events sorted by time.
pub fn parse_calendar_json(bytes: &[u8]) -> Result<Vec<CalendarEventDto>, String> {
    let raw: Vec<RawEvent> =
        serde_json::from_slice(bytes).map_err(|_| "Not a valid calendar response".to_string())?;
    let mut out: Vec<CalendarEventDto> = raw
        .into_iter()
        .filter_map(|e| {
            let t = chrono::DateTime::parse_from_rfc3339(e.date.trim())
                .ok()?
                .timestamp_millis();
            let title = plain_text(&e.title, 160);
            if title.is_empty() {
                return None;
            }
            let impact = match e.impact.trim().to_ascii_lowercase().as_str() {
                "high" => "high",
                "medium" => "medium",
                _ => "low",
            };
            let cur = e.country.trim().to_ascii_uppercase();
            Some(CalendarEventDto {
                t,
                currency: if cur.len() <= 4 && cur.chars().all(|c| c.is_ascii_alphabetic()) {
                    cur
                } else {
                    String::new()
                },
                title,
                impact: impact.into(),
                forecast: opt(e.forecast),
                previous: opt(e.previous),
                actual: opt(e.actual),
            })
        })
        .collect();
    out.sort_by_key(|e| e.t);
    Ok(out)
}

// --------------------------------------------------------------------------- network + cache

fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf29ce484222325, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
    })
}

fn cache_file(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{:016x}.json", fnv(key)))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeedCache {
    url: String,
    title: String,
    fetched_at: i64,
    items: Vec<FeedItemDto>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarCache {
    fetched_at: i64,
    events: Vec<CalendarEventDto>,
}

fn read_json<T: for<'de> Deserialize<'de>>(p: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

fn write_json<T: Serialize>(p: &Path, v: &T) {
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if let Ok(b) = serde_json::to_vec(v) {
        let _ = std::fs::write(p, b);
    }
}

fn client(allowed: Vec<String>) -> CmdResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::custom(move |a| {
            let ok = a.url().scheme() == "https"
                && a.url()
                    .host_str()
                    .and_then(normalize_host)
                    .is_some_and(|h| allowed.contains(&h));
            if a.previous().len() > 5 {
                a.error("too many redirects")
            } else if !ok {
                a.error("redirect to a host that is not allowed")
            } else {
                a.follow()
            }
        }))
        .build()
        .map_err(|_| CmdError::new("feed.client", "Could not create HTTP client"))
}

async fn get_bytes(url: reqwest::Url, client: reqwest::Client) -> Result<Vec<u8>, String> {
    let net = |e: reqwest::Error| {
        if e.is_timeout() {
            "Timed out after 15 s".to_string()
        } else if e.is_connect() {
            "Could not connect".to_string()
        } else if e.is_redirect() {
            "Redirect to a host that is not allowed".to_string()
        } else {
            "Network error".to_string()
        }
    };
    let mut resp = client.get(url).send().await.map_err(net)?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    if resp.content_length().is_some_and(|l| l > MAX_BYTES as u64) {
        return Err("Response is larger than 3 MB".into());
    }
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(net)? {
        if buf.len() + chunk.len() > MAX_BYTES {
            return Err("Response is larger than 3 MB".into());
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

fn cached_result(c: FeedCache, stale: bool, error: Option<String>) -> FeedResult {
    FeedResult {
        title: c.title,
        items: c.items,
        fetched_at: c.fetched_at,
        from_cache: true,
        stale,
        error,
    }
}

/// Fetches one feed. `force` skips the 60 s disk-cache shortcut. On network / parse failure the
/// last good cache is returned with `stale = true`; with no cache the error is returned.
#[tauri::command]
pub async fn feed_fetch(
    state: State<'_, FeedState>,
    url: String,
    force: Option<bool>,
) -> CmdResult<FeedResult> {
    let (parsed, host) = validate_feed_url(&url)?;
    let hosts = state.hosts();
    if !hosts.contains(&host) {
        return Err(CmdError::new(
            "feed.host_not_allowed",
            format!("{host} is not on the feed allow-list; add the feed first"),
        ));
    }
    let file = cache_file(&state.dir, parsed.as_str());
    let cached: Option<FeedCache> =
        read_json::<FeedCache>(&file).filter(|c| c.url == parsed.as_str());
    let now = now_secs();
    if let Some(c) = &cached {
        if force != Some(true) && now - c.fetched_at / 1000 < MIN_REFETCH_SECS {
            return Ok(cached_result(
                FeedCache {
                    url: c.url.clone(),
                    title: c.title.clone(),
                    fetched_at: c.fetched_at,
                    items: c.items.clone(),
                },
                false,
                None,
            ));
        }
    }
    let fetched = match get_bytes(parsed.clone(), client(hosts)?).await {
        Ok(b) => parse_feed_bytes(&b),
        Err(e) => Err(e),
    };
    match fetched {
        Ok((title, items)) => {
            let c = FeedCache {
                url: parsed.to_string(),
                title,
                fetched_at: now * 1000,
                items,
            };
            write_json(&file, &c);
            Ok(FeedResult {
                title: c.title,
                items: c.items,
                fetched_at: c.fetched_at,
                from_cache: false,
                stale: false,
                error: None,
            })
        }
        Err(e) => match cached {
            Some(c) => Ok(cached_result(c, true, Some(e))),
            None => Err(CmdError::new("feed.fetch", e)),
        },
    }
}

/// Validates a feed URL and adds its host to the persisted allow-list. Returns the host.
#[tauri::command]
pub fn feed_allow_add(state: State<'_, FeedState>, url: String) -> CmdResult<String> {
    let (_, host) = validate_feed_url(&url)?;
    let mut g = state
        .user_hosts
        .lock()
        .map_err(|_| CmdError::new("feed.state", "Feed state is unavailable"))?;
    if !DEFAULT_FEED_HOSTS.contains(&host.as_str()) && !g.contains(&host) {
        if g.len() >= MAX_USER_HOSTS {
            return Err(CmdError::new("feed.too_many", "Too many custom feed hosts"));
        }
        g.push(host.clone());
        state.persist_hosts(&g);
    }
    Ok(host)
}

/// Removes a user-added host (built-in hosts cannot be removed).
#[tauri::command]
pub fn feed_allow_remove(state: State<'_, FeedState>, host: String) -> CmdResult<()> {
    let Some(h) = normalize_host(&host) else {
        return Ok(());
    };
    let mut g = state
        .user_hosts
        .lock()
        .map_err(|_| CmdError::new("feed.state", "Feed state is unavailable"))?;
    g.retain(|x| *x != h);
    state.persist_hosts(&g);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowList {
    pub defaults: Vec<String>,
    pub custom: Vec<String>,
    pub calendar_host: String,
    pub calendar_url: String,
}

#[tauri::command]
pub fn feed_allow_list(state: State<'_, FeedState>) -> AllowList {
    AllowList {
        defaults: DEFAULT_FEED_HOSTS.iter().map(|s| s.to_string()).collect(),
        custom: state
            .user_hosts
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default(),
        calendar_host: CALENDAR_HOST.into(),
        calendar_url: CALENDAR_URL.into(),
    }
}

/// The public economic calendar for the current week (UTC events), cached on disk. The source is
/// rate-limited, so the network is hit at most every 15 minutes; `force` only bypasses the cache
/// when it is older than that.
#[tauri::command]
pub async fn calendar_fetch(
    state: State<'_, FeedState>,
    force: Option<bool>,
) -> CmdResult<CalendarResult> {
    let file = state.dir.join("calendar.json");
    let cached: Option<CalendarCache> = read_json(&file);
    let now = now_secs();
    let result = |c: CalendarCache, stale: bool, error: Option<String>| CalendarResult {
        events: c.events,
        fetched_at: c.fetched_at,
        from_cache: true,
        stale,
        error,
        source_url: CALENDAR_URL.into(),
    };
    if let Some(c) = &cached {
        let age = now - c.fetched_at / 1000;
        let fresh = age < CALENDAR_MIN_SECS;
        let recently_tried = state
            .last_hit
            .lock()
            .ok()
            .and_then(|m| m.get("calendar").copied())
            .is_some_and(|t| now - t < CALENDAR_MIN_SECS);
        if fresh || (force != Some(true) && age < 6 * 3600 && recently_tried) {
            return Ok(result(
                CalendarCache {
                    fetched_at: c.fetched_at,
                    events: c.events.clone(),
                },
                false,
                None,
            ));
        }
    }
    if let Ok(mut m) = state.last_hit.lock() {
        m.insert("calendar".into(), now);
    }
    let url = reqwest::Url::parse(CALENDAR_URL)
        .map_err(|_| CmdError::new("feed.bad_url", "Bad calendar URL"))?;
    let fetched = match get_bytes(url, client(vec![CALENDAR_HOST.to_string()])?).await {
        Ok(b) => parse_calendar_json(&b),
        Err(e) => Err(e),
    };
    match fetched {
        Ok(events) if !events.is_empty() => {
            let c = CalendarCache {
                fetched_at: now * 1000,
                events,
            };
            write_json(&file, &c);
            Ok(CalendarResult {
                events: c.events,
                fetched_at: c.fetched_at,
                from_cache: false,
                stale: false,
                error: None,
                source_url: CALENDAR_URL.into(),
            })
        }
        other => {
            let e = other
                .err()
                .unwrap_or_else(|| "Empty calendar response".into());
            match cached {
                Some(c) => Ok(result(c, true, Some(e))),
                None => Err(CmdError::new("feed.fetch", e)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fx(name: &str) -> Vec<u8> {
        std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("fixtures")
                .join(name),
        )
        .unwrap()
    }

    #[test]
    fn parses_fed_rss_with_cdata_and_gmt_dates() {
        let (title, items) = parse_feed_bytes(&fx("fed_press.xml")).unwrap();
        assert!(title.contains("Press Release"));
        assert_eq!(items.len(), 3);
        for i in &items {
            assert!(i.link.starts_with("https://www.federalreserve.gov/"));
            assert!(!i.title.is_empty());
            assert!(i.published.is_some());
            assert!(!i.title.contains('<'));
        }
        // Newest first.
        assert!(items[0].published >= items[1].published);
    }

    #[test]
    fn parses_ecb_sec_and_cointelegraph() {
        for (f, host) in [
            ("ecb_press.xml", "ecb.europa.eu"),
            ("sec_press.xml", "sec.gov"),
            ("cointelegraph.xml", "cointelegraph.com"),
        ] {
            let (_, items) = parse_feed_bytes(&fx(f)).unwrap();
            assert!(!items.is_empty(), "{f}");
            assert!(
                items.iter().all(|i| i.link.contains(host)),
                "{f}: {items:?}"
            );
            assert!(items.iter().all(|i| !i.summary.contains('<')), "{f}");
            assert!(items
                .iter()
                .all(|i| i.summary.chars().count() <= SUMMARY_MAX));
        }
    }

    #[test]
    fn parses_atom() {
        let atom = r#"<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom &amp; Co</title>
<entry><title type="html">&lt;b&gt;Bold&lt;/b&gt; headline</title><id>urn:uuid:1</id>
<link rel="alternate" href="https://example.com/a"/><updated>2026-11-16T10:00:00Z</updated>
<summary type="html">&lt;p&gt;Hello &amp;amp; welcome&lt;script&gt;alert(1)&lt;/script&gt;&lt;/p&gt;</summary>
<author><name>Ann</name></author></entry></feed>"#;
        let (t, items) = parse_feed_bytes(atom.as_bytes()).unwrap();
        assert_eq!(t, "Atom & Co");
        assert_eq!(items[0].title, "Bold headline");
        assert_eq!(items[0].summary, "Hello & welcome");
        assert_eq!(items[0].author.as_deref(), Some("Ann"));
        assert_eq!(items[0].published, Some(1_794_823_200_000));
    }

    #[test]
    fn rejects_non_feed_and_html_error_pages() {
        assert!(parse_feed_bytes(b"<html><body>405</body></html>").is_err());
        assert!(parse_feed_bytes(b"").is_err());
    }

    #[test]
    fn plain_text_strips_markup_and_decodes_entities() {
        assert_eq!(
            plain_text(
                "<p>A&nbsp;<b>bold</b> &amp; &#x41;&#66; &lt;3</p><p>next</p>",
                100
            ),
            "A bold & AB <3 next"
        );
        assert_eq!(
            plain_text(
                "x<script>evil()</script><style>p{}</style>y<!-- c -->z",
                100
            ),
            "x yz"
        );
        assert_eq!(plain_text("<img src=\"a>b\" onerror=\"x()\">ok", 100), "ok");
        assert_eq!(plain_text("a < b and c > d", 100), "a < b and c > d");
        let long = "word ".repeat(500);
        let t = plain_text(&long, 50);
        assert!(t.chars().count() <= 50 && t.ends_with('\u{2026}'));
    }

    #[test]
    fn links_must_be_http_s() {
        assert_eq!(safe_link(" https://a.com/x "), "https://a.com/x");
        for bad in [
            "javascript:alert(1)",
            "data:text/html,x",
            "file:///etc/passwd",
            "//a.com",
            "https://",
            "https://a b.com",
        ] {
            assert_eq!(safe_link(bad), "", "{bad}");
        }
    }

    #[test]
    fn url_validation() {
        assert!(validate_feed_url("https://example.com/rss.xml").is_ok());
        for bad in [
            "http://example.com/rss",
            "ftp://example.com",
            "https://user:pw@example.com/",
            "https://127.0.0.1/rss",
            "https://[::1]/rss",
            "https://localhost/rss",
            "https://192.168.1.2/x",
            "https://printer.local/x",
            "https://intranet/rss",
            "file:///etc/passwd",
            "not a url",
        ] {
            assert!(validate_feed_url(bad).is_err(), "{bad}");
        }
        assert_eq!(
            validate_feed_url("https://Feeds.Example.COM./a").unwrap().1,
            "feeds.example.com"
        );
    }

    #[test]
    fn default_feed_hosts_are_valid() {
        for h in DEFAULT_FEED_HOSTS
            .iter()
            .chain(std::iter::once(&CALENDAR_HOST))
        {
            assert_eq!(normalize_host(h).as_deref(), Some(*h));
        }
    }

    #[test]
    fn calendar_json_is_normalised_to_utc() {
        let ev = parse_calendar_json(&fx("calendar_week.json")).unwrap();
        assert!(ev.len() >= 6);
        assert!(ev.windows(2).all(|w| w[0].t <= w[1].t));
        let first = &ev[0];
        // 2026-11-15T16:30:00-05:00 = 21:30 UTC.
        assert_eq!(first.title, "BusinessNZ Services Index");
        assert_eq!(first.currency, "NZD");
        assert_eq!(first.impact, "low");
        assert_eq!(first.previous.as_deref(), Some("50.9"));
        assert_eq!(first.forecast, None);
        assert_eq!(first.t, 1_794_778_200_000);
        assert!(ev.iter().any(|e| e.impact == "high"));
    }

    #[test]
    fn calendar_drops_bad_rows() {
        let j = br#"[{"title":"A","country":"USD","date":"nope","impact":"High"},
                     {"title":"","country":"USD","date":"2026-11-16T08:30:00-05:00","impact":"High"},
                     {"title":"<b>CPI</b>","country":"usd","date":"2026-11-16T08:30:00-05:00","impact":"Holiday","forecast":"0.3%","previous":"","actual":"0.4%"}]"#;
        let ev = parse_calendar_json(j).unwrap();
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].title, "CPI");
        assert_eq!(ev[0].currency, "USD");
        assert_eq!(ev[0].impact, "low");
        assert_eq!(ev[0].actual.as_deref(), Some("0.4%"));
        assert_eq!(ev[0].previous, None);
        assert!(parse_calendar_json(b"<html/>").is_err());
    }

    #[test]
    fn allow_list_persists_and_filters() {
        let dir = std::env::temp_dir().join(format!("htflow-feed-test-{}", now_secs()));
        let _ = std::fs::remove_dir_all(&dir);
        let st = FeedState::new(&dir);
        assert!(st.hosts().contains(&"www.sec.gov".to_string()));
        assert!(!st.hosts().contains(&"my.blog.example".to_string()));
        {
            let mut g = st.user_hosts.lock().unwrap();
            g.push("my.blog.example".into());
            st.persist_hosts(&g);
        }
        let again = FeedState::new(&dir);
        assert!(again.hosts().contains(&"my.blog.example".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_round_trip() {
        let dir = std::env::temp_dir().join(format!("htflow-feed-cache-{}", now_secs()));
        let f = cache_file(&dir, "https://a.com/rss");
        let c = FeedCache {
            url: "https://a.com/rss".into(),
            title: "T".into(),
            fetched_at: 5,
            items: vec![],
        };
        write_json(&f, &c);
        let back: FeedCache = read_json(&f).unwrap();
        assert_eq!(back.title, "T");
        assert_ne!(cache_file(&dir, "https://a.com/rss2"), f);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
