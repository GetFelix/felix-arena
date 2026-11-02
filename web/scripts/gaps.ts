// A client that loses ticks, through the dev stack (docs/design.md, "Failure modes"). Ana plays with three bots
// and cleo watches the same match through a page that discards every seventh live tick on arrival, as a subscriber
// whose queue overflowed would lose them. Cleo reads the missing ticks back from the log, so every tick both pages
// folded must come out the same on both, and every kill ana saw after cleo joined must be on cleo's list too.
// Usage: npx vite-node scripts/gaps.ts -- <play page url> [seconds]
import { readFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { loadCore } from '../src/core';
import type { ArenaDebug } from '../src/play';
import { bot } from './bot';

const [base, seconds = '90'] = process.argv.slice(2).filter((arg) => arg !== '--');
if (!base) throw new Error('usage: gaps.ts <play page url> [seconds]');
const ARENA = 'alpha';
const RUN_MS = Number(seconds) * 1000;
/** Every this-many-th tick cleo's page loses. */
const LOSE = 7;
/** Ticks both pages must have folded, and kills both must have seen, for a comparison worth the name. */
const MIN_COMPARED = 600;
const MIN_KILLS = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
loadCore(readFileSync(new URL('../src/core/felix_arena_core_bg.wasm', import.meta.url)));

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errors: string[] = [];
const open = async (user: string, extra = ''): Promise<Page> => {
  const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${user}: ${String(e)}`));
  await page.goto(`${base}?arena=${ARENA}&as=${user}&quality=low${extra}`, { waitUntil: 'load' });
  await page.waitForSelector('#loading', { state: 'detached', timeout: 180_000 });
  return page;
};
type Seen = Pick<ArenaDebug, 'states' | 'match' | 'gaps'> & { kills: { match: number; tick: number }[] };
const seen = (page: Page): Promise<Seen> =>
  page.evaluate(() => {
    const a = window.arena!;
    return {
      states: { ...a.states },
      match: a.match,
      gaps: { ...a.gaps },
      kills: a.kills.map((k) => ({ match: k.match, tick: k.tick })),
    };
  });

const ana = await open('ana');
const stopBots = await Promise.all(['ben', 'dan', 'eve'].map((user) => bot(user, ARENA)));
for (let waited = 0; (await seen(ana)).match?.phase !== 'playing'; waited += 500) {
  if (waited > 120_000) throw new Error(`the match did not start: ${JSON.stringify((await seen(ana)).match)}`);
  await sleep(500);
}
const cleo = await open('cleo', `&lose=${LOSE}`);

const compared = new Set<string>();
const differing: string[] = [];
const kills = new Map<string, boolean>();
let first: { match: number; tick: number } | null = null;
const key = (k: { match: number; tick: number }) => `${k.match}:${k.tick}`;
/** Whether `k` happened after cleo joined, in this match or a later one. */
const after = (k: { match: number; tick: number }) =>
  first !== null && (k.match > first.match || (k.match === first.match && k.tick >= first.tick));
async function sample(): Promise<Seen> {
  const [watcher, player] = await Promise.all([seen(cleo), seen(ana)]);
  first ??= {
    match: watcher.match?.number ?? 0,
    tick: Math.min(...Object.keys(watcher.states).map((at) => Number(at.split('/')[1]))),
  };
  for (const at of Object.keys(watcher.states).filter((at) => at in player.states)) {
    compared.add(at);
    if (watcher.states[at] !== player.states[at] && !differing.includes(at)) differing.push(at);
  }
  const theirs = new Set(watcher.kills.map(key));
  const ours = new Set(player.kills.map(key));
  for (const k of player.kills) if (after(k)) kills.set(key(k), theirs.has(key(k)));
  for (const k of watcher.kills) if (!ours.has(key(k))) kills.set(key(k), false);
  return watcher;
}
const started = Date.now();
while (Date.now() - started < RUN_MS) {
  await sleep(10_000);
  await sample();
}
// A kill in the last moments may have reached one page before the other: let both settle, then judge once more.
await sleep(2000);
const watcher = await sample();
for (const stop of stopBots) stop();
await browser.close();

const missing = [...kills].filter(([, held]) => !held).map(([k]) => k);
console.log(`cleo lost every ${LOSE}th live tick:`, watcher.gaps);
console.log(
  `${compared.size} ticks compared, ${differing.length} differ; ${kills.size} kills, ${missing.length} not on both lists`,
);
if (errors.length) throw new Error(errors.join('\n'));
if (watcher.gaps.missed < 20) throw new Error(`cleo lost only ${watcher.gaps.missed} ticks`);
if (watcher.gaps.unfilled > watcher.gaps.missed / 50) {
  throw new Error(`${watcher.gaps.unfilled} of ${watcher.gaps.missed} lost ticks could not be read back`);
}
if (compared.size < MIN_COMPARED) throw new Error(`only ${compared.size} ticks to compare`);
if (differing.length > 0) throw new Error(`${differing.length} ticks folded differently, first ${differing[0]}`);
if (kills.size < MIN_KILLS) throw new Error(`only ${kills.size} kills to compare`);
if (missing.length > 0) throw new Error(`kills not on both lists: ${missing.join(', ')}`);
process.exit(0);
