// The effects kit: bolts, flares, hits, rail beams and three point lights, from pools made once, so drawing a frame
// allocates nothing. The style frame's scripted fight and the live match both draw through it.
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  RingGeometry,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  type Texture,
  Vector3,
  Vector4,
} from 'three';
import { type Bolt, Bolts, MAX_BOLTS } from './bolts';
import { GUN_HEIGHT } from './fleet';
import { hdr, materials } from './materials';
import { palette } from './palette';

/** The textures effects are drawn with. */
export interface EffectTextures {
  glow: Texture;
  flare: Texture;
}

/** Flares (muzzle flashes and the flash of a destroyed craft) shown at once. */
export const FLARES = 24;
/** Hits shown at once. Each slot's sparks and debris fly their own way, drawn once from `random`. */
export const BURSTS = 16;
/** Rail beams shown at once. */
export const BEAMS = 6;
/** Point lights. Their number never changes, because a change in light count recompiles every lit shader. */
export const LIGHTS = 3;

/** How long a hit lasts, in seconds. */
export const BURST_S = 0.9;

const additive = { transparent: true, blending: AdditiveBlending, depthWrite: false } as const;

/** Each team's colours, made once so a frame copies them instead of parsing a palette string. */
interface Tint {
  light: Color;
  flare: Color;
  sparks: Color;
  ring: Color;
  beam: Color;
  beamGlow: Color;
}

function tint(colour: string): Tint {
  return {
    light: new Color(colour),
    flare: hdr(colour, 4),
    sparks: hdr(colour, 5),
    ring: hdr(colour, 3),
    beam: hdr(colour, 7),
    beamGlow: hdr(colour, 1.8),
  };
}

function flareSprite(fx: Object3D, tex: EffectTextures, size: number): Sprite {
  const s = new Sprite(new SpriteMaterial({ map: tex.flare, ...additive }));
  s.scale.setScalar(size);
  s.visible = false;
  fx.add(s);
  return s;
}

/** A point light's setting: its intensity, team colour and place. */
export interface Glow {
  level: number;
  violet: boolean;
  where: Vector3;
}

/** Pieces of debris a hit throws. */
const DEBRIS = 7;

interface Debris {
  v: Vector3;
  spin: Vector3;
}

interface Burst {
  sparks: Points<BufferGeometry, PointsMaterial>;
  ring: Mesh<RingGeometry, MeshBasicMaterial>;
  debris: Debris[];
  vel: Vector3[];
  flash: Sprite;
  /** Whether this frame shows it, and as what: drawn at the frame's end, so showing it allocates nothing. */
  shown: boolean;
  violet: boolean;
  where: Vector3;
  h: number;
}

