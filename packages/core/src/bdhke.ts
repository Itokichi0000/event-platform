/**
 * Cashu NUT-00 blind Diffie-Hellman key exchange (BDHKE) and NUT-12 DLEQ proofs.
 *
 * This module does not implement any curve arithmetic itself: every operation is delegated to
 * the audited primitives exported by `@cashu/cashu-ts` (which in turn use `@noble/curves`).
 * The wrappers only convert between hex strings and points so callers can store / transmit
 * values as JSON. Correctness is pinned by the official NUT-00 / NUT-12 test vectors.
 *
 * Notation (NUT-00): secret `x`, Y = hashToCurve(x), blinding factor `r`,
 * B_ = Y + rG, C_ = kB_, C = C_ - rK = kY.
 */
import {
  blindMessage,
  createBlindSignature,
  createDLEQProof,
  hashToCurve as cashuHashToCurve,
  hash_e,
  unblindSignature,
  verifyDLEQProof,
  verifyDLEQProof_reblind,
  verifyUnblindedSignature,
} from '@cashu/cashu-ts';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  assertHex,
  bytesToHex,
  hexToBytes,
  pointFromHex,
  pointToHex,
  scalarFromHex,
  scalarToHex,
} from './hex.js';

/** DLEQ proof as returned by the signer alongside a blind signature (NUT-12). */
export interface BlindDleq {
  e: string;
  s: string;
}

/** DLEQ proof carried with an unblinded proof; includes the blinding factor `r` (NUT-12). */
export interface ProofDleq extends BlindDleq {
  r: string;
}

export interface BlindedMessage {
  /** Blinded point B_ (33-byte compressed hex). */
  B_: string;
  /** Blinding factor r (32-byte hex). Secret: never leaves the participant's device. */
  r: string;
}

export interface BlindSignature {
  /** Blind signature C_ = kB_ (33-byte compressed hex). */
  C_: string;
  dleq: BlindDleq;
}

/** Y = hashToCurve(message) as compressed hex. `message` is raw bytes. */
export function hashToCurve(message: Uint8Array): string {
  return pointToHex(cashuHashToCurve(message));
}

/** NUT-12 `hash_e` over a list of points (hex in, 32-byte hex out). */
export function hashE(points: string[]): string {
  return bytesToHex(hash_e(points.map(pointFromHex)));
}

/** Alice: B_ = hashToCurve(message) + rG. A fresh random r is drawn unless one is given. */
export function blind(message: Uint8Array, r?: string): BlindedMessage {
  const raw = blindMessage(message, r === undefined ? undefined : scalarFromHex(r, 'r'));
  return { B_: pointToHex(raw.B_), r: scalarToHex(raw.r) };
}

/** Bob: C_ = kB_ plus a deterministic NUT-12 DLEQ proof that log_G(K) == log_B_(C_). */
export function signBlinded(B_: string, privateKey: string): BlindSignature {
  assertHex(privateKey, 32, 'privateKey');
  const k = hexToBytes(privateKey);
  const B = pointFromHex(B_);
  // The keyset id argument is only echoed back by cashu-ts; it does not affect the math.
  const { C_ } = createBlindSignature(B, k, '00');
  const { e, s } = createDLEQProof(B, k);
  return { C_: pointToHex(C_), dleq: { e: bytesToHex(e), s: bytesToHex(s) } };
}

/** Alice: C = C_ - rK. */
export function unblind(C_: string, r: string, publicKey: string): string {
  return pointToHex(
    unblindSignature(pointFromHex(C_), scalarFromHex(r, 'r'), pointFromHex(publicKey)),
  );
}

/** Bob: checks k * hashToCurve(message) == C. Needs the private key. */
export function verify(message: Uint8Array, C: string, privateKey: string): boolean {
  try {
    assertHex(privateKey, 32, 'privateKey');
    return verifyUnblindedSignature(
      { C: pointFromHex(C), secret: message, id: '00' },
      hexToBytes(privateKey),
    );
  } catch {
    return false;
  }
}

/** Alice: verifies the DLEQ returned with a blind signature (needs B_, C_, A). */
export function verifyBlindDleq(
  dleq: BlindDleq,
  B_: string,
  C_: string,
  publicKey: string,
): boolean {
  try {
    assertHex(dleq.e, 32, 'dleq.e');
    assertHex(dleq.s, 32, 'dleq.s');
    return verifyDLEQProof(
      { e: hexToBytes(dleq.e), s: hexToBytes(dleq.s) },
      pointFromHex(B_),
      pointFromHex(C_),
      pointFromHex(publicKey),
    );
  } catch {
    return false;
  }
}

/**
 * Carol (e.g. the offline scanner): verifies an unblinded proof (x, C) using only the public key,
 * by reconstructing B_ = Y + rG and C_ = C + rA from the carried blinding factor r.
 */
export function verifyProofDleq(
  message: Uint8Array,
  C: string,
  dleq: ProofDleq,
  publicKey: string,
): boolean {
  try {
    assertHex(dleq.e, 32, 'dleq.e');
    assertHex(dleq.s, 32, 'dleq.s');
    return verifyDLEQProof_reblind(
      message,
      { e: hexToBytes(dleq.e), s: hexToBytes(dleq.s), r: scalarFromHex(dleq.r, 'dleq.r') },
      pointFromHex(C),
      pointFromHex(publicKey),
    );
  } catch {
    return false;
  }
}

/**
 * Cashu convention: a proof's secret is a string and hashToCurve is applied to its UTF-8 bytes.
 * Our secrets are 32 random bytes rendered as 64 lower-case hex characters.
 */
export function secretToMessage(secret: string): Uint8Array {
  return utf8ToBytes(secret);
}
