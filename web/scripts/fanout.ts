// The spectator fanout check (docs/design.md, demonstration 5), through the dev stack: four bots play a match and each
// measures the trip of every tick from the sim's commit to its arrival. It does that for a phase alone, then for a phase
// with a Rust example holding spectators as Felix clients (`sim/examples/spectators.rs`). The players' median trip must
// stay within 10% of the first phase, and so must the sim's commit time, which every tick carries for the one before.
// Usage: npx vite-node scripts/fanout.ts -- <spectators binary> [spectators, default 100] [seconds a phase, default 30]
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { loadCore } from '../src/core';
import { Legs } from '../src/legs';
import { bot } from './bot';

const [binary, count = '100', seconds = '30'] = process.argv.slice(2).filter((arg) => arg !== '--');
if (!binary) throw new Error('usage: fanout.ts <spectators binary> [spectators] [seconds a phase]');
const ARENA = 'alpha';
const IDP = process.env.ARENA_IDP ?? 'http://127.0.0.1:9400';
const CONTROL_PLANE = process.env.ARENA_CONTROL_PLANE ?? 'http://127.0.0.1:8443';
const BROKER = process.env.ARENA_BROKER ?? '127.0.0.1:5000';
const BROKER_CA = process.env.ARENA_BROKER_CA ?? new URL('../../dev/state/broker-cert.pem', import.meta.url).pathname;
const PHASE_MS = Number(seconds) * 1000;
/** What a median may grow by: 10%, and a millisecond for the resolution of a median this small. */
const GROWTH = 1.1;
const SLACK_US = 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
loadCore(readFileSync(new URL('../src/core/felix_arena_core_bg.wasm', import.meta.url)));

/** A Felix token for `cleo`, who may watch an arena and not play in it, written where the example reads it. */
async function spectatorToken(): Promise<string> {
  const idp = await fetch(`${IDP}/token?sub=cleo&aud=felix-arena`);
  const idToken = ((await idp.json()) as { id_token: string }).id_token;
  const exchange = await fetch(`${CONTROL_PLANE}/v1/tenants/arena/token/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ requested: ['stream.subscribe'] }),
  });
  if (!exchange.ok) throw new Error(`token exchange: ${exchange.status} ${await exchange.text()}`);
  const file = join(mkdtempSync(join(tmpdir(), 'fanout-')), 'cleo.token');
  writeFileSync(file, ((await exchange.json()) as { felix_token: string }).felix_token, { mode: 0o600 });
  return file;
}

/** Runs the example and answers when every spectator is reading, and how the run ended. */
function holdSpectators(tokenFile: string, readSeconds: number) {
  const child = spawn(binary!, [], {
    env: {
      ...process.env,
      SPECTATORS_COUNT: count,
      SPECTATORS_SECONDS: String(readSeconds),
      SPECTATORS_ARENA: ARENA,
      SPECTATORS_FELIX_BROKERS: BROKER,
      SPECTATORS_FELIX_CA_FILE: BROKER_CA,
      SPECTATORS_FELIX_TOKEN_FILE: tokenFile,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const summary: string[] = [];
  let subscribed!: () => void;
  const ready = new Promise<void>((resolve, reject) => {
    subscribed = resolve;
    child.once('error', reject);
    child.once('exit', () => reject(new Error('the spectators exited before all of them subscribed')));
  });
  createInterface({ input: child.stdout! }).on('line', (line) => {
    console.log(`  spectators: ${line}`);
    if (line.startsWith('subscribed ')) subscribed();
    else summary.push(line);
  });
  const done = new Promise<number | null>((resolve) => child.once('exit', resolve));
  return { ready, done, summary };
}

const players = ['ana', 'ben', 'dan', 'eve'];
const fresh = () => new Map(players.map((user) => [user, new Legs(100_000)]));
// Each bot adds to whatever is in `trips` now, so each phase starts a new set and keeps the old.
let trips = fresh();
const stops = await Promise.all(players.map((user) => bot(user, ARENA, () => trips.get(user)!)));

const ms = (us: number) => (us / 1000).toFixed(2);

// The warmup is free play and counts nothing; wait it out so both phases are measured in the same match.
for (let waited = 0; trips.get('ana')!.summary('total').count < 30; waited += 500) {
  if (waited > 120_000) throw new Error('no ticks arrived');
  await sleep(500);
}
await sleep(10_000);

trips = fresh();
console.log(`${seconds} s with the four players alone`);
await sleep(PHASE_MS);
const alone = trips;

console.log(`${seconds} s with ${count} spectators`);
const tokenFile = await spectatorToken();
// The example reads a little longer than the phase, so it is still reading when the phase ends.
const held = holdSpectators(tokenFile, Number(seconds) + 5);
await held.ready;
trips = fresh();
await sleep(PHASE_MS);
const crowded = trips;
const exit = await held.done;
for (const stop of stops) stop();

const failures: string[] = [];
if (exit !== 0) failures.push(`the spectators ended with status ${exit}: ${held.summary.join('; ')}`);
console.log('median trip, sim commit to the player, in ms, alone and with the spectators:');
for (const user of players) {
  const [before, during] = [alone.get(user)!.summary('total'), crowded.get(user)!.summary('total')];
  console.log(`  ${user}: ${ms(before.p50)} -> ${ms(during.p50)} (${during.count} ticks)`);
  if (during.count < PHASE_MS / 40) failures.push(`${user} took only ${during.count} ticks with the spectators`);
  if (!(during.p50 <= before.p50 * GROWTH + SLACK_US)) {
    failures.push(`${user}'s median went from ${ms(before.p50)} to ${ms(during.p50)} ms`);
  }
}
// Every player is told the same commit times, so one is enough.
const [commitBefore, commitDuring] = [alone.get('ana')!.summary('commit'), crowded.get('ana')!.summary('commit')];
console.log(
  `the sim's commit, in ms: p50 ${ms(commitBefore.p50)} -> ${ms(commitDuring.p50)}, ` +
    `p99 ${ms(commitBefore.p99)} -> ${ms(commitDuring.p99)}`,
);
if (!(commitDuring.p50 <= commitBefore.p50 * GROWTH + SLACK_US)) {
  failures.push(`the sim's commit median went from ${ms(commitBefore.p50)} to ${ms(commitDuring.p50)} ms`);
}
if (failures.length > 0) throw new Error(failures.join('\n'));
process.exit(0);
