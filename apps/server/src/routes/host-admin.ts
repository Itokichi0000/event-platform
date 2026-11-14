/** Owner-only settings: payment wallet (NWC), invite codes and co-hosts. */
import { randomBytes } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { decode as nip19decode } from 'nostr-tools/nip19';
import { z } from 'zod';
import { apiError, getManagedEvent, type AppContext } from '../context.js';
import { eventCohosts, events, inviteCodes } from '../db/schema.js';
import { inviteCodeHash, normalizeInviteCode } from '../lib/invite.js';
import type { HostEnv } from '../lib/nip98.js';
import { randomId } from '../lib/secrets.js';
import { jsonBody } from '../lib/validate.js';
import { InvalidNwcUriError, parseNwcUri } from '../lib/wallet.js';
import { hostMiddleware } from './host-auth.js';

/** Methods a ticket wallet needs, and ones it should not have (it only has to receive). */
const REQUIRED_METHODS = ['make_invoice', 'lookup_invoice'];
const SPENDING_METHODS = ['pay_invoice', 'multi_pay_invoice', 'pay_keysend', 'multi_pay_keysend'];

const walletSchema = z.object({ nwc: z.string().min(20).max(2000) });

const inviteSchema = z.object({
  /** Omit to let the server generate a random code. */
  code: z
    .string()
    .trim()
    .min(6)
    .max(64)
    .refine((c) => normalizeInviteCode(c).length >= 6, 'code too short')
    .optional(),
  label: z.string().trim().max(60).default(''),
  maxUses: z.number().int().min(1).max(10_000),
});

const cohostSchema = z.object({ pubkey: z.string().trim().min(1).max(200) });

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 10 characters from a 32-letter alphabet (50 bits), shown as XXXXX-XXXXX. */
function generateCode(): string {
  const bytes = randomBytes(10);
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b & 31]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

/** Accepts npub1… or 64-char hex. */
export function parsePubkey(input: string): string | null {
  const s = input.trim();
  if (/^[0-9a-f]{64}$/.test(s)) return s;
  try {
    const d = nip19decode(s);
    if (d.type === 'npub') return d.data;
  } catch {
    /* fallthrough */
  }
  return null;
}

export function hostAdminRoutes(ctx: AppContext) {
  const app = new Hono<HostEnv>();
  const { host } = hostMiddleware(ctx);
  const owned = (id: string, pubkey: string) =>
    getManagedEvent(ctx, id, pubkey, { ownerOnly: true });

  /**
   * Connect the host's wallet. The connection string is stored encrypted and is only used to
   * create and look up invoices; it is deleted 48 h after the event (jobs/cleanup.ts).
   */
  app.put('/events/:id/wallet', ...host, async (c) => {
    const row = owned(c.req.param('id'), c.get('hostPubkey'));
    const { nwc } = await jsonBody(c, walletSchema);
    try {
      parseNwcUri(nwc);
    } catch (e) {
      if (e instanceof InvalidNwcUriError) apiError(422, 'invalid_nwc_uri');
      throw e;
    }
    ctx.payments.forget(row.id);
    let methods: string[];
    try {
      methods = await ctx.payments.wallet(row.id, nwc.trim()).methods();
    } catch {
      ctx.payments.forget(row.id);
      apiError(502, 'wallet_unreachable');
    }
    const missing = REQUIRED_METHODS.filter((m) => !methods.includes(m));
    if (missing.length > 0) {
      ctx.payments.forget(row.id);
      return c.json({ error: 'wallet_missing_methods', missing }, 422);
    }
    ctx.db
      .update(events)
      .set({ nwcEnc: ctx.vault.encrypt(nwc.trim(), `nwc:${row.id}`), updatedAt: ctx.now() })
      .where(eq(events.id, row.id))
      .run();
    const warnings = methods.some((m) => SPENDING_METHODS.includes(m)) ? ['can_spend'] : [];
    return c.json({ connected: true, warnings });
  });

  app.delete('/events/:id/wallet', ...host, (c) => {
    const row = owned(c.req.param('id'), c.get('hostPubkey'));
    ctx.payments.forget(row.id);
    ctx.db
      .update(events)
      .set({ nwcEnc: null, updatedAt: ctx.now() })
      .where(eq(events.id, row.id))
      .run();
    return c.body(null, 204);
  });

  app.get('/events/:id/invite-codes', ...host, (c) => {
    const row = owned(c.req.param('id'), c.get('hostPubkey'));
    return c.json(
      ctx.db
        .select({
          id: inviteCodes.id,
          label: inviteCodes.label,
          maxUses: inviteCodes.maxUses,
          usesLeft: inviteCodes.usesLeft,
        })
        .from(inviteCodes)
        .where(eq(inviteCodes.eventId, row.id))
        .orderBy(asc(inviteCodes.label))
        .all(),
    );
  });

  /** Create an invite code. Only its keyed hash is stored; the code is returned once. */
  app.post('/events/:id/invite-codes', ...host, async (c) => {
    const row = owned(c.req.param('id'), c.get('hostPubkey'));
    const input = await jsonBody(c, inviteSchema);
    const code = input.code ?? generateCode();
    const id = randomId(16);
    try {
      ctx.db
        .insert(inviteCodes)
        .values({
          id,
          eventId: row.id,
          codeHash: inviteCodeHash(ctx.inviteKey, row.id, code),
          label: input.label,
          maxUses: input.maxUses,
          usesLeft: input.maxUses,
        })
        .run();
    } catch {
      apiError(409, 'invite_code_exists');
    }
    return c.json(
      { id, code, label: input.label, maxUses: input.maxUses, usesLeft: input.maxUses },
      201,
    );
  });

  app.delete('/events/:id/invite-codes/:cid', ...host, (c) => {
    const row = owned(c.req.param('id'), c.get('hostPubkey'));
    const res = ctx.db
      .delete(inviteCodes)
      .where(and(eq(inviteCodes.id, c.req.param('cid')), eq(inviteCodes.eventId, row.id)))
      .run();
    if (res.changes === 0) apiError(404, 'invite_code_not_found');
    return c.body(null, 204);
  });

  app.get('/events/:id/cohosts', ...host, (c) => {
    const row = owned(c.req.param('id'), c.get('hostPubkey'));
    return c.json(
      ctx.db
        .select({ pubkey: eventCohosts.pubkey })
        .from(eventCohosts)
        .where(eq(eventCohosts.eventId, row.id))
        .all(),
    );
  });

  app.post('/events/:id/cohosts', ...host, async (c) => {
    const row = owned(c.req.param('id'), c.get('hostPubkey'));
    const pubkey = parsePubkey((await jsonBody(c, cohostSchema)).pubkey);
    if (!pubkey) apiError(400, 'invalid_pubkey');
    if (pubkey === row.hostPubkey) apiError(409, 'already_owner');
    ctx.db.insert(eventCohosts).values({ eventId: row.id, pubkey }).onConflictDoNothing().run();
    return c.json({ pubkey }, 201);
  });

  app.delete('/events/:id/cohosts/:pubkey', ...host, (c) => {
    const row = owned(c.req.param('id'), c.get('hostPubkey'));
    const pubkey = parsePubkey(c.req.param('pubkey'));
    if (!pubkey) apiError(400, 'invalid_pubkey');
    const res = ctx.db
      .delete(eventCohosts)
      .where(and(eq(eventCohosts.eventId, row.id), eq(eventCohosts.pubkey, pubkey)))
      .run();
    if (res.changes === 0) apiError(404, 'cohost_not_found');
    return c.body(null, 204);
  });

  return app;
}
