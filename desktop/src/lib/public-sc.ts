// Direct SoundCloud public API v2 fallback.
//
// The app backend mirrors SoundCloud data, but its collections can stay in a
// perpetual "refreshing" state or fail while it re-syncs (tracks/playlists then
// answer 404/503). Reading the public resource straight from SoundCloud keeps
// playlist/track pages usable in that window instead of showing an endless
// skeleton. The backend stays the primary source wherever it responds.

import type { Track } from '../stores/player';
import { ApiError } from './api-client';
import { edgeFetch } from './edge';
import type { Playlist, SCUser } from './hooks';

const SC_WEB_BASE = 'https://soundcloud.com';
const SC_API_V2 = 'https://api-v2.soundcloud.com';
const PUBLIC_API_TIMEOUT_MS = 20_000;

/**
 * Public data is a read-only fallback: auth rejections must still reach the
 * session-recovery flow, everything else (404/5xx/transport/timeout) may be
 * replayed against SoundCloud.
 */
export function canUsePublicFallback(error: unknown): boolean {
  if (error instanceof ApiError) return error.status !== 401 && error.status !== 403;
  return true;
}

/* ── Client id ─────────────────────────────────────────────────── */

let publicClientIdPromise: Promise<string> | null = null;

async function fetchPublicClientId(): Promise<string> {
  const page = await edgeFetch(`${SC_WEB_BASE}/`, {}, 12_000);
  if (!page.ok) throw new Error(`SoundCloud web client ${page.status}`);
  const html = await page.text();
  const hydration = html.match(
    /"hydratable"\s*:\s*"apiClient"\s*,\s*"data"\s*:\s*\{\s*"id"\s*:\s*"([a-zA-Z0-9_-]{20,64})"/,
  );
  if (hydration) return hydration[1];
  const scripts = [...html.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"']+\.js/g)].map(
    (match) => match[0],
  );
  for (const scriptUrl of scripts) {
    const response = await edgeFetch(scriptUrl, {}, 12_000);
    if (!response.ok) continue;
    const script = await response.text();
    const match = script.match(/client_id\s*:\s*["']([a-z0-9_-]{20,64})["']/i);
    if (match) return match[1];
  }
  throw new Error('Could not find SoundCloud web client ID');
}

export function getPublicClientId(): Promise<string> {
  if (!publicClientIdPromise) {
    publicClientIdPromise = fetchPublicClientId().catch((error) => {
      publicClientIdPromise = null;
      throw error;
    });
  }
  return publicClientIdPromise;
}

class PublicClientIdError extends Error {}

/**
 * GET an api-v2 resource with the scraped public client_id. SoundCloud rotates
 * these ids, so a rejection drops the cache and retries once.
 */
export async function publicApiGet<T>(
  path: string,
  params?: Record<string, string>,
  timeoutMs = PUBLIC_API_TIMEOUT_MS,
): Promise<T> {
  const attempt = async (): Promise<T> => {
    const clientId = await getPublicClientId();
    const url = new URL(`${SC_API_V2}${path}`);
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
    url.searchParams.set('client_id', clientId);
    const response = await edgeFetch(url.toString(), {}, timeoutMs);
    if (response.status === 401 || response.status === 403) {
      throw new PublicClientIdError(
        `SoundCloud rejected the public client id (${response.status})`,
      );
    }
    if (!response.ok) throw new Error(`SoundCloud ${response.status} for ${path}`);
    return (await response.json()) as T;
  };

  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof PublicClientIdError)) throw error;
    publicClientIdPromise = null;
    return await attempt();
  }
}

/* ── Mapping ───────────────────────────────────────────────────── */

export function soundcloudNumericId(urn: string | undefined, kind: string): string | null {
  if (!urn) return null;
  const match = urn.match(new RegExp(`(?:^|:)${kind}:(\\d+)$`));
  return match?.[1] ?? (/^\d+$/.test(urn) ? urn : null);
}

function normalizePublicTrack(raw: Partial<Track> & { id?: number; urn?: string }): Track {
  const id = raw.id ?? Number(soundcloudNumericId(raw.urn, 'tracks'));
  const user = raw.user;
  return {
    ...raw,
    id,
    urn: raw.urn ?? `soundcloud:tracks:${id}`,
    title: raw.title ?? '',
    duration: raw.duration ?? 0,
    artwork_url: raw.artwork_url ?? null,
    user: {
      ...user,
      id: user?.id ?? 0,
      urn: user?.urn ?? `soundcloud:users:${user?.id ?? 0}`,
      username: user?.username ?? '',
      avatar_url: user?.avatar_url ?? '',
    },
  } as Track;
}

