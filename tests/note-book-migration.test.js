import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const PRE_009_MIGRATION_FILENAMES = [
  '001_initial.sql',
  '002_add_completed_status.sql',
  '003_remove_project_priority.sql',
  '004_add_primary_image_provenance.sql',
  '005_add_notes_table.sql',
  '006_add_note_associations.sql',
  '007_add_asset_picker_order_index.sql',
  '008_add_note_hierarchy.sql',
];

function createPre009MigrationsDir(parentDir) {
  const legacyDir = path.join(parentDir, 'pre-009-migrations');
  fs.mkdirSync(legacyDir);
  for (const filename of PRE_009_MIGRATION_FILENAMES) {
    fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(legacyDir, filename));
  }
  return legacyDir;
}

function indexColumns(db, name) {
  return db.pragma(`index_info('${name}')`).map((column) => column.name);
}

function foreignKey(db, from) {
  return db.pragma("foreign_key_list('notes')").find((key) => key.from === from);
}

function sequenceForNotes(db) {
  return db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'notes'").pluck().get();
}

function insertBook(db, title, sortOrder) {
  return Number(db.prepare(`
    INSERT INTO books (title, sort_order, created_at, updated_at)
    VALUES (?, ?, '2026-01-01 00:00:00', '2026-01-02 00:00:00')
  `).run(title, sortOrder).lastInsertRowid);
}

function insertChapter(db, bookId, title, sortOrder) {
  return Number(db.prepare(`
    INSERT INTO chapters (book_id, title, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, '2026-01-03 00:00:00', '2026-01-04 00:00:00')
  `).run(bookId, title, sortOrder).lastInsertRowid);
}

