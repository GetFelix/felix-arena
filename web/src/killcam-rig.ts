// The kill cam's cameras (docs/design.md, "The kill cam", Views): the game camera centred on the victim or on the
// killer, and a lower orbit about the two. Each fits both crafts on screen, and every move is eased.
import { PerspectiveCamera, Vector3 } from 'three';
import { GUN_HEIGHT } from './fleet';

export type KillView = 'victim' | 'killer' | 'orbit';

/** The views in the order keys 1, 2 and 3 pick them. */
export const VIEWS: readonly KillView[] = ['victim', 'killer', 'orbit'];

/** The game camera's angle above the floor; see camera.ts. */
const GAME_ELEVATION = 0.98;
/** The orbit's: lower, so the crafts read as models rather than pieces on a board. */
const ORBIT_ELEVATION = 0.52;
/**
 * How far from the arena's centre a view may centre, as a share of its half length and width. Centred on a craft at a
 * wall, half the picture would be the dark beyond it.
 */
const INSIDE = 0.55;
/** How far toward the other craft a centred view leans, so the two share the frame. */
const LEAN = 0.3;
/** Both crafts stay inside this share of the screen's half width and height. */
const MARGIN = 0.62;
/** No craft is drawn further out than this, however the camera is easing. */
const HOLD = 0.8;
/** The orbit's turn, radians a second at full speed. */
const ORBIT_RATE = 0.3;
/** The time constant of every camera move, seconds. */
const EASE_S = 0.2;
/** The killer view's angle above the floor: a little lower than the game's, looking along the killer's nose. */
const CHASE_ELEVATION = 0.78;
/** The time constant of the killer view's turn after the killer's heading, seconds: slow, so circling reads calm. */
const CHASE_EASE_S = 0.7;

/** A camera pose in metres: where it is and the point it looks at. */
export interface Pose {
  position: Vector3;
  target: Vector3;
}

/** A craft on the floor, in centimetres, with its heading in 65536ths of a turn when known. */
export interface Spot {
  x: number;
  z: number;
  heading?: number;
}

/** Eases one camera between the kill cam's views as the replay plays. */
export class KillRig {
  view: KillView = 'victim';
  private readonly fit = new PerspectiveCamera();
  private readonly pose: Pose = { position: new Vector3(), target: new Vector3() };
  private started = false;
  private orbitYaw: number;
  private chaseYaw: number | null = null;
  private readonly want: Pose = { position: new Vector3(), target: new Vector3() };
  private readonly points = [new Vector3(), new Vector3()];
  private readonly away = new Vector3();

  /**
   * `fov` and `aspect` are the game camera's; `radius` is its distance from the arena's centre and `yaw` its angle
   * about y, from {@link framing}.
   */
  constructor(
    fov: number,
    aspect: number,
    private readonly radius: number,
    private readonly yaw: number,
    /** Half the arena's length (x) and width (z), in metres. */
    private readonly half: { x: number; z: number } = { x: 20, z: 14 },
  ) {
    this.fit.fov = fov;
    this.fit.aspect = aspect;
    this.fit.near = 0.5;
    this.fit.far = 500;
    this.fit.updateProjectionMatrix();
    this.orbitYaw = yaw - 0.6;
  }

  /** Start from `from`, the camera's pose now, so the first move eases out of it. */
  begin(from: Pose): void {
    this.pose.position.copy(from.position);
    this.pose.target.copy(from.target);
    this.started = true;
  }

