//! CFTC Commitments of Traders (COT) from the free public reporting API (Socrata / SoQL, no key).
//!
//! This crate is pure logic: it builds the query URL, parses the JSON into typed weekly rows and
//! keeps the on-disk cache. The HTTP request itself lives in the desktop app (`cot_cmds.rs`).
//!
//! Datasets (all futures-only, one row per contract market per report date):
//! * Legacy: `6dca-aqww` (commercial / non-commercial / non-reportable)
//! * Disaggregated: `72hh-3qpy` (producer / swap dealer / managed money / other / non-reportable);
//!   physical commodities only, so financial futures such as the E-mini S&P have no rows
//! * TFF (Traders in Financial Futures): `gpe5-46if` (dealer / asset manager / leveraged funds /
//!   other / non-reportable); financial futures only

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The only host this crate builds URLs for (and the only one the app may contact).
pub const CFTC_HOST: &str = "publicreporting.cftc.gov";
/// Hard cap on the response body the app accepts.
pub const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
/// Upper bound of rows requested (weekly data: about 40 years).
pub const MAX_ROWS: u32 = 3000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Report {
    Legacy,
    Disagg,
    Tff,
}

impl Report {
    pub fn parse(s: &str) -> Result<Self, CotError> {
        match s {
            "legacy" => Ok(Self::Legacy),
            "disagg" => Ok(Self::Disagg),
            "tff" => Ok(Self::Tff),
            _ => Err(CotError::new("cot.bad_report", "Unknown COT report type")),
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Self::Legacy => "legacy",
            Self::Disagg => "disagg",
            Self::Tff => "tff",
        }
    }
    pub fn dataset(self) -> &'static str {
        match self {
            Self::Legacy => "6dca-aqww",
            Self::Disagg => "72hh-3qpy",
            Self::Tff => "gpe5-46if",
        }
    }
    fn groups(self) -> &'static [GroupSpec] {
        match self {
            Self::Legacy => LEGACY,
            Self::Disagg => DISAGG,
            Self::Tff => TFF,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CotError {
    pub code: &'static str,
    pub message: String,
}

impl CotError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for CotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// One trader category of a report: the socrata field names of its positions and changes.
/// Field names are quoted exactly as CFTC publishes them (including its typos).
struct GroupSpec {
    key: &'static str,
    label: &'static str,
    long: &'static str,
    short: &'static str,
    spread: Option<&'static str>,
    d_long: &'static str,
    d_short: &'static str,
}

const NONREPT: GroupSpec = GroupSpec {
    key: "nonreportable",
    label: "Non-reportable",
    long: "nonrept_positions_long_all",
    short: "nonrept_positions_short_all",
    spread: None,
    d_long: "change_in_nonrept_long_all",
    d_short: "change_in_nonrept_short_all",
};

const LEGACY: &[GroupSpec] = &[
    GroupSpec {
        key: "commercial",
        label: "Commercials",
        long: "comm_positions_long_all",
        short: "comm_positions_short_all",
        spread: None,
        d_long: "change_in_comm_long_all",
        d_short: "change_in_comm_short_all",
    },
    GroupSpec {
        key: "noncommercial",
        label: "Non-commercials",
        long: "noncomm_positions_long_all",
        short: "noncomm_positions_short_all",
        spread: Some("noncomm_postions_spread_all"),
        d_long: "change_in_noncomm_long_all",
        d_short: "change_in_noncomm_short_all",
    },
    NONREPT,
];

const DISAGG: &[GroupSpec] = &[
    GroupSpec {
        key: "producer",
        label: "Producers / merchants",
        long: "prod_merc_positions_long",
        short: "prod_merc_positions_short",
        spread: None,
        d_long: "change_in_prod_merc_long",
        d_short: "change_in_prod_merc_short",
    },
    GroupSpec {
        key: "swap",
        label: "Swap dealers",
        long: "swap_positions_long_all",
        short: "swap__positions_short_all",
        spread: Some("swap__positions_spread_all"),
        d_long: "change_in_swap_long_all",
        d_short: "change_in_swap_short_all",
    },
    GroupSpec {
        key: "managed",
        label: "Managed money",
        long: "m_money_positions_long_all",
        short: "m_money_positions_short_all",
        spread: Some("m_money_positions_spread"),
        d_long: "change_in_m_money_long_all",
        d_short: "change_in_m_money_short_all",
    },
    GroupSpec {
        key: "other",
        label: "Other reportables",
        long: "other_rept_positions_long",
        short: "other_rept_positions_short",
        spread: Some("other_rept_positions_spread"),
        d_long: "change_in_other_rept_long",
        d_short: "change_in_other_rept_short",
    },
    NONREPT,
];

const TFF: &[GroupSpec] = &[
    GroupSpec {
        key: "dealer",
        label: "Dealers / intermediaries",
        long: "dealer_positions_long_all",
        short: "dealer_positions_short_all",
        spread: Some("dealer_positions_spread_all"),
        d_long: "change_in_dealer_long_all",
        d_short: "change_in_dealer_short_all",
    },
    GroupSpec {
        key: "assetmgr",
        label: "Asset managers",
        long: "asset_mgr_positions_long",
        short: "asset_mgr_positions_short",
        spread: Some("asset_mgr_positions_spread"),
        d_long: "change_in_asset_mgr_long",
        d_short: "change_in_asset_mgr_short",
    },
    GroupSpec {
        key: "levmoney",
        label: "Leveraged funds",
        long: "lev_money_positions_long",
        short: "lev_money_positions_short",
        spread: Some("lev_money_positions_spread"),
        d_long: "change_in_lev_money_long",
        d_short: "change_in_lev_money_short",
    },
    GroupSpec {
        key: "other",
        label: "Other reportables",
        long: "other_rept_positions_long",
        short: "other_rept_positions_short",
        spread: Some("other_rept_positions_spread"),
        d_long: "change_in_other_rept_long",
        d_short: "change_in_other_rept_short",
    },
    NONREPT,
];

/// Positions of one trader category in one week.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CotGroup {
    pub key: String,
    pub label: String,
    pub long: i64,
    pub short: i64,
    pub spread: i64,
    /// long - short.
    pub net: i64,
    pub long_change: i64,
    pub short_change: i64,
    /// Week-over-week change of the net position.
    pub net_change: i64,
}

