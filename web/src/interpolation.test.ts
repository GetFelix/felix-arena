import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeTick, loadCore, World } from './core';
import {
  ArrivalClock,
  Interpolator,
  MAX_DELAY_MS,
  MIN_DELAY_MS,
  type Snapshot,
  snapshot,
  TICK_MS,
  turn,
  type View,
} from './interpolation';
import { seeded } from './random';
import { type Arrival, measure, oneInTwenty } from './smoothness';

beforeAll(() => loadCore(readFileSync(new URL('./core/felix_arena_core_bg.wasm', import.meta.url))));

/**
 * Thirty seconds of a four-player match from core's own world. Each player wanders, boosts now and then, and fires
 * bursts at an opponent, so crafts turn, stop at cover, dash, die and respawn.
 */
function recordMatch(ticks = 900): Snapshot[] {
  const world = new World();
  for (const name of ['ana', 'ben', 'cleo', 'dan']) world.join(name);
  const random = seeded(7);
  const course = [0, 1, 2, 3].map(() => ({ angle: random() * 2 * Math.PI, turn: 0 }));
  const out: Snapshot[] = [snapshot(decodeTick(world.record()))];
  for (let t = 1; t <= ticks; t++) {
    const crafts = out.at(-1)!.crafts;
    const controls: number[] = [];
    course.forEach((c, slot) => {
      if (t % 20 === 0) c.turn = (random() - 0.5) * 0.3;
      c.angle += c.turn;
      // Slots alternate teams, so each one's opponent is its neighbour.
      const [me, them] = [crafts[slot]!, crafts[slot ^ 1]!];
      const aim = Math.round((Math.atan2(them.z - me.z, them.x - me.x) / (2 * Math.PI)) * 65536) & 0xffff;
      const boost = random() < 1 / 90 ? 2 : 0;
      const fire = t % 60 < 30 ? 1 : 0;
      controls.push(1, t, Math.round(Math.cos(c.angle) * 127), Math.round(Math.sin(c.angle) * 127), aim, boost | fire);
    });
    world.step(Int32Array.from(controls));
    out.push(snapshot(decodeTick(world.record())));
  }
  return out.slice(1);
}

/** One craft flying straight at a steady speed. */
function cruise(ticks: number): Snapshot[] {
  const world = new World();
  world.join('ana');
  const out: Snapshot[] = [];
  for (let t = 1; t <= ticks; t++) {
    world.step(Int32Array.from([1, t, 100, 0, 0, 0]));
    out.push(snapshot(decodeTick(world.record())));
  }
  return out;
}

/** Plays `ticks` through an interpolator on a steady link at 60 frames a second, without the ones in `missing`. */
function play(ticks: Snapshot[], missing: Set<number>, look: (view: View) => void): void {
  const arrivals = deliver(ticks, () => 0).filter((a) => !missing.has(a.snapshot.tick));
  const interpolator = new Interpolator();
  let next = 0;
  for (let now = arrivals[0]!.arrivedMs; now < arrivals.at(-1)!.arrivedMs; now += 1000 / 60) {
    while (arrivals[next] && arrivals[next]!.arrivedMs <= now) {
      interpolator.push(arrivals[next]!.snapshot, arrivals[next]!.arrivedMs);
      next++;
    }
    look(interpolator.sample(now)!);
  }
}

/**
 * When each tick reaches the page: committed every 33 ms, 20 ms of network, plus `jitter` drawn per tick. A
 * WebSocket is one TCP stream, so a late tick holds up the ones behind it.
 */
function deliver(ticks: Snapshot[], jitter: (random: () => number) => number, seed = 3): Arrival[] {
  const random = seeded(seed);
  let last = 0;
  return ticks.map((s) => {
    last = Math.max(last, s.tick * TICK_MS + 20 + jitter(random));
    return { snapshot: s, arrivedMs: last };
  });
}

const steady = (random: () => number) => random() * 12;
// Mostly under 20 ms late, with one tick in ten held up to 60 ms.
const jittery = (random: () => number) => (random() < 0.1 ? 20 + random() * 40 : random() * 20);

