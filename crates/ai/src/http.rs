//! Streaming HTTP client: no redirects (a key is never forwarded), no cookies, connect / idle
//! timeouts, response size caps. Callers cancel by dropping the future.
use std::time::Duration;

use crate::provider::{is_loopback, Provider};
use crate::{build, decode::Decoder, limits, models, scrub, sse::SseParser, AiError};
use crate::{ChatRequest, StreamEvent};

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Longest gap between two chunks of a stream (models may think silently for a while).
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const USER_AGENT: &str = "HTFlow/0.1";

/// Clients for remote (system proxy) and loopback (never proxied) endpoints.
pub fn client(local: bool) -> Result<reqwest::Client, AiError> {
    let mut b = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::none());
    if local {
        b = b.no_proxy();
    }
    b.build()
        .map_err(|_| AiError::Network("Could not create HTTP client".into()))
}

pub fn client_for(url: &reqwest::Url) -> Result<reqwest::Client, AiError> {
    client(is_loopback(url))
}

fn net_err(e: reqwest::Error) -> AiError {
    AiError::Network(
        if e.is_timeout() {
            "Timed out"
        } else if e.is_connect() {
            "Could not connect"
        } else {
            "Network error"
        }
        .into(),
    )
}

/// Reads at most `cap` bytes of an error body and pulls out `error.message`.
async fn http_error(mut resp: reqwest::Response, key: Option<&str>) -> AiError {
    let status = resp.status().as_u16();
    let mut buf = Vec::new();
    while let Ok(Ok(Some(c))) = tokio::time::timeout(Duration::from_secs(10), resp.chunk()).await {
        buf.extend_from_slice(&c);
        if buf.len() > 8192 {
            break;
        }
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    let msg = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| {
            let e = if v.is_array() {
                v[0]["error"].clone()
            } else {
                v["error"].clone()
            };
            e["message"]
                .as_str()
                .map(str::to_string)
                .or_else(|| e.as_str().map(str::to_string))
        })
        .unwrap_or_else(|| match status {
            401 | 403 => "The API key was rejected".into(),
            404 => "Not found (check the model name and base URL)".into(),
            429 => "Rate limited or out of credit".into(),
            _ => "Request failed".into(),
        });
    let msg: String = scrub(&msg, key).chars().take(300).collect();
    AiError::Http {
        status,
        message: msg,
    }
}

/// Sends `req` and streams events to `on_event`. Returns after `Done` (or an error).
pub async fn stream_chat(
    req: &ChatRequest,
    base: &reqwest::Url,
    key: Option<&str>,
    mut on_event: impl FnMut(StreamEvent),
) -> Result<(), AiError> {
    crate::validate_request(req)?;
    let prepared = build::chat(req, base, key);
    let body = serde_json::to_vec(&prepared.body)
        .map_err(|_| AiError::BadRequest("Could not encode the request".into()))?;
    if body.len() > limits::MAX_REQUEST_BYTES {
        return Err(AiError::TooLarge("Request is larger than 24 MB".into()));
    }
    let client = client_for(&prepared.url)?;
    let mut rb = client.post(prepared.url.clone()).body(body);
    for (k, v) in &prepared.headers {
        rb = rb.header(*k, v);
    }
    tracing::info!(provider = ?req.provider, model = %req.model, "ai chat request");
    let mut resp = tokio::time::timeout(IDLE_TIMEOUT, rb.send())
        .await
        .map_err(|_| AiError::Network("Timed out waiting for the provider".into()))?
        .map_err(net_err)?;
    if !resp.status().is_success() {
        let e = http_error(resp, key).await;
        tracing::warn!(provider = ?req.provider, code = e.code(), "ai chat failed");
        return Err(e);
    }
    let mut parser = SseParser::new();
    let mut dec = Decoder::new(req.provider.style());
    let mut total = 0usize;
    let emit = |evs: Vec<StreamEvent>, f: &mut dyn FnMut(StreamEvent)| {
        for e in evs {
            f(e);
        }
    };
    loop {
        let chunk = tokio::time::timeout(IDLE_TIMEOUT, resp.chunk())
            .await
            .map_err(|_| AiError::Network("The provider stopped responding".into()))?
            .map_err(net_err)?;
        let Some(chunk) = chunk else { break };
        total += chunk.len();
        if total > limits::MAX_RESPONSE_BYTES {
            return Err(AiError::TooLarge("Response is larger than 16 MB".into()));
        }
        for ev in parser.push(&chunk).map_err(AiError::Protocol)? {
            let out = dec
                .event(&ev)
                .map_err(|m| AiError::Protocol(scrub(&m, key).chars().take(300).collect()))?;
            emit(out, &mut on_event);
        }
        if dec.is_done() {
            return Ok(());
        }
    }
    for ev in parser.finish() {
        let out = dec
            .event(&ev)
            .map_err(|m| AiError::Protocol(scrub(&m, key).chars().take(300).collect()))?;
        emit(out, &mut on_event);
    }
    emit(dec.finish(), &mut on_event);
    Ok(())
}

