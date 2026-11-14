//! Async SSH client (russh): connect with host-key pinning, authenticate with a key or a
//! password, run commands with streamed output and stdin, disconnect. Every network step has a
//! hard timeout so a dead VPS can never hang the UI.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect};
use zeroize::Zeroizing;

use crate::keys::{fingerprint, matches_pin, parse_private_key};
use crate::target::Target;
use crate::Error;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
pub const AUTH_TIMEOUT: Duration = Duration::from_secs(20);
pub const DEFAULT_EXEC_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_EXEC_TIMEOUT: Duration = Duration::from_secs(600);

/// How to log in. Secrets are zeroed on drop.
pub enum Auth {
    Key {
        pem: Zeroizing<String>,
        passphrase: Option<Zeroizing<String>>,
    },
    Password(Zeroizing<String>),
}

/// Host-key policy: `Pin` refuses any key whose SHA-256 fingerprint differs; `AcceptAny` is only
/// used to read the key for the trust-on-first-use dialog (no authentication happens then).
#[derive(Debug, Clone)]
pub enum HostKeyPolicy {
    Pin(String),
    AcceptAny,
}

#[derive(Default)]
struct Seen {
    fingerprint: Option<String>,
    mismatch: bool,
}

struct Checker {
    policy: HostKeyPolicy,
    seen: Arc<Mutex<Seen>>,
}

impl client::Handler for Checker {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let pk = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(c) => c.public_key().clone().into(),
        };
        let fp = fingerprint(&pk);
        let ok = match &self.policy {
            HostKeyPolicy::AcceptAny => true,
            HostKeyPolicy::Pin(pin) => matches_pin(&pk, pin),
        };
        if let Ok(mut s) = self.seen.lock() {
            s.fingerprint = Some(fp);
            s.mismatch = !ok;
        }
        Ok(ok)
    }
}

fn config() -> Arc<client::Config> {
    Arc::new(client::Config {
        // Pooled sessions stay up between polls; keep-alives detect a dead link in ~45 s.
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    })
}

async fn timed<T, E>(
    d: Duration,
    what: &'static str,
    f: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, Error>
where
    E: Into<Error>,
{
    match tokio::time::timeout(d, f).await {
        Ok(r) => r.map_err(Into::into),
        Err(_) => Err(Error::Timeout(what)),
    }
}

impl From<russh::Error> for Error {
    fn from(e: russh::Error) -> Self {
        match e {
            russh::Error::ConnectionTimeout | russh::Error::KeepaliveTimeout => {
                Error::Timeout("connection")
            }
            russh::Error::IO(io) => Error::Connect(io.to_string()),
            russh::Error::Disconnect | russh::Error::HUP | russh::Error::SendError => Error::Closed,
            other => Error::Ssh(other.to_string()),
        }
    }
}

/// Connects (TCP + key exchange) and returns the server's fingerprint without authenticating:
/// used for the trust-on-first-use dialog.
pub async fn fetch_host_key(target: &Target) -> Result<String, Error> {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let checker = Checker {
        policy: HostKeyPolicy::AcceptAny,
        seen: seen.clone(),
    };
    let handle = timed(
        CONNECT_TIMEOUT,
        "connect",
        client::connect(config(), target.addr(), checker),
    )
    .await?;
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        handle.disconnect(Disconnect::ByApplication, "", "en"),
    )
    .await;
    let fp = seen.lock().ok().and_then(|s| s.fingerprint.clone());
    fp.ok_or_else(|| Error::Ssh("the server sent no host key".into()))
}

/// Which output stream a chunk came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

/// Collected result of [`Session::exec_collect`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Output {
    pub code: Option<u32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}

/// An authenticated SSH session. Cheap to share (`Arc`); each command opens its own channel.
pub struct Session {
    handle: Handle<Checker>,
    pub fingerprint: String,
}

