/**
 * Proof-of-work for free events (docs/SPEC.md §2, §7): abuse protection without IP addresses.
 *
 * The server hands out a stateless challenge authenticated with an HMAC, so it does not have to
 * remember who asked for one. The participant searches for a nonce such that
 *   SHA-256(challengeId || nonce_u64_le)
 * has at least `difficulty` leading zero bits. `challengeId` (= the MAC) is single-use; the server
 * keeps used ids only until they expire.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { assertHex, bytesToHex, hexToBytes, isHex } from './hex.js';

export const POW_MAX_DIFFICULTY = 32;

export interface PowChallenge {
  eventId: string;
  /** 16 random bytes, hex. */
  salt: string;
  /** Unix seconds. */
  expiresAt: number;
  difficulty: number;
  /** HMAC over the fields above; also the single-use challenge id. 32-byte hex. */
  id: string;
}

export interface PowSolution {
  challenge: PowChallenge;
  /** Non-negative integer < 2^53. */
  nonce: number;
}

function macInput(c: Omit<PowChallenge, 'id'>): Uint8Array {
  return utf8ToBytes(`kamen-pow-v1|${c.eventId}|${c.salt}|${c.expiresAt}|${c.difficulty}`);
}

function assertDifficulty(difficulty: number): void {
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > POW_MAX_DIFFICULTY) {
    throw new RangeError(`difficulty must be an integer in 0..${POW_MAX_DIFFICULTY}`);
  }
}

/** Server: create an authenticated challenge. `key` is a server secret (>= 32 bytes). */
export function createPowChallenge(
  key: Uint8Array,
  eventId: string,
  difficulty: number,
  ttlSeconds: number,
  now = Math.floor(Date.now() / 1000),
): PowChallenge {
  assertDifficulty(difficulty);
  const body = { eventId, salt: bytesToHex(randomBytes(16)), expiresAt: now + ttlSeconds, difficulty };
  return { ...body, id: bytesToHex(hmac(sha256, key, macInput(body))) };
}

/** Server: true if the challenge was issued by us (does not check expiry or work). */
export function isAuthenticChallenge(key: Uint8Array, c: PowChallenge): boolean {
  if (!isHex(c.id, 32) || !isHex(c.salt, 16)) return false;
  if (!Number.isInteger(c.expiresAt) || typeof c.eventId !== 'string') return false;
  try {
    assertDifficulty(c.difficulty);
  } catch {
    return false;
  }
  const expected = hmac(sha256, key, macInput(c));
  const given = hexToBytes(c.id);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= (expected[i] as number) ^ (given[i] as number);
  return diff === 0;
}

export function leadingZeroBits(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

function writeNonce(buf: Uint8Array, offset: number, nonce: number): void {
  let lo = nonce >>> 0;
  let hi = Math.floor(nonce / 0x1_0000_0000);
  for (let i = 0; i < 4; i++) {
    buf[offset + i] = lo & 0xff;
    lo >>>= 8;
  }
  for (let i = 4; i < 8; i++) {
    buf[offset + i] = hi & 0xff;
    hi >>>= 8;
  }
}

function workBuffer(challengeId: string): Uint8Array {
  assertHex(challengeId, 32, 'challenge id');
  const buf = new Uint8Array(40);
  buf.set(hexToBytes(challengeId));
  return buf;
}

/** True if `nonce` satisfies the challenge's difficulty. */
export function checkPowWork(challenge: PowChallenge, nonce: number): boolean {
  if (!Number.isSafeInteger(nonce) || nonce < 0) return false;
  const buf = workBuffer(challenge.id);
  writeNonce(buf, 32, nonce);
  return leadingZeroBits(sha256(buf)) >= challenge.difficulty;
}

export interface SolveOptions {
  startNonce?: number;
  /** Called every `progressEvery` attempts with the number of attempts so far. */
  onProgress?: (attempts: number) => void;
  progressEvery?: number;
  /** Give up after this many attempts (returns null). */
  maxAttempts?: number;
}

/** Participant (normally inside a Web Worker): brute-force a nonce. */
export function solvePow(challenge: PowChallenge, opts: SolveOptions = {}): number | null {
  const buf = workBuffer(challenge.id);
  const every = opts.progressEvery ?? 50_000;
  const max = opts.maxAttempts ?? Number.MAX_SAFE_INTEGER;
  let nonce = opts.startNonce ?? 0;
  for (let attempts = 1; attempts <= max; attempts++, nonce++) {
    writeNonce(buf, 32, nonce);
    if (leadingZeroBits(sha256(buf)) >= challenge.difficulty) return nonce;
    if (opts.onProgress && attempts % every === 0) opts.onProgress(attempts);
  }
  return null;
}