/// One weekly report row (as of a Tuesday).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CotRow {
    /// Report date, `YYYY-MM-DD`.
    pub date: String,
    pub open_interest: i64,
    pub oi_change: i64,
    pub groups: Vec<CotGroup>,
}

/// Exactly 8 chars max, alphanumeric: CFTC contract market codes look like `13874A`, `1170E1`.
pub fn validate_market_code(code: &str) -> Result<&str, CotError> {
    let ok = !code.is_empty() && code.len() <= 8 && code.bytes().all(|b| b.is_ascii_alphanumeric());
    if ok {
        Ok(code)
    } else {
        Err(CotError::new(
            "cot.bad_market",
            "Not a CFTC contract market code",
        ))
    }
}

/// `YYYY-MM-DD` with plausible month / day.
pub fn validate_date(d: &str) -> Result<&str, CotError> {
    let b = d.as_bytes();
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    let ok = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && digits(0..4)
        && digits(5..7)
        && digits(8..10)
        && matches!(d[5..7].parse::<u8>(), Ok(1..=12))
        && matches!(d[8..10].parse::<u8>(), Ok(1..=31));
    if ok {
        Ok(d)
    } else {
        Err(CotError::new("cot.bad_date", "Date must be YYYY-MM-DD"))
    }
}

fn pct_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The https query URL for one market, oldest first, only the fields this crate reads.
pub fn build_url(report: Report, market_code: &str, from_date: &str) -> Result<String, CotError> {
    let code = validate_market_code(market_code)?;
    let from = validate_date(from_date)?;
    let mut fields: Vec<&str> = vec![
        "report_date_as_yyyy_mm_dd",
        "open_interest_all",
        "change_in_open_interest_all",
    ];
    for g in report.groups() {
        fields.extend([g.long, g.short, g.d_long, g.d_short]);
        if let Some(s) = g.spread {
            fields.push(s);
        }
    }
    let select = fields.join(",");
    let where_ =
        format!("cftc_contract_market_code='{code}' AND report_date_as_yyyy_mm_dd>='{from}'");
    Ok(format!(
        "https://{CFTC_HOST}/resource/{}.json?$select={}&$where={}&$order=report_date_as_yyyy_mm_dd%20ASC&$limit={MAX_ROWS}",
        report.dataset(),
        pct_encode(&select),
        pct_encode(&where_),
    ))
}

