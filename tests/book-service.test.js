import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { BookError, createBookRepository } from '../src/data/book-repository.js';
import {
  BOOK_TITLE_MAX,
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
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-service-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    bookRepository = createBookRepository(db);
    service = createBookService({ bookRepository });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('requires a book repository dependency', () => {
    expect(() => createBookService()).toThrow(
      'createBookService requires a bookRepository dependency.'
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
