// The legs of a tick's trip from the sim to this page, from the times the sim
// writes into each tick, the gateway stamps on each frame and the page takes
// on arrival. Every leg but the sim's own compares two hosts' clocks, so it is
// only as true as their agreement: exact on one Linux host, off by the VM's
// clock drift under Docker Desktop or Podman on macOS, and off by NTP's error
// across machines.
import type { EventFrame } from './gateway';
import type { TickTiming } from './tick';

/** The legs in the order a tick travels them. */
export const LEGS = [
  { id: 'step', name: 'Sim step', what: 'Tick due to its commit starting (sim)' },
  { id: 'commit', name: 'Commit', what: 'Sim to broker and back, the sim waiting on its answer (sim)' },
  { id: 'toGateway', name: 'Broker to gateway', what: 'Commit start to the gateway receiving the tick (sim, gateway)' },
  { id: 'gateway', name: 'Gateway hop', what: 'Received from Felix to written to the WebSocket (gateway)' },
  { id: 'toPage', name: 'Gateway to page', what: 'Written to the WebSocket to arriving here (gateway, page)' },
  { id: 'total', name: 'Commit start to page', what: 'The whole server path and the network (sim, page)' },
] as const;

export type LegId = (typeof LEGS)[number]['id'];

/** p50 and p99 of one leg, in microseconds. */
export interface LegSummary {
  count: number;
  p50: number;
  p99: number;
}

/** The last `window` samples of every leg. */
export class Legs {
  private readonly samples = new Map<LegId, number[]>(LEGS.map((leg) => [leg.id, []]));

  constructor(private readonly window = 300) {}

  /** Add one tick's legs. The commit leg is the previous tick's, carried in this one. */
  add(frame: EventFrame, timing: TickTiming): void {
    this.push('step', timing.stepUs);
    if (timing.previousCommitUs > 0) this.push('commit', timing.previousCommitUs);
    this.push('toGateway', frame.gatewayReceivedUs - timing.commitStartUs);
    this.push('gateway', frame.gatewaySentUs - frame.gatewayReceivedUs);
    this.push('toPage', frame.receivedUs - frame.gatewaySentUs);
    this.push('total', frame.receivedUs - timing.commitStartUs);
  }

  summary(id: LegId): LegSummary {
    const sorted = [...this.samples.get(id)!].sort((a, b) => a - b);
    // Nearest rank, as the sim's own log does.
    const rank = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? NaN;
    return { count: sorted.length, p50: rank(0.5), p99: rank(0.99) };
  }

  private push(id: LegId, us: number): void {
    const samples = this.samples.get(id)!;
    samples.push(us);
    if (samples.length > this.window) samples.shift();
  }
}