describe('interpolation', () => {
  let truth: Snapshot[] = [];
  beforeAll(() => {
    truth = recordMatch();
  });

  it('records a match where crafts really move, dash and die', () => {
    const speeds = truth.flatMap((s) => s.crafts.map((c) => Math.hypot(c.vx, c.vz)));
    expect(Math.max(...speeds)).toBeGreaterThan(1500);
    expect(truth.some((s) => s.crafts.some((c) => !c.alive))).toBe(true);
    expect(truth.some((s) => s.bolts.length > 0)).toBe(true);
  });

  it('draws other crafts smoothly through 5% lost ticks on a jittery link', () => {
    const lose = oneInTwenty(truth.length);
    const run = measure(deliver(truth, jittery), lose, truth);
    console.log('5% lost, jittery:', run);
    expect(run.lost).toBe(truth.length / 20);
    expect(run.lostRuns).toBeGreaterThan(5);
    expect(run.frames).toBeGreaterThan(1500);
    expect(run.stalls).toBe(0);
    expect(run.starved + run.recovering).toBe(0);
    // A frame never moves a craft more than 4 cm away from the step the committed ticks take over the same time.
    expect(run.maxJump).toBeLessThan(4);
    // Linear blending across a lost tick cuts corners a little; a dash that starts inside a gap is the worst case.
    expect(run.maxError).toBeLessThan(40);
    expect(run.maxDelayMs).toBeLessThanOrEqual(MAX_DELAY_MS);
  });

  it('keeps two ticks of delay on a steady link and grows toward 100 ms when arrivals jitter', () => {
    const calm = measure(deliver(truth, steady), () => false, truth);
    expect(calm.maxDelayMs).toBeCloseTo(MIN_DELAY_MS, 6);
    expect(calm.extrapolated).toBe(0);
    expect(calm.maxJump).toBeLessThan(0.5);

    const rough = measure(
      deliver(truth, (random) => random() * 70),
      () => false,
      truth,
    );
    expect(rough.maxDelayMs).toBeGreaterThan(90);
    expect(rough.maxDelayMs).toBeLessThanOrEqual(MAX_DELAY_MS);
    expect(rough.stalls).toBe(0);
  });

  it('leaves every frame of the blend after a hold-up out of the measures, on the Unix clock', () => {
    // A steady link that holds the ticks up for 110 ms once, stamped as the gateway stamps them: milliseconds since
    // 1970, where adding up frame lengths drifts.
    const epoch = Date.UTC(2026, 9, 17);
    const steadily = deliver(truth, steady);
    const until = steadily[300]!.arrivedMs + 110;
    const held = steadily.map((a, i) => ({
      ...a,
      arrivedMs: epoch + (i >= 300 ? Math.max(a.arrivedMs, until) : a.arrivedMs),
    }));
    const run = measure(held, () => false, truth);
    expect(run.starved).toBeGreaterThan(0);
    expect(run.recovering).toBe(7);
    expect(run.maxJump).toBeLessThan(0.5);
  });

  it('sets aside the frames around a hold-up in the arrivals when asked, and judges the rest', () => {
    const steadily = deliver(truth, steady);
    const until = steadily[300]!.arrivedMs + 250;
    const held = steadily.map((a, i) => ({ ...a, arrivedMs: i >= 300 ? Math.max(a.arrivedMs, until) : a.arrivedMs }));
    const lose = oneInTwenty(truth.length);
    const counted = measure(held, lose, truth);
    expect(counted.starved).toBeGreaterThan(0);
    expect(counted.heldUp).toBe(0);

    const run = measure(held, lose, truth, { setAsideHoldUps: true });
    expect(run.heldUp).toBeGreaterThan(counted.starved);
    expect(run.heldUp).toBeLessThan(run.frames / 4);
    expect(run.starved + run.recovering).toBe(0);
    expect(run.stalls).toBe(0);
    expect(run.maxJump).toBeLessThan(4);
  });

  it('sets nothing aside on a steady link, even with ticks missing on time', () => {
    const lose = oneInTwenty(truth.length);
    const arrivals = deliver(truth, steady);
    const plain = measure(arrivals, lose, truth);
    const run = measure(arrivals, lose, truth, { setAsideHoldUps: true });
    expect(run.heldUp).toBe(0);
    expect(run).toEqual(plain);
  });

  it('sets aside the sim stalling for good: its ticks run late from then on', () => {
    // The sim stalls for 110 ms and does not make the ticks up, so every tick after it comes 110 ms after its turn.
    const steadily = deliver(truth, steady);
    const stalled = steadily.map((a, i) => ({ ...a, arrivedMs: a.arrivedMs + (i >= 300 ? 110 : 0) }));
    const run = measure(stalled, () => false, truth, { setAsideHoldUps: true });
    expect(run.heldUp).toBeGreaterThan(0);
    expect(run.heldUp).toBeLessThan(run.frames / 20);
    expect(run.starved + run.recovering).toBe(0);
    expect(run.stalls).toBe(0);
    expect(run.maxJump).toBeLessThan(4);
  });

  it('slides across one missing tick inside the two-tick delay', () => {
    const ticks = cruise(140);
    let frames = 0;
    play(ticks, new Set([100]), (view) => {
      expect(view.extrapolating).toBe(false);
      if (view.renderTick > 99 && view.renderTick < 101) {
        frames++;
        const [a, b] = [ticks[98]!.crafts[0]!, ticks[100]!.crafts[0]!];
        expect(view.crafts[0]!.x).toBeCloseTo(a.x + ((b.x - a.x) * (view.renderTick - 99)) / 2, 6);
      }
    });
    expect(frames).toBe(4);
  });

  it('carries a craft on across two missing ticks and stays on its course', () => {
    const ticks = cruise(140);
    let carried = 0;
    play(ticks, new Set([100, 101]), (view) => {
      if (view.extrapolating) carried++;
      if (view.renderTick < 2) return;
      const t = Math.floor(view.renderTick);
      const [a, b] = [ticks[t - 1]!.crafts[0]!, ticks[t]!.crafts[0]!];
      const x = a.x + (b.x - a.x) * (view.renderTick - t);
      expect(Math.abs(view.crafts[0]!.x - x)).toBeLessThan(0.5);
    });
    // Two ticks missing behind a two-tick delay leave one tick, two frames, to carry on through.
    expect(carried).toBe(2);
  });

  it('ignores repeats and older epochs, and starts over on a newer one', () => {
    const interpolator = new Interpolator();
    interpolator.push(truth[10]!, 0);
    interpolator.push(truth[9]!, 1);
    interpolator.push({ ...truth[20]!, epoch: 0 }, 2);
    expect(interpolator.newest?.tick).toBe(truth[20]!.tick);
    const later = (i: number) => ({ ...truth[i]!, epoch: 1 });
    interpolator.push(later(3), 1000);
    interpolator.push(later(4), 1000 + TICK_MS);
    expect(interpolator.newest).toMatchObject({ epoch: 1, tick: truth[4]!.tick });
    // Only epoch 1's ticks are left, so the render time is among them and not near tick 21.
    const view = interpolator.sample(1000 + TICK_MS + MIN_DELAY_MS)!;
    expect(view.renderTick).toBeCloseTo(truth[4]!.tick, 6);
  });

  it('moves bolts along the committed ones', () => {
    let compared = 0;
    play(truth.slice(0, 300), new Set(), (view) => {
      const t = Math.floor(view.renderTick);
      const [a, b] = [truth[t - 1], truth[t]];
      if (!a || !b || t < 3) return;
      for (const bolt of view.bolts) {
        const [from, to] = [a.bolts.find((x) => x.id === bolt.id), b.bolts.find((x) => x.id === bolt.id)];
        if (!from || !to) continue;
        const f = view.renderTick - t;
        expect(bolt.x).toBeCloseTo(from.x + (to.x - from.x) * f, 6);
        expect(bolt.z).toBeCloseTo(from.z + (to.z - from.z) * f, 6);
        compared++;
      }
    });
    expect(compared).toBeGreaterThan(100);
  });

  it('turns the short way round', () => {
    expect(turn(65000, 500, 0.5)).toBeCloseTo((65000 + 518) % 65536, 6);
    expect(turn(500, 65000, 0.5)).toBeCloseTo(65536 + 500 - 518, 6);
    expect(turn(0, 16384, 0.5)).toBe(8192);
  });
});

