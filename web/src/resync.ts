// Falling too far behind to read the gap back (docs/design.md, "Failure modes"): the page joins again from the newest
// keyframe, as it does after a lost session, and says "Connection poor" until the live ticks are close again.
import { BEHIND_TICKS } from './behind';

/** The shortest time between two resyncs. A link that stays too slow resyncs this often, not continuously. */
export const RESYNC_HOLD_MS = 5000;
/** Behind by fewer ticks than this, a resynced page counts as back. */
export const BACK_TICKS = 3;

export class Resync {
  /** The page is resyncing or has not yet caught up since. */
  poor = false;
  /** How many resyncs have run. */
  count = 0;
  private running = false;
  private deferred = false;
  private lastMs = -Infinity;

  /**
   * `join` reads the keyframe and subscribes from it again, replacing the live subscription. `changed` is told when
   * `poor` flips.
   */
  constructor(
    private readonly join: () => Promise<void>,
    private readonly changed: (poor: boolean) => void = () => {},
    private readonly now: () => number = () => performance.now(),
  ) {}

  /**
   * A jump in the offsets too wide to read back. Starts a resync, or if one ran lately, asks for another once the
   * hold is over: the jump is still unread.
   */
  request(): void {
    const now = this.now();
    if (this.running || now - this.lastMs < RESYNC_HOLD_MS) {
      this.deferred = true;
      return;
    }
    this.deferred = false;
    this.running = true;
    this.lastMs = now;
    this.count++;
    this.set(true);
    void this.join()
      .catch((err: unknown) => console.error('could not join again from the keyframe', err))
      .finally(() => {
        this.running = false;
      });
  }

  /** Take how far behind the live ticks are, as {@link Behind.ticks} says, once for each live tick. */
  behind(ticks: number): void {
    if (ticks > BEHIND_TICKS || (this.deferred && this.now() - this.lastMs >= RESYNC_HOLD_MS)) this.request();
    else if (this.poor && !this.running && ticks < BACK_TICKS) this.set(false);
  }

  private set(poor: boolean): void {
    if (this.poor === poor) return;
    this.poor = poor;
    this.changed(poor);
  }
}
