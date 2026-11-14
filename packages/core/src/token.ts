/**
 * Compact text encoding of a token for QR codes and string backups.
 *
 *   "KAMEN1" + base32(RFC 4648, upper-case, no padding)(payload || checksum)
 *
 * The alphabet (A-Z, 2-7) fits the QR "alphanumeric" mode, which packs 5.5 bits per character
 * instead of 8, so the code stays small enough to scan quickly from a phone screen. The trailing
 * "1" of the prefix is not a base32 character and doubles as a separator.
 *
 * payload (version 1):
 *   u8   version (=1)
 *   u8   kind              1=ticket 2=room 3=stamp
 *   u8   flags             bit0: DLEQ present
 *   u8   eventId length L  (0..64; 0 for host-scoped tokens such as stamps)
 *   L    eventId           UTF-8
 *   8    keysetId
 *   32   secret
 *   33   C                 compressed point
 *   [32  dleq.e, 32 dleq.s, 32 dleq.r]   if bit0
 * checksum: first 4 bytes of SHA-256(payload) — catches typos in hand-copied backups.
 *
 * This is intentionally not a `cashuB` token: Kamen tokens carry no monetary value and must not be
 * mistaken for ecash by Cashu wallets.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base32nopad } from '@scure/base';
import { bytesToHex, hexToBytes, isHex, pointFromHex, scalarFromHex } from './hex.js';
import { isKeysetId, KEYSET_ID_BYTES, KEYSET_KINDS, type KeysetKind } from './keyset.js';
import { isSecret, SECRET_BYTES, type Proof } from './ticket.js';

export const TOKEN_PREFIX = 'KAMEN1';
export const TOKEN_VERSION = 1;
export const MAX_EVENT_ID_BYTES = 64;

const POINT_BYTES = 33;
const SCALAR_BYTES = 32;
const CHECKSUM_BYTES = 4;
const HEADER_BYTES = 4;
const FLAG_DLEQ = 0x01;

export interface Token extends Proof {
  kind: KeysetKind;
  /** Event the token belongs to. Empty string for host-scoped tokens (stamps). */
  eventId: string;
}

export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

function kindToByte(kind: KeysetKind): number {
  const i = KEYSET_KINDS.indexOf(kind);
  if (i < 0) throw new InvalidTokenError(`unknown kind: ${String(kind)}`);
  return i + 1;
}

function byteToKind(b: number): KeysetKind {
  const kind = KEYSET_KINDS[b - 1];
  if (kind === undefined) throw new InvalidTokenError(`unknown kind byte: ${b}`);
  return kind;
}

function checksum(payload: Uint8Array): Uint8Array {
  return sha256(payload).subarray(0, CHECKSUM_BYTES);
}

function validate(token: Token): void {
  kindToByte(token.kind);
  if (!isKeysetId(token.keysetId)) throw new InvalidTokenError('invalid keysetId');
  if (!isSecret(token.secret)) throw new InvalidTokenError('invalid secret');
  try {
    pointFromHex(token.C);
    if (token.C.length !== POINT_BYTES * 2) throw new Error();
  } catch {
    throw new InvalidTokenError('invalid C');
  }
  if (token.dleq) {
    const { e, s, r } = token.dleq;
    if (!isHex(e, SCALAR_BYTES) || !isHex(s, SCALAR_BYTES)) {
      throw new InvalidTokenError('invalid dleq');
    }
    try {
      scalarFromHex(r, 'dleq.r');
    } catch {
      throw new InvalidTokenError('invalid dleq.r');
    }
  }
}

