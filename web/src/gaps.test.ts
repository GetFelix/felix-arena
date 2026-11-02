import { expect, it } from 'vitest';
import type { EventFrame } from './gateway';
import { GapFeed, MAX_FILL } from './gaps';
import type { Page, Reader } from './replay';

const frame = (offset: number, skippedBefore = 0): EventFrame => ({
  sub: 1,
  offset,
  skippedBefore,
  gatewayReceivedUs: 0,
  gatewaySentUs: 0,
  receivedUs: 0,
  payload: new Uint8Array([offset]),
});

/** A log of one record per offset below `size`, with the reads it was asked. */
function log(size: number, fail = false) {
  const reads: [number, number | null][] = [];
  const reader: Reader = {
    read: (_stream, from, end) => {
      reads.push([from, end]);
      if (fail) return Promise.reject(new Error('read failed'));
      const records: Page['records'] = [];
      for (let o = from; o < (end ?? size) && o < size; o++) records.push({ offset: o, payload: new Uint8Array([o]) });
      return Promise.resolve({ records, nextOffset: Math.min(end ?? size, size) });
    },
  };
  return { reader, reads };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function feedOver(reader: Reader, tooFar?: (missing: number, offset: number) => void) {
  const out: { offset: number | null; filled: boolean; catchUp: boolean }[] = [];
  const feed = new GapFeed(
    () => reader,
    (f, catchUp) => out.push({ offset: f.offset, filled: f.filled === true, catchUp }),
    { tooFar },
  );
  return { feed, out };
}

it('hands on ticks with no gap at once, without waiting a turn', () => {
  const { feed, out } = feedOver(log(10).reader);
  for (const o of [3, 4, 5]) feed.push(frame(o), false);
  expect(out.map((t) => t.offset)).toEqual([3, 4, 5]);
  expect(feed.stats.gaps).toBe(0);
});

it('reads back the ticks a jump skipped, ahead of the tick that showed it', async () => {
  const { reader, reads } = log(20);
  const { feed, out } = feedOver(reader);
  feed.push(frame(4), false);
  feed.push(frame(8), false);
  feed.push(frame(9), false);
  await flush();
  expect(out.map((t) => [t.offset, t.filled])).toEqual([
    [4, false],
    [5, true],
    [6, true],
    [7, true],
    [8, false],
    [9, false],
  ]);
  expect(reads).toEqual([[5, 8]]);
  expect(feed.stats).toEqual({ gaps: 1, missed: 3, filled: 3, unfilled: 0 });
});

it('does not count the offsets a batch says hold no event', async () => {
  const { reader, reads } = log(20);
  const { feed, out } = feedOver(reader);
  feed.push(frame(4), false);
  feed.push(frame(6, 1), false);
  feed.push(frame(11, 2), false);
  await flush();
  expect(out.map((t) => [t.offset, t.filled])).toEqual([
    [4, false],
    [6, false],
    [7, true],
    [8, true],
    [11, false],
  ]);
  expect(reads).toEqual([[7, 9]]);
  expect(feed.stats).toEqual({ gaps: 1, missed: 2, filled: 2, unfilled: 0 });
});

it('keeps the catch-up flag of the tick that showed the gap', async () => {
  const { feed, out } = feedOver(log(20).reader);
  feed.push(frame(1), true);
  feed.push(frame(3), true);
  feed.push(frame(7), false);
  await flush();
  expect(out.map((t) => [t.offset, t.catchUp])).toEqual([
    [1, true],
    [2, true],
    [3, true],
    [4, true],
    [5, true],
    [6, true],
    [7, false],
  ]);
});

it('goes on without the ticks when the read fails', async () => {
  const { feed, out } = feedOver(log(20, true).reader);
  feed.push(frame(4), false);
  feed.push(frame(8), false);
  await flush();
  expect(out.map((t) => t.offset)).toEqual([4, 8]);
  expect(feed.stats).toEqual({ gaps: 1, missed: 3, filled: 0, unfilled: 3 });
});

it('does not read a jump wider than it fills, and says so', async () => {
  const { reader, reads } = log(100);
  const wide: [number, number][] = [];
  const { feed, out } = feedOver(reader, (missing, offset) => wide.push([missing, offset]));
  feed.push(frame(2), false);
  feed.push(frame(3 + MAX_FILL + 1), false);
  await flush();
  expect(out.map((t) => t.offset)).toEqual([2, 3 + MAX_FILL + 1]);
  expect(reads).toEqual([]);
  expect(wide).toEqual([[MAX_FILL + 1, 3 + MAX_FILL + 1]]);
});

it('keeps ticks that arrive during a read in order behind it', async () => {
  const { reader } = log(30);
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const slow: Reader = { read: async (...args) => (await gate, reader.read(...args)) };
  const { feed, out } = feedOver(slow);
  feed.push(frame(1), false);
  feed.push(frame(4), false);
  feed.push(frame(5), false);
  feed.push(frame(7), false);
  await flush();
  expect(out.map((t) => t.offset)).toEqual([1]);
  open();
  await flush();
  await flush();
  expect(out.map((t) => t.offset)).toEqual([1, 2, 3, 4, 5, 6, 7]);
});
