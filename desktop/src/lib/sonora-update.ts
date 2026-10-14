import { check, type Update } from '@tauri-apps/plugin-updater';
import { create } from 'zustand';

export interface SonoraRelease {
  version: string;
  body?: string;
  date?: string;
}

export type UpdaterError = 'checkFailed' | 'installFailed';

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

/**
 * Pending update handle, kept out of the store: it holds a Rust-side resource
 * and isn't serializable. One at a time is enough — a newer check replaces it.
 */
let pendingUpdate: Update | null = null;

async function closePendingUpdate() {
  const handle = pendingUpdate;
  pendingUpdate = null;
  if (handle) await handle.close().catch(() => {});
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
    if (opts?.resetDismissal) set({ dismissedTag: null });
    set({ checking: true, error: null, upToDate: false });
    try {
      const update = await check({ timeout: 30_000 });
      if (!update) {
        set({ release: null, upToDate: true });
        return;
      }
      if (update.version === get().dismissedTag && !opts?.resetDismissal) {
        await update.close().catch(() => {});
        set({ release: null });
        return;
      }
      await closePendingUpdate();
      pendingUpdate = update;
      set({ release: { version: update.version, body: update.body, date: update.date } });
    } catch {
      set({ error: 'checkFailed' });
    } finally {
      set({ checking: false });
    }
  },

  install: async () => {
    const { installing, release } = get();
    if (!pendingUpdate || installing || !release) return;
    set({ installing: true, progress: 0, error: null });
    let received = 0;
    let total: number | null = null;
    try {
      await pendingUpdate.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? null;
            set({ progress: total ? 0 : null });
            break;
          case 'Progress':
            received += event.data.chunkLength;
            set({ progress: total ? Math.min(1, received / total) : null });
            break;
          case 'Finished':
            set({ progress: 1 });
            break;
        }
      });
      // On Windows the app exits while the installer runs, so this usually
      // only resolves on other platforms or when the install was aborted.
      set({ installing: false, progress: null });
    } catch {
      set({ installing: false, progress: null, error: 'installFailed' });
    }
  },

  dismiss: () => {
    void closePendingUpdate();
    set((s) => ({ release: null, dismissedTag: s.release?.version ?? s.dismissedTag }));
  },
}));
