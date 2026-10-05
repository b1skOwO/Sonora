//! Managed `yt-dlp` binary: acquisition, playlist metadata and audio download.
//!
//! Same shape as the ffmpeg handling in `track_cache::transcode`: prefer an
//! already-installed binary, then a system one on `PATH`, then download the
//! standalone release into a writable app dir. The YouTube playlist import uses
//! `fetch_playlist` (fast, `--flat-playlist`) and the track cache uses
//! `download_audio` to materialise a playable m4a.

use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

/// Cap on imported playlist size — mirrors the Yandex Music importer's limit.
const MAX_PLAYLIST_ENTRIES: usize = 500;
const FETCH_TIMEOUT_SECS: u64 = 180;
const DOWNLOAD_TIMEOUT_SECS: u64 = 900;

fn bin_name() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    }
}

fn download_url() -> &'static str {
    if cfg!(windows) {
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
    } else {
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux"
    }
}

/// Playlist entry as handed to the frontend.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct YtEntry {
    pub id: String,
    pub title: String,
    pub uploader: Option<String>,
    pub duration_secs: Option<f64>,
    pub thumbnail: Option<String>,
}

/// Playlist (or single video) metadata as handed to the frontend.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct YtPlaylist {
    pub id: Option<String>,
    pub title: String,
    pub uploader: Option<String>,
    pub entries: Vec<YtEntry>,
}

fn apply_no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW — don't flash a console on Windows.
        cmd.creation_flags(0x0800_0000);
    }
}

/// Whether `program --version` runs successfully — detects a system install and
/// exec-tests a fresh download before trusting it.
async fn runs(program: &Path) -> bool {
    let mut cmd = Command::new(program);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    apply_no_window(&mut cmd);
    matches!(cmd.status().await, Ok(status) if status.success())
}

/// Resolve a usable yt-dlp, in order: an already-downloaded binary in
/// `install_dir`, a system `yt-dlp` on PATH, then a fresh download. `None` when
/// none can be obtained (the YouTube import then reports an error).
pub async fn acquire(install_dir: &Path) -> Option<PathBuf> {
    let bundled = install_dir.join(bin_name());
    if bundled.is_file() && runs(&bundled).await {
        return Some(bundled);
    }
    let system = PathBuf::from("yt-dlp");
    if runs(&system).await {
        return Some(system);
    }
    download(install_dir).await
}

/// Force-refresh the managed binary from the latest GitHub release. Returns the
/// binary path on success.
pub async fn update(install_dir: &Path) -> Option<PathBuf> {
    let bin = install_dir.join(bin_name());
    tokio::fs::remove_file(&bin).await.ok();
    download(install_dir).await
}

async fn download(install_dir: &Path) -> Option<PathBuf> {
    if tokio::fs::create_dir_all(install_dir).await.is_err() {
        return None;
    }
    let client = wreq::Client::builder()
        .redirect(wreq::redirect::Policy::limited(10))
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(300))
        .build()
        .ok()?;
    let resp = client.get(download_url()).send().await.ok()?;
    if !resp.status().is_success() {
        eprintln!("[yt-dlp] download failed: HTTP {}", resp.status());
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    let tmp = install_dir.join(format!("{}.part", bin_name()));
    tokio::fs::write(&tmp, &bytes).await.ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).ok();
    }
    let bin = install_dir.join(bin_name());
    if tokio::fs::rename(&tmp, &bin).await.is_err() {
        tokio::fs::remove_file(&tmp).await.ok();
        return None;
    }
    if runs(&bin).await {
        println!("[yt-dlp] ready: {}", bin.display());
        Some(bin)
    } else {
        eprintln!("[yt-dlp] downloaded binary does not run — discarding");
        tokio::fs::remove_file(&bin).await.ok();
        None
    }
}

/// Whether a URL targets YouTube (the only host the preflight applies to).
fn is_youtube_target(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains("youtube.com") || lower.contains("youtu.be")
}

