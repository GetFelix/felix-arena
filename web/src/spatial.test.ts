import { describe, expect, it } from 'vitest';
import { FAR_GAIN, place } from './spatial';

const reach = 6000;
const centre = { x: 0, z: 0, yaw: 0 };

describe('place', () => {
  it('leaves a sound with no place centred and at full level', () => {
    expect(place(centre, null, reach)).toEqual({ pan: 0, gain: 1 });
  });

  it('pans to the side of the screen the sound is on', () => {
    expect(place(centre, { x: 1500, z: 0 }, reach).pan).toBeGreaterThan(0.3);
    expect(place(centre, { x: -1500, z: 0 }, reach).pan).toBeLessThan(-0.3);
    expect(place(centre, { x: 0, z: 1500 }, reach).pan).toBeCloseTo(0);
  });

  it('follows the camera when it is turned', () => {
    // A quarter turn: the camera's right is now toward negative z.
    const turned = { ...centre, yaw: Math.PI / 2 };
    expect(place(turned, { x: 0, z: -1500 }, reach).pan).toBeGreaterThan(0.3);
    expect(place(turned, { x: 1500, z: 0 }, reach).pan).toBeCloseTo(0);
  });

  it('pans relative to the listener, not the arena', () => {
    const listener = { x: 2000, z: 0, yaw: 0 };
    expect(place(listener, { x: 2000, z: 800 }, reach).pan).toBeCloseTo(0);
    expect(place(listener, { x: 1000, z: 0 }, reach).pan).toBeLessThan(0);
  });

  it('gets quieter with distance, down to a floor, and never pans hard to one ear', () => {
    const near = place(centre, { x: 300, z: 0 }, reach).gain;
    const far = place(centre, { x: 5000, z: 0 }, reach).gain;
    expect(near).toBeGreaterThan(far);
    const beyond = place(centre, { x: 90000, z: 0 }, reach);
    expect(beyond.gain).toBeCloseTo(FAR_GAIN);
    expect(Math.abs(beyond.pan)).toBeLessThan(1);
  });
});
