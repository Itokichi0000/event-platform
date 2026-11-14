import { describe, expect, it } from 'vitest';
import {
  decodeToken,
  encodeToken,
  finalizeIssue,
  generateKeyset,
  InvalidTokenError,
  prepareIssue,
  signIssueRequest,
  toIssueRequest,
  toPublicKeyset,
  TOKEN_PREFIX,
  verifyProofOffline,
  type Token,
} from '../src/index.js';

function makeToken(eventId = 'evt_01JABCDEF', kind: Token['kind'] = 'ticket'): Token {
  const keyset = generateKeyset(kind);
  const pub = toPublicKeyset(keyset);
  const pending = prepareIssue(pub);
  const proof = finalizeIssue(pending, signIssueRequest(toIssueRequest(pending), keyset), pub);
  return { kind, eventId, ...proof };
}

describe('token encoding', () => {
  it('round-trips a ticket with DLEQ', () => {
    const t = makeToken();
    const text = encodeToken(t);
    expect(text.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(decodeToken(text)).toEqual(t);
  });

  it('uses only QR alphanumeric-mode characters', () => {
    const text = encodeToken(makeToken());
    expect(text).toMatch(/^[0-9A-Z $%*+\-./:]+$/);
  });

  it('stays short enough for a quick-scanning QR code', () => {
    // 4 header + 11 eventId + 8 + 32 + 33 + 96 + 4 checksum = 188 bytes → 301 base32 chars
    expect(encodeToken(makeToken()).length).toBeLessThanOrEqual(310);
  });

  it('round-trips without DLEQ and with an empty eventId (host-scoped stamp)', () => {
    const { dleq: _dleq, ...t } = makeToken('', 'stamp');
    expect(decodeToken(encodeToken(t))).toEqual(t);
  });

  it('round-trips a room token and a UTF-8 event id', () => {
    const t = makeToken('勉強会-2026', 'room');
    expect(decodeToken(encodeToken(t))).toEqual(t);
  });

  it('a decoded token still verifies offline', () => {
    const keyset = generateKeyset('ticket');
    const pub = toPublicKeyset(keyset);
    const pending = prepareIssue(pub);
    const proof = finalizeIssue(pending, signIssueRequest(toIssueRequest(pending), keyset), pub);
    const decoded = decodeToken(encodeToken({ kind: 'ticket', eventId: 'e1', ...proof }));
    expect(verifyProofOffline(decoded, pub)).toBe(true);
  });

  it('tolerates whitespace, hyphens and lower case in pasted backups', () => {
    const t = makeToken();
    const text = encodeToken(t);
    const messy = `  ${text.slice(0, 20).toLowerCase()}\n${text.slice(20, 40)}-${text.slice(40)}  `;
    expect(decodeToken(messy)).toEqual(t);
  });

  it('detects a typo via the checksum', () => {
    const text = encodeToken(makeToken());
    const i = 40;
    const typo = text.slice(0, i) + (text[i] === 'A' ? 'B' : 'A') + text.slice(i + 1);
    expect(() => decodeToken(typo)).toThrow(/checksum/);
  });

  it.each([
    ['', /prefix/],
    ['cashuBabc', /prefix/],
    [TOKEN_PREFIX + '0189', /base32/],
    [TOKEN_PREFIX + 'AAAA', /short/],
  ])('rejects %j', (text, msg) => {
    expect(() => decodeToken(text)).toThrow(InvalidTokenError);
    expect(() => decodeToken(text)).toThrow(msg);
  });

  it('rejects invalid fields on encode', () => {
    const t = makeToken();
    expect(() => encodeToken({ ...t, keysetId: '01abcdef01234567' })).toThrow(/keysetId/);
    expect(() => encodeToken({ ...t, secret: 'ab' })).toThrow(/secret/);
    expect(() => encodeToken({ ...t, C: '02' + '00'.repeat(32) })).toThrow(/C/);
    expect(() => encodeToken({ ...t, eventId: 'x'.repeat(65) })).toThrow(/eventId/);
    expect(() => encodeToken({ ...t, kind: 'sats' as never })).toThrow(/kind/);
    expect(() => encodeToken({ ...t, dleq: { ...t.dleq!, r: '00'.repeat(32) } })).toThrow(/dleq/);
  });
});
