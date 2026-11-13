//! OKX candles for the history backfill (P06): `/api/v5/market/history-candles`.
//!
//! * Rows are `[ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]`, newest first, at most 100
//!   per request; the next (older) page is requested with `after=<oldest ts of the page>`.
//! * `vol` is in contracts on derivatives (multiplied by the contract value like trades are;
//!   inverse contracts stay in contracts) and in base units on spot.
//! * Bars from 6 h up use the `utc` bar names so they open on UTC boundaries (OKX's default
//!   6H / 12H / 1D bars open at 00:00 Hong Kong time).
//! * OKX gives no taker split, so the volume is split by candle direction
//!   ([`htflow_connector_common::directional_taker_buy`]).
//! * Rate limit: the shared 10 req/s bucket plus the `Retry-After` back-off of [`Rest`].
use htflow_connector_common::{
    bar, finish_klines, num_text, parse_f64, scale_qty, ConnectorError, Kline, Result, SymbolSpec,
};
use serde_json::Value;

use crate::Okx;

/// Candle widths served (ms, ascending).
pub const KLINE_INTERVALS: &[i64] = &[
    60_000, 180_000, 300_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 21_600_000,
    43_200_000, 86_400_000,
];

/// Rows per request on `history-candles`.
pub const KLINE_PAGE: usize = 100;
/// Pages one [`Okx::klines_range`] call may spend (≤ 5,000 bars).
pub const KLINE_PAGES: u32 = 50;

/// OKX `bar` name of an interval.
pub fn kline_bar_name(ms: i64) -> Option<&'static str> {
    Some(match ms {
        60_000 => "1m",
        180_000 => "3m",
        300_000 => "5m",
        900_000 => "15m",
        1_800_000 => "30m",
        3_600_000 => "1H",
        7_200_000 => "2H",
        14_400_000 => "4H",
        21_600_000 => "6Hutc",
        43_200_000 => "12Hutc",
        86_400_000 => "1Dutc",
        _ => return None,
    })
}

/// One candle row (see the module docs); `vol` is scaled by the contract value.
pub fn kline_of(spec: &SymbolSpec, span_ms: i64, r: &[Value]) -> Result<Kline> {
    let t = |i: usize| -> Result<String> {
        r.get(i)
            .and_then(num_text)
            .ok_or_else(|| ConnectorError::Other(format!("okx candle field {i}")))
    };
    let open_ms: i64 = t(0)?
        .parse()
        .map_err(|_| ConnectorError::Other("okx candle time".into()))?;
    let vol = scale_qty(parse_f64(&t(5)?)?, spec.contract_value, spec.qty_precision);
    bar(
        &spec.tick,
        open_ms,
        span_ms,
        &t(1)?,
        &t(2)?,
        &t(3)?,
        &t(4)?,
        vol,
    )
}

