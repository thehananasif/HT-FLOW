//! Request bodies, endpoints and auth headers for the three wire formats.
use serde_json::{json, Map, Value};

use crate::provider::{join, ApiStyle, Provider};
use crate::{ChatRequest, Message, Part, Role};

/// Messages API version header sent to Anthropic.
pub const ANTHROPIC_VERSION: &str = "2026-10-21";
/// Default output cap when the UI does not set one.
pub const DEFAULT_MAX_TOKENS: u32 = 8192;

/// An HTTP request ready to send (the key goes into one of `headers`).
#[derive(Debug, Clone, PartialEq)]
pub struct Prepared {
    pub url: reqwest::Url,
    pub headers: Vec<(&'static str, String)>,
    pub body: Value,
}

/// Auth headers for `provider` (none when there is no key).
pub fn auth_headers(provider: Provider, key: Option<&str>) -> Vec<(&'static str, String)> {
    let mut h = Vec::new();
    match provider.style() {
        ApiStyle::Anthropic => {
            h.push(("anthropic-version", ANTHROPIC_VERSION.to_string()));
            if let Some(k) = key {
                h.push(("x-api-key", k.to_string()));
            }
        }
        ApiStyle::Gemini => {
            if let Some(k) = key {
                h.push(("x-goog-api-key", k.to_string()));
            }
        }
        ApiStyle::OpenAiCompat => {
            if let Some(k) = key {
                h.push(("authorization", format!("Bearer {k}")));
            }
        }
    }
    h
}

/// Builds the streaming chat request.
pub fn chat(req: &ChatRequest, base: &reqwest::Url, key: Option<&str>) -> Prepared {
    let (url, body) = match req.provider.style() {
        ApiStyle::Anthropic => (join(base, "messages"), anthropic_body(req)),
        ApiStyle::Gemini => {
            let mut u = join(base, &format!("models/{}:streamGenerateContent", req.model));
            u.set_query(Some("alt=sse"));
            (u, gemini_body(req))
        }
        ApiStyle::OpenAiCompat => (join(base, "chat/completions"), openai_body(req)),
    };
    let mut headers = auth_headers(req.provider, key);
    headers.push(("content-type", "application/json".into()));
    headers.push(("accept", "text/event-stream".into()));
    Prepared { url, headers, body }
}

/// The list-models endpoint.
pub fn models_url(provider: Provider, base: &reqwest::Url) -> reqwest::Url {
    let mut u = join(base, "models");
    match provider.style() {
        ApiStyle::Anthropic => u.set_query(Some("limit=1000")),
        ApiStyle::Gemini => u.set_query(Some("pageSize=1000")),
        ApiStyle::OpenAiCompat => {}
    }
    u
}

fn text_of(parts: &[Part]) -> String {
    parts
        .iter()
        .filter_map(|p| match p {
            Part::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ------------------------------------------------------------------------------- Anthropic

fn anthropic_body(req: &ChatRequest) -> Value {
    let messages: Vec<Value> = req
        .messages
        .iter()
        .filter_map(|m| {
            let content: Vec<Value> = m
                .parts
                .iter()
                .map(|p| match p {
                    Part::Text { text } => json!({"type": "text", "text": text}),
                    Part::Image { media_type, data } => json!({
                        "type": "image",
                        "source": {"type": "base64", "media_type": media_type, "data": data}
                    }),
                    Part::ToolCall {
                        id,
                        name,
                        arguments,
                        ..
                    } => json!({"type": "tool_use", "id": id, "name": name, "input": object_or_empty(arguments)}),
                    Part::ToolResult {
                        id,
                        content,
                        is_error,
                        ..
                    } => json!({"type": "tool_result", "tool_use_id": id, "content": content, "is_error": is_error}),
                })
                .collect();
            (!content.is_empty()).then(|| json!({"role": role_str(m.role), "content": content}))
        })
        .collect();
    let mut b = Map::new();
    b.insert("model".into(), json!(req.model));
    b.insert(
        "max_tokens".into(),
        json!(req.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS)),
    );
    b.insert("stream".into(), json!(true));
    if let Some(s) = req.system.as_deref().filter(|s| !s.is_empty()) {
        b.insert("system".into(), json!(s));
    }
    b.insert("messages".into(), Value::Array(messages));
    if !req.tools.is_empty() {
        b.insert(
            "tools".into(),
            Value::Array(
                req.tools
                    .iter()
                    .map(|t| json!({"name": t.name, "description": t.description, "input_schema": t.parameters}))
                    .collect(),
            ),
        );
    }
    // Sampling parameters are not sent: current Claude models reject them.
    Value::Object(b)
}

fn role_str(r: Role) -> &'static str {
    match r {
        Role::User => "user",
        Role::Assistant => "assistant",
    }
}

fn object_or_empty(v: &Value) -> Value {
    if v.is_object() {
        v.clone()
    } else {
        json!({})
    }
}

// ------------------------------------------------------------------------------- Gemini

fn gemini_body(req: &ChatRequest) -> Value {
    let contents: Vec<Value> = req
        .messages
        .iter()
        .filter_map(|m| {
            let parts: Vec<Value> = m
                .parts
                .iter()
                .map(|p| match p {
                    Part::Text { text } => json!({"text": text}),
                    Part::Image { media_type, data } => {
                        json!({"inlineData": {"mimeType": media_type, "data": data}})
                    }
                    Part::ToolCall {
                        name,
                        arguments,
                        signature,
                        ..
                    } => {
                        let mut v = json!({"functionCall": {"name": name, "args": object_or_empty(arguments)}});
                        if let Some(s) = signature {
                            v["thoughtSignature"] = json!(s);
                        }
                        v
                    }
                    Part::ToolResult {
                        name,
                        content,
                        is_error,
                        ..
                    } => {
                        let parsed: Value = serde_json::from_str(content)
                            .unwrap_or_else(|_| json!(content));
                        let key = if *is_error { "error" } else { "result" };
                        json!({"functionResponse": {"name": name, "response": {key: parsed}}})
                    }
                })
                .collect();
            let role = match m.role {
                Role::User => "user",
                Role::Assistant => "model",
            };
            (!parts.is_empty()).then(|| json!({"role": role, "parts": parts}))
        })
        .collect();
    let mut b = Map::new();
    if let Some(s) = req.system.as_deref().filter(|s| !s.is_empty()) {
        b.insert("systemInstruction".into(), json!({"parts": [{"text": s}]}));
    }
    b.insert("contents".into(), Value::Array(contents));
    if !req.tools.is_empty() {
        b.insert(
            "tools".into(),
            json!([{"functionDeclarations": req.tools.iter()
                .map(|t| json!({"name": t.name, "description": t.description, "parameters": t.parameters}))
                .collect::<Vec<_>>()}]),
        );
    }
    let mut gen = Map::new();
    gen.insert(
        "maxOutputTokens".into(),
        json!(req.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS)),
    );
    if let Some(t) = req.temperature {
        gen.insert("temperature".into(), json!(t));
    }
    b.insert("generationConfig".into(), Value::Object(gen));
    Value::Object(b)
}

// ------------------------------------------------------------------------------- OpenAI-compatible

fn openai_body(req: &ChatRequest) -> Value {
    let p = req.provider;
    let mut messages: Vec<Value> = Vec::new();
    if let Some(s) = req.system.as_deref().filter(|s| !s.is_empty()) {
        messages.push(json!({"role": "system", "content": s}));
    }
    for m in &req.messages {
        openai_messages(p, m, &mut messages);
    }
    let mut b = Map::new();
    b.insert("model".into(), json!(req.model));
    b.insert("stream".into(), json!(true));
    b.insert("messages".into(), Value::Array(messages));
    let max = req.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS);
    if p == Provider::OpenAi {
        b.insert("max_completion_tokens".into(), json!(max));
    } else {
        b.insert("max_tokens".into(), json!(max));
    }
    if matches!(
        p,
        Provider::OpenAi | Provider::Xai | Provider::DeepSeek | Provider::Qwen
    ) {
        b.insert("stream_options".into(), json!({"include_usage": true}));
    }
    if let Some(t) = req.temperature {
        b.insert("temperature".into(), json!(t));
    }
    if !req.tools.is_empty() {
        b.insert(
            "tools".into(),
            Value::Array(
                req.tools
                    .iter()
                    .map(|t| json!({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.parameters}}))
                    .collect(),
            ),
        );
    }
    Value::Object(b)
}

