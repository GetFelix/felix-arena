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

function card(arena: string, entry: LobbyEntry, seconds: number): HTMLElement {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.arena = arena;
  const live = entry.phase === 'playing';
  const join = new URL('play.html', location.href);
  for (const [name, value] of params) if (name !== 'as') join.searchParams.set(name, value);
  join.searchParams.set('arena', arena);
  join.searchParams.set('as', USER);
  const slots = Array.from({ length: entry.capacity }, (_, i) => `<i class="${i < entry.players ? 'on' : ''}"></i>`);
  const under =
    entry.phase === 'warmup'
      ? entry.players < 2
        ? 'needs two players'
        : 'starting'
      : entry.phase === 'results'
        ? `final · match ${entry.match + 1}`
        : `match ${entry.match + 1}`;
  el.innerHTML = `
    <div class="top">
      <span class="name">${arena.toUpperCase()}</span>
      <span class="pill ${live ? 'playing' : ''}"><i class="dot"></i>${phaseLabel(entry)}</span>
    </div>
    <div class="board">
      <div class="team coral"><small>CORAL</small><b>${entry.scores[0]}</b></div>
      <div class="clock"><b>${clock(seconds)}</b><span>${under}</span></div>
      <div class="team violet"><small>VIOLET</small><b>${entry.scores[1]}</b></div>
    </div>
    <div class="meta">
      <span class="slots">${slots.join('')}</span>
      <span title="players"><span class="n">${entry.players}/${entry.capacity}</span></span>
      <span title="watching">${EYE}<span class="n">${entry.spectators}</span></span>
      <a class="join" href="${join.toString()}">JOIN</a>
    </div>`;
  return el;
}

/** The lobby list: cards in name order, each phase clock counting down between the sims' writes. */
class Lobby {
  private readonly entries = new Map<string, { entry: LobbyEntry; atMs: number }>();

  constructor(
    private readonly list: HTMLElement,
    private readonly count: HTMLElement,
    private readonly debug: LobbyDebug,
  ) {}

  set(change: CacheEntry): void {
    const entry = change.payload && parseEntry(change.payload);
    if (entry) this.entries.set(change.key, { entry, atMs: performance.now() });
    else this.entries.delete(change.key);
    this.debug.arenas = Object.fromEntries([...this.entries].map(([name, { entry }]) => [name, entry]));
    this.render();
  }

  clear(): void {
    this.entries.clear();
  }

  render(): void {
    const now = performance.now();
    const names = [...this.entries.keys()].sort();
    this.count.textContent =
      names.length === 0 ? 'No arenas running' : `${names.length} ${names.length === 1 ? 'arena' : 'arenas'} live`;
    if (names.length === 0) {
      this.list.innerHTML =
        '<div class="empty">No arena is running right now. Arenas appear here when their sim starts.</div>';
      return;
    }
    this.list.replaceChildren(
      ...names.map((name) => {
        const { entry, atMs } = this.entries.get(name)!;
        // A warmup waiting for players holds its clock, as the sim does.
        const held = entry.phase === 'warmup' && entry.players < 2;
        const seconds = held ? entry.seconds : Math.max(0, entry.seconds - Math.floor((now - atMs) / 1000));
        return card(name, entry, seconds);
      }),
    );
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
