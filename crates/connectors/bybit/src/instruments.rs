//! Symbol discovery: every `Trading` instrument of a Bybit v5 category from
//! `/v5/market/instruments-info` (linear and inverse are paged with `nextPageCursor`).
use htflow_connector_common::instruments::{
    discovery_rest, parse_json, text_of, InstrumentInfo, MarketKind, RawSpec,
};
use htflow_connector_common::{ConnectorError, Result};

use crate::REST_BASE;

/// A Bybit v5 product category.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Linear,
    Inverse,
    Spot,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Category::Linear => "linear",
            Category::Inverse => "inverse",
            Category::Spot => "spot",
        }
    }
    /// Feed provider id: only linear streams through the built-in connector today.
    pub fn venue(self) -> &'static str {
        match self {
            Category::Linear => "bybit-linear",
            Category::Inverse => "bybit-inverse",
            Category::Spot => "bybit-spot",
        }
    }
}

/// Pages fetched at most (1,000 rows each).
const MAX_PAGES: usize = 10;

pub async fn list_instruments(category: Category) -> Result<Vec<InstrumentInfo>> {
    list_from(REST_BASE, category).await
}

/// Same as [`list_instruments`] against another base URL (tests use a local mock server).
pub async fn list_from(base: &str, category: Category) -> Result<Vec<InstrumentInfo>> {
    let rest = discovery_rest(base);
    let mut out = Vec::new();
    let mut cursor = String::new();
    for _ in 0..MAX_PAGES {
        let mut path = format!("/v5/market/instruments-info?category={}", category.as_str());
        if category != Category::Spot {
            path.push_str("&limit=1000");
        }
        if !cursor.is_empty() {
            path.push_str("&cursor=");
            path.push_str(&cursor);
        }
        let (rows, next) = parse_page(category, &rest.get_text(&path).await?)?;
        out.extend(rows);
        match next {
            Some(n) if !n.is_empty() && n != cursor => cursor = n,
            _ => break,
        }
    }
    Ok(out)
}

/// One `instruments-info` page → rows and the next page cursor.
pub fn parse_page(category: Category, text: &str) -> Result<(Vec<InstrumentInfo>, Option<String>)> {
    let v = parse_json(text, "bybit instruments-info")?;
    if v["retCode"].as_i64() != Some(0) {
        return Err(ConnectorError::Api(format!(
            "bybit {}: {}",
            v["retCode"],
            v["retMsg"].as_str().unwrap_or("")
        )));
    }
    let r = &v["result"];
    let mut out = Vec::new();
    for i in r["list"].as_array().map(Vec::as_slice).unwrap_or_default() {
        if i["status"].as_str() != Some("Trading") {
            continue;
        }
        let ct = i["contractType"].as_str().unwrap_or("");
        let expiry = text_of(&i["deliveryTime"])
            .parse::<i64>()
            .ok()
            .filter(|t| *t > 0);
        let (kind, expiry) = match category {
            Category::Spot => (MarketKind::Spot, None),
            _ if ct.ends_with("Futures") && expiry.is_some() => (MarketKind::Future, expiry),
            _ => (MarketKind::Perp, None),
        };
        let lot = &i["lotSizeFilter"];
        let step = match category {
            Category::Spot => text_of(&lot["basePrecision"]),
            _ => text_of(&lot["qtyStep"]),
        };
        let tick = text_of(&i["priceFilter"]["tickSize"]);
        let min = text_of(&lot["minOrderQty"]);
        let row = InstrumentInfo::new(
            category.venue(),
            kind,
            i["symbol"].as_str().unwrap_or_default(),
            i["baseCoin"].as_str().unwrap_or_default(),
            i["quoteCoin"].as_str().unwrap_or_default(),
            i["settleCoin"].as_str().unwrap_or_default(),
            category == Category::Inverse,
            RawSpec {
                tick: &tick,
                step: &step,
                min_qty: &min,
            },
            1.0,
            expiry,
        );
        out.extend(row);
    }
    let next = r["nextPageCursor"].as_str().map(str::to_string);
    Ok((out, next))
}

#[cfg(test)]
mod tests {
    use super::*;
    use htflow_connector_common::mock_http::{MockServer, Reply};

    #[tokio::test]
    async fn pages_linear_instruments() {
        let srv = MockServer::start(|p| {
            if p.contains("cursor=page2") {
                Reply::ok(include_str!("../fixtures/instruments_linear_p2.json"))
            } else {
                Reply::ok(include_str!("../fixtures/instruments_linear_p1.json"))
            }
        });
        let rows = list_from(&srv.base, Category::Linear).await.unwrap();
        let syms: Vec<&str> = rows.iter().map(|r| r.symbol.as_str()).collect();
        assert_eq!(
            syms,
            ["BTCUSDT", "BTC-26DEC26", "1000PEPEUSDT"],
            "pre-launch dropped"
        );
        assert_eq!(
            srv.requests(),
            vec![
                "/v5/market/instruments-info?category=linear&limit=1000",
                "/v5/market/instruments-info?category=linear&limit=1000&cursor=page2",
            ]
        );
        assert_eq!(rows[0].venue, "bybit-linear");
        assert_eq!((rows[0].tick_size, rows[0].price_precision), (0.1, 1));
        assert_eq!((rows[0].qty_precision, rows[0].min_qty), (3, 0.001));
        assert_eq!(rows[1].market, MarketKind::Future);
        assert_eq!(rows[1].expiry_ms, Some(1_798_272_000_000));
        assert_eq!(rows[1].settle, "USDC");
        assert_eq!((rows[2].lot_step, rows[2].qty_precision), (100.0, 0));
    }

    #[test]
    fn inverse_and_spot() {
        let (inv, next) = parse_page(
            Category::Inverse,
            include_str!("../fixtures/instruments_inverse.json"),
        )
        .unwrap();
        assert_eq!(next.as_deref(), Some(""));
        assert_eq!(inv.len(), 2);
        assert!(inv.iter().all(|r| r.inverse && r.venue == "bybit-inverse"));
        assert_eq!(inv[0].market, MarketKind::Perp);
        assert_eq!(inv[1].market, MarketKind::Future);
        assert_eq!(inv[0].settle, "BTC");

        let (spot, next) = parse_page(
            Category::Spot,
            include_str!("../fixtures/instruments_spot.json"),
        )
        .unwrap();
        assert_eq!(next, None);
        assert_eq!(spot.len(), 2);
        assert_eq!(spot[0].market, MarketKind::Spot);
        assert_eq!((spot[0].lot_step, spot[0].qty_precision), (0.000001, 6));
        assert_eq!(spot[0].min_qty, 0.000048);
        assert_eq!(spot[1].price_precision, 6);
        assert!(parse_page(Category::Spot, r#"{"retCode":10001,"retMsg":"bad"}"#).is_err());
    }
}
