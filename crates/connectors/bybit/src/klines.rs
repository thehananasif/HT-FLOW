//! Bybit candles for the history backfill (P06): `/v5/market/kline`.
//!
//! * Rows are `[start (ms), open, high, low, close, volume, turnover]` as strings, **newest
//!   first**, at most 1,000 per request; a range is cut into windows of 1,000 bars
//!   (`start` / `end`) so no window is truncated.
//! * `category` is `linear` (the connector's market), `inverse` or `spot`
//!   ([`BybitLinear::klines_in`]); volume is base units on linear / spot and contracts (USD)
//!   on inverse, like the trade feed.
//! * Bybit gives no taker split, so the volume is split by candle direction
//!   ([`htflow_connector_common::directional_taker_buy`]).
//! * Rate limit: the shared 10 req/s bucket plus the `Retry-After` back-off of
//!   [`htflow_connector_common::Rest`]; Bybit also answers HTTP 200 with `retCode` 10006 /
//!   10018 ("too many visits"), which is waited out with the same exponential back-off.
use htflow_connector_common::rest::{retry_wait, MAX_RETRIES};
use htflow_connector_common::{bar_text, finish_klines, windows, Kline};

use crate::{wire, BybitLinear, ConnectorError, SymbolSpec};

/// Candle widths served (ms, ascending).
pub const KLINE_INTERVALS: &[i64] = &[
    60_000, 180_000, 300_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 21_600_000,
    43_200_000, 86_400_000,
];

/// Bars per request.
pub const KLINE_PAGE: i64 = 1_000;
/// Requests one [`BybitLinear::klines_range`] call may spend (≤ 5,000 bars).
pub const KLINE_PAGES: u32 = 5;

/// `result` of a kline answer (absent on errors).
#[derive(Debug, serde::Deserialize, Default)]
pub struct Page {
    #[serde(default)]
    pub list: Vec<Vec<String>>,
}

/// Bybit `interval` of an interval.
pub fn kline_interval(ms: i64) -> Option<&'static str> {
    Some(match ms {
        60_000 => "1",
        180_000 => "3",
        300_000 => "5",
        900_000 => "15",
        1_800_000 => "30",
        3_600_000 => "60",
        7_200_000 => "120",
        14_400_000 => "240",
        21_600_000 => "360",
        43_200_000 => "720",
        86_400_000 => "D",
        _ => return None,
    })
}

fn other(e: htflow_connector_common::ConnectorError) -> ConnectorError {
    ConnectorError::Api(e.to_string())
}

/// One candle row (see the module docs).
pub fn kline_of(spec: &SymbolSpec, span_ms: i64, r: &[String]) -> Result<Kline, ConnectorError> {
    let f = |i: usize| -> Result<&str, ConnectorError> {
        r.get(i)
            .map(String::as_str)
            .ok_or_else(|| ConnectorError::Other(format!("kline field {i}")))
    };
    let open_ms: i64 = f(0)?
        .parse()
        .map_err(|_| ConnectorError::Other("kline open time".into()))?;
    bar_text(
        &spec.tick,
        open_ms,
        span_ms,
        f(1)?,
        f(2)?,
        f(3)?,
        f(4)?,
        f(5)?,
    )
    .map_err(other)
}

impl BybitLinear {
    /// Rate-limited answers seen so far (see [`htflow_connector_common::Rest::throttled`]).
    pub fn throttled(&self) -> u64 {
        self.kline_rest.throttled_count()
    }

    /// Candles of this client's category, see [`BybitLinear::klines_in`].
    pub async fn klines_range(
        &self,
        spec: &SymbolSpec,
        interval_ms: i64,
        from_ms: i64,
        to_ms: i64,
    ) -> Result<Vec<Kline>, ConnectorError> {
        self.klines_in(self.category.as_str(), spec, interval_ms, from_ms, to_ms)
            .await
    }

    /// Candles of `interval_ms` (see [`KLINE_INTERVALS`]) opening in `[from_ms, to_ms)` for a
    /// `category` (`linear`, `inverse` or `spot`), oldest first.
    pub async fn klines_in(
        &self,
        category: &str,
        spec: &SymbolSpec,
        interval_ms: i64,
        from_ms: i64,
        to_ms: i64,
    ) -> Result<Vec<Kline>, ConnectorError> {
        if !matches!(category, "linear" | "inverse" | "spot") {
            return Err(ConnectorError::Other(format!("bad category {category}")));
        }
        let iv = kline_interval(interval_ms).ok_or_else(|| {
            ConnectorError::Other(format!("unsupported kline interval {interval_ms} ms"))
        })?;
        let first = from_ms.div_euclid(interval_ms) * interval_ms;
        let mut out: Vec<Kline> = Vec::new();
        for (a, b) in windows(first, to_ms, KLINE_PAGE * interval_ms)
            .into_iter()
            .take(KLINE_PAGES as usize)
        {
            let path = format!(
                "/v5/market/kline?category={category}&symbol={}&interval={iv}&start={a}&end={}&limit={KLINE_PAGE}",
                spec.symbol,
                b - 1
            );
            let list = self.kline_page(&path).await?;
            for r in &list {
                out.push(kline_of(spec, interval_ms, r)?);
            }
        }
        Ok(finish_klines(out, first, to_ms))
    }

