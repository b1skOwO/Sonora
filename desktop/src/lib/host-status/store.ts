import { create } from 'zustand';
import { API_BASE } from '../constants';

export type HostVerdict = 'up' | 'down' | 'unknown';
export type NetVerdict = 'unknown' | 'online' | 'no-internet';

export interface HostStatusState {
  main: HostVerdict;
  net: NetVerdict;
  /** Активная проба идёт (single-flight гейт + фидбек retry-кнопки). */
  probing: boolean;
  /** ++ на подтверждённом переходе main→down при net=online. */
  incidentId: number;
  modalDismissedIncidentId: number;
  bannerDismissedIncidentId: number;
  lastModalDismissAt: number;
  dismissModal: () => void;
  dismissBanner: () => void;
  reopenModal: () => void;
}

// Без persist: статус аварии — runtime-only.
export const useHostStatusStore = create<HostStatusState>()((set, get) => ({
  main: 'unknown',
  net: 'unknown',
  probing: false,
  incidentId: 0,
  modalDismissedIncidentId: -1,
  bannerDismissedIncidentId: -1,
  lastModalDismissAt: 0,
  dismissModal: () =>
    set({ modalDismissedIncidentId: get().incidentId, lastModalDismissAt: Date.now() }),
  dismissBanner: () => set({ bannerDismissedIncidentId: get().incidentId }),
  reopenModal: () => set({ modalDismissedIncidentId: -1 }),
}));

export type FailoverUi = 'none' | 'all-down';

/** Derived UI-состояние; UI его рендерит, нигде не хранится. */
export function selectFailoverUi(
  s: Pick<HostStatusState, 'main' | 'net'>,
  navigatorOnline: boolean,
  offlineBypass: boolean,
): FailoverUi {
  if (!navigatorOnline || offlineBypass) return 'none'; // нет сети / юзер сам выбрал offline
  if (s.net === 'no-internet') return 'none';
  return s.main === 'down' ? 'all-down' : 'none';
}

export function getHostVerdict(base: string): HostVerdict {
  if (base !== API_BASE) return 'unknown';
  return useHostStatusStore.getState().main;
}

export function isIncidentActive(): boolean {
  return useHostStatusStore.getState().main === 'down';
}

/** Control-plane база: единственный хост. */
export function preferredControlBase(): string {
  return API_BASE;
}
