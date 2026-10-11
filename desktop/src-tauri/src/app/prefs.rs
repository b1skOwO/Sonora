//! Boolean preferences read straight from the persisted `sc-settings.json`.
//!
//! A few settings are consumed outside the frontend store: WebView2 browser
//! arguments at startup (`memory`) and the close-button behavior in the window
//! event loop. Reading the file on demand keeps them always in sync with what
//! the UI persisted, without another IPC channel.

const SETTINGS_DIR: &str = "com.soundcloud.desktop";
const SETTINGS_FILE: &str = "sc-settings.json";

#[cfg(windows)]
fn settings_raw() -> Option<String> {
    let base = std::env::var_os("APPDATA")?;
    let path = std::path::Path::new(&base)
        .join(SETTINGS_DIR)
        .join(SETTINGS_FILE);
    std::fs::read_to_string(path).ok()
}

/// Read `state.<name>` from the persisted settings. `None` when the file or the
/// key is missing.
#[cfg(windows)]
pub fn read_bool(name: &str) -> Option<bool> {
    let raw = settings_raw()?;
    let json = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    let state = json.get("state").unwrap_or(&json);
    state.get(name).and_then(|value| value.as_bool())
}

#[cfg(not(windows))]
pub fn read_bool(_name: &str) -> Option<bool> {
    None
}
