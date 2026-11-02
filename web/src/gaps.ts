// Ticks that never arrived (docs/design.md, "Failure modes"). A subscriber whose queue is full loses ticks, which
// shows as a jump in log offsets beyond the ones `skippedBefore` explains. The ticks in a short jump are read back from
// the log and handed on in order before the one that revealed it, so the match's events (kills, joins, the tally)
// are never missing, and the interpolator has the ticks it would otherwise draw across.
import type { EventFrame } from './gateway';
import type { Reader } from './replay';

/** The most missing ticks that are read back. A client further behind than this rejoins from the keyframe. */
export const MAX_FILL = 15;
/** How long a fill read may take before the ticks go on without it. */
export const FILL_TIMEOUT_MS = 1500;

/** What the feed has seen, for tests and the debug page. */
export interface GapStats {
  /** Jumps in the offsets. */
  gaps: number;
  /** Ticks those jumps skipped over. */
  missed: number;
  /** Of them, ticks read back and handed on. */
  filled: number;
  /** Of them, ticks that could not be read back, because the jump was too wide or the read failed or ran late. */
  unfilled: number;
}

/** The ticks of one subscription in order, with the gaps in them filled when they are short enough to be. */
export class GapFeed {
  readonly stats: GapStats;
  private readonly tooFar: (missing: number, offset: number) => void;
  private readonly stream: string;
  /** The offset of the last tick handed on. */
  private last: number | null = null;
  /** Ticks received while a fill read is out, oldest first. */
  private waiting: { frame: EventFrame; catchUp: boolean }[] = [];
  private reading = false;

  /**
   * `reader` answers the fill reads, and is asked each time so it follows a replaced session. `emit` gets every tick
   * in order. `tooFar` is told of a jump wider than {@link MAX_FILL}, with the offset it reached. `stats` is where
   * the counts go, so they can outlive this feed.
   */
  constructor(
    private readonly reader: () => Reader,
    private readonly emit: (frame: EventFrame, catchUp: boolean) => void,
    options: {
      stats?: GapStats;
      tooFar?: (missing: number, offset: number) => void;
      stream?: string;
    } = {},
  ) {
    this.stats = options.stats ?? { gaps: 0, missed: 0, filled: 0, unfilled: 0 };
    this.tooFar = options.tooFar ?? (() => {});
    this.stream = options.stream ?? 'ticks';
  }

  /** Take a tick as the subscription delivered it. */
  push(frame: EventFrame, catchUp: boolean): void {
    this.waiting.push({ frame, catchUp });
    if (!this.reading) void this.drain();
  }

  /** The offsets `frame` skipped over, as a range, or `null` when there is none. */
  private gapBefore(frame: EventFrame): [number, number] | null {
    if (this.last === null || frame.offset === null) return null;
    const from = this.last + 1;
    const end = frame.offset - frame.skippedBefore;
    return end > from ? [from, end] : null;
  }

  private async drain(): Promise<void> {
    this.reading = true;
    try {
      for (let next = this.waiting.shift(); next; next = this.waiting.shift()) {
        const gap = this.gapBefore(next.frame);
        if (gap) {
          const count = gap[1] - gap[0];
          this.stats.gaps++;
          this.stats.missed += count;
          if (count > MAX_FILL) {
            this.stats.unfilled += count;
            this.tooFar(count, next.frame.offset!);
          } else {
            const got = await this.fill(next.frame, gap[0], gap[1]);
            this.stats.filled += got.length;
            this.stats.unfilled += count - got.length;
            for (const frame of got) this.emit(frame, next.catchUp);
          }
        }
        if (next.frame.offset !== null) this.last = Math.max(this.last ?? -1, next.frame.offset);
        this.emit(next.frame, next.catchUp);
      }
    } finally {
      this.reading = false;
    }
  }

  /** The ticks at offsets `from` up to `end`, as frames, or none when they could not be read in time. */
  private async fill(like: EventFrame, from: number, end: number): Promise<EventFrame[]> {
    const read = async (): Promise<EventFrame[]> => {
      const frames: EventFrame[] = [];
      for (let at = from; at < end; ) {
        const page = await this.reader().read(this.stream, at, end);
        for (const record of page.records) {
          if (record.offset < from || record.offset >= end) continue;
          frames.push({
            sub: like.sub,
            offset: record.offset,
            skippedBefore: 0,
            gatewayReceivedUs: 0,
            gatewaySentUs: 0,
            receivedUs: like.receivedUs,
            payload: record.payload,
            filled: true,
          });
        }
        if (page.nextOffset <= at) break;
        at = page.nextOffset;
      }
      return frames;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<EventFrame[]>((resolve) => {
      timer = setTimeout(() => resolve([]), FILL_TIMEOUT_MS);
    });
    try {
      return await Promise.race([read().catch(() => []), late]);
    } finally {
      clearTimeout(timer);
    }
  }
}
