import { describe, expect, it } from 'vitest';
import { CUES, type Play } from './cues';
import { CROSSFADE_S, Sound, type SoundEnv, type SoundFiles } from './sound';
import { onFirstGesture, soundWanted } from './sound-browser';
import { DEFAULT_SOUND, gainOf, type SoundSettings } from './sound-settings';

const listener = { x: 0, z: 0, yaw: 0 };
const shot: Play = { cue: 'fire', at: null, gain: 1 };

class FakeNode {
  connected: FakeNode[] = [];
  gain = { value: 1, setTargetAtTime: (v: number) => void (this.gain.value = v) };
  pan = { value: 0 };
  playbackRate = { value: 1 };
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started = false;
  connect(to: FakeNode) {
    this.connected.push(to);
  }
  disconnect() {}
  start() {
    this.started = true;
  }
}

class FakeContext {
  state = 'suspended';
  currentTime = 0;
  destination = new FakeNode();
  nodes: FakeNode[] = [];
  sources: FakeNode[] = [];
  resumed = 0;
  suspended = 0;
  private node() {
    const n = new FakeNode();
    this.nodes.push(n);
    return n;
  }
  createGain = () => this.node();
  createStereoPanner = () => this.node();
  createBufferSource = () => {
    const n = this.node();
    this.sources.push(n);
    return n;
  };
  createMediaElementSource = () => this.node();
  decodeAudioData = (data: ArrayBuffer) => Promise.resolve({ length: data.byteLength });
  resume = () => {
    this.resumed++;
    this.state = 'running';
    return Promise.resolve();
  };
  suspend = () => {
    this.suspended++;
    this.state = 'suspended';
    return Promise.resolve();
  };
}

