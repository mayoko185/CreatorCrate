import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { BookError, createBookRepository } from '../src/data/book-repository.js';
import { createBookContentRepository } from '../src/data/book-content-repository.js';
import { createChapterRepository } from '../src/data/chapter-repository.js';
import { createNoteRepository } from '../src/data/note-repository.js';
import {
  BOOK_TITLE_MAX,
  BookContentIntegrityError,
  BookNotEmptyError,
  BookNotFoundError,
  BookOperationError,
  BookValidationError,
  createBookService,
} from '../src/services/book-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MISSING_ID = 999999;

describe('book service', () => {
  let tmpDir;
  let db;
  let bookRepository;
  let bookContentRepository;
  let chapterRepository;
  let noteRepository;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-service-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    bookRepository = createBookRepository(db);
    bookContentRepository = createBookContentRepository(db);
    chapterRepository = createChapterRepository(db);
    noteRepository = createNoteRepository(db);
    service = createBookService({
      bookRepository,
      bookContentRepository,
      chapterRepository,
      noteRepository,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createChapter(bookId, title) {
    return chapterRepository.create({ bookId, title });
  }

  function createPage(bookId, title, chapterId = null) {
    return noteRepository.create({
      bookId,
      chapterId,
      title,
      content: `${title} content`,
    });
  }

  function appendContent(bookId, itemType, itemId) {
    return bookContentRepository.append(bookId, itemType, itemId);
  }

  it('requires a book repository dependency', () => {
    expect(() => createBookService()).toThrow(
      'createBookService requires a bookRepository dependency.'
    );
  });

  it('requires the repositories needed to read mixed Book contents', () => {
    expect(() => createBookService({ bookRepository })).toThrow(
      'createBookService requires a bookContentRepository dependency.'
    );
    expect(() => createBookService({ bookRepository, bookContentRepository })).toThrow(
      'createBookService requires a chapterRepository dependency.'
    );
    expect(() => createBookService({ bookRepository, bookContentRepository, chapterRepository })).toThrow(
      'createBookService requires a noteRepository dependency.'
    );
  });

  it('lists books in repository order', () => {
    const first = service.createBook({ title: 'First' });
    const second = service.createBook({ title: 'Second' });

    expect(service.listBooks()).toEqual([first, second]);
  });

  it('gets an existing book', () => {
    const created = service.createBook({ title: 'Detail' });

    expect(service.getBook(created.id)).toEqual(created);
  });

  it('validates and requires an existing Book for mixed content reads', () => {
    expect(() => service.listBookContents(0)).toThrow(BookValidationError);
    expect(() => service.listBookContents(MISSING_ID)).toThrow(BookNotFoundError);
  });

  it('returns an empty sequence for an empty Book', () => {
    const book = service.createBook({ title: 'Empty content' });

    expect(service.listBookContents(book.id)).toEqual([]);
  });

  it('hydrates a Chapter-only Book', () => {
    const book = service.createBook({ title: 'Chapter content' });
    const chapter = createChapter(book.id, 'Chapter One');
    appendContent(book.id, 'chapter', chapter.id);

    expect(service.listBookContents(book.id)).toEqual([{
      type: 'chapter',
      id: chapter.id,
      sortOrder: 0,
      chapter,
      pages: [],
    }]);
  });

  it('hydrates one Chapter Page beneath its Chapter item', () => {
    const book = service.createBook({ title: 'One Chapter Page' });
    const chapter = createChapter(book.id, 'Chapter One');
    const page = createPage(book.id, 'Page One', chapter.id);
    appendContent(book.id, 'chapter', chapter.id);

    const result = service.listBookContents(book.id);

    expect(result).toEqual([{
      type: 'chapter',
      id: chapter.id,
      sortOrder: 0,
      chapter,
      pages: [page],
    }]);
    expect(result[0].pages.every((nestedPage) => (
      nestedPage.book_id === book.id && nestedPage.chapter_id === chapter.id
    ))).toBe(true);
  });

  it('returns several Chapter Pages in canonical Chapter-local order', () => {
    const book = service.createBook({ title: 'Several Chapter Pages' });
    const chapter = createChapter(book.id, 'Chapter One');
    const first = createPage(book.id, 'First', chapter.id);
    const second = createPage(book.id, 'Second', chapter.id);
    const third = createPage(book.id, 'Third', chapter.id);
    appendContent(book.id, 'chapter', chapter.id);

    db.prepare('UPDATE notes SET sort_order = ? WHERE id = ?').run(20, first.id);
    db.prepare('UPDATE notes SET sort_order = ? WHERE id = ?').run(0, second.id);
    db.prepare('UPDATE notes SET sort_order = ? WHERE id = ?').run(10, third.id);

    const result = service.listBookContents(book.id);

    expect(result[0].pages.map(({ id, title, sort_order }) => ({ id, title, sort_order }))).toEqual([
      { id: second.id, title: 'Second', sort_order: 0 },
      { id: third.id, title: 'Third', sort_order: 10 },
      { id: first.id, title: 'First', sort_order: 20 },
    ]);
  });

  it('hydrates a direct-Page-only Book', () => {
    const book = service.createBook({ title: 'Page content' });
    const page = createPage(book.id, 'Page One');
    appendContent(book.id, 'page', page.id);

    expect(service.listBookContents(book.id)).toEqual([{
      type: 'page',
      id: page.id,
      sortOrder: 0,
      page,
    }]);
  });

  it('returns an interleaved sequence in book_contents order only', () => {
    const book = service.createBook({ title: 'Interleaved content' });
    const chapterX = createChapter(book.id, 'Chapter X');
    const pageA = createPage(book.id, 'Page A');
    const chapterY = createChapter(book.id, 'Chapter Y');
    const pageB = createPage(book.id, 'Page B');
    const nestedXFirst = createPage(book.id, 'Nested X First', chapterX.id);
    const nestedXSecond = createPage(book.id, 'Nested X Second', chapterX.id);
    const nestedYFirst = createPage(book.id, 'Nested Y First', chapterY.id);
    const nestedYSecond = createPage(book.id, 'Nested Y Second', chapterY.id);

    appendContent(book.id, 'page', pageA.id);
    appendContent(book.id, 'chapter', chapterX.id);
    appendContent(book.id, 'page', pageB.id);
    appendContent(book.id, 'chapter', chapterY.id);

    db.prepare('UPDATE chapters SET sort_order = ? WHERE id = ?').run(50, chapterX.id);
    db.prepare('UPDATE chapters SET sort_order = ? WHERE id = ?').run(1, chapterY.id);
    db.prepare('UPDATE notes SET sort_order = ? WHERE id = ?').run(40, pageA.id);
    db.prepare('UPDATE notes SET sort_order = ? WHERE id = ?').run(2, pageB.id);
    db.prepare('UPDATE notes SET sort_order = ? WHERE id = ?').run(30, nestedXFirst.id);
    db.prepare('UPDATE notes SET sort_order = ? WHERE id = ?').run(10, nestedXSecond.id);
    db.prepare('UPDATE notes SET sort_order = ? WHERE id = ?').run(5, nestedYFirst.id);
    db.prepare('UPDATE notes SET sort_order = ? WHERE id = ?').run(15, nestedYSecond.id);
    const bookBefore = bookRepository.findById(book.id);
    const contentsBefore = bookContentRepository.listForBook(book.id);
    const chaptersBefore = db.prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY id').all(book.id);
    const notesBefore = db.prepare('SELECT * FROM notes WHERE book_id = ? ORDER BY id').all(book.id);
    const foreignKeysBefore = db.pragma('foreign_key_check');

    const result = service.listBookContents(book.id);

    expect(result.map(({ type, id, sortOrder }) => ({ type, id, sortOrder }))).toEqual([
      { type: 'page', id: pageA.id, sortOrder: 0 },
      { type: 'chapter', id: chapterX.id, sortOrder: 1 },
      { type: 'page', id: pageB.id, sortOrder: 2 },
      { type: 'chapter', id: chapterY.id, sortOrder: 3 },
    ]);
    expect(result[0].page).toMatchObject({ title: 'Page A', sort_order: 40, chapter_id: null });
    expect(result[1].chapter).toMatchObject({ title: 'Chapter X', sort_order: 50 });
    expect(result[2].page).toMatchObject({ title: 'Page B', sort_order: 2, chapter_id: null });
    expect(result[3].chapter).toMatchObject({ title: 'Chapter Y', sort_order: 1 });
    expect(result[1].pages.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: nestedXSecond.id, title: 'Nested X Second' },
      { id: nestedXFirst.id, title: 'Nested X First' },
    ]);
    expect(result[3].pages.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: nestedYFirst.id, title: 'Nested Y First' },
      { id: nestedYSecond.id, title: 'Nested Y Second' },
    ]);
    expect(result.filter((item) => item.type === 'page').map(({ id }) => id)).toEqual([
      pageA.id,
      pageB.id,
    ]);
    expect(result.flatMap((item) => item.pages ?? []).map(({ id }) => id)).toEqual([
      nestedXSecond.id,
      nestedXFirst.id,
      nestedYFirst.id,
      nestedYSecond.id,
    ]);
    expect(bookRepository.findById(book.id)).toEqual(bookBefore);
    expect(bookContentRepository.listForBook(book.id)).toEqual(contentsBefore);
    expect(db.prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY id').all(book.id)).toEqual(chaptersBefore);
    expect(db.prepare('SELECT * FROM notes WHERE book_id = ? ORDER BY id').all(book.id)).toEqual(notesBefore);
    expect(db.pragma('foreign_key_check')).toEqual(foreignKeysBefore);
  });

  it('hydrates a Chapter and Page with the same numeric ID by type', () => {
    const book = service.createBook({ title: 'Typed identity' });
    const chapter = createChapter(book.id, 'Chapter Five');
    const page = createPage(book.id, 'Page Five');

    expect(chapter.id).toBe(page.id);
    appendContent(book.id, 'chapter', chapter.id);
    appendContent(book.id, 'page', page.id);

    const result = service.listBookContents(book.id);

    expect(result).toEqual([
      expect.objectContaining({
        type: 'chapter',
        id: chapter.id,
        chapter: expect.objectContaining({ title: 'Chapter Five' }),
        pages: [],
      }),
      expect.objectContaining({ type: 'page', id: page.id, page: expect.objectContaining({ title: 'Page Five' }) }),
    ]);
  });

  it('excludes memberships belonging to another Book', () => {
    const book = service.createBook({ title: 'Included Book' });
    const otherBook = service.createBook({ title: 'Other Book' });
    const chapter = createChapter(book.id, 'Included Chapter');
    const otherChapter = createChapter(otherBook.id, 'Other Chapter');
    const otherPage = createPage(otherBook.id, 'Other Page');
    appendContent(book.id, 'chapter', chapter.id);
    appendContent(otherBook.id, 'chapter', otherChapter.id);
    appendContent(otherBook.id, 'page', otherPage.id);

    expect(service.listBookContents(book.id).map(({ id }) => id)).toEqual([chapter.id]);
  });

  it('fails coherently for a missing Chapter membership target', () => {
    const book = service.createBook({ title: 'Missing Chapter target' });
    const page = createPage(book.id, 'Valid Page');
    appendContent(book.id, 'page', page.id);
    appendContent(book.id, 'chapter', MISSING_ID);

    let result = 'not called';
    let error;
    try {
      result = service.listBookContents(book.id);
    } catch (caught) {
      error = caught;
    }

    expect(result).toBe('not called');
    expect(error).toBeInstanceOf(BookContentIntegrityError);
    expect(error.code).toBe('CONTENT_ITEM_NOT_FOUND');
  });

  it('validates a Chapter membership before loading its Pages', () => {
    const book = service.createBook({ title: 'Validate before hydrate' });
    const listForChapter = vi.spyOn(noteRepository, 'listForChapter');
    appendContent(book.id, 'chapter', MISSING_ID);

    expect(() => service.listBookContents(book.id)).toThrow(BookContentIntegrityError);
    expect(listForChapter).not.toHaveBeenCalled();
  });

  it('fails when a Chapter membership targets another Book', () => {
    const book = service.createBook({ title: 'Chapter mismatch target' });
    const otherBook = service.createBook({ title: 'Chapter owner' });
    const chapter = createChapter(otherBook.id, 'Foreign Chapter');
    appendContent(book.id, 'chapter', chapter.id);

    expect(() => service.listBookContents(book.id)).toThrow(BookContentIntegrityError);
    expect(() => service.listBookContents(book.id)).toThrow(
      expect.objectContaining({ code: 'CONTENT_BOOK_MISMATCH' }),
    );
  });

  it('fails for a missing Page membership target', () => {
    const book = service.createBook({ title: 'Missing Page target' });
    appendContent(book.id, 'page', MISSING_ID);

    expect(() => service.listBookContents(book.id)).toThrow(
      expect.objectContaining({
        code: 'CONTENT_ITEM_NOT_FOUND',
        name: 'BookContentIntegrityError',
      }),
    );
  });

  it('fails when a Page membership targets another Book', () => {
    const book = service.createBook({ title: 'Page mismatch target' });
    const otherBook = service.createBook({ title: 'Page owner' });
    const page = createPage(otherBook.id, 'Foreign Page');
    appendContent(book.id, 'page', page.id);

    expect(() => service.listBookContents(book.id)).toThrow(
      expect.objectContaining({ code: 'CONTENT_BOOK_MISMATCH' }),
    );
  });

  it('fails when a Chapter Page is referenced as a direct Page', () => {
    const book = service.createBook({ title: 'Nested Page target' });
    const chapter = createChapter(book.id, 'Parent Chapter');
    const page = createPage(book.id, 'Nested Page', chapter.id);
    appendContent(book.id, 'page', page.id);

    expect(() => service.listBookContents(book.id)).toThrow(
      expect.objectContaining({ code: 'CONTENT_PAGE_NOT_DIRECT' }),
    );
  });

  it('does not mutate Book content or legacy ordering while reading', () => {
    const book = service.createBook({ title: 'Read-only content' });
    const chapter = createChapter(book.id, 'Read-only Chapter');
    const directPage = createPage(book.id, 'Read-only Page');
    const chapterPage = createPage(book.id, 'Read-only Chapter Page', chapter.id);
    appendContent(book.id, 'page', directPage.id);
    appendContent(book.id, 'chapter', chapter.id);
    db.prepare('UPDATE chapters SET sort_order = ? WHERE id = ?').run(27, chapter.id);
    db.prepare('UPDATE notes SET sort_order = ? WHERE id = ?').run(19, directPage.id);
    db.prepare('UPDATE notes SET sort_order = ? WHERE id = ?').run(23, chapterPage.id);

    const contentsBefore = bookContentRepository.listForBook(book.id);
    const chapterBefore = chapterRepository.findById(chapter.id);
    const directPageBefore = noteRepository.findById(directPage.id);
    const chapterPageBefore = noteRepository.findById(chapterPage.id);

    service.listBookContents(book.id);

    expect(bookContentRepository.listForBook(book.id)).toEqual(contentsBefore);
    expect(chapterRepository.findById(chapter.id)).toEqual(chapterBefore);
    expect(noteRepository.findById(directPage.id)).toEqual(directPageBefore);
    expect(noteRepository.findById(chapterPage.id)).toEqual(chapterPageBefore);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('reorders mixed Book contents by typed identity and leaves other Books unchanged', () => {
    const book = service.createBook({ title: 'Mixed reorder' });
    const pageA = createPage(book.id, 'Page A');
    const chapterX = createChapter(book.id, 'Chapter X');
    const pageB = createPage(book.id, 'Page B');
    const chapterY = createChapter(book.id, 'Chapter Y');
    appendContent(book.id, 'page', pageA.id);
    appendContent(book.id, 'chapter', chapterX.id);
    appendContent(book.id, 'page', pageB.id);
    appendContent(book.id, 'chapter', chapterY.id);

    const otherBook = service.createBook({ title: 'Other mixed reorder' });
    const otherChapter = createChapter(otherBook.id, 'Other Chapter');
    const otherPage = createPage(otherBook.id, 'Other Page');
    appendContent(otherBook.id, 'chapter', otherChapter.id);
    appendContent(otherBook.id, 'page', otherPage.id);
    const otherContentsBefore = bookContentRepository.listForBook(otherBook.id);

    const reordered = service.reorderBookContents(book.id, [
      { type: 'chapter', id: chapterY.id },
      { type: 'page', id: pageA.id },
      { type: 'chapter', id: chapterX.id },
      { type: 'page', id: pageB.id },
    ]);

    expect(chapterX.id).toBe(pageA.id);
    expect(chapterY.id).toBe(pageB.id);
    expect(reordered.map(({ item_type, item_id, sort_order }) => ({
      type: item_type,
      id: item_id,
      sortOrder: sort_order,
    }))).toEqual([
      { type: 'chapter', id: chapterY.id, sortOrder: 0 },
      { type: 'page', id: pageA.id, sortOrder: 1 },
      { type: 'chapter', id: chapterX.id, sortOrder: 2 },
      { type: 'page', id: pageB.id, sortOrder: 3 },
    ]);
    expect(bookContentRepository.listForBook(otherBook.id)).toEqual(otherContentsBefore);
    expect(service.listBookContents(book.id).map(({ type, id }) => ({ type, id }))).toEqual([
      { type: 'chapter', id: chapterY.id },
      { type: 'page', id: pageA.id },
      { type: 'chapter', id: chapterX.id },
      { type: 'page', id: pageB.id },
    ]);
  });

  it('requires an existing Book and translates Book-content reorder validation', () => {
    const book = service.createBook({ title: 'Reorder validation' });

    expect(() => service.reorderBookContents(MISSING_ID, [])).toThrow(BookNotFoundError);
    expect(() => service.reorderBookContents(book.id, 'not an array')).toThrow(BookValidationError);
  });

  it('creates a book with a trimmed title', () => {
    const created = service.createBook({ title: '  Project plans  ' });

    expect(created).toMatchObject({ title: 'Project plans', sort_order: 0 });
  });

  it('rejects a blank title', () => {
    expect(() => service.createBook({ title: '   ' })).toThrow(BookValidationError);
    expect(service.listBooks()).toEqual([]);
  });

  it('rejects an overlong title', () => {
    expect(() => service.createBook({ title: 'x'.repeat(BOOK_TITLE_MAX + 1) }))
      .toThrow(BookValidationError);
    expect(service.listBooks()).toEqual([]);
  });

  it('updates and trims a book title', () => {
    const created = service.createBook({ title: 'Before' });

    const updated = service.updateBook(created.id, { title: '  After  ' });

    expect(updated).toMatchObject({ id: created.id, title: 'After' });
  });

  it('throws BookNotFoundError for missing get, update, and delete operations', () => {
    expect(() => service.getBook(MISSING_ID)).toThrow(BookNotFoundError);
    expect(() => service.updateBook(MISSING_ID, { title: 'Missing' })).toThrow(BookNotFoundError);
    expect(() => service.deleteBook(MISSING_ID)).toThrow(BookNotFoundError);
  });

  it('reorders books through the repository and returns canonical order', () => {
    const first = service.createBook({ title: 'First' });
    const second = service.createBook({ title: 'Second' });
    const third = service.createBook({ title: 'Third' });
    const orderedIds = [third.id, first.id, second.id];

    const reordered = service.reorderBooks(orderedIds);

    expect(reordered.map((book) => book.id)).toEqual(orderedIds);
    expect(reordered.map((book) => book.sort_order)).toEqual([0, 1, 2]);
  });

  it('rejects malformed reorder input', () => {
    expect(() => service.reorderBooks('not an array')).toThrow(BookValidationError);
    expect(() => service.reorderBooks([1, '2'])).toThrow(BookValidationError);
  });

  it('translates repository reorder validation errors', () => {
    const first = service.createBook({ title: 'First' });
    const second = service.createBook({ title: 'Second' });
    vi.spyOn(bookRepository, 'reorder').mockImplementation(() => {
      throw new BookError('repository detail', { code: 'INVALID_SEQUENCE_LENGTH' });
    });

    let error;
    try {
      service.reorderBooks([second.id, first.id]);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BookValidationError);
    expect(error.errors.orderedIds).toBeTruthy();
    expect(error.message).not.toContain('repository detail');
  });

  it('translates unexpected repository errors without exposing BookError', () => {
    const first = service.createBook({ title: 'First' });
    const second = service.createBook({ title: 'Second' });
    vi.spyOn(bookRepository, 'reorder').mockImplementation(() => {
      throw new BookError('repository detail', { code: 'UPDATE_CHANGES_MISMATCH' });
    });

    let error;
    try {
      service.reorderBooks([second.id, first.id]);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BookOperationError);
    expect(error.code).toBe('BOOK_OPERATION_FAILED');
    expect(error.message).not.toContain('repository detail');
  });

  it('deletes an empty book', () => {
    const created = service.createBook({ title: 'Empty' });

    expect(service.deleteBook(created.id)).toBe(true);
    expect(bookRepository.findById(created.id)).toBeUndefined();
  });

  it('translates a non-empty delete failure', () => {
    const created = service.createBook({ title: 'Has chapter' });
    db.prepare('INSERT INTO chapters (book_id, title, sort_order) VALUES (?, ?, ?)')
      .run(created.id, 'Chapter', 0);

    let error;
    try {
      service.deleteBook(created.id);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BookNotEmptyError);
    expect(error.status).toBe(409);
    expect(error.code).toBe('BOOK_NOT_EMPTY');
    expect(bookRepository.findById(created.id)).toBeDefined();
  });
});
