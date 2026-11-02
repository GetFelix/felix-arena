// A page too far behind rejoins from the keyframe (docs/design.md, "Failure modes"), through the dev stack: ana and
// three bots play a match, and `cleo` watches it on a link slowed below the rate of the ticks. Her page must fall
// behind, join again from the keyframe and say "Connection poor"; once the slowdown is lifted she must catch up and
// hold, tick for tick, the same state as ana.
// Usage: npx vite-node scripts/resync.ts -- <play page url>
import { readFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { loadCore } from '../src/core';
import type { ArenaDebug } from '../src/play';
import { bot } from './bot';

const [base] = process.argv.slice(2).filter((arg) => arg !== '--');
if (!base) throw new Error('usage: resync.ts <play page url>');
const ARENA = 'alpha';
/** Ticks both pages must have folded since the slowdown ended, for a comparison worth the name. */
const MIN_COMPARED = 60;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
loadCore(readFileSync(new URL('../src/core/felix_arena_core_bg.wasm', import.meta.url)));

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errors: string[] = [];
const open = async (user: string, query = ''): Promise<Page> => {
  const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${user}: ${String(e)}`));
  await page.goto(`${base}?arena=${ARENA}&as=${user}&quality=low${query}`, { waitUntil: 'load' });
  await page.waitForSelector('#loading', { state: 'detached', timeout: 180_000 });
  return page;
};
type Seen = Pick<ArenaDebug, 'resyncs' | 'behindTicks' | 'states' | 'newestTick' | 'match'> & { where: string };
const seen = (page: Page): Promise<Seen> =>
  page.evaluate(() => {
    const a = window.arena!;
    const { resyncs, behindTicks, newestTick, match } = a;
    return {
      resyncs,
      behindTicks,
      newestTick,
      match,
      states: { ...a.states },
      where: document.getElementById('where')!.textContent!,
    };
  });
const until = async (what: string, page: Page, done: (s: Seen) => boolean, seconds: number): Promise<Seen> => {
  for (let waited = 0; ; waited += 250) {
    const s = await seen(page);
    if (done(s)) return s;
    if (waited > seconds * 1000) throw new Error(`${what}: ${JSON.stringify({ ...s, states: undefined })}`);
    await sleep(250);
  }
};

const ana = await open('ana');
const stopBots = await Promise.all(['ben', 'dan', 'eve'].map((user) => bot(user, ARENA)));
await until('the match did not start', ana, (s) => s.match?.phase === 'playing', 120);

// Slowed from the start: 16 kbit/s is below the 40 kbit/s four players' ticks need.
const cleo = await open('cleo', '&throttle=16');
let poor = false;
const slow = await until(
  'cleo never rejoined from the keyframe',
  cleo,
  (s) => {
    poor ||= s.where === 'Connection poor';
    return s.resyncs >= 1 && poor;
  },
  90,
);
console.log(
  `slowed: ${slow.resyncs} resyncs, ${slow.behindTicks.toFixed(1)} ticks behind, the page says "${slow.where}"`,
);

await cleo.evaluate(() => window.arena!.throttle(null));
const lifted = await seen(ana);
const back = await until(
  'cleo did not catch up once the slowdown was lifted',
  cleo,
  (s) => s.behindTicks < 3 && s.where !== 'Connection poor',
  60,
);
console.log(
  `lifted: ${back.resyncs} resyncs, ${back.behindTicks.toFixed(1)} ticks behind, the page says "${back.where}"`,
);

// Compare every tick both pages folded after the slowdown ended.
let common: string[] = [];
let watcher!: Seen;
let player!: Seen;
for (let waited = 0; ; waited += 250) {
  [watcher, player] = await Promise.all([seen(cleo), seen(ana)]);
  common = Object.keys(watcher.states).filter((at) => at in player.states && !(at in lifted.states));
  if (common.length >= MIN_COMPARED) break;
  if (waited > 60_000) throw new Error(`only ${common.length} ticks to compare since the slowdown ended`);
  await sleep(250);
}
const differing = common.filter((at) => watcher.states[at] !== player.states[at]);
for (const stop of stopBots) stop();
await browser.close();
if (differing.length > 0) {
  const at = differing[0]!;
  throw new Error(`${differing.length} of ${common.length} ticks differ, first ${at}:
  cleo ${watcher.states[at]}
  ana  ${player.states[at]}`);
}
if (errors.length) throw new Error(errors.join('\n'));
console.log(`cleo's state matched ana's on all ${common.length} ticks since the slowdown ended.`);
process.exit(0);
