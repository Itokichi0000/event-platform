import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';

describe('migrations', () => {
  it('upgrades a phase-1 database without losing rows or cascading deletes', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(MIGRATIONS[0]!);
    db.pragma('user_version = 1');
    db.exec(`
      INSERT INTO hosts VALUES ('${'a'.repeat(64)}');
      INSERT INTO events (id, host_pubkey, title, starts_at, ends_at, capacity, issued_count, created_at, updated_at)
        VALUES ('e1', '${'a'.repeat(64)}', 'old', 1, 2, 10, 3, 0, 0);
      INSERT INTO keysets (id, event_id, kind, public_key, private_key_enc) VALUES ('00aa', 'e1', 'ticket', 'pk', 'v1:x');
      INSERT INTO spent VALUES ('00aa', 'y1');
      INSERT INTO announcements VALUES ('a1', 'e1', 'hello', 0);
    `);

    migrate(db);

    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(
      db
        .prepare(
          'SELECT id, title, issued_count, issue_policy, offline_checkin, returned_count FROM events',
        )
        .all(),
    ).toEqual([
      {
        id: 'e1',
        title: 'old',
        issued_count: 3,
        issue_policy: 'pow',
        offline_checkin: 0,
        returned_count: 0,
      },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM keysets').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM spent').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM announcements').get()).toEqual({ n: 1 });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    // the new CHECK constraint accepts the new policies
    db.prepare("UPDATE events SET issue_policy = 'paid' WHERE id = 'e1'").run();
    // and foreign keys still cascade after the rebuild
    db.prepare("DELETE FROM events WHERE id = 'e1'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM keysets').get()).toEqual({ n: 0 });
  });

  it('is idempotent', () => {
    const db = new Database(':memory:');
    migrate(db);
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
  });
});
