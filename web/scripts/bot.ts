// A bot for the CI scripts: a gateway session that reads ticks and steers its craft as the offline bots do.
// Load core before calling it.
import { decodeTick, Inputs } from '../src/core';
import { Gateway } from '../src/gateway';
import { drive } from '../src/offline';

const GATEWAY = process.env.ARENA_GATEWAY ?? 'ws://127.0.0.1:8787/ws';
const IDP = process.env.ARENA_IDP ?? 'http://127.0.0.1:9400';
/** Bots find their own craft by the sequence numbers it applies, so theirs start far apart. */
const FIRST_SEQ: Record<string, number> = { dan: 1000, ben: 15000, eve: 30000 };

/** Each bot's slot once it has found itself. */
export const botSlots = new Map<string, number | null>();

/** Play `user` in `arena` until the answer is called. */
export async function bot(user: string, arena: string): Promise<() => void> {
  const answer = await fetch(`${IDP}/token?sub=${user}&aud=felix-arena`);
  const token = ((await answer.json()) as { id_token: string }).id_token;
  const gateway = await Gateway.connect(GATEWAY, arena, token);
  const inputs = new Inputs(FIRST_SEQ[user] ?? 45000);
  const state = { turn: user === 'eve' ? -1 : 1 };
  let slot: number | null = null;
  let control = [0, 0, 0, 0];
  await gateway.subscribe('ticks', 'live', 'live', (frame) => {
    const tick = decodeTick(frame.payload);
    const crafts = tick.crafts.map((c) => ({
      slot: c.slot,
      violet: c.violet,
      alive: c.alive,
      x: c.x,
      z: c.z,
      rail: c.rail,
      lastInput: c.lastInput,
      protected: c.protected,
    }));
    // A bot knows itself as the craft its inputs drive.
    slot ??= crafts.find((c) => c.lastInput !== 0 && Math.abs(c.lastInput - inputs.seq) < 10)?.slot ?? null;
    botSlots.set(user, slot);
    const me = crafts.find((c) => c.slot === slot);
    control = me?.alive && tick.phase === 'playing' ? drive(me, crafts, state, tick.railIn === 0) : [0, 0, 0, 0];
    tick.free();
  });
  const timer = setInterval(
    () => gateway.send('input', inputs.next(control[0]!, control[1]!, control[2]!, control[3]!)),
    33,
  );
  return () => {
    clearInterval(timer);
    gateway.close();
  };
}
