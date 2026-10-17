// Replays from the kill feed through the dev stack (docs/design.md, "Replays from the feed"), on a broker that keeps
// about a minute of each log (dev/retention.yml). Three bots play short matches while cleo watches. Once a match has
// ended, cleo replays its last kill from the replays panel; a fresh page of cleo's finds that match's kills through
// the `match/<n>` state keys and replays one too; and once retention has trimmed the match's first kill, replaying it
// must say "Replay no longer available". Screenshots go to `out`.
// Usage: npx vite-node scripts/feed.ts -- <play page url> <out dir>
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { loadCore } from '../src/core';
import { Gateway } from '../src/gateway';
import type { ArenaDebug } from '../src/play';
import { bot } from './bot';

const [base, out] = process.argv.slice(2).filter((arg) => arg !== '--');
if (!base || !out) throw new Error('usage: feed.ts <play page url> <out dir>');
const ARENA = 'alpha';
const GATEWAY = process.env.ARENA_GATEWAY ?? 'ws://127.0.0.1:8787/ws';
const IDP = process.env.ARENA_IDP ?? 'http://127.0.0.1:9400';
const LIMIT_MS = 6 * 60_000;
const SHOT_TIMEOUT_MS = 240_000;
mkdirSync(out, { recursive: true });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
loadCore(readFileSync(new URL('../src/core/felix_arena_core_bg.wasm', import.meta.url)));

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errors: string[] = [];
async function watch(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}?arena=${ARENA}&as=cleo&quality=low`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#loading', { state: 'detached', timeout: 180_000 });
  return page;
}
type Seen = Pick<ArenaDebug, 'match' | 'kills' | 'killcam' | 'killcams'>;
const seen = (page: Page): Promise<Seen> =>
  page.evaluate(() => {
    const a = window.arena!;
    return { match: a.match, kills: a.kills, killcam: a.killcam, killcams: a.killcams };
  });
async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, ms = LIMIT_MS): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const got = await check();
    if (got) return got;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Replay the kill with `key` from the replays panel, and answer the kill cam it ran once it is done or refused. */
async function replay(page: Page, key: string): Promise<Seen['killcams'][number]> {
  if (await page.locator('#replays').isHidden()) await page.keyboard.press('KeyR');
  const before = (await seen(page)).killcams.length;
  await page.locator(`#replays-list [data-kill="${key}"]`).click();
  return until(
    'the replay',
    async () => {
      const k = (await seen(page)).killcams[before];
      return k && (k.failed || (k.drawnUnixMs !== null && k.complete)) ? k : null;
    },
    60_000,
  );
}

const cleo = await watch();
const stopBots = await Promise.all(['dan', 'eve', 'ben'].map((user) => bot(user, ARENA)));
const failures: string[] = [...errors];
try {
  // A match with kills, then the next one under way.
  const first = await until('a match with kills', async () => {
    const s = await seen(cleo);
    return s.match?.phase === 'playing' && s.kills.some((k) => k.match === s.match!.number) ? s.match.number : null;
  });
  await until('the next match', async () => ((await seen(cleo)).match!.number > first ? true : null));
  const kills = (await seen(cleo)).kills.filter((k) => k.match === first);
  console.log(`match ${first}: ${kills.length} kills, offsets ${kills[0]!.offset} to ${kills.at(-1)!.offset}`);

  // The match's last kill, from the panel.
  const last = kills.at(-1)!;
  const played = await replay(cleo, last.key);
  console.log('replayed from the panel:', JSON.stringify(played));
  if (played.failed || played.last !== last.tick + 30) failures.push(`the panel's replay of match ${first} failed`);
  await page_shot(cleo, 'feed-replay.png');

  // A page that never saw the match finds its kills through match/<n>.
  const fresh = await watch();
  await fresh.keyboard.press('KeyR');
  await fresh.locator('#replays-earlier').click();
  const found = await until(
    `match ${first} in the log`,
    async () => {
      const s = await seen(fresh);
      const note = await fresh.locator('#replays-note').textContent();
      if (note && note !== '' && !note.startsWith('Reading')) throw new Error(`loading match ${first}: ${note}`);
      return s.kills.filter((k) => k.match === first).length ? s.kills.filter((k) => k.match === first) : null;
    },
    60_000,
  );
  console.log(`a fresh page found ${found.length} of match ${first}'s kills in the log`);
  const loaded = await replay(fresh, found.at(-1)!.key);
  if (loaded.failed || loaded.last !== found.at(-1)!.tick + 30) failures.push('a loaded kill did not replay');
  await fresh.close();

  // The match's first kill, once retention has passed its replay's start.
  const oldest = kills[0]!;
  const gateway = await Gateway.connect(
    GATEWAY,
    ARENA,
    ((await (await fetch(`${IDP}/token?sub=cleo&aud=felix-arena`)).json()) as { id_token: string }).id_token,
  );
  await until(`offset ${oldest.replayFrom} to be trimmed`, async () => {
    try {
      await gateway.read('ticks', oldest.replayFrom, oldest.replayFrom + 1);
      return null;
    } catch (err) {
      return (err as { code?: string }).code === 'trimmed';
    }
  });
  gateway.close();
  const refused = await replay(cleo, oldest.key);
  const gone = await cleo.locator('#replay-gone').isVisible();
  console.log('replayed a trimmed kill:', JSON.stringify(refused), 'message shown:', gone);
  if (refused.failed !== 'trimmed' || !gone) failures.push('a trimmed replay did not say "Replay no longer available"');
  await page_shot(cleo, 'trimmed.png');
} finally {
  for (const stop of stopBots) stop();
  await browser.close();
}

async function page_shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(out!, name), timeout: SHOT_TIMEOUT_MS });
  console.log(`saved ${name}`);
}

failures.push(...errors);
if (failures.length) throw new Error(failures.join('\n'));
process.exit(0);