/// Fetches the provider's model list.
pub async fn list_models(
    provider: Provider,
    base: &reqwest::Url,
    key: Option<&str>,
) -> Result<Vec<String>, AiError> {
    let url = build::models_url(provider, base);
    let client = client_for(&url)?;
    let mut rb = client.get(url).timeout(Duration::from_secs(20));
    for (k, v) in build::auth_headers(provider, key) {
        rb = rb.header(k, v);
    }
    let mut resp = rb.send().await.map_err(net_err)?;
    if !resp.status().is_success() {
        return Err(http_error(resp, key).await);
    }
    let mut buf = Vec::new();
    while let Some(c) = resp.chunk().await.map_err(net_err)? {
        buf.extend_from_slice(&c);
        if buf.len() > limits::MAX_MODELS_BYTES {
            return Err(AiError::TooLarge("Model list is larger than 4 MB".into()));
        }
    }
    models::parse(provider.style(), &String::from_utf8_lossy(&buf)).map_err(AiError::Protocol)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::resolve_base;
    use crate::{Message, Part, Role};
    use std::io::{Read, Write};

    /// One-shot local HTTP server returning `status` + `body`; reports the request it saw.
    fn serve(
        status: &'static str,
        ctype: &'static str,
        body: &'static [u8],
    ) -> (String, std::sync::mpsc::Receiver<String>) {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            s.set_read_timeout(Some(Duration::from_millis(500)))
                .unwrap();
            let mut req = Vec::new();
            let mut b = [0u8; 4096];
            while let Ok(n) = s.read(&mut b) {
                if n == 0 {
                    break;
                }
                req.extend_from_slice(&b[..n]);
                let t = String::from_utf8_lossy(&req);
                if let Some(i) = t.find("\r\n\r\n") {
                    let len = t[..i]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if req.len() >= i + 4 + len {
                        break;
                    }
                }
            }
            let _ = tx.send(String::from_utf8_lossy(&req).into_owned());
            let head = format!(
                "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = s.write_all(head.as_bytes());
            let _ = s.write_all(body);
        });
        (format!("http://{addr}/v1"), rx)
    }

    fn req() -> ChatRequest {
        ChatRequest {
            provider: Provider::Ollama,
            model: "llama3".into(),
            system: None,
            messages: vec![Message {
                role: Role::User,
                parts: vec![Part::Text { text: "hi".into() }],
            }],
            tools: vec![],
            max_tokens: Some(64),
            temperature: None,
        }
    }

    #[tokio::test]
    async fn streams_from_a_local_server() {
        let (url, rx) = serve(
            "200 OK",
            "text/event-stream",
            include_bytes!("../tests/fixtures/openai_stream.txt"),
        );
        let base = resolve_base(Provider::Ollama, Some(&url)).unwrap();
        let mut evs = Vec::new();
        stream_chat(&req(), &base, Some("local-key-123456"), |e| evs.push(e))
            .await
            .unwrap();
        let seen = rx.recv().unwrap();
        assert!(seen.starts_with("POST /v1/chat/completions"), "{seen}");
        assert!(seen
            .to_ascii_lowercase()
            .contains("authorization: bearer local-key-123456"));
        assert!(seen.contains("\"stream\":true"));
        assert!(matches!(evs.last(), Some(StreamEvent::Done { .. })));
    }

    #[tokio::test]
    async fn http_errors_are_scrubbed() {
        let (url, _rx) = serve(
            "401 Unauthorized",
            "application/json",
            br#"{"error":{"message":"Incorrect API key provided: local-key-123456."}}"#,
        );
        let base = resolve_base(Provider::Ollama, Some(&url)).unwrap();
        let e = stream_chat(&req(), &base, Some("local-key-123456"), |_| {})
            .await
            .unwrap_err();
        assert_eq!(e.code(), "ai.auth");
        assert!(!e.to_string().contains("local-key-123456"), "{e}");
    }

    #[tokio::test]
    async fn lists_models() {
        let (url, rx) = serve(
            "200 OK",
            "application/json",
            br#"{"data":[{"id":"qwen2.5"},{"id":"llama3"}]}"#,
        );
        let base = resolve_base(Provider::LmStudio, Some(&url)).unwrap();
        let m = list_models(Provider::LmStudio, &base, None).await.unwrap();
        assert_eq!(m, ["llama3", "qwen2.5"]);
        assert!(rx.recv().unwrap().starts_with("GET /v1/models"));
    }
}
