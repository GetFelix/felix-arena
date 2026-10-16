// Every bolt in flight, as one instanced core and one instanced glow per team: four draw calls however many fly.
import {
  AdditiveBlending,
  CapsuleGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
  Quaternion,
  type Texture,
  Vector3,
} from 'three';
import { GUN_HEIGHT } from './fleet';
import { hdr } from './materials';
import { palette } from './palette';

/** At most this many bolts of each team are drawn. */
const MAX = 64;

/** A bolt to draw: centimetres, a heading in 65536ths of a turn, and 0 to 1 of its full size. */
export interface BoltView {
  violet: boolean;
  x: number;
  z: number;
  heading: number;
  size?: number;
}

interface Team {
  core: InstancedMesh;
  halo: InstancedMesh;
}

/** The bolts in flight, drawn the way the style frame draws one. */
export class Bolts {
  private readonly teams: [Team, Team];
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly p = new Vector3();
  private readonly s = new Vector3();
  private readonly up = new Vector3(0, 1, 0);

  constructor(fx: Object3D, glow: Texture) {
    const core = new CapsuleGeometry(0.09, 0.9, 4, 8).rotateZ(Math.PI / 2);
    const halo = new PlaneGeometry(3.2, 0.7).rotateX(-Math.PI / 2).translate(-0.9, 0, 0);
    const team = (colour: string): Team => {
      const t = {
        core: new InstancedMesh(core, new MeshBasicMaterial({ color: hdr(colour, 6) }), MAX),
        halo: new InstancedMesh(
          halo,
          new MeshBasicMaterial({
            map: glow,
            color: hdr(colour, 1.4),
            transparent: true,
            blending: AdditiveBlending,
            depthWrite: false,
          }),
          MAX,
        ),
      };
      for (const mesh of [t.core, t.halo]) {
        mesh.count = 0;
        mesh.frustumCulled = false;
        fx.add(mesh);
      }
      return t;
    };
    this.teams = [team(palette.coral), team(palette.violet)];
  }

  /** Draws exactly `bolts`. */
  update(bolts: BoltView[]): void {
    const counts = [0, 0];
    for (const bolt of bolts) {
      const side = bolt.violet ? 1 : 0;
      const i = counts[side]!;
      if (i >= MAX) continue;
      counts[side] = i + 1;
      this.q.setFromAxisAngle(this.up, -(bolt.heading / 65536) * 2 * Math.PI);
      this.p.set(bolt.x / 100, GUN_HEIGHT, bolt.z / 100);
      this.s.setScalar(bolt.size ?? 1);
      this.m.compose(this.p, this.q, this.s);
      this.teams[side].core.setMatrixAt(i, this.m);
      this.teams[side].halo.setMatrixAt(i, this.m);
    }
    this.teams.forEach((t, side) => {
      for (const mesh of [t.core, t.halo]) {
        mesh.count = counts[side]!;
        mesh.instanceMatrix.needsUpdate = true;
      }
    });
  }
}
