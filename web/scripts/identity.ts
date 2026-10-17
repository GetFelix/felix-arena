// The kill cam identity test (docs/design.md, "Every viewer sees the same replay"), through the dev stack. Ana flies
// at two bots without firing, so she is destroyed and her page plays the kill cam. Ben plays, and cleo watches through
// a WebSocket that loses a third of the live ticks on the way. Both replay ana's kill from their replays panel. All
// three pages must have replayed the same tick bytes, by hash, and so must a plain range read of the log.
// Usage: npx vite-node scripts/identity.ts -- <play page url>
import { readFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { decodeTick, loadCore } from '../src/core';
import { Gateway } from '../src/gateway';
import type { ArenaDebug } from '../src/play';
import { bot } from './bot';

const [base] = process.argv.slice(2).filter((arg) => arg !== '--');
if (!base) throw new Error('usage: identity.ts <play page url>');
const ARENA = 'alpha';
const GATEWAY = process.env.ARENA_GATEWAY ?? 'ws://127.0.0.1:8787/ws';
const IDP = process.env.ARENA_IDP ?? 'http://127.0.0.1:9400';
const LIMIT_MS = 6 * 60_000;
/** The share of live ticks cleo's WebSocket loses. */
const DROP = 0.33;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
loadCore(readFileSync(new URL('../src/core/felix_arena_core_bg.wasm', import.meta.url)));

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errors: string[] = [];
/** The log offsets of the live ticks cleo's WebSocket dropped. */
const dropped = new Set<number>();
async function open(user: string, lossy = false): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  page.on('pageerror', (e) => errors.push(`${user}: ${String(e)}`));
  if (lossy) {
    // Binary frames are the live ticks; replays arrive as JSON answers, which pass untouched.
    await page.routeWebSocket(/\/ws$/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => server.send(message));
      server.onMessage((message) => {
        if (typeof message !== 'string' && Math.random() < DROP) {
          // A binary event frame carries its offset at bytes 8 to 15.
          dropped.add(Number(message.readBigUInt64LE(8)));
        } else ws.send(message);
      });
    });
  }
  await page.goto(`${base}?arena=${ARENA}&as=${user}&quality=low`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loading', { state: 'detached', timeout: 180_000 });
  return page;
}

type Seen = Pick<ArenaDebug, 'slot' | 'own' | 'crafts' | 'killcam' | 'killcams' | 'kills'>;
const seen = (page: Page): Promise<Seen> =>
  page.evaluate(() => {
    const a = window.arena!;
    return { slot: a.slot, own: a.own, crafts: a.crafts, killcam: a.killcam, killcams: a.killcams, kills: a.kills };
  });

/** Holds the keys that move toward the nearest enemy on screen. */
async function charge(page: Page, a: Seen): Promise<void> {
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

/** FNV-1a, 64 bits, over `chunks` in order, as the page hashes its replay. */
function fnv64(chunks: Uint8Array[]): string {
  let hash = 0xcbf29ce484222325n;
  for (const chunk of chunks)
    for (const byte of chunk) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}

const [ana, ben, cleo] = [await open('ana'), await open('ben'), await open('cleo', true)];
const stopBots = await Promise.all(['dan', 'eve'].map((user) => bot(user, ARENA)));
const failures: string[] = [];
try {
  // Ana's kill cams, until one is of a kill the other two pages both know of.
  let pick: { key: string; tick: number; offset: number; replayFrom: number; hash: string } | null = null;
  const started = Date.now();
  while (!pick && Date.now() - started < LIMIT_MS) {
    const a = await seen(ana);
    const [b, c] = [await seen(ben), await seen(cleo)];
    for (const k of a.killcams) {
      if (!k.complete || !k.hash || k.last !== k.killTick + 30) continue;
      const known = a.kills.find((x) => x.tick === k.killTick && x.replayFrom === k.from);
      if (known && b.kills.some((x) => x.key === known.key) && c.kills.some((x) => x.key === known.key)) {
        pick = { ...known, hash: k.hash };
      }
    }
    if (a.killcam === 'off') await charge(ana, a);
    await sleep(200);
  }
  if (!pick) throw new Error('no kill of ana that all three pages know of');
  for (const key of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) await ana.keyboard.up(key);
  console.log(`ana's kill at tick ${pick.tick}, replayed from offset ${pick.replayFrom}: ${pick.hash}`);
  const inWindow = [...dropped].filter((o) => o >= pick!.replayFrom && o <= pick!.offset + 30).length;
  console.log(`cleo's WebSocket dropped ${dropped.size} live ticks, ${inWindow} of them in the replay's window`);
  if (inWindow === 0) failures.push(`cleo dropped none of the replay's ticks live (${dropped.size} in all)`);

  const hashes: Record<string, string | null> = { ana: pick.hash };
  for (const [name, page] of [
    ['ben', ben],
    ['cleo', cleo],
  ] as const) {
    if (await page.locator('#replays').isHidden()) await page.keyboard.press('KeyR');
    const before = (await seen(page)).killcams.length;
    await page.locator(`#replays-list [data-kill="${pick.key}"]`).click();
    const deadline = Date.now() + 60_000;
    let run: Seen['killcams'][number] | undefined;
    while (Date.now() < deadline) {
      // The page's own death can start a kill cam too; this is the one of ana's kill.
      run = (await seen(page)).killcams
        .slice(before)
        .find((k) => k.killTick === pick!.tick && k.from === pick!.replayFrom);
      if (run && (run.failed || run.complete)) break;
      await sleep(250);
    }
    hashes[name] = run?.hash ?? null;
    console.log(`${name} replayed ticks ${run?.first} to ${run?.last}: ${run?.hash} ${run?.failed ?? ''}`);
  }

  // The log itself, read plainly.
  const token = ((await (await fetch(`${IDP}/token?sub=cleo&aud=felix-arena`)).json()) as { id_token: string })
    .id_token;
  const gateway = await Gateway.connect(GATEWAY, ARENA, token);
  // Read as a page reads a replay: the kill's epoch only, each tick once, up to a second after the kill.
  const end = pick.offset + 31;
  const raw: Uint8Array[] = [];
  for (let from = pick.replayFrom; from < end; ) {
    const page = await gateway.read('ticks', from, end);
    raw.push(...page.records.map((r) => r.payload));
    if (page.nextOffset <= from) break;
    from = page.nextOffset;
  }
  const epochOf = (bytes: Uint8Array) => {
    const tick = decodeTick(bytes);
    const out = [tick.epoch, tick.tick] as const;
    tick.free();
    return out;
  };
  const killEpoch = raw.map(epochOf).find(([, tick]) => tick === pick!.tick)?.[0];
  const held = new Set<number>();
  const records = raw.filter((bytes) => {
    const [epoch, tick] = epochOf(bytes);
    if (epoch !== killEpoch || held.has(tick) || tick > pick!.tick + 30) return false;
    held.add(tick);
    return true;
  });
  gateway.close();
  hashes.log = fnv64(records);
  console.log('hashes:', JSON.stringify(hashes));
  const distinct = new Set(Object.values(hashes));
  if (distinct.size !== 1 || distinct.has(null)) failures.push(`the replays differ: ${JSON.stringify(hashes)}`);
} finally {
  for (const stop of stopBots) stop();
  await browser.close();
}
failures.push(...errors);
if (failures.length) throw new Error(failures.join('\n'));
process.exit(0);
