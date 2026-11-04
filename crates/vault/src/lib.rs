//! Sealed blobs and the encrypted credential vault (P03).
//!
//! `seal`/`open` use XChaCha20-Poly1305 with a random 192-bit nonce prepended to the ciphertext,
//! so nonces never repeat in practice. Plaintext is never written to disk and never logged.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;
use zeroize::Zeroizing;

pub const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 24;
const MAGIC: &[u8; 4] = b"HTV1";

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("decryption failed (wrong key or corrupted data)")]
    Decrypt,
    #[error("data is not an HT Flow sealed blob")]
    Format,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Key = Zeroizing<[u8; KEY_LEN]>;

/// Fresh random 256-bit key.
pub fn random_key() -> Key {
    let mut k = Zeroizing::new([0u8; KEY_LEN]);
    rand::rngs::OsRng.fill_bytes(k.as_mut());
    k
}

/// Encrypts `plaintext`, binding it to `aad` (purpose label). Output: MAGIC | nonce | ciphertext+tag.
pub fn seal(key: &[u8; KEY_LEN], plaintext: &[u8], aad: &[u8]) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let mut nonce = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .expect("XChaCha20Poly1305 encryption cannot fail for in-memory buffers");
    let mut out = Vec::with_capacity(MAGIC.len() + NONCE_LEN + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    out
}

/// Decrypts a blob produced by [`seal`] with the same key and aad.
pub fn open(
    key: &[u8; KEY_LEN],
    blob: &[u8],
    aad: &[u8],
) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    if blob.len() < MAGIC.len() + NONCE_LEN + 16 || &blob[..4] != MAGIC {
        return Err(VaultError::Format);
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce = XNonce::from_slice(&blob[4..4 + NONCE_LEN]);
    cipher
        .decrypt(
            nonce,
            Payload {
                msg: &blob[4 + NONCE_LEN..],
                aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| VaultError::Decrypt)
}

/// Writes atomically: temp file in the same directory, then rename.
pub fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

/// Encrypted key → string map persisted as one sealed file (broker / API credentials, settings).
pub struct SealedMap {
    path: PathBuf,
    key: Key,
    aad: &'static [u8],
    entries: BTreeMap<String, String>,
}

impl SealedMap {
    /// Opens (or creates empty) the map at `path`. Fails if the file exists but the key is wrong.
    pub fn open(
        path: impl Into<PathBuf>,
        key: &[u8; KEY_LEN],
        aad: &'static [u8],
    ) -> Result<Self, VaultError> {
        let path = path.into();
        let entries = if path.exists() {
            let blob = fs::read(&path)?;
            let plain = open(key, &blob, aad)?;
            serde_json::from_slice(&plain)?
        } else {
            BTreeMap::new()
        };
        Ok(Self {
            path,
            key: Zeroizing::new(*key),
            aad,
            entries,
        })
    }

    pub fn get(&self, k: &str) -> Option<&str> {
        self.entries.get(k).map(String::as_str)
    }

    pub fn put(&mut self, k: &str, v: String) -> Result<(), VaultError> {
        self.entries.insert(k.to_string(), v);
        self.save()
    }

    pub fn remove(&mut self, k: &str) -> Result<(), VaultError> {
        self.entries.remove(k);
        self.save()
    }

    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.entries.keys()
    }

    fn save(&self) -> Result<(), VaultError> {
        let plain = Zeroizing::new(serde_json::to_vec(&self.entries)?);
        write_atomic(&self.path, &seal(&self.key, &plain, self.aad))?;
        Ok(())
    }
}

impl std::fmt::Debug for SealedMap {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print keys or values.
        f.debug_struct("SealedMap")
            .field("path", &self.path)
            .field("entries", &self.entries.len())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_round_trip_and_tamper_detection() {
        let k = random_key();
        let blob = seal(&k, b"api-secret", b"vault");
        assert_eq!(&*open(&k, &blob, b"vault").unwrap(), b"api-secret");
        assert!(matches!(
            open(&k, &blob, b"other"),
            Err(VaultError::Decrypt)
        ));
        let wrong = random_key();
        assert!(matches!(
            open(&wrong, &blob, b"vault"),
            Err(VaultError::Decrypt)
        ));
        let mut t = blob.clone();
        let n = t.len() - 1;
        t[n] ^= 1;
        assert!(matches!(open(&k, &t, b"vault"), Err(VaultError::Decrypt)));
        assert!(matches!(
            open(&k, b"nope", b"vault"),
            Err(VaultError::Format)
        ));
        // Random nonces: same plaintext seals differently.
        assert_ne!(seal(&k, b"x", b"a"), seal(&k, b"x", b"a"));
    }

    #[test]
    fn sealed_map_persists_encrypted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.bin");
        let k = random_key();
        {
            let mut m = SealedMap::open(&path, &k, b"vault").unwrap();
            m.put("binance.key", "SECRET-123".into()).unwrap();
        }
        let raw = fs::read(&path).unwrap();
        assert!(
            !raw.windows(10).any(|w| w == b"SECRET-123"),
            "secret must not be stored in plain text"
        );
        let m = SealedMap::open(&path, &k, b"vault").unwrap();
        assert_eq!(m.get("binance.key"), Some("SECRET-123"));
        assert!(SealedMap::open(&path, &random_key(), b"vault").is_err());
        assert!(!format!("{m:?}").contains("SECRET"));
    }
}
