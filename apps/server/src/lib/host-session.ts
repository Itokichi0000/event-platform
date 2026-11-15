/**
 * Short-lived host session tokens, so the dashboard does not ask the Nostr extension to sign a
 * NIP-98 event for every poll. A token is obtained with one NIP-98-signed request and is
 * stateless: "kh1." + base64url(pubkey || expiresAt) + "." + base64url(HMAC). Nothing is stored.
 * The web app keeps it in sessionStorage (not a cookie), so it disappears with the tab.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const HOST_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PREFIX = 'kh1.';

export function createHostSession(key: Uint8Array, pubkey: string, now: number) {
  const expiresAt = now + HOST_SESSION_TTL_MS;
  const body = Buffer.from(`${pubkey}|${expiresAt}`, 'utf8').toString('base64url');
  const mac = createHmac('sha256', key).update(body).digest('base64url');
  return { token: `${PREFIX}${body}.${mac}`, expiresAt };
}

/** Returns the host pubkey, or null if the token is invalid or expired. */
export function verifyHostSession(key: Uint8Array, token: string, now: number): string | null {
  if (!token.startsWith(PREFIX)) return null;
  const [body, mac] = token.slice(PREFIX.length).split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', key).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [pubkey, exp] = Buffer.from(body, 'base64url').toString('utf8').split('|');
  if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey) || !exp || Number(exp) <= now) return null;
  return pubkey;
}
