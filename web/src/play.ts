// The live game. `?arena=` picks the arena and `?as=` the dev IdP user to play as; `?quality=low` draws without
// post processing or shadows. The style frame at / stays the frozen scene it was ported as.
import { Clock, Color, Fog, Group, Scene } from 'three';
import { buildArena } from './arena';
import { hdriUrl, modelUrls } from './assets';
import { Bolts, type BoltView } from './bolts';
import { ArenaCamera } from './camera';
import { Controls } from './controls';
import { arenaLayout, boltReach, decodeTick, Inputs, loadCore, playerKey, type Tick } from './core';
import { Effects } from './effects';
import { type CraftView, Fleet } from './fleet';
import { Gateway } from './gateway';
import { Interpolator, snapshot } from './interpolation';
import { addLights, loadEnvironment } from './lighting';
import { ModelLibrary } from './models';
import { palette, setCssColours } from './palette';
import { Own, Pacer } from './prediction';
import { seeded } from './random';
import { createRenderer, Post } from './renderer';
import { blobTexture, flareTexture, glowTexture } from './textures';

const params = new URLSearchParams(location.search);
const ARENA = params.get('arena') ?? 'alpha';
const USER = params.get('as') ?? 'ana';
const GATEWAY = params.get('gateway') ?? 'ws://127.0.0.1:8787/ws';
const IDP = params.get('idp') ?? 'http://127.0.0.1:9400';
const LOW = params.get('quality') === 'low';

/** What the page exposes for tests and the dev console. */
export interface ArenaDebug {
  /**
   * For each input event, in milliseconds: how long it waited for the next frame to start, how long the page took in
   * that frame to put it into the scene, and how long the frame then took to render.
   */
  inputToPixel: { wait: number; update: number; render: number }[];
  slot: number | null;
  ticks: number;
  /** Where your craft is drawn, in centimetres. */
  own: { x: number; z: number; heading: number } | null;
}

declare global {
  interface Window {
    arena?: ArenaDebug;
  }
}

