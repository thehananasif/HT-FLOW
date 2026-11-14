//! Venue-neutral API the desktop app dispatches on (one `Arc<dyn MarketApi>` per venue).
use futures_util::future::BoxFuture;
use htflow_core_types::{Aggressor, MarketEvent, TickSize, Trade};
use tokio::sync::{mpsc, watch};

use crate::clock::ClockSkew;
use crate::Result;

#[derive(Debug, Clone, PartialEq)]
pub struct SymbolSpec {
    /// Venue symbol, e.g. `BTC-USDT-SWAP`, `BTC-PERPETUAL`, `tBTCF0:USTF0`.
    pub symbol: String,
    pub tick: TickSize,
    pub qty_precision: u32,
    /// Base units per contract; venue sizes are multiplied by it (1.0 when sizes are already in
    /// base units, or for inverse contracts whose sizes are kept in contracts).
    pub contract_value: f64,
}

impl SymbolSpec {
    pub fn new(symbol: impl Into<String>, tick: TickSize, qty_precision: u32) -> Self {
        Self {
            symbol: symbol.into(),
            tick,
            qty_precision,
            contract_value: 1.0,
        }
    }
}

/// `(bids, asks)`, best first, prices in ticks.
pub type BookLevels = (Vec<(i64, f64)>, Vec<(i64, f64)>);

/// One OHLCV bar from a venue's klines / candles REST endpoint (prices in ticks).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Kline {
    pub open_ms: i64,
    /// Bar length (60,000 for one-minute klines).
    pub span_ms: i64,
    pub open: i64,
    pub high: i64,
    pub low: i64,
    pub close: i64,
    /// Traded size in the venue's size unit (contracts on inverse futures).
    pub volume: f64,
    /// Aggressive-buy share of `volume`, when the venue reports it.
    pub taker_buy: Option<f64>,
}

/// Result of a newest-first trades download (see [`MarketApi::trades_back`]).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TradesBack {
    /// Trades in `[covered_from_ms, to_ms)`, oldest first.
    pub trades: Vec<Trade>,
    /// Start of the span the download actually covers: `from_ms` when complete, later when the
    /// page budget ran out first, `to_ms` when nothing could be fetched.
    pub covered_from_ms: i64,
    /// REST requests spent.
    pub pages: u32,
}

pub trait MarketApi: Send + Sync {
    /// Venue id used in instrument ids (`okx-swap`, `deribit`, …).
    fn venue(&self) -> &'static str;
    fn spec<'a>(&'a self, symbol: &'a str) -> BoxFuture<'a, Result<SymbolSpec>>;
    fn book<'a>(&'a self, spec: &'a SymbolSpec) -> BoxFuture<'a, Result<BookLevels>>;
    /// Trades in `[from_ms, to_ms]`, oldest first (as far back as the public REST allows).
    fn trades<'a>(
        &'a self,
        spec: &'a SymbolSpec,
        from_ms: i64,
        to_ms: i64,
    ) -> BoxFuture<'a, Result<Vec<Trade>>>;
    /// True when [`MarketApi::trades`] can reach any start time (else only the latest N trades).
    fn history_from_start(&self) -> bool;
    /// True when [`MarketApi::trades`] fetches an arbitrary past `[from, to]` window directly
    /// (instead of paging back from now), so older days can be downloaded window by window.
    fn windowed_trades(&self) -> bool {
        self.history_from_start()
    }
    /// Newest-first download of `[from_ms, to_ms)`: pages backwards from `to_ms` and stops at
    /// `from_ms` or after `max_pages` requests. The default fetches the window with one
    /// [`MarketApi::trades`] call when [`MarketApi::windowed_trades`], else returns nothing.
    fn trades_back<'a>(
        &'a self,
        spec: &'a SymbolSpec,
        from_ms: i64,
        to_ms: i64,
        max_pages: u32,
    ) -> BoxFuture<'a, Result<TradesBack>> {
        Box::pin(async move {
            if !self.windowed_trades() || max_pages == 0 || from_ms >= to_ms {
                return Ok(TradesBack {
                    covered_from_ms: to_ms,
                    ..TradesBack::default()
                });
            }
            let mut trades = self.trades(spec, from_ms, to_ms - 1).await?;
            let (lo, hi) = (from_ms * 1_000_000, to_ms * 1_000_000);
            trades.retain(|t| t.exchange_ts_ns >= lo && t.exchange_ts_ns < hi);
            Ok(TradesBack {
                trades,
                covered_from_ms: from_ms,
                pages: 1,
            })
        })
    }
    /// Kline intervals (ms, ascending) [`MarketApi::klines`] serves for any past window; empty
    /// when the venue has no klines endpoint wired.
    fn kline_intervals(&self) -> &'static [i64] {
        &[]
    }
    /// Most klines one [`MarketApi::klines`] range may need (the venue's page size × the pages
    /// it is willing to spend); the history backfill picks an interval whose span fits.
    fn kline_max_bars(&self) -> i64 {
        5_000
    }
    /// Klines of `interval_ms` (one of [`MarketApi::kline_intervals`]) whose open time is in
    /// `[from_ms, to_ms)`, oldest first.
    fn klines<'a>(
        &'a self,
        _spec: &'a SymbolSpec,
        _interval_ms: i64,
        _from_ms: i64,
        _to_ms: i64,
    ) -> BoxFuture<'a, Result<Vec<Kline>>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    /// The live stream; runs until `stop` flips to true.
    fn stream(
        &self,
        spec: SymbolSpec,
        tx: mpsc::Sender<MarketEvent>,
        stop: watch::Receiver<bool>,
    ) -> BoxFuture<'static, ()>;
    fn clock(&self) -> &ClockSkew;
    /// Rate-limited REST answers seen so far (see [`crate::Rest::throttled`]).
    fn throttled(&self) -> u64 {
        0
    }
}

