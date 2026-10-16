import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Box3, type Material, type Mesh, MeshStandardMaterial, type Object3D, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { modelUrls } from './assets';
import { materials, teamMaterial } from './materials';
import { ModelLibrary, prepareModel } from './models';
import { palette } from './palette';

const MODELS = fileURLToPath(new URL('../../prototype/assets/models', import.meta.url));
const files = readdirSync(MODELS, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.glb'))
  .map((f) => join(MODELS, f));

async function parse(file: string): Promise<Object3D> {
  const buf = readFileSync(file);
  const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  return gltf.scene;
}

function meshMaterials(root: Object3D): Material[] {
  const out: Material[] = [];
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (mesh.isMesh) out.push(...(Array.isArray(mesh.material) ? mesh.material : [mesh.material]));
  });
  return out;
}

const shared = new Set<Material>(Object.values(materials));

describe('model pipeline', () => {
  it('finds every model file', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(Object.keys(modelUrls).sort()).toEqual(files.map((f) => basename(f, '.glb')).sort());
  });

  it.each(files.map((f) => [basename(f, '.glb'), f]))('restyles and normalises %s', async (name, file) => {
    const model = prepareModel(name, await parse(file));
    const used = meshMaterials(model);
    expect(used.length).toBeGreaterThan(0);
    for (const m of used) expect(shared.has(m), `${name} kept material "${m.name}"`).toBe(true);

    const box = new Box3().setFromObject(model);
    const centre = box.getCenter(new Vector3());
    expect(box.min.y).toBeCloseTo(0, 5);
    expect(centre.x).toBeCloseTo(0, 5);
    expect(centre.z).toBeCloseTo(0, 5);
  });

  it('swaps the accent slot on a copy and leaves the template alone', async () => {
    const lib = ModelLibrary.of([
      prepareModel('craft_speederA', await parse(files.find((f) => f.includes('craft_speederA'))!)),
    ]);
    const coral = teamMaterial(palette.coral);
    const craft = lib.spawn('craft_speederA', { scale: 1.3, accent: coral });
    expect(craft.scale.x).toBe(1.3);
    expect(meshMaterials(craft)).toContain(coral);
    expect(meshMaterials(craft)).not.toContain(materials.accent);
    expect(meshMaterials(lib.spawn('craft_speederA'))).toContain(materials.accent);
  });

  it('rejects a model with an unmapped material', async () => {
    const scene = await parse(files[0]!);
    scene.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) mesh.material = new MeshStandardMaterial({ name: 'orangePaint' });
    });
    expect(() => prepareModel('odd', scene)).toThrow(/orangePaint/);
  });
});
