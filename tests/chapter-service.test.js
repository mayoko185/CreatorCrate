import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createBookRepository } from '../src/data/book-repository.js';
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
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-chapter-service-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    bookRepository = createBookRepository(db);
    chapterRepository = createChapterRepository(db);
    service = createChapterService({ chapterRepository, bookRepository });
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
  });

  it('rejects blank and overlong Chapter titles', () => {
    const book = bookRepository.create({ title: 'Book' });

    expect(() => service.createChapter({ bookId: book.id, title: '   ' }))
      .toThrow(ChapterValidationError);
    expect(() => service.createChapter({ bookId: book.id, title: 'x'.repeat(CHAPTER_TITLE_MAX + 1) }))
      .toThrow(ChapterValidationError);
    expect(service.listChapters(book.id)).toEqual([]);
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
  });

  it('rejects missing and non-empty Chapter deletion', () => {
    const book = bookRepository.create({ title: 'Book' });
    const chapter = service.createChapter({ bookId: book.id, title: 'Has Notes' });
    db.prepare(`
      INSERT INTO notes (chapter_id, title, content, sort_order)
      VALUES (?, 'Note', '', 0)
    `).run(chapter.id);

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
  });
});
