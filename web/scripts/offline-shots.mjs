// Throwaway: screenshots of play.html?offline mid-match, and the style frame. Usage: node offline-shots.mjs <base> <frame url> <out>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [base, frameUrl, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const SEEDED = `window.__seeded = (() => { let a = 1; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();`;

async function frame(w, h, name) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.addInitScript(SEEDED);
  await page.route((u) => u.pathname.endsWith('.html'), async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()).replaceAll('Math.random()', 'window.__seeded()') });
  });
  await page.goto(`${frameUrl}?t=1.2`, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForSelector('#loading', { state: 'detached', timeout: 180_000 });
  await page.evaluate(() => new Promise((r) => { let n = 0; const f = () => (++n >= 4 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
  await page.screenshot({ path: join(out, name), timeout: 240_000 });
  await page.close();
  console.log('saved', name);
}
if (process.env.FRAMES) {
  await frame(1920, 1080, 'style-frame-1920.png');
  await frame(1440, 900, 'style-frame-1440.png');
}

async function play(w, h, prefix, count) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}?offline&warmup=2&length=600`, { waitUntil: 'load' });
  await page.waitForSelector('#loading', { state: 'detached', timeout: 180_000 });
  await page.waitForFunction(() => window.arena?.match?.phase === 'playing' && window.arena.own, null, { timeout: 120_000 });
  const started = Date.now();
  let shots = 0;
  let lastShot = Date.now();
  let aliveSince = Date.now();
  await page.mouse.move(w / 2, h / 2);
  while (shots < count && Date.now() - started < 8 * 60_000) {
    const a = await page.evaluate(() => ({ own: window.arena.own, crafts: window.arena.crafts, slot: window.arena.slot }));
    const me = a.crafts.find((c) => c.slot === a.slot);
    for (const key of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) await page.keyboard.up(key);
    if (!a.own || !me?.alive) { aliveSince = Date.now(); await page.mouse.up(); await new Promise((r) => setTimeout(r, 200)); continue; }
    const enemy = a.crafts.filter((c) => c.alive && c.violet !== me.violet)
      .sort((p, q) => Math.hypot(p.x - a.own.x, p.z - a.own.z) - Math.hypot(q.x - a.own.x, q.z - a.own.z))[0];
    if (!enemy) continue;
    const [dx, dz] = [enemy.x - a.own.x, enemy.z - a.own.z];
    const d = Math.hypot(dx, dz);
    const closing = d > 1000 ? 1 : d < 500 ? -0.6 : 0;
    const [wx, wz] = [dx * closing - dz * 0.8, dz * closing + dx * 0.8];
    const [from, to, aim] = await page.evaluate(([x, z, sx, sz, ex, ez]) => [
      window.arena.screenOf(x, z), window.arena.screenOf(x + sx, z + sz), window.arena.screenOf(ex, ez)],
      [a.own.x, a.own.z, (wx / (Math.hypot(wx, wz) || 1)) * 300, (wz / (Math.hypot(wx, wz) || 1)) * 300,
       enemy.x + (enemy.x - a.own.x) * 0.25, enemy.z + (enemy.z - a.own.z) * 0.25]);
    const [sx, sy] = [to.x - from.x, to.y - from.y];
    const size = Math.hypot(sx, sy) || 1;
    if (sx / size > 0.38) await page.keyboard.down('KeyD');
    if (sx / size < -0.38) await page.keyboard.down('KeyA');
    if (sy / size > 0.38) await page.keyboard.down('KeyS');
    if (sy / size < -0.38) await page.keyboard.down('KeyW');
    await page.mouse.move(aim.x, aim.y);
    await page.mouse.down();
    if (Date.now() - lastShot > 4000 && d > 600 && d < 1500 && Date.now() - aliveSince > 1500) {
      await page.screenshot({ path: join(out, `${prefix}-${shots}.png`), timeout: 240_000 });
      console.log('saved', `${prefix}-${shots}.png`, JSON.stringify({ own: a.own, enemy, d }));
      shots++;
      lastShot = Date.now();
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await page.close();
  if (errors.length) console.log('page errors:', errors.join('\n'));
}
await play(1920, 1080, 'play', 8);
await play(1080, 1920, 'portrait', 2);
await browser.close();
