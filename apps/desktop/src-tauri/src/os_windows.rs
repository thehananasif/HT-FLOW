//! P02 / P25 / P44 — separate OS windows (multi-monitor). A dock group or a whole workspace can
//! move into its own `WebviewWindow`. Each secondary window loads the same UI with
//! `index.html?window=<label>`; the UI there renders only that group / workspace and talks to the
//! main window over the `htflow:bus` event (see `ui/src/platform/windowBus.ts`).
//!
//! Rust owns the native side only: creating / closing / listing windows, and remembering each
//! label's bounds and monitor in `<data>/windows.json`. Saved bounds are clamped to the monitors
//! connected today when the window opens again, so a window never comes back off-screen.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};

use crate::error::{CmdError, CmdResult};

/// Every secondary window label starts with this (the capability file matches `ht-w-*`).
pub const LABEL_PREFIX: &str = "ht-w-";
const MAX_LABEL_LEN: usize = 48;
const MAX_TITLE_LEN: usize = 120;
/// Labels remembered in `windows.json`; the least recently used ones are dropped beyond this.
pub const MAX_ENTRIES: usize = 64;
pub const MIN_WIDTH: u32 = 360;
pub const MIN_HEIGHT: u32 = 240;
const DEFAULT_WIDTH: u32 = 960;
const DEFAULT_HEIGHT: u32 = 640;
/// Sent to the main window when a secondary window is gone (closed by the user or the OS).
pub const CLOSED_EVENT: &str = "htflow:os-window-closed";

// ------------------------------------------------------------------ pure parts

/// `ht-w-` followed by `[a-z0-9-]`, at most 48 characters. Never `main`.
pub fn validate_label(label: &str) -> Result<(), &'static str> {
    let Some(rest) = label.strip_prefix(LABEL_PREFIX) else {
        return Err("Window label must start with ht-w-");
    };
    if rest.is_empty() || label.len() > MAX_LABEL_LEN {
        return Err("Window label has a bad length");
    }
    if !rest
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err("Window label may only use a-z, 0-9 and -");
    }
    Ok(())
}

/// Window title without control characters, at most 120 characters.
pub fn clean_title(title: &str) -> String {
    let t: String = title
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_TITLE_LEN)
        .collect();
    let t = t.trim();
    if t.is_empty() {
        "HT Flow".into()
    } else {
        format!("{t} — HT Flow")
    }
}

/// Physical pixels, like the monitor positions the OS reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    fn overlap(&self, o: &Rect) -> u64 {
        let l = self.x.max(o.x) as i64;
        let t = self.y.max(o.y) as i64;
        let r = (self.x as i64 + self.width as i64).min(o.x as i64 + o.width as i64);
        let b = (self.y as i64 + self.height as i64).min(o.y as i64 + o.height as i64);
        if r <= l || b <= t {
            0
        } else {
            ((r - l) * (b - t)) as u64
        }
    }
}

/// Saved placement of one secondary window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    #[serde(flatten)]
    pub rect: Rect,
    /// Monitor name the window was on (it goes back there when that monitor is connected).
    #[serde(default)]
    pub monitor: Option<String>,
    #[serde(default)]
    pub maximized: bool,
    /// Last use (seconds since 1970), for dropping old labels.
    #[serde(default)]
    pub used: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MonitorArea {
    pub name: Option<String>,
    pub rect: Rect,
    pub primary: bool,
}

/// The monitor a window belongs to: its saved monitor when still connected, else the one it
/// overlaps most, else the primary one.
pub fn pick_monitor<'a>(b: &Bounds, monitors: &'a [MonitorArea]) -> Option<&'a MonitorArea> {
    if let Some(name) = &b.monitor {
        if let Some(m) = monitors.iter().find(|m| m.name.as_deref() == Some(name)) {
            return Some(m);
        }
    }
    let best = monitors
        .iter()
        .map(|m| (m.rect.overlap(&b.rect), m))
        .filter(|(o, _)| *o > 0)
        .max_by_key(|(o, _)| *o)
        .map(|(_, m)| m);
    best.or_else(|| monitors.iter().find(|m| m.primary))
        .or_else(|| monitors.first())
}

