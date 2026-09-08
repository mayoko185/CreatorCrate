import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations } from '../src/db.js';
import { createNoteRepository } from '../src/data/note-repository.js';
import { createBookRepository } from '../src/data/book-repository.js';
import { createChapterRepository } from '../src/data/chapter-repository.js';
import { createBookContentRepository } from '../src/data/book-content-repository.js';
import { BookContentIntegrityError, BookValidationError } from '../src/services/book-service.js';
import {
  BookHierarchyValidationError, buildCurrentBookHierarchy, parseBookHierarchyPayload, planBookHierarchy,
} from '../src/services/book-hierarchy.js';

const page = (id) => ({ type: 'page', id });
const chapter = (id, pages = []) => ({ type: 'chapter', id, pages });
const CURRENT = [page(25), chapter(18, [62]), page(19), chapter(12, [51, 44]), chapter(22)];
const payload = (target = CURRENT, expected = CURRENT) => ({ version: 1, expected, target });
const parse = (value) => parseBookHierarchyPayload(JSON.stringify(value));

describe('Book hierarchy payload', () => {
  it('accepts version 1, exact order, typed IDs, and empty Chapters', () => {
    expect(parse(payload())).toEqual(payload());
    expect(parse(payload([chapter(12), page(12)], []))).toEqual(payload([chapter(12), page(12)], []));
  });

  it.each(['{', '', 'undefined'])('rejects malformed JSON %j', (value) => {
    expect(() => parseBookHierarchyPayload(value)).toThrow(BookValidationError);
  });

  it.each([undefined, null, [], [JSON.stringify(payload()), JSON.stringify(payload())], payload()])(
    'requires a single string, not %j', (value) => {
      expect(() => parseBookHierarchyPayload(value)).toThrow(BookHierarchyValidationError);
    },
  );

  it.each([
    null, [], 1, 'text', {}, { expected: [], target: [] },
    { version: 2, expected: [], target: [] }, { version: '1', expected: [], target: [] },
    { version: 1, target: [] }, { version: 1, expected: [] },
    { version: 1, expected: null, target: [] }, { version: 1, expected: [], target: {} },
    { ...payload(), book_id: 20 },
  ])('rejects invalid envelope %j', (value) => {
    expect(() => parse(value)).toThrow(BookHierarchyValidationError);
  });

  const badShapes = [
    ['duplicate root Page', [page(19), page(19)]],
    ['Page at root and in Chapter', [page(19), chapter(12, [19])]],
    ['Page in two Chapters', [chapter(12, [19]), chapter(18, [19])]],
    ['Page twice in Chapter', [chapter(12, [19, 19])]],
    ['duplicate Chapter', [chapter(12), chapter(12)]],
    ['root Page with children', [{ ...page(19), pages: [] }]],
    ['nested Chapter', [chapter(12, [chapter(18)])]],
    ['nested Page object', [chapter(12, [page(19)])]],
    ['missing Chapter pages', [{ type: 'chapter', id: 12 }]],
    ['invalid pages type', [chapter(12, {})]],
    ['unknown type', [{ type: 'book', id: 1 }]],
    ['missing type', [{ id: 1 }]],
    ['null node', [null]],
    ['array node', [[]]],
    ['primitive node', [19]],
    ['ownership field', [{ ...page(19), book_id: 20 }]],
    ['presentation field', [{ ...chapter(12), title: 'Extra' }]],
  ];
  it.each(badShapes)('rejects %s in expected and target', (_name, shape) => {
    expect(() => parse(payload(shape))).toThrow(BookHierarchyValidationError);
    expect(() => parse(payload([], shape))).toThrow(BookHierarchyValidationError);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '19', '019', null, true])(
    'rejects noncanonical ID %j in every position', (id) => {
      for (const shape of [[page(id)], [chapter(id)], [chapter(12, [id])]]) {
        expect(() => parse(payload(shape))).toThrow(BookHierarchyValidationError);
      }
    },
  );

  it('accepts the maximum safe integer', () => {
    expect(parse(payload([page(Number.MAX_SAFE_INTEGER)], []))).toEqual(payload([page(Number.MAX_SAFE_INTEGER)], []));
  });
});

