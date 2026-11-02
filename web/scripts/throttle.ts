// The throttle lane (docs/design.md, "Slow clients"), through the dev stack: four bots play a match, two spectators
// read it at full speed, and a third has the gateway slow its subscription to a slow link. The slow one must fall
// behind, and the others' trip time from the sim's commit to the page must stay within 10% of what it was before.
// Usage: npx vite-node scripts/throttle.ts -- [kilobits a second, default 16] [seconds a phase, default 30]
import { readFileSync } from 'node:fs';
import { Behind } from '../src/behind';
import { decodeTick, loadCore } from '../src/core';
import { Gateway } from '../src/gateway';
import { Legs } from '../src/legs';
import { bot } from './bot';

const [kbit = '16', seconds = '30'] = process.argv.slice(2).filter((arg) => arg !== '--');
const ARENA = 'alpha';
const GATEWAY = process.env.ARENA_GATEWAY ?? 'ws://127.0.0.1:8787/ws';
const IDP = process.env.ARENA_IDP ?? 'http://127.0.0.1:9400';
const PHASE_MS = Number(seconds) * 1000;
/** What the others' median may grow by: 10%, and a millisecond for the resolution of a median this small. */
const GROWTH = 1.1;
const SLACK_US = 1000;
/** A client this many ticks late is behind in the sense docs/design.md gives. */
const BEHIND_TICKS = 15;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
loadCore(readFileSync(new URL('../src/core/felix_arena_core_bg.wasm', import.meta.url)));

/** A spectator's session, with the trip time of every tick it takes and the ticks it never got. */
async function spectator(name: string) {
  const answer = await fetch(`${IDP}/token?sub=cleo&aud=felix-arena`);
  const token = ((await answer.json()) as { id_token: string }).id_token;
  const gateway = await Gateway.connect(GATEWAY, ARENA, token);
  const state = { legs: new Legs(100_000), behind: new Behind(), maxBehind: 0, ticks: 0, missed: 0 };
  let last: number | null = null;
  await gateway.subscribe('ticks', 'live', 'live', (frame) => {
    const tick = decodeTick(frame.payload);
    const timing = tick.timing;
    if (timing) {
      state.legs.add(frame, timing);
      state.behind.add(frame.receivedUs - timing.commitStartUs);
      state.maxBehind = Math.max(state.maxBehind, state.behind.ticks);
      timing.free();
    }
    tick.free();
    state.ticks++;
    if (frame.offset !== null) {
      if (last !== null) state.missed += Math.max(0, frame.offset - last - 1 - frame.skippedBefore);
      last = frame.offset;
    }
  });
  return { name, gateway, state };
}

type Spectator = Awaited<ReturnType<typeof spectator>>;
const fresh = (s: Spectator) => Object.assign(s.state, { legs: new Legs(100_000), maxBehind: 0, ticks: 0, missed: 0 });
const median = (s: Spectator) => s.state.legs.summary('total').p50;
const ms = (us: number) => (us / 1000).toFixed(2);

const stops = await Promise.all(['ana', 'ben', 'dan', 'eve'].map((user) => bot(user, ARENA)));
const others = [await spectator('first'), await spectator('second')];
const slow = await spectator('slow');
const everyone = [...others, slow];
// Let the match get going, so every phase is measured under the same load.
await sleep(10_000);

everyone.forEach(fresh);
await sleep(PHASE_MS);
const before = others.map(median);
const baseline = { ticks: slow.state.ticks, behind: slow.state.maxBehind, missed: slow.state.missed };

everyone.forEach(fresh);
slow.gateway.onError = (err) => console.log(`slow session: ${err.code}: ${err.message}`);
slow.gateway.throttle(Number(kbit) * 1000);
await sleep(PHASE_MS);
const during = others.map(median);
const result = { ticks: slow.state.ticks, behind: slow.state.maxBehind, missed: slow.state.missed };

for (const stop of stops) stop();
for (const s of everyone) s.gateway.close();

console.log(`median trip, sim commit to page, in ms, before and with one spectator at ${kbit} kbit/s:`);
others.forEach((s, i) => console.log(`  ${s.name}: ${ms(before[i]!)} -> ${ms(during[i]!)}`));
console.log(
  `the slow one: ${baseline.ticks} ticks, ${baseline.missed} lost, up to ${baseline.behind.toFixed(1)} behind`,
);
console.log(
  `  at ${kbit} kbit/s: ${result.ticks} ticks, ${result.missed} lost, up to ${result.behind.toFixed(1)} behind`,
);

const failures: string[] = [];
if (baseline.ticks < PHASE_MS / 40) failures.push(`the slow session took only ${baseline.ticks} ticks at full speed`);
others.forEach((s, i) => {
  if (during[i]! > before[i]! * GROWTH + SLACK_US) {
    failures.push(`${s.name}'s median went from ${ms(before[i]!)} to ${ms(during[i]!)} ms`);
  }
});
if (result.behind < BEHIND_TICKS && result.missed === 0) {
  failures.push(`the slow session never fell behind: ${result.behind.toFixed(1)} ticks, ${result.missed} lost`);
}
if (failures.length > 0) throw new Error(failures.join('\n'));
process.exit(0);
