// The effects kit's budget, in headless Chromium: 40 bolts and 8 hits on screen must cost under 2 ms a frame, and
// updating them must allocate nothing. Usage: node scripts/fx-bench.mjs <fx-bench.html url>.
//
// CI draws with SwiftShader, on the CPU, so a GPU's frame time means nothing here. What is timed is the page's own
// work each frame: updating every effect, and `renderer.render`, which issues the draw calls to the GPU process
// without waiting for them to be drawn.
import { appendFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { isolateRenderer } from './isolate.mjs';
import { analyse, CATEGORIES } from './trace-diag.mjs';

const [url] = process.argv.slice(2);
if (!url) throw new Error('usage: fx-bench.mjs <fx-bench.html url>');
const FRAMES = Number(process.env.FX_FRAMES ?? '600');
const BUDGET_MS = 2;

const errors = [];
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.fxBench !== undefined);
const isolation = await isolateRenderer(browser);

// Warm up first, so shader compiles and the JIT's first passes are not counted as either cost.
await page.evaluate(() => window.fxBench.run(120));
await browser.startTracing(page, { categories: CATEGORIES });
const { update, render } = await page.evaluate((n) => window.fxBench.run(n), FRAMES);
{
  const trace = await browser.stopTracing();
  const r = analyse(trace, 'fx-render', 15);
  console.log('DIAG', JSON.stringify(r));
}
const total = update.map((u, i) => u + render[i]);
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
const ms = (x) => Number(x.toFixed(3));
// The timer is coarse (0.1 ms without cross-origin isolation), so the update alone is also timed over a batch.
const updateMean = await page.evaluate((n) => {
  const start = performance.now();
  window.fxBench.step(n);
  return (performance.now() - start) / n;
}, 6000);
const timing = {
  frames: FRAMES,
  updateMean: ms(updateMean),
  updateP50: ms(pct(update, 50)),
  updateP95: ms(pct(update, 95)),
  renderP50: ms(pct(render, 50)),
  renderP95: ms(pct(render, 95)),
  totalP50: ms(pct(total, 50)),
  totalP95: ms(pct(total, 95)),
};

// Every allocation made while the effects update, short-lived ones included, sampled about every 64 bytes, under the
// page's own code. The harness passes the effects only small integers and numbers boxed up front, so anything counted
// here was allocated by the effects or by Three.js on their behalf.
const cdp = await page.context().newCDPSession(page);
await cdp.send('HeapProfiler.enable');
await page.evaluate(() => window.fxBench.step(20000));
await cdp.send('HeapProfiler.collectGarbage');
await cdp.send('HeapProfiler.startSampling', {
  samplingInterval: 64,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
await page.evaluate((n) => window.fxBench.step(n), FRAMES);
const { profile } = await cdp.send('HeapProfiler.stopSampling');
const origin = new URL(url).origin;
const allocations = [];
const walk = (node, ours) => {
  const here = ours || node.callFrame.url.startsWith(origin);
  if (here && node.selfSize > 0) {
    const { functionName, url: file, lineNumber, columnNumber } = node.callFrame;
    allocations.push(`${node.selfSize} B in ${functionName || '(anonymous)'} ${file}:${lineNumber}:${columnNumber}`);
  }
  for (const child of node.children) walk(child, here);
};
walk(profile.head, false);
await browser.close();

const result = { ...timing, allocations: allocations.length, isolation };
console.log(result);
for (const a of allocations) console.log(a);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Effects kit: 40 bolts and 8 hits\n\n` +
      `Update and submit, per frame over ${FRAMES} frames: p50 ${timing.totalP50} ms, p95 ${timing.totalP95} ms ` +
      `(update mean ${timing.updateMean} ms, render call p95 ${timing.renderP95} ms). ` +
      `Allocations sampled over ${FRAMES} updates: ${allocations.length}.\n`,
  );
}
const failures = [...errors];
if (timing.totalP95 >= BUDGET_MS)
  failures.push(`update and submit take ${timing.totalP95} ms at p95, over ${BUDGET_MS} ms`);
if (allocations.length) failures.push(`updating the effects allocated in ${allocations.length} places`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
