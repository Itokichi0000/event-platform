import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

export { bytesToHex, hexToBytes };

export type Point = InstanceType<typeof secp256k1.Point>;

const HEX_RE = /^(?:[0-9a-f]{2})*$/;

/** Lower-case, even-length hex with an optional exact byte length. */
export function isHex(value: unknown, byteLength?: number): value is string {
  if (typeof value !== 'string' || !HEX_RE.test(value)) return false;
  return byteLength === undefined || value.length === byteLength * 2;
}

export function assertHex(
  value: unknown,
  byteLength: number,
  name: string,
): asserts value is string {
  if (!isHex(value, byteLength)) {
    throw new TypeError(`${name} must be ${byteLength}-byte lower-case hex`);
  }
}

/** Parses a SEC1 (compressed or uncompressed) point. Throws on invalid / infinity. */
export function pointFromHex(hex: string): Point {
  const p = secp256k1.Point.fromHex(hex);
  p.assertValidity();
  return p;
}

export function pointToHex(p: Point): string {
  return p.toHex(true);
}

export function scalarToHex(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

/** Parses a 32-byte hex scalar and checks 0 < n < curve order. */
export function scalarFromHex(hex: string, name = 'scalar'): bigint {
  assertHex(hex, 32, name);
  const n = BigInt('0x' + hex);
  if (!secp256k1.Point.Fn.isValidNot0(n)) {
    throw new RangeError(`${name} is out of range`);
  }
  return n;
}
