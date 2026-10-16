// The match as the HUD shows it, folded from ticks: the phase and its clock, the score, the roster with kills and
// deaths, and the kill feed.
import type { Tick } from './core';

export type Phase = 'warmup' | 'playing' | 'results';

/** Callsigns by slot. Slots alternate teams as players join, so the first four match the style frame's crafts. */
const CALLSIGNS = ['Rook', 'Vex', 'Ash', 'Mara', 'Juno', 'Kite', 'Onyx', 'Sable'];

/** The name the game shows for the player in `slot`. */
export function callsign(slot: number): string {
  return CALLSIGNS[slot % CALLSIGNS.length]!;
}

/** One player on the scoreboard. */
export interface Standing {
  slot: number;
  violet: boolean;
  kills: number;
  deaths: number;
}

/** A kill, for the feed. */
export interface Kill {
  killer: number;
  victim: number;
  /** When it arrived, on the page's clock. */
  atMs: number;
  /** The rail made it. */
  rail: boolean;
}

/** How long a kill stays in the feed, and how many show. */
const FEED_MS = 6000;
const FEED = 4;

/** The match, from ticks in order. */
export class Match {
  number = 0;
  phase: Phase = 'warmup';
  /** Ticks left in the phase. */
  left = 0;
  scores: [number, number] = [0, 0];
  /** Ticks until a rail is on the crystal, or 0 while one is. */
  railIn = 0;
  /** A warmup whose clock is not moving: it waits for a second player. */
  waiting = false;
  private feed: Kill[] = [];
  /** The roster as of the newest keyframe, and the kills and deaths in ticks since it. */
  private roster = new Map<number, Standing>();
  private since = new Map<number, { kills: number; deaths: number }>();
  private lastTick = -1;

  /** Take a tick that arrived at `nowMs`. */
  update(tick: Tick, nowMs: number): void {
    const phase = tick.phase as Phase;
    const left = tick.phaseLeft;
    const fresh = tick.matchNumber !== this.number || phase !== this.phase;
    this.waiting =
      phase === 'warmup' && this.phase === 'warmup' && left === this.left && tick.tick === this.lastTick + 1;
    if (fresh && (phase === 'warmup' || phase === 'playing')) {
      // A new match or its start clears the board, as the sim does.
      this.feed = [];
      this.since.clear();
      for (const s of this.roster.values()) [s.kills, s.deaths] = [0, 0];
    }
    this.number = tick.matchNumber;
    this.phase = phase;
    this.left = left;
    this.scores = [tick.coralScore, tick.violetScore];
    this.railIn = tick.railIn;
    this.lastTick = tick.tick;

    if (tick.keyframe) {
      const players = tick.players;
      this.roster = new Map(
        players.map((p) => [p.slot, { slot: p.slot, violet: p.violet, kills: p.kills, deaths: p.deaths }]),
      );
      for (const p of players) p.free();
      this.since.clear();
    }
    const events = tick.events;
    const railed = new Set<number>();
    for (const e of events) {
      if (e.kind === 'railed' && e.target !== undefined) railed.add(e.target);
      if (e.kind === 'joined' || e.kind === 'left') this.since.delete(e.slot);
      if (e.kind === 'joined') this.roster.set(e.slot, { slot: e.slot, violet: e.violet, kills: 0, deaths: 0 });
      if (e.kind === 'left') this.roster.delete(e.slot);
      if (e.kind !== 'killed') continue;
      this.feed.push({ killer: e.by, victim: e.slot, atMs: nowMs, rail: railed.has(e.slot) });
      // Keyframes carry the tally; between them, kills are counted here.
      if (!tick.keyframe) {
        const tally = (slot: number) => this.since.get(slot) ?? { kills: 0, deaths: 0 };
        this.since.set(e.by, { ...tally(e.by), kills: tally(e.by).kills + 1 });
        this.since.set(e.slot, { ...tally(e.slot), deaths: tally(e.slot).deaths + 1 });
      }
    }
    for (const e of events) e.free();
  }

  /** The latest kills, newest last, as of `nowMs`. */
  kills(nowMs: number): Kill[] {
    this.feed = this.feed.filter((k) => nowMs - k.atMs < FEED_MS);
    return this.feed.slice(-FEED);
  }

  /** Every player, best first: by kills, then fewest deaths, then slot. */
  standings(): Standing[] {
    return [...this.roster.values()]
      .map((s) => {
        const extra = this.since.get(s.slot);
        return { ...s, kills: s.kills + (extra?.kills ?? 0), deaths: s.deaths + (extra?.deaths ?? 0) };
      })
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.slot - b.slot);
  }

  /** Whole seconds left in the phase. */
  get seconds(): number {
    return Math.ceil(this.left / 30);
  }
}

/** `seconds` as m:ss. */
export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
