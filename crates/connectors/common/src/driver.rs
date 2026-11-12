//! Generic WebSocket session driver (Live Pipeline stage 1).
//!
//! One task per connection: measure the server clock → connect → send the protocol's subscribe
//! messages → heartbeat → parse every text frame through the venue's [`Protocol`] → forward
//! normalised events. On any error the session is torn down and re-established with exponential
//! backoff (0.5 s → 30 s plus up to 250 ms jitter); the backoff resets once the book is synced.
//! A slow consumer never blocks the socket: when the output channel is full, deltas are dropped
//! and one full book snapshot is sent as soon as there is room again.
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::{SinkExt, StreamExt};
use htflow_core_types::{
    BookDelta, BookSnapshot, FeedState, FeedStatus, MarketEvent, MarketStat, Trade,
};
use rand::Rng;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::Message;

use crate::clock::ClockSkew;
use crate::{ConnectorError, Result};

/// What a protocol wants done after a message.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Trades(Vec<Trade>),
    /// The book was (re)built: forward the whole book.
    Synced(BookSnapshot),
    Deltas(Vec<BookDelta>),
    Stats(Vec<MarketStat>),
    /// Send a text frame (heartbeat reply, …).
    Send(String),
    /// Sequence gap / checksum mismatch: the book is stale. `send` re-subscribes (venues that
    /// push a snapshot on subscribe); `rest` asks the driver for a REST snapshot.
    Resync {
        send: Vec<String>,
        rest: bool,
    },
    /// Unrecoverable for this session (e.g. subscription rejected): reconnect with backoff.
    Fail(String),
}

/// A REST order book used to (re)sync stream deltas (Binance-style venues).
#[derive(Debug, Clone, PartialEq)]
pub struct RestBook {
    pub seq: u64,
    pub bids: Vec<(i64, f64)>,
    pub asks: Vec<(i64, f64)>,
}

pub type Probe<T> = Arc<dyn Fn() -> BoxFuture<'static, Result<T>> + Send + Sync>;

#[derive(Clone)]
pub enum Ping {
    None,
    /// Application-level text ping (`"ping"`, `{"op":"ping"}`, …).
    Text(String),
    /// WebSocket ping frame.
    Frame,
}

pub trait Protocol: Send + 'static {
    /// Called on every (re)connect: reset state, return the subscribe messages.
    fn on_open(&mut self) -> Vec<String>;
    /// `local_ns` is the receive time already corrected into the exchange clock.
    fn on_text(&mut self, text: &str, local_ns: i64) -> Result<Vec<Action>>;
    fn on_rest_snapshot(&mut self, _book: RestBook, _local_ns: i64) -> Vec<Action> {
        Vec::new()
    }
    /// The local book is in sequence (status `live`).
    fn synced(&self) -> bool;
    fn book_snapshot(&self, ts_ns: i64) -> BookSnapshot;
}

pub struct StreamConfig {
    /// Venue name for logs.
    pub name: &'static str,
    pub symbol: String,
    pub url: String,
    pub ping: Ping,
    pub ping_every: Duration,
    /// No frame for this long → reconnect.
    pub idle_timeout: Duration,
    pub clock: Arc<ClockSkew>,
    /// Measures the server clock before each connect (errors are logged, not fatal).
    pub time_probe: Option<Probe<i64>>,
    /// REST book for protocols that resync from REST (fetched at connect and on `Resync{rest}`).
    pub snapshot: Option<Probe<RestBook>>,
    /// Periodic REST poll for stats the venue does not stream (open interest, …).
    pub poll: Option<(Duration, Probe<Vec<MarketStat>>)>,
}

impl StreamConfig {
    pub fn new(name: &'static str, symbol: &str, url: String, clock: Arc<ClockSkew>) -> Self {
        Self {
            name,
            symbol: symbol.to_string(),
            url,
            ping: Ping::Frame,
            ping_every: Duration::from_secs(20),
            idle_timeout: Duration::from_secs(45),
            clock,
            time_probe: None,
            snapshot: None,
            poll: None,
        }
    }
}

