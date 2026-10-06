//! Two-deck DJ mode: deck state, transport and the crossfader.
//!
//! Decks live in Rust (`audio::dj`); this store mirrors their state for the UI
//! and forwards commands. Positions/playing flags ride the `dj:tick` event.

import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { create } from 'zustand';
import { ensureTrackCached } from '../lib/cache';
import { trackedInvoke as invoke } from '../lib/diagnostics';
import type { Track } from './player';
import { usePlayerStore } from './player';

export interface DjDeckTick {
  deck: number;
  loaded: boolean;
  playing: boolean;
  position: number;
  duration: number | null;
}

export interface DjDeck {
  track: Track | null;
  loaded: boolean;
  playing: boolean;
  position: number;
  duration: number | null;
  /** 0..2, multiplied by the crossfader and the app volume. */
  volume: number;
  /** 0.5..2, pitch follows speed. */
  speed: number;
  /** Low / mid / high gains in dB. */
  eq: [number, number, number];
  loopA: number | null;
  loopB: number | null;
  loading: boolean;
}

function emptyDeck(): DjDeck {
  return {
    track: null,
    loaded: false,
    playing: false,
    position: 0,
    duration: null,
    volume: 0.8,
    speed: 1,
    eq: [0, 0, 0],
    loopA: null,
    loopB: null,
    loading: false,
  };
}

function patchDeck(decks: [DjDeck, DjDeck], index: 0 | 1, patch: Partial<DjDeck>): [DjDeck, DjDeck] {
  const next: [DjDeck, DjDeck] = [decks[0], decks[1]];
  next[index] = { ...next[index], ...patch };
  return next;
}

interface DjStoreState {
  open: boolean;
  active: boolean;
  crossfade: number;
  decks: [DjDeck, DjDeck];
  openPanel: () => void;
  closePanel: () => void;
  loadTrack: (deck: 0 | 1, track: Track) => Promise<void>;
  unload: (deck: 0 | 1) => void;
  togglePlay: (deck: 0 | 1) => void;
  seek: (deck: 0 | 1, position: number) => void;
  setVolume: (deck: 0 | 1, volume: number) => void;
  setSpeed: (deck: 0 | 1, speed: number) => void;
  setEq: (deck: 0 | 1, band: 0 | 1 | 2, gain: number) => void;
  setLoopPoint: (deck: 0 | 1, point: 'a' | 'b') => void;
  clearLoop: (deck: 0 | 1) => void;
  setCrossfade: (value: number) => void;
}

let tickBound = false;
function bindTick() {
  if (tickBound) return;
  tickBound = true;
  void listen<DjDeckTick[]>('dj:tick', (event) => {
    useDjStore.setState((state) => {
      let decks = state.decks;
      for (const tick of event.payload) {
        const index: 0 | 1 = tick.deck === 1 ? 1 : 0;
        const deck = decks[index];
        decks = patchDeck(decks, index, {
          loaded: tick.loaded,
          playing: tick.playing,
          position: tick.position,
          duration: tick.duration ?? deck.duration,
        });
      }
      return { decks };
    });
  });
}

export const useDjStore = create<DjStoreState>((set, get) => ({
  open: false,
  active: false,
  crossfade: 0.5,
  decks: [emptyDeck(), emptyDeck()],

  openPanel: () => {
    bindTick();
    set({ open: true, active: true });
    // The decks get the stage — silence the main player.
    usePlayerStore.getState().pause();
    void invoke('dj_set_active', { active: true }).catch(() => {});
    // Rust starts at crossfade 0 (deck A); push the UI's center position.
    void invoke('dj_set_crossfade', { value: get().crossfade }).catch(() => {});
  },

  closePanel: () => {
    set((state) => ({
      open: false,
      active: false,
      decks: [
        { ...state.decks[0], playing: false },
        { ...state.decks[1], playing: false },
      ],
    }));
    void invoke('dj_set_active', { active: false }).catch(() => {});
  },

  loadTrack: async (deck, track) => {
    bindTick();
    set((state) => ({ decks: patchDeck(state.decks, deck, { loading: true }) }));
    try {
      const info = await ensureTrackCached(track.urn, undefined, track.duration);
      const result = await invoke<{ durationSecs: number | null }>('dj_load', {
        deck,
        path: info.path,
      });
      set((state) => ({
        decks: patchDeck(state.decks, deck, {
          track,
          loaded: true,
          playing: false,
          position: 0,
          duration: result.durationSecs ?? track.duration / 1000,
          speed: 1,
          loopA: null,
          loopB: null,
          loading: false,
        }),
      }));
    } catch (error) {
      set((state) => ({ decks: patchDeck(state.decks, deck, { loading: false }) }));
      toast.error(String(error));
    }
  },

  unload: (deck) => {
    set((state) => ({ decks: patchDeck(state.decks, deck, { ...emptyDeck() }) }));
    void invoke('dj_unload', { deck }).catch(() => {});
  },

  togglePlay: (deck) => {
    const current = get().decks[deck];
    if (!current.loaded) return;
    const playing = !current.playing;
    set((state) => ({ decks: patchDeck(state.decks, deck, { playing }) }));
    void invoke('dj_play', { deck, playing }).catch(() => {});
  },

  seek: (deck, position) => {
    const current = get().decks[deck];
    const clamped = Math.max(0, Math.min(position, current.duration ?? position));
    set((state) => ({ decks: patchDeck(state.decks, deck, { position: clamped }) }));
    void invoke('dj_seek', { deck, position: clamped }).catch(() => {});
  },

  setVolume: (deck, volume) => {
    const value = Math.max(0, Math.min(2, volume));
    set((state) => ({ decks: patchDeck(state.decks, deck, { volume: value }) }));
    void invoke('dj_set_volume', { deck, volume: value }).catch(() => {});
  },

  setSpeed: (deck, speed) => {
    const value = Math.max(0.5, Math.min(2, speed));
    set((state) => ({ decks: patchDeck(state.decks, deck, { speed: value }) }));
    void invoke('dj_set_speed', { deck, speed: value }).catch(() => {});
  },

  setEq: (deck, band, gain) => {
    const current = get().decks[deck];
    const eq: [number, number, number] = [current.eq[0], current.eq[1], current.eq[2]];
    eq[band] = Math.max(-12, Math.min(12, gain));
    set((state) => ({ decks: patchDeck(state.decks, deck, { eq }) }));
    void invoke('dj_set_eq', { deck, low: eq[0], mid: eq[1], high: eq[2] }).catch(() => {});
  },

  setLoopPoint: (deck, point) => {
    const current = get().decks[deck];
    const loopA = point === 'a' ? current.position : current.loopA;
    const loopB = point === 'b' ? current.position : current.loopB;
    set((state) => ({ decks: patchDeck(state.decks, deck, { loopA, loopB }) }));
    void invoke('dj_set_loop', { deck, a: loopA, b: loopB }).catch(() => {});
  },

  clearLoop: (deck) => {
    set((state) => ({ decks: patchDeck(state.decks, deck, { loopA: null, loopB: null }) }));
    void invoke('dj_set_loop', { deck, a: null, b: null }).catch(() => {});
  },

  setCrossfade: (value) => {
    const crossfade = Math.max(0, Math.min(1, value));
    set({ crossfade });
    void invoke('dj_set_crossfade', { value: crossfade }).catch(() => {});
  },
}));
