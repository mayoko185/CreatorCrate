import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATION_FILENAME = '030_add_book_page_preview_settings.sql';

function copyPre030Migrations(parentDir) {
  const target = path.join(parentDir, 'pre-030');
  fs.mkdirSync(target);
  for (const filename of fs.readdirSync(MIGRATIONS_DIR)) {
    if (filename.endsWith('.sql') && filename.localeCompare(MIGRATION_FILENAME) < 0) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(target, filename));
    }
  }
  return target;
}

describe('Book Page-preview settings migration (030)', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-page-preview-migration-'));
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('upgrades an existing pre-030 database without backfilling settings', () => {
    db = openDatabase(path.join(tmpDir, 'upgrade.db'));
    const pre030 = copyPre030Migrations(tmpDir);
    runMigrations(db, pre030);
    const bookId = Number(db.prepare(
      'INSERT INTO books (title, sort_order) VALUES (?, ?)'
    ).run('Existing Book', 0).lastInsertRowid);
    const pageId = Number(db.prepare(`
      INSERT INTO notes (book_id, chapter_id, title, content, sort_order)
      VALUES (?, NULL, 'Existing Page', '', 0)
    `).run(bookId).lastInsertRowid);

    fs.copyFileSync(path.join(MIGRATIONS_DIR, MIGRATION_FILENAME), path.join(pre030, MIGRATION_FILENAME));
    runMigrations(db, pre030);

    expect(db.prepare('SELECT * FROM book_page_preview_settings').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM book_page_preview_pages').all()).toEqual([]);
    expect(db.prepare('SELECT id FROM books').pluck().all()).toEqual([bookId]);
    expect(db.prepare('SELECT id FROM notes').pluck().all()).toEqual([pageId]);
    expect(db.prepare('SELECT filename FROM schema_migrations WHERE filename = ?')
      .pluck().get(MIGRATION_FILENAME)).toBe(MIGRATION_FILENAME);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('enforces schema constraints and cascade cleanup', () => {
    db = openDatabase(path.join(tmpDir, 'constraints.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const bookId = Number(db.prepare(
      'INSERT INTO books (title, sort_order) VALUES (?, ?)'
    ).run('Book', 0).lastInsertRowid);
    const pageId = Number(db.prepare(`
      INSERT INTO notes (book_id, chapter_id, title, content, sort_order)
      VALUES (?, NULL, 'Page', '', 0)
    `).run(bookId).lastInsertRowid);

    expect(() => db.prepare(`
      INSERT INTO book_page_preview_settings (book_id, mode, random_count)
      VALUES (?, 'invalid', 5)
    `).run(bookId)).toThrow();
    for (const randomCount of [0, 26, 1.5]) {
      expect(() => db.prepare(`
        INSERT INTO book_page_preview_settings (book_id, mode, random_count)
        VALUES (?, 'random', ?)
      `).run(bookId, randomCount)).toThrow();
    }

    db.prepare(`
      INSERT INTO book_page_preview_settings (book_id, mode, random_count)
      VALUES (?, 'selected', 5)
    `).run(bookId);
    db.prepare('INSERT INTO book_page_preview_pages (book_id, page_id) VALUES (?, ?)')
      .run(bookId, pageId);
    db.prepare('DELETE FROM notes WHERE id = ?').run(pageId);
    expect(db.prepare('SELECT * FROM book_page_preview_pages').all()).toEqual([]);
    db.prepare('DELETE FROM books WHERE id = ?').run(bookId);
    expect(db.prepare('SELECT * FROM book_page_preview_settings').all()).toEqual([]);
  });
});
