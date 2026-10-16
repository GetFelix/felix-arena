// Muzzle flashes and hits in a live match, from fixed pools so nothing is allocated while playing. Each looks the way
// the style frame's scripted fight draws it.
import {
  AdditiveBlending,
  type BufferAttribute,
  CylinderGeometry,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
  PointLight,
  type Sprite,
  Vector3,
} from 'three';
import { type Burst, burst, type CombatTextures, flash } from './combat';
import { hdr } from './materials';
import { palette } from './palette';

/** How many of each effect a team can show at once. */
const FLASHES = 6;
const BURSTS = 6;
const FLASH_S = 0.07;
const BURST_S = 0.9;
const BEAMS = 3;
const BEAM_S = 0.45;
const BLASTS = 3;
const BLAST_S = 0.5;
/** Beams fly at muzzle height. */
const BEAM_Y = 0.6;

interface Shown<T> {
  item: T;
  at: number;
  where: Vector3;
}

interface Beam {
  core: Mesh<CylinderGeometry, MeshBasicMaterial>;
  glow: Mesh<PlaneGeometry, MeshBasicMaterial>;
  end: Sprite;
  from: Vector3;
}

interface Team {
  flashes: Shown<Sprite>[];
  bursts: Shown<Burst>[];
  beams: Shown<Beam>[];
  /** A destroyed craft: a large flash over a burst. */
  blasts: Shown<{ flash: Sprite; burst: Burst }>[];
}

/** The effects of a match. Times are in seconds on the page's clock. */
export class Effects {
  private readonly teams: [Team, Team];
  private readonly lights: PointLight[];

  constructor(scene: Object3D, fx: Object3D, tex: CombatTextures, random: () => number) {
    const team = (colour: string): Team => ({
      flashes: Array.from({ length: FLASHES }, () => ({
        item: flash(fx, tex, colour, 2.2),
        at: -Infinity,
        where: new Vector3(),
      })),
      bursts: Array.from({ length: BURSTS }, () => ({
        item: burst(scene, fx, tex, colour, random),
        at: -Infinity,
        where: new Vector3(),
      })),
      beams: Array.from({ length: BEAMS }, () => ({
        item: beam(fx, tex, colour),
        at: -Infinity,
        where: new Vector3(),
      })),
      blasts: Array.from({ length: BLASTS }, () => ({
        item: { flash: flash(fx, tex, colour, 9), burst: burst(scene, fx, tex, colour, random) },
        at: -Infinity,
        where: new Vector3(),
      })),
    });
    this.teams = [team(palette.coral), team(palette.violet)];
    this.lights = [0, 1, 2].map(() => {
      const light = new PointLight(palette.white, 0, 9, 2);
      scene.add(light);
      return light;
    });
    for (const t of this.teams) {
      for (const b of t.bursts) this.hideBurst(b.item);
      for (const b of t.blasts) this.hideBurst(b.item.burst);
    }
  }

  /** A rail beam of `violet`'s team from `(x0, z0)` to `(x1, z1)` in centimetres, at time `t`. */
  railed(violet: boolean, x0: number, z0: number, x1: number, z1: number, t: number): void {
    const slot = oldest(this.teams[violet ? 1 : 0].beams);
    slot.at = t;
    slot.item.from.set(x0 / 100, BEAM_Y, z0 / 100);
    slot.where.set(x1 / 100, BEAM_Y, z1 / 100);
  }

  /** A craft of `violet`'s team destroyed at `(x, z)` in centimetres, at time `t`. */
  destroyed(violet: boolean, x: number, z: number, t: number): void {
    const slot = oldest(this.teams[violet ? 1 : 0].blasts);
    slot.at = t;
    slot.where.set(x / 100, 0.7, z / 100);
  }

  /** A muzzle flash at `(x, z)` in centimetres, at time `t`. */
  fired(violet: boolean, x: number, z: number, t: number): void {
    const slot = oldest(this.teams[violet ? 1 : 0].flashes);
    slot.at = t;
    slot.where.set(x / 100, 0.6, z / 100);
  }

  /** A hit on whatever is at `(x, z)` in centimetres, by a shot of `violet`'s team, at time `t`. */
  hit(violet: boolean, x: number, z: number, t: number): void {
    const slot = oldest(this.teams[violet ? 1 : 0].bursts);
    slot.at = t;
    slot.where.set(x / 100, 0.87, z / 100);
  }

