import { pointFromHex, signIssueRequest, spentKey, verifyProofWithKeyset } from '@kamen/core';
import { z } from 'zod';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import {
  apiError,
  ensureEventKeyset,
  getEvent,
  hostStampKeyset,
  loadKeyset,
  type AppContext,
} from '../context.js';
import { refundDeposit } from '../lib/deposits.js';
import { keysets, scannerLinks, spent } from '../db/schema.js';
import { sha256Hex } from '../lib/secrets.js';
import { jsonBody } from '../lib/validate.js';
import { proofSchema } from './public.js';

export const BUCKET_MS = 15 * 60 * 1000;

/**
 * The ticket (no DLEQ) plus optional check-in extras from the door QR: blinded messages for the
 * participant's stamp and vote credential, and a deposit refund reference.
 */
const redeemSchema = proofSchema.extend({
  stampB_: z
    .string()
    .regex(/^0[23][0-9a-f]{64}$/)
    .optional(),
  voteB_: z
    .string()
    .regex(/^0[23][0-9a-f]{64}$/)
    .optional(),
  depositRef: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .optional(),
});

const PENDING_SIGNATURE_MS = 24 * 60 * 60 * 1000;

type ScannerEnv = { Variables: { scannerExpiresAt: number } };

function voteKeyset(ctx: AppContext, eventId: string) {
  ensureEventKeyset(ctx, eventId, 'vote');
  return loadKeyset(ctx, eventId, 'vote');
}

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
      offlineCheckin: row.offlineCheckin,
      status: row.status,
    });
  });

  /**
   * Spent identifiers (Y = hashToCurve(secret)) of the event's tickets, so a scanner going
   * offline already knows tickets used at other devices. Only for offline check-in events.
   * The list contains no times and no order (it is sorted by Y).
   */
  app.get('/events/:id/spent', scannerAuth, (c) => {
    const row = getEvent(ctx, c.req.param('id'));
    if (!row.offlineCheckin) apiError(403, 'offline_checkin_disabled');
    const ys = ctx.db
      .select({ y: spent.y })
      .from(spent)
      .innerJoin(keysets, eq(keysets.id, spent.keysetId))
      .where(and(eq(keysets.eventId, row.id), eq(keysets.kind, 'ticket')))
      .orderBy(spent.y)
      .all()
      .map((r) => r.y);
    return c.json({ ys });
  });

  /**
   * Check a ticket in. The insert into `spent` and the counter update happen in one transaction;
   * the primary key on (keyset_id, y) makes a second redemption of the same ticket impossible.
   */
  app.post('/events/:id/redeem', scannerAuth, async (c) => {
    const body = await jsonBody(c, redeemSchema);
    const proof = body;
    const ticketProof = { keysetId: body.keysetId, secret: body.secret, C: body.C };
    const row = getEvent(ctx, c.req.param('id'));
    if (row.status === 'cancelled') apiError(410, 'event_cancelled');
    if (row.status !== 'published') apiError(403, 'event_not_published');

    const keyset = loadKeyset(ctx, row.id, 'ticket');
    if (proof.keysetId !== keyset.id || !verifyProofWithKeyset(ticketProof, keyset)) {
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

    // Sign the check-in extras. They are stored only under the random blinded message, for the
    // participant to fetch once (GET /api/stamps/:blinded); the final tokens are unlinkable.
    const pending = sqlite.prepare(
      'INSERT OR IGNORE INTO pending_signatures (blinded, kind, payload, expires_at) VALUES (?, ?, ?, ?)',
    );
    const expires = now + PENDING_SIGNATURE_MS;
    const extras: { stamp: boolean; vote: boolean; deposit: string | null } = {
      stamp: false,
      vote: false,
      deposit: null,
    };
    for (const [kind, B_] of [
      ['stamp', proof.stampB_],
      ['vote', proof.voteB_],
    ] as const) {
      if (!B_) continue;
      try {
        pointFromHex(B_);
        const ks =
          kind === 'stamp' ? hostStampKeyset(ctx, row.hostPubkey) : voteKeyset(ctx, row.id);
        const sig = signIssueRequest({ keysetId: ks.id, B_ }, ks);
        pending.run(B_, kind, JSON.stringify(sig), expires);
        extras[kind] = true;
      } catch {
        /* an invalid extra never blocks the entry */
      }
    }
    if (proof.depositRef) extras.deposit = await refundDeposit(ctx, row, proof.depositRef);

    return c.json({ ok: true, redeemed, capacity: row.capacity, issued: row.issuedCount, extras });
  });

  return app;
}