function insertLegacyNote(db, chapterId, title, content, sortOrder, createdAt, updatedAt) {
  return Number(db.prepare(`
    INSERT INTO notes (chapter_id, title, content, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(chapterId, title, content, sortOrder, createdAt, updatedAt).lastInsertRowid);
}

function insertPage(db, bookId, chapterId, title = 'Page', content = 'Content') {
  return db.prepare(`
    INSERT INTO notes (book_id, chapter_id, title, content, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, '2026-02-01 00:00:00', '2026-02-02 00:00:00')
  `).run(bookId, chapterId, title, content);
}

describe('note Book parent migration (009_add_note_book_id)', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-note-book-migration-'));
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the final notes schema and indexes on a fresh database', () => {
    db = openDatabase(path.join(tmpDir, 'fresh.db'));
    runMigrations(db, MIGRATIONS_DIR);

    expect(db.pragma("table_info('notes')")).toEqual([
      { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
      { cid: 1, name: 'book_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 2, name: 'chapter_id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
      { cid: 3, name: 'title', type: 'TEXT', notnull: 1, dflt_value: "''", pk: 0 },
      { cid: 4, name: 'content', type: 'TEXT', notnull: 1, dflt_value: "''", pk: 0 },
      { cid: 5, name: 'sort_order', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
      { cid: 6, name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: "datetime('now')", pk: 0 },
      { cid: 7, name: 'updated_at', type: 'TEXT', notnull: 1, dflt_value: "datetime('now')", pk: 0 },
    ]);
    expect(foreignKey(db, 'book_id')).toMatchObject({
      table: 'books', to: 'id', on_delete: 'RESTRICT',
    });
    expect(foreignKey(db, 'chapter_id')).toMatchObject({
      table: 'chapters', to: 'id', on_delete: 'RESTRICT',
    });
    expect(indexColumns(db, 'idx_notes_book_chapter_sort_order'))
      .toEqual(['book_id', 'chapter_id', 'sort_order', 'id']);
    expect(indexColumns(db, 'idx_notes_chapter_sort_order'))
      .toEqual(['chapter_id', 'sort_order', 'id']);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'book_contents'").get())
      .toBeTruthy();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('backfills each existing Note from its Chapter and preserves data, associations, and sequence history', () => {
    db = openDatabase(path.join(tmpDir, 'upgrade.db'));
    runMigrations(db, createPre009MigrationsDir(tmpDir));

    const firstBookId = insertBook(db, 'First Book', 0);
    const secondBookId = insertBook(db, 'Second Book', 1);
    const firstChapterId = insertChapter(db, firstBookId, 'First Chapter', 0);
    const secondChapterId = insertChapter(db, secondBookId, 'Second Chapter', 0);

    const projectId = Number(db.prepare(`
      INSERT INTO projects (title, slug, status) VALUES ('Migration Project', 'migration-project', 'tbd')
    `).run().lastInsertRowid);
    const otherProjectId = Number(db.prepare(`
      INSERT INTO projects (title, slug, status) VALUES ('Other Project', 'other-project', 'tbd')
    `).run().lastInsertRowid);
    const assetId = Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, is_present)
      VALUES (?, 'migration.png', 'migration.png', 1)
    `).run(projectId).lastInsertRowid);
    const otherAssetId = Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, is_present)
      VALUES (?, 'other.png', 'other.png', 1)
    `).run(otherProjectId).lastInsertRowid);

    const firstNoteId = insertLegacyNote(
      db, firstChapterId, 'First Page', '# First page', 7,
      '2026-01-05 10:00:00', '2026-01-06 10:00:00',
    );
    const secondNoteId = insertLegacyNote(
      db, secondChapterId, 'Second Page', 'Second page', 2,
      '2026-01-07 10:00:00', '2026-01-08 10:00:00',
    );
    const deletedHighNoteId = insertLegacyNote(
      db, firstChapterId, 'Deleted High Page', 'High-water marker', 99,
      '2026-01-09 10:00:00', '2026-01-10 10:00:00',
    );
    db.prepare('DELETE FROM notes WHERE id = ?').run(deletedHighNoteId);

    db.prepare('INSERT INTO note_projects (note_id, project_id) VALUES (?, ?), (?, ?)')
      .run(firstNoteId, projectId, secondNoteId, otherProjectId);
    db.prepare('INSERT INTO note_assets (note_id, asset_id) VALUES (?, ?), (?, ?)')
      .run(firstNoteId, assetId, secondNoteId, otherAssetId);

    const beforeNotes = db.prepare(`
      SELECT id, chapter_id, title, content, sort_order, created_at, updated_at
      FROM notes ORDER BY id
    `).all();
    const beforeProjectAssociations = db.prepare(`
      SELECT note_id, project_id FROM note_projects ORDER BY note_id, project_id
    `).all();
    const beforeAssetAssociations = db.prepare(`
      SELECT note_id, asset_id FROM note_assets ORDER BY note_id, asset_id
    `).all();
    const highWaterBefore = sequenceForNotes(db);

    runMigrations(db, MIGRATIONS_DIR);

    const afterNotes = db.prepare(`
      SELECT id, book_id, chapter_id, title, content, sort_order, created_at, updated_at
      FROM notes ORDER BY id
    `).all();
    expect(afterNotes.map(({ book_id: _bookId, ...legacyFields }) => legacyFields)).toEqual(beforeNotes);
    expect(afterNotes.map((note) => note.book_id)).toEqual([firstBookId, secondBookId]);
    expect(afterNotes.map((note) => note.chapter_id)).toEqual([firstChapterId, secondChapterId]);
    expect(db.prepare('SELECT note_id, project_id FROM note_projects ORDER BY note_id, project_id').all())
      .toEqual(beforeProjectAssociations);
    expect(db.prepare('SELECT note_id, asset_id FROM note_assets ORDER BY note_id, asset_id').all())
      .toEqual(beforeAssetAssociations);
    expect(sequenceForNotes(db)).toBe(highWaterBefore);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    const directPage = insertPage(db, firstBookId, null, 'Direct Page', 'Direct content');
    expect(Number(directPage.lastInsertRowid)).toBe(highWaterBefore + 1);
    expect(db.prepare('SELECT book_id, chapter_id FROM notes WHERE id = ?')
      .get(directPage.lastInsertRowid)).toEqual({ book_id: firstBookId, chapter_id: null });
  });

  it('accepts direct Pages while rejecting NULL and invalid foreign keys', () => {
    db = openDatabase(path.join(tmpDir, 'constraints.db'));
    runMigrations(db, createPre009MigrationsDir(tmpDir));
    const bookId = insertBook(db, 'Constraint Book', 0);
    const chapterId = insertChapter(db, bookId, 'Constraint Chapter', 0);
    runMigrations(db, MIGRATIONS_DIR);

    const insert = db.prepare(`
      INSERT INTO notes (book_id, chapter_id, title, content, sort_order, created_at, updated_at)
      VALUES (?, ?, 'Page', 'Content', 0, '2026-03-01 00:00:00', '2026-03-02 00:00:00')
    `);

    expect(() => insert.run(null, chapterId)).toThrow(/NOT NULL/i);
    expect(() => insert.run(999999, null)).toThrow(/FOREIGN KEY/i);
    expect(() => insert.run(bookId, 999999)).toThrow(/FOREIGN KEY/i);

    const directPageId = Number(insert.run(bookId, null).lastInsertRowid);
    expect(db.prepare('SELECT book_id, chapter_id FROM notes WHERE id = ?').get(directPageId))
      .toEqual({ book_id: bookId, chapter_id: null });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('rolls back instead of discarding a Note whose Chapter or Book cannot be backfilled', () => {
    db = openDatabase(path.join(tmpDir, 'malformed.db'));
    runMigrations(db, createPre009MigrationsDir(tmpDir));
    const bookId = insertBook(db, 'Malformed Book', 0);
    insertChapter(db, bookId, 'Valid Chapter', 0);

    db.pragma('foreign_keys = OFF');
    const malformedNoteId = insertLegacyNote(
      db, 999999, 'Malformed Page', 'Must survive rollback', 0,
      '2026-04-01 00:00:00', '2026-04-02 00:00:00',
    );
    db.pragma('foreign_keys = ON');

    expect(() => runMigrations(db, MIGRATIONS_DIR)).toThrow(/009_add_note_book_id/i);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare('SELECT id, chapter_id, title FROM notes WHERE id = ?').get(malformedNoteId))
      .toEqual({ id: malformedNoteId, chapter_id: 999999, title: 'Malformed Page' });
    expect(db.pragma("table_info('notes')").find((column) => column.name === 'book_id')).toBeUndefined();
    expect(db.prepare('SELECT filename FROM schema_migrations WHERE filename = ?')
      .get('009_add_note_book_id.sql')).toBeUndefined();
  });
});
