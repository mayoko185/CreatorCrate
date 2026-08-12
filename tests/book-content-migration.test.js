import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const PRE_010_MIGRATION_FILENAMES = [
  '001_initial.sql',
  '002_add_completed_status.sql',
  '003_remove_project_priority.sql',
  '004_add_primary_image_provenance.sql',
  '005_add_notes_table.sql',
  '006_add_note_associations.sql',
  '007_add_asset_picker_order_index.sql',
  '008_add_note_hierarchy.sql',
  '009_add_note_book_id.sql',
];

function createPre010MigrationsDir(parentDir) {
  const legacyDir = path.join(parentDir, 'pre-010-migrations');
  fs.mkdirSync(legacyDir);
  for (const filename of PRE_010_MIGRATION_FILENAMES) {
    fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(legacyDir, filename));
  }
  return legacyDir;
}

function insertBook(db, title, sortOrder, createdAt = '2026-01-01 00:00:00', updatedAt = '2026-01-02 00:00:00') {
  return Number(db.prepare(`
    INSERT INTO books (title, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(title, sortOrder, createdAt, updatedAt).lastInsertRowid);
}

function insertChapter(
  db,
  bookId,
  title,
  sortOrder,
  createdAt = '2026-01-03 00:00:00',
  updatedAt = '2026-01-04 00:00:00',
) {
  return Number(db.prepare(`
    INSERT INTO chapters (book_id, title, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(bookId, title, sortOrder, createdAt, updatedAt).lastInsertRowid);
}

function insertPage(db, {
  bookId,
  chapterId = null,
  title,
  content,
  sortOrder,
  createdAt = '2026-02-01 00:00:00',
  updatedAt = '2026-02-02 00:00:00',
}) {
  return Number(db.prepare(`
    INSERT INTO notes (book_id, chapter_id, title, content, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(bookId, chapterId, title, content, sortOrder, createdAt, updatedAt).lastInsertRowid);
}

function contentsForBook(db, bookId) {
  return db.prepare(`
    SELECT book_id, item_type, item_id, sort_order
    FROM book_contents
    WHERE book_id = ?
    ORDER BY sort_order
  `).all(bookId);
}

function indexSignatures(db) {
  return db.pragma("index_list('book_contents')")
    .map((index) => ({
      name: index.name,
      unique: index.unique,
      columns: db.pragma(`index_info('${index.name}')`).map((column) => column.name),
    }))
    .sort((left, right) => left.columns.join(',').localeCompare(right.columns.join(',')));
}

function existingDataSnapshot(db) {
  return {
    books: db.prepare('SELECT * FROM books ORDER BY id').all(),
    chapters: db.prepare('SELECT * FROM chapters ORDER BY id').all(),
    notes: db.prepare('SELECT * FROM notes ORDER BY id').all(),
    projects: db.prepare('SELECT * FROM projects ORDER BY id').all(),
    assets: db.prepare('SELECT * FROM assets ORDER BY id').all(),
    noteProjects: db.prepare('SELECT * FROM note_projects ORDER BY note_id, project_id').all(),
    noteAssets: db.prepare('SELECT * FROM note_assets ORDER BY note_id, asset_id').all(),
    sqliteSequence: db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all(),
  };
}

describe('Book-content migration (010_add_book_contents)', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-content-migration-'));
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the schema, generated unique indexes, and no rows on an empty database', () => {
    db = openDatabase(path.join(tmpDir, 'fresh.db'));
    runMigrations(db, MIGRATIONS_DIR);

    expect(db.pragma("table_info('book_contents')")).toEqual([
      { cid: 0, name: 'book_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
      { cid: 1, name: 'item_type', type: 'TEXT', notnull: 1, dflt_value: null, pk: 2 },
      { cid: 2, name: 'item_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 3 },
      { cid: 3, name: 'sort_order', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    ]);
    expect(db.pragma("foreign_key_list('book_contents')")).toEqual([
      expect.objectContaining({ from: 'book_id', table: 'books', to: 'id', on_delete: 'RESTRICT' }),
    ]);
    expect(contentsForBook(db, 1)).toEqual([]);

    const indexes = db.pragma("index_list('book_contents')");
    expect(indexes).toHaveLength(2);
    expect(indexes.every(({ name }) => name.startsWith('sqlite_autoindex_book_contents_'))).toBe(true);
    expect(indexSignatures(db).map(({ unique, columns }) => ({ unique, columns }))).toEqual([
      { unique: 1, columns: ['book_id', 'item_type', 'item_id'] },
      { unique: 1, columns: ['book_id', 'sort_order'] },
    ]);

    expect(db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all()).toEqual([
      ...PRE_010_MIGRATION_FILENAMES,
      '010_add_book_contents.sql',
    ]);
    runMigrations(db, MIGRATIONS_DIR);
    expect(db.prepare('SELECT COUNT(*) FROM book_contents').pluck().get()).toBe(0);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('backfills Chapters only in current Chapter order with contiguous positions', () => {
    db = openDatabase(path.join(tmpDir, 'chapters-only.db'));
    runMigrations(db, createPre010MigrationsDir(tmpDir));

    const bookId = insertBook(db, 'Chapters Only', 0);
    const laterChapterId = insertChapter(db, bookId, 'Later', 5);
    const firstTiedChapterId = insertChapter(db, bookId, 'First Tie', 1);
    const secondTiedChapterId = insertChapter(db, bookId, 'Second Tie', 1);

    runMigrations(db, MIGRATIONS_DIR);

    const rows = contentsForBook(db, bookId);
    expect(rows).toEqual([
      { book_id: bookId, item_type: 'chapter', item_id: firstTiedChapterId, sort_order: 0 },
      { book_id: bookId, item_type: 'chapter', item_id: secondTiedChapterId, sort_order: 1 },
      { book_id: bookId, item_type: 'chapter', item_id: laterChapterId, sort_order: 2 },
    ]);
    expect(rows.map((row) => row.sort_order)).toEqual([0, 1, 2]);
  });

  it('backfills direct Pages only, preserving direct order and excluding Chapter Pages', () => {
    db = openDatabase(path.join(tmpDir, 'direct-pages.db'));
    runMigrations(db, createPre010MigrationsDir(tmpDir));

    const directBookId = insertBook(db, 'Direct Pages', 0);
    const firstDirectPageId = insertPage(db, {
      bookId: directBookId, title: 'First Tie', content: 'first', sortOrder: 2,
    });
    const secondDirectPageId = insertPage(db, {
      bookId: directBookId, title: 'Second Tie', content: 'second', sortOrder: 0,
    });
    const thirdDirectPageId = insertPage(db, {
      bookId: directBookId, title: 'Third Tie', content: 'third', sortOrder: 0,
    });

    const chapterBookId = insertBook(db, 'Chapter Pages', 1);
    const chapterId = insertChapter(db, chapterBookId, 'Chapter', 0);
    const chapterPageId = insertPage(db, {
      bookId: chapterBookId,
      chapterId,
      title: 'Chapter Page',
      content: 'chapter content',
      sortOrder: 0,
    });

    runMigrations(db, MIGRATIONS_DIR);

    expect(contentsForBook(db, directBookId)).toEqual([
      { book_id: directBookId, item_type: 'page', item_id: secondDirectPageId, sort_order: 0 },
      { book_id: directBookId, item_type: 'page', item_id: thirdDirectPageId, sort_order: 1 },
      { book_id: directBookId, item_type: 'page', item_id: firstDirectPageId, sort_order: 2 },
    ]);
    expect(contentsForBook(db, chapterBookId)).toEqual([
      { book_id: chapterBookId, item_type: 'chapter', item_id: chapterId, sort_order: 0 },
    ]);
    expect(db.prepare(`
      SELECT COUNT(*)
      FROM book_contents
      WHERE item_type = 'page' AND item_id = ?
    `).pluck().get(chapterPageId)).toBe(0);
  });

  it('places Chapters before direct Pages and preserves both relative orders', () => {
    db = openDatabase(path.join(tmpDir, 'mixed-book.db'));
    runMigrations(db, createPre010MigrationsDir(tmpDir));

    const bookId = insertBook(db, 'Mixed Book', 0);
    const highChapterId = insertChapter(db, bookId, 'High Chapter', 9);
    const firstLowChapterId = insertChapter(db, bookId, 'First Low Chapter', 1);
    const secondLowChapterId = insertChapter(db, bookId, 'Second Low Chapter', 1);
    const chapterPageId = insertPage(db, {
      bookId,
      chapterId: firstLowChapterId,
      title: 'Nested Page',
      content: 'nested',
      sortOrder: 0,
    });
    const lateDirectPageId = insertPage(db, {
      bookId, title: 'Late Direct Page', content: 'late', sortOrder: 4,
    });
    const firstDirectPageId = insertPage(db, {
      bookId, title: 'First Direct Page', content: 'first', sortOrder: 0,
    });
    const secondDirectPageId = insertPage(db, {
      bookId, title: 'Second Direct Page', content: 'second', sortOrder: 0,
    });

    runMigrations(db, MIGRATIONS_DIR);

    const rows = contentsForBook(db, bookId);
    expect(rows).toEqual([
      { book_id: bookId, item_type: 'chapter', item_id: firstLowChapterId, sort_order: 0 },
      { book_id: bookId, item_type: 'chapter', item_id: secondLowChapterId, sort_order: 1 },
      { book_id: bookId, item_type: 'chapter', item_id: highChapterId, sort_order: 2 },
      { book_id: bookId, item_type: 'page', item_id: firstDirectPageId, sort_order: 3 },
      { book_id: bookId, item_type: 'page', item_id: secondDirectPageId, sort_order: 4 },
      { book_id: bookId, item_type: 'page', item_id: lateDirectPageId, sort_order: 5 },
    ]);
    expect(rows.map((row) => row.sort_order)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rows.some((row) => row.item_type === 'page' && row.item_id === chapterPageId)).toBe(false);
  });

  it('restarts each Book sequence at zero without cross-Book membership leakage', () => {
    db = openDatabase(path.join(tmpDir, 'multiple-books.db'));
    runMigrations(db, createPre010MigrationsDir(tmpDir));

    const firstBookId = insertBook(db, 'First Book', 4);
    const firstChapterId = insertChapter(db, firstBookId, 'First Chapter', 0);
    const firstPageId = insertPage(db, {
      bookId: firstBookId, title: 'First Page', content: 'first', sortOrder: 8,
    });
    const secondBookId = insertBook(db, 'Second Book', 1);
    const secondPageId = insertPage(db, {
      bookId: secondBookId, title: 'Second Page', content: 'second', sortOrder: 2,
    });

    runMigrations(db, MIGRATIONS_DIR);

    expect(contentsForBook(db, firstBookId)).toEqual([
      { book_id: firstBookId, item_type: 'chapter', item_id: firstChapterId, sort_order: 0 },
      { book_id: firstBookId, item_type: 'page', item_id: firstPageId, sort_order: 1 },
    ]);
    expect(contentsForBook(db, secondBookId)).toEqual([
      { book_id: secondBookId, item_type: 'page', item_id: secondPageId, sort_order: 0 },
    ]);
    expect(db.prepare('SELECT DISTINCT book_id FROM book_contents ORDER BY book_id').pluck().all())
      .toEqual([firstBookId, secondBookId]);
  });

  it('preserves the real pre-010 hierarchy, associations, timestamps, IDs, ordering, and sequences', () => {
    db = openDatabase(path.join(tmpDir, 'upgrade.db'));
    runMigrations(db, createPre010MigrationsDir(tmpDir));

    const firstBookId = insertBook(db, 'First Book', 7, '2026-01-01 10:00:00', '2026-01-02 10:00:00');
    const secondBookId = insertBook(db, 'Second Book', 2, '2026-01-03 10:00:00', '2026-01-04 10:00:00');
    const firstHighChapterId = insertChapter(
      db, firstBookId, 'First High Chapter', 9, '2026-01-05 10:00:00', '2026-01-06 10:00:00',
    );
    const firstLowChapterId = insertChapter(
      db, firstBookId, 'First Low Chapter', 1, '2026-01-07 10:00:00', '2026-01-08 10:00:00',
    );
    const secondChapterId = insertChapter(
      db, secondBookId, 'Second Chapter', 0, '2026-01-09 10:00:00', '2026-01-10 10:00:00',
    );

    const projectId = Number(db.prepare(`
      INSERT INTO projects (title, slug, description, status, created_at, updated_at)
      VALUES ('Migration Project', 'migration-project', 'Preserve this project', 'tbd', '2026-01-11 10:00:00', '2026-01-12 10:00:00')
    `).run().lastInsertRowid);
    const otherProjectId = Number(db.prepare(`
      INSERT INTO projects (title, slug, description, status, created_at, updated_at)
      VALUES ('Other Project', 'other-project', 'Preserve this other project', 'ready', '2026-01-13 10:00:00', '2026-01-14 10:00:00')
    `).run().lastInsertRowid);
    const assetId = Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, created_at, updated_at)
      VALUES (?, 'migration/present.png', 'present.png', '2026-01-15 10:00:00', '2026-01-16 10:00:00')
    `).run(projectId).lastInsertRowid);
    const otherAssetId = Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, created_at, updated_at)
      VALUES (?, 'other/asset.png', 'asset.png', '2026-01-17 10:00:00', '2026-01-18 10:00:00')
    `).run(otherProjectId).lastInsertRowid);

    const nestedPageId = insertPage(db, {
      bookId: firstBookId,
      chapterId: firstLowChapterId,
      title: 'Nested Page',
      content: '# Nested content',
      sortOrder: 3,
      createdAt: '2026-01-19 10:00:00',
      updatedAt: '2026-01-20 10:00:00',
    });
    const firstDirectPageId = insertPage(db, {
      bookId: firstBookId,
      title: 'First Direct Page',
      content: '# First direct content',
      sortOrder: 5,
      createdAt: '2026-01-21 10:00:00',
      updatedAt: '2026-01-22 10:00:00',
    });
    const secondDirectPageId = insertPage(db, {
      bookId: firstBookId,
      title: 'Second Direct Page',
      content: '# Second direct content',
      sortOrder: 0,
      createdAt: '2026-01-23 10:00:00',
      updatedAt: '2026-01-24 10:00:00',
    });
    const otherNestedPageId = insertPage(db, {
      bookId: secondBookId,
      chapterId: secondChapterId,
      title: 'Other Nested Page',
      content: 'Other nested content',
      sortOrder: 0,
      createdAt: '2026-01-25 10:00:00',
      updatedAt: '2026-01-26 10:00:00',
    });
    const otherDirectPageId = insertPage(db, {
      bookId: secondBookId,
      title: 'Other Direct Page',
      content: 'Other direct content',
      sortOrder: 2,
      createdAt: '2026-01-27 10:00:00',
      updatedAt: '2026-01-28 10:00:00',
    });

    db.prepare('INSERT INTO note_projects (note_id, project_id) VALUES (?, ?), (?, ?), (?, ?)')
      .run(nestedPageId, projectId, firstDirectPageId, otherProjectId, otherDirectPageId, projectId);
    db.prepare('INSERT INTO note_assets (note_id, asset_id) VALUES (?, ?), (?, ?), (?, ?)')
      .run(nestedPageId, assetId, firstDirectPageId, otherAssetId, otherNestedPageId, assetId);

    const before = existingDataSnapshot(db);
    const expectedContents = [
      { book_id: firstBookId, item_type: 'chapter', item_id: firstLowChapterId, sort_order: 0 },
      { book_id: firstBookId, item_type: 'chapter', item_id: firstHighChapterId, sort_order: 1 },
      { book_id: firstBookId, item_type: 'page', item_id: secondDirectPageId, sort_order: 2 },
      { book_id: firstBookId, item_type: 'page', item_id: firstDirectPageId, sort_order: 3 },
      { book_id: secondBookId, item_type: 'chapter', item_id: secondChapterId, sort_order: 0 },
      { book_id: secondBookId, item_type: 'page', item_id: otherDirectPageId, sort_order: 1 },
    ];

    runMigrations(db, MIGRATIONS_DIR);

    expect(existingDataSnapshot(db)).toEqual(before);
    expect(db.prepare('SELECT filename FROM schema_migrations ORDER BY rowid').pluck().all())
      .toEqual([...PRE_010_MIGRATION_FILENAMES, '010_add_book_contents.sql']);
    expect(db.prepare('SELECT * FROM book_contents ORDER BY book_id, sort_order').all())
      .toEqual(expectedContents);
    expect(db.prepare(`
      SELECT COUNT(*)
      FROM book_contents
      JOIN notes ON notes.id = book_contents.item_id
      WHERE book_contents.item_type = 'page' AND notes.chapter_id IS NOT NULL
    `).pluck().get()).toBe(0);
    expect(db.prepare(`
      SELECT item_id, COUNT(*) AS membership_count
      FROM book_contents
      WHERE item_type = 'chapter'
      GROUP BY item_id
      ORDER BY item_id
    `).all()).toEqual([
      { item_id: firstHighChapterId, membership_count: 1 },
      { item_id: firstLowChapterId, membership_count: 1 },
      { item_id: secondChapterId, membership_count: 1 },
    ]);
    expect(db.prepare(`
      SELECT item_id, COUNT(*) AS membership_count
      FROM book_contents
      WHERE item_type = 'page'
      GROUP BY item_id
      ORDER BY item_id
    `).all()).toEqual([
      { item_id: firstDirectPageId, membership_count: 1 },
      { item_id: secondDirectPageId, membership_count: 1 },
      { item_id: otherDirectPageId, membership_count: 1 },
    ]);
    expect(db.prepare(`
      SELECT book_id, COUNT(*) AS item_count,
        MIN(sort_order) AS first_position,
        MAX(sort_order) AS last_position,
        COUNT(DISTINCT sort_order) AS distinct_positions
      FROM book_contents
      GROUP BY book_id
      ORDER BY book_id
    `).all()).toEqual([
      { book_id: firstBookId, item_count: 4, first_position: 0, last_position: 3, distinct_positions: 4 },
      { book_id: secondBookId, item_count: 2, first_position: 0, last_position: 1, distinct_positions: 2 },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('enforces item type, position, membership, and Book foreign-key constraints', () => {
    db = openDatabase(path.join(tmpDir, 'constraints.db'));
    runMigrations(db, createPre010MigrationsDir(tmpDir));
    const bookId = insertBook(db, 'Constraint Book', 0);
    runMigrations(db, MIGRATIONS_DIR);

    const insert = db.prepare(`
      INSERT INTO book_contents (book_id, item_type, item_id, sort_order)
      VALUES (?, ?, ?, ?)
    `);
    expect(() => insert.run(bookId, 'invalid', 1, 0)).toThrow(/CHECK constraint failed/i);
    expect(() => insert.run(bookId, 'chapter', 1, -1)).toThrow(/CHECK constraint failed/i);

    insert.run(bookId, 'chapter', 1, 0);
    expect(() => insert.run(bookId, 'chapter', 1, 1)).toThrow(/UNIQUE constraint failed/i);
    expect(() => insert.run(bookId, 'page', 2, 0)).toThrow(/UNIQUE constraint failed/i);
    expect(() => insert.run(999999, 'page', 3, 1)).toThrow(/FOREIGN KEY constraint failed/i);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
