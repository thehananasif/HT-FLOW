//! Binance public market data — USDⓈ-M futures, COIN-M futures and spot (P05), free, no key.
//!
//! Live Pipeline stages 1–3 on the shared driver (`htflow-connector-common`): combined stream
//! `<s>@aggTrade/<s>@depth@100ms` (+ `@markPrice@1s` funding and `@forceOrder` liquidations on
//! futures), the REST depth snapshot is fetched once the stream buffers, and the local book is
//! sequence-checked (`pu` chain on futures, `U == u + 1` on spot); any gap refetches the
//! snapshot. Open interest is polled over REST every 10 s (Binance does not stream it).
//! REST goes through a token bucket (2 req/s sustained, burst 10 — aggTrades/depth cost 20
//! weight of the 2,400/min futures budget) and the server clock is measured at connect.

pub mod book_sync;
pub mod wire;

use std::sync::Arc;
use std::time::Duration;

use book_sync::{BookSync, DepthUpdate, SyncOutcome};
use futures_util::future::BoxFuture;
use htflow_connector_common::{
    driver, Action, BookLevels, ClockSkew, MarketApi, Ping, Protocol, Rest, RestBook, StreamConfig,
    TokenBucket,
};
use htflow_core_types::{
    decimals_of, Aggressor, BookSnapshot, MarketEvent, MarketStat, Side, TickSize, Trade,
};
use tokio::sync::{mpsc, watch};

pub use htflow_connector_common::{now_ns, ConnectorError, SymbolSpec};

pub const REST_BASE: &str = "https://fapi.binance.com";
pub const WS_BASE: &str = "wss://fstream.binance.com";
pub const DEPTH_LIMIT: u32 = 1000;

/// `(lastUpdateId, bids, asks)` from the REST depth endpoint, prices in ticks.
pub type DepthSnapshot = (u64, Vec<(i64, f64)>, Vec<(i64, f64)>);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Market {
    /// USDⓈ-margined futures (`fapi`).
    UsdM,
    /// Coin-margined futures (`dapi`), sizes in contracts.
    CoinM,
    Spot,
}

impl Market {
    pub fn venue(self) -> &'static str {
        match self {
            Market::UsdM => "binance-futures",
            Market::CoinM => "binance-coinm",
            Market::Spot => "binance-spot",
        }
    }
    pub fn rest_base(self) -> &'static str {
        match self {
            Market::UsdM => REST_BASE,
            Market::CoinM => "https://dapi.binance.com",
            Market::Spot => "https://api.binance.com",
        }
    }
    pub fn ws_base(self) -> &'static str {
        match self {
            Market::UsdM => WS_BASE,
            Market::CoinM => "wss://dstream.binance.com",
            Market::Spot => "wss://stream.binance.com:9443",
        }
    }
    fn api(self) -> &'static str {
        match self {
            Market::UsdM => "/fapi/v1",
            Market::CoinM => "/dapi/v1",
            Market::Spot => "/api/v3",
        }
    }
    pub fn is_futures(self) -> bool {
        self != Market::Spot
    }
}

#[derive(Debug, Clone)]
pub struct Endpoints {
    pub rest: String,
    pub ws: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            rest: REST_BASE.into(),
            ws: WS_BASE.into(),
        }
    }
}

fn parse_f64(s: &str) -> Result<f64, ConnectorError> {
    htflow_connector_common::parse_f64(s)
}

fn parse_level(tick: &TickSize, l: &[String; 2]) -> Result<(i64, f64), ConnectorError> {
    Ok((tick.parse_ticks(&l[0])?, parse_f64(&l[1])?))
}

pub fn parse_depth(
    tick: &TickSize,
    w: wire::DepthUpdateWire,
) -> Result<DepthUpdate, ConnectorError> {
    Ok(DepthUpdate {
        first_id: w.first_id,
        final_id: w.final_id,
        prev_final_id: w
            .prev_final_id
            .unwrap_or_else(|| w.first_id.saturating_sub(1)),
        event_ms: w.event_ms,
        bids: w
            .bids
            .iter()
            .map(|l| parse_level(tick, l))
            .collect::<Result<_, _>>()?,
        asks: w
            .asks
            .iter()
            .map(|l| parse_level(tick, l))
            .collect::<Result<_, _>>()?,
    })
}

