import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeTick, loadCore, type Tick, World } from './core';
import { TICK_MS } from './interpolation';
import { after, type Control, Own, Pacer } from './prediction';
import { seeded } from './random';

beforeAll(() => loadCore(readFileSync(new URL('./core/felix_arena_core_bg.wasm', import.meta.url))));

const FRAME_MS = 1000 / 60;

/** A message on its way, and when it lands. */
interface Flight<T> {
  at: number;
  what: T;
}

/** What a run looked like. Distances in centimetres. */
interface Run {
  frames: number;
  reconciles: number;
  /** The largest correction taken in at a tick: how far the prediction was from the sim's word. */
  maxError: number;
  /** The most a correction moved the drawn craft in one frame. */
  maxStep: number;
  /** Corrections too large to blend, shown at once. */
  snaps: number;
  shots: number;
  /** Shots matched to the sim's bolt. */
  matched: number;
  /** Shots whose drawn position jumped more than a frame of bolt flight plus 10 cm. */
  shotJumps: number;
  /** Frames until the first input showed on screen. */
  firstInputFrames: number;
  /** Ticks in a row, after the first two seconds, where the sim applied no new input of ana's, or skipped one. */
  uneven: number;
}

/**
 * Ana plays against core's own world as the sim, with `latencyMs` each way between her page and the sim plus up to
 * 10 ms of jitter, and ben ramming her now and then, so the sim pushes her about in ways she cannot predict. The sim takes
 * inputs as sim/src/inputs.rs does: the newest one each tick with the buttons of any it skipped, held 100 ms.
 */
function play(latencyMs: number, seconds = 20, seed = 1, lose = 0): Run {
  const random = seeded(seed);
  // A warmup that never ends, so the match starting does not respawn ana mid-test.
  const world = World.withRules(65535, 9000, 450, 25, 900);
  world.join('ana');
  world.join('ben');
  const own = new Own(0);
  const run: Run = {
    frames: 0,
    reconciles: 0,
    maxError: 0,
    maxStep: 0,
    snaps: 0,
    shots: 0,
    matched: 0,
    shotJumps: 0,
    firstInputFrames: -1,
    uneven: 0,
  };
  let lastApplied: number | null = null;
  let lastTick: number | null = null;

  const toSim: Flight<Control & { seq: number }>[] = [];
  const toPage: Flight<Uint8Array>[] = [];
  let lastToSim = 0;
  let lastToPage = 0;
  let newest: (Control & { seq: number }) | null = null;
  let applied = -1;
  let heard = -Infinity;
  let simTick = 0;

  // Ana strafes back and forth toward ben, sweeps her aim, fires in bursts and boosts now and then.
  const control = (t: number): Control => {
    const phase = Math.floor(t / 700) % 4;
    const moveX = [127, 90, 127, -60][phase]!;
    const moveZ = [0, 90, -90, 0][phase]!;
    const aim = Math.round(8000 * Math.sin(t / 400)) & 0xffff;
    const fire = t % 1500 < 600 ? 1 : 0;
    const boost = t % 3000 < 40 ? 2 : 0;
    return { moveX, moveZ, aim, buttons: fire | boost };
  };

  let seq = 0;
  const pacer = new Pacer();
  let previous: { t: number; c: [number, number] } | null = null;
  // The bolts of the last few ticks the page took; the interpolated view draws the one two ticks back.
  const recent: Map<number, { x: number; z: number }>[] = [];
  const claimed = new Set<number>();
  let shotsBefore = new Map<number, { x: number; z: number }>();
  let inputAt: number | null = null;
  let startedFrame = -1;

  for (let now = 0; now < seconds * 1000; now += 1) {
    // The sim: a 30 Hz tick taking the inputs that have landed.
    if (now >= simTick * TICK_MS) {
      simTick++;
      while (toSim[0] && toSim[0].at <= now) {
        const input = toSim.shift()!.what;
        if (applied >= 0 && !after(input.seq, applied)) continue;
        newest = newest && after(newest.seq, applied) ? { ...input, buttons: input.buttons | newest.buttons } : input;
        heard = now;
      }
      const controls = new Int32Array(12);
      if (newest && now - heard <= 100) {
        controls.set([1, newest.seq, newest.moveX, newest.moveZ, newest.aim, newest.buttons]);
        applied = newest.seq;
        newest = { ...newest, buttons: 0 };
      }
      // Ben rams ana for two and a half seconds, then backs off.
      const crafts = decodeTick(world.record());
      const [a, b] = crafts.crafts;
      const [dx, dz] = [a!.x - b!.x, a!.z - b!.z];
      const d = Math.max(1, Math.hypot(dx, dz));
      const toward = now % 4000 < 2500 ? 127 : -60;
      controls.set([1, simTick, Math.round((dx / d) * toward), Math.round((dz / d) * toward), 0, 0], 6);
      a!.free();
      b!.free();
      crafts.free();
      world.step(controls);
      lastToPage = Math.max(lastToPage, now + latencyMs + random() * 10);
      if (random() >= lose) toPage.push({ at: lastToPage, what: world.record() });
    }

    // The page: an input every 33 ms on its own clock, a little faster than the sim's.
    if (own.ready && pacer.due(now)) {
      seq = (seq + 1) & 0xffff;
      const c = control(now);
      own.steer(c);
      own.send(seq, c, now);
      lastToSim = Math.max(lastToSim, now + latencyMs + random() * 10);
      toSim.push({ at: lastToSim, what: { ...c, seq } });
    }
    while (toPage[0] && toPage[0].at <= now) {
      const tick: Tick = decodeTick(toPage.shift()!.what);
      const bolts = tick.bolts;
      recent.push(new Map(bolts.map((b) => [b.id, { x: b.x, z: b.z }])));
      if (recent.length > 3) recent.shift();
      for (const b of bolts) b.free();
      const crafts = tick.crafts;
      const before: [number, number] = own.ready ? own.correction(now) : [0, 0];
      const lastInput = crafts[0]!.lastInput;
      const inRow = lastTick === tick.tick - 1;
      if (own.ready && inRow && lastApplied !== null && now > 2000 && ((lastInput - lastApplied) & 0xffff) !== 1) {
        run.uneven++;
      }
      if (own.ready) lastApplied = lastInput;
      lastTick = tick.tick;
      pacer.tick(tick.tick, now, own.ready ? lastInput : null);
      for (const c of crafts) c.free();
      own.reconcile(tick, now);
      const after = own.correction(now);
      run.maxError = Math.max(run.maxError, Math.hypot(after[0] - before[0], after[1] - before[1]));
      if (after[0] === 0 && after[1] === 0 && Math.hypot(...before) > 1) run.snaps++;
      run.reconciles++;
      for (const id of own.claimed) claimed.add(id);
      tick.free();
      // A correction is taken in without moving the craft, so the last frame's correction is measured afresh.
      if (previous) previous.c = own.correction(previous.t);
    }

    if (now % FRAME_MS < 1 && own.ready) {
      // A key goes down a little after a frame, five seconds in: how many frames until it shows?
      const unchanged = own.draw(now)!;
      if (startedFrame < 0 && now >= 5000) {
        startedFrame = run.frames;
        inputAt = now;
        own.steer({ ...control(now), moveX: -127, moveZ: -127, aim: 30000 });
      }
      const drawn = own.draw(now)!;
      const c = own.correction(now);
      if (previous) run.maxStep = Math.max(run.maxStep, Math.hypot(c[0] - previous.c[0], c[1] - previous.c[1]));
      // Both the aim and the move must show.
      const moved = Math.hypot(drawn.x - unchanged.x, drawn.z - unchanged.z) > 0;
      if (inputAt !== null && run.firstInputFrames < 0 && drawn.heading === 30000 && moved) {
        run.firstInputFrames = run.frames - startedFrame + 1;
      }
      const shown = recent.length >= 3 ? recent[0]! : new Map<number, { x: number; z: number }>();
      const shots = new Map(
        own
          .drawShots(
            now,
            (id) => shown.has(id),
            () => false,
          )
          .map((s) => [s.seq, s]),
      );
      for (const [s, shot] of shots) {
        const was = shotsBefore.get(s);
        if (!was) {
          run.shots++;
          continue;
        }
        if (Math.hypot(shot.x - was.x, shot.z - was.z) > (3000 / 60) * 1.0 + 10) run.shotJumps++;
      }
      shotsBefore = shots;
      previous = { t: now, c };
      run.frames++;
    }
  }
  run.matched = claimed.size;
  return run;
}

