import {
  checkPowWork,
  createPowChallenge,
  isAuthenticChallenge,
  isKeysetId,
  isSecret,
  pointFromHex,
  signIssueRequest,
  spentKey,
  verifyProofWithKeyset,
  type IssueResponse,
  type KeysetKind,
} from '@kamen/core';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  apiError,
  ensureRoomKeyset,
  getEvent,
  loadKeyset,
  remainingSeats,
  roomAvailable,
  toPublicEvent,
  type AppContext,
} from '../context.js';
import { AgentRequestError } from '../lib/agent-client.js';
import { quotes, type EventRow } from '../db/schema.js';
import { inviteCodeHash } from '../lib/invite.js';
import { randomToken } from '../lib/secrets.js';
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
  /** Free (`pow`) and invite-only (`invite`) events. */
  pow: powSchema.optional(),
  /** Invite-only events. */
  invite: z.string().min(1).max(64).optional(),
  /** Paid events: a paid quote id. */
  quoteId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{20,64}$/)
    .optional(),
  // Keyed by kind: the room pass is signed with its own keyset (unlinkable to the ticket).
  outputs: z.object({ ticket: blindedOutput, room: blindedOutput.optional() }).strict(),
});

/** Exactly what `toRedeemPayload()` produces: no DLEQ, no blinding factor. */
export const proofSchema = z
  .object({
    keysetId: z.string().refine(isKeysetId),
    secret: z.string().refine(isSecret),
    C: z.string().regex(/^0[23][0-9a-f]{64}$/),
  })
  .strict();

const joinSchema = z.object({
  pass: z.lazy(() => proofSchema),
  /** Kind 30443 key package signed by the participant's per-event key (not published to relays). */
  keyPackage: z.object({
    id: z.string().regex(/^[0-9a-f]{64}$/),
    pubkey: z.string().regex(/^[0-9a-f]{64}$/),
    created_at: z.number().int(),
    kind: z.literal(30443),
    tags: z.array(z.array(z.string())).max(50),
    content: z.string().max(60_000),
    sig: z.string().regex(/^[0-9a-f]{128}$/),
  }),
});

