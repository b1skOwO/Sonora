import type { Track } from '../stores/player';
import { api } from './api';
import { getTrackDisplay } from './track-display';
import { isYoutubeUrn } from './youtube';

export type LyricsSource = 'lrclib' | 'musixmatch' | 'genius' | 'netease' | 'self_gen' | 'none';

export interface LyricLine {
  time: number;
  text: string;
}

export interface LyricsResult {
  plain: string | null;
  synced: LyricLine[] | null;
  source: LyricsSource;
  language: string | null;
}

interface BackendLyricsResponse {
  scTrackId: string;
  syncedLrc: string | null;
  plainText: string | null;
  source: LyricsSource;
  language: string | null;
  languageConfidence: number | null;
}

/** Parse LRC format: [mm:ss.xx] text */
export function parseLRC(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of lrc.split('\n')) {
    const m = raw.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\]\s*(.*)/);
    if (!m) continue;
    const time = +m[1] * 60 + +m[2] + +m[3].padEnd(3, '0') / 1000;
    const text = m[4].trim();
    if (text) lines.push({ time, text });
  }
  return lines;
}

function toResult(data: BackendLyricsResponse | null): LyricsResult | null {
  if (!data) return null;
  const synced = data.syncedLrc ? parseLRC(data.syncedLrc) : null;
  return {
    plain: data.plainText,
    synced: synced && synced.length > 0 ? synced : null,
    source: data.source,
    language: data.language,
  };
}

/** Load lyrics by track URN/id. Backend resolves artist/title itself and writes to cache. */
export async function getLyricsByTrack(scTrackId: string): Promise<LyricsResult | null> {
  if (isYoutubeUrn(scTrackId)) return null;
  const data = await api<BackendLyricsResponse>(
    `/lyrics/${encodeURIComponent(scTrackId)}`,
    undefined,
    180_000,
  ).catch(() => null);
  return toResult(data);
}

/** Manual search — preview only. Backend does NOT read or write cache. */
export async function searchLyricsManual(
  artist: string,
  title: string,
  durationMs?: number,
): Promise<LyricsResult | null> {
  const params = new URLSearchParams({ artist, title });
  if (durationMs && Number.isFinite(durationMs) && durationMs > 0) {
    params.set('duration', String(Math.round(durationMs)));
  }
  const data = await api<BackendLyricsResponse>(
    `/lyrics/search?${params}`,
    undefined,
    180_000,
  ).catch(() => null);
  return toResult(data);
}

/**
 * Lyrics for any track. SoundCloud goes through the backend cache by id;
 * YouTube tracks have no backend id, so they are searched by artist/title —
 * the same route the manual search uses, with a couple of fallback splits for
 * "Artist - Song" style video titles.
 */
export async function getLyricsForTrack(track: Track): Promise<LyricsResult | null> {
  if (!isYoutubeUrn(track.urn)) return getLyricsByTrack(track.urn);

  const display = getTrackDisplay(track);
  const uploader = track.user?.username?.trim() ?? '';
  const attempts: Array<{ artist: string; title: string }> = [];
  const push = (artist: string | undefined, title: string | undefined) => {
    const a = (artist ?? '').trim();
    const t = (title ?? '').trim();
    if (!a || !t) return;
    if (attempts.some((x) => x.artist === a && x.title === t)) return;
    attempts.push({ artist: a, title: t });
  };

  push(display.artistLine || uploader, display.title);
  // Japanese video titles often wrap the song in 「」 after the group name
  // ("初星学園「がむしゃらに行こう」"): the inner text is the actual title.
  const jp = display.title.match(/^(.{0,40}?)「(.+?)」/);
  if (jp) {
    push(jp[1] || uploader, jp[2]);
    push(uploader, jp[2]);
  }
  // The display kept "Artist - Song" whole (the artist wasn't in the known
  // set): try both directions once before giving up.
  const split = display.title.match(/^(.{2,60}?)\s[-–—|]\s(.{2,80})$/);
  if (split) {
    push(split[1], split[2]);
    push(split[2], split[1]);
  }
  push(uploader, display.title);

  for (const attempt of attempts.slice(0, 3)) {
    const result = await searchLyricsManual(attempt.artist, attempt.title, track.duration);
    if (result && ((result.synced?.length ?? 0) > 0 || result.plain)) return result;
  }
  return null;
}
