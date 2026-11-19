//! Native file logging: a daily-rolling `tracing` file under the configured log folder
//! (`logs.folder`, default `<data>/logs`), a start-up sweep that deletes files older than
//! `logs.keepDays`, and the `open_log_folder` command. Every line goes through the crash
//! reporter's redaction, so secrets, e-mail addresses and user-profile folder names never reach
//! the disk.
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

use tauri::State;
use tracing_appender::non_blocking::{NonBlocking, WorkerGuard};
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::fmt::MakeWriter;

use crate::crash::{open_folder, redact};
use crate::error::{CmdError, CmdResult};
use crate::native_prefs::NativeState;

const PREFIX: &str = "htflow";
const SUFFIX: &str = "log";
/// The settings default; it means "the standard folder under the data root".
const DEFAULT_TOKEN: &str = "%APPDATA%\\HTFlow\\logs";

static GUARD: OnceLock<WorkerGuard> = OnceLock::new();

/// Folder for the log files. Empty / default -> `<root>/logs`; `%NAME%` variables are expanded;
/// a relative path is taken relative to the data root.
pub fn resolve_log_dir(
    root: &Path,
    setting: &str,
    env: impl Fn(&str) -> Option<String>,
) -> PathBuf {
    let s = setting.trim();
    if s.is_empty() || s.eq_ignore_ascii_case(DEFAULT_TOKEN) {
        return root.join("logs");
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.find('%') {
            Some(j) if j > 0 => match env(&after[..j]) {
                Some(v) => {
                    out.push_str(&v);
                    rest = &after[j + 1..];
                }
                None => {
                    out.push('%');
                    rest = after;
                }
            },
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    let p = PathBuf::from(out);
    if p.is_absolute() {
        p
    } else {
        root.join(p)
    }
}

/// Names of log files (`(name, age in seconds)`) older than `keep_days`; other files are never
/// touched.
pub fn expired(entries: &[(String, u64)], keep_days: u32) -> Vec<String> {
    let limit = u64::from(keep_days) * 86_400;
    entries
        .iter()
        .filter(|(n, age)| is_log_name(n) && *age > limit)
        .map(|(n, _)| n.clone())
        .collect()
}

fn is_log_name(n: &str) -> bool {
    n.starts_with(&format!("{PREFIX}.")) && n.ends_with(&format!(".{SUFFIX}"))
}

/// Deletes log files older than `keep_days`; returns how many were removed.
pub fn sweep(dir: &Path, keep_days: u32) -> usize {
    let now = SystemTime::now();
    let entries: Vec<(String, u64)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let age = now
                .duration_since(e.metadata().ok()?.modified().ok()?)
                .ok()?;
            Some((e.file_name().into_string().ok()?, age.as_secs()))
        })
        .collect();
    expired(&entries, keep_days)
        .into_iter()
        .filter(|n| fs::remove_file(dir.join(n)).is_ok())
        .count()
}

/// Redacts every write before passing it on.
pub struct RedactWriter<W: Write>(pub W);

impl<W: Write> Write for RedactWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let text = String::from_utf8_lossy(buf);
        self.0.write_all(redact(&text).as_bytes())?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

#[derive(Clone)]
pub struct RedactingMaker(NonBlocking);

impl<'a> MakeWriter<'a> for RedactingMaker {
    type Writer = RedactWriter<NonBlocking>;
    fn make_writer(&'a self) -> Self::Writer {
        RedactWriter(self.0.clone())
    }
}

/// Opens the daily file appender in `dir` (non-blocking, redacted). `None` when the folder
/// cannot be created, in which case logging stays on stderr only.
pub fn maker(dir: &Path) -> Option<RedactingMaker> {
    fs::create_dir_all(dir).ok()?;
    let appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(PREFIX)
        .filename_suffix(SUFFIX)
        .build(dir)
        .ok()?;
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let _ = GUARD.set(guard);
    Some(RedactingMaker(writer))
}

/// Opens the log folder in the file manager (Explorer on Windows).
#[tauri::command]
pub fn open_log_folder(state: State<'_, NativeState>) -> CmdResult<String> {
    fs::create_dir_all(&state.log_dir)
        .map_err(|_| CmdError::new("logs.folder", "Could not create the log folder"))?;
    open_folder(&state.log_dir)
        .map_err(|_| CmdError::new("logs.folder", "Could not open the folder"))?;
    Ok(state.log_dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_resolution() {
        let root = PathBuf::from("/data/HTFlow");
        let env = |k: &str| (k == "APPDATA").then(|| "/roaming".to_string());
        assert_eq!(resolve_log_dir(&root, "", env), root.join("logs"));
        assert_eq!(
            resolve_log_dir(&root, DEFAULT_TOKEN, env),
            root.join("logs")
        );
        assert_eq!(
            resolve_log_dir(&root, "%APPDATA%/mylogs", env),
            PathBuf::from("/roaming/mylogs")
        );
        assert_eq!(
            resolve_log_dir(&root, "sub/logs", env),
            root.join("sub/logs")
        );
        // Unknown variables are left alone.
        assert_eq!(
            resolve_log_dir(&root, "/x/%NOPE%/y", env),
            PathBuf::from("/x/%NOPE%/y")
        );
    }

    #[test]
    fn expiry_selection() {
        let day = 86_400;
        let e = vec![
            ("htflow.2026-01-01.log".to_string(), 20 * day),
            ("htflow.2026-02-01.log".to_string(), 14 * day),
            ("htflow.2026-03-01.log".to_string(), 2 * day),
            ("notes.txt".to_string(), 99 * day),
        ];
        assert_eq!(expired(&e, 14), vec!["htflow.2026-01-01.log".to_string()]);
        assert!(expired(&e, 30).is_empty());
    }

    #[test]
    fn sweep_removes_only_old_log_files() {
        let dir = std::env::temp_dir().join(format!("htflow-logs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("htflow.2026-01-01.log"), "x").unwrap();
        fs::write(dir.join("other.txt"), "x").unwrap();
        // Fresh files are kept.
        assert_eq!(sweep(&dir, 1), 0);
        assert!(dir.join("htflow.2026-01-01.log").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn writer_redacts() {
        let mut out = Vec::new();
        let mut w = RedactWriter(&mut out);
        w.write_all(b"login password=hunter2 from C:\\Users\\Alice\\x\n")
            .unwrap();
        let s = String::from_utf8(out).unwrap();
        assert!(!s.contains("hunter2") && !s.contains("Alice"), "{s}");
        assert!(s.contains("password=<redacted>"), "{s}");
    }
}
