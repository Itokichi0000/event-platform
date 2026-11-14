import { generateKeyset } from '@kamen/core';
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { apiError, getManagedEvent, toHostEvent, type AppContext } from '../context.js';
import {
  announcements,
  checkinBuckets,
  eventCohosts,
  events,
  keysets,
  scannerLinks,
} from '../db/schema.js';
import { createHostSession } from '../lib/host-session.js';
import type { HostEnv } from '../lib/nip98.js';
import { randomId, randomToken, sha256Hex } from '../lib/secrets.js';
import { jsonBody } from '../lib/validate.js';
import { hostMiddleware } from './host-auth.js';

export const MAX_COVER_BYTES = 512 * 1024;
const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const SCANNER_GRACE_MS = 6 * 60 * 60 * 1000;
/** Lightning cannot carry less than 1 sat in practice. */
const MIN_PRICE_MSAT = 1000;

const eventFields = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(5000),
  startsAt: z.number().int().positive(),
  endsAt: z.number().int().positive(),
  location: z.string().max(500),
  locationVisibility: z.enum(['public', 'ticket_holders']),
  capacity: z.number().int().min(1).max(10_000),
  issuePolicy: z.enum(['pow', 'invite', 'paid']),
  priceMsat: z.number().int().min(0).max(100_000_000_000),
  offlineCheckin: z.boolean(),
});

const createSchema = eventFields
  .extend({
    description: eventFields.shape.description.default(''),
    location: eventFields.shape.location.default(''),
    locationVisibility: eventFields.shape.locationVisibility.default('public'),
    issuePolicy: eventFields.shape.issuePolicy.default('pow'),
    priceMsat: eventFields.shape.priceMsat.default(0),
    offlineCheckin: eventFields.shape.offlineCheckin.default(false),
  })
  .refine((e) => e.endsAt > e.startsAt, 'endsAt must be after startsAt');

const patchSchema = eventFields
  .partial()
  .extend({ status: z.enum(['draft', 'published', 'cancelled']).optional() })
  .strict();

const announcementSchema = z.object({ body: z.string().trim().min(1).max(2000) });

const scannerLinkSchema = z.object({
  label: z.string().trim().max(60).default(''),
  /** Defaults to the event end + 6 h. */
  expiresAt: z.number().int().positive().optional(),
});

