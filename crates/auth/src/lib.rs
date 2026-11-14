//! Local accounts (P03) — no server.
//!
//! Each profile has a random 256-bit *data key*. The data key encrypts the profile's settings and
//! credential vault (XChaCha20-Poly1305, see `htflow-vault`). It is stored only *wrapped*:
//! once under a key derived from the password (Argon2id, m=64 MiB, t=3, p=1), once under the
//! 24-word recovery code, and optionally under a 6-digit PIN. A wrong password therefore never
//! decrypts anything, and "Forgot password" works only with the recovery code shown at sign-up.
//!
//! A 6-digit PIN has only 10^6 values, so on its own it could be brute-forced offline from a copied
//! `profile.json`. The PIN wrap therefore also mixes in a per-profile random *pepper* that lives
//! outside the profile folder (the OS credential store, see [`PinPepper`]); exported `.htprofile`
//! bundles never carry the PIN wrap at all.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use htflow_vault::{open, random_key, seal, write_atomic, Key, SealedMap, VaultError, KEY_LEN};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

const WORDLIST: &str = include_str!("wordlist.txt");
pub const RECOVERY_WORDS: usize = 24;
pub const MIN_PASSWORD: usize = 10;
const PIN_MAX_FAILURES: u32 = 5;
const META_FILE: &str = "profile.json";
const SETTINGS_FILE: &str = "settings.bin";
const VAULT_FILE: &str = "vault.bin";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

impl KdfParams {
    /// Spec: Argon2id m = 64 MB, t = 3, p = 1.
    pub const PRODUCTION: KdfParams = KdfParams {
        m_kib: 64 * 1024,
        t: 3,
        p: 1,
    };

    /// Bounds accepted from disk / imported bundles. Parameters come from files an attacker may
    /// have written (a crafted `.htprofile`), so they must not be able to request gigabytes of
    /// memory, hours of CPU or values that make Argon2 refuse to run.
    pub fn is_sane(&self) -> bool {
        (8..=1024 * 1024).contains(&self.m_kib)
            && (1..=16).contains(&self.t)
            && (1..=8).contains(&self.p)
            && self.m_kib >= 8 * self.p
    }
}

/// Supplies the per-profile PIN pepper kept outside the profile folder (Windows: the Credential
/// Manager). `create` asks for a new random pepper when none exists yet. Returning `None` means
/// the pepper is unavailable, so a PIN cannot be set or used on this machine.
pub trait PinPepper: Send + Sync {
    fn pepper(&self, profile_id: &str, create: bool) -> Option<Zeroizing<Vec<u8>>>;
}

/// Fills `buf` from the OS CSPRNG (for callers that keep auth secrets, e.g. the PIN pepper).
pub fn fill_random(buf: &mut [u8]) {
    rand::rngs::OsRng.fill_bytes(buf);
}

/// Longest display name kept from user input or an imported bundle.
pub const MAX_DISPLAY_NAME: usize = 64;

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("No profile with that username on this PC")]
    UnknownUser,
    #[error("That username already exists on this PC")]
    Exists,
    #[error("Wrong username or password")]
    InvalidCredentials,
    #[error("Too many failed attempts — try again in {0} s")]
    LockedOut(u64),
    #[error("No PIN is set for this profile")]
    NoPin,
    #[error("PIN disabled after too many failed attempts — log in with your password")]
    PinLockedOut,
    #[error("Wrong PIN")]
    InvalidPin,
    #[error("Password must be at least {MIN_PASSWORD} characters")]
    WeakPassword,
    #[error("Username must be 3–32 letters, digits, '.', '_' or '-'")]
    InvalidUsername,
    #[error("PIN must be exactly 6 digits")]
    PinFormat,
    #[error("Recovery code is not valid for this profile")]
    InvalidRecovery,
    #[error("Not a valid .htprofile file")]
    Format,
    #[error("A PIN needs the Windows credential store, which is not available")]
    PinUnavailable,
    #[error("Storage error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Encrypted storage error: {0}")]
    Vault(#[from] VaultError),
    #[error("Serialization error: {0}")]
    Json(#[from] serde_json::Error),
}

impl AuthError {
    /// Stable machine-readable code for the UI.
    pub fn code(&self) -> &'static str {
        match self {
            AuthError::UnknownUser => "auth.unknown_user",
            AuthError::Exists => "auth.exists",
            AuthError::InvalidCredentials => "auth.invalid",
            AuthError::LockedOut(_) => "auth.locked_out",
            AuthError::NoPin => "auth.no_pin",
            AuthError::PinLockedOut => "auth.pin_locked",
            AuthError::InvalidPin => "auth.invalid_pin",
            AuthError::WeakPassword => "auth.weak_password",
            AuthError::InvalidUsername => "auth.invalid_username",
            AuthError::PinFormat => "auth.pin_format",
            AuthError::InvalidRecovery => "auth.invalid_recovery",
            AuthError::Format => "auth.format",
            AuthError::PinUnavailable => "auth.pin_unavailable",
            AuthError::Io(_) | AuthError::Vault(_) | AuthError::Json(_) => "internal",
        }
    }
}

