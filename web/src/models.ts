import { Box3, Group, type Material, type Mesh, type Object3D, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { materials } from './materials';

// Kenney's Space Kit names its materials consistently, so restyling is a lookup. `metalRed` is the accent slot:
// a prop's steel by default, a team colour on a craft.
const RESTYLE = new Map<string, Material>([
  ['metal', materials.hull],
  ['metalDark', materials.hullDark],
  ['_defaultMat', materials.hullDark],
  ['dark', materials.trim],
  ['metalRed', materials.accent],
  ['rock', materials.rock],
  ['rockTrack', materials.rock],
  ['crystal', materials.crystal],
]);

/** How to place one copy of a model. */
export interface SpawnOptions {
  /** Uniform scale. Kenney models are about one metre across. */
  scale?: number;
  /** Replaces the accent slot (`metalRed`), for example with a team material. */
  accent?: Material;
}

/**
 * Restyles a loaded model in place and wraps it so its origin is the centre of its footprint at floor level.
 * Throws if a material has no palette mapping, so a model that would show its own colours never loads.
 */
export function prepareModel(name: string, scene: Object3D): Group {
  scene.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const swap = (m: Material): Material => {
      const to = RESTYLE.get(m.name);
      if (!to) throw new Error(`model ${name}: material "${m.name}" has no palette mapping`);
      return to;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
  const box = new Box3().setFromObject(scene);
  const centre = box.getCenter(new Vector3());
  scene.position.sub(new Vector3(centre.x, box.min.y, centre.z));
  const root = new Group();
  root.name = name;
  root.add(scene);
  return root;
}

/** Every model, restyled and normalised once, handed out as cheap clones that share geometry and materials. */
export class ModelLibrary {
  private readonly templates: ReadonlyMap<string, Group>;

  private constructor(templates: ReadonlyMap<string, Group>) {
    this.templates = templates;
  }

  /** Loads and prepares every model in `urls`, keyed by model name. */
  static async load(urls: Readonly<Record<string, string>>, loader = new GLTFLoader()): Promise<ModelLibrary> {
    const entries = await Promise.all(
      Object.entries(urls).map(async ([name, url]) => {
        const gltf = await loader.loadAsync(url);
        return [name, prepareModel(name, gltf.scene)] as const;
      }),
    );
    return new ModelLibrary(new Map(entries));
  }

  /** Builds a library from models that are already prepared. */
  static of(templates: Iterable<Group>): ModelLibrary {
    return new ModelLibrary(new Map([...templates].map((t) => [t.name, t])));
  }

  get names(): string[] {
    return [...this.templates.keys()];
  }

  /** A new copy of `name`, at the origin. Throws for a model that was not loaded. */
  spawn(name: string, { scale = 1, accent }: SpawnOptions = {}): Group {
    const template = this.templates.get(name);
    if (!template) throw new Error(`model ${name} is not loaded`);
    const copy = template.clone(true);
    copy.scale.setScalar(scale);
    if (accent) {
      copy.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        const swap = (m: Material) => (m === materials.accent ? accent : m);
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
      });
    }
    return copy;
  }
}
