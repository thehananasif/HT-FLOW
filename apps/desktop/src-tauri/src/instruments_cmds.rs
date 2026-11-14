//! Live symbol discovery (P04/P05): every tradable instrument of every crypto venue, from each
//! connector's public exchange-info endpoint.
//!
//! * `instruments_cached` returns the on-disk list at once (`<data>/cache/instruments.json`),
//!   flagged `stale` after 24 h, so the UI starts with the full list and refreshes in the
//!   background.
//! * `instruments_list(venue?, refresh?)` fetches every source (or the ones whose id starts with
//!   `venue`) in parallel, 10 s timeout each. A failing source is reported in its row and keeps
//!   its previous instruments; it never fails the whole call.
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::future::join_all;
use htflow_connector_binance::Market;
use htflow_connector_bybit::instruments::Category;
use htflow_connector_common::{ConnectorError, InstrumentInfo};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{CmdError, CmdResult};

/// The cached list is refreshed in the background once it is older than this.
pub const MAX_AGE_MS: i64 = 24 * 3_600_000;
/// Per-source request budget.
pub const SOURCE_TIMEOUT: Duration = Duration::from_secs(10);

/// Discovery sources: `(id, label)`. Ids are feed provider ids where the source maps onto one.
pub const SOURCES: &[(&str, &str)] = &[
    ("binance-futures", "Binance USDⓈ-M futures"),
    ("binance-coinm", "Binance COIN-M futures"),
    ("binance-spot", "Binance spot"),
    ("bybit-linear", "Bybit linear"),
    ("bybit-inverse", "Bybit inverse"),
    ("bybit-spot", "Bybit spot"),
    ("okx-swap", "OKX perpetual swaps"),
    ("okx-futures", "OKX futures"),
    ("okx-spot", "OKX spot"),
    ("deribit", "Deribit futures"),
    ("bitget", "Bitget futures"),
    ("kraken-futures", "Kraken Futures"),
    ("bitfinex", "Bitfinex"),
    ("phemex", "Phemex perpetuals"),
    ("whitebit", "WhiteBIT"),
];

/// One source's last result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceListing {
    pub id: String,
    pub label: String,
    /// The last refresh of this source succeeded.
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// When `instruments` were fetched (0 = never).
    pub fetched_at_ms: i64,
    pub count: usize,
    /// Listed options (Deribit), counted only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options_count: Option<usize>,
    pub instruments: Vec<InstrumentInfo>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentsReport {
    /// Last full refresh (every source attempted).
    pub refreshed_at_ms: i64,
    /// Older than [`MAX_AGE_MS`] or never refreshed (computed on read).
    #[serde(default)]
    pub stale: bool,
    pub sources: Vec<SourceListing>,
}

/// Outcome of fetching one source.
pub type Fetched = Result<(Vec<InstrumentInfo>, Option<usize>), String>;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Sources a `venue` filter selects: all for `None`, else ids equal to or starting with it.
pub fn select(venue: Option<&str>) -> CmdResult<Vec<(&'static str, &'static str)>> {
    let Some(v) = venue.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(SOURCES.to_vec());
    };
    let v = v.to_lowercase();
    let picked: Vec<_> = SOURCES
        .iter()
        .copied()
        .filter(|(id, _)| *id == v || id.starts_with(&format!("{v}-")))
        .collect();
    if picked.is_empty() {
        return Err(CmdError::new(
            "instruments.venue",
            format!("No symbol list for venue '{v}'"),
        ));
    }
    Ok(picked)
}

/// Folds fresh results into the previous listing: successes replace a source, failures keep
/// its previous instruments (flagged with the error). Rows follow [`SOURCES`] order.
pub fn merge(
    old: &[SourceListing],
    fresh: Vec<(&str, &str, Fetched)>,
    now: i64,
) -> Vec<SourceListing> {
    let mut out: Vec<SourceListing> = old.to_vec();
    for (id, label, res) in fresh {
        let prev = out.iter().position(|s| s.id == id);
        let row = match res {
            Ok((instruments, options_count)) => SourceListing {
                id: id.into(),
                label: label.into(),
                ok: true,
                error: None,
                fetched_at_ms: now,
                count: instruments.len(),
                options_count,
                instruments,
            },
            Err(e) => match prev.map(|i| out[i].clone()) {
                Some(p) => SourceListing {
                    ok: false,
                    error: Some(e),
                    ..p
                },
                None => SourceListing {
                    id: id.into(),
                    label: label.into(),
                    ok: false,
                    error: Some(e),
                    fetched_at_ms: 0,
                    count: 0,
                    options_count: None,
                    instruments: Vec::new(),
                },
            },
        };
        match prev {
            Some(i) => out[i] = row,
            None => out.push(row),
        }
    }
    let rank = |id: &str| {
        SOURCES
            .iter()
            .position(|(s, _)| *s == id)
            .unwrap_or(usize::MAX)
    };
    out.sort_by_key(|s| rank(&s.id));
    out
}

