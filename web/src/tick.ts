// The fixed header at the front of every tick record, as the sim writes it in
// sim/src/tick.rs. The rest of the tick's encoding arrives with core/ in
// WebAssembly; this is only what a page needs to follow the tick stream.

/** The fixed part of a tick record. */
export interface TickHeader {
  epoch: number;
  keyframe: boolean;
  match: number;
  tick: number;
  /** The sim's timing block, when the tick carries one. */
  timing: TickTiming | null;
}

/** When the sim stepped and committed the tick. */
export interface TickTiming {
  /** When the tick's commit started: µs since the Unix epoch on the sim's clock. */
  commitStartUs: number;
  /** From the tick falling due to its commit starting. */
  stepUs: number;
  /** How long the previous tick's commit took to be answered; 0 when unknown. */
  previousCommitUs: number;
}

/** The length of {@link TickHeader} on the wire. */
export const HEADER_LEN = 12;
const TIMING_LEN = 16;
const KEYFRAME = 1;
const TIMED = 2;

/**
 * Little-endian: epoch (2 bytes), flags (1), reserved (1), match (4), tick (4),
 * then, with the timed flag, commit start (8), step (4) and previous commit (4).
 */
export function parseTickHeader(record: Uint8Array): TickHeader | null {
  if (record.byteLength < HEADER_LEN) return null;
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const flags = view.getUint8(2);
  const timed = (flags & TIMED) !== 0 && record.byteLength >= HEADER_LEN + TIMING_LEN;
  return {
    epoch: view.getUint16(0, true),
    keyframe: (flags & KEYFRAME) !== 0,
    match: view.getUint32(4, true),
    tick: view.getUint32(8, true),
    timing: timed
      ? {
          commitStartUs: Number(view.getBigUint64(HEADER_LEN, true)),
          stepUs: view.getUint32(HEADER_LEN + 8, true),
          previousCommitUs: view.getUint32(HEADER_LEN + 12, true),
        }
      : null,
  };
}
