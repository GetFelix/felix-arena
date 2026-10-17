// A screenshot of the offline game just after your craft respawns, under its spawn shield. The page plays as itself
// and flies at the nearest enemy without firing, so the bots destroy it; once it is back, the page grows to 1920x1080
// and the shot is taken while the shield is still up. `respawn-close.png` is the part of it around the craft.
// Usage: npx vite-node scripts/respawn-shot.ts -- <play page url> <out dir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import pngjs from 'pngjs';
import type { ArenaDebug } from '../src/play';

const [base, out] = process.argv.slice(2).filter((arg) => arg !== '--');
if (!base || !out) throw new Error('usage: respawn-shot.ts <play page url> <out dir>');
const LIMIT_MS = 8 * 60_000;
/** Software rendering at 1920x1080 takes many seconds a frame on a CI runner. */
const SHOT_TIMEOUT_MS = 240_000;
mkdirSync(out, { recursive: true });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Arena = Pick<ArenaDebug, 'slot' | 'own' | 'crafts'>;

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errors: string[] = [];
// Small while it waits, so the software renderer leaves the page's own sim its time.
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${base}?offline&quality=high&warmup=2`, { waitUntil: 'load' });
await page.waitForSelector('#loading', { state: 'detached', timeout: 180_000 });

const arena = (): Promise<Arena> =>
  page.evaluate(() => {
    const a = window.arena!;
    return { slot: a.slot, own: a.own, crafts: a.crafts };
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

const started = Date.now();
let died = false;
let shot = false;
while (!shot && Date.now() - started < LIMIT_MS) {
  const a = await arena();
  const me = a.crafts.find((c) => c.slot === a.slot);
  if (me && !me.alive && !died) {
    died = true;
    console.log(`${((Date.now() - started) / 1000).toFixed(0)} s: destroyed`);
  }
  if (died && me?.alive && me.protected) {
    for (const key of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) await page.keyboard.up(key);
    console.log(`${((Date.now() - started) / 1000).toFixed(0)} s: respawned at (${me.x}, ${me.z}), protected`);
    await page.setViewportSize({ width: 1920, height: 1080 });
    const at = await page.evaluate(([x, z]) => window.arena!.screenOf(x!, z!), [me.x, me.z]);
    await page.screenshot({ path: join(out, 'respawn.png'), timeout: SHOT_TIMEOUT_MS });
    const full = pngjs.PNG.sync.read(readFileSync(join(out, 'respawn.png')));
    const [w, h] = [480, 270];
    const close = new pngjs.PNG({ width: w, height: h });
    const left = Math.round(Math.min(Math.max(at.x - w / 2, 0), full.width - w));
    const top = Math.round(Math.min(Math.max(at.y - h / 2, 0), full.height - h));
    pngjs.PNG.bitblt(full, close, left, top, w, h, 0, 0);
    writeFileSync(join(out, 'respawn-close.png'), pngjs.PNG.sync.write(close));
    const after = (await arena()).crafts.find((c) => c.slot === a.slot);
    console.log(`saved respawn.png; still protected after the shot: ${after?.protected}`);
    const enemies = a.crafts.filter((c) => c.alive && c.violet !== me.violet);
    console.log(
      'enemies at',
      enemies.map(
        (c) => `(${c.x.toFixed(0)}, ${c.z.toFixed(0)}) ${(Math.hypot(c.x - me.x, c.z - me.z) / 100).toFixed(1)} m`,
      ),
    );
    shot = true;
    break;
  }
  if (!died) await charge(a);
  await sleep(100);
}
await browser.close();
if (errors.length) throw new Error(errors.join('\n'));
if (!shot) throw new Error(died ? 'the craft did not come back protected' : 'the craft was never destroyed');
process.exit(0);