export function encodeToken(token: Token): string {
  validate(token);
  const eventId = utf8ToBytes(token.eventId);
  if (eventId.length > MAX_EVENT_ID_BYTES) throw new InvalidTokenError('eventId too long');

  const parts: Uint8Array[] = [
    Uint8Array.of(
      TOKEN_VERSION,
      kindToByte(token.kind),
      token.dleq ? FLAG_DLEQ : 0,
      eventId.length,
    ),
    eventId,
    hexToBytes(token.keysetId),
    hexToBytes(token.secret),
    hexToBytes(token.C),
  ];
  if (token.dleq) {
    parts.push(hexToBytes(token.dleq.e), hexToBytes(token.dleq.s), hexToBytes(token.dleq.r));
  }
  const payload = concat(parts);
  return TOKEN_PREFIX + base32nopad.encode(concat([payload, checksum(payload)]));
}

export function decodeToken(text: string): Token {
  const trimmed = text.trim().toUpperCase().replace(/[\s-]/g, '');
  if (!trimmed.startsWith(TOKEN_PREFIX)) throw new InvalidTokenError('missing prefix');

  let bytes: Uint8Array;
  try {
    bytes = base32nopad.decode(trimmed.slice(TOKEN_PREFIX.length));
  } catch {
    throw new InvalidTokenError('invalid base32');
  }
  if (bytes.length < HEADER_BYTES + CHECKSUM_BYTES) throw new InvalidTokenError('too short');

  const payload = bytes.subarray(0, bytes.length - CHECKSUM_BYTES);
  const sum = bytes.subarray(bytes.length - CHECKSUM_BYTES);
  if (!equalBytes(sum, checksum(payload))) throw new InvalidTokenError('checksum mismatch');

  const version = payload[0] as number;
  const kindByte = payload[1] as number;
  const flags = payload[2] as number;
  const eventIdLen = payload[3] as number;
  if (version !== TOKEN_VERSION) throw new InvalidTokenError(`unsupported version: ${version}`);
  if ((flags & ~FLAG_DLEQ) !== 0) throw new InvalidTokenError('unknown flags');
  if (eventIdLen > MAX_EVENT_ID_BYTES) throw new InvalidTokenError('eventId too long');
  const hasDleq = (flags & FLAG_DLEQ) !== 0;

  const expected =
    HEADER_BYTES +
    eventIdLen +
    KEYSET_ID_BYTES +
    SECRET_BYTES +
    POINT_BYTES +
    (hasDleq ? SCALAR_BYTES * 3 : 0);
  if (payload.length !== expected) throw new InvalidTokenError('unexpected length');

  let off = HEADER_BYTES;
  const take = (n: number): Uint8Array => payload.subarray(off, (off += n));

  let eventId: string;
  try {
    eventId = new TextDecoder('utf-8', { fatal: true }).decode(take(eventIdLen));
  } catch {
    throw new InvalidTokenError('eventId is not valid UTF-8');
  }

  const token: Token = {
    kind: byteToKind(kindByte),
    eventId,
    keysetId: bytesToHex(take(KEYSET_ID_BYTES)),
    secret: bytesToHex(take(SECRET_BYTES)),
    C: bytesToHex(take(POINT_BYTES)),
  };
  if (hasDleq) {
    token.dleq = {
      e: bytesToHex(take(SCALAR_BYTES)),
      s: bytesToHex(take(SCALAR_BYTES)),
      r: bytesToHex(take(SCALAR_BYTES)),
    };
  }
  validate(token);
  return token;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export interface QrPolicy {
  /** Whether the event allows offline check-in (docs/SPEC.md §4 「運用上の決めごと」). */
  offlineCheckin: boolean;
}

/**
 * Text for the door QR code. The DLEQ proof (which contains the blinding factor r) is included
 * only when the event uses offline check-in, because only then does the scanner need to verify
 * the signature without the server. Otherwise anyone who sees the QR — including staff devices —
 * learns nothing that could be matched against an issuance (docs/PRIVACY.md).
 *
 * Backups use plain `encodeToken()` and keep the DLEQ: they never leave the participant.
 */
export function encodeQrToken(token: Token, policy: QrPolicy): string {
  if (policy.offlineCheckin || !token.dleq) return encodeToken(token);
  const { dleq: _dleq, ...withoutDleq } = token;
  return encodeToken(withoutDleq);
}
