// The sound engine: effects through Web Audio, background music from audio elements, one volume bus for each. The
// browser plays nothing until the page has seen a click or key press, so nothing here starts before `unlock`.
import { CUES, type CueName, type Play } from './cues';
import { Playlist } from './playlist';
import { DEFAULT_SOUND, gainOf, type SoundSettings } from './sound-settings';
import { type Listener, place } from './spatial';

/** What the engine needs from the page, so tests can stand in for it. */
export interface SoundEnv {
  context(): AudioContext;
  /** The bytes of a bundled file. */
  load(url: string): Promise<ArrayBuffer>;
  /** An element that plays a bundled music file. */
  track(url: string): HTMLAudioElement;
  save(settings: SoundSettings): void;
  now(): number;
  random(): number;
  /** Calls `fn` every `ms` for as long as the page lives. */
  every(fn: () => void, ms: number): void;
}

export interface SoundFiles {
  /** URLs of the effects by file name without the extension. */
  sfx: Record<string, string>;
  /** URLs of the music by file name without the extension. */
  music: Record<string, string>;
}

/** Seconds before a track's end that the next one starts. The files fade out and in over this long, so they cross. */
export const CROSSFADE_S = 2;
/** Seconds before a track's end that the next one starts loading, so a slow link has time to fetch it. */
export const PREFETCH_S = 25;
/** Effects playing at once, so a busy fight cannot pile up voices. */
const MAX_VOICES = 24;
/** The music under the effects, and while a replay plays. */
const MUSIC_TRIM = 0.5;
const DUCKED = 0.4;
/** A repeated effect varies by up to this much in pitch, so it does not wear. */
const DETUNE = 0.04;
/** Music files that fail one after another before the engine gives up on music. */
const MAX_FAILURES = 3;

interface Playing {
  el: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  /** The next track has been started. */
  handedOver: boolean;
}

export class Sound {
  private settings: SoundSettings;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private effectsBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private readonly bytes = new Map<string, ArrayBuffer>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly loading: Promise<unknown>;
  private readonly lastPlayed = new Map<string, number>();
  private readonly lastFile = new Map<CueName, string>();
  private voices = 0;
  private readonly playlist: Playlist | null;
  private tracks: Playing[] = [];
  /** The next track, loading but not playing. */
  private queued: { name: string; el: HTMLAudioElement } | null = null;
  private failures = 0;
  private ducked = false;

  constructor(
    private readonly env: SoundEnv,
    private readonly files: SoundFiles,
    settings: SoundSettings = DEFAULT_SOUND,
  ) {
    this.settings = { ...settings };
    const music = Object.keys(files.music);
    this.playlist = music.length ? new Playlist(music, () => env.random()) : null;
    // The files are fetched now and decoded at unlock, when there is a context to decode with.
    this.loading = Promise.all(
      Object.entries(files.sfx).map(([name, url]) =>
        env
          .load(url)
          .then((data) => void this.bytes.set(name, data))
          .catch(() => {}),
      ),
    );
  }

  /** True once the page may make sound. */
  get unlocked(): boolean {
    return this.ctx !== null;
  }

  get current(): Readonly<SoundSettings> {
    return this.settings;
  }

