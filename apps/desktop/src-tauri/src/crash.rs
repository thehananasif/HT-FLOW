//! P29 — local-only crash reporter. A panic hook and the UI error boundary write a redacted
//! text file to `<data>/crashes/`; the "Report a problem" dialog opens that folder and copies a
//! redacted summary to the clipboard. Nothing is ever sent anywhere.
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;

use crate::error::{CmdError, CmdResult};

/// Newest crash files kept; older ones are deleted on each write.
const KEEP: usize = 20;
/// Largest report accepted from the UI (an error boundary stack is a few KB).
const MAX_REPORT_BYTES: usize = 64 * 1024;
/// How much of the newest report goes into the clipboard summary.
const SUMMARY_BYTES: usize = 12 * 1024;

/// `<data>/crashes/`, managed as Tauri state.
pub struct CrashState(pub PathBuf);

pub fn crash_dir(root: &Path) -> PathBuf {
    root.join("crashes")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `[a-z0-9-]` only, at most 16 characters: the kind becomes part of the file name.
fn clean_kind(kind: &str) -> String {
    let k: String = kind
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(16)
        .collect::<String>()
        .to_ascii_lowercase();
    if k.is_empty() {
        "crash".into()
    } else {
        k
    }
}

/// Removes anything that identifies the user or looks like a secret, so the text is safe to
/// paste into a public issue: user-profile folder names, e-mail addresses, `password=…`-style
/// values and long token-like strings.
pub fn redact(text: &str) -> String {
    let mut s = redact_user_paths(text);
    s = s
        .split_inclusive('\n')
        .map(redact_line)
        .collect::<Vec<_>>()
        .concat();
    s
}

/// `C:\Users\alice\x` / `/home/alice/x` / `/Users/alice/x` -> `…\<user>\x`.
fn redact_user_paths(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    'outer: while i < text.len() {
        for marker in ["\\users\\", "/users/", "/home/"] {
            if lower[i..].starts_with(marker) {
                let seg_start = i + marker.len();
                out.push_str(&text[i..seg_start]);
                let rest = &text[seg_start..];
                let seg_len = rest
                    // Windows user names may contain spaces: stop only at separators / line end.
                    .find(['\\', '/', '"', '\'', ')', ':', '\n', '\r'])
                    .unwrap_or(rest.len());
                if seg_len > 0 {
                    out.push_str("<user>");
                }
                i = seg_start + seg_len;
                continue 'outer;
            }
        }
        let ch = text[i..].chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

const SECRET_KEYS: [&str; 9] = [
    "api-key",
    "password",
    "passwd",
    "secret",
    "token",
    "apikey",
    "api_key",
    "authorization",
    "recovery",
];

fn redact_line(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut redact_next = false;
    for piece in line.split_inclusive(char::is_whitespace) {
        let word = piece.trim_end_matches(char::is_whitespace);
        let ws = &piece[word.len()..];
        let lw = word.to_ascii_lowercase();
        if redact_next && !word.is_empty() {
            redact_next = false;
            out.push_str("<redacted>");
        } else if lw == "bearer" {
            // `Authorization: Bearer <token>`: the token is the next word.
            out.push_str(word);
            redact_next = true;
        } else if let Some(i) = provider_key_at(word) {
            out.push_str(&word[..i]);
            out.push_str("<api-key>");
        } else if let Some(i) = word.find(['=', ':']).filter(|_| {
            SECRET_KEYS.iter().any(|k| {
                lw.split(['=', ':'])
                    .next()
                    .is_some_and(|key| key.contains(k))
            })
        }) {
            if i + 1 >= word.len() {
                // `password:` with the value in the next word.
                out.push_str(word);
                redact_next = true;
            } else {
                out.push_str(&word[..=i]);
                out.push_str("<redacted>");
            }
        } else if word.contains('@')
            && word
                .split_once('@')
                .is_some_and(|(a, b)| !a.is_empty() && b.contains('.'))
        {
            out.push_str("<email>");
        } else if looks_like_token(word) {
            out.push_str("<token>");
        } else {
            out.push_str(&redact_embedded(word));
        }
        out.push_str(ws);
    }
    out
}

/// Secrets inside URLs and `id:secret` pairs, e.g. a Discord webhook
/// `https://discord.com/api/webhooks/<id>/<token>` or a Telegram bot token `123456:AA…` inside
/// `https://api.telegram.org/bot123456:AA…/sendMessage`: each piece between `/ : ? & = # ;` is
/// checked on its own, and query values are always hidden.
fn redact_embedded(word: &str) -> String {
    let mut out = String::with_capacity(word.len());
    let mut in_query = false;
    let mut after_eq = false;
    for piece in word.split_inclusive(['/', ':', '?', '&', '=', '#', ';', ',']) {
        let sep = piece.chars().last().filter(|c| "/:?&=#;,".contains(*c));
        let body = sep.map_or(piece, |c| &piece[..piece.len() - c.len_utf8()]);
        let tokenish = body.len() >= 20
            && body
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '=' | '_' | '-' | '.'))
            && body.chars().any(|c| c.is_ascii_digit())
            && body.chars().any(|c| c.is_ascii_alphabetic());
        if (in_query && after_eq && !body.is_empty()) || tokenish || looks_like_token(body) {
            out.push_str("<token>");
        } else {
            out.push_str(body);
        }
        if let Some(c) = sep {
            out.push(c);
            in_query |= c == '?';
            after_eq = in_query && c == '=';
        } else {
            after_eq = false;
        }
    }
    out
}

