// Against a running dev stack (dev/up.sh): ticks reach a WebSocket client
// through the gateway at 30 Hz, core's WebAssembly build decodes them to the
// state hashes the sim logged, and a replay slot reads the same records while
// the live slot keeps going. `npm run smoke` runs it; CI's dev stack job does.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { decodeTick, loadCore } from '../src/core';
import { Gateway, type EventFrame } from '../src/gateway';
import { LEGS, Legs } from '../src/legs';

const GATEWAY = process.env.ARENA_GATEWAY ?? 'ws://127.0.0.1:8787/ws';
const IDP = process.env.ARENA_IDP ?? 'http://127.0.0.1:9400';
const ARENA = process.env.ARENA ?? 'alpha';
const LISTEN_MS = 3000;

const ENGINE = process.env.CONTAINER_ENGINE ?? 'docker';

beforeAll(() => loadCore(readFileSync(new URL('../src/core/felix_arena_core_bg.wasm', import.meta.url))));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function signIn(user: string): Promise<string> {
  const answer = await fetch(`${IDP}/token?sub=${user}&aud=felix-arena`);
  return ((await answer.json()) as { id_token: string }).id_token;
}

/** Offset and tick number of each frame. */
const ticks = (frames: EventFrame[]) =>
  frames.map((frame) => [frame.offset, decodeTick(frame.payload).tick] as const);

/** The state hash the sim logged for each keyframe it committed in `arena`, by tick. */
function loggedHashes(arena: string): Map<number, string> {
  const logs = execFileSync(ENGINE, ['compose', '-f', '../dev/compose.yml', 'logs', '--no-color', 'sim'], {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  const hashes = new Map<number, string>();
  for (const [, name, tick, hash] of logs.matchAll(/keyframe arena="?([\w-]+)"? tick=(\d+) hash="?([0-9a-f]{16})/g)) {
    if (name === arena) hashes.set(Number(tick), hash!);
  }
  return hashes;
}

it('a watcher sees the live ticks, and a replay slot alongside', async () => {
  const gateway = await Gateway.connect(GATEWAY, ARENA, await signIn('cleo'));
  const live: EventFrame[] = [];
  await gateway.subscribe('ticks', 'live', 'live', (frame) => live.push(frame));
  await sleep(LISTEN_MS);

  const seen = ticks(live);
  const hz = (live.length * 1000) / LISTEN_MS;
  console.log(
    `${live.length} ticks in ${LISTEN_MS} ms (${hz.toFixed(1)} Hz), offsets ${seen[0]?.[0]} to ${seen.at(-1)?.[0]}`,
  );
  // The sim skips a tick rather than bursting when a commit runs long.
  expect(hz).toBeGreaterThanOrEqual(25);
  expect(hz).toBeLessThanOrEqual(32);
  for (let i = 1; i < seen.length; i++) {
    expect(seen[i]![0]!).toBeGreaterThan(seen[i - 1]![0]!);
    expect(seen[i]![1]!).toBeGreaterThan(seen[i - 1]![1]!);
  }
  for (const frame of live) {
    expect(frame.gatewayReceivedUs).toBeGreaterThan(0);
    expect(frame.gatewaySentUs).toBeGreaterThanOrEqual(frame.gatewayReceivedUs);
  }

  // The sim, the gateway and this client share the runner's clock in CI.
  const legs = new Legs(live.length);
  for (const frame of live) {
    const timing = decodeTick(frame.payload).timing;
    expect(timing).toBeTruthy();
    legs.add(frame, timing!);
  }
  console.table(
    Object.fromEntries(
      LEGS.map((leg) => {
        const { count, p50, p99 } = legs.summary(leg.id);
        return [leg.name, { count, p50_ms: p50 / 1000, p99_ms: p99 / 1000 }];
      }),
    ),
  );
  for (const leg of LEGS) {
    expect(legs.summary(leg.id).count).toBeGreaterThan(0);
    expect(legs.summary(leg.id).p50).toBeGreaterThanOrEqual(0);
  }

  // The sim hashed each keyframe's state natively; this decoded it in
  // WebAssembly from the bytes the gateway relayed.
  const keyframes = live.map((frame) => decodeTick(frame.payload)).filter((tick) => tick.keyframe);
  const logged = loggedHashes(ARENA);
  const compared = keyframes.filter((tick) => logged.has(tick.tick));
  console.log(`${compared.length} of ${keyframes.length} keyframes compared with the sim's hashes`);
  expect(compared.length).toBeGreaterThanOrEqual(2);
  for (const tick of compared) expect([tick.tick, tick.hash]).toEqual([tick.tick, logged.get(tick.tick)]);

  const replayed: EventFrame[] = [];
  const liveBefore = live.length;
  await gateway.subscribe('ticks', 'replay', live[0]!.offset!, (frame) => replayed.push(frame));
  for (let waited = 0; replayed.length < liveBefore && waited < 5000; waited += 50) await sleep(50);
  expect(ticks(replayed.slice(0, liveBefore))).toEqual(seen.slice(0, liveBefore));
  await sleep(200);
  expect(live.length).toBeGreaterThan(liveBefore);
  gateway.close();
}, 20_000);
