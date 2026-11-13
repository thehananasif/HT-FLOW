//! P05 — native transport for the "Custom WebSocket" connector. The WebView CSP
//! (`connect-src 'self' ipc: http://ipc.localhost`) blocks ws(s) URLs, and the user's host cannot
//! be known at build time, so the core opens the socket and relays raw text frames to the UI over
//! a Tauri `Channel`. The UI keeps the mapping, status and back-off reconnect logic; this module
//! only connects, sends the subscribe message, answers pings, keeps the link alive and closes
//! cleanly. ws:// and wss:// only; frames and messages are capped at [`MAX_MESSAGE`].
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use crate::error::{CmdError, CmdResult};

/// Largest accepted frame / message (1 MiB); larger ones end the connection with an error.
pub const MAX_MESSAGE: usize = 1024 * 1024;
/// Most simultaneously open custom sockets.
const MAX_OPEN: usize = 64;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Keep-alive ping interval; a link silent for [`STALE_AFTER`] is treated as dead.
const PING_EVERY: Duration = Duration::from_secs(20);
const STALE_AFTER: Duration = Duration::from_secs(60);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
/// Frames are batched for up to this long before one IPC message (like `market_subscribe`).
const FLUSH_EVERY: Duration = Duration::from_millis(16);
const MAX_BATCH: usize = 512;

/// Events streamed to the UI. `frames` carries raw text frames in arrival order.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WsEvent {
    Open,
    Frames {
        data: Vec<String>,
    },
    Closed {
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<u16>,
        reason: String,
    },
    Error {
        message: String,
    },
}

#[derive(Debug)]
pub enum WsCmd {
    Send(String),
    Close,
}

#[derive(Default)]
pub struct CustomWsState {
    conns: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<WsCmd>>>>,
    next: AtomicU32,
}

/// Accepts only absolute ws(s) URLs with a host.
pub fn validate_url(raw: &str) -> CmdResult<String> {
    let url = reqwest::Url::parse(raw.trim())
        .map_err(|_| CmdError::new("ws.bad_url", "Not a valid URL"))?;
    match url.scheme() {
        "ws" | "wss" if url.host_str().is_some_and(|h| !h.is_empty()) => Ok(url.to_string()),
        _ => Err(CmdError::new(
            "ws.bad_url",
            "Only ws:// and wss:// URLs are supported",
        )),
    }
}

fn config() -> WebSocketConfig {
    WebSocketConfig {
        max_message_size: Some(MAX_MESSAGE),
        max_frame_size: Some(MAX_MESSAGE),
        ..Default::default()
    }
}

/// Runs one connection until it closes, fails, `Close` arrives or `emit` returns false (the UI
/// went away). Always ends with exactly one `Closed` or `Error` event (unless `emit` failed).
pub async fn run(
    url: String,
    subscribe: Option<String>,
    mut cmds: mpsc::UnboundedReceiver<WsCmd>,
    mut emit: impl FnMut(WsEvent) -> bool,
) {
    let connect = tokio_tungstenite::connect_async_with_config(url.as_str(), Some(config()), true);
    let mut ws = match tokio::time::timeout(CONNECT_TIMEOUT, connect).await {
        Ok(Ok((ws, _))) => ws,
        Ok(Err(e)) => {
            emit(WsEvent::Error {
                message: format!("Cannot connect: {e}"),
            });
            return;
        }
        Err(_) => {
            emit(WsEvent::Error {
                message: "Cannot connect: timed out".into(),
            });
            return;
        }
    };
    if let Some(sub) = subscribe.filter(|s| !s.is_empty()) {
        if let Err(e) = ws.send(Message::Text(sub)).await {
            emit(WsEvent::Error {
                message: format!("Subscribe failed: {e}"),
            });
            return;
        }
    }
    if !emit(WsEvent::Open) {
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, ws.close(None)).await;
        return;
    }

    let mut batch: Vec<String> = Vec::new();
    let mut flush = tokio::time::interval(FLUSH_EVERY);
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await; // the first tick is immediate
    let mut last_rx = tokio::time::Instant::now();
    let end: WsEvent = loop {
        tokio::select! {
            msg = ws.next() => {
                last_rx = tokio::time::Instant::now();
                match msg {
                    // Pings are answered by tungstenite itself on the next read / write.
                    Some(Ok(Message::Text(t))) => batch.push(t),
                    Some(Ok(Message::Binary(b))) => {
                        // Many servers send JSON as binary frames; forward it when it is UTF-8.
                        if let Ok(t) = String::from_utf8(b) { batch.push(t); }
                    }
                    Some(Ok(Message::Close(f))) => {
                        break WsEvent::Closed {
                            code: f.as_ref().map(|f| u16::from(f.code)),
                            reason: f.map(|f| f.reason.into_owned()).unwrap_or_default(),
                        };
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => break WsEvent::Error { message: e.to_string() },
                    None => break WsEvent::Closed { code: None, reason: "Connection closed".into() },
                }
                if batch.len() >= MAX_BATCH && !emit(WsEvent::Frames { data: std::mem::take(&mut batch) }) {
                    let _ = tokio::time::timeout(CLOSE_TIMEOUT, ws.close(None)).await;
                    return;
                }
            }
            cmd = cmds.recv() => match cmd {
                Some(WsCmd::Send(t)) => {
                    if let Err(e) = ws.send(Message::Text(t)).await {
                        break WsEvent::Error { message: e.to_string() };
                    }
                }
                Some(WsCmd::Close) | None => {
                    let _ = tokio::time::timeout(CLOSE_TIMEOUT, ws.close(None)).await;
                    break WsEvent::Closed { code: Some(1000), reason: "Closed".into() };
                }
            },
            _ = flush.tick() => {
                if !batch.is_empty() && !emit(WsEvent::Frames { data: std::mem::take(&mut batch) }) {
                    let _ = tokio::time::timeout(CLOSE_TIMEOUT, ws.close(None)).await;
                    return;
                }
            }
            _ = ping.tick() => {
                if last_rx.elapsed() >= STALE_AFTER {
                    break WsEvent::Error { message: "No data for 60 s, connection looks dead".into() };
                }
                if let Err(e) = ws.send(Message::Ping(Vec::new())).await {
                    break WsEvent::Error { message: e.to_string() };
                }
            }
        }
    };
    if !batch.is_empty() {
        emit(WsEvent::Frames { data: batch });
    }
    emit(end);
}

