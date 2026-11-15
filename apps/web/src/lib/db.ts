/**
 * The participant's secrets live here and nowhere else (CLAUDE.md). Nothing in this module talks
 * to the network.
 */
import type { PendingIssue, Proof, PublicKeyset, Token } from '@kamen/core';
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
  issuePolicy?: 'pow' | 'invite' | 'paid' | 'approval';
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
  /**
   * Blinded messages shown in the door QR so the scanner's check-in gets them signed: a stamp
   * (御朱印) from the host's stamp keyset and a vote credential from the event's vote keyset.
   */
  checkin?: {
    stamp?: PendingIssue & { keyset: PublicKeyset };
    vote?: PendingIssue & { keyset: PublicKeyset };
  };
  /** Check-in credential for anonymous polls, questions and draws (after check-in). */
  voteCredential?: Proof;
  /** Hold-invoice deposit; its id is the refund reference shown at the door. */
  depositId?: string;
  /** Draw entry codes, by draw id. */
  drawCodes?: Record<string, string>;
}

/** A stamp (御朱印) from a host. Says nothing about which event; the title is kept locally only. */
export interface StoredStamp extends Proof {
  hostPubkey: string;
  eventTitle: string | null;
  receivedAt: number;
}

/** A deposit hold invoice being paid (kept until the ticket is issued). */
export interface PendingDeposit {
  eventId: string;
  depositId: string;
  invoice: string;
  amountMsat: number;
  expiresAt: number;
  createdAt: number;
}

/** An application to an approval-based event. The token is the claim to the ticket. */
export interface StoredApplication {
  eventId: string;
  id: string;
  token: string;
  createdAt: number;
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
  stamps: { key: string; value: StoredStamp; indexes: { byHost: string } };
  pendingDeposits: { key: string; value: PendingDeposit };
  applications: { key: string; value: StoredApplication };
}

const DB_NAME = 'kamen';
let dbPromise: Promise<IDBPDatabase<KamenDB>> | null = null;

export function db(): Promise<IDBPDatabase<KamenDB>> {
  dbPromise ??= openDB<KamenDB>(DB_NAME, 3, {
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
      if (oldVersion < 3) {
        d.createObjectStore('stamps', { keyPath: 'secret' }).createIndex('byHost', 'hostPubkey');
        d.createObjectStore('pendingDeposits', { keyPath: 'eventId' });
        d.createObjectStore('applications', { keyPath: 'eventId' });
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

export async function putTicket(t: StoredTicket): Promise<void> {
  await (await db()).put('tickets', t);
}

export const stampStore = {
  all: async () => (await db()).getAll('stamps'),
  forHost: async (host: string) => (await db()).getAllFromIndex('stamps', 'byHost', host),
  add: async (s: StoredStamp) => void (await (await db()).put('stamps', s)),
  /** Replace stamps that were spent in a swap with the fresh ones, atomically. */
  async replace(spent: string[], fresh: StoredStamp[]) {
    const tx = (await db()).transaction('stamps', 'readwrite');
    await Promise.all([
      ...spent.map((k) => tx.store.delete(k)),
      ...fresh.map((f) => tx.store.put(f)),
      tx.done,
    ]);
  },
};

export const depositStore = {
  get: async (eventId: string) => (await db()).get('pendingDeposits', eventId),
  put: async (d: PendingDeposit) => void (await (await db()).put('pendingDeposits', d)),
  delete: async (eventId: string) => (await db()).delete('pendingDeposits', eventId),
};

export const applicationStore = {
  get: async (eventId: string) => (await db()).get('applications', eventId),
  put: async (a: StoredApplication) => void (await (await db()).put('applications', a)),
  delete: async (eventId: string) => (await db()).delete('applications', eventId),
};