fn aggressor(buyer_is_maker: bool) -> Aggressor {
    if buyer_is_maker {
        Aggressor::Sell
    } else {
        Aggressor::Buy
    }
}

pub fn parse_agg_trade(
    tick: &TickSize,
    t: &wire::AggTrade<'_>,
    local_ns: i64,
) -> Result<Trade, ConnectorError> {
    Ok(Trade {
        exchange_ts_ns: t.trade_ms * 1_000_000,
        local_ts_ns: local_ns,
        px: tick.parse_ticks(t.price)?,
        qty: parse_f64(t.qty)?,
        aggressor: aggressor(t.buyer_is_maker),
        trade_id: t.id,
    })
}

fn rest_trade(tick: &TickSize, r: &wire::AggTradeRest) -> Result<Trade, ConnectorError> {
    Ok(Trade {
        exchange_ts_ns: r.trade_ms * 1_000_000,
        local_ts_ns: r.trade_ms * 1_000_000,
        px: tick.parse_ticks(&r.price)?,
        qty: parse_f64(&r.qty)?,
        aggressor: aggressor(r.buyer_is_maker),
        trade_id: r.id,
    })
}

/// REST client for metadata, snapshots and history backfill.
#[derive(Clone)]
pub struct Binance {
    pub market: Market,
    rest: Rest,
    pub ws: String,
}

/// The USDⓈ-M client (kept for existing callers).
pub type BinanceFutures = Binance;

impl Default for Binance {
    fn default() -> Self {
        Self::market(Market::UsdM)
    }
}

impl Binance {
    pub fn market(market: Market) -> Self {
        Self::with_endpoints(market, market.rest_base(), market.ws_base())
    }

    pub fn with_endpoints(market: Market, rest: &str, ws: &str) -> Self {
        Self {
            market,
            rest: Rest::new(rest, TokenBucket::new(10, Duration::from_secs(5))),
            ws: ws.into(),
        }
    }

    /// USDⓈ-M client on custom endpoints.
    pub fn new(endpoints: Endpoints) -> Self {
        Self::with_endpoints(Market::UsdM, &endpoints.rest, &endpoints.ws)
    }

    fn path(&self, p: &str) -> String {
        format!("{}{p}", self.market.api())
    }

    pub async fn symbol_spec(&self, symbol: &str) -> Result<SymbolSpec, ConnectorError> {
        let sym = symbol.to_uppercase();
        let q = if self.market == Market::Spot {
            format!("/exchangeInfo?symbol={sym}")
        } else {
            "/exchangeInfo".into()
        };
        let info: wire::ExchangeInfo = self.rest.get(&self.path(&q)).await?;
        spec_from_info(&sym, info)
    }

    pub async fn depth_snapshot(
        &self,
        spec: &SymbolSpec,
        limit: u32,
    ) -> Result<DepthSnapshot, ConnectorError> {
        let w: wire::DepthSnapshotWire = self
            .rest
            .get(&self.path(&format!("/depth?symbol={}&limit={limit}", spec.symbol)))
            .await?;
        let bids = w
            .bids
            .iter()
            .map(|l| parse_level(&spec.tick, l))
            .collect::<Result<_, _>>()?;
        let asks = w
            .asks
            .iter()
            .map(|l| parse_level(&spec.tick, l))
            .collect::<Result<_, _>>()?;
        Ok((w.last_update_id, bids, asks))
    }

