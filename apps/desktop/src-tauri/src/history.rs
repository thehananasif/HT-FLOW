//! P06 "Load days": newest-first history backfill for one `[from, to)` range.
//!
//! The range is walked from `to` backwards in one-hour chunks:
//! 1. chunks the local tick store fully covers come from the store;
//! 2. recent chunks (the last [`Plan::trades_recent_ms`]) come from the size-capped
//!    [`HistoryCache`] or, on a miss, from the venue's REST trades paged newest-first
//!    ([`MarketApi::trades_back`]) until the request budget ([`Plan::max_pages`]) runs out;
//! 3. everything older (or past the budget) comes from klines ([`MarketApi::klines`]) turned
//!    into synthetic trades ([`kline_trades`]) — exact OHLC, volume and delta per bar, so long
//!    timeframes never need millions of trades. The kline interval is the smallest one that
//!    covers the span in at most [`MAX_KLINE_BARS`] bars.
//!
//! Synthetic trades never overlap real ones: klines stop at the oldest real trade downloaded.
//! Progress is reported after every chunk.
use htflow_connector_common::{
    kline_trades, pick_kline_interval, ConnectorError, Kline, MarketApi, SymbolSpec,
};
use htflow_core_types::Trade;
use serde::Serialize;

use crate::history_cache::HistoryCache;

pub const TRADE_CHUNK_MS: i64 = 3_600_000;
pub const DAY_MS: i64 = 86_400_000;
/// Upper bound of klines per request range (≈ 40k synthetic trades).
pub const MAX_KLINE_BARS: i64 = 5_000;
/// Chunks closer than this to "now" may still change and are not cached.
pub const OPEN_MARGIN_MS: i64 = 120_000;

#[derive(Debug, Clone, Copy)]
pub struct Plan {
    pub from_ms: i64,
    pub to_ms: i64,
    pub now_ms: i64,
    /// REST requests allowed for real trades in this call.
    pub max_pages: u32,
    /// Only chunks newer than `now - trades_recent_ms` use real trades.
    pub trades_recent_ms: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Progress {
    /// Milliseconds of the range covered so far (newest first) out of `total_ms`.
    pub done_ms: i64,
    pub total_ms: i64,
    pub trades: usize,
    pub pages: u32,
    /// `trades` / `klines` / `done`.
    pub phase: &'static str,
    /// The venue answered "rate limited" during this call (requests are being slowed down).
    pub throttled: bool,
}

#[derive(Debug, Default)]
pub struct RangeOut {
    /// Oldest first, in `[from_ms, to_ms)`.
    pub trades: Vec<Trade>,
    /// Trades from the tick store / the history cache / the network.
    pub local: usize,
    pub cached: usize,
    pub downloaded: usize,
    /// Trades rebuilt from klines.
    pub synthetic: usize,
    pub pages: u32,
    /// Interval of the klines used, when any.
    pub kline_ms: Option<i64>,
}

/// Newest-first, hour-aligned chunks of `[from, to)`.
pub fn chunks_newest_first(from: i64, to: i64, size: i64) -> Vec<(i64, i64)> {
    let mut out = Vec::new();
    if from >= to || size <= 0 {
        return out;
    }
    let mut b = to;
    while b > from {
        let a = ((b - 1).div_euclid(size) * size).max(from);
        out.push((a, b));
        b = a;
    }
    out
}

fn covered_locally(gaps_ns: &[(i64, i64)], a_ms: i64, b_ms: i64) -> bool {
    let (a, b) = (a_ms * 1_000_000, b_ms * 1_000_000);
    !gaps_ns.iter().any(|&(g0, g1)| g0 < b && g1 > a)
}

/// See the module docs. `local` / `local_gaps_ns` are the tick store's trades and uncovered
/// spans (ns) for the range.
#[allow(clippy::too_many_arguments)]
pub async fn load_range(
    api: &dyn MarketApi,
    spec: &SymbolSpec,
    instrument: &str,
    cache: Option<&HistoryCache>,
    local: &[Trade],
    local_gaps_ns: &[(i64, i64)],
    plan: Plan,
    progress: &mut (dyn FnMut(Progress) + Send),
) -> Result<RangeOut, ConnectorError> {
    let Plan {
        from_ms: from,
        to_ms: to,
        now_ms: now,
        ..
    } = plan;
    let mut out = RangeOut::default();
    if from >= to {
        return Ok(out);
    }
    let total = to - from;
    let throttled0 = api.throttled();
    let closed = now - OPEN_MARGIN_MS;
    // Real-trade parts, newest first; `real_from` is the oldest point real data reaches.
    let mut parts: Vec<Vec<Trade>> = Vec::new();
    let mut real_from = to;
    let trades_ok = api.windowed_trades() && plan.max_pages > 0;
    let mut n_trades = 0usize;
    let mut report = |out: &RangeOut, done: i64, n: usize, phase: &'static str| {
        progress(Progress {
            done_ms: done.clamp(0, total),
            total_ms: total,
            trades: n,
            pages: out.pages,
            phase,
            throttled: api.throttled() > throttled0,
        })
    };

