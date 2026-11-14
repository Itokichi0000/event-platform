import {
  generateKeyset,
  keysetFromPrivateKey,
  type Keyset,
  type KeysetKind,
  type PublicKeyset,
} from '@kamen/core';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import {
  announcements,
  eventCohosts,
  events,
  keysets,
  quotes,
  type EventRow,
} from './db/schema.js';
import { PaymentHub } from './lib/payments.js';
import { deriveKey, KeyVault } from './lib/secrets.js';
import { TtlSet } from './lib/ttl-set.js';
import { MockWalletBackend, nwcWalletFactory, type WalletFactory } from './lib/wallet.js';
import { httpAgentClient, type AgentClient } from './lib/agent-client.js';

export interface AppContext {
  db: Db;
  config: Config;
  vault: KeyVault;
  powKey: Uint8Array;
  inviteKey: Uint8Array;
  usedPow: TtlSet;
  payments: PaymentHub;
  /** null when rooms are disabled (no ROOM_RELAYS). */
  agent: AgentClient | null;
  now: () => number;
}

export interface ContextOptions {
  now?: () => number;
  walletFactory?: WalletFactory;
  agent?: AgentClient | null;
}

/** Rooms stay joinable until they are disbanded 24 h after the event. */
export const ROOM_OPEN_AFTER_END_MS = 24 * 60 * 60 * 1000;

export function createContext(db: Db, config: Config, opts: ContextOptions = {}): AppContext {
  const now = opts.now ?? Date.now;
  const factory =
    opts.walletFactory ??
    (config.mockWalletSettleMs !== null
      ? new MockWalletBackend(config.mockWalletSettleMs, now).factory
      : nwcWalletFactory);
  const ctx: AppContext = {
    db,
    config,
    vault: new KeyVault(config.masterKey),
    powKey: deriveKey(config.masterKey, 'pow'),
    inviteKey: deriveKey(config.masterKey, 'invite'),
    usedPow: new TtlSet(),
    payments: new PaymentHub(factory, (eventId, hash) => markPaid(ctx, eventId, hash), now),
    agent:
      opts.agent !== undefined
        ? opts.agent
        : config.roomRelays.length > 0
          ? httpAgentClient(config.agentUrl, config.masterKey)
          : null,
    now,
  };
  return ctx;
}

/** Notification path: an invoice of this event was paid. */
export function markPaid(ctx: AppContext, eventId: string, paymentHash: string): void {
  ctx.db
    .update(quotes)
    .set({ state: 'paid' })
    .where(
      and(
        eq(quotes.eventId, eventId),
        eq(quotes.paymentHash, paymentHash),
        inArray(quotes.state, ['unpaid', 'expired']),
      ),
    )
    .run();
}

export function apiError(
  status: 400 | 401 | 402 | 403 | 404 | 409 | 410 | 413 | 422 | 502 | 503,
  code: string,
): never {
  throw new HTTPException(status, { res: Response.json({ error: code }, { status }) });
}

export function getEvent(ctx: AppContext, id: string): EventRow {
  const row = ctx.db.select().from(events).where(eq(events.id, id)).get();
  if (!row) apiError(404, 'event_not_found');
  return row;
}

export type HostRole = 'owner' | 'cohost';

export function roleOf(ctx: AppContext, row: EventRow, pubkey: string): HostRole | null {
  if (row.hostPubkey === pubkey) return 'owner';
  const co = ctx.db
    .select({ pubkey: eventCohosts.pubkey })
    .from(eventCohosts)
    .where(and(eq(eventCohosts.eventId, row.id), eq(eventCohosts.pubkey, pubkey)))
    .get();
  return co ? 'cohost' : null;
}

/**
 * Event the caller may manage. Co-hosts may edit, post announcements and issue check-in links
 * (docs/SPEC.md §2); `ownerOnly` operations (payments, invite codes, co-hosts, cancelling) are
 * reserved for the owner.
 */
export function getManagedEvent(
  ctx: AppContext,
  id: string,
  pubkey: string,
  opts: { ownerOnly?: boolean } = {},
): EventRow & { role: HostRole } {
  const row = getEvent(ctx, id);
  const role = roleOf(ctx, row, pubkey);
  if (!role) apiError(403, 'not_event_host');
  if (opts.ownerOnly && role !== 'owner') apiError(403, 'owner_only');
  return { ...row, role };
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

/** Whether participants may get a room pass / enter the room now. */
export function roomAvailable(ctx: AppContext, row: EventRow): boolean {
  return (
    ctx.agent !== null &&
    row.roomEnabled &&
    row.status === 'published' &&
    ctx.now() < row.endsAt + ROOM_OPEN_AFTER_END_MS
  );
}

/** Events created before phase 3 get their room keyset on first use. */
export function ensureRoomKeyset(ctx: AppContext, eventId: string): void {
  const exists = ctx.db
    .select({ id: keysets.id })
    .from(keysets)
    .where(and(eq(keysets.eventId, eventId), eq(keysets.kind, 'room')))
    .get();
  if (exists) return;
  const ks = generateKeyset('room');
  ctx.db
    .insert(keysets)
    .values({
      id: ks.id,
      eventId,
      kind: 'room',
      publicKey: ks.publicKey,
      privateKeyEnc: ctx.vault.encrypt(ks.privateKey, ks.id),
    })
    .run();
}

/** Paid but not yet issued tickets hold a seat (they must always be issuable). */
export function paidUnissued(ctx: AppContext, eventId: string): number {
  return ctx.db
    .select({ id: quotes.id })
    .from(quotes)
    .where(and(eq(quotes.eventId, eventId), eq(quotes.state, 'paid')))
    .all().length;
}

export function remainingSeats(ctx: AppContext, row: EventRow): number {
  const held = row.issuePolicy === 'paid' ? paidUnissued(ctx, row.id) : 0;
  return Math.max(0, row.capacity - row.issuedCount - held);
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
    remaining: remainingSeats(ctx, row),
    issuePolicy: row.issuePolicy,
    priceMsat: row.issuePolicy === 'paid' ? row.priceMsat : 0,
    // A paid event is only purchasable once the host connected a wallet.
    paymentsReady: row.issuePolicy !== 'paid' || row.nwcEnc !== null,
    status: row.status,
    coverVersion: row.coverImage ? row.coverVersion : null,
    offlineCheckin: row.offlineCheckin,
    roomAvailable: roomAvailable(ctx, row),
    keysets: publicKeysets(ctx, row.id),
    announcements: listAnnouncements(ctx, row.id),
  };
}

/** Host view: adds counters and the location regardless of visibility. Never the NWC secret. */
export function toHostEvent(ctx: AppContext, row: EventRow, role: HostRole) {
  return {
    ...toPublicEvent(ctx, row),
    location: row.location,
    priceMsat: row.priceMsat,
    issued: row.issuedCount,
    redeemed: row.redeemedCount,
    returned: row.returnedCount,
    walletConnected: row.nwcEnc !== null,
    roomEnabled: row.roomEnabled,
    roomsConfigured: ctx.agent !== null,
    role,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
