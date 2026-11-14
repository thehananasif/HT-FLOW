//! Symbol discovery: every tradeable Kraken Futures contract (flexible perpetuals and dated
//! futures) from `/derivatives/api/v3/instruments`. Indices and suspended contracts are skipped.
use htflow_connector_common::instruments::{
    discovery_rest, parse_json, pow10_text, text_of, InstrumentInfo, MarketKind, RawSpec,
};
use htflow_connector_common::{parse_iso8601_ms, ConnectorError, Result};

use crate::REST_BASE;

pub async fn list_instruments() -> Result<Vec<InstrumentInfo>> {
    list_from(REST_BASE).await
}

pub async fn list_from(base: &str) -> Result<Vec<InstrumentInfo>> {
    parse_instruments(
        &discovery_rest(base)
            .get_text("/derivatives/api/v3/instruments")
            .await?,
    )
}

/// `PF_XBTUSD` / `FI_XBTUSD_261225` → (`BTC`, `USD`) when the venue gives no base / quote.
fn base_quote(symbol: &str) -> (String, String) {
    let pair = symbol.split('_').nth(1).unwrap_or(symbol).to_uppercase();
    let (b, q) = pair.split_at(pair.len().saturating_sub(3));
    let b = if b == "XBT" { "BTC" } else { b };
    (b.to_string(), q.to_string())
}

pub fn parse_instruments(text: &str) -> Result<Vec<InstrumentInfo>> {
    let v = parse_json(text, "kraken instruments")?;
    if v["result"].as_str() != Some("success") {
        return Err(ConnectorError::Api(format!(
            "kraken: {}",
            v["error"].as_str().unwrap_or("instruments failed")
        )));
    }
    let mut out = Vec::new();
    for i in v["instruments"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        if i["tradeable"].as_bool() != Some(true) || i["suspended"].as_bool() == Some(true) {
            continue;
        }
        let ty = i["type"].as_str().unwrap_or("");
        let symbol = i["symbol"].as_str().unwrap_or_default().to_uppercase();
        let expiry = i["lastTradingTime"].as_str().and_then(parse_iso8601_ms);
        let kind = match ty {
            "flexible_futures" => MarketKind::Perp,
            "futures_inverse" | "futures_vanilla" if expiry.is_some() => MarketKind::Future,
            _ => continue,
        };
        let (b, q) = base_quote(&symbol);
        let base = i["base"].as_str().map(str::to_string).unwrap_or(b);
        let quote = i["quote"].as_str().map(str::to_string).unwrap_or(q);
        let step = pow10_text(i["contractValueTradePrecision"].as_i64().unwrap_or(0) as i32);
        let inverse = ty == "futures_inverse";
        let row = InstrumentInfo::new(
            "kraken-futures",
            kind,
            &symbol,
            &base,
            &quote,
            if inverse { &base } else { &quote },
            inverse,
            RawSpec {
                tick: &text_of(&i["tickSize"]),
                step: &step,
                min_qty: &step,
            },
            i["contractSize"].as_f64().unwrap_or(1.0),
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
    fn instruments() {
        let rows = parse_instruments(include_str!("../fixtures/instruments.json")).unwrap();
        let syms: Vec<&str> = rows.iter().map(|r| r.symbol.as_str()).collect();
        assert_eq!(
            syms,
            ["PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD", "FI_XBTUSD_261225"]
        );
        let btc = &rows[0];
        assert_eq!(btc.venue, "kraken-futures");
        assert_eq!((btc.base.as_str(), btc.quote.as_str()), ("BTC", "USD"));
        assert_eq!((btc.tick_size, btc.price_precision), (1.0, 0));
        assert_eq!((btc.lot_step, btc.qty_precision), (0.0001, 4));
        assert_eq!(rows[2].tick_size, 0.01);
        let fi = &rows[3];
        assert_eq!(fi.market, MarketKind::Future);
        assert!(fi.inverse);
        assert_eq!((fi.base.as_str(), fi.settle.as_str()), ("BTC", "BTC"));
        assert_eq!(fi.expiry_ms, parse_iso8601_ms("2026-12-25T16:00:00.000Z"));
        assert!(parse_instruments(r#"{"result":"error","error":"x"}"#).is_err());
    }
}