    for (a, b) in chunks_newest_first(from, to, TRADE_CHUNK_MS) {
        if !local.is_empty() && covered_locally(local_gaps_ns, a, b) {
            let (lo, hi) = (a * 1_000_000, b * 1_000_000);
            let part: Vec<Trade> = local
                .iter()
                .filter(|t| t.exchange_ts_ns >= lo && t.exchange_ts_ns < hi)
                .cloned()
                .collect();
            out.local += part.len();
            n_trades += part.len();
            parts.push(part);
            real_from = a;
            report(&out, to - a, n_trades, "trades");
            continue;
        }
        let whole = (a.div_euclid(TRADE_CHUNK_MS) * TRADE_CHUNK_MS, b) == (a, b)
            && b - a == TRADE_CHUNK_MS
            && b <= closed;
        if whole {
            if let Some(t) = cache.and_then(|c| c.get_trades(instrument, a)) {
                out.cached += t.len();
                n_trades += t.len();
                parts.push(t);
                real_from = a;
                report(&out, to - a, n_trades, "trades");
                continue;
            }
        }
        if !trades_ok || b <= now - plan.trades_recent_ms || out.pages >= plan.max_pages {
            break;
        }
        let r = api
            .trades_back(spec, a, b, plan.max_pages - out.pages)
            .await?;
        out.pages += r.pages;
        out.downloaded += r.trades.len();
        n_trades += r.trades.len();
        let complete = r.covered_from_ms <= a;
        if complete && whole {
            if let Some(c) = cache {
                c.put_trades(instrument, a, &r.trades);
            }
        }
        parts.push(r.trades);
        real_from = r.covered_from_ms.max(a);
        report(&out, to - real_from, n_trades, "trades");
        if !complete {
            break;
        }
    }

    // Klines for [from, real_from).
    let intervals = api.kline_intervals();
    if real_from > from && !intervals.is_empty() {
        let iv = pick_kline_interval(
            intervals,
            real_from - from,
            MAX_KLINE_BARS.min(api.kline_max_bars()),
        )
        .expect("non-empty intervals");
        out.kline_ms = Some(iv);
        // Bars must end before the first real trade; a range that is all klines keeps the bar
        // that straddles `to` (its synthetic points before `to` only).
        let strict = real_from < to;
        let chunk = iv * 1440;
        let first_bar = from.div_euclid(iv) * iv;
        let mut synth: Vec<Trade> = Vec::new();
        let mut kl: Vec<Kline> = Vec::new();
        for (ca, cb) in chunks_newest_first(first_bar, real_from, chunk) {
            let (ka, kb) = (
                ca.div_euclid(chunk) * chunk,
                ca.div_euclid(chunk) * chunk + chunk,
            );
            let cacheable = kb <= closed;
            let rows = match cache
                .filter(|_| cacheable)
                .and_then(|c| c.get_klines(instrument, iv, ka))
            {
                Some(k) => k,
                None => {
                    let k = api.klines(spec, iv, ka, kb.min(now)).await?;
                    out.pages += 1;
                    if cacheable && !k.is_empty() {
                        if let Some(c) = cache {
                            c.put_klines(instrument, iv, ka, &k);
                        }
                    }
                    k
                }
            };
            kl.extend(
                rows.into_iter()
                    .filter(|k| k.open_ms >= ca.min(first_bar).max(ka) && k.open_ms < cb),
            );
            report(&out, to - ca.max(from), n_trades + kl.len() * 8, "klines");
        }
        kl.sort_by_key(|k| k.open_ms);
        kl.dedup_by_key(|k| k.open_ms);
        let (lo, hi) = (from * 1_000_000, real_from * 1_000_000);
        for k in &kl {
            if strict && k.open_ms + k.span_ms > real_from {
                continue;
            }
            synth.extend(
                kline_trades(k)
                    .into_iter()
                    .filter(|t| t.exchange_ts_ns >= lo && t.exchange_ts_ns < hi),
            );
        }
        out.synthetic = synth.len();
        parts.push(synth);
    }

