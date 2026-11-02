// The sound settings on the HUD: mute, music volume and effects volume, saved on this browser.

export interface SoundSettings {
  muted: boolean;
  /** Slider positions, 0 to 1. */
  music: number;
  effects: number;
}

/** Quiet by default: the music sits under the game, and the effects are what tells you what happened. */
export const DEFAULT_SOUND: SoundSettings = { muted: false, music: 0.4, effects: 0.7 };

/** Where the saved settings are kept. */
const KEY = 'felix-arena.sound';

/** What a slider position plays at. The curve is squared because loudness is heard on a log scale. */
export function gainOf(slider: number): number {
  return slider * slider;
}

const level = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

/** The settings saved on this browser, with the default for anything missing or unreadable. */
export function savedSound(store: Pick<Storage, 'getItem'> | null = browserStore()): SoundSettings {
  try {
    const raw = store?.getItem(KEY);
    const saved: unknown = raw ? JSON.parse(raw) : null;
    if (typeof saved !== 'object' || saved === null) return { ...DEFAULT_SOUND };
    const s = saved as Record<string, unknown>;
    return {
      muted: typeof s.muted === 'boolean' ? s.muted : DEFAULT_SOUND.muted,
      music: level(s.music, DEFAULT_SOUND.music),
      effects: level(s.effects, DEFAULT_SOUND.effects),
    };
  } catch {
    return { ...DEFAULT_SOUND };
  }
}

/** Saves `settings` on this browser. */
export function saveSound(settings: SoundSettings, store: Pick<Storage, 'setItem'> | null = browserStore()): void {
  try {
    store?.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage can be blocked; the settings then last only for this page.
  }
}

function browserStore(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}
