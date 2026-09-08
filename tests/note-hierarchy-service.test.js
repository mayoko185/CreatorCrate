import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createBookContentRepository } from '../src/data/book-content-repository.js';
import { createBookRepository } from '../src/data/book-repository.js';
import { createChapterRepository } from '../src/data/chapter-repository.js';
import { createNoteRepository } from '../src/data/note-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { buildCurrentBookHierarchy, BookHierarchyValidationError } from '../src/services/book-hierarchy.js';
import { BookContentIntegrityError } from '../src/services/book-service.js';
import { createNoteService } from '../src/services/note-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const page = (id) => ({ type: 'page', id });
const chapter = (id, pages = []) => ({ type: 'chapter', id, pages });

describe('Note service aggregate Book hierarchy persistence', () => {
  let tmpDir;
  let db;
  let repositories;
  let ids;
  let logInfo;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-note-hierarchy-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    repositories = {
      bookRepository: createBookRepository(db),
      bookContentRepository: createBookContentRepository(db),
      chapterRepository: createChapterRepository(db),
      noteRepository: createNoteRepository(db),
      projectRepository: createProjectRepository(db),
      assetRepository: createAssetRepository(db),
    };
    ids = seedHierarchy();
    logInfo = vi.fn();
    service = makeService();
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedHierarchy() {
    const bookId = Number(db.prepare(`
      INSERT INTO books (title, sort_order) VALUES ('Hierarchy book', 0)
    `).run().lastInsertRowid);
    const a = repositories.chapterRepository.create({ bookId, title: 'A' }).id;
    const b = repositories.chapterRepository.create({ bookId, title: 'B' }).id;
    const empty = repositories.chapterRepository.create({ bookId, title: 'Empty' }).id;
    const rootA = repositories.noteRepository.create({ bookId, title: 'Root A', content: 'root-a' }).id;
    const rootB = repositories.noteRepository.create({ bookId, title: 'Root B', content: 'root-b' }).id;
    const a1 = repositories.noteRepository.create({ bookId, chapterId: a, title: 'A1', content: 'a-1' }).id;
    const a2 = repositories.noteRepository.create({ bookId, chapterId: a, title: 'A2', content: 'a-2' }).id;
    const b1 = repositories.noteRepository.create({ bookId, chapterId: b, title: 'B1', content: 'b-1' }).id;
    const b2 = repositories.noteRepository.create({ bookId, chapterId: b, title: 'B2', content: 'b-2' }).id;

    for (const item of [page(rootA), chapter(a), page(rootB), chapter(b), chapter(empty)]) {
      repositories.bookContentRepository.append(bookId, item.type, item.id);
    }

    const project = repositories.projectRepository.create({
      title: 'Associated project', slug: 'associated-project', description: '', notes: '', status: 'tbd',
    });
    const asset = repositories.assetRepository.upsert(project.id, 'image.png', {
      filename: 'image.png', extension: '.png', mimeType: 'image/png', sizeBytes: 10,
    });
    repositories.noteRepository.replaceProjects(rootA, [project.id]);
    repositories.noteRepository.replaceAssets(rootA, [asset.id]);

    return { bookId, a, b, empty, rootA, rootB, a1, a2, b1, b2 };
  }

  function makeService({ noteRepository = repositories.noteRepository,
    bookContentRepository = repositories.bookContentRepository,
    applicationLogger = { info: logInfo } } = {}) {
    return createNoteService({
      db,
      noteRepository,
      projectRepository: repositories.projectRepository,
      assetRepository: repositories.assetRepository,
      chapterRepository: repositories.chapterRepository,
      bookRepository: repositories.bookRepository,
      bookContentRepository,
      applicationLogger,
    });
  }

  function hierarchy() {
    return buildCurrentBookHierarchy({
      bookId: ids.bookId,
      book: repositories.bookRepository.findById(ids.bookId),
      chapters: repositories.chapterRepository.listForBook(ids.bookId),
      pages: repositories.noteRepository.listAllForBook(ids.bookId),
      memberships: repositories.bookContentRepository.listForBook(ids.bookId),
    });
  }

  function submission(target, expected = hierarchy()) {
    return { version: 1, expected, target };
  }

  function databaseSnapshot() {
    return {
      books: db.prepare('SELECT * FROM books ORDER BY id').all(),
      chapters: db.prepare('SELECT * FROM chapters ORDER BY id').all(),
      notes: db.prepare('SELECT * FROM notes ORDER BY id').all(),
      contents: db.prepare('SELECT * FROM book_contents ORDER BY book_id, sort_order').all(),
      projects: db.prepare('SELECT * FROM note_projects ORDER BY note_id, project_id').all(),
      assets: db.prepare('SELECT * FROM note_assets ORDER BY note_id, asset_id').all(),
    };
  }

  function assertPersisted(target, before) {
    expect(hierarchy()).toEqual(target);
    expect(repositories.bookContentRepository.listForBook(ids.bookId).map((row) => row.sort_order))
      .toEqual(target.map((_, index) => index));
    for (const node of target.filter(({ type }) => type === 'chapter')) {
      const rows = repositories.noteRepository.listForChapter(node.id);
      expect(rows.map(({ id }) => id)).toEqual(node.pages);
      expect(rows.map(({ sort_order: sortOrder }) => sortOrder))
        .toEqual(node.pages.map((_, index) => index));
    }

    const after = databaseSnapshot();
    expect(after.notes.map(({ id, book_id, title, content, created_at, updated_at }) => (
      { id, book_id, title, content, created_at, updated_at }
    ))).toEqual(before.notes.map(({ id, book_id, title, content, created_at, updated_at }) => (
      { id, book_id, title, content, created_at, updated_at }
    )));
    expect(after.projects).toEqual(before.projects);
    expect(after.assets).toEqual(before.assets);
  }

  function aggregateEvents() {
    return logInfo.mock.calls.map(([record]) => record)
      .filter(({ event }) => event === 'book.hierarchy.reordered');
  }

  const cases = [
    ['root-only reorder', ({ rootA, rootB, a, b, empty, a1, a2, b1, b2 }) => [
      chapter(a, [a1, a2]), page(rootA), chapter(b, [b1, b2]), chapter(empty), page(rootB),
    ]],
    ['Chapter reorder at the Book root', ({ rootA, rootB, a, b, empty, a1, a2, b1, b2 }) => [
      page(rootA), chapter(b, [b1, b2]), page(rootB), chapter(a, [a1, a2]), chapter(empty),
    ]],
    ['Page reorder within a Chapter', ({ rootA, rootB, a, b, empty, a1, a2, b1, b2 }) => [
      page(rootA), chapter(a, [a2, a1]), page(rootB), chapter(b, [b1, b2]), chapter(empty),
    ]],
    ['root Page to Chapter', ({ rootA, rootB, a, b, empty, a1, a2, b1, b2 }) => [
      chapter(a, [a1, rootA, a2]), page(rootB), chapter(b, [b1, b2]), chapter(empty),
    ]],
    ['Chapter Page to root', ({ rootA, rootB, a, b, empty, a1, a2, b1, b2 }) => [
      page(rootA), chapter(a, [a2]), page(a1), page(rootB), chapter(b, [b1, b2]), chapter(empty),
    ]],
    ['Page from Chapter A to Chapter B', ({ rootA, rootB, a, b, empty, a1, a2, b1, b2 }) => [
      page(rootA), chapter(a, [a2]), page(rootB), chapter(b, [b1, a1, b2]), chapter(empty),
    ]],
    ['several simultaneous moves', ({ rootA, rootB, a, b, empty, a1, a2, b1, b2 }) => [
      chapter(a, [rootA, a2]), page(b1), page(rootB), chapter(b, [a1, b2]), chapter(empty),
    ]],
    ['simultaneous move and reorder', ({ rootA, rootB, a, b, empty, a1, a2, b1, b2 }) => [
      chapter(b, [b2, a1, b1]), page(rootB), chapter(a, [a2, rootA]), chapter(empty),
    ]],
    ['root Pages before, between, and after Chapters', ({ rootA, rootB, a, b, empty, a1, a2, b1, b2 }) => [
      page(rootB), chapter(b, [b1, b2]), page(rootA), chapter(empty), chapter(a, [a2]), page(a1),
    ]],
    ['empty Chapter', ({ rootA, rootB, a, b, empty, a1, a2, b1, b2 }) => [
      chapter(empty), page(rootA), chapter(a, [a1, a2]), page(rootB), chapter(b, [b1, b2]),
    ]],
    ['all Pages at root', ({ rootA, rootB, a, b, empty, a1, a2, b1, b2 }) => [
      page(a1), chapter(a), page(rootA), chapter(b), page(b1), page(rootB), chapter(empty), page(a2), page(b2),
    ]],
    ['all Pages in Chapters', ({ rootA, rootB, a, b, empty, a1, a2, b1, b2 }) => [
      chapter(b, [b2, rootA, b1]), chapter(empty), chapter(a, [rootB, a2, a1]),
    ]],
  ];

  it.each(cases)('atomically applies %s', (_label, targetFor) => {
    const before = databaseSnapshot();
    const target = targetFor(ids);

    const outcome = service.reorderBookHierarchy(ids.bookId, submission(target));

    expect(outcome).toEqual({ changed: true, hierarchy: target });
    assertPersisted(target, before);
    expect(aggregateEvents()).toHaveLength(1);
    expect(aggregateEvents()[0].context).toEqual({ bookId: ids.bookId });
  });

  it('does no writes and emits no event for an exact no-op', () => {
    const moveToContainer = vi.fn(repositories.noteRepository.moveToContainer);
    const reorderChapter = vi.fn(repositories.noteRepository.reorder);
    const reorderRoot = vi.fn(repositories.bookContentRepository.reorder);
    const isolated = makeService({
      noteRepository: { ...repositories.noteRepository, moveToContainer, reorder: reorderChapter },
      bookContentRepository: { ...repositories.bookContentRepository, reorder: reorderRoot },
    });
    const current = hierarchy();

    expect(isolated.reorderBookHierarchy(ids.bookId, submission(current)))
      .toEqual({ changed: false, hierarchy: current });
    expect(moveToContainer).not.toHaveBeenCalled();
    expect(reorderRoot).not.toHaveBeenCalled();
    expect(reorderChapter).not.toHaveBeenCalled();
    expect(aggregateEvents()).toEqual([]);
  });

  it('keeps a committed hierarchy save successful when activity logging fails', () => {
    const target = [
      chapter(ids.a, [ids.a2, ids.a1]), page(ids.rootA), page(ids.rootB),
      chapter(ids.b, [ids.b1, ids.b2]), chapter(ids.empty),
    ];
    const isolated = makeService({
      applicationLogger: { info: vi.fn(() => { throw new Error('logging unavailable'); }) },
    });

    expect(isolated.reorderBookHierarchy(ids.bookId, submission(target)))
      .toEqual({ changed: true, hierarchy: target });
    expect(hierarchy()).toEqual(target);
  });

  function expectRollback(isolated, target, message) {
    const before = databaseSnapshot();
    expect(() => isolated.reorderBookHierarchy(ids.bookId, submission(target))).toThrow(message);
    expect(databaseSnapshot()).toEqual(before);
    expect(aggregateEvents()).toEqual([]);
  }

  it('rolls back a completed Page move when the next Page move fails', () => {
    let calls = 0;
    const noteRepository = {
      ...repositories.noteRepository,
      moveToContainer(...args) {
        calls += 1;
        if (calls === 2) throw new Error('second Page move failed');
        return repositories.noteRepository.moveToContainer(...args);
      },
    };
    const target = [
      chapter(ids.a, [ids.rootA, ids.a2]), page(ids.rootB),
      chapter(ids.b, [ids.a1, ids.b1, ids.b2]), chapter(ids.empty),
    ];
    expectRollback(makeService({ noteRepository }), target, 'second Page move failed');
  });

  it('rolls back root membership transitions when final root reorder fails', () => {
    const bookContentRepository = {
      ...repositories.bookContentRepository,
      reorder: vi.fn(() => { throw new Error('root reorder failed'); }),
    };
    const target = [
      chapter(ids.a, [ids.rootA, ids.a2]), page(ids.a1), page(ids.rootB),
      chapter(ids.b, [ids.b1, ids.b2]), chapter(ids.empty),
    ];
    expectRollback(makeService({ bookContentRepository }), target, 'root reorder failed');
  });

  it('rolls back final root reorder when a later Chapter reorder fails', () => {
    const noteRepository = {
      ...repositories.noteRepository,
      reorder: vi.fn(() => { throw new Error('Chapter reorder failed'); }),
    };
    const target = [
      chapter(ids.b, [ids.b1, ids.b2]), page(ids.rootA),
      chapter(ids.a, [ids.a2, ids.a1]), page(ids.rootB), chapter(ids.empty),
    ];
    expectRollback(makeService({ noteRepository }), target, 'Chapter reorder failed');
  });

  it('rolls back Page moves, root changes, and one completed Chapter reorder when the next fails', () => {
    let calls = 0;
    const noteRepository = {
      ...repositories.noteRepository,
      reorder(...args) {
        calls += 1;
        if (calls === 2) throw new Error('second Chapter reorder failed');
        return repositories.noteRepository.reorder(...args);
      },
    };
    const target = [
      chapter(ids.b, [ids.b2, ids.a1, ids.b1]), page(ids.rootB),
      chapter(ids.a, [ids.a2, ids.rootA]), chapter(ids.empty),
    ];
    expectRollback(makeService({ noteRepository }), target, 'second Chapter reorder failed');
  });

  it('rolls back when the final in-transaction authoritative reread violates invariants', () => {
    let reads = 0;
    const noteRepository = {
      ...repositories.noteRepository,
      listAllForBook(bookId) {
        reads += 1;
        const rows = repositories.noteRepository.listAllForBook(bookId);
        return reads === 1 ? rows : rows.slice(1);
      },
    };
    const target = [
      chapter(ids.a, [ids.a2, ids.a1]), page(ids.rootA), page(ids.rootB),
      chapter(ids.b, [ids.b1, ids.b2]), chapter(ids.empty),
    ];
    expectRollback(makeService({ noteRepository }), target, BookContentIntegrityError);
  });

  const staleCases = [
    ['root reorder', () => repositories.bookContentRepository.reorder(ids.bookId, [
      chapter(ids.a), page(ids.rootA), page(ids.rootB), chapter(ids.b), chapter(ids.empty),
    ])],
    ['Chapter-local reorder', () => repositories.noteRepository.reorder(ids.a, [ids.a2, ids.a1])],
    ['root to Chapter', () => service.moveNote(ids.rootA, { bookId: ids.bookId, chapterId: ids.a })],
    ['Chapter to root', () => service.moveNote(ids.a1, { bookId: ids.bookId, chapterId: null })],
    ['Chapter A to Chapter B', () => service.moveNote(ids.a1, { bookId: ids.bookId, chapterId: ids.b })],
    ['Page move to another Book', () => {
      const otherBookId = Number(db.prepare(`
        INSERT INTO books (title, sort_order) VALUES ('Other book', 1)
      `).run().lastInsertRowid);
      service.moveNote(ids.rootA, { bookId: otherBookId, chapterId: null });
    }],
    ['Page deletion', () => service.deleteNote(ids.rootA)],
    ['Page addition', () => {
      const added = repositories.noteRepository.create({ bookId: ids.bookId, title: 'Added' });
      repositories.bookContentRepository.append(ids.bookId, 'page', added.id);
    }],
    ['Chapter deletion', () => {
      repositories.bookContentRepository.remove(ids.bookId, 'chapter', ids.empty);
      repositories.chapterRepository.deleteAndCompact(ids.empty);
    }],
    ['Chapter addition', () => {
      const added = repositories.chapterRepository.create({ bookId: ids.bookId, title: 'Added' });
      repositories.bookContentRepository.append(ids.bookId, 'chapter', added.id);
    }],
  ];

  it.each(staleCases)('rejects stale expected state after intervening %s without writing', (_label, mutate) => {
    const expected = hierarchy();
    const target = [expected[2], expected[1], expected[0], ...expected.slice(3)];
    mutate();
    const beforeSave = databaseSnapshot();

    let error;
    try {
      service.reorderBookHierarchy(ids.bookId, submission(target, expected));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BookHierarchyValidationError);
    expect(error).toMatchObject({ code: 'HIERARCHY_STALE', status: 409 });
    expect(databaseSnapshot()).toEqual(beforeSave);
    expect(aggregateEvents()).toEqual([]);
  });

  it('allows title/content-only edits while applying a hierarchy save', () => {
    const expected = hierarchy();
    repositories.noteRepository.update(ids.a1, { title: 'Edited title', content: 'Edited content' });
    const target = [expected[2], expected[1], expected[0], ...expected.slice(3)];

    expect(service.reorderBookHierarchy(ids.bookId, submission(target, expected)).changed).toBe(true);
    expect(hierarchy()).toEqual(target);
    expect(repositories.noteRepository.findById(ids.a1)).toMatchObject({
      title: 'Edited title', content: 'Edited content',
    });
  });

  it('aborts corrupt current hierarchy before any mutation', () => {
    const expected = hierarchy();
    repositories.bookContentRepository.remove(ids.bookId, 'chapter', ids.empty);
    const before = databaseSnapshot();
    const reorderRoot = vi.fn(repositories.bookContentRepository.reorder);
    const reorderChapter = vi.fn(repositories.noteRepository.reorder);
    const isolated = makeService({
      noteRepository: { ...repositories.noteRepository, reorder: reorderChapter },
      bookContentRepository: { ...repositories.bookContentRepository, reorder: reorderRoot },
    });

    expect(() => isolated.reorderBookHierarchy(ids.bookId, submission(expected, expected)))
      .toThrow(BookContentIntegrityError);
    expect(databaseSnapshot()).toEqual(before);
    expect(reorderRoot).not.toHaveBeenCalled();
    expect(reorderChapter).not.toHaveBeenCalled();
    expect(aggregateEvents()).toEqual([]);
  });

  it('revalidates the complete versioned submission inside the write method', () => {
    const current = hierarchy();
    const before = databaseSnapshot();

    expect(() => service.reorderBookHierarchy(ids.bookId, {
      version: 2, expected: current, target: current,
    })).toThrow(BookHierarchyValidationError);
    expect(databaseSnapshot()).toEqual(before);
  });
});
