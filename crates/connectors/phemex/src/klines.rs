//! Phemex candles for the history backfill (P06):
//! `/exchange/public/md/v2/kline/list?symbol=&resolution=<s>&from=<s>&to=<s>` (USDT perpetuals).
//!
//! * The answer is `{"code":0,"data":{"rows":[[time (s), interval, lastClose, open, high, low,
//!   close, volume, turnover], …]}}`, oldest first, at most 1,000 rows; a range is cut into
//!   windows of 1,000 bars.
//! * Volume is in base units, as in the trade feed.
//! * Phemex gives no taker split, so the volume is split by candle direction
//!   ([`htflow_connector_common::directional_taker_buy`]).
//! * Rate limit: the shared 10 req/s bucket plus the `Retry-After` back-off of
//!   [`htflow_connector_common::Rest`].
use htflow_connector_common::{
    bar, finish_klines, num_f64, num_text, windows, ConnectorError, Kline, Result, SymbolSpec,
};
use serde_json::Value;

use crate::Phemex;

/// Candle widths served (ms, ascending).
pub const KLINE_INTERVALS: &[i64] = &[
    60_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 86_400_000,
];

/// Bars per request.
pub const KLINE_PAGE: i64 = 1_000;
/// Requests one [`Phemex::klines_range`] call may spend (≤ 5,000 bars).
pub const KLINE_PAGES: u32 = 5;

/// Phemex `resolution` (seconds) of an interval.
pub fn kline_resolution(ms: i64) -> Option<i64> {
    KLINE_INTERVALS.contains(&ms).then_some(ms / 1000)
}

/// The bars of a `kline/list` answer.
pub fn klines_of(spec: &SymbolSpec, span_ms: i64, v: &Value) -> Result<Vec<Kline>> {
    let code = v.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if code != 0 {
        return Err(ConnectorError::Api(format!(
            "phemex {code}: {}",
            v.get("msg").and_then(Value::as_str).unwrap_or("")
        )));
    }
    let rows = v
        .pointer("/data/rows")
        .and_then(Value::as_array)
        .ok_or_else(|| ConnectorError::Api("phemex: no kline rows".into()))?;
    rows.iter()
        .map(|r| {
            let r = r
                .as_array()
                .ok_or_else(|| ConnectorError::Other("phemex kline row".into()))?;
            let t = |i: usize| -> Result<String> {
                r.get(i)
                    .and_then(num_text)
                    .ok_or_else(|| ConnectorError::Other(format!("phemex kline field {i}")))
            };
            let secs = r
                .first()
                .and_then(num_f64)
                .ok_or_else(|| ConnectorError::Other("phemex kline time".into()))?;
            bar(
                &spec.tick,
                secs as i64 * 1000,
                span_ms,
                &t(3)?,
                &t(4)?,
                &t(5)?,
                &t(6)?,
                r.get(7).and_then(num_f64).unwrap_or(0.0),
            )
        })
        .collect()
}

impl Phemex {
    /// Candles of `interval_ms` (see [`KLINE_INTERVALS`]) opening in `[from_ms, to_ms)`, oldest
    /// first, in windows of 1,000 bars (at most `max_pages` requests).
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
        for (a, b) in windows(first, to_ms, KLINE_PAGE * interval_ms)
            .into_iter()
            .take(max_pages as usize)
        {
            let v: Value = self
                .rest
                .get(&format!(
                    "/exchange/public/md/v2/kline/list?symbol={}&resolution={res}&from={}&to={}",
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

    const FIXTURE: &str = include_str!("../tests/fixtures/kline-list.json");

    fn spec() -> SymbolSpec {
        SymbolSpec::new("BTCUSDT", TickSize::parse("0.5").unwrap(), 3)
    }

    #[test]
    fn parses_fixture() {
        let v: Value = serde_json::from_str(FIXTURE).unwrap();
        let k = klines_of(&spec(), 60_000, &v).unwrap();
        assert_eq!(k.len(), 3);
        assert_eq!(k[0].open_ms, 1_700_000_040_000);
        assert_eq!(
            (k[0].open, k[0].high, k[0].low, k[0].close),
            (74_001, 74_020, 73_980, 74_010)
        );
        assert_eq!((k[0].volume, k[0].taker_buy), (12.5, Some(12.5)));
        assert_eq!(k[1].taker_buy, Some(0.0));
        let bad = serde_json::json!({"code":30000,"msg":"bad symbol"});
        assert!(klines_of(&spec(), 60_000, &bad)
            .unwrap_err()
            .to_string()
            .contains("30000"));
        assert_eq!(kline_resolution(3_600_000), Some(3600));
        assert_eq!(kline_resolution(61_000), None);
    }

    #[tokio::test]
    async fn windows_of_1000_bars() {
        let srv = MockServer::start(|t| {
            let p = |k| query_param(t, k).and_then(|v| v.parse::<i64>().ok());
            let (s, e) = (p("from").unwrap(), p("to").unwrap());
            let rows: Vec<String> = (0..1000)
                .map(|i| s + i * 60)
                .filter(|o| *o <= e)
                .map(|o| format!("[{o},60,100,100,101,99,100.5,2,200]"))
                .collect();
            Reply::ok(format!(
                r#"{{"code":0,"msg":"OK","data":{{"total":-1,"rows":[{}]}}}}"#,
                rows.join(",")
            ))
        });
        let p = Phemex::new(&srv.base, "ws://unused");
        let k = p
            .klines_range(&spec(), 60_000, 0, 2500 * 60_000, 5)
            .await
            .unwrap();
        assert_eq!(k.len(), 2500);
        let reqs = srv.requests();
        assert_eq!(reqs.len(), 3, "{reqs:?}");
        assert!(
            reqs[0].contains("symbol=BTCUSDT&resolution=60&from=0&to=59999"),
            "{reqs:?}"
        );
        assert_eq!(
            p.klines_range(&spec(), 60_000, 0, 2500 * 60_000, 1)
                .await
                .unwrap()
                .len(),
            1000
        );
        assert!(p.klines_range(&spec(), 61_000, 0, 1, 1).await.is_err());
        assert!(!p.kline_intervals().is_empty());
    }
}
