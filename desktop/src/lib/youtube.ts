//! YouTube import helpers: synthetic URNs, yt-dlp-backed cache and track mapping.
//!
//! Imported YouTube tracks live in the same player/queue as SoundCloud ones, but
//! their URN is `youtube:tracks:<videoId>` and their audio is materialised on
//! demand by yt-dlp (see `yt_ensure_cached` in Rust) instead of the SC pipeline.

import type { Track } from '../stores/player';
import type { TrackCacheInfo } from './cache';
import { trackedInvoke as invoke } from './diagnostics';

export const YOUTUBE_TRACK_PREFIX = 'youtube:tracks:';
export const YOUTUBE_PLAYLIST_PREFIX = 'youtube:playlists:';

export interface YtEntry {
  id: string;
  title: string;
  uploader: string | null;
  durationSecs: number | null;
  thumbnail: string | null;
}

export interface YtPlaylist {
  id: string | null;
  title: string;
  uploader: string | null;
  entries: YtEntry[];
}

/** True for any synthetic YouTube URN (tracks and local playlists). */
export function isYoutubeUrn(urn: string | null | undefined): boolean {
  return !!urn && urn.startsWith('youtube:');
}

export function youtubeVideoId(urn: string): string | null {
  return urn.startsWith(YOUTUBE_TRACK_PREFIX) ? urn.slice(YOUTUBE_TRACK_PREFIX.length) : null;
}

/** Fetch playlist (or single-video) metadata through yt-dlp — no media download. */
export function fetchYoutubePlaylist(url: string): Promise<YtPlaylist> {
  return invoke<YtPlaylist>('yt_playlist_fetch', { url: normalizeYoutubeUrl(url) });
}

/** Tidy a pasted link: add the scheme, and repair the `.../playlist&list=...`
 *  copy/paste artifact (a `?` that arrived as `&`). */
export function normalizeYoutubeUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return url;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (!url.includes('?') && url.includes('&list=')) url = url.replace('&list=', '?list=');
  return url;
}

/** Download (or hit the cache of) a YouTube track through yt-dlp. */
export function ensureYoutubeCached(videoId: string, durationMs?: number): Promise<TrackCacheInfo> {
  return invoke<TrackCacheInfo>('yt_ensure_cached', { videoId, durationMs });
}

/** Map a yt-dlp entry to the app's Track shape (synthetic URN + uploader as artist). */
export function ytEntryToTrack(entry: YtEntry, fallbackUploader?: string | null): Track {
  const uploader = entry.uploader?.trim() || fallbackUploader?.trim() || 'YouTube';
  return {
    id: 0,
    urn: `${YOUTUBE_TRACK_PREFIX}${entry.id}`,
    title: entry.title,
    duration: Math.round((entry.durationSecs ?? 0) * 1000),
    artwork_url: entry.thumbnail ?? `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`,
    permalink_url: `https://www.youtube.com/watch?v=${entry.id}`,
    user: {
      id: 0,
      urn: `youtube:users:${uploader}`,
      username: uploader,
      avatar_url: '',
    },
  };
}
