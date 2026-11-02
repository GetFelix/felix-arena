// How far behind the sim a client is, in ticks, from the trip time of each tick: its arrival less the commit time the
// sim wrote into it. The clocks of the sim and the page may disagree, but the disagreement is the same for every tick,
// so a tick's trip time less the shortest one lately seen is how much later than the best it arrived. A client that
// reads its ticks slower than they come falls further behind with each one.
import { TICK_MS } from './interpolation';

/** Ticks remembered for the shortest trip: a minute. */
const WINDOW = 1800;

/** What a client behind the sim by this many ticks or more is taken to have lost touch. */
export const BEHIND_TICKS = 15;

export class Behind {
  private trips: number[] = [];
  private newest = 0;

  /** Take a tick whose trip took `tripUs` microseconds. */
  add(tripUs: number): void {
    this.trips.push(tripUs);
    if (this.trips.length > WINDOW) this.trips.shift();
    this.newest = tripUs;
  }

  /** How many ticks later than the best of the last minute the newest arrived. */
  get ticks(): number {
    if (this.trips.length === 0) return 0;
    let best = Infinity;
    for (const trip of this.trips) best = Math.min(best, trip);
    return Math.max(0, (this.newest - best) / 1000 / TICK_MS);
  }

  /** Start over, as after a resync, when the trips to come are from a new subscription. */
  clear(): void {
    this.trips = [];
    this.newest = 0;
  }
}
