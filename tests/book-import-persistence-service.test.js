import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createBookImportPersistenceRepository } from '../src/data/book-import-persistence-repository.js';
import {
  BookImportPersistenceError,
  createBookImportPersistenceService,
} from '../src/services/book-import-persistence-service.js';
import { parseBookImportArchive } from '../src/services/book-import-service.js';
import { makeZip } from './helpers/zip-fixture.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const TS = Object.freeze({
  bookCreated: '2025-01-01 01:02:03',
  bookUpdated: '2025-01-02 02:03:04',
  chapterCreated: '2025-02-01 03:04:05',
  chapterUpdated: '2025-02-02 04:05:06',
  pageCreated: '2025-03-01 05:06:07',
  pageUpdated: '2025-03-02 06:07:08',
  newestSource: '2025-03-02 06:00:00',
  newestCreated: '2025-03-02 06:01:00',
  olderSource: '2025-02-28 05:00:00',
  olderCreated: '2025-02-28 05:01:00',
  oldestSource: '2025-02-27 04:00:00',
  oldestCreated: '2025-02-27 04:01:00',
});

function projectLocator(slug = 'portable-project') {
  return { slug, title: 'Portable Project', projectType: 'illustration' };
}

function assetLocator(slug = 'portable-project') {
  return {
    project: projectLocator(slug),
    relativePath: 'source/cover.webp',
    filename: 'cover.webp',
    extension: '.webp',
    mimeType: 'image/webp',
  };
}

function associations(label) {
  return {
    projects: [projectLocator(`${label}-project`)],
    assets: [assetLocator(`${label}-project`)],
    unresolvedProjectCount: 1,
    unresolvedAssetCount: 2,
  };
}

function revision(key, title, rawMarkdown, sourceUpdatedAt, createdAt) {
  return {
    key,
    title,
    rawMarkdown,
    sourceUpdatedAt,
    createdAt,
    associations: associations(key),
  };
}

function populatedBook({ key = 'book-900', title = 'Imported Book', cover } = {}) {
  const managedCover = cover ?? {
    kind: 'managed',
    media: {
      path: `covers/${key}/cover.webp`,
      mimeType: 'image/webp',
      sizeBytes: 4,
      width: 2,
      height: 2,
      sha256: 'a'.repeat(64),
      bytes: Buffer.from([1, 2, 3, 4]),
    },
  };
  return {
    key,
    title,
    createdAt: TS.bookCreated,
    updatedAt: TS.bookUpdated,
    rootContents: [
      { type: 'page', key: 'page-700' },
      { type: 'chapter', key: 'chapter-500' },
      { type: 'page', key: 'page-701' },
      { type: 'chapter', key: 'chapter-501' },
    ],
    chapters: [
      {
        key: 'chapter-500',
        title: 'Chapter exact',
        createdAt: TS.chapterCreated,
        updatedAt: TS.chapterUpdated,
        pageKeys: ['page-702', 'page-703'],
      },
      {
        key: 'chapter-501',
        title: 'Empty chapter',
        createdAt: TS.chapterCreated,
        updatedAt: TS.chapterUpdated,
        pageKeys: [],
      },
    ],
    pages: [
      {
        key: 'page-700',
        chapterKey: null,
        title: 'Root first',
        rawMarkdown: '  leading\n\n# Markdown\n\nhttps://example.com/42\n\n```txt\n9001\n```\ntrailing  ',
        createdAt: TS.pageCreated,
        updatedAt: TS.pageUpdated,
        associations: associations('root-first'),
        revisions: [
          revision('revision-900', 'Newest revision', ' newest 42 ', TS.newestSource, TS.newestCreated),
          revision('revision-800', 'Older revision', '\n**older**\n', TS.olderSource, TS.olderCreated),
          revision('revision-700', 'Oldest revision', '```\n123\n```', TS.oldestSource, TS.oldestCreated),
        ],
      },
      {
        key: 'page-702',
        chapterKey: 'chapter-500',
        title: 'Chapter Page A',
        rawMarkdown: 'A',
        createdAt: TS.pageCreated,
        updatedAt: TS.pageUpdated,
        associations: associations('chapter-a'),
        revisions: [],
      },
      {
        key: 'page-703',
        chapterKey: 'chapter-500',
        title: 'Chapter Page B',
        rawMarkdown: 'B',
        createdAt: TS.pageCreated,
        updatedAt: TS.pageUpdated,
        associations: associations('chapter-b'),
        revisions: [],
      },
      {
        key: 'page-701',
        chapterKey: null,
        title: 'Root second',
        rawMarkdown: 'Second root',
        createdAt: TS.pageCreated,
        updatedAt: TS.pageUpdated,
        associations: associations('root-second'),
        revisions: [],
      },
    ],
    previewSettings: {
      mode: 'selected',
      randomCount: 7,
      selectedPageKeys: ['page-703', 'page-700'],
    },
    cover: managedCover,
  };
}

