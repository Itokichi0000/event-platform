import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MIGRATIONS } from './migrations.js';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // Deleted rows (e.g. expired keys) are overwritten instead of lingering in free pages.
  sqlite.pragma('secure_delete = ON');
  migrate(sqlite);
  return drizzle(sqlite, { schema });
}

export function migrate(sqlite: Database.Database): void {
  const current = sqlite.pragma('user_version', { simple: true }) as number;
  if (current >= MIGRATIONS.length) return;
  // Table rebuilds (SQLite cannot alter CHECK constraints) must not cascade deletes, so foreign
  // keys are off while migrating and verified afterwards. The pragma is a no-op inside a
  // transaction, hence it is set here.
  sqlite.pragma('foreign_keys = OFF');
  try {
    for (let v = current; v < MIGRATIONS.length; v++) {
      sqlite.transaction(() => {
        sqlite.exec(MIGRATIONS[v] as string);
        const broken = sqlite.pragma('foreign_key_check') as unknown[];
        if (broken.length > 0) throw new Error(`migration ${v + 1} broke foreign keys`);
        sqlite.pragma(`user_version = ${v + 1}`);
      })();
    }
  } finally {
    sqlite.pragma('foreign_keys = ON');
  }
}

export { schema };
