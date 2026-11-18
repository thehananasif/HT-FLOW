//! Parses each provider's list-models response into sorted, de-duplicated model ids.
use serde_json::Value;

use crate::provider::ApiStyle;

pub fn parse(style: ApiStyle, body: &str) -> Result<Vec<String>, String> {
    let v: Value = serde_json::from_str(body).map_err(|_| "Unexpected model list".to_string())?;
    let mut ids: Vec<String> = match style {
        ApiStyle::Gemini => v["models"]
            .as_array()
            .ok_or("Unexpected model list")?
            .iter()
            .filter(|m| {
                m["supportedGenerationMethods"]
                    .as_array()
                    .is_none_or(|a| a.iter().any(|x| x == "generateContent"))
            })
            .filter_map(|m| m["name"].as_str())
            .map(|n| n.trim_start_matches("models/").to_string())
            .collect(),
        // Anthropic and OpenAI-compatible both use {"data":[{"id":…}]}; Ollama's /api/tags
        // shape {"models":[{"name":…}]} is accepted too.
        _ => {
            let arr = v["data"]
                .as_array()
                .or_else(|| v["models"].as_array())
                .ok_or("Unexpected model list")?;
            arr.iter()
                .filter_map(|m| m["id"].as_str().or_else(|| m["name"].as_str()))
                .map(str::to_string)
                .collect()
        }
    };
    ids.retain(|s| !s.is_empty() && s.len() <= 200);
    ids.sort();
    ids.dedup();
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lists() {
        let oa = r#"{"object":"list","data":[{"id":"gpt-b","object":"model"},{"id":"gpt-a"}]}"#;
        assert_eq!(
            parse(ApiStyle::OpenAiCompat, oa).unwrap(),
            ["gpt-a", "gpt-b"]
        );
        let an = r#"{"data":[{"type":"model","id":"claude-opus-5-5","display_name":"Claude Opus 5.5"}],"has_more":false}"#;
        assert_eq!(parse(ApiStyle::Anthropic, an).unwrap(), ["claude-opus-5-5"]);
        let ge = r#"{"models":[{"name":"models/gemini-x","supportedGenerationMethods":["generateContent"]},{"name":"models/embed","supportedGenerationMethods":["embedContent"]}]}"#;
        assert_eq!(parse(ApiStyle::Gemini, ge).unwrap(), ["gemini-x"]);
        let ol = r#"{"models":[{"name":"llama3:8b"}]}"#;
        assert_eq!(parse(ApiStyle::OpenAiCompat, ol).unwrap(), ["llama3:8b"]);
        assert!(parse(ApiStyle::OpenAiCompat, "<html>").is_err());
    }
}
