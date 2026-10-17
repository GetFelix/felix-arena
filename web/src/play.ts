// The live game. `?arena=` picks the arena and `?as=` the dev IdP user to play as; `?quality=high|medium|low|auto`
// overrides the quality setting. `?offline&bench` runs the frame-time benchmark. The style frame at / stays the
// frozen scene it was ported as.
import { Clock, Color, Fog, Group, Scene, Vector3 } from 'three';
import { Aim } from './aim';
import { buildArena } from './arena';
import { hdriUrl, modelUrls } from './assets';
import { Bench, BENCH_SIZE, type BenchReport, gpuName } from './bench';
import { ArenaCamera } from './camera';
import { Controls } from './controls';
import {
  arenaLayout,
  boltReach,
  boostTicks,
  decodeTick,
  Inputs,
  loadCore,
  playerKey,
  railChargeTicks,
  respawnTicks,
  spawnProtectionTicks,
  type Tick,
} from './core';
import { Effects } from './effects';
import { type CraftView, Fleet, GUN_HEIGHT } from './fleet';
import { type EventFrame, Gateway, GatewayError } from './gateway';
import { botCount, botLevel, botTag } from './bots';
import { type Link, Offline, OFFLINE_PRINCIPAL } from './offline';
import { Hud } from './hud';
import { joinFromKeyframe, type JoinTimes } from './join';
import { Interpolator, snapshot } from './interpolation';
import { addLights, loadEnvironment } from './lighting';
import { Match } from './match';
import { ModelLibrary } from './models';
import { palette, setCssColours } from './palette';
import { Pickup } from './pickup';
import { Own, Pacer } from './prediction';
import { seeded } from './random';
import { requestedTier, TierChooser, urlTier } from './quality';
import { createRenderer, Pipeline } from './renderer';
import { qualitySetting } from './settings';
import { blobTexture, flareTexture, glowTexture } from './textures';

const params = new URLSearchParams(location.search);
const ARENA = params.get('arena') ?? 'alpha';
const USER = params.get('as') ?? 'ana';
const GATEWAY = params.get('gateway') ?? 'ws://127.0.0.1:8787/ws';
const IDP = params.get('idp') ?? 'http://127.0.0.1:9400';
/** The frame-time benchmark: an offline match, `&seconds=` long (120 by default), drawn at 1920x1080. */
const BENCH = params.has('bench');
/** A tier the URL or the saved setting asks for, or null to choose. The benchmark heeds only the URL. */
const ASKED = BENCH ? urlTier(params) : requestedTier(params);
/** Play against bots with the sim in the page, without the dev stack: `?offline`, with `&warmup=`, `&length=` and `&results=` in seconds. */
const OFFLINE = params.has('offline') || BENCH;
/** Offline only: `&bots=easy|normal|hard` and `&botcount=1..3`. */
const BOT_LEVEL = botLevel(params.get('bots'));
const BOT_COUNT = botCount(params.get('botcount'));
/** How long a try at joining may take before it is given up and made again. */
const JOIN_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `promise`, or a rejection once {@link JOIN_TIMEOUT_MS} has passed, calling `onLate` then. */
function within<T>(promise: Promise<T>, onLate = () => {}): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onLate();
      reject(new Error('the gateway did not answer in time'));
    }, JOIN_TIMEOUT_MS);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** What the page exposes for tests and the dev console. */
