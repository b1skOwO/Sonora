import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { art } from '../../lib/formatters';
import {
  useLyricSearch,
  useSearchDbArtists,
  useSearchDbPlaylists,
  useSearchDbTracks,
  useSearchDbUsers,
  useSearchPlaylists,
  useSearchTracks,
  useSearchUsers,
} from '../../lib/hooks';
import { useSmartWave, useWaveBoard } from '../../lib/soundwave';
import type { Track } from '../../stores/player';
import type { SearchSource } from '../../stores/searchPrefs';
import { useSettingsStore } from '../../stores/settings';
import type { EntityItem } from './EntityStrip';
import { genreColor, isHeroPos, isHeroUrn, vibeEnergy, type WallItem } from './utils';

export interface DiveSeed {
  urn: string;
  title: string;
}

export interface SearchWallResult {
  items: WallItem[];
  entities: EntityItem[];
  atmosphere: { tint: string[]; energy: number };
  isLoading: boolean;
  /** Vibe vector is still being computed by the worker (high load) — the wall
   *  is empty not because there are no matches, but because it isn't encoded
   *  yet. Drives the "preparing vibe" plaque; the query auto-refetches. */
  preparing: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  entitiesLoading: boolean;
  loadMore: () => void;
}

const MIN_LEN = 2;

function toTiles(tracks: Track[], kind: WallItem['kind']): WallItem[] {
  return tracks.filter((t) => t?.urn).map((track, i) => ({ track, kind, hero: isHeroPos(i) }));
}

/** Weave lexical + lyric hits into one deduped wall (text mode). */
function weaveText(
  lex: Track[],
  lyric: { track: Track; matchedLine: string | null }[],
): WallItem[] {
  const out: WallItem[] = [];
  const seen = new Set<string>();
  let li = 0;
  let ly = 0;
  let slot = 0;
  const push = (track: Track, kind: WallItem['kind'], matchedLine?: string | null): boolean => {
    if (!track?.urn || seen.has(track.urn)) return false;
    seen.add(track.urn);
    out.push({ track, kind, matchedLine });
    return true;
  };

  while (li < lex.length || ly < lyric.length) {
    let placed = false;
    if (ly < lyric.length && slot % 4 === 2) {
      placed = push(lyric[ly].track, 'lyric', lyric[ly].matchedLine);
      ly++;
    } else if (li < lex.length) {
      placed = push(lex[li], 'lexical');
      li++;
    } else if (ly < lyric.length) {
      placed = push(lyric[ly].track, 'lyric', lyric[ly].matchedLine);
      ly++;
    }
    if (placed) slot++;
  }
  return out.map((it) => ({ ...it, hero: isHeroUrn(it.track.urn) }));
}

/** Decides what fills the wall for the current query/source/dive, plus the
 *  atmosphere tint, the entity strip, and pagination. Keeps the page thin.
 *  source 'sc' searches the live SoundCloud (lexical only) instead of our DB. */
