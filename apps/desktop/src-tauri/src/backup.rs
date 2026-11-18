//! Profile backups. The sealed profile folder (`<data>/profiles/`, already encrypted with the
//! account keys, see `paths.rs`) is copied into `<data>/backups/<timestamp>/`. A timer checks at
//! start-up and then daily whether the newest backup is older than `common.backupDays`, and the
//! oldest backups beyond `common.maxBackups` are deleted.
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::crash::open_folder;
use crate::error::{CmdError, CmdResult};
use crate::native_prefs::NativeState;

/// How often the scheduler re-checks whether a backup is due.
const CHECK_EVERY: Duration = Duration::from_secs(24 * 3600);

pub fn backups_dir(root: &Path) -> PathBuf {
    root.join("backups")
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Days since 1970-01-01 -> (year, month, day), proleptic Gregorian.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = i64::from(if m > 2 { m - 3 } else { m + 9 });
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `YYYYMMDD-HHMMSS` (UTC). Sorts chronologically as plain text.
pub fn timestamp_name(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}{m:02}{d:02}-{:02}{:02}{:02}",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Seconds since the epoch encoded in a backup folder name (`YYYYMMDD-HHMMSS[-n]`).
pub fn parse_name(name: &str) -> Option<u64> {
    let b = name.as_bytes();
    if b.len() < 15 || b[8] != b'-' {
        return None;
    }
    if !b[..8].iter().chain(&b[9..15]).all(u8::is_ascii_digit) {
        return None;
    }
    if b.len() > 15 && (b[15] != b'-' || b.len() == 16 || !b[16..].iter().all(u8::is_ascii_digit)) {
        return None;
    }
    let n = |r: std::ops::Range<usize>| name[r].parse::<u32>().ok();
    let (y, mo, d) = (i64::from(n(0..4)?), n(4..6)?, n(6..8)?);
    let (h, mi, s) = (n(9..11)?, n(11..13)?, n(13..15)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 59 {
        return None;
    }
    let days = days_from_civil(y, mo, d);
    u64::try_from(days * 86_400)
        .ok()
        .map(|t| t + u64::from(h * 3600 + mi * 60 + s))
}

/// The oldest backup names beyond `max` (names that are not backup folders are ignored).
pub fn select_prune(names: &[String], max: usize) -> Vec<String> {
    let mut v: Vec<&String> = names.iter().filter(|n| parse_name(n).is_some()).collect();
    v.sort();
    let excess = v.len().saturating_sub(max);
    v.into_iter().take(excess).cloned().collect()
}

/// True when no backup exists yet or the newest one is at least `days` old.
pub fn is_due(newest: Option<u64>, now: u64, days: u32) -> bool {
    newest.is_none_or(|t| now.saturating_sub(t) >= u64::from(days) * 86_400)
}

fn list_names(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| parse_name(n).is_some())
        .collect()
}

fn copy_dir(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for e in fs::read_dir(src)? {
        let e = e?;
        let ty = e.file_type()?;
        let to = dst.join(e.file_name());
        if ty.is_dir() {
            copy_dir(&e.path(), &to)?;
        } else if ty.is_file() {
            fs::copy(e.path(), to)?;
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub name: String,
    pub path: String,
}

/// Copies `<root>/profiles` into `<root>/backups/<timestamp>/`.
pub fn backup_now(root: &Path, now: u64) -> io::Result<BackupInfo> {
    let src = root.join("profiles");
    if !src.is_dir() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "no profiles yet"));
    }
    let dir = backups_dir(root);
    fs::create_dir_all(&dir)?;
    let base = timestamp_name(now);
    let mut name = base.clone();
    let mut n = 1;
    while dir.join(&name).exists() {
        n += 1;
        name = format!("{base}-{n}");
    }
    // Copy next to the final folder, then rename: a half-copied backup never looks complete.
    let tmp = dir.join(format!(".partial-{name}"));
    let _ = fs::remove_dir_all(&tmp);
    if let Err(e) = copy_dir(&src, &tmp).and_then(|_| fs::rename(&tmp, dir.join(&name))) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(e);
    }
    Ok(BackupInfo {
        path: dir.join(&name).to_string_lossy().into_owned(),
        name,
    })
}

/// Deletes the oldest backups beyond `max`; returns the removed names.
pub fn prune(root: &Path, max: usize) -> Vec<String> {
    let dir = backups_dir(root);
    select_prune(&list_names(&dir), max)
        .into_iter()
        .filter(|n| fs::remove_dir_all(dir.join(n)).is_ok())
        .collect()
}

fn newest(root: &Path) -> Option<u64> {
    list_names(&backups_dir(root))
        .iter()
        .filter_map(|n| parse_name(n))
        .max()
}

