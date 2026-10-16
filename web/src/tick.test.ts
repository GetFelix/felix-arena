import { describe, expect, it } from 'vitest';
import { parseFrame } from './gateway';
import { parseTickHeader } from './tick';

describe('parseTickHeader', () => {
  it('reads what the sim writes', () => {
    // sim/src/tick.rs `round_trips`.
    const bytes = new Uint8Array([7, 0, 1, 0, 3, 0, 0, 0, 4, 3, 2, 1]);
    expect(parseTickHeader(bytes)).toEqual({ epoch: 7, keyframe: true, match: 3, tick: 0x01020304, timing: null });
    expect(parseTickHeader(bytes.subarray(0, 11))).toBeNull();
  });

  it('reads the timing block after the header', () => {
    // sim/src/tick.rs `a_timed_record_carries_its_timing_after_the_header`.
    const bytes = new Uint8Array(28);
    const view = new DataView(bytes.buffer);
    view.setUint8(2, 2);
    view.setUint32(8, 9, true);
    view.setBigUint64(12, 1_700_000_000_000_000n, true);
    view.setUint32(20, 40, true);
    view.setUint32(24, 2_500, true);
    expect(parseTickHeader(bytes)?.timing).toEqual({
      commitStartUs: 1_700_000_000_000_000,
      stepUs: 40,
      previousCommitUs: 2_500,
    });
  });
});

describe('parseFrame', () => {
  const frame = (headerLen: number, offset: bigint) => {
    const bytes = new Uint8Array(headerLen + 2);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, 1);
    view.setUint8(1, headerLen);
    view.setUint32(4, 9, true);
    view.setBigUint64(8, offset, true);
    view.setUint32(16, 2, true);
    view.setBigUint64(24, 1_000n, true);
    view.setBigUint64(32, 1_250n, true);
    bytes.set([0xaa, 0xbb], headerLen);
    return bytes.buffer;
  };

  it('splits the header from the payload', () => {
    const parsed = parseFrame(frame(40, 42n), 1_400)!;
    expect(parsed).toMatchObject({
      sub: 9,
      offset: 42,
      skippedBefore: 2,
      gatewayReceivedUs: 1000,
      gatewaySentUs: 1250,
      receivedUs: 1400,
    });
    expect([...parsed.payload]).toEqual([0xaa, 0xbb]);
  });

  it('finds the payload by the header length, so the header can grow', () => {
    expect([...parseFrame(frame(48, 1n))!.payload]).toEqual([0xaa, 0xbb]);
  });

  it('reads the no-offset marker as null and skips unknown kinds', () => {
    expect(parseFrame(frame(40, 0xffff_ffff_ffff_ffffn))!.offset).toBeNull();
    const other = new Uint8Array(frame(40, 1n));
    other[0] = 2;
    expect(parseFrame(other.buffer)).toBeNull();
  });
});
