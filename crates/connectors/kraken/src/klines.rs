//! Kraken Futures candles for the history backfill (P06):
//! `/api/charts/v1/trade/{symbol}/{resolution}?from=<s>&to=<s>`.
//!
//! * The answer is `{"candles":[{"time":ms,"open":"…","high":"…","low":"…","close":"…",
//!   "volume":n}],"more_candles":bool}`, oldest first; a range is cut into windows of 2,000
//!   bars and a window that reports `more_candles` is continued after its last bar.
//! * Volume is in contracts (the unit of the trade feed).
//! * Kraken gives no taker split, so the volume is split by candle direction
//!   ([`htflow_connector_common::directional_taker_buy`]).
//! * Rate limit: the shared 5 req/s bucket plus the `Retry-After` back-off of
//!   [`htflow_connector_common::Rest`].
use htflow_connector_common::{
    bar, finish_klines, num_f64, num_text, windows, ConnectorError, Kline, Result, SymbolSpec,
};
use serde_json::Value;

use crate::KrakenFutures;

/// Candle widths served (ms, ascending).
pub const KLINE_INTERVALS: &[i64] = &[
    60_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 43_200_000, 86_400_000,
];

/// Bars requested per window.
pub const KLINE_PAGE: i64 = 2_000;
/// Requests one [`KrakenFutures::klines_range`] call may spend (≤ 4,000 bars).
pub const KLINE_PAGES: u32 = 2;

/// Kraken `resolution` of an interval.
pub fn kline_resolution(ms: i64) -> Option<&'static str> {
    Some(match ms {
        60_000 => "1m",
        300_000 => "5m",
        900_000 => "15m",
        1_800_000 => "30m",
        3_600_000 => "1h",
        14_400_000 => "4h",
        43_200_000 => "12h",
        86_400_000 => "1d",
        _ => return None,
    })
}

/// The bars of a charts answer and its `more_candles` flag.
pub fn klines_of(spec: &SymbolSpec, span_ms: i64, text: &str) -> Result<(Vec<Kline>, bool)> {
    let v: Value = serde_json::from_str(text)?;
    if let Some(e) = v.get("error").and_then(Value::as_str) {
        return Err(ConnectorError::Api(format!("kraken: {e}")));
    }
    let rows = v
        .get("candles")
        .and_then(Value::as_array)
        .ok_or_else(|| ConnectorError::Api("kraken: no candles".into()))?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let t = |k: &str| -> Result<String> {
            r.get(k)
                .and_then(num_text)
                .ok_or_else(|| ConnectorError::Other(format!("kraken candle field {k}")))
        };
        let open_ms = r
            .get("time")
            .and_then(num_f64)
            .ok_or_else(|| ConnectorError::Other("kraken candle time".into()))?
            as i64;
        out.push(bar(
            &spec.tick,
            open_ms,
            span_ms,
            &t("open")?,
            &t("high")?,
            &t("low")?,
            &t("close")?,
            r.get("volume").and_then(num_f64).unwrap_or(0.0),
        )?);
    }
    let more = v
        .get("more_candles")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok((out, more))
}

