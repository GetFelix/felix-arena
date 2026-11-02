import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeTick, loadCore, World } from './core';
import type { EventFrame, StateValue, Subscribed } from './gateway';
import { GapFeed } from './gaps';
import { Folded, HOLE_TICKS, HOLE_TIMEOUT_MS, isCatchUp, joinFromKeyframe, RESUME_TICKS, type Joinable } from './join';
import { Match } from './match';
import { drive } from './offline';
import type { Reader } from './replay';

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

  it('reads on from where a page got to when it is close to the newest tick, and from the keyframe otherwise', async () => {
    const from = async (keyframe: number | null, tail: number | null, resumeAfter: number | null) => {
      let start: number | 'live' | undefined;
      await joinFromKeyframe(
        {
          stateGet: async () => ({ payload: null, version: keyframe, asOf: tail }),
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
    // The join-time catch-up: the page is a few ticks behind the newest tick.
    expect(await from(600, 615, 590)).toBe(591);
    expect(await from(600, 615, 615 - RESUME_TICKS)).toBe(615 - RESUME_TICKS + 1);
    // A page on a slow link falls behind the newest tick, not just the keyframe, and jumps to the keyframe.
    expect(await from(600, 615, 615 - RESUME_TICKS - 1)).toBe(600);
    expect(await from(600, 629, 590)).toBe(600);
    expect(await from(600, 600, 610)).toBe(600);
    expect(await from(600, 615, null)).toBe(600);
    // No tail in the answer: the keyframe stands in for it.
    expect(await from(600, null, 590)).toBe(591);
    expect(await from(null, null, 590)).toBe('live');
  });

  it('reads the ticks between a far-behind page and the keyframe before it subscribes', async () => {
    const run = async (read: Joinable['read'], resumeAfter: number, keyframe = 600) => {
      const seen: [number | null, boolean][] = [];
      let subscribedAfter = -1;
      await joinFromKeyframe(
        {
          stateGet: async () => ({ payload: null, version: keyframe, asOf: keyframe + 5 }),
          subscribe: async () => {
            subscribedAfter = seen.length;
            return { sub: 1, startOffset: keyframe, liveOffset: keyframe };
          },
          read,
        },
        (f, catchUp) => seen.push([f.offset, catchUp]),
        resumeAfter,
      );
      return { seen, subscribedAfter };
    };
    const page: Joinable['read'] = async (_s, from, end) => ({
      records: Array.from({ length: Math.min(40, end! - from) }, (_, i) => ({
        offset: from + i,
        payload: new Uint8Array(),
      })),
      nextOffset: from + Math.min(40, end! - from),
    });
    // 100 ticks behind: further than a subscription reads, so the range is read, in pages, ahead of the subscription.
    const far = await run(page, 499);
    expect(far.seen.map(([offset]) => offset)).toEqual(Array.from({ length: 100 }, (_, i) => 500 + i));
    expect(far.seen.every(([, catchUp]) => catchUp)).toBe(true);
    expect(far.subscribedAfter).toBe(100);
    // Too many ticks to read, no reader, a failed read and a late one all join from the keyframe alone.
    expect((await run(page, 600 - HOLE_TICKS - 2)).seen).toEqual([]);
    expect((await run(undefined, 499)).seen).toEqual([]);
    expect((await run(async () => Promise.reject(new Error('refused')), 499)).seen).toEqual([]);
    vi.useFakeTimers();
    try {
      const late = run(() => new Promise(() => {}), 499);
      await vi.advanceTimersByTimeAsync(HOLE_TIMEOUT_MS);
      expect((await late).seen).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
    // A read that stops short of the keyframe would leave a hole of its own.
    const short: Joinable['read'] = async (_s, from) => ({
      records: [{ offset: from, payload: new Uint8Array() }],
      nextOffset: from,
    });
    expect((await run(short, 499)).seen).toEqual([]);
  });

  it('counts a page as folded up to the first tick that was skipped and not read back', () => {
    const folded = new Folded();
    expect(folded.offset).toBeNull();
    folded.rejoin();
    folded.see(100, 0);
    folded.see(101, 0);
    expect(folded.offset).toBe(101);
    // Offsets 102 to 104 never arrived and were not read back: later ticks do not hide the hole.
    folded.see(105, 0);
    folded.see(106, 0);
    expect(folded.offset).toBe(101);
    // Ticks the broker says it skipped on purpose are not a hole.
    const clear = new Folded();
    clear.see(10, 0);
    clear.see(14, 3);
    expect(clear.offset).toBe(14);
  });

  it('reads on after a hole, and starts over when the join took the keyframe', () => {
    const folded = new Folded();
    folded.rejoin();
    folded.see(100, 0);
    folded.see(105, 0);
    expect(folded.offset).toBe(100);
    // A join that read on from 101 closes the hole.
    folded.rejoin();
    for (let offset = 101; offset <= 105; offset++) folded.see(offset, 0);
    expect(folded.offset).toBe(105);
    folded.see(106, 0);
    expect(folded.offset).toBe(106);
    // A join that took a keyframe past a hole starts over from it.
    folded.see(110, 0);
    folded.rejoin();
    folded.see(120, 0);
    expect(folded.offset).toBe(120);
    folded.see(121, 0);
    expect(folded.offset).toBe(121);
  });

  it('does not count the tick after an unread gap as folded', async () => {
    const seen: number[] = [];
    const folded = new Folded();
    const reader = { read: async () => ({ records: [], nextOffset: 0 }) } as unknown as Reader;
    const feed = new GapFeed(
      () => reader,
      (frame) => {
        folded.see(frame.offset, frame.skippedBefore);
        seen.push(frame.offset!);
      },
      { tooFar: () => {} },
    );
    const frame = (offset: number) =>
      ({ offset, skippedBefore: 0, payload: new Uint8Array() }) as unknown as EventFrame;
    feed.push(frame(100), false);
    feed.push(frame(101), false);
    feed.push(frame(140), false);
    await vi.waitFor(() => expect(seen).toEqual([100, 101, 140]));
    expect(folded.offset).toBe(101);
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
