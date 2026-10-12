//! Per-playlist thumbnail overrides, stored locally by playlist URN.
//!
//! Works for every playlist kind (own SoundCloud sets, imports, mixes):
//! the override wins over the playlist's own artwork everywhere covers
//! resolve, without touching the backend.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createThrottledJsonStorage } from '../lib/tauri-storage';

interface PlaylistArtworkState {
  overrides: Record<string, string>;
  setArtwork: (urn: string, url: string) => void;
  clearArtwork: (urn: string) => void;
}

export const usePlaylistArtworkStore = create<PlaylistArtworkState>()(
  persist(
    (set) => ({
      overrides: {},
      setArtwork: (urn, url) => set((state) => ({ overrides: { ...state.overrides, [urn]: url } })),
      clearArtwork: (urn) =>
        set((state) => {
          if (!(urn in state.overrides)) return state;
          const overrides = { ...state.overrides };
          delete overrides[urn];
          return { overrides };
        }),
    }),
    {
      name: 'sc-playlist-artwork',
      storage: createThrottledJsonStorage(),
      partialize: (state) => ({ overrides: state.overrides }),
    },
  ),
);

/** Reactive override for one playlist — re-renders only when it changes. */
export function usePlaylistArtwork(urn: string | undefined): string | undefined {
  return usePlaylistArtworkStore((s) => (urn ? s.overrides[urn] : undefined));
}

/** One-shot read for event handlers (pin, save) that can't subscribe. */
export function playlistArtworkOverride(urn: string | undefined): string | undefined {
  if (!urn) return undefined;
  return usePlaylistArtworkStore.getState().overrides[urn];
}
