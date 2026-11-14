//! Remote command builder for the HT Flow headless runner. Every command is built from validated
//! ids and fixed templates, so nothing the UI sends is pasted into a shell unquoted.
//!
//! Layout on the VPS (one folder per runner, all owned by the SSH user, never root):
//!
//! ```text
//! ~/.htflow-runner/runners/<id>/runner.js    single-file bundle (SDK + strategy + params)
//!                               state.json   status snapshot, rewritten every few seconds
//!                               log.jsonl    JSON-lines log
//!                               trips.jsonl  closed paper round trips (journal import)
//!                               pid          process id (written by the runner)
//!                               stop         graceful-stop request (the runner polls for it)
//! ```
//!
//! Linux (any POSIX `sh`) uses `nohup` or a systemd *user* unit; Windows uses a per-user
//! scheduled task run through `powershell -EncodedCommand`, which works whatever the OpenSSH
//! default shell is (cmd.exe or PowerShell).

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteOs {
    /// Linux and other POSIX systems with `sh`.
    Linux,
    Windows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StartMode {
    /// `nohup node runner.js &` (Linux). Survives logout, not reboots.
    Nohup,
    /// systemd user unit with `Restart=on-failure` (Linux). Survives reboots with lingering.
    SystemdUser,
    /// Per-user scheduled task (Windows), restarted on failure and at log-on.
    ScheduledTask,
}

/// A command plus how the stdin payload (if any) must be sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteCommand {
    pub command: String,
    /// Upload commands on Windows read base64 text from stdin (binary-safe through the console).
    pub stdin_base64: bool,
}

impl RemoteCommand {
    fn sh(command: String) -> Self {
        Self {
            command,
            stdin_base64: false,
        }
    }
}

/// Runner ids become folder, unit and task names: `[a-z0-9-]`, 1–40 chars, not starting with `-`.
pub fn validate_runner_id(id: &str) -> Result<&str, Error> {
    let ok = !id.is_empty()
        && id.len() <= 40
        && !id.starts_with('-')
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(id)
    } else {
        Err(Error::BadArgument(format!("invalid runner id '{id}'")))
    }
}

/// File names that may be uploaded into a runner folder.
pub fn validate_file_name(name: &str) -> Result<&str, Error> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name != "."
        && name != ".."
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if ok {
        Ok(name)
    } else {
        Err(Error::BadArgument(format!("invalid file name '{name}'")))
    }
}

/// POSIX shell single-quoting.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// PowerShell single-quoted string literal.
pub fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// `powershell … -EncodedCommand <base64 UTF-16LE>`: no quoting issues in cmd.exe or PowerShell.
pub fn powershell(script: &str) -> String {
    let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    format!(
        "powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {}",
        STANDARD.encode(utf16)
    )
}

const SH_BASE: &str = "\"$HOME/.htflow-runner/runners\"";
const PS_BASE: &str = "(Join-Path $env:USERPROFILE '.htflow-runner\\runners')";
pub const UNIT_PREFIX: &str = "htflow-runner-";
pub const TASK_PREFIX: &str = "HTFlowRunner-";

fn sh_dir(id: &str) -> String {
    format!("D={SH_BASE}/{id}")
}

fn ps_dir(id: &str) -> String {
    format!("$ErrorActionPreference='Stop'; $d = Join-Path {PS_BASE} '{id}'")
}

/// First probe: POSIX only. On Windows this fails (no `uname`) and the caller runs
/// [`probe_windows`]. Output is `key=value` lines.
pub fn probe_posix() -> RemoteCommand {
    RemoteCommand::sh(
        [
            "printf 'os=%s\\narch=%s\\n' \"$(uname -s)\" \"$(uname -m)\" || exit 9",
            "printf 'node=%s\\n' \"$(node --version 2>/dev/null || echo none)\"",
            "if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then echo systemd=yes; else echo systemd=no; fi",
            "printf 'linger=%s\\n' \"$(loginctl show-user \"$(id -un)\" -p Linger --value 2>/dev/null || echo unknown)\"",
            "printf 'distro=%s\\n' \"$( (. /etc/os-release 2>/dev/null && echo \"$ID\") || echo unknown)\"",
            "printf 'home=%s\\n' \"$HOME\"",
        ]
        .join("; "),
    )
}

