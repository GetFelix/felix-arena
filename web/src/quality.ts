// Quality tiers, and choosing one from how fast the first frames draw. docs/design.md ("Quality tiers") has what each
// tier draws; renderer.ts draws it.

/** High is the style frame; Medium and Low trade effects for frame time. */
export type Tier = 'high' | 'medium' | 'low';

export const TIERS: readonly Tier[] = ['high', 'medium', 'low'];

/** Where the saved setting is kept. */
const KEY = 'felix-arena.quality';

/** Seconds of frames each tier is judged on. */
export const WINDOW_S = 3;
/**
 * A tier is too slow when the 95th percentile of its frame intervals is over this. At 60 Hz a frame rate that holds
 * still jitters around 16.7 ms and a missed frame shows as 33 ms, so the line sits between them.
 */
export const SLOW_MS = 20;
/** A gap between frames longer than this is a pause, not a slow frame. */
const PAUSE_MS = 1000;
/** Frames ignored while a tier settles: the first draws compile shaders and fill caches. */
const SETTLE_FRAMES = 10;

export function isTier(value: string | null): value is Tier {
  return value !== null && (TIERS as readonly string[]).includes(value);
}

/** The setting saved on this browser, or null for automatic. */
export function savedTier(): Tier | null {
  try {
    const value = localStorage.getItem(KEY);
    return isTier(value) ? value : null;
  } catch {
    return null;
  }
}

/** Saves `tier` as this browser's setting; null saves automatic. */
export function saveTier(tier: Tier | null): void {
  try {
    if (tier) localStorage.setItem(KEY, tier);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage can be blocked; the setting then lasts only for this page.
  }
}

/** The tier asked for: `?quality=` first, then the saved setting. Null, or `?quality=auto`, means choose. */
export function requestedTier(params: URLSearchParams): Tier | null {
  const asked = params.get('quality');
  if (asked === 'auto') return null;
  return isTier(asked) ? asked : savedTier();
}

/** The `p`th percentile of `values`, which it sorts. */
export function percentile(values: number[], p: number): number {
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor((p / 100) * values.length))] ?? 0;
}

/**
 * Picks a tier from frame times: starting at High, it judges each tier on {@link WINDOW_S} seconds of frames and steps
 * down while their 95th percentile is over {@link SLOW_MS}. It never steps back up, so the look does not flicker
 * between tiers.
 */
export class TierChooser {
  private intervals: number[] = [];
  private last: number | null = null;
  private start: number | null = null;
  private skipped = 0;
  done = false;

  constructor(
    public tier: Tier,
    private readonly onChange: (tier: Tier) => void,
  ) {}

  /** Counts a frame that started at `now`, in milliseconds. */
  frame(now: number): void {
    if (this.done) return;
    const last = this.last;
    this.last = now;
    if (last === null || this.skipped++ < SETTLE_FRAMES) return;
    // A long gap is a hidden page or a stall, not the tier's speed: judge from the next frame on.
    if (now - last > PAUSE_MS) {
      this.intervals = [];
      this.start = null;
      return;
    }
    this.start ??= now;
    this.intervals.push(now - last);
    if (now - this.start < WINDOW_S * 1000) return;
    const p95 = percentile(this.intervals, 95);
    const next = TIERS[TIERS.indexOf(this.tier) + 1];
    if (p95 <= SLOW_MS || !next) {
      this.done = true;
      return;
    }
    this.tier = next;
    this.intervals = [];
    this.last = this.start = null;
    this.skipped = 0;
    this.onChange(next);
  }
}
