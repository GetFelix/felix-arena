// The rail waiting on the centre crystal: a column of light and a turning ring on the plinth, which fade in when a
// rail appears and out when someone takes it.
import {
  AdditiveBlending,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  type PointLight,
  RingGeometry,
  Sprite,
  SpriteMaterial,
  type Texture,
} from 'three';
import { hdr } from './materials';
import { palette } from './palette';

/** Seconds to fade in or out. */
const FADE_S = 0.4;

export class Pickup {
  private readonly column: Sprite;
  private readonly ring: Mesh<RingGeometry, MeshBasicMaterial>;
  private level = 0;

  constructor(
    fx: Object3D,
    glow: Texture,
    private readonly light: PointLight,
  ) {
    const additive = { transparent: true, blending: AdditiveBlending, depthWrite: false } as const;
    this.column = new Sprite(new SpriteMaterial({ map: glow, color: hdr(palette.accentGlow, 1.6), ...additive }));
    this.column.scale.set(1.6, 9, 1);
    this.column.position.set(0, 4, 0);
    this.ring = new Mesh(
      new RingGeometry(2.25, 2.45, 64),
      new MeshBasicMaterial({ color: hdr(palette.accentGlow, 3), ...additive }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.37;
    fx.add(this.column, this.ring);
  }

  /** Shows the rail as there or not at time `t`, `dt` seconds after the last frame. */
  update(there: boolean, t: number, dt: number): void {
    this.level = Math.min(1, Math.max(0, this.level + (there ? dt : -dt) / FADE_S));
    const pulse = 0.85 + Math.sin(t * 4) * 0.15;
    this.column.visible = this.ring.visible = this.level > 0;
    this.column.material.opacity = this.level * pulse;
    this.ring.material.opacity = this.level * pulse;
    this.ring.scale.setScalar(1 + Math.sin(t * 2) * 0.02);
    this.light.intensity = 9 + Math.sin(t * 1.7) * 1.5 + this.level * 10 * pulse;
  }
}
