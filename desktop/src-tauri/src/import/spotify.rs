//! Spotify playlist import: public embed metadata + YouTube matching.
//!
//! Spotify's public embed page exposes the first 100 tracks of a playlist as
//! hydration JSON — no OAuth needed. Each track is then searched on YouTube
//! (`ytsearch`) and the best candidate is matched by title / artist / duration.
//! Matched videos are YouTube-backed tracks, downloaded on demand by yt-dlp.

use std::collections::HashMap;
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
/// Candidates per track search — a bigger pool so the artist's own channel can
/// beat a random re-upload that ranks higher.
const SEARCH_RESULTS: usize = 6;
/// Candidates when discovering an artist's channel by name.
const ARTIST_SEARCH_RESULTS: usize = 10;
/// How many distinct artists are resolved to channels per import run (each
/// lookup costs one extra yt-dlp search).
const MAX_ARTIST_LOOKUPS: usize = 5;
/// Score bonus for a candidate uploaded by the artist's own channel.
const OFFICIAL_CHANNEL_BONUS: f64 = 0.35;
const SEARCH_DELAY_MS: u64 = 250;
const MATCH_THRESHOLD: f64 = 0.4;
/// Second-chance floor: when nothing solid is found, a re-upload or a
/// differently credited upload still beats dropping the track entirely.
const FALLBACK_THRESHOLD: f64 = 0.2;
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