pub type Result<T> = std::result::Result<T, AuthError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WrappedKey {
    pub salt: String,
    pub kdf: KdfParams,
    pub blob: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProfileMeta {
    pub format: u32,
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub created_at: i64,
    pub wrapped_password: WrappedKey,
    pub wrapped_recovery: WrappedKey,
    #[serde(default)]
    pub wrapped_pin: Option<WrappedKey>,
    /// The PIN wrap mixes in the [`PinPepper`] (false for PINs set before round 6).
    #[serde(default)]
    pub pin_peppered: bool,
    #[serde(default)]
    pub pin_failures: u32,
    #[serde(default)]
    pub failed_attempts: u32,
    #[serde(default)]
    pub locked_until_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSummary {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub created_at: i64,
    pub has_pin: bool,
}

/// Encrypted per-profile preferences (email stays local and encrypted too).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct Prefs {
    pub timezone: String,
    pub theme: String,
    #[serde(default)]
    pub email: Option<String>,
}

pub struct NewProfile<'a> {
    pub username: &'a str,
    pub display_name: &'a str,
    pub password: &'a str,
    pub prefs: Prefs,
    pub pin: Option<&'a str>,
}

#[derive(Serialize, Deserialize)]
struct Bundle {
    format: String,
    version: u32,
    meta: ProfileMeta,
    settings: Option<String>,
    vault: Option<String>,
}

fn words() -> Vec<&'static str> {
    WORDLIST
        .lines()
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .collect()
}