/// Prefixes of LLM provider API keys (round 7 AI assistant): OpenAI / DeepSeek / Qwen `sk-…`,
/// Anthropic `sk-ant-…`, xAI `xai-…`, Google `AIza…`, Groq-style `gsk_…`, OpenRouter `sk-or-…`.
const PROVIDER_KEY_PREFIXES: [&str; 4] = ["sk-", "xai-", "AIza", "gsk_"];

/// Byte offset of a provider API key inside `word` (12+ key characters after the prefix start).
fn provider_key_at(word: &str) -> Option<usize> {
    for p in PROVIDER_KEY_PREFIXES {
        let mut from = 0;
        while let Some(rel) = word[from..].find(p) {
            let i = from + rel;
            let boundary = i == 0
                || !word[..i]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_ascii_alphanumeric());
            let run = word[i..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
                .count();
            if boundary && run >= 16 {
                return Some(i);
            }
            from = i + p.len();
        }
    }
    None
}

/// 32+ chars of base64 / hex / url-safe alphabet that mix letters and digits.
fn looks_like_token(w: &str) -> bool {
    w.len() >= 32
        && w.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '_' | '-'))
        && w.chars().any(|c| c.is_ascii_digit())
        && w.chars().any(|c| c.is_ascii_alphabetic())
        && !w.contains("::")
}

fn header(kind: &str) -> String {
    format!(
        "HT Flow crash report\nkind: {kind}\ntime_unix: {}\nversion: {}\nos: {} {}\n",
        now_secs(),
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

/// Writes one redacted report and prunes old ones. Returns the file path.
pub fn write_crash(dir: &Path, kind: &str, body: &str) -> std::io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let kind = clean_kind(kind);
    let mut text = header(&kind);
    text.push('\n');
    text.push_str(&redact(body));
    if text.len() > MAX_REPORT_BYTES {
        let mut cut = MAX_REPORT_BYTES;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n[truncated]\n");
    }
    // Same-second crashes (panic storms) must not overwrite each other.
    let mut n = 0;
    let path = loop {
        let name = if n == 0 {
            format!("crash-{}-{kind}.txt", now_secs())
        } else {
            format!("crash-{}-{kind}-{n}.txt", now_secs())
        };
        let p = dir.join(name);
        if !p.exists() {
            break p;
        }
        n += 1;
    };
    let mut f = fs::File::create(&path)?;
    f.write_all(text.as_bytes())?;
    f.flush()?;
    prune(dir);
    Ok(path)
}

fn list_files(dir: &Path) -> Vec<(PathBuf, u64, SystemTime)> {
    let mut v: Vec<_> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| n.starts_with("crash-") && n.ends_with(".txt"))
        })
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((e.path(), m.len(), m.modified().ok()?))
        })
        .collect();
    v.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| b.0.cmp(&a.0)));
    v
}

