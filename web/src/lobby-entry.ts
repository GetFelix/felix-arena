// What an arena's sim writes to the lobby cache, as the lobby page reads it.

/** One arena's lobby entry, as its sim writes it. */
export interface LobbyEntry {
  match: number;
  phase: 'warmup' | 'playing' | 'results';
  /** Seconds left in the phase when the sim wrote it. */
  seconds: number;
  scores: [number, number];
  players: number;
  capacity: number;
  spectators: number;
}

/** A lobby entry, or `null` for one this page cannot read. */
export function parseEntry(payload: Uint8Array): LobbyEntry | null {
  try {
    const entry = JSON.parse(new TextDecoder().decode(payload)) as LobbyEntry;
    return typeof entry.match === 'number' && Array.isArray(entry.scores) ? entry : null;
  } catch {
    return null;
  }
}

/** What the card says about the phase. */
export function phaseLabel(entry: LobbyEntry): string {
  if (entry.phase === 'warmup') return entry.players < 2 ? 'WAITING' : 'WARMUP';
  return entry.phase === 'playing' ? 'LIVE' : 'RESULTS';
}
