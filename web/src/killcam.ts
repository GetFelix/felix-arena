// The kill cam (docs/design.md, "The kill cam"): the live death beat while the replay is read, the replay drawn by
// the same scene through its own cameras, and the way back to the game. The live world keeps updating underneath.
import { AdditiveBlending, type Mesh, Mesh as ThreeMesh, MeshBasicMaterial, type Object3D, RingGeometry } from 'three';
import { type KillRig, type KillView, type Pose, type Spot, VIEWS } from './killcam-rig';
import { hdr } from './materials';
import { callsign } from './match';
import { palette } from './palette';
import { fetchReplay, type KillRef, Playback, type Reader, type Replay, type ReplayFrame } from './replay';

export type KillCamState = 'beat' | 'replay' | 'leaving' | 'off';

/** The live death beat before the replay, in which the fetch runs. */
export const BEAT_MS = 600;
/** How long the camera takes to ease back to the game. */
const LEAVE_MS = 450;
/** How long "Replay no longer available" stays up. */
const REFUSED_MS = 2500;
/** How far the death beat eases the camera toward the victim. */
const BEAT_WEIGHT = 0.5;
/** Ticks after the kill before the caption comes up, so the explosion is seen first. */
const CAPTION_TICKS = 8;
/** How long the replay holds on its last tick, with the caption up, before going back to the game. */
const HOLD_MS = 1200;
/** How long the shock ring under the explosion takes to spread, in seconds of the replay. */
const SHOCK_S = 0.6;

/** When one kill cam's steps happened, in Unix milliseconds on the page's clock unless named otherwise. */
export interface KillCamTimes {
  killTick: number;
  /** When the sim started the kill's commit, on the sim's clock. */
  commitUnixMs: number | null;
  /** The kill's tick arrived in the page. */
  arrivedUnixMs: number;
  /** How long the read of every tick up to the kill took, decoded. */
  fetchMs: number | null;
  /** The replay was ready to show: the death beat over and every tick up to the kill decoded. */
  readyUnixMs: number | null;
  /** The first frame of the replay began. */
  drawnUnixMs: number | null;
  /** The replay could not be read: `trimmed` or `error`. */
  failed: string | null;
}

/** What a frame draws while a kill cam runs. */
export interface KillCamFrame {
  /** The replay's frame, or `null` to draw the live world. */
  replay: ReplayFrame | null;
  /** The camera's pose, and how far toward it from the game camera, 0 to 1. */
  pose: Pose | null;
  weight: number;
}

/** A craft as the kill cam needs it, in centimetres. */
interface Placed {
  slot: number;
  violet: boolean;
  alive: boolean;
  x: number;
  z: number;
  heading: number;
}

/** One kill cam at a time. */
export class KillCam {
  state: KillCamState = 'off';
  kill: KillRef | null = null;
  replay: Replay | null = null;
  times: KillCamTimes | null = null;
  /** Holds the replay's clock still, for screenshots. */
  held = false;
  private playback: Playback | null = null;
  private rig: KillRig | null = null;
  private since = 0;
  private leaveFrom = 1;
  private lastMs: number | null = null;
  private refusedUntil = 0;
  /** When the replay reached its last tick. */
  private endedAt: number | null = null;
  /** Whether the killer was seen alive in this kill cam; until then the views frame the victim alone. */
  private killerSeen = false;
  private victimAt: Spot = { x: 0, z: 0 };
  private killerAt: Spot = { x: 0, z: 0 };
  private readonly hud = new ReplayHud();
  private readonly fetched = new WeakMap<KillCamTimes, Replay>();

  constructor(
    private readonly rigFor: () => KillRig,
    private readonly markers: Markers,
  ) {}

  /** Whether the replay, rather than the live world, is on screen. */
  get playing(): boolean {
    return this.state === 'replay';
  }

  /** Start the kill cam for `kill`, which arrived at `nowMs`: the death beat now, the replay once it is read. */
  start(kill: KillRef, reader: Reader, nowMs: number, commitUnixMs: number | null, beatMs = BEAT_MS): void {
    const view = this.rig?.view;
    if (this.replay) this.replay.dropped = true;
    this.hud.hide();
    this.markers.hide();
    this.state = 'beat';
    this.kill = kill;
    this.since = nowMs - (BEAT_MS - beatMs);
    this.replay = null;
    this.playback = null;
    this.endedAt = null;
    this.killerSeen = false;
    this.rig = this.rigFor();
    if (view) this.rig.view = view;
    const times: KillCamTimes = {
      killTick: kill.tick,
      commitUnixMs,
      arrivedUnixMs: Date.now(),
      fetchMs: null,
      readyUnixMs: null,
      drawnUnixMs: null,
      failed: null,
    };
    this.times = times;
    void fetchReplay(reader, kill).then((replay) => {
      this.fetched.set(times, replay);
      if (this.times !== times) {
        replay.dropped = true;
        return;
      }
      this.replay = replay;
      times.failed = replay.failed;
      if (replay.times.beforeMs !== null) times.fetchMs = replay.times.beforeMs - replay.times.startMs;
    });
  }

