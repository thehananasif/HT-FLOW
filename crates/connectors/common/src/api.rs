//! Venue-neutral API the desktop app dispatches on (one `Arc<dyn MarketApi>` per venue).
use futures_util::future::BoxFuture;
use htflow_core_types::{MarketEvent, TickSize, Trade};
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
    /// The live stream; runs until `stop` flips to true.
    fn stream(
        &self,
        spec: SymbolSpec,
        tx: mpsc::Sender<MarketEvent>,
        stop: watch::Receiver<bool>,
    ) -> BoxFuture<'static, ()>;
    fn clock(&self) -> &ClockSkew;
}
