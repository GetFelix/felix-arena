// A client that loses ticks, through the dev stack (docs/design.md, "Failure modes"). Ana plays with three bots
// and cleo watches the same match through a page that discards every seventh live tick on arrival, as a subscriber
// whose queue overflowed would lose them. Cleo reads the missing ticks back from the log, so every tick both pages
// folded must come out the same on both, and every kill ana saw after cleo joined must be on cleo's list too.
// Usage: npx vite-node scripts/gaps.ts -- <play page url> [seconds]
import { readFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { loadCore } from '../src/core';
import type { ArenaDebug } from '../src/play';
import { bot } from './bot';

const [base, seconds = '90'] = process.argv.slice(2).filter((arg) => arg !== '--');
if (!base) throw new Error('usage: gaps.ts <play page url> [seconds]');
const ARENA = 'alpha';
const RUN_MS = Number(seconds) * 1000;
/** Every this-many-th tick cleo's page loses. */
const LOSE = 7;
/** Ticks both pages must have folded, and kills both must have seen, for a comparison worth the name. */
const MIN_COMPARED = 600;
const MIN_KILLS = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
loadCore(readFileSync(new URL('../src/core/felix_arena_core_bg.wasm', import.meta.url)));

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const errors: string[] = [];
const open = async (user: string, extra = ''): Promise<Page> => {
  const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${user}: ${String(e)}`));
  await page.goto(`${base}?arena=${ARENA}&as=${user}&quality=low${extra}`, { waitUntil: 'load' });
  await page.waitForSelector('#loading', { state: 'detached', timeout: 180_000 });
  return page;
};
type Seen = Pick<ArenaDebug, 'states' | 'match' | 'gaps'> & { kills: { match: number; tick: number }[] };
const seen = (page: Page): Promise<Seen> =>
  page.evaluate(() => {
    const a = window.arena!;
    return {
      states: { ...a.states },
      match: a.match,
      gaps: { ...a.gaps },
      kills: a.kills.map((k) => ({ match: k.match, tick: k.tick })),
    };
  });

const ana = await open('ana');
const stopBots = await Promise.all(['ben', 'dan', 'eve'].map((user) => bot(user, ARENA)));
for (let waited = 0; (await seen(ana)).match?.phase !== 'playing'; waited += 500) {
  if (waited > 120_000) throw new Error(`the match did not start: ${JSON.stringify((await seen(ana)).match)}`);
  await sleep(500);
}
const cleo = await open('cleo', `&lose=${LOSE}`);

const compared = new Set<string>();
const differing: string[] = [];
let first: { match: number; tick: number } | null = null;
const key = (k: { match: number; tick: number }) => `${k.match}:${k.tick}`;
/** Whether `k` happened after cleo joined, in this match or a later one. */
const after = (k: { match: number; tick: number }) =>
  first !== null && (k.match > first.match || (k.match === first.match && k.tick >= first.tick));
/** What each page listed at each look, for saying what happened to a kill that ended up on one list only. */
const looks: { s: number; ana: Set<string>; cleo: Set<string>; resyncs: number; behind: number }[] = [];
const started = Date.now();
async function look(): Promise<void> {
  const [watcher, player] = await Promise.all([seen(cleo), seen(ana)]);
  const extra = await cleo.evaluate(() => ({ resyncs: window.arena!.resyncs, behind: window.arena!.behindTicks }));
  looks.push({
    s: Math.round((Date.now() - started) / 1000),
    ana: new Set(player.kills.map(key)),
    cleo: new Set(watcher.kills.map(key)),
    ...extra,
  });
}
async function sample(): Promise<Seen> {
  const [watcher, player] = await Promise.all([seen(cleo), seen(ana)]);
  first ??= {
    match: watcher.match?.number ?? 0,
    tick: Math.min(...Object.keys(watcher.states).map((at) => Number(at.split('/')[1]))),
  };
  for (const at of Object.keys(watcher.states).filter((at) => at in player.states)) {
    compared.add(at);
    if (watcher.states[at] !== player.states[at] && !differing.includes(at)) differing.push(at);
  }
  return watcher;
}
while (Date.now() - started < RUN_MS) {
  for (let i = 0; i < 5; i++) {
    await sleep(2000);
    await look();
  }
  await sample();
}
// A kill in the last moments may have reached one page before the other: let both settle, then judge once more.
await sleep(2000);
const watcher = await sample();
await look();
const resyncs = looks.at(-1)!.resyncs;
for (const stop of stopBots) stop();
await browser.close();

// Judged on the last look: every kill ana lists since cleo joined must be on cleo's list, and the other way round.
const last = looks.at(-1)!;
const tickOf = (k: string) => Number(k.split(':')[1]);
const everAna = new Set(looks.flatMap((l) => [...l.ana]));
const missing = [...everAna]
  .filter((k) => after({ match: Number(k.split(':')[0]), tick: tickOf(k) }))
  .filter((k) => !last.cleo.has(k))
  .map((k) => {
    const seenBy = (which: 'ana' | 'cleo') => looks.filter((l) => l[which].has(k)).map((l) => l.s);
    const cleoHad = seenBy('cleo');
    const anaHad = seenBy('ana');
    return (
      `${k} (ana from ${anaHad[0]}s to ${anaHad.at(-1)}s, cleo ${cleoHad.length ? `${cleoHad[0]}s to ${cleoHad.at(-1)}s` : 'never'}; ` +
      `cleo had a state at that tick: ${Object.keys(watcher.states).some((at) => at.endsWith(`/${tickOf(k)}`))})`
    );
  });
const extras = [...last.cleo].filter((k) => !last.ana.has(k)).map((k) => `${k} (cleo only)`);
const kills = new Set([...everAna].filter((k) => after({ match: Number(k.split(':')[0]), tick: tickOf(k) })));
console.log(`cleo lost every ${LOSE}th live tick:`, watcher.gaps, `${resyncs} resyncs`);
console.log(
  `${compared.size} ticks compared, ${differing.length} differ; ${kills.size} kills, ${missing.length + extras.length} not on both lists`,
);
if (missing.length + extras.length > 0) {
  console.log('behind, resyncs by look:', looks.map((l) => `${l.s}s:${l.behind.toFixed(0)}/${l.resyncs}`).join(' '));
}
if (errors.length) throw new Error(errors.join('\n'));
if (watcher.gaps.missed < 20) throw new Error(`cleo lost only ${watcher.gaps.missed} ticks`);
if (watcher.gaps.unfilled > watcher.gaps.missed / 50) {
  throw new Error(`${watcher.gaps.unfilled} of ${watcher.gaps.missed} lost ticks could not be read back`);
}
if (compared.size < MIN_COMPARED) throw new Error(`only ${compared.size} ticks to compare`);
if (differing.length > 0) throw new Error(`${differing.length} ticks folded differently, first ${differing[0]}`);
if (kills.size < MIN_KILLS) throw new Error(`only ${kills.size} kills to compare`);
if (missing.length + extras.length > 0)
  throw new Error(`kills not on both lists: ${[...missing, ...extras].join(', ')}`);
process.exit(0);