function emptyBook({ key = 'book-empty', title = 'Empty Book' } = {}) {
  return {
    key,
    title,
    createdAt: TS.bookCreated,
    updatedAt: TS.bookUpdated,
    rootContents: [],
    chapters: [],
    pages: [],
    previewSettings: { mode: 'random', randomCount: 5, selectedPageKeys: [] },
    cover: { kind: 'none' },
  };
}

function plan(books) {
  return { format: 'creatorcrate-books', version: 1, books };
}

function tableRows(db, table, orderBy = 'rowid') {
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
}

function databaseSnapshot(db) {
  return {
    books: tableRows(db, 'books', 'id'),
    chapters: tableRows(db, 'chapters', 'id'),
    notes: tableRows(db, 'notes', 'id'),
    contents: tableRows(db, 'book_contents', 'book_id, sort_order'),
    revisions: tableRows(db, 'note_revisions', 'id'),
    previewSettings: tableRows(db, 'book_page_preview_settings', 'book_id'),
    previewPages: tableRows(db, 'book_page_preview_pages', 'book_id, page_id'),
    primaryImages: tableRows(db, 'book_primary_images', 'book_id'),
    noteProjects: tableRows(db, 'note_projects', 'note_id, project_id'),
    noteAssets: tableRows(db, 'note_assets', 'note_id, asset_id'),
    appMeta: tableRows(db, 'app_meta', 'key'),
  };
}

function seedExistingBook(db, title = 'Existing') {
  const book = db.prepare(`
    INSERT INTO books (title, sort_order, created_at, updated_at)
    VALUES (?, 0, '2024-01-01 00:00:00', '2024-01-02 00:00:00')
    RETURNING id
  `).get(title);
  const chapter = db.prepare(`
    INSERT INTO chapters (book_id, title, sort_order)
    VALUES (?, 'Existing Chapter', 0)
    RETURNING id
  `).get(book.id);
  const page = db.prepare(`
    INSERT INTO notes (book_id, chapter_id, title, content, sort_order)
    VALUES (?, ?, 'Existing Page', 'untouched', 0)
    RETURNING id
  `).get(book.id, chapter.id);
  db.prepare(`
    INSERT INTO book_contents (book_id, item_type, item_id, sort_order)
    VALUES (?, 'chapter', ?, 0)
  `).run(book.id, chapter.id);
  db.prepare(`
    INSERT INTO note_revisions (
      note_id, title, content, project_ids_json, asset_ids_json, source_updated_at
    ) VALUES (?, 'Existing revision', 'untouched', '[]', '[]', '2024-01-01 00:00:00')
  `).run(page.id);
  db.prepare(`
    INSERT INTO book_page_preview_settings (book_id, mode, random_count)
    VALUES (?, 'selected', 3)
  `).run(book.id);
  db.prepare('INSERT INTO book_page_preview_pages (book_id, page_id) VALUES (?, ?)')
    .run(book.id, page.id);
  return { bookId: book.id, chapterId: chapter.id, pageId: page.id };
}

