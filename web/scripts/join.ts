// Cold spectators joining mid-match: ana plays in a headless browser with three bots, and once the match is being
// played, `cleo` joins it again and again, each time in a fresh browser context with an empty cache. Each join is
// timed step by step; the state read, the first event and the catch-up fold together must stay within the target at
// p50, the first frame must be the match as it was, and every tick both pages folded must come out the same on both.
// Usage: npx vite-node scripts/join.ts -- <play page url> [joins]
import { readFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { loadCore } from '../src/core';
import type { ArenaDebug } from '../src/play';
import { bot } from './bot';

const [base, runs = '10'] = process.argv.slice(2).filter((arg) => arg !== '--');
if (!base) throw new Error('usage: join.ts <play page url> [joins]');
const ARENA = 'alpha';
const JOINS = Number(runs);
const TARGET_P50_MS = 500;
/** Ticks both pages must have folded, for a comparison worth the name. */
const MIN_COMPARED = 30;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
loadCore(readFileSync(new URL('../src/core/felix_arena_core_bg.wasm', import.meta.url)));

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errors: string[] = [];
const open = async (user: string): Promise<Page> => {
  // A context of its own: no cache, no storage, as a first visit.
  const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${user}: ${String(e)}`));
  await page.goto(`${base}?arena=${ARENA}&as=${user}&quality=low`, { waitUntil: 'load' });
  return page;
};
type Seen = Pick<ArenaDebug, 'join' | 'states' | 'match' | 'ticks' | 'newestTick'> & { atUnixMs: number };
const seen = (page: Page): Promise<Seen> =>
  page.evaluate(() => {
    const a = window.arena!;
    const { join, match, ticks, newestTick } = a;
    return { join, states: { ...a.states }, match, ticks, newestTick, atUnixMs: Date.now() };
  });
/** How far behind the live match a first frame may be, in ticks: a keyframe interval plus a little. */
const STALE_TICKS = 45;

const ana = await open('ana');
await ana.waitForSelector('#loading', { state: 'detached', timeout: 180_000 });
const stopBots = await Promise.all(['ben', 'dan', 'eve'].map((user) => bot(user, ARENA)));
for (let waited = 0; (await seen(ana)).match?.phase !== 'playing'; waited += 500) {
  if (waited > 120_000) throw new Error(`the match did not start: ${JSON.stringify((await seen(ana)).match)}`);
  await sleep(500);
}

const rows: {
  stateGet: number;
  firstEvent: number;
  fold: number;
  path: number;
  signIn: number;
  draw: number;
  catchUp: number;
  behind: number;
  compared: number;
  score: string;
}[] = [];
for (let i = 0; i < JOINS; i++) {
  const cleo = await open('cleo');
  let joined: Seen | null = null;
  for (let waited = 0; !joined?.join?.drawnMs; waited += 50) {
    if (waited > 120_000) throw new Error(`cleo's join ${i + 1} drew nothing: ${JSON.stringify(joined?.join)}`);
    await sleep(50);
    joined = await seen(cleo);
  }
  // Let both pages fold a second of live ticks, then compare every tick both have.
  await sleep(1000);
  const [watcher, player] = await Promise.all([seen(cleo), seen(ana)]);
  const common = Object.keys(watcher.states).filter((at) => at in player.states);
  const differing = common.filter((at) => watcher.states[at] !== player.states[at]);
  if (common.length < MIN_COMPARED) throw new Error(`join ${i + 1}: only ${common.length} ticks to compare`);
  if (differing.length > 0) {
    const at = differing[0]!;
    throw new Error(`join ${i + 1}: ${differing.length} of ${common.length} ticks differ, first ${at}:
  cleo ${watcher.states[at]}
  ana  ${player.states[at]}`);
  }
  const j = joined!.join!;
  // The first frame must be the match as it was then: ana's newest tick at that moment, give or take.
  const anaThen = player.newestTick! - Math.round((player.atUnixMs - j.drawnAtUnixMs!) / (1000 / 30));
  if (Math.abs(anaThen - j.drawnTick!) > STALE_TICKS) {
    throw new Error(`join ${i + 1} drew tick ${j.drawnTick} while ana was at about ${anaThen}`);
  }
  const drawnAt = `${Object.keys(watcher.states)[0]?.split('/')[0]}/${j.drawnTick}`;
  if (watcher.states[drawnAt] !== player.states[drawnAt]) {
    throw new Error(`join ${i + 1}'s first frame, ${drawnAt}, is not ana's state at that tick`);
  }
  const r = (ms: number) => Math.round(ms);
  rows.push({
    stateGet: r(j.keyframeMs - j.startMs),
    firstEvent: r(j.firstEventMs! - j.keyframeMs),
    fold: r(j.liveMs! - j.firstEventMs!),
    path: r(j.liveMs! - j.startMs),
    signIn: r(j.startMs - j.signInMs),
    draw: r(j.drawnMs! - j.liveMs!),
    catchUp: j.catchUp,
    behind: anaThen - j.drawnTick!,
    compared: common.length,
    score: `${player.match?.phase} ${player.match?.scores.join('-')}`,
  });
  await cleo.context().close();
}
for (const stop of stopBots) stop();
await browser.close();

console.table(rows);
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};
const steps = ['stateGet', 'firstEvent', 'fold', 'path', 'signIn', 'draw'] as const;
for (const step of steps) {
  const values = rows.map((row) => row[step]);
  console.log(`${step}: p50 ${percentile(values, 50)} ms, p95 ${percentile(values, 95)} ms`);
}
console.log(`Every compared tick matched ana's state (${rows.reduce((n, row) => n + row.compared, 0)} ticks).`);
if (errors.length) throw new Error(errors.join('\n'));
// The gate is the Felix and client path: the state read, the subscription's first event and the catch-up fold.
// Signing in is the IdP's, and drawing on CI's software renderer says nothing about a real GPU.
const path = percentile(
  rows.map((row) => row.path),
  50,
);
if (path >= TARGET_P50_MS) throw new Error(`the join path's p50 is ${path} ms, over ${TARGET_P50_MS} ms`);
process.exit(0);