pub fn probe_windows() -> RemoteCommand {
    RemoteCommand::sh(powershell(
        "'os=Windows'; \"arch=$env:PROCESSOR_ARCHITECTURE\"; \
         $n = Get-Command node -ErrorAction SilentlyContinue; \
         if ($n) { 'node=' + (& node --version) } else { 'node=none' }; \
         'systemd=no'; \"home=$env:USERPROFILE\"",
    ))
}

/// Writes stdin to `<runner>/<file>` atomically (temp file + rename), mode 600 on Linux.
pub fn upload(os: RemoteOs, runner_id: &str, file: &str) -> Result<RemoteCommand, Error> {
    let id = validate_runner_id(runner_id)?;
    let f = validate_file_name(file)?;
    Ok(match os {
        RemoteOs::Linux => RemoteCommand::sh(format!(
            "{}; umask 077 && mkdir -p \"$D\" && cat > \"$D/{f}.part\" && mv -f \"$D/{f}.part\" \"$D/{f}\" && echo uploaded",
            sh_dir(id)
        )),
        RemoteOs::Windows => RemoteCommand {
            command: powershell(&format!(
                "{}; New-Item -ItemType Directory -Force -Path $d | Out-Null; \
                 $b = [Console]::In.ReadToEnd(); $p = Join-Path $d '{f}.part'; \
                 [IO.File]::WriteAllBytes($p, [Convert]::FromBase64String($b.Trim())); \
                 Move-Item -Force -LiteralPath $p -Destination (Join-Path $d '{f}'); 'uploaded'",
                ps_dir(id)
            )),
            stdin_base64: true,
        },
    })
}

fn check_mode(os: RemoteOs, mode: StartMode) -> Result<(), Error> {
    match (os, mode) {
        (RemoteOs::Linux, StartMode::Nohup | StartMode::SystemdUser)
        | (RemoteOs::Windows, StartMode::ScheduledTask) => Ok(()),
        _ => Err(Error::BadArgument(format!(
            "start mode {mode:?} is not available on {os:?}"
        ))),
    }
}

/// Starts (or restarts) a runner whose `runner.js` is already uploaded.
pub fn start(os: RemoteOs, runner_id: &str, mode: StartMode) -> Result<RemoteCommand, Error> {
    let id = validate_runner_id(runner_id)?;
    check_mode(os, mode)?;
    Ok(match mode {
        StartMode::Nohup => RemoteCommand::sh(format!(
            "{}; cd \"$D\" || exit 3; [ -f runner.js ] || {{ echo 'runner.js missing' >&2; exit 3; }}; \
             command -v node >/dev/null 2>&1 || {{ echo 'node not found' >&2; exit 4; }}; \
             if [ -f pid ] && kill -0 \"$(cat pid)\" 2>/dev/null; then echo already-running; exit 0; fi; \
             rm -f stop; nohup node runner.js >> stdout.log 2>&1 < /dev/null & echo $! > pid; echo started",
            sh_dir(id)
        )),
        StartMode::SystemdUser => RemoteCommand::sh(format!(
            "{d}; cd \"$D\" || exit 3; [ -f runner.js ] || {{ echo 'runner.js missing' >&2; exit 3; }}; \
             N=$(command -v node) || {{ echo 'node not found' >&2; exit 4; }}; \
             U=\"$HOME/.config/systemd/user\"; mkdir -p \"$U\" && rm -f stop && \
             printf '[Unit]\\nDescription=HT Flow runner {id}\\nAfter=network-online.target\\n\\n[Service]\\nWorkingDirectory=%s\\nExecStart=%s runner.js\\nRestart=on-failure\\nRestartSec=10\\n\\n[Install]\\nWantedBy=default.target\\n' \"$D\" \"$N\" > \"$U/{UNIT_PREFIX}{id}.service\" && \
             systemctl --user daemon-reload && systemctl --user enable {UNIT_PREFIX}{id}.service >/dev/null 2>&1; \
             systemctl --user restart {UNIT_PREFIX}{id}.service && echo started",
            d = sh_dir(id)
        )),
        StartMode::ScheduledTask => RemoteCommand::sh(powershell(&format!(
            "{d}; if (-not (Test-Path (Join-Path $d 'runner.js'))) {{ throw 'runner.js missing' }}; \
             $n = (Get-Command node).Source; Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $d 'stop'); \
             $a = New-ScheduledTaskAction -Execute $n -Argument 'runner.js' -WorkingDirectory $d; \
             $t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; \
             $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1); \
             Register-ScheduledTask -TaskName {task} -Action $a -Trigger $t -Settings $s -Force | Out-Null; \
             Start-ScheduledTask -TaskName {task}; 'started'",
            d = ps_dir(id),
            task = ps_quote(&format!("{TASK_PREFIX}{id}")),
        ))),
    })
}