function mapPublicPlaylist(item: Record<string, unknown>, local = false): Playlist {
  const owner = item.user as
    | { id?: number; urn?: string; username?: string; avatar_url?: string; permalink_url?: string }
    | undefined;
  const userId = (item.user_id as number | undefined) ?? owner?.id ?? 0;
  const id = item.id as number;
  return {
    ...item,
    id,
    // A manually imported playlist is a local snapshot; public fallback data
    // keeps the real urn so opening it goes through the normal playlist page.
    urn: local ? `soundcloud:playlists:imported-${id}` : `soundcloud:playlists:${id}`,
    title: (item.title as string | undefined) ?? 'Untitled playlist',
    permalink_url: item.permalink_url as string | undefined,
    artwork_url: (item.artwork_url as string | null | undefined) ?? null,
    description: (item.description as string | null | undefined) ?? null,
    genre: (item.genre as string | undefined) ?? '',
    tag_list: (item.tag_list as string | undefined) ?? '',
    sharing: (item.sharing as string | undefined) ?? 'public',
    duration: (item.duration as number | undefined) ?? 0,
    track_count: (item.track_count as number | undefined) ?? 0,
    created_at: (item.created_at as string | undefined) ?? '',
    last_modified:
      (item.last_modified as string | undefined) ?? (item.created_at as string | undefined) ?? '',
    playlist_type:
      ((item.is_album as boolean | undefined) ? 'album' : undefined) ??
      (item.set_type as string | undefined) ??
      'playlist',
    user_favorite: false,
    tracks: Array.isArray(item.tracks) ? (item.tracks as Track[]).map(normalizePublicTrack) : [],
    user: {
      id: userId,
      urn: owner?.urn ?? `soundcloud:users:${userId}`,
      username: owner?.username ?? '',
      avatar_url: owner?.avatar_url ?? '',
      permalink_url: owner?.permalink_url,
    },
  } as Playlist;
}

/** Compact playlist entries carry only track stubs — resolve the full objects. */
async function hydratePublicTracks(tracks: Track[]): Promise<Track[]> {
  const complete = new Map<number, Track>();
  for (const track of tracks) {
    if (track.id && track.urn && track.title && track.duration > 0 && track.user?.id) {
      complete.set(track.id, normalizePublicTrack(track));
    }
  }
  const missing = tracks.filter((track) => !complete.has(track.id) && track.id);
  if (missing.length === 0) return tracks.map(normalizePublicTrack);
  for (let offset = 0; offset < missing.length; offset += 50) {
    const chunk = missing.slice(offset, offset + 50);
    const resolved = await publicApiGet<Track[]>('/tracks', {
      ids: chunk.map((track) => track.id).join(','),
    });
    for (const track of resolved) {
      if (track?.id) complete.set(track.id, normalizePublicTrack(track));
    }
  }
  return tracks.map((track) => complete.get(track.id) ?? normalizePublicTrack(track));
}

/* ── Public reads ──────────────────────────────────────────────── */

export async function fetchPublicPlaylist(playlistUrn: string): Promise<Playlist> {
  const id = soundcloudNumericId(playlistUrn, 'playlists');
  if (!id) throw new Error('Invalid SoundCloud playlist reference');
  const raw = await publicApiGet<Record<string, unknown>>(`/playlists/${id}`);
  const playlist = mapPublicPlaylist(raw);
  playlist.tracks = await hydratePublicTracks(playlist.tracks);
  return playlist;
}

export async function fetchPublicPlaylistTracks(playlistUrn: string): Promise<Track[]> {
  return (await fetchPublicPlaylist(playlistUrn)).tracks;
}

export async function fetchPublicTrack(trackUrn: string): Promise<Track> {
  const id = soundcloudNumericId(trackUrn, 'tracks');
  if (!id) throw new Error('Invalid SoundCloud track reference');
  return normalizePublicTrack(await publicApiGet<Partial<Track>>(`/tracks/${id}`));
}

function numericUserId(userUrn: string): string | null {
  const match = userUrn.match(/(?:users:|users\/)(\d+)/);
  return match?.[1] ?? (/^\d+$/.test(userUrn) ? userUrn : null);
}

function normalizePublicUser(raw: Record<string, unknown>): SCUser {
  const id =
    (raw.id as number | undefined) ?? Number(soundcloudNumericId(raw.urn as string, 'users'));
  return {
    ...raw,
    id,
    urn: (raw.urn as string | undefined) ?? `soundcloud:users:${id}`,
    username: (raw.username as string | undefined) ?? '',
    avatar_url: (raw.avatar_url as string | undefined) ?? '',
    permalink_url: raw.permalink_url as string | undefined,
    followers_count: raw.followers_count as number | undefined,
    followings_count: raw.followings_count as number | undefined,
    track_count: raw.track_count as number | undefined,
    city: (raw.city as string | null | undefined) ?? null,
    country_code: (raw.country_code as string | null | undefined) ?? null,
  } as SCUser;
}