/// True only for `https://publicreporting.cftc.gov/...` (no userinfo, no other port).
pub fn is_allowed_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    authority.eq_ignore_ascii_case(CFTC_HOST)
}

fn int(v: &Value, field: &str) -> i64 {
    match v.get(field) {
        Some(Value::String(s)) => s
            .trim()
            .parse::<i64>()
            .or_else(|_| s.trim().parse::<f64>().map(|f| f.round() as i64))
            .unwrap_or(0),
        Some(Value::Number(n)) => n
            .as_i64()
            .unwrap_or_else(|| n.as_f64().unwrap_or(0.0) as i64),
        _ => 0,
    }
}

/// Parses the JSON array of a Socrata response into weekly rows (ascending, one per date).
/// Rows without a date or without open interest are skipped.
pub fn parse_rows(report: Report, json: &str) -> Result<Vec<CotRow>, CotError> {
    let v: Value = serde_json::from_str(json)
        .map_err(|_| CotError::new("cot.parse", "The CFTC response is not valid JSON"))?;
    let arr = match &v {
        Value::Array(a) => a,
        Value::Object(o) => {
            let msg = o
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("The CFTC API returned an error");
            return Err(CotError::new("cot.api", msg));
        }
        _ => return Err(CotError::new("cot.parse", "Unexpected CFTC response shape")),
    };
    let mut rows: Vec<CotRow> = Vec::with_capacity(arr.len());
    for r in arr {
        let Some(date) = r
            .get("report_date_as_yyyy_mm_dd")
            .and_then(Value::as_str)
            .map(|s| s.chars().take(10).collect::<String>())
        else {
            continue;
        };
        if validate_date(&date).is_err() || r.get("open_interest_all").is_none() {
            continue;
        }
        let groups = report
            .groups()
            .iter()
            .map(|g| {
                let (long, short) = (int(r, g.long), int(r, g.short));
                let (dl, ds) = (int(r, g.d_long), int(r, g.d_short));
                CotGroup {
                    key: g.key.into(),
                    label: g.label.into(),
                    long,
                    short,
                    spread: g.spread.map_or(0, |s| int(r, s)),
                    net: long - short,
                    long_change: dl,
                    short_change: ds,
                    net_change: dl - ds,
                }
            })
            .collect();
        rows.push(CotRow {
            date,
            open_interest: int(r, "open_interest_all"),
            oi_change: int(r, "change_in_open_interest_all"),
            groups,
        });
    }
    rows.sort_by(|a, b| a.date.cmp(&b.date));
    rows.dedup_by(|a, b| a.date == b.date);
    Ok(rows)
}

// ---------------------------------------------------------------------------------- cache

/// What `cot_fetch` stores per (report, market).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheFile {
    pub fetched_at: i64,
    pub from_date: String,
    pub rows: Vec<CotRow>,
}

pub fn cache_path(dir: &Path, report: Report, market_code: &str) -> Result<PathBuf, CotError> {
    let code = validate_market_code(market_code)?;
    Ok(dir.join(format!(
        "cot_{}_{}.json",
        report.key(),
        code.to_ascii_uppercase()
    )))
}

pub fn read_cache(path: &Path) -> Option<CacheFile> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

pub fn write_cache(path: &Path, file: &CacheFile) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(
        &tmp,
        serde_json::to_vec(file).map_err(std::io::Error::other)?,
    )?;
    fs::rename(tmp, path)
}

const DAY_MS: i64 = 86_400_000;
/// Reports publish Friday 15:30 US Eastern (19:30 / 20:30 UTC); 20:30 UTC covers both.
const RELEASE_OFFSET_MS: i64 = (20 * 60 + 30) * 60_000;

/// Unix ms of the most recent Friday release (20:30 UTC) at or before `now_ms`.
pub fn latest_release_ms(now_ms: i64) -> i64 {
    let day = now_ms.div_euclid(DAY_MS);
    // 1970-01-01 was a Thursday: with Monday = 0, weekday = (day + 3) % 7; Friday = 4.
    let dow = (day + 3).rem_euclid(7);
    let back = (dow - 4).rem_euclid(7);
    let mut t = (day - back) * DAY_MS + RELEASE_OFFSET_MS;
    if t > now_ms {
        t -= 7 * DAY_MS;
    }
    t
}

