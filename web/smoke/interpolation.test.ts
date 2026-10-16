// Against a running dev stack (dev/up.sh): ana flies circles in arena alpha while cleo watches through the gateway.
// Cleo's ticks, with the times they really arrived, are played through the interpolator at 60 frames a second with
// one tick in twenty thrown away, and every frame is checked against all the ticks cleo received.
import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { decodeTick, Inputs, loadCore } from '../src/core';
import { Gateway } from '../src/gateway';
import { snapshot } from '../src/interpolation';
import { type Arrival, measure, oneInTwenty } from '../src/smoothness';

const GATEWAY = process.env.ARENA_GATEWAY ?? 'ws://127.0.0.1:8787/ws';
const IDP = process.env.ARENA_IDP ?? 'http://127.0.0.1:9400';
const ARENA = 'alpha';
const FLY_MS = 8000;

beforeAll(() => loadCore(readFileSync(new URL('../src/core/felix_arena_core_bg.wasm', import.meta.url))));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function signIn(user: string): Promise<string> {
  const answer = await fetch(`${IDP}/token?sub=${user}&aud=felix-arena`);
  return ((await answer.json()) as { id_token: string }).id_token;
}

it('draws a flying craft smoothly with one tick in twenty lost', async () => {
  const ana = await Gateway.connect(GATEWAY, ARENA, await signIn('ana'));
  const cleo = await Gateway.connect(GATEWAY, ARENA, await signIn('cleo'));
  const arrivals: Arrival[] = [];
  await cleo.subscribe('ticks', 'live', 'live', (frame) => {
    arrivals.push({ snapshot: snapshot(decodeTick(frame.payload)), arrivedMs: frame.receivedUs / 1000 });
  });

  const inputs = new Inputs(1);
  let angle = 0;
  const fly = setInterval(() => {
    angle += 0.15;
    const aim = Math.round((angle / (2 * Math.PI)) * 65536) & 0xffff;
    ana.send('input', inputs.next(Math.round(Math.cos(angle) * 127), Math.round(Math.sin(angle) * 127), aim, 0));
  }, 1000 / 30);
  await sleep(FLY_MS);
  clearInterval(fly);
  ana.close();
  cleo.close();

  // Felix or the sim may have skipped a tick of its own; losses are only added where the ticks around are whole, so
  // no gap grows past what the interpolator bridges.
  const truth = arrivals.map((a) => a.snapshot);
  const whole = (i: number) =>
    [-2, -1, 0, 1, 2, 3].every((d) => {
      const [a, b] = [truth[i + d - 1], truth[i + d]];
      return !a || !b || b.tick === a.tick + 1;
    });
  const pick = oneInTwenty(arrivals.length);
  const lose = (i: number) => pick(i) && whole(i);
  const speeds = truth.flatMap((s) => s.crafts.map((c) => Math.hypot(c.vx, c.vz)));
  expect(Math.max(...speeds)).toBeGreaterThan(600);
  const run = measure(arrivals, lose, truth);
  console.log(`${arrivals.length} ticks through the gateway, one in twenty lost:`, run);
  expect(run.lost).toBeGreaterThan(arrivals.length / 25);
  expect(run.frames).toBeGreaterThan(300);
  expect(run.stalls).toBe(0);
  // A runner that holds the socket up for over 100 ms starves any interpolator; that may happen, but rarely.
  expect(run.starved).toBeLessThan(run.frames / 50);
  expect(run.maxJump).toBeLessThan(4);
  expect(run.maxError).toBeLessThan(40);
}, 30_000);