    /// Aggregated trades in `[start_ms, end_ms]`, oldest first (Live Pipeline stage 6 backfill).
    ///
    /// Binance only accepts `startTime`/`endTime` windows shorter than one hour, so the first
    /// request walks hour windows until it finds trades; after that it pages with `fromId`
    /// (1,000 rows per page) until `end_ms` or `max_pages`.
    pub async fn agg_trades_range(
        &self,
        spec: &SymbolSpec,
        start_ms: i64,
        end_ms: i64,
        max_pages: u32,
    ) -> Result<Vec<Trade>, ConnectorError> {
        const HOUR: i64 = 3_600_000;
        let mut out: Vec<Trade> = Vec::new();
        let mut window = start_ms;
        let mut from_id: Option<u64> = None;
        for _ in 0..max_pages {
            let q = match from_id {
                Some(id) => format!("/aggTrades?symbol={}&fromId={id}&limit=1000", spec.symbol),
                None => format!(
                    "/aggTrades?symbol={}&startTime={window}&endTime={}&limit=1000",
                    spec.symbol,
                    (window + HOUR - 1).min(end_ms)
                ),
            };
            let rows: Vec<wire::AggTradeRest> = self.rest.get(&self.path(&q)).await?;
            let n = rows.len();
            if n == 0 {
                if from_id.is_some() || window + HOUR > end_ms {
                    break;
                }
                window += HOUR;
                continue;
            }
            let mut done = false;
            for r in &rows {
                if r.trade_ms > end_ms {
                    done = true;
                    break;
                }
                if r.trade_ms >= start_ms {
                    out.push(rest_trade(&spec.tick, r)?);
                }
            }
            let last = rows.last().expect("non-empty");
            if done || last.trade_ms >= end_ms {
                break;
            }
            // Continue from the next id (also when the hour window was exhausted).
            from_id = Some(last.id + 1);
            if n < 1000 && last.trade_ms >= now_ns() / 1_000_000 - 1_000 {
                break;
            }
        }
        out.dedup_by_key(|t| t.trade_id);
        Ok(out)
    }

    /// Recent aggregated trades: the last `minutes` minutes.
    pub async fn recent_trades(
        &self,
        spec: &SymbolSpec,
        minutes: u32,
        max_pages: u32,
    ) -> Result<Vec<Trade>, ConnectorError> {
        let now = now_ns() / 1_000_000;
        self.agg_trades_range(spec, now - i64::from(minutes) * 60_000, now, max_pages)
            .await
    }

    /// Open interest (futures only).
    pub async fn open_interest(&self, spec: &SymbolSpec) -> Result<MarketStat, ConnectorError> {
        let w: wire::OpenInterest = self
            .rest
            .get(&self.path(&format!("/openInterest?symbol={}", spec.symbol)))
            .await?;
        Ok(MarketStat::OpenInterest {
            ts_ns: if w.time > 0 {
                w.time * 1_000_000
            } else {
                now_ns()
            },
            oi: parse_f64(&w.open_interest)?,
            value: f64::NAN,
        })
    }

    pub fn clock(&self) -> &ClockSkew {
        &self.rest.clock
    }

    fn config(&self, spec: &SymbolSpec) -> StreamConfig {
        let s = spec.symbol.to_lowercase();
        let mut streams = format!("{s}@aggTrade/{s}@depth@100ms");
        if self.market.is_futures() {
            streams.push_str(&format!("/{s}@markPrice@1s/{s}@forceOrder"));
        }
        let mut cfg = StreamConfig::new(
            self.market.venue(),
            &spec.symbol,
            format!("{}/stream?streams={streams}", self.ws),
            Arc::clone(&self.rest.clock),
        );
        cfg.ping = Ping::None; // Binance pings us; the driver answers with pongs.
        cfg.idle_timeout = Duration::from_secs(30);
        let me = self.clone();
        cfg.time_probe = Some(self.rest.time_probe(self.path("/time"), |t| {
            serde_json::from_str::<wire::ServerTime>(t)
                .ok()
                .map(|s| s.server_time)
        }));
        let sp = spec.clone();
        cfg.snapshot = Some(Arc::new(move || {
            let (me, sp) = (me.clone(), sp.clone());
            Box::pin(async move {
                let (seq, bids, asks) = me.depth_snapshot(&sp, DEPTH_LIMIT).await?;
                Ok(RestBook { seq, bids, asks })
            })
        }));
        if self.market.is_futures() {
            let (me, sp) = (self.clone(), spec.clone());
            cfg.poll = Some((
                Duration::from_secs(10),
                Arc::new(move || {
                    let (me, sp) = (me.clone(), sp.clone());
                    Box::pin(async move { Ok(vec![me.open_interest(&sp).await?]) })
                }),
            ));
        }
        cfg
    }
}

