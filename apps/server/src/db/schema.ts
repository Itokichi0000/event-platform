/** Drizzle view of the tables created in ./migrations.ts (the SQL there is authoritative). */
import { blob, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const hosts = sqliteTable('hosts', {
  pubkey: text('pubkey').primaryKey(),
});

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  hostPubkey: text('host_pubkey').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  startsAt: integer('starts_at').notNull(),
  endsAt: integer('ends_at').notNull(),
  location: text('location').notNull(),
  locationVisibility: text('location_visibility', { enum: ['public', 'ticket_holders'] }).notNull(),
  capacity: integer('capacity').notNull(),
  issuePolicy: text('issue_policy', { enum: ['pow', 'invite', 'paid', 'approval'] }).notNull(),
  priceMsat: integer('price_msat').notNull(),
  depositMsat: integer('deposit_msat').notNull(),
  minStamps: integer('min_stamps').notNull(),
  issuedCount: integer('issued_count').notNull(),
  redeemedCount: integer('redeemed_count').notNull(),
  returnedCount: integer('returned_count').notNull(),
  offlineCheckin: integer('offline_checkin', { mode: 'boolean' }).notNull(),
  roomEnabled: integer('room_enabled', { mode: 'boolean' }).notNull(),
  nwcEnc: text('nwc_enc'),
  status: text('status', { enum: ['draft', 'published', 'cancelled'] }).notNull(),
  coverImage: blob('cover_image', { mode: 'buffer' }),
  coverMime: text('cover_mime'),
  coverVersion: integer('cover_version').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const keysets = sqliteTable('keysets', {
  id: text('id').primaryKey(),
  eventId: text('event_id'),
  hostPubkey: text('host_pubkey'),
  kind: text('kind', { enum: ['ticket', 'room', 'stamp', 'vote'] }).notNull(),
  publicKey: text('public_key').notNull(),
  privateKeyEnc: text('private_key_enc'),
});

export const spent = sqliteTable(
  'spent',
  {
    keysetId: text('keyset_id').notNull(),
    y: text('y').notNull(),
  },
  (t) => [primaryKey({ columns: [t.keysetId, t.y] })],
);

export const checkinBuckets = sqliteTable(
  'checkin_buckets',
  {
    eventId: text('event_id').notNull(),
    bucketStart: integer('bucket_start').notNull(),
    count: integer('count').notNull(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.bucketStart] })],
);

export const announcements = sqliteTable('announcements', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull(),
  body: text('body').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const scannerLinks = sqliteTable('scanner_links', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  label: text('label').notNull(),
  expiresAt: integer('expires_at').notNull(),
  revokedAt: integer('revoked_at'),
  createdAt: integer('created_at').notNull(),
});

export const eventCohosts = sqliteTable(
  'event_cohosts',
  {
    eventId: text('event_id').notNull(),
    pubkey: text('pubkey').notNull(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.pubkey] })],
);

export const quotes = sqliteTable('quotes', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull(),
  paymentHash: text('payment_hash').notNull(),
  state: text('state', { enum: ['unpaid', 'paid', 'issued', 'expired'] }).notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const inviteCodes = sqliteTable('invite_codes', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull(),
  codeHash: text('code_hash').notNull(),
  label: text('label').notNull(),
  maxUses: integer('max_uses').notNull(),
  usesLeft: integer('uses_left').notNull(),
});

export type EventRow = typeof events.$inferSelect;
export type KeysetRow = typeof keysets.$inferSelect;
