//! Live symbol discovery (P04/P05): one venue-neutral row per tradable instrument, read from each
//! venue's public exchange-info endpoint by its connector crate (`<venue>::instruments`).
//!
//! Only instruments that trade right now are kept (Binance `TRADING`, Bybit `Trading`, OKX
//! `live`, …). Decimal strings from the venue are kept exact for the precisions; the numbers
//! sent to the UI are plain `f64`.
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{ConnectorError, Rest, Result, TokenBucket};

/// What kind of contract a discovered instrument is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MarketKind {
    /// Perpetual swap (linear or inverse).
    Perp,
    /// Dated (delivery) future.
    Future,
    Spot,
}

/// One tradable instrument of a venue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentInfo {
    /// Feed provider / Rust venue id the instrument streams through (`binance-futures`,
    /// `okx-swap`, …), or a catalog-only key (`bybit-spot`) when no connector streams it yet.
    pub venue: String,
    pub market: MarketKind,
    /// Venue-native symbol (`BTCUSDT`, `BTC-USDT-SWAP`, `tBTCUSD`, `PF_XBTUSD`).
    pub symbol: String,
    pub base: String,
    pub quote: String,
    /// Margin / settlement asset (the quote for spot).
    pub settle: String,
    /// Inverse contract (sized in USD, settled in the coin).
    pub inverse: bool,
    pub tick_size: f64,
    pub price_precision: u32,
    /// Quantity step in the venue's size unit (contracts on contract venues).
    pub lot_step: f64,
    pub qty_precision: u32,
    pub min_qty: f64,
    /// Base units (linear) or quote units (inverse) per contract; 1 for spot.
    pub contract_size: f64,
    /// Expiry / delivery time of a dated future (epoch ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expiry_ms: Option<i64>,
}

/// Decimal places of a decimal string ("0.0010" → 3, "1e-5" → 5, "10" → 0).
pub fn decimals(s: &str) -> u32 {
    let s = s.trim();
    if let Some((_, exp)) = s.split_once(['e', 'E']) {
        let mant = s.split(['e', 'E']).next().unwrap_or("");
        let frac = decimals(mant) as i32;
        let e: i32 = exp.parse().unwrap_or(0);
        return (frac - e).max(0) as u32;
    }
    s.split_once('.')
        .map(|(_, f)| f.trim_end_matches('0').len() as u32)
        .unwrap_or(0)
}

/// A float as the shortest decimal string (`0.00001`, not `1e-5`).
pub fn f64_text(v: f64) -> String {
    if !v.is_finite() {
        return "0".into();
    }
    let s = format!("{v}");
    if s.contains(['e', 'E']) {
        format!("{v:.12}")
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    } else {
        s
    }
}

/// A JSON string or number as a decimal string (`""` when absent).
pub fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.as_f64().map(f64_text).unwrap_or_default(),
        _ => String::new(),
    }
}

/// Parses a decimal string; empty / invalid → `None`.
pub fn num(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Spec numbers of one instrument as the venue reports them (decimal strings).
#[derive(Debug, Clone, Default)]
pub struct RawSpec<'a> {
    pub tick: &'a str,
    pub step: &'a str,
    pub min_qty: &'a str,
}

#[allow(clippy::too_many_arguments)]
impl InstrumentInfo {
    /// Builds a row from exact decimal strings. `None` when the tick size is missing or zero.
    pub fn new(
        venue: &str,
        market: MarketKind,
        symbol: &str,
        base: &str,
        quote: &str,
        settle: &str,
        inverse: bool,
        spec: RawSpec<'_>,
        contract_size: f64,
        expiry_ms: Option<i64>,
    ) -> Option<Self> {
        let tick = num(spec.tick).filter(|t| *t > 0.0)?;
        let step = num(spec.step).filter(|t| *t > 0.0).unwrap_or(1.0);
        let step_text = if num(spec.step).is_some_and(|t| t > 0.0) {
            spec.step
        } else {
            "1"
        };
        let min_qty = num(spec.min_qty).filter(|t| *t > 0.0).unwrap_or(step);
        Some(Self {
            venue: venue.into(),
            market,
            symbol: symbol.into(),
            base: base.to_uppercase(),
            quote: quote.to_uppercase(),
            settle: if settle.is_empty() {
                quote.to_uppercase()
            } else {
                settle.to_uppercase()
            },
            inverse,
            tick_size: tick,
            price_precision: decimals(spec.tick),
            lot_step: step,
            qty_precision: decimals(step_text),
            min_qty,
            contract_size: if contract_size.is_finite() && contract_size > 0.0 {
                contract_size
            } else {
                1.0
            },
            expiry_ms: expiry_ms.filter(|e| *e > 0),
        })
    }
}

/// "10^-n" as a decimal string (`3` → `"0.001"`, `0` → `"1"`, `-2` → `"100"`).
pub fn pow10_text(places: i32) -> String {
    match places {
        p if p <= 0 => format!("1{}", "0".repeat((-p).min(12) as usize)),
        p => format!("0.{}1", "0".repeat((p - 1).min(17) as usize)),
    }
}

/// A REST client for one discovery run (short timeout, gentle rate limit).
pub fn discovery_rest(base: &str) -> Rest {
    Rest::new(base, TokenBucket::new(5, Duration::from_secs(1)))
}

/// Parses a JSON body, mapping a decode error to an API error that names the endpoint.
pub fn parse_json(text: &str, what: &str) -> Result<Value> {
    serde_json::from_str(text).map_err(|e| ConnectorError::Api(format!("{what}: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_helpers() {
        assert_eq!(decimals("0.0010"), 3);
        assert_eq!(decimals("10"), 0);
        assert_eq!(decimals("1e-5"), 5);
        assert_eq!(decimals("2.5e-3"), 4);
        assert_eq!(f64_text(0.00001), "0.00001");
        assert_eq!(f64_text(0.5), "0.5");
        assert_eq!(f64_text(1e-8), "0.00000001");
        assert_eq!(pow10_text(3), "0.001");
        assert_eq!(pow10_text(0), "1");
        assert_eq!(pow10_text(-2), "100");
        assert_eq!(text_of(&serde_json::json!(0.25)), "0.25");
        assert_eq!(text_of(&serde_json::json!("0.10")), "0.10");
    }

    #[test]
    fn builds_rows() {
        let r = InstrumentInfo::new(
            "x",
            MarketKind::Perp,
            "BTCUSDT",
            "btc",
            "usdt",
            "",
            false,
            RawSpec {
                tick: "0.10",
                step: "0.001",
                min_qty: "",
            },
            0.0,
            Some(0),
        )
        .unwrap();
        assert_eq!(r.price_precision, 1);
        assert_eq!(r.qty_precision, 3);
        assert_eq!(r.min_qty, 0.001);
        assert_eq!(r.settle, "USDT");
        assert_eq!(r.contract_size, 1.0);
        assert_eq!(r.expiry_ms, None);
        let js = serde_json::to_string(&r).unwrap();
        assert!(js.contains("\"tickSize\":0.1") && js.contains("\"market\":\"perp\""));
        // A row without a tick size is dropped.
        assert!(InstrumentInfo::new(
            "x",
            MarketKind::Spot,
            "A",
            "A",
            "B",
            "",
            false,
            RawSpec::default(),
            1.0,
            None
        )
        .is_none());
    }
}