describe('prediction', () => {
  it('draws an input on the very next frame', () => {
    const run = play(100, 6);
    expect(run.firstInputFrames).toBe(1);
  });

  it('blends corrections out with no visible snap at 100 ms of added latency', () => {
    const run = play(100);
    console.log('100 ms each way:', run);
    expect(run.reconciles).toBeGreaterThan(500);
    // Ben's pushes and the sim's tick timing do make the prediction wrong...
    expect(run.maxError).toBeGreaterThan(5);
    // ...but no frame moves the craft more than 10 cm to fix it: four pixels at 1080p, less than a craft at full
    // speed moves in a frame.
    expect(run.maxStep).toBeLessThan(10);
    expect(run.snaps).toBe(0);
    // Paced by the sim's own clock, the sim applies each input once.
    expect(run.uneven).toBeLessThanOrEqual(2);
    expect(run.shots).toBeGreaterThan(20);
    expect(run.matched).toBeGreaterThan(run.shots * 0.9);
    expect(run.shotJumps).toBe(0);
  });

  it('still matches its shots to the sim’s bolts when ticks are lost', () => {
    const run = play(100, 20, 2, 0.05);
    console.log('100 ms each way, 5% of ticks lost:', run);
    expect(run.uneven).toBeLessThanOrEqual(2);
    expect(run.matched).toBeGreaterThan(run.shots * 0.9);
    expect(run.shotJumps).toBe(0);
    expect(run.maxStep).toBeLessThan(10);
  });

  it('keeps corrections small without added latency too', () => {
    const run = play(0);
    console.log('no added latency:', run);
    expect(run.maxStep).toBeLessThan(10);
    expect(run.snaps).toBe(0);
  });

  it('finds a send time the sim applies every input at, whatever the latency', () => {
    for (let latency = 0; latency < 34; latency += 3) {
      const run = play(latency, 8, latency);
      expect(run.uneven, `${latency} ms`).toBeLessThanOrEqual(4);
    }
  });
});
