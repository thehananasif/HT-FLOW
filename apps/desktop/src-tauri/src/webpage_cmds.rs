//! P28 — embedded browser for the desktop app's Web Pages module.
//!
//! The main window's CSP blocks iframes, so each Web Page panel gets its own top-level
//! `WebviewWindow` labelled `webpage-<id>` (no `unstable` multi-webview feature). Security model:
//!
//! * The window label does not match any capability (`capabilities/default.json` is scoped to
//!   `main`), and Tauri refuses custom-command IPC from non-local origins that have no `remote`
//!   capability, so remote content can never reach our commands. No `remote` capability exists.
//! * Only `http` / `https` URLs without credentials are ever opened or navigated to. The
//!   `on_navigation` handler cancels everything else (`file:`, `javascript:`, `data:`, `blob:`,
//!   `tauri:`, `ipc:`, `about:`, custom schemes) and anything outside the panel's optional
//!   domain allow-list. `window.open` / `target=_blank` requests go through the same checks and
//!   then load in the same window or open in the system browser, per panel setting.
//! * The URL validation, allow-list matching and label rules are pure functions with unit tests.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};

use crate::error::{CmdError, CmdResult};

const LABEL_PREFIX: &str = "webpage-";
const MAX_ALLOW_ENTRIES: usize = 50;

// ---------------------------------------------------------------------------------------------
// Pure policy (unit tested)
// ---------------------------------------------------------------------------------------------

/// Accepts only absolute http(s) URLs with a host and no embedded credentials.
pub(crate) fn validate_url(raw: &str) -> Result<Url, &'static str> {
    let url = Url::parse(raw.trim()).map_err(|_| "Not a valid URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only http:// and https:// pages can be opened");
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("The address has no host");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Addresses with a user name or password are not allowed");
    }
    Ok(url)
}

/// Panel ids become part of a window label: letters, digits, `-` and `_`, 1..=64 chars.
pub(crate) fn label_for(id: &str) -> Result<String, &'static str> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(format!("{LABEL_PREFIX}{id}"))
    } else {
        Err("Invalid panel id")
    }
}

/// Normalises one allow-list entry to `host` or `*.host` (lower case), or `None` if invalid.
/// Accepts a pasted URL (`https://Example.com/path`) and keeps only its host.
pub(crate) fn normalize_allow_entry(raw: &str) -> Option<String> {
    let mut s = raw.trim().to_ascii_lowercase();
    if s.is_empty() {
        return None;
    }
    if let Some(i) = s.find("://") {
        s = s[i + 3..].to_string();
    }
    s = s.split(['/', '?', '#']).next().unwrap_or("").to_string();
    let (wild, host) = match s.strip_prefix("*.") {
        Some(h) => (true, h.trim_end_matches('.')),
        None => (false, s.trim_end_matches('.')),
    };
    let valid_label = |l: &str| {
        !l.is_empty()
            && l.len() <= 63
            && !l.starts_with('-')
            && !l.ends_with('-')
            && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    };
    if host.is_empty() || !host.split('.').all(valid_label) {
        return None;
    }
    if !host.contains('.') && host != "localhost" {
        return None;
    }
    Some(if wild {
        format!("*.{host}")
    } else {
        host.to_string()
    })
}

pub(crate) fn normalize_allow_list(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for e in raw.iter().filter_map(|e| normalize_allow_entry(e)) {
        if !out.contains(&e) && out.len() < MAX_ALLOW_ENTRIES {
            out.push(e);
        }
    }
    out
}

/// An empty list allows every host. `example.com` matches the host itself and its subdomains
/// (on a label boundary: `evilexample.com` does not match); `*.example.com` matches subdomains
/// only.
pub(crate) fn host_allowed(host: &str, allow: &[String]) -> bool {
    if allow.is_empty() {
        return true;
    }
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    allow.iter().any(|entry| match entry.strip_prefix("*.") {
        Some(base) => host.len() > base.len() && host.ends_with(&format!(".{base}")),
        None => host == *entry || host.ends_with(&format!(".{entry}")),
    })
}

/// The single decision used by navigation, new-window and open/navigate commands.
pub(crate) fn url_permitted(url: &Url, allow: &[String]) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && url
            .host_str()
            .is_some_and(|h| !h.is_empty() && host_allowed(h, allow))
}

// ---------------------------------------------------------------------------------------------
// State + events
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
struct PanelPolicy {
    allow: Vec<String>,
    /// `target=_blank` / `window.open`: false = load in this window, true = system browser.
    new_window_external: bool,
}