export function hostRoutes(ctx: AppContext) {
  const app = new Hono<HostEnv>();
  const { sessionKey, strictAuth, auth, limit, register, host } = hostMiddleware(ctx);

  /** Exchange one NIP-98 signature for a short-lived session token (see lib/host-session.ts). */
  app.post('/host/session', limit, strictAuth, register, (c) => {
    return c.json(createHostSession(sessionKey, c.get('hostPubkey'), ctx.now()));
  });

  /** Events the caller owns or co-hosts. */
  app.get('/host/events', ...host, (c) => {
    const me = c.get('hostPubkey');
    const cohosted = ctx.db
      .select({ id: eventCohosts.eventId })
      .from(eventCohosts)
      .where(eq(eventCohosts.pubkey, me))
      .all()
      .map((r) => r.id);
    const rows = ctx.db
      .select()
      .from(events)
      .where(
        cohosted.length > 0
          ? or(eq(events.hostPubkey, me), inArray(events.id, cohosted))
          : eq(events.hostPubkey, me),
      )
      .orderBy(desc(events.startsAt))
      .all();
    return c.json(rows.map((r) => toHostEvent(ctx, r, r.hostPubkey === me ? 'owner' : 'cohost')));
  });

  app.post('/events', ...host, async (c) => {
    const input = await jsonBody(c, createSchema);
    if (input.issuePolicy === 'paid' && input.priceMsat < MIN_PRICE_MSAT)
      apiError(400, 'price_required');
    const now = ctx.now();
    const id = randomId();
    const ticket = generateKeyset('ticket');
    ctx.db.transaction((tx) => {
      tx.insert(events)
        .values({
          id,
          hostPubkey: c.get('hostPubkey'),
          ...input,
          priceMsat: input.issuePolicy === 'paid' ? input.priceMsat : 0,
          issuedCount: 0,
          redeemedCount: 0,
          returnedCount: 0,
          status: 'draft',
          coverVersion: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      tx.insert(keysets)
        .values({
          id: ticket.id,
          eventId: id,
          kind: 'ticket',
          publicKey: ticket.publicKey,
          privateKeyEnc: ctx.vault.encrypt(ticket.privateKey, ticket.id),
        })
        .run();
    });
    const row = getManagedEvent(ctx, id, c.get('hostPubkey'));
    return c.json(toHostEvent(ctx, row, row.role), 201);
  });

  app.get('/host/events/:id', ...host, (c) => {
    const row = getManagedEvent(ctx, c.req.param('id'), c.get('hostPubkey'));
    return c.json(toHostEvent(ctx, row, row.role));
  });

  app.patch('/events/:id', ...host, async (c) => {
    const input = await jsonBody(c, patchSchema);
    const row = getManagedEvent(ctx, c.req.param('id'), c.get('hostPubkey'), {
      ownerOnly: input.status === 'cancelled',
    });
    const startsAt = input.startsAt ?? row.startsAt;
    const endsAt = input.endsAt ?? row.endsAt;
    if (endsAt <= startsAt) apiError(400, 'invalid_time_range');
    if (input.capacity !== undefined && input.capacity < row.issuedCount) {
      apiError(409, 'capacity_below_issued');
    }
    const policy = input.issuePolicy ?? row.issuePolicy;
    const price = input.priceMsat ?? row.priceMsat;
    if (policy === 'paid' && price < MIN_PRICE_MSAT) apiError(400, 'price_required');
    if (row.status === 'cancelled' && input.status && input.status !== 'cancelled') {
      apiError(409, 'event_cancelled');
    }
    if (input.status === 'draft' && row.status === 'published' && row.issuedCount > 0) {
      apiError(409, 'tickets_already_issued');
    }
    const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    ctx.db
      .update(events)
      .set({ ...patch, updatedAt: ctx.now() })
      .where(eq(events.id, row.id))
      .run();
    const updated = getManagedEvent(ctx, row.id, c.get('hostPubkey'));
    return c.json(toHostEvent(ctx, updated, updated.role));
  });

  app.put(
    '/events/:id/cover',
    bodyLimit({ maxSize: MAX_COVER_BYTES, onError: () => apiError(413, 'cover_too_large') }),
    auth,
    register,
    async (c) => {
      const row = getManagedEvent(ctx, c.req.param('id'), c.get('hostPubkey'));
      const mime = (c.req.header('content-type') ?? '').split(';')[0]?.trim() ?? '';
      if (!(COVER_TYPES as readonly string[]).includes(mime))
        apiError(422, 'unsupported_image_type');
      const data = Buffer.from(await c.req.arrayBuffer());
      if (data.length === 0) apiError(400, 'empty_body');
      ctx.db
        .update(events)
        .set({
          coverImage: data,
          coverMime: mime,
          coverVersion: row.coverVersion + 1,
          updatedAt: ctx.now(),
        })
        .where(eq(events.id, row.id))
        .run();
      return c.json({ coverVersion: row.coverVersion + 1 });
    },
  );

  app.delete('/events/:id/cover', ...host, (c) => {
    const row = getManagedEvent(ctx, c.req.param('id'), c.get('hostPubkey'));
    ctx.db
      .update(events)
      .set({ coverImage: null, coverMime: null, updatedAt: ctx.now() })
      .where(eq(events.id, row.id))
      .run();
    return c.body(null, 204);
  });

  app.post('/events/:id/announcements', ...host, async (c) => {
    const row = getManagedEvent(ctx, c.req.param('id'), c.get('hostPubkey'));
    const { body } = await jsonBody(c, announcementSchema);
    const item = { id: randomId(16), eventId: row.id, body, createdAt: ctx.now() };
    ctx.db.insert(announcements).values(item).run();
    // Phase 3: also post to the event's Marmot room.
    return c.json({ id: item.id, body: item.body, createdAt: item.createdAt }, 201);
  });

  app.delete('/events/:id/announcements/:aid', ...host, (c) => {
    const row = getManagedEvent(ctx, c.req.param('id'), c.get('hostPubkey'));
    const res = ctx.db
      .delete(announcements)
      .where(and(eq(announcements.id, c.req.param('aid')), eq(announcements.eventId, row.id)))
      .run();
    if (res.changes === 0) apiError(404, 'announcement_not_found');
    return c.body(null, 204);
  });

  app.get('/events/:id/scanner-links', ...host, (c) => {
    const row = getManagedEvent(ctx, c.req.param('id'), c.get('hostPubkey'));
    const links = ctx.db
      .select({
        id: scannerLinks.id,
        label: scannerLinks.label,
        expiresAt: scannerLinks.expiresAt,
        revokedAt: scannerLinks.revokedAt,
        createdAt: scannerLinks.createdAt,
      })
      .from(scannerLinks)
      .where(eq(scannerLinks.eventId, row.id))
      .orderBy(asc(scannerLinks.createdAt))
      .all();
    return c.json(links);
  });

  /**
   * Issue a check-in link. The bearer token is returned once and only its hash is stored; the
   * web app puts it in the URL fragment so it never reaches server or proxy logs.
   */
  app.post('/events/:id/scanner-links', ...host, async (c) => {
    const row = getManagedEvent(ctx, c.req.param('id'), c.get('hostPubkey'));
    const input = await jsonBody(c, scannerLinkSchema);
    const now = ctx.now();
    const expiresAt = Math.min(input.expiresAt ?? Infinity, row.endsAt + SCANNER_GRACE_MS);
    if (expiresAt <= now) apiError(422, 'already_expired');
    const token = randomToken();
    const id = randomId(16);
    ctx.db
      .insert(scannerLinks)
      .values({
        id,
        eventId: row.id,
        tokenHash: sha256Hex(token),
        label: input.label,
        expiresAt,
        createdAt: now,
      })
      .run();
    return c.json({ id, token, label: input.label, expiresAt }, 201);
  });

  app.delete('/events/:id/scanner-links/:lid', ...host, (c) => {
    const row = getManagedEvent(ctx, c.req.param('id'), c.get('hostPubkey'));
    const res = ctx.db
      .update(scannerLinks)
      .set({ revokedAt: ctx.now() })
      .where(
        and(
          eq(scannerLinks.id, c.req.param('lid')),
          eq(scannerLinks.eventId, row.id),
          isNull(scannerLinks.revokedAt),
        ),
      )
      .run();
    if (res.changes === 0) apiError(404, 'scanner_link_not_found');
    return c.body(null, 204);
  });

  app.get('/events/:id/stats', ...host, (c) => {
    const row = getManagedEvent(ctx, c.req.param('id'), c.get('hostPubkey'));
    const buckets = ctx.db
      .select({ start: checkinBuckets.bucketStart, count: checkinBuckets.count })
      .from(checkinBuckets)
      .where(eq(checkinBuckets.eventId, row.id))
      .orderBy(asc(checkinBuckets.bucketStart))
      .all();
    return c.json({
      capacity: row.capacity,
      issued: row.issuedCount,
      redeemed: row.redeemedCount,
      returned: row.returnedCount,
      checkinsPer15Min: buckets,
    });
  });

  return app;
}
