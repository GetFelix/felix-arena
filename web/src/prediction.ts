// Your own craft and shots: stepped through core the moment an input is sent, and pulled back into line with each
// tick. docs/design.md, "Interpolation and prediction", describes the rules this follows.
import { boltSpeed, Prediction, type Tick } from './core';
import { TICK_MS } from './interpolation';

/** One tick of the player's controls, as an input carries them. */
export interface Control {
  /** -127 to 127. */
  moveX: number;
  moveZ: number;
  /** A heading, 65536ths of a turn. */
  aim: number;
  /** 1 fire, 2 boost. */
  buttons: number;
}

/** Where your craft is drawn. Centimetres and 65536ths of a turn. */
export interface OwnCraft {
  alive: boolean;
  x: number;
  z: number;
  vx: number;
  vz: number;
  heading: number;
  health: number;
  boostCooldown: number;
}

/** A shot you fired, drawn ahead of the sim. */
export interface OwnShot {
  seq: number;
  x: number;
  z: number;
  heading: number;
  /** How opaque to draw it, from 1 down to 0 as a shot the sim refused fades out. */
  opacity: number;
}

/** How long a correction from the sim takes to blend out. */
export const BLEND_MS = 100;
/** A correction larger than this is a respawn or a teleport, shown at once. */
const SNAP_CM = 300;
/** How long a shot the sim refused takes to fade. */
const FADE_MS = 150;
/** A shot is forgotten after this, whatever became of it: longer than any bolt flies plus a round trip. */
const GIVE_UP_MS = 3000;
/** Inputs kept for replay: three seconds, far more than any round trip. */
const KEEP = 90;
/** How far apart the input that fired a shot here and the one the sim fired it with may be. */
const MATCH = 3;

interface Sent extends Control {
  seq: number;
  /** Sent while the match was over, so the sim lets the craft coast. */
  coast: boolean;
}

interface Shot {
  seq: number;
  x: number;
  z: number;
  heading: number;
  firedMs: number;
  /** Ticks it flies before the arena stops it. */
  ticks: number;
  /** The sim's bolt, once its `fired` event has arrived. */
  bolt: number | null;
  /** When the interpolated view first drew the sim's bolt. */
  seenMs: number | null;
  /** It met a craft as drawn. */
  ended: boolean;
  fadeMs: number | null;
}

/** `a` is after `b`, with sequence numbers wrapping at 65536. */
export function after(a: number, b: number): boolean {
  return ((a - b) & 0xffff) !== 0 && ((a - b) & 0xffff) < 0x8000;
}

/** The player's own craft, predicted. */
export class Own {
  private pending: Sent[] = [];
  private state: Prediction | null = null;
  private steppedMs = 0;
  private offset: [number, number] = [0, 0];
  private blendFrom = -Infinity;
  private live: Control = { moveX: 0, moveZ: 0, aim: 0, buttons: 0 };
  private shots: Shot[] = [];
  private confirmed = false;
  /** The match is over and the sim ignores inputs. */
  frozen = false;

  constructor(readonly slot: number) {}

  /** Whether a tick has given the craft a state to predict from. */
  get ready(): boolean {
    return this.state !== null;
  }

  /** Step the craft by the input `seq` as it is sent at `nowMs`. */
  send(seq: number, control: Control, nowMs: number): void {
    this.pending.push({ seq, ...control, coast: this.frozen });
    if (this.pending.length > KEEP) this.pending.shift();
    if (!this.state) return;
    this.steppedMs = nowMs;
    if (this.frozen) {
      this.state.coast();
      return;
    }
    const shot = this.state.step(seq, control.moveX, control.moveZ, control.aim, control.buttons);
    // A rail is a beam the sim judges and the page draws when its tick says so; only bolts are predicted.
    if (shot?.rail) shot.free();
    else if (shot) {
      this.shots.push({
        seq,
        x: shot.x,
        z: shot.z,
        heading: shot.heading,
        firedMs: nowMs,
        ticks: shot.ticks,
        bolt: null,
        seenMs: null,
        ended: false,
        fadeMs: null,
      });
      shot.free();
    }
  }

