import { describe, expect, it } from 'vitest';
import {
  checkPowWork,
  createPowChallenge,
  isAuthenticChallenge,
  leadingZeroBits,
  solvePow,
} from '../src/index.js';

const key = new Uint8Array(32).fill(7);

describe('leadingZeroBits', () => {
  it.each([
    [[0xff], 0],
    [[0x80], 0],
    [[0x7f], 1],
    [[0x01], 7],
    [[0x00, 0xff], 8],
    [[0x00, 0x0f], 12],
    [[0x00, 0x00], 16],
  ])('%j → %i', (bytes, n) => {
    expect(leadingZeroBits(Uint8Array.from(bytes))).toBe(n);
  });
});

describe('PoW challenge', () => {
  it('is authentic only with the server key and unmodified fields', () => {
    const c = createPowChallenge(key, 'evt1', 8, 600);
    expect(isAuthenticChallenge(key, c)).toBe(true);
    expect(isAuthenticChallenge(new Uint8Array(32), c)).toBe(false);
    expect(isAuthenticChallenge(key, { ...c, difficulty: 0 })).toBe(false);
    expect(isAuthenticChallenge(key, { ...c, eventId: 'evt2' })).toBe(false);
    expect(isAuthenticChallenge(key, { ...c, expiresAt: c.expiresAt + 1 })).toBe(false);
    expect(isAuthenticChallenge(key, { ...c, id: 'zz' })).toBe(false);
  });

  it('solves and verifies', () => {
    const c = createPowChallenge(key, 'evt1', 10, 600);
    const nonce = solvePow(c);
    expect(nonce).not.toBeNull();
    expect(checkPowWork(c, nonce!)).toBe(true);
  });

  it('rejects insufficient work', () => {
    const c = createPowChallenge(key, 'evt1', 24, 600);
    // the first nonces almost surely do not reach 24 bits
    const bad = [0, 1, 2, 3].filter((n) => !checkPowWork(c, n));
    expect(bad.length).toBeGreaterThan(0);
    expect(checkPowWork(c, -1)).toBe(false);
    expect(checkPowWork(c, 1.5)).toBe(false);
  });

  it('difficulty 0 accepts anything and limits are enforced', () => {
    const c = createPowChallenge(key, 'evt1', 0, 600);
    expect(checkPowWork(c, 0)).toBe(true);
    expect(() => createPowChallenge(key, 'evt1', 33, 600)).toThrow(RangeError);
    expect(solvePow(createPowChallenge(key, 'e', 32, 1), { maxAttempts: 10 })).toBeNull();
  });

  it('handles nonces above 2^32', () => {
    const c = createPowChallenge(key, 'evt1', 4, 600);
    const n = solvePow(c, { startNonce: 2 ** 33 });
    expect(n).toBeGreaterThanOrEqual(2 ** 33);
    expect(checkPowWork(c, n!)).toBe(true);
  });
});
