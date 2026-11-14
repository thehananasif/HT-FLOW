//! Strategy VPS runner transport: a pure-Rust SSH client (russh) for the user's own VPS, plus
//! the command builder that installs, starts, stops and polls the headless HT Flow runner.
//! No HT Flow server is involved: the desktop app talks to the VPS directly over SSH.

pub mod client;
pub mod commands;
pub mod keys;
pub mod target;

pub use client::{fetch_host_key, Auth, HostKeyPolicy, Output, Session, Stream};
pub use commands::{RemoteCommand, RemoteOs, StartMode};
pub use target::{parse_target, Target};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    BadTarget(String),
    #[error("{0}")]
    BadArgument(String),
    #[error("{0}")]
    BadKey(String),
    #[error("the private key is encrypted: enter its passphrase")]
    KeyNeedsPassphrase,
    #[error("cannot connect: {0}")]
    Connect(String),
    #[error("timed out ({0})")]
    Timeout(&'static str),
    #[error("HOST KEY CHANGED: expected {expected}, the server sent {actual}. Someone may be intercepting the connection, or the VPS was reinstalled.")]
    HostKeyMismatch { expected: String, actual: String },
    #[error("authentication failed: check the user name and the key or password")]
    AuthFailed,
    #[error("the connection was closed")]
    Closed,
    #[error("SSH error: {0}")]
    Ssh(String),
}

impl Error {
    /// Stable code for the UI (`vps.*`).
    pub fn code(&self) -> &'static str {
        match self {
            Error::BadTarget(_) => "vps.bad_target",
            Error::BadArgument(_) => "vps.bad_argument",
            Error::BadKey(_) => "vps.bad_key",
            Error::KeyNeedsPassphrase => "vps.key_passphrase",
            Error::Connect(_) => "vps.connect",
            Error::Timeout(_) => "vps.timeout",
            Error::HostKeyMismatch { .. } => "vps.host_key_mismatch",
            Error::AuthFailed => "vps.auth",
            Error::Closed => "vps.closed",
            Error::Ssh(_) => "vps.ssh",
        }
    }
}

#[cfg(test)]
mod loopback;
