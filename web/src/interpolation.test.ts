import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeTick, loadCore, World } from './core';
import {
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
