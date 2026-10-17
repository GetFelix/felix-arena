// Screenshots of the kill cam, for review: the page flies at the nearest enemy without firing until it is destroyed,
// and once its replay plays the page grows to 1920x1080, holds the replay a moment before the kill and takes it in
// each view. With `?offline` in the URL it plays the page's own sim; otherwise two bots join the arena through the
// dev stack to do the destroying.
// Usage: npx vite-node scripts/killcam-shot.ts -- <play page url with its query> <out dir> [GPU]
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { loadCore } from '../src/core';
import type { ArenaDebug } from '../src/play';
import { bot } from './bot';

const [url, out, gpu] = process.argv.slice(2).filter((arg) => arg !== '--');
if (!url || !out) throw new Error('usage: killcam-shot.ts <play page url> <out dir> [GPU]');
const LIMIT_MS = 6 * 60_000;
const SHOT_TIMEOUT_MS = 240_000;
mkdirSync(out, { recursive: true });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Arena = Pick<ArenaDebug, 'slot' | 'own' | 'crafts' | 'killcam' | 'replayAt'>;

const browser = await chromium.launch({
  args: gpu ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errors: string[] = [];
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url, { waitUntil: 'load' });
await page.waitForSelector('#loading', { state: 'detached', timeout: 180_000 });

const arena = (): Promise<Arena> =>
  page.evaluate(() => {
    const a = window.arena!;
    return { slot: a.slot, own: a.own, crafts: a.crafts, killcam: a.killcam, replayAt: a.replayAt };
  });

/** Holds the keys that move toward the nearest enemy on screen. */
async function charge(a: Arena): Promise<void> {
  for (const key of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) await page.keyboard.up(key);
  const me = a.crafts.find((c) => c.slot === a.slot);
  if (!a.own || !me?.alive) return;
  const own = a.own;
  const enemy = a.crafts
    .filter((c) => c.alive && c.violet !== me.violet)
    .sort((p, q) => Math.hypot(p.x - own.x, p.z - own.z) - Math.hypot(q.x - own.x, q.z - own.z))[0];
  if (!enemy) return;
  const [from, to] = await page.evaluate(
    ([x, z, ex, ez]) => [window.arena!.screenOf(x!, z!), window.arena!.screenOf(ex!, ez!)],
    [own.x, own.z, enemy.x, enemy.z],
  );
  const [sx, sy] = [to!.x - from!.x, to!.y - from!.y];
  const size = Math.hypot(sx, sy) || 1;
  if (sx / size > 0.38) await page.keyboard.down('KeyD');
  if (sx / size < -0.38) await page.keyboard.down('KeyA');
  if (sy / size > 0.38) await page.keyboard.down('KeyS');
  if (sy / size < -0.38) await page.keyboard.down('KeyW');
}

const stopBots: (() => void)[] = [];
if (!url.includes('offline')) {
  loadCore(readFileSync(new URL('../src/core/felix_arena_core_bg.wasm', import.meta.url)));
  const arenaName = new URL(url).searchParams.get('arena') ?? 'alpha';
  stopBots.push(...(await Promise.all(['dan', 'eve'].map((user) => bot(user, arenaName)))));
}
const started = Date.now();
let a = await arena();
while (Date.now() - started < LIMIT_MS) {
  a = await arena();
  if (a.replayAt && a.replayAt.r >= a.replayAt.kill - 6) break;
  if (a.killcam === 'off') await charge(a);
  await sleep(a.killcam === 'off' ? 150 : 10);
}
if (!a.replayAt) throw new Error(`no replay played: ${a.killcam}`);
await page.evaluate(() => {
  window.arena!.holdReplay(true);
  window.arena!.pause?.(true);
});
for (const key of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) await page.keyboard.up(key);
await page.setViewportSize({ width: 1920, height: 1080 });
for (const [key, name] of [
  ['Digit1', 'victim'],
  ['Digit2', 'killer'],
  ['Digit3', 'orbit'],
] as const) {
  await page.keyboard.press(key);
  // The camera eases into the view.
  await sleep(gpu ? 1500 : 20_000);
  await page.screenshot({ path: join(out, `${name}.png`), timeout: SHOT_TIMEOUT_MS });
  console.log(`saved ${name}.png`, JSON.stringify(await page.evaluate(() => window.arena!.replayAt)));
}
console.log(JSON.stringify(await page.evaluate(() => window.arena!.killcams), null, 1));
for (const stop of stopBots) stop();
await browser.close();
if (errors.length) throw new Error(errors.join('\n'));
