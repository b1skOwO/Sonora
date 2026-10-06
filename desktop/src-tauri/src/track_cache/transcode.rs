//! Cross-platform audio transcoding via a managed `ffmpeg` binary.
//!
//! ffmpeg is acquired through the `ffmpeg-sidecar` crate: on first run it is
//! downloaded for the host OS into a writable app dir (the app is always online
//! anyway — it streams audio), and reused thereafter. A system `ffmpeg` on PATH
//! is preferred when present, sparing the download. The crate has baked-in URLs
//! for x86_64 and aarch64 on win/mac/linux (the ARM sources are third-party and
//! best-effort), so a downloaded binary is exec-tested (`ffmpeg -version`) before
//! it is trusted. When ffmpeg can't be obtained (offline, an unsupported target,
//! or a download that won't run) every entry point degrades gracefully: callers
//! keep the raw cached bytes.
//!
//! All writes are crash-safe: ffmpeg renders into a `.part` temp on the *same*
//! filesystem as the destination, which is then `rename`d into place atomically.
//! A power loss mid-render leaves only an orphan `.part` (swept on next launch);
//! a loss mid-rename leaves either the old file or the new one, never a torn one.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::process::Command;

/// AAC bitrate for re-encoded output. Matches the storage canonical (256k m4a);
/// sources that are already AAC are stream-copied and keep their original rate.
const AAC_BITRATE: &str = "256k";
/// Peak ceiling for re-encoded files. Sources routinely decode above full scale
/// (measured up to +6 dB on SoundCloud streams), which hard-clips inside the
/// encoder / the s16 conversion. A plain static attenuation — not a limiter —
/// brings the peak here, so dynamics are left untouched.
const ENCODE_PEAK_CEILING_DB: f64 = -0.5;

/// Output container/codec of the clean cache ("Б"). Chosen by the user in
/// Settings → Cache; applies to newly forged files (old ones re-forge on play).
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioFormat {
    M4a,
    Mp3,
    Wav,
}

impl Default for AudioFormat {
    fn default() -> Self {
        Self::M4a
    }
}

impl AudioFormat {
    pub fn label(self) -> &'static str {
        match self {
            Self::M4a => "m4a",
            Self::Mp3 => "mp3",
            Self::Wav => "wav",
        }
    }

    /// File extension (same as the label; kept as a named accessor for clarity).
    pub fn extension(self) -> &'static str {
        self.label()
    }

    pub fn from_label(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "m4a" | "aac" | "mp4" => Some(Self::M4a),
            "mp3" => Some(Self::Mp3),
            "wav" | "wave" => Some(Self::Wav),
            _ => None,
        }
    }
}

fn ffmpeg_bin_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

/// Resolve a usable ffmpeg, in order: an already-downloaded binary in
/// `install_dir`, a system `ffmpeg` on PATH, then a fresh download into
/// `install_dir`. Returns `None` when none can be obtained (cache then serves
/// raw bytes). Safe to call repeatedly — it no-ops once a binary is present.
pub async fn acquire_ffmpeg(install_dir: &Path) -> Option<PathBuf> {
    let bundled = install_dir.join(ffmpeg_bin_name());
    if bundled.is_file() && ffmpeg_runs(&bundled).await {
        return Some(bundled);
    }
    // Prefer a system ffmpeg — spares the download and is the safest bet on ARM,
    // where the crate's download sources are third-party / best-effort.
    let system = PathBuf::from("ffmpeg");
    if ffmpeg_runs(&system).await {
        return Some(system);
    }
    download_ffmpeg(install_dir).await
}

/// Whether `program -version` runs successfully — used both to detect a system
/// ffmpeg and to exec-test a freshly downloaded binary (rejects a wrong-arch or
/// corrupt download before we trust it).
async fn ffmpeg_runs(program: &Path) -> bool {
    let mut cmd = Command::new(program);
    cmd.arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    matches!(cmd.status().await, Ok(status) if status.success())
}

