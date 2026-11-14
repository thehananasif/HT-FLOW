//! Symbol discovery: every `normal` Bitget futures contract (USDT-, USDC- and COIN-margined) from
//! `/api/v2/mix/market/contracts`.
use htflow_connector_common::instruments::{
    discovery_rest, parse_json, text_of, InstrumentInfo, MarketKind, RawSpec,
};
use htflow_connector_common::{ConnectorError, Result};

use crate::REST_BASE;

/// The futures product types the connector streams.
pub const PRODUCT_TYPES: [&str; 3] = ["USDT-FUTURES", "USDC-FUTURES", "COIN-FUTURES"];

pub async fn list_instruments() -> Result<Vec<InstrumentInfo>> {
    list_from(REST_BASE).await
}

pub async fn list_from(base: &str) -> Result<Vec<InstrumentInfo>> {
    let rest = discovery_rest(base);
    let mut out = Vec::new();
    for pt in PRODUCT_TYPES {
        let text = rest
            .get_text(&format!("/api/v2/mix/market/contracts?productType={pt}"))
            .await?;
        out.extend(parse_contracts(pt, &text)?);
    }
    Ok(out)
}

/// Tick size from `pricePlace` decimals and `priceEndStep` (place 2, step 5 → "0.05").
pub fn tick_text(price_place: &str, end_step: &str) -> String {
    let places: usize = price_place.trim().parse().unwrap_or(0);
    let step: u64 = end_step.trim().parse().unwrap_or(1).max(1);
    if places == 0 {
        return step.to_string();
    }
    let digits = format!("{step:0>width$}", width = places + 1);
    let (int, frac) = digits.split_at(digits.len() - places);
    format!("{int}.{frac}")
}

pub fn parse_contracts(product_type: &str, text: &str) -> Result<Vec<InstrumentInfo>> {
    let v = parse_json(text, "bitget contracts")?;
    if v["code"].as_str() != Some("00000") {
        return Err(ConnectorError::Api(format!(
            "bitget {}: {}",
            v["code"],
            v["msg"].as_str().unwrap_or("")
        )));
    }
    let mut out = Vec::new();
    for c in v["data"].as_array().map(Vec::as_slice).unwrap_or_default() {
        if c["symbolStatus"].as_str() != Some("normal") {
            continue;
        }
        let s = |k: &str| c[k].as_str().unwrap_or("");
        let expiry = text_of(&c["deliveryTime"])
            .parse::<i64>()
            .ok()
            .filter(|t| *t > 0);
        let (kind, expiry) = match (s("symbolType"), expiry) {
            ("delivery", Some(t)) => (MarketKind::Future, Some(t)),
            _ => (MarketKind::Perp, None),
        };
        let settle = c["supportMarginCoins"][0]
            .as_str()
            .unwrap_or(s("quoteCoin"));
        let row = InstrumentInfo::new(
            "bitget",
            kind,
            s("symbol"),
            s("baseCoin"),
            s("quoteCoin"),
            settle,
            product_type == "COIN-FUTURES",
            RawSpec {
                tick: &tick_text(&text_of(&c["pricePlace"]), &text_of(&c["priceEndStep"])),
                step: &text_of(&c["sizeMultiplier"]),
                min_qty: &text_of(&c["minTradeNum"]),
            },
            1.0,
            expiry,
        );
        out.extend(row);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tick_from_places() {
        assert_eq!(tick_text("1", "1"), "0.1");
        assert_eq!(tick_text("2", "5"), "0.05");
        assert_eq!(tick_text("0", "1"), "1");
        assert_eq!(tick_text("6", "1"), "0.000001");
        assert_eq!(tick_text("1", "25"), "2.5");
    }

    #[test]
    fn usdt_contracts() {
        let rows = parse_contracts(
            "USDT-FUTURES",
            include_str!("../fixtures/contracts_usdt.json"),
        )
        .unwrap();
        assert_eq!(rows.len(), 2, "the halted contract is dropped");
        assert_eq!(rows[0].symbol, "BTCUSDT");
        assert_eq!(rows[0].venue, "bitget");
        assert_eq!((rows[0].tick_size, rows[0].price_precision), (0.1, 1));
        assert_eq!(
            (rows[0].lot_step, rows[0].qty_precision, rows[0].min_qty),
            (0.0001, 4, 0.0001)
        );
        assert_eq!(rows[0].market, MarketKind::Perp);
        assert!(!rows[0].inverse);
        assert_eq!(rows[1].tick_size, 0.01);
        assert!(parse_contracts("USDT-FUTURES", r#"{"code":"40034","msg":"x"}"#).is_err());
    }
}
