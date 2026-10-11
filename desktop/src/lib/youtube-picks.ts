//! YouTube-mode recommendations.
//!
//! There is no recommendation API for YouTube, so the picks are seeded from the
//! channels the user actually imported: the top uploaders across the local
//! (YouTube/Spotify-imported) playlists are searched through yt-dlp
//! (`yt_search`) and the results are merged round-robin, newest channels first
//! come from the round-robin order. Entries already in the library are dropped.
//!
//! Results are cached by react-query (30 min) — each search costs a yt-dlp run.

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { LocalPlaylist } from '../stores/local-playlists';
import type { Track } from '../stores/player';
import { trackedInvoke as invoke } from './diagnostics';
import { type YtEntry, youtubeVideoId, ytEntryToTrack } from './youtube';

const CHANNEL_LIMIT = 3;
const PER_CHANNEL = 12;
const PICK_LIMIT = 18;

/** Uploaders seen most across the imported playlists. */
export function topChannels(playlists: LocalPlaylist[], limit = CHANNEL_LIMIT): string[] {
  const counts = new Map<string, number>();
  for (const playlist of playlists) {
    for (const track of playlist.tracks) {
      const name = track.user?.username?.trim();
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}

/** Merge per-channel batches: channel-owned results first, round-robin so every
 *  seed contributes, deduped, library tracks excluded. */
function mergePicks(batches: Array<{ channel: string; entries: YtEntry[] }>): YtEntry[] {
  const ordered = batches.map(({ channel, entries }) => {
    const wanted = channel.toLowerCase();
    return [...entries].sort((a, b) => {
      const aMatch = (a.uploader ?? '').toLowerCase() === wanted ? 0 : 1;
      const bMatch = (b.uploader ?? '').toLowerCase() === wanted ? 0 : 1;
      return aMatch - bMatch;
    });
  });

  const out: YtEntry[] = [];
  const seen = new Set<string>();
  const depth = Math.max(0, ...ordered.map((batch) => batch.length));
  for (let i = 0; i < depth && out.length < PICK_LIMIT; i++) {
    for (const batch of ordered) {
      const entry = batch[i];
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
      if (out.length >= PICK_LIMIT) break;
    }
  }
  return out;
}

/** Picks for the YouTube home: top channels → `yt_search` → playable tracks. */
export function useYoutubePicks(playlists: LocalPlaylist[]) {
  const channels = useMemo(() => topChannels(playlists), [playlists]);
  const knownVideoIds = useMemo(() => {
    const ids = new Set<string>();
    for (const playlist of playlists) {
      for (const track of playlist.tracks) {
        const id = youtubeVideoId(track.urn);
        if (id) ids.add(id);
      }
    }
    return ids;
  }, [playlists]);

  const query = useQuery({
    queryKey: ['yt', 'picks', channels],
    enabled: channels.length > 0,
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    retry: false,
    queryFn: async () => {
      const batches = await Promise.all(
        channels.map(async (channel) => {
          const entries = await invoke<YtEntry[]>('yt_search', {
            query: channel,
            limit: PER_CHANNEL,
          }).catch(() => [] as YtEntry[]);
          return { channel, entries };
        }),
      );
      return mergePicks(batches).filter((entry) => !knownVideoIds.has(entry.id));
    },
  });

  const tracks: Track[] = useMemo(
    () => (query.data ?? []).map((entry) => ytEntryToTrack(entry)),
    [query.data],
  );

  return { tracks, isLoading: query.isLoading, hasSeed: channels.length > 0 };
}