/// Moves / shrinks saved bounds so the whole window is visible on today's monitors.
pub fn clamp_bounds(b: &Bounds, monitors: &[MonitorArea]) -> Bounds {
    let Some(m) = pick_monitor(b, monitors) else {
        let mut out = b.clone();
        out.rect.width = out.rect.width.max(MIN_WIDTH);
        out.rect.height = out.rect.height.max(MIN_HEIGHT);
        return out;
    };
    let a = m.rect;
    let width = b.rect.width.max(MIN_WIDTH).min(a.width);
    let height = b.rect.height.max(MIN_HEIGHT).min(a.height);
    let max_x = a.x as i64 + a.width as i64 - width as i64;
    let max_y = a.y as i64 + a.height as i64 - height as i64;
    let x = (b.rect.x as i64).clamp(a.x as i64, max_x) as i32;
    let y = (b.rect.y as i64).clamp(a.y as i64, max_y) as i32;
    Bounds {
        rect: Rect {
            x,
            y,
            width,
            height,
        },
        monitor: m.name.clone().or_else(|| b.monitor.clone()),
        maximized: b.maximized,
        used: b.used,
    }
}

/// First placement of a new label: the requested size, centred on `anchor` (the main window's
/// monitor), or on the primary monitor.
pub fn default_bounds(
    width: Option<u32>,
    height: Option<u32>,
    anchor: Option<&MonitorArea>,
    monitors: &[MonitorArea],
) -> Bounds {
    let width = width.unwrap_or(DEFAULT_WIDTH);
    let height = height.unwrap_or(DEFAULT_HEIGHT);
    let m = anchor
        .or_else(|| monitors.iter().find(|m| m.primary))
        .or_else(|| monitors.first());
    let (x, y) = match m {
        Some(m) => (
            m.rect.x + (m.rect.width as i32 - width as i32) / 2,
            m.rect.y + (m.rect.height as i32 - height as i32) / 2,
        ),
        None => (100, 100),
    };
    let b = Bounds {
        rect: Rect {
            x,
            y,
            width,
            height,
        },
        monitor: m.and_then(|m| m.name.clone()),
        maximized: false,
        used: 0,
    };
    clamp_bounds(&b, monitors)
}

/// `windows.json`: saved bounds per label.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BoundsFile {
    pub version: u32,
    pub windows: BTreeMap<String, Bounds>,
}

impl BoundsFile {
    /// Parses the file; unreadable files and bad labels are dropped (never an error).
    pub fn parse(text: &str) -> Self {
        let mut f: BoundsFile = serde_json::from_str(text).unwrap_or_default();
        f.windows.retain(|k, _| validate_label(k).is_ok());
        f.version = 1;
        f.prune();
        f
    }

    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .map(|t| Self::parse(&t))
            .unwrap_or_else(|_| BoundsFile {
                version: 1,
                windows: BTreeMap::new(),
            })
    }

    /// Keeps the `MAX_ENTRIES` most recently used labels.
    pub fn prune(&mut self) {
        if self.windows.len() <= MAX_ENTRIES {
            return;
        }
        let mut by_use: Vec<(u64, String)> = self
            .windows
            .iter()
            .map(|(k, b)| (b.used, k.clone()))
            .collect();
        by_use.sort();
        let drop = by_use.len() - MAX_ENTRIES;
        for (_, k) in by_use.into_iter().take(drop) {
            self.windows.remove(&k);
        }
    }

    pub fn to_text(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".into())
    }

    /// Atomic write (temp file + rename).
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, self.to_text())?;
        std::fs::rename(&tmp, path)
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ------------------------------------------------------------------ Tauri glue

pub struct OsWindowsState {
    path: PathBuf,
    file: Mutex<BoundsFile>,
}

impl OsWindowsState {
    pub fn new(root: &Path) -> Self {
        let path = root.join("windows.json");
        let file = BoundsFile::load(&path);
        Self {
            path,
            file: Mutex::new(file),
        }
    }

    fn get(&self, label: &str) -> Option<Bounds> {
        self.file
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .windows
            .get(label)
            .cloned()
    }

    fn put(&self, label: &str, b: Bounds) {
        let mut f = self.file.lock().unwrap_or_else(|e| e.into_inner());
        f.windows.insert(label.to_string(), b);
    }