/// One scheduler pass: back up when due, then prune.
pub fn run_due(root: &Path, days: u32, max: u32, now: u64) {
    if is_due(newest(root), now, days) {
        match backup_now(root, now) {
            Ok(b) => tracing::info!(name = %b.name, "profile backup created"),
            Err(e) => tracing::warn!(error = %e, "profile backup skipped"),
        }
    }
    let removed = prune(root, max as usize);
    if !removed.is_empty() {
        tracing::info!(count = removed.len(), "old profile backups deleted");
    }
}

/// Checks at start-up and then daily, reading the current preferences on every pass.
pub fn spawn_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let (root, days, max) = {
                let st = app.state::<NativeState>();
                let p = st.prefs.lock().map(|p| p.clone()).unwrap_or_default();
                (st.root.clone(), p.backup_days, p.max_backups)
            };
            let _ = tauri::async_runtime::spawn_blocking(move || {
                run_due(&root, days, max, now_secs());
            })
            .await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// "Back up now": copies the sealed profile folder into a new `backups\<timestamp>\`.
#[tauri::command]
pub async fn profile_backup_now(state: State<'_, NativeState>) -> CmdResult<BackupInfo> {
    let root = state.root.clone();
    tauri::async_runtime::spawn_blocking(move || backup_now(&root, now_secs()))
        .await
        .map_err(|_| CmdError::new("backup.failed", "Backup task failed"))?
        .map_err(|e| CmdError::new("backup.failed", format!("Backup failed: {e}")))
}

/// Deletes the oldest backups beyond `max`; returns how many were removed.
#[tauri::command]
pub async fn profile_backup_prune(state: State<'_, NativeState>, max: u32) -> CmdResult<u32> {
    let root = state.root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        prune(&root, max.clamp(1, 100) as usize).len() as u32
    })
    .await
    .map_err(|_| CmdError::new("backup.failed", "Prune task failed"))
}

/// Opens `<data>/backups/` in the file manager.
#[tauri::command]
pub fn open_backups_folder(state: State<'_, NativeState>) -> CmdResult<()> {
    let dir = backups_dir(&state.root);
    fs::create_dir_all(&dir)
        .map_err(|_| CmdError::new("backup.folder", "Could not create the backups folder"))?;
    open_folder(&dir).map_err(|_| CmdError::new("backup.folder", "Could not open the folder"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamp_naming_round_trips() {
        assert_eq!(timestamp_name(0), "19700101-000000");
        // 2024-02-29 12:34:56 UTC (leap day).
        assert_eq!(timestamp_name(1_709_210_096), "20240229-123456");
        assert_eq!(parse_name("20240229-123456"), Some(1_709_210_096));
        assert_eq!(parse_name("20240229-123456-3"), Some(1_709_210_096));
        for t in [0u64, 86_399, 951_782_400, 1_709_210_096, 4_102_444_799] {
            assert_eq!(parse_name(&timestamp_name(t)), Some(t));
        }
        for bad in [
            "",
            "x",
            "20240229-12345",
            "20241399-000000",
            "20240229_123456",
            "20240229-123456-",
            "20240229-123456-x",
        ] {
            assert_eq!(parse_name(bad), None, "{bad}");
        }
    }

    #[test]
    fn prune_keeps_newest() {
        let names: Vec<String> = [
            "20260103-000000",
            "20260101-000000",
            "20260101-000000-2",
            "20260102-000000",
            "notes",
            ".partial-20260101-000000",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(
            select_prune(&names, 2),
            vec![
                "20260101-000000".to_string(),
                "20260101-000000-2".to_string()
            ]
        );
        assert!(select_prune(&names, 4).is_empty());
        assert!(select_prune(&names, 10).is_empty());
        assert_eq!(select_prune(&names, 0).len(), 4);
    }

    #[test]
    fn due_check() {
        let day = 86_400;
        assert!(is_due(None, 1000, 1));
        assert!(!is_due(Some(1000), 1000 + day - 1, 1));
        assert!(is_due(Some(1000), 1000 + day, 1));
        assert!(!is_due(Some(1000), 1000 + 6 * day, 7));
    }

    #[test]
    fn backup_copies_profiles_and_prunes() {
        let root = std::env::temp_dir().join(format!("htflow-backup-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("profiles/abc")).unwrap();
        fs::write(root.join("profiles/abc/settings.bin"), b"sealed").unwrap();
        assert!(backup_now(&root.join("nope"), 1).is_err());
        let a = backup_now(&root, 1_709_210_096).unwrap();
        let b = backup_now(&root, 1_709_210_096).unwrap();
        assert_eq!(a.name, "20240229-123456");
        assert_eq!(b.name, "20240229-123456-2");
        assert_eq!(
            fs::read(backups_dir(&root).join(&a.name).join("abc/settings.bin")).unwrap(),
            b"sealed"
        );
        let c = backup_now(&root, 1_709_300_000).unwrap();
        assert_eq!(prune(&root, 1), vec![a.name.clone(), b.name.clone()]);
        assert_eq!(list_names(&backups_dir(&root)), vec![c.name]);
        let _ = fs::remove_dir_all(&root);
    }
}
