import { readFileSync } from 'node:fs';
import { PerspectiveCamera, Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { framing } from './camera';
import { loadCore } from './core';
import { GUN_HEIGHT } from './fleet';
import { KillRig, VIEWS } from './killcam-rig';
import { botMatch, type Fixture } from './kills.fixture';
import { fetchReplay, Playback, type Reader } from './replay';

let match: Fixture;
beforeAll(() => {
  loadCore(readFileSync(new URL('./core/felix_arena_core_bg.wasm', import.meta.url)));
  match = botMatch(4000);
});

const reader = (records: Uint8Array[]): Reader => ({
  read: async (_stream, from, end) => {
    const stop = Math.min(end ?? records.length, records.length);
    return {
      records: records.slice(from, stop).map((payload, i) => ({ offset: from + i, payload })),
      nextOffset: stop,
    };
  },
});

describe('the kill cam views', () => {
  for (const [width, height] of [
    [1920, 1080],
    [1280, 1024],
    [800, 1200],
  ] as const) {
    it(`keep the killer and the victim on screen through every replay, at ${width}x${height}`, async () => {
      expect(match.kills.length).toBeGreaterThan(5);
      const aspect = width / height;
      const { radius, yaw } = framing(aspect, 30, true);
      const camera = new PerspectiveCamera(30, aspect, 1, 200);
      let worst = 0;
      for (const kill of match.kills) {
        const replay = await fetchReplay(reader(match.records), kill);
        for (let i = 0; i < 50 && replay.times.afterMs === null; i++) await new Promise((r) => setTimeout(r, 0));
        for (const view of VIEWS) {
          const rig = new KillRig(30, aspect, radius, yaw);
          rig.view = view;
          const playback = new Playback(replay);
          for (let frame = playback.advance(0); !frame.done; frame = playback.advance(1000 / 60)) {
            const at = (slot: number) => frame.crafts.find((c) => c.slot === slot)!;
            const [victim, killer] = [at(kill.victim), at(kill.killer)];
            // Halfway through, the view changes to the next one, which the camera eases into.
            if (frame.progress > 0.5) rig.view = VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]!;
            const pose = rig.update(victim, killer, 1 / 60, frame.speed, frame.renderTick >= kill.tick);
            camera.position.copy(pose.position);
            camera.lookAt(pose.target);
            camera.updateMatrixWorld();
            for (const c of [victim, killer]) {
              const p = new Vector3(c.x / 100, GUN_HEIGHT, c.z / 100).project(camera);
              const off = Math.max(Math.abs(p.x), Math.abs(p.y));
              worst = Math.max(worst, off);
              // Inside the letterbox: its bars cover the outer 12% of a 1080-pixel-high screen.
              expect(off, `${view}, kill at ${kill.tick}, tick ${frame.renderTick.toFixed(1)}`).toBeLessThan(0.85);
              expect(p.z).toBeLessThan(1);
            }
          }
        }
      }
      console.log(
        `${match.kills.length} kills, three views: furthest craft at ${(worst * 100).toFixed(0)}% of the half screen`,
      );
    });
  }
});

describe('the hand-over from the death beat to the replay', () => {
  it('moves the camera without a jump, though the replay opens with the crafts elsewhere', async () => {
    const aspect = 1920 / 1080;
    const { radius, yaw } = framing(aspect, 30, true);
    const rest = new PerspectiveCamera(30, aspect, 1, 200);
    rest.position.set(
      Math.sin(yaw) * Math.cos(0.98) * radius,
      Math.sin(0.98) * radius,
      Math.cos(yaw) * Math.cos(0.98) * radius,
    );
    let worst = 0;
    let checked = 0;
    for (const kill of match.kills) {
      const replay = await fetchReplay(reader(match.records), kill);
      for (let i = 0; i < 50 && replay.times.afterMs === null; i++) await new Promise((r) => setTimeout(r, 0));
      // Where the two were at the kill, which the live beat looks at.
      const toKill = new Playback(replay);
      let at = toKill.advance(0);
      while (!at.done && at.renderTick < kill.tick) at = toKill.advance(1000 / 60);
      const spot = (slot: number) => at.crafts.find((c) => c.slot === slot)!;
      const [victim, killer] = [spot(kill.victim), spot(kill.killer)];
      const rig = new KillRig(30, aspect, radius, yaw);
      const last = new Vector3();
      // The beat: 600 ms easing to half weight, as KillCam draws it.
      for (let frame = 1; frame <= 36; frame++) {
        const pose = rig.update(victim, killer, 1 / 60);
        const f = frame / 36;
        const w = 0.5 * f * f * (3 - 2 * f);
        last.copy(rest.position).lerp(pose.position, w);
      }
      rig.handoff(0.5);
      const playback = new Playback(replay);
      let step = 0;
      let was: { x: number; z: number }[] | null = null;
      // The hand-over and a little after. A craft that respawns in it is a cut the rig makes on purpose, so that kill is left out.
      for (let i = 0, frame = playback.advance(0); i < 75 && !frame.done; i++, frame = playback.advance(1000 / 60)) {
        const now = [kill.victim, kill.killer].map((slot) => frame.crafts.find((x) => x.slot === slot)!);
        if (was?.some((w, j) => Math.hypot(now[j]!.x - w.x, now[j]!.z - w.z) > 200)) {
          step = -1;
          break;
        }
        was = now.map((c) => ({ x: c.x, z: c.z }));
        const pose = rig.update(now[0]!, now[1]!, 1 / 60, frame.speed);
        step = Math.max(step, pose.position.distanceTo(last));
        last.copy(pose.position);
      }
      if (step < 0) continue;
      checked++;
      worst = Math.max(worst, step);
    }
    expect(checked).toBeGreaterThan(match.kills.length / 2);
    // A 60 Hz frame; the eased hand-over moves at most about a metre a frame.
    expect(worst).toBeLessThan(1.5);
  });
});
