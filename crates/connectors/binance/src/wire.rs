//! Binance USDⓈ-M Futures wire formats (public endpoints only).
use serde::Deserialize;

/// Combined-stream envelope: `{"stream": "...", "data": {...}}`.
#[derive(Debug, Deserialize)]
pub struct Envelope<'a> {
    pub stream: &'a str,
    #[serde(borrow)]
    pub data: &'a serde_json::value::RawValue,
}

#[derive(Debug, Deserialize)]
pub struct AggTrade<'a> {
    /// Event time (ms).
    #[serde(rename = "E")]
    pub event_ms: i64,
    /// Aggregate trade id.
    #[serde(rename = "a")]
    pub id: u64,
    #[serde(rename = "p")]
    pub price: &'a str,
    #[serde(rename = "q")]
    pub qty: &'a str,
    /// Trade time (ms).
    #[serde(rename = "T")]
    pub trade_ms: i64,
    /// Buyer is the maker → the aggressor sold.
    #[serde(rename = "m")]
    pub buyer_is_maker: bool,
}

#[derive(Debug, Deserialize)]
pub struct DepthUpdateWire {
    #[serde(rename = "E")]
    pub event_ms: i64,
    #[serde(rename = "U")]
    pub first_id: u64,
    #[serde(rename = "u")]
    pub final_id: u64,
    /// Futures only (spot streams have no `pu`).
    #[serde(rename = "pu", default)]
    pub prev_final_id: Option<u64>,
    #[serde(rename = "b")]
    pub bids: Vec<[String; 2]>,
    #[serde(rename = "a")]
    pub asks: Vec<[String; 2]>,
}

#[derive(Debug, Deserialize)]
pub struct DepthSnapshotWire {
    #[serde(rename = "lastUpdateId")]
    pub last_update_id: u64,
    pub bids: Vec<[String; 2]>,
    pub asks: Vec<[String; 2]>,
}

/// REST aggTrades row.
#[derive(Debug, Deserialize)]
pub struct AggTradeRest {
    #[serde(rename = "a")]
    pub id: u64,
    #[serde(rename = "p")]
    pub price: String,
    #[serde(rename = "q")]
    pub qty: String,
    #[serde(rename = "T")]
    pub trade_ms: i64,
    #[serde(rename = "m")]
    pub buyer_is_maker: bool,
}

#[derive(Debug, Deserialize)]
pub struct ExchangeInfo {
    pub symbols: Vec<SymbolInfo>,
}

#[derive(Debug, Deserialize)]
pub struct SymbolInfo {
    pub symbol: String,
    #[serde(default)]
    pub filters: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct MarkPrice<'a> {
    #[serde(rename = "E")]
    pub event_ms: i64,
    #[serde(rename = "p")]
    pub mark: &'a str,
    /// Funding rate (empty on delivery contracts).
    #[serde(rename = "r", default)]
    pub rate: &'a str,
    /// Next funding time (ms).
    #[serde(rename = "T", default)]
    pub next_ms: i64,
}

#[derive(Debug, Deserialize)]
pub struct ForceOrder<'a> {
    #[serde(rename = "o", borrow)]
    pub order: ForceOrderBody<'a>,
}

#[derive(Debug, Deserialize)]
pub struct ForceOrderBody<'a> {
    #[serde(rename = "S")]
    pub side: &'a str,
    #[serde(rename = "p")]
    pub price: &'a str,
    #[serde(rename = "ap", default)]
    pub avg_price: &'a str,
    #[serde(rename = "q")]
    pub qty: &'a str,
    #[serde(rename = "z", default)]
    pub filled: &'a str,
    #[serde(rename = "T")]
    pub trade_ms: i64,
}

#[derive(Debug, Deserialize)]
pub struct OpenInterest {
    #[serde(rename = "openInterest")]
    pub open_interest: String,
    #[serde(default)]
    pub time: i64,
}

#[derive(Debug, Deserialize)]
pub struct ServerTime {
    #[serde(rename = "serverTime")]
    pub server_time: i64,
}
