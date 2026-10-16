// Screenshots the built app and the prototype style frame at the same frozen moment and measures how far apart they
// are. Usage: node scripts/compare-frame.mjs <app url> <style frame url> <out dir>. Both pages must already be served.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { chromium } from 'playwright';
import pngjs from 'pngjs';

const [appUrl, frameUrl, out] = process.argv.slice(2);
if (!out) throw new Error('usage: compare-frame.mjs <app url> <style frame url> <out dir>');
const T = process.env.FRAME_T ?? '1.2';
const [W, H] = [1920, 1080];
mkdirSync(out, { recursive: true });

// The style frame draws its random numbers from Math.random, as do Three.js's ids. The app uses web/src/random.ts with
// seed 1, so the style frame's own calls are pointed at a copy of that generator, drawn in the same order.
const SEEDED = `window.__seeded = (() => {
  let a = 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();`;

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

async function shoot(url, file, patch) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  if (patch) {
    await page.addInitScript(SEEDED);
    await page.route(
      (u) => u.pathname.endsWith('.html'),
      async (route) => {
        const res = await route.fetch();
        const body = (await res.text()).replaceAll('Math.random()', 'window.__seeded()');
        await route.fulfill({ response: res, body });
      },
    );
  }
  await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForSelector('#loading', { state: 'detached', timeout: 180_000 });
  await page.evaluate(() => document.fonts.ready.then(() => true));
  // A frozen moment draws the same every frame; a few frames let textures and shadow maps settle.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 0;
        const frame = () => (++n >= 4 ? resolve() : requestAnimationFrame(frame));
        requestAnimationFrame(frame);
      }),
  );
  await page.screenshot({ path: join(out, file), timeout: 120_000 });
  await page.close();
  if (errors.length) throw new Error(`${url}:\n${errors.join('\n')}`);
}

await shoot(`${frameUrl}?t=${T}`, 'style-frame.png', true);
await shoot(`${appUrl}?t=${T}`, 'app.png', false);
await browser.close();

const read = (f) => pngjs.PNG.sync.read(readFileSync(join(out, f)));
const [a, b] = [read('style-frame.png'), read('app.png')];
const diff = new pngjs.PNG({ width: W, height: H });
const differing = pixelmatch(a.data, b.data, diff.data, W, H, { threshold: 0.1 });
writeFileSync(join(out, 'diff.png'), pngjs.PNG.sync.write(diff));
let sum = 0;
let max = 0;
for (let i = 0; i < a.data.length; i += 4) {
  for (let c = 0; c < 3; c++) {
    const d = Math.abs(a.data[i + c] - b.data[i + c]);
    sum += d;
    max = Math.max(max, d);
  }
}
const result = {
  t: Number(T),
  differingPixels: differing,
  differingPercent: Number(((100 * differing) / (W * H)).toFixed(4)),
  meanAbsoluteError: Number((sum / (W * H * 3)).toFixed(4)),
  maxChannelDifference: max,
};
writeFileSync(join(out, 'diff.json'), JSON.stringify(result, null, 2) + '\n');
console.log(result);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### App against the style frame at t=${T}\n\n` +
      `${result.differingPixels} pixels differ (${result.differingPercent}%), ` +
      `mean absolute error ${result.meanAbsoluteError} of 255, largest channel difference ${max}.\n`,
  );
}
const limit = Number(process.env.FRAME_MAX_DIFFERING_PERCENT ?? '100');
if (result.differingPercent > limit) {
  console.error(`more than ${limit}% of pixels differ`);
  process.exit(1);
}
