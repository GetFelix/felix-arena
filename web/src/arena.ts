import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  type Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  type Scene,
  TorusGeometry,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { ArenaLayout, Obstacle } from './core';
import { materials } from './materials';
import type { ModelLibrary } from './models';
import { palette } from './palette';
import { floorTextures } from './textures';

/** A model placed in the scene. */
interface Prop {
  model: string;
  scale: number;
  rot?: number;
  y?: number;
}

/**
 * What stands on each of core's round obstacles after the centre crystal, in core's order: each prop on one side, then
 * its point-symmetric twin. Core decides where they are; this decides how they look.
 */
const ROUND_PROPS: Prop[] = [
  { model: 'structure_closed', scale: 2.0, rot: Math.PI / 4 },
  { model: 'structure_closed', scale: 2.0, rot: Math.PI / 4 },
  { model: 'barrels', scale: 2.6, rot: 0.6 },
  { model: 'barrels', scale: 2.6, rot: -0.6 },
  { model: 'machine_barrelLarge', scale: 2.2 },
  { model: 'machine_barrelLarge', scale: 2.2 },
  { model: 'machine_barrelLarge', scale: 1.7 },
  { model: 'machine_barrelLarge', scale: 1.7 },
  { model: 'rock_largeA', scale: 3.2, rot: 1.2 },
  { model: 'rock_largeA', scale: 3.2, rot: 1.2 },
  { model: 'rock_largeB', scale: 2.8, rot: 0.4 },
  { model: 'rock_largeB', scale: 2.8, rot: 0.4 },
  { model: 'machine_generator', scale: 2.4 },
  { model: 'machine_generator', scale: 2.4, rot: Math.PI },
  { model: 'turret_single', scale: 2.0, rot: 0.7 },
  { model: 'turret_single', scale: 2.0, rot: 0.7 + Math.PI },
];

/** Silhouettes outside the walls that fall away into the fog. They block nothing. */
const BACKDROP: (Prop & { x: number; z: number })[] = [
  { model: 'hangar_roundA', x: -12, z: -21, scale: 3.4, rot: 0.2 },
  { model: 'hangar_roundA', x: 14, z: 21.5, scale: 3.0, rot: Math.PI + 0.3 },
  { model: 'satelliteDish_large', x: 26, z: -10, scale: 5, rot: -0.8 },
  { model: 'satelliteDish_large', x: -26, z: 9, scale: 4.4, rot: 2.3 },
  { model: 'structure_closed', x: 25, z: 4, scale: 4, rot: 0.3, y: -0.6 },
  { model: 'structure_closed', x: -24.5, z: -5, scale: 3.2, rot: 0.8, y: -0.6 },
];

const WALL_THICKNESS = 0.9;
const WALL_HEIGHT = 1.9;
const COVER_HEIGHT = 1.0;
/** The floor outside the arena sits this far down, so the walls stand on a step. */
const OUTER_DROP = 0.6;

/** The parts of the arena that animate. */
export interface Arena {
  crystal: Group;
  crystalLight: PointLight;
}

/** Builds the arena from core's layout: floor, walls, cover, props and the centre crystal. */
export function buildArena(
  scene: Scene,
  layout: ArenaLayout,
  models: ModelLibrary,
  anisotropy: number,
): Arena {
  const { halfX, halfZ } = layout;
  const place = (p: Prop, x: number, z: number) => {
    const g = models.spawn(p.model, { scale: p.scale });
    g.position.set(x, p.y ?? 0, z);
    g.rotation.y = p.rot ?? 0;
    scene.add(g);
    return g;
  };

  const ft = floorTextures(halfX, halfZ, anisotropy);
  const floor = new Mesh(
    new PlaneGeometry(halfX * 2, halfZ * 2),
    new MeshStandardMaterial({
      ...ft,
      roughness: 0.75,
      metalness: 0.05,
      emissive: new Color(palette.white).multiplyScalar(1.6),
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const outer = new Mesh(
    new PlaneGeometry(240, 240),
    new MeshStandardMaterial({ color: palette.outerFloor, roughness: 0.95 }),
  );
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -OUTER_DROP;
  outer.receiveShadow = true;
  scene.add(outer);

  const T = WALL_THICKNESS;
  // Perimeter: rounded slabs so edges catch the key light, with a thin glowing strip on the inner top edge so the
  // light reads as trim, not a neon tube.
  const wall = (x: number, z: number, w: number, d: number) => {
    const h = WALL_HEIGHT;
    const m = new Mesh(new RoundedBoxGeometry(w, h, d, 3, 0.14), materials.wall);
    m.position.set(x, h / 2 - OUTER_DROP, z);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    const along = w > d;
    const s = new Mesh(new BoxGeometry(along ? w - 1.8 : 0.1, 0.05, along ? 0.1 : d - 0.2), materials.strip);
    s.position.set(
      along ? x : x - Math.sign(x) * (T / 2 - 0.12),
      h - OUTER_DROP + 0.01,
      along ? z - Math.sign(z) * (T / 2 - 0.12) : z,
    );
    scene.add(s);
  };
  wall(0, -halfZ - T / 2, halfX * 2 + T * 2, T);
  wall(0, halfZ + T / 2, halfX * 2 + T * 2, T);
  wall(-halfX - T / 2, 0, T, halfZ * 2);
  wall(halfX + T / 2, 0, T, halfZ * 2);

  const cover = ({ x, z, halfX: hx, halfZ: hz }: Extract<Obstacle, { kind: 'box' }>) => {
    const [w, d] = [hx * 2, hz * 2];
    const m = new Mesh(new RoundedBoxGeometry(w, COVER_HEIGHT, d, 3, 0.12), materials.wall);
    m.position.set(x, COVER_HEIGHT / 2, z);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    const s = new Mesh(new BoxGeometry(w - 0.3, 0.04, 0.08), materials.strip);
    s.position.set(x, COVER_HEIGHT + 0.005, z);
    if (d > w) {
      s.scale.set((d - 0.3) / (w - 0.3), 1, 1);
      s.rotation.y = Math.PI / 2;
    }
    scene.add(s);
  };

  const [centre, ...rest] = layout.obstacles;
  if (centre?.kind !== 'round') throw new Error('core has no centre obstacle');
  const rounds = rest.filter((o) => o.kind === 'round');
  if (rounds.length !== ROUND_PROPS.length) {
    throw new Error(`core has ${rounds.length} round obstacles besides the centre, the arena dresses ${ROUND_PROPS.length}`);
  }
  for (const o of rest) if (o.kind === 'box') cover(o);
  rounds.forEach((o, i) => place(ROUND_PROPS[i]!, o.x, o.z));

  // The centre landmark: a crystal on a plinth.
  const plinth = new Mesh(new CylinderGeometry(2.0, 2.3, 0.35, 32), materials.wall);
  plinth.position.set(centre.x, 0.17, centre.z);
  plinth.castShadow = plinth.receiveShadow = true;
  scene.add(plinth);
  const ring = new Mesh(new TorusGeometry(2.05, 0.035, 8, 64), materials.strip);
  ring.rotation.x = Math.PI / 2;
  ring.position.set(centre.x, 0.36, centre.z);
  scene.add(ring);
  const crystal = place({ model: 'rock_crystalsLargeA', scale: 3.0, y: 0.3 }, centre.x, centre.z);
  const crystalLight = new PointLight(palette.accentGlow, 9, 12, 2);
  crystalLight.position.set(centre.x, 2.2, centre.z);
  scene.add(crystalLight);

  for (const p of BACKDROP) place(p, p.x, p.z);
  return { crystal, crystalLight };
}
