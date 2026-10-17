import { type Fog, MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** About 56 degrees above the floor. */
const ELEVATION = 0.98;

/**
 * How far from the centre the camera sits and its angle about y, to fit the arena to a viewport of `aspect`. In
 * portrait the long axis runs up the screen. The `fixed` play camera sits square to the arena, so the keys' up, left,
 * down and right line up with its walls; the style frame's camera looks in from an angle.
 */
export function framing(aspect: number, fov: number, fixed: boolean): { radius: number; yaw: number } {
  const k = 2 * Math.tan(MathUtils.degToRad(fov / 2));
  const [w, h] = aspect >= 1 ? [46, 34] : [24, 46];
  const base = fixed ? 0 : 0.35;
  return { radius: Math.max(h / k, w / (k * aspect)), yaw: aspect >= 1 ? base : base + Math.PI / 2 };
}

/** Puts `camera` `radius` from the arena's centre at `yaw` about y, looking at the centre. */
export function placeCamera(camera: PerspectiveCamera, radius: number, yaw: number): void {
  camera.position.set(
    Math.sin(yaw) * Math.cos(ELEVATION) * radius,
    Math.sin(ELEVATION) * radius,
    Math.cos(yaw) * Math.cos(ELEVATION) * radius,
  );
  camera.lookAt(0, 0, 0);
}

/**
 * The board-game camera: a narrow lens looking down on the arena, fitted to the viewport and swaying slowly until the
 * player drags it.
 */
export class ArenaCamera {
  readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private radius = 63;
  private yawBase = 0;
  private userMoved = false;

  /** A `fixed` camera holds still and ignores the mouse, which aims in the game. */
  constructor(
    element: HTMLElement,
    private readonly fog: Fog,
    private readonly fixed = false,
  ) {
    this.camera = new PerspectiveCamera(30, innerWidth / innerHeight, 1, 200);
    const c = new OrbitControls(this.camera, element);
    c.enableDamping = true;
    c.minPolarAngle = 0.35;
    c.maxPolarAngle = 1.05;
    c.minDistance = 22;
    c.maxDistance = 140;
    c.enablePan = false;
    c.target.set(0, 0, 0);
    c.addEventListener('start', () => {
      this.userMoved = true;
    });
    c.enabled = !fixed;
    this.controls = c;
    this.fit();
  }

  /** Fits the arena to a view `width` by `height`, the window by default. */
  fit(width = innerWidth, height = innerHeight): void {
    const { camera } = this;
    camera.aspect = width / height;
    const { radius, yaw } = framing(camera.aspect, camera.fov, this.fixed);
    this.radius = radius;
    this.yawBase = yaw;
    this.fog.near = this.radius * 0.7;
    this.fog.far = this.radius * 1.45;
    camera.far = this.radius * 3;
    camera.updateProjectionMatrix();
  }

  /** The distance from the arena's centre and the angle about y the camera rests at. */
  get resting(): { radius: number; yaw: number } {
    return { radius: this.radius, yaw: this.yawBase };
  }

  /**
   * Moves the camera to time `t` unless the player has taken it. With a `pose`, the camera is `weight` of the way
   * from where it rests to that pose, for the kill cam.
   */
  update(t: number, pose?: { position: Vector3; target: Vector3 }, weight = 0): void {
    if (!this.userMoved) {
      placeCamera(this.camera, this.radius, this.yawBase + (this.fixed ? 0 : Math.sin(t * 0.07) * 0.45));
    }
    if (pose && weight > 0) {
      this.look.set(0, 0, 0).lerp(pose.target, weight);
      this.camera.position.lerp(pose.position, weight);
      this.camera.lookAt(this.look);
      return;
    }
    this.controls.update();
  }

  private readonly look = new Vector3();
}
