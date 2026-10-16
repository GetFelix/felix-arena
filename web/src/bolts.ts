// Every bolt in flight, as one instanced core and one instanced glow per team: four draw calls however many fly.
import {
  AdditiveBlending,
  CapsuleGeometry,
  InstancedMesh,
  MeshBasicMaterial,
  type Object3D,
  PlaneGeometry,
  type Texture,
} from 'three';
import { hdr } from './materials';
import { palette } from './palette';

/** At most this many bolts of each team are drawn. */
export const MAX_BOLTS = 64;

/** A bolt to draw this frame: metres, turned `yaw` radians about y from +x, at `size` of its full size. */
export interface Bolt {
  x: number;
  y: number;
  z: number;
  yaw: number;
  size: number;
}

interface Team {
  core: InstancedMesh;
  halo: InstancedMesh;
  bolts: Bolt[];
  count: number;
}

/** The bolts in flight, drawn the way the style frame draws one. */
export class Bolts {
  private readonly teams: [Team, Team];
  /** Filled in and never drawn when a team asks for more than {@link MAX_BOLTS}. */
  private readonly spare: Bolt = bolt();

  constructor(fx: Object3D, glow: Texture) {
    const core = new CapsuleGeometry(0.09, 0.9, 4, 8).rotateZ(Math.PI / 2);
    const halo = new PlaneGeometry(3.2, 0.7).rotateX(-Math.PI / 2).translate(-0.9, 0, 0);
    const team = (colour: string): Team => {
      const t = {
        core: new InstancedMesh(core, new MeshBasicMaterial({ color: hdr(colour, 6) }), MAX_BOLTS),
        halo: new InstancedMesh(
          halo,
          new MeshBasicMaterial({
            map: glow,
            color: hdr(colour, 1.4),
            transparent: true,
            blending: AdditiveBlending,
            depthWrite: false,
          }),
          MAX_BOLTS,
        ),
        bolts: Array.from({ length: MAX_BOLTS }, bolt),
        count: 0,
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

  /** A bolt of `violet`'s team for this frame, to fill in. */
  add(violet: boolean): Bolt {
    const team = this.teams[violet ? 1 : 0];
    return team.bolts[team.count++] ?? this.spare;
  }

  /** Draws the bolts added since the last commit, and starts the next frame empty. */
  commit(): void {
    for (const team of this.teams) {
      const n = Math.min(team.count, MAX_BOLTS);
      const core = team.core.instanceMatrix.array as Float32Array;
      const halo = team.halo.instanceMatrix.array as Float32Array;
      for (let i = 0; i < n; i++) {
        const b = team.bolts[i]!;
        // Turned about y and scaled evenly, as Matrix4.compose would make it, written straight into both buffers.
        const c = Math.cos(b.yaw) * b.size;
        const s = Math.sin(b.yaw) * b.size;
        const o = i * 16;
        core[o] = halo[o] = c;
        core[o + 1] = halo[o + 1] = 0;
        core[o + 2] = halo[o + 2] = -s;
        core[o + 3] = halo[o + 3] = 0;
        core[o + 4] = halo[o + 4] = 0;
        core[o + 5] = halo[o + 5] = b.size;
        core[o + 6] = halo[o + 6] = 0;
        core[o + 7] = halo[o + 7] = 0;
        core[o + 8] = halo[o + 8] = s;
        core[o + 9] = halo[o + 9] = 0;
        core[o + 10] = halo[o + 10] = c;
        core[o + 11] = halo[o + 11] = 0;
        core[o + 12] = halo[o + 12] = b.x;
        core[o + 13] = halo[o + 13] = b.y;
        core[o + 14] = halo[o + 14] = b.z;
        core[o + 15] = halo[o + 15] = 1;
      }
      team.core.count = team.halo.count = n;
      team.core.instanceMatrix.needsUpdate = team.halo.instanceMatrix.needsUpdate = true;
      team.count = 0;
    }
  }
}

function bolt(): Bolt {
  return { x: 0, y: 0, z: 0, yaw: 0, size: 0 };
}
