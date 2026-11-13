//! A scripted local HTTP/1.1 server for REST tests (std thread, `Connection: close`), so
//! connector and history tests never touch the live network.
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

/// One canned answer: status line (`"200 OK"`), extra header lines, body.
#[derive(Debug, Clone)]
pub struct Reply {
    pub status: &'static str,
    pub headers: Vec<String>,
    pub body: String,
}

impl Reply {
    pub fn ok(body: impl Into<String>) -> Self {
        Self {
            status: "200 OK",
            headers: Vec::new(),
            body: body.into(),
        }
    }
    pub fn status(status: &'static str, body: impl Into<String>) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: body.into(),
        }
    }
    pub fn header(mut self, h: impl Into<String>) -> Self {
        self.headers.push(h.into());
        self
    }
}

/// Running mock server: `base` is `http://127.0.0.1:<port>`; `requests` logs every request
/// target (path + query) in arrival order.
pub struct MockServer {
    pub base: String,
    pub requests: Arc<Mutex<Vec<String>>>,
}

impl MockServer {
    /// Serves until the process ends; `route` maps a request target to a reply.
    pub fn start<F>(route: F) -> Self
    where
        F: Fn(&str) -> Reply + Send + 'static,
    {
        let l = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let base = format!("http://{}", l.local_addr().expect("addr"));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = requests.clone();
        std::thread::spawn(move || {
            for s in l.incoming() {
                let Ok(mut s) = s else { continue };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                // Read the head (GET requests have no body).
                loop {
                    match s.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&chunk[..n]);
                            if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 65_536 {
                                break;
                            }
                        }
                    }
                }
                let head = String::from_utf8_lossy(&buf);
                let target = head
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("/")
                    .to_string();
                log.lock().expect("log").push(target.clone());
                let r = route(&target);
                let mut out = format!(
                    "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
                    r.status,
                    r.body.len()
                );
                for h in &r.headers {
                    out.push_str(h);
                    out.push_str("\r\n");
                }
                out.push_str("\r\n");
                out.push_str(&r.body);
                let _ = s.write_all(out.as_bytes());
                let _ = s.flush();
            }
        });
        Self { base, requests }
    }

    pub fn requests(&self) -> Vec<String> {
        self.requests.lock().expect("log").clone()
    }
}

/// Value of query parameter `key` in a request target.
pub fn query_param<'a>(target: &'a str, key: &str) -> Option<&'a str> {
    let q = target.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then_some(v)
    })
}
