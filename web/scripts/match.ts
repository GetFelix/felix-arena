// A whole match through the dev stack: ana and ben play in two headless browsers with the keyboard and mouse,
// two bots (dan and eve) make it two a side through the gateway, and the match must run from warmup through play
// and results into the next match's warmup. Screenshots of the live game and the results go to `out`, at 1920x1080.
// The sim must run a short match (SIM_* settings); see the `match` job in CI.
// Usage: npx vite-node scripts/match.ts -- <play page url> <out dir>
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { loadCore } from '../src/core';
import type { ArenaDebug } from '../src/play';
import { bot, botSlots } from './bot';

const [base, out] = process.argv.slice(2).filter((arg) => arg !== '--');
if (!base || !out) throw new Error('usage: match.ts <play page url> <out dir>');
const ARENA = 'alpha';
const LIMIT_MS = 9 * 60_000;
/** Software rendering at 1920x1080 takes many seconds a frame on a CI runner. */
const SHOT_TIMEOUT_MS = 240_000;
mkdirSync(out, { recursive: true });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Arena = Pick<ArenaDebug, 'slot' | 'own' | 'match' | 'crafts' | 'phases'>;

loadCore(readFileSync(new URL('../src/core/felix_arena_core_bg.wasm', import.meta.url)));

async function arena(page: Page): Promise<Arena> {
  return page.evaluate(() => {
    const a = window.arena!;
    return { slot: a.slot, own: a.own, match: a.match, crafts: a.crafts, phases: a.phases };
  });
}

/** Plays one browser for a moment: aim at the nearest enemy, close in, circle and fire, or take the rail. */
async function play(page: Page, a: Arena, circle: number): Promise<void> {
  const { own, crafts, match } = a;
  const me = crafts.find((c) => c.slot === a.slot);
  for (const key of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) await page.keyboard.up(key);
  if (!own || !me?.alive || match?.phase === 'results') {
    await page.mouse.up();
    return;
  }
  const enemy = crafts
    .filter((c) => c.alive && c.violet !== me.violet)
    .sort((p, q) => Math.hypot(p.x - own.x, p.z - own.z) - Math.hypot(q.x - own.x, q.z - own.z))[0];
  const goal = match?.railIn === 0 && a.slot === 0 ? { x: 0, z: 0 } : enemy;
  if (!goal) return;
  const [dx, dz] = [goal.x - own.x, goal.z - own.z];
  const distance = Math.hypot(dx, dz);
  const closing = goal === enemy ? (distance > 1000 ? 1 : distance < 500 ? -0.6 : 0) : 1;
  const [wx, wz] = [dx * closing - dz * circle, dz * closing + dx * circle];
  // Which keys move that way on screen: compare where a step that way lands.
  const [from, to, aim] = await page.evaluate(
    ([x, z, sx, sz, ex, ez]) => [
      window.arena!.screenOf(x!, z!),
      window.arena!.screenOf(x! + sx!, z! + sz!),
      window.arena!.screenOf(ex!, ez!),
    ],
    [
      own.x,
      own.z,
      (wx / (Math.hypot(wx, wz) || 1)) * 300,
      (wz / (Math.hypot(wx, wz) || 1)) * 300,
      enemy?.x ?? 0,
      enemy?.z ?? 0,
    ],
  );
  const [sx, sy] = [to!.x - from!.x, to!.y - from!.y];
  const size = Math.hypot(sx, sy) || 1;
  if (sx / size > 0.38) await page.keyboard.down('KeyD');
  if (sx / size < -0.38) await page.keyboard.down('KeyA');
  if (sy / size > 0.38) await page.keyboard.down('KeyS');
  if (sy / size < -0.38) await page.keyboard.down('KeyW');
  await page.mouse.move(aim!.x, aim!.y);
  if (enemy && distance < 2000) await page.mouse.down();
  else await page.mouse.up();
}

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errors: string[] = [];
const open = async (user: string, quality: string, width: number, height: number) => {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => errors.push(`${user}: ${String(e)}`));
  // The page draws its first frame before it joins, which can hold it past the load event on a software renderer;
  // #loading going away is what says it joined.
  await page.goto(`${base}?arena=${ARENA}&as=${user}${quality}`, { waitUntil: 'domcontentloaded' });
  return page;
};
// Ana's page draws at full quality and full size for the screenshots, slowly on a runner's software renderer; her
// inputs still go out on the page's timer. Ben's draws lean, to spare the CPU.
const ana = await open('ana', '&quality=high', 1920, 1080);
const ben = await open('ben', '&quality=low', 480, 270);
for (const page of [ana, ben]) await page.waitForSelector('#loading', { state: 'detached', timeout: 180_000 });
const stopBots = await Promise.all(['dan', 'eve'].map((user) => bot(user, ARENA)));