/// Opens a socket to `url` (ws/wss), sends `subscribe` once connected and streams frames to
/// `channel`. Returns an id for `custom_ws_send` / `custom_ws_close`.
#[tauri::command]
pub async fn custom_ws_open(
    state: State<'_, CustomWsState>,
    url: String,
    subscribe: Option<String>,
    channel: Channel<WsEvent>,
) -> CmdResult<u32> {
    let url = validate_url(&url)?;
    if subscribe.as_ref().is_some_and(|s| s.len() > MAX_MESSAGE) {
        return Err(CmdError::new(
            "ws.too_large",
            "Subscribe message is too large",
        ));
    }
    let (tx, rx) = mpsc::unbounded_channel();
    let id = {
        let mut conns = state.conns.lock().expect("ws conns");
        if conns.len() >= MAX_OPEN {
            return Err(CmdError::new(
                "ws.too_many",
                format!("At most {MAX_OPEN} custom WebSockets can be open"),
            ));
        }
        let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
        conns.insert(id, tx);
        id
    };
    let conns = state.conns.clone();
    tauri::async_runtime::spawn(async move {
        run(url, subscribe, rx, |ev| channel.send(ev).is_ok()).await;
        conns.lock().expect("ws conns").remove(&id);
    });
    Ok(id)
}

/// Sends a text frame on an open socket.
#[tauri::command]
pub async fn custom_ws_send(
    state: State<'_, CustomWsState>,
    id: u32,
    text: String,
) -> CmdResult<()> {
    if text.len() > MAX_MESSAGE {
        return Err(CmdError::new("ws.too_large", "Message is too large"));
    }
    let tx = state.conns.lock().expect("ws conns").get(&id).cloned();
    match tx {
        Some(tx) if tx.send(WsCmd::Send(text)).is_ok() => Ok(()),
        _ => Err(CmdError::new("ws.closed", "The connection is closed")),
    }
}

