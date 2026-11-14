/**
 * Room data on the participant's device, in its own IndexedDB database ("kamen-rooms"):
 * the per-event Nostr secret key, Marmot's MLS state, and the decrypted messages.
 * Values keep Uint8Array intact (structured clone). Everything for an event is deleted when its
 * room is disbanded or 24 h after the event ends.
 */
import type { KeyValueBackend, RoomMessage } from '@kamen/messaging';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export interface RoomRecord {
  eventId: string;
  roomId: string;
  /** Per-event key: never the participant's usual npub. Secret. */
  secretKey: string;
  pubkey: string;
  agentPubkey: string;
  relays: string[];
  eventTitle: string;
  eventEndsAt: number;
  joinedAt: number;
}

export interface StoredMessage extends RoomMessage {
  eventId: string;
}

interface RoomsDB extends DBSchema {
  rooms: { key: string; value: RoomRecord };
  kv: {
    key: [string, string, string];
    value: { eventId: string; ns: string; key: string; value: unknown };
  };
  messages: { key: [string, string]; value: StoredMessage; indexes: { byEvent: string } };
}

const NAME = 'kamen-rooms';
let promise: Promise<IDBPDatabase<RoomsDB>> | null = null;

function rdb() {
  promise ??= openDB<RoomsDB>(NAME, 1, {
    upgrade(d) {
      d.createObjectStore('rooms', { keyPath: 'eventId' });
      d.createObjectStore('kv', { keyPath: ['eventId', 'ns', 'key'] });
      d.createObjectStore('messages', { keyPath: ['eventId', 'id'] }).createIndex(
        'byEvent',
        'eventId',
      );
    },
  });
  return promise;
}

export async function resetRoomStore(): Promise<void> {
  if (promise) (await promise).close();
  promise = null;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export const roomStore = {
  get: async (eventId: string) => (await rdb()).get('rooms', eventId),
  all: async () => (await rdb()).getAll('rooms'),
  save: async (r: RoomRecord) => void (await (await rdb()).put('rooms', r)),

  async messages(eventId: string): Promise<StoredMessage[]> {
    const all = await (await rdb()).getAllFromIndex('messages', 'byEvent', eventId);
    return all.sort((a, b) => a.createdAt - b.createdAt);
  },
  async addMessage(m: StoredMessage) {
    await (await rdb()).put('messages', m);
  },

  /** Delete everything stored for an event's room. */
  async purge(eventId: string) {
    const d = await rdb();
    const tx = d.transaction(['rooms', 'kv', 'messages'], 'readwrite');
    const range = IDBKeyRange.bound([eventId], [eventId, []]);
    await Promise.all([
      tx.objectStore('rooms').delete(eventId),
      tx.objectStore('kv').delete(range),
      tx.objectStore('messages').delete(range),
      tx.done,
    ]);
  },

  /** Marmot store backend scoped to one event. */
  backend(eventId: string): KeyValueBackend {
    return {
      get: async (ns, key) => (await (await rdb()).get('kv', [eventId, ns, key]))?.value,
      set: async (ns, key, value) =>
        void (await (await rdb()).put('kv', { eventId, ns, key, value })),
      delete: async (ns, key) => (await rdb()).delete('kv', [eventId, ns, key]),
      keys: async (ns) =>
        (
          await (await rdb()).getAllKeys('kv', IDBKeyRange.bound([eventId, ns], [eventId, ns, []]))
        ).map((k) => k[2]),
      clear: async (ns) =>
        (await rdb()).delete('kv', IDBKeyRange.bound([eventId, ns], [eventId, ns, []])),
    };
  },
};
