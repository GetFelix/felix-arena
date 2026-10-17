import { describe, expect, it } from 'vitest';
import { parseEntry, phaseLabel } from './lobby-entry';
import { leaveUrl, memberEntry } from './members';

describe('the lobby and the member list', () => {
  it("reads the sim's lobby entry and names its phase", () => {
    // The sim's own test writes this text (sim/src/lobby.rs).
    const text = '{"match":3,"phase":"playing","seconds":3,"scores":[4,2],"players":4,"capacity":8,"spectators":1}';
    const entry = parseEntry(new TextEncoder().encode(text))!;
    expect(entry).toEqual({
      match: 3,
      phase: 'playing',
      seconds: 3,
      scores: [4, 2],
      players: 4,
      capacity: 8,
      spectators: 1,
    });
    expect(phaseLabel(entry)).toBe('LIVE');
    expect(phaseLabel({ ...entry, phase: 'warmup', players: 1 })).toBe('WAITING');
    expect(parseEntry(new TextEncoder().encode('not json'))).toBeNull();
  });

  it('writes the role the sim counts and finds the leave endpoint', () => {
    expect(new TextDecoder().decode(memberEntry('watch', 'cleo'))).toBe('watch:cleo');
    expect(leaveUrl('ws://127.0.0.1:8787/ws')).toBe('http://127.0.0.1:8787/members/leave');
    expect(leaveUrl('wss://arena.example/ws')).toBe('https://arena.example/members/leave');
  });
});
