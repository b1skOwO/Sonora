import { appCacheDir, join } from '@tauri-apps/api/path';
import { mkdir, writeFile } from '@tauri-apps/plugin-fs';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { create } from 'zustand';
import { useSettingsStore } from '../stores/settings';
import { APP_VERSION } from './constants';
import { trackedInvoke as invoke } from './diagnostics';
import { isNewerVersion } from './semver';
import type { GithubRelease } from './update-check';

/** This repo's releases — the private update feed (needs a token to read). */
export const SONORA_OWNER = 'b1skOwO';
export const SONORA_REPO = 'Sonora';

export interface SonoraAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface SonoraRelease extends GithubRelease {
  assets: SonoraAsset[];
}

export type UpdateCheckFailure = 'auth' | 'network';

export class UpdateCheckError extends Error {
  code: UpdateCheckFailure;
  constructor(code: UpdateCheckFailure) {
    super(`sonora update check failed: ${code}`);
    this.code = code;
  }
}

function stripLeadingV(version: string): string {
  return version.replace(/^v/, '');
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/**
 * Latest published release, or null when none exists yet. Throws
 * UpdateCheckError('auth') on 401 (bad/missing token) and
 * UpdateCheckError('network') on 5xx/429/timeouts.
 */
export async function fetchSonoraRelease(pat: string): Promise<SonoraRelease | null> {
  const url = `https://api.github.com/repos/${SONORA_OWNER}/${SONORA_REPO}/releases/latest`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${pat}`,
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await tauriFetch(url, { headers });
      if (response.status === 401 || response.status === 403) {
        throw new UpdateCheckError('auth');
      }
      if (response.status === 404) return null;
      if (response.ok) return await readJson<SonoraRelease>(response);
      if (response.status < 500 && response.status !== 429) {
        throw new UpdateCheckError('network');
      }
    } catch (error) {
      if (error instanceof UpdateCheckError) throw error;
      // Transport error — retry below, then give up as network failure.
    }
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw new UpdateCheckError('network');
}

export function isUpdateAvailable(release: SonoraRelease): boolean {
  return isNewerVersion(stripLeadingV(release.tag_name), stripLeadingV(APP_VERSION));
}

/** Prefer the NSIS setup exe; fall back to any plain exe asset. */
export function pickInstallerAsset(release: SonoraRelease): SonoraAsset | null {
  const assets = release.assets ?? [];
  return (
    assets.find((a) => a.name.endsWith('-setup.exe')) ??
    assets.find((a) => a.name.endsWith('.exe') && !a.name.endsWith('.zip')) ??
    null
  );
}

async function readBodyWithProgress(
  response: Response,
  onProgress: (fraction: number | null) => void,
): Promise<Uint8Array> {
  const totalHeader = response.headers.get('content-length');
  const total = totalHeader ? Number.parseInt(totalHeader, 10) : NaN;
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    onProgress(Number.isFinite(total) && total > 0 ? 1 : null);
    return new Uint8Array(buffer);
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(Number.isFinite(total) && total > 0 ? Math.min(1, received / total) : null);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Download the installer asset into the app cache and hand it to the Rust
 * side, which launches it and quits. Resolves only when something fails —
 * on success the process is gone.
 */
export async function downloadAndInstallAsset(
  asset: SonoraAsset,
  pat: string,
  onProgress: (fraction: number | null) => void,
): Promise<void> {
  onProgress(0);
  let bytes: Uint8Array;
  try {
    const response = await tauriFetch(asset.browser_download_url, {
      headers: { Authorization: `Bearer ${pat}` },
    });
    if (!response.ok) throw new Error(`download HTTP ${response.status}`);
    bytes = await readBodyWithProgress(response, onProgress);
  } catch (error) {
    // Streaming isn't guaranteed on every backend — one plain retry.
    const response = await tauriFetch(asset.browser_download_url, {
      headers: { Authorization: `Bearer ${pat}` },
    });
    if (!response.ok) throw error instanceof Error ? error : new Error('download failed');
    bytes = new Uint8Array(await response.arrayBuffer());
    onProgress(1);
  }
  if (asset.size > 0 && bytes.byteLength !== asset.size) {
    throw new Error(`size mismatch: got ${bytes.byteLength}, expected ${asset.size}`);
  }
  const dir = await join(await appCacheDir(), 'updates');
  await mkdir(dir, { recursive: true });
  const dest = await join(dir, asset.name);
  await writeFile(dest, bytes);
  onProgress(null);
  await invoke('app_install_update', { path: dest });
}

export type UpdaterError =
  | 'authFailed'
  | 'checkFailed'
  | 'noReleases'
  | 'installFailed'
  | 'noAsset';

interface UpdaterState {
  release: SonoraRelease | null;
  checking: boolean;
  installing: boolean;
  progress: number | null;
  upToDate: boolean;
  error: UpdaterError | null;
  dismissedTag: string | null;
  checkNow: (opts?: { resetDismissal?: boolean }) => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
}

export const useUpdaterStore = create<UpdaterState>()((set, get) => ({
  release: null,
  checking: false,
  installing: false,
  progress: null,
  upToDate: false,
  error: null,
  dismissedTag: null,

  checkNow: async (opts) => {
    const { checking, installing } = get();
    if (checking || installing) return;
    const pat = useSettingsStore.getState().githubPat.trim();
    if (!pat) return;
    if (opts?.resetDismissal) set({ dismissedTag: null });
    set({ checking: true, error: null, upToDate: false });
    try {
      const release = await fetchSonoraRelease(pat);
      if (!release) {
        set({ release: null, upToDate: false, error: 'noReleases' });
        return;
      }
      if (!isUpdateAvailable(release)) {
        set({ release: null, upToDate: true });
        return;
      }
      if (release.tag_name === get().dismissedTag && !opts?.resetDismissal) {
        set({ release: null });
        return;
      }
      set({ release });
    } catch (error) {
      set({
        error:
          error instanceof UpdateCheckError && error.code === 'auth' ? 'authFailed' : 'checkFailed',
      });
    } finally {
      set({ checking: false });
    }
  },

  install: async () => {
    const { release, installing } = get();
    if (!release || installing) return;
    const asset = pickInstallerAsset(release);
    const pat = useSettingsStore.getState().githubPat.trim();
    if (!asset || !pat) {
      set({ error: !asset ? 'noAsset' : 'authFailed' });
      return;
    }
    set({ installing: true, progress: 0, error: null });
    try {
      await downloadAndInstallAsset(asset, pat, (fraction) => {
        useUpdaterStore.setState({ progress: fraction });
      });
    } catch {
      set({ installing: false, progress: null, error: 'installFailed' });
    }
  },

  dismiss: () =>
    set((s) => ({ release: null, dismissedTag: s.release?.tag_name ?? s.dismissedTag })),
}));