  /**
   * Take the sim's word for the craft from a new tick: start again from its craft, replay the inputs the sim has not
   * applied yet against the other crafts where the tick has them, and blend the difference from what was on screen
   * out over {@link BLEND_MS}.
   */
  reconcile(tick: Tick, nowMs: number): void {
    const crafts = tick.crafts;
    const craft = crafts.find((c) => c.slot === this.slot);
    if (!craft) {
      for (const c of crafts) c.free();
      return;
    }
    const before = this.state ? this.draw(nowMs) : null;
    const lastInput = craft.lastInput;
    // Until the sim has applied one of ours, the craft's last input is someone else's count, as for a fresh craft.
    this.confirmed ||= this.pending.some((input) => input.seq === lastInput);
    if (this.confirmed) this.pending = this.pending.filter((input) => after(input.seq, lastInput));
    const next = new Prediction(craft);
    next.among(tick);
    for (const input of this.pending) {
      if (input.coast) next.coast();
      else next.step(input.seq, input.moveX, input.moveZ, input.aim, input.buttons)?.free();
    }
    for (const c of crafts) c.free();
    this.state?.free();
    this.state = next;
    const now = this.raw(nowMs);
    const [dx, dz] = before ? [before.x - now.x, before.z - now.z] : [0, 0];
    if (before?.alive && now.alive && Math.hypot(dx, dz) < SNAP_CM) {
      this.offset = [dx, dz];
      this.blendFrom = nowMs;
    } else {
      this.offset = [0, 0];
      this.blendFrom = -Infinity;
    }

    const gap = (a: number, b: number) => Math.abs(((a - b + 32768) & 0xffff) - 32768);
    const taken = this.claimed;
    const events = tick.events;
    for (const event of events) {
      if (event.kind !== 'fired' || event.slot !== this.slot || taken.has(event.bolt)) continue;
      const near = this.shots
        .filter((s) => s.bolt === null && gap(event.seq, s.seq) <= MATCH)
        .sort((a, b) => gap(event.seq, a.seq) - gap(event.seq, b.seq))[0];
      if (near) {
        near.bolt = event.bolt;
        taken.add(event.bolt);
      }
    }
    for (const event of events) event.free();
    // A tick lost on the way takes its `fired` event with it; the sim's bolt is then known by flying our heading.
    const bolts = tick.bolts;
    for (const bolt of bolts) {
      if (bolt.owner !== this.slot || taken.has(bolt.id)) continue;
      const shot = this.shots.find((s) => s.bolt === null && s.heading === bolt.heading);
      if (shot) {
        shot.bolt = bolt.id;
        taken.add(bolt.id);
      }
    }
    for (const bolt of bolts) bolt.free();
    for (const shot of this.shots) {
      // The sim has applied inputs well past this shot's and fired nothing for it: it refused the shot.
      if (shot.bolt === null && shot.fadeMs === null && after(lastInput, (shot.seq + MATCH) & 0xffff)) {
        shot.fadeMs = nowMs;
      }
    }
  }

  /** Free the prediction's WebAssembly memory. */
  dispose(): void {
    this.state?.free();
    this.state = null;
  }

  /** The controls as sampled this frame, which the craft is drawn moving under until the next input is sent. */
  steer(control: Control): void {
    this.live = control;
  }

  /** How far the drawn craft is from the prediction, while a correction blends out. */
  correction(nowMs: number): [number, number] {
    const fade = Math.min(1, Math.max(0, 1 - (nowMs - this.blendFrom) / BLEND_MS));
    return [this.offset[0] * fade, this.offset[1] * fade];
  }

  /** The craft to draw at `nowMs`, or `null` before the first tick. */
  draw(nowMs: number): OwnCraft | null {
    if (!this.state) return null;
    const craft = this.raw(nowMs);
    const [cx, cz] = this.correction(nowMs);
    return { ...craft, x: craft.x + cx, z: craft.z + cz };
  }

  /**
   * Your shots to draw at `nowMs`. Each flies its own path ahead of the sim's bolt, which is later in time by the
   * round trip and the render delay, and ends where the arena stops it, where `hits` says it meets a craft as
   * drawn, or when the sim's bolt ends. `drawn` says whether the interpolated view draws one of the sim's bolts.
   */
  drawShots(nowMs: number, drawn: (id: number) => boolean, hits: (x: number, z: number) => boolean): OwnShot[] {
    const out: OwnShot[] = [];
    const cmPerMs = boltSpeed() / 1000;
    this.shots = this.shots.filter((shot) => {
      const flown = nowMs - shot.firedMs;
      if (shot.bolt !== null && drawn(shot.bolt)) shot.seenMs ??= nowMs;
      else if (shot.seenMs !== null) return false;
      let opacity = 1;
      if (shot.fadeMs !== null) {
        opacity = 1 - (nowMs - shot.fadeMs) / FADE_MS;
        if (opacity <= 0) return false;
      }
      if (flown > GIVE_UP_MS) return false;
      // A shot that has ended is not drawn, but is kept until the sim's bolt for it has come and gone, so that bolt
      // is never drawn a second time.
      if (shot.ended || flown > (shot.ticks + 0.5) * TICK_MS) return true;
      const angle = (shot.heading / 65536) * 2 * Math.PI;
      const x = shot.x + Math.cos(angle) * cmPerMs * flown;
      const z = shot.z + Math.sin(angle) * cmPerMs * flown;
      if (hits(x, z)) {
        shot.ended = true;
        return true;
      }
      out.push({ seq: shot.seq, x, z, heading: shot.heading, opacity });
      return true;
    });
    return out;
  }

