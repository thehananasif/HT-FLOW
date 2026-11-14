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
pub mod instruments;
pub mod wire;

use std::sync::Arc;
use std::time::Duration;

use book_sync::{BookSync, DepthUpdate, SyncOutcome};
use futures_util::future::BoxFuture;
use htflow_connector_common::{
    driver, Action, BookLevels, ClockSkew, Kline, MarketApi, Ping, Protocol, Rest, RestBook,
    StreamConfig, TokenBucket, TradesBack,
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

/// Kline intervals the history backfill uses (ms, ascending).
pub const KLINE_INTERVALS: &[i64] = &[
    60_000, 180_000, 300_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 21_600_000,
    43_200_000, 86_400_000,
];

/// Binance interval name (`1m`, `4h`, `1d`, …) of an interval in ms.
pub fn kline_interval_name(ms: i64) -> Option<&'static str> {
    Some(match ms {
        60_000 => "1m",
        180_000 => "3m",
        300_000 => "5m",
        900_000 => "15m",
        1_800_000 => "30m",
        3_600_000 => "1h",
        7_200_000 => "2h",
        14_400_000 => "4h",
        21_600_000 => "6h",
        43_200_000 => "12h",
        86_400_000 => "1d",
        _ => return None,
    })
}

/// One REST kline row: `[openTime, o, h, l, c, volume, closeTime, quoteVol, count,
/// takerBuyVolume, takerBuyQuote, …]`.
pub fn kline_of(tick: &TickSize, r: &[serde_json::Value]) -> Result<Kline, ConnectorError> {
    let s = |i: usize| -> Result<&str, ConnectorError> {
        r.get(i)
            .and_then(|v| v.as_str())
            .ok_or_else(|| ConnectorError::Other(format!("kline field {i}")))
    };
    let open_ms = r
        .first()
        .and_then(|v| v.as_i64())
        .ok_or_else(|| ConnectorError::Other("kline open time".into()))?;
    Ok(Kline {
        open_ms,
        span_ms: 60_000,
        open: tick.parse_ticks(s(1)?)?,
        high: tick.parse_ticks(s(2)?)?,
        low: tick.parse_ticks(s(3)?)?,
        close: tick.parse_ticks(s(4)?)?,
        volume: parse_f64(s(5)?)?,
        taker_buy: s(9).ok().and_then(|v| parse_f64(v).ok()),
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

    /// Newest-first download of `[from_ms, to_ms)` (P06 "Load days"): finds the first aggregate
    /// trade id at `to_ms`, then pages backwards by id (`fromId = id - 1000`), so the newest
    /// history arrives first and a page budget cuts the oldest part, never the seam with the
    /// data already loaded. Falls back to forward windows when no anchor id can be found.
    pub async fn agg_trades_back(
        &self,
        spec: &SymbolSpec,
        from_ms: i64,
        to_ms: i64,
        max_pages: u32,
    ) -> Result<TradesBack, ConnectorError> {
        const HOUR: i64 = 3_600_000;
        let mut out = TradesBack {
            covered_from_ms: to_ms,
            ..TradesBack::default()
        };
        if from_ms >= to_ms || max_pages == 0 {
            return Ok(out);
        }
        // (1) Anchor: the first trade at / after `to_ms` (exclusive end id).
        let sym = &spec.symbol;
        let q = format!(
            "/aggTrades?symbol={sym}&startTime={to_ms}&endTime={}&limit=1",
            to_ms + HOUR - 1
        );
        let rows: Vec<wire::AggTradeRest> = self.rest.get(&self.path(&q)).await?;
        out.pages += 1;
        let mut end_id = match rows.first() {
            Some(r) => r.id,
            None => {
                // Nothing after `to_ms` within an hour: near "now" the latest trade is the anchor.
                let latest: Vec<wire::AggTradeRest> = self
                    .rest
                    .get(&self.path(&format!("/aggTrades?symbol={sym}&limit=1")))
                    .await?;
                out.pages += 1;
                match latest.first() {
                    Some(l) if l.trade_ms < to_ms || to_ms + HOUR >= now_ns() / 1_000_000 => {
                        l.id + 1
                    }
                    _ => {
                        // A quiet hour deep in the past: forward windows over the span.
                        let pages = max_pages.saturating_sub(out.pages).max(1);
                        let mut t = self
                            .agg_trades_range(spec, from_ms, to_ms - 1, pages)
                            .await?;
                        t.retain(|x| x.exchange_ts_ns < to_ms * 1_000_000);
                        out.pages += pages;
                        out.covered_from_ms = from_ms;
                        out.trades = t;
                        return Ok(out);
                    }
                }
            }
        };
        // (2) Page backwards by id.
        let (lo, hi) = (from_ms * 1_000_000, to_ms * 1_000_000);
        let mut pages: Vec<Vec<Trade>> = Vec::new();
        loop {
            if end_id == 0 {
                out.covered_from_ms = from_ms; // start of the symbol's history
                break;
            }
            if out.pages >= max_pages {
                break;
            }
            let start = end_id.saturating_sub(1000);
            let q = format!(
                "/aggTrades?symbol={sym}&fromId={start}&limit={}",
                end_id - start
            );
            let rows: Vec<wire::AggTradeRest> = self.rest.get(&self.path(&q)).await?;
            out.pages += 1;
            let Some(first) = rows.first() else {
                out.covered_from_ms = from_ms;
                break;
            };
            let oldest_ms = first.trade_ms;
            let mut page = Vec::with_capacity(rows.len());
            for r in rows.iter().filter(|r| r.id < end_id) {
                let t = rest_trade(&spec.tick, r)?;
                if t.exchange_ts_ns >= lo && t.exchange_ts_ns < hi {
                    page.push(t);
                }
            }
            pages.push(page);
            if oldest_ms < from_ms {
                out.covered_from_ms = from_ms;
                break;
            }
            // Trades sharing the oldest millisecond may continue on the next page.
            out.covered_from_ms = (oldest_ms + 1).min(to_ms);
            end_id = start;
        }
        let floor = out.covered_from_ms * 1_000_000;
        out.trades = pages
            .into_iter()
            .rev()
            .flatten()
            .filter(|t| t.exchange_ts_ns >= floor)
            .collect();
        out.trades.sort_by_key(|t| (t.exchange_ts_ns, t.trade_id));
        out.trades.dedup_by_key(|t| t.trade_id);
        Ok(out)
    }

    /// Klines of `interval_ms` (see [`KLINE_INTERVALS`]) opening in `[from_ms, to_ms)`, oldest
    /// first, with the taker-buy volume (same endpoint shape on `fapi`, `dapi` and spot `api`;
    /// COIN-M volumes are contracts). 1,000 bars per request.
    pub async fn klines_range(
        &self,
        spec: &SymbolSpec,
        interval_ms: i64,
        from_ms: i64,
        to_ms: i64,
        max_pages: u32,
    ) -> Result<Vec<Kline>, ConnectorError> {
        let iv = interval_ms.max(60_000);
        let name = kline_interval_name(iv).ok_or_else(|| {
            ConnectorError::Other(format!("unsupported kline interval {interval_ms} ms"))
        })?;
        let first = from_ms.div_euclid(iv) * iv;
        let mut out: Vec<Kline> = Vec::new();
        let mut start = first;
        for _ in 0..max_pages {
            if start >= to_ms {
                break;
            }
            let q = format!(
                "/klines?symbol={}&interval={name}&startTime={start}&endTime={}&limit=1000",
                spec.symbol,
                to_ms - 1
            );
            let rows: Vec<Vec<serde_json::Value>> = self.rest.get(&self.path(&q)).await?;
            let n = rows.len();
            for r in &rows {
                let mut k = kline_of(&spec.tick, r)?;
                k.span_ms = iv;
                if k.open_ms >= first && k.open_ms < to_ms {
                    out.push(k);
                }
            }
            match rows.last().and_then(|r| r.first()).and_then(|v| v.as_i64()) {
                Some(last) if n >= 1000 => start = last + iv,
                _ => break,
            }
        }
        out.dedup_by_key(|k| k.open_ms);
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
    fn trades_back<'a>(
        &'a self,
        spec: &'a SymbolSpec,
        from_ms: i64,
        to_ms: i64,
        max_pages: u32,
    ) -> BoxFuture<'a, Result<TradesBack, ConnectorError>> {
        Box::pin(self.agg_trades_back(spec, from_ms, to_ms, max_pages))
    }
    fn kline_intervals(&self) -> &'static [i64] {
        KLINE_INTERVALS
    }
    fn klines<'a>(
        &'a self,
        spec: &'a SymbolSpec,
        interval_ms: i64,
        from_ms: i64,
        to_ms: i64,
    ) -> BoxFuture<'a, Result<Vec<Kline>, ConnectorError>> {
        // At most 60,000 bars per call (the history path asks for a few thousand).
        Box::pin(self.klines_range(spec, interval_ms, from_ms, to_ms, 60))
    }
    fn throttled(&self) -> u64 {
        self.rest.throttled_count()
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

    const BASE: i64 = 1_700_000_000_000;

    /// Mock venue: aggregate trade `id` happens at `BASE + id * 10` ms (ids 0..5000), and one
    /// kline per minute.
    fn mock_binance(prefix: &'static str) -> htflow_connector_common::mock_http::MockServer {
        use htflow_connector_common::mock_http::{query_param, MockServer, Reply};
        const N: i64 = 5000;
        let row = |id: i64| {
            format!(
                r#"{{"a":{id},"p":"{}.0","q":"0.5","f":1,"l":1,"T":{},"m":{}}}"#,
                100 + id % 7,
                BASE + id * 10,
                id % 2 == 0
            )
        };
        MockServer::start(move |t| {
            let p = |k| query_param(t, k).and_then(|v| v.parse::<i64>().ok());
            if t.starts_with(&format!("{prefix}/aggTrades")) {
                let limit = p("limit").unwrap_or(500);
                let ids: Vec<i64> = if let Some(from) = p("fromId") {
                    (from..(from + limit).min(N)).collect()
                } else if let (Some(s), Some(e)) = (p("startTime"), p("endTime")) {
                    (0..N)
                        .filter(|i| BASE + i * 10 >= s && BASE + i * 10 <= e)
                        .take(limit as usize)
                        .collect()
                } else {
                    vec![N - 1]
                };
                let rows: Vec<String> = ids.into_iter().map(row).collect();
                return Reply::ok(format!("[{}]", rows.join(",")));
            }
            if t.starts_with(&format!("{prefix}/klines")) {
                let (s, e) = (p("startTime").unwrap_or(0), p("endTime").unwrap_or(0));
                let rows: Vec<String> = (0..1000)
                    .map(|i| {
                        s + i * if t.contains("interval=1h") {
                            3_600_000
                        } else {
                            60_000
                        }
                    })
                    .filter(|o| *o <= e)
                    .map(|o| {
                        format!(
                            r#"[{o},"100.0","102.0","99.0","101.0","10",{},"0",5,"6","0","0"]"#,
                            o + 59_999
                        )
                    })
                    .collect();
                return Reply::ok(format!("[{}]", rows.join(",")));
            }
            Reply::status("404 Not Found", "{}")
        })
    }

    #[tokio::test]
    async fn pages_trades_newest_first_and_klines() {
        let srv = mock_binance("/fapi/v1");
        let b = Binance::with_endpoints(Market::UsdM, &srv.base, "ws://unused");
        let sp = SymbolSpec::new("BTCUSDT", TickSize::parse("0.1").unwrap(), 3);
        let (from, to) = (BASE + 10_000, BASE + 40_000);
        // Complete: ids 1000..4000.
        let r = b.agg_trades_back(&sp, from, to, 100).await.unwrap();
        assert_eq!(r.covered_from_ms, from);
        assert_eq!(r.trades.len(), 3000);
        assert_eq!(r.trades.first().unwrap().trade_id, 1000);
        assert_eq!(r.trades.last().unwrap().trade_id, 3999);
        assert!(r
            .trades
            .windows(2)
            .all(|w| w[0].exchange_ts_ns < w[1].exchange_ts_ns));
        assert_eq!(r.pages, 1 + 4);
        // The first page after the anchor is the newest one.
        let reqs = srv.requests();
        assert!(reqs[0].contains(&format!("startTime={to}")), "{reqs:?}");
        assert!(reqs[1].contains("fromId=3000&limit=1000"), "{reqs:?}");

        // A budget of 2 requests: only the newest page; coverage says where it stopped.
        let r = b.agg_trades_back(&sp, from, to, 2).await.unwrap();
        assert_eq!(r.covered_from_ms, BASE + 30_001);
        assert_eq!(r.trades.len(), 999);
        assert_eq!(r.trades[0].trade_id, 3001);

        // Up to "now": the latest trade is the anchor.
        let r = b
            .agg_trades_back(&sp, BASE + 49_000, now_ns() / 1_000_000, 10)
            .await
            .unwrap();
        assert_eq!(r.trades.len(), 100);
        assert_eq!(r.trades.last().unwrap().trade_id, 4999);

        let k = b
            .klines_range(&sp, 60_000, 0, 2500 * 60_000, 10)
            .await
            .unwrap();
        assert_eq!(k.len(), 2500);
        assert_eq!(k[1].open_ms, 60_000);
        assert_eq!(
            (k[0].open, k[0].high, k[0].low, k[0].close),
            (1000, 1020, 990, 1010)
        );
        assert_eq!((k[0].volume, k[0].taker_buy), (10.0, Some(6.0)));
        assert!(!b.kline_intervals().is_empty() && b.windowed_trades());
        let h = b
            .klines_range(&sp, 3_600_000, 0, 10 * 3_600_000, 10)
            .await
            .unwrap();
        assert_eq!(
            (h.len(), h[1].open_ms - h[0].open_ms, h[0].span_ms),
            (10, 3_600_000, 3_600_000)
        );
        assert!(srv.requests().last().unwrap().contains("interval=1h"));
        assert!(b.klines_range(&sp, 61_000, 0, 1, 1).await.is_err());

        // Spot / COIN-M use the same shapes under their own prefixes.
        let srv = mock_binance("/dapi/v1");
        let c = Binance::with_endpoints(Market::CoinM, &srv.base, "ws://unused");
        let r = c.agg_trades_back(&sp, from, to, 100).await.unwrap();
        assert_eq!(r.trades.len(), 3000);
    }
}
