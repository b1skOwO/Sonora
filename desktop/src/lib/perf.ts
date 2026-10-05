import { useMemo } from 'react';
import { useSettingsStore } from '../stores/settings';

/**
 * Performance modes scale the cost of the liquid-glass design down gracefully.
 * `beauty` is byte-for-byte the original experience; `light` is flat and static
 * but keeps the dark frosted aesthetic via solid tints; `medium` sits between.
 *
 * Two gating surfaces consume this:
 *  - index.css `[data-perf="…"]` rules gate CSS-class effects (named glass panels,
 *    keyframe animations) — see ThemeProvider which writes `documentElement.dataset.perf`.
 *  - components read `usePerfMode()` to gate inline-style blurs, particle counts and
 *    whole decorative subtrees (inline `animation`/`filter` can't be overridden by a class).
 */
export type PerfMode = 'light' | 'medium' | 'beauty';

export const PERF_MODES: PerfMode[] = ['light', 'medium', 'beauty'];

export interface PerfProfile {
  mode: PerfMode;
  /** Scale a backdrop/decorative blur radius (px). `light` → 0 (caller swaps to a solid tint). */
  blur: (beautyPx: number) => number;
  /** Scale a decorative particle/element count. `light` → 0. */
  particles: (beautyCount: number) => number;
  /** Run idle decorative animations (drifts, twinkles, spins, marquees, breathing). */
  idleAnim: boolean;
  /** Mount the full page atmosphere (aurora orbs, star fields, ambient layers). */
  atmosphere: boolean;
  /** Per-element drop-shadow/box-shadow glows on particles (the expensive part of twinkle). */
  glow: boolean;
  /** Mount heavy decorative background blooms (AmbientGlow, BackgroundGlow, per-card halos). */
  bloom: boolean;
  /** User accent-glow multiplier (0–1.5) for inline glow alphas. */
  glowScale: number;
}

const MODE_PROFILES: Record<PerfMode, Omit<PerfProfile, 'mode' | 'glowScale'>> = {
  beauty: {
    blur: (px) => px,
    particles: (n) => n,
    idleAnim: true,
    atmosphere: true,
    glow: true,
    bloom: true,
  },
  medium: {
    blur: (px) => Math.round(px * 0.5),
    particles: (n) => Math.ceil(n * 0.45),
    idleAnim: true,
    atmosphere: true,
    glow: false,
    bloom: true,
  },
  light: {
    blur: (px) => Math.round(px * 0.3),
    particles: () => 0,
    idleAnim: false,
    atmosphere: false,
    glow: false,
    bloom: false,
  },
};

const profileCache = new Map<string, PerfProfile>();

/** Stable per (mode, strength) profile objects so consumers can use them as memo deps. */
function buildProfile(mode: PerfMode, blurStrength: number, glowStrength: number): PerfProfile {
  const key = `${mode}:${blurStrength}:${glowStrength}`;
  const cached = profileCache.get(key);
  if (cached) return cached;
  const base = MODE_PROFILES[mode] ?? MODE_PROFILES.beauty;
  const scale = Math.max(0, blurStrength) / 100;
  const profile: PerfProfile = {
    mode,
    blur: (px) => Math.round(base.blur(px) * scale),
    particles: base.particles,
    idleAnim: base.idleAnim,
    atmosphere: base.atmosphere,
    glow: base.glow,
    bloom: base.bloom,
    glowScale: Math.max(0, glowStrength) / 100,
  };
  profileCache.set(key, profile);
  return profile;
}

/** Non-React accessor: uses the current settings strengths. */
export function getPerfProfile(mode: PerfMode): PerfProfile {
  const s = useSettingsStore.getState();
  return buildProfile(mode, s.blurStrength ?? 100, s.glowStrength ?? 100);
}

/** React hook: the active profile, re-rendering when mode or effect strengths change. */
export function usePerfMode(): PerfProfile {
  const mode = useSettingsStore((s) => s.perfMode);
  const blurStrength = useSettingsStore((s) => s.blurStrength);
  const glowStrength = useSettingsStore((s) => s.glowStrength);
  return useMemo(
    () => buildProfile(mode, blurStrength, glowStrength),
    [mode, blurStrength, glowStrength],
  );
}

/**
 * Global idle-animation gate: a single visibilitychange listener flips
 * `documentElement[data-app-hidden]`, which index.css uses to pause every CSS
 * animation while the window is hidden (the WebView does NOT throttle timers/rAF).
 * Idempotent; call once at startup.
 */
let visibilityGateInstalled = false;

export function setupVisibilityGate(): void {
  if (visibilityGateInstalled || typeof document === 'undefined') return;
  visibilityGateInstalled = true;
  const apply = () => {
    if (document.visibilityState === 'hidden') {
      document.documentElement.setAttribute('data-app-hidden', '1');
    } else {
      document.documentElement.removeAttribute('data-app-hidden');
    }
  };
  apply();
  document.addEventListener('visibilitychange', apply);
}
