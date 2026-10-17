// The lobby: every arena whose sim is running, from the `arena.lobby` cache the sims write, with a join button each.
// The style frame's arena plays behind it. `?as=` picks the dev IdP user, as on the play page.
import { Clock, Color, Fog, Group, Scene } from 'three';
import mark from '../../docs/brand/felix-arena-mark.png?url';
import { buildArena } from './arena';
import { hdriUrl, modelUrls } from './assets';
import { ArenaCamera } from './camera';
import { Combat } from './combat';
import { arenaLayout, loadCore } from './core';
import { spawnCrafts, updateCrafts } from './crafts';
import { type CacheEntry, Gateway } from './gateway';
import { type LobbyEntry, parseEntry, phaseLabel } from './lobby-entry';
import { addLights, loadEnvironment } from './lighting';
import { clock } from './match';
import { ModelLibrary } from './models';
import { palette, setCssColours } from './palette';
import { requestedTier, TierChooser } from './quality';
import { seeded } from './random';
import { createRenderer, Pipeline } from './renderer';
import { blobTexture, flareTexture, glowTexture } from './textures';

const params = new URLSearchParams(location.search);
const USER = params.get('as') ?? 'cleo';
const GATEWAY = params.get('gateway') ?? 'ws://127.0.0.1:8787/ws';
const IDP = params.get('idp') ?? 'http://127.0.0.1:9400';

/** What the page exposes for tests. */
export interface LobbyDebug {
  connected: boolean;
  arenas: Record<string, LobbyEntry>;
}

declare global {
  interface Window {
    lobby?: LobbyDebug;
  }
}

const EYE =
  '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';

/** A card for `arena`, filled in by {@link fill}. Its join link is made once, so a click is never lost to a redraw. */
function card(arena: string): HTMLElement {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.arena = arena;
  const join = new URL('play.html', location.href);
  for (const [name, value] of params) if (name !== 'as') join.searchParams.set(name, value);
  join.searchParams.set('arena', arena);
  join.searchParams.set('as', USER);
  el.innerHTML = `
    <div class="top"><span class="name"></span><span class="pill"><i class="dot"></i><span></span></span></div>
    <div class="board">
      <div class="team coral"><small>CORAL</small><b></b></div>
      <div class="clock"><b></b><span></span></div>
      <div class="team violet"><small>VIOLET</small><b></b></div>
    </div>
    <div class="meta">
      <span class="slots"></span>
      <span title="players"><span class="n players"></span></span>
      <span title="watching">${EYE}<span class="n watching"></span></span>
      <a class="join">JOIN</a>
    </div>`;
  el.querySelector('.name')!.textContent = arena.toUpperCase();
  (el.querySelector('.join') as HTMLAnchorElement).href = join.toString();
  return el;
}

/** Show `entry` on `el`, with `seconds` left on the phase clock. */
function fill(el: HTMLElement, entry: LobbyEntry, seconds: number): void {
  const text = (selector: string, value: string) => {
    const node = el.querySelector(selector)!;
    if (node.textContent !== value) node.textContent = value;
  };
  el.querySelector('.pill')!.classList.toggle('playing', entry.phase === 'playing');
  text('.pill > span', phaseLabel(entry));
  text('.coral b', String(entry.scores[0]));
  text('.violet b', String(entry.scores[1]));
  text('.clock b', clock(seconds));
  text(
    '.clock span',
    entry.phase === 'warmup'
      ? entry.players < 2
        ? 'needs two players'
        : 'starting'
      : entry.phase === 'results'
        ? `final · match ${entry.match + 1}`
        : `match ${entry.match + 1}`,
  );
  text('.players', `${entry.players}/${entry.capacity}`);
  text('.watching', String(entry.spectators));
  const slots = el.querySelector('.slots')!;
  if (slots.childElementCount !== entry.capacity) {
    slots.replaceChildren(...Array.from({ length: entry.capacity }, () => document.createElement('i')));
  }
  [...slots.children].forEach((pip, i) => pip.classList.toggle('on', i < entry.players));
}

/** The lobby list: cards in name order, each phase clock counting down between the sims' writes. */
class Lobby {
  /** Each arena's entry, when it arrived and when it lapses, on the page's clock. */
  private readonly entries = new Map<string, { entry: LobbyEntry; atMs: number; lapsesMs: number }>();
  private readonly cards = new Map<string, HTMLElement>();

  constructor(
    private readonly list: HTMLElement,
    private readonly count: HTMLElement,
    private readonly debug: LobbyDebug,
  ) {}

  set(change: CacheEntry): void {
    const entry = change.payload && parseEntry(change.payload);
    const now = performance.now();
    if (entry) this.entries.set(change.key, { entry, atMs: now, lapsesMs: now + (change.expiresInMs ?? Infinity) });
    else this.entries.delete(change.key);
    this.render();
  }