  /** The replay a kill cam read, once it has, current or not. */
  replayOf(times: KillCamTimes): Replay | null {
    return this.fetched.get(times) ?? null;
  }

  /** Leave for the game. */
  skip(nowMs: number): void {
    if (this.held) return;
    if (this.state === 'beat') this.leave(nowMs, this.beatWeight(nowMs));
    if (this.state === 'replay') this.leave(nowMs, 1);
  }

  /** Put the replay at `ticks` from its kill, for screenshots; it is held there if {@link held}. */
  seek(ticks: number): void {
    if (this.playback && this.kill) this.playback.seek(this.kill.tick + ticks);
  }

  /** Set the replay's camera. */
  view(view: KillView): void {
    if (this.rig) this.rig.view = view;
  }

  /** The frame at `nowMs`, given the live crafts, which the death beat looks at. */
  frame(nowMs: number, live: Placed[]): KillCamFrame {
    // A page that was hidden comes back with one long frame; the replay takes it as a short one.
    const dt = this.lastMs === null ? 0 : Math.min(100, Math.max(0, nowMs - this.lastMs));
    this.lastMs = nowMs;
    this.hud.refused(nowMs < this.refusedUntil);
    const kill = this.kill;
    if (this.state === 'beat' && kill) {
      const replay = this.replay;
      if (replay?.failed) {
        this.refusedUntil = nowMs + REFUSED_MS;
        this.leave(nowMs, this.beatWeight(nowMs));
      } else if (replay?.ready && nowMs - this.since >= BEAT_MS) {
        this.state = 'replay';
        this.rig!.handoff(this.beatWeight(nowMs));
        this.playback = new Playback(replay);
        this.times!.readyUnixMs = Date.now();
      } else {
        this.follow(live, kill);
        return {
          replay: null,
          pose: this.rig!.update(this.victimAt, this.killerAt, dt / 1000),
          weight: this.beatWeight(nowMs),
        };
      }
    }
    if (this.state === 'replay' && this.playback && kill) {
      this.playback.held = this.held;
      const frame = this.playback.advance(dt);
      this.follow(frame.crafts, kill);
      const pose = this.rig!.update(
        this.victimAt,
        this.killerAt,
        dt / 1000,
        frame.speed,
        frame.renderTick >= kill.tick,
      );
      this.times!.drawnUnixMs ??= Date.now();
      this.hud.update(frame, kill, this.rig!.view, frame.crafts);
      this.markers.show(frame.crafts, kill, frame.renderTick, nowMs);
      if (frame.done) this.endedAt ??= nowMs;
      if (this.endedAt !== null && nowMs - this.endedAt >= HOLD_MS && !this.held) this.leave(nowMs, 1);
      return { replay: frame, pose, weight: 1 };
    }
    this.hud.hide();
    this.markers.hide();
    if (this.state !== 'leaving' || !this.rig) return { replay: null, pose: null, weight: 0 };
    const left = 1 - (nowMs - this.since) / LEAVE_MS;
    if (left <= 0) {
      this.state = 'off';
      return { replay: null, pose: null, weight: 0 };
    }
    return {
      replay: null,
      pose: this.rig.update(this.victimAt, this.killerAt, dt / 1000),
      weight: this.leaveFrom * ease(left),
    };
  }

  private leave(nowMs: number, from: number): void {
    this.state = 'leaving';
    this.since = nowMs;
    this.leaveFrom = from;
  }

  private beatWeight(nowMs: number): number {
    return BEAT_WEIGHT * ease(Math.min(1, (nowMs - this.since) / BEAT_MS));
  }

  private follow(
    crafts: { slot: number; alive: boolean; x: number; z: number; heading?: number }[],
    kill: KillRef,
  ): void {
    // A destroyed victim stays where it went down. A destroyed killer waiting to respawn is nowhere to look.
    const victim = crafts.find((c) => c.slot === kill.victim);
    const killer = crafts.find((c) => c.slot === kill.killer);
    if (victim) this.victimAt = { x: victim.x, z: victim.z };
    if (killer?.alive) {
      this.killerSeen = true;
      this.killerAt = { x: killer.x, z: killer.z, heading: killer.heading };
    } else if (!this.killerSeen) {
      this.killerAt = this.victimAt;
    }
  }
}

