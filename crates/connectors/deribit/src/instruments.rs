//! Symbol discovery: every active Deribit future / perpetual (`public/get_instruments`,
//! `kind=future`), plus the number of listed options (the options chain loads them itself).
use htflow_connector_common::instruments::{
    discovery_rest, f64_text, parse_json, InstrumentInfo, MarketKind, RawSpec,
};
use htflow_connector_common::{ConnectorError, Result};
use serde_json::Value;

use crate::REST_BASE;

const FUTURES: &str = "/api/v2/public/get_instruments?currency=any&kind=future&expired=false";
const OPTIONS: &str = "/api/v2/public/get_instruments?currency=any&kind=option&expired=false";

pub async fn list_instruments() -> Result<Vec<InstrumentInfo>> {
    list_from(REST_BASE).await
}

pub async fn list_from(base: &str) -> Result<Vec<InstrumentInfo>> {
    parse_futures(&discovery_rest(base).get_text(FUTURES).await?)
}

/// Active options listed right now (count only).
pub async fn count_options() -> Result<usize> {
    count_options_from(REST_BASE).await
}

pub async fn count_options_from(base: &str) -> Result<usize> {
    parse_option_count(&discovery_rest(base).get_text(OPTIONS).await?)
}

fn result(text: &str) -> Result<Vec<Value>> {
    let mut v = parse_json(text, "deribit get_instruments")?;
    if let Some(e) = v.get("error") {
        return Err(ConnectorError::Api(format!("deribit: {e}")));
    }
    match v["result"].take() {
        Value::Array(a) => Ok(a),
        _ => Err(ConnectorError::Api(
            "deribit get_instruments: no result".into(),
        )),
    }
}

fn active(i: &Value) -> bool {
    i["is_active"].as_bool().unwrap_or(true) && i["state"].as_str().unwrap_or("open") == "open"
}

pub fn parse_futures(text: &str) -> Result<Vec<InstrumentInfo>> {
    let mut out = Vec::new();
    for i in result(text)?.iter().filter(|i| active(i)) {
        if i["kind"].as_str().unwrap_or("future") != "future" {
            continue;
        }
        let s = |k: &str| i[k].as_str().unwrap_or("");
        let perp = s("settlement_period") == "perpetual";
        let inverse = s("instrument_type") == "reversed" || s("future_type") == "reversed";
        let quote = if s("quote_currency").is_empty() {
            s("counter_currency")
        } else {
            s("quote_currency")
        };
        let num = |k: &str| i[k].as_f64().map(f64_text).unwrap_or_default();
        let min = num("min_trade_amount");
        let row = InstrumentInfo::new(
            "deribit",
            if perp {
                MarketKind::Perp
            } else {
                MarketKind::Future
            },
            s("instrument_name"),
            s("base_currency"),
            quote,
            s("settlement_currency"),
            inverse,
            RawSpec {
                tick: &num("tick_size"),
                step: &min,
                min_qty: &min,
            },
            i["contract_size"].as_f64().unwrap_or(1.0),
            if perp {
                None
            } else {
                i["expiration_timestamp"].as_i64()
            },
        );
        out.extend(row);
    }
    Ok(out)
}

pub fn parse_option_count(text: &str) -> Result<usize> {
    Ok(result(text)?.iter().filter(|i| active(i)).count())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn futures_and_perpetuals() {
        let rows = parse_futures(include_str!("../fixtures/instruments_future.json")).unwrap();
        assert_eq!(rows.len(), 3);
        let btc = rows.iter().find(|r| r.symbol == "BTC-PERPETUAL").unwrap();
        assert!(btc.inverse);
        assert_eq!(btc.market, MarketKind::Perp);
        assert_eq!((btc.tick_size, btc.price_precision), (0.5, 1));
        assert_eq!(
            (btc.lot_step, btc.min_qty, btc.contract_size),
            (10.0, 10.0, 10.0)
        );
        assert_eq!((btc.quote.as_str(), btc.settle.as_str()), ("USD", "BTC"));
        let eth = rows
            .iter()
            .find(|r| r.symbol == "ETH_USDC-PERPETUAL")
            .unwrap();
        assert!(!eth.inverse);
        assert_eq!((eth.price_precision, eth.qty_precision), (2, 4));
        let dated = rows
            .iter()
            .find(|r| r.market == MarketKind::Future)
            .unwrap();
        assert_eq!(dated.symbol, "BTC-14NOV26");
        assert_eq!(dated.expiry_ms, Some(1_794_643_200_000));
        assert_eq!(dated.tick_size, 2.5);
    }

    #[test]
    fn option_count() {
        assert_eq!(
            parse_option_count(include_str!("../fixtures/instruments_option.json")).unwrap(),
            3
        );
        assert!(parse_option_count(r#"{"error":{"code":1,"message":"x"}}"#).is_err());
    }
}