describe('authoritative Book hierarchy and pure plan', () => {
  let db;
  let notes;
  let books;
  let chapters;
  let contents;
  const migrations = fileURLToPath(new URL('../migrations', import.meta.url));

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, migrations);
    db.exec(`
      INSERT INTO books (id, title, sort_order) VALUES (10, 'Book', 0), (20, 'Foreign', 1);
      INSERT INTO chapters (id, book_id, title, sort_order)
        VALUES (12, 10, 'A', 0), (18, 10, 'B', 1), (22, 10, 'Empty', 2), (28, 20, 'Foreign', 0);
      INSERT INTO notes (id, book_id, chapter_id, title, content, sort_order) VALUES
        (19, 10, NULL, 'First created root', '', 0), (25, 10, NULL, 'Second root', '', 1),
        (44, 10, 12, 'First created child', '', 9), (51, 10, 12, 'Second child', '', 3),
        (62, 10, 18, 'B child', '', 0), (70, 20, 28, 'Foreign child', '', 0);
      INSERT INTO book_contents (book_id, item_type, item_id, sort_order) VALUES
        (10, 'chapter', 12, 7), (10, 'chapter', 18, 2), (10, 'chapter', 22, 9),
        (10, 'page', 19, 4), (10, 'page', 25, 0), (20, 'chapter', 28, 0);
    `);
    notes = createNoteRepository(db);
    books = createBookRepository(db);
    chapters = createChapterRepository(db);
    contents = createBookContentRepository(db);
  });

  afterEach(() => db?.close());

  function snapshot() {
    return {
      bookId: 10,
      book: books.findById(10),
      chapters: chapters.listForBook(10),
      pages: notes.listAllForBook(10),
      memberships: contents.listForBook(10),
    };
  }

  function move(id, chapterId, bookId = 10) {
    // Existing repository operations are fixture setup only, never the new path.
    const current = notes.findById(id);
    if (current.chapter_id === null) contents.remove(current.book_id, 'page', id);
    notes.moveToContainer(id, { bookId, chapterId });
    if (chapterId === null) contents.append(bookId, 'page', id);
  }

  it('lists ALL owned Pages deterministically without changing root-only list semantics', () => {
    expect(notes.listAllForBook(10).map(({ id }) => id)).toEqual([19, 25, 44, 51, 62]);
    expect(notes.listAllForBook(10)).toEqual(notes.listAllForBook(10));
    expect(notes.listAllForBook(10).find(({ id }) => id === 44)).toMatchObject({
      id: 44, book_id: 10, chapter_id: 12, sort_order: 9,
    });
    expect(notes.listForBook(10).map(({ id }) => id)).toEqual([19, 25]);
    expect(notes.listAllForBook(999)).toEqual([]);
    expect(() => notes.listAllForBook('10')).toThrow();
  });

  it('uses mixed root order and Chapter-local order, not creation or ID order', () => {
    const state = snapshot();
    state.memberships.reverse();
    state.pages.reverse();
    state.chapters.reverse();
    expect(buildCurrentBookHierarchy(state)).toEqual(CURRENT);
  });

  it('uses the established ID tie-breaker for equal Chapter-local orders', () => {
    db.exec('UPDATE notes SET sort_order = 3 WHERE id = 44');
    expect(buildCurrentBookHierarchy(snapshot())[3]).toEqual(chapter(12, [44, 51]));
    expect(notes.listForChapter(12).map(({ id }) => id)).toEqual([44, 51]);
  });

  it('does not treat legacy Chapter/root Page sort orders as authoritative', () => {
    db.exec('UPDATE chapters SET sort_order = 99 WHERE id = 18; UPDATE notes SET sort_order = 99 WHERE id = 25');
    expect(planBookHierarchy(snapshot(), payload()).changed).toBe(false);
  });

  const corruptions = [
    ['missing Book', (s) => { s.book = null; }],
    ['wrong Book', (s) => { s.book.id = 20; }],
    ['foreign Chapter', (s) => { s.chapters[0].book_id = 20; }],
    ['foreign Page', (s) => { s.pages[0].book_id = 20; }],
    ['missing Chapter', (s) => { s.pages[0].chapter_id = 999; }],
    ['foreign parent Chapter', (s) => { s.pages[0].chapter_id = 28; }],
    ['undefined parent', (s) => { delete s.pages[0].chapter_id; }],
    ['missing Chapter membership', (s) => { s.memberships = s.memberships.filter((r) => r.item_id !== 22); }],
    ['missing root Page membership', (s) => { s.memberships = s.memberships.filter((r) => r.item_id !== 19); }],
    ['Chapter Page at root', (s) => { s.memberships.push({ book_id: 10, item_type: 'page', item_id: 44, sort_order: 11 }); }],
    ['unresolved root', (s) => { s.memberships[0].item_id = 999; }],
    ['foreign root Book', (s) => { s.memberships[0].book_id = 20; }],
    ['foreign root Chapter', (s) => { s.memberships[1].item_id = 28; }],
    ['unknown root type', (s) => { s.memberships[0].item_type = 'book'; }],
    ['duplicate root', (s) => { s.memberships.push({ ...s.memberships[0], sort_order: 11 }); }],
    ['duplicate root order', (s) => { s.memberships[0].sort_order = s.memberships[1].sort_order; }],
    ['negative root order', (s) => { s.memberships[0].sort_order = -1; }],
    ['fractional root order', (s) => { s.memberships[0].sort_order = 0.5; }],
    ['unsafe root order', (s) => { s.memberships[0].sort_order = Number.MAX_SAFE_INTEGER + 1; }],
    ['invalid child order', (s) => { s.pages.find((r) => r.id === 44).sort_order = '9'; }],
    ['negative child order', (s) => { s.pages.find((r) => r.id === 44).sort_order = -1; }],
    ['unsafe child order', (s) => { s.pages.find((r) => r.id === 44).sort_order = Infinity; }],
    ['unsafe entity ID', (s) => { s.pages[0].id = Number.MAX_SAFE_INTEGER + 1; }],
    ['duplicate Page inventory', (s) => { s.pages.push(s.pages[0]); }],
    ['duplicate Chapter inventory', (s) => { s.chapters.push(s.chapters[0]); }],
    ['missing root Page inventory row', (s) => { s.pages = s.pages.filter((r) => r.id !== 19); }],
    ['missing inventory', (s) => { delete s.pages; }],
  ];
  it.each(corruptions)('fails explicitly for %s before stale comparison', (_name, corrupt) => {
    const state = snapshot();
    corrupt(state);
    expect(() => planBookHierarchy(state, payload([], []))).toThrow(BookContentIntegrityError);
    try { buildCurrentBookHierarchy(state); } catch (error) {
      expect(error).toMatchObject({ status: 500, code: 'HIERARCHY_INTEGRITY' });
    }
  });

  const staleChanges = [
    ['root reorder', () => contents.reorder(10, [...CURRENT].reverse().map(({ type, id }) => ({ type, id })))],
    ['Chapter-local reorder', () => notes.reorder(12, [44, 51])],
    ['root Page into Chapter', () => move(19, 12)],
    ['Chapter Page to root', () => move(44, null)],
    ['Chapter A to B', () => move(44, 18)],
    ['Page to another Book', () => move(44, 28, 20)],
    ['root Page to another Book', () => move(19, null, 20)],
    ['Page deleted', () => db.exec('DELETE FROM notes WHERE id = 44')],
    ['root Page deleted', () => { contents.remove(10, 'page', 19); db.exec('DELETE FROM notes WHERE id = 19'); }],
    ['Page added', () => notes.create({ bookId: 10, chapterId: 12, title: 'New' })],
    ['root Page added', () => { const p = notes.create({ bookId: 10, chapterId: null, title: 'New' }); contents.append(10, 'page', p.id); }],
    ['Chapter deleted', () => { contents.remove(10, 'chapter', 22); db.exec('DELETE FROM chapters WHERE id = 22'); }],
    ['Chapter added', () => { db.exec("INSERT INTO chapters (id, book_id, title, sort_order) VALUES (30, 10, 'New', 3)"); contents.append(10, 'chapter', 30); }],
  ];
  it.each(staleChanges)('detects stale expected after %s', (_name, change) => {
    const expected = buildCurrentBookHierarchy(snapshot());
    change();
    const state = snapshot();
    const target = buildCurrentBookHierarchy(state);
    expect(() => planBookHierarchy(state, payload(target, expected))).toThrow(expect.objectContaining({
      code: 'HIERARCHY_STALE', status: 409,
    }));
  });

  it('ignores title/content edits and accepts an exactly restored hierarchy', () => {
    notes.update(44, { title: 'Edited', content: 'Changed content' });
    db.exec("UPDATE books SET title = 'Renamed' WHERE id = 10; UPDATE chapters SET title = 'Renamed' WHERE id = 12");
    notes.reorder(12, [44, 51]);
    notes.reorder(12, [51, 44]);
    expect(planBookHierarchy(snapshot(), payload()).changed).toBe(false);
  });

  const targets = [
    ['root-only reorder', [page(19), chapter(18, [62]), page(25), chapter(12, [51, 44]), chapter(22)]],
    ['Chapter reorder', [page(25), chapter(22), page(19), chapter(12, [51, 44]), chapter(18, [62])]],
    ['within Chapter reorder', [page(25), chapter(18, [62]), page(19), chapter(12, [44, 51]), chapter(22)]],
    ['root to Chapter', [page(25), chapter(18, [62]), chapter(12, [51, 19, 44]), chapter(22)]],
    ['Chapter to root', [page(25), chapter(18, [62]), page(44), page(19), chapter(12, [51]), chapter(22)]],
    ['Chapter A to B', [page(25), chapter(18, [44, 62]), page(19), chapter(12, [51]), chapter(22)]],
    ['simultaneous destinations', [chapter(12, [62, 25]), page(44), chapter(22, [19]), chapter(18, [51])]],
    ['all Pages at root mixed around Chapters', [page(51), chapter(22), page(19), chapter(12), page(44), chapter(18), page(25), page(62)]],
    ['all Pages in one Chapter', [chapter(18), chapter(22, [19, 62, 25, 44, 51]), chapter(12)]],
    ['all Pages distributed in Chapters', [chapter(12, [25, 51]), chapter(18, [19]), chapter(22, [62, 44])]],
  ];
  it.each(targets)('allows %s with exact current inventory', (_name, target) => {
    const plan = planBookHierarchy(snapshot(), parse(payload(target)));
    expect(plan.targetHierarchy).toEqual(target);
    expect(plan.changed).toBe(true);
    expect(plan.rootTargetItems).toEqual(target.map(({ type, id }) => ({ type, id })));
    expect(plan.chapterTargetOrders).toEqual(new Map(target.filter((n) => n.type === 'chapter').map((n) => [n.id, n.pages])));
  });

  it.each([
    ['omitted Page', [chapter(12, [51, 44]), chapter(18, [62]), chapter(22), page(19)]],
    ['duplicate Page', [...CURRENT, page(19)]],
    ['omitted Chapter', CURRENT.filter((n) => n.id !== 22)],
    ['duplicate Chapter', [...CURRENT, chapter(22)]],
    ['foreign Page', [page(70), ...CURRENT.slice(1)]],
    ['foreign nested Page', [page(25), chapter(18, [70]), ...CURRENT.slice(2)]],
    ['foreign Chapter', [...CURRENT.slice(0, -1), chapter(28)]],
    ['missing Chapter with owned Page moved into foreign Chapter', [page(25), chapter(28, [62]), ...CURRENT.slice(2)]],
    ['illegal nesting', [chapter(12, [chapter(18)]), page(19)]],
    ['Book ownership change', [{ ...page(25), book_id: 20 }, ...CURRENT.slice(1)]],
  ])('rejects target %s', (_name, target) => {
    expect(() => planBookHierarchy(snapshot(), payload(target))).toThrow(BookHierarchyValidationError);
  });

  it('returns only changed destinations, deterministically by Page ID', () => {
    const target = [chapter(12, [62, 25]), page(44), chapter(22, [19]), chapter(18, [51])];
    expect(planBookHierarchy(snapshot(), payload(target)).pageDestinationChanges).toEqual([
      { pageId: 19, currentChapterId: null, targetChapterId: 22 },
      { pageId: 25, currentChapterId: null, targetChapterId: 12 },
      { pageId: 44, currentChapterId: 12, targetChapterId: null },
      { pageId: 51, currentChapterId: 12, targetChapterId: 18 },
      { pageId: 62, currentChapterId: 18, targetChapterId: 12 },
    ]);
    const reordered = structuredClone(CURRENT);
    reordered.reverse();
    reordered.find((n) => n.id === 12).pages.reverse();
    expect(planBookHierarchy(snapshot(), payload(reordered)).pageDestinationChanges).toEqual([]);
    expect(planBookHierarchy(snapshot(), payload())).toMatchObject({ changed: false, pageDestinationChanges: [] });
  });

  it('supports an empty Book', () => {
    db.exec("INSERT INTO books (id, title, sort_order) VALUES (99, 'Empty', 2)");
    expect(planBookHierarchy({ bookId: 99, book: books.findById(99), chapters: [], pages: [], memberships: [] }, payload([], [])))
      .toMatchObject({ currentHierarchy: [], targetHierarchy: [], changed: false });
  });

  it('supports a Book with only root Pages and no Chapters', () => {
    const state = {
      bookId: 10, book: books.findById(10), chapters: [],
      pages: notes.listForBook(10),
      memberships: contents.listForBook(10).filter((r) => r.item_type === 'page'),
    };
    expect(planBookHierarchy(state, payload([page(19), page(25)], [page(25), page(19)])))
      .toMatchObject({ changed: true, pageDestinationChanges: [], chapterTargetOrders: new Map() });
  });

  it('revalidates parsed objects rather than trusting an earlier parser call', () => {
    const submission = parse(payload());
    submission.target[0].id = Infinity;
    expect(() => planBookHierarchy(snapshot(), submission)).toThrow(BookHierarchyValidationError);
    submission.target = new Array(1);
    expect(() => planBookHierarchy(snapshot(), submission)).toThrow(BookHierarchyValidationError);
  });

  it('performs no writes on success or rejection and does not mutate inputs', () => {
    const before = db.serialize();
    const changes = db.prepare('SELECT total_changes() AS count').get();
    db.pragma('query_only = ON');
    const state = snapshot();
    const submission = payload(targets[6][1]);
    const originals = structuredClone({ state, submission });
    const plan = db.transaction(() => planBookHierarchy(state, submission))();
    expect(() => planBookHierarchy(state, payload([]))).toThrow(BookHierarchyValidationError);
    expect(() => planBookHierarchy(state, payload([], []))).toThrow(BookHierarchyValidationError);
    expect(() => planBookHierarchy({ ...state, memberships: [] }, submission)).toThrow(BookContentIntegrityError);
    expect({ state, submission }).toEqual(originals);
    plan.targetHierarchy[0].pages.push(999);
    plan.chapterTargetOrders.get(12).push(998);
    plan.currentHierarchy.reverse();
    expect({ state, submission }).toEqual(originals);
    expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
    expect(db.serialize()).toEqual(before);
  });
});
