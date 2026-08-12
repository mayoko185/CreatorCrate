import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createBookRepository } from '../src/data/book-repository.js';
import { createBookContentRepository } from '../src/data/book-content-repository.js';
import { ChapterError, createChapterRepository } from '../src/data/chapter-repository.js';
import { BookNotFoundError } from '../src/services/book-service.js';
import {
  CHAPTER_TITLE_MAX,
  ChapterNotEmptyError,
  ChapterNotFoundError,
  ChapterOperationError,
  ChapterValidationError,
  createChapterService,
} from '../src/services/chapter-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MISSING_ID = 999999;

describe('chapter service', () => {
  let tmpDir;
  let db;
  let bookRepository;
  let chapterRepository;
  let bookContentRepository;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-chapter-service-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    bookRepository = createBookRepository(db);
    chapterRepository = createChapterRepository(db);
    bookContentRepository = createBookContentRepository(db);
    service = createChapterService({ db, chapterRepository, bookRepository, bookContentRepository });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('requires Chapter and Book repository dependencies', () => {
    expect(() => createChapterService()).toThrow(
      'createChapterService requires a chapterRepository dependency.'
    );
    expect(() => createChapterService({ chapterRepository })).toThrow(
      'createChapterService requires a bookRepository dependency.'
    );
    expect(() => createChapterService({ chapterRepository, bookRepository })).toThrow(
      'createChapterService requires a bookContentRepository dependency.'
    );
    expect(() => createChapterService({ chapterRepository, bookRepository, bookContentRepository })).toThrow(
      'createChapterService requires a db dependency.'
    );
  });

  it('lists Chapters for a valid Book in repository order', () => {
    const book = bookRepository.create({ title: 'Book' });
    const first = service.createChapter({ bookId: book.id, title: 'First' });
    const second = service.createChapter({ bookId: book.id, title: 'Second' });

    expect(service.listChapters(book.id)).toEqual([first, second]);
  });

  it('creates a Chapter with a trimmed title', () => {
    const book = bookRepository.create({ title: 'Book' });

    const created = service.createChapter({ bookId: book.id, title: '  Plans  ' });

    expect(created).toMatchObject({ book_id: book.id, title: 'Plans', sort_order: 0 });
    expect(chapterRepository.findById(created.id)).toEqual(created);
  });

  it('appends exactly one Chapter membership at the end of an empty Book', () => {
    const book = bookRepository.create({ title: 'Book' });

    const created = service.createChapter({ bookId: book.id, title: 'Plans' });

    expect(bookContentRepository.listForBook(book.id)).toEqual([
      { book_id: book.id, item_type: 'chapter', item_id: created.id, sort_order: 0 },
    ]);
  });

  it('rejects blank and overlong Chapter titles', () => {
    const book = bookRepository.create({ title: 'Book' });

    expect(() => service.createChapter({ bookId: book.id, title: '   ' }))
      .toThrow(ChapterValidationError);
    expect(() => service.createChapter({ bookId: book.id, title: 'x'.repeat(CHAPTER_TITLE_MAX + 1) }))
      .toThrow(ChapterValidationError);
    expect(service.listChapters(book.id)).toEqual([]);
    expect(bookContentRepository.listForBook(book.id)).toEqual([]);
  });

  it('rejects invalid Chapter and Book IDs', () => {
    const book = bookRepository.create({ title: 'Book' });

    expect(() => service.getChapter(0)).toThrow(ChapterValidationError);
    expect(() => service.updateChapter('1', { title: 'Updated' })).toThrow(ChapterValidationError);
    expect(() => service.deleteChapter(Number.MAX_SAFE_INTEGER + 1)).toThrow(ChapterValidationError);
    expect(() => service.listChapters('1')).toThrow(ChapterValidationError);
    expect(() => service.createChapter({ bookId: 0, title: 'Chapter' })).toThrow(ChapterValidationError);
    expect(() => service.reorderChapters(book.id, [])).not.toThrow();
    expect(() => service.reorderChapters(0, [])).toThrow(ChapterValidationError);
  });

  it('gets an existing Chapter and rejects a missing one', () => {
    const book = bookRepository.create({ title: 'Book' });
    const created = service.createChapter({ bookId: book.id, title: 'Detail' });

    expect(service.getChapter(created.id)).toEqual(created);
    expect(() => service.getChapter(MISSING_ID)).toThrow(ChapterNotFoundError);
  });

  it('updates an existing Chapter and rejects a missing one', () => {
    const book = bookRepository.create({ title: 'Book' });
    const created = service.createChapter({ bookId: book.id, title: 'Before' });

    expect(service.updateChapter(created.id, { title: '  After  ' }))
      .toMatchObject({ id: created.id, title: 'After' });
    expect(() => service.updateChapter(MISSING_ID, { title: 'Missing' }))
      .toThrow(ChapterNotFoundError);
  });

  it('throws BookNotFoundError for missing parent Book list, create, and reorder operations', () => {
    expect(() => service.listChapters(MISSING_ID)).toThrow(BookNotFoundError);
    expect(() => service.createChapter({ bookId: MISSING_ID, title: 'Missing parent' }))
      .toThrow(BookNotFoundError);
    expect(() => service.reorderChapters(MISSING_ID, [])).toThrow(BookNotFoundError);
    expect(chapterRepository.listForBook(MISSING_ID)).toEqual([]);
    expect(bookContentRepository.listForBook(MISSING_ID)).toEqual([]);
  });

  it('appends Chapters after existing mixed Book content', () => {
    const book = bookRepository.create({ title: 'Book' });
    const first = service.createChapter({ bookId: book.id, title: 'First' });
    const pageId = 7001;
    bookContentRepository.append(book.id, 'page', pageId);
    const second = service.createChapter({ bookId: book.id, title: 'Second' });

    expect(bookContentRepository.listForBook(book.id)).toEqual([
      { book_id: book.id, item_type: 'chapter', item_id: first.id, sort_order: 0 },
      { book_id: book.id, item_type: 'page', item_id: pageId, sort_order: 1 },
      { book_id: book.id, item_type: 'chapter', item_id: second.id, sort_order: 2 },
    ]);
  });

  it('keeps Chapter memberships contiguous per Book without affecting another Book', () => {
    const firstBook = bookRepository.create({ title: 'First Book' });
    const secondBook = bookRepository.create({ title: 'Second Book' });

    const first = service.createChapter({ bookId: firstBook.id, title: 'First' });
    const otherFirst = service.createChapter({ bookId: secondBook.id, title: 'Other First' });
    const second = service.createChapter({ bookId: firstBook.id, title: 'Second' });
    const otherSecond = service.createChapter({ bookId: secondBook.id, title: 'Other Second' });

    expect(bookContentRepository.listForBook(firstBook.id)).toEqual([
      { book_id: firstBook.id, item_type: 'chapter', item_id: first.id, sort_order: 0 },
      { book_id: firstBook.id, item_type: 'chapter', item_id: second.id, sort_order: 1 },
    ]);
    expect(bookContentRepository.listForBook(secondBook.id)).toEqual([
      { book_id: secondBook.id, item_type: 'chapter', item_id: otherFirst.id, sort_order: 0 },
      { book_id: secondBook.id, item_type: 'chapter', item_id: otherSecond.id, sort_order: 1 },
    ]);
  });

  it('does not leave a Chapter or membership when appending fails', () => {
    const book = bookRepository.create({ title: 'Book' });
    const originalAppend = bookContentRepository.append;
    vi.spyOn(bookContentRepository, 'append').mockImplementation((...args) => {
      originalAppend(...args);
      throw new Error('append failed');
    });

    expect(() => service.createChapter({ bookId: book.id, title: 'Broken' }))
      .toThrow('append failed');
    expect(chapterRepository.listForBook(book.id)).toEqual([]);
    expect(bookContentRepository.listForBook(book.id)).toEqual([]);
  });

  it('does not add a membership when Chapter creation fails', () => {
    const book = bookRepository.create({ title: 'Book' });
    vi.spyOn(chapterRepository, 'create').mockImplementation(() => {
      throw new Error('create failed');
    });

    expect(() => service.createChapter({ bookId: book.id, title: 'Broken' }))
      .toThrow('create failed');
    expect(chapterRepository.listForBook(book.id)).toEqual([]);
    expect(bookContentRepository.listForBook(book.id)).toEqual([]);
  });

  it('reorders Chapters through the repository and returns canonical order', () => {
    const book = bookRepository.create({ title: 'Book' });
    const first = service.createChapter({ bookId: book.id, title: 'First' });
    const second = service.createChapter({ bookId: book.id, title: 'Second' });
    const third = service.createChapter({ bookId: book.id, title: 'Third' });
    const orderedIds = [third.id, first.id, second.id];

    const reordered = service.reorderChapters(book.id, orderedIds);

    expect(reordered.map((chapter) => chapter.id)).toEqual(orderedIds);
    expect(reordered.map((chapter) => chapter.sort_order)).toEqual([0, 1, 2]);
  });

  it('rejects malformed reorder input', () => {
    const book = bookRepository.create({ title: 'Book' });

    expect(() => service.reorderChapters(book.id, 'not an array')).toThrow(ChapterValidationError);
    expect(() => service.reorderChapters(book.id, [1, '2'])).toThrow(ChapterValidationError);
  });

  it('translates cross-Book repository permutation failures', () => {
    const firstBook = bookRepository.create({ title: 'First Book' });
    const secondBook = bookRepository.create({ title: 'Second Book' });
    const first = service.createChapter({ bookId: firstBook.id, title: 'First' });
    const other = service.createChapter({ bookId: secondBook.id, title: 'Other' });

    let error;
    try {
      service.reorderChapters(firstBook.id, [first.id, other.id]);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ChapterValidationError);
    expect(error.errors.orderedIds).toBeTruthy();
    expect(error.message).not.toContain(`Chapter ID ${other.id}`);
  });

  it('translates unexpected Chapter repository errors without exposing details', () => {
    const book = bookRepository.create({ title: 'Book' });
    const first = service.createChapter({ bookId: book.id, title: 'First' });
    const second = service.createChapter({ bookId: book.id, title: 'Second' });
    vi.spyOn(chapterRepository, 'reorder').mockImplementation(() => {
      throw new ChapterError('repository detail', { code: 'UPDATE_CHANGES_MISMATCH' });
    });

    let error;
    try {
      service.reorderChapters(book.id, [second.id, first.id]);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ChapterOperationError);
    expect(error.code).toBe('CHAPTER_OPERATION_FAILED');
    expect(error.message).not.toContain('repository detail');
  });

  it('deletes an empty Chapter', () => {
    const book = bookRepository.create({ title: 'Book' });
    const created = service.createChapter({ bookId: book.id, title: 'Empty' });

    expect(service.deleteChapter(created.id)).toBe(true);
    expect(chapterRepository.findById(created.id)).toBeUndefined();
    expect(bookContentRepository.listForBook(book.id)).toEqual([]);
  });

  it.each([
    ['first', 0],
    ['middle', 1],
    ['last', 2],
  ])('deletes an empty Chapter in the %s mixed-content position and compacts its Book', (_position, targetChapterIndex) => {
    const book = bookRepository.create({ title: 'Book' });
    const otherBook = bookRepository.create({ title: 'Other Book' });
    const chapters = [];
    const pageIds = [7001, 7002];

    for (const title of ['First', 'Second', 'Third']) {
      chapters.push(service.createChapter({ bookId: book.id, title }));
      if (chapters.length <= pageIds.length) {
        bookContentRepository.append(book.id, 'page', pageIds[chapters.length - 1]);
      }
    }

    const target = chapters[targetChapterIndex];
    const otherChapter = service.createChapter({ bookId: otherBook.id, title: 'Other' });
    bookContentRepository.append(otherBook.id, 'page', 8001);
    const otherBookBefore = bookContentRepository.listForBook(otherBook.id);
    const before = bookContentRepository.listForBook(book.id);

    expect(before.map((row) => [row.item_type, row.item_id])).toEqual([
      ['chapter', chapters[0].id],
      ['page', pageIds[0]],
      ['chapter', chapters[1].id],
      ['page', pageIds[1]],
      ['chapter', chapters[2].id],
    ]);

    expect(service.deleteChapter(target.id)).toBe(true);

    const after = bookContentRepository.listForBook(book.id);
    expect(after.map((row) => [row.item_type, row.item_id])).toEqual(
      before
        .filter((row) => !(row.item_type === 'chapter' && row.item_id === target.id))
        .map((row) => [row.item_type, row.item_id])
    );
    expect(after.map((row) => row.sort_order)).toEqual([0, 1, 2, 3]);
    expect(after.filter((row) => row.item_type === 'page').map((row) => row.item_id))
      .toEqual(pageIds);
    expect(after.filter((row) => row.item_type === 'chapter').map((row) => row.item_id))
      .toEqual(chapters.filter((chapter) => chapter.id !== target.id).map((chapter) => chapter.id));
    expect(chapterRepository.findById(target.id)).toBeUndefined();
    expect(chapterRepository.findById(otherChapter.id)).toBeDefined();
    expect(bookContentRepository.listForBook(otherBook.id)).toEqual(otherBookBefore);
  });

  it('rejects missing and non-empty Chapter deletion', () => {
    const book = bookRepository.create({ title: 'Book' });
    const chapter = service.createChapter({ bookId: book.id, title: 'Has Notes' });
    bookContentRepository.append(book.id, 'page', 7001);
    const otherChapter = service.createChapter({ bookId: book.id, title: 'After Notes' });
    db.prepare(`
      INSERT INTO notes (book_id, chapter_id, title, content, sort_order)
      VALUES (?, ?, 'Note', '', 0)
    `).run(book.id, chapter.id);
    const contentBefore = bookContentRepository.listForBook(book.id);

    expect(() => service.deleteChapter(MISSING_ID)).toThrow(ChapterNotFoundError);

    let error;
    try {
      service.deleteChapter(chapter.id);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ChapterNotEmptyError);
    expect(error.status).toBe(409);
    expect(error.code).toBe('CHAPTER_NOT_EMPTY');
    expect(chapterRepository.findById(chapter.id)).toBeDefined();
    expect(bookContentRepository.listForBook(book.id)).toEqual(contentBefore);
    expect(chapterRepository.findById(otherChapter.id)).toBeDefined();
  });

  it('rolls back Chapter deletion when its membership is missing', () => {
    const book = bookRepository.create({ title: 'Book' });
    const chapter = service.createChapter({ bookId: book.id, title: 'Corrupt' });
    expect(bookContentRepository.remove(book.id, 'chapter', chapter.id)).toBe(true);

    expect(() => service.deleteChapter(chapter.id)).toThrow(ChapterOperationError);
    expect(chapterRepository.findById(chapter.id)).toBeDefined();
    expect(bookContentRepository.listForBook(book.id)).toEqual([]);
  });

  it('rolls back Chapter deletion when membership removal fails', () => {
    const book = bookRepository.create({ title: 'Book' });
    const chapter = service.createChapter({ bookId: book.id, title: 'Broken membership removal' });
    const contentBefore = bookContentRepository.listForBook(book.id);
    const originalRemove = bookContentRepository.remove;
    vi.spyOn(bookContentRepository, 'remove').mockImplementation((...args) => {
      originalRemove(...args);
      throw new Error('remove failed');
    });

    expect(() => service.deleteChapter(chapter.id)).toThrow('remove failed');
    expect(chapterRepository.findById(chapter.id)).toBeDefined();
    expect(bookContentRepository.listForBook(book.id)).toEqual(contentBefore);
  });

  it('leaves membership unchanged when Chapter deletion fails', () => {
    const book = bookRepository.create({ title: 'Book' });
    const chapter = service.createChapter({ bookId: book.id, title: 'Broken Chapter deletion' });
    const contentBefore = bookContentRepository.listForBook(book.id);
    const originalDeleteAndCompact = chapterRepository.deleteAndCompact;
    vi.spyOn(chapterRepository, 'deleteAndCompact').mockImplementation((...args) => {
      originalDeleteAndCompact(...args);
      throw new Error('delete failed');
    });

    expect(() => service.deleteChapter(chapter.id)).toThrow('delete failed');
    expect(chapterRepository.findById(chapter.id)).toBeDefined();
    expect(bookContentRepository.listForBook(book.id)).toEqual(contentBefore);
  });
});
