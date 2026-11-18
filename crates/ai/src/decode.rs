//! Per-format stream decoders: SSE events in, [`StreamEvent`]s out.
use std::collections::BTreeMap;

use serde_json::Value;

use crate::provider::ApiStyle;
use crate::sse::SseEvent;
use crate::StreamEvent;

#[derive(Default)]
struct PendingCall {
    id: String,
    name: String,
    args: String,
}

/// Turns a provider's SSE events into neutral events. Feed with [`Decoder::event`], end with
/// [`Decoder::finish`] (emits any half-finished tool calls and a `done` if none was seen).
pub struct Decoder {
    style: ApiStyle,
    calls: BTreeMap<u64, PendingCall>,
    done: bool,
    stop: Option<String>,
    usage_in: u64,
    usage_out: u64,
    gemini_seq: u32,
}

/// `{"_raw": text}` when the model produced arguments that are not JSON.
fn parse_args(s: &str) -> Value {
    if s.trim().is_empty() {
        return Value::Object(Default::default());
    }
    serde_json::from_str::<Value>(s)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| serde_json::json!({ "_raw": s }))
}

fn provider_error(v: &Value) -> Option<String> {
    let e = v.get("error")?;
    Some(
        e.get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| e.to_string()),
    )
}

impl Decoder {
    pub fn new(style: ApiStyle) -> Self {
        Self {
            style,
            calls: BTreeMap::new(),
            done: false,
            stop: None,
            usage_in: 0,
            usage_out: 0,
            gemini_seq: 0,
        }
    }

    pub fn is_done(&self) -> bool {
        self.done
    }

