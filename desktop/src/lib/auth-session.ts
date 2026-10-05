import { listen } from '@tauri-apps/api/event';
import { useAuthStore } from '../stores/auth';
import { useAuthRecoveryStore } from '../stores/auth-recovery';
import { setSessionId } from './api';
import { trackedInvoke as invoke } from './diagnostics';
import { queryClient } from './query-client';

interface ServerAuthState {
  token: string | null;
}

/**
 * Apply Rust-owned session state to the frontend mirrors. The api-client token
 * mirror and the auth store are written ONLY here — always with a value Rust
 * just confirmed (command return or the `auth:changed` broadcast). Idempotent,
 * so the initiating window and the tray can both run it.
 */
export function applyAuthFromServer(token: string | null): void {
  setSessionId(token);
  if (token) {
    useAuthStore.setState({ hasSession: true });
  } else {
    useAuthStore.setState({ hasSession: false, isAuthenticated: false, user: null });
    queryClient.clear();
    useAuthRecoveryStore.getState().reset();
  }
}

const SNAPSHOT_ATTEMPTS = 3;
const SNAPSHOT_RETRY_MS = 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Снимок сессии из Rust. Провал invoke — это НЕ «юзер разлогинен», а «Rust не
 * ответил», и путать их нельзя: в dev webview перезагружается отдельно от
 * бэкенда, висящий callback теряется (`[TAURI] Couldn't find callback id`), и
 * ошибка прилетает на ровном месте. Раньше её принимали за пустую сессию —
 * зеркало чистилось, и первые запросы уходили без `x-session-id`, ловя
 * бессмысленный 401 «Missing or malformed». Поэтому: ретраим, а не отвечаем.
 */
async function readAuthStatus(): Promise<ServerAuthState | null> {
  for (let attempt = 1; attempt <= SNAPSHOT_ATTEMPTS; attempt++) {
    try {
      return await invoke<ServerAuthState>('auth_status');
    } catch {
      if (attempt < SNAPSHOT_ATTEMPTS) await sleep(SNAPSHOT_RETRY_MS);
    }
  }
  return null;
}

/** Seed the mirror from Rust once, then track every `auth:changed` broadcast. */
export async function initAuthBridge(): Promise<void> {
  // Подписка ПЕРЕД снимком: логин/логаут, случившийся пока читаем снимок,
  // иначе потерялся бы целиком.
  await listen<ServerAuthState>('auth:changed', (e) => {
    applyAuthFromServer(e.payload?.token ?? null);
  });
  const snap = await readAuthStatus();
  // Rust так и не ответил — зеркало не трогаем. Пусть его заполнит
  // `auth:changed`, а запросы подождут (`api-client`: гейт с потолком).
  if (snap) applyAuthFromServer(snap.token ?? null);
}