/// Download + unpack the host-appropriate ffmpeg into `install_dir`, then verify
/// it runs. Blocking work (ureq + archive extraction) runs off the async runtime.
/// Returns `None` on an unsupported target, a failed download, or a binary that
/// won't execute (e.g. a wrong-arch ARM build) — handled gracefully upstream.
async fn download_ffmpeg(install_dir: &Path) -> Option<PathBuf> {
    let dir = install_dir.to_path_buf();
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        use ffmpeg_sidecar::download::{
            download_ffmpeg_package, ffmpeg_download_url, unpack_ffmpeg_without_extras,
        };
        std::fs::create_dir_all(&dir).map_err(|e| format!("create ffmpeg dir: {e}"))?;
        let url = ffmpeg_download_url().map_err(|e| e.to_string())?;
        let archive = download_ffmpeg_package(url, &dir).map_err(|e| e.to_string())?;
        unpack_ffmpeg_without_extras(&archive, &dir).map_err(|e| e.to_string())?;
        std::fs::remove_file(&archive).ok();
        Ok(())
    })
        .await;

    match result {
        Ok(Ok(())) => {
            let bin = install_dir.join(ffmpeg_bin_name());
            if bin.is_file() && ffmpeg_runs(&bin).await {
                Some(bin)
            } else {
                eprintln!("[Transcode] downloaded ffmpeg does not run — discarding");
                tokio::fs::remove_file(&bin).await.ok();
                None
            }
        }
        Ok(Err(e)) => {
            eprintln!("[Transcode] ffmpeg download failed: {e}");
            None
        }
        Err(e) => {
            eprintln!("[Transcode] ffmpeg download task panicked: {e}");
            None
        }
    }
}

fn nonce() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

/// A sibling temp path in `dir` so the final `rename` stays on one filesystem.
/// The extension must match the target format — ffmpeg picks its muxer by it.
fn temp_sibling(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    dir.join(format!("{stem}.{}.part.{ext}", nonce()))
}

/// True when the payload is an ISO-BMFF (mp4/m4a) container — `....ftyp` at
/// offset 4. SoundCloud's AAC (progressive and HLS-with-init) arrives this way,
/// so it can be stream-copied into m4a instead of re-encoded.
fn is_mp4_container(prefix: &[u8]) -> bool {
    prefix.len() >= 8 && &prefix[4..8] == b"ftyp"
}

/// Read just the first `len` bytes of `path` (not the whole file) for a cheap
/// magic-byte sniff.
async fn sniff_head(path: &Path, len: usize) -> Vec<u8> {
    use tokio::io::AsyncReadExt;
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return Vec::new();
    };
    let mut buf = vec![0u8; len];
    match file.read(&mut buf).await {
        Ok(n) => {
            buf.truncate(n);
            buf
        }
        Err(_) => Vec::new(),
    }
}

/// Whether `path` is already an m4a/mp4 (AAC) container — a valid m4a as-is.
pub async fn is_m4a(path: &Path) -> bool {
    is_mp4_container(&sniff_head(path, 16).await)
}

