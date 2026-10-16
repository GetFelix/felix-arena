import { Color, type ColorRepresentation, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import { palette } from './palette';

/** A palette colour scaled past 1, so it blooms. */
export function hdr(color: ColorRepresentation, k: number): Color {
  return new Color(color).multiplyScalar(k);
}

/** The shared scene materials. Models are restyled onto these, so one change here restyles every model. */
export const materials = {
  hull: new MeshStandardMaterial({ color: palette.hull, roughness: 0.42, metalness: 0.25 }),
  hullDark: new MeshStandardMaterial({ color: palette.hullDark, roughness: 0.5, metalness: 0.35 }),
  trim: new MeshStandardMaterial({ color: palette.trim, roughness: 0.65, metalness: 0.2 }),
  // Props keep Kenney's accent faces but in a quiet steel, so cyan stays rare.
  accent: new MeshStandardMaterial({ color: palette.prop, roughness: 0.45, metalness: 0.3 }),
  rock: new MeshStandardMaterial({ color: palette.rock, roughness: 0.85, metalness: 0, flatShading: true }),
  crystal: new MeshStandardMaterial({
    color: palette.accentGlow,
    roughness: 0.2,
    metalness: 0,
    emissive: palette.accentGlow,
    emissiveIntensity: 2.2,
  }),
  wall: new MeshStandardMaterial({ color: palette.wall, roughness: 0.6, metalness: 0.15 }),
  strip: new MeshBasicMaterial({ color: hdr(palette.accentGlow, 1.25) }),
};

/** A craft's team colour, with a faint glow so it reads in shadow. */
export function teamMaterial(color: ColorRepresentation): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    roughness: 0.32,
    metalness: 0.15,
    emissive: color,
    emissiveIntensity: 0.12,
  });
}
