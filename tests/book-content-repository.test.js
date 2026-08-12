import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import {
  BookContentError,
  createBookContentRepository,
} from '../src/data/book-content-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('Book-content repository', () => {
  let tmpDir;
  let db;
  let repository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-content-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    repository = createBookContentRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  describe('listForBook', () => {
    it('returns an empty array for an empty Book', () => {
      const bookId = insertBook('Empty Book');

      expect(repository.listForBook(bookId)).toEqual([]);
    });

    it('returns rows ordered by sort_order', () => {
      const bookId = insertBook('Ordered Book');
      insertContent(bookId, 'page', 8, 2);
      insertContent(bookId, 'chapter', 3, 0);
      insertContent(bookId, 'page', 5, 1);

      expect(repository.listForBook(bookId).map((row) => [row.item_type, row.item_id]))
        .toEqual([['chapter', 3], ['page', 5], ['page', 8]]);
    });

    it('excludes rows belonging to another Book', () => {
      const bookId = insertBook('First Book');
      const otherBookId = insertBook('Other Book');
      insertContent(bookId, 'chapter', 1, 0);
      insertContent(otherBookId, 'page', 1, 0);

      expect(repository.listForBook(bookId)).toEqual([
        { book_id: bookId, item_type: 'chapter', item_id: 1, sort_order: 0 },
      ]);
    });

    it('rejects an invalid Book ID', () => {
      expect(() => repository.listForBook(0)).toThrow(BookContentError);
    });
  });

  describe('append', () => {
    it('appends to an empty Book at position zero', () => {
      const bookId = insertBook('Book');

      expect(repository.append(bookId, 'chapter', 3)).toEqual({
        book_id: bookId,
        item_type: 'chapter',
        item_id: 3,
        sort_order: 0,
      });
    });

    it('appends several typed items contiguously', () => {
      const bookId = insertBook('Book');

      repository.append(bookId, 'chapter', 3);
      repository.append(bookId, 'page', 8);
      repository.append(bookId, 'chapter', 5);

      expect(repository.listForBook(bookId).map((row) => row.sort_order)).toEqual([0, 1, 2]);
    });

    it('allows equal numeric IDs for different item types', () => {
      const bookId = insertBook('Book');

      repository.append(bookId, 'chapter', 7);
      repository.append(bookId, 'page', 7);

      expect(repository.listForBook(bookId).map((row) => [row.item_type, row.item_id]))
        .toEqual([['chapter', 7], ['page', 7]]);
    });

    it('rejects an invalid item type', () => {
      const bookId = insertBook('Book');

      expect(() => repository.append(bookId, 'note', 1)).toThrow(BookContentError);
    });

    it('rejects invalid Book and item IDs', () => {
      const bookId = insertBook('Book');

      for (const invalidBookId of [0, -1, 1.5, '1']) {
        expect(() => repository.append(invalidBookId, 'chapter', 1)).toThrow(BookContentError);
      }
      for (const invalidItemId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
        expect(() => repository.append(bookId, 'chapter', invalidItemId)).toThrow(BookContentError);
      }
    });

    it('rejects a duplicate typed membership without changing the sequence', () => {
      const bookId = insertBook('Book');
      repository.append(bookId, 'chapter', 1);

      expect(() => repository.append(bookId, 'chapter', 1)).toThrow(BookContentError);
      expect(repository.listForBook(bookId).map((row) => row.sort_order)).toEqual([0]);
    });
  });

  describe('remove', () => {
    it('removes the first item and compacts the remainder', () => {
      const bookId = insertBook('Book');
      seed(bookId, [
        ['chapter', 1],
        ['page', 2],
        ['chapter', 3],
      ]);
      const before = repository.listForBook(bookId);

      expect(repository.remove(bookId, before[0].item_type, before[0].item_id)).toBe(true);
      expect(repository.listForBook(bookId).map((row) => [row.item_id, row.sort_order]))
        .toEqual([[2, 0], [3, 1]]);
    });

    it('removes a middle item and compacts the remainder', () => {
      const bookId = insertBook('Book');
      seed(bookId, [['chapter', 1], ['page', 2], ['chapter', 3]]);
      const middle = repository.listForBook(bookId)[1];

      repository.remove(bookId, middle.item_type, middle.item_id);

      expect(repository.listForBook(bookId).map((row) => [row.item_id, row.sort_order]))
        .toEqual([[1, 0], [3, 1]]);
    });

    it('removes the last item and compacts the remainder', () => {
      const bookId = insertBook('Book');
      seed(bookId, [['chapter', 1], ['page', 2], ['chapter', 3]]);
      const last = repository.listForBook(bookId)[2];

      repository.remove(bookId, last.item_type, last.item_id);

      expect(repository.listForBook(bookId).map((row) => [row.item_id, row.sort_order]))
        .toEqual([[1, 0], [2, 1]]);
    });

    it('only affects the target Book and is a no-op for missing membership', () => {
      const bookId = insertBook('First Book');
      const otherBookId = insertBook('Other Book');
      seed(bookId, [['chapter', 1], ['page', 2]]);
      seed(otherBookId, [['page', 8], ['chapter', 9]]);
      const otherBefore = repository.listForBook(otherBookId);

      expect(repository.remove(bookId, 'chapter', 999)).toBe(false);
      expect(repository.remove(bookId, 'chapter', 1)).toBe(true);
      expect(repository.listForBook(otherBookId)).toEqual(otherBefore);
      expect(repository.listForBook(bookId).map((row) => [row.item_id, row.sort_order]))
        .toEqual([[2, 0]]);
    });

    it('rejects invalid removal inputs', () => {
      const bookId = insertBook('Book');

      expect(() => repository.remove(bookId, 'note', 1)).toThrow(BookContentError);
      expect(() => repository.remove(bookId, 'chapter', 0)).toThrow(BookContentError);
    });
  });

  describe('compact', () => {
    it('rewrites only one Book to contiguous positions', () => {
      const bookId = insertBook('First Book');
      const otherBookId = insertBook('Other Book');
      insertContent(bookId, 'chapter', 1, 3);
      insertContent(bookId, 'page', 2, 8);
      insertContent(otherBookId, 'page', 9, 4);

      const compacted = repository.compact(bookId);

      expect(compacted.map((row) => [row.item_id, row.sort_order]))
        .toEqual([[1, 0], [2, 1]]);
      expect(repository.listForBook(otherBookId)).toEqual([
        { book_id: otherBookId, item_type: 'page', item_id: 9, sort_order: 4 },
      ]);
    });
  });

  describe('reorder', () => {
    it('reorders a mixed Chapter/Page sequence', () => {
      const bookId = insertBook('Book');
      seed(bookId, [['chapter', 3], ['page', 8], ['chapter', 5]]);

      const reordered = repository.reorder(bookId, [
        { type: 'page', id: 8 },
        { type: 'chapter', id: 5 },
        { type: 'chapter', id: 3 },
      ]);

      expect(reordered.map((row) => [row.item_type, row.item_id])).toEqual([
        ['page', 8],
        ['chapter', 5],
        ['chapter', 3],
      ]);
    });

    it('writes contiguous positions after reorder', () => {
      const bookId = insertBook('Book');
      seed(bookId, [['chapter', 1], ['page', 2], ['chapter', 3], ['page', 4]]);

      repository.reorder(bookId, [
        { type: 'page', id: 4 },
        { type: 'chapter', id: 1 },
        { type: 'page', id: 2 },
        { type: 'chapter', id: 3 },
      ]);

      expect(repository.listForBook(bookId).map((row) => row.sort_order)).toEqual([0, 1, 2, 3]);
    });

    it('preserves same numeric IDs as distinct typed items', () => {
      const bookId = insertBook('Book');
      seed(bookId, [['chapter', 7], ['page', 7]]);

      const reordered = repository.reorder(bookId, [
        { type: 'page', id: 7 },
        { type: 'chapter', id: 7 },
      ]);

      expect(reordered.map((row) => [row.item_type, row.item_id, row.sort_order])).toEqual([
        ['page', 7, 0],
        ['chapter', 7, 1],
      ]);
    });

    it('rejects a duplicate typed item', () => {
      const bookId = insertBook('Book');
      seed(bookId, [['chapter', 1], ['page', 1]]);
      const before = repository.listForBook(bookId);

      expect(() => repository.reorder(bookId, [
        { type: 'chapter', id: 1 },
        { type: 'chapter', id: 1 },
      ])).toThrow(BookContentError);
      expect(repository.listForBook(bookId)).toEqual(before);
    });

    it('rejects an omitted item', () => {
      const bookId = insertBook('Book');
      seed(bookId, [['chapter', 1], ['page', 2], ['chapter', 3]]);

      expect(() => repository.reorder(bookId, [
        { type: 'chapter', id: 1 },
        { type: 'page', id: 2 },
      ])).toThrow(BookContentError);
    });

    it('rejects an extra item', () => {
      const bookId = insertBook('Book');
      seed(bookId, [['chapter', 1], ['page', 2]]);

      expect(() => repository.reorder(bookId, [
        { type: 'chapter', id: 1 },
        { type: 'page', id: 2 },
        { type: 'chapter', id: 3 },
      ])).toThrow(BookContentError);
    });

    it('rejects an unknown typed membership', () => {
      const bookId = insertBook('Book');
      seed(bookId, [['chapter', 1], ['page', 2]]);

      expect(() => repository.reorder(bookId, [
        { type: 'page', id: 1 },
        { type: 'page', id: 2 },
      ])).toThrow(BookContentError);
    });

    it('rejects malformed entries', () => {
      const bookId = insertBook('Book');
      seed(bookId, [['chapter', 1]]);

      for (const orderedItems of [
        null,
        [{ type: 'chapter' }],
        [{ id: 1 }],
        [null],
        [['chapter', 1]],
      ]) {
        expect(() => repository.reorder(bookId, orderedItems)).toThrow(BookContentError);
      }
    });

    it('rejects an item belonging to another Book', () => {
      const bookId = insertBook('First Book');
      const otherBookId = insertBook('Other Book');
      seed(bookId, [['chapter', 1], ['page', 2]]);
      seed(otherBookId, [['page', 8], ['chapter', 9]]);
      const before = repository.listForBook(bookId);
      const otherBefore = repository.listForBook(otherBookId);

      expect(() => repository.reorder(bookId, [
        { type: 'page', id: 8 },
        { type: 'page', id: 2 },
      ])).toThrow(BookContentError);
      expect(repository.listForBook(bookId)).toEqual(before);
      expect(repository.listForBook(otherBookId)).toEqual(otherBefore);
    });

    it('rejects invalid item IDs, types, and Book IDs', () => {
      const bookId = insertBook('Book');
      seed(bookId, [['chapter', 1]]);

      expect(() => repository.reorder(0, [{ type: 'chapter', id: 1 }]))
        .toThrow(BookContentError);
      expect(() => repository.reorder(bookId, [{ type: 'note', id: 1 }]))
        .toThrow(BookContentError);
      expect(() => repository.reorder(bookId, [{ type: 'chapter', id: 0 }]))
        .toThrow(BookContentError);
    });

    it('rolls back a failed reorder without changing the previous order', () => {
      const bookId = insertBook('Book');
      seed(bookId, [['chapter', 1], ['page', 2], ['chapter', 3]]);
      const before = repository.listForBook(bookId);
      db.exec(`
        CREATE TRIGGER fail_book_content_reorder
        BEFORE UPDATE OF sort_order ON book_contents
        WHEN OLD.sort_order >= 6 AND NEW.sort_order = 0
        BEGIN
          SELECT RAISE(ABORT, 'forced Book-content reorder failure');
        END
      `);

      expect(() => repository.reorder(bookId, [
        { type: 'chapter', id: 3 },
        { type: 'page', id: 2 },
        { type: 'chapter', id: 1 },
      ])).toThrow(/forced Book-content reorder failure/);
      expect(repository.listForBook(bookId)).toEqual(before);
    });

    it('rolls back a failed remove and compact without partial changes', () => {
      const bookId = insertBook('Book');
      seed(bookId, [['chapter', 1], ['page', 2], ['chapter', 3]]);
      const before = repository.listForBook(bookId);
      db.exec(`
        CREATE TRIGGER fail_book_content_compact
        BEFORE UPDATE OF sort_order ON book_contents
        WHEN OLD.sort_order >= 5 AND NEW.sort_order = 0
        BEGIN
          SELECT RAISE(ABORT, 'forced Book-content compact failure');
        END
      `);

      expect(() => repository.remove(bookId, 'chapter', 1))
        .toThrow(/forced Book-content compact failure/);
      expect(repository.listForBook(bookId)).toEqual(before);
    });

    it('rolls back a failed public compact without partial changes', () => {
      const bookId = insertBook('Book');
      seed(bookId, [['chapter', 1], ['page', 2], ['chapter', 3]]);
      const before = repository.listForBook(bookId);
      db.exec(`
        CREATE TRIGGER fail_book_content_public_compact
        BEFORE UPDATE OF sort_order ON book_contents
        WHEN OLD.sort_order >= 6 AND NEW.sort_order = 0
        BEGIN
          SELECT RAISE(ABORT, 'forced public compact failure');
        END
      `);

      expect(() => repository.compact(bookId)).toThrow(/forced public compact failure/);
      expect(repository.listForBook(bookId)).toEqual(before);
    });

    it('never violates the unique Book position constraint during a valid reorder', () => {
      const bookId = insertBook('Book');
      seed(bookId, [['chapter', 1], ['page', 2], ['chapter', 3], ['page', 4]]);

      expect(() => repository.reorder(bookId, [
        { type: 'page', id: 4 },
        { type: 'chapter', id: 3 },
        { type: 'page', id: 2 },
        { type: 'chapter', id: 1 },
      ])).not.toThrow();
      expect(db.prepare(`
        SELECT COUNT(*) AS total, COUNT(DISTINCT sort_order) AS distinct_positions
        FROM book_contents
        WHERE book_id = ?
      `).get(bookId)).toEqual({ total: 4, distinct_positions: 4 });
    });
  });

  it('matches direct book_contents SQL rows exactly', () => {
    const bookId = insertBook('Book');
    insertContent(bookId, 'page', 8, 1);
    insertContent(bookId, 'chapter', 3, 0);

    const directRows = db.prepare(`
      SELECT book_id, item_type, item_id, sort_order
      FROM book_contents
      WHERE book_id = ?
      ORDER BY sort_order ASC
    `).all(bookId);

    expect(repository.listForBook(bookId)).toEqual(directRows);
  });

  function insertBook(title) {
    const maxOrder = db.prepare('SELECT MAX(sort_order) AS max_order FROM books').get().max_order;
    const sortOrder = maxOrder === null ? 0 : maxOrder + 1;
    return Number(db.prepare('INSERT INTO books (title, sort_order) VALUES (?, ?)')
      .run(title, sortOrder).lastInsertRowid);
  }

  function insertContent(bookId, itemType, itemId, sortOrder) {
    db.prepare(`
      INSERT INTO book_contents (book_id, item_type, item_id, sort_order)
      VALUES (?, ?, ?, ?)
    `).run(bookId, itemType, itemId, sortOrder);
  }

  function seed(bookId, items) {
    for (const [itemType, itemId] of items) {
      repository.append(bookId, itemType, itemId);
    }
  }
});
