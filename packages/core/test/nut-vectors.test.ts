/**
 * Official Cashu test vectors, copied verbatim from
 *   https://github.com/cashubtc/nuts/blob/1363de413294e2ef3a57b16950f9506af38fffc2/tests/00-tests.md
 *   https://github.com/cashubtc/nuts/blob/1363de413294e2ef3a57b16950f9506af38fffc2/tests/12-tests.md
 * (Token V3/V4 serialization vectors from 00-tests.md are not applicable: Kamen uses its own
 * non-monetary token format, see src/token.ts.)
 */
import { describe, expect, it } from 'vitest';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  blind,
  hashE,
  hashToCurve,
  hexToBytes,
  signBlinded,
  verifyBlindDleq,
  verifyProofDleq,
} from '../src/index.js';

describe('NUT-00 hash_to_curve', () => {
  it.each([
    [
      '0000000000000000000000000000000000000000000000000000000000000000',
      '024cce997d3b518f739663b757deaec95bcd9473c30a14ac2fd04023a739d1a725',
    ],
    [
      '0000000000000000000000000000000000000000000000000000000000000001',
      '022e7158e11c9506f1aa4248bf531298daa7febd6194f003edcd9b93ade6253acf',
    ],
    [
      // takes a few iterations of the counter loop
      '0000000000000000000000000000000000000000000000000000000000000002',
      '026cdbe15362df59cd1dd3c9c11de8aedac2106eca69236ecd9fbe117af897be4f',
    ],
  ])('message %s', (message, point) => {
    expect(hashToCurve(hexToBytes(message))).toBe(point);
  });
});

describe('NUT-00 blinded messages', () => {
  it.each([
    [
      'd341ee4871f1f889041e63cf0d3823c713eea6aff01e80f1719f08f9e5be98f6',
      '99fce58439fc37412ab3468b73db0569322588f62fb3a49182d67e23d877824a',
      '033b1a9737a40cc3fd9b6af4b723632b76a67a36782596304612a6c2bfb5197e6d',
    ],
    [
      'f1aaf16c2239746f369572c0784d9dd3d032d952c2d992175873fb58fae31a60',
      'f78476ea7cc9ade20f9e05e58a804cf19533f03ea805ece5fee88c8e2874ba50',
      '029bdf2d716ee366eddf599ba252786c1033f47e230248a4612a5670ab931f1763',
    ],
  ])('x=%s', (x, r, B_) => {
    expect(blind(hexToBytes(x), r)).toEqual({ B_, r });
  });
});

describe('NUT-00 blinded signatures', () => {
  const B_ = '02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2';
  it.each([
    [
      '0000000000000000000000000000000000000000000000000000000000000001',
      '02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2',
    ],
    [
      '7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f',
      '0398bc70ce8184d27ba89834d19f5199c84443c31131e48d3c1214db24247d005d',
    ],
  ])('k=%s', (k, C_) => {
    expect(signBlinded(B_, k).C_).toBe(C_);
  });
});

describe('NUT-12 hash_e', () => {
  it('matches the reference digest', () => {
    const one = '020000000000000000000000000000000000000000000000000000000000000001';
    const C_ = '02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2';
    expect(hashE([one, one, one, C_])).toBe(
      'a4dc034b74338c28c6bc3ea49731f2a24440fc7c4affc08b31a93fc9fbe6401e',
    );
  });
});

describe('NUT-12 deterministic nonce derivation', () => {
  const a = '0000000000000000000000000000000000000000000000000000000000000002';
  const A = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
  const B_ = '02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2';
  const C_ = '0244eccfc7a348274458bb38044c7f3c389b3c2086c7ec18b5812d2877ab937787';

  it('reproduces C_, e and s exactly', () => {
    const sig = signBlinded(B_, a);
    expect(sig.C_).toBe(C_);
    expect(sig.dleq).toEqual({
      e: '2a16ffee280aff3c429045607f9b8e0bf8b35910c44c1b20b9dfaf01b263d7b3',
      s: '9df27731238334718d120d4f74611a7c668233f988e687ac3fb188f0a34a2dab',
    });
  });

  it('the resulting proof verifies', () => {
    expect(verifyBlindDleq(signBlinded(B_, a).dleq, B_, C_, A)).toBe(true);
  });
});

describe('NUT-12 DLEQ verification on BlindSignature', () => {
  const A = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  const B_ = '02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2';
  const C_ = '02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2';
  const dleq = {
    e: '9818e061ee51d5c8edc3342369a554998ff7b4381c8652d724cdf46429be73d9',
    s: '9818e061ee51d5c8edc3342369a554998ff7b4381c8652d724cdf46429be73da',
  };

  it('accepts the valid proof', () => {
    expect(verifyBlindDleq(dleq, B_, C_, A)).toBe(true);
  });

  it('rejects a tampered proof', () => {
    expect(verifyBlindDleq({ ...dleq, s: dleq.e }, B_, C_, A)).toBe(false);
    const otherA = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
    expect(verifyBlindDleq(dleq, B_, C_, otherA)).toBe(false);
  });
});

describe('NUT-12 DLEQ verification on Proof', () => {
  const A = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  const secret = 'daf4dd00a2b68a0858a80450f52c8a7d2ccf87d375e43e216e0c571f089f63e9';
  const C = '024369d2d22a80ecf78f3937da9d5f30c1b9f74f0c32684d583cca0fa6a61cdcfc';
  const dleq = {
    e: 'b31e58ac6527f34975ffab13e70a48b6d2b0d35abc4b03f0151f09ee1a9763d4',
    s: '8fbae004c59e754d71df67e392b6ae4e29293113ddc2ec86592a0431d16306d8',
    r: 'a6d13fcd7a18442e6076f5e1e7c887ad5de40a019824bdfa9fe740d302e8d861',
  };

  it('accepts the valid proof (secret hashed as UTF-8 string)', () => {
    expect(verifyProofDleq(utf8ToBytes(secret), C, dleq, A)).toBe(true);
  });

  it('rejects a wrong blinding factor, secret or key', () => {
    const r2 = '0000000000000000000000000000000000000000000000000000000000000001';
    expect(verifyProofDleq(utf8ToBytes(secret), C, { ...dleq, r: r2 }, A)).toBe(false);
    expect(verifyProofDleq(utf8ToBytes(secret.replace(/^d/, 'e')), C, dleq, A)).toBe(false);
    const otherA = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
    expect(verifyProofDleq(utf8ToBytes(secret), C, dleq, otherA)).toBe(false);
  });
});
