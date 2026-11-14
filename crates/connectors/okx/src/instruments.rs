//! Symbol discovery: every `live` OKX instrument of an `instType` (SWAP, FUTURES, SPOT) from
//! `/api/v5/public/instruments`. All three stream through the one OKX connector (`okx-swap`),
//! which works out the `instType` from the instrument id.
use htflow_connector_common::instruments::{
    discovery_rest, parse_json, text_of, InstrumentInfo, MarketKind, RawSpec,
};
use htflow_connector_common::{ConnectorError, Result};

use crate::REST_BASE;

/// Feed provider id of every OKX instrument.
pub const VENUE: &str = "okx-swap";

/// `inst_type`: `SWAP`, `FUTURES` or `SPOT`.
pub async fn list_instruments(inst_type: &str) -> Result<Vec<InstrumentInfo>> {
    list_from(REST_BASE, inst_type).await
}

pub async fn list_from(base: &str, inst_type: &str) -> Result<Vec<InstrumentInfo>> {
    let text = discovery_rest(base)
        .get_text(&format!("/api/v5/public/instruments?instType={inst_type}"))
        .await?;
    parse_instruments(&text)
}

pub fn parse_instruments(text: &str) -> Result<Vec<InstrumentInfo>> {
    let v = parse_json(text, "okx instruments")?;
    if v["code"].as_str() != Some("0") {
        return Err(ConnectorError::Api(format!(
            "okx {}: {}",
            v["code"],
            v["msg"].as_str().unwrap_or("")
        )));
    }
    let mut out = Vec::new();
    for i in v["data"].as_array().map(Vec::as_slice).unwrap_or_default() {
        if i["state"].as_str() != Some("live") {
            continue;
        }
        let s = |k: &str| i[k].as_str().unwrap_or("").to_string();
        let kind = match i["instType"].as_str() {
            Some("SWAP") => MarketKind::Perp,
            Some("FUTURES") => MarketKind::Future,
            Some("SPOT") => MarketKind::Spot,
            _ => continue,
        };
        let (base, quote) = if kind == MarketKind::Spot {
            (s("baseCcy"), s("quoteCcy"))
        } else {
            // Derivatives name their underlying ("BTC-USD"), not base / quote.
            let uly = if s("uly").is_empty() {
                s("instFamily")
            } else {
                s("uly")
            };
            let mut p = uly.splitn(2, '-');
            let b = p.next().unwrap_or("").to_string();
            let q = p.next().unwrap_or("").split('_').next().unwrap_or("");
            (b, q.to_string())
        };
        let inverse = i["ctType"].as_str() == Some("inverse");
        let contract = text_of(&i["ctVal"]).parse::<f64>().unwrap_or(1.0);
        let expiry = text_of(&i["expTime"]).parse::<i64>().ok();
        let row = InstrumentInfo::new(
            VENUE,
            kind,
            &s("instId"),
            &base,
            &quote,
            &s("settleCcy"),
            inverse,
            RawSpec {
                tick: &text_of(&i["tickSz"]),
                step: &text_of(&i["lotSz"]),
                min_qty: &text_of(&i["minSz"]),
            },
            if kind == MarketKind::Spot {
                1.0
            } else {
                contract
            },
            if kind == MarketKind::Future {
                expiry
            } else {
                None
            },
        );
        out.extend(row);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swaps() {
        let rows = parse_instruments(include_str!("../fixtures/instruments_swap.json")).unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.symbol.as_str()).collect();
        assert_eq!(ids, ["BTC-USD-SWAP", "BTC-USDT-SWAP", "PEPE-USDT-SWAP"]);
        let inv = &rows[0];
        assert!(inv.inverse);
        assert_eq!(
            (inv.base.as_str(), inv.quote.as_str(), inv.settle.as_str()),
            ("BTC", "USD", "BTC")
        );
        assert_eq!(inv.contract_size, 100.0);
        let lin = &rows[1];
        assert!(!lin.inverse);
        assert_eq!(lin.venue, "okx-swap");
        assert_eq!(
            (lin.tick_size, lin.lot_step, lin.contract_size),
            (0.1, 0.01, 0.01)
        );
        assert_eq!(rows[2].price_precision, 10);
    }

    #[test]
    fn futures_and_spot() {
        let f = parse_instruments(include_str!("../fixtures/instruments_futures.json")).unwrap();
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].market, MarketKind::Future);
        assert_eq!(f[0].expiry_ms, Some(1_795_766_400_000));
        let s = parse_instruments(include_str!("../fixtures/instruments_spot.json")).unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].market, MarketKind::Spot);
        assert_eq!((s[1].base.as_str(), s[1].quote.as_str()), ("ETH", "BTC"));
        assert_eq!((s[0].qty_precision, s[0].min_qty), (8, 0.00001));
        assert!(parse_instruments(r#"{"code":"51001","msg":"x","data":[]}"#).is_err());
    }
}
