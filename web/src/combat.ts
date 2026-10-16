import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  RingGeometry,
  Sprite,
  SpriteMaterial,
  type Texture,
  Vector3,
} from 'three';
import { type Craft, type CraftName, TARGETS } from './crafts';
import { hdr, materials } from './materials';
import { palette } from './palette';

// The style frame's scripted fight: each shooter fires two bolts at a fixed beat in a loop, and each hit throws
// sparks, a ground ring, a flash and some debris. The sim's bolts and hits replace the script later.

/** The textures combat effects are drawn with. */
export interface CombatTextures {
  glow: Texture;
  flare: Texture;
}

const LOOP = 2.4;
const SPEED = 30;
const SHOTS: { from: CraftName; at: number }[] = [
  { from: 'rook', at: 0.0 },
  { from: 'mara', at: 0.75 },
  { from: 'ash', at: 1.35 },
  { from: 'vex', at: 1.95 },
];

const additive = { transparent: true, blending: AdditiveBlending, depthWrite: false } as const;

/** A bolt: a bright core and a trailing glow, hidden until placed. */
export function bolt(fx: Object3D, tex: CombatTextures, color: string): Group {
  const g = new Group();
  const core = new Mesh(new CapsuleGeometry(0.09, 0.9, 4, 8), new MeshBasicMaterial({ color: hdr(color, 6) }));
  core.rotation.z = Math.PI / 2;
  const halo = new Mesh(
    new PlaneGeometry(3.2, 0.7),
    new MeshBasicMaterial({ map: tex.glow, color: hdr(color, 1.4), ...additive }),
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.x = -0.9;
  g.add(core, halo);
  g.visible = false;
  fx.add(g);
  return g;
}

export function flash(fx: Object3D, tex: CombatTextures, color: string, size: number): Sprite {
  const s = new Sprite(new SpriteMaterial({ map: tex.flare, color: hdr(color, 4), ...additive }));
  s.scale.setScalar(size);
  s.visible = false;
  fx.add(s);
  return s;
}

interface Debris {
  m: Mesh;
  v: Vector3;
  spin: Vector3;
}

export interface Burst {
  sparks: Points<BufferGeometry, PointsMaterial>;
  ring: Mesh<RingGeometry, MeshBasicMaterial>;
  debris: Debris[];
  vel: Vector3[];
  f: Sprite;
}

/** The effects of one hit: sparks, a ground ring, debris and a flash. */
export function burst(scene: Object3D, fx: Object3D, tex: CombatTextures, color: string, random: () => number): Burst {
  const n = 70;
  const pos = new Float32Array(n * 3);
  const vel: Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const a = random() * Math.PI * 2;
    const u = random();
    vel.push(new Vector3(Math.cos(a) * (2 + u * 7), 2 + random() * 6, Math.sin(a) * (2 + u * 7)));
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  const sparks = new Points(geo, new PointsMaterial({ map: tex.glow, color: hdr(color, 5), size: 0.32, ...additive }));
  const ring = new Mesh(
    new RingGeometry(0.8, 1.0, 48),
    new MeshBasicMaterial({ color: hdr(color, 3), ...additive, side: DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  const debris: Debris[] = [];
  for (let i = 0; i < 7; i++) {
    const m = new Mesh(new BoxGeometry(0.22, 0.08, 0.16), materials.hullDark);
    m.castShadow = true;
    const a = random() * Math.PI * 2;
    const v = new Vector3(Math.cos(a) * (2 + random() * 3), 4 + random() * 3, Math.sin(a) * (2 + random() * 3));
    const spin = new Vector3(random() * 9, random() * 9, random() * 9);
    debris.push({ m, v, spin });
    // Debris lives outside the effects group so ambient occlusion still sees it.
    scene.add(m);
  }
  const f = flash(fx, tex, color, 4.5);
  fx.add(sparks, ring);
  return { sparks, ring, debris, vel, f };
}

interface Shooter {
  from: CraftName;
  at: number;
  bolts: Group[];
  muzzle: Sprite;
  hit: Burst;
  light: PointLight;
}

/** The scripted fight between the crafts, driven by {@link Combat.update}. */
export class Combat {
  private readonly shooters: Shooter[];
  private readonly nose = new Vector3();
  private readonly end = new Vector3();

  /** `random` sets the sparks and debris, drawn shooter by shooter in {@link SHOTS} order. */
  constructor(
    scene: Object3D,
    fx: Object3D,
    tex: CombatTextures,
    private readonly crafts: Record<CraftName, Craft>,
    random: () => number,
  ) {
    const lights = [0, 1, 2].map(() => {
      const l = new PointLight(palette.white, 0, 9, 2);
      scene.add(l);
      return l;
    });
    this.shooters = SHOTS.map((s, i) => {
      const color = crafts[s.from].color;
      return {
        ...s,
        bolts: [bolt(fx, tex, color), bolt(fx, tex, color)],
        muzzle: flash(fx, tex, color, 2.2),
        hit: burst(scene, fx, tex, color, random),
        light: lights[i % lights.length]!,
      };
    });
  }

  /** Shows every effect as it is at time `t`. Call after the crafts have moved to `t`. */
  update(t: number): void {
    const { nose: tmp, end } = this;
    for (const s of this.shooters) {
      const p = this.crafts[s.from];
      const q = this.crafts[TARGETS[s.from]];
      const local = (((t - s.at) % LOOP) + LOOP) % LOOP;
      tmp.set(Math.sin(p.aim) * 1.3, 0.55, Math.cos(p.aim) * 1.3).add(p.g.position);
      end.copy(q.g.position).setY(q.g.position.y + 0.45);
      const flight = tmp.distanceTo(end) / SPEED;
      let flashLevel = 0;
      s.bolts.forEach((b, i) => {
        const u = (local - i * 0.12) / flight;
        b.visible = u >= 0 && u < 1;
        if (b.visible) {
          b.position.lerpVectors(tmp, end, u);
          b.rotation.y = p.aim - Math.PI / 2;
        }
        const since = local - i * 0.12;
        if (since >= 0 && since < 0.07) flashLevel = Math.max(flashLevel, 1 - since / 0.07);
      });
      s.muzzle.visible = flashLevel > 0;
      s.muzzle.position.copy(tmp);
      s.muzzle.material.opacity = flashLevel;
      s.muzzle.material.rotation = local * 40;

      const h = local - flight;
      const fx = s.hit;
      const live = h >= 0 && h < 0.9;
      fx.sparks.visible = fx.ring.visible = live;
      fx.f.visible = live && h < 0.12;
      let lightLevel = flashLevel * 14;
      if (live) {
        const position = fx.sparks.geometry.attributes.position as BufferAttribute;
        const arr = position.array as Float32Array;
        fx.vel.forEach((v, i) => {
          arr[i * 3] = end.x + v.x * h;
          arr[i * 3 + 1] = Math.max(0.05, end.y + v.y * h - 9 * h * h);
          arr[i * 3 + 2] = end.z + v.z * h;
        });
        position.needsUpdate = true;
        fx.sparks.material.opacity = Math.max(0, 1 - h / 0.9);
        fx.ring.position.set(end.x, 0.06, end.z);
        fx.ring.scale.setScalar(0.3 + h * 3.2);
        fx.ring.material.opacity = Math.max(0, 1 - h / 0.5);
        fx.f.position.copy(end);
        fx.f.material.opacity = 1 - h / 0.12;
        lightLevel = Math.max(lightLevel, 22 * Math.max(0, 1 - h / 0.25));
      }
      for (const d of fx.debris) {
        d.m.visible = live;
        if (!live) continue;
        d.m.position.set(end.x + d.v.x * h, Math.max(0.05, end.y + d.v.y * h - 12 * h * h), end.z + d.v.z * h);
        d.m.rotation.set(d.spin.x * h, d.spin.y * h, d.spin.z * h);
      }
      s.light.color.set(p.color);
      s.light.intensity = lightLevel;
      s.light.position.copy(live && h < 0.25 ? end : tmp);
    }
  }
}