impl Okx {
    /// Candles of `interval_ms` (see [`KLINE_INTERVALS`]) opening in `[from_ms, to_ms)`, oldest
    /// first: pages `history-candles` backwards from `to_ms` (100 bars each) until `from_ms`,
    /// the end of the history or `max_pages`.
    pub async fn klines_range(
        &self,
        spec: &SymbolSpec,
        interval_ms: i64,
        from_ms: i64,
        to_ms: i64,
        max_pages: u32,
    ) -> Result<Vec<Kline>> {
        let bar = kline_bar_name(interval_ms).ok_or_else(|| {
            ConnectorError::Other(format!("unsupported kline interval {interval_ms} ms"))
        })?;
        let first = from_ms.div_euclid(interval_ms) * interval_ms;
        let mut out: Vec<Kline> = Vec::new();
        let mut after = to_ms;
        for _ in 0..max_pages {
            if after <= first {
                break;
            }
            let rows: Vec<Vec<Value>> = self
                .get(&format!(
                    "/api/v5/market/history-candles?instId={}&bar={bar}&after={after}&limit={KLINE_PAGE}",
                    spec.symbol
                ))
                .await?;
            let n = rows.len();
            let mut oldest = i64::MAX;
            for r in &rows {
                let k = kline_of(spec, interval_ms, r)?;
                oldest = oldest.min(k.open_ms);
                out.push(k);
            }
            if n < KLINE_PAGE || oldest >= after {
                break;
            }
            after = oldest;
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

    const FIXTURE: &str = include_str!("../tests/fixtures/history-candles.json");

    fn spec(cv: f64) -> SymbolSpec {
        let mut s = SymbolSpec::new("BTC-USDT-SWAP", TickSize::parse("0.1").unwrap(), 4);
        s.contract_value = cv;
        s
    }

    #[test]
    fn parses_fixture() {
        let r: wire::Rest<Vec<Value>> = serde_json::from_str(FIXTURE).unwrap();
        let rows: Vec<Kline> = r
            .data
            .iter()
            .map(|r| kline_of(&spec(0.01), 60_000, r).unwrap())
            .collect();
        assert_eq!(rows.len(), 3);
        let k = rows[0];
        assert_eq!(k.open_ms, 1_700_000_160_000);
        assert_eq!((k.open, k.high, k.low, k.close), (1015, 1030, 1010, 1020));
        // 12 contracts × 0.01 = 0.12 base; a bullish bar is booked as buying.
        assert_eq!((k.volume, k.taker_buy), (0.12, Some(0.12)));
        // The bearish bar sells.
        assert_eq!(rows[2].taker_buy, Some(0.0));
        assert!(kline_of(&spec(1.0), 60_000, &[Value::Null]).is_err());
        assert_eq!(kline_bar_name(21_600_000), Some("6Hutc"));
        assert_eq!(kline_bar_name(61_000), None);
        assert!(KLINE_INTERVALS.iter().all(|i| kline_bar_name(*i).is_some()));
    }

    /// One bar per minute, 250 bars (ids 0..250 at minute `i`), pages of 100 older than `after`.
    #[tokio::test]
    async fn pages_backwards_to_from() {
        let srv = MockServer::start(|t| {
            let after: i64 = query_param(t, "after").unwrap().parse().unwrap();
            let end = (after / 60_000).min(250);
            let rows: Vec<String> = ((end - 100).max(0)..end)
                .rev()
                .map(|m| {
                    format!(
                        r#"["{}","100","101","99","100.5","2","0","0","1"]"#,
                        m * 60_000
                    )
                })
                .collect();
            Reply::ok(format!(
                r#"{{"code":"0","msg":"","data":[{}]}}"#,
                rows.join(",")
            ))
        });
        let okx = Okx::new(&srv.base, "ws://unused");
        let sp = spec(1.0);
        let k = okx
            .klines_range(&sp, 60_000, 30 * 60_000, 250 * 60_000, 10)
            .await
            .unwrap();
        assert_eq!(k.len(), 220);
        assert_eq!(k[0].open_ms, 30 * 60_000);
        assert_eq!(k.last().unwrap().open_ms, 249 * 60_000);
        assert_eq!(k[0].span_ms, 60_000);
        let reqs = srv.requests();
        assert_eq!(reqs.len(), 3, "{reqs:?}");
        assert!(reqs[0].contains("after=15000000&limit=100"), "{reqs:?}");
        assert!(reqs[0].contains("bar=1m"));
        assert!(reqs[1].contains("after=9000000"), "{reqs:?}");
        // A budget of one page keeps only the newest bars.
        let k = okx
            .klines_range(&sp, 60_000, 0, 250 * 60_000, 1)
            .await
            .unwrap();
        assert_eq!(k.len(), 100);
        assert!(okx.klines_range(&sp, 61_000, 0, 1, 1).await.is_err());
        assert!(!okx.kline_intervals().is_empty());
    }

    #[tokio::test]
    async fn api_errors_surface() {
        let srv = MockServer::start(|_| {
            Reply::ok(r#"{"code":"51001","msg":"Instrument ID does not exist","data":[]}"#)
        });
        let okx = Okx::new(&srv.base, "ws://unused");
        let e = okx
            .klines_range(&spec(1.0), 60_000, 0, 600_000, 1)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("51001"));
    }
}
