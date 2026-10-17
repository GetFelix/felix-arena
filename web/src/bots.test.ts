import { describe, expect, it } from 'vitest';
import { BOT_PROFILES, botCount, botLevel, botTag } from './bots';

describe('bot difficulty', () => {
  it('makes easy aim worse and react slower than hard, with normal between', () => {
    const { easy, normal, hard } = BOT_PROFILES;
    expect(easy.aimError).toBeGreaterThan(normal.aimError);
    expect(normal.aimError).toBeGreaterThan(hard.aimError);
    expect(easy.reactionTicks).toBeGreaterThan(normal.reactionTicks);
    expect(normal.reactionTicks).toBeGreaterThan(hard.reactionTicks);
    expect(easy.fireChance).toBeLessThan(hard.fireChance);
    expect(easy.chases).toBe(false);
    expect(hard.chases).toBe(true);
  });

  it('reads the URL values, falling back to normal and three', () => {
    expect(botLevel('easy')).toBe('easy');
    expect(botLevel('hard')).toBe('hard');
    expect(botLevel('nightmare')).toBe('normal');
    expect(botLevel(null)).toBe('normal');
    expect(botCount('1')).toBe(1);
    expect(botCount('0')).toBe(3);
    expect(botCount('9')).toBe(3);
    expect(botCount(null)).toBe(3);
  });

  it('names the match in the tag', () => {
    expect(botTag('easy', 3)).toBe('offline, against 3 easy bots');
    expect(botTag('hard', 1)).toBe('offline, against 1 hard bot');
  });
});
