import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import {
  BookPagePreviewSettingsRepositoryError,
  createBookPagePreviewSettingsRepository,
} from '../src/data/book-page-preview-settings-repository.js';
import { createNoteRepository } from '../src/data/note-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('Book Page-preview settings repository', () => {
  let db;
  let repository;
  let noteRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    repository = createBookPagePreviewSettingsRepository(db);
    noteRepository = createNoteRepository(db);
  });

  afterEach(() => closeDatabase(db));

  function createBook(title) {
    return Number(db.prepare(`
      INSERT INTO books (title, sort_order)
      VALUES (?, (SELECT COUNT(*) FROM books))
    `).run(title).lastInsertRowid);
  }

  function createChapter(bookId, title) {
    return Number(db.prepare(`
      INSERT INTO chapters (book_id, title, sort_order)
      VALUES (?, ?, (SELECT COUNT(*) FROM chapters WHERE book_id = ?))
    `).run(bookId, title, bookId).lastInsertRowid);
  }

  function createPage(bookId, chapterId = null, title = 'Page') {
    return noteRepository.create({ bookId, chapterId, title });
  }

  it('atomically replaces normalized selections and isolates Books', () => {
    const firstBookId = createBook('First');
    const secondBookId = createBook('Second');
    const first = createPage(firstBookId, null, 'First');
    const second = createPage(firstBookId, null, 'Second');
    const other = createPage(secondBookId, null, 'Other');

    expect(repository.replace(firstBookId, {
      mode: 'selected', randomCount: 7, selectedPageIds: [second.id, first.id],
    })).toMatchObject({
      book_id: firstBookId, mode: 'selected', random_count: 7,
      selected_page_ids: [first.id, second.id],
    });
    repository.replace(secondBookId, {
      mode: 'selected', randomCount: 3, selectedPageIds: [other.id],
    });
    repository.replace(firstBookId, {
      mode: 'random', randomCount: 25, selectedPageIds: [second.id],
    });

    expect(repository.findByBookId(firstBookId)).toMatchObject({
      mode: 'random', random_count: 25, selected_page_ids: [second.id],
    });
    expect(repository.findByBookId(secondBookId)).toMatchObject({
      mode: 'selected', random_count: 3, selected_page_ids: [other.id],
    });
  });

  it('rejects foreign or stale Pages and rolls the complete replacement back', () => {
    const firstBookId = createBook('First');
    const secondBookId = createBook('Second');
    const retained = createPage(firstBookId, null, 'Retained');
    const foreign = createPage(secondBookId, null, 'Foreign');
    repository.replace(firstBookId, {
      mode: 'selected', randomCount: 5, selectedPageIds: [retained.id],
    });
    const before = repository.findByBookId(firstBookId);

    for (const invalidPageId of [foreign.id, 999999]) {
      expect(() => repository.replace(firstBookId, {
        mode: 'random', randomCount: 1, selectedPageIds: [invalidPageId],
      })).toThrow(BookPagePreviewSettingsRepositoryError);
      expect(repository.findByBookId(firstBookId)).toEqual(before);
    }
  });

  it('defensively excludes a foreign membership if database integrity was bypassed', () => {
    const firstBookId = createBook('First');
    const secondBookId = createBook('Second');
    const foreign = createPage(secondBookId, null, 'Foreign');
    repository.replace(firstBookId, { mode: 'selected', randomCount: 5, selectedPageIds: [] });
    db.pragma('foreign_keys = OFF');
    db.prepare('INSERT INTO book_page_preview_pages (book_id, page_id) VALUES (?, ?)')
      .run(firstBookId, foreign.id);
    db.pragma('foreign_keys = ON');

    expect(repository.findByBookId(firstBookId).selected_page_ids).toEqual([]);
  });

  it('removes a selection after a cross-Book move and never resurrects it', () => {
    const firstBookId = createBook('First');
    const secondBookId = createBook('Second');
    const page = createPage(firstBookId);
    repository.replace(firstBookId, {
      mode: 'selected', randomCount: 5, selectedPageIds: [page.id],
    });

    noteRepository.moveToContainer(page.id, { bookId: secondBookId });
    expect(repository.findByBookId(firstBookId).selected_page_ids).toEqual([]);
    noteRepository.moveToContainer(page.id, { bookId: firstBookId });
    expect(repository.findByBookId(firstBookId).selected_page_ids).toEqual([]);
  });

  it('retains a selection through Chapter/direct moves within the same Book', () => {
    const bookId = createBook('Book');
    const chapterId = createChapter(bookId, 'Chapter');
    const page = createPage(bookId);
    repository.replace(bookId, {
      mode: 'selected', randomCount: 5, selectedPageIds: [page.id],
    });

    noteRepository.moveToContainer(page.id, { bookId, chapterId });
    expect(repository.findByBookId(bookId).selected_page_ids).toEqual([page.id]);
    noteRepository.moveToContainer(page.id, { bookId, chapterId: null });
    expect(repository.findByBookId(bookId).selected_page_ids).toEqual([page.id]);
  });

  it('rolls back settings and selections when a later insert fails', () => {
    const bookId = createBook('Book');
    const first = createPage(bookId, null, 'First');
    const second = createPage(bookId, null, 'Second');
    repository.replace(bookId, {
      mode: 'selected', randomCount: 5, selectedPageIds: [first.id],
    });
    const before = repository.findByBookId(bookId);
    db.exec(`
      CREATE TRIGGER fail_second_preview_selection
      BEFORE INSERT ON book_page_preview_pages
      WHEN NEW.page_id = ${second.id}
      BEGIN
        SELECT RAISE(ABORT, 'forced preview selection failure');
      END
    `);

    expect(() => repository.replace(bookId, {
      mode: 'random', randomCount: 25, selectedPageIds: [second.id],
    })).toThrow(/forced preview selection failure/);
    expect(repository.findByBookId(bookId)).toEqual(before);
  });
});
