import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { arenaLayout, decodeTick, loadCore, playerKey } from './core';

const built = (name: string) => readFileSync(new URL(`./core/${name}`, import.meta.url));

/** Records the native build wrote, with its hash of each. */
const fixture = JSON.parse(built('fixture.json').toString()) as { tick: number; record: string; hash: string }[];
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));

beforeAll(() => loadCore(built('felix_arena_core_bg.wasm')));

describe('core in WebAssembly', () => {
  it('decodes the native build’s ticks to the same state hash', () => {
    expect(fixture.length).toBeGreaterThan(10);
    for (const { tick, record, hash } of fixture) {
      const decoded = decodeTick(bytes(record));
      expect([decoded.tick, decoded.hash]).toEqual([tick, hash]);
    }
  });

  it('reads the crafts, the roster and the timing', () => {
    const keyframe = fixture.map(({ record }) => decodeTick(bytes(record))).find((tick) => tick.keyframe)!;
    expect(keyframe.crafts).toHaveLength(8);
    expect(keyframe.players.map((player) => player.key)).toContain(playerKey('player-3'));
    expect(keyframe.timing?.commitStartUs).toBe(1_760_000_000_000_000 + keyframe.tick * 33_333);
    expect(keyframe.timing?.stepUs).toBe(keyframe.tick);
  });

  it('refuses bytes that are not exactly one tick', () => {
    const record = bytes(fixture[0]!.record);
    expect(() => decodeTick(record.subarray(0, record.length - 1))).toThrow('not a tick record');
    expect(() => decodeTick(new Uint8Array([...record, 0]))).toThrow('not a tick record');
  });

  it('hands over the arena in metres, point-symmetric about the centre', () => {
    const { halfX, halfZ, obstacles } = arenaLayout();
    expect([halfX, halfZ]).toEqual([20, 14]);
    expect(obstacles[0]).toEqual({ kind: 'round', x: 0, z: 0, radius: 0.9 });
    expect(obstacles[1]).toEqual({ kind: 'box', x: 12.5, z: -1.5, halfX: 0.5, halfZ: 3 });
    for (let i = 1; i < obstacles.length; i += 2) {
      const [a, b] = [obstacles[i]!, obstacles[i + 1]!];
      expect({ ...b, x: 0 - b.x, z: 0 - b.z }).toEqual(a);
    }
  });
});
