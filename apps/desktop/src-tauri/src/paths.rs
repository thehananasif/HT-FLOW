use std::path::PathBuf;

/// Data root: `%APPDATA%\HTFlow\` (spec), or `<exe dir>\data\` in portable mode
/// (when a `portable` marker file sits next to the executable).
pub fn data_root(fallback: Option<PathBuf>) -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if dir.join("portable").exists() {
                return dir.join("data");
            }
        }
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        return PathBuf::from(appdata).join("HTFlow");
    }
    fallback.unwrap_or_else(|| PathBuf::from(".htflow"))
}
