// How hard the offline bots play. They only change what the bots feed the input path, never the rules.

export type BotLevel = 'easy' | 'normal' | 'hard';

export interface BotProfile {
  /** Full width of the random aim error, in radians. */
  readonly aimError: number;
  /** Ticks between a target appearing and the bot aiming or firing at it. */
  readonly reactionTicks: number;
  /** Chance per tick of pulling the trigger while a burst is on. */
  readonly fireChance: number;
  /** Ticks a burst lasts, and the pause after it. */
  readonly burstTicks: number;
  readonly pauseTicks: number;
  /** Furthest target the bot fires at. */
  readonly fireRange: number;
  /** Whether the bot crosses the arena after an enemy, or holds near where it started. */
  readonly chases: boolean;
  /** Whether the bot in slot 2 goes for the rail. */
  readonly fetchesRail: boolean;
}

export const BOT_PROFILES: Record<BotLevel, BotProfile> = {
  easy: {
    aimError: 1,
    reactionTicks: 18,
    fireChance: 0.4,
    burstTicks: 10,
    pauseTicks: 25,
    fireRange: 1200,
    chases: false,
    fetchesRail: false,
  },
  normal: {
    aimError: 0.2,
    reactionTicks: 8,
    fireChance: 0.65,
    burstTicks: 20,
    pauseTicks: 10,
    fireRange: 1600,
    chases: true,
    fetchesRail: true,
  },
  hard: {
    aimError: 0.08,
    reactionTicks: 4,
    fireChance: 0.85,
    burstTicks: 40,
    pauseTicks: 4,
    fireRange: 1800,
    chases: true,
    fetchesRail: true,
  },
};

/** `?bots=`: easy, normal or hard; anything else is normal. */
export function botLevel(value: string | null): BotLevel {
  return value === 'easy' || value === 'hard' ? value : 'normal';
}

/** `?botcount=`: 1 to 3 bots; anything else is 3. */
export function botCount(value: string | null): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 3 ? n : 3;
}

/** The tag shown for an offline match. */
export function botTag(level: BotLevel, count: number): string {
  return `offline, against ${count} ${level} ${count === 1 ? 'bot' : 'bots'}`;
}
