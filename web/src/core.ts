// The WebAssembly build of core/: the tick decoder and, later, the rules the
// page predicts with. `npm run core` builds it into src/core/.
import init, { arena, initSync } from './core/felix_arena_core.js';

export { boltSpeed, decodeTick, Inputs, playerKey, World } from './core/felix_arena_core.js';
export type { Bolt, Craft, Player, Tick, Timing } from './core/felix_arena_core.js';

/**
 * Load core. A page fetches the module next to its script; Node passes the
 * module's bytes, since it has no fetch for files.
 */
export async function loadCore(wasm?: BufferSource): Promise<void> {
  if (wasm) initSync({ module: wasm });
  else await init();
}

/** An obstacle in metres, from core's collision layout. */
export type Obstacle =
  | { kind: 'box'; x: number; z: number; halfX: number; halfZ: number }
  | { kind: 'round'; x: number; z: number; radius: number };

/** The arena core collides against, in metres: half its length (x) and width (z), and every obstacle in core's order. */
export interface ArenaLayout {
  halfX: number;
  halfZ: number;
  obstacles: Obstacle[];
}

/** The arena layout from core. Call after {@link loadCore}. */
export function arenaLayout(): ArenaLayout {
  const cm = arena();
  const m = (i: number) => cm[i]! / 100;
  const obstacles: Obstacle[] = [];
  for (let i = 2; i < cm.length; i += 5) {
    obstacles.push(
      cm[i] === 0
        ? { kind: 'box', x: m(i + 1), z: m(i + 2), halfX: m(i + 3), halfZ: m(i + 4) }
        : { kind: 'round', x: m(i + 1), z: m(i + 2), radius: m(i + 3) },
    );
  }
  return { halfX: m(0), halfZ: m(1), obstacles };
}
