import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { tauriStorage } from '../lib/tauri-storage';

/** Content service the app is switched to: SoundCloud or YouTube. */
export type Service = 'soundcloud' | 'youtube';

interface ServiceState {
  service: Service;
  setService: (service: Service) => void;
  toggleService: () => void;
}

export const useServiceStore = create<ServiceState>()(
  persist(
    (set) => ({
      service: 'soundcloud',
      setService: (service) => set({ service }),
      toggleService: () =>
        set((s) => ({ service: s.service === 'soundcloud' ? 'youtube' : 'soundcloud' })),
    }),
    {
      name: 'sc-service',
      storage: createJSONStorage(() => tauriStorage),
      partialize: (s) => ({ service: s.service }),
    },
  ),
);