  clear(): void {
    this.entries.clear();
  }

  render(): void {
    const now = performance.now();
    // An entry past its TTL is gone even before the cache says so: its sim has stopped.
    for (const [name, { lapsesMs }] of this.entries) if (lapsesMs <= now) this.entries.delete(name);
    this.debug.arenas = Object.fromEntries([...this.entries].map(([name, { entry }]) => [name, entry]));
    const names = [...this.entries.keys()].sort();
    this.count.textContent =
      names.length === 0 ? 'No arenas running' : `${names.length} ${names.length === 1 ? 'arena' : 'arenas'} live`;
    for (const name of this.cards.keys()) if (!this.entries.has(name)) this.cards.delete(name);
    if (names.length === 0) {
      this.list.innerHTML =
        '<div class="empty">No arena is running right now. Arenas appear here when their sim starts.</div>';
      return;
    }
    const cards = names.map((name) => {
      const { entry, atMs } = this.entries.get(name)!;
      let el = this.cards.get(name);
      if (!el) {
        el = card(name);
        this.cards.set(name, el);
      }
      // A warmup waiting for players holds its clock, as the sim does.
      const held = entry.phase === 'warmup' && entry.players < 2;
      fill(el, entry, held ? entry.seconds : Math.max(0, entry.seconds - Math.floor((now - atMs) / 1000)));
      return el;
    });
    const same = cards.length === this.list.children.length && cards.every((el, i) => this.list.children[i] === el);
    if (!same) this.list.replaceChildren(...cards);
  }
}

/** The style frame's arena, playing behind the lobby. */
async function backdrop(): Promise<void> {
  const renderer = createRenderer();
  document.body.prepend(renderer.domElement);
  const scene = new Scene();
  scene.background = new Color(palette.void);
  const fog = new Fog(palette.void, 42, 90);
  scene.fog = fog;
  const view = new ArenaCamera(renderer.domElement, fog);
  const key = addLights(scene);
  const fx = new Group();
  scene.add(fx);
  const [models] = await Promise.all([
    ModelLibrary.load(modelUrls),
    loadEnvironment(renderer, scene, hdriUrl),
    loadCore(),
  ]);
  const arena = buildArena(scene, arenaLayout(), models, renderer.capabilities.getMaxAnisotropy());
  const glow = glowTexture();
  const random = seeded(1);
  const crafts = spawnCrafts(scene, fx, models, { glow, blob: blobTexture() }, random);
  const combat = new Combat(scene, fx, { glow, flare: flareTexture() }, crafts, random);
  const asked = requestedTier(params);
  const pipeline = new Pipeline(renderer, scene, view.camera, fx, key, asked ?? 'medium');
  const chooser = asked ? null : new TierChooser('medium', (tier) => pipeline.setTier(tier));
  addEventListener('resize', () => {
    view.fit();
    pipeline.setSize(innerWidth, innerHeight);
  });
  const time = new Clock();
  renderer.setAnimationLoop((now: number) => {
    chooser?.frame(now);
    const t = time.getElapsedTime();
    updateCrafts(crafts, t);
    combat.update(t);
    arena.crystal.rotation.y = t * 0.2;
    arena.crystalLight.intensity = 9 + Math.sin(t * 1.7) * 1.5;
    view.update(t);
    pipeline.render(t);
  });
}

async function main(): Promise<void> {
  setCssColours();
  (document.getElementById('mark') as HTMLImageElement).src = mark;
  document.getElementById('user')!.textContent = USER;
  const debug: LobbyDebug = { connected: false, arenas: {} };
  window.lobby = debug;
  const lobby = new Lobby(document.getElementById('arenas')!, document.getElementById('count')!, debug);
  backdrop().catch((error: unknown) => console.error('the backdrop did not load', error));

  const answer = await fetch(`${IDP}/token?sub=${encodeURIComponent(USER)}&aud=felix-arena`);
  const token = ((await answer.json()) as { id_token: string }).id_token;
  // The lobby is a scope of its own: of the scope file's resources it reaches only the shared lobby cache.
  const gateway = await Gateway.connect(GATEWAY, 'lobby', token);
  const link = document.getElementById('link')!;
  link.classList.add('on');
  debug.connected = true;
  gateway.onError = (err) => {
    link.classList.remove('on');
    debug.connected = false;
    document.getElementById('count')!.textContent = err.message;
  };
  gateway.cacheWatch('lobby', {
    entries: (entries) => {
      lobby.clear();
      for (const entry of entries) lobby.set(entry);
      lobby.render();
    },
    change: (entry) => lobby.set(entry),
  });
  setInterval(() => lobby.render(), 1000);
}

main().catch((error: unknown) => {
  document.getElementById('count')!.textContent = `The lobby did not load: ${String(error)}`;
  throw error;
});
