//! Spotify playlist import: Spotify metadata (Rust) + YouTube matching (yt-dlp).
//!
//! Rust streams `spotify_import:progress` while it searches YouTube and emits a
//! `spotify_import:match` per matched track. Matches become a local playlist of
//! YouTube-backed tracks, downloaded on demand.

import { listen } from '@tauri-apps/api/event';
import { create } from 'zustand';
import { trackedInvoke as invoke } from '../lib/diagnostics';
import { stableYoutubeThumbnail, YOUTUBE_TRACK_PREFIX } from '../lib/youtube';
import { type LocalPlaylist, useLocalPlaylistsStore } from './local-playlists';
import type { Track } from './player';

export interface SpotifyImportProgress {
  total: number;
  current: number;
  matched: number;
  not_found: number;
  current_track: string;
}

export interface SpotifyImportMatch {
  title: string;
  artists: string;
  duration_ms: number;
  video_id: string;
  video_title: string;
  uploader: string | null;
  duration_secs: number | null;
  thumbnail: string | null;
}

interface SpotifyPlaylistMeta {
  id: string;
  title: string;
}

type SpotifyImportPhase = 'idle' | 'running' | 'stopping' | 'done' | 'stopped' | 'error';

interface SpotifyImportState {
  phase: SpotifyImportPhase;
  progress: SpotifyImportProgress | null;
  playlist: LocalPlaylist | null;
  error: string | null;
  startImport: (url: string) => Promise<void>;
  stopImport: () => Promise<void>;
  clearFinished: () => void;
}

let bridgeInitialized = false;
let activeRunId = 0;
let stopRequested = false;
let matches: SpotifyImportMatch[] = [];

function currentRunIsActive(runId: number): boolean {
  return runId === activeRunId;
}

/** The Spotify track is what the user asked for; the YouTube id plays it. */
function matchToTrack(match: SpotifyImportMatch): Track {
  const artists = match.artists.trim() || match.uploader?.trim() || 'YouTube';
  const durationSecs = match.duration_secs ?? match.duration_ms / 1000;
  return {
    id: 0,
    urn: `${YOUTUBE_TRACK_PREFIX}${match.video_id}`,
    title: match.title,
    duration: Math.round(durationSecs * 1000),
    artwork_url: stableYoutubeThumbnail(match.thumbnail, match.video_id),
    permalink_url: `https://www.youtube.com/watch?v=${match.video_id}`,
    user: {
      id: 0,
      urn: `youtube:users:${artists}`,
      username: artists,
      avatar_url: '',
    },
  };
}

function ensureBridge() {
  if (bridgeInitialized) return;
  bridgeInitialized = true;

  void listen<SpotifyImportProgress>('spotify_import:progress', (event) => {
    useSpotifyImportStore.setState({ progress: event.payload });
  });

  void listen<SpotifyImportMatch>('spotify_import:match', (event) => {
    if (!currentRunIsActive(activeRunId) || stopRequested) return;
    matches.push(event.payload);
  });
}

async function startImportRun(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return;

  const state = useSpotifyImportStore.getState();
  if (state.phase === 'running' || state.phase === 'stopping') return;

  ensureBridge();
  activeRunId += 1;
  const runId = activeRunId;
  stopRequested = false;
  matches = [];

  useSpotifyImportStore.setState({
    phase: 'running',
    progress: null,
    playlist: null,
    error: null,
  });

  try {
    const playlist = await invoke<SpotifyPlaylistMeta>('spotify_import_start', { url: trimmed });
    if (!currentRunIsActive(runId)) return;

    const wasStopped = stopRequested;
    const tracks = matches.map(matchToTrack);
    const local: LocalPlaylist | null =
      tracks.length > 0
        ? {
            id: `spotify:playlists:${playlist.id}`,
            title: playlist.title,
            uploader: 'Spotify',
            artworkUrl: tracks[0]?.artwork_url ?? null,
            sourceUrl: trimmed,
            source: 'spotify',
            tracks,
            createdAt: Date.now(),
          }
        : null;
    if (local) useLocalPlaylistsStore.getState().upsert(local);

    useSpotifyImportStore.setState({
      phase: wasStopped ? 'stopped' : 'done',
      playlist: local,
    });
  } catch (error) {
    if (!currentRunIsActive(runId)) return;
    console.error('[Spotify Import]', error);
    useSpotifyImportStore.setState({
      phase: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (currentRunIsActive(runId)) stopRequested = false;
  }
}

export const useSpotifyImportStore = create<SpotifyImportState>((set, get) => ({
  phase: 'idle',
  progress: null,
  playlist: null,
  error: null,
  startImport: startImportRun,
  stopImport: async () => {
    const { phase } = get();
    if (phase !== 'running') return;
    stopRequested = true;
    set({ phase: 'stopping' });
    try {
      await invoke('spotify_import_stop');
    } catch (error) {
      console.error('[Spotify Import] stop failed:', error);
    }
  },
  clearFinished: () => {
    const { phase } = get();
    if (phase === 'running' || phase === 'stopping') return;
    set({ phase: 'idle', progress: null, playlist: null, error: null });
  },
}));
