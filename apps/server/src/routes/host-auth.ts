import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import { apiError, type AppContext } from '../context.js';
import { hosts } from '../db/schema.js';
import { nip98Auth, type HostEnv } from '../lib/nip98.js';
import { deriveKey } from '../lib/secrets.js';

/**
 * Middleware for host endpoints. Applied per route, because host paths share prefixes with
 * public ones. Host registration is implicit on first authenticated use.
 */
export function hostMiddleware(ctx: AppContext) {
  const sessionKey = deriveKey(ctx.config.masterKey, 'host-session');
  const strictAuth = nip98Auth({ publicOrigin: ctx.config.publicOrigin, now: ctx.now });
  const auth = nip98Auth({ publicOrigin: ctx.config.publicOrigin, now: ctx.now, sessionKey });
  const limit = bodyLimit({ maxSize: 64 * 1024, onError: () => apiError(413, 'body_too_large') });
  const register = createMiddleware<HostEnv>(async (c, next) => {
    ctx.db
      .insert(hosts)
      .values({ pubkey: c.get('hostPubkey') })
      .onConflictDoNothing()
      .run();
    await next();
  });
  return { sessionKey, strictAuth, auth, limit, register, host: [limit, auth, register] as const };
}
