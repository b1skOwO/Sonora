import { BaseDirectory, exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import type { Track } from '../stores/player';

const BASE_DIR = BaseDirectory.AppData;
const INDEX_PATH = 'offline-index.json';

interface OfflineIndex {
  likedUrns: string[];
  tracksByUrn: Record<string, Track>;
  updatedAt: number | null;
  /** User-arranged order of the cached list ("Свой порядок" sort mode). */
  cacheOrder: string[];
}

const EMPTY_INDEX: OfflineIndex = {
  likedUrns: [],
  tracksByUrn: {},
  updatedAt: null,
  cacheOrder: [],
};

let indexCache: OfflineIndex | null = null;
let loadPromise: Promise<OfflineIndex> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let dirReady: Promise<void> | null = null;

function ensureDir() {
  if (!dirReady) {
    dirReady = mkdir('', { baseDir: BASE_DIR, recursive: true }).catch(() => {});
  }
  return dirReady;
}

function cloneTrack(track: Track): Track {
  return {
    ...track,
    user: { ...track.user },
  };
}

/** Safety bound on the remembered-track metadata map (pathological growth
 *  only — effectively unlimited for real use). Liked and locally cached
 *  tracks are always kept; the rest falls off oldest-first. */
const TRACKS_BY_URN_CAP = 50000;

function trimTracksByUrn(index: OfflineIndex) {
  const keys = Object.keys(index.tracksByUrn);
  if (keys.length <= TRACKS_BY_URN_CAP) {
    return;
  }
  const keep = new Set([...index.likedUrns, ...index.cacheOrder]);
  let over = keys.length - TRACKS_BY_URN_CAP;
  for (const key of keys) {
    if (over <= 0) break;
    if (keep.has(key)) continue;
    delete index.tracksByUrn[key];
    over--;
  }
}

async function readIndexFile(): Promise<OfflineIndex> {
  await ensureDir();

  try {
    if (!(await exists(INDEX_PATH, { baseDir: BASE_DIR }))) {
      return EMPTY_INDEX;
    }

    const raw = await readTextFile(INDEX_PATH, { baseDir: BASE_DIR });
    const parsed = JSON.parse(raw) as OfflineIndex;
    return {
      likedUrns: Array.isArray(parsed.likedUrns) ? parsed.likedUrns : [],
      tracksByUrn: parsed.tracksByUrn ?? {},
      updatedAt: parsed.updatedAt ?? null,
      cacheOrder: Array.isArray(parsed.cacheOrder) ? parsed.cacheOrder : [],
    };
  } catch {
    return EMPTY_INDEX;
  }
}

async function loadIndex(): Promise<OfflineIndex> {
  if (indexCache) {
    return indexCache;
  }

  if (!loadPromise) {
    loadPromise = readIndexFile()
      .then((parsed) => {
        indexCache = parsed;
        return parsed;
      })
      .finally(() => {
        loadPromise = null;
      });
  }

  return loadPromise;
}

function schedulePersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }

  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!indexCache) return;

    void ensureDir().then(() =>
      writeTextFile(INDEX_PATH, JSON.stringify(indexCache), { baseDir: BASE_DIR }).catch(() => {}),
    );
  }, 120);
}

export async function rememberTracks(tracks: Track[]) {
  if (tracks.length === 0) return;

  const index = await loadIndex();
  let changed = false;

  for (const track of tracks) {
    if (!track?.urn) continue;
    index.tracksByUrn[track.urn] = cloneTrack(track);
    changed = true;
  }

  if (changed) {
    trimTracksByUrn(index);
    schedulePersist();
  }
}

export async function rememberLikedTracks(tracks: Track[]) {
  const index = await loadIndex();
  for (const track of tracks) {
    if (!track?.urn) continue;
    index.tracksByUrn[track.urn] = cloneTrack(track);
  }

  index.likedUrns = tracks.map((track) => track.urn);
  trimTracksByUrn(index);
  index.updatedAt = Date.now();
  schedulePersist();
}

export async function getOfflineLikedTracks() {
  const index = await loadIndex();
  return index.likedUrns
    .map((urn) => index.tracksByUrn[urn])
    .filter((track): track is Track => Boolean(track));
}

export async function getOfflineTracksByUrns(urns: string[]) {
  const index = await loadIndex();
  return urns
    .map((urn) => index.tracksByUrn[urn])
    .filter((track): track is Track => Boolean(track));
}

export async function getOfflineIndexUpdatedAt() {
  const index = await loadIndex();
  return index.updatedAt;
}

export async function getCacheOrder(): Promise<string[]> {
  const index = await loadIndex();
  return index.cacheOrder;
}

export async function saveCacheOrder(urns: string[]) {
  const index = await loadIndex();
  index.cacheOrder = urns;
  schedulePersist();
}
