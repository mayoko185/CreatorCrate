import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATION_FILENAME = '031_add_note_revisions.sql';

function copyPre031Migrations(parentDir) {
  const target = path.join(parentDir, 'pre-031');
  fs.mkdirSync(target);
  for (const filename of fs.readdirSync(MIGRATIONS_DIR)) {
    if (filename.endsWith('.sql') && filename.localeCompare(MIGRATION_FILENAME) < 0) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(target, filename));
    }
  }
  return target;
}

function insertNote(db, title = 'Page') {
  const bookId = Number(db.prepare(
    'INSERT INTO books (title, sort_order) VALUES (?, 0)'
  ).run('Book').lastInsertRowid);
  return Number(db.prepare(`
    INSERT INTO notes (book_id, chapter_id, title, content, sort_order)
    VALUES (?, NULL, ?, 'Body', 0)
  `).run(bookId, title).lastInsertRowid);
}

describe('Note revisions migration (031)', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-note-revisions-migration-'));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('upgrades a pre-031 database without fabricating revisions for existing Notes', () => {
    db = openDatabase(path.join(tmpDir, 'upgrade.db'));
    const pre031 = copyPre031Migrations(tmpDir);
    runMigrations(db, pre031);
    const noteId = insertNote(db, 'Existing Page');

    fs.copyFileSync(path.join(MIGRATIONS_DIR, MIGRATION_FILENAME), path.join(pre031, MIGRATION_FILENAME));
    runMigrations(db, pre031);

    expect(db.prepare('SELECT * FROM note_revisions').all()).toEqual([]);
    expect(db.prepare('SELECT title FROM notes WHERE id = ?').pluck().get(noteId)).toBe('Existing Page');
    expect(db.prepare('SELECT filename FROM schema_migrations WHERE filename = ?')
      .pluck().get(MIGRATION_FILENAME)).toBe(MIGRATION_FILENAME);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('creates the revision schema and deterministic per-Note index', () => {
    db = openDatabase(path.join(tmpDir, 'fresh.db'));
    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare("PRAGMA table_info('note_revisions')").all().map((column) => column.name))
      .toEqual([
        'id', 'note_id', 'title', 'content', 'project_ids_json', 'asset_ids_json',
        'source_updated_at', 'created_at',
      ]);
    expect(db.prepare("PRAGMA index_info('note_revisions_note_id_id_desc_idx')")
      .all().map((column) => column.name)).toEqual(['note_id', 'id']);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .pluck().get('note_revisions_note_id_id_desc_idx')).toMatch(/\(note_id, id DESC\)/i);
    expect(db.pragma("foreign_key_list('note_revisions')")).toEqual([
      expect.objectContaining({ from: 'note_id', table: 'notes', to: 'id', on_delete: 'CASCADE' }),
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('cascades revisions when a Note is deleted without linking historical association IDs', () => {
    db = openDatabase(path.join(tmpDir, 'cascade.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const noteId = insertNote(db);
    db.prepare(`
      INSERT INTO note_revisions (
        note_id, title, content, project_ids_json, asset_ids_json, source_updated_at
      ) VALUES (?, 'Old', 'Old body', '[999991]', '[999992]', '2026-09-08 00:00:00')
    `).run(noteId);

    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
    expect(db.prepare('SELECT * FROM note_revisions').all()).toEqual([]);
  });
});
