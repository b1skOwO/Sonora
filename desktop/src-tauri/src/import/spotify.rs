//! Spotify playlist import: public embed metadata + YouTube matching.
//!
//! Spotify's public embed page exposes the first 100 tracks of a playlist as
//! hydration JSON — no OAuth needed. Each track is then searched on YouTube
//! (`ytsearch`) and the best candidate is matched by title / artist / duration.
//! Matched videos are YouTube-backed tracks, downloaded on demand by yt-dlp.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::Emitter;

use crate::rt::AppHandle;
use crate::track_cache::TrackCacheState;
use crate::ytdlp::YtEntry;

static CANCEL_FLAG: std::sync::LazyLock<Arc<AtomicBool>> =
    std::sync::LazyLock::new(|| Arc::new(AtomicBool::new(false)));

/// The embed page exposes at most 100 entries.
const MAX_TRACKS: usize = 100;
const SEARCH_RESULTS: usize = 3;
const SEARCH_DELAY_MS: u64 = 250;
const MATCH_THRESHOLD: f64 = 0.4;
/// Abort the import when this many searches fail in a row (YouTube unreachable).
const MAX_CONSECUTIVE_ERRORS: u32 = 3;

const SPOTIFY_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

#[derive(serde::Serialize, Clone)]
pub struct SpotifyTrack {
    pub title: String,
    pub artists: String,
    pub duration_ms: u64,
}

#[derive(serde::Serialize, Clone)]
pub struct SpotifyPlaylist {
    pub id: String,
    pub title: String,
    pub tracks: Vec<SpotifyTrack>,
}

#[derive(serde::Serialize, Clone)]
pub struct SpotifyImportProgress {
    pub total: usize,
    pub current: usize,
    pub matched: usize,
    pub not_found: usize,
    pub current_track: String,
}

#[derive(serde::Serialize, Clone)]
pub struct SpotifyImportMatch {
    pub title: String,
    pub artists: String,
    pub duration_ms: u64,
    pub video_id: String,
    pub video_title: String,
    pub uploader: Option<String>,
    pub duration_secs: Option<f64>,
    pub thumbnail: Option<String>,
}

/// Pull the playlist id out of a share link / URI / embed link.
fn extract_playlist_id(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(rest) = trimmed.strip_prefix("spotify:playlist:") {
        let id: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        return (!id.is_empty()).then_some(id);
    }
    let re = regex::Regex::new(r"playlist/([A-Za-z0-9]+)").ok()?;
    re.captures(trimmed).map(|c| c[1].to_string())
}

fn extract_next_data(html: &str) -> Option<String> {
    let start = html.find("__NEXT_DATA__")?;
    let after = &html[start..];
    let open = after.find('>')? + 1;
    let close = after[open..].find("</script>")? + open;
    Some(after[open..close].to_string())
}

async fn fetch_playlist(client: &wreq::Client, id: &str) -> Result<SpotifyPlaylist, String> {
    let url = format!("https://open.spotify.com/embed/playlist/{id}");
    let resp = client
        .get(&url)
        .header("user-agent", SPOTIFY_UA)
        .send()
        .await
        .map_err(|e| format!("Spotify request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Spotify HTTP {}", resp.status()));
    }
    let html = resp
        .text()
        .await
        .map_err(|e| format!("Spotify body: {e}"))?;
    let raw = extract_next_data(&html).ok_or("No playlist data on the Spotify page")?;
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("Spotify JSON: {e}"))?;
    let entity = value
        .pointer("/props/pageProps/state/data/entity")
        .ok_or("Unexpected Spotify page structure")?;

    let title = entity
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Spotify playlist")
        .to_string();
    let tracks = entity
        .get("trackList")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|t| {
                    let title = t.get("title").and_then(|v| v.as_str())?.trim().to_string();
                    if title.is_empty() {
                        return None;
                    }
                    let artists = t
                        .get("subtitle")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    let duration_ms = t.get("duration").and_then(|v| v.as_u64()).unwrap_or(0);
                    Some(SpotifyTrack {
                        title,
                        artists,
                        duration_ms,
                    })
                })
                .take(MAX_TRACKS)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if tracks.is_empty() {
        return Err("The Spotify playlist has no tracks (private or empty?)".into());
    }
    Ok(SpotifyPlaylist {
        id: id.to_string(),
        title,
        tracks,
    })
}

