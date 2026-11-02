import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { heatMax, loadCore } from './core';
import { BOT_PROFILES } from './bots';
import { drive } from './offline';

beforeAll(() => loadCore(readFileSync(new URL('./core/felix_arena_core_bg.wasm', import.meta.url))));

/** How many of `ticks` a bot facing one enemy holds fire in, with its blaster at `heat`. */
function firingTicks(heat: number, ticks: number): number {
  const me = { slot: 1, violet: false, x: 0, z: 0, rail: 0, heat };
  const enemy = { slot: 2, violet: true, alive: true, x: 800, z: 0 };
  const bot = { turn: 1, seq: 0 };
  let fired = 0;
  for (let i = 0; i < ticks; i++) {
    const buttons = drive(me, [enemy], bot, false, BOT_PROFILES.hard)[3]!;
    if (buttons & 1) fired++;
  }
  return fired;
}

describe('bots and blaster heat', () => {
  it('fires on a cool blaster and lets go of the trigger on a full one', () => {
    expect(firingTicks(0, 200)).toBeGreaterThan(20);
    expect(firingTicks(heatMax(), 200)).toBe(0);
  });
});
