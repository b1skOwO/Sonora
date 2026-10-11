//! Local likes: backend-independent hearts, primarily for YouTube tracks
//! (SoundCloud likes stay server-side). Stored as full Track objects so the
//! collection plays like a playlist with no extra fetching.

import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useLikedTracks } from '../lib/hooks';
import { createThrottledJsonStorage } from '../lib/tauri-storage';
import type { Track } from './player';

/** Generous bound so the persisted file can't grow without limit. */
const MAX_LOCAL_LIKES = 2000;

interface LocalLikesState {
  tracks: Track[];
  toggle: (track: Track) => void;
  remove: (urn: string) => void;
}

export const useLocalLikesStore = create<LocalLikesState>()(
  persist(
    (set) => ({
      tracks: [],
      toggle: (track) =>
        set((state) => {
          if (state.tracks.some((t) => t.urn === track.urn)) {
            return { tracks: state.tracks.filter((t) => t.urn !== track.urn) };
          }
          return { tracks: [track, ...state.tracks].slice(0, MAX_LOCAL_LIKES) };
        }),
      remove: (urn) => set((state) => ({ tracks: state.tracks.filter((t) => t.urn !== urn) })),
    }),
    {
      name: 'sc-local-likes',
      storage: createThrottledJsonStorage(),
      partialize: (state) => ({ tracks: state.tracks }),
    },
  ),
);

/** Boolean selector — re-renders only when this track's liked state flips. */
export function useLocalLiked(urn: string): boolean {
  return useLocalLikesStore((s) => s.tracks.some((t) => t.urn === urn));
}

/**
 * The unified likes playlist: local hearts first (newest), then backend
 * SoundCloud likes, deduped by URN. One collection for both services — the
 * store is never duplicated into, so unlike/relike stays consistent and the
 * backend part simply goes empty offline.
 */
export function useUnifiedLikes(): Track[] {
  const local = useLocalLikesStore((s) => s.tracks);
  const { tracks: backend } = useLikedTracks();
  return useMemo(() => {
    if (backend.length === 0) return local;
    const seen = new Set(local.map((t) => t.urn));
    const merged = [...local];
    for (const track of backend) {
      if (!seen.has(track.urn)) {
        seen.add(track.urn);
        merged.push(track);
      }
    }
    return merged;
  }, [local, backend]);
}
