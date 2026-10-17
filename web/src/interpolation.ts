// Everyone else's crafts and bolts, drawn between the two ticks around a render time that runs a little behind the
// newest tick received. docs/design.md, "Interpolation and prediction", describes the rules this follows.
import { boltSpeed, type Tick } from './core';

/** One tick at 30 Hz, in milliseconds. */
export const TICK_MS = 1000 / 30;
/** The render delay with a steady link: two ticks. */
export const MIN_DELAY_MS = 2 * TICK_MS;
/** The most the render delay grows to on a jittery link. */
export const MAX_DELAY_MS = 100;
/** Ticks kept: a second. */
const KEEP = 30;
/** Arrivals the clock and the jitter are judged over: two seconds. */
const WINDOW = 60;
/** Room left above the jitter, so a tick a little later than usual still arrives in time. */
const MARGIN_MS = 10;
/** Ticks apart that are still slid across: one or two missing between them. */
const BRIDGE = 3;
/** How far past the newest tick a craft is carried on by its velocity, in ticks. */
const EXTRAPOLATE = 2;
/** A craft further than this from where it was a tick ago was respawned, not moved, so it is not slid across. */
const TELEPORT_CM = 300;
/** How long the end of a guess past the newest tick takes to blend into the ticks that follow it. */
const BLEND_MS = 100;
/** The render clock runs at most this much faster or slower than real time while it catches its target. */
const SLEW = 0.1;
/** Further than this from its target, in milliseconds, the render clock jumps instead. */
const RESYNC_MS = 300;

/** A craft as a tick has it. Positions in centimetres, velocities in centimetres a second, headings in 65536ths. */
export interface CraftState {
  slot: number;
  violet: boolean;
  alive: boolean;
  x: number;
  z: number;
  vx: number;
  vz: number;
  heading: number;
  health: number;
  lastInput: number;
  /** Rail shots left, and ticks until a charging rail fires. */
  rail: number;
  charge: number;
  /** Under spawn protection: just respawned, and not hurt until it fires or the protection runs out. */
  protected: boolean;
}

/** A bolt as a tick has it. */
export interface BoltState {
  id: number;
  owner: number;
  x: number;
  z: number;
  heading: number;
}

/** The parts of a tick the renderer draws. */
export interface Snapshot {
  epoch: number;
  tick: number;
  crafts: CraftState[];
  bolts: BoltState[];
}

/** The snapshot of a decoded tick. */
export function snapshot(tick: Tick): Snapshot {
  const crafts = tick.crafts;
  const bolts = tick.bolts;
  const out = {
    epoch: tick.epoch,
    tick: tick.tick,
    crafts: crafts.map((c) => ({
      slot: c.slot,
      violet: c.violet,
      alive: c.alive,
      x: c.x,
      z: c.z,
      vx: c.vx,
      vz: c.vz,
      heading: c.heading,
      health: c.health,
      lastInput: c.lastInput,
      rail: c.rail,
      charge: c.charge,
      protected: c.protected,
    })),
    bolts: bolts.map((b) => ({ id: b.id, owner: b.owner, x: b.x, z: b.z, heading: b.heading })),
  };
  for (const item of [...crafts, ...bolts]) item.free();
  return out;
}

/** What to draw at one moment. Positions are fractional centimetres and headings fractional 65536ths. */
export interface View {
  /** The tick time being drawn. */
  renderTick: number;
  delayMs: number;
  /** Whether the render time has run past the newest tick, so crafts are carried on by their velocity. */
  extrapolating: boolean;
  crafts: CraftState[];
  bolts: BoltState[];
}

/** Ticks as they arrive, and the view between them at any moment. */
export class Interpolator {
  private ticks: Snapshot[] = [];
  /** Each recent arrival's time less its tick's place on the sim's clock, newest last. */
  private arrivals: number[] = [];
  private renderMs: number | null = null;
  private lastSampleMs: number | null = null;
  private delay = MIN_DELAY_MS;
  /** The tick crafts are being carried on from, past the newest or across a wide gap. */
  private carried: Snapshot | null = null;
  /** Each craft's distance from where it was guessed to be when the guess ended, blended out over {@link BLEND_MS}. */
  private offsets = new Map<number, [number, number]>();
  private blendFrom = -Infinity;

