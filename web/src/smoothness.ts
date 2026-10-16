// How smoothly the interpolator draws a run of ticks: the tests play ticks through it at 60 frames a second, with
// some lost, and compare every frame with the ticks as the sim committed them.
import { Interpolator, type Snapshot, TICK_MS } from './interpolation';
import { seeded } from './random';

/** A tick and when it reached the page. */
export interface Arrival {
  snapshot: Snapshot;
  arrivedMs: number;
}

/** What a run looked like. Distances in centimetres. */
export interface Smoothness {
  frames: number;
  /** Ticks left out of the run. */
  lost: number;
  /** Times two ticks in a row were left out. */
  lostRuns: number;
  /** The furthest any craft was drawn from where the committed ticks put it at the same moment. */
  maxError: number;
  /**
   * The furthest any craft moved in one frame beyond what its fastest committed speed around that moment allows: a
   * jump on screen.
   */
  maxJump: number;
  /** Frames where a moving craft did not move, or the render time stood still. */
  stalls: number;
  /** Frames drawn past the newest tick received. */
  extrapolated: number;
  minDelayMs: number;
  maxDelayMs: number;
}

const FRAME_MS = 1000 / 60;

/**
 * Play `arrivals` through an {@link Interpolator} at 60 frames a second, leaving out each arrival `lose` picks, and
 * measure every frame against `truth`: every tick the sim committed, in order.
 */
export function measure(arrivals: Arrival[], lose: (index: number) => boolean, truth: Snapshot[]): Smoothness {
  const byTick = new Map(truth.map((s) => [s.tick, s]));
  const kept = arrivals.filter((_, i) => !lose(i));
  const out: Smoothness = {
    frames: 0,
    lost: arrivals.length - kept.length,
    lostRuns: arrivals.filter((_, i) => i > 0 && lose(i) && lose(i - 1)).length,
    maxError: 0,
    maxJump: 0,
    stalls: 0,
    extrapolated: 0,
    minDelayMs: Infinity,
    maxDelayMs: 0,
  };
  const interpolator = new Interpolator();
  let next = 0;
  let previous: { r: number; at: Map<number, [number, number]>; truth: Map<number, [number, number]> } | null = null;
  // A second in, so the clock has settled, until the last arrival.
  const start = kept[0]!.arrivedMs + 1000;
  for (let now = kept[0]!.arrivedMs; now <= kept.at(-1)!.arrivedMs; now += FRAME_MS) {
    while (next < kept.length && kept[next]!.arrivedMs <= now) {
      interpolator.push(kept[next]!.snapshot, kept[next]!.arrivedMs);
      next++;
    }
    const view = interpolator.sample(now);
    if (!view || now < start) continue;
    out.frames++;
    out.minDelayMs = Math.min(out.minDelayMs, view.delayMs);
    out.maxDelayMs = Math.max(out.maxDelayMs, view.delayMs);
    if (view.extrapolating) out.extrapolated++;
    const at = new Map<number, [number, number]>();
    const real = new Map<number, [number, number]>();
    for (const craft of view.crafts) {
      const expected = position(byTick, craft.slot, view.renderTick);
      if (!craft.alive || !expected) continue;
      at.set(craft.slot, [craft.x, craft.z]);
      real.set(craft.slot, expected);
      out.maxError = Math.max(out.maxError, Math.hypot(craft.x - expected[0], craft.z - expected[1]));
    }
    if (previous) {
      if (view.renderTick - previous.r < (0.5 * FRAME_MS) / TICK_MS) out.stalls++;
      for (const [slot, [x, z]] of at) {
        const [px, pz] = previous.at.get(slot) ?? [x, z];
        const [tx, tz] = real.get(slot)!;
        const [ptx, ptz] = previous.truth.get(slot) ?? [tx, tz];
        const moved = Math.hypot(x - px, z - pz);
        const allowed = fastest(byTick, slot, previous.r, view.renderTick) * (view.renderTick - previous.r);
        out.maxJump = Math.max(out.maxJump, moved - allowed);
        if (Math.hypot(tx - ptx, tz - ptz) > 1 && moved < 0.1) out.stalls++;
      }
    }
    previous = { r: view.renderTick, at, truth: real };
  }
  return out;
}

/** The furthest `slot`'s craft moved in one tick, in the ticks from just before `from` to just after `to`. */
function fastest(byTick: Map<number, Snapshot>, slot: number, from: number, to: number): number {
  let top = 0;
  for (let t = Math.floor(from) - 1; t <= Math.ceil(to) + 1; t++) {
    const a = byTick.get(t - 1)?.crafts.find((craft) => craft.slot === slot);
    const b = byTick.get(t)?.crafts.find((craft) => craft.slot === slot);
    const step = a && b ? Math.hypot(b.x - a.x, b.z - a.z) : 0;
    if (step <= 300) top = Math.max(top, step);
  }
  return top;
}

/** Where the committed ticks put `slot`'s craft at tick time `r`, or `null` where it was dead or respawning. */
function position(byTick: Map<number, Snapshot>, slot: number, r: number): [number, number] | null {
  const a = byTick.get(Math.floor(r))?.crafts.find((c) => c.slot === slot);
  const b = byTick.get(Math.floor(r) + 1)?.crafts.find((c) => c.slot === slot);
  if (!a?.alive || !b?.alive || Math.hypot(b.x - a.x, b.z - a.z) > 300) return null;
  const f = r - Math.floor(r);
  return [a.x + (b.x - a.x) * f, a.z + (b.z - a.z) * f];
}

/** Picks one index in twenty of `count` to lose, at random but repeatably, in runs of one or two. */
export function oneInTwenty(count: number, seed = 11): (index: number) => boolean {
  if (count < 200) throw new Error(`${count} ticks are too few to lose one in twenty of`);
  const random = seeded(seed);
  const lost = new Set<number>();
  const target = Math.floor(count / 20);
  while (lost.size < target) {
    const i = 30 + Math.floor(random() * (count - 60));
    if (lost.has(i) || lost.has(i - 1) || lost.has(i + 1) || lost.has(i + 2) || lost.has(i - 2)) continue;
    lost.add(i);
    if (random() < 0.3 && lost.size < target) lost.add(i + 1);
  }
  return (i) => lost.has(i);
}
