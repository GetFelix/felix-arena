// Plays the live page in headless Chromium against the dev stack, moves the mouse and presses keys, and times each
// input to the screen in three parts: the wait for the next frame, the page putting the input into that frame's
// scene, and the frame rendering. Prediction means the first frame after an input draws it, so on a 60 Hz display
// the wait is under a frame; the page's own part is what this holds to a limit. Headless Chromium renders on the
// CPU (SwiftShader), so here the render, and the wait behind it, are the software rasterizer's and are reported only.
// Usage: node scripts/input-to-pixel.mjs <play page url>. The page and the dev stack must already be up.
import { appendFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { isolateRenderer } from './isolate.mjs';

const url = process.argv[2];
if (!url) throw new Error('usage: input-to-pixel.mjs <play page url>');
/** The page's own part of a frame: interpolating, predicting and updating the scene, before it renders. */
const LIMIT_MS = 2;
/** Inputs timed. Of a few dozen, the 95th percentile is the second or third largest: one unlucky frame. */
const SAMPLES = 300;
/** Inputs drawn first and not timed, while the JIT compiles the frame's code. */
const WARM_UP = 60;
const TIMEOUT_MS = 240_000;

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
// Small, so the software rasterizer draws frames, and so takes inputs, several times faster. The page's own part of
// a frame does not depend on its size.
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.arena?.own != null, null, { timeout: 60_000 });
const isolation = await isolateRenderer(browser);
await page.waitForTimeout(1000);

const start = await page.evaluate(() => ({ ...window.arena.own }));
// Hold D for a second while sweeping the mouse.
await page.keyboard.down('KeyD');
for (let i = 0; i < 20; i++) {
  await page.mouse.move(160 + 100 * Math.cos(i / 3), 90 + 60 * Math.sin(i / 3));
  await page.waitForTimeout(50);
}
await page.keyboard.up('KeyD');
const moved = await page.evaluate(
  (from) => Math.hypot(window.arena.own.x - from.x, window.arena.own.z - from.z),
  start,
);

/** Taps keys and moves the mouse in single steps until the page has drawn `count` inputs. */
async function play(count) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (let i = 0; Date.now() < deadline; i++) {
    if ((await page.evaluate(() => window.arena.inputToPixel.length)) >= count) return;
    const key = ['KeyW', 'KeyA', 'KeyS', 'KeyD'][i % 4];
    await page.keyboard.down(key);
    await page.mouse.move(20 + Math.random() * 280, 20 + Math.random() * 140);
    await page.waitForTimeout(40);
    await page.keyboard.up(key);
    await page.mouse.move(20 + Math.random() * 280, 20 + Math.random() * 140);
    await page.waitForTimeout(40);
  }
}
await play(WARM_UP);
await page.evaluate(() => (window.arena.inputToPixel.length = 0));
await play(SAMPLES);
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
  isolation,
};
console.log('input to own pixel, ms:', JSON.stringify(result));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Input to own pixel\n\n${result.samples} inputs, each drawn by the next frame, after ${WARM_UP} not timed ` +
      `(${isolation}). The page put each into the scene in p50 ${result.update.p50} ms, ` +
      `p95 ${result.update.p95} ms. On SwiftShader a frame took ${result.frameMs} ms, so the wait for it ` +
      `(p50 ${result.wait.p50} ms) and its render (p50 ${result.render.p50} ms) are the software rasterizer's. ` +
      `Holding D for a second moved the craft ${result.movedCm} cm.\n`,
  );
}
if (errors.length) throw new Error(errors.join('\n'));
if (samples.length < SAMPLES) throw new Error(`only ${samples.length} of ${SAMPLES} inputs were drawn`);
if (moved < 200) throw new Error(`holding D moved the craft only ${Math.round(moved)} cm`);
if (result.update.p95 >= LIMIT_MS) {
  throw new Error(`the page took ${result.update.p95} ms (p95) to put an input on screen, over ${LIMIT_MS} ms`);
}
