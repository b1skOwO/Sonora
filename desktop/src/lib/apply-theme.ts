/**
 * Shared theme/perf var application. Used by the main-window ThemeProvider and the
 * standalone tray-popover window (a separate webview context that can't read the
 * main window's :root vars), so the accent + perf gating stay byte-identical.
 */

function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const r = Number.parseInt(h.substring(0, 2), 16);
  const g = Number.parseInt(h.substring(2, 4), 16);
  const b = Number.parseInt(h.substring(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

/** Write the accent CSS variables (+contrast) onto a root element.
 *  `glowStrength` (0–150) scales the accent glow/tint alpha. */
export function applyAccentVars(
  accentColor: string,
  root: HTMLElement = document.documentElement,
  glowStrength = 100,
) {
  const rgb = hexToRgb(accentColor);
  root.style.setProperty('--color-accent', accentColor);
  root.style.setProperty('--color-accent-rgb', rgb);
  const r = Number.parseInt(accentColor.slice(1, 3), 16);
  const g = Number.parseInt(accentColor.slice(3, 5), 16);
  const b = Number.parseInt(accentColor.slice(5, 7), 16);
  const hover = `rgb(${Math.min(255, r + 26)}, ${Math.min(255, g + 26)}, ${Math.min(255, b + 26)})`;
  root.style.setProperty('--color-accent-hover', hover);
  const glowAlpha = (0.2 * Math.max(0, glowStrength)) / 100;
  root.style.setProperty('--color-accent-glow', `rgba(${rgb}, ${glowAlpha})`);
  root.style.setProperty('--color-accent-selection', `rgba(${rgb}, 0.3)`);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  root.style.setProperty('--color-accent-contrast', lum > 160 ? '#000000' : '#ffffff');
}

/** Blur/glow multipliers consumed by index.css (glass radii, glow tints). */
export function applyEffectVars(
  blurStrength: number,
  glowStrength: number,
  root: HTMLElement = document.documentElement,
) {
  root.style.setProperty('--blur-scale', String(Math.max(0, blurStrength) / 100));
  root.style.setProperty('--glow-scale', String(Math.max(0, glowStrength) / 100));
  // 0% blur → index.css swaps live backdrop-filter for flat solid tints.
  root.dataset.blur = blurStrength > 0 ? 'on' : 'off';
}

/** Write the background CSS variables onto a root element. */
export function applyBgVars(bgPrimary: string, root: HTMLElement = document.documentElement) {
  root.style.setProperty('--bg-primary', bgPrimary);
  root.style.setProperty('--bg-titlebar', `rgba(${hexToRgb(bgPrimary)}, 0.95)`);
}

/** Drives index.css `[data-perf="…"]` rules (glass blur radii, idle-animation gates). */
export function applyPerfMode(perfMode: string, root: HTMLElement = document.documentElement) {
  root.dataset.perf = perfMode;
}
