//! Locally stored playlists imported from external services (currently YouTube).
//!
//! These never touch the SoundCloud backend: the tracks are synthetic
//! `youtube:tracks:<id>` entries and their audio is fetched on demand by yt-dlp.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Playlist } from '../lib/hooks';
import { createThrottledJsonStorage } from '../lib/tauri-storage';
import type { Track } from './player';

export interface LocalPlaylist {
  id: string;
  title: string;
  uploader: string | null;
  artworkUrl: string | null;
  sourceUrl: string;
  source: 'youtube';
  tracks: Track[];
  createdAt: number;
}

interface LocalPlaylistsState {
  playlists: LocalPlaylist[];
  upsert: (playlist: LocalPlaylist) => void;
  remove: (id: string) => void;
}

export const useLocalPlaylistsStore = create<LocalPlaylistsState>()(
  persist(
    (set) => ({
      playlists: [],
      upsert: (playlist) =>
        set((state) => {
          const index = state.playlists.findIndex((p) => p.id === playlist.id);
          if (index === -1) return { playlists: [playlist, ...state.playlists] };
          const next = [...state.playlists];
          next[index] = playlist;
          return { playlists: next };
        }),
      remove: (id) =>
        set((state) => ({ playlists: state.playlists.filter((p) => p.id !== id) })),
    }),
    {
      name: 'sc-local-playlists',
      storage: createThrottledJsonStorage(),
      partialize: (state) => ({ playlists: state.playlists }),
    },
  ),
);

export function localPlaylistById(id: string | undefined): LocalPlaylist | undefined {
  if (!id) return undefined;
  return useLocalPlaylistsStore.getState().playlists.find((p) => p.id === id);
}

/** Playlist-shaped view of a local import, for the shared `PlaylistCard`. */
export function localPlaylistToCard(playlist: LocalPlaylist): Playlist {
  const stamp = new Date(playlist.createdAt).toISOString();
  return {
    id: 0,
    urn: playlist.id,
    title: playlist.title,
    description: null,
    duration: playlist.tracks.reduce((sum, track) => sum + (track.duration || 0), 0),
    artwork_url: playlist.artworkUrl,
    genre: '',
    tag_list: '',
    track_count: playlist.tracks.length,
    created_at: stamp,
    last_modified: stamp,
    sharing: 'private',
    playlist_type: 'YouTube',
    tracks: playlist.tracks,
    user: {
      id: 0,
      urn: 'youtube',
      username: playlist.uploader ?? 'YouTube',
      avatar_url: '',
    },
  };
}
