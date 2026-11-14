import {
  checkPowWork,
  createPowChallenge,
  isAuthenticChallenge,
  isKeysetId,
  pointFromHex,
  signIssueRequest,
  type IssueResponse,
  type KeysetKind,
} from '@kamen/core';
import { Hono } from 'hono';
import { z } from 'zod';
import { apiError, getEvent, loadKeyset, toPublicEvent, type AppContext } from '../context.js';
import { jsonBody } from '../lib/validate.js';

const hex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));

const powSchema = z.object({
  challenge: z.object({
    eventId: z.string().max(64),
    salt: hex(16),
    expiresAt: z.number().int(),
    difficulty: z.number().int().min(0).max(32),
    id: hex(32),
  }),
  nonce: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const blindedOutput = z.object({ keysetId: z.string().refine(isKeysetId), B_: hex(33) });

const issueSchema = z.object({
  pow: powSchema,
  // Keyed by kind so the room pass can be issued alongside the ticket in phase 3.
  outputs: z.object({ ticket: blindedOutput }).strict(),
});

/** Kinds that may be issued at the moment. 'room' is added in phase 3. */
const ISSUABLE_KINDS: readonly KeysetKind[] = ['ticket'];

export function publicRoutes(ctx: AppContext) {
  const app = new Hono();

  app.get('/events/:id', (c) => {
    return c.json(toPublicEvent(ctx, getEvent(ctx, c.req.param('id'))));
  });

  app.get('/events/:id/cover', (c) => {
    const row = getEvent(ctx, c.req.param('id'));
    if (!row.coverImage || !row.coverMime) apiError(404, 'no_cover');
    return c.body(new Uint8Array(row.coverImage), 200, {
      'Content-Type': row.coverMime,
      // URLs carry ?v=<cover_version>, so the image can be cached indefinitely.
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });

  /** Free events: hand out a proof-of-work challenge. (Paid events: invoice, phase 2.) */
  app.post('/events/:id/quote', (c) => {
    const row = getEvent(ctx, c.req.param('id'));
    assertIssuable(ctx, row);
    const challenge = createPowChallenge(
      ctx.powKey,
      row.id,
      ctx.config.powDifficulty,
      ctx.config.powTtlSeconds,
      Math.floor(ctx.now() / 1000),
    );
    return c.json({ kind: 'pow', challenge });
  });

  /**
   * Sign the participant's blinded messages. Nothing about the request is stored:
   * the only persistent effect is issued_count + 1 (and the PoW id, in memory, until expiry).
   */
  app.post('/events/:id/issue', async (c) => {
    const body = await jsonBody(c, issueSchema);
    const row = getEvent(ctx, c.req.param('id'));
    assertIssuable(ctx, row);

    const { challenge, nonce } = body.pow;
    const nowMs = ctx.now();
    if (!isAuthenticChallenge(ctx.powKey, challenge) || challenge.eventId !== row.id) {
      apiError(422, 'invalid_pow');
    }
    if (challenge.expiresAt * 1000 <= nowMs) apiError(422, 'pow_expired');
    if (!checkPowWork(challenge, nonce)) apiError(422, 'invalid_pow');

    const requested = Object.keys(body.outputs) as KeysetKind[];
    for (const kind of requested)
      if (!ISSUABLE_KINDS.includes(kind)) apiError(422, 'unsupported_kind');
    const keysets = requested.map((kind) => ({ kind, keyset: loadKeyset(ctx, row.id, kind) }));
    for (const { kind, keyset } of keysets) {
      const out = body.outputs[kind as 'ticket'];
      if (out.keysetId !== keyset.id) apiError(422, 'keyset_mismatch');
      try {
        pointFromHex(out.B_);
      } catch {
        apiError(422, 'invalid_blinded_message');
      }
    }

    if (!ctx.usedPow.add(challenge.id, challenge.expiresAt * 1000, nowMs)) {
      apiError(409, 'pow_already_used');
    }

    const sqlite = ctx.db.$client;
    const signatures = sqlite.transaction(() => {
      const taken = sqlite
        .prepare(
          `UPDATE events SET issued_count = issued_count + 1
           WHERE id = ? AND status = 'published' AND issued_count < capacity`,
        )
        .run(row.id);
      if (taken.changes !== 1) apiError(409, 'sold_out');
      const out: Partial<Record<KeysetKind, IssueResponse>> = {};
      for (const { kind, keyset } of keysets) {
        out[kind] = signIssueRequest(body.outputs[kind as 'ticket'], keyset);
      }
      return out;
    })();

    return c.json({
      signatures,
      // Ticket holders learn a hidden location at issue time, so they never have to present
      // their ticket (and thus link a later request to it) just to read it.
      location: row.locationVisibility === 'ticket_holders' ? row.location : null,
    });
  });

  return app;
}

function assertIssuable(ctx: AppContext, row: { status: string; endsAt: number }): void {
  if (row.status === 'cancelled') apiError(410, 'event_cancelled');
  if (row.status !== 'published') apiError(403, 'event_not_published');
  if (row.endsAt <= ctx.now()) apiError(410, 'event_ended');
}
