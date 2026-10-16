import {
  AdditiveBlending,
  Group,
  type Material,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
  Sprite,
  SpriteMaterial,
  type Texture,
  Vector2,
} from 'three';
import { hdr, teamMaterial } from './materials';
import type { ModelLibrary } from './models';
import { palette } from './palette';

/** A craft in the scene, with the glow pool, contact shadow and engine light that follow it. */
export interface Craft {
  g: Group;
  pool: Mesh;
  blob: Mesh;
  engine: Sprite;
  color: string;
  home: Vector2;
  phase: number;
  /** The heading it faces, in radians about y; 0 faces +z. */
  aim: number;
}

/** The textures craft effects are drawn with. */
export interface CraftTextures {
  glow: Texture;
  blob: Texture;
}

const additive = { transparent: true, blending: AdditiveBlending, depthWrite: false } as const;

/** Builds one craft around `body`, with its glow pool, contact shadow and engine light. */
export function craft(
  scene: Object3D,
  fx: Object3D,
  tex: CraftTextures,
  body: Group,
  color: string,
  x: number,
  z: number,
  phase: number,
): Craft {
  const g = new Group();
  g.add(body);
  g.position.set(x, 0, z);
  scene.add(g);
  const pool = new Mesh(
    new PlaneGeometry(3.4, 3.4),
    new MeshBasicMaterial({ map: tex.glow, color: hdr(color, 0.28), ...additive }),
  );
  pool.rotation.x = -Math.PI / 2;
  const blob = new Mesh(
    new PlaneGeometry(3.0, 3.0),
    new MeshBasicMaterial({ map: tex.blob, transparent: true, depthWrite: false }),
  );
  blob.rotation.x = -Math.PI / 2;
  fx.add(pool, blob);
  const engine = new Sprite(
    new SpriteMaterial({ map: tex.glow, color: hdr(color, 3), blending: AdditiveBlending, depthWrite: false }),
  );
  engine.scale.setScalar(0.9);
  fx.add(engine);
  return { g, pool, blob, engine, color, home: new Vector2(x, z), phase, aim: 0 };
}

/** The style frame's two-a-side skirmish. Each craft aims at the one in {@link TARGETS}. */
export type CraftName = 'rook' | 'ash' | 'vex' | 'mara';
export const TARGETS: Record<CraftName, CraftName> = { rook: 'vex', ash: 'mara', vex: 'rook', mara: 'ash' };

/** Spawns the four crafts. `random` sets each one's bob phase, drawn in the order rook, ash, vex, mara. */
export function spawnCrafts(
  scene: Object3D,
  fx: Object3D,
  models: ModelLibrary,
  tex: CraftTextures,
  random: () => number,
): Record<CraftName, Craft> {
  const coral = teamMaterial(palette.coral);
  const violet = teamMaterial(palette.violet);
  const make = (model: string, color: string, accent: Material, x: number, z: number, scale: number) =>
    craft(scene, fx, tex, models.spawn(model, { scale, accent }), color, x, z, random() * 6);
  return {
    rook: make('craft_speederA', palette.coral, coral, -10.5, 3.0, 1.3),
    ash: make('craft_racer', palette.coral, coral, -4.5, -7.0, 1.5),
    vex: make('craft_speederB', palette.violet, violet, 6.5, -1.0, 1.3),
    mara: make('craft_speederD', palette.violet, violet, 10.5, 6.5, 1.1),
  };
}

/** Moves the crafts to time `t`: a slow drift about home, a bob, and each one facing its target. */
export function updateCrafts(crafts: Record<CraftName, Craft>, t: number): void {
  for (const p of Object.values(crafts)) {
    const x = p.home.x + Math.sin(t * 0.55 + p.phase) * 0.9;
    const z = p.home.y + Math.cos(t * 0.43 + p.phase * 1.3) * 0.7;
    const y = 0.42 + Math.sin(t * 2.1 + p.phase) * 0.06;
    p.g.position.set(x, y, z);
  }
  for (const [name, p] of Object.entries(crafts) as [CraftName, Craft][]) {
    const q = crafts[TARGETS[name]].g.position;
    p.aim = Math.atan2(q.x - p.g.position.x, q.z - p.g.position.z);
    p.g.rotation.y = p.aim;
    p.g.rotation.z = Math.sin(t * 1.3 + p.phase) * 0.04;
    p.pool.position.set(p.g.position.x, 0.02, p.g.position.z);
    p.blob.position.set(p.g.position.x, 0.015, p.g.position.z);
    p.engine.position.set(
      p.g.position.x - Math.sin(p.aim) * 1.1,
      p.g.position.y + 0.35,
      p.g.position.z - Math.cos(p.aim) * 1.1,
    );
    p.engine.material.opacity = 0.75 + Math.sin(t * 30 + p.phase) * 0.1;
  }
}