pub fn is_stale(r: &InstrumentsReport, now: i64) -> bool {
    r.refreshed_at_ms <= 0 || now - r.refreshed_at_ms > MAX_AGE_MS || r.sources.is_empty()
}

fn text(e: ConnectorError) -> String {
    e.to_string()
}

/// Fetches one source from the live venue.
async fn fetch(id: &str) -> Fetched {
    use htflow_connector_binance::instruments as binance;
    use htflow_connector_bybit::instruments as bybit;
    use htflow_connector_okx::instruments as okx;
    let rows = match id {
        "binance-futures" => binance::list_instruments(Market::UsdM).await,
        "binance-coinm" => binance::list_instruments(Market::CoinM).await,
        "binance-spot" => binance::list_instruments(Market::Spot).await,
        "bybit-linear" => bybit::list_instruments(Category::Linear).await,
        "bybit-inverse" => bybit::list_instruments(Category::Inverse).await,
        "bybit-spot" => bybit::list_instruments(Category::Spot).await,
        "okx-swap" => okx::list_instruments("SWAP").await,
        "okx-futures" => okx::list_instruments("FUTURES").await,
        "okx-spot" => okx::list_instruments("SPOT").await,
        "deribit" => {
            let (futures, options) = tokio::join!(
                htflow_connector_deribit::instruments::list_instruments(),
                htflow_connector_deribit::instruments::count_options()
            );
            return Ok((futures.map_err(text)?, options.ok()));
        }
        "bitget" => htflow_connector_bitget::instruments::list_instruments().await,
        "kraken-futures" => htflow_connector_kraken::instruments::list_instruments().await,
        "bitfinex" => htflow_connector_bitfinex::instruments::list_instruments().await,
        "phemex" => htflow_connector_phemex::instruments::list_instruments().await,
        "whitebit" => htflow_connector_whitebit::instruments::list_instruments().await,
        other => return Err(format!("unknown source {other}")),
    };
    rows.map(|r| (r, None)).map_err(text)
}

async fn fetch_all(
    sources: &[(&'static str, &'static str)],
) -> Vec<(&'static str, &'static str, Fetched)> {
    join_all(sources.iter().map(|&(id, label)| async move {
        let res = match tokio::time::timeout(SOURCE_TIMEOUT, fetch(id)).await {
            Ok(r) => r,
            Err(_) => Err(format!("timed out after {} s", SOURCE_TIMEOUT.as_secs())),
        };
        if let Err(e) = &res {
            tracing::warn!(source = id, error = %e, "symbol discovery failed");
        }
        (id, label, res)
    }))
    .await
}

/// On-disk cache of the last discovery (one JSON file).
pub struct InstrumentsState {
    path: PathBuf,
    lock: tokio::sync::Mutex<()>,
}

impl InstrumentsState {
    pub fn new(cache_dir: &Path) -> Self {
        Self {
            path: cache_dir.join("instruments.json"),
            lock: tokio::sync::Mutex::new(()),
        }
    }

    pub fn load(&self) -> InstrumentsReport {
        std::fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, r: &InstrumentsReport) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(r)?)?;
        std::fs::rename(&tmp, &self.path)
    }

    fn with_stale(&self, mut r: InstrumentsReport) -> InstrumentsReport {
        r.stale = is_stale(&r, now_ms());
        r
    }
}

/// The cached list as it is (no network); `stale` tells the UI to refresh in the background.
#[tauri::command]
pub async fn instruments_cached(
    state: State<'_, InstrumentsState>,
) -> CmdResult<InstrumentsReport> {
    let _g = state.lock.lock().await;
    Ok(state.with_stale(state.load()))
}

