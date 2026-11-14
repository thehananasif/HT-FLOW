//! Helpers shared by the venues' klines / candles history (P06).
//!
//! No venue except Binance reports the taker-buy share of a bar. For those, [`bar`] splits the
//! bar's volume by direction ([`directional_taker_buy`]): a bar that closed above its open is
//! booked as buying, one that closed below as selling, a flat bar half and half. The bar's
//! delta is therefore an estimate (its sign follows the candle colour), while OHLC and total
//! volume stay exact.
use htflow_core_types::TickSize;

use crate::api::Kline;
use crate::util::parse_f64;
use crate::Result;

/// Taker-buy volume estimated from the candle direction: all of `volume` when `close > open`,
/// none when `close < open`, half when they are equal.
pub fn directional_taker_buy(open: i64, close: i64, volume: f64) -> f64 {
    let v = if volume.is_finite() {
        volume.max(0.0)
    } else {
        0.0
    };
    match close.cmp(&open) {
        std::cmp::Ordering::Greater => v,
        std::cmp::Ordering::Less => 0.0,
        std::cmp::Ordering::Equal => v / 2.0,
    }
}

/// One bar from a venue's price / volume text, with the direction-split taker volume.
#[allow(clippy::too_many_arguments)]
pub fn bar(
    tick: &TickSize,
    open_ms: i64,
    span_ms: i64,
    open: &str,
    high: &str,
    low: &str,
    close: &str,
    volume: f64,
) -> Result<Kline> {
    let (o, c) = (tick.parse_ticks(open)?, tick.parse_ticks(close)?);
    Ok(Kline {
        open_ms,
        span_ms,
        open: o,
        high: tick.parse_ticks(high)?,
        low: tick.parse_ticks(low)?,
        close: c,
        volume,
        taker_buy: Some(directional_taker_buy(o, c, volume)),
    })
}

/// [`bar`] with the volume given as text.
#[allow(clippy::too_many_arguments)]
pub fn bar_text(
    tick: &TickSize,
    open_ms: i64,
    span_ms: i64,
    open: &str,
    high: &str,
    low: &str,
    close: &str,
    volume: &str,
) -> Result<Kline> {
    bar(
        tick,
        open_ms,
        span_ms,
        open,
        high,
        low,
        close,
        parse_f64(volume)?,
    )
}

/// `[from, to)` cut into consecutive windows of at most `step` (all in the same unit).
pub fn windows(from: i64, to: i64, step: i64) -> Vec<(i64, i64)> {
    let mut out = Vec::new();
    if step <= 0 {
        return out;
    }
    let mut a = from;
    while a < to {
        let b = (a + step).min(to);
        out.push((a, b));
        a = b;
    }
    out
}

/// Sorted by open time, de-duplicated, and limited to bars opening in `[first_ms, to_ms)`.
pub fn finish_klines(mut rows: Vec<Kline>, first_ms: i64, to_ms: i64) -> Vec<Kline> {
    rows.retain(|k| k.open_ms >= first_ms && k.open_ms < to_ms);
    rows.sort_by_key(|k| k.open_ms);
    rows.dedup_by_key(|k| k.open_ms);
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direction_split() {
        assert_eq!(directional_taker_buy(100, 105, 8.0), 8.0);
        assert_eq!(directional_taker_buy(105, 100, 8.0), 0.0);
        assert_eq!(directional_taker_buy(100, 100, 8.0), 4.0);
        assert_eq!(directional_taker_buy(100, 105, f64::NAN), 0.0);
    }

    #[test]
    fn bars_and_windows() {
        let t = TickSize::parse("0.1").unwrap();
        let k = bar_text(&t, 60_000, 60_000, "100.0", "102", "99.5", "99.8", "3").unwrap();
        assert_eq!((k.open, k.high, k.low, k.close), (1000, 1020, 995, 998));
        assert_eq!((k.volume, k.taker_buy), (3.0, Some(0.0)));
        assert!(bar_text(&t, 0, 1, "x", "1", "1", "1", "1").is_err());
        assert_eq!(windows(0, 10, 4), vec![(0, 4), (4, 8), (8, 10)]);
        assert!(windows(5, 5, 4).is_empty() && windows(0, 5, 0).is_empty());
        let rows = vec![
            Kline { open_ms: 120, ..k },
            Kline { open_ms: 60, ..k },
            Kline { open_ms: 60, ..k },
            Kline { open_ms: 240, ..k },
        ];
        let f = finish_klines(rows, 60, 240);
        assert_eq!(f.iter().map(|k| k.open_ms).collect::<Vec<_>>(), [60, 120]);
    }
}
