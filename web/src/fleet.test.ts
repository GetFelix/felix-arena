import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Group, type Mesh, type Object3D, Texture, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { type Craft, type CraftName, spawnCrafts, TARGETS, updateCrafts } from './crafts';
import { Fleet } from './fleet';
import { ModelLibrary, prepareModel } from './models';
import { seeded } from './random';

const CRAFTS = ['craft_speederA', 'craft_speederB', 'craft_racer', 'craft_speederD'];

async function library(): Promise<ModelLibrary> {
  const models = await Promise.all(
    CRAFTS.map(async (name) => {
      const file = fileURLToPath(new URL(`../../prototype/assets/models/space-kit/${name}.glb`, import.meta.url));
      const buf = readFileSync(file);
      const gltf = await new GLTFLoader().parseAsync(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        '',
      );
      return prepareModel(name, gltf.scene);
    }),
  );
  return ModelLibrary.of(models);
}

/**
 * How wide a craft is across `(dx, dz)` at its front end over its back end. A Kenney craft tapers to a narrow nose
 * and is widest across its engines and wings, so a craft facing `(dx, dz)` has a ratio well under 1.
 */
function taper(craft: Object3D, dx: number, dz: number): number {
  craft.updateMatrixWorld(true);
  const points: Vector3[] = [];
  craft.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const position = mesh.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      points.push(new Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
    }
  });
  const length = Math.hypot(dx, dz);
  const [ux, uz] = [dx / length, dz / length];
  const along = points.map((p) => p.x * ux + p.z * uz);
  const across = points.map((p) => p.z * ux - p.x * uz);
  const [lo, hi] = [Math.min(...along), Math.max(...along)];
  const end = 0.15 * (hi - lo);
  const width = (keep: (a: number) => boolean) => {
    const xs = across.filter((_, i) => keep(along[i]!));
    return Math.max(...xs) - Math.min(...xs);
  };
  return width((a) => a > hi - end) / width((a) => a < lo + end);
}

describe('craft facing', () => {
  it('points every craft’s nose along its aim in a match', async () => {
    const scene = new Group();
    const fleet = new Fleet(scene, new Group(), await library(), { glow: new Texture(), blob: new Texture() });
    for (const heading of [0, 9000, 16384, 30000, 47000, 60000]) {
      const views = CRAFTS.map((_, slot) => ({
        slot,
        violet: slot % 2 === 1,
        alive: true,
        x: slot * 500 - 700,
        z: 300,
        heading,
      }));
      fleet.update(views, 0);
      const angle = (heading / 65536) * 2 * Math.PI;
      for (const [slot, name] of CRAFTS.entries()) {
        const ratio = taper(fleet.get(slot)!.g, Math.cos(angle), Math.sin(angle));
        expect(ratio, `${name} at heading ${heading}`).toBeLessThan(0.6);
      }
    }
  });

  it('points every style frame craft’s nose at its target', async () => {
    const tex = { glow: new Texture(), blob: new Texture() };
    const crafts = spawnCrafts(new Group(), new Group(), await library(), tex, seeded(1));
    for (const t of [0.4, 1.2, 5]) {
      updateCrafts(crafts, t);
      for (const [name, craft] of Object.entries(crafts) as [CraftName, Craft][]) {
        const target = crafts[TARGETS[name]].g.position;
        const ratio = taper(craft.g, target.x - craft.g.position.x, target.z - craft.g.position.z);
        expect(ratio, `${name} at t=${t}`).toBeLessThan(0.6);
      }
    }
  });
});
