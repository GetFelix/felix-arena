// The spectator fanout check (docs/design.md, demonstration 5), through the dev stack: four bots play a match and each
// measures the trip of every tick from the sim's commit to its arrival. It does that alone, then with a Rust example
// holding spectators as Felix clients (`sim/examples/spectators.rs`), then alone again. A player's median trip, and the
// sim's commit time, which every tick carries for the one before, may grow by 10% plus a small slack over the
// slower of the two quiet phases, so a machine that warms up during the run cannot hide a cost.
// The readers' own CPU is not Felix's cost, so on a shared machine FANOUT_SPECTATOR_CPUS (a `taskset -c` list, such as
// `3`) keeps them on cores the broker, the sim and these players do not use; CI also pins the stack and this script
// to the other cores. Without it the numbers include the readers competing for CPU, and the run says so.
// Usage: npx vite-node scripts/fanout.ts -- <spectators binary> [spectators, default 100] [seconds a phase, default 20]
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { loadCore } from '../src/core';
import { Legs } from '../src/legs';
import { bot } from './bot';

const [binary, count = '100', seconds = '20'] = process.argv.slice(2).filter((arg) => arg !== '--');
if (!binary) throw new Error('usage: fanout.ts <spectators binary> [spectators] [seconds a phase]');
const ARENA = 'alpha';
const IDP = process.env.ARENA_IDP ?? 'http://127.0.0.1:9400';
const CONTROL_PLANE = process.env.ARENA_CONTROL_PLANE ?? 'http://127.0.0.1:8443';
const BROKER = process.env.ARENA_BROKER ?? '127.0.0.1:5000';
const BROKER_CA = process.env.ARENA_BROKER_CA ?? new URL('../../dev/state/broker-cert.pem', import.meta.url).pathname;
const PHASE_MS = Number(seconds) * 1000;
const SPECTATOR_CPUS = process.env.FANOUT_SPECTATOR_CPUS?.trim();
/**
 * What a median may grow by: 10%, and a little for timer and scheduler noise on a median of about 1 ms. With the
 * readers on their own cores the slack stands for that noise alone. Without that, 100 readers sharing the broker's
 * cores add 0.5 to 0.8 ms of their own, so the slack is a millisecond and the run says it did not isolate them.
 */
const GROWTH = 1.1;
const SLACK_US = SPECTATOR_CPUS ? 300 : 1000;

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
  const dir = mkdtempSync(join(tmpdir(), 'fanout-'));
  const file = join(dir, 'cleo.token');
  writeFileSync(file, ((await exchange.json()) as { felix_token: string }).felix_token, { mode: 0o600 });
  return { file, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Runs the example and answers when every spectator is reading, and how the run ended. */
function holdSpectators(tokenFile: string, readSeconds: number) {
  const timeout = setTimeout(() => child.kill(), (readSeconds + 90) * 1000);
  const [command, args] = SPECTATOR_CPUS ? ['taskset', ['-c', SPECTATOR_CPUS, binary!]] : [binary!, []];
  const child = spawn(command, args, {
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
  const done = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    }),
  );
  return { ready, done, summary, kill: () => child.kill() };
}

console.log(
  SPECTATOR_CPUS
    ? `the spectators run on cpu ${SPECTATOR_CPUS}, apart from the stack and the players`
    : 'the spectators share cpu with the stack and the players, so their own cost is in the numbers',
);
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
const quiet = [trips];

console.log(`${seconds} s with ${count} spectators`);
const token = await spectatorToken();
// The example reads a little longer than the phase, so it is still reading when the phase ends.
const held = holdSpectators(token.file, Number(seconds) + 5);
try {
  await held.ready;
} catch (err) {
  held.kill();
  for (const stop of stops) stop();
  throw err;
} finally {
  token.remove();
}
trips = fresh();
await sleep(PHASE_MS);
const crowded = trips;
const exit = await held.done;

trips = fresh();
console.log(`${seconds} s alone again`);
await sleep(PHASE_MS);
quiet.push(trips);
for (const stop of stops) stop();

/** The larger of a statistic over the quiet phases: the baseline a crowded phase must stay within. */
const baseline = (user: string, leg: 'total' | 'commit') =>
  Math.max(...quiet.map((t) => t.get(user)!.summary(leg).p50));

const failures: string[] = [];
if (exit !== 0) failures.push(`the spectators ended with status ${exit}: ${held.summary.join('; ')}`);
console.log('median trip, sim commit to the player, in ms, alone (slower of two phases) and with the spectators:');
for (const user of players) {
  const [before, during] = [{ p50: baseline(user, 'total') }, crowded.get(user)!.summary('total')];
  console.log(`  ${user}: ${ms(before.p50)} -> ${ms(during.p50)} (p99 ${ms(during.p99)}, ${during.count} ticks)`);
  if (during.count < PHASE_MS / 40) failures.push(`${user} took only ${during.count} ticks with the spectators`);
  if (!(during.p50 <= before.p50 * GROWTH + SLACK_US)) {
    failures.push(`${user}'s median went from ${ms(before.p50)} to ${ms(during.p50)} ms`);
  }
}
// Every player is told the same commit times, so one is enough. The commit ends when the tick is durable, before
// Felix fans it out, so this leg only moves if the spectators starve the sim or the broker of CPU.
const commitBefore = baseline('ana', 'commit');
const commitDuring = crowded.get('ana')!.summary('commit');
console.log(`the sim's commit, in ms: p50 ${ms(commitBefore)} -> ${ms(commitDuring.p50)}, p99 ${ms(commitDuring.p99)}`);
if (!(commitDuring.p50 <= commitBefore * GROWTH + SLACK_US)) {
  failures.push(`the sim's commit median went from ${ms(commitBefore)} to ${ms(commitDuring.p50)} ms`);
}
if (failures.length > 0) throw new Error(failures.join('\n'));
process.exit(0);
