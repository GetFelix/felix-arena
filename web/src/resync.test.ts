import { expect, it, vi } from 'vitest';
import { BEHIND_TICKS } from './behind';
import { RESYNC_HOLD_MS, Resync } from './resync';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const clock = { ms: 0 };
  const joins: (() => void)[] = [];
  const changes: boolean[] = [];
  const resync = new Resync(
    () => new Promise<void>((resolve) => joins.push(resolve)),
    (poor) => changes.push(poor),
    () => clock.ms,
  );
  return { clock, joins, changes, resync };
}

it('joins again when a jump is too wide, and says so until the page is close again', async () => {
  const { joins, changes, resync } = setup();
  resync.request();
  expect(resync.count).toBe(1);
  expect(resync.poor).toBe(true);
  joins[0]!();
  await flush();
  resync.behind(2);
  expect(resync.poor).toBe(false);
  expect(changes).toEqual([true, false]);
});

it('joins again when the page is behind by more than the limit', () => {
  const { resync } = setup();
  resync.behind(BEHIND_TICKS);
  expect(resync.count).toBe(0);
  resync.behind(BEHIND_TICKS + 1);
  expect(resync.count).toBe(1);
});

it('does not start a second resync while one runs, or soon after one ran', async () => {
  const { clock, joins, resync } = setup();
  resync.request();
  resync.request();
  expect(resync.count).toBe(1);
  joins[0]!();
  await flush();
  clock.ms = RESYNC_HOLD_MS - 1;
  resync.request();
  expect(resync.count).toBe(1);
  clock.ms = RESYNC_HOLD_MS;
  resync.request();
  expect(resync.count).toBe(2);
});

it('stays poor while the join is still running, whatever the live ticks say', () => {
  const { resync } = setup();
  resync.request();
  resync.behind(0);
  expect(resync.poor).toBe(true);
});

it('stays poor when a resync fails, so the next request may try again', async () => {
  const clock = { ms: 0 };
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const resync = new Resync(
    () => Promise.reject(new Error('gone')),
    () => {},
    () => clock.ms,
  );
  resync.request();
  await flush();
  logged.mockRestore();
  expect(resync.poor).toBe(true);
  clock.ms = RESYNC_HOLD_MS;
  resync.request();
  expect(resync.count).toBe(2);
});

it('asks again once the hold is over when a wide jump came during it', async () => {
  const { clock, joins, resync } = setup();
  resync.request();
  joins[0]!();
  await flush();
  clock.ms = 100;
  resync.request();
  resync.behind(0);
  expect(resync.count).toBe(1);
  clock.ms = RESYNC_HOLD_MS;
  resync.behind(0);
  expect(resync.count).toBe(2);
});
