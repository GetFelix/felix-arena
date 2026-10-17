// Against a running dev stack (dev/up.sh): the sim's keyframe commits write
// the `keyframe` state key, so a reader learns the latest keyframe's offset
// from the key's version, and a match's first tick writes `match/<n>`.
import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { decodeTick, loadCore } from '../src/core';
import { Gateway, type EventFrame } from '../src/gateway';

const GATEWAY = process.env.ARENA_GATEWAY ?? 'ws://127.0.0.1:8787/ws';
const IDP = process.env.ARENA_IDP ?? 'http://127.0.0.1:9400';
const ARENA = process.env.ARENA ?? 'alpha';

beforeAll(() => loadCore(readFileSync(new URL('../src/core/felix_arena_core_bg.wasm', import.meta.url))));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function signIn(user: string): Promise<string> {
  const answer = await fetch(`${IDP}/token?sub=${user}&aud=felix-arena`);
  return ((await answer.json()) as { id_token: string }).id_token;
}

/** The match and tick numbers in a tick record's 12-byte header, which is what the state keys hold. */
function header(bytes: Uint8Array): { match: number; tick: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { match: view.getUint32(4, true), tick: view.getUint32(8, true) };
}

it("state_get answers the latest keyframe's offset as the key's version", async () => {
  const gateway = await Gateway.connect(GATEWAY, ARENA, await signIn('cleo'));
  const live: EventFrame[] = [];
  await gateway.subscribe('ticks', 'live', 'live', (frame) => live.push(frame));
  // Long enough for two keyframes to pass on the live subscription.
  await sleep(2500);

  const state = await gateway.stateGet('ticks', 'keyframe');
  expect(state.payload).not.toBeNull();
  expect(state.payload!.length).toBe(12);
  const at = state.version!;
  const asOf = state.asOf!;
  expect(asOf).toBeGreaterThanOrEqual(at);
  const { match, tick } = header(state.payload!);
  // Ticks up to `as_of` may still be on their way on the live subscription.
  for (let waited = 0; (live.at(-1)?.offset ?? -1) < asOf && waited < 3000; waited += 20) await sleep(20);

  // Every keyframe the live subscription saw up to `as_of`: the key names the newest of them.
  const keyframes = live.filter((frame) => frame.offset! <= asOf && decodeTick(frame.payload).keyframe);
  console.log(
    `keyframe key: match ${match} tick ${tick} at offset ${at}, as of ${asOf}; ` +
      `live keyframes at ${keyframes.map((frame) => frame.offset).join(', ')}`,
  );
  expect(keyframes.length).toBeGreaterThanOrEqual(1);
  expect(keyframes.at(-1)!.offset).toBe(at);

  // Subscribing from the version starts at that keyframe.
  const replayed: EventFrame[] = [];
  const subscribed = await gateway.subscribe('ticks', 'replay', at, (frame) => replayed.push(frame));
  expect(subscribed.startOffset).toBe(at);
  for (let waited = 0; replayed.length === 0 && waited < 3000; waited += 20) await sleep(20);
  const first = decodeTick(replayed[0]!.payload);
  expect([replayed[0]!.offset, first.keyframe, first.matchNumber, first.tick]).toEqual([at, true, match, tick]);

  // The match's first tick wrote `match/<n>`, at or before the keyframe.
  const start = await gateway.stateGet('ticks', `match/${match}`);
  expect(start.version, `match/${match} is missing; was the sim started before this build?`).not.toBeNull();
  expect(start.version!).toBeLessThanOrEqual(at);
  expect(header(start.payload!).match).toBe(match);
  const none = await gateway.stateGet('ticks', `match/${match + 1000}`);
  expect([none.payload, none.version]).toEqual([null, null]);
  gateway.close();
}, 20_000);