/// Providers without image input get a text placeholder instead of the image.
fn has_vision(p: Provider) -> bool {
    p != Provider::DeepSeek
}

fn openai_messages(p: Provider, m: &Message, out: &mut Vec<Value>) {
    match m.role {
        Role::Assistant => {
            let text = text_of(&m.parts);
            let calls: Vec<Value> = m
                .parts
                .iter()
                .filter_map(|x| match x {
                    Part::ToolCall {
                        id,
                        name,
                        arguments,
                        ..
                    } => Some(json!({
                        "id": id, "type": "function",
                        "function": {"name": name, "arguments": object_or_empty(arguments).to_string()}
                    })),
                    _ => None,
                })
                .collect();
            let mut msg = json!({"role": "assistant", "content": if text.is_empty() { Value::Null } else { json!(text) }});
            if !calls.is_empty() {
                msg["tool_calls"] = Value::Array(calls);
            }
            out.push(msg);
        }
        Role::User => {
            // Tool results first (they answer the previous assistant turn), then the user content.
            for x in &m.parts {
                if let Part::ToolResult { id, content, .. } = x {
                    out.push(json!({"role": "tool", "tool_call_id": id, "content": content}));
                }
            }
            let mut content: Vec<Value> = Vec::new();
            let mut only_text = true;
            for x in &m.parts {
                match x {
                    Part::Text { text } => content.push(json!({"type": "text", "text": text})),
                    Part::Image { media_type, data } if has_vision(p) => {
                        only_text = false;
                        let url = format!("data:{media_type};base64,{data}");
                        content.push(if p == Provider::Mistral {
                            json!({"type": "image_url", "image_url": url})
                        } else {
                            json!({"type": "image_url", "image_url": {"url": url}})
                        });
                    }
                    Part::Image { .. } => content.push(json!({
                        "type": "text",
                        "text": "[A screenshot was attached but this model cannot read images.]"
                    })),
                    _ => {}
                }
            }
            if content.is_empty() {
                return;
            }
            if only_text {
                out.push(json!({"role": "user", "content": text_from_values(&content)}));
            } else {
                out.push(json!({"role": "user", "content": content}));
            }
        }
    }
}

