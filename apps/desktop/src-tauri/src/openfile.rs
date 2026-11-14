//! P30 — file associations. Windows starts `htflow-desktop.exe "<file>"` for `.htprofile`,
//! `.htworkspace`, `.htind`, `.htidea` and `.httemplate`; the single-instance plugin forwards the
//! arguments of a second launch to the running app. Each existing, size-checked file is read and
//! handed to the UI as an `htflow:open-file` event (queued until the UI calls `open_file_ready`),
//! where the matching importer picks it up (see `ui/src/shell/openFile.ts`).
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Largest file accepted (profile bundles with recorded settings are well below this).
pub const MAX_BYTES: u64 = 32 * 1024 * 1024;

pub const EVENT: &str = "htflow:open-file";

/// Extension (lower-case, no dot) -> kind the UI routes on.
pub const KINDS: [(&str, &str); 5] = [
    ("htprofile", "profile"),
    ("htworkspace", "workspace"),
    ("htind", "indicator"),
    ("htidea", "idea"),
    ("httemplate", "template"),
];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenFile {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub kind: String,
    /// File text (UTF-8); empty when `error` is set.
    pub text: String,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct OpenFileState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    ready: bool,
    pending: Vec<OpenFile>,
}

/// `(ext, kind)` for a supported file name, else `None`.
pub fn classify(path: &Path) -> Option<(String, &'static str)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    KINDS
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, k)| (ext, *k))
}

/// Command-line arguments that name supported files (flags and the executable path are ignored).
pub fn paths_from_args<I: IntoIterator<Item = String>>(args: I) -> Vec<PathBuf> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .map(PathBuf::from)
        .filter(|p| classify(p).is_some())
        .collect()
}

/// Reads at most `MAX_BYTES` (+1 to detect overflow) whatever the metadata said earlier.
fn read_capped(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    use std::io::Read;
    let mut b = Vec::new();
    std::fs::File::open(path)?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut b)?;
    Ok((b.len() as u64 <= MAX_BYTES).then_some(b))
}

/// Reads one file for the UI. Problems become `error` so the UI can show a toast.
pub fn load(path: &Path) -> Option<OpenFile> {
    let (ext, kind) = classify(path)?;
    let mut f = OpenFile {
        path: path.display().to_string(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        ext,
        kind: kind.into(),
        text: String::new(),
        error: None,
    };
    match std::fs::metadata(path) {
        Ok(m) if !m.is_file() => f.error = Some("Not a file".into()),
        Ok(m) if m.len() > MAX_BYTES => f.error = Some("File is larger than 32 MB".into()),
        Ok(_) => match read_capped(path) {
            Ok(Some(b)) => match String::from_utf8(b) {
                Ok(t) => f.text = t.strip_prefix('\u{feff}').unwrap_or(&t).to_string(),
                Err(_) => f.error = Some("File is not UTF-8 text".into()),
            },
            // The file grew past the cap between the size check and the read.
            Ok(None) => f.error = Some("File is larger than 32 MB".into()),
            Err(_) => f.error = Some("Could not read the file".into()),
        },
        Err(_) => f.error = Some("File not found".into()),
    }
    Some(f)
}

/// Loads the files and either emits them or queues them until the UI is ready.
pub fn dispatch(app: &AppHandle, paths: Vec<PathBuf>) {
    let state = app.state::<OpenFileState>();
    for file in paths.iter().filter_map(|p| load(p)) {
        let mut g = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        if g.ready {
            drop(g);
            let _ = app.emit(EVENT, &file);
        } else {
            g.pending.push(file);
        }
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// The UI listener is attached: returns files queued so far and switches to direct emits.
#[tauri::command]
pub fn open_file_ready(state: State<'_, OpenFileState>) -> Vec<OpenFile> {
    let mut g = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    g.ready = true;
    std::mem::take(&mut g.pending)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_by_extension() {
        for (ext, kind) in KINDS {
            let (e, k) = classify(Path::new(&format!("C:\\x\\a.{}", ext.to_uppercase()))).unwrap();
            assert_eq!((e.as_str(), k), (ext, kind));
        }
        assert!(classify(Path::new("a.txt")).is_none());
        assert!(classify(Path::new("htprofile")).is_none());
    }

    #[test]
    fn args_keep_only_supported_files() {
        let args = ["htflow.exe", "--flag", "a.htidea", "b.exe", "c.HTPROFILE"]
            .map(String::from)
            .to_vec();
        let p = paths_from_args(args);
        assert_eq!(
            p,
            vec![PathBuf::from("a.htidea"), PathBuf::from("c.HTPROFILE")]
        );
    }

    #[test]
    fn loads_text_and_reports_errors() {
        let dir = std::env::temp_dir().join(format!("htflow-open-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ok = dir.join("t.httemplate");
        std::fs::write(&ok, "\u{feff}{\"a\":1}").unwrap();
        let f = load(&ok).unwrap();
        assert_eq!(
            (f.kind.as_str(), f.text.as_str(), f.error),
            ("template", "{\"a\":1}", None)
        );
        let bad = dir.join("b.htidea");
        std::fs::write(&bad, [0xff, 0xfe, 0xfd]).unwrap();
        assert_eq!(
            load(&bad).unwrap().error.as_deref(),
            Some("File is not UTF-8 text")
        );
        assert_eq!(
            load(&dir.join("missing.htind")).unwrap().error.as_deref(),
            Some("File not found")
        );
        assert!(load(Path::new("x.txt")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
