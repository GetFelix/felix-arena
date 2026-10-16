// The crafts of a live match, one per slot, placed from ticks each frame.
import type { Object3D } from 'three';
import { craft, type Craft, type CraftTextures } from './crafts';
import { teamMaterial } from './materials';
import type { ModelLibrary } from './models';
import { palette } from './palette';

/** The model each slot flies, and its scale: the style frame's four crafts, in turn. */
const MODELS: [string, number][] = [
  ['craft_speederA', 1.3],
  ['craft_speederB', 1.3],
  ['craft_racer', 1.5],
  ['craft_speederD', 1.1],
];

/** A craft to draw: centimetres, and a heading in 65536ths of a turn. */
export interface CraftView {
  slot: number;
  violet: boolean;
  alive: boolean;
  x: number;
  z: number;
  heading: number;
}

/** The scene's angle about y for a heading: a heading turns from +x toward +z, a model faces +z at angle 0. */
export function yaw(heading: number): number {
  return Math.PI / 2 - (heading / 65536) * 2 * Math.PI;
}

interface Flown {
  craft: Craft;
  violet: boolean;
}

/** Every craft in the match. */
export class Fleet {
  private readonly flown = new Map<number, Flown>();
  private readonly coral = teamMaterial(palette.coral);
  private readonly violet = teamMaterial(palette.violet);

  constructor(
    private readonly scene: Object3D,
    private readonly fx: Object3D,
    private readonly models: ModelLibrary,
    private readonly tex: CraftTextures,
  ) {}

  /** The craft in `slot`, while it is drawn. */
  get(slot: number): Craft | undefined {
    const f = this.flown.get(slot);
    return f?.craft.g.visible ? f.craft : undefined;
  }

  /** Places every craft in `views` at time `t` in seconds, and hides the rest. */
  update(views: CraftView[], t: number): void {
    const seen = new Set<number>();
    for (const view of views) {
      seen.add(view.slot);
      const p = this.craftFor(view);
      const parts = [p.g, p.pool, p.blob, p.engine];
      for (const part of parts) part.visible = view.alive;
      if (!view.alive) continue;
      const [x, z] = [view.x / 100, view.z / 100];
      p.aim = yaw(view.heading);
      p.g.position.set(x, 0.42 + Math.sin(t * 2.1 + p.phase) * 0.06, z);
      p.g.rotation.set(0, p.aim, Math.sin(t * 1.3 + p.phase) * 0.04);
      p.pool.position.set(x, 0.02, z);
      p.blob.position.set(x, 0.015, z);
      p.engine.position.set(x - Math.sin(p.aim) * 1.1, p.g.position.y + 0.35, z - Math.cos(p.aim) * 1.1);
      p.engine.material.opacity = 0.75 + Math.sin(t * 30 + p.phase) * 0.1;
    }
    for (const [slot, f] of this.flown) {
      if (seen.has(slot)) continue;
      for (const part of [f.craft.g, f.craft.pool, f.craft.blob, f.craft.engine]) part.visible = false;
    }
  }

  private craftFor(view: CraftView): Craft {
    const had = this.flown.get(view.slot);
    if (had && had.violet === view.violet) return had.craft;
    // A slot changes team only between matches; build it again in the new colours.
    if (had)
      for (const part of [had.craft.g, had.craft.pool, had.craft.blob, had.craft.engine]) part.removeFromParent();
    const [model, scale] = MODELS[view.slot % MODELS.length]!;
    const body = this.models.spawn(model, { scale, accent: view.violet ? this.violet : this.coral });
    const colour = view.violet ? palette.violet : palette.coral;
    const made = craft(this.scene, this.fx, this.tex, body, colour, view.x / 100, view.z / 100, view.slot * 1.7);
    this.flown.set(view.slot, { craft: made, violet: view.violet });
    return made;
  }
}
