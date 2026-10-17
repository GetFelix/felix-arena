// A match of four bots stepped in core, for the kill cam's tests: its tick records, each at the log offset of its
// index, and the kills in it.
import { decodeTick, World } from './core';
import { drive } from './offline';
import type { KillRef } from './replay';

export interface Fixture {
  records: Uint8Array[];
  kills: KillRef[];
}

/** `ticks` ticks of a match, and every kill with 3 s of ticks before it and 1 s after. */
export function botMatch(ticks: number): Fixture {
  const world = World.withRules(30, 6000, 60, 99, 300);
  for (const name of ['a', 'b', 'c', 'd']) world.join(name);
  const bots = [0, 1, 2, 3].map((i) => ({ turn: i % 2 ? 1 : -1, seq: 0 }));
  const records: Uint8Array[] = [];
  const kills: KillRef[] = [];
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
    const offset = records.length;
    records.push(record);
    tick = decodeTick(record);
    for (const e of tick.events) {
      if (e.kind === 'killed' && offset >= 90) {
        kills.push({
          matchNumber: tick.matchNumber,
          tick: tick.tick,
          offset,
          replayFrom: offset - 90,
          victim: e.slot,
          killer: e.by,
          epoch: tick.epoch,
        });
      }
      e.free();
    }
  }
  tick.free();
  return { records, kills: kills.filter((k) => k.offset + 30 < records.length) };
}
