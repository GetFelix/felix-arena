import { describe, expect, it } from 'vitest';
import { Playlist } from './playlist';

const tracks = ['a', 'b', 'c', 'd'];
/** A deterministic stand-in for Math.random. */
const lcg = (seed: number) => () => (seed = (seed * 48271) % 2147483647) / 2147483647;

describe('Playlist', () => {
  it('plays every track once before any repeats', () => {
    const list = new Playlist(tracks, lcg(7));
    expect([list.next(), list.next(), list.next(), list.next()].sort()).toEqual(tracks);
  });

  it('never plays the same track twice in a row, across many rounds', () => {
    for (let seed = 1; seed < 40; seed++) {
      const list = new Playlist(tracks, lcg(seed));
      let last = '';
      for (let i = 0; i < 40; i++) {
        const next = list.next();
        expect(next).not.toBe(last);
        last = next;
      }
    }
  });

  it('shuffles: different seeds give different orders', () => {
    const order = (seed: number) => {
      const list = new Playlist(tracks, lcg(seed));
      return [list.next(), list.next(), list.next(), list.next()].join('');
    };
    expect(new Set([1, 2, 3, 4, 5, 6].map(order)).size).toBeGreaterThan(1);
  });

  it('keeps playing a single track, and refuses an empty list', () => {
    const one = new Playlist(['a'], Math.random);
    expect([one.next(), one.next()]).toEqual(['a', 'a']);
    expect(() => new Playlist([], Math.random)).toThrow();
  });
});
