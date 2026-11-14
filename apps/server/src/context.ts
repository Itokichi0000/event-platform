import { keysetFromPrivateKey, type Keyset, type KeysetKind, type PublicKeyset } from '@kamen/core';
import { and, asc, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { announcements, events, keysets, type EventRow } from './db/schema.js';
import { deriveKey, KeyVault } from './lib/secrets.js';
import { TtlSet } from './lib/ttl-set.js';

export interface AppContext {
  db: Db;
  config: Config;
  vault: KeyVault;
  powKey: Uint8Array;
  usedPow: TtlSet;
  now: () => number;
}

export function createContext(db: Db, config: Config, now: () => number = Date.now): AppContext {
  return {
    db,
    config,
    vault: new KeyVault(config.masterKey),
    powKey: deriveKey(config.masterKey, 'pow'),
    usedPow: new TtlSet(),
    now,
  };
}

export function apiError(
  status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422,
  code: string,
): never {
  throw new HTTPException(status, { res: Response.json({ error: code }, { status }) });
}

export function getEvent(ctx: AppContext, id: string): EventRow {
  const row = ctx.db.select().from(events).where(eq(events.id, id)).get();
  if (!row) apiError(404, 'event_not_found');
  return row;
}

export function getOwnedEvent(ctx: AppContext, id: string, pubkey: string): EventRow {
  const row = getEvent(ctx, id);
  // Phase 2 adds co-hosts (event_cohosts).
  if (row.hostPubkey !== pubkey) apiError(403, 'not_event_host');
  return row;
}

export function publicKeysets(ctx: AppContext, eventId: string): PublicKeyset[] {
  return ctx.db
    .select({ id: keysets.id, kind: keysets.kind, publicKey: keysets.publicKey })
    .from(keysets)
    .where(eq(keysets.eventId, eventId))
    .all();
}

/** Loads and decrypts an event keyset's private key. Throws 410 once the key was deleted. */
export function loadKeyset(ctx: AppContext, eventId: string, kind: KeysetKind): Keyset {
  const row = ctx.db
    .select()
    .from(keysets)
    .where(and(eq(keysets.eventId, eventId), eq(keysets.kind, kind)))
    .get();
  if (!row) apiError(422, 'keyset_not_found');
  if (!row.privateKeyEnc) apiError(410, 'keyset_retired');
  const ks = keysetFromPrivateKey(kind, ctx.vault.decrypt(row.privateKeyEnc, row.id));
  if (ks.id !== row.id || ks.publicKey !== row.publicKey) throw new Error('keyset integrity');
  return ks;
}

export function listAnnouncements(ctx: AppContext, eventId: string) {
  return ctx.db
    .select({ id: announcements.id, body: announcements.body, createdAt: announcements.createdAt })
    .from(announcements)
    .where(eq(announcements.eventId, eventId))
    .orderBy(asc(announcements.createdAt))
    .all()
    .reverse();
}

/** Public view of an event. The location is withheld when only ticket holders may see it. */
export function toPublicEvent(ctx: AppContext, row: EventRow) {
  return {
    id: row.id,
    hostPubkey: row.hostPubkey,
    title: row.title,
    description: row.description,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    location: row.locationVisibility === 'public' ? row.location : null,
    locationVisibility: row.locationVisibility,
    capacity: row.capacity,
    remaining: Math.max(0, row.capacity - row.issuedCount),
    issuePolicy: row.issuePolicy,
    status: row.status,
    coverVersion: row.coverImage ? row.coverVersion : null,
    // Phase 2 makes this an event setting; until then the door QR never carries the DLEQ.
    offlineCheckin: false,
    keysets: publicKeysets(ctx, row.id),
    announcements: listAnnouncements(ctx, row.id),
  };
}

/** Host view: adds counters and the location regardless of visibility. */
export function toHostEvent(ctx: AppContext, row: EventRow) {
  return {
    ...toPublicEvent(ctx, row),
    location: row.location,
    issued: row.issuedCount,
    redeemed: row.redeemedCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