  /** True once the browser lets the page make sound. */
  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /**
   * Starts the audio. Call it from a click or key press handler. A gesture the browser does not count, such as a
   * touch's pointerdown, leaves the context suspended, so a later call asks it to resume again.
   */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
      return;
    }
    const ctx = this.env.context();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.effectsBus = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.effectsBus.connect(this.master);
    this.musicBus.connect(this.master);
    this.master.connect(ctx.destination);
    this.applyVolumes();
    void ctx.resume().catch(() => {});
    void this.decode(ctx);
    this.syncMusic();
    this.env.every(() => this.follow(), 500);
  }

  /** Plays `play` as heard from `listener`, in an arena `reach` centimetres across. */
  play(play: Play, listener: Listener, reach: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.settings.muted || this.settings.effects === 0) return;
    const spec = CUES[play.cue];
    const now = this.env.now();
    // Your own sounds and everyone else's are spaced apart separately, so a bot's shot cannot silence yours.
    const slot = play.at === null ? play.cue : `${play.cue}:other`;
    const before = this.lastPlayed.get(slot);
    if (before !== undefined && now - before < spec.minGapMs) return;
    if (this.voices >= MAX_VOICES) return;
    const file = this.pick(play.cue);
    const buffer = this.buffers.get(file);
    if (!buffer) return;
    this.lastPlayed.set(slot, now);
    const where = place(listener, play.at, reach);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    if (spec.files.length > 1) source.playbackRate.value = 1 + (this.env.random() * 2 - 1) * DETUNE;
    const level = ctx.createGain();
    level.gain.value = spec.gain * play.gain * where.gain;
    const pan = ctx.createStereoPanner();
    pan.pan.value = where.pan;
    source.connect(level);
    level.connect(pan);
    pan.connect(this.effectsBus!);
    this.voices++;
    source.onended = () => {
      this.voices--;
      source.disconnect();
      pan.disconnect();
    };
    source.start();
  }

  /** Plays an interface sound, which has no place. */
  ui(cue: CueName): void {
    this.play({ cue, at: null, gain: 1 }, { x: 0, z: 0, yaw: 0 }, 1);
  }

  setMuted(muted: boolean): void {
    this.change({ ...this.settings, muted });
  }

  setMusic(music: number): void {
    this.change({ ...this.settings, music });
  }

  setEffects(effects: number): void {
    this.change({ ...this.settings, effects });
  }

  /** Turns the music down while a replay plays. */
  duck(on: boolean): void {
    if (on === this.ducked) return;
    this.ducked = on;
    this.applyVolumes();
  }

  /** Holds the audio while the page is hidden. */
  hold(hidden: boolean): void {
    if (!this.ctx) return;
    void (hidden ? this.ctx.suspend() : this.ctx.resume()).catch(() => {});
  }

  private change(next: SoundSettings): void {
    this.settings = next;
    this.env.save(next);
    this.applyVolumes();
    this.syncMusic();
  }

  private applyVolumes(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const s = this.settings;
    const at = ctx.currentTime;
    this.master!.gain.setTargetAtTime(s.muted ? 0 : 1, at, 0.02);
    this.effectsBus!.gain.setTargetAtTime(gainOf(s.effects), at, 0.02);
    this.musicBus!.gain.setTargetAtTime(gainOf(s.music) * MUSIC_TRIM * (this.ducked ? DUCKED : 1), at, 0.1);
  }

  private pick(cue: CueName): string {
    const files = CUES[cue].files;
    const last = this.lastFile.get(cue);
    const choices = files.length > 1 ? files.filter((f) => f !== last) : files;
    const file = choices[Math.floor(this.env.random() * choices.length)]!;
    this.lastFile.set(cue, file);
    return file;
  }

  private async decode(ctx: AudioContext): Promise<void> {
    await this.loading;
    await Promise.all(
      [...this.bytes].map(([name, data]) =>
        // decodeAudioData takes ownership of the bytes.
        ctx.decodeAudioData(data.slice(0)).then(
          (buffer) => void this.buffers.set(name, buffer),
          () => {},
        ),
      ),
    );
  }

  /** Music plays when sound is on and the music is up; otherwise it is held, not stopped. */
  private syncMusic(): void {
    if (!this.ctx || !this.playlist) return;
    if (!this.wanted()) {
      for (const t of this.tracks) t.el.pause();
    } else if (this.tracks.length === 0) {
      this.startTrack();
    } else {
      for (const t of this.tracks) void t.el.play().catch(() => {});
    }
  }

  private wanted(): boolean {
    return !this.settings.muted && this.settings.music > 0;
  }

  private startTrack(): void {
    const ctx = this.ctx;
    if (!ctx || !this.playlist || this.failures >= MAX_FAILURES) return;
    this.queue();
    const { el } = this.queued!;
    this.queued = null;
    const source = ctx.createMediaElementSource(el);
    source.connect(this.musicBus!);
    const track: Playing = { el, source, handedOver: false };
    this.tracks.push(track);
    el.addEventListener('playing', () => (this.failures = 0), { once: true });
    el.addEventListener('ended', () => this.finish(track));
    el.addEventListener('error', () => {
      this.failures++;
      this.finish(track);
    });
    // A play() that is refused raises no error event, so it counts as a failed file here.
    void el.play().catch(() => {
      this.failures++;
      this.finish(track);
    });
  }

  /** Picks the next track and starts loading it. */
  private queue(): void {
    if (this.queued || !this.playlist) return;
    const name = this.playlist.next();
    this.queued = { name, el: this.env.track(this.files.music[name]!) };
  }

  private finish(track: Playing): void {
    const i = this.tracks.indexOf(track);
    if (i < 0) return;
    this.tracks.splice(i, 1);
    track.source.disconnect();
    // Nothing left playing: start the next track.
    if (this.tracks.length === 0) this.syncMusic();
  }

  /** Loads the next track as the newest one nears its end, and starts it within the crossfade. */
  private follow(): void {
    if (!this.wanted()) return;
    for (const t of [...this.tracks]) {
      const left = t.el.duration - t.el.currentTime;
      if (t.handedOver || !Number.isFinite(left)) continue;
      if (left <= PREFETCH_S) this.queue();
      if (left <= CROSSFADE_S) {
        t.handedOver = true;
        this.startTrack();
      }
    }
  }
}
