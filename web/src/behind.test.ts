import { expect, it } from 'vitest';
import { Behind } from './behind';

it('is zero for a steady link, whatever the clocks say', () => {
  const behind = new Behind();
  for (let i = 0; i < 100; i++) behind.add(5_000_000 + (i % 3) * 800);
  expect(behind.ticks).toBeLessThan(0.1);
});

it('counts ticks later than the best, and grows as a client reads slower than ticks come', () => {
  const behind = new Behind();
  for (let i = 0; i < 100; i++) behind.add(2_000);
  const seen: number[] = [];
  // Each tick arrives 20 ms later than the last would have, relative to when it was committed.
  for (let i = 1; i <= 40; i++) {
    behind.add(2_000 + i * 20_000);
    seen.push(behind.ticks);
  }
  expect(seen[0]).toBeCloseTo(0.6, 1);
  expect(seen.at(-1)!).toBeGreaterThan(15);
  expect(seen).toEqual([...seen].sort((a, b) => a - b));
});

it('forgets what it saw when cleared', () => {
  const behind = new Behind();
  behind.add(1_000);
  behind.add(900_000);
  expect(behind.ticks).toBeGreaterThan(20);
  behind.clear();
  expect(behind.ticks).toBe(0);
});
