// Where your craft aims: a reticle at the pointer in place of the OS cursor, and a faint line from the nose to it.
import {
  AdditiveBlending,
  BufferAttribute,
  type Color,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  type PerspectiveCamera,
  PlaneGeometry,
  Vector3,
} from 'three';
import { GUN_HEIGHT } from './fleet';
import { hdr } from './materials';
import { palette } from './palette';

/** How far ahead of a craft's centre its nose is, in metres. */
const NOSE = 1.3;
const WIDTH = 0.12;
/** The line stops this many CSS pixels short of the reticle's centre, outside its ring. */
const GAP_PX = 15;

/** What the aim shows this frame. */
export interface AimView {
  /** The pointer on the page, in CSS pixels, or null to show neither reticle nor line and give the cursor back. */
  pointer: { x: number; y: number } | null;
  /** Your craft's centre in metres, while it flies. */
  craft: { x: number; z: number } | null;
  violet: boolean;
  /** Where the pointer meets gun height, in metres. */
  target: Vector3;
  firing: boolean;
}

/** A flat ribbon from x = 0 to 1, bright along its middle and fading in at the nose and out at the far end. */
function ribbon(): PlaneGeometry {
  const g = new PlaneGeometry(1, WIDTH, 32, 2).rotateX(-Math.PI / 2).translate(0.5, 0, 0);
  const position = g.getAttribute('position');
  const colours = new Float32Array(position.count * 3);
  const smooth = (a: number, b: number, u: number) => {
    const k = Math.min(1, Math.max(0, (u - a) / (b - a)));
    return k * k * (3 - 2 * k);
  };
  for (let i = 0; i < position.count; i++) {
    const u = position.getX(i);
    const across = 1 - Math.abs(position.getZ(i)) / (WIDTH / 2);
    const level = smooth(0, 0.1, u) * smooth(1, 0.7, u) * (1 - 0.5 * u) * across;
    colours.set([level, level, level], i * 3);
  }
  g.setAttribute('color', new BufferAttribute(colours, 3));
  return g;
}

/** The reticle and the aim line. */
export class Aim {
  private readonly line: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly colours: [Color, Color];
  private readonly nose = new Vector3();
  private shown = '';

  constructor(
    fx: Object3D,
    private readonly reticle: HTMLElement,
  ) {
    this.line = new Mesh(
      ribbon(),
      new MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    );
    this.line.visible = false;
    fx.add(this.line);
    // Faint enough to stay under the bloom threshold: a guide, not an effect.
    this.colours = [hdr(palette.coral, 0.3), hdr(palette.violet, 0.3)];
  }

  update(view: AimView, camera: PerspectiveCamera): void {
    const { pointer, craft, target } = view;
    const team = craft ? (view.violet ? 'violet' : 'coral') : 'down';
    const state = pointer ? `${team}${view.firing ? ' firing' : ''}` : '';
    if (state !== this.shown) {
      this.shown = state;
      this.reticle.hidden = !pointer;
      this.reticle.setAttribute('class', `reticle ${state}`);
      document.body.classList.toggle('aiming', pointer !== null);
    }
    if (pointer) this.reticle.style.transform = `translate(${pointer.x}px, ${pointer.y}px)`;

    this.line.visible = false;
    if (!pointer || !craft) return;
    const [dx, dz] = [target.x - craft.x, target.z - craft.z];
    const reach = Math.hypot(dx, dz);
    const perPixel = (2 * camera.position.distanceTo(target) * Math.tan((camera.fov * Math.PI) / 360)) / innerHeight;
    const length = reach - NOSE - GAP_PX * perPixel;
    if (length < 0.6) return;
    const [ux, uz] = [dx / reach, dz / reach];
    this.nose.set(craft.x + ux * NOSE, GUN_HEIGHT, craft.z + uz * NOSE);
    this.line.position.copy(this.nose);
    this.line.rotation.set(0, -Math.atan2(uz, ux), 0);
    this.line.scale.set(length, 1, 1);
    this.line.material.color.copy(this.colours[view.violet ? 1 : 0]);
    this.line.visible = true;
  }
}