describe('after the sim stalls', () => {
  /** Ticks that arrive on schedule, except that from `stallAt` the sim has skipped `skipped` ticks of wall time. */
  function stalled(ticks: Snapshot[], stallAt: number, skipped: number): Arrival[] {
    return ticks.map((s) => ({
      snapshot: s,
      arrivedMs: (s.tick + (s.tick >= stallAt ? skipped : 0)) * TICK_MS + 20,
    }));
  }

  it('moves the page clock onto the ticks within a quarter of a second, not the window', () => {
    const arrivals = stalled(cruise(300), 100, 6);
    const interpolator = new Interpolator();
    let next = 0;
    const settled: View[] = [];
    for (let now = arrivals[0]!.arrivedMs; now < arrivals.at(-1)!.arrivedMs; now += 1000 / 60) {
      while (arrivals[next] && arrivals[next]!.arrivedMs <= now) {
        interpolator.push(arrivals[next]!.snapshot, arrivals[next]!.arrivedMs);
        next++;
      }
      const view = interpolator.sample(now)!;
      // The 8 ticks it takes to see the stall are 267 ms; after another half second the view is steady again.
      if (next > 100 + 8 + 15) settled.push(view);
    }
    expect(settled.length).toBeGreaterThan(300);
    expect(settled.filter((v) => v.extrapolating)).toEqual([]);
    expect(Math.max(...settled.map((v) => v.delayMs))).toBeLessThan(MIN_DELAY_MS + 15);
  });

  it('does not take a single late tick, or a short run of them, for a stall', () => {
    const arrivals = deliver(cruise(200), (random) => (random() < 0.1 ? 20 + random() * 40 : random() * 20));
    const interpolator = new Interpolator();
    for (const a of arrivals) interpolator.push(a.snapshot, a.arrivedMs);
    expect(interpolator.delayMs).toBeGreaterThan(MIN_DELAY_MS);
  });
});

