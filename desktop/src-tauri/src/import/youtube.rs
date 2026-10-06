//! YouTube playlist import: metadata via yt-dlp (audio is downloaded lazily by
//! the track cache when a track is played).

use tauri::State;

use crate::track_cache::TrackCacheState;
use crate::ytdlp::{YtEntry, YtPlaylist};

/// Fetch playlist (or single video) metadata without downloading media.
#[tauri::command]
pub async fn yt_playlist_fetch(
    url: String,
    state: State<'_, TrackCacheState>,
) -> Result<YtPlaylist, String> {
    let bin = state
        .ytdlp()
        .await
        .ok_or_else(|| "yt-dlp is not available (check your connection)".to_string())?;
    crate::ytdlp::fetch_playlist(&bin, url.trim()).await
}

/// Search YouTube through yt-dlp (`ytsearch`) for manual track picking —
/// used by the "add tracks" flow on local playlists.
#[tauri::command]
pub async fn yt_search(
    query: String,
    limit: Option<usize>,
    state: State<'_, TrackCacheState>,
) -> Result<Vec<YtEntry>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let bin = state
        .ytdlp()
        .await
        .ok_or_else(|| "yt-dlp is not available (check your connection)".to_string())?;
    crate::ytdlp::search_tracks(&bin, query, limit.unwrap_or(20).clamp(1, 50)).await
}
