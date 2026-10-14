//! DJ keyboard shortcuts: action ids, defaults, dispatch and user remapping.
//!
//! Bindings are stored as `KeyboardEvent.code` values (layout-independent) and
//! persisted via `tauri-storage`. The global keydown handler in AppShell
//! consults this store: when the DJ panel is open, DJ bindings win over the
//! main-player keys.

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { tauriStorage } from '../lib/tauri-storage';
import { useDjStore } from './dj';

export type DjActionId =
  | 'deckA.play'
  | 'deckB.play'
  | 'deckA.cue'
  | 'deckB.cue'
  | 'deckA.sync'
  | 'deckB.sync'
  | 'xfader.left'
  | 'xfader.right'
  | 'automix.toggle';

export interface DjActionDef {
  id: DjActionId;
  labelKey: string;
}

/** Display order in Settings and the shortcuts dialog. */
export const DJ_ACTIONS: ReadonlyArray<DjActionDef> = [
  { id: 'deckA.play', labelKey: 'dj.playA' },
  { id: 'deckB.play', labelKey: 'dj.playB' },
  { id: 'deckA.cue', labelKey: 'dj.cueA' },
  { id: 'deckB.cue', labelKey: 'dj.cueB' },
  { id: 'deckA.sync', labelKey: 'dj.syncA' },
  { id: 'deckB.sync', labelKey: 'dj.syncB' },
  { id: 'xfader.left', labelKey: 'dj.xfaderLeft' },
  { id: 'xfader.right', labelKey: 'dj.xfaderRight' },
  { id: 'automix.toggle', labelKey: 'dj.automixToggle' },
];

export const DJ_ACTION_IDS: ReadonlyArray<DjActionId> = DJ_ACTIONS.map((a) => a.id);

/**
 * Defaults: left hand drives deck A, right hand deck B, arrows ride the
 * crossfader. None of these collide with the global (main-player) shortcuts.
 */
export const DEFAULT_DJ_BINDINGS: Record<DjActionId, string> = {
  'deckA.play': 'KeyA',
  'deckB.play': 'KeyD',
  'deckA.cue': 'KeyW',
  'deckB.cue': 'KeyE',
  'deckA.sync': 'KeyZ',
  'deckB.sync': 'KeyC',
  'xfader.left': 'ArrowLeft',
  'xfader.right': 'ArrowRight',
  'automix.toggle': 'KeyX',
};

/** Crossfader travel per key press (holding the key repeats). */
const XFADER_STEP = 0.1;

export function findDjAction(
  bindings: Record<DjActionId, string>,
  code: string,
): DjActionId | null {
  for (const id of DJ_ACTION_IDS) {
    if (bindings[id] === code) return id;
  }
  return null;
}

export function dispatchDjAction(action: DjActionId): void {
  const dj = useDjStore.getState();
  switch (action) {
    case 'deckA.play':
      dj.togglePlay(0);
      break;
    case 'deckB.play':
      dj.togglePlay(1);
      break;
    case 'deckA.cue':
      dj.seek(0, 0);
      break;
    case 'deckB.cue':
      dj.seek(1, 0);
      break;
    case 'deckA.sync':
      dj.syncTempo(0);
      break;
    case 'deckB.sync':
      dj.syncTempo(1);
      break;
    case 'xfader.left':
      dj.setCrossfade(dj.crossfade - XFADER_STEP);
      break;
    case 'xfader.right':
      dj.setCrossfade(dj.crossfade + XFADER_STEP);
      break;
    case 'automix.toggle':
      dj.setAutomix(!dj.automix);
      break;
  }
}

const CODE_LABELS: Record<string, string> = {
  Space: 'Space',
  Escape: 'Esc',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  BracketLeft: '[',
  BracketRight: ']',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Backslash: '\\',
  Tab: 'Tab',
  Enter: 'Enter',
  CapsLock: 'Caps',
};

/** `KeyA` → `A`, `Digit1` → `1`, arrows → ←/→, known codes → short labels. */
export function formatKeyCode(code: string): string {
  const direct = CODE_LABELS[code];
  if (direct) return direct;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (/^F\d+$/.test(code)) return code;
  if (code.startsWith('Numpad')) return code.slice(6);
  return code;
}

/**
 * Text-entry targets where deck hotkeys must not fire. Range sliders are
 * deliberately excluded — letter keys do nothing on them, so shortcuts keep
 * working right after dragging tempo / EQ / crossfade.
 */
export function isTextEntryTarget(el: EventTarget | null): boolean {
  return (
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    (el instanceof HTMLInputElement && el.type !== 'range') ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}

interface KeybindingsState {
  bindings: Record<DjActionId, string>;
  /** Rebind an action; if the key is taken, the two actions swap keys. */
  setBinding: (action: DjActionId, code: string) => void;
  resetBindings: () => void;
}

export const useKeybindingsStore = create<KeybindingsState>()(
  persist(
    (set) => ({
      bindings: { ...DEFAULT_DJ_BINDINGS },

      setBinding: (action, code) =>
        set((s) => {
          const bindings = { ...s.bindings };
          const other = DJ_ACTION_IDS.find((id) => id !== action && bindings[id] === code);
          if (other) bindings[other] = bindings[action];
          bindings[action] = code;
          return { bindings };
        }),

      resetBindings: () => set({ bindings: { ...DEFAULT_DJ_BINDINGS } }),
    }),
    {
      name: 'sc-keybindings',
      storage: createJSONStorage(() => tauriStorage),
      version: 1,
      migrate: (persistedState) => {
        const prev = (persistedState ?? {}) as {
          bindings?: Partial<Record<DjActionId, string>>;
        };
        const bindings = { ...DEFAULT_DJ_BINDINGS };
        for (const id of DJ_ACTION_IDS) {
          const code = prev.bindings?.[id];
          if (typeof code === 'string' && code.length > 0) bindings[id] = code;
        }
        return { bindings } as KeybindingsState;
      },
      partialize: (s) => ({ bindings: s.bindings }),
    },
  ),
);