async function fetchPublicUserCollection<T>(
  userUrn: string,
  collection: string,
  map: (item: Record<string, unknown>) => T,
): Promise<T[]> {
  const userId = await resolvePublicUserId(userUrn);
  const payload = await publicApiGet<{ collection?: Array<Record<string, unknown>> }>(
    `/users/${userId}/${collection}`,
    { limit: '50', offset: '0' },
  );
  return (payload.collection ?? []).map(map);
}

async function resolvePublicUserId(userUrn: string): Promise<string> {
  if (!userUrn.trim()) throw new Error('Missing SoundCloud profile reference');
  const idFromUrn = numericUserId(userUrn);
  if (idFromUrn) return idFromUrn;
  const permalink = userUrn
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?soundcloud\.com\//i, '')
    .replace(/\/$/, '');
  if (!permalink || permalink.includes('/'))
    throw new Error('Invalid SoundCloud profile reference');
  const user = await publicApiGet<{ id?: number; kind?: string }>('/resolve', {
    url: `https://soundcloud.com/${permalink}`,
  });
  if (!user.id || user.kind !== 'user') throw new Error('SoundCloud URL did not resolve to a user');
  return String(user.id);
}

export async function fetchPublicUserPlaylists(userUrn: string): Promise<Playlist[]> {
  return fetchPublicUserCollection(userUrn, 'playlists', (item) => mapPublicPlaylist(item));
}

export async function fetchPublicUserPlaylistLikes(userUrn: string): Promise<Playlist[]> {
  return fetchPublicUserCollection(userUrn, 'playlist_likes', (item) => {
    const liked = item.kind === 'like' && item.playlist ? item.playlist : item;
    return mapPublicPlaylist(liked as Record<string, unknown>);
  });
}

export async function fetchPublicUserTracks(userUrn: string): Promise<Track[]> {
  return fetchPublicUserCollection(userUrn, 'tracks', (item) =>
    normalizePublicTrack(item as Partial<Track>),
  );
}

export async function fetchPublicUserLikes(userUrn: string): Promise<Track[]> {
  return fetchPublicUserCollection(userUrn, 'likes', (item) => {
    const liked = item.kind === 'like' && item.track ? item.track : item;
    return normalizePublicTrack(liked as Partial<Track>);
  }).then((tracks) => tracks.filter((track) => track.id));
}

export async function fetchPublicUserFollowings(userUrn: string): Promise<SCUser[]> {
  return fetchPublicUserCollection(userUrn, 'followings', normalizePublicUser);
}

export async function fetchPublicUserFollowers(userUrn: string): Promise<SCUser[]> {
  return fetchPublicUserCollection(userUrn, 'followers', normalizePublicUser);
}

/* ── Manual imports (local snapshots) ──────────────────────────── */

const IMPORTED_PLAYLISTS_KEY = 'scd.imported-public-playlists.v1';

/** Parsed-snapshot cache keyed on the raw stored string. Render-time callers
 *  (`usePlaylistTracks`) must see a STABLE identity — parsing per call used to
 *  return a fresh array every render, which looped React (#185) on the
 *  playlist page via the server→local track sync effect. */
let importedCacheRaw: string | null = null;
let importedCache: Playlist[] = [];

export function loadImportedPublicPlaylists(): Playlist[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(IMPORTED_PLAYLISTS_KEY);
  } catch {
    raw = null;
  }
  if (raw === importedCacheRaw) return importedCache;
  importedCacheRaw = raw;
  if (!raw) {
    importedCache = [];
    return importedCache;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    importedCache = !Array.isArray(parsed)
      ? []
      : parsed
          .filter((item): item is Playlist => {
            if (!item || typeof item !== 'object') return false;
            const candidate = item as Partial<Playlist>;
            return (
              typeof candidate.urn === 'string' &&
              typeof candidate.title === 'string' &&
              Array.isArray(candidate.tracks) &&
              !!candidate.user &&
              typeof candidate.user === 'object'
            );
          })
          .map((playlist) => ({
            ...playlist,
            // Imported public playlists are local snapshots. Give them a local URN
            // so generic playlist widgets never send these IDs to the API.
            urn: `soundcloud:playlists:imported-${playlist.id}`,
          }));
  } catch {
    importedCache = [];
  }
  return importedCache;
}