function ease(f: number): number {
  const c = Math.max(0, Math.min(1, f));
  return c * c * (3 - 2 * c);
}

/** The REPLAY overlay: letterbox bars, the tag, who killed whom, the views and the timeline. */
class ReplayHud {
  private readonly root = document.getElementById('replay')!;
  private readonly shown = new Map<string, string>();
  private on = false;

  hide(): void {
    if (!this.on) return;
    this.on = false;
    this.root.classList.remove('on', 'ended');
  }

  refused(on: boolean): void {
    document.getElementById('replay-gone')!.hidden = !on;
  }

  update(frame: ReplayFrame, kill: KillRef, view: KillView, crafts: Placed[]): void {
    if (!this.on) {
      this.on = true;
      this.root.classList.add('on');
    }
    const team = (slot: number) => (crafts.find((c) => c.slot === slot)?.violet ? 'violet' : 'coral');
    this.html(
      'replay-title',
      `<span class="${team(kill.killer)}">${callsign(kill.killer)}</span><span class="x">eliminated</span><span class="${team(kill.victim)}">${callsign(kill.victim)}</span>`,
    );
    this.text('replay-speed', frame.speed < 0.95 ? `${frame.speed.toFixed(1)}×` : '');
    this.html(
      'replay-verdict',
      `<span class="${team(kill.victim)}">${callsign(kill.victim)}</span> was destroyed by <span class="${team(kill.killer)}">${callsign(kill.killer)}</span>`,
    );
    this.root.classList.toggle('ended', frame.renderTick >= kill.tick + CAPTION_TICKS);
    for (const v of VIEWS) document.getElementById(`replay-${v}`)!.classList.toggle('on', v === view);
    const bar = document.getElementById('replay-progress')!;
    bar.style.transform = `scaleX(${Math.max(0, Math.min(1, frame.progress)).toFixed(4)})`;
    document.getElementById('replay-mark')!.style.left = `${(frame.killAt * 100).toFixed(2)}%`;
  }

  private text(id: string, value: string): void {
    if (this.shown.get(id) === value) return;
    this.shown.set(id, value);
    document.getElementById(id)!.textContent = value;
  }

  private html(id: string, value: string): void {
    if (this.shown.get(id) === value) return;
    this.shown.set(id, value);
    document.getElementById(id)!.innerHTML = value;
  }
}

/**
 * Team-coloured rings on the floor under the killer and the victim while a replay plays, and the shock ring that
 * spreads from the victim's explosion.
 */
export class Markers {
  private readonly killer: Mesh;
  private readonly victim: Mesh;
  private readonly shock: Mesh;
  private readonly tints = [hdr(palette.coral, 0.8), hdr(palette.violet, 0.8)] as const;

  constructor(fx: Object3D) {
    const ring = (inner: number, outer: number, segments = 72) => {
      const mesh = new ThreeMesh(
        new RingGeometry(inner, outer, segments),
        new MeshBasicMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.03;
      mesh.visible = false;
      fx.add(mesh);
      return mesh;
    };
    this.killer = ring(1.2, 1.32);
    this.victim = ring(1.2, 1.26);
    this.shock = ring(0.92, 1, 96);
  }

  /** Place the rings for the replay's crafts at tick time `r`. */
  show(crafts: Placed[], kill: KillRef, r: number, nowMs: number): void {
    const place = (mesh: Mesh, slot: number, level: number) => {
      const c = crafts.find((craft) => craft.slot === slot);
      mesh.visible = !!c;
      if (!c) return;
      mesh.position.x = c.x / 100;
      mesh.position.z = c.z / 100;
      const material = mesh.material as MeshBasicMaterial;
      material.color.copy(this.tints[c.violet ? 1 : 0]);
      material.opacity = level;
    };
    // The killer's ring breathes, so the eye finds it; the victim's is quieter. Neither marks a destroyed craft.
    const killer = crafts.find((c) => c.slot === kill.killer);
    place(this.killer, kill.killer, killer?.alive ? 0.75 + 0.25 * Math.sin(nowMs / 220) : 0);
    const victim = crafts.find((c) => c.slot === kill.victim);
    place(this.victim, kill.victim, victim?.alive ? 0.45 : 0);
    const since = (r - kill.tick) / 30 / SHOCK_S;
    place(this.shock, kill.victim, since >= 0 && since < 1 ? 1 - since : 0);
    this.shock.scale.setScalar(0.4 + 5 * Math.sqrt(Math.max(0, since)));
    this.shock.visible &&= since >= 0 && since < 1;
  }

  hide(): void {
    this.killer.visible = false;
    this.victim.visible = false;
    this.shock.visible = false;
  }
}
