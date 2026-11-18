//! Provider catalogue and the network allow-list.
//!
//! Hosted providers: https only, and the host must be the provider's own API host (a different
//! path on that host is allowed, e.g. a regional `/v1`). Custom OpenAI-compatible endpoints:
//! https to a public host, or http(s) to loopback. Ollama / LM Studio: loopback only.
use serde::{Deserialize, Serialize};

use crate::AiError;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Xai,
    Anthropic,
    Gemini,
    #[serde(rename = "openai")]
    OpenAi,
    Mistral,
    DeepSeek,
    Qwen,
    Custom,
    Ollama,
    LmStudio,
}

/// The three wire formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiStyle {
    Anthropic,
    Gemini,
    OpenAiCompat,
}

impl Provider {
    pub const ALL: [Provider; 10] = [
        Provider::Xai,
        Provider::Anthropic,
        Provider::Gemini,
        Provider::OpenAi,
        Provider::Mistral,
        Provider::DeepSeek,
        Provider::Qwen,
        Provider::Custom,
        Provider::Ollama,
        Provider::LmStudio,
    ];

    pub fn style(self) -> ApiStyle {
        match self {
            Provider::Anthropic => ApiStyle::Anthropic,
            Provider::Gemini => ApiStyle::Gemini,
            _ => ApiStyle::OpenAiCompat,
        }
    }

    /// Default base URL (endpoints are appended to it).
    pub fn default_base(self) -> &'static str {
        match self {
            Provider::Xai => "https://api.x.ai/v1",
            Provider::Anthropic => "https://api.anthropic.com/v1",
            Provider::Gemini => "https://generativelanguage.googleapis.com/v1beta",
            Provider::OpenAi => "https://api.openai.com/v1",
            Provider::Mistral => "https://api.mistral.ai/v1",
            Provider::DeepSeek => "https://api.deepseek.com/v1",
            Provider::Qwen => "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
            Provider::Custom => "",
            Provider::Ollama => "http://127.0.0.1:11434/v1",
            Provider::LmStudio => "http://127.0.0.1:1234/v1",
        }
    }

    /// Hosts a hosted provider may be reached on (empty = custom / local rules).
    pub fn hosts(self) -> &'static [&'static str] {
        match self {
            Provider::Xai => &["api.x.ai"],
            Provider::Anthropic => &["api.anthropic.com"],
            Provider::Gemini => &["generativelanguage.googleapis.com"],
            Provider::OpenAi => &["api.openai.com"],
            Provider::Mistral => &["api.mistral.ai"],
            Provider::DeepSeek => &["api.deepseek.com"],
            Provider::Qwen => &["dashscope-intl.aliyuncs.com", "dashscope.aliyuncs.com"],
            Provider::Custom | Provider::Ollama | Provider::LmStudio => &[],
        }
    }

    /// Whether a key is required (local servers and custom endpoints may run without one).
    pub fn needs_key(self) -> bool {
        !matches!(
            self,
            Provider::Custom | Provider::Ollama | Provider::LmStudio
        )
    }

    pub fn is_local(self) -> bool {
        matches!(self, Provider::Ollama | Provider::LmStudio)
    }
}

/// `localhost`, `*.localhost`, 127.0.0.0/8 and `::1` only (no DNS lookup).
pub fn is_loopback(url: &reqwest::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            d == "localhost" || d.ends_with(".localhost")
        }
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// Private / link-local / CGNAT / unspecified literal addresses (never allowed for "custom").
fn is_private_literal(url: &reqwest::Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => {
            let o = ip.octets();
            ip.is_private()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || (o[0] == 100 && (64..128).contains(&o[1]))
        }
        Some(url::Host::Ipv6(ip)) => {
            let s0 = ip.segments()[0];
            ip.is_unspecified() || (s0 & 0xfe00) == 0xfc00 || (s0 & 0xffc0) == 0xfe80
        }
        _ => false,
    }
}

