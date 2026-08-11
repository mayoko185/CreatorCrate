import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { BookError, createBookRepository } from '../src/data/book-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('book repository', () => {
  let tmpDir;
  let db;
  let repository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-books-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    repository = createBookRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('list', () => {
    it('returns an empty array when no Books exist', () => {
      expect(repository.list()).toEqual([]);
    });

    it('orders by sort_order then id', () => {
      const insert = db.prepare('INSERT INTO books (title, sort_order) VALUES (?, ?)');
      const secondAtTwo = Number(insert.run('Second at two', 2).lastInsertRowid);
      const firstAtOne = Number(insert.run('First at one', 1).lastInsertRowid);
      const secondAtOne = Number(insert.run('Second at one', 1).lastInsertRowid);

      expect(repository.list().map((book) => book.id)).toEqual([
        firstAtOne,
        secondAtOne,
        secondAtTwo,
      ]);
    });
  });

  describe('create', () => {
    it('starts at zero and appends after the current maximum', () => {
      const first = repository.create({ title: 'First' });
      const second = repository.create({ title: 'Second' });
      db.prepare('DELETE FROM books WHERE id = ?').run(second.id);
      const third = repository.create({ title: 'Third' });

      expect(first.sort_order).toBe(0);
      expect(third.sort_order).toBe(1);
      expect(repository.list().map((book) => [book.title, book.sort_order])).toEqual([
        ['First', 0],
        ['Third', 1],
      ]);
    });
  });

  describe('find and update', () => {
    it('finds and renames a Book', () => {
      const created = repository.create({ title: 'Before' });
      const found = repository.findById(created.id);
      const updated = repository.update(created.id, { title: 'After' });

      expect(found).toMatchObject({ id: created.id, title: 'Before' });
      expect(updated).toMatchObject({ id: created.id, title: 'After', sort_order: 0 });
    });

    it('returns undefined for missing Books', () => {
      expect(repository.findById(999999)).toBeUndefined();
      expect(repository.update(999999, { title: 'Missing' })).toBeUndefined();
    });
  });

  describe('reorder', () => {
    it('accepts an exact permutation and writes contiguous positions', () => {
      const first = repository.create({ title: 'First' });
      const second = repository.create({ title: 'Second' });
      const third = repository.create({ title: 'Third' });

      const reordered = repository.reorder([third.id, first.id, second.id]);

      expect(reordered.map((book) => book.id)).toEqual([third.id, first.id, second.id]);
      expect(reordered.map((book) => book.sort_order)).toEqual([0, 1, 2]);
    });

    it('rejects duplicate, missing, and extra IDs without changing the order', () => {
      const first = repository.create({ title: 'First' });
      const second = repository.create({ title: 'Second' });
      const before = repository.list();

      for (const ids of [[first.id, first.id], [first.id], [first.id, 999999]]) {
        expect(() => repository.reorder(ids)).toThrow(BookError);
        expect(repository.list()).toEqual(before);
      }
    });

    it('rolls back a failed final update', () => {
      const first = repository.create({ title: 'First' });
      const second = repository.create({ title: 'Second' });
      const third = repository.create({ title: 'Third' });
      const before = repository.list();
      db.exec(`
        CREATE TRIGGER fail_book_reorder
        BEFORE UPDATE OF sort_order ON books
        WHEN OLD.sort_order >= 5 AND NEW.sort_order = 0
        BEGIN
          SELECT RAISE(ABORT, 'forced Book reorder failure');
        END
      `);

      expect(() => repository.reorder([third.id, second.id, first.id]))
        .toThrow(/forced Book reorder failure/);
      expect(repository.list()).toEqual(before);
    });
  });

  describe('deleteAndCompact', () => {
    it('deletes an empty Book and returns false for a missing Book', () => {
      const book = repository.create({ title: 'Empty' });

      expect(repository.deleteAndCompact(book.id)).toBe(true);
      expect(repository.findById(book.id)).toBeUndefined();
      expect(repository.deleteAndCompact(999999)).toBe(false);
    });

    it('rejects a non-empty Book', () => {
      const book = repository.create({ title: 'Has chapter' });
      db.prepare('INSERT INTO chapters (book_id, title, sort_order) VALUES (?, ?, ?)')
        .run(book.id, 'Chapter', 0);

      expect(() => repository.deleteAndCompact(book.id)).toThrow(BookError);
      expect(() => repository.deleteAndCompact(book.id)).toThrow(/contains chapters/);
      expect(repository.findById(book.id)).toBeDefined();
    });

    it('compacts surviving Books after deletion', () => {
      const first = repository.create({ title: 'First' });
      const second = repository.create({ title: 'Second' });
      const third = repository.create({ title: 'Third' });

      expect(repository.deleteAndCompact(second.id)).toBe(true);
      expect(repository.list().map((book) => [book.id, book.sort_order])).toEqual([
        [first.id, 0],
        [third.id, 1],
      ]);
    });
  });
});
