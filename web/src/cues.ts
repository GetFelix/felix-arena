// Which sound each thing in the game makes. Everything here is plain data and functions of it, so the mapping from a
// game event to a sound can be tested without a browser. sound.ts plays the result.
import type { Phase } from './match';
import type { Point } from './spatial';

export type CueName =
  | 'fire'
  | 'hit'
  | 'hurt'
  | 'absorb'
  | 'explode'
  | 'destroyed'
  | 'rail'
  | 'pickup'
  | 'spawn'
  | 'boost'
  | 'overheat'
  | 'tick'
  | 'go'
  | 'round-end'
  | 'click'
  | 'toggle'
  | 'replay-in'
  | 'replay-out';

export interface CueSpec {
  /** Files in prototype/assets/audio/sfx, without the extension. A cue with several picks one at random, never the same twice running. */
  files: readonly string[];
  /** How loud the cue is before the effects volume, 0 to 1. */
  gain: number;
  /** Plays closer together than this are dropped, so eight crafts firing at once is not eight stacked shots. */
  minGapMs: number;
}

export const CUES: Record<CueName, CueSpec> = {
  fire: { files: ['fire-1', 'fire-2', 'fire-3'], gain: 0.5, minGapMs: 45 },
  hit: { files: ['hit-1', 'hit-2'], gain: 0.6, minGapMs: 60 },
  hurt: { files: ['hurt'], gain: 0.8, minGapMs: 90 },
  absorb: { files: ['absorb'], gain: 0.6, minGapMs: 120 },
  explode: { files: ['explode-1', 'explode-2'], gain: 0.8, minGapMs: 150 },
  destroyed: { files: ['destroyed'], gain: 0.9, minGapMs: 500 },
  rail: { files: ['rail'], gain: 0.7, minGapMs: 200 },
  pickup: { files: ['pickup'], gain: 0.7, minGapMs: 300 },
  spawn: { files: ['spawn'], gain: 0.5, minGapMs: 120 },
  boost: { files: ['boost'], gain: 0.55, minGapMs: 300 },
  overheat: { files: ['overheat'], gain: 0.45, minGapMs: 500 },
  tick: { files: ['tick'], gain: 0.6, minGapMs: 400 },
  go: { files: ['go'], gain: 0.7, minGapMs: 1000 },
  'round-end': { files: ['round-end'], gain: 0.7, minGapMs: 1000 },
  click: { files: ['click'], gain: 0.5, minGapMs: 30 },
  toggle: { files: ['toggle'], gain: 0.5, minGapMs: 30 },
  'replay-in': { files: ['replay-in'], gain: 0.5, minGapMs: 500 },
  'replay-out': { files: ['replay-out'], gain: 0.5, minGapMs: 500 },
};

/** One sound to play. */
export interface Play {
  cue: CueName;
  /** Where it comes from, or null for one with no place: your own craft and the interface. */
  at: Point | null;
  /** Scales the cue's own gain: what happens to others is quieter than what happens to you. */
  gain: number;
}

/** The part of a tick event the sounds care about. `slot` is the craft it happened to, and `by` the one that did it. */
export interface GameEvent {
  kind: string;
  slot: number;
  by: number;
  damage: number;
}

/**
 * The sounds for `event`, which happened at `at`, the position of the craft in `event.slot`. `own` is your slot, or null
 * for a spectator, who hears everything from the middle of the arena and nothing as their own.
 */
export function playsFor(event: GameEvent, at: Point, own: number | null): Play[] {
  const mine = own !== null && event.slot === own;
  const byMe = own !== null && event.by === own;
  switch (event.kind) {
    case 'fired':
      return [mine ? { cue: 'fire', at: null, gain: 1 } : { cue: 'fire', at, gain: 0.6 }];
    case 'hit':
      // A shot the spawn shield stopped does no damage.
      if (event.damage === 0) return [mine ? { cue: 'absorb', at: null, gain: 1 } : { cue: 'absorb', at, gain: 0.6 }];
      if (mine) return [{ cue: 'hurt', at: null, gain: 1 }];
      return [{ cue: 'hit', at, gain: byMe ? 1 : 0.6 }];
    case 'killed':
      if (mine) return [{ cue: 'destroyed', at: null, gain: 1 }];
      return [{ cue: 'explode', at, gain: byMe ? 1 : 0.7 }];
    case 'railed':
      return [mine ? { cue: 'rail', at: null, gain: 1 } : { cue: 'rail', at, gain: 0.7 }];
    case 'picked':
      return [mine ? { cue: 'pickup', at: null, gain: 1 } : { cue: 'pickup', at, gain: 0.5 }];
    case 'spawned':
      return [mine ? { cue: 'spawn', at: null, gain: 1 } : { cue: 'spawn', at, gain: 0.4 }];
    default:
      return [];
  }
}

/** What {@link PhaseWatcher} reads each frame. */
export interface MatchClock {
  phase: Phase;
  number: number;
  /** Whole seconds left in the phase. */
  seconds: number;
  /** A warmup waiting for a second player has a clock that is not moving. */
  waiting: boolean;
}

/** The round start, the last seconds of warmup and the round end, from the match as the HUD shows it. */
export class PhaseWatcher {
  private last: MatchClock | null = null;
  private counted: number | null = null;

  /** The cues for the match now, given it was `last` the time before. The first look makes none: you may have joined mid-match. */
  update(now: MatchClock): CueName[] {
    const last = this.last;
    this.last = { ...now };
    const counting = now.phase === 'warmup' && !now.waiting && now.seconds >= 1 && now.seconds <= 3;
    if (last === null) {
      // Joining with 2 seconds of warmup left must not tick for that second.
      this.counted = counting ? now.seconds : null;
      return [];
    }
    const cues: CueName[] = [];
    if (now.phase === 'playing' && (last.phase !== 'playing' || last.number !== now.number)) cues.push('go');
    if (now.phase === 'results' && last.phase === 'playing') cues.push('round-end');
    if (!counting) this.counted = null;
    else if (this.counted !== now.seconds) {
      this.counted = now.seconds;
      cues.push('tick');
    }
    return cues;
  }
}

/** Your craft, as far as its sounds go. */
export interface OwnState {
  alive: boolean;
  /** 0 when the boost is ready, up to 1 just after a dash. */
  boostCooling: number;
  overheated: boolean;
}

/** The sounds of your own craft that no event carries: the dash and the blaster locking up. */
export class OwnWatcher {
  private last: OwnState | null = null;

  update(now: OwnState | null): CueName[] {
    const last = this.last;
    this.last = now && { ...now };
    if (!now || !last || !now.alive || !last.alive) return [];
    const cues: CueName[] = [];
    if (now.boostCooling > last.boostCooling + 0.5) cues.push('boost');
    if (now.overheated && !last.overheated) cues.push('overheat');
    return cues;
  }
}

/** The sound for a replay starting or ending, given whether one was on screen before this frame and is now. */
export function replayCue(was: boolean, now: boolean): CueName | null {
  if (was === now) return null;
  return now ? 'replay-in' : 'replay-out';
}
