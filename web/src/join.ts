// Joining mid-match (docs/design.md, "Joining mid-match"): read the `keyframe` state key, whose version is the
// newest keyframe's offset, subscribe from that offset, and fold the catch-up ticks without drawing them.
import type { EventFrame, StateValue, Subscribed } from './gateway';

/** What joining needs of a gateway session. */
export interface Joinable {
  stateGet(stream: string, key: string): Promise<StateValue>;
  subscribe(
    stream: string,
    slot: string,
    from: number | 'live',
    onEvent: (frame: EventFrame) => void,
  ): Promise<Subscribed>;
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
 * newest keyframe. A keyframe carries the tally but not the kills between it and where the page was, so a short
 * jump back is worth the extra ticks. Kept under the broker's queue of 64 so the burst is not dropped.
 */
export const RESUME_TICKS = 60;

/**
 * Subscribe to the tick stream from the newest keyframe. `onTick` gets every tick in order with `catchUp` true for
 * those already in the log when the subscription began, except the newest of them, which is the first to draw.
 * A page that has folded every tick up to `resumeAfter` starts at the tick after it instead when that is no more
 * than {@link RESUME_TICKS} before the keyframe, so the ticks the keyframe would skip still count.
 */
export async function joinFromKeyframe(
  gateway: Joinable,
  onTick: (frame: EventFrame, catchUp: boolean) => void,
  resumeAfter: number | null = null,
  now: () => number = () => performance.now(),
): Promise<JoinTimes> {
  const startMs = now();
  const keyframe = (await gateway.stateGet('ticks', 'keyframe')).version;
  const keyframeMs = now();
  const start: number | 'live' =
    keyframe === null
      ? 'live'
      : resumeAfter !== null && resumeAfter < keyframe && keyframe - resumeAfter <= RESUME_TICKS
        ? resumeAfter + 1
        : keyframe;
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

/**
 * Whether the tick at `offset` is catch-up to fold without drawing: it was in the log before the subscription
 * began at `tail`, and is not the last record before it.
 */
export function isCatchUp(offset: number | null, tail: number | null): boolean {
  return offset !== null && tail !== null && offset < tail - 1;
}
