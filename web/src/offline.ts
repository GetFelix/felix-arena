// A development stand-in for the gateway: core's world runs in the page as the sim, at 30 Hz, with three bots, and
// its ticks reach the page as they would through Felix. `play.html?offline` uses it, so the game can be seen and
// played without the dev stack. It is not part of the game.
import { decodeInput, decodeTick, World } from './core';
import type { EventFrame, GatewayError, StateValue, Subscribed } from './gateway';
import { BOT_PROFILES, type BotLevel, type BotProfile } from './bots';
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
  stateGet(stream: string, key: string): Promise<StateValue>;
  subscribe(
    stream: string,
    slot: string,
    from: number | 'live',
    onEvent: (frame: EventFrame) => void,
  ): Promise<Subscribed>;
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
  private readonly bots: BotState[];
  private readonly profile: BotProfile;
  /** Holds the world still: no steps and no ticks, for screenshots. */
  paused = false;

  /** Match lengths in seconds. */
  constructor(warmup: number, length: number, results: number, level: BotLevel = 'normal', count = BOTS.length) {
    const names = BOTS.slice(0, count);
    this.profile = BOT_PROFILES[level];
    this.bots = names.map((_, i) => ({ turn: i % 2 ? 1 : -1, seq: 0 }));
    this.world = World.withRules(warmup * 30, length * 30, results * 30, 25, 15 * 30);
    this.world.join(OFFLINE_PRINCIPAL);
    for (const bot of names) this.world.join(bot);
    setInterval(() => this.step(), TICK_MS);
  }

  /** The page's sim keeps no log, so there is no keyframe to start from and a join starts live. */
  stateGet(): Promise<StateValue> {
    return Promise.resolve({ payload: null, version: null, asOf: null });
  }

  subscribe(_stream: string, _slot: string, _from: number | 'live', onEvent: (frame: EventFrame) => void) {
    this.listener = onEvent;
    return Promise.resolve({ sub: 0, startOffset: null, liveOffset: null });
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
    if (this.paused) return;
    const tick = decodeTick(this.world.record());
    const crafts = tick.crafts.map((c) => ({
      slot: c.slot,
      violet: c.violet,
      alive: c.alive,
      x: c.x,
      z: c.z,
      rail: c.rail,
      protected: c.protected,
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
      const stick = drive(me, crafts, bot, railThere, this.profile);
      controls.set([1, ++bot.seq & 0xffff, ...stick], 6 * (i + 1));
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

/** What a bot remembers between ticks. Only `turn` is needed; the rest starts empty. */
export interface BotState {
  turn: number;
  seq: number;
  tick?: number;
  home?: { x: number; z: number };
  target?: number;
  seenAt?: number;
  aim?: number;
  /** Ticks left in the current burst or pause. */
  phase?: number;
  firing?: boolean;
}

/**
 * A bot's stick, aim and buttons: close on the nearest enemy, circle it and fire; the bot in slot 2 fetches the rail
 * when it is up. `bot.turn` is which way it circles. An enemy under spawn protection is chased only when there is no
 * other. `profile` sets how well it aims, how soon it reacts, how it bursts, and whether it chases or holds.
 */
export function drive(
  me: { slot: number; violet: boolean; x: number; z: number; rail: number },
  crafts: { slot: number; violet: boolean; alive: boolean; x: number; z: number; protected?: boolean }[],
  bot: BotState,
  railThere: boolean,
  profile: BotProfile = BOT_PROFILES.normal,
): number[] {
  const tick = (bot.tick = (bot.tick ?? 0) + 1);
  bot.home ??= { x: me.x, z: me.z };
  const enemies = crafts.filter((c) => c.alive && c.violet !== me.violet);
  const away = (c: { x: number; z: number }) => Math.hypot(c.x - me.x, c.z - me.z);
  const target = enemies.sort((a, b) => Number(!!a.protected) - Number(!!b.protected) || away(a) - away(b))[0];
  if (target?.slot !== bot.target) {
    bot.target = target?.slot;
    bot.seenAt = tick;
  }
  if (Math.random() < 0.01) bot.turn = -bot.turn;
  let [mx, mz] = [0, 0];
  let aim = bot.aim ?? 0;
  let buttons = 0;
  if (profile.fetchesRail && railThere && me.slot === 2 && me.rail === 0) {
    [mx, mz] = [-me.x, -me.z];
  } else if (target) {
    const [dx, dz] = [target.x - me.x, target.z - me.z];
    const distance = Math.hypot(dx, dz);
    const reacted = tick - (bot.seenAt ?? tick) >= profile.reactionTicks;
    if (reacted) aim = Math.atan2(dz, dx) + (Math.random() - 0.5) * profile.aimError;
    // Close in from afar, circle at fighting range. A bot that holds drifts back to where it started instead.
    let closing = distance > 1100 ? 1 : distance < 600 ? -0.5 : 0;
    if (!profile.chases && distance > 1100) closing = 0;
    [mx, mz] = [dx * closing - dz * bot.turn * 0.8, dz * closing + dx * bot.turn * 0.8];
    if (!profile.chases && distance > 1500) [mx, mz] = [bot.home.x - me.x, bot.home.z - me.z];
    if (reacted && distance < profile.fireRange) {
      if ((bot.phase = (bot.phase ?? 0) - 1) <= 0) {
        bot.firing = !bot.firing;
        bot.phase = bot.firing ? profile.burstTicks : profile.pauseTicks;
      }
      if (bot.firing && Math.random() < profile.fireChance) buttons |= 1;
    }
    if (Math.random() < 0.004) buttons |= 2;
  }
  bot.aim = aim;
  const length = Math.hypot(mx, mz) || 1;
  const heading = Math.round((aim / (2 * Math.PI)) * 65536) & 0xffff;
  return [Math.round((mx / length) * 127), Math.round((mz / length) * 127), heading, buttons];
}
