use std::sync::{Arc, Mutex};

use discord_rich_presence::{
    activity::{Activity, ActivityType, Assets, Button, Timestamps},
    DiscordIpc, DiscordIpcClient,
};

use crate::rt::AppHandle;
use crate::shared::constants::{DISCORD_CLIENT_ID, GITHUB_URL};

pub struct DiscordState {
    pub client: Mutex<Option<DiscordIpcClient>>,
}

#[derive(serde::Deserialize)]
pub struct DiscordTrackInfo {
    title: String,
    artist: String,
    artwork_url: Option<String>,
    track_url: Option<String>,
    duration_secs: Option<i64>,
    elapsed_secs: Option<i64>,
    is_playing: Option<bool>,
    mode: Option<DiscordRpcMode>,
    show_button: Option<bool>,
    /// "youtube" | "soundcloud" — which service the track plays from.
    #[serde(default)]
    source: Option<String>,
}

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscordRpcMode {
    Track,
    Artist,
    Activity,
}

#[tauri::command]
pub fn discord_connect(state: tauri::State<'_, Arc<DiscordState>>) -> Result<bool, String> {
    let mut guard = state.client.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(true);
    }
    let mut client = DiscordIpcClient::new(DISCORD_CLIENT_ID);
    match client.connect() {
        Ok(_) => {
            println!("[Discord] Connected");
            *guard = Some(client);
            Ok(true)
        }
        Err(e) => {
            println!("[Discord] Connection failed: {e}");
            Err(format!("Connection failed: {e}"))
        }
    }
}

#[tauri::command]
pub fn discord_disconnect(state: tauri::State<'_, Arc<DiscordState>>) {
    let Ok(mut guard) = state.client.lock() else {
        return;
    };
    if let Some(ref mut client) = *guard {
        let _ = client.close();
        println!("[Discord] Disconnected");
    }
    *guard = None;
}

#[tauri::command]
pub fn discord_set_activity(
    state: tauri::State<'_, Arc<DiscordState>>,
    track: DiscordTrackInfo,
    app: AppHandle,
) -> Result<(), String> {
    let mut guard = state.client.lock().map_err(|e| e.to_string())?;
    let client = guard.as_mut().ok_or("Discord not connected")?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    let elapsed = track.elapsed_secs.unwrap_or(0);
    let start = now - elapsed;
    let is_playing = track.is_playing.unwrap_or(true);
    let mode = track.mode.unwrap_or(DiscordRpcMode::Track);
    let show_button = track.show_button.unwrap_or(true);

    let large_image = track.artwork_url.as_deref().unwrap_or("soundcloud_logo");
    let artist_text = if track.artist.trim().is_empty() {
        track.title.as_str()
    } else {
        track.artist.as_str()
    };
    let has_artist = !track.artist.trim().is_empty();

    // Artwork hover tooltip: deliberately unset — the artist already owns the
    // card's name line, and repeating it here made the artist show up twice.
    let assets = Assets::new().large_image(large_image);

    // Which service the track comes from — Discord cards must make "playing
    // SoundCloud" vs "playing YouTube" distinguishable at a glance, and the
    // "via Sonora" suffix keeps the app visible next to the service.
    let source_label = if track.source.as_deref() == Some("youtube") {
        "YouTube"
    } else {
        "SoundCloud"
    };
    let source_line = format!("{source_label} via Sonora");

    // `name` overrides the application name Discord shows on the player card.
    // Track/Artist modes put the artist there; Activity mode puts the *service*
    // there (its details/state lines carry artist + title).
    let mut activity = Activity::new()
        .activity_type(ActivityType::Listening)
        .assets(assets);
    match mode {
        DiscordRpcMode::Track | DiscordRpcMode::Artist if has_artist => {
            activity = activity.name(artist_text);
        }
        DiscordRpcMode::Activity => {
            activity = activity.name(source_line.as_str());
        }
        _ => {}
    }

    activity = match mode {
        // Artist on the name line, title below, service on the state line.
        DiscordRpcMode::Track => {
            let activity = activity.details(&track.title);
            if is_playing {
                activity.state(source_line.as_str())
            } else {
                activity.state("Paused")
            }
        }
        // Artist only — the name line already shows it; state carries the service.
        DiscordRpcMode::Artist => {
            if is_playing {
                activity.state(source_line.as_str())
            } else {
                activity.state("Paused")
            }
        }
        // Service header, artist + title in the content lines.
        DiscordRpcMode::Activity => {
            let activity = activity.details(artist_text);
            if is_playing {
                if has_artist {
                    activity.state(&track.title)
                } else {
                    activity.state(source_line.as_str())
                }
            } else {
                activity.state("Paused")
            }
        }
    };

    if is_playing {
        let mut timestamps = Timestamps::new().start(start);
        if let Some(dur) = track.duration_secs {
            timestamps = timestamps.end(start + dur);
        }
        activity = activity.timestamps(timestamps);
    }

    let mut buttons: Vec<Button> = Vec::new();
    if show_button
        && let Some(ref url) = track.track_url
    {
        let label = if url.contains("youtube.com") || url.contains("youtu.be") {
            "Listen on YouTube"
        } else {
            "Listen on SoundCloud"
        };
        crate::app::diagnostics::log_native(
            &app,
            "INFO",
            format!("[Discord] button '{label}' -> {url}"),
        );
        buttons.push(Button::new(label, url));
    } else {
        crate::app::diagnostics::log_native(
            &app,
            "INFO",
            format!(
                "[Discord] no listen button (show_button={show_button}, has_url={})",
                track.track_url.is_some()
            ),
        );
    }

    // Always-on second link: the public project page.
    buttons.push(Button::new("GitHub", GITHUB_URL));
    activity = activity.buttons(buttons);

    let result = client.set_activity(activity);

    if result.is_err() {
        *guard = None;
    }

    result.map_err(|e| format!("set_activity: {e}"))?;

    Ok(())
}

#[tauri::command]
pub fn discord_clear_activity(state: tauri::State<'_, Arc<DiscordState>>) -> Result<(), String> {
    let mut guard = state.client.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut client) = *guard {
        client
            .clear_activity()
            .map_err(|e| format!("clear_activity: {e}"))?;
    }
    Ok(())
}
