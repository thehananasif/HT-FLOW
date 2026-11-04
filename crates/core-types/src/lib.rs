//! Normalised market events (Live Pipeline stage 2).
//!
//! Prices are integer ticks (`price / tick_size`) everywhere inside the engine — never `f64`.
//! Decimal strings from venues are converted exactly with [`TickSize::parse_ticks`].

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Aggressor {
    Buy,
    Sell,
    Unknown,
}

impl Aggressor {
    /// Wire encoding used by the UI streamer: 1 buy, -1 sell, 0 unknown.
    pub fn as_i8(self) -> i8 {
        match self {
            Aggressor::Buy => 1,
            Aggressor::Sell => -1,
            Aggressor::Unknown => 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Trade {
    /// Exchange timestamp, ns since epoch.
    pub exchange_ts_ns: i64,
    /// Local receive timestamp, ns since epoch (latency = local − exchange).
    pub local_ts_ns: i64,
    /// Price in ticks.
    pub px: i64,
    pub qty: f64,
    pub aggressor: Aggressor,
    pub trade_id: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BookDelta {
    pub side: Side,
    pub px: i64,
    /// New absolute size; 0 removes the level.
    pub qty: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BookSnapshot {
    pub ts_ns: i64,
    /// Best first.
    pub bids: Vec<(i64, f64)>,
    /// Best first.
    pub asks: Vec<(i64, f64)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FeedState {
    Connecting,
    Live,
    Delayed,
    Replay,
    Disconnected,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FeedStatus {
    pub state: FeedState,
    pub latency_ms: f64,
    pub msgs_per_sec: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Every event a connector emits onto the bus.
#[derive(Debug, Clone, PartialEq)]
pub enum MarketEvent {
    Trades(Vec<Trade>),
    Deltas(Vec<BookDelta>),
    Snapshot(BookSnapshot),
    Status(FeedStatus),
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DecimalError {
    #[error("invalid decimal: {0}")]
    Invalid(String),
    #[error("tick size must be positive")]
    ZeroTick,
}

/// Exact decimal tick size, e.g. "0.10" → 1 unit at scale 10^1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TickSize {
    /// Decimal places used for the integer representation.
    pub scale: u32,
    /// Tick size expressed in units of 10^-scale.
    pub units: i64,
}

fn parse_scaled(s: &str, scale: u32) -> Result<i64, DecimalError> {
    let s = s.trim();
    let (neg, body) = match s.strip_prefix('-') {
        Some(b) => (true, b),
        None => (false, s),
    };
    let (int_part, frac_part) = match body.split_once('.') {
        Some((i, f)) => (i, f),
        None => (body, ""),
    };
    if int_part.is_empty() && frac_part.is_empty() {
        return Err(DecimalError::Invalid(s.to_string()));
    }
    if !int_part.chars().all(|c| c.is_ascii_digit())
        || !frac_part.chars().all(|c| c.is_ascii_digit())
    {
        return Err(DecimalError::Invalid(s.to_string()));
    }
    let mut v: i128 = if int_part.is_empty() {
        0
    } else {
        int_part
            .parse::<i128>()
            .map_err(|_| DecimalError::Invalid(s.to_string()))?
    };
    let mut round_up = false;
    for (i, c) in frac_part.chars().enumerate() {
        let d = c as i128 - '0' as i128;
        if (i as u32) < scale {
            v = v * 10 + d;
        } else if i as u32 == scale {
            round_up = d >= 5;
            break;
        }
    }
    let have = frac_part.len().min(scale as usize) as u32;
    for _ in have..scale {
        v *= 10;
    }
    if round_up {
        v += 1;
    }
    let v = i64::try_from(v).map_err(|_| DecimalError::Invalid(s.to_string()))?;
    Ok(if neg { -v } else { v })
}

impl TickSize {
    /// Parses a venue tick size string such as "0.10", "0.25" or "1".
    pub fn parse(s: &str) -> Result<Self, DecimalError> {
        let trimmed = s.trim();
        let frac = trimmed
            .split_once('.')
            .map(|(_, f)| f.trim_end_matches('0'))
            .unwrap_or("");
        let scale = frac.len() as u32;
        let units = parse_scaled(trimmed, scale)?;
        if units <= 0 {
            return Err(DecimalError::ZeroTick);
        }
        Ok(Self { scale, units })
    }

    pub fn as_f64(&self) -> f64 {
        self.units as f64 / 10f64.powi(self.scale as i32)
    }

    /// Converts a decimal price string to ticks exactly (rounding half up to the nearest tick).
    pub fn parse_ticks(&self, price: &str) -> Result<i64, DecimalError> {
        let v = parse_scaled(price, self.scale)?;
        let q = v.div_euclid(self.units);
        let r = v.rem_euclid(self.units);
        Ok(if r * 2 >= self.units { q + 1 } else { q })
    }

    /// Decimal places needed to display a price at this tick size.
    pub fn precision(&self) -> u32 {
        self.scale
    }
}

/// Aggressor from the venue flag when present, else the tick rule against the last best bid/ask.
pub fn aggressor_from_quote(px: i64, best_bid: Option<i64>, best_ask: Option<i64>) -> Aggressor {
    match (best_bid, best_ask) {
        (_, Some(a)) if px >= a => Aggressor::Buy,
        (Some(b), _) if px <= b => Aggressor::Sell,
        _ => Aggressor::Unknown,
    }
}

/// Decimal places of a step string such as "0.001" → 3.
pub fn decimals_of(step: &str) -> u32 {
    step.trim()
        .split_once('.')
        .map(|(_, f)| f.trim_end_matches('0').len() as u32)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tick_sizes() {
        assert_eq!(
            TickSize::parse("0.10").unwrap(),
            TickSize { scale: 1, units: 1 }
        );
        assert_eq!(
            TickSize::parse("0.25").unwrap(),
            TickSize {
                scale: 2,
                units: 25
            }
        );
        assert_eq!(
            TickSize::parse("1").unwrap(),
            TickSize { scale: 0, units: 1 }
        );
        assert_eq!(
            TickSize::parse("0.00001000").unwrap(),
            TickSize { scale: 5, units: 1 }
        );
        assert!(TickSize::parse("0").is_err());
        assert!(TickSize::parse("abc").is_err());
    }

    #[test]
    fn converts_prices_to_ticks_exactly() {
        let t = TickSize::parse("0.10").unwrap();
        assert_eq!(t.parse_ticks("68123.40").unwrap(), 681_234);
        assert_eq!(t.parse_ticks("68123.4000000").unwrap(), 681_234);
        let q = TickSize::parse("0.25").unwrap();
        assert_eq!(q.parse_ticks("6850.75").unwrap(), 27_403);
        // Off-grid prices round to the nearest tick.
        assert_eq!(q.parse_ticks("6850.80").unwrap(), 27_403);
        assert_eq!(q.parse_ticks("6850.90").unwrap(), 27_404);
        let s = TickSize::parse("0.00001").unwrap();
        assert_eq!(s.parse_ticks("0.16543").unwrap(), 16_543);
        assert_eq!(t.parse_ticks("-1.5").unwrap(), -15);
    }

    #[test]
    fn tick_rule_aggressor() {
        assert_eq!(
            aggressor_from_quote(101, Some(100), Some(101)),
            Aggressor::Buy
        );
        assert_eq!(
            aggressor_from_quote(100, Some(100), Some(101)),
            Aggressor::Sell
        );
        assert_eq!(aggressor_from_quote(100, None, None), Aggressor::Unknown);
        assert_eq!(decimals_of("0.001"), 3);
        assert_eq!(decimals_of("1"), 0);
    }
}
