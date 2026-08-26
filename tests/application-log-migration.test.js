import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const APPLICATION_LOG_MIGRATION = '026_add_application_logs.sql';

describe('application log migration', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-application-log-migration-'));
    db = undefined;
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the application log schema and required indexes without a project foreign key', () => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").pluck().get('application_logs'))
      .toBe('application_logs');
    expect(db.prepare("SELECT name FROM pragma_table_info('application_logs')").pluck().all()).toEqual([
      'id', 'occurred_at_ms', 'level', 'kind', 'subsystem', 'event', 'message',
      'project_id', 'correlation_id', 'context_json',
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?").pluck().all('application_logs'))
      .toEqual(expect.arrayContaining([
        'idx_application_logs_occurred_at_id',
        'idx_application_logs_level_occurred_at_id',
      ]));

    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .pluck().get('application_logs');
    expect(ddl).not.toMatch(/FOREIGN KEY/i);
    expect(ddl).toMatch(/context_json.*16384/i);
  });

  it('upgrades an existing 025 database without altering its data or tables', () => {
    const legacyMigrationsDir = path.join(tmpDir, 'migrations-through-025');
    fs.mkdirSync(legacyMigrationsDir);
    for (const filename of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name <= '025_add_book_primary_images.sql')) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(legacyMigrationsDir, filename));
    }

    db = openDatabase(path.join(tmpDir, 'existing.db'));
    runMigrations(db, legacyMigrationsDir);
    const projectId = Number(db.prepare(`
      INSERT INTO projects (title, slug, description, notes, status, planned_date, published_date, patreon_url)
      VALUES ('Existing', 'existing', '', '', 'tbd', NULL, NULL, NULL)
    `).run().lastInsertRowid);
    const tablesBefore = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT IN ('schema_migrations')
      ORDER BY name
    `).pluck().all();

    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare('SELECT id, title FROM projects WHERE id = ?').get(projectId))
      .toEqual({ id: projectId, title: 'Existing' });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT IN ('schema_migrations', 'application_logs')
      ORDER BY name
    `).pluck().all()).toEqual(tablesBefore);
    expect(db.prepare('SELECT filename FROM schema_migrations WHERE filename = ?').pluck().get(APPLICATION_LOG_MIGRATION))
      .toBe(APPLICATION_LOG_MIGRATION);
  });
});
