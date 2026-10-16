// Keyboard and mouse into the controls an input carries: WASD moves relative to the screen, the mouse aims, the
// left button fires and Space boosts.
import { type Camera, Plane, Raycaster, Vector2, Vector3 } from 'three';
import type { Control } from './prediction';

const FIRE = 1;
const BOOST = 2;

/** The stick for `forward` and `right` keys held (each -1 to 1), with the camera looking along `(fx, fz)`. */
export function stick(forward: number, right: number, fx: number, fz: number): [number, number] {
  const length = Math.hypot(fx, fz) || 1;
  const [ux, uz] = [fx / length, fz / length];
  // Right of the view is the forward direction turned a quarter turn clockwise, seen from above.
  const x = forward * ux - right * uz;
  const z = forward * uz + right * ux;
  const size = Math.hypot(x, z);
  if (size === 0) return [0, 0];
  return [Math.round((x / size) * 127), Math.round((z / size) * 127)];
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
  private readonly floor = new Plane(new Vector3(0, 1, 0), -0.6);
  private readonly hit = new Vector3();
  private firing = false;
  private aim = 0;
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
    addEventListener('blur', () => this.keys.clear());
    element.addEventListener('pointermove', (event) => {
      this.pointer.set((event.clientX / innerWidth) * 2 - 1, -(event.clientY / innerHeight) * 2 + 1);
      changed(event);
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
  sample(camera: Camera, x: number, z: number): Control {
    const held = (code: string) => (this.keys.has(code) ? 1 : 0);
    const forward = held('KeyW') - held('KeyS');
    const right = held('KeyD') - held('KeyA');
    const look = camera.getWorldDirection(new Vector3());
    const [moveX, moveZ] = stick(forward, right, look.x, look.z);
    this.ray.setFromCamera(this.pointer, camera);
    if (this.ray.ray.intersectPlane(this.floor, this.hit))
      this.aim = headingTo(x, z, this.hit.x * 100, this.hit.z * 100);
    const buttons = (this.firing ? FIRE : 0) | (this.keys.has('Space') ? BOOST : 0);
    return { moveX, moveZ, aim: this.aim, buttons };
  }
}