/// Resolves and validates the base URL for a request. `custom` overrides the provider default.
pub fn resolve_base(provider: Provider, custom: Option<&str>) -> Result<reqwest::Url, AiError> {
    let raw = custom
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(provider.default_base());
    if raw.is_empty() {
        return Err(AiError::BadUrl("Enter the endpoint's base URL".into()));
    }
    let url = reqwest::Url::parse(raw).map_err(|_| AiError::BadUrl("Not a valid URL".into()))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AiError::BadUrl(
            "URLs with a user name or password are not allowed".into(),
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(AiError::BadUrl(
            "The base URL may not have a query or fragment".into(),
        ));
    }
    let scheme = url.scheme();
    if scheme != "https" && scheme != "http" {
        return Err(AiError::BadUrl("Only http(s) URLs are allowed".into()));
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if host.is_empty() {
        return Err(AiError::BadUrl("The URL has no host".into()));
    }
    let loopback = is_loopback(&url);
    if provider.is_local() {
        if !loopback {
            return Err(AiError::BadUrl(
                "Local models must run on this PC (localhost / 127.0.0.1)".into(),
            ));
        }
    } else if provider == Provider::Custom {
        if loopback {
            // http or https both fine on loopback.
        } else if scheme != "https" {
            return Err(AiError::BadUrl("Remote endpoints must use https://".into()));
        } else if is_private_literal(&url) {
            return Err(AiError::BadUrl(
                "Private network addresses are not allowed; use localhost or a public https host"
                    .into(),
            ));
        }
    } else {
        let allowed = provider
            .hosts()
            .iter()
            .any(|h| *h == host.trim_end_matches('.'));
        if scheme != "https" || !allowed || url.port().is_some_and(|p| p != 443) {
            return Err(AiError::BadUrl(format!(
                "Only https://{} is allowed for this provider",
                provider.hosts().join(" or https://")
            )));
        }
    }
    Ok(url)
}

/// `base` + `/path` (keeps the base path, avoids `//`).
pub fn join(base: &reqwest::Url, path: &str) -> reqwest::Url {
    let mut u = base.clone();
    let p = format!(
        "{}/{}",
        base.path().trim_end_matches('/'),
        path.trim_start_matches('/')
    );
    u.set_path(&p);
    u
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosted_providers_are_pinned() {
        for p in Provider::ALL {
            if p == Provider::Custom {
                continue;
            }
            assert!(resolve_base(p, None).is_ok(), "{p:?}");
        }
        assert!(resolve_base(Provider::OpenAi, Some("https://api.openai.com/v1/")).is_ok());
        assert!(resolve_base(
            Provider::Qwen,
            Some("https://dashscope.aliyuncs.com/compatible-mode/v1")
        )
        .is_ok());
        for bad in [
            "http://api.openai.com/v1",
            "https://api.openai.com.evil.com/v1",
            "https://evil.com/v1",
            "https://user:pw@api.openai.com/v1",
            "https://api.openai.com:8443/v1",
            "https://api.openai.com/v1?x=1",
            "file:///etc/passwd",
        ] {
            assert!(resolve_base(Provider::OpenAi, Some(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn custom_and_local_rules() {
        assert!(resolve_base(Provider::Custom, None).is_err());
        assert!(resolve_base(Provider::Custom, Some("https://llm.example.com/v1")).is_ok());
        assert!(resolve_base(Provider::Custom, Some("http://localhost:8000/v1")).is_ok());
        assert!(resolve_base(Provider::Custom, Some("http://[::1]:8000/v1")).is_ok());
        for bad in [
            "http://llm.example.com/v1",
            "https://192.168.1.5/v1",
            "https://169.254.169.254/latest",
            "https://10.0.0.1/v1",
            "ftp://x.com",
        ] {
            assert!(resolve_base(Provider::Custom, Some(bad)).is_err(), "{bad}");
        }
        assert!(resolve_base(Provider::Ollama, Some("http://localhost:11500/v1")).is_ok());
        assert!(resolve_base(Provider::LmStudio, Some("https://example.com/v1")).is_err());
        assert!(resolve_base(Provider::Ollama, Some("http://192.168.1.2:11434/v1")).is_err());
    }

    #[test]
    fn joins_paths() {
        let b = resolve_base(Provider::Qwen, None).unwrap();
        assert_eq!(
            join(&b, "/chat/completions").as_str(),
            "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"
        );
        let b = reqwest::Url::parse("https://api.openai.com/v1/").unwrap();
        assert_eq!(
            join(&b, "models").as_str(),
            "https://api.openai.com/v1/models"
        );
    }
}
