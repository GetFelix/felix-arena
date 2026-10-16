import { describe, expect, it } from 'vitest';
import type { EventFrame } from './gateway';
import { Legs } from './legs';

const frame = (commitStart: number): EventFrame => ({
  sub: 0,
  offset: 1,
  skippedBefore: 0,
  gatewayReceivedUs: commitStart + 3_000,
  gatewaySentUs: commitStart + 3_100,
  receivedUs: commitStart + 3_600,
  payload: new Uint8Array(),
});

describe('Legs', () => {
  it('splits a tick into its legs', () => {
    const legs = new Legs();
    legs.add(frame(1_000_000), { commitStartUs: 1_000_000, stepUs: 20, previousCommitUs: 2_000 });
    expect(legs.summary('step').p50).toBe(20);
    expect(legs.summary('commit').p50).toBe(2_000);
    expect(legs.summary('toGateway').p50).toBe(3_000);
    expect(legs.summary('gateway').p50).toBe(100);
    expect(legs.summary('toPage').p50).toBe(500);
    expect(legs.summary('total').p50).toBe(3_600);
  });

  it('keeps only the window, and skips an unknown commit', () => {
    const legs = new Legs(100);
    for (let i = 1; i <= 200; i++) {
      legs.add(frame(0), { commitStartUs: 0, stepUs: i, previousCommitUs: 0 });
    }
    expect(legs.summary('step')).toEqual({ count: 100, p50: 150, p99: 199 });
    expect(legs.summary('commit').count).toBe(0);
  });
});
