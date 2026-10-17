// The lobby and the member list through the dev stack: two bots play in each arena, the lobby must list both
// arenas, and a spectator's member key must leave the list when its tab closes, at once with the leave beacon and
// within the cache's 30 s TTL without it. Screenshots of the lobby go to `out`.
// Usage: npx vite-node scripts/lobby.ts -- <web root url> <out dir>
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { loadCore } from '../src/core';
import { Gateway } from '../src/gateway';
import type { LobbyDebug } from '../src/lobby';
import { bot } from './bot';

const [root, out] = process.argv.slice(2).filter((arg) => arg !== '--');
if (!root || !out) throw new Error('usage: lobby.ts <web root url> <out dir>');
const GATEWAY = process.env.ARENA_GATEWAY ?? 'ws://127.0.0.1:8787/ws';
const IDP = process.env.ARENA_IDP ?? 'http://127.0.0.1:9400';
const TTL_MS = 30_000;
mkdirSync(out, { recursive: true });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
loadCore(readFileSync(new URL('../src/core/felix_arena_core_bg.wasm', import.meta.url)));

async function until<T>(what: string, limitMs: number, probe: () => Promise<T | null | undefined | false>): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > limitMs) throw new Error(`timed out after ${limitMs} ms waiting for ${what}`);
    await sleep(100);
  }
}

// Ana and ben play alpha, dan and eve bravo.
const stopBots = await Promise.all([
  bot('ana', 'alpha'),
  bot('ben', 'alpha'),
  bot('dan', 'bravo'),
  bot('eve', 'bravo'),
]);

// The member list as a reader sees it: an entry is gone when it is deleted, or once its TTL has run out without a
// newer write, which is what Felix's reads report.
const token = ((await (await fetch(`${IDP}/token?sub=ana&aud=felix-arena`)).json()) as { id_token: string }).id_token;
const watcher = await Gateway.connect(GATEWAY, 'alpha', token);
const members = new Map<string, { payload: string; lapsesAt: number }>();
const removed = new Map<string, number>();
watcher.cacheWatch('members', {
  entries: (entries) => {
    for (const e of entries) {
      if (e.payload) {
        members.set(e.key, {
          payload: new TextDecoder().decode(e.payload),
          lapsesAt: Date.now() + (e.expiresInMs ?? Infinity),
        });
      }
    }
  },
  change: (e) => {
    if (e.payload) {
      members.set(e.key, {
        payload: new TextDecoder().decode(e.payload),
        lapsesAt: Date.now() + (e.expiresInMs ?? Infinity),
      });
    } else {
      members.delete(e.key);
      removed.set(e.key, Date.now());
    }
  },
});
const listed = (key: string) => {
  const entry = members.get(key);
  return entry !== undefined && entry.lapsesAt > Date.now();
};

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errors: string[] = [];
const lobby = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
lobby.on('pageerror', (e) => errors.push(`lobby: ${String(e)}`));
await lobby.goto(`${root}/lobby.html?as=cleo&quality=medium`, { waitUntil: 'load' });
const arenas = () => lobby.evaluate(() => (window.lobby as LobbyDebug | undefined)?.arenas ?? {});
await until('the lobby to list alpha and bravo, both playing', 120_000, async () => {
  const a = await arenas();
  return a.alpha?.phase === 'playing' && a.bravo?.phase === 'playing' && a.alpha.players >= 2;
});
const cards = await lobby.locator('.card').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.arena));
console.log('lobby cards:', cards, JSON.stringify(await arenas()));
if (cards.join() !== 'alpha,bravo') throw new Error(`the lobby shows ${cards.join()}`);

/** A spectator tab on alpha, in a context of its own. Answers its member key once the list has it. */
async function spectator(): Promise<{ context: BrowserContext; page: Page; key: string }> {
  const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`cleo: ${String(e)}`));
  await page.goto(`${root}/play.html?arena=alpha&as=cleo&quality=low`, { waitUntil: 'load' });
  const key = await until('the spectator to write its member key', 120_000, () =>
    page.evaluate(() => window.arena?.member ?? null),
  );
  await until('the member list to have the spectator', 10_000, async () => listed(key));
  if (!members.get(key)!.payload.startsWith('watch:'))
    throw new Error(`cleo is listed as ${members.get(key)!.payload}`);
  return { context, page, key };
}

// A tab that closes normally sends the leave beacon.
const first = await spectator();
await until('the lobby to count the spectator', 15_000, async () => ((await arenas()).alpha?.spectators ?? 0) >= 1);
await lobby.screenshot({ path: join(out, 'lobby.png'), timeout: 240_000 });
console.log('saved lobby.png');
let closed = Date.now();
await first.page.goto('about:blank');
await until('the closed tab to leave the member list', TTL_MS, async () => !listed(first.key));
const beacon = Date.now() - closed;
console.log(`a tab that closed normally left the member list after ${beacon} ms`);

// A tab that dies without a word: no beacon reaches the gateway, so only the TTL takes the key out.
const second = await spectator();
await second.context.route('**/members/leave', (route) => route.abort());
closed = Date.now();
await second.context.close();
await until('the dead tab to lapse from the member list', TTL_MS + 5_000, async () => !listed(second.key));
const lapsed = Date.now() - closed;
await until('Felix to report the expiry', 10_000, async () => removed.has(second.key));
const reported = removed.get(second.key)! - closed;
await until('the lobby to stop counting it', 15_000, async () => (await arenas()).alpha?.spectators === 0);
const lobbyCleared = Date.now() - closed;
console.log(
  `a tab that died without closing left the member list after ${lapsed} ms (Felix reported the expiry after ` +
    `${reported} ms; the lobby stopped counting it after ${lobbyCleared} ms)`,
);

// The lobby on a phone, too.
await lobby.setViewportSize({ width: 390, height: 844 });
await sleep(1000);
await lobby.screenshot({ path: join(out, 'lobby-phone.png'), timeout: 240_000, fullPage: true });

for (const stop of stopBots) stop();
watcher.close();
await browser.close();
if (errors.length) throw new Error(errors.join('\n'));
if (beacon > 5_000) throw new Error(`a normal close took ${beacon} ms to leave the list`);
// A key is written every 10 s, so one that left sooner than 20 s after the tab died was deleted, not lapsed.
if (lapsed < (TTL_MS * 2) / 3) throw new Error(`the dead tab left after ${lapsed} ms: its beacon got through`);
if (lapsed > TTL_MS) throw new Error(`a dead tab took ${lapsed} ms to leave the list, over the ${TTL_MS} ms TTL`);
process.exit(0);
