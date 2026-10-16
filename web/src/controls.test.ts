import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { framing, placeCamera } from './camera';
import { headingTo, stick } from './controls';
import { GUN_HEIGHT } from './fleet';

function playCamera(width: number, height: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(30, width / height, 1, 200);
  const { radius, yaw } = framing(camera.aspect, camera.fov, true);
  placeCamera(camera, radius, yaw);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

/** Where `p` is on a `width` by `height` screen, in pixels with y down. */
function pixel(p: Vector3, camera: PerspectiveCamera, width: number, height: number): [number, number] {
  const q = p.clone().project(camera);
  return [((q.x + 1) / 2) * width, ((1 - q.y) / 2) * height];
}

const KEYS: [string, number, number, number][] = [
  // key, forward, right, the screen angle it must move along: 0 is right, 90 is up.
  ['W', 1, 0, 90],
  ['A', 0, -1, 180],
  ['S', -1, 0, 270],
  ['D', 0, 1, 0],
];

describe('controls', () => {
  it.each([
    ['landscape', 1920, 1080],
    ['portrait', 1080, 1920],
  ])('moves each key straight along the screen in %s', (_, width, height) => {
    const camera = playCamera(width, height);
    const spots = [
      [0, 0],
      [-20, -14],
      [20, -14],
      [-20, 14],
      [20, 14],
      [-10, 6],
      [9, -11],
    ];
    for (const [x, z] of spots) {
      for (const [key, forward, right, angle] of KEYS) {
        const [mx, mz] = stick(forward, right, camera, x!, z!);
        const from = new Vector3(x, GUN_HEIGHT, z);
        const step = new Vector3(mx / 127, 0, mz / 127).multiplyScalar(0.05).add(from);
        const [ax, ay] = pixel(from, camera, width, height);
        const [bx, by] = pixel(step, camera, width, height);
        const moved = (Math.atan2(ay - by, bx - ax) * 180) / Math.PI;
        const off = Math.abs(((moved - angle + 540) % 360) - 180);
        expect(off, `${key} at (${x}, ${z}) moves at ${moved.toFixed(2)} degrees`).toBeLessThan(2);
      }
    }
  });

  it('sits square to the arena in play, so up the screen is straight across it', () => {
    const up = (width: number, height: number) => stick(1, 0, playCamera(width, height), 0, 0).map((v) => v + 0);
    expect(up(1920, 1080)).toEqual([0, -127]);
    expect(up(1080, 1920)).toEqual([-127, 0]);
  });

  it('stays still with no key held', () => {
    expect(stick(0, 0, playCamera(1920, 1080), 3, 4)).toEqual([0, 0]);
  });

  it('aims with core’s headings: 0 is +x, a quarter turn +z', () => {
    expect(headingTo(0, 0, 100, 0)).toBe(0);
    expect(headingTo(0, 0, 0, 100)).toBe(16384);
    expect(headingTo(0, 0, -100, 0)).toBe(32768);
    expect(headingTo(0, 0, 0, -100)).toBe(49152);
  });
});