/// Quick reachability probe before spawning yt-dlp. Catches the common failure
/// mode where a VPN/proxy client leaves a fake-IP DNS entry behind (198.18/15)
/// while its tunnel is down — yt-dlp would otherwise spend 1–2 minutes retrying
/// every player client before failing. Returns a user-facing error on failure.
async fn preflight_youtube() -> Result<(), String> {
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host(("www.youtube.com", 443))
        .await
        .map_err(|e| format!("DNS lookup for www.youtube.com failed: {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err("DNS lookup for www.youtube.com returned no addresses".into());
    }

    // Proxy/VPN fake-IP space (Clash/WireSock/mihomo-style): a live DNS hijack
    // with a dead tunnel — fail instantly with an actionable message.
    if let Some(ip) = addrs.iter().find_map(|addr| match addr.ip() {
        IpAddr::V4(v4) if v4.octets()[0] == 198 && (v4.octets()[1] & 0xfe) == 18 => Some(v4),
        _ => None,
    }) {
        return Err(format!(
            "www.youtube.com resolves to {ip} — a VPN/proxy fake IP (DNS hijack). \
             Turn the VPN off or restart it, then run `ipconfig /flushdns`."
        ));
    }

    let target = addrs
        .iter()
        .find(|addr| addr.is_ipv4())
        .copied()
        .unwrap_or(addrs[0]);
    match tokio::time::timeout(Duration::from_secs(6), tokio::net::TcpStream::connect(target)).await
    {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(format!(
            "cannot reach www.youtube.com:443 ({e}) — check your VPN / proxy / DNS"
        )),
        Err(_) => {
            Err("cannot reach www.youtube.com:443 (timed out) — check your VPN / proxy / DNS".into())
        }
    }
}

/// Fetch playlist (or single-video) metadata without downloading media.
pub async fn fetch_playlist(bin: &Path, url: &str) -> Result<YtPlaylist, String> {
    if is_youtube_target(url) {
        preflight_youtube().await?;
    }
    let mut cmd = Command::new(bin);
    cmd.args([
        "--ignore-config",
        "--no-warnings",
        "--flat-playlist",
        "--dump-single-json",
        "--skip-download",
        "--socket-timeout",
        "15",
        "--retries",
        "1",
        "--playlist-end",
    ])
    .arg(MAX_PLAYLIST_ENTRIES.to_string())
    .arg(url)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
    apply_no_window(&mut cmd);

    let output = tokio::time::timeout(Duration::from_secs(FETCH_TIMEOUT_SECS), cmd.output())
        .await
        .map_err(|_| "yt-dlp timed out while reading the playlist".to_string())?
        .map_err(|e| format!("yt-dlp failed to start: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "yt-dlp failed ({}): {}{}",
            output.status,
            stderr_tail(&stderr),
            connection_hint(&stderr)
        ));
    }

    let value: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| format!("yt-dlp JSON: {e}"))?;

    let entries_value = value.get("entries").filter(|e| !e.is_null());
    if let Some(entries) = entries_value {
        let title = value
            .get("title")
            .and_then(|t| t.as_str())
            .unwrap_or("YouTube")
            .to_string();
        let uploader = value
            .get("uploader")
            .or_else(|| value.get("channel"))
            .and_then(|u| u.as_str())
            .map(str::to_string);
        let id = value.get("id").and_then(|i| i.as_str()).map(str::to_string);
        let list: Vec<YtEntry> = entries
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(parse_entry)
                    .take(MAX_PLAYLIST_ENTRIES)
                    .collect()
            })
            .unwrap_or_default();
        if list.is_empty() {
            return Err("the playlist has no playable entries".into());
        }
        Ok(YtPlaylist {
            id,
            title,
            uploader,
            entries: list,
        })
    } else {
        let entry = parse_entry(&value).ok_or("unrecognized yt-dlp output")?;
        Ok(YtPlaylist {
            id: Some(entry.id.clone()),
            title: entry.title.clone(),
            uploader: entry.uploader.clone(),
            entries: vec![entry],
        })
    }
}

