// Checks the replay offset each kill event names (docs/design.md, "The kill cam"): a watcher reads every tick live,
// and each kill's `replay_from` must be the offset of the tick 3 seconds earlier, or of the first tick of the warmup
// or match it happened in when that is later. Load core before calling it.
import { decodeTick } from '../src/core';
import { Gateway, type EventFrame } from '../src/gateway';

const GATEWAY = process.env.ARENA_GATEWAY ?? 'ws://127.0.0.1:8787/ws';
const IDP = process.env.ARENA_IDP ?? 'http://127.0.0.1:9400';
const REPLAY_BEFORE = 90;

interface Kill {
  tick: number;
  offset: number;
  replayFrom: number | undefined;
  /** The first tick of the warmup or match the kill is in. */
  cut: number;
}

/** Watch `arena` as `user` until the answer's `check` is called, which stops watching and throws on a bad offset. */
export async function watchKills(user: string, arena: string): Promise<{ check: () => Promise<number> }> {
  const answer = await fetch(`${IDP}/token?sub=${user}&aud=felix-arena`);
  const token = ((await answer.json()) as { id_token: string }).id_token;
  const gateway = await Gateway.connect(GATEWAY, arena, token);
  const tickAt = new Map<number, number>();
  const kills: Kill[] = [];
  let phase: string | null = null;
  let cut = 0;
  let first: number | null = null;
  await gateway.subscribe('ticks', 'live', 'live', (frame) => {
    const tick = decodeTick(frame.payload);
    tickAt.set(frame.offset!, tick.tick);
    first ??= tick.tick;
    if (tick.phase !== phase && tick.phase !== 'results') cut = tick.tick;
    phase = tick.phase;
    for (const e of tick.events) {
      if (e.kind === 'killed') kills.push({ tick: tick.tick, offset: frame.offset!, replayFrom: e.replayFrom, cut });
      e.free();
    }
    tick.free();
  });

  return {
    async check() {
      // Each kill is checked against the ticks this watcher saw, so only those whose replay starts after it began;
      // the first is also read back from the log.
      const checked = kills.filter((k) => Math.max(k.tick - REPLAY_BEFORE, k.cut) > first!);
      // When the expected tick is not in the log (its commit failed), the sim names a neighbour instead.
      const logged = new Set(tickAt.values());
      const bad = checked.filter((k) => {
        const expected = Math.max(k.tick - REPLAY_BEFORE, k.cut);
        const named = k.replayFrom === undefined ? undefined : tickAt.get(k.replayFrom);
        if (named === expected) return false;
        return named === undefined || logged.has(expected) || Math.abs(named - expected) > 3;
      });
      for (const k of checked) {
        console.log(
          `kill at tick ${k.tick} (offset ${k.offset}): replay from offset ${k.replayFrom}, tick ${tickAt.get(k.replayFrom ?? -1)}`,
        );
      }
      const back = checked.find((k) => k.replayFrom !== undefined);
      if (back) {
        const read = await new Promise<EventFrame>((resolve, reject) => {
          setTimeout(() => reject(new Error(`nothing came back from offset ${back.replayFrom}`)), 10_000);
          gateway.subscribe('ticks', 'replay', back.replayFrom!, resolve).catch(reject);
        });
        const tick = decodeTick(read.payload).tick;
        if (read.offset !== back.replayFrom || tick !== tickAt.get(back.replayFrom!)) {
          bad.push(back);
          console.log(`reading offset ${back.replayFrom} back gave offset ${read.offset}, tick ${tick}`);
        }
      }
      gateway.close();
      if (bad.length > 0) throw new Error(`${bad.length} of ${checked.length} kills named the wrong replay offset`);
      return checked.length;
    },
  };
}
