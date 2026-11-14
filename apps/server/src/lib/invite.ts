import { createHmac } from 'node:crypto';

/** Case- and separator-insensitive, so "abcd-efgh" and "ABCDEFGH" are the same code. */
export function normalizeInviteCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Only this keyed hash is stored. HMAC (rather than plain SHA-256) so that a leaked database
 * does not allow offline guessing of short codes.
 */
export function inviteCodeHash(key: Uint8Array, eventId: string, code: string): string {
  return createHmac('sha256', key)
    .update(`${eventId}\n${normalizeInviteCode(code)}`)
    .digest('hex');
}
