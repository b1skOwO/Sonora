import type { Track } from '../stores/player';
import { usePlayerStore } from '../stores/player';
import { useSettingsStore } from '../stores/settings';
import { getCurrentTime, subscribe as subscribeAudioTime } from './audio';
import { trackedInvoke as invoke } from './diagnostics';
import { getArtistDisplay, getDisplayTitle } from './track-display';
import { isYoutubeUrn } from './youtube';

let connected = false;
let lastConnectAttemptAt = 0;
const CONNECT_RETRY_MS = 5000;
let connectAttempt: Promise<boolean> | null = null;

async function ensureConnected(): Promise<boolean> {
  if (!useSettingsStore.getState().discordRpcEnabled) {
    return false;
  }
  if (connected) return true;
  if (connectAttempt) return connectAttempt;
  const now = Date.now();
  if (now - lastConnectAttemptAt < CONNECT_RETRY_MS) {
    return false;
  }
  lastConnectAttemptAt = now;
  connectAttempt = invoke<boolean>('discord_connect')
    .then((result) => {
      connected = result;
      return result;
    })
    .catch(() => false)
    .finally(() => {
      connectAttempt = null;
    });
  return connectAttempt;
}

function artworkToLarge(url: string | null): string | undefined {
  if (!url) return undefined;
  // Only SoundCloud CDN art uses the `-large` suffix; other hosts (YouTube
  // thumbnails) must stay untouched or a dashed video id would be mangled.
  return url.replace(/-large(\.[^.]+)$/, '-t500x500$1');
}

async function updatePresence(track: Track) {
  if (!(await ensureConnected())) return;

  try {
    const { isPlaying, currentTrack } = usePlayerStore.getState();
    // A track switch can happen while the IPC connection is opening. Never
    // publish a stale activity after the newer track has become current.
    if (currentTrack?.urn !== track.urn) return;
    const { discordRpcMode, discordRpcShowButton } = useSettingsStore.getState();
    const display = getArtistDisplay(track);
    await invoke('discord_set_activity', {
      track: {
        title: getDisplayTitle(track),
        artist: display.primary || track.user?.username || '',
        artwork_url: artworkToLarge(track.artwork_url),
        track_url: track.permalink_url ? `${track.permalink_url}`.replace(/\?.*$/, '') : undefined,
        duration_secs: Math.round(track.duration / 1000),
        elapsed_secs: Math.round(getCurrentTime()),
        is_playing: isPlaying,
        mode: discordRpcMode,
        show_button: discordRpcShowButton,
        // Which service this track plays from — shown on the Discord card so
        // "playing SoundCloud" and "playing YouTube" are distinguishable.
        source: isYoutubeUrn(track.urn) ? 'youtube' : 'soundcloud',
      },
    });
  } catch (e) {
    console.warn('[Discord] Failed to set activity:', e);
    connected = false;
    lastConnectAttemptAt = 0;
  }
}

async function clearPresence() {
  if (!connected) return;
  try {
    await invoke('discord_clear_activity');
  } catch {
    connected = false;
  }
}

let lastUrn: string | null = null;
let lastPlaying = false;
let lastElapsed = 0;
let seekSyncTimer: ReturnType<typeof setTimeout> | null = null;

// The player store may restore its current track before this deferred module is
// imported. Seed the RPC state from that snapshot as well as future transitions.
const initialPlayer = usePlayerStore.getState();
lastUrn = initialPlayer.currentTrack?.urn ?? null;
lastPlaying = initialPlayer.isPlaying;
if (initialPlayer.currentTrack) {
  lastElapsed = Math.round(getCurrentTime());
  void updatePresence(initialPlayer.currentTrack);
}

function schedulePresenceSync(track: Track, delayMs: number) {
  if (seekSyncTimer) clearTimeout(seekSyncTimer);
  seekSyncTimer = setTimeout(() => {
    seekSyncTimer = null;
    lastElapsed = Math.round(getCurrentTime());
    updatePresence(track);
  }, delayMs);
}

usePlayerStore.subscribe((state) => {
  const { currentTrack, isPlaying } = state;

  const trackChanged = currentTrack?.urn !== lastUrn;
  const playChanged = isPlaying !== lastPlaying;

  if (!currentTrack) {
    if (lastPlaying || trackChanged) {
      clearPresence();
    }
    if (seekSyncTimer) {
      clearTimeout(seekSyncTimer);
      seekSyncTimer = null;
    }
    lastUrn = null;
    lastPlaying = false;
    lastElapsed = 0;
    return;
  }

  if (trackChanged || playChanged) {
    if (seekSyncTimer) {
      clearTimeout(seekSyncTimer);
      seekSyncTimer = null;
    }
    lastUrn = currentTrack.urn;
    lastPlaying = isPlaying;
    lastElapsed = Math.round(getCurrentTime());
    updatePresence(currentTrack);
  }
});

useSettingsStore.subscribe((state, prev) => {
  const rpcSettingsChanged =
    state.discordRpcEnabled !== prev.discordRpcEnabled ||
    state.discordRpcMode !== prev.discordRpcMode ||
    state.discordRpcShowButton !== prev.discordRpcShowButton;

  if (!rpcSettingsChanged) return;

  if (!state.discordRpcEnabled) {
    if (seekSyncTimer) {
      clearTimeout(seekSyncTimer);
      seekSyncTimer = null;
    }
    void clearPresence().finally(() => {
      connected = false;
      void invoke('discord_disconnect').catch(() => undefined);
    });
    return;
  }

  const { currentTrack } = usePlayerStore.getState();
  if (currentTrack) {
    void updatePresence(currentTrack);
  }
});

subscribeAudioTime(() => {
  const { currentTrack, isPlaying } = usePlayerStore.getState();
  if (!currentTrack || !useSettingsStore.getState().discordRpcEnabled) return;

  if (!connected) {
    void updatePresence(currentTrack);
    return;
  }

  if (!isPlaying) return;

  const elapsed = Math.round(getCurrentTime());
  const drift = Math.abs(elapsed - lastElapsed);

  // Re-sync Discord timestamps on manual seek / large jumps without spamming updates every second.
  if (drift >= 2) {
    lastElapsed = elapsed;
    schedulePresenceSync(currentTrack, 180);
  } else {
    lastElapsed = elapsed;
  }
});