/// The smallest interval of `intervals` (ascending) that covers `span_ms` in at most
/// `max_bars` klines (the largest one when none does); `None` when `intervals` is empty.
pub fn pick_kline_interval(intervals: &[i64], span_ms: i64, max_bars: i64) -> Option<i64> {
    intervals
        .iter()
        .copied()
        .find(|i| span_ms / i.max(&1) <= max_bars)
        .or_else(|| intervals.last().copied())
}

/// Synthetic trades that rebuild a kline: open → low/high (or high/low) → close at four points
/// inside the bar, each carrying a quarter of the buy and of the sell volume. OHLC, volume and
/// delta of the bar are exact; the price distribution inside it is not. Ids are 0 (no venue id).
pub fn kline_trades(k: &Kline) -> Vec<Trade> {
    let path = if k.close >= k.open {
        [k.open, k.low, k.high, k.close]
    } else {
        [k.open, k.high, k.low, k.close]
    };
    let vol = if k.volume.is_finite() {
        k.volume.max(0.0)
    } else {
        0.0
    };
    let (buy, sell, buy_side) = match k.taker_buy {
        Some(b) if b.is_finite() => {
            let b = b.clamp(0.0, vol);
            (b, vol - b, Aggressor::Buy)
        }
        _ => (vol, 0.0, Aggressor::Unknown),
    };
    let step = (k.span_ms / 4).max(1);
    let mut out = Vec::with_capacity(8);
    for (i, px) in path.iter().enumerate() {
        let ts = (k.open_ms + step * i as i64) * 1_000_000;
        for (qty, aggressor) in [(buy / 4.0, buy_side), (sell / 4.0, Aggressor::Sell)] {
            if qty > 0.0 {
                out.push(Trade {
                    exchange_ts_ns: ts,
                    local_ts_ns: ts,
                    px: *px,
                    qty,
                    aggressor,
                    trade_id: 0,
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kline_trades_keep_ohlc_volume_and_delta() {
        let k = Kline {
            open_ms: 60_000,
            span_ms: 60_000,
            open: 100,
            high: 110,
            low: 95,
            close: 105,
            volume: 8.0,
            taker_buy: Some(6.0),
        };
        let t = kline_trades(&k);
        assert_eq!(t.len(), 8);
        assert_eq!(t[0].px, 100);
        assert_eq!(t.last().unwrap().px, 105);
        assert_eq!(t.iter().map(|x| x.px).max(), Some(110));
        assert_eq!(t.iter().map(|x| x.px).min(), Some(95));
        // A bullish bar visits the low before the high.
        assert_eq!(t[2].px, 95);
        let vol: f64 = t.iter().map(|x| x.qty).sum();
        let buys: f64 = t
            .iter()
            .filter(|x| x.aggressor == Aggressor::Buy)
            .map(|x| x.qty)
            .sum();
        assert!((vol - 8.0).abs() < 1e-9 && (buys - 6.0).abs() < 1e-9);
        assert!(t.iter().all(|x| x.exchange_ts_ns >= 60_000_000_000
            && x.exchange_ts_ns < 120_000_000_000
            && x.trade_id == 0));
        // Without a taker split the side is unknown.
        let u = kline_trades(&Kline {
            taker_buy: None,
            ..k
        });
        assert_eq!(u.len(), 4);
        assert!(u.iter().all(|x| x.aggressor == Aggressor::Unknown));

        let iv = [60_000, 300_000, 3_600_000, 86_400_000];
        const DAY: i64 = 86_400_000;
        assert_eq!(pick_kline_interval(&iv, DAY, 5000), Some(60_000));
        assert_eq!(pick_kline_interval(&iv, 10 * DAY, 5000), Some(300_000));
        assert_eq!(pick_kline_interval(&iv, 100 * DAY, 5000), Some(3_600_000));
        assert_eq!(pick_kline_interval(&iv, 100_000 * DAY, 5000), Some(DAY));
        assert_eq!(pick_kline_interval(&[], DAY, 5000), None);
    }
}
