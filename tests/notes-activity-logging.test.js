import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createApplicationLogRepository } from '../src/data/application-log-repository.js';
import { createBookRepository } from '../src/data/book-repository.js';
import { createBookContentRepository } from '../src/data/book-content-repository.js';
import { createChapterRepository } from '../src/data/chapter-repository.js';
import { createNoteRepository } from '../src/data/note-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createApplicationLogger } from '../src/services/application-logger.js';
import { createBookService } from '../src/services/book-service.js';
import { createChapterService } from '../src/services/chapter-service.js';
import { createNoteService } from '../src/services/note-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('Notes hierarchy activity logging', () => {
  let tmpDir;
  let db;
  let bookRepository;
  let bookContentRepository;
  let chapterRepository;
  let noteRepository;
  let projectRepository;
  let assetRepository;
  let applicationLogRepository;
  let bookService;
  let chapterService;
  let noteService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-notes-activity-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    bookRepository = createBookRepository(db);
    bookContentRepository = createBookContentRepository(db);
    chapterRepository = createChapterRepository(db);
    noteRepository = createNoteRepository(db);
    projectRepository = createProjectRepository(db);
    assetRepository = createAssetRepository(db);
    applicationLogRepository = createApplicationLogRepository(db);
    const applicationLogger = createApplicationLogger({
      repository: applicationLogRepository,
      console: { error: vi.fn() },
      now: () => 1,
    });
    bookService = createBookService({
      bookRepository,
      bookContentRepository,
      chapterRepository,
      noteRepository,
      applicationLogger,
    });
    chapterService = createChapterService({
      db,
      chapterRepository,
      bookRepository,
      bookContentRepository,
      applicationLogger,
    });
    noteService = createNoteService({
      db,
      noteRepository,
      projectRepository,
      assetRepository,
      chapterRepository,
      bookRepository,
      bookContentRepository,
      applicationLogger,
    });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function records(event) {
    return applicationLogRepository.findPage({ kind: 'activity' })
      .filter((record) => !event || record.event === event);
  }

  it('records committed Book, chapter, and Note mutations once with safe identifiers only', () => {
    const book = bookService.createBook({ title: 'Book title must not be logged' });
    const otherBook = bookService.createBook({ title: 'Other book' });
    bookService.updateBook(book.id, { title: '  Renamed book  ' });
    bookService.updateBook(book.id, { title: 'Renamed book' });
    bookService.reorderBooks([otherBook.id, book.id]);
    bookService.reorderBooks([otherBook.id, book.id]);

    const chapter = chapterService.createChapter({ bookId: book.id, title: 'Chapter title must not be logged' });
    const otherChapter = chapterService.createChapter({ bookId: book.id, title: 'Other chapter' });
    chapterService.updateChapter(chapter.id, { title: '  Renamed chapter  ' });
    chapterService.updateChapter(chapter.id, { title: 'Renamed chapter' });
    chapterService.reorderChapters(book.id, [otherChapter.id, chapter.id]);
    chapterService.reorderChapters(book.id, [otherChapter.id, chapter.id]);

    const directPage = noteService.createNote({
      bookId: book.id,
      title: 'Direct title must not be logged',
      content: 'Direct content must not be logged',
    });
    const contents = bookContentRepository.listForBook(book.id)
      .map(({ item_type: type, item_id: id }) => ({ type, id }))
      .reverse();
    bookService.reorderBookContents(book.id, contents);
    bookService.reorderBookContents(book.id, contents);

    const note = noteService.createNote({
      chapterId: chapter.id,
      title: 'Note title must not be logged',
      content: 'Note content must not be logged',
    });
    noteService.updateNote(note.id, { title: '  Updated note  ', content: 'Updated body' });
    noteService.updateNote(note.id, { title: 'Updated note', content: 'Updated body' });
    noteService.moveNoteToChapter(note.id, otherChapter.id);
    noteService.moveNoteToChapter(note.id, otherChapter.id);
    const secondNote = noteService.createNote({ chapterId: otherChapter.id, title: 'Second', content: '' });
    noteService.reorderNotes(otherChapter.id, [secondNote.id, note.id]);
    noteService.reorderNotes(otherChapter.id, [secondNote.id, note.id]);

    const secondDirectPage = noteService.createNote({ bookId: book.id, title: 'Second direct', content: '' });
    noteService.reorderBookPages(book.id, [secondDirectPage.id, directPage.id]);
    noteService.reorderBookPages(book.id, [secondDirectPage.id, directPage.id]);

    const deletedNote = noteService.createNote({ chapterId: otherChapter.id, title: 'Delete note', content: '' });
    noteService.deleteNote(deletedNote.id);
    const deletedChapter = chapterService.createChapter({ bookId: book.id, title: 'Delete chapter' });
    chapterService.deleteChapter(deletedChapter.id);
    const deletedBook = bookService.createBook({ title: 'Delete book' });
    bookService.deleteBook(deletedBook.id);

    expect(records().map((record) => record.event)).toEqual(expect.arrayContaining([
      'book.created', 'book.updated', 'book.reordered', 'book.content.reordered', 'book.deleted',
      'chapter.created', 'chapter.updated', 'chapter.reordered', 'chapter.deleted',
      'note.created', 'note.updated', 'note.moved', 'note.reordered', 'note.deleted',
    ]));
    expect(records('book.updated')).toHaveLength(1);
    expect(records('book.reordered')).toHaveLength(1);
    expect(records('book.content.reordered')).toHaveLength(1);
    expect(records('chapter.updated')).toHaveLength(1);
    expect(records('chapter.reordered')).toHaveLength(1);
    expect(records('note.updated')).toHaveLength(1);
    expect(records('note.moved')).toHaveLength(1);
    expect(records('note.reordered')).toHaveLength(2);

    const bookCreatedRecord = records('book.created')
      .find((record) => record.context_json.includes(`\"bookId\":${book.id}`));
    expect(bookCreatedRecord).toMatchObject({ level: 'info', kind: 'activity', subsystem: 'notes' });
    expect(JSON.parse(bookCreatedRecord.context_json)).toEqual({ bookId: book.id });
    const chapterCreatedRecord = records('chapter.created')
      .find((record) => record.context_json.includes(`\"chapterId\":${chapter.id}`));
    expect(JSON.parse(chapterCreatedRecord.context_json)).toEqual({
      bookId: book.id,
      chapterId: chapter.id,
    });
    expect(JSON.parse(records('note.created').find((record) => record.context_json.includes(`\"noteId\":${note.id}`)).context_json)).toEqual({
      bookId: book.id,
      chapterId: chapter.id,
      noteId: note.id,
    });
    expect(JSON.parse(records('note.moved')[0].context_json)).toEqual({
      bookId: book.id,
      chapterId: chapter.id,
      noteId: note.id,
      destinationBookId: book.id,
      destinationChapterId: otherChapter.id,
    });

    const persistedActivity = records().map((record) => `${record.message}${record.context_json}`).join('\n');
    expect(persistedActivity).not.toContain('must not be logged');
    expect(persistedActivity).not.toContain('Updated body');
  });

  it('does not emit success events for failures and isolates a failing logger', () => {
    expect(() => bookService.deleteBook(999999)).toThrow();
    expect(() => chapterService.deleteChapter(999999)).toThrow();
    expect(() => noteService.deleteNote(999999)).toThrow();
    expect(records()).toEqual([]);

    const failingLogger = { info: vi.fn(() => { throw new Error('log persistence unavailable'); }) };
    const isolatedBookService = createBookService({
      bookRepository,
      bookContentRepository,
      chapterRepository,
      noteRepository,
      applicationLogger: failingLogger,
    });
    const isolatedChapterService = createChapterService({
      db,
      chapterRepository,
      bookRepository,
      bookContentRepository,
      applicationLogger: failingLogger,
    });
    const isolatedNoteService = createNoteService({
      db,
      noteRepository,
      projectRepository,
      assetRepository,
      chapterRepository,
      bookRepository,
      bookContentRepository,
      applicationLogger: failingLogger,
    });

    const book = isolatedBookService.createBook({ title: 'Logger isolation' });
    const chapter = isolatedChapterService.createChapter({ bookId: book.id, title: 'Logger isolation' });
    const note = isolatedNoteService.createNote({ chapterId: chapter.id, title: 'Logger isolation', content: '' });

    expect(note.id).toBeTypeOf('number');
    expect(failingLogger.info).toHaveBeenCalledTimes(3);
  });

  it('derives hierarchy activity outcomes without logging-only snapshots', () => {
    const firstBook = bookService.createBook({ title: 'First' });
    const secondBook = bookService.createBook({ title: 'Second' });
    const firstChapter = chapterService.createChapter({ bookId: firstBook.id, title: 'First chapter' });
    const secondChapter = chapterService.createChapter({ bookId: firstBook.id, title: 'Second chapter' });
    const chapterNote = noteService.createNote({
      chapterId: firstChapter.id,
      title: 'Chapter note',
      content: '',
    });
    const directNote = noteService.createNote({
      bookId: firstBook.id,
      title: 'Direct note',
      content: '',
    });

    const snapshotFailingBookService = createBookService({
      bookRepository: { ...bookRepository, list: vi.fn(() => { throw new Error('retired book snapshot'); }) },
      bookContentRepository,
      chapterRepository,
      noteRepository,
      applicationLogger: createApplicationLogger({
        repository: applicationLogRepository,
        console: { error: vi.fn() },
        now: () => 2,
      }),
    });
    expect(snapshotFailingBookService.reorderBooks([secondBook.id, firstBook.id])
      .map((book) => book.id))
      .toEqual([secondBook.id, firstBook.id]);

    const snapshotFailingContentService = createBookService({
      bookRepository,
      bookContentRepository: {
        ...bookContentRepository,
        listForBook: vi.fn(() => { throw new Error('retired content snapshot'); }),
      },
      chapterRepository,
      noteRepository,
      applicationLogger: createApplicationLogger({
        repository: applicationLogRepository,
        console: { error: vi.fn() },
        now: () => 3,
      }),
    });
    const reversedContents = bookContentRepository.listForBook(firstBook.id)
      .map(({ item_type: type, item_id: id }) => ({ type, id }))
      .reverse();
    expect(snapshotFailingContentService.reorderBookContents(firstBook.id, reversedContents))
      .toHaveLength(reversedContents.length);

    const snapshotFailingChapterService = createChapterService({
      db,
      chapterRepository: {
        ...chapterRepository,
        listForBook: vi.fn(() => { throw new Error('retired chapter snapshot'); }),
      },
      bookRepository,
      bookContentRepository,
      applicationLogger: createApplicationLogger({
        repository: applicationLogRepository,
        console: { error: vi.fn() },
        now: () => 4,
      }),
    });
    expect(snapshotFailingChapterService.reorderChapters(firstBook.id, [secondChapter.id, firstChapter.id])
      .map((chapter) => chapter.id))
      .toEqual([secondChapter.id, firstChapter.id]);

    const snapshotFailingUpdateService = createNoteService({
      db,
      noteRepository: {
        ...noteRepository,
        listProjectsForNote: vi.fn(() => { throw new Error('retired project snapshot'); }),
        listAssetsForNote: vi.fn(() => { throw new Error('retired asset snapshot'); }),
      },
      projectRepository,
      assetRepository,
      chapterRepository,
      bookRepository,
      bookContentRepository,
      applicationLogger: createApplicationLogger({
        repository: applicationLogRepository,
        console: { error: vi.fn() },
        now: () => 5,
      }),
    });
    expect(snapshotFailingUpdateService.updateNote(chapterNote.id, { title: 'Updated chapter note' }).title)
      .toBe('Updated chapter note');

    let sourceLookupCount = 0;
    const snapshotFailingMoveService = createNoteService({
      db,
      noteRepository: {
        ...noteRepository,
        findById(id) {
          sourceLookupCount += 1;
          if (sourceLookupCount > 1) throw new Error('retired move snapshot');
          return noteRepository.findById(id);
        },
      },
      projectRepository,
      assetRepository,
      chapterRepository,
      bookRepository,
      bookContentRepository,
      applicationLogger: createApplicationLogger({
        repository: applicationLogRepository,
        console: { error: vi.fn() },
        now: () => 6,
      }),
    });
    expect(snapshotFailingMoveService.moveNoteToChapter(chapterNote.id, secondChapter.id).chapter_id)
      .toBe(secondChapter.id);
    expect(sourceLookupCount).toBe(1);

    const snapshotFailingReorderService = createNoteService({
      db,
      noteRepository: {
        ...noteRepository,
        listForChapter: vi.fn(() => { throw new Error('retired note snapshot'); }),
        listForBook: vi.fn(() => { throw new Error('retired direct-note snapshot'); }),
      },
      projectRepository,
      assetRepository,
      chapterRepository,
      bookRepository,
      bookContentRepository,
      applicationLogger: createApplicationLogger({
        repository: applicationLogRepository,
        console: { error: vi.fn() },
        now: () => 7,
      }),
    });
    const secondChapterNote = noteService.createNote({
      chapterId: secondChapter.id,
      title: 'Second chapter note',
      content: '',
    });
    expect(snapshotFailingReorderService.reorderNotes(secondChapter.id, [secondChapterNote.id, chapterNote.id]))
      .toHaveLength(2);
    const secondDirectNote = noteService.createNote({
      bookId: firstBook.id,
      title: 'Second direct note',
      content: '',
    });
    expect(snapshotFailingReorderService.reorderBookPages(firstBook.id, [secondDirectNote.id, directNote.id]))
      .toHaveLength(2);

    expect(records('book.reordered')).toHaveLength(1);
    expect(records('book.content.reordered')).toHaveLength(1);
    expect(records('chapter.reordered')).toHaveLength(1);
    expect(records('note.updated')).toHaveLength(1);
    expect(records('note.moved')).toHaveLength(1);
    expect(records('note.reordered')).toHaveLength(2);
    const persistedActivity = records().map((record) => record.context_json).join('\n');
    expect(persistedActivity).not.toContain('First chapter');
    expect(persistedActivity).not.toContain('Updated chapter note');
  });
});
