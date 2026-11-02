import { describe, expect, it } from 'vitest';
import { DEFAULT_SOUND, gainOf, saveSound, savedSound } from './sound-settings';

/** A Storage that keeps its items in a map. */
function memory(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
  };
}

describe('sound settings', () => {
  it('start at the defaults on a browser that has saved nothing', () => {
    expect(savedSound(memory())).toEqual(DEFAULT_SOUND);
  });

  it('come back as they were saved', () => {
    const store = memory();
    saveSound({ muted: true, music: 0.25, effects: 0.9 }, store);
    expect(savedSound(store)).toEqual({ muted: true, music: 0.25, effects: 0.9 });
  });

  it('take the default for what is missing or the wrong type, and clamp levels', () => {
    const store = memory({ 'felix-arena.sound': JSON.stringify({ muted: 'yes', music: 7, effects: 'loud' }) });
    expect(savedSound(store)).toEqual({ muted: DEFAULT_SOUND.muted, music: 1, effects: DEFAULT_SOUND.effects });
  });

  it('survive garbage in storage', () => {
    for (const raw of ['not json', 'null', '42', '[]']) {
      expect(savedSound(memory({ 'felix-arena.sound': raw }))).toEqual(DEFAULT_SOUND);
    }
  });

  it('survive storage that is blocked or full', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(savedSound(blocked)).toEqual(DEFAULT_SOUND);
    expect(() => saveSound(DEFAULT_SOUND, blocked)).not.toThrow();
    expect(savedSound(null)).toEqual(DEFAULT_SOUND);
  });

  it('turn a slider into a gain that is silent at 0, full at 1 and quieter than linear between', () => {
    expect(gainOf(0)).toBe(0);
    expect(gainOf(1)).toBe(1);
    expect(gainOf(0.5)).toBeLessThan(0.5);
  });
});