  /** Shows every effect as it is at time `t`. */
  update(t: number): void {
    const glows: { level: number; where: Vector3; colour: string }[] = [];
    this.teams.forEach((team, side) => {
      const colour = side ? palette.violet : palette.coral;
      for (const f of team.flashes) {
        const since = t - f.at;
        const level = since >= 0 && since < FLASH_S ? 1 - since / FLASH_S : 0;
        f.item.visible = level > 0;
        if (!f.item.visible) continue;
        f.item.position.copy(f.where);
        f.item.material.opacity = level;
        f.item.material.rotation = since * 40;
        glows.push({ level: level * 14, where: f.where, colour });
      }
      for (const b of team.bursts) {
        const h = t - b.at;
        if (h < 0 || h >= BURST_S) {
          this.hideBurst(b.item);
          continue;
        }
        showBurst(b.item, b.where, h);
        if (h < 0.25) glows.push({ level: 22 * (1 - h / 0.25), where: b.where, colour });
      }
      for (const b of team.beams) {
        const h = t - b.at;
        const { core, glow, end, from } = b.item;
        const live = h >= 0 && h < BEAM_S;
        core.visible = glow.visible = end.visible = live;
        if (!live) continue;
        const fade = 1 - h / BEAM_S;
        const length = Math.max(0.01, from.distanceTo(b.where));
        const angle = Math.atan2(b.where.z - from.z, b.where.x - from.x);
        for (const mesh of [core, glow]) {
          mesh.position.copy(from).lerp(b.where, 0.5);
          mesh.rotation.set(0, -angle, 0);
          mesh.scale.set(length, 1, 1);
        }
        core.scale.set(length, 1 + h * 2, 1 + h * 2);
        core.material.opacity = fade;
        glow.material.opacity = fade * fade;
        end.position.copy(b.where);
        end.material.opacity = fade;
        glows.push({ level: 26 * fade, where: b.where, colour });
      }
      for (const b of team.blasts) {
        const h = t - b.at;
        if (h < 0 || h >= BURST_S) {
          this.hideBurst(b.item.burst);
          b.item.flash.visible = false;
          continue;
        }
        showBurst(b.item.burst, b.where, h);
        b.item.flash.visible = h < BLAST_S;
        b.item.flash.position.copy(b.where);
        b.item.flash.material.opacity = Math.max(0, 1 - h / BLAST_S);
        b.item.flash.scale.setScalar(6 + h * 10);
        if (h < 0.4) glows.push({ level: 40 * (1 - h / 0.4), where: b.where, colour });
      }
    });
    glows.sort((a, b) => b.level - a.level);
    this.lights.forEach((light, i) => {
      const glow = glows[i];
      light.intensity = glow?.level ?? 0;
      if (!glow) return;
      light.color.set(glow.colour);
      light.position.copy(glow.where);
    });
  }

  private hideBurst(b: Burst): void {
    b.sparks.visible = b.ring.visible = b.f.visible = false;
    for (const d of b.debris) d.m.visible = false;
  }
}

/** A rail beam along +x, one unit long, scaled to its length when shown. */
function beam(fx: Object3D, tex: CombatTextures, colour: string): Beam {
  const additive = { transparent: true, blending: AdditiveBlending, depthWrite: false } as const;
  const core = new Mesh(
    new CylinderGeometry(0.045, 0.045, 1, 8, 1, true).rotateZ(Math.PI / 2),
    new MeshBasicMaterial({ color: hdr(colour, 7), ...additive }),
  );
  const glow = new Mesh(
    new PlaneGeometry(1, 1.1).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({ map: tex.glow, color: hdr(colour, 1.8), ...additive }),
  );
  const end = flash(fx, tex, colour, 3.2);
  core.visible = glow.visible = false;
  fx.add(core, glow);
  return { core, glow, end, from: new Vector3() };
}

function oldest<T>(shown: Shown<T>[]): Shown<T> {
  return shown.reduce((a, b) => (b.at < a.at ? b : a));
}

/** The style frame's hit, `h` seconds in. */
function showBurst(fx: Burst, end: Vector3, h: number): void {
  fx.sparks.visible = fx.ring.visible = true;
  fx.f.visible = h < 0.12;
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
  for (const d of fx.debris) {
    d.m.visible = true;
    d.m.position.set(end.x + d.v.x * h, Math.max(0.05, end.y + d.v.y * h - 12 * h * h), end.z + d.v.z * h);
    d.m.rotation.set(d.spin.x * h, d.spin.y * h, d.spin.z * h);
  }
}
