import { describe, expect, it } from 'vitest';
import { decodeValue, encodeValue } from '../src/marmot/index.js';

describe('store codec', () => {
  it('round-trips Uint8Array and bigint inside nested values', () => {
    const v = {
      a: new Uint8Array([0, 1, 255]),
      b: [1n, { c: new Uint8Array(0) }],
      d: 'x',
      e: null,
    };
    expect(decodeValue(encodeValue(v))).toEqual(v);
    expect(decodeValue(encodeValue(new Uint8Array([9])))).toEqual(new Uint8Array([9]));
  });
});
