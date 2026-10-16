import { DirectionalLight, HemisphereLight, PMREMGenerator, type Scene, type WebGLRenderer } from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { palette } from './palette';

/**
 * One warm key that casts every shadow, a cool sky fill, and a cyan rim from behind so silhouettes separate from the
 * dark floor. Returns the key light, whose shadow map the quality tier sizes.
 */
export function addLights(scene: Scene): DirectionalLight {
  scene.add(new HemisphereLight(palette.skyFill, palette.groundFill, 0.32));
  const key = new DirectionalLight(palette.keyLight, 3.6);
  key.position.set(-16, 30, 14);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  // The shadow camera covers the arena and the walls, and no more, so the 2048 map stays sharp.
  Object.assign(key.shadow.camera, { left: -27, right: 27, top: 22, bottom: -22, near: 5, far: 80 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  scene.add(key);
  const rim = new DirectionalLight(palette.accentGlow, 0.9);
  rim.position.set(18, 10, -22);
  scene.add(rim);
  return key;
}

/** Loads the studio HDRI at `url` as the scene's environment, for soft reflections. */
export async function loadEnvironment(renderer: WebGLRenderer, scene: Scene, url: string): Promise<void> {
  const equirect = await new RGBELoader().loadAsync(url);
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(equirect).texture;
  scene.environmentIntensity = 0.38;
  equirect.dispose();
  pmrem.dispose();
}
