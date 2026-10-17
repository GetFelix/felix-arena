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