/** One hit's sparks, ground ring, debris and flash. */
function burst(fx: Object3D, tex: EffectTextures, random: () => number): Burst {
  const n = 70;
  const vel: Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const a = random() * Math.PI * 2;
    const u = random();
    vel.push(new Vector3(Math.cos(a) * (2 + u * 7), 2 + random() * 6, Math.sin(a) * (2 + u * 7)));
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3));
  const sparks = new Points(geo, new PointsMaterial({ map: tex.glow, size: 0.32, ...additive }));
  // The sparks move every frame, so a bounding sphere computed once would cull them in the wrong places.
  sparks.frustumCulled = false;
  const ring = new Mesh(new RingGeometry(0.8, 1.0, 48), new MeshBasicMaterial({ ...additive, side: DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  const debris: Debris[] = [];
  for (let i = 0; i < DEBRIS; i++) {
    const a = random() * Math.PI * 2;
    const v = new Vector3(Math.cos(a) * (2 + random() * 3), 4 + random() * 3, Math.sin(a) * (2 + random() * 3));
    const spin = new Vector3(random() * 9, random() * 9, random() * 9);
    debris.push({ v, spin });
  }
  const flash = flareSprite(fx, tex, 4.5);
  sparks.visible = ring.visible = false;
  fx.add(sparks, ring);
  return { sparks, ring, debris, vel, flash, shown: false, violet: false, where: new Vector3(), h: 0 };
}

interface Beam {
  core: Mesh<CylinderGeometry, MeshBasicMaterial>;
  glow: Mesh<PlaneGeometry, MeshBasicMaterial>;
  end: Sprite;
  violet: boolean;
  from: Vector3;
  to: Vector3;
  h: number;
  fade: number;
}

/** A rail beam along +x, one unit long, scaled to its length when shown. */
function beam(fx: Object3D, tex: EffectTextures): Beam {
  const core = new Mesh(
    new CylinderGeometry(0.045, 0.045, 1, 8, 1, true).rotateZ(Math.PI / 2),
    new MeshBasicMaterial(additive),
  );
  const glow = new Mesh(
    new PlaneGeometry(1, 1.1).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({ map: tex.glow, ...additive }),
  );
  core.visible = glow.visible = false;
  core.matrixAutoUpdate = glow.matrixAutoUpdate = false;
  fx.add(core, glow);
  return {
    core,
    glow,
    end: flareSprite(fx, tex, 2.2),
    violet: false,
    from: new Vector3(),
    to: new Vector3(),
    h: 0,
    fade: 0,
  };
}

function hideBurst(b: Burst): void {
  b.sparks.visible = b.ring.visible = b.flash.visible = false;
}

/** Draws a hit, its debris as instances `first` onward of `debris`. */
function drawBurst(b: Burst, tint: Tint, debris: Float32Array, first: number): void {
  const { where, h } = b;
  b.sparks.visible = b.ring.visible = true;
  b.flash.visible = h < 0.12;
  const position = b.sparks.geometry.attributes.position as BufferAttribute;
  const arr = position.array as Float32Array;
  for (let i = 0; i < b.vel.length; i++) {
    const v = b.vel[i]!;
    arr[i * 3] = where.x + v.x * h;
    arr[i * 3 + 1] = Math.max(0.05, where.y + v.y * h - 9 * h * h);
    arr[i * 3 + 2] = where.z + v.z * h;
  }
  position.needsUpdate = true;
  b.sparks.material.color.copy(tint.sparks);
  b.sparks.material.opacity = Math.max(0, 1 - h / BURST_S);
  // Fields rather than set() and setScalar(): a float passed to a call that is not inlined is boxed.
  b.ring.position.x = where.x;
  b.ring.position.y = 0.06;
  b.ring.position.z = where.z;
  b.ring.scale.x = b.ring.scale.y = b.ring.scale.z = 0.3 + h * 3.2;
  b.ring.material.color.copy(tint.ring);
  b.ring.material.opacity = Math.max(0, 1 - h / 0.5);
  b.flash.position.copy(where);
  b.flash.material.color.copy(tint.flare);
  b.flash.material.opacity = 1 - h / 0.12;
  for (let i = 0; i < DEBRIS; i++) {
    const { v, spin } = b.debris[i]!;
    // Turned by the Euler angles `spin * h` in XYZ order, as Matrix4.makeRotationFromEuler would, then placed.
    const a = Math.cos(spin.x * h);
    const s1 = Math.sin(spin.x * h);
    const c = Math.cos(spin.y * h);
    const d = Math.sin(spin.y * h);
    const e = Math.cos(spin.z * h);
    const f = Math.sin(spin.z * h);
    const ae = a * e;
    const af = a * f;
    const be = s1 * e;
    const bf = s1 * f;
    const o = (first + i) * 16;
    debris[o] = c * e;
    debris[o + 1] = af + be * d;
    debris[o + 2] = bf - ae * d;
    debris[o + 3] = 0;
    debris[o + 4] = -c * f;
    debris[o + 5] = ae - bf * d;
    debris[o + 6] = be + af * d;
    debris[o + 7] = 0;
    debris[o + 8] = d;
    debris[o + 9] = -s1 * c;
    debris[o + 10] = a * c;
    debris[o + 11] = 0;
    debris[o + 12] = where.x + v.x * h;
    debris[o + 13] = Math.max(0.05, where.y + v.y * h - 12 * h * h);
    debris[o + 14] = where.z + v.z * h;
    debris[o + 15] = 1;
  }
}

function drawFlare(s: Sprite, f: Flare, tint: Tint): void {
  s.position.copy(f.where);
  s.scale.x = s.scale.y = s.scale.z = f.size;
  s.material.color.copy(tint.flare);
  s.material.opacity = f.opacity;
  s.material.rotation = f.rotation;
}

function drawBeam(b: Beam, tint: Tint): void {
  const { core, glow, end, from, to, h, fade } = b;
  core.visible = glow.visible = end.visible = true;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.max(0.01, Math.sqrt(dx * dx + (to.y - from.y) ** 2 + dz * dz));
  // Turned about y to point from `from` to `to`, stretched to the length, written straight into each matrix: setting
  // rotation and scale through their methods would box the floats.
  const flat = Math.sqrt(dx * dx + dz * dz);
  const cos = flat > 0 ? dx / flat : 1;
  const sin = flat > 0 ? dz / flat : 0;
  const thick = 1 + h * 2;
  for (let i = 0; i < 2; i++) {
    const m = (i === 0 ? core : glow).matrix.elements;
    const sy = i === 0 ? thick : 1;
    const sz = i === 0 ? thick : 1;
    m[0] = cos * length;
    m[1] = 0;
    m[2] = sin * length;
    m[3] = 0;
    m[4] = 0;
    m[5] = sy;
    m[6] = 0;
    m[7] = 0;
    m[8] = -sin * sz;
    m[9] = 0;
    m[10] = cos * sz;
    m[11] = 0;
    m[12] = (from.x + to.x) / 2;
    m[13] = (from.y + to.y) / 2;
    m[14] = (from.z + to.z) / 2;
    m[15] = 1;
  }
  core.matrixWorldNeedsUpdate = glow.matrixWorldNeedsUpdate = true;
  core.material.color.copy(tint.beam);
  core.material.opacity = fade;
  glow.material.color.copy(tint.beamGlow);
  glow.material.opacity = fade * fade;
  end.position.copy(to);
  end.material.color.copy(tint.flare);
  end.material.opacity = fade * 0.8;
}

/** A flare to show this frame: a four-point star `size` metres across. */
export interface Flare {
  violet: boolean;
  where: Vector3;
  size: number;
  opacity: number;
  rotation: number;
}

/** A hit to show this frame, `h` seconds into its {@link BURST_S}. */
export interface Hit {
  violet: boolean;
  where: Vector3;
  h: number;
}

/** A rail beam to show this frame, `h` seconds in and at `fade` of full brightness. */
export interface Rail {
  violet: boolean;
  from: Vector3;
  to: Vector3;
  h: number;
  fade: number;
}

/**
 * The pools every effect is drawn from. A frame is what is asked for between two {@link EffectsKit.end}s, and `end`
 * draws it and hides the rest. Each request returns a record for the caller to fill in, rather than taking the
 * numbers as arguments: a float passed to a call the compiler did not inline is boxed, which allocates. Nothing here
 * allocates after construction.
 */
export class EffectsKit {
  /** What each of the {@link LIGHTS} point lights shows. A light keeps its setting until it is set again. */
  readonly glows: Glow[] = Array.from({ length: LIGHTS }, () => ({ level: 0, violet: false, where: new Vector3() }));
  private readonly tints: [Tint, Tint];
  private readonly lights: PointLight[];
  private readonly bolts: Bolts;
  private readonly flareSprites: Sprite[];
  private readonly flares: Flare[];
  private readonly bursts: Burst[];
  /** Every hit's debris, one draw call for all of them. */
  private readonly debris: InstancedMesh;
  private readonly beams: Beam[];
  /** Filled in and never drawn when a frame asks for more flares or beams than there are. */
  private readonly spareFlare: Flare;
  private readonly spareRail: Rail;
  private flareCount = 0;
  private beamCount = 0;

  /** `random` sets each hit slot's sparks and debris, drawn slot by slot from slot 0. */
  constructor(scene: Object3D, fx: Object3D, tex: EffectTextures, random: () => number) {
    this.tints = [tint(palette.coral), tint(palette.violet)];
    this.lights = [];
    for (let i = 0; i < LIGHTS; i++) {
      const light = new PointLight(palette.white, 0, 9, 2);
      scene.add(light);
      this.lights.push(light);
    }
    this.bolts = new Bolts(fx, tex.glow);
    this.bursts = Array.from({ length: BURSTS }, () => burst(fx, tex, random));
    this.debris = new InstancedMesh(new BoxGeometry(0.22, 0.08, 0.16), materials.hullDark, BURSTS * DEBRIS);
    this.debris.castShadow = true;
    this.debris.frustumCulled = false;
    this.debris.count = 0;
    // Debris lives outside the effects group so ambient occlusion still sees it.
    scene.add(this.debris);
    this.flareSprites = Array.from({ length: FLARES }, () => flareSprite(fx, tex, 2.2));
    const flare = (): Flare => ({ violet: false, where: new Vector3(), size: 0, opacity: 0, rotation: 0 });
    this.flares = Array.from({ length: FLARES }, flare);
    this.spareFlare = flare();
    this.beams = Array.from({ length: BEAMS }, () => beam(fx, tex));
    this.spareRail = { violet: false, from: new Vector3(), to: new Vector3(), h: 0, fade: 0 };
  }

  /** A bolt of `violet`'s team for this frame. Bolts past {@link MAX_BOLTS} for a team are not drawn. */
  bolt(violet: boolean): Bolt {
    return this.bolts.add(violet);
  }

  /** A flare for this frame. Flares past {@link FLARES} in a frame are not drawn. */
  flare(): Flare {
    return this.flares[this.flareCount++] ?? this.spareFlare;
  }

  /** Hit slot `slot` for this frame. */
  hit(slot: number): Hit {
    const b = this.bursts[slot]!;
    b.shown = true;
    return b;
  }

  /** A rail beam for this frame. Beams past {@link BEAMS} in a frame are not drawn. */
  rail(): Rail {
    return this.beams[this.beamCount++] ?? this.spareRail;
  }

  /** Draws the frame: every effect asked for since the last `end`, and none of the rest. */
  end(): void {
    this.bolts.commit();
    for (let i = 0; i < LIGHTS; i++) {
      const light = this.lights[i]!;
      const glow = this.glows[i]!;
      light.color.copy(this.tints[glow.violet ? 1 : 0].light);
      light.intensity = glow.level;
      light.position.copy(glow.where);
    }
    for (let i = 0; i < FLARES; i++) {
      const s = this.flareSprites[i]!;
      s.visible = i < this.flareCount;
      if (s.visible) drawFlare(s, this.flares[i]!, this.tints[this.flares[i]!.violet ? 1 : 0]);
    }
    for (let i = 0; i < BEAMS; i++) {
      const b = this.beams[i]!;
      if (i < this.beamCount) drawBeam(b, this.tints[b.violet ? 1 : 0]);
      else b.core.visible = b.glow.visible = b.end.visible = false;
    }
    const debris = this.debris.instanceMatrix.array as Float32Array;
    let pieces = 0;
    for (let i = 0; i < BURSTS; i++) {
      const b = this.bursts[i]!;
      if (b.shown) {
        drawBurst(b, this.tints[b.violet ? 1 : 0], debris, pieces);
        pieces += DEBRIS;
      } else hideBurst(b);
      b.shown = false;
    }
    this.debris.count = pieces;
    this.debris.instanceMatrix.needsUpdate = true;
    this.flareCount = this.beamCount = 0;
  }
}

/** Spawn shields: one a craft, by slot. */
export const SHIELDS = 8;
/** How long a shield takes to rise around a respawned craft, in seconds. */
const SHIELD_IN_S = 0.15;
/** Sim ticks over which a shield fades as the protection runs out: the last 0.4 s. */
const SHIELD_FADE_TICKS = 12;
/** How long a shield takes to collapse when firing ends the protection early, in seconds. */
const SHIELD_COLLAPSE_S = 0.18;
/** How long the ripple from an absorbed shot runs, in seconds. */
const SHIELD_HIT_S = 0.6;

/** A spawn shield: a bubble around the craft, clear in the middle and bright at its silhouette. */
interface Shield {
  bubble: Mesh<SphereGeometry, MeshBasicMaterial>;
  time: { value: number };
  /** The last absorbed shot: its direction from the centre in xyz, and seconds since it in w. */
  hit: { value: Vector4 };
  /** Asked for this frame, held since `since`, or let go at `gone`. */
  asked: boolean;
  held: boolean;
  since: number;
  gone: number;
  violet: boolean;
  where: Vector3;
  /** Sim ticks of protection left. */
  left: number;
  /** How far the end-of-protection fade had got when the shield was let go: near 1 means firing ended it. */
  fade: number;
  /** Where the last absorbed shot came from, in metres, and when. */
  from: Vector3;
  hitAt: number;
}

const SHIELD_VERTEX = `
vShieldNormal = normalize( normalMatrix * normal );
vShieldView = -mvPosition.xyz;
vShieldAt = position;`;

/**
 * A fresnel rim, nearly nothing where the bubble faces the camera so the craft inside stays clear, with a faint sheen
 * sliding over it. An absorbed shot flashes where it struck and sends a ring across the bubble from there.
 */
const SHIELD_ALPHA = `
float facing = abs( dot( normalize( vShieldNormal ), normalize( vShieldView ) ) );
float edge = 1.0 - facing;
float rim = pow( edge, 5.0 ) + 0.08 * pow( edge, 2.0 );
float sheen = 0.5 + 0.5 * sin( dot( vShieldAt, vec3( 1.5, 4.0, 1.0 ) ) * 2.5 - uShieldTime * 2.0 );
float struck = 0.0;
if ( uShieldHit.w < ${SHIELD_HIT_S.toFixed(2)} ) {
  float angle = acos( clamp( dot( normalize( vShieldAt ), uShieldHit.xyz ), -1.0, 1.0 ) );
  float fade = 1.0 - uShieldHit.w / ${SHIELD_HIT_S.toFixed(2)};
  float ring = exp( -pow( ( angle - uShieldHit.w * 4.0 ) * 6.0, 2.0 ) );
  float spot = exp( -angle * 2.5 ) * max( 0.0, 1.0 - uShieldHit.w * 4.0 );
  struck = ( ring + spot ) * fade;
}
diffuseColor.a *= rim * ( 0.85 + 0.15 * sheen ) + struck;
outgoingLight *= 1.0 + struck * 4.0;
#include <opaque_fragment>`;

function shield(fx: Object3D, geometry: SphereGeometry): Shield {
  const time = { value: 0 };
  const hit = { value: new Vector4(0, 0, 1, SHIELD_HIT_S) };
  const material = new MeshBasicMaterial(additive);
  const varyings = 'varying vec3 vShieldNormal;\nvarying vec3 vShieldView;\nvarying vec3 vShieldAt;\n';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uShieldTime = time;
    shader.uniforms.uShieldHit = hit;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `${varyings}void main() {`)
      .replace('#include <project_vertex>', `#include <project_vertex>${SHIELD_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `uniform float uShieldTime;\nuniform vec4 uShieldHit;\n${varyings}void main() {`)
      .replace('#include <opaque_fragment>', SHIELD_ALPHA);
  };
  const bubble = new Mesh(geometry, material);
  bubble.visible = false;
  fx.add(bubble);
  return {
    bubble,
    time,
    hit,
    asked: false,
    held: false,
    since: -Infinity,
    gone: -Infinity,
    violet: false,
    where: new Vector3(),
    left: 0,
    fade: 0,
    from: new Vector3(),
    hitAt: -Infinity,
  };
}

/** How long each live effect lasts, in seconds. */
const FLASH_S = 0.07;
const BEAM_S = 0.45;
const BLAST_S = 0.5;
/** Live effects remembered at once; the oldest is reused when they run out. */
const FIRED = 12;
const HITS = 10;
const BLASTS = BURSTS - HITS;

/** A live effect: when it started, where, for which team, and how brightly it lights the scene this frame. */
interface Shown {
  at: number;
  violet: boolean;
  where: Vector3;
  /** Where a beam started. */
  from: Vector3;
  glow: number;
}

function shown(n: number): Shown[] {
  return Array.from({ length: n }, () => ({
    at: -Infinity,
    violet: false,
    where: new Vector3(),
    from: new Vector3(),
    glow: 0,
  }));
}

/** Starts the oldest effect of `list` over, at time `t`. */
function start(list: Shown[], violet: boolean, t: number): Shown {
  let s = list[0]!;
  // Indexed rather than for-of: an iterator is only free when the call is inlined.
  for (let i = 1; i < list.length; i++) if (list[i]!.at < s.at) s = list[i]!;
  s.at = t;
  s.violet = violet;
  return s;
}

/** The effects of a live match, driven by the sim's events. Times are in seconds on the page's clock. */
export class Effects {
  private readonly kit: EffectsKit;
  private readonly fires = shown(FIRED);
  private readonly hits = shown(HITS);
  private readonly beams = shown(BEAMS);
  private readonly blasts = shown(BLASTS);
  private readonly all = [...this.fires, ...this.hits, ...this.beams, ...this.blasts];
  private readonly shields: Shield[];
  private readonly shieldTints: [Color, Color];
  /** The shields are drawn, unseen, in the first frame, so their shader compiles before a respawn needs it. */
  private warm = true;

  constructor(scene: Object3D, fx: Object3D, tex: EffectTextures, random: () => number) {
    this.kit = new EffectsKit(scene, fx, tex, random);
    // Made after the kit, so the style frame, which draws through the kit alone, is unchanged.
    const sphere = new SphereGeometry(1, 32, 16);
    this.shields = Array.from({ length: SHIELDS }, () => shield(fx, sphere));
    // Below the bloom threshold at full strength: only an absorbed shot and the collapse glow.
    this.shieldTints = [hdr(palette.coral, 2.2), hdr(palette.violet, 2.2)];
  }

  /**
   * `slot`'s craft, of `violet`'s team, is under spawn protection at `(x, z)` in centimetres this frame, with `left`
   * sim ticks of it to go unless the craft fires. The fade at the end follows the sim's ticks rather than the page's
   * clock, so it lines up with the protection on a page that draws slowly.
   */
  shield(slot: number, violet: boolean, x: number, z: number, left: number): void {
    const s = this.shields[slot % SHIELDS]!;
    s.asked = true;
    s.left = left;
    s.violet = violet;
    s.where.x = x / 100;
    s.where.z = z / 100;
  }

  /** `slot`'s shield stopped a shot coming from `(x, z)` in centimetres, at time `t`. */
  absorbed(slot: number, x: number, z: number, t: number): void {
    const s = this.shields[slot % SHIELDS]!;
    // Only stored here: the direction is worked out in `update`, which runs hot enough to be compiled, so its
    // arithmetic allocates nothing.
    s.from.x = x / 100;
    s.from.z = z / 100;
    s.hitAt = t;
  }

  /** A bolt at `(x, z)` in centimetres heading `heading` 65536ths of a turn from +x toward +z, for this frame. */
  bolt(violet: boolean, x: number, z: number, heading: number, size = 1): void {
    const b = this.kit.bolt(violet);
    b.x = x / 100;
    b.y = GUN_HEIGHT;
    b.z = z / 100;
    b.yaw = -(heading / 65536) * 2 * Math.PI;
    b.size = size;
  }

  /** A rail beam of `violet`'s team from `(x0, z0)` to `(x1, z1)` in centimetres, at time `t`. */
  railed(violet: boolean, x0: number, z0: number, x1: number, z1: number, t: number): void {
    const s = start(this.beams, violet, t);
    s.where.set(x1 / 100, GUN_HEIGHT, z1 / 100);
    s.from.set(x0 / 100, GUN_HEIGHT, z0 / 100);
  }

  /** A craft of `violet`'s team destroyed at `(x, z)` in centimetres, at time `t`. */
  destroyed(violet: boolean, x: number, z: number, t: number): void {
    start(this.blasts, violet, t).where.set(x / 100, 0.7, z / 100);
  }

  /**
   * The kill cam's victim destroyed at `(x, z)` in centimetres, at time `t`: three blasts close together, so the
   * replay's end reads as an explosion rather than one more hit.
   */
  wrecked(violet: boolean, x: number, z: number, t: number): void {
    this.destroyed(violet, x, z, t);
    start(this.blasts, violet, t + 0.1).where.set(x / 100 + 0.5, 1.0, z / 100 - 0.3);
    start(this.blasts, violet, t + 0.22).where.set(x / 100 - 0.4, 0.5, z / 100 + 0.4);
  }

  /** A muzzle flash at `(x, z)` in centimetres, at time `t`. */
  fired(violet: boolean, x: number, z: number, t: number): void {
    start(this.fires, violet, t).where.set(x / 100, GUN_HEIGHT, z / 100);
  }

  /** A hit on whatever is at `(x, z)` in centimetres, by a shot of `violet`'s team, at time `t`. */
  hit(violet: boolean, x: number, z: number, t: number): void {
    start(this.hits, violet, t).where.set(x / 100, 0.87, z / 100);
  }

  /** Draws every effect as it is at time `t`, with the bolts given since the last update. */
  update(t: number): void {
    const kit = this.kit;
    for (const f of this.fires) {
      const since = t - f.at;
      f.glow = 0;
      if (!(since >= 0 && since < FLASH_S)) continue;
      const level = 1 - since / FLASH_S;
      const flare = kit.flare();
      flare.violet = f.violet;
      flare.where.copy(f.where);
      flare.size = 2.2;
      flare.opacity = level;
      flare.rotation = since * 40;
      f.glow = level * 14;
    }
    for (let i = 0; i < HITS; i++) {
      const b = this.hits[i]!;
      const h = t - b.at;
      b.glow = 0;
      if (!(h >= 0 && h < BURST_S)) continue;
      const hit = kit.hit(i);
      hit.violet = b.violet;
      hit.where.copy(b.where);
      hit.h = h;
      b.glow = h < 0.25 ? 22 * (1 - h / 0.25) : 0;
    }
    for (const b of this.beams) {
      const h = t - b.at;
      b.glow = 0;
      if (!(h >= 0 && h < BEAM_S)) continue;
      const rail = kit.rail();
      rail.violet = b.violet;
      rail.from.copy(b.from);
      rail.to.copy(b.where);
      rail.h = h;
      rail.fade = 1 - h / BEAM_S;
      b.glow = 18 * rail.fade;
    }
    for (let i = 0; i < BLASTS; i++) {
      const b = this.blasts[i]!;
      const h = t - b.at;
      b.glow = 0;
      if (!(h >= 0 && h < BURST_S)) continue;
      const hit = kit.hit(HITS + i);
      hit.violet = b.violet;
      hit.where.copy(b.where);
      hit.h = h;
      if (h < BLAST_S) {
        // A little larger and longer than a hit, no brighter: the style frame's hits set the ceiling.
        const flare = kit.flare();
        flare.violet = b.violet;
        flare.where.copy(b.where);
        flare.size = 4 + h * 4;
        flare.opacity = 0.85 * (1 - h / BLAST_S);
        flare.rotation = 0;
      }
      b.glow = h < 0.4 ? 24 * (1 - h / 0.4) : 0;
    }
    // Written out here rather than in a method: a float passed to a call that is not inlined is boxed.
    for (let i = 0; i < SHIELDS; i++) {
      const s = this.shields[i]!;
      if (s.asked && !s.held) s.since = t;
      if (!s.asked && s.held) s.gone = t;
      s.held = s.asked;
      s.asked = false;
      let level: number;
      let grow: number;
      if (s.held) {
        const age = t - s.since;
        const rise = Math.min(1, age / SHIELD_IN_S);
        s.fade = Math.min(1, Math.max(0, s.left / SHIELD_FADE_TICKS));
        // A slow breath, so it reads as live rather than painted on.
        level = rise * s.fade * (0.85 + 0.15 * Math.sin(age * 4.5));
        grow = 0.85 + 0.15 * rise;
      } else {
        const out = t - s.gone;
        // Ended by firing, it collapses onto the craft with a flash; run out, it has already faded.
        const k = out / SHIELD_COLLAPSE_S;
        level = k < 1 ? s.fade * (1 - k) * (1 + 0.8 * (1 - k)) : 0;
        grow = 1 - 0.35 * Math.min(1, k);
      }
      const bubble = s.bubble;
      bubble.visible = level > 0 || this.warm;
      if (!bubble.visible) continue;
      bubble.position.x = s.where.x;
      bubble.position.y = 0.8;
      bubble.position.z = s.where.z;
      bubble.scale.x = bubble.scale.z = 1.55 * grow;
      bubble.scale.y = 1.2 * grow;
      bubble.material.color.copy(this.shieldTints[s.violet ? 1 : 0]);
      bubble.material.opacity = 0.9 * level;
      s.time.value = t;
      const hit = s.hit.value;
      hit.w = t - s.hitAt;
      if (hit.w < SHIELD_HIT_S) {
        // Shots fly at gun height, close to the bubble's middle.
        const dx = s.from.x - s.where.x;
        const dz = s.from.z - s.where.z;
        const flat = Math.sqrt(dx * dx + dz * dz) || 1;
        hit.x = dx / flat;
        hit.y = 0;
        hit.z = dz / flat;
      }
    }
    this.warm = false;
    // The point lights go to the brightest glows.
    for (const g of kit.glows) g.level = 0;
    for (const s of this.all) {
      if (s.glow <= 0) continue;
      let dimmest = kit.glows[0]!;
      for (const g of kit.glows) if (g.level < dimmest.level) dimmest = g;
      if (s.glow <= dimmest.level) continue;
      dimmest.level = s.glow;
      dimmest.violet = s.violet;
      dimmest.where.copy(s.where);
    }
    kit.end();
  }
}