fn status(state: FeedState, latency_ms: f64, msgs: f64, message: Option<String>) -> MarketEvent {
    MarketEvent::Status(FeedStatus {
        state,
        latency_ms,
        msgs_per_sec: msgs,
        message,
    })
}

fn offer(tx: &mpsc::Sender<MarketEvent>, ev: MarketEvent) -> bool {
    tx.try_send(ev).is_ok()
}

/// Runs the live stream until `stop` flips to true (or the receiver is dropped).
pub async fn run<P: Protocol>(
    cfg: StreamConfig,
    mut proto: P,
    tx: mpsc::Sender<MarketEvent>,
    mut stop: watch::Receiver<bool>,
) {
    if let Some((every, poll)) = cfg.poll.clone() {
        let (tx, mut stop) = (tx.clone(), stop.clone());
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(every);
            loop {
                tokio::select! {
                    _ = iv.tick() => {}
                    _ = stop.changed() => return,
                }
                if *stop.borrow() || tx.is_closed() {
                    return;
                }
                match poll().await {
                    Ok(s) if !s.is_empty() => {
                        offer(&tx, MarketEvent::Stats(s));
                    }
                    Ok(_) => {}
                    Err(e) => tracing::debug!(error = %e, "stats poll failed"),
                }
            }
        });
    }
    let mut backoff = Duration::from_millis(500);
    loop {
        if *stop.borrow() || tx.is_closed() {
            return;
        }
        let _ = tx.send(status(FeedState::Connecting, 0.0, 0.0, None)).await;
        if let Some(p) = &cfg.time_probe {
            match tokio::time::timeout(Duration::from_secs(5), p()).await {
                Ok(Ok(_)) => {
                    tracing::debug!(venue = cfg.name, offset_ms = cfg.clock.offset_ms(), "clock")
                }
                Ok(Err(e)) => tracing::debug!(venue = cfg.name, error = %e, "time probe failed"),
                Err(_) => tracing::debug!(venue = cfg.name, "time probe timed out"),
            }
        }
        match session(&cfg, &mut proto, &tx, &mut stop, &mut backoff).await {
            Ok(()) => return,
            Err(e) => {
                tracing::warn!(venue = cfg.name, symbol = %cfg.symbol, error = %e, "stream dropped; reconnecting");
                let _ = tx
                    .send(status(
                        FeedState::Disconnected,
                        0.0,
                        0.0,
                        Some(e.to_string()),
                    ))
                    .await;
            }
        }
        let jitter = Duration::from_millis(rand::thread_rng().gen_range(0..250));
        tokio::select! {
            _ = tokio::time::sleep(backoff + jitter) => {}
            _ = stop.changed() => return,
        }
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

type SnapTask = tokio::task::JoinHandle<Result<RestBook>>;

fn spawn_snapshot(cfg: &StreamConfig, delay: Duration) -> Option<SnapTask> {
    let p = cfg.snapshot.clone()?;
    Some(tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        p().await
    }))
}

