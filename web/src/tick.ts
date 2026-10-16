// The fixed header at the front of every tick record, as the sim writes it in
// sim/src/tick.rs. The rest of the tick's encoding arrives with core/ in
// WebAssembly; this is only what a page needs to follow the tick stream.

/** The fixed part of a tick record. */
export interface TickHeader {
  epoch: number;
  keyframe: boolean;
  match: number;
  tick: number;
}

/** The length of {@link TickHeader} on the wire. */
export const HEADER_LEN = 12;
const KEYFRAME = 1;

/** Little-endian: epoch (2 bytes), flags (1), reserved (1), match (4), tick (4). */
export function parseTickHeader(record: Uint8Array): TickHeader | null {
  if (record.byteLength < HEADER_LEN) return null;
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  return {
    epoch: view.getUint16(0, true),
    keyframe: (view.getUint8(2) & KEYFRAME) !== 0,
    match: view.getUint32(4, true),
    tick: view.getUint32(8, true),
  };
}