fn text_from_values(v: &[Value]) -> String {
    v.iter()
        .filter_map(|x| x["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::resolve_base;
    use crate::ToolDef;

    fn convo(provider: Provider) -> ChatRequest {
        ChatRequest {
            provider,
            model: "m-1".into(),
            system: Some("You are a market analyst.".into()),
            messages: vec![
                Message {
                    role: Role::User,
                    parts: vec![
                        Part::Text {
                            text: "What is on my chart?".into(),
                        },
                        Part::Image {
                            media_type: "image/png".into(),
                            data: "iVBORw0KGgo=".into(),
                        },
                    ],
                },
                Message {
                    role: Role::Assistant,
                    parts: vec![
                        Part::Text {
                            text: "Let me check positions.".into(),
                        },
                        Part::ToolCall {
                            id: "call_1".into(),
                            name: "get_positions".into(),
                            arguments: json!({"account": "paper"}),
                            signature: Some("sig==".into()),
                        },
                    ],
                },
                Message {
                    role: Role::User,
                    parts: vec![Part::ToolResult {
                        id: "call_1".into(),
                        name: "get_positions".into(),
                        content: "{\"positions\":[]}".into(),
                        is_error: false,
                    }],
                },
            ],
            tools: vec![ToolDef {
                name: "get_positions".into(),
                description: "Open positions".into(),
                parameters: json!({"type": "object", "properties": {}}),
            }],
            max_tokens: Some(1000),
            temperature: Some(0.2),
        }
    }

    fn prep(p: Provider) -> Prepared {
        chat(
            &convo(p),
            &resolve_base(p, None).unwrap(),
            Some("KEY123456789"),
        )
    }

    #[test]
    fn anthropic_messages_body() {
        let r = prep(Provider::Anthropic);
        assert_eq!(r.url.as_str(), "https://api.anthropic.com/v1/messages");
        assert!(r.headers.contains(&("x-api-key", "KEY123456789".into())));
        assert!(r
            .headers
            .contains(&("anthropic-version", ANTHROPIC_VERSION.into())));
        let expected = json!({
            "model": "m-1", "max_tokens": 1000, "stream": true,
            "system": "You are a market analyst.",
            "messages": [
                {"role": "user", "content": [
                    {"type": "text", "text": "What is on my chart?"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}}
                ]},
                {"role": "assistant", "content": [
                    {"type": "text", "text": "Let me check positions."},
                    {"type": "tool_use", "id": "call_1", "name": "get_positions", "input": {"account": "paper"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "call_1", "content": "{\"positions\":[]}", "is_error": false}
                ]}
            ],
            "tools": [{"name": "get_positions", "description": "Open positions", "input_schema": {"type": "object", "properties": {}}}]
        });
        assert_eq!(r.body, expected);
    }

    #[test]
    fn gemini_body_and_url() {
        let r = prep(Provider::Gemini);
        assert_eq!(
            r.url.as_str(),
            "https://generativelanguage.googleapis.com/v1beta/models/m-1:streamGenerateContent?alt=sse"
        );
        assert!(r
            .headers
            .contains(&("x-goog-api-key", "KEY123456789".into())));
        assert!(!r.url.as_str().contains("KEY"));
        let expected = json!({
            "systemInstruction": {"parts": [{"text": "You are a market analyst."}]},
            "contents": [
                {"role": "user", "parts": [
                    {"text": "What is on my chart?"},
                    {"inlineData": {"mimeType": "image/png", "data": "iVBORw0KGgo="}}
                ]},
                {"role": "model", "parts": [
                    {"text": "Let me check positions."},
                    {"functionCall": {"name": "get_positions", "args": {"account": "paper"}}, "thoughtSignature": "sig=="}
                ]},
                {"role": "user", "parts": [
                    {"functionResponse": {"name": "get_positions", "response": {"result": {"positions": []}}}}
                ]}
            ],
            "tools": [{"functionDeclarations": [{"name": "get_positions", "description": "Open positions", "parameters": {"type": "object", "properties": {}}}]}],
            "generationConfig": {"maxOutputTokens": 1000, "temperature": 0.2f32}
        });
        assert_eq!(r.body, expected);
    }

    #[test]
    fn openai_compatible_body() {
        let r = prep(Provider::OpenAi);
        assert_eq!(r.url.as_str(), "https://api.openai.com/v1/chat/completions");
        assert!(r
            .headers
            .contains(&("authorization", "Bearer KEY123456789".into())));
        let expected = json!({
            "model": "m-1", "stream": true,
            "messages": [
                {"role": "system", "content": "You are a market analyst."},
                {"role": "user", "content": [
                    {"type": "text", "text": "What is on my chart?"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo="}}
                ]},
                {"role": "assistant", "content": "Let me check positions.", "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "get_positions", "arguments": "{\"account\":\"paper\"}"}}
                ]},
                {"role": "tool", "tool_call_id": "call_1", "content": "{\"positions\":[]}"}
            ],
            "max_completion_tokens": 1000,
            "stream_options": {"include_usage": true},
            "temperature": 0.2f32,
            "tools": [{"type": "function", "function": {"name": "get_positions", "description": "Open positions", "parameters": {"type": "object", "properties": {}}}}]
        });
        assert_eq!(r.body, expected);
    }

    #[test]
    fn compat_variants() {
        let x = prep(Provider::Xai);
        assert_eq!(x.url.as_str(), "https://api.x.ai/v1/chat/completions");
        assert_eq!(x.body["max_tokens"], 1000);
        let m = prep(Provider::Mistral);
        assert_eq!(
            m.body["messages"][1]["content"][1]["image_url"],
            "data:image/png;base64,iVBORw0KGgo="
        );
        assert!(m.body.get("stream_options").is_none());
        let d = prep(Provider::DeepSeek);
        // No vision: the image becomes a note and the content collapses to plain text.
        assert!(d.body["messages"][1]["content"]
            .as_str()
            .unwrap()
            .contains("cannot read images"));
        let q = prep(Provider::Qwen);
        assert!(q
            .url
            .as_str()
            .ends_with("/compatible-mode/v1/chat/completions"));
        let o = chat(
            &convo(Provider::Ollama),
            &resolve_base(Provider::Ollama, None).unwrap(),
            None,
        );
        assert_eq!(o.url.as_str(), "http://127.0.0.1:11434/v1/chat/completions");
        assert!(o.headers.iter().all(|(k, _)| *k != "authorization"));
    }

    #[test]
    fn models_urls() {
        let a = resolve_base(Provider::Anthropic, None).unwrap();
        assert_eq!(
            models_url(Provider::Anthropic, &a).as_str(),
            "https://api.anthropic.com/v1/models?limit=1000"
        );
        let g = resolve_base(Provider::Gemini, None).unwrap();
        assert!(models_url(Provider::Gemini, &g)
            .as_str()
            .ends_with("/v1beta/models?pageSize=1000"));
    }
}