export function saveImportedPublicPlaylist(playlist: Playlist): Playlist[] {
  const normalized = { ...playlist, urn: `soundcloud:playlists:imported-${playlist.id}` };
  const playlists = [
    normalized,
    ...loadImportedPublicPlaylists().filter((item) => item.id !== playlist.id),
  ];
  try {
    localStorage.setItem(IMPORTED_PLAYLISTS_KEY, JSON.stringify(playlists));
    // Storage changed — drop the parse cache so the next load re-reads it.
    importedCacheRaw = null;
  } catch {}
  return playlists;
}

export function findImportedPublicPlaylist(playlistUrn: string | undefined): Playlist | undefined {
  if (!playlistUrn) return undefined;
  let normalizedUrn = playlistUrn;
  try {
    normalizedUrn = decodeURIComponent(playlistUrn);
  } catch {}
  const idMatch = normalizedUrn.match(/playlists:(?:imported-)?(\d+)$/);
  const id = idMatch ? Number(idMatch[1]) : Number.NaN;
  return loadImportedPublicPlaylists().find(
    (playlist) => playlist.urn === normalizedUrn || (Number.isFinite(id) && playlist.id === id),
  );
}

function assertSoundCloudUrl(reference: string): URL {
  const trimmed = reference.trim();
  if (!trimmed) throw new Error('Paste a SoundCloud link');
  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error('Enter a valid SoundCloud link');
  }
  if (
    !['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'].includes(
      url.hostname.toLowerCase(),
    )
  ) {
    throw new Error('Link must be from soundcloud.com');
  }
  url.hash = '';
  return url;
}

async function fetchHydration(
  url: URL,
): Promise<Array<{ hydratable?: string; data?: Record<string, unknown> }>> {
  const response = await edgeFetch(url.toString(), { headers: { Accept: 'text/html' } }, 20_000);
  if (!response.ok) throw new Error(`SoundCloud page load failed (${response.status})`);
  const html = await response.text();
  const match = html.match(/window\.__sc_hydration\s*=\s*(\[.*?\]);\s*<\/script>/s);
  if (!match) throw new Error('SoundCloud did not provide data for this link');
  try {
    return JSON.parse(match[1]) as Array<{ hydratable?: string; data?: Record<string, unknown> }>;
  } catch {
    throw new Error('Could not read data from this SoundCloud page');
  }
}

export async function importPublicPlaylist(reference: string): Promise<Playlist> {
  const url = assertSoundCloudUrl(reference);
  const hydration = await fetchHydration(url);
  const playlist = hydration.find((entry) => entry.hydratable === 'playlist')?.data;
  if (!playlist || playlist.kind !== 'playlist') {
    throw new Error('This SoundCloud link is not a public playlist');
  }
  const mapped = mapPublicPlaylist(playlist, true);
  mapped.tracks = await hydratePublicTracks(mapped.tracks);
  return mapped;
}

export async function importPublicLikesPlaylist(reference: string): Promise<Playlist> {
  const url = assertSoundCloudUrl(reference);
  if (url.pathname.split('/').filter(Boolean).length !== 1) {
    throw new Error('Paste a SoundCloud profile link, not a playlist link');
  }
  const hydration = await fetchHydration(url);
  const profile = hydration.find((entry) => entry.hydratable === 'user')?.data;
  if (!profile?.id) throw new Error('This link did not resolve to a SoundCloud account');
  const payload = await publicApiGet<{ collection?: Array<Record<string, unknown>> }>(
    `/users/${profile.id}/likes`,
    { limit: '200' },
  );
  const tracks = (payload.collection ?? [])
    .map(
      (item): Record<string, unknown> =>
        item.kind === 'like' && item.track ? (item.track as Record<string, unknown>) : item,
    )
    .filter((item) => item.kind === 'track')
    .map((item) => normalizePublicTrack(item));
  const accountId = Number(profile.id);
  const accountName = String(profile.username ?? profile.permalink ?? 'SoundCloud');
  return {
    id: accountId,
    urn: `soundcloud:playlists:imported-likes-${accountId}`,
    title: `${accountName} Likes`,
    permalink_url: profile.permalink_url as string | undefined,
    description: `Imported likes from ${accountName}`,
    duration: tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0),
    artwork_url: null,
    genre: '',
    tag_list: '',
    track_count: tracks.length,
    created_at: new Date().toISOString(),
    last_modified: new Date().toISOString(),
    sharing: 'public',
    playlist_type: 'playlist',
    tracks,
    user: {
      id: accountId,
      urn: `soundcloud:users:${accountId}`,
      username: accountName,
      avatar_url: String(profile.avatar_url ?? ''),
      permalink_url: profile.permalink_url as string | undefined,
    },
  };
}
