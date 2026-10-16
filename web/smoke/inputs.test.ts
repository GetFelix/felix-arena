// Against a running dev stack (dev/up.sh): two players drive their own crafts
// through the gateway's input stream, a forged input claiming to be the other
// player moves nothing, and a watcher cannot publish inputs at all.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { decodeTick, Inputs, loadCore, playerKey, type Tick } from '../src/core';
import { Gateway } from '../src/gateway';

const GATEWAY = process.env.ARENA_GATEWAY ?? 'ws://127.0.0.1:8787/ws';
const IDP = process.env.ARENA_IDP ?? 'http://127.0.0.1:9400';
const ENGINE = process.env.CONTAINER_ENGINE ?? 'docker';
// Not the arena the tick smoke watches, so the two can run side by side.
const ARENA = 'bravo';
const FIRE = 1;
const ANA_AIM = 16384;
const BEN_AIM = 0;
const FORGED_AIM = 49152;

beforeAll(() => loadCore(readFileSync(new URL('../src/core/felix_arena_core_bg.wasm', import.meta.url))));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function signIn(user: string): Promise<string> {
  const answer = await fetch(`${IDP}/token?sub=${user}&aud=felix-arena`);
  return ((await answer.json()) as { id_token: string }).id_token;
}

/** The Felix principal of a dev IdP user: hex SHA-256 of `issuer|subject`, as dev/seed.mjs grants it. */
async function principal(user: string): Promise<string> {
  const { issuer } = (await (await fetch(`${IDP}/.well-known/openid-configuration`)).json()) as { issuer: string };
  return createHash('sha256').update(`${issuer}|${user}`).digest('hex');
}

/** `payload` behind a sender stamp of `principal`, as the gateway writes one. */
function stamped(principal: string, payload: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(principal);
  const out = new Uint8Array(2 + name.length + payload.length);
  new DataView(out.buffer).setUint16(0, name.length);
  out.set(name, 2);
  out.set(payload, 2 + name.length);
  return out;
}

/** How many inputs the sim refused in `arena`, summed over its reports so far. */
function refusedInputs(arena: string): number {
  const logs = execFileSync(ENGINE, ['compose', '-f', '../dev/compose.yml', 'logs', '--no-color', 'sim'], {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  let refused = 0;
  for (const [, name, count] of logs.matchAll(/ticks committed arena="?([\w-]+)"? .*inputs_refused=(\d+)/g)) {
    if (name === arena) refused += Number(count);
  }
  return refused;
}

it('each player moves only its own craft, and a watcher cannot send inputs', async () => {
  const [anaKey, benKey] = [playerKey(await principal('ana')), playerKey(await principal('ben'))];
  const anaPrincipal = await principal('ana');
  const ana = await Gateway.connect(GATEWAY, ARENA, await signIn('ana'));
  const ben = await Gateway.connect(GATEWAY, ARENA, await signIn('ben'));
  const cleo = await Gateway.connect(GATEWAY, ARENA, await signIn('cleo'));
  expect(ana.missing).toEqual([]);
  expect(cleo.missing).toContain('input');

  const ticks: Tick[] = [];
  await cleo.subscribe('ticks', 'live', 'live', (frame) => ticks.push(decodeTick(frame.payload)));
  const roster = () => [...ticks].reverse().find((tick) => tick.keyframe)?.players ?? [];
  const craftOf = (tick: Tick, key: string) => {
    const slot = roster().find((player) => player.key === key)?.slot;
    return tick.crafts.find((craft) => craft.slot === slot);
  };

  // The sim's log outlives a run, so count the refusals this run adds.
  const refusedBefore = refusedInputs(ARENA);
  const anaInputs = new Inputs(1);
  const benInputs = new Inputs(20_000);
  const forged = new Inputs(40_000);
  // Toward the centre, once the roster says which side each player is on.
  let anaMove = 0;
  const drive = setInterval(() => {
    ana.send('input', anaInputs.next(anaMove, 0, ANA_AIM, 0));
    ben.send('input', benInputs.next(0, 0, BEN_AIM, 0));
    // A stamp of ana's in ben's payload: the gateway stamps ben in front of it.
    ben.send('input', stamped(anaPrincipal, forged.next(-anaMove || 127, 0, FORGED_AIM, FIRE)));
  }, 33);

  for (let waited = 0; roster().length < 2 && waited < 5000; waited += 50) await sleep(50);
  const anaPlayer = roster().find((player) => player.key === anaKey)!;
  expect(anaPlayer).toBeTruthy();
  const anaStart = craftOf(ticks.at(-1)!, anaKey)!.x;
  anaMove = anaPlayer.violet ? -127 : 127;
  const from = ticks.length;
  await sleep(2000);
  clearInterval(drive);

  const keys = roster().map((player) => player.key);
  expect(keys.sort()).toEqual([anaKey, benKey].sort());
  const driven = ticks.slice(from);
  expect(driven.length).toBeGreaterThan(40);
  for (const tick of driven) {
    const [anaCraft, benCraft] = [craftOf(tick, anaKey)!, craftOf(tick, benKey)!];
    expect(anaCraft.heading).not.toBe(FORGED_AIM);
    expect(anaCraft.lastInput).toBeLessThan(20_000);
    expect(benCraft.heading).toBe(BEN_AIM);
    expect(benCraft.lastInput).toBeGreaterThanOrEqual(20_000);
    expect(benCraft.lastInput).toBeLessThan(40_000);
  }
  const last = driven.at(-1)!;
  const anaCraft = craftOf(last, anaKey)!;
  expect(anaCraft.heading).toBe(ANA_AIM);
  expect(anaCraft.lastInput).toBeGreaterThan(anaInputs.seq - 15);
  expect(anaCraft.health).toBe(100);
  const moved = (anaCraft.x - anaStart) * Math.sign(anaMove);
  console.log(`ana moved ${moved} cm toward the centre; ben's forged inputs moved nothing`);
  expect(moved).toBeGreaterThan(200);

  await expect(cleo.publish('input', anaInputs.next(0, 0, 0, 0))).rejects.toThrow();

  // The sim saw the forged records and refused them. It reports every 5 s.
  let refused = 0;
  for (let waited = 0; refused === 0 && waited < 8000; waited += 500) {
    refused = refusedInputs(ARENA) - refusedBefore;
    if (refused === 0) await sleep(500);
  }
  expect(refused).toBeGreaterThan(0);
  for (const gateway of [ana, ben, cleo]) gateway.close();
}, 30_000);