describe('ticks read back from the log', () => {
  it('say nothing about the link, so they do not move the delay or the clock', () => {
    const arrivals = cruise(120).map((s) => ({ snapshot: s, arrivedMs: s.tick * TICK_MS + 20 }));
    const interpolator = new Interpolator();
    for (const a of arrivals.slice(0, 60)) interpolator.push(a.snapshot, a.arrivedMs);
    const before = interpolator.sample(arrivals[59]!.arrivedMs)!;
    const delay = interpolator.delayMs;
    // Seconds late, and enough of them to read as a stall if they counted.
    for (const a of arrivals.slice(60, 90)) interpolator.push(a.snapshot, a.arrivedMs + 5000, false);
    expect(interpolator.delayMs).toBe(delay);
    const after = interpolator.sample(arrivals[59]!.arrivedMs + 16)!;
    expect(Math.abs(after.renderTick - before.renderTick)).toBeLessThan(1);
  });

  it('leave nothing to sample by until a live tick arrives', () => {
    const interpolator = new Interpolator();
    interpolator.push(cruise(2)[1]!, 1000, false);
    expect(interpolator.sample(1000)).toBeNull();
  });
});

describe('ArrivalClock', () => {
  it('moves only when eight arrivals in a row sit more than two ticks above the earliest', () => {
    const clock = new ArrivalClock(60);
    for (let n = 0; n < 30; n++) expect(clock.add(n, n * TICK_MS)).toBe(false);
    // Seven ticks three ticks late is a hiccup; the eighth makes it a new clock.
    const moved = [];
    for (let n = 30; n < 38; n++) moved.push(clock.add(n, (n + 3) * TICK_MS));
    expect(moved).toEqual([false, false, false, false, false, false, false, true]);
    expect(clock.earliest).toBeCloseTo(3 * TICK_MS);
    expect(clock.length).toBe(8);
  });

  it('is not moved by a run that comes back down', () => {
    const clock = new ArrivalClock(60);
    for (let n = 0; n < 30; n++) clock.add(n, n * TICK_MS);
    for (let n = 30; n < 37; n++) clock.add(n, (n + 3) * TICK_MS);
    expect(clock.add(37, 37 * TICK_MS)).toBe(false);
    expect(clock.earliest).toBeCloseTo(0);
  });
});