    let mut all: Vec<Trade> = parts.into_iter().rev().flatten().collect();
    all.sort_by_key(|t| (t.exchange_ts_ns, t.trade_id));
    all.dedup_by(|x, y| {
        x.trade_id != 0 && x.trade_id == y.trade_id && x.exchange_ts_ns == y.exchange_ts_ns
    });
    out.trades = all;
    report(&out, total, out.trades.len(), "done");
    Ok(out)
}

/// REST requests the first paint of a chart may spend on real trades (the rest of the history
/// arrives in the background through [`load_range`]).
pub const FIRST_PAINT_PAGES: u32 = 3;

/// The most recent part of `[from_ms, to_ms)` for a chart's first paint: newest-first within
/// `max_pages` requests on venues that page by time (Binance used to page *forward* through
/// up to 60 rate-limited requests — ~25 s — before the first candle), else the venue's
/// "latest trades" call. Returns the trades (oldest first) and the start of the span they
/// cover completely.
pub async fn recent_window(
    api: &dyn MarketApi,
    spec: &SymbolSpec,
    from_ms: i64,
    to_ms: i64,
    max_pages: u32,
) -> Result<(Vec<Trade>, i64), ConnectorError> {
    if api.windowed_trades() {
        let r = api
            .trades_back(spec, from_ms, to_ms, max_pages.max(1))
            .await?;
        return Ok((r.trades, r.covered_from_ms.max(from_ms)));
    }
    let t = api.trades(spec, from_ms, to_ms).await?;
    let covered = if api.history_from_start() {
        from_ms
    } else {
        t.first().map_or(to_ms, |x| x.exchange_ts_ns / 1_000_000)
    };
    Ok((t, covered))
}

#[cfg(test)]
mod tests {
    use super::*;
    use htflow_connector_binance::{Binance, Market};
    use htflow_connector_common::mock_http::{query_param, MockServer, Reply};
    use htflow_core_types::TickSize;

    /// Time to first candle (docs/PERFORMANCE.md): a busy symbol (50 trades / s) opened with
    /// 30 minutes of history. The old forward paging needs 90 pages (capped at 60, ~25 s at
    /// Binance's public rate of 10 burst + 2 / s); the first paint now spends 3 requests.
    #[tokio::test]
    async fn first_paint_needs_three_requests() {
        const RATE: i64 = 50; // trades per second; id = ms / 20
        let srv = MockServer::start(|t| {
            let p = |k| query_param(t, k).and_then(|v| v.parse::<i64>().ok());
            let limit = p("limit").unwrap_or(500);
            let ids: Vec<i64> = if let Some(f) = p("fromId") {
                (f..f + limit).collect()
            } else if let Some(s) = p("startTime") {
                let first = (s * RATE + 999) / 1000;
                let last = p("endTime").map_or(first + limit - 1, |e| e * RATE / 1000);
                (first..=last.min(first + limit - 1)).collect()
            } else {
                vec![100 * H * RATE / 1000]
            };
            let rows: Vec<String> = ids
                .into_iter()
                .map(|id| {
                    format!(
                        r#"{{"a":{id},"p":"100.0","q":"1","T":{},"m":false}}"#,
                        id * 1000 / RATE
                    )
                })
                .collect();
            Reply::ok(format!("[{}]", rows.join(",")))
        });
        let api = Binance::with_endpoints(Market::UsdM, &srv.base, "ws://unused");
        let sp = SymbolSpec::new("BTCUSDT", TickSize::parse("0.1").unwrap(), 3);
        let now = 100 * H;
        let from = now - 30 * 60_000;
        let t0 = std::time::Instant::now();
        let (trades, covered) = recent_window(&api, &sp, from, now, FIRST_PAINT_PAGES)
            .await
            .unwrap();
        let first_paint = t0.elapsed();
        let new_reqs = srv.requests().len();
        assert!(new_reqs <= FIRST_PAINT_PAGES as usize + 1, "{new_reqs}");
        assert!(!trades.is_empty() && covered > from && covered < now);
        // The newest trades come first: the window ends at "now".
        assert!(trades.last().unwrap().exchange_ts_ns / 1_000_000 >= now - 1_000);
        // Old path: 10 pages (the free burst) cover only 10,000 of the 90,000 trades needed.
        let before = srv.requests().len();
        let old = api.agg_trades_range(&sp, from, now, 10).await.unwrap();
        assert_eq!(srv.requests().len() - before, 10);
        assert!(old.len() <= 10_000);
        let needed_pages = (30 * 60 * RATE) / 1000;
        assert_eq!(needed_pages, 90);
        eprintln!(
            "first paint: {new_reqs} requests in {first_paint:?} (old: {} pages, rate-limited ≈ {} s)",
            needed_pages.min(60),
            (needed_pages.min(60) - 10) / 2
        );
    }

