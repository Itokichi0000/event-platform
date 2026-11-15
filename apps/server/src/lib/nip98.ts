/**
 * NIP-98 HTTP auth for host endpoints.
 *   Authorization: Nostr base64(JSON(kind-27235 event))
 * The event must be signed, fresh (±60 s), single-use, and bind the URL, method and body hash.
 */
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure';
import { verifyHostSession } from './host-session.js';
import { sha256Hex } from './secrets.js';
import { TtlSet } from './ttl-set.js';

export const NIP98_KIND = 27235;
const MAX_SKEW_SECONDS = 60;

export interface Nip98Options {
  publicOrigin: string | undefined;
  now?: () => number;
  /** When set, `Authorization: Bearer kh1.…` host session tokens are accepted as well. */
  sessionKey?: Uint8Array;
}

export type HostEnv = { Variables: { hostPubkey: string } };

function fail(message: string): never {
  throw new HTTPException(401, { message });
}

function tag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

export function nip98Auth(opts: Nip98Options) {
  const seen = new TtlSet();
  const now = opts.now ?? Date.now;

  return createMiddleware<HostEnv>(async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    if (opts.sessionKey && header.startsWith('Bearer ')) {
      const pubkey = verifyHostSession(opts.sessionKey, header.slice(7).trim(), now());
      if (!pubkey) fail('invalid or expired host session');
      c.set('hostPubkey', pubkey);
      return next();
    }
    const m = /^Nostr\s+([A-Za-z0-9+/=_-]+)$/.exec(header);
    if (!m) fail('missing NIP-98 authorization');

    let event: NostrEvent;
    try {
      event = JSON.parse(Buffer.from(m[1] as string, 'base64').toString('utf8')) as NostrEvent;
    } catch {
      fail('malformed NIP-98 token');
    }
    if (typeof event !== 'object' || event === null || !Array.isArray(event.tags)) {
      fail('malformed NIP-98 token');
    }
    if (event.kind !== NIP98_KIND) fail('wrong event kind');
    if (!verifyEvent(event)) fail('bad signature');

    const nowMs = now();
    if (Math.abs(event.created_at - nowMs / 1000) > MAX_SKEW_SECONDS) fail('stale token');

    if ((tag(event, 'method') ?? '').toUpperCase() !== c.req.method.toUpperCase()) {
      fail('method mismatch');
    }

    let signedUrl: URL;
    try {
      signedUrl = new URL(tag(event, 'u') ?? '');
    } catch {
      fail('bad u tag');
    }
    const reqUrl = new URL(c.req.url);
    if (signedUrl.pathname !== reqUrl.pathname || signedUrl.search !== reqUrl.search) {
      fail('url mismatch');
    }
    if (opts.publicOrigin) {
      if (signedUrl.origin !== opts.publicOrigin) fail('origin mismatch');
    } else if (signedUrl.host !== (c.req.header('host') ?? reqUrl.host)) {
      fail('host mismatch');
    }

    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'DELETE') {
      const body = new Uint8Array(await c.req.arrayBuffer());
      if (body.length > 0 || tag(event, 'payload') !== undefined) {
        if (tag(event, 'payload') !== sha256Hex(body)) fail('payload hash mismatch');
      }
    }

    // Keyed on the signature: an exact copy of a token is rejected, while a client that signs
    // the same request twice within one second (same event id, fresh BIP-340 aux randomness) is not.
    if (!seen.add(event.sig, nowMs + 2 * MAX_SKEW_SECONDS * 1000, nowMs)) fail('replayed token');

    c.set('hostPubkey', event.pubkey);
    await next();
  });
}
