/**
 * The participant's secrets live here and nowhere else (CLAUDE.md). Nothing in this module talks
 * to the network.
 */
import type { Token } from '@kamen/core';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/** Copy of the event details at issue time, so the ticket can be shown offline. */
export interface EventSnapshot {
  title: string;
  startsAt: number;
  endsAt: number;
  location: string | null;
  locationVisibility: 'public' | 'ticket_holders';
  offlineCheckin: boolean;
  hostPubkey: string;
  /** Added in phase 2; absent on tickets saved earlier. */
  issuePolicy?: 'pow' | 'invite' | 'paid';
  status?: 'draft' | 'published' | 'cancelled';
}

export interface StoredTicket {
  /** Random local id used in URLs (never the secret). */
  id: string;
  token: Token;
  event: EventSnapshot;
  createdAt: number;
  /** Set once the participant copied / saved a backup. */
  backedUpAt: number | null;
  /**
   * Pass for the event's room (blind-signed with a separate keyset, so it is unlinkable to the
   * ticket). Removed once used. Not part of the backup string.
   */
  roomPass?: Token;
}

/**
 * A Lightning invoice the participant is paying or has paid. Kept until the ticket is issued,
 * because the quote id is the only claim to the ticket (the server does not know who paid).
 */
export interface PendingQuote {
  quoteId: string;
  eventId: string;
  invoice: string;
  amountMsat: number;
  expiresAt: number;
  createdAt: number;
}

interface KamenDB extends DBSchema {
  tickets: {
    key: string;
    value: StoredTicket;
    indexes: { bySecret: string; byEvent: string };
  };
  pendingQuotes: {
    key: string;
    value: PendingQuote;
    indexes: { byEvent: string };
  };
}

const DB_NAME = 'kamen';
let dbPromise: Promise<IDBPDatabase<KamenDB>> | null = null;

export function db(): Promise<IDBPDatabase<KamenDB>> {
  dbPromise ??= openDB<KamenDB>(DB_NAME, 2, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        const tickets = d.createObjectStore('tickets', { keyPath: 'id' });
        tickets.createIndex('bySecret', 'token.secret', { unique: true });
        tickets.createIndex('byEvent', 'token.eventId');
      }
      if (oldVersion < 2) {
        const quotes = d.createObjectStore('pendingQuotes', { keyPath: 'quoteId' });
        quotes.createIndex('byEvent', 'eventId');
      }
    },
  });
  return dbPromise;
}

/** For tests: close the connection and delete the database. */
export async function resetDb(): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export function newTicketId(): string {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export async function saveTicket(
  token: Token,
  event: EventSnapshot,
  opts: { backedUp?: boolean; roomPass?: Token } = {},
): Promise<StoredTicket> {
  const d = await db();
  const existing = await d.getFromIndex('tickets', 'bySecret', token.secret);
  if (existing) return existing;
  const ticket: StoredTicket = {
    id: newTicketId(),
    token,
    event,
    createdAt: Date.now(),
    backedUpAt: opts.backedUp ? Date.now() : null,
    ...(opts.roomPass ? { roomPass: opts.roomPass } : {}),
  };
  await d.add('tickets', ticket);
  return ticket;
}

export async function listTickets(): Promise<StoredTicket[]> {
  const all = await (await db()).getAll('tickets');
  return all.sort((a, b) => a.event.startsAt - b.event.startsAt);
}

export async function getTicket(id: string): Promise<StoredTicket | undefined> {
  return (await db()).get('tickets', id);
}

export async function ticketsForEvent(eventId: string): Promise<StoredTicket[]> {
  return (await db()).getAllFromIndex('tickets', 'byEvent', eventId);
}

export async function updateTicket(id: string, patch: Partial<Omit<StoredTicket, 'id'>>) {
  const d = await db();
  const t = await d.get('tickets', id);
  if (!t) return;
  await d.put('tickets', { ...t, ...patch });
}

export async function deleteTicket(id: string): Promise<void> {
  await (await db()).delete('tickets', id);
}

export async function savePendingQuote(q: PendingQuote): Promise<void> {
  await (await db()).put('pendingQuotes', q);
}

export async function pendingQuotesForEvent(eventId: string): Promise<PendingQuote[]> {
  return (await db()).getAllFromIndex('pendingQuotes', 'byEvent', eventId);
}

export async function deletePendingQuote(quoteId: string): Promise<void> {
  await (await db()).delete('pendingQuotes', quoteId);
}

/** Forget a used room pass. */
export async function clearRoomPass(id: string): Promise<void> {
  const d = await db();
  const t = await d.get('tickets', id);
  if (!t) return;
  const { roomPass: _used, ...rest } = t;
  await d.put('tickets', rest);
}