impl KrakenFutures {
    /// Candles of `interval_ms` (see [`KLINE_INTERVALS`]) opening in `[from_ms, to_ms)`, oldest
    /// first, spending at most `max_pages` requests.
    pub async fn klines_range(
        &self,
        spec: &SymbolSpec,
        interval_ms: i64,
        from_ms: i64,
        to_ms: i64,
        max_pages: u32,
    ) -> Result<Vec<Kline>> {
        let res = kline_resolution(interval_ms).ok_or_else(|| {
            ConnectorError::Other(format!("unsupported kline interval {interval_ms} ms"))
        })?;
        let first = from_ms.div_euclid(interval_ms) * interval_ms;
        let mut out: Vec<Kline> = Vec::new();
        let mut pages = 0;
        'win: for (a, b) in windows(first, to_ms, KLINE_PAGE * interval_ms) {
            let mut start = a;
            while start < b {
                if pages >= max_pages {
                    break 'win;
                }
                pages += 1;
                let text = self
                    .rest
                    .get_text(&format!(
                        "/api/charts/v1/trade/{}/{res}?from={}&to={}",
                        spec.symbol,
                        start / 1000,
                        (b - 1) / 1000
                    ))
                    .await?;
                let (rows, more) = klines_of(spec, interval_ms, &text)?;
                let last = rows.iter().map(|k| k.open_ms).max();
                out.extend(rows);
                match last {
                    Some(l) if more && l + interval_ms > start => start = l + interval_ms,
                    _ => break,
                }
            }
        }
        Ok(finish_klines(out, first, to_ms))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use htflow_connector_common::mock_http::{query_param, MockServer, Reply};
    use htflow_connector_common::MarketApi;
    use htflow_core_types::TickSize;

    const FIXTURE: &str = include_str!("../tests/fixtures/charts-trade.json");

    fn spec() -> SymbolSpec {
        SymbolSpec::new("PF_XBTUSD", TickSize::parse("0.5").unwrap(), 4)
    }

    #[test]
    fn parses_fixture() {
        let (k, more) = klines_of(&spec(), 60_000, FIXTURE).unwrap();
        assert!(!more);
        assert_eq!(k.len(), 3);
        assert_eq!(k[0].open_ms, 1_700_000_040_000);
        assert_eq!(
            (k[0].open, k[0].high, k[0].low, k[0].close),
            (74_001, 74_020, 73_980, 74_010)
        );
        assert_eq!((k[0].volume, k[0].taker_buy), (120.0, Some(120.0)));
        assert_eq!(k[1].taker_buy, Some(0.0));
        assert_eq!((k[2].volume, k[2].taker_buy), (0.0, Some(0.0)));
        assert!(klines_of(&spec(), 60_000, r#"{"error":"nope"}"#).is_err());
        assert!(klines_of(&spec(), 60_000, "{}").is_err());
        assert!(KLINE_INTERVALS
            .iter()
            .all(|i| kline_resolution(*i).is_some()));
    }

    /// Serves at most 1,000 bars per answer and flags `more_candles`.
    #[tokio::test]
    async fn continues_truncated_windows() {
        let srv = MockServer::start(|t| {
            let p = |k| query_param(t, k).and_then(|v| v.parse::<i64>().ok());
            let (s, e) = (p("from").unwrap(), p("to").unwrap());
            let all: Vec<i64> = (0..).map(|i| s + i * 60).take_while(|x| *x <= e).collect();
            let more = all.len() > 1000;
            let rows: Vec<String> = all
                .into_iter()
                .take(1000)
                .map(|o| {
                    format!(
                        r#"{{"time":{},"open":"100","high":"101","low":"99","close":"100.5","volume":3}}"#,
                        o * 1000
                    )
                })
                .collect();
            Reply::ok(format!(
                r#"{{"candles":[{}],"more_candles":{more}}}"#,
                rows.join(",")
            ))
        });
        let k = KrakenFutures::new(&srv.base, "ws://unused");
        let rows = k
            .klines_range(&spec(), 60_000, 0, 1500 * 60_000, 5)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1500);
        let reqs = srv.requests();
        assert_eq!(reqs.len(), 2, "{reqs:?}");
        assert!(
            reqs[0].starts_with("/api/charts/v1/trade/PF_XBTUSD/1m?from=0&to="),
            "{reqs:?}"
        );
        assert!(reqs[1].contains("from=60000&to="), "{reqs:?}");
        // The request budget bounds the download.
        let rows = k
            .klines_range(&spec(), 60_000, 0, 1500 * 60_000, 1)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1000);
        assert!(k.klines_range(&spec(), 61_000, 0, 1, 1).await.is_err());
        assert!(k.kline_max_bars() <= 5000 && !k.kline_intervals().is_empty());
    }
}