/** The Felix principal of an ID token's holder: hex SHA-256 of `issuer|subject`, as Felix's control plane keys it. */
async function principal(token: string): Promise<string> {
  const claims = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as {
    iss: string;
    sub: string;
  };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${claims.iss}|${claims.sub}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function main(): Promise<void> {
  setCssColours();
  const debug: ArenaDebug = { inputToPixel: [], slot: null, ticks: 0, own: null };
  window.arena = debug;

  const renderer = createRenderer();
  if (LOW) renderer.shadowMap.enabled = false;
  document.body.prepend(renderer.domElement);
  const scene = new Scene();
  scene.background = new Color(palette.void);
  const fog = new Fog(palette.void, 42, 90);
  scene.fog = fog;
  const view = new ArenaCamera(renderer.domElement, fog, true);
  addLights(scene);
  const fx = new Group();
  scene.add(fx);

  const [models] = await Promise.all([
    ModelLibrary.load(modelUrls),
    loadEnvironment(renderer, scene, hdriUrl),
    loadCore(),
  ]);
  const arena = buildArena(scene, arenaLayout(), models, renderer.capabilities.getMaxAnisotropy());
  const glow = glowTexture();
  const fleet = new Fleet(scene, fx, models, { glow, blob: blobTexture() });
  const bolts = new Bolts(fx, glow);
  const effects = new Effects(scene, fx, { glow, flare: flareTexture() }, seeded(1));
  const post = LOW ? null : new Post(renderer, scene, view.camera, fx);
  const controls = new Controls(renderer.domElement);
  addEventListener('resize', () => {
    view.fit();
    if (post) post.setSize(renderer, innerWidth, innerHeight);
    else renderer.setSize(innerWidth, innerHeight);
  });

  const status = document.getElementById('loading')!;
  status.textContent = `Joining ${ARENA}`;
  const token = (
    (await (await fetch(`${IDP}/token?sub=${encodeURIComponent(USER)}&aud=felix-arena`)).json()) as {
      id_token: string;
    }
  ).id_token;
  const key = playerKey(await principal(token));
  const gateway = await Gateway.connect(GATEWAY, ARENA, token);
  gateway.onError = (err) => {
    status.textContent = `${err.code}: ${err.message}`;
  };

  const interpolator = new Interpolator();
  let pacer = new Pacer();
  const inputs = new Inputs(Math.floor(Math.random() * 65536));
  let own: Own | null = null;
  /** Events waiting for the render time to reach their tick, oldest first. */
  const due: { tick: number; kind: string; slot: number; by: number }[] = [];

  const onTick = (tick: Tick, arrivedMs: number) => {
    debug.ticks++;
    const players = tick.players;
    const me = players.find((p) => p.key === key)?.slot;
    for (const p of players) p.free();
    if (me !== undefined && own?.slot !== me) {
      own?.dispose();
      own = new Own(me);
      debug.slot = me;
    }
    const s = snapshot(tick);
    // A restarted sim counts ticks again from its keyframe; what was waiting on the old count never comes due.
    const newest = interpolator.newest;
    if (newest && s.epoch > newest.epoch) {
      due.length = 0;
      pacer = new Pacer();
    }
    interpolator.push(s, arrivedMs);
    const mine = own && s.crafts.find((c) => c.slot === own!.slot);
    pacer.tick(s.tick, arrivedMs, mine ? mine.lastInput : null);
    for (const e of tick.events) {
      if (!(e.kind === 'fired' && e.slot === own?.slot))
        due.push({ tick: s.tick, kind: e.kind, slot: e.slot, by: e.by });
      e.free();
    }
    own?.reconcile(tick, arrivedMs);
  };
  await gateway.subscribe('ticks', 'live', 'live', (frame) => {
    let tick: Tick;
    try {
      tick = decodeTick(frame.payload);
    } catch {
      return;
    }
    onTick(tick, performance.now());
    tick.free();
  });

  // Inputs go once a sim tick, on the sim's clock as the ticks show it; a short timer keeps the send close to it.
  let live = { moveX: 0, moveZ: 0, aim: 0, buttons: 0 };
  // The first input joins the arena; a watcher, who may not publish inputs, sends none.
  const playing = !gateway.missing.includes('input');
  setInterval(() => {
    const now = performance.now();
    // A hidden page draws no frames, so its controls are stale: send none, and the sim lets the craft coast.
    if (!playing || document.hidden || !pacer.due(now)) return;
    gateway.send('input', inputs.next(live.moveX, live.moveZ, live.aim, live.buttons));
    if (own?.ready) own.send(inputs.seq, live, now);
  }, 4);

  status.remove();
  document.getElementById('where')!.textContent = `${ARENA} · playing as ${USER}`;
  const clock = new Clock();
  let shown: number | null = null;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const frameStart = now;
    const t = clock.getElapsedTime();
    const frame = interpolator.sample(now);
    const ownDrawn = own?.draw(now) ?? null;
    live = controls.sample(view.camera, ownDrawn?.x ?? 0, ownDrawn?.z ?? 0);
    own?.steer(live);
    const ownNow = own?.draw(now) ?? null;
    debug.own = ownNow && { x: ownNow.x, z: ownNow.z, heading: ownNow.heading };

    const crafts: CraftView[] = (frame?.crafts ?? []).map((c) =>
      c.slot === own?.slot && ownNow ? { ...c, ...ownNow, slot: c.slot, violet: c.violet } : c,
    );
    fleet.update(crafts, t);

    const claimed = own?.claimed ?? new Set<number>();
    const drawn: BoltView[] = [];
    const byId = new Map<number, { x: number; z: number }>();
    const violet = new Map(crafts.map((c) => [c.slot, c.violet]));
    for (const b of frame?.bolts ?? []) {
      byId.set(b.id, b);
      if (!claimed.has(b.id)) drawn.push({ violet: violet.get(b.owner) ?? false, x: b.x, z: b.z, heading: b.heading });
    }
    if (own) {
      const mine = violet.get(own.slot) ?? false;
      const reach = boltReach();
      const hits = (x: number, z: number) =>
        crafts.some((c) => c.alive && c.violet !== mine && Math.hypot(c.x - x, c.z - z) < reach);
      for (const shot of own.drawShots(now, (id) => byId.has(id), hits)) {
        drawn.push({ violet: mine, x: shot.x, z: shot.z, heading: shot.heading, size: shot.opacity });
      }
      for (const fired of own.firedSince(shown ?? now)) effects.fired(mine, fired.x, fired.z, t);
    }
    bolts.update(drawn);

    while (frame && due[0] && due[0].tick <= frame.renderTick) {
      const e = due.shift()!;
      const at = crafts.find((c) => c.slot === e.slot);
      if (!at) continue;
      if (e.kind === 'fired') {
        const angle = (at.heading / 65536) * 2 * Math.PI;
        effects.fired(at.violet, at.x + Math.cos(angle) * 130, at.z + Math.sin(angle) * 130, t);
      } else if (e.kind === 'hit') {
        effects.hit(violet.get(e.by) ?? !at.violet, at.x, at.z, t);
      }
    }
    effects.update(t);

    arena.crystal.rotation.y = t * 0.2;
    arena.crystalLight.intensity = 9 + Math.sin(t * 1.7) * 1.5;
    view.update(t);
    const updated = performance.now();
    if (post) post.render(t);
    else renderer.render(scene, view.camera);
    shown = now;
    if (controls.changedAt !== null) {
      const rendered = performance.now();
      debug.inputToPixel.push({
        wait: frameStart - controls.changedAt,
        update: updated - frameStart,
        render: rendered - updated,
      });
      if (debug.inputToPixel.length > 1000) debug.inputToPixel.shift();
      controls.changedAt = null;
    }
  });
}

main().catch((error: unknown) => {
  const loading = document.getElementById('loading');
  if (loading) loading.textContent = `The game did not start: ${String(error)}`;
  throw error;
});