function failingRepository(db, method, occurrence = 1) {
  const base = createBookImportPersistenceRepository(db);
  let calls = 0;
  return {
    ...base,
    [method](...args) {
      calls += 1;
      if (calls === occurrence) throw new Error(`Injected ${method} failure`);
      return base[method](...args);
    },
  };
}

describe('Book import persistence service', () => {
  let db;
  let databasePath;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-import-persistence-'));
    databasePath = path.join(tmpDir, 'test.db');
    db = openDatabase(databasePath);
    runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(() => {
    if (db?.open) closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists one populated Book with fresh IDs, exact hierarchy, history, timestamps, and preview settings', () => {
    const existing = seedExistingBook(db);
    db.prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES
      ('page_defaults.book_detail.navigation', 'chapters'),
      ('notes.revision_retention_count', '1')`).run();
    const sourceBook = populatedBook();
    const sourceTitle = sourceBook.title;
    const sourceCover = sourceBook.cover;
    const sourceAssociations = sourceBook.pages[0].associations;
    const filesBefore = fs.readdirSync(tmpDir).sort();

    const result = createBookImportPersistenceService({ db })
      .persistValidatedPlan(plan([sourceBook]));
    const imported = result.books[0];

    expect(result).toMatchObject({
      format: 'creatorcrate-books',
      version: 1,
      transactionMode: 'immediate',
    });
    expect(imported).toMatchObject({
      sourceBookKey: 'book-900',
      sourceTitle,
      destinationTitle: sourceTitle,
      renamed: false,
      cover: sourceCover,
      preview: {
        mode: 'selected',
        randomCount: 7,
        selectedPageKeys: ['page-703', 'page-700'],
      },
    });
    expect(sourceBook.title).toBe(sourceTitle);
    expect(imported.cover).toBe(sourceCover);
    expect(imported.associations.get('page-700').page).toBe(sourceAssociations);

    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(imported.destinationBookId);
    expect(book).toMatchObject({
      title: sourceTitle,
      sort_order: 1,
      created_at: TS.bookCreated,
      updated_at: TS.bookUpdated,
    });
    expect(book.id).not.toBe(existing.bookId);
    expect(book.id).not.toBe(900);

    const chapters = db.prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY sort_order')
      .all(book.id);
    expect(chapters.map(({ title, sort_order: sortOrder }) => [title, sortOrder])).toEqual([
      ['Chapter exact', 0],
      ['Empty chapter', 1],
    ]);
    expect(chapters[0]).toMatchObject({
      created_at: TS.chapterCreated,
      updated_at: TS.chapterUpdated,
    });
    expect(imported.chapterIdsBySourceKey.get('chapter-500')).toBe(chapters[0].id);
    expect(imported.chapterIdsBySourceKey.get('chapter-501')).toBe(chapters[1].id);
    expect([...imported.chapterIdsBySourceKey.values()]).not.toContain(500);

    const pages = db.prepare('SELECT * FROM notes WHERE book_id = ? ORDER BY id').all(book.id);
    const pageByTitle = new Map(pages.map((page) => [page.title, page]));
    expect(pageByTitle.get('Root first')).toMatchObject({
      chapter_id: null,
      content: sourceBook.pages[0].rawMarkdown,
      sort_order: 0,
      created_at: TS.pageCreated,
      updated_at: TS.pageUpdated,
    });
    expect(pageByTitle.get('Root second')).toMatchObject({ chapter_id: null, sort_order: 1 });
    expect(pageByTitle.get('Chapter Page A')).toMatchObject({
      chapter_id: chapters[0].id,
      sort_order: 0,
    });
    expect(pageByTitle.get('Chapter Page B')).toMatchObject({
      chapter_id: chapters[0].id,
      sort_order: 1,
    });
    expect(imported.pageIdsBySourceKey.get('page-700')).toBe(pageByTitle.get('Root first').id);
    expect([...imported.pageIdsBySourceKey.values()]).not.toContain(700);

    expect(db.prepare(`
      SELECT item_type, item_id, sort_order
      FROM book_contents
      WHERE book_id = ?
      ORDER BY sort_order
    `).all(book.id)).toEqual([
      { item_type: 'page', item_id: imported.pageIdsBySourceKey.get('page-700'), sort_order: 0 },
      { item_type: 'chapter', item_id: chapters[0].id, sort_order: 1 },
      { item_type: 'page', item_id: imported.pageIdsBySourceKey.get('page-701'), sort_order: 2 },
      { item_type: 'chapter', item_id: chapters[1].id, sort_order: 3 },
    ]);

    const revisions = db.prepare(`
      SELECT * FROM note_revisions WHERE note_id = ? ORDER BY id DESC
    `).all(imported.pageIdsBySourceKey.get('page-700'));
    expect(revisions.map((row) => row.title)).toEqual([
      'Newest revision', 'Older revision', 'Oldest revision',
    ]);
    expect(revisions.map((row) => row.content)).toEqual([
      ' newest 42 ', '\n**older**\n', '```\n123\n```',
    ]);
    expect(revisions.map((row) => [row.source_updated_at, row.created_at])).toEqual([
      [TS.newestSource, TS.newestCreated],
      [TS.olderSource, TS.olderCreated],
      [TS.oldestSource, TS.oldestCreated],
    ]);
    expect(revisions.every((row) => row.project_ids_json === '[]' && row.asset_ids_json === '[]'))
      .toBe(true);
    expect(imported.revisionIdsByPageKey.get('page-700').get('revision-900'))
      .toBe(revisions[0].id);
    expect(revisions[0].id).not.toBe(900);

    expect(db.prepare(`
      SELECT mode, random_count FROM book_page_preview_settings WHERE book_id = ?
    `).get(book.id)).toEqual({ mode: 'selected', random_count: 7 });
    expect(imported.preview.selectedPageIds).toEqual([
      imported.pageIdsBySourceKey.get('page-703'),
      imported.pageIdsBySourceKey.get('page-700'),
    ]);
    expect(db.prepare(`
      SELECT page_id FROM book_page_preview_pages WHERE book_id = ? ORDER BY page_id
    `).pluck().all(book.id).sort((left, right) => left - right)).toEqual(
      [...imported.preview.selectedPageIds].sort((left, right) => left - right),
    );

    expect(db.prepare('SELECT COUNT(*) FROM book_primary_images WHERE book_id = ?').pluck().get(book.id))
      .toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM note_projects WHERE note_id IN (SELECT id FROM notes WHERE book_id = ?)')
      .pluck().get(book.id)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM note_assets WHERE note_id IN (SELECT id FROM notes WHERE book_id = ?)')
      .pluck().get(book.id)).toBe(0);
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck()
      .get('page_defaults.book_detail.navigation')).toBe('chapters');
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck()
      .get('notes.revision_retention_count')).toBe('1');
    expect(revisions).toHaveLength(3);
    expect(databaseSnapshot(db).books.find((row) => row.id === existing.bookId).title).toBe('Existing');
    expect(db.prepare('SELECT title FROM chapters WHERE id = ?').pluck().get(existing.chapterId))
      .toBe('Existing Chapter');
    expect(db.prepare('SELECT content FROM notes WHERE id = ?').pluck().get(existing.pageId))
      .toBe('untouched');
    expect(db.prepare(`
      SELECT mode, random_count FROM book_page_preview_settings WHERE book_id = ?
    `).get(existing.bookId)).toEqual({ mode: 'selected', random_count: 3 });
    expect(fs.readdirSync(tmpDir).sort()).toEqual(filesBefore);
  });

  it('consumes the normalized output returned by parseBookImportArchive', async () => {
    const source = plan([emptyBook({ key: 'parsed-book', title: 'Parsed Book' })]);
    const validatedPlan = await parseBookImportArchive(makeZip([{
      name: 'creatorcrate-books.json',
      data: JSON.stringify(source),
    }]));

    const result = createBookImportPersistenceService({ db })
      .persistValidatedPlan(validatedPlan);

    expect(result.books[0]).toMatchObject({
      sourceBookKey: 'parsed-book',
      sourceTitle: 'Parsed Book',
      destinationTitle: 'Parsed Book',
    });
    expect(db.prepare('SELECT title FROM books').pluck().all()).toEqual(['Parsed Book']);
  });

  it('persists multiple Books in manifest order and supports a valid empty Book', () => {
    const first = populatedBook({ key: 'first', title: 'First' });
    const second = emptyBook({ key: 'second', title: 'Second' });

    const result = createBookImportPersistenceService({ db })
      .persistValidatedPlan(plan([first, second]));

    expect(db.prepare('SELECT title FROM books ORDER BY sort_order, id').pluck().all())
      .toEqual(['First', 'Second']);
    expect(result.books.map((book) => book.sourceBookKey)).toEqual(['first', 'second']);
    expect(result.books[1].chapterIdsBySourceKey.size).toBe(0);
    expect(result.books[1].pageIdsBySourceKey.size).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM book_page_preview_settings WHERE book_id = ?').pluck()
      .get(result.books[1].destinationBookId)).toBe(1);
  });

  it.each([
    {
      label: 'existing collision',
      existing: ['Book'],
      incoming: [['one', 'Book']],
      expected: ['Book-1'],
    },
    {
      label: 'multiple incoming reservations',
      existing: ['Book'],
      incoming: [['one', 'Book'], ['two', 'Book']],
      expected: ['Book-1', 'Book-2'],
    },
    {
      label: 'literal suffix collision',
      existing: ['Name-1'],
      incoming: [['one', 'Name-1']],
      expected: ['Name-1-1'],
    },
    {
      label: 'case-sensitive availability',
      existing: ['book'],
      incoming: [['one', 'Book']],
      expected: ['Book'],
    },
  ])('persists $label naming results', ({ existing, incoming, expected }) => {
    existing.forEach((title, index) => {
      db.prepare('INSERT INTO books (title, sort_order) VALUES (?, ?)').run(title, index);
    });
    const result = createBookImportPersistenceService({ db }).persistValidatedPlan(plan(
      incoming.map(([key, title]) => emptyBook({ key, title })),
    ));

    expect(result.books.map((book) => book.destinationTitle)).toEqual(expected);
    expect(result.books.map((book) => book.sourceTitle)).toEqual(
      incoming.map(([, sourceTitle]) => sourceTitle),
    );
    expect(result.books.map((book) => book.renamed)).toEqual(
      incoming.map(([, sourceTitle], index) => sourceTitle !== expected[index]),
    );
    expect(db.prepare(`
      SELECT title FROM books ORDER BY sort_order, id LIMIT ? OFFSET ?
    `).pluck().all(expected.length, existing.length)).toEqual(expected);
  });

  it.each([
    ['second Book creation', 'insertBook', 2, [emptyBook({ key: 'one' }), emptyBook({ key: 'two' })]],
    ['Chapter creation', 'insertChapter', 1, [populatedBook()]],
    ['Page creation', 'insertPage', 2, [populatedBook()]],
    ['revision creation', 'insertRevision', 2, [populatedBook()]],
    ['hierarchy write', 'insertBookContent', 2, [populatedBook()]],
    ['preview-settings write', 'insertPreviewSettings', 1, [populatedBook()]],
    ['selected-preview write', 'insertPreviewPage', 2, [populatedBook()]],
  ])('rolls back the whole archive after an injected $label failure', (
    _label, method, occurrence, books,
  ) => {
    seedExistingBook(db);
    const before = databaseSnapshot(db);
    const repository = failingRepository(db, method, occurrence);
    const service = createBookImportPersistenceService({ db, repository });

    expect(() => service.persistValidatedPlan(plan(books))).toThrowError(
      expect.objectContaining({
        name: 'BookImportPersistenceError',
        code: 'IMPORT_PERSISTENCE_FAILED',
      }),
    );
    expect(databaseSnapshot(db)).toEqual(before);
  });

  it('takes the write lock before reading destination titles and planning names', () => {
    db.prepare('INSERT INTO books (title, sort_order) VALUES (?, 0)').run('Book');
    const rival = openDatabase(databasePath);
    rival.pragma('busy_timeout = 1');
    const base = createBookImportPersistenceRepository(db);
    let rivalError;
    const repository = {
      ...base,
      listBookTitles() {
        expect(db.inTransaction).toBe(true);
        try {
          rival.prepare('INSERT INTO books (title, sort_order) VALUES (?, 99)').run('Rival');
        } catch (error) {
          rivalError = error;
        }
        return base.listBookTitles();
      },
    };

    try {
      const result = createBookImportPersistenceService({ db, repository })
        .persistValidatedPlan(plan([emptyBook({ title: 'Book' })]));
      expect(result.books[0].destinationTitle).toBe('Book-1');
      expect(rivalError?.code).toMatch(/^SQLITE_BUSY/);
      expect(db.prepare('SELECT title FROM books ORDER BY sort_order, id').pluck().all())
        .toEqual(['Book', 'Book-1']);
    } finally {
      closeDatabase(rival);
    }
  });

  it('refuses nested use so the persistence layer retains outer transaction ownership', () => {
    const service = createBookImportPersistenceService({ db });
    const nestedCall = db.transaction(() => service.persistValidatedPlan(plan([emptyBook()])));

    expect(() => nestedCall()).toThrowError(expect.objectContaining({
      name: 'BookImportPersistenceError',
      code: 'TRANSACTION_OWNERSHIP_REQUIRED',
    }));
    expect(db.prepare('SELECT COUNT(*) FROM books').pluck().get()).toBe(0);
  });

  it('exposes the same persistence algorithm to a caller-owned transaction', () => {
    const service = createBookImportPersistenceService({ db });
    const outer = db.transaction(() => service.persistValidatedPlanInTransaction(
      plan([emptyBook({ title: 'Caller owned' })]),
    ));

    expect(outer.immediate().books[0].destinationTitle).toBe('Caller owned');
    expect(db.prepare('SELECT title FROM books').pluck().all()).toEqual(['Caller owned']);
    expect(() => service.persistValidatedPlanInTransaction(plan([emptyBook()])))
      .toThrowError(expect.objectContaining({ code: 'TRANSACTION_CONTEXT_REQUIRED' }));
  });

  it('classifies impossible missing mappings as import integrity failures', () => {
    const invalidAfterValidation = populatedBook();
    invalidAfterValidation.pages[1].chapterKey = 'missing-chapter';

    expect(() => createBookImportPersistenceService({ db })
      .persistValidatedPlan(plan([invalidAfterValidation]))).toThrowError(
      expect.objectContaining({
        name: 'BookImportPersistenceError',
        code: 'IMPORT_INTEGRITY_ERROR',
      }),
    );
    expect(db.prepare('SELECT COUNT(*) FROM books').pluck().get()).toBe(0);
  });

  it('wraps unexpected repository failures without labeling them malformed archives', () => {
    const service = createBookImportPersistenceService({
      db,
      repository: failingRepository(db, 'listBookTitles'),
    });

    let thrown;
    try { service.persistValidatedPlan(plan([emptyBook()])); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(BookImportPersistenceError);
    expect(thrown).toMatchObject({ code: 'IMPORT_PERSISTENCE_FAILED', status: 500 });
    expect(thrown.cause?.message).toBe('Injected listBookTitles failure');
  });
});