/// Graceful stop: drop a `stop` file (the runner flattens its paper position, writes its state
/// and exits), wait up to 8 s, then kill. Also disables the unit / task so it stays stopped.
pub fn stop(os: RemoteOs, runner_id: &str) -> Result<RemoteCommand, Error> {
    let id = validate_runner_id(runner_id)?;
    Ok(match os {
        RemoteOs::Linux => RemoteCommand::sh(format!(
            "{d}; cd \"$D\" 2>/dev/null || {{ echo not-deployed; exit 0; }}; touch stop; \
             if [ -f pid ]; then P=$(cat pid); for i in 1 2 3 4 5 6 7 8; do kill -0 \"$P\" 2>/dev/null || break; sleep 1; done; fi; \
             if command -v systemctl >/dev/null 2>&1; then systemctl --user disable --now {UNIT_PREFIX}{id}.service >/dev/null 2>&1; fi; \
             if [ -f pid ] && kill -0 \"$(cat pid)\" 2>/dev/null; then kill \"$(cat pid)\"; sleep 1; kill -9 \"$(cat pid)\" 2>/dev/null; fi; echo stopped",
            d = sh_dir(id)
        )),
        RemoteOs::Windows => RemoteCommand::sh(powershell(&format!(
            "{d}; if (-not (Test-Path $d)) {{ 'not-deployed'; exit 0 }}; New-Item -Force (Join-Path $d 'stop') | Out-Null; \
             $f = Join-Path $d 'pid'; $p = if (Test-Path $f) {{ [int](Get-Content $f -Raw) }} else {{ 0 }}; \
             for ($i = 0; $i -lt 8 -and $p -and (Get-Process -Id $p -ErrorAction SilentlyContinue); $i++) {{ Start-Sleep -Seconds 1 }}; \
             $ErrorActionPreference='SilentlyContinue'; Stop-ScheduledTask -TaskName {task}; Disable-ScheduledTask -TaskName {task} | Out-Null; \
             if ($p) {{ Stop-Process -Id $p -Force }}; 'stopped'",
            d = ps_dir(id),
            task = ps_quote(&format!("{TASK_PREFIX}{id}")),
        ))),
    })
}

/// Stops the runner and deletes its folder, unit and task.
pub fn remove(os: RemoteOs, runner_id: &str) -> Result<RemoteCommand, Error> {
    let id = validate_runner_id(runner_id)?;
    let stop = stop(os, id)?;
    Ok(match os {
        RemoteOs::Linux => RemoteCommand::sh(format!(
            "{}; {d}; rm -rf \"$D\"; rm -f \"$HOME/.config/systemd/user/{UNIT_PREFIX}{id}.service\"; \
             (systemctl --user daemon-reload >/dev/null 2>&1 || true); echo removed",
            stop.command,
            d = sh_dir(id)
        )),
        RemoteOs::Windows => RemoteCommand::sh(format!(
            "{} && {}",
            stop.command,
            powershell(&format!(
                "{d}; $ErrorActionPreference='SilentlyContinue'; Unregister-ScheduledTask -TaskName {task} -Confirm:$false; \
                 Remove-Item -Recurse -Force -LiteralPath $d; 'removed'",
                d = ps_dir(id),
                task = ps_quote(&format!("{TASK_PREFIX}{id}")),
            ))
        )),
    })
}