fn prune(dir: &Path) {
    for (p, _, _) in list_files(dir).into_iter().skip(KEEP) {
        let _ = fs::remove_file(p);
    }
}

/// Installs the panic hook. The previous hook (stderr message) still runs.
pub fn install_panic_hook(root: PathBuf) {
    let dir = crash_dir(&root);
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        prev(info);
        let thread = std::thread::current();
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "panic with a non-string payload".to_string()
        };
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".into());
        let bt = std::backtrace::Backtrace::force_capture();
        let body = format!(
            "thread: {}\nmessage: {msg}\nlocation: {loc}\n\nbacktrace:\n{bt}\n",
            thread.name().unwrap_or("<unnamed>")
        );
        // A failing disk must never turn a panic into a double panic.
        let _ = write_crash(&dir, "panic", &body);
    }));
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashFile {
    pub name: String,
    pub bytes: u64,
    /// Seconds since the Unix epoch.
    pub modified: u64,
}

/// Saves a report from the UI (error boundary, unhandled rejection).
#[tauri::command]
pub fn crash_save(state: State<'_, CrashState>, kind: String, body: String) -> CmdResult<String> {
    if body.len() > MAX_REPORT_BYTES {
        return Err(CmdError::new("crash.too_large", "Report is too large"));
    }
    let p = write_crash(&state.0, &kind, &body)
        .map_err(|_| CmdError::new("crash.write", "Could not write the crash report"))?;
    Ok(p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default())
}

/// Saved reports, newest first.
#[tauri::command]
pub fn crash_list(state: State<'_, CrashState>) -> Vec<CrashFile> {
    list_files(&state.0)
        .into_iter()
        .map(|(p, bytes, m)| CrashFile {
            name: p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            bytes,
            modified: m
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        })
        .collect()
}

