// Killing the broker that owns an arena's tick stream mid-match (docs/design.md, "Failure modes"), on the
// three-broker stack. Two bots play, a spectator reads every tick, and a page watches. The owner is killed with
// SIGKILL once the match is being played. Play must resume on another broker within MAX_PAUSE_MS, in the same match
// and sim epoch, with every tick the spectator was handed before the kill still in the log byte for byte, a replay
// that spans the failover reading back from it, and the page drawing ticks again.
// Needs `dev/up.sh --cluster` with a short warmup. Usage: npx vite-node scripts/failover.ts -- <play page url>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { decodeTick, loadCore } from '../src/core';
import { Gateway, type EventFrame } from '../src/gateway';
import type { ArenaDebug } from '../src/play';
import { fetchReplay, type KillRef } from '../src/replay';
import { bot } from './bot';

const [base] = process.argv.slice(2).filter((arg) => arg !== '--');
if (!base) throw new Error('usage: failover.ts <play page url>');
const GATEWAY = process.env.ARENA_GATEWAY ?? 'ws://127.0.0.1:8787/ws';
const IDP = process.env.ARENA_IDP ?? 'http://127.0.0.1:9400';
const CONTROL_PLANE = process.env.ARENA_CONTROL_PLANE ?? 'http://127.0.0.1:8443';
const ENGINE = process.env.CONTAINER_ENGINE ?? 'docker';
const ARENA = 'alpha';
const STREAM = `arena.ticks.${ARENA}`;
/** The control plane's failover window in the cluster stack is 3 s; the rest is the sim's retry and the new owner's election. */
const MAX_PAUSE_MS = 10_000;
/** Ticks a second. */
const HZ = 30;
/** How far before its kill a replay starts, and how long after play resumed the kill it stands for happens. */
const REPLAY_BEFORE = 90;
const KILL_AFTER = HZ / 2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
loadCore(readFileSync(new URL('../src/core/felix_arena_core_bg.wasm', import.meta.url)));

interface Seen {
  offset: number;
  epoch: number;
  tick: number;
  match: number;
  phase: string;
  /** When the sim began committing the tick, on its clock, in milliseconds. */
  commitMs: number;
  /** When this script received it. */
  at: number;
  bytes: Uint8Array;
}

const compose = (...args: string[]) =>
  execFileSync(ENGINE, ['compose', '-f', '../dev/compose.yml', '-f', '../dev/compose.cluster.yml', ...args], {
    stdio: 'inherit',
  });
const nodeToken = () => readFileSync(new URL('../../dev/state/node.token', import.meta.url), 'utf8').trim();

interface Placement {
  kind: string;
  stream: string;
  leader: string | null;
  under_replicated: boolean;
  restoring?: string;
  unavailable?: string[];
}
async function placements(): Promise<Placement[]> {
  const answer = await fetch(`${CONTROL_PLANE}/v1/placement/replication`, {
    headers: { authorization: `Bearer ${nodeToken()}` },
  });
  return ((await answer.json()) as { items: Placement[] }).items;
}
/** Shards short of their copies, being given one, or without a leader: losing a broker now could cost a majority. */
const unreplicated = async () =>
  (await placements()).filter((i) => !i.leader || i.under_replicated || i.restoring || i.unavailable?.length).length;
const owner = async () => {
  const shard = (await placements()).find((i) => i.kind === 'stream' && i.stream === STREAM);
  if (!shard?.leader) throw new Error(`${STREAM} has no owner`);
  return shard.leader;
};