/** Expired quotes are still looked up for a while in case the payment landed at the deadline. */
const LATE_PAYMENT_GRACE_MS = 60 * 60 * 1000;

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

  /**
   * Free / invite-only events: a proof-of-work challenge.
   * Paid events: a Lightning invoice created in the host's wallet. The quote id returned is the
   * participant's claim to one ticket once paid; nothing about the payer is recorded.
   */
  app.post('/events/:id/quote', async (c) => {
    const row = getEvent(ctx, c.req.param('id'));
    assertIssuable(ctx, row);

    if (row.issuePolicy !== 'paid') {
      const challenge = createPowChallenge(
        ctx.powKey,
        row.id,
        ctx.config.powDifficulty,
        ctx.config.powTtlSeconds,
        Math.floor(ctx.now() / 1000),
      );
      return c.json({ kind: 'pow', challenge });
    }

    if (!row.nwcEnc) apiError(409, 'payments_not_configured');
    if (remainingSeats(ctx, row) <= 0) apiError(409, 'sold_out');
    const uri = ctx.vault.decrypt(row.nwcEnc, `nwc:${row.id}`);
    let invoice;
    try {
      invoice = await ctx.payments
        .wallet(row.id, uri)
        .makeInvoice(row.priceMsat, `${row.title} (Kamen)`, ctx.config.invoiceTtlSeconds);
    } catch {
      apiError(502, 'wallet_unavailable');
    }
    const id = randomToken();
    ctx.db
      .insert(quotes)
      .values({
        id,
        eventId: row.id,
        paymentHash: invoice.paymentHash,
        state: 'unpaid',
        expiresAt: invoice.expiresAt,
      })
      .run();
    void ctx.payments.watch(row.id, uri);
    return c.json({
      kind: 'invoice',
      quoteId: id,
      invoice: invoice.invoice,
      amountMsat: row.priceMsat,
      expiresAt: invoice.expiresAt,
    });
  });

  /** Payment status of a quote. Asks the host's wallet (lookup_invoice) while unpaid. */
  app.get('/events/:id/quotes/:qid', async (c) => {
    const row = getEvent(ctx, c.req.param('id'));
    const quote = await refreshQuote(ctx, row, c.req.param('qid'));
    return c.json({ state: quote.state, expiresAt: quote.expiresAt });
  });

  /**
   * Sign the participant's blinded messages. Nothing about the request is stored: the persistent
   * effects are issued_count + 1 and, depending on the policy, one invite use or the quote moving
   * to `issued`. No column links a quote or code to the blinded message.
   */
  app.post('/events/:id/issue', async (c) => {
    const body = await jsonBody(c, issueSchema);
    const row = getEvent(ctx, c.req.param('id'));
    assertIssuable(ctx, row);

    // A room pass is issued only while the room is available; otherwise it is silently omitted
    // so that getting a ticket never depends on the room.
    const withRoom = body.outputs.room !== undefined && roomAvailable(ctx, row);
    if (withRoom) ensureRoomKeyset(ctx, row.id);
    const requested: ('ticket' | 'room')[] = withRoom ? ['ticket', 'room'] : ['ticket'];
    const keysets = requested.map((kind) => ({ kind, keyset: loadKeyset(ctx, row.id, kind) }));
    for (const { kind, keyset } of keysets) {
      const out = body.outputs[kind]!;
      if (out.keysetId !== keyset.id) apiError(422, 'keyset_mismatch');
      try {
        pointFromHex(out.B_);
      } catch {
        apiError(422, 'invalid_blinded_message');
      }
    }

    let inviteHash: string | null = null;
    if (row.issuePolicy === 'paid') {
      if (!body.quoteId) apiError(422, 'quote_required');
      const quote = await refreshQuote(ctx, row, body.quoteId);
      if (quote.state === 'issued') apiError(409, 'quote_already_used');
      if (quote.state !== 'paid') apiError(402, 'quote_not_paid');
    } else {
      if (!body.pow) apiError(422, 'pow_required');
      if (row.issuePolicy === 'invite') {
        if (!body.invite) apiError(422, 'invite_required');
        inviteHash = inviteCodeHash(ctx.inviteKey, row.id, body.invite);
      }
      const { challenge, nonce } = body.pow;
      const nowMs = ctx.now();
      if (!isAuthenticChallenge(ctx.powKey, challenge) || challenge.eventId !== row.id) {
        apiError(422, 'invalid_pow');
      }
      if (challenge.expiresAt * 1000 <= nowMs) apiError(422, 'pow_expired');
      if (!checkPowWork(challenge, nonce)) apiError(422, 'invalid_pow');
      if (!ctx.usedPow.add(challenge.id, challenge.expiresAt * 1000, nowMs)) {
        apiError(409, 'pow_already_used');
      }
    }

    const sqlite = ctx.db.$client;
    const signatures = sqlite.transaction(() => {
      if (row.issuePolicy === 'paid') {
        const used = sqlite
          .prepare(
            `UPDATE quotes SET state = 'issued' WHERE id = ? AND event_id = ? AND state = 'paid'`,
          )
          .run(body.quoteId, row.id);
        if (used.changes !== 1) apiError(409, 'quote_already_used');
        // The seat was held since payment, so no capacity check here.
        const taken = sqlite
          .prepare(
            `UPDATE events SET issued_count = issued_count + 1 WHERE id = ? AND status = 'published'`,
          )
          .run(row.id);
        if (taken.changes !== 1) apiError(409, 'event_not_published');
      } else {
        if (inviteHash) {
          const used = sqlite
            .prepare(
              `UPDATE invite_codes SET uses_left = uses_left - 1
               WHERE event_id = ? AND code_hash = ? AND uses_left > 0`,
            )
            .run(row.id, inviteHash);
          if (used.changes !== 1) apiError(403, 'invalid_invite');
        }
        const taken = sqlite
          .prepare(
            `UPDATE events SET issued_count = issued_count + 1
             WHERE id = ? AND status = 'published' AND issued_count < capacity`,
          )
          .run(row.id);
        if (taken.changes !== 1) apiError(409, 'sold_out');
      }
      const out: Partial<Record<KeysetKind, IssueResponse>> = {};
      for (const { kind, keyset } of keysets) {
        out[kind] = signIssueRequest(body.outputs[kind]!, keyset);
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

  /**
   * Give a ticket back before the event: it becomes spent and the seat is released.
   * Returned and redeemed tickets look the same in `spent`. No refund: the server holds no funds.
   */
  app.post('/events/:id/return', async (c) => {
    const proof = await jsonBody(c, proofSchema);
    const row = getEvent(ctx, c.req.param('id'));
    if (row.status !== 'published') apiError(409, 'event_not_published');
    if (row.endsAt <= ctx.now()) apiError(410, 'event_ended');
    const keyset = loadKeyset(ctx, row.id, 'ticket');
    if (proof.keysetId !== keyset.id || !verifyProofWithKeyset(proof, keyset)) {
      apiError(422, 'invalid_ticket');
    }
    const sqlite = ctx.db.$client;
    sqlite.transaction(() => {
      const ins = sqlite
        .prepare('INSERT INTO spent (keyset_id, y) VALUES (?, ?) ON CONFLICT DO NOTHING')
        .run(keyset.id, spentKey(proof.secret));
      if (ins.changes === 0) apiError(409, 'already_redeemed');
      sqlite
        .prepare(
          `UPDATE events SET issued_count = issued_count - 1, returned_count = returned_count + 1
           WHERE id = ?`,
        )
        .run(row.id);
    })();
    return c.json({ ok: true });
  });

  /**
   * Enter the event's room: spend the room pass, then ask the room agent to add the participant's
   * per-event key. If the agent fails, the pass is restored. The pass is a blind signature from
   * the room keyset, so it cannot be linked to the ticket or to the issuance.
   */
  app.post(
    '/events/:id/room/join',
    bodyLimit({ maxSize: 96 * 1024, onError: () => apiError(413, 'body_too_large') }),
    async (c) => {
      const body = await jsonBody(c, joinSchema);
      const row = getEvent(ctx, c.req.param('id'));
      if (!ctx.agent || !roomAvailable(ctx, row)) apiError(409, 'room_unavailable');
      ensureRoomKeyset(ctx, row.id);
      const keyset = loadKeyset(ctx, row.id, 'room');
      if (body.pass.keysetId !== keyset.id || !verifyProofWithKeyset(body.pass, keyset)) {
        apiError(422, 'invalid_pass');
      }
      const y = spentKey(body.pass.secret);
      const sqlite = ctx.db.$client;
      const ins = sqlite
        .prepare('INSERT INTO spent (keyset_id, y) VALUES (?, ?) ON CONFLICT DO NOTHING')
        .run(keyset.id, y);
      if (ins.changes === 0) apiError(409, 'pass_already_used');
      try {
        return c.json(await ctx.agent.join(row.id, row.title, row.endsAt, body.keyPackage));
      } catch (e) {
        sqlite.prepare('DELETE FROM spent WHERE keyset_id = ? AND y = ?').run(keyset.id, y);
        if (e instanceof AgentRequestError && e.code === 'invalid_key_package') {
          apiError(400, 'invalid_key_package');
        }
        apiError(503, 'room_unavailable');
      }
    },
  );

  return app;
}

function assertIssuable(ctx: AppContext, row: EventRow): void {
  if (row.status === 'cancelled') apiError(410, 'event_cancelled');
  if (row.status !== 'published') apiError(403, 'event_not_published');
  if (row.endsAt <= ctx.now()) apiError(410, 'event_ended');
}

/** Load a quote and, while it is unpaid, ask the host's wallet whether it was paid. */
async function refreshQuote(ctx: AppContext, row: EventRow, quoteId: string) {
  const quote = ctx.db
    .select()
    .from(quotes)
    .where(and(eq(quotes.id, quoteId), eq(quotes.eventId, row.id)))
    .get();
  if (!quote) apiError(404, 'quote_not_found');
  const now = ctx.now();
  const checkable =
    (quote.state === 'unpaid' || quote.state === 'expired') &&
    now < quote.expiresAt + LATE_PAYMENT_GRACE_MS &&
    row.nwcEnc !== null;
  if (!checkable) return quote;

  let state = quote.state;
  try {
    const uri = ctx.vault.decrypt(row.nwcEnc as string, `nwc:${row.id}`);
    const res = await ctx.payments.wallet(row.id, uri).lookupInvoice(quote.paymentHash);
    if (res === 'settled') state = 'paid';
    else if (now >= quote.expiresAt || res === 'expired' || res === 'failed') state = 'expired';
  } catch {
    // Wallet unreachable: report the stored state; the participant can retry.
    if (now >= quote.expiresAt && state === 'unpaid') state = 'expired';
  }
  if (state !== quote.state) {
    ctx.db
      .update(quotes)
      .set({ state })
      .where(and(eq(quotes.id, quote.id), eq(quotes.state, quote.state)))
      .run();
  }
  return { ...quote, state };
}
