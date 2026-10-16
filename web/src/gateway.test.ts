import { describe, expect, it } from 'vitest';
import { parseFrame } from './gateway';

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