const waitFor = async (what: string, done: () => boolean | Promise<boolean>, ms: number) => {
  for (const start = performance.now(); !(await done()); await sleep(100)) {
    if (performance.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
  }
};

async function signIn(user: string): Promise<string> {
  const answer = await fetch(`${IDP}/token?sub=${user}&aud=felix-arena`);
  return ((await answer.json()) as { id_token: string }).id_token;
}

// The spectator does what the gateway's protocol asks: a subscription that ends is made again from the last offset
// handled plus one, and a session that closes is opened again.
const seen: Seen[] = [];
const events: string[] = [];
let spectator = await Gateway.connect(GATEWAY, ARENA, await signIn('cleo'));
const onFrame = (frame: EventFrame) => {
  const tick = decodeTick(frame.payload);
  const timing = tick.timing;
  seen.push({
    offset: frame.offset!,
    epoch: tick.epoch,
    tick: tick.tick,
    match: tick.matchNumber,
    phase: tick.phase,
    commitMs: Number(timing?.commitStartUs ?? 0) / 1000,
    at: Date.now(),
    bytes: frame.payload.slice(),
  });
  timing?.free();
  tick.free();
};
let stopped = false;
const follow = async () => {
  while (!stopped) {
    try {
      await spectator.subscribe('ticks', 'live', seen.length > 0 ? seen.at(-1)!.offset + 1 : 'live', onFrame);
      return;
    } catch (err) {
      events.push(`subscribe failed: ${err}`);
      await sleep(500);
    }
  }
};
const watch = (gateway: Gateway) => {
  gateway.onError = (err) => {
    events.push(`${((Date.now() - started) / 1000).toFixed(1)} s: ${err.code}`);
    if (err.code === 'subscription_ended') void follow();
    else if (err.code === 'closed') void reopen();
  };
};
const reopen = async () => {
  while (!stopped) {
    try {
      spectator = await Gateway.connect(GATEWAY, ARENA, await signIn('cleo'));
      watch(spectator);
      return await follow();
    } catch {
      await sleep(500);
    }
  }
};
const started = Date.now();
watch(spectator);
await follow();

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const pageErrors: string[] = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto(`${base}?arena=${ARENA}&as=cleo`, { waitUntil: 'load' });
await page.waitForSelector('#loading', { state: 'detached', timeout: 180_000 });
type Page = Pick<ArenaDebug, 'newestTick' | 'reconnects'>;
const arena = () =>
  page.evaluate((): { newest: Page['newestTick']; reconnects: Page['reconnects'] } => ({
    newest: window.arena!.newestTick,
    reconnects: window.arena!.reconnects,
  }));

const stops = [await bot('dan', ARENA), await bot('ben', ARENA)];
let service: string | null = null;
const failures: string[] = [];
try {
  await waitFor(
    'a match being played',
    () => seen.length > REPLAY_BEFORE + HZ && seen.at(-1)!.phase === 'playing',
    180_000,
  );
  await waitFor('every shard to hold all three copies', async () => (await unreplicated()) === 0, 60_000);
  await sleep(3000);

  const leader = await owner();
  // The nodes are named broker-1 to broker-3 and the first one's service is `broker`.
  service = leader === 'broker-1' ? 'broker' : leader;
  const killedAt = Date.now();
  const pageBefore = await arena();
  console.log(
    `killing ${leader}, which owns ${STREAM}, at tick ${seen.at(-1)!.tick}; the page is at ${pageBefore.newest}`,
  );
  compose('kill', service);

  // The stall is the longest wait between two ticks from the kill on; play has resumed once a second of ticks follows it.
  const stall = () => {
    const from = seen.findIndex((t) => t.at >= killedAt - 200);
    let at = -1;
    for (let i = Math.max(from, 0); i < seen.length - 1; i++) {
      if (
        seen[i + 1]!.at - seen[i]!.at > 400 &&
        (at < 0 || seen[i + 1]!.at - seen[i]!.at > seen[at + 1]!.at - seen[at]!.at)
      )
        at = i;
    }
    return at;
  };
  await waitFor(
    'ticks after the failover',
    () => stall() >= 0 && seen.length - stall() > 2 * HZ,
    MAX_PAUSE_MS + 60_000,
  );
  const i = stall();
  const last = seen[i]!;
  const resumed = seen[i + 1]!;
  const pause = resumed.commitMs - last.commitMs;
  console.log(
    `${leader} killed; ${Math.round(pause)} ms between tick ${last.tick} (offset ${last.offset}) and tick ${resumed.tick} (offset ${resumed.offset})`,
  );
  console.log(`the spectator's session: ${events.join(', ') || 'nothing ended'}`);

  if (pause >= MAX_PAUSE_MS) failures.push(`the pause was ${Math.round(pause)} ms, over ${MAX_PAUSE_MS}`);
  if (resumed.epoch !== last.epoch) failures.push(`the sim's epoch went ${last.epoch} to ${resumed.epoch}`);
  if (resumed.match !== last.match) failures.push(`the match went ${last.match} to ${resumed.match}`);
  if (resumed.tick <= last.tick) failures.push(`the tick numbering went back, ${last.tick} to ${resumed.tick}`);
  if ((await owner()) === leader) failures.push(`${STREAM} is still owned by ${leader}`);

  // Every tick handed out before the kill was committed, so the new owner must hold it, as the same bytes.
  const logged = new Map<number, Uint8Array>();
  const reader = await Gateway.connect(GATEWAY, ARENA, await signIn('cleo'));
  for (let from = seen[0]!.offset; ; ) {
    const page = await reader.read('ticks', from, null, 500);
    for (const r of page.records) logged.set(r.offset, r.payload);
    if (page.nextOffset <= from) break;
    from = page.nextOffset;
  }
  const same = (a: Uint8Array | undefined, b: Uint8Array) => a?.length === b.length && a.every((v, k) => v === b[k]);
  const before = seen.filter((t) => t.at < killedAt);
  const lost = before.filter((t) => !logged.has(t.offset));
  const changed = before.filter((t) => logged.has(t.offset) && !same(logged.get(t.offset), t.bytes));
  const afterwards = seen.filter((t) => t.at >= killedAt && !same(logged.get(t.offset), t.bytes));
  console.log(`${before.length} ticks were handed out before the kill; ${lost.length} are missing from the log`);
  if (lost.length > 0) failures.push(`${lost.length} acknowledged ticks are gone, from tick ${lost[0]!.tick}`);
  if (changed.length > 0)
    failures.push(`${changed.length} acknowledged ticks read back different, from tick ${changed[0]!.tick}`);
  if (afterwards.length > 0) failures.push(`${afterwards.length} ticks delivered after the kill differ from the log`);

  // A kill cam for a kill half a second after play resumed names a replay that starts before the pause.
  const killFrame = seen[i + 1 + KILL_AFTER]!;
  const from = seen[i + 1 + KILL_AFTER - REPLAY_BEFORE]!;
  const ref: KillRef = {
    matchNumber: killFrame.match,
    tick: killFrame.tick,
    offset: killFrame.offset,
    replayFrom: from.offset,
    victim: 0,
    killer: 1,
    epoch: killFrame.epoch,
  };
  const replay = await fetchReplay(reader, ref, () => Date.now());
  await waitFor('the replay to finish', () => replay.times.afterMs !== null, 15_000);
  const ticks = replay.ticks.map((t) => t.snapshot.tick);
  const expected = seen.filter((t) => t.offset >= from.offset && t.offset <= killFrame.offset).map((t) => t.tick);
  const missing = expected.filter((t) => !ticks.includes(t));
  console.log(
    `a replay from tick ${from.tick} to a kill at tick ${killFrame.tick} spans the failover: ${ticks.length} ticks, ${missing.length} missing`,
  );
  if (replay.failed) failures.push(`the replay failed: ${replay.failed}`);
  if (!(ticks[0]! <= last.tick && ticks.some((t) => t >= resumed.tick)))
    failures.push('the replay does not span the pause');
  if (missing.length > 0) failures.push(`the replay lacks ${missing.length} ticks the spectator saw`);
  if (ticks.some((t, k) => k > 0 && t <= ticks[k - 1]!)) failures.push('the replay is out of order');
  reader.close();

  // The page rejoins by itself and draws live ticks again.
  await waitFor(
    'the page to draw ticks again',
    async () => ((await arena()).newest ?? 0) > last.tick + HZ,
    60_000,
  ).catch((err) => failures.push(String(err.message)));
  const pageAfter = await arena();
  console.log(
    `the page joined again ${pageAfter.reconnects - pageBefore.reconnects} times and is at tick ${pageAfter.newest}`,
  );
  if ((pageAfter.newest ?? 0) <= last.tick + HZ) failures.push(`the page stayed at tick ${pageAfter.newest}`);
  if (pageErrors.length > 0) failures.push(`the page raised: ${pageErrors.join('; ')}`);

  if (failures.length > 0) throw new Error(failures.join('\n'));
  console.log('play resumed on another broker with every acknowledged tick intact');
} finally {
  stopped = true;
  for (const stop of stops) stop();
  spectator.close();
  await browser.close();
  if (service) compose('start', service);
}
process.exit(0);