    #[test]
    fn chunking() {
        assert_eq!(
            chunks_newest_first(1_000, 7_500_000, 3_600_000),
            vec![
                (7_200_000, 7_500_000),
                (3_600_000, 7_200_000),
                (1_000, 3_600_000)
            ]
        );
        assert!(chunks_newest_first(5, 5, 10).is_empty());
    }

    const H: i64 = 3_600_000;
    /// One trade per second; ids = seconds since 0.
    fn mock() -> MockServer {
        MockServer::start(|t| {
            let p = |k| query_param(t, k).and_then(|v| v.parse::<i64>().ok());
            let row = |id: i64| {
                format!(
                    r#"{{"a":{id},"p":"100.0","q":"1","T":{},"m":false}}"#,
                    id * 1000
                )
            };
            if t.contains("/aggTrades") {
                let ids: Vec<i64> = if let Some(f) = p("fromId") {
                    (f..f + p("limit").unwrap_or(500)).collect()
                } else if let Some(s) = p("startTime") {
                    vec![(s + 999) / 1000]
                } else {
                    vec![0]
                };
                let rows: Vec<String> = ids.into_iter().map(row).collect();
                return Reply::ok(format!("[{}]", rows.join(",")));
            }
            if t.contains("/klines") {
                let iv = if t.contains("interval=1m") {
                    60_000
                } else {
                    300_000
                };
                let (s, e) = (p("startTime").unwrap(), p("endTime").unwrap());
                let rows: Vec<String> = (0..1000)
                    .map(|i| s + i * iv)
                    .filter(|o| *o <= e)
                    .map(|o| {
                        format!(r#"[{o},"100.0","101.0","99.0","100.5","8",0,"0",1,"4","0","0"]"#)
                    })
                    .collect();
                return Reply::ok(format!("[{}]", rows.join(",")));
            }
            Reply::status("404 Not Found", "{}")
        })
    }

    /// A venue other than Binance: OKX candles (100 per page, newest first) rebuild the days
    /// beyond the trade endpoints' reach, with the volume split by candle direction.
    #[tokio::test]
    async fn okx_klines_fill_old_days() {
        let srv = MockServer::start(|t| {
            let after = query_param(t, "after")
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap();
            let end = (after / 60_000).min(3_000);
            let rows: Vec<String> = ((end - 100).max(0)..end)
                .rev()
                .map(|m| {
                    format!(
                        r#"["{}","100","101","99","100.5","4","0","0","1"]"#,
                        m * 60_000
                    )
                })
                .collect();
            Reply::ok(format!(
                r#"{{"code":"0","msg":"","data":[{}]}}"#,
                rows.join(",")
            ))
        });
        let api = htflow_connector_okx::Okx::new(&srv.base, "ws://unused");
        let sp = SymbolSpec::new("BTC-USDT-SWAP", TickSize::parse("0.1").unwrap(), 3);
        let plan = Plan {
            from_ms: 0,
            to_ms: 10 * H,
            now_ms: 400 * H,
            max_pages: 10,
            trades_recent_ms: DAY_MS,
        };
        let r = load_range(
            &api,
            &sp,
            "okx-swap:BTC-USDT-SWAP",
            None,
            &[],
            &[],
            plan,
            &mut |_| {},
        )
        .await
        .unwrap();
        assert_eq!((r.downloaded, r.kline_ms), (0, Some(60_000)));
        // 600 one-minute bars, 4 synthetic ticks each (bullish: only the buy side).
        assert_eq!(r.synthetic, 600 * 4);
        assert!(r
            .trades
            .iter()
            .all(|t| t.aggressor != htflow_core_types::Aggressor::Sell));
        let vol: f64 = r.trades.iter().map(|t| t.qty).sum();
        assert!((vol - 600.0 * 4.0).abs() < 1e-6);
    }

    #[tokio::test]
    async fn trades_newest_first_then_klines_then_cache() {
        let srv = mock();
        let api = Binance::with_endpoints(Market::UsdM, &srv.base, "ws://unused");
        let sp = SymbolSpec::new("BTCUSDT", TickSize::parse("0.1").unwrap(), 3);
        let root = std::env::temp_dir().join(format!("htflow-hist-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let cache = HistoryCache::open(&root, 1 << 30);
        let now = 100 * H;
        // Six hours before "now - 2 h"; budget: 1 anchor + 4 pages per hour → about 2 hours.
        let plan = Plan {
            from_ms: 92 * H,
            to_ms: 98 * H,
            now_ms: now,
            max_pages: 10,
            trades_recent_ms: DAY_MS,
        };
        let mut seen = Vec::new();
        let r = load_range(
            &api,
            &sp,
            "binance-futures:BTCUSDT",
            Some(&cache),
            &[],
            &[],
            plan,
            &mut |p| seen.push(p),
        )
        .await
        .unwrap();
        // Real trades: two full hours (3,600 each) from the newest end; then klines.
        assert_eq!((r.downloaded, r.pages - 1), (7200, 10), "{r:?}");
        assert_eq!(r.synthetic, 4 * 60 * 8);
        assert_eq!(r.kline_ms, Some(60_000));
        assert!(r.synthetic > 0);
        let first_real = r.trades.iter().find(|t| t.trade_id != 0).unwrap();
        // No synthetic trade at / after the first real one.
        assert!(r
            .trades
            .iter()
            .filter(|t| t.trade_id == 0)
            .all(|t| t.exchange_ts_ns < first_real.exchange_ts_ns));
        assert!(r
            .trades
            .windows(2)
            .all(|w| w[0].exchange_ts_ns <= w[1].exchange_ts_ns));
        assert!(r.trades.first().unwrap().exchange_ts_ns >= 92 * H * 1_000_000);
        assert!(r.trades.last().unwrap().exchange_ts_ns < 98 * H * 1_000_000);
        assert_eq!(seen.last().unwrap().phase, "done");
        assert!(seen.windows(2).all(|w| w[0].done_ms <= w[1].done_ms));
        // The newest page is requested first.
        let reqs = srv.requests();
        assert!(
            reqs[0].contains(&format!("startTime={}", 98 * H)),
            "{reqs:?}"
        );

        // Second call: both hours come from the cache, no new trade requests.
        let before = srv.requests().len();
        let r2 = load_range(
            &api,
            &sp,
            "binance-futures:BTCUSDT",
            Some(&cache),
            &[],
            &[],
            plan,
            &mut |_| {},
        )
        .await
        .unwrap();
        assert_eq!(r2.cached, r.downloaded);
        // The budget now goes to the next older hour.
        let new_reqs = &srv.requests()[before..];
        assert!(
            new_reqs[0].contains(&format!("startTime={}", 96 * H)),
            "{new_reqs:?}"
        );

        // Older than a day: klines only, coarser interval for a long span.
        let plan = Plan {
            from_ms: 0,
            to_ms: 30 * H,
            now_ms: now,
            max_pages: 10,
            trades_recent_ms: DAY_MS,
        };
        let r3 = load_range(
            &api,
            &sp,
            "binance-futures:BTCUSDT",
            None,
            &[],
            &[],
            plan,
            &mut |_| {},
        )
        .await
        .unwrap();
        assert_eq!(r3.downloaded, 0);
        assert_eq!(r3.kline_ms, Some(60_000));
        assert_eq!(r3.synthetic, 30 * 60 * 8);
        let _ = std::fs::remove_dir_all(&root);
    }
}