fn valid_username(u: &str) -> bool {
    (3..=32).contains(&u.len())
        && u.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn valid_pin(p: &str) -> bool {
    p.len() == 6 && p.chars().all(|c| c.is_ascii_digit())
}

/// Argon2id. `None` for parameters outside [`KdfParams::is_sane`] or a salt shorter than 8 bytes
/// (both can only come from a tampered or crafted file), instead of panicking or allocating
/// whatever the file asks for.
fn derive(secret: &[u8], salt: &[u8], kdf: KdfParams) -> Option<Key> {
    if !kdf.is_sane() || !(8..=64).contains(&salt.len()) {
        return None;
    }
    let params = Params::new(kdf.m_kib, kdf.t, kdf.p, Some(KEY_LEN)).ok()?;
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(secret, salt, out.as_mut())
        .ok()?;
    Some(out)
}

fn wrap(data_key: &[u8; KEY_LEN], secret: &[u8], kdf: KdfParams, purpose: &[u8]) -> WrappedKey {
    let mut salt = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    // Our own parameters (PRODUCTION or the test set) are always sane.
    let kek = derive(secret, &salt, kdf).expect("sane Argon2id parameters");
    WrappedKey {
        salt: B64.encode(salt),
        kdf,
        blob: B64.encode(seal(&kek, data_key, purpose)),
    }
}

fn unwrap(w: &WrappedKey, secret: &[u8], purpose: &[u8]) -> Option<Key> {
    let salt = B64.decode(&w.salt).ok()?;
    let blob = B64.decode(&w.blob).ok()?;
    let kek = derive(secret, &salt, w.kdf)?;
    let plain = open(&kek, &blob, purpose).ok()?;
    if plain.len() != KEY_LEN {
        return None;
    }
    let mut k = Zeroizing::new([0u8; KEY_LEN]);
    k.copy_from_slice(&plain);
    Some(k)
}

/// PIN wrap secret: the PIN, a separator and the pepper (when one is used).
fn pin_secret(pin: &str, pepper: Option<&[u8]>) -> Zeroizing<Vec<u8>> {
    let mut v = Zeroizing::new(Vec::with_capacity(
        pin.len() + 1 + pepper.map_or(0, <[u8]>::len),
    ));
    v.extend_from_slice(pin.as_bytes());
    if let Some(p) = pepper {
        v.push(0);
        v.extend_from_slice(p);
    }
    v
}

/// Display names are shown in the UI and written to files: trimmed, no control characters and no
/// bidi overrides (which could make one profile name look like another).
fn clean_display_name(s: &str) -> String {
    s.trim()
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(MAX_DISPLAY_NAME)
        .collect()
}

/// Structural checks for a wrapped key read from an untrusted file.
fn sane_wrapped(w: &WrappedKey) -> bool {
    w.kdf.is_sane()
        && B64
            .decode(&w.salt)
            .is_ok_and(|s| (8..=64).contains(&s.len()))
        && B64.decode(&w.blob).is_ok_and(|b| b.len() <= 256)
}

fn normalize_recovery(words: &[String]) -> String {
    words
        .iter()
        .map(|w| w.trim().to_lowercase())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Exponential back-off after the 3rd consecutive failure: 1, 2, 4 … 300 s.
pub fn lockout_seconds(failures: u32) -> u64 {
    if failures < 3 {
        0
    } else {
        (1u64 << (failures - 3).min(9)).min(300)
    }
}

/// An unlocked profile. Holds the data key in memory (zeroized on drop).
pub struct Session {
    pub profile_id: String,
    pub username: String,
    pub display_name: String,
    dir: PathBuf,
    key: Key,
    settings: SealedMap,
    vault: SealedMap,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("profile_id", &self.profile_id)
            .field("username", &self.username)
            .finish()
    }
}

impl Session {
    fn open(dir: &Path, meta: &ProfileMeta, key: Key) -> Result<Session> {
        let settings = SealedMap::open(dir.join(SETTINGS_FILE), &key, b"htflow.settings")?;
        let vault = SealedMap::open(dir.join(VAULT_FILE), &key, b"htflow.vault")?;
        Ok(Session {
            profile_id: meta.id.clone(),
            username: meta.username.clone(),
            display_name: meta.display_name.clone(),
            dir: dir.to_path_buf(),
            key,
            settings,
            vault,
        })
    }

    /// The raw data key (only for "Remember me" in the OS credential store).
    pub fn data_key(&self) -> &[u8; KEY_LEN] {
        &self.key
    }

    pub fn settings_get(&self, key: &str) -> Option<String> {
        self.settings.get(key).map(str::to_string)
    }

    pub fn settings_set(&mut self, key: &str, value: String) -> Result<()> {
        Ok(self.settings.put(key, value)?)
    }

    pub fn vault_get(&self, key: &str) -> Option<String> {
        self.vault.get(key).map(str::to_string)
    }

    pub fn vault_put(&mut self, key: &str, secret: String) -> Result<()> {
        Ok(self.vault.put(key, secret)?)
    }

    pub fn prefs(&self) -> Prefs {
        self.settings_get("__prefs")
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

/// All profiles on this PC under `<root>/profiles/<id>/`.
pub struct ProfileStore {
    root: PathBuf,
    kdf: KdfParams,
    pepper: Option<Arc<dyn PinPepper>>,
}

impl ProfileStore {
    pub fn new(root: impl Into<PathBuf>, kdf: KdfParams) -> Self {
        Self {
            root: root.into(),
            kdf,
            pepper: None,
        }
    }

    /// Uses `pepper` for PIN wraps. Without one, PINs are wrapped with the PIN alone (tests,
    /// platforms without a credential store).
    pub fn with_pin_pepper(mut self, pepper: Arc<dyn PinPepper>) -> Self {
        self.pepper = Some(pepper);
        self
    }

    /// Wraps the data key under a PIN. Returns `(wrap, peppered)`.
    fn wrap_pin(
        &self,
        profile_id: &str,
        data_key: &[u8; KEY_LEN],
        pin: &str,
    ) -> Result<(WrappedKey, bool)> {
        match &self.pepper {
            Some(p) => {
                let pepper = p
                    .pepper(profile_id, true)
                    .ok_or(AuthError::PinUnavailable)?;
                let secret = pin_secret(pin, Some(&pepper));
                Ok((wrap(data_key, &secret, self.kdf, b"pin"), true))
            }
            None => Ok((wrap(data_key, pin.as_bytes(), self.kdf, b"pin"), false)),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn profiles_dir(&self) -> PathBuf {
        self.root.join("profiles")
    }

    fn load_all(&self) -> Result<Vec<(PathBuf, ProfileMeta)>> {
        let dir = self.profiles_dir();
        let mut out = Vec::new();
        if !dir.exists() {
            return Ok(out);
        }
        for entry in fs::read_dir(dir)? {
            let p = entry?.path();
            let meta_path = p.join(META_FILE);
            if meta_path.is_file() {
                if let Ok(m) = serde_json::from_slice::<ProfileMeta>(&fs::read(&meta_path)?) {
                    out.push((p, m));
                }
            }
        }
        out.sort_by_key(|(_, m)| m.created_at);
        Ok(out)
    }

    fn find(&self, username: &str) -> Result<(PathBuf, ProfileMeta)> {
        self.load_all()?
            .into_iter()
            .find(|(_, m)| m.username.eq_ignore_ascii_case(username.trim()))
            .ok_or(AuthError::UnknownUser)
    }

    fn find_id(&self, id: &str) -> Result<(PathBuf, ProfileMeta)> {
        self.load_all()?
            .into_iter()
            .find(|(_, m)| m.id == id)
            .ok_or(AuthError::UnknownUser)
    }

    fn save_meta(dir: &Path, meta: &ProfileMeta) -> Result<()> {
        write_atomic(&dir.join(META_FILE), &serde_json::to_vec_pretty(meta)?)?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<ProfileSummary>> {
        Ok(self
            .load_all()?
            .into_iter()
            .map(|(_, m)| ProfileSummary {
                has_pin: m.wrapped_pin.is_some(),
                id: m.id,
                username: m.username,
                display_name: m.display_name,
                created_at: m.created_at,
            })
            .collect())
    }

    /// Creates a profile and returns the unlocked session plus the 24-word recovery code.
    pub fn create(&self, input: NewProfile<'_>, now_ms: i64) -> Result<(Session, Vec<String>)> {
        if !valid_username(input.username) {
            return Err(AuthError::InvalidUsername);
        }
        if input.password.chars().count() < MIN_PASSWORD {
            return Err(AuthError::WeakPassword);
        }
        if let Some(pin) = input.pin {
            if !valid_pin(pin) {
                return Err(AuthError::PinFormat);
            }
        }
        if self.find(input.username).is_ok() {
            return Err(AuthError::Exists);
        }
        let list = words();
        let mut idx = [0u8; RECOVERY_WORDS];
        rand::rngs::OsRng.fill_bytes(&mut idx);
        let recovery: Vec<String> = idx
            .iter()
            .map(|i| list[*i as usize % list.len()].to_string())
            .collect();
        let data_key = random_key();
        let id = uuid::Uuid::new_v4().to_string();
        let pin = match input.pin {
            Some(p) => Some(self.wrap_pin(&id, &data_key, p)?),
            None => None,
        };
        let meta = ProfileMeta {
            format: 1,
            id,
            username: input.username.trim().to_string(),
            display_name: clean_display_name(input.display_name),
            created_at: now_ms,
            wrapped_password: wrap(&data_key, input.password.as_bytes(), self.kdf, b"pw"),
            wrapped_recovery: wrap(
                &data_key,
                normalize_recovery(&recovery).as_bytes(),
                self.kdf,
                b"rec",
            ),
            pin_peppered: pin.as_ref().is_some_and(|(_, p)| *p),
            wrapped_pin: pin.map(|(w, _)| w),
            pin_failures: 0,
            failed_attempts: 0,
            locked_until_ms: 0,
        };
        let dir = self.profiles_dir().join(&meta.id);
        fs::create_dir_all(&dir)?;
        Self::save_meta(&dir, &meta)?;
        let mut session = Session::open(&dir, &meta, data_key)?;
        session.settings_set("__prefs", serde_json::to_string(&input.prefs)?)?;
        Ok((session, recovery))
    }

    pub fn login(&self, username: &str, password: &str, now_ms: i64) -> Result<Session> {
        let (dir, mut meta) = self.find(username)?;
        if meta.locked_until_ms > now_ms {
            return Err(AuthError::LockedOut(
                ((meta.locked_until_ms - now_ms) as u64).div_ceil(1000),
            ));
        }
        match unwrap(&meta.wrapped_password, password.as_bytes(), b"pw") {
            Some(key) => {
                if meta.failed_attempts != 0 || meta.locked_until_ms != 0 {
                    meta.failed_attempts = 0;
                    meta.locked_until_ms = 0;
                    Self::save_meta(&dir, &meta)?;
                }
                Session::open(&dir, &meta, key)
            }
            None => {
                meta.failed_attempts = meta.failed_attempts.saturating_add(1);
                meta.locked_until_ms = now_ms + lockout_seconds(meta.failed_attempts) as i64 * 1000;
                Self::save_meta(&dir, &meta)?;
                Err(AuthError::InvalidCredentials)
            }
        }
    }

    pub fn unlock_pin(&self, username: &str, pin: &str) -> Result<Session> {
        let (dir, mut meta) = self.find(username)?;
        let wrapped = meta.wrapped_pin.clone().ok_or(AuthError::NoPin)?;
        let secret = if meta.pin_peppered {
            // The pepper lives in this machine's credential store; without it the PIN is unusable.
            let pepper = self
                .pepper
                .as_ref()
                .and_then(|p| p.pepper(&meta.id, false))
                .ok_or(AuthError::NoPin)?;
            pin_secret(pin, Some(&pepper))
        } else {
            pin_secret(pin, None)
        };
        match unwrap(&wrapped, &secret, b"pin") {
            Some(key) => {
                let mut dirty = meta.pin_failures != 0;
                meta.pin_failures = 0;
                if !meta.pin_peppered && self.pepper.is_some() {
                    // Upgrade a PIN set before peppering existed. Keep the old wrap if the
                    // credential store is unavailable right now.
                    if let Ok((w, true)) = self.wrap_pin(&meta.id, &key, pin) {
                        meta.wrapped_pin = Some(w);
                        meta.pin_peppered = true;
                        dirty = true;
                    }
                }
                if dirty {
                    Self::save_meta(&dir, &meta)?;
                }
                Session::open(&dir, &meta, key)
            }
            None => {
                meta.pin_failures = meta.pin_failures.saturating_add(1);
                let locked = meta.pin_failures >= PIN_MAX_FAILURES;
                if locked {
                    meta.wrapped_pin = None;
                    meta.pin_peppered = false;
                    meta.pin_failures = 0;
                }
                Self::save_meta(&dir, &meta)?;
                Err(if locked {
                    AuthError::PinLockedOut
                } else {
                    AuthError::InvalidPin
                })
            }
        }
    }

    /// Restores a session from a data key kept in the OS credential store ("Remember me").
    pub fn session_from_key(&self, profile_id: &str, key: &[u8; KEY_LEN]) -> Result<Session> {
        let (dir, meta) = self.find_id(profile_id)?;
        Session::open(&dir, &meta, Zeroizing::new(*key)).map_err(|_| AuthError::InvalidCredentials)
    }

    pub fn change_password(&self, session: &Session, old: &str, new: &str) -> Result<()> {
        if new.chars().count() < MIN_PASSWORD {
            return Err(AuthError::WeakPassword);
        }
        let (dir, mut meta) = self.find_id(&session.profile_id)?;
        unwrap(&meta.wrapped_password, old.as_bytes(), b"pw")
            .ok_or(AuthError::InvalidCredentials)?;
        meta.wrapped_password = wrap(session.data_key(), new.as_bytes(), self.kdf, b"pw");
        Self::save_meta(&dir, &meta)
    }

    /// "Forgot password": proves knowledge of the recovery code and sets a new password.
    pub fn recover(&self, username: &str, recovery: &[String], new_password: &str) -> Result<()> {
        if new_password.chars().count() < MIN_PASSWORD {
            return Err(AuthError::WeakPassword);
        }
        let (dir, mut meta) = self.find(username)?;
        let key = unwrap(
            &meta.wrapped_recovery,
            normalize_recovery(recovery).as_bytes(),
            b"rec",
        )
        .ok_or(AuthError::InvalidRecovery)?;
        meta.wrapped_password = wrap(&key, new_password.as_bytes(), self.kdf, b"pw");
        meta.failed_attempts = 0;
        meta.locked_until_ms = 0;
        Self::save_meta(&dir, &meta)
    }

    pub fn set_pin(&self, session: &Session, pin: Option<&str>) -> Result<()> {
        if let Some(p) = pin {
            if !valid_pin(p) {
                return Err(AuthError::PinFormat);
            }
        }
        let (dir, mut meta) = self.find_id(&session.profile_id)?;
        let w = match pin {
            Some(p) => Some(self.wrap_pin(&meta.id, session.data_key(), p)?),
            None => None,
        };
        meta.pin_peppered = w.as_ref().is_some_and(|(_, p)| *p);
        meta.wrapped_pin = w.map(|(w, _)| w);
        meta.pin_failures = 0;
        Self::save_meta(&dir, &meta)
    }

    /// Encrypted `.htprofile` bundle: metadata with wrapped keys + sealed settings and vault.
    /// The PIN wrap is left out: a 6-digit PIN is far too weak to protect a file that may be
    /// copied to a USB stick or a cloud folder (set the PIN again after importing).
    pub fn export(&self, session: &Session) -> Result<String> {
        let (dir, mut meta) = self.find_id(&session.profile_id)?;
        meta.wrapped_pin = None;
        meta.pin_peppered = false;
        meta.pin_failures = 0;
        meta.failed_attempts = 0;
        meta.locked_until_ms = 0;
        let read = |f: &str| -> Result<Option<String>> {
            let p = dir.join(f);
            Ok(if p.exists() {
                Some(B64.encode(fs::read(p)?))
            } else {
                None
            })
        };
        let bundle = Bundle {
            format: "htprofile".into(),
            version: 1,
            meta,
            settings: read(SETTINGS_FILE)?,
            vault: read(VAULT_FILE)?,
        };
        Ok(serde_json::to_string_pretty(&bundle)?)
    }

    pub fn import(&self, text: &str) -> Result<ProfileSummary> {
        let bundle: Bundle = serde_json::from_str(text).map_err(|_| AuthError::Format)?;
        if bundle.format != "htprofile" || bundle.version != 1 {
            return Err(AuthError::Format);
        }
        let mut meta = bundle.meta;
        // Everything in the bundle is untrusted (a double-clicked file imports straight away).
        // The id becomes a directory name, so only a canonical UUID is ever used as one:
        // `../../x` or `C:\x` would otherwise write profile files outside the profiles folder.
        if meta.format != 1
            || !valid_username(meta.username.trim())
            || !sane_wrapped(&meta.wrapped_password)
            || !sane_wrapped(&meta.wrapped_recovery)
        {
            return Err(AuthError::Format);
        }
        meta.username = meta.username.trim().to_string();
        meta.display_name = clean_display_name(&meta.display_name);
        if meta.display_name.is_empty() {
            meta.display_name = meta.username.clone();
        }
        if self.find(&meta.username).is_ok() {
            return Err(AuthError::Exists);
        }
        let canonical = uuid::Uuid::parse_str(&meta.id)
            .ok()
            .map(|u| u.hyphenated().to_string())
            .filter(|c| *c == meta.id);
        if canonical.is_none() || self.find_id(&meta.id).is_ok() {
            meta.id = uuid::Uuid::new_v4().to_string();
        }
        // A PIN wrap from elsewhere is never trusted (weak secret, foreign pepper).
        meta.wrapped_pin = None;
        meta.pin_peppered = false;
        meta.pin_failures = 0;
        let dir = self.profiles_dir().join(&meta.id);
        fs::create_dir_all(&dir)?;
        for (name, data) in [
            (SETTINGS_FILE, &bundle.settings),
            (VAULT_FILE, &bundle.vault),
        ] {
            if let Some(d) = data {
                write_atomic(
                    &dir.join(name),
                    &B64.decode(d).map_err(|_| AuthError::Format)?,
                )?;
            }
        }
        meta.failed_attempts = 0;
        meta.locked_until_ms = 0;
        Self::save_meta(&dir, &meta)?;
        Ok(ProfileSummary {
            has_pin: meta.wrapped_pin.is_some(),
            id: meta.id,
            username: meta.username,
            display_name: meta.display_name,
            created_at: meta.created_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAST: KdfParams = KdfParams {
        m_kib: 1024,
        t: 1,
        p: 1,
    };

    fn new<'a>(u: &'a str, pw: &'a str) -> NewProfile<'a> {
        NewProfile {
            username: u,
            display_name: u,
            password: pw,
            prefs: Prefs {
                timezone: "Asia/Karachi".into(),
                theme: "dark".into(),
                email: None,
            },
            pin: Some("123456"),
        }
    }

    #[test]
    fn production_kdf_matches_spec() {
        assert_eq!(
            KdfParams::PRODUCTION,
            KdfParams {
                m_kib: 65536,
                t: 3,
                p: 1
            }
        );
        // Derivation is deterministic for the same salt and differs per secret.
        let a = derive(b"password-1", b"0123456789abcdef", FAST).unwrap();
        let b = derive(b"password-1", b"0123456789abcdef", FAST).unwrap();
        let c = derive(b"password-2", b"0123456789abcdef", FAST).unwrap();
        assert_eq!(*a, *b);
        assert_ne!(*a, *c);
    }

    #[test]
    fn two_users_are_isolated_and_wrong_password_never_decrypts() {
        let dir = tempfile::tempdir().unwrap();
        let store = ProfileStore::new(dir.path(), FAST);
        let (mut s1, _) = store.create(new("alice", "alice-password-1"), 1).unwrap();
        let (mut s2, _) = store.create(new("bob", "bob-password-12"), 2).unwrap();
        s1.settings_set("theme", "light".into()).unwrap();
        s2.settings_set("theme", "dark-blue".into()).unwrap();
        s1.vault_put("binance", "KEY-A".into()).unwrap();
        drop((s1, s2));
        assert!(matches!(
            store.create(new("ALICE", "another-pass-1"), 3),
            Err(AuthError::Exists)
        ));
        let a = store.login("alice", "alice-password-1", 10).unwrap();
        let b = store.login("Bob", "bob-password-12", 10).unwrap();
        assert_eq!(a.settings_get("theme").as_deref(), Some("light"));
        assert_eq!(b.settings_get("theme").as_deref(), Some("dark-blue"));
        assert_eq!(a.vault_get("binance").as_deref(), Some("KEY-A"));
        assert_eq!(b.vault_get("binance"), None);
        assert_eq!(a.prefs().timezone, "Asia/Karachi");
        assert!(matches!(
            store.login("alice", "bob-password-12", 10),
            Err(AuthError::InvalidCredentials)
        ));
        assert!(matches!(
            store.login("carol", "whatever-123", 10),
            Err(AuthError::UnknownUser)
        ));
        assert_eq!(store.list().unwrap().len(), 2);
    }

    #[test]
    fn failed_attempts_back_off_exponentially() {
        let dir = tempfile::tempdir().unwrap();
        let store = ProfileStore::new(dir.path(), FAST);
        store.create(new("eve", "correct-horse-1"), 0).unwrap();
        for _ in 0..3 {
            assert!(matches!(
                store.login("eve", "wrong-password", 1_000),
                Err(AuthError::InvalidCredentials)
            ));
        }
        assert!(matches!(
            store.login("eve", "correct-horse-1", 1_500),
            Err(AuthError::LockedOut(1))
        ));
        assert!(store.login("eve", "correct-horse-1", 2_100).is_ok());
        assert_eq!(
            [
                lockout_seconds(2),
                lockout_seconds(3),
                lockout_seconds(5),
                lockout_seconds(30)
            ],
            [0, 1, 4, 300]
        );
    }

    #[test]
    fn recovery_pin_and_password_change() {
        let dir = tempfile::tempdir().unwrap();
        let store = ProfileStore::new(dir.path(), FAST);
        let (mut s, words) = store.create(new("hanan", "first-password"), 0).unwrap();
        assert_eq!(words.len(), RECOVERY_WORDS);
        s.vault_put("rithmic", "secret".into()).unwrap();
        // PIN unlock + lockout after 5 wrong PINs.
        assert!(store.unlock_pin("hanan", "123456").is_ok());
        for _ in 0..4 {
            assert!(matches!(
                store.unlock_pin("hanan", "000000"),
                Err(AuthError::InvalidPin)
            ));
        }
        assert!(matches!(
            store.unlock_pin("hanan", "000000"),
            Err(AuthError::PinLockedOut)
        ));
        assert!(matches!(
            store.unlock_pin("hanan", "123456"),
            Err(AuthError::NoPin)
        ));
        store.set_pin(&s, Some("654321")).unwrap();
        assert!(store.unlock_pin("hanan", "654321").is_ok());
        // Change password.
        store
            .change_password(&s, "first-password", "second-password")
            .unwrap();
        assert!(store.login("hanan", "first-password", 0).is_err());
        let s2 = store.login("hanan", "second-password", 0).unwrap();
        assert_eq!(s2.vault_get("rithmic").as_deref(), Some("secret"));
        // Recovery with the 24 words (case-insensitive, extra spaces ok).
        let mut bad = words.clone();
        bad.swap(0, 1);
        if bad != words {
            assert!(matches!(
                store.recover("hanan", &bad, "third-password"),
                Err(AuthError::InvalidRecovery)
            ));
        }
        let upper: Vec<String> = words
            .iter()
            .map(|w| format!(" {} ", w.to_uppercase()))
            .collect();
        store.recover("hanan", &upper, "third-password").unwrap();
        let s3 = store.login("hanan", "third-password", 0).unwrap();
        assert_eq!(s3.vault_get("rithmic").as_deref(), Some("secret"));
        drop(s);
    }

    #[test]
    fn export_import_round_trip_and_remember_me() {
        let src_dir = tempfile::tempdir().unwrap();
        let dst_dir = tempfile::tempdir().unwrap();
        let src = ProfileStore::new(src_dir.path(), FAST);
        let dst = ProfileStore::new(dst_dir.path(), FAST);
        let (mut s, _) = src.create(new("trader", "my-password-1"), 5).unwrap();
        s.settings_set("workspace", "{\"tabs\":[]}".into()).unwrap();
        s.vault_put("dxfeed", "TOKEN".into()).unwrap();
        let bundle = src.export(&s).unwrap();
        assert!(!bundle.contains("TOKEN"), "export must stay encrypted");
        let summary = dst.import(&bundle).unwrap();
        assert_eq!(summary.username, "trader");
        assert!(matches!(dst.import(&bundle), Err(AuthError::Exists)));
        assert!(matches!(dst.import("{}"), Err(AuthError::Format)));
        let s2 = dst.login("trader", "my-password-1", 0).unwrap();
        assert_eq!(
            s2.settings_get("workspace").as_deref(),
            Some("{\"tabs\":[]}")
        );
        assert_eq!(s2.vault_get("dxfeed").as_deref(), Some("TOKEN"));
        let restored = dst.session_from_key(&s2.profile_id, s2.data_key()).unwrap();
        assert_eq!(restored.vault_get("dxfeed").as_deref(), Some("TOKEN"));
        let wrong = random_key();
        assert!(dst.session_from_key(&s2.profile_id, &wrong).is_err());
    }

    /// In-memory stand-in for the OS credential store.
    #[derive(Default)]
    struct MemPepper(
        std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>,
        bool,
    );

    impl PinPepper for MemPepper {
        fn pepper(&self, id: &str, create: bool) -> Option<Zeroizing<Vec<u8>>> {
            if self.1 {
                return None; // "credential store unavailable"
            }
            let mut m = self.0.lock().unwrap();
            if !m.contains_key(id) && create {
                let mut v = vec![0u8; 32];
                rand::rngs::OsRng.fill_bytes(&mut v);
                m.insert(id.to_string(), v);
            }
            m.get(id).cloned().map(Zeroizing::new)
        }
    }

    fn meta_of(dir: &Path) -> ProfileMeta {
        let p = fs::read_dir(dir.join("profiles"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        serde_json::from_slice(&fs::read(p.join(META_FILE)).unwrap()).unwrap()
    }

    #[test]
    fn import_rejects_path_traversal_and_bad_fields() {
        let src_dir = tempfile::tempdir().unwrap();
        let src = ProfileStore::new(src_dir.path(), FAST);
        let (s, _) = src.create(new("victim", "my-password-1"), 5).unwrap();
        let good: serde_json::Value = serde_json::from_str(&src.export(&s).unwrap()).unwrap();

        let dst_dir = tempfile::tempdir().unwrap();
        let outside = dst_dir.path().join("outside");
        let dst = ProfileStore::new(dst_dir.path().join("root"), FAST);
        for (i, evil_id) in [
            "../../outside".to_string(),
            outside.display().to_string(),
            "..".to_string(),
            "x/../../outside".to_string(),
        ]
        .into_iter()
        .enumerate()
        {
            let mut b = good.clone();
            b["meta"]["id"] = evil_id.clone().into();
            b["meta"]["username"] = format!("user{i}").into();
            let sum = dst.import(&b.to_string()).unwrap();
            assert_ne!(sum.id, evil_id);
            assert!(uuid::Uuid::parse_str(&sum.id).is_ok());
            assert!(dst_dir
                .path()
                .join("root/profiles")
                .join(&sum.id)
                .join(META_FILE)
                .is_file());
        }
        assert!(
            !outside.exists(),
            "import wrote outside the profiles folder"
        );
        assert!(!dst_dir.path().join(META_FILE).exists());

        // Hostile field values are refused instead of panicking / allocating gigabytes.
        let bad = |f: &dyn Fn(&mut serde_json::Value)| {
            let mut b = good.clone();
            b["meta"]["username"] = "fresh".into();
            f(&mut b);
            dst.import(&b.to_string())
        };
        for f in [
            &(|b: &mut serde_json::Value| b["meta"]["username"] = "../x".into())
                as &dyn Fn(&mut serde_json::Value),
            &|b| b["meta"]["wrapped_password"]["kdf"]["m_kib"] = (u32::MAX).into(),
            &|b| b["meta"]["wrapped_password"]["kdf"]["m_kib"] = 0.into(),
            &|b| b["meta"]["wrapped_password"]["kdf"]["t"] = 0.into(),
            &|b| b["meta"]["wrapped_recovery"]["kdf"]["p"] = 1000.into(),
            &|b| b["meta"]["wrapped_password"]["salt"] = "AA==".into(),
            &|b| b["meta"]["format"] = 7.into(),
        ] {
            assert!(matches!(bad(f), Err(AuthError::Format)));
        }
        // Control characters are stripped from the display name.
        let ok = bad(&|b| b["meta"]["display_name"] = "a\u{202e}\nb".into()).unwrap();
        assert_eq!(ok.display_name, "ab");
    }

    #[test]
    fn tampered_kdf_on_disk_fails_closed_without_panicking() {
        let dir = tempfile::tempdir().unwrap();
        let store = ProfileStore::new(dir.path(), FAST);
        store.create(new("mallory", "correct-horse-1"), 0).unwrap();
        let p = fs::read_dir(dir.path().join("profiles"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let mut m = meta_of(dir.path());
        m.wrapped_password.kdf.m_kib = u32::MAX;
        m.failed_attempts = u32::MAX;
        fs::write(p.join(META_FILE), serde_json::to_vec(&m).unwrap()).unwrap();
        assert!(matches!(
            store.login("mallory", "correct-horse-1", 0),
            Err(AuthError::InvalidCredentials)
        ));
        assert_eq!(meta_of(dir.path()).failed_attempts, u32::MAX);
    }

    #[test]
    fn pin_is_peppered_and_never_exported() {
        let dir = tempfile::tempdir().unwrap();
        let pep = Arc::new(MemPepper::default());
        let store = ProfileStore::new(dir.path(), FAST).with_pin_pepper(pep.clone());
        let (s, _) = store.create(new("pinny", "pin-password-1"), 0).unwrap();
        let m = meta_of(dir.path());
        assert!(m.pin_peppered && m.wrapped_pin.is_some());
        // An attacker with only profile.json cannot test PINs: the PIN alone does not unwrap.
        assert!(unwrap(m.wrapped_pin.as_ref().unwrap(), b"123456", b"pin").is_none());
        assert!(store.unlock_pin("pinny", "123456").is_ok());
        // Without the credential-store pepper the PIN cannot be used at all.
        let bare = ProfileStore::new(dir.path(), FAST);
        assert!(matches!(
            bare.unlock_pin("pinny", "123456"),
            Err(AuthError::NoPin)
        ));
        // Exports never carry the PIN wrap, imports never accept one.
        let bundle = store.export(&s).unwrap();
        let v: serde_json::Value = serde_json::from_str(&bundle).unwrap();
        assert!(v["meta"]["wrapped_pin"].is_null());
        let other = tempfile::tempdir().unwrap();
        let dst = ProfileStore::new(other.path(), FAST);
        let mut with_pin = v.clone();
        with_pin["meta"]["wrapped_pin"] = serde_json::to_value(&m.wrapped_pin).unwrap();
        assert!(!dst.import(&with_pin.to_string()).unwrap().has_pin);
        // No credential store: setting a PIN is refused rather than silently weak.
        let no_store = ProfileStore::new(dir.path(), FAST)
            .with_pin_pepper(Arc::new(MemPepper(Default::default(), true)));
        assert!(matches!(
            no_store.set_pin(&s, Some("111111")),
            Err(AuthError::PinUnavailable)
        ));
    }

    #[test]
    fn legacy_pin_is_upgraded_to_peppered() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = ProfileStore::new(dir.path(), FAST);
        legacy.create(new("old", "old-password-1"), 0).unwrap();
        assert!(!meta_of(dir.path()).pin_peppered);
        let store =
            ProfileStore::new(dir.path(), FAST).with_pin_pepper(Arc::new(MemPepper::default()));
        assert!(store.unlock_pin("old", "123456").is_ok());
        let m = meta_of(dir.path());
        assert!(m.pin_peppered);
        assert!(unwrap(m.wrapped_pin.as_ref().unwrap(), b"123456", b"pin").is_none());
        assert!(store.unlock_pin("old", "123456").is_ok());
    }

    #[test]
    fn validates_inputs() {
        let dir = tempfile::tempdir().unwrap();
        let store = ProfileStore::new(dir.path(), FAST);
        assert!(matches!(
            store.create(new("ab", "long-enough-pw"), 0),
            Err(AuthError::InvalidUsername)
        ));
        assert!(matches!(
            store.create(new("abc", "short"), 0),
            Err(AuthError::WeakPassword)
        ));
        let mut p = new("abcd", "long-enough-pw");
        p.pin = Some("12ab56");
        assert!(matches!(store.create(p, 0), Err(AuthError::PinFormat)));
        assert_eq!(words().len(), 256);
    }
}