#[derive(Default)]
pub struct WebpageState {
    panels: Mutex<HashMap<String, Arc<Mutex<PanelPolicy>>>>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenArgs {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub new_window_external: bool,
    pub title: Option<String>,
    pub bounds: Option<Bounds>,
    #[serde(default)]
    pub always_on_top: bool,
}

#[derive(Clone, Serialize)]
struct NavEvent {
    id: String,
    url: String,
}

#[derive(Clone, Serialize)]
struct BoundsEvent {
    id: String,
    #[serde(flatten)]
    bounds: Bounds,
}

fn err(code: &str, msg: &str) -> CmdError {
    CmdError::new(code, msg)
}

fn policy_of(state: &WebpageState, label: &str) -> Option<Arc<Mutex<PanelPolicy>>> {
    state.panels.lock().ok()?.get(label).cloned()
}

fn clamp_bounds(b: Bounds) -> Bounds {
    let c = |v: f64, lo: f64, hi: f64| if v.is_finite() { v.clamp(lo, hi) } else { lo };
    Bounds {
        x: c(b.x, -10_000.0, 20_000.0),
        y: c(b.y, -10_000.0, 20_000.0),
        w: c(b.w, 320.0, 8_000.0),
        h: c(b.h, 240.0, 8_000.0),
    }
}

/// Opens an already validated http(s) URL in the system browser (no shell involved).
fn open_system_browser(url: &Url) -> CmdResult<()> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(err(
            "webpage.bad_url",
            "Only http(s) addresses can be opened",
        ));
    }
    let opener = if cfg!(windows) {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg(url.as_str())
        .spawn()
        .map(|_| ())
        .map_err(|_| err("webpage.open_external", "Could not open the system browser"))
}

fn get_window(app: &AppHandle, id: &str) -> CmdResult<tauri::WebviewWindow> {
    let label = label_for(id).map_err(|m| err("webpage.bad_id", m))?;
    app.get_webview_window(&label)
        .ok_or_else(|| err("webpage.not_open", "That page window is not open"))
}