    /// One `kline` answer's rows; retries `retCode` 10006 / 10018 with the shared back-off.
    async fn kline_page(&self, path: &str) -> Result<Vec<Vec<String>>, ConnectorError> {
        let mut attempt = 0;
        loop {
            let text = self.kline_rest.get_text(path).await.map_err(other)?;
            let r: wire::Rest<Page> = serde_json::from_str(&text)?;
            if matches!(r.ret_code, 10006 | 10018) && attempt < MAX_RETRIES {
                self.kline_rest
                    .throttled
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if let Some(w) = retry_wait(429, None, attempt) {
                    tokio::time::sleep(w).await;
                    attempt += 1;
                    continue;
                }
            }
            if r.ret_code != 0 {
                return Err(ConnectorError::Api(r.ret_msg));
            }
            return Ok(r.result.map(|l| l.list).unwrap_or_default());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Endpoints;
    use htflow_connector_common::mock_http::{query_param, MockServer, Reply};
    use htflow_core_types::TickSize;

    const FIXTURE: &str = include_str!("../tests/fixtures/kline.json");

    fn spec() -> SymbolSpec {
        SymbolSpec {
            symbol: "BTCUSDT".into(),
            tick: TickSize::parse("0.5").unwrap(),
            qty_precision: 3,
        }
    }

    fn client(base: &str) -> BybitLinear {
        BybitLinear::new(Endpoints {
            rest: base.into(),
            ws: "ws://unused".into(),
        })
    }

    #[test]
    fn parses_fixture() {
        let r: wire::Rest<Page> = serde_json::from_str(FIXTURE).unwrap();
        let k: Vec<Kline> = r
            .result
            .unwrap()
            .list
            .iter()
            .map(|r| kline_of(&spec(), 60_000, r).unwrap())
            .collect();
        // Newest first, as served.
        assert_eq!(k[0].open_ms, 1_700_000_160_000);
        assert_eq!(k[2].open_ms, 1_700_000_040_000);
        assert_eq!(
            (k[2].open, k[2].high, k[2].low, k[2].close),
            (74_001, 74_020, 73_980, 74_010)
        );
        assert_eq!((k[2].volume, k[2].taker_buy), (12.5, Some(12.5)));
        assert_eq!(k[1].taker_buy, Some(0.0));
        assert!(kline_of(&spec(), 60_000, &["x".to_string()]).is_err());
        assert!(KLINE_INTERVALS.iter().all(|i| kline_interval(*i).is_some()));
    }

    /// Newest-first pages of up to 1,000 bars inside `[start, end]`.
    fn mock() -> MockServer {
        MockServer::start(|t| {
            let p = |k| query_param(t, k).and_then(|v| v.parse::<i64>().ok());
            let (s, e) = (p("start").unwrap(), p("end").unwrap());
            let step = match t.split("interval=").nth(1).map(|x| x.split('&').next()) {
                Some(Some("1")) => 60_000,
                Some(Some("60")) => 3_600_000,
                _ => 86_400_000,
            };
            let rows: Vec<String> = (0..1000)
                .map(|i| s + i * step)
                .filter(|o| *o <= e)
                .rev()
                .map(|o| format!(r#"["{o}","100","101","99","100.5","2","200"]"#))
                .collect();
            Reply::ok(format!(
                r#"{{"retCode":0,"retMsg":"OK","result":{{"list":[{}]}}}}"#,
                rows.join(",")
            ))
        })
    }

    #[tokio::test]
    async fn windows_categories_and_order() {
        let srv = mock();
        let b = client(&srv.base);
        let k = b
            .klines_range(&spec(), 60_000, 0, 2500 * 60_000)
            .await
            .unwrap();
        assert_eq!(k.len(), 2500);
        assert!(k.windows(2).all(|w| w[0].open_ms < w[1].open_ms));
        let reqs = srv.requests();
        assert_eq!(reqs.len(), 3, "{reqs:?}");
        assert!(
            reqs[0].contains("category=linear&symbol=BTCUSDT&interval=1&start=0&end=59999"),
            "{reqs:?}"
        );
        let h = b
            .klines_in("spot", &spec(), 3_600_000, 0, 10 * 3_600_000)
            .await
            .unwrap();
        assert_eq!(h.len(), 10);
        assert_eq!(h[0].span_ms, 3_600_000);
        assert!(srv
            .requests()
            .last()
            .unwrap()
            .contains("category=spot&symbol=BTCUSDT&interval=60"));
        assert!(b
            .klines_in("inverse", &spec(), 86_400_000, 0, 86_400_000)
            .await
            .is_ok());
        assert!(b.klines_in("option", &spec(), 60_000, 0, 1).await.is_err());
        assert!(b.klines_range(&spec(), 61_000, 0, 1).await.is_err());
    }

    #[tokio::test]
    async fn api_errors_and_rate_limit_answers() {
        let srv = MockServer::start(|_| {
            Reply::ok(r#"{"retCode":10001,"retMsg":"params error: symbol invalid","result":{}}"#)
        });
        let e = client(&srv.base)
            .klines_range(&spec(), 60_000, 0, 600_000)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("symbol invalid"));

        // HTTP 429 with Retry-After and a retCode 10006 body are both waited out (1 s).
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let h = hits.clone();
        let srv = MockServer::start(move |_| {
            match h.fetch_add(1, std::sync::atomic::Ordering::SeqCst) {
                0 => Reply::status("429 Too Many Requests", "{}").header("Retry-After: 0"),
                1 => Reply::ok(r#"{"retCode":10006,"retMsg":"Too many visits","result":{}}"#),
                _ => Reply::ok(
                    r#"{"retCode":0,"retMsg":"OK","result":{"list":[["0","1","2","0.5","1.5","3","4"]]}}"#,
                ),
            }
        });
        let b = client(&srv.base);
        let k = b.klines_range(&spec(), 60_000, 0, 60_000).await.unwrap();
        assert_eq!(k.len(), 1);
        assert_eq!(b.throttled(), 2);
        assert_eq!(srv.requests().len(), 3);
    }
}
