//! Upgrade an imported YouTube playlist: when a track was uploaded by someone
//! other than the artist, look for the artist's own channel and play their
//! upload instead.
//!
//! The artist is inferred from the video title (common music-title shapes:
//! "(Artist - Title)", "Artist「Title」", "Artist - Title", "Title / Artist"),
//! resolved to a channel through `yt_search`, and only then used to pick a
//! replacement — every step is conservative: no channel or no title/duration
//! match means the original video stays.

import { trackedInvoke as invoke } from './diagnostics';
import { stableYoutubeThumbnail, type YtEntry } from './youtube';

/** Entries upgraded per import (each one costs a yt-dlp search). */
const MAX_UPGRADE_TRACKS = 60;
/** Distinct artist→channel lookups per import. */
const MAX_CHANNEL_LOOKUPS = 8;
const CHANNEL_SEARCH = 10;
const TRACK_SEARCH = 6;
const SEARCH_DELAY_MS = 150;

const NOISE_WORDS = new Set([
  'official',
  'video',
  'music',
  'mv',
  'lyric',
  'lyrics',
  'audio',
  'visualizer',
  'visualiser',
  'full',
  'hd',
  '4k',
  'short',
  'ver',
  'version',
  'remix',
  'cover',
  'feat',
  'ft',
  'prod',
  'live',
  'tv',
  'size',
  'movie',
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lowercase, drop bracketed content, keep letters/digits (mirrors the Rust normalize). */
export function normalizeForMatch(text: string): string {
  let out = '';
  let depth = 0;
  for (const ch of text) {
    if ('([【（「'.includes(ch)) depth += 1;
    else if (')]】）」'.includes(ch)) depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      out += /[\p{L}\p{N}]/u.test(ch) ? ch.toLowerCase() : ' ';
    }
  }
  return out.split(/\s+/).filter(Boolean).join(' ');
}

function clean(text: string): string {
  return text
    .replace(/[「」【】[\]()（）]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeArtist(text: string): boolean {
  const cleaned = clean(text);
  if (cleaned.length < 2 || cleaned.length > 40) return false;
  const words = cleaned
    .toLowerCase()
    .split(/[\s/&,]+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;
  const meaningful = words.filter((word) => !NOISE_WORDS.has(word) && !/^\d+$/.test(word));
  return meaningful.length > 0 && meaningful.length * 2 >= words.length;
}

/** Candidate artist names parsed out of a video title (most specific first). */
export function artistCandidates(title: string): string[] {
  const out: string[] = [];
  const push = (value: string | undefined) => {
    if (!value) return;
    const cleaned = clean(value);
    if (looksLikeArtist(cleaned) && !out.includes(cleaned)) out.push(cleaned);
  };

  // "(Artist - Title)" tail — common on official Japanese MVs.
  push(title.match(/[(（]([^()（）]{2,60}?)\s[-–—]\s[^()（）]{1,80}[)）]/)?.[1]);
  // "Artist「Title」"
  push(title.match(/^([^「」]{2,40})「/)?.[1]);
  // "Artist - Title" head.
  push(title.match(/^([^-–—]{2,40}?)\s[-–—]\s/)?.[1]);
  // "Title / Artist" tail.
  push(title.match(/\s\/\s([^/]{2,40})$/)?.[1]);

  return out.slice(0, 2);
}

function channelMatches(hint: string, uploader: string | null | undefined): boolean {
  const hintNorm = normalizeForMatch(hint);
  const uploaderNorm = normalizeForMatch(uploader ?? '');
  if (!hintNorm || !uploaderNorm) return false;
  return (
    uploaderNorm === hintNorm || uploaderNorm.includes(hintNorm) || hintNorm.includes(uploaderNorm)
  );
}

function jaccard(a: string, b: string): number {
  const left = new Set(a.split(' ').filter(Boolean));
  const right = new Set(b.split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const word of left) if (right.has(word)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

/** Search the artist name and take the channel that looks like them: exact or
 *  containing names win, otherwise a channel that dominates the results. */
async function resolveArtistChannel(
  artist: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const key = normalizeForMatch(artist);
  if (!key) return null;
  if (cache.has(key)) return cache.get(key) ?? null;

  let found: string | null = null;
  try {
    const entries = await invoke<YtEntry[]>('yt_search', { query: artist, limit: CHANNEL_SEARCH });
    const counts = new Map<string, { rank: number; hits: number }>();
    for (const entry of entries) {
      const uploader = entry.uploader?.trim();
      if (!uploader) continue;
      const norm = normalizeForMatch(uploader);
      if (!norm) continue;
      const rank = norm === key ? 2 : norm.includes(key) || key.includes(norm) ? 1 : 0;
      const slot = counts.get(uploader) ?? { rank: 0, hits: 0 };
      slot.rank = Math.max(slot.rank, rank);
      slot.hits += 1;
      counts.set(uploader, slot);
    }
    let best: { name: string; rank: number; hits: number } | null = null;
    for (const [name, stats] of counts) {
      if (stats.rank === 0 && stats.hits < 3) continue;
      if (!best || stats.rank > best.rank || (stats.rank === best.rank && stats.hits > best.hits)) {
        best = { name, ...stats };
      }
    }
    found = best?.name ?? null;
  } catch {
    found = null;
  }
  cache.set(key, found);
  return found;
}

/** The artist's own upload of `entry`, if the search finds one. */
async function findOnChannel(
  entry: YtEntry,
  artist: string,
  channel: string,
): Promise<YtEntry | null> {
  const titleNorm = normalizeForMatch(entry.title);
  if (titleNorm.length < 4) return null;

  let candidates: YtEntry[] = [];
  try {
    candidates = await invoke<YtEntry[]>('yt_search', {
      query: `${entry.title} ${artist}`,
      limit: TRACK_SEARCH,
    });
  } catch {
    return null;
  }

  let best: YtEntry | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    if (!channelMatches(channel, candidate.uploader)) continue;
    const candTitle = normalizeForMatch(candidate.title);
    if (!candTitle) continue;
    const sameish =
      candTitle === titleNorm || candTitle.includes(titleNorm) || titleNorm.includes(candTitle);
    const similarity = sameish ? 1 : jaccard(titleNorm, candTitle);
    if (similarity < 0.5) continue;
    let score = similarity;
    if (entry.durationSecs && candidate.durationSecs) {
      const diff = Math.abs(entry.durationSecs - candidate.durationSecs);
      if (diff > 15) continue;
      if (diff <= 5) score += 0.2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

export interface UpgradeProgress {
  done: number;
  total: number;
  replaced: number;
  current: string;
}

export interface UpgradeOutcome {
  entries: YtEntry[];
  replaced: number;
  scanned: number;
}

/** Walk the entries and swap in the artist's own uploads where they exist. */
export async function upgradeYoutubeEntries(
  entries: YtEntry[],
  opts: {
    shouldCancel?: () => boolean;
    onProgress?: (progress: UpgradeProgress) => void;
  } = {},
): Promise<UpgradeOutcome> {
  const total = Math.min(entries.length, MAX_UPGRADE_TRACKS);
  const channelCache = new Map<string, string | null>();
  const upgraded = [...entries];
  let lookups = 0;
  let replaced = 0;

  for (let index = 0; index < total; index++) {
    if (opts.shouldCancel?.()) break;
    const entry = entries[index];
    opts.onProgress?.({ done: index, total, replaced, current: entry.title });

    const candidates = artistCandidates(entry.title);
    if (candidates.length === 0) continue;

    let artist: string | null = null;
    let channel: string | null = null;
    for (const candidate of candidates) {
      const key = normalizeForMatch(candidate);
      if (!key) continue;
      if (!channelCache.has(key) && lookups >= MAX_CHANNEL_LOOKUPS) continue;
      if (!channelCache.has(key)) lookups += 1;
      const resolved = await resolveArtistChannel(candidate, channelCache);
      if (resolved) {
        artist = candidate;
        channel = resolved;
        break;
      }
    }
    if (!artist || !channel) continue;
    // Already playing from the artist's own channel.
    if (channelMatches(channel, entry.uploader)) continue;

    const found = await findOnChannel(entry, artist, channel);
    if (!found || found.id === entry.id) continue;

    upgraded[index] = {
      ...entry,
      id: found.id,
      uploader: found.uploader ?? entry.uploader,
      durationSecs: found.durationSecs ?? entry.durationSecs,
      thumbnail: stableYoutubeThumbnail(found.thumbnail, found.id),
    };
    replaced += 1;
    await sleep(SEARCH_DELAY_MS);
  }

  opts.onProgress?.({ done: total, total, replaced, current: '' });
  return { entries: upgraded, replaced, scanned: total };
}
