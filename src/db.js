import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export class DatabaseError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'DatabaseError';
  }
}

function readMigrations(migrationsDir) {
  const entries = fs.readdirSync(migrationsDir);
  return entries
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .map((name) => ({
      filename: name,
      sql: fs.readFileSync(path.join(migrationsDir, name), 'utf8'),
    }));
}

export function openDatabase(databasePath) {
  try {
    const db = new Database(databasePath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return db;
  } catch (err) {
    throw new DatabaseError(`Failed to open database at "${databasePath}".`, { cause: err });
  }
}

export function runMigrations(db, migrationsDir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const completed = new Set(
    db.prepare('SELECT filename FROM schema_migrations').pluck().all()
  );

  const migrations = readMigrations(migrationsDir);

  for (const { filename, sql } of migrations) {
    if (completed.has(filename)) {
      continue;
    }

    // `PRAGMA foreign_keys` cannot be changed inside a transaction, so toggle
    // it outside the per-migration transaction. Table-rebuild migrations
    // (e.g. altering a CHECK constraint) require FKs OFF: rebuilding a parent
    // table with FKs ON would cascade-delete child rows. The result is still
    // recorded atomically, and FKs are restored immediately after each file.
    const priorForeignKeys = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');

    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_migrations (filename, applied_at) VALUES (?, datetime('now'))"
      ).run(filename);
    });

    try {
      apply();
    } catch (err) {
      throw new DatabaseError(`Migration "${filename}" failed.`, { cause: err });
    } finally {
      db.pragma(`foreign_keys = ${priorForeignKeys ? 'ON' : 'OFF'}`);
    }
  }
}

export function closeDatabase(db) {
  if (db && typeof db.close === 'function') {
    db.close();
  }
}
