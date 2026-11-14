/**
 * Binary-safe JSON for Marmot store values (they contain Uint8Array; plain JSON corrupts them).
 */
const U8 = '__u8';
const BIG = '__bigint';

export function encodeValue(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key, v: unknown) {
    const raw = this[key];
    if (raw instanceof Uint8Array) return { [U8]: Buffer.from(raw).toString('base64') };
    if (typeof raw === 'bigint') return { [BIG]: raw.toString() };
    return v;
  });
}

export function decodeValue(text: string): unknown {
  return JSON.parse(text, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 1 && typeof o[U8] === 'string')
        return new Uint8Array(Buffer.from(o[U8], 'base64'));
      if (keys.length === 1 && typeof o[BIG] === 'string') return BigInt(o[BIG]);
    }
    return v;
  });
}