/** The screenshots, at 1920x1080. */
async function shoot(name: string): Promise<void> {
  await ana.screenshot({ path: join(out!, name), timeout: SHOT_TIMEOUT_MS });
  console.log(`saved ${name}`);
}

let seen: string[] = [];
let shotLive = false;
/** Every slot seen flying, and the most kills seen in a match. */
const players = new Set<number>();
let scored = 0;
let shotResults = false;
let done = false;
const started = Date.now();
while (!done && Date.now() - started < LIMIT_MS) {
  const [a, b] = await Promise.all([arena(ana), arena(ben)]);
  const m = a.match;
  if (a.phases.length > seen.length) {
    for (const phase of a.phases.slice(seen.length)) {
      console.log(
        `${((Date.now() - started) / 1000).toFixed(0)} s: match ${phase.replace(':', ' ')}, ${m?.scores.join(' to ')}`,
      );
    }
    seen = a.phases;
  }
  if (m) {
    // The results first, as they last the shortest; then the live game, once someone has scored or late on.
    if (m.phase === 'results' && !shotResults) {
      await shoot('results.png');
      const after = await arena(ana);
      // A slow render can outlast the results; the picture must still be of them.
      if (after.match?.phase !== 'results' || after.match.number !== m.number) {
        throw new Error(`the results ended before their screenshot was taken: ${after.match?.phase}`);
      }
      shotResults = true;
    } else if (
      m.phase === 'playing' &&
      !shotLive &&
      m.seconds < 80 &&
      (m.scores[0] + m.scores[1] > 0 || m.seconds < 60)
    ) {
      await shoot('live.png');
      shotLive = true;
    }
    const first = seen.findIndex((s) => s.endsWith(':playing'));
    const number = first >= 0 ? Number(seen[first]!.split(':')[0]) : NaN;
    done = seen.includes(`${number}:results`) && seen.includes(`${number + 1}:warmup`) && shotResults && shotLive;
  }
  for (const c of a.crafts) players.add(c.slot);
  if (m) scored = Math.max(scored, m.scores[0] + m.scores[1]);
  await Promise.all([play(ana, a, 0.8), play(ben, b, -0.8)]);
  await sleep(120);
}

const who = async (page: Page) =>
  page.evaluate(() => ({
    slot: window.arena!.slot,
    ticks: window.arena!.ticks,
    reconnects: window.arena!.reconnects,
    hidden: document.hidden,
  }));
console.log('ana:', await who(ana), 'ben:', await who(ben), 'bots:', Object.fromEntries(botSlots));
const board = await ana.evaluate(() => ({
  title: document.getElementById('board-title')?.textContent,
  coral: document.getElementById('board-coral-players')?.textContent,
  violet: document.getElementById('board-violet-players')?.textContent,
}));
for (const stop of stopBots) stop();
await browser.close();
console.log('phases:', seen.join(' → '));
console.log('last scoreboard:', board);
if (errors.length) throw new Error(errors.join('\n'));
if (!done) throw new Error(`the match did not run from play through results to the next warmup: ${seen.join(', ')}`);
if (!shotLive || !shotResults) throw new Error('a screenshot is missing');
console.log(`${players.size} crafts flew, ${scored} kills in the match`);
if (players.size < 4) throw new Error(`only ${players.size} crafts joined; the bots should make four`);
if (scored === 0) throw new Error('nobody was destroyed in the whole match');
process.exit(0);
