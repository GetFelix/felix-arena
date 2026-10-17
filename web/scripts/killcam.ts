// The kill cam through the dev stack (docs/design.md, "The kill cam"). Two bots fight ana, who flies at them without
// firing, and a watcher replays every kill in the match the way the page does, with the page's own code. Each step is
// timed: the kill's commit to its tick arriving, the read of the replay, and when the replay would be on screen,
// which is the later of the death beat ending and the read. Those must hold the design's targets: the read under
// 250 ms and the replay on screen within 800 ms of the commit, both at p95. Ana's page runs its own kill cams, which are
// drawn in software at about a frame a second on a CI runner, so its times are reported, not judged.
// Usage: npx vite-node scripts/killcam.ts -- <play page url> <out dir>
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { decodeTick, loadCore } from '../src/core';
import { Gateway } from '../src/gateway';
import { BEAT_MS } from '../src/killcam';
import { fetchReplay, type KillRef, type Replay } from '../src/replay';
import type { ArenaDebug } from '../src/play';
import { bot } from './bot';

const [base, out] = process.argv.slice(2).filter((arg) => arg !== '--');
if (!base || !out) throw new Error('usage: killcam.ts <play page url> <out dir>');
const ARENA = 'alpha';
const GATEWAY = process.env.ARENA_GATEWAY ?? 'ws://127.0.0.1:8787/ws';
const IDP = process.env.ARENA_IDP ?? 'http://127.0.0.1:9400';
const LIMIT_MS = 8 * 60_000;
/** Kills the watcher replays, and kill cams ana's page must run. */
const KILLS = 20;
const PAGE_KILLCAMS = 2;
const SHOT_TIMEOUT_MS = 240_000;
mkdirSync(out, { recursive: true });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
loadCore(readFileSync(new URL('../src/core/felix_arena_core_bg.wasm', import.meta.url)));

async function signIn(user: string): Promise<string> {
  const answer = await fetch(`${IDP}/token?sub=${user}&aud=felix-arena`);
  return ((await answer.json()) as { id_token: string }).id_token;
}

/** One kill the watcher replayed, timed in Unix milliseconds. */
interface Watched {
  kill: KillRef;
  commitMs: number;
  arrivedMs: number;
  fetchedMs: number | null;
  replay: Replay | null;
}

const watched: Watched[] = [];
const watcher = await Gateway.connect(GATEWAY, ARENA, await signIn('cleo'));
await watcher.subscribe('ticks', 'live', 'live', (frame) => {
  const arrivedMs = Date.now();
  const tick = decodeTick(frame.payload);
  const timing = tick.timing;
  for (const e of tick.events) {
    if (e.kind === 'killed' && e.replayFrom !== undefined && timing && watched.length < KILLS) {
      const w: Watched = {
        kill: {
          matchNumber: tick.matchNumber,
          tick: tick.tick,
          offset: frame.offset!,
          replayFrom: e.replayFrom,
          victim: e.slot,
          killer: e.by,
          epoch: tick.epoch,
        },
        commitMs: timing.commitStartUs / 1000,
        arrivedMs,
        fetchedMs: null,
        replay: null,
      };
      watched.push(w);
      void fetchReplay(watcher, w.kill, () => Date.now()).then((replay) => {
        w.replay = replay;
        w.fetchedMs = replay.times.beforeMs;
      });
    }
    e.free();
  }
  timing?.free();
  tick.free();
});

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errors: string[] = [];
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${base}?arena=${ARENA}&as=ana&quality=low`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#loading', { state: 'detached', timeout: 180_000 });
const stopBots = await Promise.all(['dan', 'eve'].map((user) => bot(user, ARENA)));

type Arena = Pick<ArenaDebug, 'slot' | 'own' | 'crafts' | 'killcam' | 'killcams'>;
const arena = (p: Page): Promise<Arena> =>
  p.evaluate(() => {
    const a = window.arena!;
    return { slot: a.slot, own: a.own, crafts: a.crafts, killcam: a.killcam, killcams: a.killcams };
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
let a = await arena(page);
let shot = false;
while (Date.now() - started < LIMIT_MS) {
  a = await arena(page);
  const played = a.killcams.filter((k) => k.drawnUnixMs !== null && k.complete).length;
  if (a.killcam === 'replay' && !shot) {
    await page.screenshot({ path: join(out, 'replay.png'), timeout: SHOT_TIMEOUT_MS });
    shot = true;
  }
  if (watched.length >= KILLS && watched.every((w) => w.replay) && played >= PAGE_KILLCAMS && shot) break;
  if (a.killcam === 'off') await charge(a);
  await sleep(150);
}
for (const stop of stopBots) stop();
await sleep(1500);
a = await arena(page);
watcher.close();
await browser.close();

const p = (values: number[], q: number) => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] ?? NaN;
};
const done = watched.filter((w) => w.fetchedMs !== null);
const rows = done.map((w) => ({
  tick: w.kill.tick,
  arrive_ms: Math.round(w.arrivedMs - w.commitMs),
  fetch_ms: Math.round(w.fetchedMs! - w.arrivedMs),
  on_screen_ms: Math.round(Math.max(w.arrivedMs + BEAT_MS, w.fetchedMs!) - w.commitMs),
  ticks: w.replay!.ticks.length,
}));
console.table(rows);
const fetches = rows.map((r) => r.fetch_ms);
const onScreen = rows.map((r) => r.on_screen_ms);
console.log(
  `watcher: ${rows.length} kills, read p50 ${p(fetches, 0.5)} ms, p95 ${p(fetches, 0.95)} ms; ` +
    `on screen p50 ${p(onScreen, 0.5)} ms, p95 ${p(onScreen, 0.95)} ms, max ${Math.max(...onScreen)} ms after the commit`,
);
console.log('ana:', JSON.stringify(a.killcams, null, 1));
for (const k of a.killcams) {
  console.log(
    `ana's kill cam at tick ${k.killTick}: read ${k.fetchMs?.toFixed(0)} ms, ready ${
      k.readyUnixMs && k.commitUnixMs ? (k.readyUnixMs - k.commitUnixMs).toFixed(0) : '-'
    } ms and first replay frame ${
      k.drawnUnixMs && k.commitUnixMs ? (k.drawnUnixMs - k.commitUnixMs).toFixed(0) : '-'
    } ms after the commit, drawn in software`,
  );
}

const failures: string[] = [...errors];
if (rows.length < KILLS) failures.push(`the watcher replayed ${rows.length} kills, wanted ${KILLS}`);
if (done.some((w) => w.replay!.failed)) failures.push('a replay could not be read');
if (p(fetches, 0.95) >= 250) failures.push(`the read took ${p(fetches, 0.95)} ms at p95, over 250`);
if (p(onScreen, 0.95) >= 800) failures.push(`replays were on screen ${p(onScreen, 0.95)} ms after the commit at p95`);
const played = a.killcams.filter((k) => k.drawnUnixMs !== null && k.complete);
if (played.length < PAGE_KILLCAMS) failures.push(`ana's page played ${played.length} kill cams`);
for (const k of played) {
  if (k.last !== k.killTick + 30)
    failures.push(`ana's kill cam at ${k.killTick} replayed ticks ${k.first} to ${k.last}`);
}
if (!shot) failures.push('no screenshot of a replay');
if (failures.length) throw new Error(failures.join('\n'));
process.exit(0);
