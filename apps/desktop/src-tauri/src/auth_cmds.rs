use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use htflow_auth::{NewProfile, PinPepper, Prefs, ProfileStore, ProfileSummary, Session};
use serde::{Deserialize, Serialize};
use tauri::State;
use zeroize::Zeroizing;

use crate::error::{CmdError, CmdResult};

const KEYRING_SERVICE: &str = "HTFlow";
const LAST_PROFILE: &str = "last_profile";

/// Per-profile PIN pepper in the OS credential store (Windows Credential Manager, DPAPI-protected
/// for the signed-in Windows user). A copied profile folder alone is therefore not enough to
/// brute-force the 6-digit PIN offline.
pub struct KeyringPepper;

impl PinPepper for KeyringPepper {
    fn pepper(&self, profile_id: &str, create: bool) -> Option<Zeroizing<Vec<u8>>> {
        let entry =
            keyring::Entry::new(KEYRING_SERVICE, &format!("pin-pepper:{profile_id}")).ok()?;
        if let Ok(s) = entry.get_password() {
            let s = Zeroizing::new(s);
            if let Ok(b) = B64.decode(s.as_bytes()) {
                if b.len() == 32 {
                    return Some(Zeroizing::new(b));
                }
            }
        }
        if !create {
            return None;
        }
        let mut b = Zeroizing::new(vec![0u8; 32]);
        htflow_auth::fill_random(&mut b);
        let enc = Zeroizing::new(B64.encode(&*b));
        entry.set_password(&enc).ok()?;
        // Read back: refuse a PIN when the store silently drops writes (e.g. no secret service).
        let back = Zeroizing::new(entry.get_password().ok()?);
        (*back == *enc).then_some(b)
    }
}

pub struct AuthState {
    pub store: Arc<ProfileStore>,
    pub session: Arc<Mutex<Option<Session>>>,
    /// Set by Lock (Ctrl+L) so "Remember me" cannot bypass the lock screen in this run.
    pub locked: AtomicBool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAccountInput {
    display_name: String,
    username: String,
    email: Option<String>,
    password: String,
    timezone: String,
    theme: String,
    remember_me: bool,
    pin: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    profile_id: String,
    username: String,
    display_name: String,
    timezone: String,
    theme: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateResult {
    session: SessionInfo,
    recovery_code: Vec<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn info(s: &Session) -> SessionInfo {
    let p = s.prefs();
    SessionInfo {
        profile_id: s.profile_id.clone(),
        username: s.username.clone(),
        display_name: s.display_name.clone(),
        timezone: if p.timezone.is_empty() {
            "UTC".into()
        } else {
            p.timezone
        },
        theme: if p.theme.is_empty() {
            "dark".into()
        } else {
            p.theme
        },
    }
}

/// Runs CPU-heavy Argon2 work off the async runtime threads.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> CmdResult<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| CmdError::new("internal", e.to_string()))?
}

fn remember(store: &ProfileStore, s: &Session) {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &s.profile_id);
    if let Ok(entry) = entry {
        if entry.set_password(&B64.encode(s.data_key())).is_ok() {
            let _ = std::fs::write(store.root().join(LAST_PROFILE), &s.profile_id);
        }
    }
}

fn forget(store: &ProfileStore, profile_id: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, profile_id) {
        let _ = entry.delete_credential();
    }
    let _ = std::fs::remove_file(store.root().join(LAST_PROFILE));
}

fn set_session(state: &AuthState, s: Session) -> SessionInfo {
    let i = info(&s);
    *state.session.lock().expect("session lock") = Some(s);
    state.locked.store(false, Ordering::SeqCst);
    i
}

pub(crate) fn with_session<T>(
    state: &AuthState,
    f: impl FnOnce(&mut Session) -> CmdResult<T>,
) -> CmdResult<T> {
    let mut g = state.session.lock().expect("session lock");
    match g.as_mut() {
        Some(s) => f(s),
        None => Err(CmdError::new("auth.locked", "Not logged in")),
    }
}

#[tauri::command]
pub async fn auth_list_profiles(state: State<'_, AuthState>) -> CmdResult<Vec<ProfileSummary>> {
    Ok(state.store.list()?)
}

#[tauri::command]
pub async fn auth_create_account(
    state: State<'_, AuthState>,
    input: CreateAccountInput,
) -> CmdResult<CreateResult> {
    let store = state.store.clone();
    let remember_me = input.remember_me;
    let (session, words) = blocking(move || {
        let pw = Zeroizing::new(input.password);
        let pin = input.pin.map(Zeroizing::new);
        Ok(store.create(
            NewProfile {
                username: &input.username,
                display_name: &input.display_name,
                password: &pw,
                prefs: Prefs {
                    timezone: input.timezone,
                    theme: input.theme,
                    email: input.email,
                },
                pin: pin.as_deref().map(String::as_str),
            },
            now_ms(),
        )?)
    })
    .await?;
    if remember_me {
        remember(&state.store, &session);
    }
    Ok(CreateResult {
        session: set_session(&state, session),
        recovery_code: words,
    })
}

#[tauri::command]
pub async fn auth_login(
    state: State<'_, AuthState>,
    username: String,
    password: String,
    remember: bool,
) -> CmdResult<SessionInfo> {
    let store = state.store.clone();
    let session = blocking(move || {
        let pw = Zeroizing::new(password);
        Ok(store.login(&username, &pw, now_ms())?)
    })
    .await?;
    if remember {
        self::remember(&state.store, &session);
    } else {
        forget(&state.store, &session.profile_id);
    }
    Ok(set_session(&state, session))
}

