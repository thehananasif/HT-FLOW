//! Private-key parsing and host-key fingerprints (OpenSSH `SHA256:<base64>` form).

use russh::keys::{decode_secret_key, HashAlg, PrivateKey, PublicKey};

use crate::Error;

/// Largest key file accepted (an RSA-16384 OpenSSH key is ~13 KB).
pub const MAX_KEY_BYTES: usize = 64 * 1024;

/// Parses an OpenSSH, PKCS#8, PKCS#1 (RSA) or PuTTY (`.ppk`) private key. `passphrase` is only
/// used for encrypted keys; an empty passphrase counts as none.
pub fn parse_private_key(text: &str, passphrase: Option<&str>) -> Result<PrivateKey, Error> {
    if text.len() > MAX_KEY_BYTES {
        return Err(Error::BadKey("the key file is too large".into()));
    }
    let text = text.trim();
    if text.is_empty() {
        return Err(Error::BadKey("the key is empty".into()));
    }
    if text.starts_with("ssh-") || text.starts_with("ecdsa-") {
        return Err(Error::BadKey(
            "this is a public key; choose the private key file (usually without .pub)".into(),
        ));
    }
    let pass = passphrase.filter(|p| !p.is_empty());
    match decode_secret_key(text, pass) {
        Ok(k) => Ok(k),
        Err(russh::keys::Error::KeyIsEncrypted) => Err(Error::KeyNeedsPassphrase),
        Err(e) if pass.is_some() && is_decrypt_error(&e) => Err(Error::BadKey(
            "the passphrase is wrong or the key is damaged".into(),
        )),
        Err(e) => Err(Error::BadKey(format!("cannot read the private key: {e}"))),
    }
}

fn is_decrypt_error(e: &russh::keys::Error) -> bool {
    let s = e.to_string().to_ascii_lowercase();
    s.contains("decrypt") || s.contains("crypto") || s.contains("padding") || s.contains("mac")
}

/// `SHA256:<unpadded base64>` exactly as `ssh-keygen -lf` and the OpenSSH client print it.
pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

/// One-line OpenSSH public key (`ssh-ed25519 AAAA… comment`) for `~/.ssh/authorized_keys`.
pub fn public_line(key: &PrivateKey) -> Result<String, Error> {
    key.public_key()
        .to_openssh()
        .map_err(|e| Error::BadKey(format!("cannot encode the public key: {e}")))
}

/// Normalises a user-entered fingerprint for comparison: trims, accepts with or without the
/// `SHA256:` prefix and with or without base64 padding. Returns `None` for anything that is not
/// a 32-byte SHA-256 digest in base64.
pub fn normalize_fingerprint(raw: &str) -> Option<String> {
    use base64::engine::general_purpose::STANDARD_NO_PAD;
    use base64::Engine;
    let s = raw.trim();
    let body = s
        .strip_prefix("SHA256:")
        .or_else(|| s.strip_prefix("sha256:"))
        .unwrap_or(s)
        .trim_end_matches('=');
    let bytes = STANDARD_NO_PAD.decode(body).ok()?;
    (bytes.len() == 32).then(|| format!("SHA256:{}", STANDARD_NO_PAD.encode(bytes)))
}

/// True when the server key matches the pinned fingerprint.
pub fn matches_pin(server: &PublicKey, pin: &str) -> bool {
    normalize_fingerprint(pin).is_some_and(|p| p == fingerprint(server))
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::ssh_key::LineEnding;

    // Test vectors published with russh (`src/keys/mod.rs`) and RFC 8410 §10.3. Not real keys.
    const ED25519_AESCTR_TEST: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABD1phlku5
A2G7Q9iP+DcOc9AAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIHeLC1lWiCYrXsf/
85O/pkbUFZ6OGIt49PX3nw8iRoXEAAAAkKRF0st5ZI7xxo9g6A4m4l6NarkQre3mycqNXQ
dP3jryYgvsCIBAA5jMWSjrmnOTXhidqcOy4xYCrAttzSnZ/cUadfBenL+DQq6neffw7j8r
0tbCxVGp6yCQlKrgSZf6c0Hy7dNEIU2bJFGxLe6/kWChcUAt/5Ll5rI7DVQPJdLgehLzvv
sJWR7W+cGvJ/vLsw==
-----END OPENSSH PRIVATE KEY-----";
    const RFC8410_TEST: &str = "-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEINTuctv5E1hK1bbY8fdp+K06/nwoy/HU++CXqI9EdVhC
-----END PRIVATE KEY-----";

    #[test]
    fn parses_pkcs8_and_encrypted_openssh() {
        let k = parse_private_key(RFC8410_TEST, None).unwrap();
        assert_eq!(k.algorithm(), russh::keys::Algorithm::Ed25519);
        assert!(public_line(&k).unwrap().starts_with("ssh-ed25519 AAAA"));

        assert!(matches!(
            parse_private_key(ED25519_AESCTR_TEST, None),
            Err(Error::KeyNeedsPassphrase)
        ));
        assert!(matches!(
            parse_private_key(ED25519_AESCTR_TEST, Some("")),
            Err(Error::KeyNeedsPassphrase)
        ));
        assert!(parse_private_key(ED25519_AESCTR_TEST, Some("wrong")).is_err());
        let k = parse_private_key(ED25519_AESCTR_TEST, Some("test")).unwrap();

        // Round trip through an unencrypted OpenSSH file (what `ssh-keygen -N ''` writes),
        // with Windows line endings and surrounding blank lines.
        let pem = k.to_openssh(LineEnding::CRLF).unwrap();
        let again = parse_private_key(&format!("\r\n{}\r\n", pem.as_str()), None).unwrap();
        assert_eq!(fingerprint(again.public_key()), fingerprint(k.public_key()));
    }

    #[test]
    fn rejects_non_keys() {
        assert!(matches!(parse_private_key("", None), Err(Error::BadKey(_))));
        assert!(matches!(
            parse_private_key("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA user@pc", None),
            Err(Error::BadKey(m)) if m.contains("public key")
        ));
        assert!(parse_private_key("-----BEGIN OPENSSH PRIVATE KEY-----\nnope\n", None).is_err());
        assert!(parse_private_key(&"A".repeat(MAX_KEY_BYTES + 1), None).is_err());
    }

    #[test]
    fn fingerprints_and_pins() {
        let k = parse_private_key(RFC8410_TEST, None).unwrap();
        let fp = fingerprint(k.public_key());
        assert!(fp.starts_with("SHA256:"));
        assert_eq!(fp.len(), "SHA256:".len() + 43);
        let body = fp.trim_start_matches("SHA256:");
        assert_eq!(normalize_fingerprint(body).as_deref(), Some(fp.as_str()));
        assert_eq!(
            normalize_fingerprint(&format!("  {fp}=  ")).as_deref(),
            Some(fp.as_str())
        );
        assert!(matches_pin(k.public_key(), &fp));
        assert!(!matches_pin(
            k.public_key(),
            "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        ));
        assert_eq!(normalize_fingerprint("MD5:aa:bb"), None);
        assert_eq!(normalize_fingerprint("SHA256:dG9vc2hvcnQ"), None);
    }
}
