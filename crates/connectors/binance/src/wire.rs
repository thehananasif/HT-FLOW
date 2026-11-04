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
    #[serde(rename = "pu")]
    pub prev_final_id: u64,
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
