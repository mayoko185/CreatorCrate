import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createBookRepository } from '../src/data/book-repository.js';
import { createNoteRepository } from '../src/data/note-repository.js';
import { createBookPagePreviewSettingsRepository } from '../src/data/book-page-preview-settings-repository.js';
import {
  BookPagePreviewSettingsError,
  createBookPagePreviewSettingsService,
} from '../src/services/book-page-preview-settings-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('Book Page-preview settings service', () => {
  let db;
  let bookRepository;
  let noteRepository;
  let repository;
  let service;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    bookRepository = createBookRepository(db);
    noteRepository = createNoteRepository(db);
    repository = createBookPagePreviewSettingsRepository(db);
    service = createBookPagePreviewSettingsService({ repository, bookRepository });
  });

  afterEach(() => closeDatabase(db));

  function createBook(title) {
    return bookRepository.create({ title });
  }

  it('resolves absence to Random/5/empty without inserting a row', () => {
    const book = createBook('Defaults');

    expect(service.getBookPagePreviewSettings(book.id)).toEqual({
      mode: 'random', randomCount: 5, selectedPageIds: [],
    });
    expect(db.prepare('SELECT COUNT(*) FROM book_page_preview_settings').pluck().get()).toBe(0);
  });

  it('accepts valid random and selected settings at both count bounds', () => {
    const book = createBook('Bounds');
    const page = noteRepository.create({ bookId: book.id, title: 'Page' });

    expect(service.replaceBookPagePreviewSettings(book.id, {
      mode: 'random', randomCount: 1, selectedPageIds: [],
    })).toEqual({ mode: 'random', randomCount: 1, selectedPageIds: [] });
    expect(service.replaceBookPagePreviewSettings(book.id, {
      mode: 'selected', randomCount: 25, selectedPageIds: [page.id],
    })).toEqual({ mode: 'selected', randomCount: 25, selectedPageIds: [page.id] });
  });

  it('rejects counts outside 1 through 25', () => {
    const book = createBook('Invalid bounds');

    for (const randomCount of [0, 26, 1.5, '5']) {
      expect(() => service.replaceBookPagePreviewSettings(book.id, {
        mode: 'random', randomCount, selectedPageIds: [],
      })).toThrow(BookPagePreviewSettingsError);
    }
    expect(service.getBookPagePreviewSettings(book.id)).toEqual({
      mode: 'random', randomCount: 5, selectedPageIds: [],
    });
  });

  it('deduplicates and returns selected Page IDs deterministically', () => {
    const book = createBook('Canonical IDs');
    const first = noteRepository.create({ bookId: book.id, title: 'First' });
    const second = noteRepository.create({ bookId: book.id, title: 'Second' });

    expect(service.replaceBookPagePreviewSettings(book.id, {
      mode: 'selected', randomCount: 5,
      selectedPageIds: [second.id, first.id, second.id],
    }).selectedPageIds).toEqual([first.id, second.id]);
    expect(service.getBookPagePreviewSettings(book.id).selectedPageIds)
      .toEqual([first.id, second.id]);
  });

  it('returns a 422-capable domain error for a foreign Page without mutation', () => {
    const firstBook = createBook('First');
    const secondBook = createBook('Second');
    const retained = noteRepository.create({ bookId: firstBook.id, title: 'Retained' });
    const foreign = noteRepository.create({ bookId: secondBook.id, title: 'Foreign' });
    service.replaceBookPagePreviewSettings(firstBook.id, {
      mode: 'selected', randomCount: 5, selectedPageIds: [retained.id],
    });

    try {
      service.replaceBookPagePreviewSettings(firstBook.id, {
        mode: 'random', randomCount: 1, selectedPageIds: [foreign.id],
      });
      throw new Error('Expected foreign membership rejection.');
    } catch (error) {
      expect(error).toBeInstanceOf(BookPagePreviewSettingsError);
      expect(error).toMatchObject({ code: 'PAGE_NOT_IN_BOOK', status: 422 });
    }
    expect(service.getBookPagePreviewSettings(firstBook.id)).toEqual({
      mode: 'selected', randomCount: 5, selectedPageIds: [retained.id],
    });
  });

  it('maps an unexpected replacement failure and preserves prior state', () => {
    const book = createBook('Failure');
    const page = noteRepository.create({ bookId: book.id, title: 'Page' });
    service.replaceBookPagePreviewSettings(book.id, {
      mode: 'selected', randomCount: 5, selectedPageIds: [page.id],
    });
    db.exec(`
      CREATE TRIGGER fail_preview_settings_update
      BEFORE UPDATE ON book_page_preview_settings
      BEGIN
        SELECT RAISE(ABORT, 'forced settings failure');
      END
    `);

    expect(() => service.replaceBookPagePreviewSettings(book.id, {
      mode: 'random', randomCount: 25, selectedPageIds: [],
    })).toThrow(expect.objectContaining({ code: 'DATABASE_ERROR', status: 500 }));
    expect(service.getBookPagePreviewSettings(book.id)).toEqual({
      mode: 'selected', randomCount: 5, selectedPageIds: [page.id],
    });
  });
});
