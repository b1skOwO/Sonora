//! Unheard picks: tracks you haven't played yet, from the genres you like.
//!
//! Seeds are liked tracks from your top genres; candidates come from their
//! related tracks, round-robin merged, with everything you've already heard
//! (history + likes + local hearts) filtered out. One query fans out the
//! related fetches; the heard-set applies outside it so replays refilter
//! without refetching.

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { Track } from '../stores/player';
import { fetchRelatedTracks } from './related';

const TOP_GENRES = 3;
const SEEDS_PER_GENRE = 2;
const RELATED_PER_SEED = 10;
const PICK_LIMIT = 18;

/** Most frequent genres across the given tracks. */
export function topGenres(tracks: Track[], limit = TOP_GENRES): string[] {
  const counts = new Map<string, number>();
  for (const track of tracks) {
    const genre = track.genre?.trim();
    if (genre) counts.set(genre, (counts.get(genre) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([genre]) => genre);
}

function mergeRoundRobin(batches: Track[][], heard: Set<string>, limit: number): Track[] {
  const out: Track[] = [];
  const seen = new Set<string>();
  const depth = Math.max(0, ...batches.map((batch) => batch.length));
  for (let i = 0; i < depth && out.length < limit; i++) {
    for (const batch of batches) {
      const track = batch[i];
      if (!track?.urn || seen.has(track.urn) || heard.has(track.urn)) continue;
      seen.add(track.urn);
      out.push(track);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function useUnheardPicks(opts: {
  likedTracks: Track[];
  heardUrns: Set<string>;
  nonce?: number;
}) {
  const { likedTracks, heardUrns, nonce = 0 } = opts;

  const seeds = useMemo(() => {
    const out: string[] = [];
    for (const genre of topGenres(likedTracks)) {
      const inGenre = likedTracks.filter((t) => t.genre?.trim() === genre);
      for (const track of inGenre.slice(0, SEEDS_PER_GENRE)) out.push(track.urn);
    }
    // Rotate the seed order so a re-roll weaves a different mix.
    const k = out.length > 0 ? nonce % out.length : 0;
    return [...out.slice(k), ...out.slice(0, k)];
  }, [likedTracks, nonce]);

  const query = useQuery({
    queryKey: ['unheard', 'related', seeds],
    enabled: seeds.length > 0,
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    retry: false,
    queryFn: async () => {
      const batches = await Promise.all(
        seeds.map((urn) =>
          fetchRelatedTracks(urn, RELATED_PER_SEED).catch(() => ({ collection: [] as Track[] })),
        ),
      );
      return batches.map((batch) => batch.collection ?? []);
    },
  });

  const tracks = useMemo(
    () => mergeRoundRobin(query.data ?? [], heardUrns, PICK_LIMIT),
    [query.data, heardUrns],
  );

  return { tracks, isLoading: query.isLoading, hasSeeds: seeds.length > 0 };
}
