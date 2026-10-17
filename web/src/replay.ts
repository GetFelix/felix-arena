// The kill cam's ticks (docs/design.md, "The kill cam"): a fresh read of the log from the offset the kill names, and
// a playback clock over it that slows for the half second before the kill.
import { decodeTick, type Tick } from './core';
import { boltsBetween, between, type BoltState, type CraftState, snapshot, type Snapshot } from './interpolation';

/** Ticks a second. */
const HZ = 30;
/** Ticks played after the kill. */
export const AFTER = 30;
/** Ticks before the kill that play at half speed. */
const SLOW = 15;
/** Ticks over which the speed eases into and out of the slow motion. */
const EASE = 4;
/** How long to wait for the second after the kill to be committed before playing without it. */
const AFTER_WAIT_MS = 3000;
/** Between reads of the second after the kill, while it is still being played live. */
const POLL_MS = 150;

/** A page of a range read. */
export interface Page {
  records: { offset: number; payload: Uint8Array }[];
  nextOffset: number;
}

/** What fetching a replay needs: a range read of the tick stream. */
export interface Reader {
  read(stream: string, from: number, end: number | null, max?: number): Promise<Page>;
}

/** A kill to replay, as its tick named it. */
export interface KillRef {
  matchNumber: number;
  /** The kill's tick and the log offset it is at. */
  tick: number;
  offset: number;
  /** Where the replay starts: the offset the kill event names. */
  replayFrom: number;
  victim: number;
  killer: number;
  epoch: number;
}

/** One replayed tick: what is drawn, its events, and the record's bytes as the log holds them. */
export interface ReplayTick {
  snapshot: Snapshot;
  events: ReplayEvent[];
  bytes: Uint8Array;
}

/** An event of a replayed tick, copied out of core's objects. */
export interface ReplayEvent {
  kind: string;
  slot: number;
  by: number;
  x: number;
  z: number;
  target?: number;
  damage: number;
}

/** When each step of a fetch finished, in milliseconds on the page's clock. */
export interface FetchTimes {
  startMs: number;
  /** Every tick up to the kill is decoded: the replay can start. */
  beforeMs: number | null;
  /** The second after the kill is decoded too. */
  afterMs: number | null;
}

/** The ticks of one kill's replay, in tick order. */
export class Replay {
  readonly ticks: ReplayTick[] = [];
  readonly times: FetchTimes;
  /** The read failed: `trimmed` when retention has passed the offset. */
  failed: 'trimmed' | 'error' | null = null;
  private seen = new Set<number>();

  constructor(
    readonly kill: KillRef,
    now: number,
  ) {
    this.times = { startMs: now, beforeMs: null, afterMs: null };
  }

  /** The first and last tick numbers held, or `null` with none. */
  get span(): [number, number] | null {
    return this.ticks.length ? [this.ticks[0]!.snapshot.tick, this.ticks.at(-1)!.snapshot.tick] : null;
  }

  /** The tick it plays to: a second after the kill, or the last one held once the wait for that is over. */
  get end(): number {
    const after = this.kill.tick + AFTER;
    return this.times.afterMs !== null ? Math.min(after, this.span?.[1] ?? after) : after;
  }

  /** Every tick up to the kill is here. */
  get ready(): boolean {
    return this.times.beforeMs !== null;
  }

  /**
   * Take records in offset order. A record from another epoch than the kill's, or a tick already held, is dropped:
   * a retried commit can land twice, and a stale sim's ticks are not the match.
   */
  add(records: Page['records']): void {
    for (const record of records) {
      let tick: Tick;
      try {
        tick = decodeTick(record.payload);
      } catch {
        continue;
      }
      if (tick.epoch !== this.kill.epoch || this.seen.has(tick.tick)) {
        tick.free();
        continue;
      }
      this.seen.add(tick.tick);
      const events = tick.events.map((e) => {
        const copy = { kind: e.kind, slot: e.slot, by: e.by, x: e.x, z: e.z, target: e.target, damage: e.damage };
        e.free();
        return copy;
      });
      this.ticks.push({ snapshot: snapshot(tick), events, bytes: record.payload });
      tick.free();
    }
  }

  /** The bytes of every tick from the start to the end, for comparing what two pages replayed. */
  bytes(): Uint8Array[] {
    return this.ticks.filter((t) => t.snapshot.tick <= this.end).map((t) => t.bytes);
  }
}

/**
 * Read `kill`'s replay: the ticks from its `replayFrom` up to the kill, then the second after it, which may still be
 * being committed and is read again until it is all there. Resolves once the ticks up to the kill are held; the rest
 * arrive in the replay as they are read.
 */
