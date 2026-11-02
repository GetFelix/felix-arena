import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeTick, loadCore, World } from './core';
import type { EventFrame, StateValue, Subscribed } from './gateway';
import { isCatchUp, joinFromKeyframe, RESUME_TICKS } from './join';
import { Match } from './match';
import { drive } from './offline';

beforeAll(() => loadCore(readFileSync(new URL('./core/felix_arena_core_bg.wasm', import.meta.url))));

/** A match of four bots, as tick records in order. */
function records(ticks: number): Uint8Array[] {
  const world = World.withRules(30, 3000, 60, 25, 300);
  for (const name of ['a', 'b', 'c', 'd']) world.join(name);
  const bots = [0, 1, 2, 3].map((i) => ({ turn: i % 2 ? 1 : -1, seq: 0 }));
  const out: Uint8Array[] = [];
  let tick = decodeTick(world.record());
  for (let n = 0; n < ticks; n++) {
    const crafts = tick.crafts.map((c) => ({
      slot: c.slot,
      violet: c.violet,
      alive: c.alive,
      x: c.x,
      z: c.z,
      rail: c.rail,
    }));
    const railThere = tick.railIn === 0;
    tick.free();
    const controls = new Int32Array(48);
    bots.forEach((bot, i) => {
      const me = crafts.find((c) => c.slot === i);
      if (me?.alive) controls.set([1, ++bot.seq & 0xffff, ...drive(me, crafts, bot, railThere)], 6 * i);
    });
    world.step(controls);
    const record = world.record();
    out.push(record);
    tick = decodeTick(record);
  }
  tick.free();
  return out;
}

describe('joining from a keyframe', () => {
  it('folds to the same state as a client that saw every tick', () => {
    const log = records(1500);
    const all = new Match();
    const digests = log.map((record) => {
      const tick = decodeTick(record);
      all.update(tick, 0);
      tick.free();
      return all.digest();
    });
    expect(all.standings().some((s) => s.kills > 0)).toBe(true);
    const keyframes = log.flatMap((record, i) => {
      const tick = decodeTick(record);
      const keyframe = tick.keyframe;
      tick.free();
      return keyframe ? [i] : [];
    });
    expect(keyframes.length).toBeGreaterThan(10);
    for (const from of keyframes) {
      const joined = new Match();
      for (let i = from; i < log.length; i++) {
        const tick = decodeTick(log[i]!);
        joined.update(tick, 0, false);
        tick.free();
        expect(joined.digest(), `joined at ${from}, tick ${i}`).toBe(digests[i]);
      }
    }
  });

  it('subscribes from the keyframe and marks what was already in the log as catch-up', async () => {
    const frame = (offset: number) => ({ offset }) as EventFrame;
    const seen: [number | null, boolean][] = [];
    let from: number | 'live' | undefined;
    const gateway = {
      stateGet: async (): Promise<StateValue> => ({ payload: new Uint8Array(12), version: 40, asOf: 45 }),
      subscribe: async (_s: string, _slot: string, start: number | 'live', onEvent: (f: EventFrame) => void) => {
        from = start;
        onEvent(frame(40));
        return { sub: 1, startOffset: 40, liveOffset: 46 } satisfies Subscribed;
      },
    };
    const times = await joinFromKeyframe(gateway, (f, catchUp) => seen.push([f.offset, catchUp]));
    expect([from, times.keyframe]).toEqual([40, 40]);
    expect(seen).toEqual([[40, true]]);
    expect([44, 45, 46].map((offset) => isCatchUp(offset, 46))).toEqual([true, false, false]);
    expect(isCatchUp(10, null)).toBe(false);
  });

  it('reads on from where a page got to when that is close to the keyframe, and from the keyframe otherwise', async () => {
    const from = async (keyframe: number | null, resumeAfter: number | null) => {
      let start: number | 'live' | undefined;
      await joinFromKeyframe(
        {
          stateGet: async () => ({ payload: null, version: keyframe, asOf: keyframe }),
          subscribe: async (_s, _slot, at) => {
            start = at;
            return { sub: 1, startOffset: 0, liveOffset: 0 };
          },
        },
        () => {},
        resumeAfter,
      );
      return start;
    };
    expect(await from(600, 590)).toBe(591);
    expect(await from(600, 600 - RESUME_TICKS)).toBe(600 - RESUME_TICKS + 1);
    expect(await from(600, 600 - RESUME_TICKS - 1)).toBe(600);
    expect(await from(600, 610)).toBe(600);
    expect(await from(600, null)).toBe(600);
    expect(await from(null, 590)).toBe('live');
  });

  it('keeps the kills between where a page got to and the keyframe it would otherwise jump to', () => {
    const log = records(1500);
    const all = new Match();
    const killOffsets = (m: Match) => m.replays().flatMap(([, kills]) => kills.map((k) => k.replay?.offset));
    log.forEach((record, i) => {
      const tick = decodeTick(record);
      all.update(tick, 0, false, i, () => 0);
      tick.free();
    });
    const tickKeyframe = (i: number) => {
      const tick = decodeTick(log[i]!);
      const keyframe = tick.keyframe;
      tick.free();
      return keyframe;
    };
    const kills = killOffsets(all);
    expect(kills.length).toBeGreaterThan(3);
    // A page that folded up to `stopped`, then joined again: from the keyframe after it, or reading on.
    const fold = (stopped: number, restart: number) => {
      const m = new Match();
      for (let i = 0; i <= stopped; i++) {
        const tick = decodeTick(log[i]!);
        m.update(tick, 0, false, i, () => 0);
        tick.free();
      }
      for (let i = restart; i < log.length; i++) {
        const tick = decodeTick(log[i]!);
        m.update(tick, 0, false, i, () => 0);
        tick.free();
      }
      return killOffsets(m);
    };
    // The tick before the first kill that has a keyframe after it within the resume window.
    const kill = kills.find((offset) => {
      const key = log.findIndex((_, i) => i > offset! && tickKeyframe(i));
      return offset! > 100 && key > offset! && key - offset! < RESUME_TICKS;
    })!;
    const next = log.findIndex((_, i) => i > kill! && tickKeyframe(i));
    expect(fold(kill! - 1, next)).not.toContain(kill);
    expect(fold(kill! - 1, kill!)).toEqual(kills);
  });

  it('starts live when the arena has no keyframe yet', async () => {
    let from: number | 'live' | undefined;
    await joinFromKeyframe(
      {
        stateGet: async () => ({ payload: null, version: null, asOf: null }),
        subscribe: async (_s, _slot, start) => {
          from = start;
          return { sub: 1, startOffset: 7, liveOffset: 7 };
        },
      },
      () => {},
    );
    expect(from).toBe('live');
  });
});
