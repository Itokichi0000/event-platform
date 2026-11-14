/**
 * Check-in device storage for offline check-in (docs/SPEC.md §4). A separate IndexedDB database
 * from the participant's tickets. Holds the event's public key, the spent identifiers Y this
 * device knows about, check-ins not yet sent to the server, and conflicts found while syncing.
 */
import type { PublicKeyset, RedeemPayload } from '@kamen/core';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export interface CachedEvent {
  eventId: string;
  title: string;
  keyset: PublicKeyset | null;
  offlineCheckin: boolean;
  status: string;
  issued: number;
  redeemed: number;
  savedAt: number;
}

export interface QueuedCheckin {
  id?: number;
  eventId: string;
  y: string;
  payload: RedeemPayload;
  scannedAt: number;
}

export interface Conflict {
  id?: number;
  eventId: string;
  y: string;
  reason: 'already_redeemed' | 'invalid';
  scannedAt: number;
}

interface ScannerDB extends DBSchema {
  events: { key: string; value: CachedEvent };
  spent: { key: [string, string]; value: { eventId: string; y: string } };
  queue: { key: number; value: QueuedCheckin; indexes: { byEvent: string } };
  conflicts: { key: number; value: Conflict; indexes: { byEvent: string } };
}

const NAME = 'kamen-scanner';
let promise: Promise<IDBPDatabase<ScannerDB>> | null = null;

function sdb() {
  promise ??= openDB<ScannerDB>(NAME, 1, {
    upgrade(d) {
      d.createObjectStore('events', { keyPath: 'eventId' });
      d.createObjectStore('spent', { keyPath: ['eventId', 'y'] });
      d.createObjectStore('queue', { keyPath: 'id', autoIncrement: true }).createIndex(
        'byEvent',
        'eventId',
      );
      d.createObjectStore('conflicts', { keyPath: 'id', autoIncrement: true }).createIndex(
        'byEvent',
        'eventId',
      );
    },
  });
  return promise;
}

export async function resetScannerStore(): Promise<void> {
  if (promise) (await promise).close();
  promise = null;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export const scannerStore = {
  async saveEvent(e: CachedEvent) {
    await (await sdb()).put('events', e);
  },
  async getEvent(eventId: string) {
    return (await sdb()).get('events', eventId);
  },
  async isSpent(eventId: string, y: string) {
    return (await (await sdb()).get('spent', [eventId, y])) !== undefined;
  },
  async addSpent(eventId: string, ys: string[]) {
    const tx = (await sdb()).transaction('spent', 'readwrite');
    await Promise.all([...ys.map((y) => tx.store.put({ eventId, y })), tx.done]);
  },
  /** Record an offline check-in atomically: mark spent and queue it for the server. */
  async queueCheckin(item: QueuedCheckin) {
    const tx = (await sdb()).transaction(['spent', 'queue'], 'readwrite');
    await Promise.all([
      tx.objectStore('spent').put({ eventId: item.eventId, y: item.y }),
      tx.objectStore('queue').add(item),
      tx.done,
    ]);
  },
  async queued(eventId: string) {
    return (await sdb()).getAllFromIndex('queue', 'byEvent', eventId);
  },
  async dequeue(id: number) {
    await (await sdb()).delete('queue', id);
  },
  async addConflict(c: Conflict) {
    await (await sdb()).add('conflicts', c);
  },
  async conflicts(eventId: string) {
    return (await sdb()).getAllFromIndex('conflicts', 'byEvent', eventId);
  },
  async clearConflicts(eventId: string) {
    const d = await sdb();
    const keys = await d.getAllKeysFromIndex('conflicts', 'byEvent', eventId);
    const tx = d.transaction('conflicts', 'readwrite');
    await Promise.all([...keys.map((k) => tx.store.delete(k)), tx.done]);
  },
};
