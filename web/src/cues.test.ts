import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CUES, OwnWatcher, PhaseWatcher, playsFor, replayCue, type CueName, type MatchClock } from './cues';

const at = { x: 500, z: -200 };
const event = (kind: string, slot: number, by = 0, damage = 10) => ({ kind, slot, by, damage });

describe('playsFor', () => {
  it('plays your own shot centred and full, and another craft shot from where it is and quieter', () => {
    expect(playsFor(event('fired', 1), at, 1)).toEqual([{ cue: 'fire', at: null, gain: 1 }]);
    const other = playsFor(event('fired', 2), at, 1);
    expect(other).toHaveLength(1);
    expect(other[0]).toMatchObject({ cue: 'fire', at });
    expect(other[0]!.gain).toBeLessThan(1);
  });

  it('tells being hit, hitting and watching a hit apart', () => {
    expect(playsFor(event('hit', 1, 2), at, 1)[0]).toMatchObject({ cue: 'hurt', at: null });
    const landed = playsFor(event('hit', 2, 1), at, 1)[0]!;
    const seen = playsFor(event('hit', 2, 3), at, 1)[0]!;
    expect(landed).toMatchObject({ cue: 'hit', at });
    expect(seen.cue).toBe('hit');
    expect(landed.gain).toBeGreaterThan(seen.gain);
  });

  it('makes a shot the spawn shield stopped a shield sound, not a hit', () => {
    expect(playsFor(event('hit', 1, 2, 0), at, 1)[0]).toMatchObject({ cue: 'absorb', at: null });
    expect(playsFor(event('hit', 2, 1, 0), at, 1)[0]).toMatchObject({ cue: 'absorb', at });
  });

  it('plays your destruction as a blow that fills the room and another craft as an explosion on the floor', () => {
    expect(playsFor(event('killed', 1, 2), at, 1)).toEqual([{ cue: 'destroyed', at: null, gain: 1 }]);
    const yours = playsFor(event('killed', 2, 1), at, 1)[0]!;
    const theirs = playsFor(event('killed', 2, 3), at, 1)[0]!;
    expect([yours.cue, theirs.cue]).toEqual(['explode', 'explode']);
    expect(yours.gain).toBeGreaterThan(theirs.gain);
  });

  it('has a sound for the rail shot, the pickup and a spawn', () => {
    expect(playsFor(event('railed', 2), at, 1)[0]).toMatchObject({ cue: 'rail', at });
    expect(playsFor(event('picked', 1), at, 1)[0]).toMatchObject({ cue: 'pickup', at: null });
    expect(playsFor(event('spawned', 2), at, 1)[0]).toMatchObject({ cue: 'spawn', at });
  });

  it('is silent for joins, leaves and kinds it does not know', () => {
    for (const kind of ['joined', 'left', 'something-new']) expect(playsFor(event(kind, 1), at, 1)).toEqual([]);
  });

  it('gives a spectator every sound from where it happened, none as their own', () => {
    for (const kind of ['fired', 'hit', 'killed', 'railed', 'picked', 'spawned']) {
      const plays = playsFor(event(kind, 1, 2), at, null);
      expect(plays).toHaveLength(1);
      expect(plays[0]!.at).toEqual(at);
    }
  });

  it('only names cues that exist', () => {
    for (const kind of ['fired', 'hit', 'killed', 'railed', 'picked', 'spawned'])
      for (const own of [1, 2, null])
        for (const p of playsFor(event(kind, 1, 2), at, own)) expect(CUES[p.cue]).toBeDefined();
  });
});

describe('PhaseWatcher', () => {
  const clock = (phase: MatchClock['phase'], seconds = 0, number = 1, waiting = false): MatchClock => ({
    phase,
    number,
    seconds,
    waiting,
  });

  it('says nothing on the first look, so joining a match in progress is not a round start', () => {
    expect(new PhaseWatcher().update(clock('playing', 100))).toEqual([]);
  });

  it('ticks once for each of the last three seconds of warmup, then starts the round', () => {
    const watcher = new PhaseWatcher();
    watcher.update(clock('warmup', 5));
    const heard: CueName[] = [];
    for (const seconds of [5, 4, 3, 3, 3, 2, 2, 1, 1]) heard.push(...watcher.update(clock('warmup', seconds)));
    expect(heard).toEqual(['tick', 'tick', 'tick']);
    expect(watcher.update(clock('playing', 120))).toEqual(['go']);
    expect(watcher.update(clock('playing', 119))).toEqual([]);
  });

  it('does not count down while the warmup waits for a second player', () => {
    const watcher = new PhaseWatcher();
    watcher.update(clock('warmup', 2, 1, true));
    expect(watcher.update(clock('warmup', 2, 1, true))).toEqual([]);
  });

  it('ends the round once, when play gives way to the results', () => {
    const watcher = new PhaseWatcher();
    watcher.update(clock('playing', 1));
    expect(watcher.update(clock('results', 15))).toEqual(['round-end']);
    expect(watcher.update(clock('results', 14))).toEqual([]);
    expect(watcher.update(clock('warmup', 10, 2))).toEqual([]);
  });
});

describe('OwnWatcher', () => {
  const state = (boostCooling = 0, overheated = false, alive = true) => ({ alive, boostCooling, overheated });

  it('plays the dash when the boost cooldown jumps up, not as it runs down', () => {
    const watcher = new OwnWatcher();
    expect(watcher.update(state(0))).toEqual([]);
    expect(watcher.update(state(1))).toEqual(['boost']);
    expect(watcher.update(state(0.9))).toEqual([]);
    expect(watcher.update(state(0.2))).toEqual([]);
  });

  it('plays the lock-up once when the blaster overheats', () => {
    const watcher = new OwnWatcher();
    watcher.update(state());
    expect(watcher.update(state(0, true))).toEqual(['overheat']);
    expect(watcher.update(state(0, true))).toEqual([]);
  });

  it('is silent while destroyed or without a craft', () => {
    const watcher = new OwnWatcher();
    watcher.update(state(0, false, false));
    expect(watcher.update(state(1, true, false))).toEqual([]);
    expect(watcher.update(null)).toEqual([]);
  });
});

describe('replayCue', () => {
  it('marks a replay starting and ending, and nothing between', () => {
    expect(replayCue(false, true)).toBe('replay-in');
    expect(replayCue(true, true)).toBeNull();
    expect(replayCue(true, false)).toBe('replay-out');
    expect(replayCue(false, false)).toBeNull();
  });
});

describe('the audio files', () => {
  const dir = new URL('../../prototype/assets/audio/', import.meta.url);
  const files = (sub: string) => readdirSync(new URL(sub, dir)).filter((f) => f.endsWith('.ogg'));
  const credits = readFileSync(new URL('CREDITS.md', dir), 'utf8');

  it('include every file a cue names', () => {
    const have = new Set(files('sfx/').map((f) => f.slice(0, -4)));
    for (const [cue, spec] of Object.entries(CUES))
      for (const f of spec.files) expect(have, `${cue}: ${f}`).toContain(f);
  });

  it('are each listed in the credits with their licence', () => {
    for (const f of files('sfx/')) expect(credits, `sfx/${f}`).toContain(`sfx/${f}`);
    for (const f of files('music/')) expect(credits, `music/${f}`).toContain(`music/${f}`);
  });

  it('use no effect that no cue plays', () => {
    const used = new Set(Object.values(CUES).flatMap((s) => s.files));
    for (const f of files('sfx/')) expect(used, f).toContain(f.slice(0, -4));
  });
});
