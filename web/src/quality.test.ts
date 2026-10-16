import { describe, expect, it } from 'vitest';
import { percentile, requestedTier, type Tier, TierChooser } from './quality';

/** Feeds `chooser` frames `ms` apart for `seconds`, starting at `from`; returns the time after the last. */
function run(chooser: TierChooser, ms: number, seconds: number, from = 0): number {
  let now = from;
  for (; now < from + seconds * 1000; now += ms) chooser.frame(now);
  return now;
}

describe('TierChooser', () => {
  it('keeps High when frames hold 60 a second, with vsync jitter', () => {
    const changes: Tier[] = [];
    const chooser = new TierChooser('high', (t) => changes.push(t));
    let now = 0;
    for (let i = 0; i < 400; i++) chooser.frame((now += i % 2 ? 15.9 : 17.5));
    expect(chooser.done).toBe(true);
    expect(chooser.tier).toBe('high');
    expect(changes).toEqual([]);
  });

  it('steps down one tier at a time while frames are slow, and stops at the first fast one', () => {
    const changes: Tier[] = [];
    const chooser = new TierChooser('high', (t) => changes.push(t));
    let now = 0;
    while (changes.length === 0) chooser.frame((now += 33));
    expect(changes).toEqual(['medium']);
    run(chooser, 16.7, 4, now);
    expect(chooser.done).toBe(true);
    expect(chooser.tier).toBe('medium');
  });

  it('stops at Low however slow', () => {
    const chooser = new TierChooser('high', () => {});
    run(chooser, 50, 20);
    expect(chooser.tier).toBe('low');
    expect(chooser.done).toBe(true);
  });

  it('does not count a hidden page as a slow frame', () => {
    const chooser = new TierChooser('high', () => {});
    let now = run(chooser, 16.7, 1);
    now = run(chooser, 16.7, 2.5, now + 5000);
    expect(chooser.tier).toBe('high');
  });
});

describe('requestedTier', () => {
  it('reads ?quality=, with auto meaning choose', () => {
    expect(requestedTier(new URLSearchParams('quality=medium'))).toBe('medium');
    expect(requestedTier(new URLSearchParams('quality=auto'))).toBe(null);
    // Node has no localStorage, so there is no saved setting either.
    expect(requestedTier(new URLSearchParams('quality=ultra'))).toBe(null);
  });
});

describe('percentile', () => {
  it('is the value at that rank', () => {
    expect(percentile([5, 1, 4, 2, 3, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
  });
});
