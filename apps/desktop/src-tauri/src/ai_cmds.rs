//! Round 7 — AI assistant, bring your own key. The UI never sees an API key after it is saved:
//! `ai_chat` / `ai_list_models` read it from the encrypted vault (`ai/<configId>/key`) and put it
//! in one request header. Calls go only to the provider allow-list in `htflow_ai::provider`
//! (custom endpoints: public https or loopback). Tokens stream to the UI over a Tauri channel;
//! `ai_cancel` stops a stream. Nothing here logs prompts, responses or keys.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use htflow_ai::{provider::resolve_base, AiError, ChatRequest, Provider, StreamEvent};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::oneshot;
use zeroize::Zeroizing;

use crate::auth_cmds::{with_session, AuthState};
use crate::error::{CmdError, CmdResult};

/// Whole-turn cap (a stream that is still producing tokens after this is stopped).
const TURN_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Default)]
pub struct AiState {
    running: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

impl From<AiError> for CmdError {
    fn from(e: AiError) -> Self {
        CmdError::new(e.code(), e.to_string())
    }
}

/// Vault key holding a provider configuration's API key (must match the UI).
pub fn vault_key(config_id: &str) -> CmdResult<String> {
    let ok = !config_id.is_empty()
        && config_id.len() <= 48
        && config_id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !ok {
        return Err(CmdError::new("ai.bad_request", "Invalid provider id"));
    }
    Ok(format!("ai/{config_id}/key"))
}

fn read_key(auth: &AuthState, config_id: &str) -> CmdResult<Option<Zeroizing<String>>> {
    let k = vault_key(config_id)?;
    Ok(with_session(auth, |s| Ok(s.vault_get(&k)))?
        .map(|v| Zeroizing::new(v.trim().to_string()))
        .filter(|v| !v.is_empty()))
}

fn key_for(
    auth: &AuthState,
    provider: Provider,
    config_id: &str,
) -> CmdResult<Option<Zeroizing<String>>> {
    let key = read_key(auth, config_id)?;
    if key.is_none() && provider.needs_key() {
        return Err(CmdError::new(
            "ai.no_key",
            "Add your API key for this provider first (AI → Providers)",
        ));
    }
    Ok(key)
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatEvent {
    Error {
        code: String,
        message: String,
    },
    #[serde(untagged)]
    Stream(StreamEvent),
}

/// Streams one assistant turn. Events: text / toolCall / usage / done, or a final `error`.
#[tauri::command]
pub async fn ai_chat(
    state: State<'_, AiState>,
    auth: State<'_, AuthState>,
    request_id: String,
    config_id: String,
    base_url: Option<String>,
    request: ChatRequest,
    channel: Channel<ChatEvent>,
) -> CmdResult<()> {
    if request_id.is_empty() || request_id.len() > 64 {
        return Err(CmdError::new("ai.bad_request", "Invalid request id"));
    }
    htflow_ai::validate_request(&request)?;
    let base = resolve_base(request.provider, base_url.as_deref())?;
    let key = key_for(&auth, request.provider, &config_id)?;
    let (tx, rx) = oneshot::channel();
    state
        .running
        .lock()
        .expect("ai lock")
        .insert(request_id.clone(), tx);
    let send = |e: StreamEvent| {
        let _ = channel.send(ChatEvent::Stream(e));
    };
    let work =
        htflow_ai::http::stream_chat(&request, &base, key.as_deref().map(|k| k.as_str()), send);
    let res = tokio::select! {
        r = tokio::time::timeout(TURN_TIMEOUT, work) => match r {
            Ok(r) => r.map_err(CmdError::from),
            Err(_) => Err(CmdError::new("ai.timeout", "The reply took longer than 10 minutes")),
        },
        _ = rx => {
            let _ = channel.send(ChatEvent::Stream(StreamEvent::Done { stop_reason: "cancelled".into() }));
            Ok(())
        }
    };
    state.running.lock().expect("ai lock").remove(&request_id);
    if let Err(e) = &res {
        let _ = channel.send(ChatEvent::Error {
            code: e.code.clone(),
            message: e.message.clone(),
        });
    }
    res
}

/// Stops a running `ai_chat` (true when one was running).
#[tauri::command]
pub fn ai_cancel(state: State<'_, AiState>, request_id: String) -> bool {
    match state.running.lock().expect("ai lock").remove(&request_id) {
        Some(tx) => tx.send(()).is_ok(),
        None => false,
    }
}

/// Models offered by the provider's list-models endpoint.
#[tauri::command]
pub async fn ai_list_models(
    auth: State<'_, AuthState>,
    provider: Provider,
    config_id: String,
    base_url: Option<String>,
) -> CmdResult<Vec<String>> {
    let base = resolve_base(provider, base_url.as_deref())?;
    let key = key_for(&auth, provider, &config_id)?;
    Ok(htflow_ai::http::list_models(provider, &base, key.as_deref().map(|k| k.as_str())).await?)
}

/// Whether a key is saved (never returns the key).
#[tauri::command]
pub fn ai_key_status(auth: State<'_, AuthState>, config_id: String) -> CmdResult<bool> {
    Ok(read_key(&auth, &config_id)?.is_some())
}

/// Validates a base URL against the allow-list without sending anything.
#[tauri::command]
pub fn ai_check_url(provider: Provider, base_url: Option<String>) -> CmdResult<String> {
    Ok(resolve_base(provider, base_url.as_deref())?.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_keys() {
        assert_eq!(vault_key("openai").unwrap(), "ai/openai/key");
        assert_eq!(vault_key("custom-ab12").unwrap(), "ai/custom-ab12/key");
        for bad in ["", "../x", "Open AI", "a/b", &"x".repeat(49)] {
            assert!(vault_key(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn events_serialise_flat() {
        let v = serde_json::to_value(ChatEvent::Stream(StreamEvent::Text { text: "a".into() }))
            .unwrap();
        assert_eq!(v, serde_json::json!({"kind": "text", "text": "a"}));
        let v = serde_json::to_value(ChatEvent::Error {
            code: "ai.auth".into(),
            message: "x".into(),
        })
        .unwrap();
        assert_eq!(v["kind"], "error");
    }
}