  /** The render delay now, in milliseconds. */
  get delayMs(): number {
    return this.delay;
  }

  /** The newest tick received. */
  get newest(): Snapshot | undefined {
    return this.ticks.at(-1);
  }

  /** Take a tick that arrived at `arrivedMs` on the page's clock. A tick from an older epoch, or a repeat, is ignored. */
  push(tick: Snapshot, arrivedMs: number): void {
    const newest = this.newest;
    if (newest && tick.epoch < newest.epoch) return;
    if (newest && tick.epoch === newest.epoch && tick.tick <= newest.tick) return;
    if (newest && tick.epoch > newest.epoch) this.reset();
    this.ticks.push(tick);
    if (this.ticks.length > KEEP) this.ticks.shift();
    this.arrivals.push(arrivedMs - tick.tick * TICK_MS);
    if (this.arrivals.length > WINDOW) this.arrivals.shift();
    this.delay = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, TICK_MS + lateness(this.arrivals) + MARGIN_MS));
  }

  /** Forget every tick, as after a resync. */
  reset(): void {
    this.ticks = [];
    this.arrivals = [];
    this.renderMs = null;
    this.lastSampleMs = null;
    this.delay = MIN_DELAY_MS;
    this.carried = null;
    this.offsets.clear();
  }

  /** The view at `nowMs` on the page's clock, or `null` before the first tick. Call once a frame, with rising times. */
  sample(nowMs: number): View | null {
    if (this.ticks.length === 0) return null;
    // The earliest arrival in the window is the one the network delayed least; the render time trails it.
    const target = nowMs - Math.min(...this.arrivals) - this.delay;
    const dt = this.lastSampleMs === null ? 0 : Math.max(0, nowMs - this.lastSampleMs);
    this.lastSampleMs = nowMs;
    if (this.renderMs === null || Math.abs(target - this.renderMs - dt) > RESYNC_MS) {
      this.renderMs = target;
      this.offsets.clear();
    } else {
      const ahead = this.renderMs + dt;
      this.renderMs = ahead + Math.max(-SLEW * dt, Math.min(SLEW * dt, target - ahead));
    }
    const r = this.renderMs / TICK_MS;
    const frame = this.at(r);
    // Carrying on past a tick guesses; when the ticks after it arrive, the guess is blended into them rather than
    // dropped in one frame.
    if (this.carried && frame.carried !== this.carried) {
      const guessed = this.carry(this.carried, r);
      const fade = this.fade(nowMs);
      for (const craft of frame.crafts) {
        const was = guessed.find((c) => c.slot === craft.slot);
        if (!was?.alive || !craft.alive) continue;
        const left = this.offsets.get(craft.slot) ?? [0, 0];
        const off: [number, number] = [was.x + left[0] * fade - craft.x, was.z + left[1] * fade - craft.z];
        if (Math.hypot(...off) < TELEPORT_CM) this.offsets.set(craft.slot, off);
      }
      this.blendFrom = nowMs;
    }
    this.carried = frame.carried;
    const fade = this.fade(nowMs);
    if (fade === 0) this.offsets.clear();
    const crafts = frame.crafts.map((c) => {
      const off = this.offsets.get(c.slot);
      return off && c.alive && fade > 0 ? { ...c, x: c.x + off[0] * fade, z: c.z + off[1] * fade } : c;
    });
    return { renderTick: r, delayMs: this.delay, extrapolating: frame.extrapolating, crafts, bolts: frame.bolts };
  }

  /** How much of the last blend is left at `nowMs`, from 1 down to 0. */
  private fade(nowMs: number): number {
    return Math.max(0, 1 - (nowMs - this.blendFrom) / BLEND_MS);
  }

  private at(r: number): {
    extrapolating: boolean;
    carried: Snapshot | null;
    crafts: CraftState[];
    bolts: BoltState[];
  } {
    const { ticks } = this;
    let i = ticks.length - 1;
    while (i > 0 && ticks[i]!.tick > r) i--;
    const a = ticks[i]!;
    const b = ticks[i + 1];
    if (a.tick > r) return { extrapolating: false, carried: null, crafts: a.crafts, bolts: a.bolts };
    if (b && b.tick - a.tick <= BRIDGE) {
      const f = (r - a.tick) / (b.tick - a.tick);
      return { extrapolating: false, carried: null, crafts: between(a, b, f), bolts: boltsBetween(a, b, f) };
    }
    // Past the newest tick, or across a gap too wide to slide over: carry on from `a` for a little while.
    const ticksOn = Math.min(r - a.tick, EXTRAPOLATE);
    return {
      extrapolating: !b,
      carried: a,
      crafts: this.carry(a, r),
      bolts: a.bolts.map((bolt) => along(bolt, ticksOn)),
    };
  }

  /**
   * The crafts of `a` carried on to `r` at the pace they last moved between ticks. That pace includes being pushed
   * by cover and other crafts, which the velocity alone does not.
   */
  private carry(a: Snapshot, r: number): CraftState[] {
    const ticksOn = Math.min(r - a.tick, EXTRAPOLATE);
    const before = this.ticks[this.ticks.indexOf(a) - 1];
    const span = before ? a.tick - before.tick : 0;
    return a.crafts.map((c) => {
      if (!c.alive) return c;
      const was = span > 0 && span <= BRIDGE ? before!.crafts.find((p) => p.slot === c.slot) : undefined;
      const [px, pz] =
        was?.alive && Math.hypot(c.x - was.x, c.z - was.z) <= TELEPORT_CM * span
          ? [(c.x - was.x) / span, (c.z - was.z) / span]
          : [(c.vx * TICK_MS) / 1000, (c.vz * TICK_MS) / 1000];
      return { ...c, x: c.x + px * ticksOn, z: c.z + pz * ticksOn };
    });
  }
}

