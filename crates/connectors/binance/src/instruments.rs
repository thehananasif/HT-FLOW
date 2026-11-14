//! Symbol discovery: every `TRADING` instrument of a Binance market from its public
//! `exchangeInfo` (`/fapi/v1`, `/dapi/v1`, `/api/v3`).
use htflow_connector_common::instruments::{
    discovery_rest, parse_json, text_of, InstrumentInfo, MarketKind, RawSpec,
};
use htflow_connector_common::{ConnectorError, Result};
use serde_json::Value;

use crate::Market;

/// Binance stamps perpetuals with a delivery date in 2100; anything this far out is no expiry.
const NO_EXPIRY_MS: i64 = 4_000_000_000_000;

fn path(m: Market, trading_only: bool) -> &'static str {
    match (m, trading_only) {
        (Market::UsdM, _) => "/fapi/v1/exchangeInfo",
        (Market::CoinM, _) => "/dapi/v1/exchangeInfo",
        (Market::Spot, true) => "/api/v3/exchangeInfo?symbolStatus=TRADING",
        (Market::Spot, false) => "/api/v3/exchangeInfo",
    }
}

/// Every tradable instrument of `market` from the live exchange.
pub async fn list_instruments(market: Market) -> Result<Vec<InstrumentInfo>> {
    list_from(market.rest_base(), market).await
}

/// Same as [`list_instruments`] against another base URL (tests use a local mock server).
pub async fn list_from(base: &str, market: Market) -> Result<Vec<InstrumentInfo>> {
    let rest = discovery_rest(base);
    // The spot list is large; ask the server to filter, and fall back when it does not know the
    // parameter.
    let text = match rest.get_text(path(market, true)).await {
        Err(ConnectorError::Api(m)) if market == Market::Spot && m.starts_with("HTTP 400") => {
            rest.get_text(path(market, false)).await?
        }
        r => r?,
    };
    parse_exchange_info(market, &text)
}

fn filter<'a>(s: &'a Value, kind: &str) -> Option<&'a Value> {
    s["filters"]
        .as_array()?
        .iter()
        .find(|f| f["filterType"] == kind)
}

/// Maps an `exchangeInfo` body to discovery rows (non-trading symbols dropped).
pub fn parse_exchange_info(market: Market, text: &str) -> Result<Vec<InstrumentInfo>> {
    let v = parse_json(text, "binance exchangeInfo")?;
    if let Some(msg) = v["msg"].as_str() {
        return Err(ConnectorError::Api(format!("binance: {msg}")));
    }
    let list = v["symbols"]
        .as_array()
        .ok_or_else(|| ConnectorError::Api("binance exchangeInfo: no symbols".into()))?;
    let mut out = Vec::with_capacity(list.len());
    for s in list {
        let status = s["status"].as_str().or(s["contractStatus"].as_str());
        if status != Some("TRADING") {
            continue;
        }
        let symbol = s["symbol"].as_str().unwrap_or_default();
        let base = s["baseAsset"].as_str().unwrap_or_default();
        let quote = s["quoteAsset"].as_str().unwrap_or_default();
        let settle = s["marginAsset"].as_str().unwrap_or(quote);
        let tick = filter(s, "PRICE_FILTER").map(|f| text_of(&f["tickSize"]));
        let lot = filter(s, "LOT_SIZE");
        let step = lot.map(|f| text_of(&f["stepSize"])).unwrap_or_default();
        let min = lot.map(|f| text_of(&f["minQty"])).unwrap_or_default();
        let contract_type = s["contractType"].as_str().unwrap_or("");
        let expiry = s["deliveryDate"].as_i64().filter(|d| *d < NO_EXPIRY_MS);
        let (kind, expiry) = match market {
            Market::Spot => (MarketKind::Spot, None),
            _ if contract_type.contains("PERPETUAL") || expiry.is_none() => {
                (MarketKind::Perp, None)
            }
            _ => (MarketKind::Future, expiry),
        };
        let contract = match market {
            Market::CoinM => s["contractSize"].as_f64().unwrap_or(1.0),
            _ => 1.0,
        };
        let row = InstrumentInfo::new(
            market.venue(),
            kind,
            symbol,
            base,
            quote,
            settle,
            market == Market::CoinM,
            RawSpec {
                tick: tick.as_deref().unwrap_or(""),
                step: &step,
                min_qty: &min,
            },
            contract,
            expiry,
        );
        out.extend(row);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use htflow_connector_common::mock_http::{MockServer, Reply};

    #[test]
    fn usdm_exchange_info() {
        let rows = parse_exchange_info(
            Market::UsdM,
            include_str!("../fixtures/exchange_info_usdm.json"),
        )
        .unwrap();
        let syms: Vec<&str> = rows.iter().map(|r| r.symbol.as_str()).collect();
        assert_eq!(syms, ["BTCUSDT", "1000PEPEUSDT", "BTCUSDT_261225"]);
        let btc = &rows[0];
        assert_eq!(btc.venue, "binance-futures");
        assert_eq!(btc.market, MarketKind::Perp);
        assert_eq!((btc.tick_size, btc.price_precision), (0.1, 1));
        assert_eq!(
            (btc.lot_step, btc.qty_precision, btc.min_qty),
            (0.001, 3, 0.001)
        );
        assert_eq!(btc.expiry_ms, None);
        assert_eq!(rows[1].price_precision, 7);
        assert_eq!(rows[1].base, "1000PEPE");
        let q = &rows[2];
        assert_eq!(q.market, MarketKind::Future);
        assert_eq!(q.expiry_ms, Some(1_798_185_600_000));
    }

    #[test]
    fn coinm_exchange_info() {
        let rows = parse_exchange_info(
            Market::CoinM,
            include_str!("../fixtures/exchange_info_coinm.json"),
        )
        .unwrap();
        assert_eq!(rows.len(), 2, "the delivering contract is dropped");
        assert_eq!(rows[0].venue, "binance-coinm");
        assert!(rows[0].inverse);
        assert_eq!(rows[0].contract_size, 100.0);
        assert_eq!(rows[0].settle, "BTC");
        assert_eq!(rows[1].market, MarketKind::Future);
        assert_eq!(rows[1].contract_size, 10.0);
    }

    #[test]
    fn spot_exchange_info() {
        let rows = parse_exchange_info(
            Market::Spot,
            include_str!("../fixtures/exchange_info_spot.json"),
        )
        .unwrap();
        let syms: Vec<&str> = rows.iter().map(|r| r.symbol.as_str()).collect();
        assert_eq!(syms, ["ETHBTC", "BTCUSDT"]);
        assert_eq!(rows[0].venue, "binance-spot");
        assert_eq!(rows[0].market, MarketKind::Spot);
        assert_eq!(
            (rows[0].quote.as_str(), rows[0].settle.as_str()),
            ("BTC", "BTC")
        );
        assert_eq!((rows[1].tick_size, rows[1].qty_precision), (0.01, 5));
        assert!(parse_exchange_info(Market::Spot, r#"{"code":-1,"msg":"nope"}"#).is_err());
    }

    #[tokio::test]
    async fn spot_falls_back_without_status_filter() {
        let srv = MockServer::start(|p| {
            if p.contains("symbolStatus") {
                Reply::status("400 Bad Request", r#"{"code":-1104,"msg":"bad param"}"#)
            } else {
                Reply::ok(include_str!("../fixtures/exchange_info_spot.json"))
            }
        });
        let rows = list_from(&srv.base, Market::Spot).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            srv.requests(),
            vec![
                "/api/v3/exchangeInfo?symbolStatus=TRADING",
                "/api/v3/exchangeInfo"
            ]
        );
    }
}
