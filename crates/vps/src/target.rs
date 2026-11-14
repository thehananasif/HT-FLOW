//! Where to connect: host, port and user name, validated before any socket is opened.

use std::net::{IpAddr, Ipv6Addr};

use serde::{Deserialize, Serialize};

use crate::Error;

/// A validated SSH destination.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub user: String,
}

impl Target {
    /// Validates each part (see [`validate_host`] and [`validate_user`]).
    pub fn new(host: &str, port: u16, user: &str) -> Result<Self, Error> {
        if port == 0 {
            return Err(Error::BadTarget("port must be 1–65535".into()));
        }
        Ok(Self {
            host: validate_host(host)?,
            port,
            user: validate_user(user)?,
        })
    }

    /// `(host, port)` for `TcpStream::connect` (IPv6 literals without brackets).
    pub fn addr(&self) -> (&str, u16) {
        (self.host.as_str(), self.port)
    }

    /// `user@host:port`, with IPv6 hosts in brackets.
    pub fn display(&self) -> String {
        if self.host.contains(':') {
            format!("{}@[{}]:{}", self.user, self.host, self.port)
        } else {
            format!("{}@{}:{}", self.user, self.host, self.port)
        }
    }
}

/// Parses `user@host`, `user@host:port`, `user@[v6]:port`, `host` (user defaults to
/// `default_user`, port to 22).
pub fn parse_target(spec: &str, default_user: &str) -> Result<Target, Error> {
    let spec = spec.trim();
    let (user, rest) = match spec.rsplit_once('@') {
        Some((u, r)) => (u, r),
        None => (default_user, spec),
    };
    let (host, port) = if let Some(r) = rest.strip_prefix('[') {
        let (h, tail) = r
            .split_once(']')
            .ok_or_else(|| Error::BadTarget("missing ']' after an IPv6 address".into()))?;
        let port = match tail {
            "" => 22,
            t => parse_port(
                t.strip_prefix(':')
                    .ok_or_else(|| Error::BadTarget("expected ':port' after ']'".into()))?,
            )?,
        };
        (h, port)
    } else if rest.matches(':').count() == 1 {
        let (h, p) = rest.split_once(':').unwrap_or((rest, ""));
        (h, parse_port(p)?)
    } else {
        // Plain host name, IPv4 or a bare IPv6 literal.
        (rest, 22)
    };
    Target::new(host, port, user)
}

fn parse_port(p: &str) -> Result<u16, Error> {
    match p.parse::<u16>() {
        Ok(n) if n > 0 => Ok(n),
        _ => Err(Error::BadTarget(format!("invalid port '{p}'"))),
    }
}

/// Accepts DNS names (RFC 1123 labels), IPv4 and IPv6 literals (brackets optional).
pub fn validate_host(raw: &str) -> Result<String, Error> {
    let h = raw.trim();
    let h = h
        .strip_prefix('[')
        .and_then(|x| x.strip_suffix(']'))
        .unwrap_or(h);
    if h.is_empty() {
        return Err(Error::BadTarget("host is empty".into()));
    }
    if let Ok(ip) = h.parse::<IpAddr>() {
        if ip.is_unspecified() || ip.is_multicast() {
            return Err(Error::BadTarget(format!("'{h}' is not a usable address")));
        }
        return Ok(match ip {
            IpAddr::V6(v6) => canonical_v6(v6),
            IpAddr::V4(v4) => v4.to_string(),
        });
    }
    if h.len() > 253 {
        return Err(Error::BadTarget("host name is too long".into()));
    }
    let ok = h.trim_end_matches('.').split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    });
    // An all-numeric dotted name that did not parse as IPv4 (e.g. 999.1.1.1) is a typo.
    let numeric = h.split('.').all(|l| l.chars().all(|c| c.is_ascii_digit()));
    if !ok || numeric {
        return Err(Error::BadTarget(format!("'{h}' is not a valid host name")));
    }
    Ok(h.to_ascii_lowercase())
}

fn canonical_v6(v6: Ipv6Addr) -> String {
    v6.to_string()
}

/// POSIX-portable user names (also valid on Windows): letters, digits, `._-`, optional
/// `DOMAIN\` prefix for Windows accounts; 1–64 chars; must not start with `-`.
pub fn validate_user(raw: &str) -> Result<String, Error> {
    let u = raw.trim();
    let name = u.rsplit_once('\\').map_or(u, |(_, n)| n);
    let ok = !u.is_empty()
        && u.len() <= 64
        && !u.starts_with('-')
        && !name.is_empty()
        && u.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '\\' | '$'));
    if ok {
        Ok(u.to_string())
    } else {
        Err(Error::BadTarget(format!("'{u}' is not a valid user name")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_forms() {
        let t = parse_target("trader@vps.example.com:2222", "root").unwrap();
        assert_eq!(
            (t.host.as_str(), t.port, t.user.as_str()),
            ("vps.example.com", 2222, "trader")
        );
        let t = parse_target("203.0.113.10", "htflow").unwrap();
        assert_eq!(
            (t.host.as_str(), t.port, t.user.as_str()),
            ("203.0.113.10", 22, "htflow")
        );
        let t = parse_target("me@[2001:db8::1]:2200", "x").unwrap();
        assert_eq!((t.host.as_str(), t.port), ("2001:db8::1", 2200));
        assert_eq!(t.display(), "me@[2001:db8::1]:2200");
        let t = parse_target("2001:db8::2", "x").unwrap();
        assert_eq!((t.host.as_str(), t.port), ("2001:db8::2", 22));
        let t = parse_target("Admin@VPS.Example.COM", "x").unwrap();
        assert_eq!(t.host, "vps.example.com");
        assert_eq!(t.display(), "Admin@vps.example.com:22");
    }

    #[test]
    fn rejects_bad_targets() {
        for bad in [
            "",
            "user@",
            "user@host:0",
            "user@host:70000",
            "user@host:abc",
            "user@-bad.example",
            "user@bad_host",
            "user@999.1.1.1",
            "user@0.0.0.0",
            "user@[2001:db8::1",
            "user@[2001:db8::1]2200",
            "-oProxyCommand=x@host",
            "us er@host",
            "user@host;rm",
        ] {
            assert!(
                parse_target(bad, "root").is_err(),
                "{bad} should be rejected"
            );
        }
    }

    #[test]
    fn windows_domain_user() {
        assert_eq!(validate_user("CORP\\trader").unwrap(), "CORP\\trader");
        assert!(validate_user("CORP\\").is_err());
        assert!(Target::new("host", 0, "u").is_err());
    }
}