    /// Decodes one SSE event. `Err` carries an error message sent inside the stream.
    pub fn event(&mut self, ev: &SseEvent) -> Result<Vec<StreamEvent>, String> {
        let data = ev.data.trim();
        if data.is_empty() {
            return Ok(vec![]);
        }
        if data == "[DONE]" {
            return Ok(self.finish());
        }
        let v: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            // Keep-alives and unknown non-JSON lines are ignored.
            Err(_) => return Ok(vec![]),
        };
        if let Some(msg) = provider_error(&v) {
            return Err(msg);
        }
        Ok(match self.style {
            ApiStyle::OpenAiCompat => self.openai(&v),
            ApiStyle::Anthropic => self.anthropic(ev.event.as_deref(), &v)?,
            ApiStyle::Gemini => self.gemini(&v),
        })
    }

    fn flush_calls(&mut self, out: &mut Vec<StreamEvent>) {
        for (_, c) in std::mem::take(&mut self.calls) {
            if c.name.is_empty() {
                continue;
            }
            out.push(StreamEvent::ToolCall {
                id: c.id,
                name: c.name,
                arguments: parse_args(&c.args),
                signature: None,
            });
        }
    }

    /// Ends the stream (idempotent).
    pub fn finish(&mut self) -> Vec<StreamEvent> {
        let mut out = Vec::new();
        if self.done {
            return out;
        }
        self.flush_calls(&mut out);
        if self.usage_in > 0 || self.usage_out > 0 {
            out.push(StreamEvent::Usage {
                input: self.usage_in,
                output: self.usage_out,
            });
        }
        out.push(StreamEvent::Done {
            stop_reason: self.stop.take().unwrap_or_else(|| "end_turn".into()),
        });
        self.done = true;
        out
    }

    fn openai(&mut self, v: &Value) -> Vec<StreamEvent> {
        let mut out = Vec::new();
        if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
            self.usage_in = u["prompt_tokens"].as_u64().unwrap_or(self.usage_in);
            self.usage_out = u["completion_tokens"].as_u64().unwrap_or(self.usage_out);
        }
        let Some(choice) = v["choices"].get(0) else {
            return out;
        };
        let delta = &choice["delta"];
        if let Some(t) = delta["content"].as_str().filter(|t| !t.is_empty()) {
            out.push(StreamEvent::Text { text: t.into() });
        }
        if let Some(calls) = delta["tool_calls"].as_array() {
            for (i, c) in calls.iter().enumerate() {
                let idx = c["index"].as_u64().unwrap_or(i as u64);
                let p = self.calls.entry(idx).or_default();
                if let Some(id) = c["id"].as_str().filter(|s| !s.is_empty()) {
                    p.id = id.into();
                }
                if let Some(n) = c["function"]["name"].as_str().filter(|s| !s.is_empty()) {
                    p.name = n.into();
                }
                if let Some(a) = c["function"]["arguments"].as_str() {
                    p.args.push_str(a);
                }
                if p.id.is_empty() {
                    p.id = format!("call_{idx}");
                }
            }
        }
        if let Some(r) = choice["finish_reason"].as_str() {
            self.stop = Some(
                match r {
                    "stop" => "end_turn",
                    "tool_calls" | "function_call" => "tool_use",
                    "length" => "max_tokens",
                    other => other,
                }
                .to_string(),
            );
            self.flush_calls(&mut out);
        }
        out
    }

    fn anthropic(&mut self, name: Option<&str>, v: &Value) -> Result<Vec<StreamEvent>, String> {
        let mut out = Vec::new();
        let kind = v["type"].as_str().or(name).unwrap_or("");
        match kind {
            "message_start" => {
                let u = &v["message"]["usage"];
                self.usage_in = u["input_tokens"].as_u64().unwrap_or(0)
                    + u["cache_read_input_tokens"].as_u64().unwrap_or(0)
                    + u["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                self.usage_out = u["output_tokens"].as_u64().unwrap_or(0);
            }
            "content_block_start" => {
                let b = &v["content_block"];
                if b["type"] == "tool_use" {
                    let idx = v["index"].as_u64().unwrap_or(0);
                    self.calls.insert(
                        idx,
                        PendingCall {
                            id: b["id"].as_str().unwrap_or_default().into(),
                            name: b["name"].as_str().unwrap_or_default().into(),
                            args: String::new(),
                        },
                    );
                }
            }
            "content_block_delta" => {
                let d = &v["delta"];
                match d["type"].as_str() {
                    Some("text_delta") => {
                        if let Some(t) = d["text"].as_str().filter(|t| !t.is_empty()) {
                            out.push(StreamEvent::Text { text: t.into() });
                        }
                    }
                    Some("input_json_delta") => {
                        let idx = v["index"].as_u64().unwrap_or(0);
                        if let Some(p) = self.calls.get_mut(&idx) {
                            p.args.push_str(d["partial_json"].as_str().unwrap_or(""));
                        }
                    }
                    _ => {} // thinking / signature deltas are not shown
                }
            }
            "content_block_stop" => {
                let idx = v["index"].as_u64().unwrap_or(0);
                if let Some(c) = self.calls.remove(&idx) {
                    out.push(StreamEvent::ToolCall {
                        id: c.id,
                        name: c.name,
                        arguments: parse_args(&c.args),
                        signature: None,
                    });
                }
            }
            "message_delta" => {
                if let Some(r) = v["delta"]["stop_reason"].as_str() {
                    self.stop = Some(r.into());
                }
                if let Some(o) = v["usage"]["output_tokens"].as_u64() {
                    self.usage_out = o;
                }
            }
            "message_stop" => out.extend(self.finish()),
            "error" => {
                return Err(v["error"]["message"]
                    .as_str()
                    .unwrap_or("Provider error")
                    .into())
            }
            _ => {}
        }
        Ok(out)
    }

    fn gemini(&mut self, v: &Value) -> Vec<StreamEvent> {
        let mut out = Vec::new();
        if let Some(u) = v.get("usageMetadata") {
            self.usage_in = u["promptTokenCount"].as_u64().unwrap_or(self.usage_in);
            self.usage_out = u["candidatesTokenCount"].as_u64().unwrap_or(self.usage_out)
                + u["thoughtsTokenCount"].as_u64().unwrap_or(0);
        }
        let Some(c) = v["candidates"].get(0) else {
            return out;
        };
        let mut saw_call = false;
        if let Some(parts) = c["content"]["parts"].as_array() {
            for p in parts {
                if p["thought"] == true {
                    continue;
                }
                if let Some(t) = p["text"].as_str().filter(|t| !t.is_empty()) {
                    out.push(StreamEvent::Text { text: t.into() });
                }
                if let Some(fc) = p.get("functionCall") {
                    saw_call = true;
                    self.gemini_seq += 1;
                    out.push(StreamEvent::ToolCall {
                        id: fc["id"]
                            .as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| format!("gemini-call-{}", self.gemini_seq)),
                        name: fc["name"].as_str().unwrap_or_default().into(),
                        arguments: if fc["args"].is_object() {
                            fc["args"].clone()
                        } else {
                            Value::Object(Default::default())
                        },
                        signature: p["thoughtSignature"].as_str().map(str::to_string),
                    });
                }
            }
        }
        if saw_call {
            self.stop = Some("tool_use".into());
        }
        if let Some(r) = c["finishReason"].as_str() {
            if self.stop.as_deref() != Some("tool_use") {
                self.stop = Some(
                    match r {
                        "STOP" => "end_turn",
                        "MAX_TOKENS" => "max_tokens",
                        "SAFETY" | "RECITATION" | "PROHIBITED_CONTENT" => "refusal",
                        other => other,
                    }
                    .to_string(),
                );
            }
        }
        out
    }
}

