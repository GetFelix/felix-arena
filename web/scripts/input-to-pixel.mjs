// Plays the live page in headless Chromium against the dev stack, moves the mouse and presses keys, and times each
// input to the screen in three parts: the wait for the next frame, the page putting the input into that frame's
// scene, and the frame rendering. Prediction means the first frame after an input draws it, so on a 60 Hz display
// the wait is under a frame; the page's own part is what this holds to a limit. Headless Chromium renders on the
// CPU (SwiftShader), so here the render, and the wait behind it, are the software rasterizer's and are reported only.
// Usage: node scripts/input-to-pixel.mjs <play page url>. The page and the dev stack must already be up.
import { appendFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { analyse, CATEGORIES } from './trace-diag.mjs';

const url = process.argv[2];
if (!url) throw new Error('usage: input-to-pixel.mjs <play page url>');
/** The page's own part of a frame: interpolating, predicting and updating the scene, before it renders. */
const LIMIT_MS = 2;

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
if (process.env.DIAG) await browser.startTracing(page, { categories: CATEGORIES });
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
if (process.env.DIAG) {
  const trace = await browser.stopTracing();
  const diag = { updates: samples.map((s) => Number(s.update.toFixed(2))),
    input: analyse(trace, 'input-update'), page: analyse(trace, 'page-update') };
  appendFileSync('diag-itp.json', JSON.stringify(diag, null, 1));
  console.log('DIAG', JSON.stringify(diag));
}
const frames = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const times = [];
      const step = (t) => (times.push(t), times.length < 61 ? requestAnimationFrame(step) : resolve(times));
      requestAnimationFrame(step);
    }),
);
await browser.close();

const p = (values, q) => {
  const sorted = [...values].sort((x, y) => x - y);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))].toFixed(2));
};
const intervals = frames.slice(1).map((t, i) => t - frames[i]);
const part = (name) => ({
  p50: p(
    samples.map((s) => s[name]),
    0.5,
  ),
  p95: p(
    samples.map((s) => s[name]),
    0.95,
  ),
});
const result = {
  samples: samples.length,
  update: part('update'),
  wait: part('wait'),
  render: part('render'),
  frameMs: Number((intervals.reduce((a, b) => a + b, 0) / intervals.length).toFixed(2)),
  movedCm: Math.round(moved),
};
console.log('input to own pixel, ms:', JSON.stringify(result));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Input to own pixel\n\n${result.samples} inputs, each drawn by the next frame. The page put each into the ` +
      `scene in p50 ${result.update.p50} ms, p95 ${result.update.p95} ms. On SwiftShader a frame took ` +
      `${result.frameMs} ms, so the wait for it (p50 ${result.wait.p50} ms) and its render ` +
      `(p50 ${result.render.p50} ms) are the software rasterizer's. Holding D for a second moved the craft ` +
      `${result.movedCm} cm.\n`,
  );
}
if (errors.length) throw new Error(errors.join('\n'));
if (samples.length < 20) throw new Error(`only ${samples.length} inputs were drawn`);
if (moved < 200) throw new Error(`holding D moved the craft only ${Math.round(moved)} cm`);
if (result.update.p95 >= LIMIT_MS) {
  throw new Error(`the page took ${result.update.p95} ms (p95) to put an input on screen, over ${LIMIT_MS} ms`);
}
