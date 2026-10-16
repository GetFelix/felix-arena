// The style frame's scripted fight: each shooter fires two bolts at a fixed beat in a loop, and each hit throws
// sparks, a ground ring, a flash and some debris, all drawn through the effects kit the live match uses.
import { type Object3D, Vector3 } from 'three';
import { type Craft, type CraftName, TARGETS } from './crafts';
import { BURST_S, type EffectTextures, EffectsKit, LIGHTS } from './effects';
import { palette } from './palette';

const LOOP = 2.4;
const SPEED = 30;
const SHOTS: { from: CraftName; at: number }[] = [
  { from: 'rook', at: 0.0 },
  { from: 'mara', at: 0.75 },
  { from: 'ash', at: 1.35 },
  { from: 'vex', at: 1.95 },
];

/** The scripted fight between the crafts, driven by {@link Combat.update}. */
export class Combat {
  private readonly kit: EffectsKit;
  private readonly nose = new Vector3();
  private readonly end = new Vector3();
  private readonly at = new Vector3();

  /** `random` sets the sparks and debris; shooter `i` in {@link SHOTS} order hits with the kit's slot `i`. */
  constructor(
    scene: Object3D,
    fx: Object3D,
    tex: EffectTextures,
    private readonly crafts: Record<CraftName, Craft>,
    random: () => number,
  ) {
    this.kit = new EffectsKit(scene, fx, tex, random);
  }

  /** Shows every effect as it is at time `t`. Call after the crafts have moved to `t`. */
  update(t: number): void {
    const { nose, end, at, kit } = this;
    for (let n = 0; n < SHOTS.length; n++) {
      const s = SHOTS[n]!;
      const p = this.crafts[s.from];
      const q = this.crafts[TARGETS[s.from]];
      const violet = p.color === palette.violet;
      const local = (((t - s.at) % LOOP) + LOOP) % LOOP;
      nose.set(Math.sin(p.aim) * 1.3, 0.55, Math.cos(p.aim) * 1.3).add(p.g.position);
      end.copy(q.g.position).setY(q.g.position.y + 0.45);
      const flight = nose.distanceTo(end) / SPEED;
      let flashLevel = 0;
      for (let i = 0; i < 2; i++) {
        const u = (local - i * 0.12) / flight;
        if (u >= 0 && u < 1) {
          at.lerpVectors(nose, end, u);
          const b = kit.bolt(violet);
          b.x = at.x;
          b.y = at.y;
          b.z = at.z;
          b.yaw = p.aim - Math.PI / 2;
          b.size = 1;
        }
        const since = local - i * 0.12;
        if (since >= 0 && since < 0.07) flashLevel = Math.max(flashLevel, 1 - since / 0.07);
      }
      if (flashLevel > 0) {
        const flare = kit.flare();
        flare.violet = violet;
        flare.where.copy(nose);
        flare.size = 2.2;
        flare.opacity = flashLevel;
        flare.rotation = local * 40;
      }

      const h = local - flight;
      const live = h >= 0 && h < BURST_S;
      let lightLevel = flashLevel * 14;
      if (live) {
        const hit = kit.hit(n);
        hit.violet = violet;
        hit.where.copy(end);
        hit.h = h;
        lightLevel = Math.max(lightLevel, 22 * Math.max(0, 1 - h / 0.25));
      }
      // Four shooters share three lights, so the last shooter's light is the first's.
      const glow = kit.glows[n % LIGHTS]!;
      glow.level = lightLevel;
      glow.violet = violet;
      glow.where.copy(live && h < 0.25 ? end : nose);
    }
    kit.end();
  }
}
