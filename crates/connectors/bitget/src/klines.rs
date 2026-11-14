//! Bitget candles for the history backfill (P06): `/api/v2/mix/market/history-candles`.
//!
//! * Rows are `[ts, o, h, l, c, baseVolume, quoteVolume, usdtVolume]`, oldest first, at most
//!   200 per request; a range is cut into windows of 200 bars (`startTime` / `endTime`).
//! * Volume is the base-coin volume (`baseVolume`), the unit the trade feed uses.
//! * Bars from 6 h up use the `utc` granularities so they open on UTC boundaries.
//! * Bitget gives no taker split, so the volume is split by candle direction
//!   ([`htflow_connector_common::directional_taker_buy`]).
//! * Rate limit: the shared 10 req/s bucket (Bitget allows 20/s per IP) plus the
//!   `Retry-After` back-off of [`htflow_connector_common::Rest`].
use htflow_connector_common::{
    bar, finish_klines, num_text, parse_f64, windows, ConnectorError, Kline, Result, SymbolSpec,
};
use serde_json::Value;

use crate::{product_type, Bitget};

/// Candle widths served (ms, ascending).
pub const KLINE_INTERVALS: &[i64] = &[
    60_000, 180_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000, 21_600_000, 43_200_000,
    86_400_000,
];

/// Bars per request.
pub const KLINE_PAGE: i64 = 200;
/// Requests one [`Bitget::klines_range`] call may spend (≤ 5,000 bars).
pub const KLINE_PAGES: u32 = 25;

/// Bitget `granularity` of an interval.
pub fn kline_granularity(ms: i64) -> Option<&'static str> {
    Some(match ms {
        60_000 => "1m",
        180_000 => "3m",
        300_000 => "5m",
        900_000 => "15m",
        1_800_000 => "30m",
        3_600_000 => "1H",
        14_400_000 => "4H",
        21_600_000 => "6Hutc",
        43_200_000 => "12Hutc",
        86_400_000 => "1Dutc",
        _ => return None,
    })
}

/// One candle row (see the module docs).
pub fn kline_of(spec: &SymbolSpec, span_ms: i64, r: &[Value]) -> Result<Kline> {
    let t = |i: usize| -> Result<String> {
        r.get(i)
            .and_then(num_text)
            .ok_or_else(|| ConnectorError::Other(format!("bitget candle field {i}")))
    };
    let open_ms: i64 = t(0)?
        .parse()
        .map_err(|_| ConnectorError::Other("bitget candle time".into()))?;
    bar(
        &spec.tick,
        open_ms,
        span_ms,
        &t(1)?,
        &t(2)?,
        &t(3)?,
        &t(4)?,
        parse_f64(&t(5)?)?,
    )
}

impl Bitget {
    /// Candles of `interval_ms` (see [`KLINE_INTERVALS`]) opening in `[from_ms, to_ms)`, oldest
    /// first, in windows of 200 bars (at most `max_pages` requests).
    pub async fn klines_range(
        &self,
        spec: &SymbolSpec,
        interval_ms: i64,
        from_ms: i64,
        to_ms: i64,
        max_pages: u32,
    ) -> Result<Vec<Kline>> {
        let gran = kline_granularity(interval_ms).ok_or_else(|| {
            ConnectorError::Other(format!("unsupported kline interval {interval_ms} ms"))
        })?;
        let first = from_ms.div_euclid(interval_ms) * interval_ms;
        let pt = product_type(&spec.symbol);
        let mut out: Vec<Kline> = Vec::new();
        for (a, b) in windows(first, to_ms, KLINE_PAGE * interval_ms)
            .into_iter()
            .take(max_pages as usize)
        {
            let rows: Vec<Vec<Value>> = self
                .get(&format!(
                    "/api/v2/mix/market/history-candles?symbol={}&productType={pt}&granularity={gran}&startTime={a}&endTime={}&limit={KLINE_PAGE}",
                    spec.symbol,
                    b - 1
                ))
                .await?;
            for r in &rows {
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

    const FIXTURE: &str = include_str!("../tests/fixtures/history-candles.json");

    fn spec() -> SymbolSpec {
        SymbolSpec::new("BTCUSDT", TickSize::parse("0.1").unwrap(), 3)
    }

    #[test]
    fn parses_fixture() {
        let r: crate::wire::Rest<Vec<Vec<Value>>> = serde_json::from_str(FIXTURE).unwrap();
        let rows: Vec<Kline> = r
            .data
            .unwrap()
            .iter()
            .map(|r| kline_of(&spec(), 60_000, r).unwrap())
            .collect();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].open_ms, 1_700_000_040_000);
        assert_eq!(
            (rows[0].open, rows[0].high, rows[0].low, rows[0].close),
            (270_000, 270_105, 269_900, 270_055)
        );
        assert_eq!((rows[0].volume, rows[0].taker_buy), (12.5, Some(12.5)));
        assert_eq!(rows[1].taker_buy, Some(0.0)); // bearish: sells
        assert_eq!(rows[2].taker_buy, Some(0.5)); // flat: half and half
        assert!(kline_of(&spec(), 60_000, &[]).is_err());
        assert_eq!(kline_granularity(86_400_000), Some("1Dutc"));
        assert!(KLINE_INTERVALS
            .iter()
            .all(|i| kline_granularity(*i).is_some()));
    }

    #[tokio::test]
    async fn windows_of_200_bars() {
        let srv = MockServer::start(|t| {
            let p = |k| query_param(t, k).and_then(|v| v.parse::<i64>().ok());
            let (s, e) = (p("startTime").unwrap(), p("endTime").unwrap());
            let rows: Vec<String> = (0..200)
                .map(|i| s + i * 60_000)
                .filter(|o| *o <= e)
                .map(|o| format!(r#"["{o}","100","101","99","100.5","2","0","0"]"#))
                .collect();
            Reply::ok(format!(
                r#"{{"code":"00000","msg":"success","data":[{}]}}"#,
                rows.join(",")
            ))
        });
        let b = Bitget::new(&srv.base, "ws://unused");
        let k = b
            .klines_range(&spec(), 60_000, 0, 450 * 60_000, 10)
            .await
            .unwrap();
        assert_eq!(k.len(), 450);
        assert_eq!(k[449].open_ms, 449 * 60_000);
        let reqs = srv.requests();
        assert_eq!(reqs.len(), 3, "{reqs:?}");
        assert!(
            reqs[0].contains("productType=USDT-FUTURES") && reqs[0].contains("granularity=1m"),
            "{reqs:?}"
        );
        assert!(reqs[1].contains("startTime=12000000&endTime=23999999"));
        assert_eq!(
            b.klines_range(&spec(), 60_000, 0, 450 * 60_000, 2)
                .await
                .unwrap()
                .len(),
            400
        );
        assert!(b.klines_range(&spec(), 61_000, 0, 1, 1).await.is_err());
        assert!(!b.kline_intervals().is_empty());
        let bad = MockServer::start(|_| Reply::ok(r#"{"code":"40034","msg":"Parameter error"}"#));
        let b = Bitget::new(&bad.base, "ws://unused");
        let e = b.klines_range(&spec(), 60_000, 0, 600_000, 1).await;
        assert!(e.unwrap_err().to_string().contains("40034"));
    }
}
