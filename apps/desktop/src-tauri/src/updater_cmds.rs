//! P30 — auto-update from GitHub Releases through the free `tauri-plugin-updater`.
//!
//! The plugin is configured in `tauri.conf.json` (`plugins.updater`). Updates are only offered
//! when the build carries a minisign public key (`pubkey`, put there by the release workflow or
//! committed once; see docs/RELEASE.md) and is not a portable build (a zip cannot update itself).
//! Nothing here runs unless the user clicks "Check for updates" or enables the start-up check.
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

use crate::error::{CmdError, CmdResult};

const REPO: &str = "thehananasif/HT-FLOW";

/// Release channel -> `latest.json` URL. `stable` follows the newest published release;
/// `beta` follows a rolling `beta-channel` release that the workflow refreshes for pre-releases.
pub fn endpoint_for(channel: &str) -> Option<String> {
    match channel {
        "stable" => Some(format!(
            "https://github.com/{REPO}/releases/latest/download/latest.json"
        )),
        "beta" => Some(format!(
            "https://github.com/{REPO}/releases/download/beta-channel/latest.json"
        )),
        _ => None,
    }
}

/// `plugins.updater.pubkey` from the bundled config (empty when unset).
fn pubkey(app: &AppHandle) -> String {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub supported: bool,
    /// `no-pubkey` | `portable` when unsupported.
    pub reason: Option<&'static str>,
    pub portable: bool,
    pub version: String,
}

fn status_for(pubkey: &str, portable: bool, version: &str) -> UpdateStatus {
    let reason = if portable {
        Some("portable")
    } else if pubkey.is_empty() {
        Some("no-pubkey")
    } else {
        None
    };
    UpdateStatus {
        supported: reason.is_none(),
        reason,
        portable,
        version: version.to_string(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[tauri::command]
pub fn update_status(app: AppHandle) -> UpdateStatus {
    status_for(
        &pubkey(&app),
        crate::paths::is_portable(),
        &app.package_info().version.to_string(),
    )
}

fn ensure_supported(app: &AppHandle) -> CmdResult<()> {
    let s = update_status(app.clone());
    if s.supported {
        Ok(())
    } else {
        Err(CmdError::new(
            "update.unavailable",
            "Updates unavailable in this build",
        ))
    }
}

fn updater(app: &AppHandle, channel: &str) -> CmdResult<tauri_plugin_updater::Updater> {
    let url = endpoint_for(channel)
        .and_then(|u| u.parse().ok())
        .ok_or_else(|| CmdError::new("update.channel", "Unknown update channel"))?;
    app.updater_builder()
        .endpoints(vec![url])
        .and_then(|b| b.build())
        .map_err(|_| CmdError::new("update.config", "Update settings are invalid"))
}

/// Looks for a newer release on `channel` (`stable` | `beta`). Sends only a GET for `latest.json`.
#[tauri::command]
pub async fn update_check(app: AppHandle, channel: String) -> CmdResult<UpdateInfo> {
    ensure_supported(&app)?;
    let found = updater(&app, &channel)?
        .check()
        .await
        .map_err(|_| CmdError::new("update.check", "Could not reach the update server"))?;
    Ok(match found {
        Some(u) => UpdateInfo {
            available: true,
            version: Some(u.version.clone()),
            notes: u.body.clone().map(|b| b.chars().take(4000).collect()),
            date: u.date.map(|d| d.to_string()),
        },
        None => UpdateInfo {
            available: false,
            version: None,
            notes: None,
            date: None,
        },
    })
}

/// Downloads, verifies the minisign signature, installs and restarts.
#[tauri::command]
pub async fn update_install(app: AppHandle, channel: String) -> CmdResult<()> {
    ensure_supported(&app)?;
    let Some(update) = updater(&app, &channel)?
        .check()
        .await
        .map_err(|_| CmdError::new("update.check", "Could not reach the update server"))?
    else {
        return Err(CmdError::new("update.none", "Already up to date"));
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|_| CmdError::new("update.install", "Update failed to download or verify"))?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_map_to_https_endpoints() {
        assert!(endpoint_for("stable")
            .unwrap()
            .starts_with("https://github.com/"));
        assert!(endpoint_for("stable")
            .unwrap()
            .ends_with("/latest/download/latest.json"));
        assert!(endpoint_for("beta").unwrap().contains("/beta-channel/"));
        assert!(endpoint_for("nightly").is_none());
        assert!(endpoint_for("stable")
            .unwrap()
            .parse::<tauri::Url>()
            .is_ok());
    }

    #[test]
    fn unsupported_without_key_or_when_portable() {
        let s = status_for("", false, "1.0.0");
        assert!(!s.supported && s.reason == Some("no-pubkey"));
        let s = status_for("KEY", true, "1.0.0");
        assert!(!s.supported && s.reason == Some("portable"));
        let s = status_for("KEY", false, "1.0.0");
        assert!(s.supported && s.reason.is_none());
    }
}
