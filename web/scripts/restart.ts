// Killing the sim mid-match (docs/design.md, "Failure modes"): two bots play, a spectator watches, the sim's container
// is killed once a kill has been scored and started again. The match must carry on in the next epoch with the same
// match, scores and roster, after a pause under five seconds, with no tick of the old epoch after the new one begins.
// Needs the dev stack with a short warmup. Usage: npx vite-node scripts/restart.ts
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { decodeTick, loadCore } from '../src/core';
import { Gateway } from '../src/gateway';
import { bot } from './bot';

const GATEWAY = process.env.ARENA_GATEWAY ?? 'ws://127.0.0.1:8787/ws';
const IDP = process.env.ARENA_IDP ?? 'http://127.0.0.1:9400';
const ENGINE = process.env.CONTAINER_ENGINE ?? 'docker';
const ARENA = 'alpha';
const MAX_PAUSE_MS = 5000;
/** Ticks of the new epoch to watch, enough to reach a keyframe with the roster in it. */
const WATCH_TICKS = 75;

interface Seen {
  epoch: number;
  tick: number;
  match: number;
  phase: string;
  scores: [number, number];
  /** When the sim began committing the tick, on its clock, in milliseconds. */
  atMs: number;
  roster: { key: string; kills: number; deaths: number }[] | null;
  inputs: number[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
loadCore(readFileSync(new URL('../src/core/felix_arena_core_bg.wasm', import.meta.url)));

const compose = (...args: string[]) =>
  execFileSync(ENGINE, ['compose', '-f', '../dev/compose.yml', ...args], { stdio: 'inherit' });

const token = ((await (await fetch(`${IDP}/token?sub=cleo&aud=felix-arena`)).json()) as { id_token: string }).id_token;
const spectator = await Gateway.connect(GATEWAY, ARENA, token);
const ticks: Seen[] = [];
await spectator.subscribe('ticks', 'live', 'live', (frame) => {
  const tick = decodeTick(frame.payload);
  const players = tick.keyframe ? tick.players : [];
  const timing = tick.timing;
  ticks.push({
    epoch: tick.epoch,
    tick: tick.tick,
    match: tick.matchNumber,
    phase: tick.phase,
    scores: [tick.coralScore, tick.violetScore],
    atMs: Number(timing?.commitStartUs ?? 0) / 1000,
    roster: tick.keyframe ? players.map((p) => ({ key: p.key, kills: p.kills, deaths: p.deaths })) : null,
    inputs: tick.crafts.map((c) => c.lastInput),
  });
  timing?.free();
  for (const p of players) p.free();
  tick.free();
});
const stops = [await bot('dan', ARENA), await bot('ben', ARENA)];

const waitFor = async (what: string, done: () => boolean, ms: number) => {
  for (const start = performance.now(); !done(); await sleep(100)) {
    if (performance.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
  }
};
const newest = () => ticks.at(-1)!;

try {
  // A kill, and a keyframe after it so the roster holds it.
  await waitFor(
    'a kill in a match being played',
    () => ticks.length > 0 && newest().phase === 'playing' && newest().scores[0] + newest().scores[1] > 0,
    180_000,
  );
  const scored = newest().tick;
  await waitFor('a keyframe after the kill', () => newest().roster !== null && newest().tick > scored, 10_000);
  const before = newest();
  console.log(`killing the sim at epoch ${before.epoch}, tick ${before.tick}, scores ${before.scores}`);
  const old = ticks.length;
  compose('kill', 'sim');
  compose('start', 'sim');
  await waitFor('ticks of the next epoch', () => ticks.slice(old).some((t) => t.epoch > before.epoch), 60_000);
  const first = ticks.findIndex((t, i) => i >= old && t.epoch > before.epoch);
  const last = ticks[first - 1]!;
  const resumed = ticks[first]!;
  const pause = resumed.atMs - last.atMs;
  console.log(
    `resumed at epoch ${resumed.epoch}, tick ${resumed.tick} after ${Math.round(pause)} ms, scores ${resumed.scores}`,
  );

  const failures: string[] = [];
  if (pause >= MAX_PAUSE_MS) failures.push(`the pause was ${Math.round(pause)} ms, over ${MAX_PAUSE_MS}`);
  if (resumed.epoch !== before.epoch + 1) failures.push(`the epoch went ${before.epoch} to ${resumed.epoch}`);
  if (resumed.match !== last.match) failures.push(`the match went ${last.match} to ${resumed.match}`);
  if (resumed.tick <= last.tick) failures.push(`the tick numbering went back, ${last.tick} to ${resumed.tick}`);
  if (resumed.phase !== last.phase) failures.push(`the phase went ${last.phase} to ${resumed.phase}`);
  // A kill can land in the ticks between the last one seen and the crash, never lost.
  const [gained, lost] = [
    resumed.scores[0] + resumed.scores[1] - last.scores[0] - last.scores[1],
    resumed.scores.some((s, i) => s < last.scores[i]!),
  ];
  if (lost || gained > 1) failures.push(`the scores went ${last.scores} to ${resumed.scores}`);

  await waitFor(
    'the next keyframe',
    () => ticks.length - first >= WATCH_TICKS && ticks.slice(first).some((t) => t.roster),
    30_000,
  );
  const after = ticks.slice(first);
  if (after.some((t) => t.epoch < resumed.epoch)) failures.push('a tick of the old epoch came after the new one');
  const roster = after.find((t) => t.roster)!.roster!;
  for (const was of before.roster!) {
    const now = roster.find((p) => p.key === was.key);
    if (!now) failures.push(`player ${was.key} is gone from the roster`);
    else if (now.kills < was.kills || now.deaths < was.deaths) failures.push(`player ${was.key} lost its tally`);
  }
  if (roster.length !== before.roster!.length)
    failures.push(`the roster went from ${before.roster!.length} players to ${roster.length}`);
  // The bots keep playing through the restart: their crafts' input numbers move on.
  const moved = after.at(-1)!.inputs.filter((n, i) => n !== after[0]!.inputs[i]).length;
  if (moved < 2) failures.push(`only ${moved} crafts kept taking input after the restart`);
  if (failures.length > 0) throw new Error(failures.join('\n'));
  console.log('the match carried on after the sim restarted');
} finally {
  for (const stop of stops) stop();
  spectator.close();
}
process.exit(0);
