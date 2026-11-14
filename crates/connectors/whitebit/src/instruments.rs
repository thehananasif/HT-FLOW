//! Symbol discovery: every WhiteBIT market with trading enabled (spot and perpetual futures)
//! from `/api/v4/public/markets`.
use htflow_connector_common::instruments::{
    discovery_rest, parse_json, pow10_text, text_of, InstrumentInfo, MarketKind, RawSpec,
};
use htflow_connector_common::{ConnectorError, Result};
use serde_json::Value;

use crate::REST_BASE;

pub async fn list_instruments() -> Result<Vec<InstrumentInfo>> {
    list_from(REST_BASE).await
}

pub async fn list_from(base: &str) -> Result<Vec<InstrumentInfo>> {
    parse_markets(
        &discovery_rest(base)
            .get_text("/api/v4/public/markets")
            .await?,
    )
}

/// `tickSize` / `stepSize` when given, else 10^-precision.
fn step_or_prec(m: &Value, step: &str, prec: &str) -> String {
    let s = text_of(&m[step]);
    if !s.is_empty() {
        return s;
    }
    pow10_text(text_of(&m[prec]).parse::<i32>().unwrap_or(0))
}

pub fn parse_markets(text: &str) -> Result<Vec<InstrumentInfo>> {
    let v = parse_json(text, "whitebit markets")?;
    let Some(list) = v.as_array() else {
        return Err(ConnectorError::Api(format!(
            "whitebit markets: {}",
            v["message"].as_str().unwrap_or("unexpected shape")
        )));
    };
    let mut out = Vec::new();
    for m in list {
        if m["tradesEnabled"].as_bool() != Some(true) {
            continue;
        }
        let kind = match m["type"].as_str() {
            Some("spot") => MarketKind::Spot,
            Some(t) if t.contains("utures") => MarketKind::Perp,
            _ => continue,
        };
        let s = |k: &str| m[k].as_str().unwrap_or("");
        let row = InstrumentInfo::new(
            "whitebit",
            kind,
            s("name"),
            s("stock"),
            s("money"),
            s("money"),
            false,
            RawSpec {
                tick: &step_or_prec(m, "tickSize", "moneyPrec"),
                step: &step_or_prec(m, "stepSize", "stockPrec"),
                min_qty: &text_of(&m["minAmount"]),
            },
            1.0,
            None,
        );
        out.extend(row);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markets() {
        let rows = parse_markets(include_str!("../fixtures/markets.json")).unwrap();
        let syms: Vec<&str> = rows.iter().map(|r| r.symbol.as_str()).collect();
        assert_eq!(
            syms,
            ["ETH_BTC", "BTC_USDT", "BTC_PERP", "LEG_USDT"],
            "disabled dropped"
        );
        assert_eq!(rows[1].market, MarketKind::Spot);
        assert_eq!((rows[1].tick_size, rows[1].qty_precision), (0.01, 6));
        let perp = &rows[2];
        assert_eq!(perp.market, MarketKind::Perp);
        assert_eq!((perp.base.as_str(), perp.quote.as_str()), ("BTC", "USDT"));
        assert_eq!(
            (perp.tick_size, perp.lot_step, perp.min_qty),
            (0.1, 0.001, 0.001)
        );
        // Older answers without tickSize / stepSize fall back to the precisions.
        assert_eq!((rows[3].tick_size, rows[3].lot_step), (0.000001, 0.0001));
        assert!(parse_markets(r#"{"message":"x"}"#).is_err());
    }
}
