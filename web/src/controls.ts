// Keyboard and mouse into the controls an input carries: WASD moves relative to the screen, the mouse aims, the
// left button fires and Space boosts.
import { type PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { GUN_HEIGHT } from './fleet';
import type { Control } from './prediction';

const FIRE = 1;
const BOOST = 2;

const gun = new Plane(new Vector3(0, 1, 0), -GUN_HEIGHT);
const stepRay = new Raycaster();
const at = new Vector3();
const to = new Vector3();
const ndc = new Vector2();

/**
 * The stick for `forward` and `right` keys held (each -1 to 1), for a craft at `(x, z)` in metres seen through
 * `camera`: the way across the floor that moves the craft up and right on screen from where it is. Under perspective
 * that way changes across the arena, so it is worked out at the craft rather than from the camera's heading.
 */
export function stick(
  forward: number,
  right: number,
  camera: PerspectiveCamera,
  x: number,
  z: number,
): [number, number] {
  if (forward === 0 && right === 0) return [0, 0];
  at.set(x, GUN_HEIGHT, z).project(camera);
  // One unit across normalised device coordinates is `aspect` times as many pixels as one unit up.
  const step = 0.01;
  stepRay.setFromCamera(ndc.set(at.x + (right * step) / camera.aspect, at.y + forward * step), camera);
  if (!stepRay.ray.intersectPlane(gun, to)) return [0, 0];
  const [dx, dz] = [to.x - x, to.z - z];
  const size = Math.hypot(dx, dz);
  if (size === 0) return [0, 0];
  return [Math.round((dx / size) * 127), Math.round((dz / size) * 127)];
}

/** A heading from `(x, z)` toward `(tx, tz)`, in 65536ths of a turn. */
export function headingTo(x: number, z: number, tx: number, tz: number): number {
  return Math.round((Math.atan2(tz - z, tx - x) / (2 * Math.PI)) * 65536) & 0xffff;
}

/** The player's keys and mouse. */
export class Controls {
  private readonly keys = new Set<string>();
  private readonly pointer = new Vector2();
  private readonly ray = new Raycaster();
  /** Whether the fire button is held. */
  firing = false;
  private aim = 0;
  /** Where the pointer is on the page, in CSS pixels, while it is over the game and the window has focus. */
  pointerAt: { x: number; y: number } | null = null;
  /** Where the pointer aims, at gun height, in metres. */
  readonly target = new Vector3();

  /** When the controls last changed, on the page's clock: the input event's own time. */
  changedAt: number | null = null;
  /** Whether Tab is held. */
  scoreboard = false;

  constructor(element: HTMLElement) {
    // The earliest change since the last frame, which waited longest for it.
    const changed = (event: Event) => {
      this.changedAt ??= event.timeStamp;
    };
    addEventListener('keydown', (event) => {
      if (event.code === 'Tab') {
        event.preventDefault();
        this.scoreboard = true;
      }
      if (!this.keys.has(event.code)) changed(event);
      this.keys.add(event.code);
    });
    addEventListener('keyup', (event) => {
      if (event.code === 'Tab') this.scoreboard = false;
      this.keys.delete(event.code);
      changed(event);
    });
    addEventListener('blur', () => {
      this.keys.clear();
      this.pointerAt = null;
    });
    element.addEventListener('pointermove', (event) => {
      this.pointer.set((event.clientX / innerWidth) * 2 - 1, -(event.clientY / innerHeight) * 2 + 1);
      this.pointerAt = { x: event.clientX, y: event.clientY };
      changed(event);
    });
    element.addEventListener('pointerleave', () => {
      this.pointerAt = null;
    });
    element.addEventListener('pointerdown', (event) => {
      if (event.button === 0) this.firing = true;
      changed(event);
    });
    addEventListener('pointerup', (event) => {
      if (event.button === 0) this.firing = false;
    });
    element.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  /** The controls now, for a craft at `(x, z)` in centimetres seen through `camera`. */
  sample(camera: PerspectiveCamera, x: number, z: number): Control {
    const held = (code: string) => (this.keys.has(code) ? 1 : 0);
    const forward = held('KeyW') - held('KeyS');
    const right = held('KeyD') - held('KeyA');
    const [moveX, moveZ] = stick(forward, right, camera, x / 100, z / 100);
    // The aim is taken where the pointer meets the bolts' own height, so a bolt flies under the cursor.
    this.ray.setFromCamera(this.pointer, camera);
    if (this.ray.ray.intersectPlane(gun, this.target))
      this.aim = headingTo(x, z, this.target.x * 100, this.target.z * 100);
    const buttons = (this.firing ? FIRE : 0) | (this.keys.has('Space') ? BOOST : 0);
    return { moveX, moveZ, aim: this.aim, buttons };
  }
}
