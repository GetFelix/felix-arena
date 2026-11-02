// Joining mid-match (docs/design.md, "Joining mid-match"): read the `keyframe` state key, whose version is the
// newest keyframe's offset, subscribe from that offset, and fold the catch-up ticks without drawing them.
import type { EventFrame, StateValue, Subscribed } from './gateway';
import { readTicks } from './gaps';
import type { Reader } from './replay';

/** Ticks between keyframes, as `core/src/world.rs` has it. */
const KEYFRAME_EVERY = 30;

/** What joining needs of a gateway session. */
export interface Joinable {
  stateGet(stream: string, key: string): Promise<StateValue>;
  subscribe(
    stream: string,
    slot: string,
    from: number | 'live',
    onEvent: (frame: EventFrame) => void,
  ): Promise<Subscribed>;
  /** Reads a range of the tick stream, for the ticks a join would otherwise skip. */
  read?: Reader['read'];
}

/** When each step of a join finished, in milliseconds on the page's clock. */
export interface JoinTimes {
  startMs: number;
  /** The keyframe's offset was known. */
  keyframeMs: number;
  /** The subscription from it was registered. */
  subscribedMs: number;
  /** The keyframe's offset, or `null` when the arena has none yet and the join started live. */
  keyframe: number | null;
}

/**
 * The most ticks a join that already holds the match up to some offset reads from there rather than from the
 * newest keyframe, counted from that offset to the newest tick. A keyframe carries the tally but not the kills
 * between it and where the page was, so a short jump back is worth the extra ticks. One keyframe interval is the
 * most a join from the keyframe reads, so the burst is never larger than that join's and the broker's queue of 64
 * takes it. A page further behind than this is behind because its link is slow, and reading the backlog again
 * over the same link would only keep it there.
 */
export const RESUME_TICKS = KEYFRAME_EVERY;

/**
 * The most ticks a join that starts from the keyframe reads back from before it, one range read rather than a
 * subscription, when the page had folded the match up to some offset. Twenty seconds of play.
 */
export const HOLE_TICKS = 600;
/** How long that read may take before the join goes on from the keyframe without it. */
export const HOLE_TIMEOUT_MS = 1000;

/**
 * Subscribe to the tick stream from the newest keyframe. `onTick` gets every tick in order with `catchUp` true for
 * those already in the log when the subscription began, except the newest of them, which is the first to draw.
 * A page that has folded every tick up to `resumeAfter` starts at the tick after it instead when that is no more
 * than {@link RESUME_TICKS} before the newest tick, so the ticks the keyframe would skip still count. Further back
 * than that, the ticks between it and the keyframe (at most {@link HOLE_TICKS}) are read back in one range read
 * first, and the join goes on without them if the read is late or fails.
 */
export async function joinFromKeyframe(
  gateway: Joinable,
  onTick: (frame: EventFrame, catchUp: boolean) => void,
  resumeAfter: number | null = null,
  now: () => number = () => performance.now(),
): Promise<JoinTimes> {
  const startMs = now();
  const state = await gateway.stateGet('ticks', 'keyframe');
  const keyframe = state.version;
  // `asOf`, the newest commit the read reflects, is the log's tail give or take the ticks that land during the join.
  const keyframeMs = now();
  const start: number | 'live' =
    keyframe === null
      ? 'live'
      : resumeAfter !== null && resumeAfter < keyframe && (state.asOf ?? keyframe) - resumeAfter <= RESUME_TICKS
        ? resumeAfter + 1
        : keyframe;
  if (keyframe !== null && start === keyframe && resumeAfter !== null && resumeAfter < keyframe) {
    for (const frame of await readHole(gateway, resumeAfter + 1, keyframe)) onTick(frame, true);
  }
  // Frames can arrive before `subscribed` is handled; they wait for the tail it names.
  let tail: number | null | undefined;
  const early: EventFrame[] = [];
  const subscribed = await gateway.subscribe('ticks', 'live', start, (frame) => {
    if (tail === undefined) early.push(frame);
    else onTick(frame, isCatchUp(frame.offset, tail));
  });
  tail = subscribed.liveOffset;
  for (const frame of early) onTick(frame, isCatchUp(frame.offset, tail));
  return { startMs, keyframeMs, subscribedMs: now(), keyframe };
}

/** The ticks from `from` up to `end`, or none when there are too many, the read fails or it is late. */
async function readHole(gateway: Joinable, from: number, end: number): Promise<EventFrame[]> {
  if (!gateway.read || end - from > HOLE_TICKS) return [];
  const reader: Reader = { read: gateway.read.bind(gateway) };
  let late = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      late = true;
      resolve(null);
    }, HOLE_TIMEOUT_MS);
  });
  try {
    const read = readTicks(reader, 'ticks', from, end, { sub: 0, receivedUs: 0 }, () => late).catch(() => null);
    const frames = await Promise.race([read, timeout]);
    // A partial or patchy hole would fold as a hole of its own, so only a read of every offset up to the keyframe is used.
    return frames !== null && frames.length === end - from && frames.at(-1)?.offset === end - 1 ? frames : [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the tick at `offset` is catch-up to fold without drawing: it was in the log before the subscription
 * began at `tail`, and is not the last record before it.
 */
export function isCatchUp(offset: number | null, tail: number | null): boolean {
  return offset !== null && tail !== null && offset < tail - 1;
}

/**
 * How far a page has folded the tick stream without a hole, for a resync to read on from. An offset the stream
 * skipped over and nothing read back stops it there, so later ticks cannot hide that hole.
 */
export class Folded {
  private at: number | null = null;
  private fresh = true;

  /** The newest offset such that every tick up to it was folded, or `null` before the first. */
  get offset(): number | null {
    return this.at;
  }

  /** A join is about to replace the subscription. Its first tick tells whether it reads on or starts over. */
  rejoin(): void {
    this.fresh = true;
  }

  /** Take a tick as it reaches the page's fold, with the offsets the broker says it skipped before it. */
  see(offset: number | null, skippedBefore: number): void {
    if (offset === null) return;
    const contiguous = this.at !== null && offset - skippedBefore <= this.at + 1;
    if (this.at === null || (this.fresh && !contiguous)) this.at = offset;
    else if (contiguous) this.at = Math.max(this.at, offset);
    this.fresh = false;
  }
}