impl Session {
    /// Connects, verifies the host key against `policy` and logs in.
    pub async fn connect(
        target: &Target,
        auth: &Auth,
        policy: HostKeyPolicy,
    ) -> Result<Self, Error> {
        let seen = Arc::new(Mutex::new(Seen::default()));
        let checker = Checker {
            policy: policy.clone(),
            seen: seen.clone(),
        };
        let connected = timed(
            CONNECT_TIMEOUT,
            "connect",
            client::connect(config(), target.addr(), checker),
        )
        .await;
        let (fp, mismatch) = seen
            .lock()
            .map(|s| (s.fingerprint.clone(), s.mismatch))
            .unwrap_or((None, false));
        if mismatch {
            let expected = match &policy {
                HostKeyPolicy::Pin(p) => p.clone(),
                HostKeyPolicy::AcceptAny => String::new(),
            };
            return Err(Error::HostKeyMismatch {
                expected,
                actual: fp.unwrap_or_default(),
            });
        }
        let mut handle = connected?;
        let ok = match auth {
            Auth::Password(pw) => {
                timed(
                    AUTH_TIMEOUT,
                    "authentication",
                    handle.authenticate_password(target.user.clone(), pw.as_str()),
                )
                .await?
            }
            Auth::Key { pem, passphrase } => {
                let key = parse_private_key(pem, passphrase.as_ref().map(|p| p.as_str()))?;
                let hash = timed(
                    AUTH_TIMEOUT,
                    "authentication",
                    handle.best_supported_rsa_hash(),
                )
                .await?
                .flatten();
                timed(
                    AUTH_TIMEOUT,
                    "authentication",
                    handle.authenticate_publickey(
                        target.user.clone(),
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    ),
                )
                .await?
            }
        };
        if !ok.success() {
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                handle.disconnect(Disconnect::ByApplication, "", "en"),
            )
            .await;
            return Err(Error::AuthFailed);
        }
        Ok(Self {
            handle,
            fingerprint: fp.unwrap_or_default(),
        })
    }

    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    /// Runs `command`, optionally writing `stdin` (then EOF), and calls `on_output` for every
    /// chunk. Returns the exit status (`None` when the server sent none, e.g. killed by signal).
    /// The whole run is bounded by `timeout` (capped at [`MAX_EXEC_TIMEOUT`]).
    pub async fn exec(
        &self,
        command: &str,
        stdin: Option<&[u8]>,
        timeout: Duration,
        mut on_output: impl FnMut(Stream, &[u8]) + Send,
    ) -> Result<Option<u32>, Error> {
        let timeout = timeout.min(MAX_EXEC_TIMEOUT);
        let run = async {
            let mut ch = self.handle.channel_open_session().await?;
            ch.exec(true, command.as_bytes()).await?;
            if let Some(data) = stdin {
                ch.data(data).await?;
            }
            ch.eof().await?;
            let mut code = None;
            while let Some(msg) = ch.wait().await {
                match msg {
                    ChannelMsg::Data { data } => on_output(Stream::Stdout, &data),
                    ChannelMsg::ExtendedData { data, .. } => on_output(Stream::Stderr, &data),
                    ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            Ok::<_, russh::Error>(code)
        };
        match tokio::time::timeout(timeout, run).await {
            Ok(r) => r.map_err(Into::into),
            Err(_) => Err(Error::Timeout("command")),
        }
    }

    /// [`Session::exec`] collecting at most `max_bytes` of each stream (UTF-8, lossy).
    pub async fn exec_collect(
        &self,
        command: &str,
        stdin: Option<&[u8]>,
        timeout: Duration,
        max_bytes: usize,
    ) -> Result<Output, Error> {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut truncated = false;
        let code = self
            .exec(command, stdin, timeout, |s, d| {
                let buf = if s == Stream::Stdout {
                    &mut out
                } else {
                    &mut err
                };
                let room = max_bytes.saturating_sub(buf.len());
                if d.len() > room {
                    truncated = true;
                }
                buf.extend_from_slice(&d[..d.len().min(room)]);
            })
            .await?;
        Ok(Output {
            code,
            stdout: String::from_utf8_lossy(&out).into_owned(),
            stderr: String::from_utf8_lossy(&err).into_owned(),
            truncated,
        })
    }

    pub async fn disconnect(&self) {
        let _ = tokio::time::timeout(
            Duration::from_secs(3),
            self.handle
                .disconnect(Disconnect::ByApplication, "bye", "en"),
        )
        .await;
    }
}