async fn session<P: Protocol>(
    cfg: &StreamConfig,
    proto: &mut P,
    tx: &mpsc::Sender<MarketEvent>,
    stop: &mut watch::Receiver<bool>,
    backoff: &mut Duration,
) -> Result<()> {
    let (mut ws, _) = tokio_tungstenite::connect_async(cfg.url.as_str()).await?;
    for m in proto.on_open() {
        ws.send(Message::Text(m)).await?;
    }
    // Give the stream a moment to buffer deltas before the REST snapshot.
    let mut snap_task = spawn_snapshot(cfg, Duration::from_millis(400));
    let mut lagging = false;
    let mut msgs: u64 = 0;
    let mut latency = 0.0f64;
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut ping = tokio::time::interval(cfg.ping_every);
    ping.tick().await;
    let mut last_msg = tokio::time::Instant::now();
    loop {
        let actions: Vec<Action> = tokio::select! {
            msg = ws.next() => {
                let Some(msg) = msg else { return Err(ConnectorError::Other("connection closed".into())) };
                last_msg = tokio::time::Instant::now();
                match msg? {
                    Message::Text(text) => {
                        msgs += 1;
                        proto.on_text(&text, cfg.clock.now_ns())?
                    }
                    Message::Binary(b) => {
                        msgs += 1;
                        match std::str::from_utf8(&b) {
                            Ok(text) => proto.on_text(text, cfg.clock.now_ns())?,
                            Err(_) => Vec::new(),
                        }
                    }
                    Message::Ping(p) => { ws.send(Message::Pong(p)).await?; Vec::new() }
                    Message::Close(f) => return Err(ConnectorError::Other(format!("server closed the connection {}", f.map(|f| f.reason.to_string()).unwrap_or_default()))),
                    _ => Vec::new(),
                }
            }
            res = async { snap_task.as_mut().expect("guarded").await }, if snap_task.is_some() => {
                snap_task = None;
                let book = res.map_err(|e| ConnectorError::Other(e.to_string()))??;
                proto.on_rest_snapshot(book, cfg.clock.now_ns())
            }
            _ = ping.tick() => {
                match &cfg.ping {
                    Ping::Text(t) => ws.send(Message::Text(t.clone())).await?,
                    Ping::Frame => ws.send(Message::Ping(Vec::new())).await?,
                    Ping::None => {}
                }
                Vec::new()
            }
            _ = tick.tick() => {
                if last_msg.elapsed() > cfg.idle_timeout {
                    return Err(ConnectorError::Other(format!("no data for {} s", cfg.idle_timeout.as_secs())));
                }
                let state = if proto.synced() { FeedState::Live } else { FeedState::Connecting };
                offer(tx, status(state, latency.max(0.0), msgs as f64, None));
                msgs = 0;
                Vec::new()
            }
            _ = stop.changed() => {
                let _ = ws.close(None).await;
                return Ok(());
            }
        };
        for a in actions {
            match a {
                Action::Trades(t) => {
                    if t.is_empty() {
                        continue;
                    }
                    if let Some(last) = t.last() {
                        let lat = (last.local_ts_ns - last.exchange_ts_ns) as f64 / 1e6;
                        latency = if latency == 0.0 {
                            lat
                        } else {
                            latency * 0.9 + lat * 0.1
                        };
                    }
                    if !offer(tx, MarketEvent::Trades(t)) {
                        lagging = true;
                    }
                }
                Action::Synced(s) => {
                    *backoff = Duration::from_millis(500);
                    lagging = false;
                    let _ = tx.send(MarketEvent::Snapshot(s)).await;
                }
                Action::Deltas(d) => {
                    if lagging {
                        let s = proto.book_snapshot(cfg.clock.now_ns());
                        if offer(tx, MarketEvent::Snapshot(s)) {
                            lagging = false;
                        }
                    } else if !offer(tx, MarketEvent::Deltas(d)) {
                        lagging = true;
                        tracing::warn!(
                            venue = cfg.name,
                            "consumer lagging; falling back to snapshots"
                        );
                    }
                }
                Action::Stats(s) => {
                    if !s.is_empty() {
                        offer(tx, MarketEvent::Stats(s));
                    }
                }
                Action::Send(m) => ws.send(Message::Text(m)).await?,
                Action::Resync { send, rest } => {
                    tracing::info!(venue = cfg.name, symbol = %cfg.symbol, "book out of sequence; resyncing");
                    for m in send {
                        ws.send(Message::Text(m)).await?;
                    }
                    if rest && snap_task.is_none() {
                        snap_task = spawn_snapshot(cfg, Duration::from_millis(100));
                    }
                }
                Action::Fail(m) => return Err(ConnectorError::Api(m)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::book::L2Book;
    use htflow_core_types::{Aggressor, Side};
    use tokio::net::TcpListener;

    /// Toy protocol: `S` = snapshot, `D` = delta, `T` = trade, `G` = gap, `X` = fail.
    struct Toy {
        book: L2Book,
        synced: bool,
        opens: usize,
    }

    impl Protocol for Toy {
        fn on_open(&mut self) -> Vec<String> {
            self.opens += 1;
            self.synced = false;
            vec!["sub".into()]
        }
        fn on_text(&mut self, text: &str, local_ns: i64) -> Result<Vec<Action>> {
            Ok(match text {
                "S" => {
                    self.book.clear();
                    self.book.apply(&[(100, 1.0)], &[(101, 1.0)]);
                    self.synced = true;
                    vec![Action::Synced(self.book.snapshot(local_ns))]
                }
                "D" => vec![Action::Deltas(vec![self.book.set(
                    Side::Buy,
                    99,
                    2.0,
                    None,
                )])],
                "T" => vec![Action::Trades(vec![Trade {
                    exchange_ts_ns: local_ns,
                    local_ts_ns: local_ns,
                    px: 100,
                    qty: 1.0,
                    aggressor: Aggressor::Buy,
                    trade_id: 1,
                }])],
                "G" => {
                    self.synced = false;
                    vec![Action::Resync {
                        send: vec!["resub".into()],
                        rest: false,
                    }]
                }
                "X" => vec![Action::Fail("rejected".into())],
                _ => vec![],
            })
        }
        fn synced(&self) -> bool {
            self.synced
        }
        fn book_snapshot(&self, ts: i64) -> BookSnapshot {
            self.book.snapshot(ts)
        }
    }

    #[tokio::test]
    async fn drives_a_session_and_reconnects() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (got_tx, mut got_rx) = mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            for round in 0..2 {
                let (sock, _) = listener.accept().await.unwrap();
                let mut ws = tokio_tungstenite::accept_async(sock).await.unwrap();
                let first = ws.next().await.unwrap().unwrap();
                got_tx.send(first.to_string()).unwrap();
                for m in ["S", "D", "T", "G"] {
                    ws.send(Message::Text(m.into())).await.unwrap();
                }
                let resub = ws.next().await.unwrap().unwrap();
                got_tx.send(resub.to_string()).unwrap();
                if round == 0 {
                    ws.send(Message::Text("X".into())).await.unwrap();
                } else {
                    // Keep the second connection open until the client stops.
                    while ws.next().await.is_some() {}
                }
            }
        });
        let cfg = StreamConfig::new(
            "toy",
            "SYM",
            format!("ws://{addr}"),
            Arc::new(ClockSkew::default()),
        );
        let (tx, mut rx) = mpsc::channel(100);
        let (stop_tx, stop_rx) = watch::channel(false);
        let proto = Toy {
            book: L2Book::default(),
            synced: false,
            opens: 0,
        };
        let h = tokio::spawn(run(cfg, proto, tx, stop_rx));
        let mut snaps = 0;
        let mut deltas = 0;
        let mut trades = 0;
        let mut disconnects = 0;
        while snaps < 2 || trades < 2 {
            match tokio::time::timeout(Duration::from_secs(10), rx.recv())
                .await
                .unwrap()
                .unwrap()
            {
                MarketEvent::Snapshot(s) => {
                    assert_eq!(s.bids, vec![(100, 1.0)]);
                    snaps += 1
                }
                MarketEvent::Deltas(_) => deltas += 1,
                MarketEvent::Trades(_) => trades += 1,
                MarketEvent::Status(s) if s.state == FeedState::Disconnected => {
                    assert!(s.message.unwrap().contains("rejected"));
                    disconnects += 1
                }
                _ => {}
            }
        }
        assert_eq!((deltas, disconnects), (2, 1));
        assert_eq!(got_rx.recv().await.unwrap(), "sub");
        assert_eq!(got_rx.recv().await.unwrap(), "resub");
        stop_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), h)
            .await
            .unwrap()
            .unwrap();
    }
}
