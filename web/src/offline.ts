// A development stand-in for the gateway: core's world runs in the page as the sim, at 30 Hz, with three bots, and
// its ticks reach the page as they would through Felix. `play.html?offline` uses it, so the game can be seen and
// played without the dev stack. It is not part of the game.
import { decodeInput, decodeTick, World } from './core';
import type { EventFrame, GatewayError } from './gateway';
import { TICK_MS } from './interpolation';

/** The principal the page plays as. */
export const OFFLINE_PRINCIPAL = 'offline-player';

const BOTS = ['offline-bot-1', 'offline-bot-2', 'offline-bot-3'];
/** How long a tick takes to reach the page. */
const LATENCY_MS = 25;

/** What the page needs of a gateway. */
export interface Link {
  readonly missing: readonly string[];
  onError: (err: GatewayError) => void;
  subscribe(
    stream: string,
    slot: string,
    from: number | 'live',
    onEvent: (frame: EventFrame) => void,
  ): Promise<unknown>;
  send(stream: string, payload: Uint8Array): void;
}

/** The sim and its bots, in the page. */
export class Offline implements Link {
  readonly missing: readonly string[] = [];
  onError: (err: GatewayError) => void = () => {};
  private readonly world: World;
  private listener: ((frame: EventFrame) => void) | null = null;
  /** The newest input from the page not yet applied: sequence, move x, move z, aim, buttons. */
  private input: number[] | null = null;
  private held: number[] | null = null;
  private heardMs = -Infinity;
  private offset = 0;
  private readonly bots = BOTS.map((_, i) => ({ turn: i % 2 ? 1 : -1, seq: 0 }));

  /** Match lengths in seconds. */
  constructor(warmup: number, length: number, results: number) {
    this.world = World.withRules(warmup * 30, length * 30, results * 30, 25, 15 * 30);
    this.world.join(OFFLINE_PRINCIPAL);
    for (const bot of BOTS) this.world.join(bot);
    setInterval(() => this.step(), TICK_MS);
  }

  subscribe(_stream: string, _slot: string, _from: number | 'live', onEvent: (frame: EventFrame) => void) {
    this.listener = onEvent;
    return Promise.resolve();
  }

  send(_stream: string, payload: Uint8Array): void {
    const input = decodeInput(payload);
    if (!input) return;
    const buttons = this.input ? this.input[4]! | input[4]! : input[4]!;
    this.input = [...input];
    this.input[4] = buttons;
    this.heardMs = performance.now();
  }

  private step(): void {
    const tick = decodeTick(this.world.record());
    const crafts = tick.crafts.map((c) => ({
      slot: c.slot,
      violet: c.violet,
      alive: c.alive,
      x: c.x,
      z: c.z,
      rail: c.rail,
    }));
    const railThere = tick.railIn === 0;
    tick.free();
    const controls = new Int32Array(6 * 8);
    // The sim's rule: the newest input, held 100 ms after the last one arrives.
    const now = performance.now();
    if (this.input) {
      this.held = this.input;
      this.input = null;
    }
    if (this.held && now - this.heardMs <= 100) {
      controls.set([1, ...this.held], 0);
      this.held = [...this.held.slice(0, 4), 0];
    }
    this.bots.forEach((bot, i) => {
      const me = crafts.find((c) => c.slot === i + 1);
      if (!me?.alive) return;
      controls.set([1, ++bot.seq & 0xffff, ...drive(me, crafts, bot, railThere)], 6 * (i + 1));
    });
    this.world.step(controls);
    const payload = this.world.record();
    const offset = this.offset++;
    setTimeout(() => {
      const us = Math.round((performance.timeOrigin + performance.now()) * 1000);
      this.listener?.({
        sub: 1,
        offset,
        skippedBefore: 0,
        gatewayReceivedUs: us,
        gatewaySentUs: us,
        receivedUs: us,
        payload,
      });
    }, LATENCY_MS);
  }
}

/**
 * A bot's stick, aim and buttons: close on the nearest enemy, circle it and fire; the bot in slot 2 fetches the rail
 * when it is up. `bot.turn` is which way it circles.
 */
export function drive(
  me: { slot: number; violet: boolean; x: number; z: number; rail: number },
  crafts: { slot: number; violet: boolean; alive: boolean; x: number; z: number }[],
  bot: { turn: number },
  railThere: boolean,
): number[] {
  const enemies = crafts.filter((c) => c.alive && c.violet !== me.violet);
  const target = enemies.sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))[0];
  if (Math.random() < 0.01) bot.turn = -bot.turn;
  let [mx, mz] = [0, 0];
  let aim = 0;
  let buttons = 0;
  if (railThere && me.slot === 2 && me.rail === 0) {
    [mx, mz] = [-me.x, -me.z];
  } else if (target) {
    const [dx, dz] = [target.x - me.x, target.z - me.z];
    const distance = Math.hypot(dx, dz);
    aim = Math.atan2(dz, dx) + (Math.random() - 0.5) * 0.12;
    // Close in from afar, circle at fighting range.
    const closing = distance > 1100 ? 1 : distance < 600 ? -0.5 : 0;
    [mx, mz] = [dx * closing - dz * bot.turn * 0.8, dz * closing + dx * bot.turn * 0.8];
    if (distance < 1800 && Math.random() < 0.8) buttons |= 1;
    if (Math.random() < 0.004) buttons |= 2;
  }
  const length = Math.hypot(mx, mz) || 1;
  const heading = Math.round((aim / (2 * Math.PI)) * 65536) & 0xffff;
  return [Math.round((mx / length) * 127), Math.round((mz / length) * 127), heading, buttons];
}