#[tauri::command]
pub async fn auth_auto_login(state: State<'_, AuthState>) -> CmdResult<Option<SessionInfo>> {
    if state.locked.load(Ordering::SeqCst) || state.session.lock().expect("session lock").is_some()
    {
        return Ok(None);
    }
    let Ok(id) = std::fs::read_to_string(state.store.root().join(LAST_PROFILE)) else {
        return Ok(None);
    };
    let id = id.trim().to_string();
    let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &id) else {
        return Ok(None);
    };
    let Ok(secret) = entry.get_password() else {
        return Ok(None);
    };
    let Ok(bytes) = B64.decode(secret) else {
        return Ok(None);
    };
    let bytes = Zeroizing::new(bytes);
    if bytes.len() != 32 {
        return Ok(None);
    }
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&bytes);
    match state.store.session_from_key(&id, &key) {
        Ok(s) => Ok(Some(set_session(&state, s))),
        Err(_) => {
            forget(&state.store, &id);
            Ok(None)
        }
    }
}

#[tauri::command]
pub async fn auth_unlock_pin(
    state: State<'_, AuthState>,
    username: String,
    pin: String,
) -> CmdResult<SessionInfo> {
    let store = state.store.clone();
    let pin = Zeroizing::new(pin);
    let s = blocking(move || Ok(store.unlock_pin(&username, &pin)?)).await?;
    Ok(set_session(&state, s))
}

#[tauri::command]
pub async fn auth_set_pin(state: State<'_, AuthState>, pin: Option<String>) -> CmdResult<()> {
    let pin = pin.map(Zeroizing::new);
    let store = state.store.clone();
    let sess = state.session.clone();
    blocking(move || {
        let g = sess.lock().expect("session lock");
        let s = g
            .as_ref()
            .ok_or_else(|| CmdError::new("auth.locked", "Not logged in"))?;
        Ok(store.set_pin(s, pin.as_deref().map(String::as_str))?)
    })
    .await
}

#[tauri::command]
pub async fn auth_change_password(
    state: State<'_, AuthState>,
    old_password: String,
    new_password: String,
) -> CmdResult<()> {
    let (old_password, new_password) = (Zeroizing::new(old_password), Zeroizing::new(new_password));
    let store = state.store.clone();
    let sess = state.session.clone();
    blocking(move || {
        let g = sess.lock().expect("session lock");
        let s = g
            .as_ref()
            .ok_or_else(|| CmdError::new("auth.locked", "Not logged in"))?;
        Ok(store.change_password(s, &old_password, &new_password)?)
    })
    .await
}

#[tauri::command]
pub async fn auth_recover(
    state: State<'_, AuthState>,
    username: String,
    words: Vec<String>,
    new_password: String,
) -> CmdResult<()> {
    let (words, new_password) = (Zeroizing::new(words), Zeroizing::new(new_password));
    let store = state.store.clone();
    blocking(move || Ok(store.recover(&username, &words, &new_password)?)).await
}

#[tauri::command]
pub async fn auth_lock(state: State<'_, AuthState>) -> CmdResult<()> {
    state.locked.store(true, Ordering::SeqCst);
    *state.session.lock().expect("session lock") = None;
    Ok(())
}

#[tauri::command]
pub async fn auth_logout(state: State<'_, AuthState>) -> CmdResult<()> {
    let id = state
        .session
        .lock()
        .expect("session lock")
        .take()
        .map(|s| s.profile_id);
    if let Some(id) = id {
        forget(&state.store, &id);
    }
    Ok(())
}

#[tauri::command]
pub async fn auth_export_profile(state: State<'_, AuthState>) -> CmdResult<String> {
    let g = state.session.lock().expect("session lock");
    let s = g
        .as_ref()
        .ok_or_else(|| CmdError::new("auth.locked", "Not logged in"))?;
    Ok(state.store.export(s)?)
}

#[tauri::command]
pub async fn auth_import_profile(
    state: State<'_, AuthState>,
    bundle: String,
) -> CmdResult<ProfileSummary> {
    Ok(state.store.import(&bundle)?)
}

#[tauri::command]
pub async fn settings_get(state: State<'_, AuthState>, key: String) -> CmdResult<Option<String>> {
    with_session(&state, |s| Ok(s.settings_get(&key)))
}

#[tauri::command]
pub async fn settings_set(
    state: State<'_, AuthState>,
    key: String,
    value: String,
) -> CmdResult<()> {
    with_session(&state, |s| Ok(s.settings_set(&key, value)?))
}

#[tauri::command]
pub async fn vault_put(state: State<'_, AuthState>, key: String, secret: String) -> CmdResult<()> {
    if key.len() > 256 || secret.len() > 64 * 1024 {
        return Err(CmdError::new("vault.too_large", "Vault entry is too large"));
    }
    with_session(&state, |s| Ok(s.vault_put(&key, secret)?))
}

#[tauri::command]
pub async fn vault_get(state: State<'_, AuthState>, key: String) -> CmdResult<Option<String>> {
    with_session(&state, |s| Ok(s.vault_get(&key)))
}