/// A cache is fresh when it was fetched after the latest weekly release and reaches back far enough.
pub fn is_fresh(file: &CacheFile, from_date: &str, now_ms: i64) -> bool {
    file.fetched_at >= latest_release_ms(now_ms) && file.from_date.as_str() <= from_date
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEGACY_ES: &str = include_str!("../tests/fixtures/legacy_es.json");
    const DISAGG_GOLD: &str = include_str!("../tests/fixtures/disagg_gold.json");
    const TFF_ES: &str = include_str!("../tests/fixtures/tff_es.json");

    #[test]
    fn legacy_rows_parse_and_sort_ascending() {
        let rows = parse_rows(Report::Legacy, LEGACY_ES).unwrap();
        assert_eq!(rows.len(), 8);
        assert!(rows.windows(2).all(|w| w[0].date < w[1].date));
        let last = rows.last().unwrap();
        assert_eq!(last.date, "2026-11-03");
        assert_eq!(last.groups.len(), 3);
        let keys: Vec<_> = last.groups.iter().map(|g| g.key.as_str()).collect();
        assert_eq!(keys, ["commercial", "noncommercial", "nonreportable"]);
        assert!(last.open_interest > 100_000);
        for g in &last.groups {
            assert_eq!(g.net, g.long - g.short);
            assert_eq!(g.net_change, g.long_change - g.short_change);
        }
    }

    #[test]
    fn legacy_values_match_the_raw_json() {
        let raw: Vec<Value> = serde_json::from_str(LEGACY_ES).unwrap();
        let newest = &raw[0];
        let rows = parse_rows(Report::Legacy, LEGACY_ES).unwrap();
        let last = rows.last().unwrap();
        let n = |k: &str| newest[k].as_str().unwrap().parse::<i64>().unwrap();
        assert_eq!(last.open_interest, n("open_interest_all"));
        assert_eq!(last.oi_change, n("change_in_open_interest_all"));
        assert_eq!(last.groups[0].long, n("comm_positions_long_all"));
        assert_eq!(last.groups[1].short, n("noncomm_positions_short_all"));
        assert_eq!(last.groups[1].spread, n("noncomm_postions_spread_all"));
        assert_eq!(last.groups[2].long_change, n("change_in_nonrept_long_all"));
    }

    #[test]
    fn disaggregated_has_five_categories() {
        let rows = parse_rows(Report::Disagg, DISAGG_GOLD).unwrap();
        let last = rows.last().unwrap();
        let keys: Vec<_> = last.groups.iter().map(|g| g.key.as_str()).collect();
        assert_eq!(
            keys,
            ["producer", "swap", "managed", "other", "nonreportable"]
        );
        // Gold: managed money is net long, swap dealers net short.
        assert!(last.groups[2].net > 0, "{:?}", last.groups[2]);
        assert!(last.groups[1].net < 0, "{:?}", last.groups[1]);
        assert!(last.groups[1].spread > 0);
    }

    #[test]
    fn tff_has_five_categories() {
        let rows = parse_rows(Report::Tff, TFF_ES).unwrap();
        let last = rows.last().unwrap();
        let keys: Vec<_> = last.groups.iter().map(|g| g.key.as_str()).collect();
        assert_eq!(
            keys,
            ["dealer", "assetmgr", "levmoney", "other", "nonreportable"]
        );
        assert!(last.groups[1].long > 0);
    }

    #[test]
    fn bad_json_and_api_errors() {
        assert_eq!(
            parse_rows(Report::Legacy, "not json").unwrap_err().code,
            "cot.parse"
        );
        let e = parse_rows(
            Report::Legacy,
            r#"{"message":"Query coordinator error","error":true}"#,
        )
        .unwrap_err();
        assert_eq!(e.code, "cot.api");
        assert!(e.message.contains("coordinator"));
        assert_eq!(parse_rows(Report::Legacy, "[]").unwrap(), vec![]);
        // missing open interest or date: skipped, not an error
        let rows = parse_rows(
            Report::Legacy,
            r#"[{"report_date_as_yyyy_mm_dd":"2026-01-06T00:00:00.000"},{"open_interest_all":"5"}]"#,
        )
        .unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn duplicate_dates_collapse() {
        let one =
            r#"{"report_date_as_yyyy_mm_dd":"2026-01-06T00:00:00.000","open_interest_all":"10"}"#;
        let rows = parse_rows(Report::Legacy, &format!("[{one},{one}]")).unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn url_is_https_cftc_only_and_encoded() {
        let u = build_url(Report::Legacy, "13874A", "2020-01-01").unwrap();
        assert!(is_allowed_url(&u));
        assert!(u.starts_with("https://publicreporting.cftc.gov/resource/6dca-aqww.json?"));
        assert!(u.contains("$where=cftc_contract_market_code%3D%2713874A%27%20AND%20"));
        assert!(
            u.contains("&$select=report_date_as_yyyy_mm_dd%2Copen_interest_all")
                || u.contains("?$select=report_date_as_yyyy_mm_dd%2Copen_interest_all")
        );
        assert!(!u.contains(' '));
        assert!(build_url(Report::Disagg, "088691", "2020-01-01")
            .unwrap()
            .contains("/72hh-3qpy.json"));
        assert!(build_url(Report::Tff, "13874A", "2020-01-01")
            .unwrap()
            .contains("/gpe5-46if.json"));
    }

    #[test]
    fn injection_is_refused() {
        for bad in ["", "13874A' OR 1=1 --", "13874A%27", "AAAAAAAAA", "13 874"] {
            assert_eq!(
                build_url(Report::Legacy, bad, "2020-01-01")
                    .unwrap_err()
                    .code,
                "cot.bad_market",
                "{bad:?}"
            );
        }
        for bad in ["2020-1-1", "2020-13-01", "2020-01-01' OR", "yesterday", ""] {
            assert_eq!(
                build_url(Report::Legacy, "13874A", bad).unwrap_err().code,
                "cot.bad_date",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn allow_list() {
        assert!(is_allowed_url(
            "https://publicreporting.cftc.gov/resource/x.json"
        ));
        assert!(is_allowed_url(
            "https://PublicReporting.CFTC.gov/resource/x.json?a=b"
        ));
        for bad in [
            "http://publicreporting.cftc.gov/resource/x.json",
            "https://publicreporting.cftc.gov.evil.com/x",
            "https://evil.com/publicreporting.cftc.gov",
            "https://user@publicreporting.cftc.gov/x",
            "https://publicreporting.cftc.gov:8443/x",
            "https://www.cftc.gov/x",
            "file:///etc/passwd",
        ] {
            assert!(!is_allowed_url(bad), "{bad}");
        }
    }

    #[test]
    fn release_schedule() {
        // 2026-11-14 (Saturday) 12:00 UTC -> Friday 2026-11-13 20:30 UTC
        let sat = 1_794_657_600_000_i64; // 2026-11-14T12:00:00Z
        let fri = latest_release_ms(sat);
        assert_eq!(fri, 1_794_601_800_000); // 2026-11-13T20:30:00Z
                                            // Friday 10:00 UTC (before the release) -> previous Friday
        let fri_morning = 1_794_564_000_000; // 2026-11-13T10:00:00Z
        assert_eq!(latest_release_ms(fri_morning), fri - 7 * DAY_MS);
        // exactly at the release
        assert_eq!(latest_release_ms(fri), fri);
        // Wednesday -> the Friday before
        assert_eq!(latest_release_ms(fri + 5 * DAY_MS), fri);
    }

    #[test]
    fn freshness_and_cache_roundtrip() {
        let now = 1_794_657_600_000_i64;
        let rows = parse_rows(Report::Legacy, LEGACY_ES).unwrap();
        let mut f = CacheFile {
            fetched_at: now - 3_600_000,
            from_date: "2020-01-01".into(),
            rows,
        };
        assert!(is_fresh(&f, "2021-01-01", now));
        assert!(
            !is_fresh(&f, "2019-01-01", now),
            "cache does not reach back far enough"
        );
        f.fetched_at = latest_release_ms(now) - 1;
        assert!(
            !is_fresh(&f, "2021-01-01", now),
            "fetched before the latest release"
        );

        let dir = std::env::temp_dir().join(format!("htflow-cot-test-{}", std::process::id()));
        let p = cache_path(&dir, Report::Legacy, "13874a").unwrap();
        assert!(p.ends_with("cot_legacy_13874A.json"));
        assert!(read_cache(&p).is_none());
        write_cache(&p, &f).unwrap();
        let back = read_cache(&p).unwrap();
        assert_eq!(back.rows, f.rows);
        assert_eq!(back.from_date, "2020-01-01");
        fs::write(&p, b"{broken").unwrap();
        assert!(read_cache(&p).is_none());
        let _ = fs::remove_dir_all(&dir);
        assert!(cache_path(&dir, Report::Legacy, "../x").is_err());
    }
}
