//! Bring-your-own-key AI adapters (round 7). The desktop core makes every LLM call natively (the
//! WebView's CSP blocks direct calls), so this crate holds the parts that must be right and are
//! easy to test without a key:
//!
//! * [`provider`]: the provider catalogue, the https host allow-list and base-URL validation
//!   (custom OpenAI-compatible endpoints; Ollama / LM Studio on loopback only).
//! * [`build`]: request bodies for the three native wire formats (Anthropic Messages, Gemini
//!   `streamGenerateContent`, OpenAI-compatible chat completions) with tools and images.
//! * [`sse`] + [`decode`]: a byte-level SSE parser and per-format stream decoders that turn chunks
//!   into [`StreamEvent`]s (text, complete tool calls, usage, done).
//! * [`models`]: parsing of each provider's list-models response.
//! * [`http`]: the streaming HTTP client (timeouts, size caps, no redirects, key never logged).
//!
//! API keys are passed in by the caller (read from the encrypted vault) and only ever placed in a
//! request header; error messages coming back from providers are scrubbed of the key.

pub mod build;
pub mod decode;
pub mod http;
pub mod models;
pub mod provider;
pub mod sse;

use serde::{Deserialize, Serialize};

pub use provider::{ApiStyle, Provider};

/// One request from the UI. Neutral format; [`build`] maps it to the provider's wire format.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub provider: Provider,
    pub model: String,
    #[serde(default)]
    pub system: Option<String>,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub tools: Vec<ToolDef>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub temperature: Option<f32>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: Role,
    pub parts: Vec<Part>,
}

/// A piece of a message. Tool results travel in a `user` message (Anthropic / Gemini style);
/// the OpenAI-compatible builder turns them into `role: "tool"` messages.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Part {
    Text {
        text: String,
    },
    /// Base64 image (no `data:` prefix).
    #[serde(rename_all = "camelCase")]
    Image {
        media_type: String,
        data: String,
    },
    #[serde(rename_all = "camelCase")]
    ToolCall {
        id: String,
        name: String,
        arguments: serde_json::Value,
        /// Gemini `thoughtSignature`, echoed back unchanged on the next request.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ToolResult {
        id: String,
        name: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
}

/// A function the model may call (executed by the app, never by the provider).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    /// JSON Schema of the arguments object.
    pub parameters: serde_json::Value,
}

