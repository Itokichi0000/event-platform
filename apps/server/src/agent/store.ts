/**
 * Agent persistence. Holds the MLS state of the rooms this agent administers, encrypted with a
 * key derived from the master key. No messages are ever stored.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { KeyValueBackend } from '@kamen/messaging';
import { decodeValue, encodeValue } from '@kamen/messaging/marmot';
import { KeyVault } from '../lib/secrets.js';

export interface RoomRow {
  event_id: string;
  room_id: string;
  ends_at: number;
}

export class AgentStore {
  readonly db: Database.Database;
  readonly #vault: KeyVault;

  constructor(path: string, masterKey: Uint8Array) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('secure_delete = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        event_id TEXT PRIMARY KEY,
        room_id  TEXT NOT NULL,
        ends_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        event_id  TEXT NOT NULL,
        namespace TEXT NOT NULL,
        key       TEXT NOT NULL,
        value_enc TEXT NOT NULL,
        PRIMARY KEY (event_id, namespace, key)
      ) WITHOUT ROWID;
    `);
    // A separate purpose string from the API server's keyset encryption.
    this.#vault = new KeyVault(masterKey, 'agent-state');
  }

  rooms(): RoomRow[] {
    return this.db.prepare('SELECT event_id, room_id, ends_at FROM rooms').all() as RoomRow[];
  }

  room(eventId: string): RoomRow | undefined {
    return this.db
      .prepare('SELECT event_id, room_id, ends_at FROM rooms WHERE event_id = ?')
      .get(eventId) as RoomRow | undefined;
  }

  saveRoom(row: RoomRow): void {
    this.db
      .prepare(
        'INSERT INTO rooms (event_id, room_id, ends_at) VALUES (?, ?, ?) ON CONFLICT (event_id) DO UPDATE SET ends_at = excluded.ends_at',
      )
      .run(row.event_id, row.room_id, row.ends_at);
  }

  /** Forget everything about a room (after disbanding). */
  deleteRoom(eventId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM kv WHERE event_id = ?').run(eventId);
      this.db.prepare('DELETE FROM rooms WHERE event_id = ?').run(eventId);
    })();
  }

  /** Key/value backend for one event's MarmotAdapter. */
  backend(eventId: string): KeyValueBackend {
    const aad = (ns: string, key: string) => `${eventId}/${ns}/${key}`;
    return {
      get: async (ns, key) => {
        const row = this.db
          .prepare('SELECT value_enc FROM kv WHERE event_id = ? AND namespace = ? AND key = ?')
          .get(eventId, ns, key) as { value_enc: string } | undefined;
        return row ? decodeValue(this.#vault.decrypt(row.value_enc, aad(ns, key))) : undefined;
      },
      set: async (ns, key, value) => {
        this.db
          .prepare(
            `INSERT INTO kv (event_id, namespace, key, value_enc) VALUES (?, ?, ?, ?)
             ON CONFLICT (event_id, namespace, key) DO UPDATE SET value_enc = excluded.value_enc`,
          )
          .run(eventId, ns, key, this.#vault.encrypt(encodeValue(value), aad(ns, key)));
      },
      delete: async (ns, key) => {
        this.db
          .prepare('DELETE FROM kv WHERE event_id = ? AND namespace = ? AND key = ?')
          .run(eventId, ns, key);
      },
      keys: async (ns) =>
        (
          this.db
            .prepare('SELECT key FROM kv WHERE event_id = ? AND namespace = ?')
            .all(eventId, ns) as {
            key: string;
          }[]
        ).map((r) => r.key),
      clear: async (ns) => {
        this.db.prepare('DELETE FROM kv WHERE event_id = ? AND namespace = ?').run(eventId, ns);
      },
    };
  }
}