/// Lowercase, drop bracketed suffixes like "(Official Video)", keep alphanumerics.
fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut depth = 0u32;
    for ch in text.chars() {
        match ch {
            '(' | '[' | '【' | '（' | '「' => depth += 1,
            ')' | ']' | '】' | '）' | '」' => depth = depth.saturating_sub(1),
            _ if depth > 0 => {}
            _ => {
                if ch.is_alphanumeric() {
                    for lc in ch.to_lowercase() {
                        out.push(lc);
                    }
                } else {
                    out.push(' ');
                }
            }
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn score_match(track: &SpotifyTrack, candidate: &YtEntry) -> f64 {
    let sp_title = normalize(&track.title);
    let cand_title = normalize(&candidate.title);
    if sp_title.is_empty() || cand_title.is_empty() {
        return 0.0;
    }

    let mut score = 0.0;
    if cand_title == sp_title || cand_title.contains(&sp_title) || sp_title.contains(&cand_title) {
        score += 0.55;
    } else {
        let a: std::collections::HashSet<&str> = sp_title.split(' ').collect();
        let b: std::collections::HashSet<&str> = cand_title.split(' ').collect();
        let inter = a.intersection(&b).count() as f64;
        let union = a.union(&b).count().max(1) as f64;
        score += 0.55 * (inter / union);
    }

    let uploader = candidate
        .uploader
        .as_deref()
        .map(normalize)
        .unwrap_or_default();
    let artist_match = track
        .artists
        .split([',', '&'])
        .map(normalize)
        .filter(|a| !a.is_empty())
        .any(|a| cand_title.contains(&a) || uploader.contains(&a));
    if artist_match {
        score += 0.30;
    }

    if let (Some(yt_secs), true) = (candidate.duration_secs, track.duration_ms > 0) {
        let diff = (yt_secs - track.duration_ms as f64 / 1000.0).abs();
        if diff <= 5.0 {
            score += 0.15;
        } else if diff <= 15.0 {
            score += 0.08;
        }
    }

    score
}

async fn search_best(ytdlp: &Path, track: &SpotifyTrack) -> Result<Option<YtEntry>, String> {
    let query = if track.artists.trim().is_empty() {
        track.title.clone()
    } else {
        format!("{} {}", track.title, track.artists)
    };
    let entries = crate::ytdlp::search_tracks(ytdlp, &query, SEARCH_RESULTS).await?;
    let best = entries.iter().max_by(|a, b| {
        score_match(track, a)
            .partial_cmp(&score_match(track, b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    match best {
        Some(entry) if score_match(track, entry) >= MATCH_THRESHOLD => Ok(Some(entry.clone())),
        _ => Ok(None),
    }
}

/// Fetch a Spotify playlist, match every track on YouTube and stream the
/// matches to the frontend (`spotify_import:progress` / `:match`).
#[tauri::command]
pub async fn spotify_import_start(
    url: String,
    state: tauri::State<'_, TrackCacheState>,
    app: AppHandle,
) -> Result<SpotifyPlaylist, String> {
    let id = extract_playlist_id(&url).ok_or("Could not find a playlist id in that link")?;
    let client = wreq::Client::builder()
        .redirect(wreq::redirect::Policy::limited(5))
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;

    let playlist = fetch_playlist(&client, &id).await?;
    let Some(ytdlp) = state.ytdlp().await else {
        return Err("yt-dlp is not available (check your connection)".into());
    };

    CANCEL_FLAG.store(false, Ordering::Relaxed);
    let total = playlist.tracks.len();
    let mut matched = 0usize;
    let mut not_found = 0usize;
    let mut consecutive_errors = 0u32;

    for (index, track) in playlist.tracks.iter().enumerate() {
        if CANCEL_FLAG.load(Ordering::Relaxed) {
            break;
        }

        let label = if track.artists.is_empty() {
            track.title.clone()
        } else {
            format!("{} — {}", track.artists, track.title)
        };
        let _ = app.emit(
            "spotify_import:progress",
            SpotifyImportProgress {
                total,
                current: index,
                matched,
                not_found,
                current_track: label,
            },
        );

        match search_best(&ytdlp, track).await {
            Ok(Some(entry)) => {
                consecutive_errors = 0;
                matched += 1;
                let _ = app.emit(
                    "spotify_import:match",
                    SpotifyImportMatch {
                        title: track.title.clone(),
                        artists: track.artists.clone(),
                        duration_ms: track.duration_ms,
                        video_id: entry.id.clone(),
                        video_title: entry.title.clone(),
                        uploader: entry.uploader.clone(),
                        duration_secs: entry.duration_secs,
                        thumbnail: entry.thumbnail.clone(),
                    },
                );
            }
            Ok(None) => {
                consecutive_errors = 0;
                not_found += 1;
            }
            Err(error) => {
                eprintln!("[Spotify] search failed for '{}': {error}", track.title);
                not_found += 1;
                consecutive_errors += 1;
                if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                    return Err(format!("YouTube search failed: {error}"));
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(SEARCH_DELAY_MS)).await;
    }

    let _ = app.emit(
        "spotify_import:progress",
        SpotifyImportProgress {
            total,
            current: total,
            matched,
            not_found,
            current_track: String::new(),
        },
    );
    Ok(playlist)
}

#[tauri::command]
pub fn spotify_import_stop() {
    CANCEL_FLAG.store(true, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::{extract_playlist_id, fetch_playlist, search_best};

    #[test]
    fn extracts_playlist_ids() {
        assert_eq!(
            extract_playlist_id("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc"),
            Some("37i9dQZF1DXcBWIGoYBM5M".to_string())
        );
        assert_eq!(
            extract_playlist_id("https://open.spotify.com/embed/playlist/0vvXsWCC9xrXsKd4FyS8kM"),
            Some("0vvXsWCC9xrXsKd4FyS8kM".to_string())
        );
        assert_eq!(
            extract_playlist_id("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M"),
            Some("37i9dQZF1DXcBWIGoYBM5M".to_string())
        );
        assert_eq!(extract_playlist_id("https://example.com/foo"), None);
        assert_eq!(extract_playlist_id(""), None);
    }

    /// Live smoke: fetch a real playlist and match its first tracks on YouTube.
    /// Run with `cargo test --lib spotify::tests::smoke_live_import -- --ignored --nocapture`.
    #[test]
    #[ignore = "live network"]
    fn smoke_live_import() {
        let rt = tokio::runtime::Runtime::new().expect("runtime");
        rt.block_on(async {
            let client = wreq::Client::new();
            let playlist = fetch_playlist(&client, "37i9dQZF1DXcBWIGoYBM5M")
                .await
                .expect("spotify fetch");
            println!("playlist: {} ({} tracks)", playlist.title, playlist.tracks.len());
            assert!(!playlist.tracks.is_empty());

            let dir = std::env::temp_dir().join("sonora-ytdlp-smoke");
            let bin = crate::ytdlp::acquire(&dir).await.expect("yt-dlp");
            for track in playlist.tracks.iter().take(3) {
                let best = search_best(&bin, track).await.expect("search");
                match best {
                    Some(entry) => println!(
                        "MATCH  {:>40} — {:<30} => {} [{}] {:?}s",
                        track.artists, track.title, entry.title, entry.id, entry.duration_secs
                    ),
                    None => println!("NO MATCH  {} — {}", track.artists, track.title),
                }
            }
        });
    }
}
