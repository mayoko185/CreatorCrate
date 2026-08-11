import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { BookError, createBookRepository } from '../src/data/book-repository.js';
import { ChapterError, createChapterRepository } from '../src/data/chapter-repository.js';
import { createNoteRepository } from '../src/data/note-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const LEGACY_MIGRATION_FILENAMES = [
  '001_initial.sql',
  '002_add_completed_status.sql',
  '003_remove_project_priority.sql',
  '004_add_primary_image_provenance.sql',
  '005_add_notes_table.sql',
  '006_add_note_associations.sql',
  '007_add_asset_picker_order_index.sql',
];

function createLegacyMigrationsDir(parentDir) {
  const legacyDir = path.join(parentDir, 'legacy-migrations');
  fs.mkdirSync(legacyDir);
  for (const filename of LEGACY_MIGRATION_FILENAMES) {
    fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(legacyDir, filename));
  }
  return legacyDir;
}

function indexColumns(db, name) {
  return db.pragma(`index_info('${name}')`).map((column) => column.name);
}

function foreignKey(db, table, from) {
  return db.pragma(`foreign_key_list('${table}')`).find((key) => key.from === from);
}

describe('note hierarchy migration (008_add_note_hierarchy)', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-note-hierarchy-migration-'));
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the hierarchy schema on a fresh database without seeding containers', () => {
    db = openDatabase(path.join(tmpDir, 'fresh.db'));
    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name IN ('books', 'chapters', 'notes')
      ORDER BY name
    `).pluck().all()).toEqual(['books', 'chapters', 'notes']);
    expect(db.prepare('SELECT COUNT(*) FROM books').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM chapters').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM notes').pluck().get()).toBe(0);

    expect(db.pragma("table_info('books')")).toEqual([
      { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
      { cid: 1, name: 'title', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 2, name: 'sort_order', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 3, name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: "datetime('now')", pk: 0 },
      { cid: 4, name: 'updated_at', type: 'TEXT', notnull: 1, dflt_value: "datetime('now')", pk: 0 },
    ]);
    expect(db.pragma("table_info('chapters')")).toEqual([
      { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
      { cid: 1, name: 'book_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 2, name: 'title', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 3, name: 'sort_order', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 4, name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: "datetime('now')", pk: 0 },
      { cid: 5, name: 'updated_at', type: 'TEXT', notnull: 1, dflt_value: "datetime('now')", pk: 0 },
    ]);
    expect(db.pragma("table_info('notes')")).toEqual([
      { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
      { cid: 1, name: 'chapter_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { cid: 2, name: 'title', type: 'TEXT', notnull: 1, dflt_value: "''", pk: 0 },
      { cid: 3, name: 'content', type: 'TEXT', notnull: 1, dflt_value: "''", pk: 0 },
      { cid: 4, name: 'sort_order', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
      { cid: 5, name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: "datetime('now')", pk: 0 },
      { cid: 6, name: 'updated_at', type: 'TEXT', notnull: 1, dflt_value: "datetime('now')", pk: 0 },
    ]);

    expect(indexColumns(db, 'idx_books_sort_order')).toEqual(['sort_order', 'id']);
    expect(indexColumns(db, 'idx_chapters_book_sort_order')).toEqual(['book_id', 'sort_order', 'id']);
    expect(indexColumns(db, 'idx_notes_chapter_sort_order')).toEqual(['chapter_id', 'sort_order', 'id']);
    expect(db.pragma("index_list('notes')").map((index) => index.name))
      .not.toContain('idx_notes_sort_order');

    expect(foreignKey(db, 'chapters', 'book_id')).toMatchObject({
      table: 'books', to: 'id', on_delete: 'RESTRICT',
    });
    expect(foreignKey(db, 'notes', 'chapter_id')).toMatchObject({
      table: 'chapters', to: 'id', on_delete: 'RESTRICT',
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('backfills existing Notes without losing IDs, associations, content, timestamps, or sequence history', () => {
    db = openDatabase(path.join(tmpDir, 'upgrade.db'));
    runMigrations(db, createLegacyMigrationsDir(tmpDir));

    const projectId = Number(db.prepare(`
      INSERT INTO projects (title, slug, status) VALUES ('Project One', 'project-one', 'tbd')
    `).run().lastInsertRowid);
    const otherProjectId = Number(db.prepare(`
      INSERT INTO projects (title, slug, status) VALUES ('Project Two', 'project-two', 'tbd')
    `).run().lastInsertRowid);
    const assetId = Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, is_present)
      VALUES (?, 'present.png', 'present.png', 1)
    `).run(projectId).lastInsertRowid);
    const missingAssetId = Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, is_present, missing_since)
      VALUES (?, 'missing.png', 'missing.png', 0, '2026-02-01 00:00:00')
    `).run(otherProjectId).lastInsertRowid);

    const insertNote = db.prepare(`
      INSERT INTO notes (title, content, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const firstNoteId = Number(insertNote.run(
      'First legacy Note', '# First\n\nKeep **this** Markdown unchanged.', 10,
      '2026-01-03 10:00:00', '2026-01-08 10:00:00',
    ).lastInsertRowid);
    const secondNoteId = Number(insertNote.run(
      'Second legacy Note', 'A tied legacy order.', 2,
      '2026-01-01 10:00:00', '2026-01-06 10:00:00',
    ).lastInsertRowid);
    const thirdNoteId = Number(insertNote.run(
      'Third legacy Note', 'Another tied legacy order.', 2,
      '2026-01-02 10:00:00', '2026-01-07 10:00:00',
    ).lastInsertRowid);
    const deletedHighNoteId = Number(insertNote.run(
      'Deleted high Note', 'This establishes the legacy AUTOINCREMENT high-water mark.', 99,
      '2026-01-04 10:00:00', '2026-01-09 10:00:00',
    ).lastInsertRowid);
    db.prepare('DELETE FROM notes WHERE id = ?').run(deletedHighNoteId);

    db.prepare('INSERT INTO note_projects (note_id, project_id) VALUES (?, ?), (?, ?), (?, ?)')
      .run(firstNoteId, projectId, firstNoteId, otherProjectId, secondNoteId, otherProjectId);
    db.prepare('INSERT INTO note_assets (note_id, asset_id) VALUES (?, ?), (?, ?), (?, ?)')
      .run(firstNoteId, assetId, secondNoteId, missingAssetId, thirdNoteId, assetId);

    const beforeNotes = db.prepare(`
      SELECT id, title, content, created_at, updated_at FROM notes ORDER BY id
    `).all();
    const beforeProjectAssociations = db.prepare(`
      SELECT note_id, project_id FROM note_projects ORDER BY note_id, project_id
    `).all();
    const beforeAssetAssociations = db.prepare(`
      SELECT note_id, asset_id FROM note_assets ORDER BY note_id, asset_id
    `).all();
    const highWaterBefore = db.prepare(`
      SELECT seq FROM sqlite_sequence WHERE name = 'notes'
    `).pluck().get();

    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare('SELECT title, sort_order, created_at, updated_at FROM books').all()).toEqual([{
      title: 'Notes',
      sort_order: 0,
      created_at: '2026-01-01 10:00:00',
      updated_at: '2026-01-08 10:00:00',
    }]);
    expect(db.prepare(`
      SELECT chapters.title, chapters.sort_order, chapters.created_at, chapters.updated_at, books.title AS book_title
      FROM chapters JOIN books ON books.id = chapters.book_id
    `).all()).toEqual([{
      title: 'Unfiled',
      sort_order: 0,
      created_at: '2026-01-01 10:00:00',
      updated_at: '2026-01-08 10:00:00',
      book_title: 'Notes',
    }]);
    expect(db.prepare(`
      SELECT id, title, content, created_at, updated_at FROM notes ORDER BY id
    `).all()).toEqual(beforeNotes);
    expect(db.prepare(`
      SELECT id, sort_order FROM notes ORDER BY sort_order ASC, id ASC
    `).all()).toEqual([
      { id: secondNoteId, sort_order: 0 },
      { id: thirdNoteId, sort_order: 1 },
      { id: firstNoteId, sort_order: 2 },
    ]);
    expect(db.prepare('SELECT note_id, project_id FROM note_projects ORDER BY note_id, project_id').all())
      .toEqual(beforeProjectAssociations);
    expect(db.prepare('SELECT note_id, asset_id FROM note_assets ORDER BY note_id, asset_id').all())
      .toEqual(beforeAssetAssociations);
    expect(db.prepare(`
      SELECT COUNT(*)
      FROM notes
      LEFT JOIN chapters ON chapters.id = notes.chapter_id
      WHERE chapters.id IS NULL
    `).pluck().get()).toBe(0);
    expect(db.prepare(`
      SELECT COUNT(*)
      FROM chapters
      LEFT JOIN books ON books.id = chapters.book_id
      WHERE books.id IS NULL
    `).pluck().get()).toBe(0);
    expect(db.prepare(`
      SELECT COUNT(*) FROM note_projects
      LEFT JOIN notes ON notes.id = note_projects.note_id
      WHERE notes.id IS NULL
    `).pluck().get()).toBe(0);
    expect(db.prepare(`
      SELECT COUNT(*) FROM note_assets
      LEFT JOIN notes ON notes.id = note_assets.note_id
      WHERE notes.id IS NULL
    `).pluck().get()).toBe(0);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    const highWaterAfter = db.prepare(`
      SELECT seq FROM sqlite_sequence WHERE name = 'notes'
    `).pluck().get();
    expect(highWaterAfter).toBeGreaterThanOrEqual(highWaterBefore);
    const chapterId = db.prepare('SELECT id FROM chapters WHERE title = ?').pluck().get('Unfiled');
    const nextNoteId = Number(db.prepare(`
      INSERT INTO notes (chapter_id, title, content, sort_order)
      VALUES (?, 'Post-migration Note', '', 3)
    `).run(chapterId).lastInsertRowid);
    expect(nextNoteId).toBe(deletedHighNoteId + 1);

    const bookId = db.prepare('SELECT id FROM books WHERE title = ?').pluck().get('Notes');
    const bookRepository = createBookRepository(db);
    const chapterRepository = createChapterRepository(db);
    const noteRepository = createNoteRepository(db);
    expect(bookRepository.findById(bookId)).toMatchObject({ title: 'Notes', sort_order: 0 });
    expect(chapterRepository.findById(chapterId)).toMatchObject({
      book_id: bookId,
      title: 'Unfiled',
      sort_order: 0,
    });
    expect(noteRepository.listForChapter(chapterId).map((note) => note.id)).toEqual([
      secondNoteId,
      thirdNoteId,
      firstNoteId,
      nextNoteId,
    ]);
    expect(noteRepository.reorder(chapterId, [firstNoteId, thirdNoteId, secondNoteId, nextNoteId])
      .map((note) => [note.id, note.sort_order])).toEqual([
      [firstNoteId, 0],
      [thirdNoteId, 1],
      [secondNoteId, 2],
      [nextNoteId, 3],
    ]);
    expect(noteRepository.deleteById(thirdNoteId)).toBe(true);
    expect(noteRepository.listForChapter(chapterId).map((note) => [note.id, note.sort_order]))
      .toEqual([
        [firstNoteId, 0],
        [secondNoteId, 1],
        [nextNoteId, 2],
      ]);
    const newChapter = chapterRepository.create({ bookId, title: 'Filed' });
    expect(noteRepository.moveToChapter(secondNoteId, newChapter.id))
      .toMatchObject({ chapter_id: newChapter.id, sort_order: 0 });
    expect(noteRepository.listForChapter(chapterId).map((note) => [note.id, note.sort_order]))
      .toEqual([[firstNoteId, 0], [nextNoteId, 1]]);
    expect(noteRepository.listForChapter(newChapter.id).map((note) => [note.id, note.sort_order]))
      .toEqual([[secondNoteId, 0]]);
    expect(() => chapterRepository.deleteAndCompact(chapterId)).toThrow(ChapterError);
    expect(() => chapterRepository.deleteAndCompact(chapterId)).toThrow(/contains Notes/);
    expect(() => bookRepository.deleteAndCompact(bookId)).toThrow(BookError);
    expect(() => bookRepository.deleteAndCompact(bookId)).toThrow(/contains chapters/);
    expect(() => db.prepare('DELETE FROM books WHERE id = ?').run(bookId)).toThrow(/FOREIGN KEY/i);
    expect(() => db.prepare('DELETE FROM chapters WHERE id = ?').run(chapterId)).toThrow(/FOREIGN KEY/i);
  });

  it('rolls back the hierarchy migration when its SQL fails part-way', () => {
    db = openDatabase(path.join(tmpDir, 'rollback.db'));
    const legacyDir = createLegacyMigrationsDir(tmpDir);
    runMigrations(db, legacyDir);
    db.prepare(`
      INSERT INTO notes (title, content, sort_order, created_at, updated_at)
      VALUES ('Legacy Note', 'unchanged', 4, '2026-01-01 00:00:00', '2026-01-02 00:00:00')
    `).run();

    const failingMigrationsDir = path.join(tmpDir, 'failing-migrations');
    fs.mkdirSync(failingMigrationsDir);
    for (const filename of LEGACY_MIGRATION_FILENAMES) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(failingMigrationsDir, filename));
    }
    fs.writeFileSync(
      path.join(failingMigrationsDir, '008_add_note_hierarchy.sql'),
      `${fs.readFileSync(path.join(MIGRATIONS_DIR, '008_add_note_hierarchy.sql'), 'utf8')}\nSELECT no_such_migration_function();\n`,
    );

    expect(() => runMigrations(db, failingMigrationsDir)).toThrow(/008_add_note_hierarchy/i);
    expect(db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('books', 'chapters')
    `).all()).toEqual([]);
    expect(db.pragma("table_info('notes')").map((column) => column.name))
      .toEqual(['id', 'title', 'content', 'sort_order', 'created_at', 'updated_at']);
    expect(db.prepare('SELECT id, title, content, sort_order FROM notes').all()).toEqual([{
      id: 1, title: 'Legacy Note', content: 'unchanged', sort_order: 4,
    }]);
    expect(db.prepare(`
      SELECT filename FROM schema_migrations WHERE filename = '008_add_note_hierarchy.sql'
    `).all()).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
