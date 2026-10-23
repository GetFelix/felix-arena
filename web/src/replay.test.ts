import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeTick, loadCore } from './core';
import { botMatch, type Fixture } from './kills.fixture';
import { AFTER, fetchReplay, killsOf, Playback, type Reader, Replay, SHOWN, speedAt } from './replay';

let match: Fixture;
beforeAll(() => {
  loadCore(readFileSync(new URL('./core/felix_arena_core_bg.wasm', import.meta.url)));
  match = botMatch(2400);
});

/** A log of `records` read in pages of at most `page`, holding only the first `committed()` records. */
function log(records: Uint8Array[], committed: () => number, page = 40): Reader & { reads: number } {
  const reader = {
    reads: 0,
    read: async (_stream: string, from: number, end: number | null, max = 0) => {
      reader.reads++;
      const stop = Math.min(end ?? Infinity, committed(), from + page, max ? from + max : Infinity);
      const out = [];
      for (let o = from; o < stop; o++) out.push({ offset: o, payload: records[o]! });
      return { records: out, nextOffset: Math.max(from, stop) };
    },
  };
  return reader;
}

describe('a replay', () => {
  it('reads from the offset the kill names to the kill, then the second after it as it is committed', async () => {
    expect(match.kills.length).toBeGreaterThan(3);
    const kill = match.kills[0]!;
    // The second after the kill is still being committed: one more tick each read.
    let committed = kill.offset + 1;
    const reader = log(match.records, () => committed++);
    const replay = await fetchReplay(
      reader,
      kill,
      () => 0,
      async () => {},
    );
    expect(replay.ready).toBe(true);
    expect(replay.span![0]).toBe(kill.tick - 90);
    expect(replay.span![1]).toBeGreaterThanOrEqual(kill.tick);
    for (let i = 0; i < 100 && replay.times.afterMs === null; i++) await new Promise((r) => setTimeout(r, 0));
    expect(replay.span).toEqual([kill.tick - 90, kill.tick + AFTER]);
    expect(replay.bytes()).toEqual(match.records.slice(kill.replayFrom, kill.offset + AFTER + 1));
  });

  it('says a trimmed offset is trimmed', async () => {
    const reader: Reader = {
      read: () => Promise.reject(Object.assign(new Error('gone'), { code: 'trimmed' })),
    };
    const replay = await fetchReplay(reader, match.kills[0]!);
    expect([replay.failed, replay.ready]).toEqual(['trimmed', false]);
  });

  it('keeps one copy of a tick that landed twice, and none from another epoch', () => {
    const kill = match.kills[0]!;
    const [a, b] = [match.records[kill.replayFrom]!, match.records[kill.replayFrom + 1]!];
    const other = a.slice();
    other[0] = 9;
    const replay = new Replay(kill, 0);
    replay.add([a, a, other, b].map((payload, offset) => ({ offset, payload })));
    expect(replay.ticks.map((t) => t.snapshot.tick)).toEqual([kill.tick - 90, kill.tick - 89]);
  });

  it('slows to half speed for the half second before the kill and plays the second after at full speed', () => {
    const kill = 1000;
    expect(speedAt(900, kill)).toBe(1);
    expect(speedAt(kill - 10, kill)).toBe(0.5);
    expect(speedAt(kill, kill)).toBe(0.5);
    expect(speedAt(kill + 10, kill)).toBe(1);
  });

  it('plays 2 s before the kill and 1 s after, in about 3.6 s with the slow motion', async () => {
    const kill = match.kills[1]!;
    const replay = await fetchReplay(
      log(match.records, () => match.records.length, 500),
      kill,
      () => 0,
    );
    for (let i = 0; i < 100 && replay.times.afterMs === null; i++) await new Promise((r) => setTimeout(r, 0));
    const playback = new Playback(replay);
    // The log is read from further back than the kill cam plays.
    expect(replay.ticks[0]!.snapshot.tick).toBeLessThan(kill.tick - SHOWN);
    expect(playback.r).toBe(kill.tick - SHOWN);
    const seen: string[] = [];
    let ms = 0;
    let frame = playback.advance(0);
    while (!frame.done && ms < 10_000) {
      frame = playback.advance(1000 / 60);
      ms += 1000 / 60;
      for (const e of frame.events) seen.push(`${e.tick}:${e.kind}`);
    }
    expect(frame.done).toBe(true);
    expect(ms / 1000).toBeGreaterThan(3.4);
    expect(ms / 1000).toBeLessThan(3.8);
    expect(seen).toContain(`${kill.tick}:killed`);
    expect(frame.crafts.find((c) => c.slot === kill.victim)?.alive).toBe(false);
  });

  it('finds the kills of a match in its log, from the oldest record left when its start was trimmed', async () => {
    const oldest = 500;
    const inner = log(match.records, () => match.records.length, 300);
    const scanned = {
      read: (stream: string, from: number, end: number | null, max?: number) =>
        from < oldest
          ? Promise.reject(Object.assign(new Error('gone'), { code: 'trimmed', oldest }))
          : inner.read(stream, from, end, max),
      stateGet: async (_stream: string, key: string) =>
        key === 'match/0' ? { payload: null, version: 0, asOf: null } : { payload: null, version: null, asOf: null },
    };
    const kills = await killsOf(scanned, 0);
    // Every kill from the oldest record on; the records come from core's world, which names no replay offsets.
    const expected = match.records.slice(oldest).flatMap((record) => {
      const tick = decodeTick(record);
      const found = tick.events.filter((e) => e.kind === 'killed').map((e) => [e.by, e.slot]);
      tick.free();
      return found;
    });
    expect(expected.length).toBeGreaterThan(3);
    expect(kills?.map((k) => [k.killer, k.victim])).toEqual(expected);
    expect(await killsOf(scanned, 1)).toBeNull();
  });
});