pub fn spec_from_info(
    symbol: &str,
    info: wire::ExchangeInfo,
) -> Result<SymbolSpec, ConnectorError> {
    let s = info
        .symbols
        .into_iter()
        .find(|s| s.symbol.eq_ignore_ascii_case(symbol))
        .ok_or_else(|| ConnectorError::UnknownSymbol(symbol.into()))?;
    let mut tick = None;
    let mut step = "1".to_string();
    for f in &s.filters {
        match f.get("filterType").and_then(|v| v.as_str()) {
            Some("PRICE_FILTER") => {
                tick = f
                    .get("tickSize")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            }
            Some("LOT_SIZE") => {
                if let Some(v) = f.get("stepSize").and_then(|v| v.as_str()) {
                    step = v.to_string();
                }
            }
            _ => {}
        }
    }
    let tick = TickSize::parse(
        &tick.ok_or_else(|| ConnectorError::Other("missing PRICE_FILTER".into()))?,
    )?;
    Ok(SymbolSpec::new(s.symbol, tick, decimals_of(&step)))
}

// ------------------------------------------------------------------ protocol

pub struct BinanceProtocol {
    spec: SymbolSpec,
    sync: BookSync,
    spot: bool,
}

impl BinanceProtocol {
    pub fn new(spec: SymbolSpec, market: Market) -> Self {
        let spot = market == Market::Spot;
        Self {
            spec,
            sync: if spot {
                BookSync::spot()
            } else {
                BookSync::default()
            },
            spot,
        }
    }

    fn outcome(&mut self, o: SyncOutcome) -> Vec<Action> {
        match o {
            SyncOutcome::Applied(d) => vec![Action::Deltas(d)],
            SyncOutcome::Synced(s) => vec![Action::Synced(s)],
            SyncOutcome::Gap => vec![Action::Resync {
                send: Vec::new(),
                rest: true,
            }],
            SyncOutcome::Buffered => Vec::new(),
        }
    }
}

impl Protocol for BinanceProtocol {
    fn on_open(&mut self) -> Vec<String> {
        self.sync = if self.spot {
            BookSync::spot()
        } else {
            BookSync::default()
        };
        Vec::new() // streams are in the URL
    }

    fn on_text(&mut self, text: &str, local_ns: i64) -> Result<Vec<Action>, ConnectorError> {
        let env: wire::Envelope<'_> = serde_json::from_str(text)?;
        let tick = self.spec.tick;
        if env.stream.ends_with("@aggTrade") {
            let t: wire::AggTrade<'_> = serde_json::from_str(env.data.get())?;
            return Ok(vec![Action::Trades(vec![parse_agg_trade(
                &tick, &t, local_ns,
            )?])]);
        }
        if env.stream.contains("@depth") {
            let w: wire::DepthUpdateWire = serde_json::from_str(env.data.get())?;
            let o = self.sync.on_update(parse_depth(&tick, w)?);
            return Ok(self.outcome(o));
        }
        if env.stream.contains("@markPrice") {
            let m: wire::MarkPrice<'_> = serde_json::from_str(env.data.get())?;
            if m.rate.is_empty() {
                return Ok(Vec::new());
            }
            return Ok(vec![Action::Stats(vec![MarketStat::Funding {
                ts_ns: m.event_ms * 1_000_000,
                rate: parse_f64(m.rate)?,
                next_ts_ns: m.next_ms * 1_000_000,
                mark_price: parse_f64(m.mark).unwrap_or(f64::NAN),
            }])]);
        }
        if env.stream.ends_with("@forceOrder") {
            let f: wire::ForceOrder<'_> = serde_json::from_str(env.data.get())?;
            let o = f.order;
            let px = if o.avg_price.is_empty() || parse_f64(o.avg_price).unwrap_or(0.0) == 0.0 {
                o.price
            } else {
                o.avg_price
            };
            let qty = if o.filled.is_empty() || parse_f64(o.filled).unwrap_or(0.0) == 0.0 {
                o.qty
            } else {
                o.filled
            };
            return Ok(vec![Action::Stats(vec![MarketStat::Liquidation {
                ts_ns: o.trade_ms * 1_000_000,
                side: if o.side == "BUY" {
                    Side::Buy
                } else {
                    Side::Sell
                },
                px: tick.parse_ticks(px)?,
                qty: parse_f64(qty)?,
            }])]);
        }
        Ok(Vec::new())
    }

