// CI has no GPU, so SwiftShader rasterizes in Chromium's GPU process on every core and preempts the page's main
// thread in the middle of the work a timing gate measures: in a trace of the slow frames the main thread ran for 1.5
// ms of a 5 ms frame and was off the CPU for the rest. On a machine with a GPU that work is on the GPU. So the timing
// gates give the page's main thread a core of its own, the renderer's other threads another, and the rest of the
// browser the remaining cores.
import { execFileSync } from 'node:child_process';
import { availableParallelism } from 'node:os';

/** Pins `browser`'s processes as above. Returns what it did, for the report. */
export async function isolateRenderer(browser) {
  const cores = availableParallelism();
  if (process.platform !== 'linux' || cores < 4) return 'renderer not isolated: needs Linux and four cores';
  const cdp = await browser.newBrowserCDPSession();
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  await cdp.detach();
  const rest = `2-${cores - 1}`;
  // Without -a, taskset pins only the thread whose id is the process id: a renderer's main thread.
  const pin = (cpus, pid, all = true) =>
    execFileSync('taskset', [...(all ? ['-a'] : []), '-p', '-c', cpus, String(pid)], { stdio: 'ignore' });
  try {
    for (const { type, id } of processInfo) {
      if (type !== 'renderer') {
        pin(rest, id);
        continue;
      }
      pin('1', id);
      pin('0', id, false);
    }
    pin(rest, process.pid);
  } catch (e) {
    // Timed anyway, and the report says so: no taskset, a process gone, or cores this job may not use.
    return `renderer not isolated: ${e.message.split('\n')[0]}`;
  }
  return `renderer main thread on core 0, its other threads on 1, the rest of the browser on ${rest}`;
}
