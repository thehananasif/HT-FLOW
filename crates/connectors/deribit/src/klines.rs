//! Deribit candles for the history backfill (P06):
//! `public/get_tradingview_chart_data?instrument_name=&start_timestamp=&end_timestamp=&resolution=`.
//!
//! * The result is column-wise: `ticks` (bar open, ms), `open`, `high`, `low`, `close`,
//!   `volume` (base currency) and `cost` (quote currency, i.e. contracts of USD on inverse
//!   instruments); up to 5,000 bars per request, so a range is a single request.
//! * Volume uses the unit of the trade feed (`amount`): `cost` for inverse instruments
//!   (`BTC-PERPETUAL`, `ETH-27DEC24`, … = USD contracts) and `volume` for linear ones
//!   (`BTC_USDC-PERPETUAL`, spot `BTC_USDC`, … = base units).
//! * Deribit gives no taker split, so the volume is split by candle direction
//!   ([`htflow_connector_common::directional_taker_buy`]).
//! * Rate limit: the shared bucket (20 burst, ~10 / s) plus the `Retry-After` back-off of
//!   [`htflow_connector_common::Rest`].
use htflow_connector_common::{
    directional_taker_buy, f64_ticks, finish_klines, windows, ConnectorError, Kline, Result,
    SymbolSpec,
};
use serde::Deserialize;

use crate::Deribit;

/// Candle widths served (ms, ascending).
pub const KLINE_INTERVALS: &[i64] = &[
    60_000, 180_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000,
    21_600_000, 43_200_000, 86_400_000,
];

/// Bars per request.
pub const KLINE_PAGE: i64 = 5_000;
/// Requests one [`Deribit::klines_range`] call may spend.
pub const KLINE_PAGES: u32 = 1;

/// Deribit `resolution` of an interval (minutes, or `1D`).
pub fn kline_resolution(ms: i64) -> Option<String> {
    if !KLINE_INTERVALS.contains(&ms) {
        return None;
    }
    Some(if ms == 86_400_000 {
        "1D".to_string()
    } else {
        (ms / 60_000).to_string()
    })
}

/// True for instruments whose size is in contracts of quote currency (`BTC-PERPETUAL`), false
/// for linear ones named `BASE_QUOTE-…`.
pub fn is_inverse(instrument: &str) -> bool {
    !instrument.split('-').next().unwrap_or("").contains('_')
}

/// Column-wise chart data of `get_tradingview_chart_data`.
#[derive(Debug, Deserialize, Default)]
pub struct Chart {
    #[serde(default)]
    pub ticks: Vec<i64>,
    #[serde(default)]
    pub open: Vec<f64>,
    #[serde(default)]
    pub high: Vec<f64>,
    #[serde(default)]
    pub low: Vec<f64>,
    #[serde(default)]
    pub close: Vec<f64>,
    #[serde(default)]
    pub volume: Vec<f64>,
    #[serde(default)]
    pub cost: Vec<f64>,
}

/// The bars of a chart answer (see the module docs for the volume unit).
pub fn klines_of(spec: &SymbolSpec, span_ms: i64, c: &Chart) -> Result<Vec<Kline>> {
    let n = c.ticks.len();
    if [c.open.len(), c.high.len(), c.low.len(), c.close.len()]
        .iter()
        .any(|l| *l != n)
    {
        return Err(ConnectorError::Other("deribit chart columns differ".into()));
    }
    let vols = if is_inverse(&spec.symbol) {
        &c.cost
    } else {
        &c.volume
    };
    (0..n)
        .map(|i| {
            let (o, cl) = (
                f64_ticks(&spec.tick, c.open[i])?,
                f64_ticks(&spec.tick, c.close[i])?,
            );
            let v = vols.get(i).copied().unwrap_or(0.0);
            Ok(Kline {
                open_ms: c.ticks[i],
                span_ms,
                open: o,
                high: f64_ticks(&spec.tick, c.high[i])?,
                low: f64_ticks(&spec.tick, c.low[i])?,
                close: cl,
                volume: v,
                taker_buy: Some(directional_taker_buy(o, cl, v)),
            })
        })
        .collect()
}

