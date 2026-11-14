/**
 * High-level issue / redeem lifecycle on top of BDHKE (docs/SPEC.md §4).
 *
 *   participant                         server
 *   prepareIssue()  ── IssueRequest ──▶  signIssueRequest()   (sees only B_, stores nothing)
 *   finalizeIssue() ◀─ IssueResponse ──
 *   ... later, at the door ...
 *   scanner: verifyProofOffline()        (public key only, uses the DLEQ incl. r)
 *   scanner: toRedeemPayload() ────────▶ verifyProofWithKeyset() + spentKey() lookup
 */
import { randomBytes } from '@noble/hashes/utils.js';
import {
  blind,
  hashToCurve,
  secretToMessage,
  signBlinded,
  unblind,
  verify,
  verifyBlindDleq,
  verifyProofDleq,
  type BlindDleq,
  type ProofDleq,
} from './bdhke.js';
import { assertHex, bytesToHex, isHex } from './hex.js';
import type { Keyset, PublicKeyset } from './keyset.js';

export const SECRET_BYTES = 32;

/** Kept on the participant's device between the issue request and the response. Secret. */
export interface PendingIssue {
  keysetId: string;
  secret: string;
  r: string;
  B_: string;
}

/** The only thing sent to the server at issue time. */
export interface IssueRequest {
  keysetId: string;
  B_: string;
}

export interface IssueResponse {
  keysetId: string;
  C_: string;
  dleq: BlindDleq;
}

/** An unblinded token held by the participant. */
export interface Proof {
  keysetId: string;
  /** 32 random bytes as lower-case hex. Y = hashToCurve(utf8(secret)). */
  secret: string;
  /** Unblinded signature C = kY (33-byte compressed hex). */
  C: string;
  /** NUT-12 proof incl. blinding factor r; lets anyone with the public key verify offline. */
  dleq?: ProofDleq;
}

/** What the scanner sends to the server to redeem: the DLEQ (and its r) is deliberately dropped. */
export interface RedeemPayload {
  keysetId: string;
  secret: string;
  C: string;
}

export class InvalidSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSignatureError';
  }
}

export function createSecret(): string {
  return bytesToHex(randomBytes(SECRET_BYTES));
}

export function isSecret(value: unknown): value is string {
  return isHex(value, SECRET_BYTES);
}

/** Participant: draw a fresh secret and blinding factor for `keyset`. */
export function prepareIssue(keyset: PublicKeyset): PendingIssue {
  const secret = createSecret();
  const { B_, r } = blind(secretToMessage(secret));
  return { keysetId: keyset.id, secret, r, B_ };
}

export function toIssueRequest(pending: PendingIssue): IssueRequest {
  return { keysetId: pending.keysetId, B_: pending.B_ };
}

/** Server: sign a blinded message. The caller must not persist `request.B_`. */
export function signIssueRequest(request: IssueRequest, keyset: Keyset): IssueResponse {
  if (request.keysetId !== keyset.id) {
    throw new InvalidSignatureError('keyset id mismatch');
  }
  const { C_, dleq } = signBlinded(request.B_, keyset.privateKey);
  return { keysetId: keyset.id, C_, dleq };
}

/**
 * Participant: verify the DLEQ against the keyset's public key, then unblind.
 * Throws InvalidSignatureError if the server signed with a different key than it advertises
 * (which could be used to tag individual participants).
 */
export function finalizeIssue(
  pending: PendingIssue,
  response: IssueResponse,
  keyset: PublicKeyset,
): Proof {
  if (response.keysetId !== pending.keysetId || response.keysetId !== keyset.id) {
    throw new InvalidSignatureError('keyset id mismatch');
  }
  if (!verifyBlindDleq(response.dleq, pending.B_, response.C_, keyset.publicKey)) {
    throw new InvalidSignatureError('invalid DLEQ proof from signer');
  }
  const C = unblind(response.C_, pending.r, keyset.publicKey);
  return {
    keysetId: keyset.id,
    secret: pending.secret,
    C,
    dleq: { e: response.dleq.e, s: response.dleq.s, r: pending.r },
  };
}

/** Offline check with only the public key. Requires the proof to carry its DLEQ. */
export function verifyProofOffline(proof: Proof, keyset: PublicKeyset): boolean {
  if (proof.keysetId !== keyset.id || !proof.dleq || !isSecret(proof.secret)) return false;
  return verifyProofDleq(secretToMessage(proof.secret), proof.C, proof.dleq, keyset.publicKey);
}

/** Server: authoritative check with the private key (k * Y == C). */
export function verifyProofWithKeyset(proof: RedeemPayload, keyset: Keyset): boolean {
  if (proof.keysetId !== keyset.id || !isSecret(proof.secret)) return false;
  return verify(secretToMessage(proof.secret), proof.C, keyset.privateKey);
}

/**
 * The value stored in the `spent` table (docs/SPEC.md §7 `spent.y`): Y = hashToCurve(secret),
 * the same identifier Cashu mints use (NUT-07).
 */
export function spentKey(secret: string): string {
  assertHex(secret, SECRET_BYTES, 'secret');
  return hashToCurve(secretToMessage(secret));
}

/**
 * Strip the DLEQ before anything is sent to the server. With `r` (or e, s) the server could
 * recompute B_ and match it against an issuance it might have logged in violation of policy
 * (NUT-12 "Privacy" note). The server never needs it: it verifies with the private key.
 */
export function toRedeemPayload(proof: Proof): RedeemPayload {
  return { keysetId: proof.keysetId, secret: proof.secret, C: proof.C };
}
