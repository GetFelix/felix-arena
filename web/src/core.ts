// The WebAssembly build of core/: the tick decoder and, later, the rules the
// page predicts with. `npm run core` builds it into src/core/.
import init, { initSync } from './core/felix_arena_core.js';

export { decodeTick, Inputs, playerKey } from './core/felix_arena_core.js';
export type { Craft, Player, Tick, Timing } from './core/felix_arena_core.js';

/**
 * Load core. A page fetches the module next to its script; Node passes the
 * module's bytes, since it has no fetch for files.
 */
export async function loadCore(wasm?: BufferSource): Promise<void> {
  if (wasm) initSync({ module: wasm });
  else await init();
}
