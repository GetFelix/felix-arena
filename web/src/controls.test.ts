import { describe, expect, it } from 'vitest';
import { headingTo, stick } from './controls';

describe('controls', () => {
  it('moves relative to the screen', () => {
    // A camera looking toward -z: up the screen is -z, right is +x.
    expect(stick(1, 0, 0, -1)).toEqual([0, -127]);
    expect(stick(0, 1, 0, -1)).toEqual([127, 0]);
    expect(stick(0, 0, 0, -1)).toEqual([0, 0]);
    const [x, z] = stick(1, 1, 0, -1);
    expect([x, z]).toEqual([90, -90]);
  });

  it('aims with core’s headings: 0 is +x, a quarter turn +z', () => {
    expect(headingTo(0, 0, 100, 0)).toBe(0);
    expect(headingTo(0, 0, 0, 100)).toBe(16384);
    expect(headingTo(0, 0, -100, 0)).toBe(32768);
    expect(headingTo(0, 0, 0, -100)).toBe(49152);
  });
});
