//! Settings the native side needs before any profile is unlocked (log folder, backup schedule,
//! WebView2 GPU adapter). Profile settings are sealed with the account key, so the UI mirrors
//! these few non-secret values into `<data>/native-prefs.json`, which is read at start-up.
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{CmdError, CmdResult};

pub const FILE: &str = "native-prefs.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NativePrefs {
    /// `logs.folder`; empty or the default token means `<data>/logs`.
    pub logs_folder: String,
    /// `logs.keepDays`.
    pub logs_keep_days: u32,
    /// `common.backupDays`.
    pub backup_days: u32,
    /// `common.maxBackups`.
    pub max_backups: u32,
    /// `performance.videoAdapter`: `auto` | `high-performance` | `low-power`.
    pub video_adapter: String,
}

impl Default for NativePrefs {
    fn default() -> Self {
        Self {
            logs_folder: String::new(),
            logs_keep_days: 14,
            backup_days: 1,
            max_backups: 10,
            video_adapter: "auto".into(),
        }
    }
}

impl NativePrefs {
    /// Clamps values to the ranges the settings schema allows.
    pub fn sanitised(mut self) -> Self {
        self.logs_keep_days = self.logs_keep_days.clamp(1, 365);
        self.backup_days = self.backup_days.clamp(1, 30);
        self.max_backups = self.max_backups.clamp(1, 100);
        if !matches!(
            self.video_adapter.as_str(),
            "auto" | "high-performance" | "low-power"
        ) {
            self.video_adapter = "auto".into();
        }
        self.logs_folder = self.logs_folder.chars().take(260).collect();
        self
    }
}

/// Reads the prefs file; a missing or damaged file gives the defaults.
pub fn load(root: &Path) -> NativePrefs {
    fs::read(root.join(FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<NativePrefs>(&b).ok())
        .unwrap_or_default()
        .sanitised()
}

fn save(root: &Path, prefs: &NativePrefs) -> std::io::Result<()> {
    fs::create_dir_all(root)?;
    let tmp = root.join(format!("{FILE}.tmp"));
    fs::write(&tmp, serde_json::to_vec_pretty(prefs)?)?;
    fs::rename(tmp, root.join(FILE))
}

/// WebView2 command-line switches for the chosen adapter (Chromium flags). Includes the
/// default feature switches wry would pass, because a custom value replaces them.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn browser_args(adapter: &str) -> String {
    browser_args_with(
        adapter,
        std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
            .ok()
            .as_deref(),
    )
}

/// The WebView2 arguments the main window started with. Every webview of the process shares one
/// WebView2 environment, and WebView2 refuses to create another webview with different arguments
/// (HRESULT 0x8007139F), so secondary OS windows and Web Page windows must reuse these exactly.
static SESSION_ARGS: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Records the arguments the main window is built with (first call wins).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn set_session_browser_args(args: String) -> &'static str {
    SESSION_ARGS.get_or_init(|| args).as_str()
}

/// Arguments to pass to every later window; `None` before the main window was built.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn session_browser_args() -> Option<&'static str> {
    SESSION_ARGS.get().map(String::as_str)
}

/// Tauri's `additional_browser_args` replaces WebView2's `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
/// instead of adding to it, so anything already set there (e.g. msedgedriver's
/// `--remote-debugging-port` under tauri-driver, or a user's own flags) is appended here.
pub fn browser_args_with(adapter: &str, env_args: Option<&str>) -> String {
    let base = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";
    let mut args = match adapter {
        "high-performance" => format!("{base} --force_high_performance_gpu"),
        "low-power" => format!("{base} --force_low_power_gpu"),
        _ => base.to_string(),
    };
    if let Some(extra) = env_args.map(str::trim).filter(|e| !e.is_empty()) {
        args.push(' ');
        args.push_str(extra);
    }
    args
}

/// Data root plus the prefs read at start-up, managed as Tauri state.
pub struct NativeState {
    pub root: PathBuf,
    /// The log folder in use this run (resolved at start-up).
    pub log_dir: PathBuf,
    pub prefs: Mutex<NativePrefs>,
}

/// Mirrors the settings the native side reads at start-up. Takes effect on the next start
/// (log folder, adapter) or the next scheduler pass (backups).
#[tauri::command]
pub fn native_prefs_set(state: State<'_, NativeState>, prefs: NativePrefs) -> CmdResult<()> {
    let prefs = prefs.sanitised();
    save(&state.root, &prefs)
        .map_err(|_| CmdError::new("prefs.write", "Could not save the native preferences"))?;
    if let Ok(mut p) = state.prefs.lock() {
        *p = prefs;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_flags() {
        assert!(!browser_args("auto").contains("force_"));
        assert!(browser_args("high-performance").ends_with("--force_high_performance_gpu"));
        assert!(browser_args("low-power").ends_with("--force_low_power_gpu"));
        assert!(browser_args("bogus").contains("msWebOOUI"));
    }

    #[test]
    fn load_clamps_and_defaults() {
        let dir = std::env::temp_dir().join(format!("htflow-prefs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(load(&dir), NativePrefs::default());
        let p = NativePrefs {
            logs_keep_days: 9999,
            max_backups: 0,
            video_adapter: "x".into(),
            ..NativePrefs::default()
        }
        .sanitised();
        save(&dir, &p).unwrap();
        let l = load(&dir);
        assert_eq!((l.logs_keep_days, l.max_backups), (365, 1));
        assert_eq!(l.video_adapter, "auto");
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod browser_args_tests {
    use super::{browser_args_with, session_browser_args, set_session_browser_args};

    #[test]
    fn keeps_existing_webview2_args() {
        let a = browser_args_with("high-performance", Some("--remote-debugging-port=9222"));
        assert!(a.contains("--force_high_performance_gpu"));
        assert!(a.ends_with(" --remote-debugging-port=9222"));
        assert!(!browser_args_with("default", Some("  ")).ends_with(' '));
        assert!(!browser_args_with("default", None).contains("remote-debugging"));
    }

    #[test]
    fn later_windows_reuse_the_main_window_args() {
        let first = set_session_browser_args("--a".into());
        // First call wins: a second value never replaces what the main window used.
        assert_eq!(set_session_browser_args("--b".into()), first);
        assert_eq!(session_browser_args(), Some(first));
    }
}