/// Every instrument of every venue (or of the sources `venue` selects). Served from the cache
/// while it is younger than 24 h unless `refresh`; per-source failures are reported, not fatal.
#[tauri::command]
pub async fn instruments_list(
    state: State<'_, InstrumentsState>,
    venue: Option<String>,
    refresh: Option<bool>,
) -> CmdResult<InstrumentsReport> {
    let sources = select(venue.as_deref())?;
    let _g = state.lock.lock().await;
    let cached = state.load();
    let now = now_ms();
    let have_all = sources
        .iter()
        .all(|(id, _)| cached.sources.iter().any(|s| s.id == *id));
    if !refresh.unwrap_or(false) && !is_stale(&cached, now) && have_all {
        return Ok(state.with_stale(cached));
    }
    let fresh = fetch_all(&sources).await;
    let mut report = InstrumentsReport {
        refreshed_at_ms: cached.refreshed_at_ms,
        stale: false,
        sources: merge(&cached.sources, fresh, now),
    };
    if sources.len() == SOURCES.len() {
        report.refreshed_at_ms = now;
    }
    if let Err(e) = state.save(&report) {
        tracing::warn!(error = %e, "could not save the symbol list cache");
    }
    Ok(state.with_stale(report))
}

#[cfg(test)]
mod tests {
    use super::*;
    use htflow_connector_common::{MarketKind, RawSpec};

    fn row(venue: &str, symbol: &str) -> InstrumentInfo {
        InstrumentInfo::new(
            venue,
            MarketKind::Perp,
            symbol,
            "BTC",
            "USDT",
            "",
            false,
            RawSpec {
                tick: "0.1",
                step: "0.001",
                min_qty: "",
            },
            1.0,
            None,
        )
        .unwrap()
    }

    #[test]
    fn selects_sources() {
        assert_eq!(select(None).unwrap().len(), SOURCES.len());
        let b: Vec<_> = select(Some("binance"))
            .unwrap()
            .iter()
            .map(|s| s.0)
            .collect();
        assert_eq!(b, ["binance-futures", "binance-coinm", "binance-spot"]);
        assert_eq!(select(Some("deribit")).unwrap().len(), 1);
        assert_eq!(select(Some("OKX")).unwrap().len(), 3);
        assert!(select(Some("nasdaq")).is_err());
    }

    #[test]
    fn failures_keep_the_previous_list() {
        let first = merge(
            &[],
            vec![
                (
                    "okx-swap",
                    "OKX",
                    Ok((vec![row("okx-swap", "BTC-USDT-SWAP")], None)),
                ),
                (
                    "binance-futures",
                    "Binance",
                    Ok((vec![row("binance-futures", "BTCUSDT")], None)),
                ),
                ("deribit", "Deribit", Err("HTTP 503".into())),
            ],
            1_000,
        );
        // SOURCES order, the failure is reported with an empty list.
        let ids: Vec<&str> = first.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["binance-futures", "okx-swap", "deribit"]);
        assert!(!first[2].ok && first[2].count == 0);
        assert_eq!(first[2].error.as_deref(), Some("HTTP 503"));

        let second = merge(
            &first,
            vec![
                (
                    "binance-futures",
                    "Binance",
                    Err("timed out after 10 s".into()),
                ),
                (
                    "deribit",
                    "Deribit",
                    Ok((vec![row("deribit", "BTC-PERPETUAL")], Some(42))),
                ),
            ],
            2_000,
        );
        let bin = &second[0];
        assert!(!bin.ok);
        assert_eq!(
            (bin.count, bin.fetched_at_ms),
            (1, 1_000),
            "old symbols kept"
        );
        assert_eq!(bin.instruments[0].symbol, "BTCUSDT");
        let der = second.iter().find(|s| s.id == "deribit").unwrap();
        assert!(der.ok && der.error.is_none());
        assert_eq!(
            (der.count, der.options_count, der.fetched_at_ms),
            (1, Some(42), 2_000)
        );
        assert_eq!(second[1], first[1], "untouched sources unchanged");
    }

    #[test]
    fn cache_round_trip_and_staleness() {
        let dir = std::env::temp_dir().join(format!("htflow-instr-{}", std::process::id()));
        let st = InstrumentsState::new(&dir);
        assert_eq!(st.load(), InstrumentsReport::default());
        assert!(is_stale(&st.load(), 5));
        let r = InstrumentsReport {
            refreshed_at_ms: 10_000,
            stale: false,
            sources: merge(
                &[],
                vec![(
                    "whitebit",
                    "WhiteBIT",
                    Ok((vec![row("whitebit", "BTC_PERP")], None)),
                )],
                10_000,
            ),
        };
        st.save(&r).unwrap();
        let back = st.load();
        assert_eq!(back, r);
        assert!(!is_stale(&back, 10_000 + MAX_AGE_MS));
        assert!(is_stale(&back, 10_001 + MAX_AGE_MS));
        let js = serde_json::to_string(&back).unwrap();
        assert!(js.contains("\"refreshedAtMs\":10000") && js.contains("\"fetchedAtMs\""));
        std::fs::remove_dir_all(&dir).ok();
    }
}