export function useSearchWall(
  query: string,
  source: SearchSource,
  dive: DiveSeed | null,
): SearchWallResult {
  const navigate = useNavigate();
  const trimmed = query.trim();
  const hasQuery = trimmed.length >= MIN_LEN;
  const db = source === 'db';
  const landing = !hasQuery && !dive;
  const scMode = hasQuery && source === 'sc' && !dive;
  const textMode = hasQuery && db && !dive;

  const hideListened = useSettingsStore((s) => s.soundwaveHideListened);
  const wave = useWaveBoard({ enabled: landing, hideListened });
  const lex = useSearchDbTracks(textMode ? trimmed : '');
  const lyric = useLyricSearch(textMode ? trimmed : '', 'auto');
  const artists = useSearchDbArtists(textMode ? trimmed : '');
  const users = useSearchDbUsers(textMode ? trimmed : '');
  const playlists = useSearchDbPlaylists(textMode ? trimmed : '');
  // Live SoundCloud fan-out (only when the user opted into the SC source).
  const scQ = scMode ? trimmed : '';
  const scTracks = useSearchTracks(scQ);
  const scPlaylists = useSearchPlaylists(scQ);
  const scUsers = useSearchUsers(scQ);
  // The wave/from-track endpoint parses the path segment as a bare numeric id;
  // a full URN (soundcloud:tracks:123) fails the parse and returns nothing, so
  // strip it down like the soundwave similar-block does.
  const diveSeedId = dive?.urn ? (dive.urn.split(':').pop() ?? dive.urn) : undefined;
  const diveWave = useSmartWave({
    seedKind: 'track',
    seedId: diveSeedId,
    enabled: !!dive,
    limit: 32,
    hideListened,
  });

  const items = useMemo<WallItem[]>(() => {
    if (dive) return toTiles(diveWave.data?.tracks ?? [], 'vibe');
    if (landing) return toTiles(wave.tracks, 'wave');
    if (scMode) return toTiles(scTracks.items, 'lexical');
    if (textMode) return weaveText(lex.tracks, lyric.hits);
    return [];
  }, [
    dive,
    diveWave.data?.tracks,
    landing,
    wave.tracks,
    scMode,
    scTracks.items,
    textMode,
    lex.tracks,
    lyric.hits,
  ]);

  const entities = useMemo<EntityItem[]>(() => {
    const out: EntityItem[] = [];
    if (textMode) {
      for (const a of artists.artists.slice(0, 6)) {
        out.push({
          key: `a-${a.id}`,
          label: a.name,
          image: art(a.avatar_url, 't120x120'),
          round: true,
          onClick: () => navigate(`/artist/${a.id}`),
        });
      }
      for (const p of playlists.playlists.slice(0, 6)) {
        out.push({
          key: `p-${p.urn}`,
          label: p.title,
          sub: p.user?.username,
          image: art(p.artwork_url, 't120x120'),
          round: false,
          onClick: () => navigate(`/playlist/${encodeURIComponent(p.urn)}`),
        });
      }
      for (const u of users.users.slice(0, 6)) {
        out.push({
          key: `u-${u.urn}`,
          label: u.username,
          image: art(u.avatar_url, 't120x120'),
          round: true,
          onClick: () => navigate(`/user/${encodeURIComponent(u.urn)}`),
        });
      }
    } else if (scMode) {
      for (const p of scPlaylists.items.slice(0, 6)) {
        out.push({
          key: `scp-${p.urn}`,
          label: p.title,
          sub: p.user?.username,
          image: art(p.artwork_url, 't120x120'),
          round: false,
          onClick: () => navigate(`/playlist/${encodeURIComponent(p.urn)}`),
        });
      }
      for (const u of scUsers.items.slice(0, 6)) {
        out.push({
          key: `scu-${u.urn}`,
          label: u.username,
          image: art(u.avatar_url, 't120x120'),
          round: true,
          onClick: () => navigate(`/user/${encodeURIComponent(u.urn)}`),
        });
      }
    }
    return out;
  }, [
    textMode,
    scMode,
    artists.artists,
    playlists.playlists,
    users.users,
    scPlaylists.items,
    scUsers.items,
    navigate,
  ]);

  const atmosphere = useMemo(() => {
    if (dive || landing || scMode) return { tint: [] as string[], energy: 0.5 };
    const counts = new Map<string, number>();
    for (const t of lex.tracks) {
      const g = t.genre?.trim();
      if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([g]) => g);
    if (top.length === 0) return { tint: [] as string[], energy: 0.5 };
    return { tint: top.map(genreColor), energy: vibeEnergy(top) };
  }, [dive, landing, scMode, lex.tracks]);

  if (dive) {
    return {
      items,
      entities,
      atmosphere,
      preparing: false,
      isLoading: diveWave.isLoading,
      hasMore: false,
      isFetchingMore: false,
      entitiesLoading: false,
      loadMore: () => {},
    };
  }
  if (landing) {
    return {
      items,
      entities,
      atmosphere,
      preparing: false,
      isLoading: wave.isLoading,
      hasMore: wave.hasNextPage,
      isFetchingMore: wave.isFetchingNextPage,
      entitiesLoading: false,
      loadMore: () => void wave.fetchNextPage(),
    };
  }
  if (scMode) {
    return {
      items,
      entities,
      atmosphere,
      preparing: false,
      isLoading: scTracks.isLoading && items.length === 0,
      hasMore: scTracks.hasNextPage,
      isFetchingMore: scTracks.isFetchingNextPage,
      entitiesLoading: (scPlaylists.isLoading || scUsers.isLoading) && entities.length === 0,
      loadMore: () => scTracks.fetchNextPage(),
    };
  }
  // text mode
  return {
    items,
    entities,
    atmosphere,
    preparing: false,
    isLoading: (lex.isLoading || lyric.isLoading) && items.length === 0,
    hasMore: lex.hasNextPage,
    isFetchingMore: lex.isFetchingNextPage,
    entitiesLoading:
      (artists.isLoading || playlists.isLoading || users.isLoading) && entities.length === 0,
    loadMore: () => lex.fetchNextPage(),
  };
}
