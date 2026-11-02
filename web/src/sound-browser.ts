// Wires the sound engine to the page: the browser's audio, the first click or key press that lets it start, and the
// controls on the HUD.
import { Sound, type SoundEnv, type SoundFiles } from './sound';
import { saveSound, savedSound, type SoundSettings } from './sound-settings';

/** The events that count as the page being used, which is what lets a browser start audio. */
const GESTURES = ['pointerdown', 'pointerup', 'keydown', 'touchend', 'click'] as const;

/**
 * Calls `fn` on each gesture on `target` until it returns true. Not every gesture counts as one to the browser (a
 * touch's pointerdown does not), so a first call that leaves the audio suspended must be tried again. Returns a function
 * that cancels the wait.
 */
export function onGesture(target: EventTarget, fn: () => boolean): () => void {
  const stop = () => {
    for (const type of GESTURES) target.removeEventListener(type, run, { capture: true });
  };
  function run() {
    if (fn()) stop();
  }
  for (const type of GESTURES) target.addEventListener(type, run, { capture: true });
  return stop;
}

/**
 * Whether this page makes sound. Automated browsers get none, so a test run does not decode music on a loaded
 * machine; `?sound=on` asks for it anyway and `?sound=off` for none.
 */
export function soundWanted(params: URLSearchParams, automated: boolean): boolean {
  const asked = params.get('sound');
  if (asked === 'on') return true;
  if (asked === 'off') return false;
  return !automated;
}

const browserEnv = (): SoundEnv => ({
  context: () =>
    new (window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)(),
  load: async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.arrayBuffer();
  },
  track: (url) => {
    const el = new Audio(url);
    el.preload = 'auto';
    return el;
  },
  save: (settings) => saveSound(settings),
  now: () => performance.now(),
  random: () => Math.random(),
  every: (fn, ms) => void setInterval(fn, ms),
});

/** Reads the controls into settings and shows `settings` in them. */
export function soundControls(sound: Sound, root: HTMLElement): void {
  const mute = root.querySelector<HTMLButtonElement>('#sound-mute')!;
  const music = root.querySelector<HTMLInputElement>('#sound-music')!;
  const effects = root.querySelector<HTMLInputElement>('#sound-effects')!;
  const show = (s: Readonly<SoundSettings>) => {
    mute.setAttribute('aria-checked', String(!s.muted));
    mute.textContent = s.muted ? 'Sound: off' : 'Sound: on';
    music.value = String(s.music);
    effects.value = String(s.effects);
  };
  const toggle = () => {
    sound.setMuted(!sound.current.muted);
    // Heard when sound comes back on; a mute is silent by definition.
    sound.ui('toggle');
    show(sound.current);
  };
  mute.addEventListener('click', () => {
    toggle();
    mute.blur();
  });
  music.addEventListener('input', () => sound.setMusic(Number(music.value)));
  effects.addEventListener('input', () => sound.setEffects(Number(effects.value)));
  // A click on the effects slider plays a sample at the new level.
  effects.addEventListener('change', () => sound.ui('click'));
  for (const slider of [music, effects]) {
    slider.addEventListener('change', () => slider.blur());
    // Keys go to the game even while a slider has focus. Tab still moves on; the keys that would move the slider do not.
    slider.addEventListener('keydown', (event) => {
      if (event.code === 'Tab') return;
      event.preventDefault();
      slider.blur();
    });
  }
  addEventListener('keydown', (event) => {
    if (event.code === 'KeyM' && !event.repeat && !event.ctrlKey && !event.metaKey) toggle();
  });
  show(sound.current);
  root.hidden = false;
}

/**
 * Starts the page's sound: the engine, its unlock on the first gesture, the HUD controls in `root` and a click sound for
 * every button. Returns the engine, which stays silent until the page has been used.
 */
export function startSound(files: SoundFiles, params: URLSearchParams, root: HTMLElement): Sound {
  if (!soundWanted(params, navigator.webdriver)) return new Sound(browserEnv(), { sfx: {}, music: {} });
  const sound = new Sound(browserEnv(), files, savedSound());
  onGesture(window, () => {
    sound.unlock();
    return sound.running;
  });
  document.addEventListener('visibilitychange', () => sound.hold(document.hidden));
  document.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest?.('button');
    if (button && button.id !== 'sound-mute') sound.ui('click');
  });
  soundControls(sound, root);
  return sound;
}