/** The 95th percentile of how much later than the earliest each arrival in the window was. */
function lateness(arrivals: number[]): number {
  const earliest = Math.min(...arrivals);
  const late = arrivals.map((t) => t - earliest).sort((x, y) => x - y);
  return late[Math.floor((late.length - 1) * 0.95)]!;
}

/** The crafts `f` of the way from tick `a` to tick `b`. */
export function between(a: Snapshot, b: Snapshot, f: number): CraftState[] {
  // A craft that left is drawn until the tick that drops it; one that joined appears at its first tick.
  return a.crafts.map((from) => {
    const to = b.crafts.find((c) => c.slot === from.slot);
    if (!to) return from;
    // A death, a respawn or a teleport is shown at the tick it happened, not slid into.
    if (from.alive !== to.alive || Math.hypot(to.x - from.x, to.z - from.z) > TELEPORT_CM) return from;
    return {
      ...to,
      x: from.x + (to.x - from.x) * f,
      z: from.z + (to.z - from.z) * f,
      vx: from.vx + (to.vx - from.vx) * f,
      vz: from.vz + (to.vz - from.vz) * f,
      heading: turn(from.heading, to.heading, f),
    };
  });
}

/** The bolts `f` of the way from tick `a` to tick `b`. */
export function boltsBetween(a: Snapshot, b: Snapshot, f: number): BoltState[] {
  const out: BoltState[] = [];
  for (const from of a.bolts) {
    const to = b.bolts.find((bolt) => bolt.id === from.id);
    if (to) out.push({ ...to, x: from.x + (to.x - from.x) * f, z: from.z + (to.z - from.z) * f });
    // A bolt missing from `b` struck something on the way; it is drawn for the first half of the way there.
    else if (f < 0.5) out.push(along(from, f * (b.tick - a.tick)));
  }
  return out;
}

/** `bolt` moved on along its heading by `ticks` ticks of flight. */
function along(bolt: BoltState, ticks: number): BoltState {
  const cm = (boltSpeed() / 30) * ticks;
  const angle = (bolt.heading / 65536) * 2 * Math.PI;
  return { ...bolt, x: bolt.x + Math.cos(angle) * cm, z: bolt.z + Math.sin(angle) * cm };
}

/** The heading `f` of the way from `from` to `to`, the short way round. */
export function turn(from: number, to: number, f: number): number {
  const delta = ((((to - from) % 65536) + 98304) % 65536) - 32768;
  return (((from + delta * f) % 65536) + 65536) % 65536;
}
