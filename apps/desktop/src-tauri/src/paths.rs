use std::path::PathBuf;

/// True when a `portable` marker file sits next to the executable.
pub fn is_portable() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join("portable").exists()))
        .unwrap_or(false)
}

/// Data root: `%APPDATA%\HTFlow\` (spec), or `<exe dir>\data\` in portable mode
/// (when a `portable` marker file sits next to the executable).
pub fn data_root(fallback: Option<PathBuf>) -> PathBuf {
    if is_portable() {
        if let Some(dir) = std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(|d| d.to_path_buf()))
        {
            return dir.join("data");
        }
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        return PathBuf::from(appdata).join("HTFlow");
    }
    fallback.unwrap_or_else(|| PathBuf::from(".htflow"))
}
