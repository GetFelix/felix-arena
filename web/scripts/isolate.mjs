// CI has no GPU, so SwiftShader rasterizes in Chromium's GPU process on every core, and preempts the page's main
// thread in the middle of the work a timing gate measures: in a trace of the slow frames the main thread ran for 1.5
// ms of a 5 ms frame and was off the CPU for the rest. On a machine with a GPU that work is on the GPU. So the timing
// gates give the page's renderer process half the cores and the rest of the browser the other half.
import { execFileSync } from 'node:child_process';
import { availableParallelism } from 'node:os';

/** Pins `browser`'s renderers away from its other processes. Returns what it did, for the report. */
export async function isolateRenderer(browser) {
  const cores = availableParallelism();
  if (process.platform !== 'linux' || cores < 2) return 'renderer not isolated: needs Linux and two cores';
  const cdp = await browser.newBrowserCDPSession();
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  await cdp.detach();
  const half = Math.floor(cores / 2);
  const page = `0-${half - 1}`;
  const rest = `${half}-${cores - 1}`;
  const pin = (cpus, pid) => execFileSync('taskset', ['-a', '-p', '-c', cpus, String(pid)], { stdio: 'ignore' });
  for (const { type, id } of processInfo) pin(type === 'renderer' ? page : rest, id);
  pin(rest, process.pid);
  return `renderer on cores ${page}, the rest of the browser on ${rest}`;
}
