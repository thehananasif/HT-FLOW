//! Shared connector framework (P05) for the free public crypto venues.
//!
//! * [`driver`]: one tokio task per connection — connect → subscribe → heartbeat → reconnect with
//!   exponential backoff (0.5 s → 30 s plus jitter), status every second, slow-consumer fallback
//!   to snapshots. Venues only implement the [`driver::Protocol`] trait (parse + sequence rules).
//! * [`book`]: integer-tick L2 book with the raw strings kept for CRC32 checksums.
//! * [`ratelimit`]: token bucket per venue for REST.
//! * [`clock`]: server clock offset measured at connect (clock-skew correction).
//! * [`rest`]: REST client that applies both.
//! * [`api`]: the venue-neutral [`api::MarketApi`] the desktop app dispatches on, with
//!   newest-first trade paging and one-minute klines for the history backfill (P06).
//! * [`instruments`]: live symbol discovery rows (every tradable instrument of a venue).
//! * [`mock_http`]: a scripted local HTTP server for REST tests (no live network in tests).

pub mod api;
pub mod book;
pub mod clock;
pub mod driver;
pub mod instruments;
pub mod klines;
pub mod mock_http;
pub mod ratelimit;
pub mod rest;
pub mod util;

pub use api::{
    kline_trades, pick_kline_interval, BookLevels, Kline, MarketApi, SymbolSpec, TradesBack,
};
pub use book::L2Book;
pub use clock::ClockSkew;
pub use driver::{Action, Ping, Probe, Protocol, RestBook, StreamConfig};
pub use instruments::{InstrumentInfo, MarketKind, RawSpec};
pub use klines::{bar, bar_text, directional_taker_buy, finish_klines, windows};
pub use ratelimit::TokenBucket;
pub use rest::Rest;
pub use util::*;

use htflow_core_types::DecimalError;

#[derive(Debug, thiserror::Error)]
pub enum ConnectorError {
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("websocket: {0}")]
    Ws(Box<tokio_tungstenite::tungstenite::Error>),
    #[error("decode: {0}")]
    Json(#[from] serde_json::Error),
    #[error("price: {0}")]
    Decimal(#[from] DecimalError),
    #[error("unknown symbol {0}")]
    UnknownSymbol(String),
    #[error("{0}")]
    Api(String),
    #[error("{0}")]
    Other(String),
}

impl From<tokio_tungstenite::tungstenite::Error> for ConnectorError {
    fn from(e: tokio_tungstenite::tungstenite::Error) -> Self {
        ConnectorError::Ws(Box::new(e))
    }
}

pub type Result<T, E = ConnectorError> = std::result::Result<T, E>;
