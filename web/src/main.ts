// The arena page. `?t=1.2` freezes the scene at that time, for screenshots that can be compared frame for frame, and
// `?quality=` picks a tier; a frozen moment is drawn at High unless asked, so it stays comparable.
import { Clock, Color, Fog, Group, Scene } from 'three';
import { buildArena } from './arena';
import { hdriUrl, modelUrls } from './assets';
import { ArenaCamera } from './camera';
import { Combat } from './combat';
import { spawnCrafts, updateCrafts } from './crafts';
import { arenaLayout, loadCore } from './core';
import { addLights, loadEnvironment } from './lighting';
import { ModelLibrary } from './models';
import { palette, setCssColours } from './palette';
import { seeded } from './random';
import { requestedTier, TierChooser } from './quality';
import { createRenderer, Pipeline } from './renderer';
import { blobTexture, flareTexture, glowTexture } from './textures';

async function main(): Promise<void> {
  setCssColours();
  const params = new URLSearchParams(location.search);
  const param = params.get('t');
  const frozen = param === null ? null : parseFloat(param);

  const renderer = createRenderer();
  document.body.prepend(renderer.domElement);
  const scene = new Scene();
  scene.background = new Color(palette.void);
  const fog = new Fog(palette.void, 42, 90);
  scene.fog = fog;
  const view = new ArenaCamera(renderer.domElement, fog);
  const key = addLights(scene);
  const fx = new Group();
  scene.add(fx);

  const [models] = await Promise.all([
    ModelLibrary.load(modelUrls),
    loadEnvironment(renderer, scene, hdriUrl),
    loadCore(),
  ]);

  const arena = buildArena(scene, arenaLayout(), models, renderer.capabilities.getMaxAnisotropy());
  const glow = glowTexture();
  const random = seeded(1);
  const crafts = spawnCrafts(scene, fx, models, { glow, blob: blobTexture() }, random);
  const combat = new Combat(scene, fx, { glow, flare: flareTexture() }, crafts, random);
  const asked = frozen === null || params.has('quality') ? requestedTier(params) : 'high';
  const pipeline = new Pipeline(renderer, scene, view.camera, fx, key, asked ?? 'high');
  const chooser = asked ? null : new TierChooser('high', (tier) => pipeline.setTier(tier));

  addEventListener('resize', () => {
    view.fit();
    pipeline.setSize(innerWidth, innerHeight);
  });
  document.getElementById('loading')?.remove();

  const clock = new Clock();
  renderer.setAnimationLoop((now: number) => {
    chooser?.frame(now);
    const t = frozen ?? clock.getElapsedTime();
    updateCrafts(crafts, t);
    combat.update(t);
    arena.crystal.rotation.y = t * 0.2;
    arena.crystalLight.intensity = 9 + Math.sin(t * 1.7) * 1.5;
    view.update(t);
    pipeline.render(t);
  });
}

main().catch((error: unknown) => {
  const loading = document.getElementById('loading');
  if (loading) loading.textContent = `The arena did not load: ${String(error)}`;
  throw error;
});