impl Deribit {
    /// Candles of `interval_ms` (see [`KLINE_INTERVALS`]) opening in `[from_ms, to_ms)`, oldest
    /// first, in windows of 5,000 bars (at most `max_pages` requests).
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
            let c: Chart = self
                .call(&format!(
                    "get_tradingview_chart_data?instrument_name={}&start_timestamp={a}&end_timestamp={}&resolution={res}",
                    spec.symbol,
                    b - 1
                ))
                .await?;
            out.extend(klines_of(spec, interval_ms, &c)?);
        }
        Ok(finish_klines(out, first, to_ms))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire;
    use htflow_connector_common::mock_http::{query_param, MockServer, Reply};
    use htflow_connector_common::MarketApi;
    use htflow_core_types::TickSize;

    const FIXTURE: &str = include_str!("../tests/fixtures/chart-data.json");

    fn spec(name: &str) -> SymbolSpec {
        SymbolSpec::new(name, TickSize::parse("0.5").unwrap(), 0)
    }

    #[test]
    fn parses_fixture_inverse_and_linear() {
        let r: wire::Rpc<Chart> = serde_json::from_str(FIXTURE).unwrap();
        let chart = r.result.unwrap();
        let k = klines_of(&spec("BTC-PERPETUAL"), 60_000, &chart).unwrap();
        assert_eq!(k.len(), 3);
        assert_eq!(k[0].open_ms, 1_700_000_040_000);
        assert_eq!(
            (k[0].open, k[0].high, k[0].low, k[0].close),
            (74_001, 74_020, 73_980, 74_010)
        );
        // Inverse: USD contracts (`cost`); a bullish bar is booked as buying.
        assert_eq!((k[0].volume, k[0].taker_buy), (18_500.0, Some(18_500.0)));
        assert_eq!(k[1].taker_buy, Some(0.0));
        // Linear: base units (`volume`).
        let l = klines_of(&spec("BTC_USDC-PERPETUAL"), 60_000, &chart).unwrap();
        assert_eq!(l[0].volume, 0.5);
        assert!(is_inverse("ETH-27DEC24") && !is_inverse("SOL_USDC-PERPETUAL"));
        let bad = Chart {
            ticks: vec![1],
            ..Chart::default()
        };
        assert!(klines_of(&spec("BTC-PERPETUAL"), 60_000, &bad).is_err());
        assert_eq!(kline_resolution(86_400_000).as_deref(), Some("1D"));
        assert_eq!(kline_resolution(7_200_000).as_deref(), Some("120"));
        assert_eq!(kline_resolution(61_000), None);
    }

    #[tokio::test]
    async fn one_request_and_errors() {
        let srv = MockServer::start(|t| {
            let p = |k| query_param(t, k).and_then(|v| v.parse::<i64>().ok());
            let (s, e) = (p("start_timestamp").unwrap(), p("end_timestamp").unwrap());
            let ticks: Vec<i64> = (0..5000)
                .map(|i| s + i * 3_600_000)
                .filter(|o| *o <= e)
                .collect();
            let col = |v: &str| vec![v; ticks.len()].join(",");
            let tk: Vec<String> = ticks.iter().map(i64::to_string).collect();
            Reply::ok(format!(
                r#"{{"result":{{"status":"ok","ticks":[{}],"open":[{}],"high":[{}],"low":[{}],"close":[{}],"volume":[{}],"cost":[{}]}}}}"#,
                tk.join(","),
                col("100.0"),
                col("101.0"),
                col("99.0"),
                col("100.5"),
                col("2.0"),
                col("200.0"),
            ))
        });
        let d = Deribit::new(&srv.base, "ws://unused");
        let k = d
            .klines_range(&spec("BTC-PERPETUAL"), 3_600_000, 0, 48 * 3_600_000, 1)
            .await
            .unwrap();
        assert_eq!(k.len(), 48);
        assert_eq!(k[47].open_ms, 47 * 3_600_000);
        assert_eq!(
            srv.requests(),
            vec!["/api/v2/public/get_tradingview_chart_data?instrument_name=BTC-PERPETUAL&start_timestamp=0&end_timestamp=172799999&resolution=60"]
        );
        assert!(d
            .klines_range(&spec("BTC-PERPETUAL"), 61_000, 0, 1, 1)
            .await
            .is_err());
        assert!(!d.kline_intervals().is_empty());
        let err = MockServer::start(|_| {
            Reply::ok(r#"{"error":{"code":13020,"message":"Instrument not found"}}"#)
        });
        let d = Deribit::new(&err.base, "ws://unused");
        let e = d
            .klines_range(&spec("NOPE"), 60_000, 0, 600_000, 1)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("13020"));
    }
}
