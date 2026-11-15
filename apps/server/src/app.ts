import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppContext } from './context.js';
import { privacyLogger } from './lib/logger.js';
import { hostAdminRoutes } from './routes/host-admin.js';
import { hostRoutes } from './routes/host.js';
import { attendeeRoutes } from './routes/attendee.js';
import { hostFeatureRoutes } from './routes/host-features.js';
import { publicRoutes } from './routes/public.js';
import { scannerRoutes } from './routes/scanner.js';

export interface AppOptions {
  log?: (line: string) => void;
}

export function createApp(ctx: AppContext, opts: AppOptions = {}) {
  const log = opts.log ?? console.log;
  const app = new Hono();

  app.use('*', privacyLogger(log));
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', c.res.headers.get('Cache-Control') ?? 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
  });

  // `rooms`: whether ROOM_RELAYS is configured (public information: the relays are, too).
  app.get('/api/health', (c) => c.json({ ok: true, rooms: ctx.agent !== null }));
  app.route('/api', scannerRoutes(ctx));
  app.route('/api', hostRoutes(ctx));
  app.route('/api', hostAdminRoutes(ctx));
  app.route('/api', hostFeatureRoutes(ctx));
  app.route('/api', attendeeRoutes(ctx));
  app.route('/api', publicRoutes(ctx));

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.res ?? c.json({ error: err.message || 'error' }, err.status);
    }
    // Log only the error itself, never the request (headers, body, client address).
    log(`error: ${err.name}: ${err.message}`);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
