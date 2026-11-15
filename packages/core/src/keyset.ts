import { deriveKeysetId } from '@cashu/cashu-ts';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { assertHex, bytesToHex, hexToBytes, isHex, pointFromHex } from './hex.js';

/**
 * ticket: one entry to one event (per event)
 * room:   one pass into the event's Marmot room (per event)
 * stamp:  attendance stamp (per host; does not reveal which event)
 * vote:   check-in credential for anonymous polls, questions and draws (per event)
 */
export const KEYSET_KINDS = ['ticket', 'room', 'stamp', 'vote'] as const;
export type KeysetKind = (typeof KEYSET_KINDS)[number];

/** Every token has the same, single denomination. Tokens never represent sats. */
export const TOKEN_AMOUNT = 1;

export interface PublicKeyset {
  /** NUT-02 v1 keyset id: "00" + 14 hex chars (8 bytes). */
  id: string;
  kind: KeysetKind;
  /** Compressed secp256k1 public key for amount 1 (33-byte hex). */
  publicKey: string;
}

export interface Keyset extends PublicKeyset {
  /** 32-byte hex. Server-side only; must be stored encrypted (docs/SPEC.md §7). */
  privateKey: string;
}

export const KEYSET_ID_BYTES = 8;

export function isKeysetKind(value: unknown): value is KeysetKind {
  return typeof value === 'string' && (KEYSET_KINDS as readonly string[]).includes(value);
}

/**
 * NUT-02 v1 keyset id over the single amount-1 key. We use v1 (8 bytes) instead of v2 (33 bytes)
 * to keep the QR code small; ids are only meaningful within one Kamen server.
 */
export function keysetIdFromPublicKey(publicKey: string): string {
  pointFromHex(publicKey);
  return deriveKeysetId({ [String(TOKEN_AMOUNT)]: publicKey }, { versionByte: 0 });
}

export function generateKeyset(kind: KeysetKind): Keyset {
  if (!isKeysetKind(kind)) throw new TypeError(`unknown keyset kind: ${String(kind)}`);
  const sk = secp256k1.utils.randomSecretKey();
  const publicKey = bytesToHex(secp256k1.getPublicKey(sk, true));
  return { id: keysetIdFromPublicKey(publicKey), kind, publicKey, privateKey: bytesToHex(sk) };
}

export function keysetFromPrivateKey(kind: KeysetKind, privateKey: string): Keyset {
  assertHex(privateKey, 32, 'privateKey');
  const publicKey = bytesToHex(secp256k1.getPublicKey(hexToBytes(privateKey), true));
  return { id: keysetIdFromPublicKey(publicKey), kind, publicKey, privateKey };
}

export function toPublicKeyset(keyset: Keyset): PublicKeyset {
  return { id: keyset.id, kind: keyset.kind, publicKey: keyset.publicKey };
}

export function isKeysetId(value: unknown): value is string {
  return isHex(value, KEYSET_ID_BYTES) && value.startsWith('00');
}
