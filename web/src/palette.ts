import { Color } from 'three';

/** Every colour in the game. Nothing outside this module writes a colour literal; see docs/art.md. */
export const palette = {
  void: '#0a0f15',
  floor: '#2a3646',
  floorAlt: '#2e3b4d',
  seam: '#111821',
  outerFloor: '#0e141c',
  marking: 'hsl(192, 60%, 30%)',
  markingGlow: '#0b8fb8',
  wall: '#2b3544',
  hull: '#d3dae3',
  hullDark: '#6c7889',
  trim: '#1b212a',
  rock: 'hsl(22, 16%, 36%)',
  accent: 'hsl(192, 90%, 42%)',
  accentGlow: 'hsl(190, 95%, 58%)',
  prop: 'hsl(208, 16%, 46%)',
  coral: 'hsl(12, 90%, 60%)',
  violet: 'hsl(262, 75%, 64%)',
  keyLight: '#ffe6c7',
  skyFill: '#9fb6d8',
  groundFill: '#1c140d',
  white: '#ffffff',
  black: '#000000',
  ink: '#e8edf3',
  muted: '#8a96a6',
  panel: 'rgba(13, 19, 27, 0.72)',
  line: 'rgba(255, 255, 255, 0.08)',
  // The HUD's team text sits a little lighter than the crafts so it stays legible on a dark panel.
  coralText: 'hsl(12, 90%, 62%)',
  violetText: 'hsl(262, 78%, 70%)',
} as const;

export type PaletteColour = keyof typeof palette;

/** A palette colour as a CSS colour with `alpha`, for canvas gradients and masks. */
export function withAlpha(name: PaletteColour, alpha: number): string {
  const hex = new Color(palette[name]).getHex();
  return `rgba(${(hex >> 16) & 255}, ${(hex >> 8) & 255}, ${hex & 255}, ${alpha})`;
}

/** A grey level from 0 to 255, for data drawn on a canvas such as a roughness map. */
export function grey(level: number): string {
  return `rgb(${level}, ${level}, ${level})`;
}

/** Sets every palette colour as a CSS variable on `root`, `floorAlt` as `--floor-alt`. */
export function setCssColours(root: HTMLElement = document.documentElement): void {
  for (const [name, colour] of Object.entries(palette)) {
    root.style.setProperty(`--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, colour);
  }
}
