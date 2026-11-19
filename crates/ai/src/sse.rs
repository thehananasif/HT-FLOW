//! Incremental Server-Sent Events parser: feed raw bytes as they arrive, get complete events.

/// One SSE event (`event:` name, joined `data:` lines).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    event: Option<String>,
    data: Vec<String>,
}

/// Longest line kept in the buffer before the stream is treated as broken.
const MAX_LINE: usize = 8 * 1024 * 1024;

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds bytes; returns the events they completed. `Err` when a line grows past 8 MB.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<SseEvent>, String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=nl).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = String::from_utf8_lossy(&line).into_owned();
            self.line(&line, &mut out);
        }
        if self.buf.len() > MAX_LINE {
            return Err("Stream line too long".into());
        }
        Ok(out)
    }

    /// Flushes a final event that was not followed by a blank line.
    pub fn finish(&mut self) -> Vec<SseEvent> {
        let mut out = Vec::new();
        if !self.buf.is_empty() {
            let rest = String::from_utf8_lossy(&std::mem::take(&mut self.buf)).into_owned();
            self.line(rest.trim_end_matches('\r'), &mut out);
        }
        self.line("", &mut out);
        out
    }

    fn line(&mut self, line: &str, out: &mut Vec<SseEvent>) {
        if line.is_empty() {
            if !self.data.is_empty() || self.event.is_some() {
                out.push(SseEvent {
                    event: self.event.take(),
                    data: std::mem::take(&mut self.data).join("\n"),
                });
            }
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "event" => self.event = Some(value.to_string()),
            "data" => self.data.push(value.to_string()),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_across_chunks() {
        let mut p = SseParser::new();
        let mut ev = p.push(b"event: ping\r\ndata: {\"a\"").unwrap();
        assert!(ev.is_empty());
        ev.extend(
            p.push(b":1}\r\n\r\n: comment\n\ndata: x\ndata: y\n\n")
                .unwrap(),
        );
        assert_eq!(
            ev,
            vec![
                SseEvent {
                    event: Some("ping".into()),
                    data: "{\"a\":1}".into()
                },
                SseEvent {
                    event: None,
                    data: "x\ny".into()
                }
            ]
        );
        assert!(p.push(b"data: [DONE]").unwrap().is_empty());
        assert_eq!(p.finish()[0].data, "[DONE]");
    }

    #[test]
    fn multibyte_split() {
        let mut p = SseParser::new();
        let s = "data: caf\u{e9}\n\n".as_bytes();
        let (a, b) = s.split_at(10);
        assert!(p.push(a).unwrap().is_empty());
        assert_eq!(p.push(b).unwrap()[0].data, "caf\u{e9}");
    }
}
