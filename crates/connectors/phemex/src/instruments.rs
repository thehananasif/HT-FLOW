//! Symbol discovery: every `Listed` Phemex perpetual (USDT / USDC hedged contracts,
//! `perpProductsV2` of `/public/products`) — the contracts the connector streams.
use htflow_connector_common::instruments::{
    discovery_rest, parse_json, text_of, InstrumentInfo, MarketKind, RawSpec,
};
use htflow_connector_common::{ConnectorError, Result};

use crate::REST_BASE;

pub async fn list_instruments() -> Result<Vec<InstrumentInfo>> {
    list_from(REST_BASE).await
}

pub async fn list_from(base: &str) -> Result<Vec<InstrumentInfo>> {
    parse_products(&discovery_rest(base).get_text("/public/products").await?)
}

pub fn parse_products(text: &str) -> Result<Vec<InstrumentInfo>> {
    let v = parse_json(text, "phemex products")?;
    if v["code"].as_i64() != Some(0) {
        return Err(ConnectorError::Api(format!(
            "phemex {}: {}",
            v["code"],
            v["msg"].as_str().unwrap_or("")
        )));
    }
    let mut out = Vec::new();
    let list = v["data"]["perpProductsV2"].as_array();
    for p in list.map(Vec::as_slice).unwrap_or_default() {
        if p["status"].as_str() != Some("Listed") {
            continue;
        }
        let s = |k: &str| p[k].as_str().unwrap_or("");
        let step = text_of(&p["qtyStepSize"]);
        let row = InstrumentInfo::new(
            "phemex",
            MarketKind::Perp,
            s("symbol"),
            s("baseCurrency"),
            s("quoteCurrency"),
            s("settleCurrency"),
            false,
            RawSpec {
                tick: &text_of(&p["tickSize"]),
                step: &step,
                min_qty: &step,
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
    fn products() {
        let rows = parse_products(include_str!("../fixtures/products.json")).unwrap();
        let syms: Vec<&str> = rows.iter().map(|r| r.symbol.as_str()).collect();
        assert_eq!(
            syms,
            ["BTCUSDT", "ETHUSDT"],
            "delisted and legacy products skipped"
        );
        assert_eq!(rows[0].venue, "phemex");
        assert_eq!((rows[0].tick_size, rows[0].lot_step), (0.1, 0.001));
        assert_eq!(
            (rows[0].base.as_str(), rows[0].settle.as_str()),
            ("BTC", "USDT")
        );
        assert_eq!(rows[1].qty_precision, 2);
        assert!(parse_products(r#"{"code":1,"msg":"x"}"#).is_err());
    }
}
