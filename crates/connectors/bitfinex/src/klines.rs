//! Bitfinex candles for the history backfill (P06):
//! `/v2/candles/trade:{timeframe}:{symbol}/hist?start=&end=&limit=10000&sort=1`.
//!
//! * Rows are `[MTS, OPEN, CLOSE, HIGH, LOW, VOLUME]` (note: close comes before high / low),
//!   up to 10,000 per request, so a backfill range is a single request.
//! * Volume is in base units (spot) or contracts of base (derivatives), as in the trade feed.
//! * Bitfinex gives no taker split, so the volume is split by candle direction
//!   ([`htflow_connector_common::directional_taker_buy`]).
//! * Rate limit: the venue bucket (10 requests per minute, shared with trades; the public
//!   candles limit is 30 per minute) plus the `Retry-After` back-off of
//!   [`htflow_connector_common::Rest`].
use htflow_connector_common::{
    bar, finish_klines, num_f64, num_text, windows, ConnectorError, Kline, Result, SymbolSpec,
};
use serde_json::Value;

use crate::Bitfinex;

/// Candle widths served (ms, ascending).
pub const KLINE_INTERVALS: &[i64] = &[
    60_000, 300_000, 900_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000,
];

/// Bars per request.
pub const KLINE_PAGE: i64 = 10_000;
/// Requests one [`Bitfinex::klines_range`] call may spend.
pub const KLINE_PAGES: u32 = 1;

/// Bitfinex `timeframe` of an interval.
pub fn kline_timeframe(ms: i64) -> Option<&'static str> {
    Some(match ms {
        60_000 => "1m",
        300_000 => "5m",
        900_000 => "15m",
        1_800_000 => "30m",
        3_600_000 => "1h",
        10_800_000 => "3h",
        21_600_000 => "6h",
        43_200_000 => "12h",
        86_400_000 => "1D",
        _ => return None,
    })
}

/// One candle row `[MTS, OPEN, CLOSE, HIGH, LOW, VOLUME]`.
pub fn kline_of(spec: &SymbolSpec, span_ms: i64, r: &[Value]) -> Result<Kline> {
    let t = |i: usize| -> Result<String> {
        r.get(i)
            .and_then(num_text)
            .ok_or_else(|| ConnectorError::Other(format!("bitfinex candle field {i}")))
    };
    let open_ms =
        r.first()
            .and_then(num_f64)
            .ok_or_else(|| ConnectorError::Other("bitfinex candle time".into()))? as i64;
    bar(
        &spec.tick,
        open_ms,
        span_ms,
        &t(1)?,
        &t(3)?,
        &t(4)?,
        &t(2)?,
        r.get(5).and_then(num_f64).unwrap_or(0.0),
    )
}

impl Bitfinex {
    /// Candles of `interval_ms` (see [`KLINE_INTERVALS`]) opening in `[from_ms, to_ms)`, oldest
    /// first, in windows of 10,000 bars (at most `max_pages` requests).
    pub async fn klines_range(
        &self,
        spec: &SymbolSpec,
        interval_ms: i64,
        from_ms: i64,
        to_ms: i64,
        max_pages: u32,
    ) -> Result<Vec<Kline>> {
        let tf = kline_timeframe(interval_ms).ok_or_else(|| {
            ConnectorError::Other(format!("unsupported kline interval {interval_ms} ms"))
        })?;
        let first = from_ms.div_euclid(interval_ms) * interval_ms;
        let mut out: Vec<Kline> = Vec::new();
        for (a, b) in windows(first, to_ms, KLINE_PAGE * interval_ms)
            .into_iter()
            .take(max_pages as usize)
        {
            let v = self
                .get(&format!(
                    "/v2/candles/trade:{tf}:{}/hist?start={a}&end={}&limit={KLINE_PAGE}&sort=1",
                    spec.symbol,
                    b - 1
                ))
                .await?;
            for r in v
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_array)
            {
                out.push(kline_of(spec, interval_ms, r)?);
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

    const FIXTURE: &str = include_str!("../tests/fixtures/candles-hist.json");

    fn spec() -> SymbolSpec {
        SymbolSpec::new("tBTCUSD", TickSize::parse("0.1").unwrap(), 8)
    }

    #[test]
    fn parses_fixture() {
        let rows: Vec<Vec<Value>> = serde_json::from_str(FIXTURE).unwrap();
        let k: Vec<Kline> = rows
            .iter()
            .map(|r| kline_of(&spec(), 60_000, r).unwrap())
            .collect();
        assert_eq!(k[0].open_ms, 1_700_000_040_000);
        // Column order is open, close, high, low.
        assert_eq!(
            (k[0].open, k[0].high, k[0].low, k[0].close),
            (270_000, 270_105, 269_900, 270_055)
        );
        assert_eq!((k[0].volume, k[0].taker_buy), (12.5, Some(12.5)));
        assert_eq!(k[1].taker_buy, Some(0.0));
        assert_eq!(k[2].taker_buy, Some(0.0005));
        assert!(kline_of(&spec(), 60_000, &[Value::Null]).is_err());
        assert!(KLINE_INTERVALS
            .iter()
            .all(|i| kline_timeframe(*i).is_some()));
    }

    #[tokio::test]
    async fn one_request_per_window() {
        let srv = MockServer::start(|t| {
            let p = |k| query_param(t, k).and_then(|v| v.parse::<i64>().ok());
            let (s, e) = (p("start").unwrap(), p("end").unwrap());
            let rows: Vec<String> = (0..p("limit").unwrap())
                .map(|i| s + i * 3_600_000)
                .filter(|o| *o <= e)
                .map(|o| format!("[{o},100.0,100.5,101.0,99.0,2.0]"))
                .collect();
            Reply::ok(format!("[{}]", rows.join(",")))
        });
        let b = Bitfinex::new(&srv.base, "ws://unused");
        let k = b
            .klines_range(&spec(), 3_600_000, 0, 120 * 3_600_000, 3)
            .await
            .unwrap();
        assert_eq!(k.len(), 120);
        assert_eq!(k[1].open_ms, 3_600_000);
        assert_eq!(
            srv.requests(),
            vec!["/v2/candles/trade:1h:tBTCUSD/hist?start=0&end=431999999&limit=10000&sort=1"]
        );
        assert!(b.klines_range(&spec(), 61_000, 0, 1, 1).await.is_err());
        assert!(!b.kline_intervals().is_empty());
        let err = MockServer::start(|_| Reply::ok(r#"["error",10020,"timeframe: invalid"]"#));
        let b = Bitfinex::new(&err.base, "ws://unused");
        assert!(b
            .klines_range(&spec(), 60_000, 0, 600_000, 1)
            .await
            .is_err());
    }
}