/// Decodes a whole recorded stream (tests, fixtures).
pub fn decode_all(style: ApiStyle, raw: &[u8]) -> Result<Vec<StreamEvent>, String> {
    let mut p = crate::sse::SseParser::new();
    let mut d = Decoder::new(style);
    let mut out = Vec::new();
    let mut evs = p.push(raw)?;
    evs.extend(p.finish());
    for e in evs {
        out.extend(d.event(&e)?);
    }
    out.extend(d.finish());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text(evs: &[StreamEvent]) -> String {
        evs.iter()
            .filter_map(|e| match e {
                StreamEvent::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn openai_fixture() {
        let evs = decode_all(
            ApiStyle::OpenAiCompat,
            include_bytes!("../tests/fixtures/openai_stream.txt"),
        )
        .unwrap();
        assert_eq!(text(&evs), "Checking your account.");
        assert!(evs.contains(&StreamEvent::ToolCall {
            id: "call_abc".into(),
            name: "place_order".into(),
            arguments: json!({"symbol": "BTCUSDT", "side": "buy", "qty": 1}),
            signature: None
        }));
        assert!(evs.contains(&StreamEvent::Usage {
            input: 120,
            output: 30
        }));
        assert_eq!(
            evs.last().unwrap(),
            &StreamEvent::Done {
                stop_reason: "tool_use".into()
            }
        );
        // Exactly one tool call (not re-emitted at [DONE]).
        assert_eq!(
            evs.iter()
                .filter(|e| matches!(e, StreamEvent::ToolCall { .. }))
                .count(),
            1
        );
    }

    #[test]
    fn anthropic_fixture() {
        let evs = decode_all(
            ApiStyle::Anthropic,
            include_bytes!("../tests/fixtures/anthropic_stream.txt"),
        )
        .unwrap();
        assert_eq!(text(&evs), "Delta is positive.");
        assert!(evs.contains(&StreamEvent::ToolCall {
            id: "toolu_01".into(),
            name: "get_footprint_stats".into(),
            arguments: json!({"bars": 20}),
            signature: None
        }));
        assert!(evs.contains(&StreamEvent::Usage {
            input: 50,
            output: 42
        }));
        assert_eq!(
            evs.last().unwrap(),
            &StreamEvent::Done {
                stop_reason: "tool_use".into()
            }
        );
    }

    #[test]
    fn gemini_fixture() {
        let evs = decode_all(
            ApiStyle::Gemini,
            include_bytes!("../tests/fixtures/gemini_stream.txt"),
        )
        .unwrap();
        assert_eq!(text(&evs), "Price is near VWAP.");
        assert!(evs.contains(&StreamEvent::ToolCall {
            id: "gemini-call-1".into(),
            name: "get_market_data".into(),
            arguments: json!({"symbol": "ESZ6"}),
            signature: Some("c2ln".into())
        }));
        assert!(evs.contains(&StreamEvent::Usage {
            input: 10,
            output: 7
        }));
    }

    #[test]
    fn errors_inside_the_stream() {
        let e = decode_all(
            ApiStyle::Anthropic,
            b"event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n",
        )
        .unwrap_err();
        assert_eq!(e, "Overloaded");
        let e = decode_all(
            ApiStyle::OpenAiCompat,
            b"data: {\"error\":{\"message\":\"bad model\"}}\n\n",
        )
        .unwrap_err();
        assert_eq!(e, "bad model");
    }

    #[test]
    fn bad_tool_json_is_kept_raw() {
        let raw = b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c\",\"function\":{\"name\":\"x\",\"arguments\":\"{oops\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n";
        let evs = decode_all(ApiStyle::OpenAiCompat, raw).unwrap();
        assert!(evs.contains(&StreamEvent::ToolCall {
            id: "c".into(),
            name: "x".into(),
            arguments: json!({"_raw": "{oops"}),
            signature: None
        }));
    }
}
