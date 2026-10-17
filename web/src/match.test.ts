import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeTick, loadCore, World } from './core';
import { callsign, clock, Match } from './match';

beforeAll(() => loadCore(readFileSync(new URL('./core/felix_arena_core_bg.wasm', import.meta.url))));

describe('the match as the HUD shows it', () => {
  it('follows the sim from warmup through play and results to the next warmup', () => {
    const world = World.withRules(30, 60, 30, 25, 900);
    world.join('ana');
    const match = new Match();
    const phases: string[] = [];
    const step = (n: number) => {
      for (let i = 0; i < n; i++) {
        world.step(new Int32Array(48));
        const tick = decodeTick(world.record());
        match.update(tick, i);
        tick.free();
        const phase = `${match.number}:${match.phase}${match.waiting ? ' waiting' : ''}`;
        if (phases.at(-1) !== phase) phases.push(phase);
      }
    };
    step(40);
    world.join('ben');
    step(130);
    expect(phases).toEqual(['0:warmup', '0:warmup waiting', '0:warmup', '0:playing', '0:results', '1:warmup']);
    expect(match.standings().map((s) => s.slot)).toEqual([0, 1]);
    expect(match.seconds).toBe(1);
  });

  it('names slots and formats the clock', () => {
    expect([0, 1, 2, 3].map(callsign)).toEqual(['Rook', 'Vex', 'Ash', 'Mara']);
    expect(clock(300)).toBe('5:00');
    expect(clock(61)).toBe('1:01');
  });

  it('keeps the kills of the last five matches, and an earlier one loaded on request', () => {
    const match = new Match();
    const kill = (n: number, offset: number) => ({
      killer: 1,
      victim: 2,
      atMs: 0,
      rail: false,
      matchNumber: n,
      seconds: 10,
      replay: { matchNumber: n, tick: offset, offset, replayFrom: offset - 90, victim: 2, killer: 1, epoch: 0 },
    });
    for (let n = 3; n <= 8; n++) match.remember(n, [kill(n, n * 1000), kill(n, n * 1000)]);
    expect(match.replays().map(([n]) => n)).toEqual([8, 7, 6, 5, 4]);
    expect(match.replays()[0]![1]).toHaveLength(1);
    match.remember(2, [kill(2, 2000)]);
    expect(match.replays().map(([n]) => n)).toEqual([8, 7, 6, 5, 2]);
  });
});
