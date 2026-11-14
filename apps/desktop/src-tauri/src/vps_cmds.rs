//! Strategy VPS runner (P42): SSH to the user's own VPS (crates/vps). The UI never sees a secret:
//! it stores the private key / passphrase / password in the encrypted vault under fixed keys
//! (`vps/<id>/key|passphrase|password`) and this module reads them when it opens a session.
//! Sessions are pooled per VPS id so status polls reuse one connection.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use htflow_vps::commands::{self, validate_runner_id, RemoteCommand};
use htflow_vps::keys::{fingerprint, normalize_fingerprint, parse_private_key, public_line};
use htflow_vps::{fetch_host_key, Auth, HostKeyPolicy, RemoteOs, Session, StartMode, Target};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex;
use zeroize::Zeroizing;

use crate::auth_cmds::{with_session, AuthState};
use crate::error::{CmdError, CmdResult};

/// Largest file accepted by `vps_op upload` (the runner bundle is ~0.3–1 MB).
const MAX_UPLOAD: usize = 8 * 1024 * 1024;
/// Output kept per stream for `vps_op` results.
const MAX_OUTPUT: usize = 2 * 1024 * 1024;
const MAX_POOLED: usize = 32;

#[derive(Default)]
pub struct VpsState {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl From<htflow_vps::Error> for CmdError {
    fn from(e: htflow_vps::Error) -> Self {
        CmdError::new(e.code(), e.to_string())
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthKind {
    Key,
    Password,
}

/// Connection details sent by the UI (no secrets).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnSpec {
    id: String,
    host: String,
    port: u16,
    user: String,
    auth: AuthKind,
    /// Pinned host key (`SHA256:…`). Required unless `trustAnyHostKey` is set.
    fingerprint: Option<String>,
    #[serde(default)]
    trust_any_host_key: bool,
}

/// Vault keys of one VPS (fixed per id, so the UI cannot point a session at other secrets).
pub fn vault_key(id: &str, what: &str) -> String {
    format!("vps/{id}/{what}")
}

fn target_of(spec: &ConnSpec) -> CmdResult<Target> {
    validate_runner_id(&spec.id)
        .map_err(|_| CmdError::new("vps.bad_argument", "Invalid VPS id"))?;
    Ok(Target::new(&spec.host, spec.port, &spec.user)?)
}

fn policy_of(spec: &ConnSpec) -> CmdResult<HostKeyPolicy> {
    match spec.fingerprint.as_deref().filter(|f| !f.trim().is_empty()) {
        Some(f) => normalize_fingerprint(f)
            .map(HostKeyPolicy::Pin)
            .ok_or_else(|| CmdError::new("vps.bad_argument", "Invalid host key fingerprint")),
        None if spec.trust_any_host_key => Ok(HostKeyPolicy::AcceptAny),
        None => Err(CmdError::new(
            "vps.untrusted",
            "Confirm the server's host key fingerprint first",
        )),
    }
}

fn auth_of(auth: &AuthState, spec: &ConnSpec) -> CmdResult<Auth> {
    let get = |what: &str| {
        with_session(auth, |s| Ok(s.vault_get(&vault_key(&spec.id, what))))
            .map(|v| v.filter(|x| !x.is_empty()).map(Zeroizing::new))
    };
    match spec.auth {
        AuthKind::Key => Ok(Auth::Key {
            pem: get("key")?.ok_or_else(|| {
                CmdError::new("vps.no_secret", "No SSH private key saved for this VPS")
            })?,
            passphrase: get("passphrase")?,
        }),
        AuthKind::Password => Ok(Auth::Password(get("password")?.ok_or_else(|| {
            CmdError::new("vps.no_secret", "No password saved for this VPS")
        })?)),
    }
}

/// Pooled session for `spec.id`, or a fresh one (also when `fresh`).
async fn session(
    state: &VpsState,
    auth: &AuthState,
    spec: &ConnSpec,
    fresh: bool,
) -> CmdResult<Arc<Session>> {
    let target = target_of(spec)?;
    let policy = policy_of(spec)?;
    let mut pool = state.sessions.lock().await;
    if !fresh {
        if let Some(s) = pool.get(&spec.id) {
            if !s.is_closed() {
                return Ok(s.clone());
            }
        }
    }
    if let Some(old) = pool.remove(&spec.id) {
        old.disconnect().await;
    }
    let creds = auth_of(auth, spec)?;
    let s = Arc::new(Session::connect(&target, &creds, policy).await?);
    if pool.len() >= MAX_POOLED {
        if let Some(k) = pool.keys().next().cloned() {
            if let Some(old) = pool.remove(&k) {
                old.disconnect().await;
            }
        }
    }
    pool.insert(spec.id.clone(), s.clone());
    Ok(s)
}

/// Drops a pooled session after a transport error so the next call reconnects.
async fn forget_on_error<T>(state: &VpsState, id: &str, r: CmdResult<T>) -> CmdResult<T> {
    if let Err(e) = &r {
        if matches!(e.code.as_str(), "vps.closed" | "vps.timeout" | "vps.ssh") {
            if let Some(s) = state.sessions.lock().await.remove(id) {
                s.disconnect().await;
            }
        }
    }
    r
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    fingerprint: String,
}

/// Reads the server's host key (no login) for the trust-on-first-use dialog.
#[tauri::command]
pub async fn vps_host_key(host: String, port: u16, user: String) -> CmdResult<HostKeyInfo> {
    let t = Target::new(&host, port, &user)?;
    Ok(HostKeyInfo {
        fingerprint: fetch_host_key(&t).await?,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    public_key: String,
    fingerprint: String,
}

/// Validates the saved private key (and passphrase) and returns its public half, so the user
/// can add it to `~/.ssh/authorized_keys`.
#[tauri::command]
pub async fn vps_key_info(auth: State<'_, AuthState>, id: String) -> CmdResult<KeyInfo> {
    validate_runner_id(&id).map_err(|_| CmdError::new("vps.bad_argument", "Invalid VPS id"))?;
    let get = |what: &str| with_session(&auth, |s| Ok(s.vault_get(&vault_key(&id, what))));
    let pem = Zeroizing::new(
        get("key")?.ok_or_else(|| CmdError::new("vps.no_secret", "No SSH private key saved"))?,
    );
    let pass = get("passphrase")?.map(Zeroizing::new);
    let k = parse_private_key(
        &pem,
        pass.as_ref().map(|p| p.as_str()).filter(|p| !p.is_empty()),
    )?;
    Ok(KeyInfo {
        public_key: public_line(&k)?,
        fingerprint: fingerprint(k.public_key()),
    })
}

/// Test connection: always opens a fresh session (and keeps it pooled).
#[tauri::command]
pub async fn vps_connect(
    state: State<'_, VpsState>,
    auth: State<'_, AuthState>,
    spec: ConnSpec,
) -> CmdResult<HostKeyInfo> {
    let s = session(&state, &auth, &spec, true).await?;
    Ok(HostKeyInfo {
        fingerprint: s.fingerprint.clone(),
    })
}

#[tauri::command]
pub async fn vps_disconnect(state: State<'_, VpsState>, id: String) -> CmdResult<()> {
    if let Some(s) = state.sessions.lock().await.remove(&id) {
        s.disconnect().await;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpOutput {
    code: Option<u32>,
    stdout: String,
    stderr: String,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    os: RemoteOs,
    /// `key=value` lines (os, arch, node, systemd, linger, distro, home).
    raw: String,
}

/// Detects the remote OS and checks Node.js / systemd. Tries POSIX `sh` first, then PowerShell.
#[tauri::command]
pub async fn vps_probe(
    state: State<'_, VpsState>,
    auth: State<'_, AuthState>,
    spec: ConnSpec,
) -> CmdResult<ProbeResult> {
    let r = async {
        let s = session(&state, &auth, &spec, false).await?;
        let t = Duration::from_secs(20);
        let posix = s
            .exec_collect(&commands::probe_posix().command, None, t, 64 * 1024)
            .await?;
        if posix.code == Some(0) && posix.stdout.contains("os=") {
            return Ok(ProbeResult {
                os: RemoteOs::Linux,
                raw: posix.stdout,
            });
        }
        let win = s
            .exec_collect(&commands::probe_windows().command, None, t, 64 * 1024)
            .await?;
        if win.stdout.contains("os=Windows") {
            return Ok(ProbeResult {
                os: RemoteOs::Windows,
                raw: win.stdout,
            });
        }
        Err(CmdError::new(
            "vps.unsupported",
            "Cannot detect the remote system (expected Linux with sh, or Windows with PowerShell)",
        ))
    }
    .await;
    forget_on_error(&state, &spec.id, r).await
}

/// Remote operations of the runner (built by `htflow_vps::commands`).
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Op {
    #[serde(rename_all = "camelCase")]
    Upload {
        runner_id: String,
        file: String,
        content: String,
    },
    #[serde(rename_all = "camelCase")]
    Start { runner_id: String, mode: StartMode },
    #[serde(rename_all = "camelCase")]
    Stop { runner_id: String },
    #[serde(rename_all = "camelCase")]
    Remove { runner_id: String },
    #[serde(rename_all = "camelCase")]
    Status { log_lines: u32 },
    #[serde(rename_all = "camelCase")]
    Trips {
        runner_id: String,
        from: u64,
        max: u32,
    },
    #[serde(rename_all = "camelCase")]
    Logs { runner_id: String, lines: u32 },
}

/// Builds the command, the stdin payload and the timeout of an operation.
pub fn build_op(os: RemoteOs, op: &Op) -> CmdResult<(RemoteCommand, Option<Vec<u8>>, Duration)> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    let short = Duration::from_secs(30);
    Ok(match op {
        Op::Upload {
            runner_id,
            file,
            content,
        } => {
            if content.len() > MAX_UPLOAD {
                return Err(CmdError::new(
                    "vps.too_large",
                    "The file is larger than 8 MB",
                ));
            }
            let c = commands::upload(os, runner_id, file)?;
            let data = if c.stdin_base64 {
                STANDARD.encode(content.as_bytes()).into_bytes()
            } else {
                content.as_bytes().to_vec()
            };
            (c, Some(data), Duration::from_secs(180))
        }
        Op::Start { runner_id, mode } => (
            commands::start(os, runner_id, *mode)?,
            None,
            Duration::from_secs(60),
        ),
        Op::Stop { runner_id } => (
            commands::stop(os, runner_id)?,
            None,
            Duration::from_secs(60),
        ),
        Op::Remove { runner_id } => (
            commands::remove(os, runner_id)?,
            None,
            Duration::from_secs(60),
        ),
        Op::Status { log_lines } => (commands::status(os, *log_lines), None, short),
        Op::Trips {
            runner_id,
            from,
            max,
        } => (commands::trips(os, runner_id, *from, *max)?, None, short),
        Op::Logs { runner_id, lines } => (commands::logs(os, runner_id, *lines)?, None, short),
    })
}

#[tauri::command]
pub async fn vps_op(
    state: State<'_, VpsState>,
    auth: State<'_, AuthState>,
    spec: ConnSpec,
    os: RemoteOs,
    op: Op,
) -> CmdResult<OpOutput> {
    let (cmd, stdin, timeout) = build_op(os, &op)?;
    let r = async {
        let s = session(&state, &auth, &spec, false).await?;
        let o = s
            .exec_collect(&cmd.command, stdin.as_deref(), timeout, MAX_OUTPUT)
            .await?;
        Ok(OpOutput {
            code: o.code,
            stdout: o.stdout,
            stderr: o.stderr,
            truncated: o.truncated,
        })
    }
    .await;
    forget_on_error(&state, &spec.id, r).await
}

/// Streamed output of [`vps_exec`].
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ExecEvent {
    Out { data: String },
    Err { data: String },
}

/// Runs the user's own command on their VPS and streams its output. Returns the exit status.
#[tauri::command]
pub async fn vps_exec(
    state: State<'_, VpsState>,
    auth: State<'_, AuthState>,
    spec: ConnSpec,
    command: String,
    timeout_s: Option<u64>,
    channel: Channel<ExecEvent>,
) -> CmdResult<Option<u32>> {
    if command.trim().is_empty() || command.len() > 16 * 1024 {
        return Err(CmdError::new(
            "vps.bad_argument",
            "Empty or too long command",
        ));
    }
    let timeout = Duration::from_secs(timeout_s.unwrap_or(60).clamp(1, 600));
    let r = async {
        let s = session(&state, &auth, &spec, false).await?;
        Ok(s.exec(&command, None, timeout, |stream, data| {
            let data = String::from_utf8_lossy(data).into_owned();
            let _ = channel.send(match stream {
                htflow_vps::Stream::Stdout => ExecEvent::Out { data },
                htflow_vps::Stream::Stderr => ExecEvent::Err { data },
            });
        })
        .await?)
    }
    .await;
    forget_on_error(&state, &spec.id, r).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(fp: Option<&str>, any: bool) -> ConnSpec {
        ConnSpec {
            id: "vps-1".into(),
            host: "vps.example.com".into(),
            port: 22,
            user: "trader".into(),
            auth: AuthKind::Key,
            fingerprint: fp.map(str::to_string),
            trust_any_host_key: any,
        }
    }

    #[test]
    fn host_key_policy() {
        assert!(matches!(policy_of(&spec(None, false)), Err(e) if e.code == "vps.untrusted"));
        assert!(matches!(
            policy_of(&spec(None, true)),
            Ok(HostKeyPolicy::AcceptAny)
        ));
        assert!(policy_of(&spec(Some("SHA256:nope"), false)).is_err());
        let fp = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        assert!(matches!(policy_of(&spec(Some(fp), false)), Ok(HostKeyPolicy::Pin(p)) if p == fp));
        let mut bad = spec(Some(fp), false);
        bad.id = "../x".into();
        assert!(target_of(&bad).is_err());
        assert_eq!(vault_key("vps-1", "key"), "vps/vps-1/key");
    }

    #[test]
    fn ops_deserialize_and_build() {
        let op: Op = serde_json::from_str(
            r#"{"kind":"upload","runnerId":"orb-1","file":"runner.js","content":"x"}"#,
        )
        .unwrap();
        let (c, stdin, _) = build_op(RemoteOs::Windows, &op).unwrap();
        assert!(c.stdin_base64);
        assert_eq!(stdin.unwrap(), b"eA==");
        let op: Op =
            serde_json::from_str(r#"{"kind":"start","runnerId":"orb-1","mode":"systemd-user"}"#)
                .unwrap();
        assert!(build_op(RemoteOs::Linux, &op).is_ok());
        assert!(build_op(RemoteOs::Windows, &op).is_err());
        let op: Op = serde_json::from_str(r#"{"kind":"status","logLines":5}"#).unwrap();
        assert!(build_op(RemoteOs::Linux, &op).is_ok());
        let op: Op =
            serde_json::from_str(r#"{"kind":"trips","runnerId":"orb-1","from":3,"max":10}"#)
                .unwrap();
        assert!(build_op(RemoteOs::Linux, &op)
            .unwrap()
            .0
            .command
            .contains("4,13p"));
    }
}