/// Closes every Web Page window (called when the main window goes away).
pub fn close_all(app: &AppHandle) {
    for (label, w) in app.webview_windows() {
        if label.starts_with(LABEL_PREFIX) {
            let _ = w.destroy();
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

/// Opens (or re-uses) the window for panel `id` and loads `url`.
#[tauri::command]
pub async fn webpage_open(
    app: AppHandle,
    state: State<'_, WebpageState>,
    args: OpenArgs,
) -> CmdResult<()> {
    let label = label_for(&args.id).map_err(|m| err("webpage.bad_id", m))?;
    let allow = normalize_allow_list(&args.allow);
    let url = validate_url(&args.url).map_err(|m| err("webpage.bad_url", m))?;
    if !url_permitted(&url, &allow) {
        return Err(err(
            "webpage.blocked",
            "That address is not in the allow-list",
        ));
    }
    let fresh = PanelPolicy {
        allow,
        new_window_external: args.new_window_external,
    };

    if let Some(existing) = app.get_webview_window(&label) {
        if let Some(p) = policy_of(&state, &label) {
            if let Ok(mut p) = p.lock() {
                *p = fresh;
            }
        }
        existing
            .navigate(url)
            .map_err(|_| err("webpage.navigate", "Navigation failed"))?;
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    let policy = Arc::new(Mutex::new(fresh));
    state
        .panels
        .lock()
        .map_err(|_| err("webpage.state", "Internal error"))?
        .insert(label.clone(), policy.clone());

    let title = args
        .title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| format!("Web Page \u{2014} {}", url.host_str().unwrap_or("")));
    let nav_policy = policy.clone();
    let nav_app = app.clone();
    let nav_id = args.id.clone();
    let win_policy = policy;
    let win_app = app.clone();
    let win_label = label.clone();

    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
        .title(title)
        .always_on_top(args.always_on_top)
        .on_navigation(move |u| {
            let ok = nav_policy
                .lock()
                .map(|p| url_permitted(u, &p.allow))
                .unwrap_or(false);
            if ok {
                let _ = nav_app.emit(
                    "webpage://navigated",
                    NavEvent {
                        id: nav_id.clone(),
                        url: u.to_string(),
                    },
                );
            }
            ok
        })
        .on_new_window(move |u, _features| {
            let (allowed, external) = win_policy
                .lock()
                .map(|p| (url_permitted(&u, &p.allow), p.new_window_external))
                .unwrap_or((false, false));
            if allowed {
                if external {
                    let _ = open_system_browser(&u);
                } else if let Some(w) = win_app.get_webview_window(&win_label) {
                    let _ = w.navigate(u);
                }
            }
            NewWindowResponse::Deny
        });
    match args.bounds.map(clamp_bounds) {
        Some(b) => {
            builder = builder.inner_size(b.w, b.h).position(b.x, b.y);
        }
        None => builder = builder.inner_size(1000.0, 700.0).center(),
    }
    let win = builder.build().map_err(|_| {
        if let Ok(mut p) = state.panels.lock() {
            p.remove(&label);
        }
        err("webpage.open", "Could not open the page window")
    })?;

    let ev_app = app.clone();
    let ev_id = args.id;
    let ev_win = win.clone();
    win.on_window_event(move |e| match e {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            let scale = ev_win.scale_factor().unwrap_or(1.0);
            if let (Ok(p), Ok(s)) = (ev_win.outer_position(), ev_win.inner_size()) {
                let (p, s) = (p.to_logical::<f64>(scale), s.to_logical::<f64>(scale));
                let _ = ev_app.emit(
                    "webpage://bounds",
                    BoundsEvent {
                        id: ev_id.clone(),
                        bounds: Bounds {
                            x: p.x,
                            y: p.y,
                            w: s.width,
                            h: s.height,
                        },
                    },
                );
            }
        }
        WindowEvent::Destroyed => {
            if let Some(st) = ev_app.try_state::<WebpageState>() {
                if let Ok(mut p) = st.panels.lock() {
                    p.remove(&format!("{LABEL_PREFIX}{ev_id}"));
                }
            }
            let _ = ev_app.emit(
                "webpage://closed",
                NavEvent {
                    id: ev_id.clone(),
                    url: String::new(),
                },
            );
        }
        _ => {}
    });
    Ok(())
}

#[tauri::command]
pub async fn webpage_navigate(
    app: AppHandle,
    state: State<'_, WebpageState>,
    id: String,
    url: String,
) -> CmdResult<()> {
    let win = get_window(&app, &id)?;
    let url = validate_url(&url).map_err(|m| err("webpage.bad_url", m))?;
    let allow = policy_of(&state, win.label())
        .and_then(|p| p.lock().ok().map(|p| p.allow.clone()))
        .unwrap_or_default();
    if !url_permitted(&url, &allow) {
        return Err(err(
            "webpage.blocked",
            "That address is not in the allow-list",
        ));
    }
    win.navigate(url)
        .map_err(|_| err("webpage.navigate", "Navigation failed"))
}

#[tauri::command]
pub async fn webpage_back(app: AppHandle, id: String) -> CmdResult<()> {
    get_window(&app, &id)?
        .eval("history.back()")
        .map_err(|_| err("webpage.navigate", "Navigation failed"))
}

#[tauri::command]
pub async fn webpage_forward(app: AppHandle, id: String) -> CmdResult<()> {
    get_window(&app, &id)?
        .eval("history.forward()")
        .map_err(|_| err("webpage.navigate", "Navigation failed"))
}

#[tauri::command]
pub async fn webpage_reload(app: AppHandle, id: String) -> CmdResult<()> {
    get_window(&app, &id)?
        .reload()
        .map_err(|_| err("webpage.navigate", "Reload failed"))
}

#[tauri::command]
pub async fn webpage_close(app: AppHandle, id: String) -> CmdResult<()> {
    // Closing a window that is already gone is not an error.
    if let Ok(w) = get_window(&app, &id) {
        let _ = w.destroy();
    }
    Ok(())
}

#[tauri::command]
pub async fn webpage_set_bounds(app: AppHandle, id: String, bounds: Bounds) -> CmdResult<()> {
    let win = get_window(&app, &id)?;
    let b = clamp_bounds(bounds);
    win.set_size(LogicalSize::new(b.w, b.h))
        .and_then(|()| win.set_position(LogicalPosition::new(b.x, b.y)))
        .map_err(|_| err("webpage.bounds", "Could not move the window"))
}

#[tauri::command]
pub async fn webpage_set_always_on_top(app: AppHandle, id: String, on_top: bool) -> CmdResult<()> {
    get_window(&app, &id)?
        .set_always_on_top(on_top)
        .map_err(|_| err("webpage.bounds", "Could not change the window"))
}

/// Replaces the allow-list (and new-window behaviour) of an open panel; applies immediately.
#[tauri::command]
pub async fn webpage_set_policy(
    state: State<'_, WebpageState>,
    id: String,
    allow: Vec<String>,
    new_window_external: bool,
) -> CmdResult<Vec<String>> {
    let label = label_for(&id).map_err(|m| err("webpage.bad_id", m))?;
    let allow = normalize_allow_list(&allow);
    if let Some(p) = policy_of(&state, &label) {
        if let Ok(mut p) = p.lock() {
            p.allow = allow.clone();
            p.new_window_external = new_window_external;
        }
    }
    Ok(allow)
}

/// "Open in system browser": validated http(s) only.
#[tauri::command]
pub fn webpage_open_external(url: String) -> CmdResult<()> {
    let url = validate_url(&url).map_err(|m| err("webpage.bad_url", m))?;
    open_system_browser(&url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn validate_accepts_only_plain_http_and_https() {
        assert!(validate_url("https://example.com/a?b=1").is_ok());
        assert!(validate_url("  http://localhost:3000 ").is_ok());
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "tauri://localhost/index.html",
            "ipc://localhost/x",
            "blob:https://example.com/uuid",
            "about:blank",
            "htflow://thing",
            "ftp://example.com",
            "example.com",
            "",
            "https://",
            "https://user:pw@example.com/",
            "https://user@example.com/",
        ] {
            assert!(validate_url(bad).is_err(), "{bad} must be rejected");
        }
    }

    #[test]
    fn label_rules() {
        assert_eq!(label_for("abc_1-2").unwrap(), "webpage-abc_1-2");
        assert!(label_for("").is_err());
        assert!(label_for("a/b").is_err());
        assert!(label_for("main").is_ok_and(|l| l.starts_with("webpage-")));
        assert!(label_for(&"x".repeat(65)).is_err());
        assert!(label_for("a b").is_err());
    }

    #[test]
    fn allow_entries_normalise() {
        assert_eq!(
            normalize_allow_entry(" Example.COM "),
            Some("example.com".into())
        );
        assert_eq!(
            normalize_allow_entry("https://Docs.Example.com/path?q=1"),
            Some("docs.example.com".into())
        );
        assert_eq!(
            normalize_allow_entry("*.example.com"),
            Some("*.example.com".into())
        );
        assert_eq!(normalize_allow_entry("localhost"), Some("localhost".into()));
        for bad in [
            "",
            "   ",
            "nodots",
            "a..b",
            "-a.com",
            "exa mple.com",
            "*.",
            "*example.com",
        ] {
            assert_eq!(normalize_allow_entry(bad), None, "{bad:?}");
        }
        let list = normalize_allow_list(&["A.com".into(), "a.com".into(), "bad".into()]);
        assert_eq!(list, vec!["a.com".to_string()]);
    }

    #[test]
    fn allow_list_matching() {
        let none: Vec<String> = vec![];
        assert!(host_allowed("anything.example", &none));
        let l = vec!["example.com".to_string()];
        assert!(host_allowed("example.com", &l));
        assert!(host_allowed("WWW.Example.com", &l));
        assert!(host_allowed("example.com.", &l));
        assert!(!host_allowed("evilexample.com", &l));
        assert!(!host_allowed("example.com.evil.io", &l));
        let w = vec!["*.example.com".to_string()];
        assert!(host_allowed("a.example.com", &w));
        assert!(!host_allowed("example.com", &w));
        assert!(!host_allowed("xexample.com", &w));
    }

    #[test]
    fn url_permitted_blocks_schemes_and_hosts() {
        let l = vec!["example.com".to_string()];
        assert!(url_permitted(&u("https://example.com/x"), &l));
        assert!(url_permitted(&u("http://sub.example.com/"), &l));
        assert!(!url_permitted(&u("https://other.com/"), &l));
        assert!(!url_permitted(&u("file:///C:/Windows/win.ini"), &[]));
        assert!(!url_permitted(&u("data:text/html,x"), &[]));
        assert!(!url_permitted(&u("javascript:alert(1)"), &[]));
        assert!(!url_permitted(&u("tauri://localhost/"), &[]));
        assert!(!url_permitted(&u("https://a:b@example.com/"), &[]));
        assert!(url_permitted(&u("https://anything.org/"), &[]));
    }

    #[test]
    fn bounds_are_clamped() {
        let b = clamp_bounds(Bounds {
            x: f64::NAN,
            y: 1e9,
            w: 1.0,
            h: 1e9,
        });
        assert!(b.x.is_finite() && b.y <= 20_000.0 && b.w >= 320.0 && b.h <= 8_000.0);
    }
}