/// Closes a socket (close handshake, then a final `closed` event). Unknown ids are ignored.
#[tauri::command]
pub async fn custom_ws_close(state: State<'_, CustomWsState>, id: u32) -> CmdResult<()> {
    if let Some(tx) = state.conns.lock().expect("ws conns").remove(&id) {
        let _ = tx.send(WsCmd::Close);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    /// Local echo server: echoes text, answers the first message with an extra greeting, and
    /// pings the client once so the test sees the automatic pong.
    async fn echo_server() -> (String, mpsc::UnboundedReceiver<Message>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (seen_tx, seen_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(sock).await.unwrap();
            ws.send(Message::Ping(b"hi".to_vec())).await.unwrap();
            while let Some(Ok(m)) = ws.next().await {
                let _ = seen_tx.send(m.clone());
                match m {
                    Message::Text(t) => {
                        ws.send(Message::Text(format!("echo:{t}"))).await.unwrap();
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });
        (format!("ws://{addr}"), seen_rx)
    }

    fn collector() -> (
        Arc<Mutex<Vec<WsEvent>>>,
        impl FnMut(WsEvent) -> bool + Send + 'static,
    ) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let l = log.clone();
        (log, move |e| {
            l.lock().unwrap().push(e);
            true
        })
    }

    async fn wait_for(log: &Arc<Mutex<Vec<WsEvent>>>, pred: impl Fn(&[WsEvent]) -> bool) {
        for _ in 0..200 {
            if pred(&log.lock().unwrap()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out; events: {:?}", log.lock().unwrap());
    }

    fn frames(evs: &[WsEvent]) -> Vec<String> {
        evs.iter()
            .flat_map(|e| match e {
                WsEvent::Frames { data } => data.clone(),
                _ => vec![],
            })
            .collect()
    }

    #[test]
    fn custom_ws_validates_urls() {
        assert!(validate_url("wss://example.com/stream").is_ok());
        assert!(validate_url(" ws://127.0.0.1:9000 ").is_ok());
        for bad in [
            "https://example.com",
            "ftp://x",
            "ws://",
            "not a url",
            "file:///etc",
        ] {
            assert_eq!(validate_url(bad).unwrap_err().code, "ws.bad_url", "{bad}");
        }
    }

    #[test]
    fn custom_ws_events_serialize_tagged() {
        let s = serde_json::to_string(&WsEvent::Frames {
            data: vec!["a".into()],
        })
        .unwrap();
        assert_eq!(s, r#"{"kind":"frames","data":["a"]}"#);
        let s = serde_json::to_string(&WsEvent::Closed {
            code: None,
            reason: "x".into(),
        })
        .unwrap();
        assert_eq!(s, r#"{"kind":"closed","reason":"x"}"#);
    }

    #[tokio::test]
    async fn custom_ws_subscribes_streams_and_closes_cleanly() {
        let (url, mut seen) = echo_server().await;
        let (log, emit) = collector();
        let (tx, rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(run(url, Some("SUB".into()), rx, emit));
        wait_for(&log, |e| frames(e).contains(&"echo:SUB".to_string())).await;
        assert_eq!(log.lock().unwrap()[0], WsEvent::Open);
        tx.send(WsCmd::Send("two".into())).unwrap();
        wait_for(&log, |e| frames(e).contains(&"echo:two".to_string())).await;
        tx.send(WsCmd::Close).unwrap();
        task.await.unwrap();
        let evs = log.lock().unwrap().clone();
        assert!(matches!(
            evs.last(),
            Some(WsEvent::Closed {
                code: Some(1000),
                ..
            })
        ));
        // The server saw the subscribe, the pong to its ping, the extra frame and a close frame.
        let mut got = Vec::new();
        while let Ok(Some(m)) = tokio::time::timeout(Duration::from_secs(2), seen.recv()).await {
            let close = matches!(m, Message::Close(_));
            got.push(m);
            if close {
                break;
            }
        }
        assert!(got.contains(&Message::Text("SUB".into())));
        assert!(got.contains(&Message::Pong(b"hi".to_vec())));
        assert!(got.iter().any(|m| matches!(m, Message::Close(_))));
    }

    #[tokio::test]
    async fn custom_ws_reports_server_close() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(sock).await.unwrap();
            ws.send(Message::Text("bye".into())).await.unwrap();
            ws.close(None).await.unwrap();
            while ws.next().await.is_some() {}
        });
        let (log, emit) = collector();
        let (_tx, rx) = mpsc::unbounded_channel();
        run(format!("ws://{addr}"), None, rx, emit).await;
        let evs = log.lock().unwrap().clone();
        assert_eq!(frames(&evs), vec!["bye".to_string()]);
        assert!(matches!(evs.last(), Some(WsEvent::Closed { .. })));
    }

    #[tokio::test]
    async fn custom_ws_rejects_oversized_frames() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(sock).await.unwrap();
            let _ = ws.send(Message::Text("x".repeat(MAX_MESSAGE + 1))).await;
            while ws.next().await.is_some() {}
        });
        let (log, emit) = collector();
        let (_tx, rx) = mpsc::unbounded_channel();
        run(format!("ws://{addr}"), None, rx, emit).await;
        let evs = log.lock().unwrap().clone();
        assert!(frames(&evs).is_empty());
        assert!(matches!(evs.last(), Some(WsEvent::Error { .. })), "{evs:?}");
    }

    #[tokio::test]
    async fn custom_ws_reports_connect_failure() {
        // Bind then drop to get a port nothing listens on.
        let addr = TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap()
            .local_addr()
            .unwrap();
        let (log, emit) = collector();
        let (_tx, rx) = mpsc::unbounded_channel();
        run(format!("ws://{addr}"), None, rx, emit).await;
        let evs = log.lock().unwrap().clone();
        assert_eq!(evs.len(), 1);
        assert!(
            matches!(&evs[0], WsEvent::Error { message } if message.starts_with("Cannot connect"))
        );
    }
}