class FakeTrack extends EventTarget {
  paused = true;
  duration = 100;
  currentTime = 0;
  plays = 0;
  constructor(readonly url: string) {
    super();
  }
  play() {
    this.paused = false;
    this.plays++;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

function setup(settings: SoundSettings = DEFAULT_SOUND, music = true) {
  const contexts: FakeContext[] = [];
  const tracks: FakeTrack[] = [];
  const saved: SoundSettings[] = [];
  const timers: (() => void)[] = [];
  let now = 0;
  let random = 0;
  const env: SoundEnv = {
    context: () => {
      const c = new FakeContext();
      contexts.push(c);
      return c as unknown as AudioContext;
    },
    load: (url) => Promise.resolve(new ArrayBuffer(url.length)),
    track: (url) => {
      const t = new FakeTrack(url);
      tracks.push(t);
      return t as unknown as HTMLAudioElement;
    },
    save: (s) => void saved.push({ ...s }),
    now: () => now,
    random: () => (random = (random + 0.37) % 1),
    every: (fn) => {
      timers.push(fn);
      return () => void timers.splice(timers.indexOf(fn), 1);
    },
  };
  const files: SoundFiles = {
    sfx: {
      'fire-1': '/fire-1.ogg',
      'fire-2': '/fire-2.ogg',
      'fire-3': '/fire-3.ogg',
      hurt: '/hurt.ogg',
      click: '/c.ogg',
    },
    music: music ? { one: '/one.ogg', two: '/two.ogg', three: '/three.ogg' } : {},
  };
  const sound = new Sound(env, files, settings);
  const ready = async () => {
    // Let the fetches and decodes settle.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return {
    sound,
    contexts,
    tracks,
    saved,
    timers,
    ready,
    advance: (ms: number) => (now += ms),
  };
}

describe('Sound before the first gesture', () => {
  it('makes no context, no sound and no music until unlocked', async () => {
    const t = setup();
    await t.ready();
    t.sound.play(shot, listener, 6000);
    t.sound.ui('click');
    expect(t.contexts).toHaveLength(0);
    expect(t.tracks).toHaveLength(0);
    expect(t.sound.unlocked).toBe(false);
  });

  it('unlocks once: one context, one running music track, however many gestures', async () => {
    const t = setup();
    t.sound.unlock();
    t.sound.unlock();
    await t.ready();
    expect(t.contexts).toHaveLength(1);
    expect(t.contexts[0]!.resumed).toBe(1);
    expect(t.tracks).toHaveLength(1);
    expect(t.tracks[0]!.paused).toBe(false);
    expect(t.sound.unlocked).toBe(true);
  });

  it('plays effects after unlocking', async () => {
    const t = setup();
    t.sound.unlock();
    await t.ready();
    t.sound.play(shot, listener, 6000);
    expect(t.contexts[0]!.sources).toHaveLength(1);
    expect(t.contexts[0]!.sources[0]!.started).toBe(true);
  });

  it('is silent for a sound whose file has not decoded', async () => {
    const t = setup();
    t.sound.unlock();
    // No wait: the decode has not finished.
    t.sound.play(shot, listener, 6000);
    expect(t.contexts[0]!.sources).toHaveLength(0);
  });
});

describe('Sound effects', () => {
  it('drops a cue repeated inside its minimum gap and plays it after', async () => {
    const t = setup();
    t.sound.unlock();
    await t.ready();
    t.sound.play(shot, listener, 6000);
    t.advance(CUES.fire.minGapMs - 1);
    t.sound.play(shot, listener, 6000);
    expect(t.contexts[0]!.sources).toHaveLength(1);
    t.advance(2);
    t.sound.play(shot, listener, 6000);
    expect(t.contexts[0]!.sources).toHaveLength(2);
  });

  it('never picks the same variant twice in a row', async () => {
    const t = setup();
    t.sound.unlock();
    await t.ready();
    const heard: unknown[] = [];
    for (let i = 0; i < 12; i++) {
      t.advance(100);
      t.sound.play(shot, listener, 6000);
      heard.push(t.contexts[0]!.sources.at(-1)!.buffer);
    }
    for (let i = 1; i < heard.length; i++) expect(heard[i]).not.toBe(heard[i - 1]);
  });

  it('caps the voices playing at once and frees them as they end', async () => {
    const t = setup();
    t.sound.unlock();
    await t.ready();
    for (let i = 0; i < 40; i++) {
      t.advance(1000);
      t.sound.play({ cue: 'hurt', at: null, gain: 1 }, listener, 6000);
    }
    const sources = t.contexts[0]!.sources;
    expect(sources.length).toBe(24);
    sources[0]!.onended!();
    t.advance(1000);
    t.sound.play({ cue: 'hurt', at: null, gain: 1 }, listener, 6000);
    expect(t.contexts[0]!.sources.length).toBe(25);
  });

  it('plays nothing while the context is suspended, as when the page is hidden', async () => {
    const t = setup();
    t.sound.unlock();
    await t.ready();
    t.sound.hold(true);
    t.sound.play(shot, listener, 6000);
    expect(t.contexts[0]!.sources).toHaveLength(0);
    t.sound.hold(false);
    t.advance(1000);
    t.sound.play(shot, listener, 6000);
    expect(t.contexts[0]!.sources).toHaveLength(1);
  });
});

describe('Sound settings', () => {
  it('mute silences effects and holds the music, and unmuting brings them back', async () => {
    const t = setup();
    t.sound.unlock();
    await t.ready();
    t.sound.setMuted(true);
    t.advance(1000);
    t.sound.play(shot, listener, 6000);
    expect(t.contexts[0]!.sources).toHaveLength(0);
    expect(t.tracks[0]!.paused).toBe(true);
    t.sound.setMuted(false);
    expect(t.tracks).toHaveLength(1);
    expect(t.tracks[0]!.paused).toBe(false);
    t.sound.play(shot, listener, 6000);
    expect(t.contexts[0]!.sources).toHaveLength(1);
  });

  it('start muted when saved muted: no music, but unmuting starts it', async () => {
    const t = setup({ ...DEFAULT_SOUND, muted: true });
    t.sound.unlock();
    await t.ready();
    expect(t.tracks).toHaveLength(0);
    t.sound.setMuted(false);
    expect(t.tracks).toHaveLength(1);
  });

  it('save every change, and set the buses from the sliders', async () => {
    const t = setup();
    t.sound.unlock();
    t.sound.setMusic(1);
    t.sound.setEffects(0.5);
    expect(t.saved.at(-1)).toEqual({ muted: false, music: 1, effects: 0.5 });
    const [master, effects, music] = t.contexts[0]!.nodes;
    expect(master!.gain.value).toBe(1);
    expect(effects!.gain.value).toBeCloseTo(gainOf(0.5));
    expect(music!.gain.value).toBeCloseTo(gainOf(1) * 0.5);
    t.sound.setMuted(true);
    expect(master!.gain.value).toBe(0);
    expect(t.saved.at(-1)!.muted).toBe(true);
  });

  it('turn the music down for a replay and back up after', async () => {
    const t = setup();
    t.sound.unlock();
    const music = t.contexts[0]!.nodes[2]!;
    const normal = music.gain.value;
    t.sound.duck(true);
    expect(music.gain.value).toBeLessThan(normal);
    t.sound.duck(false);
    expect(music.gain.value).toBe(normal);
  });

  it('pause the music at zero without a mute', async () => {
    const t = setup();
    t.sound.unlock();
    t.sound.setMusic(0);
    expect(t.tracks[0]!.paused).toBe(true);
    t.sound.setMusic(0.4);
    expect(t.tracks[0]!.paused).toBe(false);
  });
});

describe('Sound music', () => {
  it('starts the next track as the current one comes within the crossfade of its end, once', async () => {
    const t = setup();
    t.sound.unlock();
    await t.ready();
    const tick = t.timers[0]!;
    t.tracks[0]!.currentTime = 100 - CROSSFADE_S - 1;
    tick();
    expect(t.tracks).toHaveLength(1);
    t.tracks[0]!.currentTime = 100 - CROSSFADE_S + 0.5;
    tick();
    tick();
    expect(t.tracks).toHaveLength(2);
    expect(t.tracks[1]!.url).not.toBe(t.tracks[0]!.url);
  });

  it('keeps going through every track and starts a new round without repeating the last', async () => {
    const t = setup();
    t.sound.unlock();
    await t.ready();
    const tick = t.timers[0]!;
    for (let i = 0; i < 8; i++) {
      const playing = t.tracks.at(-1)!;
      playing.currentTime = 99;
      tick();
      playing.dispatchEvent(new Event('ended'));
    }
    const urls = t.tracks.map((x) => x.url);
    expect(urls.length).toBeGreaterThan(8);
    for (let i = 1; i < urls.length; i++) expect(urls[i]).not.toBe(urls[i - 1]);
  });

  it('does not move on to the next track while the music is held', async () => {
    const t = setup();
    t.sound.unlock();
    await t.ready();
    t.sound.setMusic(0);
    t.tracks[0]!.currentTime = 99;
    t.timers[0]!();
    expect(t.tracks).toHaveLength(1);
  });

  it('starts the next track when one ends with nothing queued', async () => {
    const t = setup();
    t.sound.unlock();
    await t.ready();
    t.tracks[0]!.dispatchEvent(new Event('ended'));
    expect(t.tracks).toHaveLength(2);
  });

  it('gives up on music after files keep failing, and keeps the effects', async () => {
    const t = setup();
    t.sound.unlock();
    await t.ready();
    for (let i = 0; i < 6; i++) t.tracks.at(-1)!.dispatchEvent(new Event('error'));
    expect(t.tracks.length).toBeLessThanOrEqual(3);
    t.sound.play(shot, listener, 6000);
    expect(t.contexts[0]!.sources).toHaveLength(1);
  });

  it('plays effects only when there is no music to play', async () => {
    const t = setup(DEFAULT_SOUND, false);
    t.sound.unlock();
    await t.ready();
    expect(t.tracks).toHaveLength(0);
    t.sound.play(shot, listener, 6000);
    expect(t.contexts[0]!.sources).toHaveLength(1);
  });

  it('stops the music and the timer on close', async () => {
    const t = setup();
    t.sound.unlock();
    await t.ready();
    t.sound.close();
    expect(t.tracks[0]!.paused).toBe(true);
    expect(t.timers).toHaveLength(0);
  });
});

describe('onFirstGesture', () => {
  it('runs on the first click, key press or touch, once, and not before', () => {
    for (const type of ['pointerdown', 'keydown', 'touchend', 'click']) {
      const target = new EventTarget();
      let runs = 0;
      onFirstGesture(target, () => runs++);
      expect(runs).toBe(0);
      target.dispatchEvent(new Event('mousemove'));
      expect(runs).toBe(0);
      target.dispatchEvent(new Event(type));
      target.dispatchEvent(new Event('keydown'));
      target.dispatchEvent(new Event('pointerdown'));
      expect(runs).toBe(1);
    }
  });

  it('can be cancelled', () => {
    const target = new EventTarget();
    let runs = 0;
    const cancel = onFirstGesture(target, () => runs++);
    cancel();
    target.dispatchEvent(new Event('keydown'));
    expect(runs).toBe(0);
  });
});

describe('soundWanted', () => {
  it('is on for a person, off for an automated browser, and ?sound= decides either way', () => {
    const q = (s: string) => new URLSearchParams(s);
    expect(soundWanted(q(''), false)).toBe(true);
    expect(soundWanted(q(''), true)).toBe(false);
    expect(soundWanted(q('sound=on'), true)).toBe(true);
    expect(soundWanted(q('sound=off'), false)).toBe(false);
  });
});