export async function fetchReplay(
  reader: Reader,
  kill: KillRef,
  now: () => number = () => performance.now(),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Replay> {
  const replay = new Replay(kill, now());
  let from = kill.replayFrom;
  const end = kill.offset + 1;
  try {
    while (from < end) {
      const page = await reader.read('ticks', from, end);
      replay.add(page.records);
      // A page that moved nothing on reached what is committed, which the kill already is; it would not move later.
      if (page.nextOffset <= from) break;
      from = page.nextOffset;
    }
  } catch (err) {
    replay.failed = isTrimmed(err) ? 'trimmed' : 'error';
    return replay;
  }
  replay.times.beforeMs = now();
  void (async () => {
    const give = now() + AFTER_WAIT_MS;
    try {
      while ((replay.span?.[1] ?? 0) < kill.tick + AFTER && now() < give) {
        const page = await reader.read('ticks', from, null, kill.tick + AFTER - (replay.span?.[1] ?? kill.tick));
        replay.add(page.records);
        if (page.nextOffset > from) from = page.nextOffset;
        else await sleep(POLL_MS);
      }
    } catch {
      // The replay plays what it has.
    }
    replay.times.afterMs = now();
  })();
  return replay;
}

function isTrimmed(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'trimmed';
}

/** How fast the replay runs at tick `r`, as a share of real time: half speed for the half second before the kill. */
export function speedAt(r: number, kill: number): number {
  const into = r - (kill - SLOW - EASE);
  const out = r - kill;
  if (into <= 0 || out >= EASE) return 1;
  if (into < EASE) return 1 - 0.5 * smooth(into / EASE);
  if (out <= 0) return 0.5;
  return 0.5 + 0.5 * smooth(out / EASE);
}

function smooth(f: number): number {
  return f * f * (3 - 2 * f);
}

/** What the replay draws at one moment. */
export interface ReplayFrame {
  /** The tick time drawn, fractional. */
  renderTick: number;
  speed: number;
  crafts: CraftState[];
  bolts: BoltState[];
  /** Events of ticks the clock passed since the last frame, oldest first. */
  events: (ReplayEvent & { tick: number })[];
  /** How far through the replay, 0 to 1, and where the kill is on that scale. */
  progress: number;
  killAt: number;
  done: boolean;
}

/** Plays a replay: a tick clock that runs at {@link speedAt}, and the view between ticks at each moment. */
export class Playback {
  /** The tick time now. */
  r: number;
  private passed: number;
  /** Holds the clock still, for screenshots. */
  held = false;

  constructor(readonly replay: Replay) {
    this.r = replay.ticks[0]?.snapshot.tick ?? replay.kill.tick;
    this.passed = this.r - 1;
  }

  /** Move the clock on by `dtMs` of real time and answer what to draw. */
  advance(dtMs: number): ReplayFrame {
    const { replay } = this;
    const kill = replay.kill.tick;
    const speed = speedAt(this.r, kill);
    if (!this.held) this.r = Math.min(replay.end, this.r + (dtMs / 1000) * HZ * speed);
    return this.frame(speed);
  }

  /** Put the clock at tick `r` without playing the events before it. */
  seek(r: number): void {
    this.r = r;
    this.passed = Math.floor(r);
  }

  private frame(speed: number): ReplayFrame {
    const { ticks } = this.replay;
    const r = this.r;
    let i = ticks.length - 1;
    while (i > 0 && ticks[i]!.snapshot.tick > r) i--;
    const a = ticks[i]!.snapshot;
    const b = ticks[i + 1]?.snapshot;
    const f = b ? Math.max(0, Math.min(1, (r - a.tick) / (b.tick - a.tick))) : 0;
    const events: ReplayFrame['events'] = [];
    for (const t of ticks) {
      const n = t.snapshot.tick;
      if (n > this.passed && n <= r) for (const e of t.events) events.push({ ...e, tick: n });
    }
    this.passed = Math.max(this.passed, Math.floor(r));
    const start = ticks[0]!.snapshot.tick;
    const length = Math.max(1, this.replay.end - start);
    return {
      renderTick: r,
      speed,
      crafts: b ? between(a, b, f) : a.crafts,
      bolts: b ? boltsBetween(a, b, f) : a.bolts,
      events,
      progress: (r - start) / length,
      killAt: (this.replay.kill.tick - start) / length,
      done: r >= this.replay.end && this.replay.times.afterMs !== null,
    };
  }
}
