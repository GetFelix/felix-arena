// Against a running dev stack (dev/up.sh): ticks reach a WebSocket client
// through the gateway at 30 Hz, and a replay slot reads the same records while
// the live slot keeps going. `npm run smoke` runs it; CI's dev stack job does.
import { expect, it } from 'vitest';
import { Gateway, type EventFrame } from '../src/gateway';
import { parseTickHeader } from '../src/tick';

const GATEWAY = process.env.ARENA_GATEWAY ?? 'ws://127.0.0.1:8787/ws';
const IDP = process.env.ARENA_IDP ?? 'http://127.0.0.1:9400';
const ARENA = process.env.ARENA ?? 'alpha';
const LISTEN_MS = 3000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function signIn(user: string): Promise<string> {
  const answer = await fetch(`${IDP}/token?sub=${user}&aud=felix-arena`);
  return ((await answer.json()) as { id_token: string }).id_token;
}

/** Offset and tick number of each frame. */
const ticks = (frames: EventFrame[]) =>
  frames.map((frame) => [frame.offset, parseTickHeader(frame.payload)?.tick] as const);

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
  expect(hz).toBeGreaterThanOrEqual(27);
  expect(hz).toBeLessThanOrEqual(32);
  for (let i = 1; i < seen.length; i++) {
    expect(seen[i]![0]!).toBeGreaterThan(seen[i - 1]![0]!);
    expect(seen[i]![1]!).toBeGreaterThan(seen[i - 1]![1]!);
  }
  for (const frame of live) {
    expect(frame.gatewayReceivedUs).toBeGreaterThan(0);
    expect(frame.gatewaySentUs).toBeGreaterThanOrEqual(frame.gatewayReceivedUs);
  }

  const replayed: EventFrame[] = [];
  const liveBefore = live.length;
  await gateway.subscribe('ticks', 'replay', live[0]!.offset!, (frame) => replayed.push(frame));
  for (let waited = 0; replayed.length < liveBefore && waited < 5000; waited += 50) await sleep(50);
  expect(ticks(replayed.slice(0, liveBefore))).toEqual(seen.slice(0, liveBefore));
  await sleep(200);
  expect(live.length).toBeGreaterThan(liveBefore);
  gateway.close();
}, 20_000);