/// Redacted summary for the clipboard: app version, OS and the newest report (if any).
#[tauri::command]
pub fn crash_summary(state: State<'_, CrashState>) -> String {
    let mut out = String::from("HT Flow problem report (redacted, generated locally)\n");
    out.push_str(&format!(
        "version: {}\nos: {} {}\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    match list_files(&state.0).first() {
        Some((p, _, _)) => {
            let text = fs::read(p)
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .unwrap_or_default();
            let mut cut = text.len().min(SUMMARY_BYTES);
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            out.push_str("\nlatest crash file:\n");
            out.push_str(&redact(&text[..cut]));
        }
        None => out.push_str("\nNo crash files saved.\n"),
    }
    out
}

/// Opens `<data>/crashes/` in the system file manager.
#[tauri::command]
pub fn crash_open_folder(state: State<'_, CrashState>) -> CmdResult<()> {
    fs::create_dir_all(&state.0)
        .map_err(|_| CmdError::new("crash.folder", "Could not create the crashes folder"))?;
    open_folder(&state.0).map_err(|_| CmdError::new("crash.folder", "Could not open the folder"))
}

/// Opens a folder in the system file manager (Explorer on Windows).
pub fn open_folder(path: &Path) -> std::io::Result<()> {
    let opener = if cfg!(windows) {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg(path)
        .spawn()
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_tokens_inside_urls() {
        let hook = "https://discord.com/api/webhooks/123456789012345678/AbCdEf_1234567890-ghIJKLmnopQRstuVWxyz0123456789abcdefGHIJ";
        let tg = "https://api.telegram.org/bot123456789:AAH7xY_z0123456789abcdefGHIJKLmnopq/sendMessage?chat_id=42&text=hi";
        let r = redact(&format!("Discord: failed {hook}\nTelegram error {tg}\nbare 123456789:AAH7xY_z0123456789abcdefGHIJKLmnopq\n"));
        assert!(!r.contains("AbCdEf_1234567890"), "{r}");
        assert!(!r.contains("AAH7xY_z0123456789"), "{r}");
        assert!(!r.contains("chat_id=42"), "{r}");
        assert!(r.contains("https://discord.com/api/webhooks/"), "{r}");
        assert!(r.contains("https://api.telegram.org/"), "{r}");
        // Ordinary text and code locations survive.
        let keep = "at src/charts/ChartWindow.tsx:120:7 (Binance:BTCUSDT) https://example.com/a/b";
        assert_eq!(redact(keep), keep);
    }

    #[test]
    fn redacts_llm_provider_keys() {
        let r = redact(
            "ai error key=sk-proj-Abc123Def456Ghi789 \"sk-ant-api03-ZZZZyyyy1111\" \
             xai-AAAAbbbbCCCC1234 AIzaSyD-123456789abcdefghij \
             Authorization: Bearer gsk_short1234567890ab x-goog-api-key: AIzaXYZ012345678901234\n",
        );
        for leak in [
            "Abc123Def456",
            "ZZZZyyyy1111",
            "AAAAbbbbCCCC",
            "D-123456789",
            "short1234567890",
            "XYZ0123456789",
        ] {
            assert!(!r.contains(leak), "{leak} in {r}");
        }
        // Ordinary words that merely start like a prefix survive.
        assert_eq!(
            redact("task-list desk-top sk-1 risk-engine"),
            "task-list desk-top sk-1 risk-engine"
        );
    }

    #[test]
    fn redacts_user_paths() {
        let r = redact("at C:\\Users\\Alice Smith\\AppData\\x.rs:10 and /home/bob/src/main.rs");
        assert!(!r.contains("Alice"), "{r}");
        assert!(!r.contains("bob"), "{r}");
        assert!(r.contains("C:\\Users\\<user>\\AppData"), "{r}");
        assert!(r.contains("/home/<user>/src/main.rs"), "{r}");
    }

    #[test]
    fn redacts_secrets_emails_tokens() {
        let r = redact(
            "login password=hunter2 token: abc123 mail me@example.com \
             key QWxhZGRpbjpvcGVuIHNlc2FtZQQWxhZGRpbjpvcGVuIHNlc2FtZ9 end",
        );
        assert!(!r.contains("hunter2"), "{r}");
        assert!(!r.contains("abc123"), "{r}");
        assert!(!r.contains("me@example.com"), "{r}");
        assert!(!r.contains("QWxhZGRpbjpv"), "{r}");
        assert!(r.contains("password=<redacted>"), "{r}");
        assert!(r.contains("<email>") && r.contains("<token>"), "{r}");
        // Ordinary text survives.
        assert_eq!(
            redact("thread 'main' panicked at src/lib.rs:5"),
            "thread 'main' panicked at src/lib.rs:5"
        );
    }

    #[test]
    fn writes_prunes_and_summarises() {
        let dir = std::env::temp_dir().join(format!("htflow-crash-test-{}", now_secs()));
        let _ = fs::remove_dir_all(&dir);
        for i in 0..25 {
            write_crash(&dir, "Test Kind!", &format!("boom {i} password=x")).unwrap();
        }
        let files = list_files(&dir);
        assert_eq!(files.len(), KEEP);
        let name = files[0]
            .0
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(
            name.starts_with("crash-") && name.ends_with("-testkind.txt")
                || name.contains("-testkind-"),
            "{name}"
        );
        let body = fs::read_to_string(&files[0].0).unwrap();
        assert!(body.starts_with("HT Flow crash report"));
        assert!(body.contains("password=<redacted>") && !body.contains("password=x"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn kind_is_sanitised() {
        assert_eq!(clean_kind("../../evil"), "evil");
        assert_eq!(clean_kind(""), "crash");
    }
}
