import { isKeysetId, isSecret, spentKey, verifyProofWithKeyset } from '@kamen/core';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { apiError, getEvent, loadKeyset, type AppContext } from '../context.js';
import { scannerLinks } from '../db/schema.js';
import { sha256Hex } from '../lib/secrets.js';
import { jsonBody } from '../lib/validate.js';

export const BUCKET_MS = 15 * 60 * 1000;

/** Exactly what `toRedeemPayload()` produces: no DLEQ, no blinding factor. */
const redeemSchema = z
  .object({
    keysetId: z.string().refine(isKeysetId),
    secret: z.string().refine(isSecret),
    C: z.string().regex(/^0[23][0-9a-f]{64}$/),
  })
  .strict();

type ScannerEnv = { Variables: { scannerExpiresAt: number } };

export function scannerRoutes(ctx: AppContext) {
  const app = new Hono<ScannerEnv>();

  /** Bearer token from a check-in link; valid for one event until it expires or is revoked. */
  const scannerAuth = createMiddleware<ScannerEnv>(async (c, next) => {
    const m = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(c.req.header('authorization') ?? '');
    if (!m) apiError(401, 'missing_scanner_token');
    const link = ctx.db
      .select({ expiresAt: scannerLinks.expiresAt })
      .from(scannerLinks)
      .where(
        and(
          eq(scannerLinks.tokenHash, sha256Hex(m[1] as string)),
          eq(scannerLinks.eventId, c.req.param('id') ?? ''),
          isNull(scannerLinks.revokedAt),
          gt(scannerLinks.expiresAt, ctx.now()),
        ),
      )
      .get();
    if (!link) apiError(401, 'invalid_scanner_token');
    c.set('scannerExpiresAt', link.expiresAt);
    await next();
  });

  app.get('/events/:id/scanner-session', scannerAuth, (c) => {
    const row = getEvent(ctx, c.req.param('id'));
    return c.json({
      eventId: row.id,
      title: row.title,
      expiresAt: c.get('scannerExpiresAt'),
      issued: row.issuedCount,
      redeemed: row.redeemedCount,
    });
  });

  /**
   * Check a ticket in. The insert into `spent` and the counter update happen in one transaction;
   * the primary key on (keyset_id, y) makes a second redemption of the same ticket impossible.
   */
  app.post('/events/:id/redeem', scannerAuth, async (c) => {
    const proof = await jsonBody(c, redeemSchema);
    const row = getEvent(ctx, c.req.param('id'));
    if (row.status === 'cancelled') apiError(410, 'event_cancelled');
    if (row.status !== 'published') apiError(403, 'event_not_published');

    const keyset = loadKeyset(ctx, row.id, 'ticket');
    if (proof.keysetId !== keyset.id || !verifyProofWithKeyset(proof, keyset)) {
      apiError(422, 'invalid_ticket');
    }

    const y = spentKey(proof.secret);
    const now = ctx.now();
    const sqlite = ctx.db.$client;
    const redeemed = sqlite.transaction(() => {
      const ins = sqlite
        .prepare('INSERT INTO spent (keyset_id, y) VALUES (?, ?) ON CONFLICT DO NOTHING')
        .run(keyset.id, y);
      if (ins.changes === 0) apiError(409, 'already_redeemed');
      sqlite
        .prepare('UPDATE events SET redeemed_count = redeemed_count + 1 WHERE id = ?')
        .run(row.id);
      sqlite
        .prepare(
          `INSERT INTO checkin_buckets (event_id, bucket_start, count) VALUES (?, ?, 1)
           ON CONFLICT (event_id, bucket_start) DO UPDATE SET count = count + 1`,
        )
        .run(row.id, Math.floor(now / BUCKET_MS) * BUCKET_MS);
      return (
        sqlite.prepare('SELECT redeemed_count AS n FROM events WHERE id = ?').get(row.id) as {
          n: number;
        }
      ).n;
    })();

    return c.json({ ok: true, redeemed, capacity: row.capacity, issued: row.issuedCount });
  });

  return app;
}