    fn on_rest_snapshot(&mut self, b: RestBook, local_ns: i64) -> Vec<Action> {
        let o = self.sync.on_snapshot(b.seq, b.bids, b.asks, local_ns);
        self.outcome(o)
    }

    fn synced(&self) -> bool {
        self.sync.is_synced()
    }

    fn book_snapshot(&self, ts_ns: i64) -> BookSnapshot {
        self.sync.book.snapshot(ts_ns)
    }
}

/// Runs the live stream until `stop` flips to true, reconnecting with backoff.
pub async fn run_stream(
    client: Binance,
    spec: SymbolSpec,
    tx: mpsc::Sender<MarketEvent>,
    stop: watch::Receiver<bool>,
) {
    let cfg = client.config(&spec);
    driver::run(cfg, BinanceProtocol::new(spec, client.market), tx, stop).await
}

impl MarketApi for Binance {
    fn venue(&self) -> &'static str {
        self.market.venue()
    }
    fn spec<'a>(&'a self, symbol: &'a str) -> BoxFuture<'a, Result<SymbolSpec, ConnectorError>> {
        Box::pin(self.symbol_spec(symbol))
    }
    fn book<'a>(
        &'a self,
        spec: &'a SymbolSpec,
    ) -> BoxFuture<'a, Result<BookLevels, ConnectorError>> {
        Box::pin(async move {
            let (_, b, a) = self.depth_snapshot(spec, DEPTH_LIMIT).await?;
            Ok((b, a))
        })
    }
    fn trades<'a>(
        &'a self,
        spec: &'a SymbolSpec,
        from_ms: i64,
        to_ms: i64,
    ) -> BoxFuture<'a, Result<Vec<Trade>, ConnectorError>> {
        Box::pin(self.agg_trades_range(spec, from_ms, to_ms, 60))
    }
    fn history_from_start(&self) -> bool {
        true
    }
    fn stream(
        &self,
        spec: SymbolSpec,
        tx: mpsc::Sender<MarketEvent>,
        stop: watch::Receiver<bool>,
    ) -> BoxFuture<'static, ()> {
        Box::pin(run_stream(self.clone(), spec, tx, stop))
    }
    fn clock(&self) -> &ClockSkew {
        &self.rest.clock
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> SymbolSpec {
        SymbolSpec::new("BTCUSDT", TickSize::parse("0.10").unwrap(), 3)
    }

    #[test]
    fn parses_stream_messages() {
        let tick = TickSize::parse("0.10").unwrap();
        let text = r#"{"stream":"btcusdt@aggTrade","data":{"e":"aggTrade","E":1700000000123,"s":"BTCUSDT","a":42,"p":"68123.40","q":"0.015","f":1,"l":2,"T":1700000000120,"m":true}}"#;
        let env: wire::Envelope<'_> = serde_json::from_str(text).unwrap();
        let t: wire::AggTrade<'_> = serde_json::from_str(env.data.get()).unwrap();
        let tr = parse_agg_trade(&tick, &t, 5).unwrap();
        assert_eq!(tr.px, 681_234);
        assert_eq!(tr.qty, 0.015);
        assert_eq!(tr.aggressor, Aggressor::Sell);
        assert_eq!(tr.exchange_ts_ns, 1_700_000_000_120_000_000);

        let d = r#"{"stream":"btcusdt@depth@100ms","data":{"e":"depthUpdate","E":1,"T":1,"s":"BTCUSDT","U":10,"u":12,"pu":9,"b":[["68123.30","1.5"],["68123.20","0"]],"a":[["68123.40","2.25"]]}}"#;
        let env: wire::Envelope<'_> = serde_json::from_str(d).unwrap();
        let w: wire::DepthUpdateWire = serde_json::from_str(env.data.get()).unwrap();
        let u = parse_depth(&tick, w).unwrap();
        assert_eq!(u.bids, vec![(681_233, 1.5), (681_232, 0.0)]);
        assert_eq!(u.asks, vec![(681_234, 2.25)]);
        assert_eq!((u.first_id, u.final_id, u.prev_final_id), (10, 12, 9));
        // Spot has no `pu`: prev = U - 1.
        let s = r#"{"e":"depthUpdate","E":1,"s":"BTCUSDT","U":157,"u":160,"b":[],"a":[]}"#;
        let u = parse_depth(&tick, serde_json::from_str(s).unwrap()).unwrap();
        assert_eq!(u.prev_final_id, 156);
    }

    const D1: &str = r#"{"stream":"btcusdt@depth@100ms","data":{"e":"depthUpdate","E":1,"T":1,"s":"BTCUSDT","U":10,"u":12,"pu":9,"b":[["100.0","1"]],"a":[]}}"#;
    const D2: &str = r#"{"stream":"btcusdt@depth@100ms","data":{"e":"depthUpdate","E":2,"T":2,"s":"BTCUSDT","U":13,"u":15,"pu":12,"b":[["100.0","2"]],"a":[]}}"#;
    const D_GAP: &str = r#"{"stream":"btcusdt@depth@100ms","data":{"e":"depthUpdate","E":3,"T":3,"s":"BTCUSDT","U":20,"u":22,"pu":19,"b":[],"a":[]}}"#;

    #[test]
    fn protocol_buffers_syncs_and_resyncs() {
        let mut p = BinanceProtocol::new(spec(), Market::UsdM);
        assert!(p.on_open().is_empty());
        assert!(p.on_text(D1, 0).unwrap().is_empty()); // buffered
        let a = p.on_rest_snapshot(
            RestBook {
                seq: 11,
                bids: vec![(990, 1.0)],
                asks: vec![(1010, 1.0)],
            },
            0,
        );
        let Action::Synced(s) = &a[0] else {
            panic!("{a:?}")
        };
        assert_eq!(s.bids, vec![(1000, 1.0), (990, 1.0)]);
        assert!(matches!(&p.on_text(D2, 0).unwrap()[0], Action::Deltas(d) if d.len() == 1));
        assert_eq!(
            p.on_text(D_GAP, 0).unwrap(),
            vec![Action::Resync {
                send: vec![],
                rest: true
            }]
        );
        assert!(!p.synced());
    }

    #[test]
    fn funding_liquidations_oi_and_rest() {
        let mut p = BinanceProtocol::new(spec(), Market::UsdM);
        let m = r#"{"stream":"btcusdt@markPrice@1s","data":{"e":"markPriceUpdate","E":1562305380000,"s":"BTCUSDT","p":"11794.15000000","i":"11784.62659091","P":"11784.25641265","r":"0.00038167","T":1562306400000}}"#;
        let Action::Stats(s) = &p.on_text(m, 0).unwrap()[0] else {
            panic!()
        };
        assert_eq!(
            s[0],
            MarketStat::Funding {
                ts_ns: 1_562_305_380_000_000_000,
                rate: 0.00038167,
                next_ts_ns: 1_562_306_400_000_000_000,
                mark_price: 11794.15
            }
        );
        let f = r#"{"stream":"btcusdt@forceOrder","data":{"e":"forceOrder","E":1568014460893,"o":{"s":"BTCUSDT","S":"SELL","o":"LIMIT","f":"IOC","q":"0.014","p":"9910","ap":"9910","X":"FILLED","l":"0.014","z":"0.014","T":1568014460893}}}"#;
        let Action::Stats(s) = &p.on_text(f, 0).unwrap()[0] else {
            panic!()
        };
        assert_eq!(
            s[0],
            MarketStat::Liquidation {
                ts_ns: 1_568_014_460_893_000_000,
                side: Side::Sell,
                px: 99_100,
                qty: 0.014
            }
        );
        let oi: wire::OpenInterest = serde_json::from_str(
            r#"{"openInterest":"10659.509","symbol":"BTCUSDT","time":1589437530011}"#,
        )
        .unwrap();
        assert_eq!(oi.open_interest, "10659.509");
        let info: wire::ExchangeInfo = serde_json::from_str(r#"{"symbols":[{"symbol":"BTCUSD_PERP","contractSize":100,"filters":[{"filterType":"PRICE_FILTER","tickSize":"0.1"},{"filterType":"LOT_SIZE","stepSize":"1"}]}]}"#).unwrap();
        let sp = spec_from_info("btcusd_perp", info).unwrap();
        assert_eq!((sp.tick.as_f64(), sp.qty_precision), (0.1, 0));
        assert_eq!(Market::CoinM.venue(), "binance-coinm");
        assert_eq!(Market::Spot.api(), "/api/v3");
    }
}