export interface ArenaDebug {
  /**
   * For each input event, in milliseconds: how long it waited for the next frame to start, how long the page took in
   * that frame to put it into the scene, and how long the frame then took to render.
   */
  inputToPixel: { wait: number; update: number; render: number }[];
  slot: number | null;
  ticks: number;
  /** How many times the page joined again after the gateway closed its session. */
  reconnects: number;
  /** Where your craft is drawn, in centimetres. */
  own: { x: number; z: number; heading: number } | null;
  match: { number: number; phase: string; seconds: number; scores: [number, number]; railIn: number } | null;
  /** Each match number and phase the page has seen, as `number:phase`, oldest first. */
  phases: string[];
  /** Every craft as drawn: centimetres, and whether it is under spawn protection. */
  crafts: { slot: number; violet: boolean; alive: boolean; x: number; z: number; protected: boolean }[];
  /** Where a point on the floor, in centimetres, is on screen, in CSS pixels. */
  screenOf: (x: number, z: number) => { x: number; y: number };
  /** The quality tier drawn now. */
  tier: string;
  /** The benchmark's report, once it has run. */
  bench: BenchReport | null;
  /** Offline only: holds the page's own sim still, or lets it run, so a moment can be photographed. */
  pause?: (paused: boolean) => void;
  /** For screenshots: a slot whose shield is shown absorbing a shot from `(x, z)`, `ago` seconds in, every frame. */
  absorbing: { slot: number; x: number; z: number; ago: number } | null;
  /**
   * The first join, in milliseconds on the page's clock: signing in, each step of {@link joinFromKeyframe} from the
   * state read on, the first event, the newest tick taken after the catch-up, and the first frame drawn.
   */
  join:
    | (JoinTimes & {
        signInMs: number;
        firstEventMs: number | null;
        liveMs: number | null;
        catchUp: number;
        drawnMs: number | null;
        drawnTick: number | null;
        drawnAtUnixMs: number | null;
      })
    | null;
  /** The newest tick taken, live or folded. */
  newestTick: number | null;
  /** The state each recent tick folded to, by `epoch/tick`: the tick's hash and the match's digest. */
  states: Record<string, string>;
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
  const debug: ArenaDebug = {
    inputToPixel: [],
    slot: null,
    ticks: 0,
    reconnects: 0,
    own: null,
    match: null,
    phases: [],
    crafts: [],
    screenOf: () => ({ x: 0, y: 0 }),
    tier: '',
    bench: null,
    absorbing: null,
    join: null,
    states: {},
    newestTick: null,
  };
  window.arena = debug;

  const renderer = createRenderer();
  document.body.prepend(renderer.domElement);
  const scene = new Scene();
  scene.background = new Color(palette.void);
  const fog = new Fog(palette.void, 42, 90);
  scene.fog = fog;
  const view = new ArenaCamera(renderer.domElement, fog, true);
  const keyLight = addLights(scene);
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
  const effects = new Effects(scene, fx, { glow, flare: flareTexture() }, seeded(1));
  const pickup = new Pickup(fx, glow, arena.crystalLight);
  const hud = new Hud();
  const match = new Match();
  debug.screenOf = (x, z) => {
    const p = new Vector3(x / 100, GUN_HEIGHT, z / 100).project(view.camera);
    return { x: ((p.x + 1) / 2) * innerWidth, y: ((1 - p.y) / 2) * innerHeight };
  };
  const pipeline = new Pipeline(renderer, scene, view.camera, fx, keyLight, ASKED ?? 'high');
  const select = document.getElementById('quality') as HTMLSelectElement;
  let chooser = ASKED ? null : new TierChooser('high', (tier) => pipeline.setTier(tier));
  const setting = qualitySetting(
    select,
    ASKED === null,
    () => pipeline.tier,
    (tier) => {
      chooser = tier ? null : new TierChooser('high', (t) => pipeline.setTier(t));
      pipeline.setTier(tier ?? 'high');
    },
  );
  const bench = BENCH
    ? new Bench(Number(params.get('seconds') ?? 120), ASKED !== null, gpuName(renderer.getContext()))
    : null;
  const fitView = () => {
    if (bench) {
      // The target is set at 1080p, so the benchmark draws 1920x1080 whatever the window, scaled to fit it.
      renderer.setPixelRatio(1);
      view.fit(...BENCH_SIZE);
      pipeline.setSize(...BENCH_SIZE, false);
      Object.assign(renderer.domElement.style, { width: '100vw', height: '100vh', objectFit: 'contain' });
    } else {
      view.fit();
      pipeline.setSize(innerWidth, innerHeight);
    }
  };
  fitView();
  const controls = new Controls(renderer.domElement);
  const aim = new Aim(fx, document.getElementById('reticle')!);
  addEventListener('resize', fitView);
  document.addEventListener('visibilitychange', () => chooser?.pause());

  // The first frame uploads every texture and compiles every shader, which holds the page for many seconds on a slow
  // GPU. A page held that long after joining sends no inputs and leaves its socket unread, so it is drawn first.
  renderer.compile(scene, view.camera);
  pipeline.render(0);
  // Wait for that frame here, so the join's reads do not queue behind it.
  renderer.getContext().finish();

  const status = document.getElementById('loading')!;
  status.textContent = `Joining ${ARENA}`;
  const where = document.getElementById('where')!;
  const place = OFFLINE ? botTag(BOT_LEVEL, BOT_COUNT) : `${ARENA} · playing as ${USER}`;
  let gateway: Link;
  let key: string;
  const joinStartMs = performance.now();

  const interpolator = new Interpolator();
  let pacer = new Pacer();
  const inputs = new Inputs(Math.floor(Math.random() * 65536));
  let own: Own | null = null;
  /** Events waiting for the render time to reach their tick, oldest first. */
  const due: {
    tick: number;
    kind: string;
    slot: number;
    by: number;
    x: number;
    z: number;
    target?: number;
    damage: number;
  }[] = [];
  /** When your craft respawns, on the page's clock, while it is destroyed. */
  let respawnAt: number | null = null;
  /** The tick each slot last respawned in, for how much of its spawn protection is left. */
  const spawnedIn = new Map<number, number>();