  /**
   * The pose for a frame `dt` seconds after the last, with the replay running at `speed` (1 normal, 0.5 slowed) and
   * `held` true once the killing shot has landed, which slows the orbit further.
   */
  update(victim: Spot, killer: Spot, dt: number, speed = 1, held = false): Pose {
    this.orbitYaw += dt * ORBIT_RATE * speed * (held ? 0.35 : 1);
    if (killer.heading !== undefined) {
      // Behind the killer: the camera sits opposite its nose.
      const a = (killer.heading / 65536) * 2 * Math.PI;
      const behind = Math.atan2(-Math.cos(a), -Math.sin(a));
      if (this.chaseYaw === null) this.chaseYaw = behind;
      const turn = Math.atan2(Math.sin(behind - this.chaseYaw), Math.cos(behind - this.chaseYaw));
      this.chaseYaw += turn * (1 - Math.exp(-dt / CHASE_EASE_S));
    }
    this.aim(this.view, victim, killer, this.want);
    if (!this.started) {
      this.begin(this.want);
    } else {
      const k = 1 - Math.exp(-dt / EASE_S);
      this.pose.position.lerp(this.want.position, k);
      this.pose.target.lerp(this.want.target, k);
    }
    // The ease trails a craft that boosts or respawns across the arena; rather than lose it, back off at once.
    for (let i = 0; i < 40 && !this.fits(this.pose, HOLD); i++) {
      this.away.subVectors(this.pose.position, this.pose.target).multiplyScalar(1.04);
      this.pose.position.addVectors(this.pose.target, this.away);
    }
    return this.pose;
  }

  /** The pose `view` wants for the two crafts, written into `out`. */
  aim(view: KillView, victim: Spot, killer: Spot, out: Pose): Pose {
    const [v, k] = [toMetres(victim), toMetres(killer)];
    let focus: [number, number];
    let elevation = GAME_ELEVATION;
    let yaw = this.yaw;
    let near = this.radius * 0.5;
    if (view === 'orbit') {
      focus = [(v[0] + k[0]) / 2, (v[1] + k[1]) / 2];
      elevation = ORBIT_ELEVATION;
      yaw = this.orbitYaw;
      near = this.radius * 0.3;
    } else if (view === 'killer') {
      focus = [k[0] + (v[0] - k[0]) * 0.45, k[1] + (v[1] - k[1]) * 0.45];
      elevation = CHASE_ELEVATION;
      yaw = this.chaseYaw ?? this.yaw;
      near = this.radius * 0.35;
    } else {
      focus = [v[0] + (k[0] - v[0]) * LEAN, v[1] + (k[1] - v[1]) * LEAN];
    }
    const [hx, hz] = [this.half.x * INSIDE, this.half.z * INSIDE];
    out.target.set(Math.max(-hx, Math.min(hx, focus[0])), 0, Math.max(-hz, Math.min(hz, focus[1])));
    this.points[0]!.set(v[0], GUN_HEIGHT, v[1]);
    this.points[1]!.set(k[0], GUN_HEIGHT, k[1]);
    // Out from close until both crafts fit.
    for (let r = near; ; r *= 1.06) {
      place(out.position, out.target, r, yaw, elevation);
      if (r > this.radius * 1.4 || this.fits(out, MARGIN)) break;
    }
    return out;
  }

  private fits(pose: Pose, margin: number): boolean {
    const cam = this.fit;
    cam.position.copy(pose.position);
    cam.lookAt(pose.target);
    cam.updateMatrixWorld();
    return this.points.every((p) => onScreen(p, cam, margin));
  }
}

/** Whether `point` projects inside `margin` of the screen's half width and height through `camera`, in front of it. */
export function onScreen(point: Vector3, camera: PerspectiveCamera, margin = 1): boolean {
  const p = scratch.copy(point).project(camera);
  return Math.abs(p.x) <= margin && Math.abs(p.y) <= margin && p.z < 1;
}

const scratch = new Vector3();

function toMetres(spot: Spot): [number, number] {
  return [spot.x / 100, spot.z / 100];
}

/** `out` set `radius` from `target` at `yaw` about y and `elevation` above the floor. */
function place(out: Vector3, target: Vector3, radius: number, yaw: number, elevation: number): void {
  out.set(
    target.x + Math.sin(yaw) * Math.cos(elevation) * radius,
    target.y + Math.sin(elevation) * radius,
    target.z + Math.cos(yaw) * Math.cos(elevation) * radius,
  );
}