fn base_command(ffmpeg: &Path) -> Command {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW — don't flash a console on Windows.
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

async fn run(mut cmd: Command, what: &str) -> Result<(), String> {
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("{what}: spawn ffmpeg: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let tail: String = stderr.lines().rev().take(3).collect::<Vec<_>>().join(" | ");
    Err(format!("{what}: ffmpeg exit {}: {tail}", output.status))
}

/// Transcode (or stream-copy) `input` into the chosen `format` at
/// `out_dir/final_name`, atomically. Already-AAC payloads are copied when the
/// target is m4a (near-free); everything else is re-encoded after a static,
/// peak-derived attenuation so hot sources can't clip. The temp render is
/// always cleaned up.
pub async fn transcode_audio(
    ffmpeg: &Path,
    input: &Path,
    out_dir: &Path,
    final_name: &str,
    format: AudioFormat,
    peak_db: Option<f64>,
) -> Result<PathBuf, String> {
    let final_path = out_dir.join(final_name);
    let tmp = temp_sibling(out_dir, final_name, format.extension());

    let head = sniff_head(input, 16).await;
    let can_copy = format == AudioFormat::M4a && is_mp4_container(&head);

    let mut copied = false;
    if can_copy {
        let mut cmd = base_command(ffmpeg);
        cmd.arg("-i").arg(input).args([
            "-vn",
            "-c:a",
            "copy",
            "-movflags",
            "+faststart",
        ]);
        cmd.arg(&tmp);
        match run(cmd, "remux").await {
            Ok(()) => copied = true,
            Err(e) => {
                // Copy can fail on exotic AAC profiles — fall through to encode.
                tokio::fs::remove_file(&tmp).await.ok();
                eprintln!("[Transcode] copy failed, re-encoding: {e}");
            }
        }
    }

    if !copied {
        // Static attenuation to the ceiling (never a boost): the only level
        // change applied to re-encodes, so transients keep their shape.
        let gain_db = peak_db
            .map(|peak| ENCODE_PEAK_CEILING_DB - peak)
            .filter(|gain| *gain < -0.05);

        let mut cmd = base_command(ffmpeg);
        cmd.arg("-i").arg(input).args(["-vn"]);
        if let Some(gain_db) = gain_db {
            cmd.arg("-af").arg(format!("volume={gain_db:.2}dB"));
        }
        match format {
            AudioFormat::M4a => {
                cmd.args(["-c:a", "aac", "-b:a", AAC_BITRATE, "-movflags", "+faststart"]);
            }
            AudioFormat::Mp3 => {
                cmd.args(["-c:a", "libmp3lame", "-q:a", "0"]);
            }
            AudioFormat::Wav => {
                cmd.args(["-c:a", "pcm_s16le"]);
            }
        }
        cmd.arg(&tmp);
        if let Err(e) = run(cmd, "encode").await {
            tokio::fs::remove_file(&tmp).await.ok();
            return Err(e);
        }
    }

    match tokio::fs::rename(&tmp, &final_path).await {
        Ok(()) => Ok(final_path),
        Err(e) => {
            tokio::fs::remove_file(&tmp).await.ok();
            Err(format!("commit transcode: {e}"))
        }
    }
}

/// Write `audio` (a clean cached file) to `dest`, optionally muxing in `cover`
/// (JPEG/PNG bytes) as the file's attached picture. Audio is stream-copied — no
/// quality loss. Atomic: renders to a temp beside `dest`, then renames.
pub async fn export_with_cover(
    ffmpeg: &Path,
    audio: &Path,
    cover: Option<&[u8]>,
    dest: &Path,
) -> Result<(), String> {
    let dest_dir = dest.parent().ok_or("export: dest has no parent dir")?;
    let stem = dest
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("export");
    let dest_ext = dest
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("m4a")
        .to_ascii_lowercase();
    let tmp = temp_sibling(dest_dir, stem, &dest_ext);

    // WAV carries no attached picture — never mux the cover into it.
    let cover = if dest_ext == "wav" { None } else { cover };

    // The cover is staged next to the temp so ffmpeg can read it as a 2nd input.
    let cover_tmp = match cover {
        Some(bytes) if !bytes.is_empty() => {
            let p = dest_dir.join(format!("{stem}.{}.cover", nonce()));
            if tokio::fs::write(&p, bytes).await.is_ok() {
                Some(p)
            } else {
                None
            }
        }
        _ => None,
    };

    let mut cmd = base_command(ffmpeg);
    cmd.arg("-i").arg(audio);
    if let Some(ref cover_path) = cover_tmp {
        cmd.arg("-i").arg(cover_path).args([
            "-map",
            "0:a",
            "-map",
            "1:v",
            "-c:a",
            "copy",
            "-c:v",
            "copy",
            "-disposition:v:0",
            "attached_pic",
            "-movflags",
            "+faststart",
        ]);
    } else {
        cmd.args(["-map", "0:a", "-c:a", "copy", "-movflags", "+faststart"]);
    }
    cmd.arg(&tmp);

    let result = run(cmd, "export").await;
    if let Some(cover_path) = cover_tmp {
        tokio::fs::remove_file(&cover_path).await.ok();
    }
    if let Err(e) = result {
        tokio::fs::remove_file(&tmp).await.ok();
        return Err(e);
    }

    match tokio::fs::rename(&tmp, dest).await {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            // Cross-device dest (rare) — fall back to copy+remove.
            match tokio::fs::copy(&tmp, dest).await {
                Ok(_) => {
                    tokio::fs::remove_file(&tmp).await.ok();
                    Ok(())
                }
                Err(copy_err) => {
                    tokio::fs::remove_file(&tmp).await.ok();
                    Err(format!("commit export: {rename_err}; {copy_err}"))
                }
            }
        }
    }
}

/// Whole-file sample peak in dBFS via ffmpeg's `astats` — may be positive for
/// hot lossy sources (their decoded float overshoots full scale). `None` when
/// ffmpeg fails or prints no peak. `astats` reports through the log system, so
/// this one cannot use the quiet `base_command`.
pub async fn probe_peak_db(ffmpeg: &Path, path: &Path) -> Option<f64> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-nostdin", "-hide_banner", "-loglevel", "info", "-i"])
        .arg(path)
        .args(["-vn", "-af", "astats", "-f", "null", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let output = cmd.output().await.ok()?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_peak_db(&stderr)
}

/// Last `Peak level dB:` line of astats output — the overall section.
fn parse_peak_db(stderr: &str) -> Option<f64> {
    stderr
        .lines()
        .filter_map(|line| {
            let idx = line.find("Peak level dB:")?;
            line[idx + "Peak level dB:".len()..]
                .trim()
                .parse::<f64>()
                .ok()
        })
        .last()
}

/// Probe a media file's duration in milliseconds via ffmpeg's `Duration:` line./// Used to validate cached files against the API-reported length. `None` when
/// ffmpeg is unavailable or the line can't be parsed.
pub async fn probe_duration_ms(ffmpeg: &Path, path: &Path) -> Option<u64> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-nostdin", "-hide_banner", "-i"])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    // `-i` with no output makes ffmpeg exit non-zero after printing metadata; we
    // only care about the stderr it emits, not the status.
    let output = cmd.output().await.ok()?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_duration_ms(&stderr)
}

/// Parse `Duration: HH:MM:SS.ss` out of ffmpeg's stderr into milliseconds.
fn parse_duration_ms(stderr: &str) -> Option<u64> {
    let idx = stderr.find("Duration:")?;
    let rest = stderr[idx + "Duration:".len()..].trim_start();
    let token = rest.split(',').next()?.trim();
    if token.starts_with("N/A") {
        return None;
    }
    let mut parts = token.split(':');
    let hours: u64 = parts.next()?.trim().parse().ok()?;
    let minutes: u64 = parts.next()?.trim().parse().ok()?;
    let secs_str = parts.next()?.trim();
    let secs: f64 = secs_str.parse().ok()?;
    let total_ms = (hours * 3600 + minutes * 60) as f64 * 1000.0 + secs * 1000.0;
    Some(total_ms.round() as u64)
}

#[cfg(test)]
mod tests {
    use super::{AudioFormat, is_mp4_container, parse_duration_ms, parse_peak_db};

    #[test]
    fn detects_mp4_container() {
        assert!(is_mp4_container(b"\x00\x00\x00\x20ftypM4A "));
        assert!(!is_mp4_container(b"ID3\x04\x00\x00\x00\x00")); // mp3
        assert!(!is_mp4_container(b"OggS\x00\x02\x00\x00")); // opus/ogg
        assert!(!is_mp4_container(b"\xff\xf1\x50\x80")); // adts aac
    }

    #[test]
    fn parses_duration_line() {
        let s = "  Duration: 00:03:25.71, start: 0.000000, bitrate: 256 kb/s";
        assert_eq!(parse_duration_ms(s), Some(205_710));
        assert_eq!(parse_duration_ms("Duration: 01:00:00.00,"), Some(3_600_000));
        assert_eq!(parse_duration_ms("Duration: N/A, bitrate: N/A"), None);
        assert_eq!(parse_duration_ms("no duration here"), None);
    }

    #[test]
    fn parses_audio_format_labels() {
        assert_eq!(AudioFormat::from_label("m4a"), Some(AudioFormat::M4a));
        assert_eq!(AudioFormat::from_label("AAC"), Some(AudioFormat::M4a));
        assert_eq!(AudioFormat::from_label("MP3"), Some(AudioFormat::Mp3));
        assert_eq!(AudioFormat::from_label(" wav "), Some(AudioFormat::Wav));
        assert_eq!(AudioFormat::from_label("flac"), None);
    }

    #[test]
    fn parses_astats_peak() {
        let s = "[Parsed_astats_0 @ 0x1] Channel: 1\n\
                 [Parsed_astats_0 @ 0x1] Peak level dB: 5.000629\n\
                 [Parsed_astats_0 @ 0x1] Overall\n\
                 [Parsed_astats_0 @ 0x1] Peak level dB: 6.603768\n";
        assert_eq!(parse_peak_db(s), Some(6.603768));
        assert_eq!(parse_peak_db("no stats here"), None);
    }
}
