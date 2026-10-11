//! Memory-pressure handling for the WebView2 front end (Windows).
//!
//! Three levers:
//!  * **Startup browser args** — the opt-in `memorySaver` / `disableGpu`
//!    toggles become `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`. That env var is
//!    only read while the WebView2 environment is created, so this must run
//!    before the Tauri runtime starts (`apply_startup_args` from `main`).
//!  * **Memory usage target level** — while the window is minimized/hidden the
//!    main webview is switched to `COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW`
//!    (the mechanism Edge uses for sleeping tabs) and back to NORMAL on
//!    restore.
//!  * **Working-set trim** — `EmptyWorkingSet` on this app's idle WebView2
//!    child processes (and on the host itself when no audio is playing), so a
//!    minimized player actually gives physical memory back to the system.

use tauri::Manager;

const WATCH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

/// Hand the persisted memory toggles to WebView2 as browser arguments.
///
/// MUST be called before the Tauri runtime starts: WebView2 reads the variable
/// once, while creating its environment.
pub fn apply_startup_args() {
    #[cfg(windows)]
    {
        let args = startup_args_from_settings();
        if args.is_empty() {
            return;
        }
        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        let merged = if existing.trim().is_empty() {
            args
        } else {
            format!("{existing} {args}")
        };
        // SAFETY: called from `main` before any thread or runtime exists.
        unsafe { std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged) };
    }
}

#[cfg(windows)]
fn startup_args_from_settings() -> String {
    let flag = |name: &str| crate::app::prefs::read_bool(name).unwrap_or(false);

    let mut args: Vec<&str> = Vec::new();
    if flag("memorySaver") {
        // Cap the V8 heap (GC runs earlier) and the GPU resource cache.
        args.push("--js-flags=--max-old-space-size=384");
        args.push("--force-gpu-mem-available-mb=64");
    }
    if flag("disableGpu") {
        // Software rendering: the whole GPU process goes away.
        args.push("--disable-gpu");
    }
    args.join(" ")
}

/// Start watching the main window's minimized/hidden state.
pub fn setup(app: &crate::rt::AppHandle) {
    #[cfg(windows)]
    {
        let app = app.clone();
        std::thread::Builder::new()
            .name("memory-watch".into())
            .spawn(move || watch_loop(app))
            .ok();
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

#[cfg(windows)]
fn watch_loop(app: crate::rt::AppHandle) {
    let mut low = false;
    loop {
        std::thread::sleep(WATCH_INTERVAL);
        let Some(window) = app.get_webview_window("main") else {
            continue;
        };
        let minimized = window.is_minimized().unwrap_or(false);
        let hidden = window.is_visible().map(|visible| !visible).unwrap_or(false);
        let next_low = minimized || hidden;
        if next_low == low {
            continue;
        }
        low = next_low;
        set_memory_target_level(&window, next_low);
        if next_low {
            trim_idle_processes(&app);
        }
    }
}

/// `ICoreWebView2_19::SetMemoryUsageTargetLevel` — Chromium then releases what
/// it can (caches, GC) while the window is not on screen, and re-warms on
/// restore.
#[cfg(all(windows, not(feature = "cef")))]
fn set_memory_target_level(window: &crate::rt::WebviewWindow, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        ICoreWebView2_19,
    };
    use windows_core::Interface;

    let _ = window.with_webview(move |webview| {
        let controller = webview.controller();
        if let Ok(level) = controller.cast::<ICoreWebView2_19>() {
            let target = if low {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
            } else {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
            };
            // SAFETY: COM call dispatched onto the WebView2 UI thread.
            unsafe {
                let _ = level.SetMemoryUsageTargetLevel(target);
            }
        }
    });
}

#[cfg(not(all(windows, not(feature = "cef"))))]
fn set_memory_target_level(_window: &crate::rt::WebviewWindow, _low: bool) {}

#[cfg(windows)]
fn trim_idle_processes(app: &crate::rt::AppHandle) {
    trim_webview_working_sets();
    // Trim the host too — but never while audio is pulling samples: the
    // page-in burst on the audio thread would glitch playback.
    if !audio_playing(app) {
        // SAFETY: GetCurrentProcess returns a valid pseudo-handle.
        unsafe {
            let _ = windows_sys::Win32::System::ProcessStatus::EmptyWorkingSet(
                windows_sys::Win32::System::Threading::GetCurrentProcess(),
            );
        }
    }
}

#[cfg(windows)]
fn audio_playing(app: &crate::rt::AppHandle) -> bool {
    use std::sync::atomic::Ordering;

    let Some(state) = app.try_state::<crate::audio::state::AudioState>() else {
        return false;
    };
    if !state.has_track.load(Ordering::Relaxed) {
        return false;
    }
    match state.player.try_lock() {
        Ok(player) => player
            .as_ref()
            .map(|player| !player.is_paused())
            .unwrap_or(false),
        // Locked (a load is mid-switch): assume playing and skip the trim.
        Err(_) => true,
    }
}

/// `EmptyWorkingSet` on every `msedgewebview2.exe` process that descends from
/// this app — other apps' WebView2 processes are never touched.
#[cfg(windows)]
fn trim_webview_working_sets() {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::ProcessStatus::EmptyWorkingSet;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
    };

    let mut entries: Vec<(u32, u32, bool)> = Vec::new(); // (pid, parent, is_webview)
    // SAFETY: the snapshot handle is closed below; `entry` is fully initialized.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return;
        }
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let name_len = entry
                    .szExeFile
                    .iter()
                    .position(|unit| *unit == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
                entries.push((
                    entry.th32ProcessID,
                    entry.th32ParentProcessID,
                    name.eq_ignore_ascii_case("msedgewebview2.exe"),
                ));
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
    }

    let me = std::process::id();
    let parent_of = |pid: u32| -> Option<u32> {
        entries
            .iter()
            .find(|(entry_pid, _, _)| *entry_pid == pid)
            .map(|(_, parent, _)| *parent)
    };

    for (pid, _, _) in entries.iter().filter(|(_, _, is_webview)| *is_webview) {
        // Walk the parent chain: ours = the chain reaches this process.
        let mut current = *pid;
        let mut ours = false;
        for _ in 0..8 {
            match parent_of(current) {
                Some(parent) if parent == me => {
                    ours = true;
                    break;
                }
                Some(parent) if parent != 0 && parent != current => current = parent,
                _ => break,
            }
        }
        if !ours {
            continue;
        }
        // SAFETY: handle is closed on both paths; EmptyWorkingSet is advisory.
        unsafe {
            let handle =
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA, 0, *pid);
            if handle == INVALID_HANDLE_VALUE || handle.is_null() {
                continue;
            }
            EmptyWorkingSet(handle);
            CloseHandle(handle);
        }
    }
}