/// Status of every runner on the host, as sections:
/// `@@now <unix s>` then per runner `@@runner <id>`, `@@alive 0|1`, `@@state` + state.json,
/// `@@log` + the last `log_lines` lines of log.jsonl, `@@end`.
pub fn status(os: RemoteOs, log_lines: u32) -> RemoteCommand {
    let n = log_lines.min(200);
    match os {
        RemoteOs::Linux => RemoteCommand::sh(format!(
            "echo \"@@now $(date +%s)\"; B={SH_BASE}; [ -d \"$B\" ] || exit 0; \
             for D in \"$B\"/*/; do [ -d \"$D\" ] || continue; I=$(basename \"$D\"); echo \"@@runner $I\"; \
             A=0; if [ -f \"$D/pid\" ] && kill -0 \"$(cat \"$D/pid\")\" 2>/dev/null; then A=1; fi; echo \"@@alive $A\"; \
             echo @@state; cat \"$D/state.json\" 2>/dev/null; echo; echo @@log; tail -n {n} \"$D/log.jsonl\" 2>/dev/null; echo @@end; done"
        )),
        RemoteOs::Windows => RemoteCommand::sh(powershell(&format!(
            "'@@now ' + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); $b = {PS_BASE}; if (-not (Test-Path $b)) {{ exit 0 }}; \
             Get-ChildItem -Directory $b | ForEach-Object {{ $d = $_.FullName; '@@runner ' + $_.Name; \
             $f = Join-Path $d 'pid'; $a = 0; if (Test-Path $f) {{ $p = [int](Get-Content $f -Raw); if (Get-Process -Id $p -ErrorAction SilentlyContinue) {{ $a = 1 }} }}; '@@alive ' + $a; \
             '@@state'; $s = Join-Path $d 'state.json'; if (Test-Path $s) {{ Get-Content -Raw $s }}; ''; \
             '@@log'; $l = Join-Path $d 'log.jsonl'; if ({n} -gt 0 -and (Test-Path $l)) {{ Get-Content $l -Tail {n} }}; '@@end' }}"
        ))),
    }
}

/// Closed round trips `from` (0-based line) up to `max` lines, for the journal import.
pub fn trips(os: RemoteOs, runner_id: &str, from: u64, max: u32) -> Result<RemoteCommand, Error> {
    let id = validate_runner_id(runner_id)?;
    let max = max.clamp(1, 5000);
    Ok(match os {
        RemoteOs::Linux => RemoteCommand::sh(format!(
            "{}; [ -f \"$D/trips.jsonl\" ] || exit 0; sed -n '{},{}p' \"$D/trips.jsonl\"",
            sh_dir(id),
            from + 1,
            from + u64::from(max)
        )),
        RemoteOs::Windows => RemoteCommand::sh(powershell(&format!(
            "{}; $f = Join-Path $d 'trips.jsonl'; if (Test-Path $f) {{ Get-Content $f | Select-Object -Skip {from} -First {max} }}",
            ps_dir(id)
        ))),
    })
}