/// Split a Spotify `subtitle` ("Artist A, Artist B") into artist names.
fn split_artists(artists: &str) -> Vec<String> {
    artists
        .split([',', '&'])
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

/// Resolve an artist name to their YouTube channel: search the name and take
/// the uploader that best looks like the artist. Exact/containing names win
/// (which also catches the auto-generated "Artist - Topic" feeds); otherwise a
/// channel that dominates the results (≥3 hits) is accepted — that is usually
/// the artist's own channel even when its name is romanised differently.
async fn resolve_artist_channel(ytdlp: &Path, artist: &str) -> Option<String> {
    let wanted = normalize(artist);
    if wanted.is_empty() {
        return None;
    }
    let entries = crate::ytdlp::search_tracks(ytdlp, artist, ARTIST_SEARCH_RESULTS)
        .await
        .ok()?;

    // uploader -> (rank, hits); rank 2 = exact name, 1 = contains, 0 = other.
    let mut candidates: HashMap<String, (u8, usize)> = HashMap::new();
    for entry in &entries {
        let Some(uploader) = entry.uploader.as_deref() else {
            continue;
        };
        let norm = normalize(uploader);
        if norm.is_empty() {
            continue;
        }
        let rank = if norm == wanted {
            2
        } else if norm.contains(&wanted) || wanted.contains(&norm) {
            1
        } else {
            0
        };
        let slot = candidates.entry(uploader.to_string()).or_insert((rank, 0));
        slot.0 = slot.0.max(rank);
        slot.1 += 1;
    }

    candidates
        .into_iter()
        .filter(|(_, (rank, hits))| *rank > 0 || *hits >= 3)
        .max_by_key(|(_, (rank, hits))| (*rank, *hits))
        .map(|(name, _)| name)
}

/// Does a candidate's uploader look like the given channel/artist name?
fn uploader_matches(hint: &str, uploader: Option<&str>) -> bool {
    let Some(uploader) = uploader else {
        return false;
    };
    let hint_norm = normalize(hint);
    let uploader_norm = normalize(uploader);
    !hint_norm.is_empty()
        && !uploader_norm.is_empty()
        && (uploader_norm == hint_norm
            || uploader_norm.contains(&hint_norm)
            || hint_norm.contains(&uploader_norm))
}

/// Title overlap only (0..1): 1.0 for equal/containing titles, Jaccard word
/// overlap otherwise. `None` when either title has nothing to compare.
fn title_overlap(track: &SpotifyTrack, candidate: &YtEntry) -> Option<f64> {
    let sp_title = normalize(&track.title);
    let cand_title = normalize(&candidate.title);
    if sp_title.is_empty() || cand_title.is_empty() {
        return None;
    }
    if cand_title == sp_title || cand_title.contains(&sp_title) || sp_title.contains(&cand_title) {
        return Some(1.0);
    }
    let a: std::collections::HashSet<&str> = sp_title.split(' ').collect();
    let b: std::collections::HashSet<&str> = cand_title.split(' ').collect();
    let inter = a.intersection(&b).count() as f64;
    let union = a.union(&b).count().max(1) as f64;
    Some(inter / union)
}

fn score_match(track: &SpotifyTrack, candidate: &YtEntry, channel_hint: Option<&str>) -> f64 {
    let Some(title_score) = title_overlap(track, candidate) else {
        return 0.0;
    };

    let mut score = 0.55 * title_score;

    let cand_title = normalize(&candidate.title);
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

    // The artist's own channel wins over look-alike re-uploads even when the
    // latter rank higher or carry a cleaner title.
    if channel_hint.is_some_and(|hint| uploader_matches(hint, candidate.uploader.as_deref())) {
        score += OFFICIAL_CHANNEL_BONUS;
    }

    score
}

/// Pick the best candidate above `threshold`. With `require_title` the winner
/// must also share at least one title word — the fallback pass must never
/// accept a candidate that only matches on duration.
fn pick_best(
    track: &SpotifyTrack,
    entries: &[YtEntry],
    channel_hint: Option<&str>,
    threshold: f64,
    require_title: bool,
) -> Option<YtEntry> {
    let best = entries.iter().max_by(|a, b| {
        score_match(track, a, channel_hint)
            .partial_cmp(&score_match(track, b, channel_hint))
            .unwrap_or(std::cmp::Ordering::Equal)
    })?;
    if score_match(track, best, channel_hint) < threshold {
        return None;
    }
    if require_title && title_overlap(track, best).unwrap_or(0.0) <= 0.0 {
        return None;
    }
    Some(best.clone())
}

async fn search_best(
    ytdlp: &Path,
    track: &SpotifyTrack,
    channel_hint: Option<&str>,
) -> Result<Option<YtEntry>, String> {
    let query = if track.artists.trim().is_empty() {
        track.title.clone()
    } else {
        format!("{} {}", track.title, track.artists)
    };
    let entries = crate::ytdlp::search_tracks(ytdlp, &query, SEARCH_RESULTS).await?;
    if let Some(best) = pick_best(track, &entries, channel_hint, MATCH_THRESHOLD, false) {
        return Ok(Some(best));
    }

    // Nothing solid. Try the bare title once — re-uploads and covers often
    // carry a different artist credit, and a re-upload beats "not found".
    if !track.artists.trim().is_empty() {
        let entries = crate::ytdlp::search_tracks(ytdlp, &track.title, SEARCH_RESULTS).await?;
        if let Some(best) = pick_best(track, &entries, channel_hint, FALLBACK_THRESHOLD, true) {
            return Ok(Some(best));
        }
    }
    Ok(None)
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
    // artist (normalized) -> their channel, resolved lazily and bounded so a
    // long playlist doesn't pay a lookup per track.
    let mut channel_cache: HashMap<String, Option<String>> = HashMap::new();

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

        let artists = split_artists(&track.artists);
        for artist in &artists {
            if CANCEL_FLAG.load(Ordering::Relaxed) || channel_cache.len() >= MAX_ARTIST_LOOKUPS {
                break;
            }
            let key = normalize(artist);
            if key.is_empty() || channel_cache.contains_key(&key) {
                continue;
            }
            let found = resolve_artist_channel(&ytdlp, artist).await;
            crate::app::diagnostics::log_native(
                &app,
                "INFO",
                format!(
                    "[Spotify] channel for '{artist}' -> {}",
                    found.as_deref().unwrap_or("<not found>")
                ),
            );
            channel_cache.insert(key, found);
            tokio::time::sleep(Duration::from_millis(SEARCH_DELAY_MS)).await;
        }
        let channel_hint = artists
            .iter()
            .filter_map(|artist| channel_cache.get(&normalize(artist)).cloned().flatten())
            .next();

        match search_best(&ytdlp, track, channel_hint.as_deref()).await {
            Ok(Some(entry)) => {
                consecutive_errors = 0;
                matched += 1;
                let on_artist_channel = channel_hint
                    .as_deref()
                    .is_some_and(|hint| uploader_matches(hint, entry.uploader.as_deref()));
                let score = score_match(track, &entry, channel_hint.as_deref());
                crate::app::diagnostics::log_native(
                    &app,
                    "INFO",
                    format!(
                        "[Spotify] match '{}' -> '{}' [{}] score={:.2}{}",
                        track.title,
                        entry.title,
                        entry.uploader.as_deref().unwrap_or("-"),
                        score,
                        if on_artist_channel { " (artist channel)" } else { "" }
                    ),
                );
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
    use super::{
        extract_playlist_id, fetch_playlist, pick_best, score_match, search_best, split_artists,
        title_overlap, uploader_matches, SpotifyTrack, FALLBACK_THRESHOLD, MATCH_THRESHOLD,
        OFFICIAL_CHANNEL_BONUS,
    };
    use crate::ytdlp::YtEntry;

    fn entry(id: &str, title: &str, uploader: &str, secs: Option<f64>) -> YtEntry {
        YtEntry {
            id: id.to_string(),
            title: title.to_string(),
            uploader: Some(uploader.to_string()),
            duration_secs: secs,
            thumbnail: None,
        }
    }

    fn track(title: &str, artists: &str, secs: f64) -> SpotifyTrack {
        SpotifyTrack {
            title: title.to_string(),
            artists: artists.to_string(),
            duration_ms: (secs * 1000.0) as u64,
        }
    }

    #[test]
    fn artist_channel_wins_with_the_hint() {
        // The official channel here has a name that does NOT contain the artist
        // (the hint was resolved separately) — only the hint can pick it.
        let sp = track("Song", "Composer", 200.0);
        let reupload = entry("re", "Song", "Random Uploads", Some(200.0));
        let official = entry("off", "Song", "Totally Different Channel", Some(200.0));

        let without = score_match(&sp, &reupload, None) >= score_match(&sp, &official, None);
        assert!(without, "without a hint the re-upload matches on title");

        assert!(
            score_match(&sp, &official, Some("Totally Different Channel"))
                > score_match(&sp, &reupload, Some("Totally Different Channel")),
            "the hint must flip the winner to the artist's channel"
        );
        assert!(
            score_match(&sp, &official, Some("Totally Different Channel"))
                >= score_match(&sp, &official, None) + OFFICIAL_CHANNEL_BONUS - 1e-9
        );
    }

    #[test]
    fn topic_channels_count_as_the_artist() {
        assert!(uploader_matches("Artist", Some("Artist - Topic")));
        assert!(uploader_matches("HATSUBOSHI GAKUEN", Some("HATSUBOSHI GAKUEN - Topic")));
        assert!(!uploader_matches("Artist", Some("Random Uploads")));
        assert!(!uploader_matches("", Some("Artist")));
    }

    #[test]
    fn splits_artist_lists() {
        assert_eq!(split_artists("A, B & C"), vec!["A", "B", "C"]);
        assert_eq!(split_artists("  "), Vec::<String>::new());
    }

    #[test]
    fn fallback_accepts_a_weak_but_related_upload() {
        let sp = track("Song Name Two Words", "Composer", 200.0);
        let extended = entry("e", "Song Name Other Words", "Some Re-upload", Some(230.0));
        // Below the primary bar…
        assert!(score_match(&sp, &extended, None) < MATCH_THRESHOLD);
        assert!(pick_best(&sp, &[extended.clone()], None, MATCH_THRESHOLD, false).is_none());
        // …but good enough for the second chance.
        assert!(pick_best(&sp, &[extended], None, FALLBACK_THRESHOLD, true).is_some());
    }

    #[test]
    fn fallback_rejects_titleless_matches_even_with_artist_and_duration() {
        let sp = track("Song Name", "Composer", 200.0);
        let unrelated = entry("u", "Totally Different Track", "Composer Official", Some(200.0));
        // Artist + duration give it enough points, but the title shares nothing.
        assert!(score_match(&sp, &unrelated, None) >= FALLBACK_THRESHOLD);
        assert!(pick_best(&sp, &[unrelated.clone()], None, FALLBACK_THRESHOLD, true).is_none());
        assert!(pick_best(&sp, &[unrelated], None, FALLBACK_THRESHOLD, false).is_some());
    }

    #[test]
    fn title_overlap_ignores_bracketed_noise() {
        let sp = track("Song", "Composer", 200.0);
        let official = entry("o", "Song (Official Video)", "Channel", Some(200.0));
        assert_eq!(title_overlap(&sp, &official), Some(1.0));
    }

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
                let best = search_best(&bin, track, None).await.expect("search");
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