    fn save(&self) {
        let mut f = self.file.lock().unwrap_or_else(|e| e.into_inner());
        f.version = 1;
        f.prune();
        if let Err(e) = f.save(&self.path) {
            tracing::warn!(error = %e, "could not save window bounds");
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub label: String,
    pub title: String,
    /// Size of a new window (physical pixels); saved bounds win when the label is known.
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsWindowInfo {
    pub label: String,
    pub title: String,
    pub bounds: Option<Bounds>,
}

fn monitors_of(app: &AppHandle) -> (Vec<MonitorArea>, Option<MonitorArea>) {
    let main = app.get_webview_window("main");
    let primary_name = main
        .as_ref()
        .and_then(|w| w.primary_monitor().ok().flatten())
        .and_then(|m| m.name().cloned());
    let list = main
        .as_ref()
        .and_then(|w| w.available_monitors().ok())
        .unwrap_or_default();
    let areas: Vec<MonitorArea> = list
        .iter()
        .map(|m| MonitorArea {
            name: m.name().cloned(),
            rect: Rect {
                x: m.position().x,
                y: m.position().y,
                width: m.size().width,
                height: m.size().height,
            },
            primary: m.name().is_some() && m.name().cloned() == primary_name,
        })
        .collect();
    let anchor_name = main
        .as_ref()
        .and_then(|w| w.current_monitor().ok().flatten())
        .and_then(|m| m.name().cloned());
    let anchor = areas
        .iter()
        .find(|m| m.name.is_some() && m.name == anchor_name)
        .cloned();
    (areas, anchor)
}

fn current_bounds(w: &tauri::WebviewWindow) -> Option<Bounds> {
    let pos = w.outer_position().ok()?;
    let size = w.inner_size().ok()?;
    // Minimised windows report a zero size (and x = -32000 on Windows): keep the last bounds.
    if size.width == 0 || size.height == 0 || pos.x <= -32000 {
        return None;
    }
    Some(Bounds {
        rect: Rect {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
        },
        monitor: w
            .current_monitor()
            .ok()
            .flatten()
            .and_then(|m| m.name().cloned()),
        maximized: w.is_maximized().unwrap_or(false),
        used: now_secs(),
    })
}

/// Remembers the bounds of a secondary window while it moves / resizes (not while maximised,
/// so restoring from maximised returns to the last normal size).
fn track(app: &AppHandle, w: &tauri::WebviewWindow) {
    let label = w.label().to_string();
    let app2 = app.clone();
    let win = w.clone();
    w.on_window_event(move |ev| {
        let st = app2.state::<OsWindowsState>();
        match ev {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                if let Some(mut b) = current_bounds(&win) {
                    if b.maximized {
                        if let Some(prev) = st.get(&label) {
                            b.rect = prev.rect;
                        }
                    }
                    st.put(&label, b);
                }
            }
            WindowEvent::Destroyed => {
                st.save();
                let _ = app2.emit_to("main", CLOSED_EVENT, &label);
            }
            _ => {}
        }
    });
}

/// Opens (or focuses) a secondary window. Async: creating a window from a synchronous command
/// deadlocks on Windows.
#[tauri::command]
pub async fn os_window_open(
    app: AppHandle,
    state: State<'_, OsWindowsState>,
    req: OpenRequest,
) -> CmdResult<OsWindowInfo> {
    validate_label(&req.label).map_err(|m| CmdError::new("window.label", m))?;
    let title = clean_title(&req.title);
    if let Some(w) = app.get_webview_window(&req.label) {
        let _ = w.set_title(&title);
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(OsWindowInfo {
            label: req.label,
            title,
            bounds: current_bounds(&w),
        });
    }
    let (monitors, anchor) = monitors_of(&app);
    let bounds = match state.get(&req.label) {
        Some(saved) => clamp_bounds(&saved, &monitors),
        None => default_bounds(req.width, req.height, anchor.as_ref(), &monitors),
    };
    let url = WebviewUrl::App(format!("index.html?window={}", req.label).into());
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(&app, &req.label, url)
        .title(&title)
        .decorations(false)
        .visible(false)
        .min_inner_size(MIN_WIDTH as f64 / 1.5, MIN_HEIGHT as f64 / 1.5)
        .background_color(tauri::window::Color(0, 0, 0, 255));
    // Same WebView2 arguments as the main window, or WebView2 refuses the new webview.
    #[cfg(windows)]
    if let Some(args) = crate::native_prefs::session_browser_args() {
        builder = builder.additional_browser_args(args);
    }
    let w = builder
        .build()
        .map_err(|e| CmdError::new("window.open", e.to_string()))?;
    let _ = w.set_size(PhysicalSize::new(bounds.rect.width, bounds.rect.height));
    let _ = w.set_position(PhysicalPosition::new(bounds.rect.x, bounds.rect.y));
    if bounds.maximized {
        let _ = w.maximize();
    }
    let _ = w.show();
    let _ = w.set_focus();
    let mut stored = bounds.clone();
    stored.used = now_secs();
    state.put(&req.label, stored);
    state.save();
    track(&app, &w);
    Ok(OsWindowInfo {
        label: req.label,
        title,
        bounds: Some(bounds),
    })
}

/// Closes a secondary window (its bounds are saved first).
#[tauri::command]
pub fn os_window_close(
    app: AppHandle,
    state: State<'_, OsWindowsState>,
    label: String,
) -> CmdResult<bool> {
    validate_label(&label).map_err(|m| CmdError::new("window.label", m))?;
    let Some(w) = app.get_webview_window(&label) else {
        return Ok(false);
    };
    if let Some(b) = current_bounds(&w) {
        if !b.maximized {
            state.put(&label, b);
        }
    }
    state.save();
    w.close()
        .map_err(|e| CmdError::new("window.close", e.to_string()))?;
    Ok(true)
}

/// Brings a secondary window to the front.
#[tauri::command]
pub fn os_window_focus(app: AppHandle, label: String) -> CmdResult<bool> {
    validate_label(&label).map_err(|m| CmdError::new("window.label", m))?;
    Ok(match app.get_webview_window(&label) {
        Some(w) => {
            let _ = w.unminimize();
            w.set_focus().is_ok()
        }
        None => false,
    })
}

/// Secondary windows that are open now.
#[tauri::command]
pub fn os_window_list(app: AppHandle) -> Vec<OsWindowInfo> {
    app.webview_windows()
        .into_iter()
        .filter(|(l, _)| validate_label(l).is_ok())
        .map(|(label, w)| OsWindowInfo {
            title: w.title().unwrap_or_default(),
            bounds: current_bounds(&w),
            label,
        })
        .collect()
}

/// The main window is gone: close every secondary window (the app exits with them).
pub fn close_all(app: &AppHandle) {
    for (label, w) in app.webview_windows() {
        if validate_label(&label).is_ok() {
            let _ = w.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(name: &str, x: i32, y: i32, w: u32, h: u32, primary: bool) -> MonitorArea {
        MonitorArea {
            name: Some(name.into()),
            rect: Rect {
                x,
                y,
                width: w,
                height: h,
            },
            primary,
        }
    }

    fn b(x: i32, y: i32, w: u32, h: u32, monitor: Option<&str>) -> Bounds {
        Bounds {
            rect: Rect {
                x,
                y,
                width: w,
                height: h,
            },
            monitor: monitor.map(String::from),
            maximized: false,
            used: 0,
        }
    }

    #[test]
    fn labels_are_validated() {
        assert!(validate_label("ht-w-abc123").is_ok());
        assert!(validate_label("ht-w-a-b-c").is_ok());
        for bad in [
            "main", "ht-w-", "HT-W-abc", "ht-w-ABC", "ht-w-a_b", "ht-w-a/b", "ht-w-a b",
            "x-ht-w-a", "ht-w-é",
        ] {
            assert!(validate_label(bad).is_err(), "{bad}");
        }
        assert!(validate_label(&format!("ht-w-{}", "a".repeat(43))).is_ok());
        assert!(validate_label(&format!("ht-w-{}", "a".repeat(44))).is_err());
    }

    #[test]
    fn titles_are_cleaned() {
        assert_eq!(clean_title("Chart\n BTC"), "Chart BTC — HT Flow");
        assert_eq!(clean_title("  "), "HT Flow");
        assert_eq!(clean_title(&"x".repeat(500)).chars().count(), 120 + 10);
    }

    #[test]
    fn bounds_stay_on_their_saved_monitor() {
        let ms = [
            mon("A", 0, 0, 1920, 1080, true),
            mon("B", 1920, 0, 2560, 1440, false),
        ];
        let c = clamp_bounds(&b(2000, 100, 800, 600, Some("B")), &ms);
        assert_eq!(c, b(2000, 100, 800, 600, Some("B")));
        // Saved on B but placed partly off its right edge: pulled back inside B.
        let c = clamp_bounds(&b(4300, 1200, 800, 600, Some("B")), &ms);
        assert_eq!(
            c.rect,
            Rect {
                x: 3680,
                y: 840,
                width: 800,
                height: 600
            }
        );
    }

    #[test]
    fn missing_monitor_falls_back_to_overlap_then_primary() {
        let ms = [
            mon("A", 0, 0, 1920, 1080, false),
            mon("C", -1280, 0, 1280, 1024, true),
        ];
        // Monitor B is gone; the window overlaps A most.
        let c = clamp_bounds(&b(1800, 50, 600, 400, Some("B")), &ms);
        assert_eq!(c.monitor.as_deref(), Some("A"));
        assert_eq!(c.rect.x, 1920 - 600);
        // Entirely off-screen: primary monitor C.
        let c = clamp_bounds(&b(9000, 9000, 600, 400, Some("B")), &ms);
        assert_eq!(c.monitor.as_deref(), Some("C"));
        assert_eq!((c.rect.x, c.rect.y), (-1280 + 1280 - 600, 1024 - 400));
    }

    #[test]
    fn size_is_clamped_to_monitor_and_minimum() {
        let ms = [mon("A", 0, 0, 1280, 720, true)];
        let c = clamp_bounds(&b(-50, -50, 4000, 3000, Some("A")), &ms);
        assert_eq!(
            c.rect,
            Rect {
                x: 0,
                y: 0,
                width: 1280,
                height: 720
            }
        );
        let c = clamp_bounds(&b(10, 10, 10, 10, Some("A")), &ms);
        assert_eq!((c.rect.width, c.rect.height), (MIN_WIDTH, MIN_HEIGHT));
        // No monitor information at all: only the minimum size applies.
        let c = clamp_bounds(&b(5, 5, 10, 10, None), &[]);
        assert_eq!(
            c.rect,
            Rect {
                x: 5,
                y: 5,
                width: MIN_WIDTH,
                height: MIN_HEIGHT
            }
        );
    }

    #[test]
    fn default_bounds_centre_on_anchor() {
        let ms = [
            mon("A", 0, 0, 1920, 1080, true),
            mon("B", 1920, 0, 1920, 1080, false),
        ];
        let d = default_bounds(Some(800), Some(600), Some(&ms[1]), &ms);
        assert_eq!(
            d.rect,
            Rect {
                x: 1920 + 560,
                y: 240,
                width: 800,
                height: 600
            }
        );
        assert_eq!(d.monitor.as_deref(), Some("B"));
        let d = default_bounds(None, None, None, &ms);
        assert_eq!(d.monitor.as_deref(), Some("A"));
    }

    #[test]
    fn bounds_file_round_trip_and_pruning() {
        let mut f = BoundsFile {
            version: 1,
            windows: BTreeMap::new(),
        };
        let mut x = b(1, 2, 800, 600, Some("A"));
        x.maximized = true;
        x.used = 42;
        f.windows.insert("ht-w-one".into(), x.clone());
        let back = BoundsFile::parse(&f.to_text());
        assert_eq!(back, f);

        // Bad labels and garbage are dropped, never an error.
        let text = r#"{"version":1,"windows":{"main":{"x":0,"y":0,"width":1,"height":1},
            "ht-w-ok":{"x":3,"y":4,"width":500,"height":400}}}"#;
        let p = BoundsFile::parse(text);
        assert_eq!(p.windows.len(), 1);
        assert_eq!(p.windows["ht-w-ok"].monitor, None);
        assert!(BoundsFile::parse("not json").windows.is_empty());

        for i in 0..(MAX_ENTRIES + 5) {
            let mut e = b(0, 0, 500, 400, None);
            e.used = i as u64;
            f.windows.insert(format!("ht-w-n{i}"), e);
        }
        f.prune();
        assert_eq!(f.windows.len(), MAX_ENTRIES);
        // The least recently used labels went first.
        assert!(!f.windows.contains_key("ht-w-n0"));
        assert!(f
            .windows
            .contains_key(&format!("ht-w-n{}", MAX_ENTRIES + 4)));

        let dir = std::env::temp_dir().join(format!("htflow-oswin-{}", std::process::id()));
        let path = dir.join("windows.json");
        f.save(&path).unwrap();
        assert_eq!(BoundsFile::load(&path), f);
        assert!(BoundsFile::load(&dir.join("missing.json"))
            .windows
            .is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