/// The last `lines` lines of a runner's log (Logs tab).
pub fn logs(os: RemoteOs, runner_id: &str, lines: u32) -> Result<RemoteCommand, Error> {
    let id = validate_runner_id(runner_id)?;
    let n = lines.clamp(1, 2000);
    Ok(match os {
        RemoteOs::Linux => RemoteCommand::sh(format!(
            "{}; tail -n {n} \"$D/log.jsonl\" 2>/dev/null; true",
            sh_dir(id)
        )),
        RemoteOs::Windows => RemoteCommand::sh(powershell(&format!(
            "{}; $l = Join-Path $d 'log.jsonl'; if (Test-Path $l) {{ Get-Content $l -Tail {n} }}",
            ps_dir(id)
        ))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_ps(cmd: &str) -> String {
        let b64 = cmd.rsplit(' ').next().unwrap();
        let bytes = STANDARD.decode(b64).unwrap();
        let units: Vec<u16> = bytes
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16(&units).unwrap()
    }

    #[test]
    fn ids_and_names() {
        assert!(validate_runner_id("orb-btc-1").is_ok());
        for bad in ["", "-x", "A", "a b", "a/b", "a;b", "..", &"a".repeat(41)] {
            assert!(validate_runner_id(bad).is_err(), "{bad}");
        }
        assert!(validate_file_name("runner.js").is_ok());
        for bad in ["", ".", "..", ".env", "a/b", "a\\b", "a b", "x$y"] {
            assert!(validate_file_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn quoting() {
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(ps_quote("it's"), "'it''s'");
        let ps = powershell("'hi'");
        assert!(ps.starts_with("powershell -NoLogo -NoProfile -NonInteractive"));
        assert_eq!(decode_ps(&ps), "'hi'");
    }

    #[test]
    fn linux_commands() {
        let up = upload(RemoteOs::Linux, "orb-1", "runner.js").unwrap();
        assert!(!up.stdin_base64);
        assert!(up
            .command
            .contains("D=\"$HOME/.htflow-runner/runners\"/orb-1"));
        assert!(up.command.contains("umask 077"));
        assert!(up
            .command
            .contains("mv -f \"$D/runner.js.part\" \"$D/runner.js\""));

        let s = start(RemoteOs::Linux, "orb-1", StartMode::Nohup).unwrap();
        assert!(s
            .command
            .contains("nohup node runner.js >> stdout.log 2>&1 < /dev/null &"));
        assert!(s.command.contains("already-running"));
        let s = start(RemoteOs::Linux, "orb-1", StartMode::SystemdUser).unwrap();
        assert!(s.command.contains("htflow-runner-orb-1.service"));
        assert!(s.command.contains("Restart=on-failure"));
        assert!(s.command.contains("systemctl --user restart"));
        assert!(start(RemoteOs::Linux, "orb-1", StartMode::ScheduledTask).is_err());
        assert!(start(RemoteOs::Linux, "bad id", StartMode::Nohup).is_err());

        let st = stop(RemoteOs::Linux, "orb-1").unwrap().command;
        assert!(st.contains("touch stop") && st.contains("disable --now htflow-runner-orb-1"));
        let rm = remove(RemoteOs::Linux, "orb-1").unwrap().command;
        assert!(rm.contains("touch stop") && rm.contains("rm -rf \"$D\""));
        assert!(!rm.contains("rm -rf \"$HOME"));

        let s = status(RemoteOs::Linux, 999).command;
        assert!(s.contains("tail -n 200") && s.contains("@@runner") && s.contains("@@now"));
        let t = trips(RemoteOs::Linux, "orb-1", 10, 100).unwrap().command;
        assert!(t.contains("sed -n '11,110p'"));
        assert!(logs(RemoteOs::Linux, "orb-1", 50)
            .unwrap()
            .command
            .contains("tail -n 50"));
        assert!(probe_posix().command.contains("node --version"));
    }

    #[test]
    fn windows_commands() {
        let up = upload(RemoteOs::Windows, "orb-1", "runner.js").unwrap();
        assert!(up.stdin_base64);
        let script = decode_ps(&up.command);
        assert!(script.contains("FromBase64String"));
        assert!(script.contains("Join-Path $env:USERPROFILE '.htflow-runner\\runners'"));
        assert!(script.contains("'orb-1'"));

        let s = decode_ps(
            &start(RemoteOs::Windows, "orb-1", StartMode::ScheduledTask)
                .unwrap()
                .command,
        );
        assert!(s.contains("Register-ScheduledTask -TaskName 'HTFlowRunner-orb-1'"));
        assert!(s.contains("-RestartCount 3"));
        assert!(start(RemoteOs::Windows, "orb-1", StartMode::Nohup).is_err());

        let rm = remove(RemoteOs::Windows, "orb-1").unwrap().command;
        let parts: Vec<&str> = rm.split(" && ").collect();
        assert_eq!(parts.len(), 2);
        assert!(decode_ps(parts[1]).contains("Unregister-ScheduledTask"));
        assert!(decode_ps(&status(RemoteOs::Windows, 20).command).contains("-Tail 20"));
        assert!(
            decode_ps(&trips(RemoteOs::Windows, "orb-1", 5, 10).unwrap().command)
                .contains("-Skip 5 -First 10")
        );
        assert!(decode_ps(&probe_windows().command).contains("node=none"));
    }
}