  /** Recent `epoch/tick` keys of {@link ArenaDebug.states}, oldest first. */
  const stateKeys: string[] = [];
  const recordState = (tick: Tick) => {
    const at = `${tick.epoch}/${tick.tick}`;
    debug.newestTick = tick.tick;
    if (!(at in debug.states)) stateKeys.push(at);
    debug.states[at] = `${tick.hash}|${match.digest()}`;
    if (stateKeys.length > 1800) delete debug.states[stateKeys.shift()!];
  };
  let catchUp = 0;
  /** A tick that was in the log before the join: only the match's tally takes it, and nothing is drawn. */
  const foldTick = (tick: Tick) => {
    debug.ticks++;
    catchUp++;
    match.update(tick, performance.now(), false);
    recordState(tick);
  };

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
      spawnedIn.clear();
      pacer = new Pacer();
    }
    interpolator.push(s, arrivedMs);
    const mine = own && s.crafts.find((c) => c.slot === own!.slot);
    pacer.tick(s.tick, arrivedMs, mine ? mine.lastInput : null);
    for (const e of tick.events) {
      if (!(e.kind === 'fired' && e.slot === own?.slot)) {
        due.push({
          tick: s.tick,
          kind: e.kind,
          slot: e.slot,
          by: e.by,
          x: e.x,
          z: e.z,
          target: e.target,
          damage: e.damage,
        });
      }
      if (e.kind === 'killed' && e.slot === own?.slot) respawnAt = arrivedMs + (respawnTicks() * 1000) / 30;
      e.free();
    }
    if (mine?.alive) respawnAt = null;
    match.update(tick, arrivedMs);
    recordState(tick);
    const phase = `${match.number}:${match.phase}`;
    if (debug.phases.at(-1) !== phase) debug.phases.push(phase);
    if (own) own.frozen = match.phase === 'results';
    own?.reconcile(tick, arrivedMs);
  };
  // When the first join's first event, and its first tick after the catch-up, arrived.
  let firstEventMs: number | null = null;
  let liveMs: number | null = null;
  /**
   * When the join in flight began, from its state read until the fold reaches the newest tick. Nothing is drawn
   * meanwhile: the catch-up is folded without drawing, and a frame would hold the page's thread off the ticks.
   */
  let joiningSince: number | null = null;
  /** A join whose ticks never come still lets the page draw after this long. */
  const JOIN_HOLD_MS = 2000;
  const onFrame = (frame: EventFrame, catchingUp = false) => {
    firstEventMs ??= performance.now();
    let tick: Tick;
    try {
      tick = decodeTick(frame.payload);
    } catch {
      return;
    }
    if (catchingUp) foldTick(tick);
    else onTick(tick, performance.now());
    tick.free();
    if (!catchingUp) joiningSince = null;
    if (!catchingUp && liveMs === null) {
      liveMs = performance.now();
      if (debug.join) [debug.join.firstEventMs, debug.join.liveMs] = [firstEventMs, liveMs];
    }
  };

  const signIn = async () =>
    (
      (await (await fetch(`${IDP}/token?sub=${encodeURIComponent(USER)}&aud=felix-arena`)).json()) as {
        id_token: string;
      }
    ).id_token;
  /** Open a gateway session and subscribe to the ticks. A session that closes once joined is opened again. */
  const open = async (token: string): Promise<Gateway> => {
    let late = false;
    const connecting = Gateway.connect(GATEWAY, ARENA, token);
    // A session that opens after its try was given up on would hold a place at the gateway for nothing.
    connecting.then((link) => late && link.close()).catch(() => {});
    const link = await within(connecting, () => (late = true));
    let joined = false;
    const lost = new Promise<never>((_, reject) => {
      link.onError = (err) => {
        if (err.code !== 'closed') status.textContent = String(err.message);
        else if (joined) void rejoin();
        else reject(err);
      };
    });
    try {
      // Every join, the first and each after a lost session, starts from the newest keyframe.
      joiningSince = performance.now();
      const times = await within(Promise.race([joinFromKeyframe(link, onFrame), lost]));
      debug.join ??= {
        ...times,
        signInMs: joinStartMs,
        firstEventMs,
        liveMs,
        catchUp: 0,
        drawnMs: null,
        drawnTick: null,
        drawnAtUnixMs: null,
      };
    } catch (err) {
      link.close();
      throw err;
    }
    joined = true;
    return link;
  };
  /**
   * Open sessions until one joins, waiting longer after each failed try. With `final`, a refusal from the gateway
   * ends the tries, as a page that may not join cannot start.
   */
  const persist = async (token: string | null, final: (err: unknown) => boolean): Promise<Gateway> => {
    for (let wait = 500; ; wait = Math.min(wait * 2, 8000)) {
      try {
        return await open(token ?? (await signIn()));
      } catch (err) {
        if (final(err)) throw err;
      }
      token = null;
      await sleep(wait);
    }
  };
  let rejoining = false;
  /** Join again after the gateway closed the session. */
  const rejoin = async () => {
    if (rejoining) return;
    rejoining = true;
    debug.reconnects++;
    where.textContent = 'Reconnecting';
    await sleep(500);
    gateway = await persist(null, () => false);
    where.textContent = place;
    rejoining = false;
  };

  if (OFFLINE) {
    const seconds = (name: string, fallback: number) => Number(params.get(name) ?? fallback);
    const offline = BENCH
      ? new Offline(2, seconds('length', 600), 15, BOT_LEVEL, BOT_COUNT)
      : new Offline(seconds('warmup', 10), seconds('length', 300), seconds('results', 15), BOT_LEVEL, BOT_COUNT);
    debug.pause = (paused) => {
      offline.paused = paused;
    };
    gateway = offline;
    key = playerKey(OFFLINE_PRINCIPAL);
    await gateway.subscribe('ticks', 'live', 'live', (frame) => onFrame(frame));
  } else {
    const token = await signIn();
    key = playerKey(await principal(token));
    gateway = await persist(token, (err) => err instanceof GatewayError && err.code !== 'closed');
  }

  // Inputs go once a sim tick, on the sim's clock as the ticks show it; a short timer keeps the send close to it.
  let live = { moveX: 0, moveZ: 0, aim: 0, buttons: 0 };
  // The first input joins the arena; a watcher, who may not publish inputs, sends none.
  const playing = () => !gateway.missing.includes('input');
  setInterval(() => {
    const now = performance.now();
    // A hidden page draws no frames, so its controls are stale: send none, and the sim lets the craft coast.
    if (!playing() || document.hidden || !pacer.due(now)) return;
    gateway.send('input', inputs.next(live.moveX, live.moveZ, live.aim, live.buttons));
    if (own?.ready) own.send(inputs.seq, live, now);
  }, 4);

  status.remove();
  where.textContent = place;
  const clock = new Clock();
  let shown: number | null = null;
  let lastT = 0;
  renderer.setAnimationLoop((frameAt: number) => {
    if (joiningSince !== null && performance.now() - joiningSince < JOIN_HOLD_MS) return;
    const frameStartUnixMs = Date.now();
    const settled = !chooser || chooser.done;
    chooser?.frame(frameAt);
    if (debug.tier !== pipeline.tier) {
      debug.tier = pipeline.tier;
      setting.refresh();
    }
    const now = performance.now();
    const frameStart = now;
    const t = clock.getElapsedTime();
    const frame = interpolator.sample(now);
    const ownDrawn = own?.draw(now) ?? null;
    live = bench ? bench.controls(t) : controls.sample(view.camera, ownDrawn?.x ?? 0, ownDrawn?.z ?? 0);
    own?.steer(live);
    const ownNow = own?.draw(now) ?? null;
    debug.own = ownNow && { x: ownNow.x, z: ownNow.z, heading: ownNow.heading };

    const charging = railChargeTicks();
    const crafts: CraftView[] = (frame?.crafts ?? []).map((c) => {
      const charge = c.charge > 0 ? 1 - c.charge / charging : 0;
      return c.slot === own?.slot && ownNow
        ? { ...c, ...ownNow, slot: c.slot, violet: c.violet, charge }
        : { ...c, charge };
    });
    fleet.update(crafts, t);
    debug.crafts = crafts.map(({ slot, violet, alive, x, z, protected: shielded }) => ({
      slot,
      violet,
      alive,
      x,
      z,
      protected: shielded ?? false,
    }));

    const claimed = own?.claimed ?? new Set<number>();
    const byId = new Map<number, { x: number; z: number }>();
    const violet = new Map(crafts.map((c) => [c.slot, c.violet]));
    for (const b of frame?.bolts ?? []) {
      byId.set(b.id, b);
      if (!claimed.has(b.id)) effects.bolt(violet.get(b.owner) ?? false, b.x, b.z, b.heading);
    }
    if (own) {
      const mine = violet.get(own.slot) ?? false;
      const reach = boltReach();
      const hits = (x: number, z: number) =>
        crafts.some((c) => c.alive && c.violet !== mine && Math.hypot(c.x - x, c.z - z) < reach);
      for (const shot of own.drawShots(now, (id) => byId.has(id), hits)) {
        effects.bolt(mine, shot.x, shot.z, shot.heading, shot.opacity);
      }
      for (const fired of own.firedSince(shown ?? now)) effects.fired(mine, fired.x, fired.z, t);
    }

    while (frame && due[0] && due[0].tick <= frame.renderTick) {
      const e = due.shift()!;
      const at = crafts.find((c) => c.slot === e.slot);
      if (!at) continue;
      const angle = (at.heading / 65536) * 2 * Math.PI;
      const nose = [at.x + Math.cos(angle) * 130, at.z + Math.sin(angle) * 130] as const;
      if (e.kind === 'fired') {
        effects.fired(at.violet, nose[0], nose[1], t);
      } else if (e.kind === 'hit' && e.damage === 0) {
        // A shot the spawn shield stopped.
        const from = crafts.find((c) => c.slot === e.by);
        effects.absorbed(e.slot, from?.x ?? 0, from?.z ?? 0, t);
      } else if (e.kind === 'hit') {
        effects.hit(violet.get(e.by) ?? !at.violet, at.x, at.z, t);
      } else if (e.kind === 'railed') {
        effects.railed(at.violet, nose[0], nose[1], e.x, e.z, t);
        effects.fired(at.violet, nose[0], nose[1], t);
      } else if (e.kind === 'killed') {
        effects.destroyed(at.violet, at.x, at.z, t);
        spawnedIn.delete(e.slot);
      } else if (e.kind === 'spawned') {
        spawnedIn.set(e.slot, e.tick);
      }
    }
    const protection = spawnProtectionTicks();
    for (const c of crafts) {
      if (!c.alive || !c.protected) continue;
      const since = spawnedIn.get(c.slot);
      // Counted to the newest tick at most: past it, nothing says the protection is still running down.
      const at = frame ? Math.min(frame.renderTick, interpolator.newest?.tick ?? frame.renderTick) : 0;
      const left = since === undefined || !frame ? protection : protection - (at - since);
      effects.shield(c.slot, c.violet, c.x, c.z, left);
    }
    const posed = debug.absorbing;
    if (posed) effects.absorbed(posed.slot, posed.x, posed.z, t - posed.ago);
    effects.update(t);

    arena.crystal.rotation.y = t * 0.2;
    pickup.update(match.railIn === 0 && match.phase !== 'results', t, t - lastT);
    lastT = t;
    debug.match = {
      number: match.number,
      phase: match.phase,
      seconds: match.seconds,
      scores: match.scores,
      railIn: match.railIn,
    };
    const newestOwn = own && interpolator.newest?.crafts.find((c) => c.slot === own!.slot);
    hud.update(
      match,
      own && newestOwn && ownNow
        ? {
            slot: own.slot,
            alive: ownNow.alive,
            health: ownNow.health,
            boostCooling: ownNow.boostCooldown / boostTicks(),
            rail: newestOwn.rail,
            respawnIn: respawnAt === null ? null : (respawnAt - now) / 1000,
          }
        : null,
      controls.scoreboard,
      now,
    );
    const ownCraft = own && crafts.find((c) => c.slot === own!.slot);
    // The cursor comes back for the results, which are read rather than played.
    aim.update(
      {
        pointer: playing() && own && match.phase !== 'results' ? controls.pointerAt : null,
        craft: ownCraft?.alive ? { x: ownCraft.x / 100, z: ownCraft.z / 100 } : null,
        violet: ownCraft?.violet ?? false,
        target: controls.target,
        firing: controls.firing,
      },
      view.camera,
    );
    view.update(t);
    const updated = performance.now();
    pipeline.render(t);
    shown = now;
    if (bench?.frame(frameAt, performance.now() - frameStart, settled, pipeline.tier, renderer.domElement)) {
      debug.bench = bench.report;
      console.log('bench', JSON.stringify(bench.report));
      const out = document.getElementById('bench')!;
      out.textContent = JSON.stringify(bench.report, null, 2);
      out.hidden = false;
    }
    if (frame && debug.join && debug.join.drawnMs === null) {
      debug.join.drawnMs = performance.now();
      debug.join.drawnTick = interpolator.newest?.tick ?? null;
      // The state drawn is the newest tick as the frame began; drawing it can take long on a software renderer.
      debug.join.drawnAtUnixMs = frameStartUnixMs;
      debug.join.catchUp = catchUp;
    }
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
