// The effects kit under its budget load: 40 bolts and 8 hits on screen, with muzzle flashes and the three lights.
// `scripts/fx-bench.mjs` drives it through `window.fxBench`; on its own the page just plays the scene.
import { Color, Fog, Group, PerspectiveCamera, Scene } from 'three';
import { Effects } from './effects';
import { addLights } from './lighting';
import { palette, setCssColours } from './palette';
import { seeded } from './random';
import { createRenderer } from './renderer';
import { flareTexture, glowTexture } from './textures';

const BOLTS = 40;
/** 8 hits every 54 frames, a hit's 0.9 s at 60 frames a second, keeps 8 on screen. */
const HITS_PER = [8, 54] as const;
const FRAMES = 4096;
// Frame times boxed once up front, in an array of mixed elements so they stay boxed: passing a freshly computed
// float to a function boxes it, and the allocation check would count the harness's own boxes.
const times: unknown[] = [''];
for (let i = 0; i < FRAMES; i++) times.push(i / 60);

/** What the page exposes to the benchmark script. */
export interface FxBench {
  /** Draws `frames` frames, one per animation frame, and returns each one's milliseconds. */
  run(frames: number): Promise<{ update: number[]; render: number[] }>;
  /** Updates the effects for `frames` frames without drawing, for the allocation check. */
  step(frames: number): void;
}

declare global {
  interface Window {
    fxBench?: FxBench;
  }
}

setCssColours();
const renderer = createRenderer();
document.body.prepend(renderer.domElement);
const scene = new Scene();
scene.background = new Color(palette.void);
scene.fog = new Fog(palette.void, 42, 90);
addLights(scene);
const fx = new Group();
scene.add(fx);
const camera = new PerspectiveCamera(30, innerWidth / innerHeight, 1, 200);
camera.position.set(0, 52, 36);
camera.lookAt(0, 0, 0);
const effects = new Effects(scene, fx, { glow: glowTexture(), flare: flareTexture() }, seeded(1));

let frame = 0;

/** One frame of the scene, on a fixed clock so every run is the same. */
function update(): void {
  const n = frame++ % FRAMES;
  const t = times[n + 1] as number;
  for (let i = 0; i < BOLTS; i++) {
    const violet = i >= BOLTS / 2;
    // Centimetres, as the sim reports them, in ten lanes; violet flies the other way. `0 - along` rather than
    // `-along`, which is -0 at zero: not a small integer, so it would be boxed.
    const along = ((n * 50 + i * 700) % 6000) - 3000;
    effects.bolt(violet, violet ? 0 - along : along, ((i % 10) - 5) * 300, violet ? 32768 : 0);
  }
  const k = Math.floor((n * HITS_PER[0]) / HITS_PER[1]);
  if (n === 0 || k !== Math.floor(((n - 1) * HITS_PER[0]) / HITS_PER[1])) {
    const x = ((k * 7) % 24) * 100 - 1200;
    const z = ((k * 5) % 16) * 100 - 800;
    effects.hit(k % 2 === 1, x, z, t);
    effects.fired(k % 2 === 0, 0 - x, 0 - z, t);
  }
  // A rail and a kill every second, so their paths are measured too.
  if (n % 60 === 0) {
    effects.railed(true, 1500, 600, -900, -300, t);
    effects.destroyed(false, -900, -300, t);
  }
  effects.update(t);
}

window.fxBench = {
  run(frames) {
    const result = { update: [] as number[], render: [] as number[] };
    return new Promise((resolve) => {
      const tick = () => {
        const start = performance.now();
        update();
        const updated = performance.now();
        renderer.render(scene, camera);
        result.update.push(updated - start);
        result.render.push(performance.now() - updated);
        if (result.update.length < frames) requestAnimationFrame(tick);
        else resolve(result);
      };
      requestAnimationFrame(tick);
    });
  },
  step(frames) {
    for (let i = 0; i < frames; i++) update();
  },
};
