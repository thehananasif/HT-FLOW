//! P22/P39 — fetches public RSS / Atom / OPML / ICS text for the Info windows. The WebView cannot
//! (CSP `connect-src 'self'` + CORS), so the UI asks the core: GET only, http/https only, 15 s
//! timeout, 5 MB cap, fixed user agent, no cookie store (reqwest is built without `cookies`).
use std::time::Duration;

use crate::error::{CmdError, CmdResult};

const MAX_BYTES: usize = 5 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);
const USER_AGENT: &str = "HTFlow/0.1";

/// Accepts only absolute http(s) URLs with a host.
fn validate_url(raw: &str) -> CmdResult<reqwest::Url> {
    let url = reqwest::Url::parse(raw.trim())
        .map_err(|_| CmdError::new("net.bad_url", "Not a valid URL"))?;
    match url.scheme() {
        "http" | "https" if url.host_str().is_some_and(|h| !h.is_empty()) => Ok(url),
        _ => Err(CmdError::new(
            "net.bad_url",
            "Only http:// and https:// URLs can be fetched",
        )),
    }
}

/// Charset from a Content-Type header, else from the XML declaration.
fn detect_charset(content_type: Option<&str>, body: &[u8]) -> String {
    if let Some(ct) = content_type {
        if let Some(i) = ct.to_ascii_lowercase().find("charset=") {
            let cs = ct[i + 8..].trim_matches(|c: char| c == '"' || c == '\'' || c.is_whitespace());
            let cs = cs.split(';').next().unwrap_or("").trim();
            if !cs.is_empty() {
                return cs.to_ascii_lowercase();
            }
        }
    }
    let head = String::from_utf8_lossy(&body[..body.len().min(200)]).to_ascii_lowercase();
    if let Some(i) = head.find("encoding=") {
        let rest = &head[i + 9..];
        let q = rest.chars().next().unwrap_or('"');
        if let Some(end) = rest[1..].find(q) {
            return rest[1..=end].to_string();
        }
    }
    "utf-8".into()
}

/// UTF-8 (lossy, BOM stripped); ISO-8859-1 / Windows-1252 mapped byte → char (Latin-1).
fn decode(body: &[u8], charset: &str) -> String {
    match charset {
        "iso-8859-1" | "latin1" | "latin-1" | "windows-1252" | "cp1252" | "us-ascii" => {
            body.iter().map(|&b| b as char).collect()
        }
        _ => {
            let b = body.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(body);
            String::from_utf8_lossy(b).into_owned()
        }
    }
}

async fn fetch(url: reqwest::Url, client: reqwest::Client) -> CmdResult<String> {
    let net = |e: reqwest::Error| {
        let msg = if e.is_timeout() {
            "Timed out after 15 s".to_string()
        } else if e.is_connect() {
            "Could not connect".to_string()
        } else {
            "Network error".to_string()
        };
        CmdError::new("net.fetch", msg)
    };
    let mut resp = client.get(url).send().await.map_err(net)?;
    let status = resp.status();
    if !status.is_success() {
        return Err(CmdError::new(
            "net.http",
            format!("HTTP {}", status.as_u16()),
        ));
    }
    if resp.content_length().is_some_and(|l| l > MAX_BYTES as u64) {
        return Err(CmdError::new(
            "net.too_large",
            "Response is larger than 5 MB",
        ));
    }
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(net)? {
        if buf.len() + chunk.len() > MAX_BYTES {
            return Err(CmdError::new(
                "net.too_large",
                "Response is larger than 5 MB",
            ));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(decode(&buf, &detect_charset(ct.as_deref(), &buf)))
}

fn client(system_proxy: bool) -> CmdResult<reqwest::Client> {
    let mut b = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(5));
    if !system_proxy {
        b = b.no_proxy();
    }
    b.build()
        .map_err(|_| CmdError::new("net.client", "Could not create HTTP client"))
}

/// GET a public text resource (feeds, OPML, ICS). Never sends cookies or credentials.
#[tauri::command]
pub async fn net_fetch_text(url: String) -> CmdResult<String> {
    let url = validate_url(&url)?;
    fetch(url, client(true)?).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn only_http_urls() {
        assert!(validate_url("https://example.com/rss.xml").is_ok());
        assert!(validate_url(" http://example.com ").is_ok());
        for bad in [
            "file:///etc/passwd",
            "ftp://x.com/a",
            "javascript:alert(1)",
            "rss",
            "",
        ] {
            assert_eq!(validate_url(bad).unwrap_err().code, "net.bad_url", "{bad}");
        }
    }

    #[test]
    fn charsets() {
        assert_eq!(
            detect_charset(Some("text/xml; charset=\"ISO-8859-1\""), b""),
            "iso-8859-1"
        );
        assert_eq!(
            detect_charset(
                None,
                b"<?xml version=\"1.0\" encoding='windows-1252'?><rss/>"
            ),
            "windows-1252"
        );
        assert_eq!(
            detect_charset(Some("application/rss+xml"), b"<rss/>"),
            "utf-8"
        );
        assert_eq!(decode(&[0xEF, 0xBB, 0xBF, b'a'], "utf-8"), "a");
        assert_eq!(decode(&[b'c', 0xE9], "iso-8859-1"), "c\u{e9}");
    }

    /// One-shot local HTTP server (std thread) returning `body` with `status`.
    fn serve(status: &'static str, body: Vec<u8>) -> String {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut req = [0u8; 2048];
            let n = s.read(&mut req).unwrap();
            let req = String::from_utf8_lossy(&req[..n]).to_ascii_lowercase();
            assert!(req.contains("user-agent: htflow/0.1"));
            assert!(!req.contains("cookie"));
            let head = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/rss+xml; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = s.write_all(head.as_bytes());
            let _ = s.write_all(&body);
        });
        format!("http://{addr}/feed.xml")
    }

    #[tokio::test]
    async fn fetches_and_caps() {
        let url = serve("200 OK", "<rss>ok \u{2713}</rss>".as_bytes().to_vec());
        let c = client(false).unwrap();
        let t = fetch(validate_url(&url).unwrap(), c.clone()).await.unwrap();
        assert_eq!(t, "<rss>ok \u{2713}</rss>");

        let url = serve("404 Not Found", b"nope".to_vec());
        let e = fetch(validate_url(&url).unwrap(), c.clone())
            .await
            .unwrap_err();
        assert_eq!(
            (e.code.as_str(), e.message.as_str()),
            ("net.http", "HTTP 404")
        );

        let url = serve("200 OK", vec![b'x'; MAX_BYTES + 1]);
        let e = fetch(validate_url(&url).unwrap(), c).await.unwrap_err();
        assert_eq!(e.code, "net.too_large");
    }
}
