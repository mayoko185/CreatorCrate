import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createBookRepository } from '../src/data/book-repository.js';
import { ChapterError, createChapterRepository } from '../src/data/chapter-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('chapter repository', () => {
  let tmpDir;
  let db;
  let bookRepository;
  let repository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-chapters-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    bookRepository = createBookRepository(db);
    repository = createChapterRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('list', () => {
    it('returns only one Book\'s Chapters ordered by sort_order then id', () => {
      const firstBook = bookRepository.create({ title: 'First Book' });
      const otherBook = bookRepository.create({ title: 'Other Book' });
      const insert = db.prepare('INSERT INTO chapters (book_id, title, sort_order) VALUES (?, ?, ?)');
      const secondAtOne = Number(insert.run(firstBook.id, 'Second at one', 1).lastInsertRowid);
      const firstAtOne = Number(insert.run(firstBook.id, 'First at one', 1).lastInsertRowid);
      insert.run(otherBook.id, 'Other Book Chapter', 0);

      expect(repository.listForBook(firstBook.id).map((chapter) => chapter.id)).toEqual([
        secondAtOne,
        firstAtOne,
      ]);
      expect(repository.listForBook(otherBook.id).map((chapter) => chapter.title))
        .toEqual(['Other Book Chapter']);
    });
  });

  describe('create', () => {
    it('appends independently within each Book', () => {
      const firstBook = bookRepository.create({ title: 'First Book' });
      const secondBook = bookRepository.create({ title: 'Second Book' });
      const first = repository.create({ bookId: firstBook.id, title: 'First' });
      const second = repository.create({ bookId: firstBook.id, title: 'Second' });
      const other = repository.create({ bookId: secondBook.id, title: 'Other' });

      expect([first.sort_order, second.sort_order, other.sort_order]).toEqual([0, 1, 0]);
    });
  });

  describe('find and update', () => {
    it('finds and renames a Chapter without moving it', () => {
      const book = bookRepository.create({ title: 'Book' });
      const created = repository.create({ bookId: book.id, title: 'Before' });
      const found = repository.findById(created.id);
      const updated = repository.update(created.id, { title: 'After' });

      expect(found).toMatchObject({
        id: created.id,
        book_id: book.id,
        title: 'Before',
      });
      expect(updated).toMatchObject({ id: created.id, book_id: book.id, title: 'After' });
    });

    it('returns undefined for missing Chapters', () => {
      expect(repository.findById(999999)).toBeUndefined();
      expect(repository.update(999999, { title: 'Missing' })).toBeUndefined();
    });
  });

  describe('reorder', () => {
    it('reorders one Book contiguously without changing another Book', () => {
      const firstBook = bookRepository.create({ title: 'First Book' });
      const secondBook = bookRepository.create({ title: 'Second Book' });
      const first = repository.create({ bookId: firstBook.id, title: 'First' });
      const second = repository.create({ bookId: firstBook.id, title: 'Second' });
      const third = repository.create({ bookId: firstBook.id, title: 'Third' });
      const other = repository.create({ bookId: secondBook.id, title: 'Other' });

      const reordered = repository.reorder(firstBook.id, [third.id, first.id, second.id]);

      expect(reordered.map((chapter) => chapter.id)).toEqual([third.id, first.id, second.id]);
      expect(reordered.map((chapter) => chapter.sort_order)).toEqual([0, 1, 2]);
      expect(repository.listForBook(secondBook.id)).toEqual([other]);
    });

    it('rejects cross-Book, duplicate, missing, and extra IDs without changing either Book', () => {
      const firstBook = bookRepository.create({ title: 'First Book' });
      const secondBook = bookRepository.create({ title: 'Second Book' });
      const first = repository.create({ bookId: firstBook.id, title: 'First' });
      const second = repository.create({ bookId: firstBook.id, title: 'Second' });
      const other = repository.create({ bookId: secondBook.id, title: 'Other' });
      const beforeFirstBook = repository.listForBook(firstBook.id);
      const beforeSecondBook = repository.listForBook(secondBook.id);

      for (const ids of [[first.id, other.id], [first.id, first.id], [first.id], [first.id, 999999]]) {
        expect(() => repository.reorder(firstBook.id, ids)).toThrow(ChapterError);
        expect(repository.listForBook(firstBook.id)).toEqual(beforeFirstBook);
        expect(repository.listForBook(secondBook.id)).toEqual(beforeSecondBook);
      }
    });

    it('rolls back a failed final scoped update', () => {
      const book = bookRepository.create({ title: 'Book' });
      const first = repository.create({ bookId: book.id, title: 'First' });
      const second = repository.create({ bookId: book.id, title: 'Second' });
      const third = repository.create({ bookId: book.id, title: 'Third' });
      const before = repository.listForBook(book.id);
      db.exec(`
        CREATE TRIGGER fail_chapter_reorder
        BEFORE UPDATE OF sort_order ON chapters
        WHEN OLD.sort_order >= 5 AND NEW.sort_order = 0
        BEGIN
          SELECT RAISE(ABORT, 'forced Chapter reorder failure');
        END
      `);

      expect(() => repository.reorder(book.id, [third.id, second.id, first.id]))
        .toThrow(/forced Chapter reorder failure/);
      expect(repository.listForBook(book.id)).toEqual(before);
    });
  });

  describe('deleteAndCompact', () => {
    it('deletes an empty Chapter and returns false for a missing Chapter', () => {
      const book = bookRepository.create({ title: 'Book' });
      const chapter = repository.create({ bookId: book.id, title: 'Empty' });

      expect(repository.deleteAndCompact(chapter.id)).toBe(true);
      expect(repository.findById(chapter.id)).toBeUndefined();
      expect(repository.deleteAndCompact(999999)).toBe(false);
    });

    it('rejects a Chapter containing Notes', () => {
      const book = bookRepository.create({ title: 'Book' });
      const chapter = repository.create({ bookId: book.id, title: 'Has Notes' });
      db.prepare(`
        INSERT INTO notes (chapter_id, title, content, sort_order)
        VALUES (?, 'Note', '', 0)
      `).run(chapter.id);

      expect(() => repository.deleteAndCompact(chapter.id)).toThrow(ChapterError);
      expect(() => repository.deleteAndCompact(chapter.id)).toThrow(/contains Notes/);
      expect(repository.findById(chapter.id)).toBeDefined();
    });

    it('compacts only the deleted Chapter\'s Book', () => {
      const firstBook = bookRepository.create({ title: 'First Book' });
      const secondBook = bookRepository.create({ title: 'Second Book' });
      const first = repository.create({ bookId: firstBook.id, title: 'First' });
      const second = repository.create({ bookId: firstBook.id, title: 'Second' });
      const third = repository.create({ bookId: firstBook.id, title: 'Third' });
      const other = repository.create({ bookId: secondBook.id, title: 'Other' });

      expect(repository.deleteAndCompact(second.id)).toBe(true);
      expect(repository.listForBook(firstBook.id).map((chapter) => [chapter.id, chapter.sort_order]))
        .toEqual([[first.id, 0], [third.id, 1]]);
      expect(repository.listForBook(secondBook.id)).toEqual([other]);
    });
  });
});