fn parse_entry(value: &serde_json::Value) -> Option<YtEntry> {
    let id = value.get("id").and_then(|i| i.as_str())?.to_string();
    let title = value
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or(&id)
        .to_string();
    let uploader = value
        .get("uploader")
        .or_else(|| value.get("channel"))
        .and_then(|u| u.as_str())
        .map(str::to_string);
    let duration_secs = value.get("duration").and_then(|d| d.as_f64());
    let thumbnail = value
        .get("thumbnails")
        .and_then(|t| t.as_array())
        .and_then(|arr| arr.last())
        .and_then(|t| t.get("url"))
        .and_then(|u| u.as_str())
        .map(str::to_string)
        .or_else(|| Some(format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg")));
    Some(YtEntry {
        id,
        title,
        uploader,
        duration_secs,
        thumbnail,
    })
}

/// Download a single video's audio into `dest` (an extension-less cache path).
/// Prefers YouTube's m4a/AAC stream so no re-encode happens; anything else is
/// converted to m4a by ffmpeg via yt-dlp's extract-audio postprocessor.
/// `on_progress` receives 0.0..1.0 while the download runs.
pub async fn download_audio<F: Fn(f64)>(
    bin: &Path,
    ffmpeg: Option<&Path>,
    url: &str,
    dest: &Path,
    on_progress: F,
) -> Result<(), String> {
    if is_youtube_target(url) {
        preflight_youtube().await?;
    }
    let dir = dest.parent().ok_or("download destination has no parent")?;
    let stem = dest
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("download destination has no file name")?;
    cleanup_partials(dir, stem).await;

    let template = dir.join(format!("{stem}.ytdl.%(ext)s"));
    let mut cmd = Command::new(bin);
    cmd.args([
        "--ignore-config",
        "--no-warnings",
        "--newline",
        "--no-playlist",
        "--force-overwrites",
        "--socket-timeout",
        "15",
        "--retries",
        "1",
        "-f",
        "bestaudio[ext=m4a]/bestaudio",
        "-x",
        "--audio-format",
        "m4a",
        "--audio-quality",
        "0",
        "-o",
    ])
    .arg(&template);
    if let Some(ffmpeg) = ffmpeg {
        cmd.arg("--ffmpeg-location").arg(ffmpeg);
    }
    cmd.arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    apply_no_window(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("yt-dlp failed to start: {e}"))?;

    // Drain stderr in the background so a full pipe can never deadlock the child.
    let stderr_task = child.stderr.take().map(|mut stderr| {
        tokio::spawn(async move {
            let mut buf = String::new();
            let _ = stderr.read_to_string(&mut buf).await;
            buf
        })
    });

    let mut lines = BufReader::new(child.stdout.take().ok_or("yt-dlp has no stdout")?).lines();
    let deadline = tokio::time::sleep(Duration::from_secs(DOWNLOAD_TIMEOUT_SECS));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                cleanup_partials(dir, stem).await;
                return Err("yt-dlp download timed out".into());
            }
            line = lines.next_line() => match line {
                Ok(Some(line)) => {
                    if let Some(progress) = parse_progress(&line) {
                        on_progress(progress);
                    }
                }
                _ => break,
            },
        }
    }

    let status = child.wait().await.map_err(|e| format!("yt-dlp wait: {e}"))?;
    let stderr = match stderr_task {
        Some(task) => task.await.unwrap_or_default(),
        None => String::new(),
    };

    if !status.success() {
        cleanup_partials(dir, stem).await;
        return Err(format!(
            "yt-dlp failed ({}): {}{}",
            status,
            stderr_tail(&stderr),
            connection_hint(&stderr)
        ));
    }

    let produced = find_output(dir, stem)
        .await
        .ok_or("yt-dlp produced no audio file")?;
    tokio::fs::rename(&produced, dest)
        .await
        .map_err(|e| format!("commit download: {e}"))?;
    Ok(())
}

/// Last few non-empty stderr lines, for error messages.
fn stderr_tail(stderr: &str) -> String {
    stderr
        .lines()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join(" | ")
}

/// Friendly hint appended when the failure looks like a blocked/dead route
/// (VPN fake-IP leftovers, proxy down, DNS hijack) rather than a bad URL.
fn connection_hint(stderr: &str) -> &'static str {
    let lower = stderr.to_lowercase();
    if lower.contains("timed out")
        || lower.contains("unable to download webpage")
        || lower.contains("unable to download api page")
        || lower.contains("connection refused")
    {
        " (YouTube is unreachable — check your VPN / proxy / DNS)"
    } else {
        ""
    }
}

/// Parse yt-dlp's `[download]  12.3% of ...` progress lines.
fn parse_progress(line: &str) -> Option<f64> {
    let rest = line.strip_prefix("[download]")?.trim_start();
    let pct: f64 = rest.split('%').next()?.trim().parse().ok()?;
    Some((pct / 100.0).clamp(0.0, 1.0))
}

#[cfg(test)]
mod tests {
    use super::{is_youtube_target, parse_progress};

    #[test]
    fn parses_download_progress_lines() {
        let p = parse_progress("[download]  12.3% of    3.29MiB at 1.2MiB/s ETA 00:02")
            .expect("progress");
        assert!((p - 0.123).abs() < 1e-9, "got {p}");
        assert_eq!(parse_progress("[download] 100.0% of 3.29MiB"), Some(1.0));
        assert_eq!(parse_progress("[youtube] dQw4w9WgXcQ: Downloading webpage"), None);
        assert_eq!(parse_progress("[download] Destination: C:\\x.m4a"), None);
    }

    #[test]
    fn detects_youtube_targets() {
        assert!(is_youtube_target("https://www.youtube.com/watch?v=x"));
        assert!(is_youtube_target("https://youtu.be/x"));
        assert!(is_youtube_target("https://music.youtube.com/playlist?list=x"));
        assert!(!is_youtube_target("https://soundcloud.com/x"));
    }
}

/// Remove stale `*.ytdl.*` leftovers for `stem` (previous crashed attempts).
async fn cleanup_partials(dir: &Path, stem: &str) {
    let prefix = format!("{stem}.ytdl.");
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(&prefix) {
            tokio::fs::remove_file(entry.path()).await.ok();
        }
    }
}

/// Find the file yt-dlp produced for `stem` (prefers the final `.m4a`).
async fn find_output(dir: &Path, stem: &str) -> Option<PathBuf> {
    let prefix = format!("{stem}.ytdl.");
    let mut entries = tokio::fs::read_dir(dir).await.ok()?;
    let mut fallback: Option<PathBuf> = None;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let name = name.to_string_lossy().to_string();
        if !name.starts_with(&prefix) || name.ends_with(".part") {
            continue;
        }
        let path = entry.path();
        if name.ends_with(".m4a") {
            return Some(path);
        }
        fallback = Some(path);
    }
    fallback
}
