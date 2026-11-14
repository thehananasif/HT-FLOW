//! Symbol discovery: every Bitfinex trading pair (spot + perpetual derivatives) from
//! `/v2/conf/pub:info:pair[:futures]`. Bitfinex prices have five significant digits instead of a
//! fixed tick, so the tick size comes from the last price in `/v2/tickers?symbols=ALL` (the
//! same rule the connector applies); a pair without a ticker is not trading and is skipped.
use std::collections::HashMap;

use htflow_connector_common::instruments::{
    discovery_rest, parse_json, text_of, InstrumentInfo, MarketKind, RawSpec,
};
use htflow_connector_common::{num_f64, ConnectorError, Result};
use htflow_core_types::TickSize;
use serde_json::Value;

use crate::{tick_for, REST_BASE};

/// Bitfinex amounts have eight decimals.
const AMOUNT_STEP: &str = "0.00000001";

pub async fn list_instruments() -> Result<Vec<InstrumentInfo>> {
    list_from(REST_BASE).await
}

pub async fn list_from(base: &str) -> Result<Vec<InstrumentInfo>> {
    let rest = discovery_rest(base);
    let pairs = rest.get_text("/v2/conf/pub:info:pair").await?;
    let futures = rest.get_text("/v2/conf/pub:info:pair:futures").await?;
    let tickers = rest.get_text("/v2/tickers?symbols=ALL").await?;
    parse(&pairs, &futures, &tickers)
}

fn tick_text(t: TickSize) -> String {
    if t.scale == 0 {
        return t.units.to_string();
    }
    let places = t.scale as usize;
    let digits = format!("{:0>width$}", t.units, width = places + 1);
    let (int, frac) = digits.split_at(digits.len() - places);
    format!("{int}.{frac}")
}

/// Bitfinex writes USDT as `UST` and suffixes derivative currencies with `F0`.
fn asset(s: &str) -> String {
    let s = s.strip_suffix("F0").unwrap_or(s).to_uppercase();
    match s.as_str() {
        "UST" => "USDT".into(),
        _ => s,
    }
}

/// `BTCUSD` → (`BTC`, `USD`); `AAVE:USD` / `BTCF0:USTF0` split at the colon.
fn split_pair(pair: &str) -> (String, String) {
    match pair.split_once(':') {
        Some((b, q)) => (asset(b), asset(q)),
        None if pair.len() > 3 => {
            let (b, q) = pair.split_at(pair.len() - 3);
            (asset(b), asset(q))
        }
        None => (asset(pair), String::new()),
    }
}

fn info_rows(text: &str, what: &str) -> Result<Vec<Value>> {
    let v = parse_json(text, what)?;
    match v {
        Value::Array(mut outer) if !outer.is_empty() => match outer.swap_remove(0) {
            Value::Array(rows) => Ok(rows),
            _ => Err(ConnectorError::Api(format!("{what}: unexpected shape"))),
        },
        Value::Array(_) => Ok(Vec::new()),
        _ => Err(ConnectorError::Api(format!("{what}: unexpected shape"))),
    }
}

/// Maps the pair lists and the tickers to discovery rows.
pub fn parse(pairs: &str, futures: &str, tickers: &str) -> Result<Vec<InstrumentInfo>> {
    let last: HashMap<String, f64> = match parse_json(tickers, "bitfinex tickers")? {
        Value::Array(rows) => rows
            .iter()
            .filter_map(|r| {
                let r = r.as_array()?;
                let sym = r.first()?.as_str()?;
                // Trading tickers: [SYMBOL, BID, BID_SIZE, ASK, ASK_SIZE, CHG, CHG%, LAST, …].
                if !sym.starts_with('t') {
                    return None;
                }
                Some((sym.to_string(), num_f64(r.get(7)?)?))
            })
            .collect(),
        _ => {
            return Err(ConnectorError::Api(
                "bitfinex tickers: unexpected shape".into(),
            ))
        }
    };
    let mut out = Vec::new();
    for (rows, kind) in [
        (info_rows(pairs, "bitfinex pairs")?, MarketKind::Spot),
        (info_rows(futures, "bitfinex futures")?, MarketKind::Perp),
    ] {
        for r in &rows {
            let Some(pair) = r[0].as_str() else { continue };
            let symbol = format!("t{pair}");
            let Some(px) = last.get(&symbol).copied().filter(|p| *p > 0.0) else {
                continue;
            };
            let (base, quote) = split_pair(pair);
            let min = text_of(&r[1][3]);
            let row = InstrumentInfo::new(
                "bitfinex",
                kind,
                &symbol,
                &base,
                &quote,
                &quote,
                false,
                RawSpec {
                    tick: &tick_text(tick_for(px)),
                    step: AMOUNT_STEP,
                    min_qty: &min,
                },
                1.0,
                None,
            );
            out.extend(row);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairs_and_futures() {
        let rows = parse(
            include_str!("../fixtures/pairs.json"),
            include_str!("../fixtures/pairs_futures.json"),
            include_str!("../fixtures/tickers.json"),
        )
        .unwrap();
        let syms: Vec<&str> = rows.iter().map(|r| r.symbol.as_str()).collect();
        assert_eq!(syms, ["tAAVE:USD", "tBTCUSD", "tETHBTC", "tBTCF0:USTF0"]);
        let btc = &rows[1];
        assert_eq!((btc.base.as_str(), btc.quote.as_str()), ("BTC", "USD"));
        assert_eq!((btc.tick_size, btc.price_precision), (1.0, 0));
        assert_eq!((btc.qty_precision, btc.min_qty), (8, 0.00004));
        assert_eq!(rows[0].base, "AAVE");
        assert_eq!(rows[0].tick_size, 0.01);
        assert_eq!(rows[2].price_precision, 6);
        let perp = &rows[3];
        assert_eq!(perp.market, MarketKind::Perp);
        assert_eq!((perp.base.as_str(), perp.quote.as_str()), ("BTC", "USDT"));
    }

    #[test]
    fn tick_texts() {
        assert_eq!(
            tick_text(TickSize {
                scale: 0,
                units: 10
            }),
            "10"
        );
        assert_eq!(tick_text(TickSize { scale: 3, units: 1 }), "0.001");
        assert_eq!(split_pair("ETHBTC"), ("ETH".into(), "BTC".into()));
    }
}