/// What the stream produces, in order. Tool calls are emitted once complete.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StreamEvent {
    Text {
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    ToolCall {
        id: String,
        name: String,
        arguments: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    Usage {
        input: u64,
        output: u64,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        stop_reason: String,
    },
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AiError {
    #[error("{0}")]
    BadUrl(String),
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Network(String),
    #[error("HTTP {status}: {message}")]
    Http { status: u16, message: String },
    #[error("{0}")]
    TooLarge(String),
    #[error("{0}")]
    Protocol(String),
}

impl AiError {
    /// Stable code for the UI (`ai.*`).
    pub fn code(&self) -> &'static str {
        match self {
            AiError::BadUrl(_) => "ai.bad_url",
            AiError::BadRequest(_) => "ai.bad_request",
            AiError::Network(_) => "ai.network",
            AiError::Http {
                status: 401 | 403, ..
            } => "ai.auth",
            AiError::Http { status: 429, .. } => "ai.rate_limited",
            AiError::Http { .. } => "ai.http",
            AiError::TooLarge(_) => "ai.too_large",
            AiError::Protocol(_) => "ai.protocol",
        }
    }
}

/// Request limits (also enforced by the desktop command before any network I/O).
pub mod limits {
    /// Whole JSON request body (images included).
    pub const MAX_REQUEST_BYTES: usize = 24 * 1024 * 1024;
    /// One base64 image.
    pub const MAX_IMAGE_B64: usize = 10 * 1024 * 1024;
    pub const MAX_MESSAGES: usize = 400;
    pub const MAX_TOOLS: usize = 64;
    /// Everything a stream may send back.
    pub const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
    /// A list-models response.
    pub const MAX_MODELS_BYTES: usize = 4 * 1024 * 1024;
}

/// Checks sizes and shapes before anything is sent.
pub fn validate_request(req: &ChatRequest) -> Result<(), AiError> {
    let bad = |m: &str| Err(AiError::BadRequest(m.to_string()));
    let model_ok = !req.model.is_empty()
        && req.model.len() <= 200
        && req
            .model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.:/@+".contains(c));
    if !model_ok {
        return bad("Invalid model name");
    }
    if req.messages.is_empty() || req.messages.len() > limits::MAX_MESSAGES {
        return bad("A chat needs 1–400 messages");
    }
    if req.tools.len() > limits::MAX_TOOLS {
        return bad("Too many tools");
    }
    for t in &req.tools {
        let name_ok = !t.name.is_empty()
            && t.name.len() <= 64
            && t.name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !name_ok || !t.parameters.is_object() {
            return bad("Invalid tool definition");
        }
    }
    for m in &req.messages {
        for p in &m.parts {
            if let Part::Image { media_type, data } = p {
                if !matches!(
                    media_type.as_str(),
                    "image/png" | "image/jpeg" | "image/webp"
                ) {
                    return bad("Images must be PNG, JPEG or WebP");
                }
                if data.len() > limits::MAX_IMAGE_B64 {
                    return Err(AiError::TooLarge("Image is larger than 10 MB".into()));
                }
                if !data
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
                {
                    return bad("Image data must be plain base64");
                }
            }
        }
    }
    if let Some(t) = req.temperature {
        if !(0.0..=2.0).contains(&t) {
            return bad("Temperature must be between 0 and 2");
        }
    }
    Ok(())
}

/// Replaces every occurrence of `secret` (and of an 8+ char prefix of it) in provider text.
pub fn scrub(text: &str, secret: Option<&str>) -> String {
    let mut out = text.to_string();
    if let Some(s) = secret.filter(|s| s.len() >= 8) {
        out = out.replace(s, "<key>");
        // Providers sometimes echo a masked key ("sk-abc…xyz"): hide the visible prefix too.
        let head: String = s.chars().take(12).collect();
        if head.len() >= 8 {
            out = out.replace(&head, "<key>");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> ChatRequest {
        ChatRequest {
            provider: Provider::OpenAi,
            model: "gpt-x".into(),
            system: None,
            messages: vec![Message {
                role: Role::User,
                parts: vec![Part::Text { text: "hi".into() }],
            }],
            tools: vec![],
            max_tokens: None,
            temperature: None,
        }
    }

    #[test]
    fn validates() {
        assert!(validate_request(&req()).is_ok());
        let mut r = req();
        r.model = "bad model\n".into();
        assert!(validate_request(&r).is_err());
        let mut r = req();
        r.messages[0].parts.push(Part::Image {
            media_type: "image/gif".into(),
            data: "AAAA".into(),
        });
        assert!(validate_request(&r).is_err());
        let mut r = req();
        r.messages[0].parts.push(Part::Image {
            media_type: "image/png".into(),
            data: "data:image/png;base64,AAAA".into(),
        });
        assert!(validate_request(&r).is_err());
        let mut r = req();
        r.temperature = Some(5.0);
        assert!(validate_request(&r).is_err());
        let mut r = req();
        r.tools.push(ToolDef {
            name: "place order".into(),
            description: String::new(),
            parameters: serde_json::json!({}),
        });
        assert!(validate_request(&r).is_err());
    }

    #[test]
    fn scrubs_keys() {
        let k = "sk-proj-ABCDEFGHIJKLMNOP1234567890";
        let t = format!("Incorrect API key provided: {k}. Also sk-proj-ABCD…7890");
        let s = scrub(&t, Some(k));
        assert!(!s.contains("ABCDEFGHIJ"), "{s}");
        assert!(!s.contains("sk-proj-ABCD"), "{s}");
        assert_eq!(scrub("plain", None), "plain");
    }

    #[test]
    fn json_shapes() {
        let p: Part = serde_json::from_str(
            r#"{"type":"toolResult","id":"c1","name":"get_positions","content":"[]","isError":false}"#,
        )
        .unwrap();
        assert!(matches!(p, Part::ToolResult { .. }));
        let e = serde_json::to_value(StreamEvent::Done {
            stop_reason: "end_turn".into(),
        })
        .unwrap();
        assert_eq!(
            e,
            serde_json::json!({"kind":"done","stopReason":"end_turn"})
        );
    }
}