  /** Where each shot fired after `sinceMs` left the craft, for its muzzle flash. */
  firedSince(sinceMs: number): { x: number; z: number }[] {
    return this.shots.filter((shot) => shot.firedMs > sinceMs);
  }

  /** The sim's ids of the bolts drawn here as predicted shots, so the interpolated view leaves them out. */
  get claimed(): Set<number> {
    return new Set(this.shots.flatMap((shot) => (shot.bolt === null ? [] : [shot.bolt])));
  }

  /** The prediction moved on through the part of a tick since the last input, under the live controls. */
  private raw(nowMs: number): OwnCraft {
    const state = this.state!;
    const base = state.craft;
    const ahead = state.clone();
    const { moveX, moveZ } = this.live;
    const aim = this.frozen ? base.heading : this.live.aim;
    if (this.frozen) ahead.coast();
    else ahead.step(0, moveX, moveZ, aim, 0)?.free();
    const next = ahead.craft;
    const f = Math.min(1, Math.max(0, (nowMs - this.steppedMs) / TICK_MS));
    const out: OwnCraft = {
      alive: base.alive,
      x: base.x + (next.x - base.x) * f,
      z: base.z + (next.z - base.z) * f,
      vx: next.vx,
      vz: next.vz,
      // The craft faces where you aim at once.
      heading: base.alive ? aim : base.heading,
      health: base.health,
      boostCooldown: base.boostCooldown,
    };
    base.free();
    next.free();
    ahead.free();
    return out;
  }
}

/** Arrivals the pacer judges the sim's clock over: two seconds. */
const PACE_WINDOW = 60;
/** Ticks the pacer counts misses over, and how many it takes to move. */
const MISS_WINDOW = 30;
const MISSES = 3;
/** Ticks after a move whose misses are the move's own, two round trips at 200 ms, and are not counted. */
const SETTLE = 12;

/**
 * When to send each input: once a sim tick, in step with the sim's clock as the ticks show it, so the sim applies
 * every input exactly once. A page timer of its own would drift against the sim's, and each drifted tick is an
 * input the sim skips or applies twice, which the prediction then has to take back.
 */
export class Pacer {
  private arrivals: number[] = [];
  private phase = 0;
  private sent: number | null = null;
  private lastApplied: number | null = null;
  private lastTick: number | null = null;
  private misses: number[] = [];
  private settleUntil = -Infinity;
  private fallback = 0;

  /** Learn from the tick `tick` that arrived at `arrivedMs`, whose own craft had applied input `lastInput`. */
  tick(tick: number, arrivedMs: number, lastInput: number | null): void {
    this.arrivals.push(arrivedMs - tick * TICK_MS);
    if (this.arrivals.length > PACE_WINDOW) this.arrivals.shift();
    if (lastInput === null) return;
    // The sim applying no new input, or two at once, means inputs reach it on the edge of its tick: move half a tick.
    // Only ticks in a row say anything: across a lost tick the sim rightly applied two inputs.
    const missed =
      this.lastApplied !== null && this.lastTick === tick - 1 && ((lastInput - this.lastApplied) & 0xffff) !== 1;
    if (missed && tick > this.settleUntil) this.misses.push(tick);
    this.lastApplied = lastInput;
    this.lastTick = tick;
    this.misses = this.misses.filter((t) => t > tick - MISS_WINDOW);
    if (this.misses.length >= MISSES) {
      this.phase = (this.phase + TICK_MS / 2) % TICK_MS;
      this.misses = [];
      this.settleUntil = tick + SETTLE;
    }
  }

  /** Whether an input is due at `nowMs`. Call often; answers true once a tick. */
  due(nowMs: number): boolean {
    if (this.arrivals.length === 0) {
      if (nowMs < this.fallback) return false;
      this.fallback = nowMs + TICK_MS;
      return true;
    }
    const slot = Math.floor((nowMs - Math.min(...this.arrivals) - this.phase) / TICK_MS);
    if (this.sent !== null && slot <= this.sent && slot > this.sent - 30) return false;
    this.sent = slot;
    return true;
  }
}
