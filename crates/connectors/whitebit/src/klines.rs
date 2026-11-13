//! WhiteBIT candles for the history backfill (P06):
//! `/api/v1/public/kline?market=&interval=&start=<s>&end=<s>&limit=1440`.
//!
//! * Rows are `[time (s), open, close, high, low, volumeStock, volumeMoney]` (close comes before
//!   high / low), oldest first, at most 1,440 per request; a range is cut into windows of 1,440
//!   bars.
//! * Volume is the base ("stock") volume, as in the trade feed.
//! * WhiteBIT gives no taker split, so the volume is split by candle direction
//!   ([`htflow_connector_common::directional_taker_buy`]).
//! * Rate limit: the shared 10 req/s bucket plus the `Retry-After` back-off of
//!   [`htflow_connector_common::Rest`].
use htflow_connector_common::{
    bar, finish_klines, num_f64, num_text, windows, ConnectorError, Kline, Result, SymbolSpec,
};
use serde_json::Value;

use crate::Whitebit;

/// Candle widths served (ms, ascending).
pub const KLINE_INTERVALS: &[i64] = &[
    60_000, 180_000, 300_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 21_600_000,
    43_200_000, 86_400_000,
];

/// Bars per request.
pub const KLINE_PAGE: i64 = 1_440;
/// Requests one [`Whitebit::klines_range`] call may spend (≤ 5,000 bars).
pub const KLINE_PAGES: u32 = 3;

/// WhiteBIT `interval` of an interval.
pub fn kline_interval(ms: i64) -> Option<&'static str> {
    Some(match ms {
        60_000 => "1m",
        180_000 => "3m",
        300_000 => "5m",
        900_000 => "15m",
        1_800_000 => "30m",
        3_600_000 => "1h",
        7_200_000 => "2h",
        14_400_000 => "4h",
        21_600_000 => "6h",
        43_200_000 => "12h",
        86_400_000 => "1d",
        _ => return None,
    })
}

/// The bars of a `/api/v1/public/kline` answer.
pub fn klines_of(spec: &SymbolSpec, span_ms: i64, v: &Value) -> Result<Vec<Kline>> {
    if v.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(ConnectorError::Api(format!(
            "whitebit: {}",
            v.get("message").map(|m| m.to_string()).unwrap_or_default()
        )));
    }
    let rows = v
        .get("result")
        .and_then(Value::as_array)
        .ok_or_else(|| ConnectorError::Api("whitebit: no kline result".into()))?;
    rows.iter()
        .map(|r| {
            let r = r
                .as_array()
                .ok_or_else(|| ConnectorError::Other("whitebit kline row".into()))?;
            let t = |i: usize| -> Result<String> {
                r.get(i)
                    .and_then(num_text)
                    .ok_or_else(|| ConnectorError::Other(format!("whitebit kline field {i}")))
            };
            let secs = r
                .first()
                .and_then(num_f64)
                .ok_or_else(|| ConnectorError::Other("whitebit kline time".into()))?;
            bar(
                &spec.tick,
                secs as i64 * 1000,
                span_ms,
                &t(1)?,
                &t(3)?,
                &t(4)?,
                &t(2)?,
                r.get(5).and_then(num_f64).unwrap_or(0.0),
            )
        })
        .collect()
}

impl Whitebit {
    /// Candles of `interval_ms` (see [`KLINE_INTERVALS`]) opening in `[from_ms, to_ms)`, oldest
    /// first, in windows of 1,440 bars (at most `max_pages` requests).
    pub async fn klines_range(
        &self,
        spec: &SymbolSpec,
        interval_ms: i64,
        from_ms: i64,
        to_ms: i64,
        max_pages: u32,
    ) -> Result<Vec<Kline>> {
        let iv = kline_interval(interval_ms).ok_or_else(|| {
            ConnectorError::Other(format!("unsupported kline interval {interval_ms} ms"))
        })?;
        let first = from_ms.div_euclid(interval_ms) * interval_ms;
        let mut out: Vec<Kline> = Vec::new();
        for (a, b) in windows(first, to_ms, KLINE_PAGE * interval_ms)
            .into_iter()
            .take(max_pages as usize)
        {
            let v: Value = self
                .rest
                .get(&format!(
                    "/api/v1/public/kline?market={}&interval={iv}&start={}&end={}&limit={KLINE_PAGE}",
                    spec.symbol,
                    a / 1000,
                    (b - 1) / 1000
                ))
                .await?;
            out.extend(klines_of(spec, interval_ms, &v)?);
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

    const FIXTURE: &str = include_str!("../tests/fixtures/kline.json");

    fn spec() -> SymbolSpec {
        SymbolSpec::new("BTC_USDT", TickSize::parse("0.5").unwrap(), 6)
    }

    #[test]
    fn parses_fixture() {
        let v: Value = serde_json::from_str(FIXTURE).unwrap();
        let k = klines_of(&spec(), 60_000, &v).unwrap();
        assert_eq!(k.len(), 3);
        assert_eq!(k[0].open_ms, 1_700_000_040_000);
        // Column order is open, close, high, low.
        assert_eq!(
            (k[0].open, k[0].high, k[0].low, k[0].close),
            (74_001, 74_020, 73_980, 74_010)
        );
        assert_eq!((k[0].volume, k[0].taker_buy), (12.5, Some(12.5)));
        assert_eq!(k[1].taker_buy, Some(0.0));
        let bad = serde_json::json!({"success":false,"message":{"market":["bad"]}});
        assert!(klines_of(&spec(), 60_000, &bad).is_err());
        assert!(klines_of(&spec(), 60_000, &serde_json::json!({})).is_err());
        assert!(KLINE_INTERVALS.iter().all(|i| kline_interval(*i).is_some()));
    }

    #[tokio::test]
    async fn windows_of_1440_bars() {
        let srv = MockServer::start(|t| {
            let p = |k| query_param(t, k).and_then(|v| v.parse::<i64>().ok());
            let (s, e) = (p("start").unwrap(), p("end").unwrap());
            let rows: Vec<String> = (0..p("limit").unwrap())
                .map(|i| s + i * 60)
                .filter(|o| *o <= e)
                .map(|o| format!(r#"[{o},"100","100.5","101","99","2","200"]"#))
                .collect();
            Reply::ok(format!(
                r#"{{"success":true,"message":null,"result":[{}]}}"#,
                rows.join(",")
            ))
        });
        let w = Whitebit::new(&srv.base, "ws://unused");
        let k = w
            .klines_range(&spec(), 60_000, 0, 2000 * 60_000, 5)
            .await
            .unwrap();
        assert_eq!(k.len(), 2000);
        assert_eq!(k[1999].open_ms, 1999 * 60_000);
        let reqs = srv.requests();
        assert_eq!(reqs.len(), 2, "{reqs:?}");
        assert!(
            reqs[0].contains("market=BTC_USDT&interval=1m&start=0&end=86399&limit=1440"),
            "{reqs:?}"
        );
        assert!(reqs[1].contains("start=86400"), "{reqs:?}");
        assert!(w.klines_range(&spec(), 61_000, 0, 1, 1).await.is_err());
        assert!(!w.kline_intervals().is_empty());
    }
}
