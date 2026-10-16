import { type Fog, MathUtils, PerspectiveCamera } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** About 56 degrees above the floor. */
const ELEVATION = 0.98;

/**
 * The board-game camera: a narrow lens looking down on the arena, fitted to the viewport and swaying slowly until the
 * player drags it.
 */
export class ArenaCamera {
  readonly camera: PerspectiveCamera;
  private readonly controls: OrbitControls;
  private radius = 63;
  private yawBase = 0.35;
  private userMoved = false;

  constructor(
    element: HTMLElement,
    private readonly fog: Fog,
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
    this.controls = c;
    this.fit();
  }

  /** Fits the arena to the viewport. In portrait the long axis runs up the screen. */
  fit(): void {
    const { camera } = this;
    camera.aspect = innerWidth / innerHeight;
    const a = camera.aspect;
    const k = 2 * Math.tan(MathUtils.degToRad(camera.fov / 2));
    const [w, h] = a >= 1 ? [46, 34] : [24, 46];
    this.radius = Math.max(h / k, w / (k * a));
    this.yawBase = a >= 1 ? 0.35 : 0.35 + Math.PI / 2;
    this.fog.near = this.radius * 0.7;
    this.fog.far = this.radius * 1.45;
    camera.far = this.radius * 3;
    camera.updateProjectionMatrix();
  }

  /** Moves the camera to time `t` unless the player has taken it. */
  update(t: number): void {
    if (!this.userMoved) {
      const yaw = this.yawBase + Math.sin(t * 0.07) * 0.45;
      const r = this.radius;
      this.camera.position.set(
        Math.sin(yaw) * Math.cos(ELEVATION) * r,
        Math.sin(ELEVATION) * r,
        Math.cos(yaw) * Math.cos(ELEVATION) * r,
      );
      this.camera.lookAt(this.controls.target);
    }
    this.controls.update();
  }
}
