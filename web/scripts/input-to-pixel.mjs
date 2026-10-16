// Plays the live page in headless Chromium against the dev stack, moves the mouse and presses keys, and measures
// how long each input takes to reach the screen: from the input event to the end of the first frame that drew it.
// Usage: node scripts/input-to-pixel.mjs <play page url>. The page and the dev stack must already be up.
import { appendFileSync } from 'node:fs';
import { chromium } from 'playwright';

const url = process.argv[2];
if (!url) throw new Error('usage: input-to-pixel.mjs <play page url>');
const LIMIT_MS = 16;

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.arena?.own != null, null, { timeout: 60_000 });
await page.waitForTimeout(1000);

const start = await page.evaluate(() => ({ ...window.arena.own }));
await page.evaluate(() => (window.arena.inputToPixel.length = 0));
// Hold D for a second while sweeping the mouse, then tap keys and move the mouse in single steps.
await page.keyboard.down('KeyD');
for (let i = 0; i < 20; i++) {
  await page.mouse.move(320 + 200 * Math.cos(i / 3), 180 + 120 * Math.sin(i / 3));
  await page.waitForTimeout(50);
}
await page.keyboard.up('KeyD');
const moved = await page.evaluate(
  (from) => Math.hypot(window.arena.own.x - from.x, window.arena.own.z - from.z),
  start,
);
for (const key of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyW', 'KeyA', 'KeyS', 'KeyD']) {
  await page.keyboard.down(key);
  await page.waitForTimeout(90);
  await page.keyboard.up(key);
  await page.mouse.move(100 + Math.random() * 440, 60 + Math.random() * 240);
  await page.waitForTimeout(90);
}
const samples = await page.evaluate(() => [...window.arena.inputToPixel]);
const frames = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const times = [];
      const step = (t) => (times.push(t), times.length < 61 ? requestAnimationFrame(step) : resolve(times));
      requestAnimationFrame(step);
    }),
);
await browser.close();

const sorted = [...samples].sort((a, b) => a - b);
const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
const intervals = frames.slice(1).map((t, i) => t - frames[i]);
const result = {
  samples: samples.length,
  p50: Number(at(0.5).toFixed(2)),
  p95: Number(at(0.95).toFixed(2)),
  max: Number(sorted.at(-1).toFixed(2)),
  frameMs: Number((intervals.reduce((a, b) => a + b, 0) / intervals.length).toFixed(2)),
  movedCm: Math.round(moved),
};
console.log('input to own pixel, ms:', result);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Input to own pixel\n\n${result.samples} inputs: p50 ${result.p50} ms, p95 ${result.p95} ms, ` +
      `max ${result.max} ms, at ${result.frameMs} ms a frame. Holding D for a second moved the craft ${result.movedCm} cm.\n`,
  );
}
if (errors.length) throw new Error(errors.join('\n'));
if (samples.length < 20) throw new Error(`only ${samples.length} inputs were drawn`);
if (moved < 200) throw new Error(`holding D moved the craft only ${Math.round(moved)} cm`);
if (result.p95 >= LIMIT_MS) throw new Error(`input to own pixel p95 is ${result.p95} ms, over ${LIMIT_MS} ms`);
