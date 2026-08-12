import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createNoteRepository, NoteError } from '../src/data/note-repository.js';
import { createBookRepository } from '../src/data/book-repository.js';
import { createBookContentRepository } from '../src/data/book-content-repository.js';
import { createChapterRepository } from '../src/data/chapter-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import {
  createNoteService,
  NOTE_TITLE_MAX,
  NoteNotFoundError,
  NoteOperationError,
  NoteValidationError,
} from '../src/services/note-service.js';
import { BookNotFoundError } from '../src/services/book-service.js';
import { ChapterNotFoundError } from '../src/services/chapter-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MISSING_ID = 999999;

describe('note service', () => {
  let tmpDir;
  let db;
  let bookRepository;
  let bookContentRepository;
  let noteRepository;
  let chapterRepository;
  let projectRepository;
  let assetRepository;
  let service;
  let bookId;
  let chapterId;
  let nextProjectNumber;
  let nextAssetNumber;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-note-service-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    bookRepository = createBookRepository(db);
    bookContentRepository = createBookContentRepository(db);
    noteRepository = createNoteRepository(db);
    chapterRepository = createChapterRepository(db);
    projectRepository = createProjectRepository(db);
    assetRepository = createAssetRepository(db);
    bookId = Number(db.prepare(`
      INSERT INTO books (title, sort_order)
      VALUES ('Test book', 0)
    `).run().lastInsertRowid);
    chapterId = chapterRepository.create({ bookId, title: 'Test chapter' }).id;
    service = createNoteService({
      db,
      noteRepository,
      projectRepository,
      assetRepository,
      chapterRepository,
      bookRepository,
      bookContentRepository,
    });
    nextProjectNumber = 1;
    nextAssetNumber = 1;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createProject(title = `Project ${nextProjectNumber++}`) {
    const slug = `${title.toLowerCase().replaceAll(' ', '-')}-${nextProjectNumber}`;
    return Number(db.prepare(`
      INSERT INTO projects (
        title, slug, description, notes, status,
        planned_date, published_date, patreon_url
      ) VALUES (?, ?, '', '', 'tbd', NULL, NULL, NULL)
    `).run(title, slug).lastInsertRowid);
  }

  function createAsset(projectId, relativePath = `source/asset-${nextAssetNumber++}.png`) {
    const filename = relativePath.split('/').pop();
    return Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename)
      VALUES (?, ?, ?)
    `).run(projectId, relativePath, filename).lastInsertRowid);
  }

  function createNote(input) {
    return service.createNote({ chapterId, ...input });
  }

  function createDirectNote(input) {
    return service.createNote({ bookId, ...input });
  }

  function createBook(title = 'Other book') {
    return Number(db.prepare(`
      INSERT INTO books (title, sort_order)
      VALUES (?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM books))
    `).run(title).lastInsertRowid);
  }

  function createChapterForBook(targetBookId, title = 'Other chapter') {
    return chapterRepository.create({ bookId: targetBookId, title }).id;
  }

  it('requires note, project, asset, and chapter repository dependencies', () => {
    expect(() => createNoteService()).toThrow(
      'createNoteService requires a noteRepository dependency.'
    );
    expect(() => createNoteService({ noteRepository })).toThrow(
      'createNoteService requires a projectRepository dependency.'
    );
    expect(() => createNoteService({ noteRepository, projectRepository })).toThrow(
      'createNoteService requires an assetRepository dependency.'
    );
    expect(() => createNoteService({ noteRepository, projectRepository, assetRepository })).toThrow(
      'createNoteService requires a chapterRepository dependency.'
    );
  });

  it('requires bookId for a direct Book Page', () => {
    const error = (() => {
      try {
        service.createNote({ title: 'Missing Book container' });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(NoteValidationError);
    expect(error.errors).toEqual({ bookId: 'bookId must be a positive integer.' });
    expect(noteRepository.list()).toEqual([]);
  });

  it('creates a Page directly in a Book', () => {
    const append = vi.spyOn(bookContentRepository, 'append');
    const note = createDirectNote({
      title: 'Direct Page',
      content: 'Book-level content',
    });

    expect(note).toMatchObject({
      book_id: bookId,
      chapter_id: null,
      title: 'Direct Page',
      content: 'Book-level content',
    });
    expect(service.listNotesForBook(bookId)).toEqual([
      expect.objectContaining({ id: note.id, book_id: bookId, chapter_id: null }),
    ]);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(bookId, 'page', note.id);
    expect(bookContentRepository.listForBook(bookId)).toEqual([
      { book_id: bookId, item_type: 'page', item_id: note.id, sort_order: 0 },
    ]);
  });

  it('appends a direct Page after an existing Chapter in mixed Book content', () => {
    bookContentRepository.append(bookId, 'chapter', chapterId);

    const note = createDirectNote({ title: 'After Chapter' });

    expect(bookContentRepository.listForBook(bookId)).toEqual([
      { book_id: bookId, item_type: 'chapter', item_id: chapterId, sort_order: 0 },
      { book_id: bookId, item_type: 'page', item_id: note.id, sort_order: 1 },
    ]);
  });

  it('appends a direct Page after existing direct Pages', () => {
    const first = createDirectNote({ title: 'First direct Page' });
    const second = createDirectNote({ title: 'Second direct Page' });

    expect(bookContentRepository.listForBook(bookId)).toEqual([
      { book_id: bookId, item_type: 'page', item_id: first.id, sort_order: 0 },
      { book_id: bookId, item_type: 'page', item_id: second.id, sort_order: 1 },
    ]);
  });

  it('keeps multiple direct Pages contiguous and isolates another Book', () => {
    const otherBookId = createBook();
    const first = createDirectNote({ title: 'First direct Page' });
    const otherFirst = service.createNote({ bookId: otherBookId, title: 'Other first' });
    const second = createDirectNote({ title: 'Second direct Page' });
    const otherSecond = service.createNote({ bookId: otherBookId, title: 'Other second' });

    expect(bookContentRepository.listForBook(bookId)).toEqual([
      { book_id: bookId, item_type: 'page', item_id: first.id, sort_order: 0 },
      { book_id: bookId, item_type: 'page', item_id: second.id, sort_order: 1 },
    ]);
    expect(bookContentRepository.listForBook(otherBookId)).toEqual([
      { book_id: otherBookId, item_type: 'page', item_id: otherFirst.id, sort_order: 0 },
      { book_id: otherBookId, item_type: 'page', item_id: otherSecond.id, sort_order: 1 },
    ]);
  });

  it('creates a Chapter Page with an explicit matching Book', () => {
    const note = service.createNote({
      bookId,
      chapterId,
      title: 'Explicit container',
    });

    expect(note).toMatchObject({ book_id: bookId, chapter_id: chapterId });
    const second = createNote({ title: 'Second Chapter Page' });
    expect(noteRepository.listForChapter(chapterId).map(({ id, sort_order }) => ({ id, sort_order })))
      .toEqual([
        { id: note.id, sort_order: 0 },
        { id: second.id, sort_order: 1 },
      ]);
    expect(bookContentRepository.listForBook(bookId)).toEqual([]);
  });

  it('creates a direct Page with project associations', () => {
    const projectId = createProject();

    const note = createDirectNote({ title: 'Direct project Page', projectIds: [projectId] });

    expect(note.projectIds).toEqual([projectId]);
    expect(note.assetIds).toEqual([]);
    expect(bookContentRepository.listForBook(bookId)).toEqual([
      expect.objectContaining({ item_type: 'page', item_id: note.id, sort_order: 0 }),
    ]);
  });

  it('creates a direct Page with asset associations', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);

    const note = createDirectNote({ title: 'Direct asset Page', assetIds: [assetId] });

    expect(note.projectIds).toEqual([]);
    expect(note.assetIds).toEqual([assetId]);
    expect(bookContentRepository.listForBook(bookId)).toEqual([
      expect.objectContaining({ item_type: 'page', item_id: note.id, sort_order: 0 }),
    ]);
  });

  it('creates a direct Page with both project and asset associations', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);

    const note = createDirectNote({
      title: 'Direct mixed associations',
      projectIds: [projectId],
      assetIds: [assetId],
    });

    expect(note.projectIds).toEqual([projectId]);
    expect(note.assetIds).toEqual([assetId]);
    expect(bookContentRepository.listForBook(bookId)).toEqual([
      expect.objectContaining({ item_type: 'page', item_id: note.id, sort_order: 0 }),
    ]);
  });

  it('keeps chapter-only create callers compatible by deriving the Book', () => {
    const saveWithAssociations = vi.spyOn(noteRepository, 'saveWithAssociations');

    const note = createNote({ title: 'Legacy Chapter Page' });

    expect(saveWithAssociations).toHaveBeenCalledWith(expect.objectContaining({
      bookId,
      chapterId,
    }));
    expect(note).toMatchObject({ book_id: bookId, chapter_id: chapterId });
  });

  it('keeps legacy chapter-only service construction usable without Book wiring', () => {
    const legacyService = createNoteService({
      noteRepository,
      projectRepository,
      assetRepository,
      chapterRepository,
    });

    const note = legacyService.createNote({ chapterId, title: 'Legacy wiring' });

    expect(note).toMatchObject({ book_id: bookId, chapter_id: chapterId });
  });

  it.each([0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    ('rejects invalid bookId %p', (invalidBookId) => {
      expect(() => service.createNote({ bookId: invalidBookId, title: 'Invalid Book' }))
        .toThrow(NoteValidationError);
      expect(noteRepository.list()).toEqual([]);
    });

  it('rejects a nonexistent Book before persistence', () => {
    expect(() => service.createNote({ bookId: MISSING_ID, title: 'Missing Book' }))
      .toThrow(BookNotFoundError);
    expect(noteRepository.list()).toEqual([]);
    expect(bookContentRepository.listForBook(bookId)).toEqual([]);
  });

  it('rejects a mismatched Book and Chapter before repository write', () => {
    const otherBookId = createBook();
    const saveWithAssociations = vi.spyOn(noteRepository, 'saveWithAssociations');

    let error;
    try {
      service.createNote({
        bookId: otherBookId,
        chapterId,
        title: 'Mismatched hierarchy',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(NoteValidationError);
    expect(error.code).toBe('BOOK_CHAPTER_MISMATCH');
    expect(error.errors.chapterId).toContain(`Book ${otherBookId}`);
    expect(saveWithAssociations).not.toHaveBeenCalled();
    expect(noteRepository.list()).toEqual([]);
    expect(bookContentRepository.listForBook(bookId)).toEqual([]);
    expect(bookContentRepository.listForBook(otherBookId)).toEqual([]);
  });

  it.each([0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    ('rejects invalid chapterId %p', (invalidChapterId) => {
      let error;
      try {
        service.createNote({ title: 'Invalid chapter', chapterId: invalidChapterId });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(NoteValidationError);
      expect(error.errors).toEqual({ chapterId: 'chapterId must be a positive integer.' });
      expect(noteRepository.list()).toEqual([]);
    });

  it('rejects a nonexistent Chapter before persistence', () => {
    expect(() => service.createNote({ title: 'Missing Chapter', chapterId: MISSING_ID }))
      .toThrow(ChapterNotFoundError);
    expect(noteRepository.list()).toEqual([]);
  });

  it('creates a note with a normalized title and plain Markdown content', () => {
    const note = createNote({
      title: '  Project plan  ',
      content: '# Heading\n\n- **draft**\n',
    });

    expect(note).toMatchObject({
      title: 'Project plan',
      content: '# Heading\n\n- **draft**\n',
      projectIds: [],
      assetIds: [],
    });
  });

  it('passes Chapter membership through atomic persistence and exposes it on reads', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);
    const saveWithAssociations = vi.spyOn(noteRepository, 'saveWithAssociations');

    const created = createNote({
      title: 'Scoped note',
      projectIds: [projectId],
      assetIds: [assetId],
    });

    expect(saveWithAssociations).toHaveBeenCalledWith(expect.objectContaining({
      chapterId,
      projectIds: [projectId],
      assetIds: [assetId],
    }));
    expect(created.chapter_id).toBe(chapterId);
    expect(service.getNote(created.id).chapter_id).toBe(chapterId);
    expect(service.listNotes()).toEqual([expect.objectContaining({
      id: created.id,
      chapter_id: chapterId,
    })]);
  });

  it('creates a note with project associations', () => {
    const projectId = createProject();

    const note = createNote({ title: 'Project note', projectIds: [projectId] });

    expect(note.projectIds).toEqual([projectId]);
    expect(note.assetIds).toEqual([]);
  });

  it('creates a note with asset associations', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);

    const note = createNote({ title: 'Asset note', assetIds: [assetId] });

    expect(note.projectIds).toEqual([]);
    expect(note.assetIds).toEqual([assetId]);
  });

  it('supports mixed independent project and asset associations', () => {
    const projectId = createProject();
    const unrelatedProjectId = createProject();
    const assetId = createAsset(projectId);

    const note = createNote({
      title: 'Mixed note',
      projectIds: [unrelatedProjectId],
      assetIds: [assetId],
    });

    expect(note.projectIds).toEqual([unrelatedProjectId]);
    expect(note.assetIds).toEqual([assetId]);
    expect(note.projectIds).not.toContain(projectId);
  });

  it('accepts explicit empty association arrays', () => {
    const note = createNote({ title: 'Unlinked note', projectIds: [], assetIds: [] });

    expect(note.projectIds).toEqual([]);
    expect(note.assetIds).toEqual([]);
  });

  it('deduplicates association IDs while preserving first-seen order', () => {
    const p1 = createProject();
    const p2 = createProject();
    const a1 = createAsset(p1);
    const a2 = createAsset(p2);

    const note = createNote({
      title: 'Deduplicated note',
      projectIds: [p2, p2, p1, p1],
      assetIds: [a2, a2, a1, a1],
    });

    expect(note.projectIds).toEqual([p1, p2]);
    expect(note.assetIds).toEqual([a1, a2]);
  });

  it.each([undefined, null, 123, [], {}])('rejects invalid title input %p', (title) => {
    expect(() => createNote({ title, content: '' })).toThrow(NoteValidationError);
    expect(noteRepository.list()).toEqual([]);
  });

  it('rejects an empty or overlong title', () => {
    expect(() => createNote({ title: '   ' })).toThrow(NoteValidationError);
    expect(() => createNote({ title: 'x'.repeat(NOTE_TITLE_MAX + 1) }))
      .toThrow(NoteValidationError);
    expect(noteRepository.list()).toEqual([]);
  });

  it('rejects invalid direct Page title and content before persistence', () => {
    expect(() => createDirectNote({ title: '   ' })).toThrow(NoteValidationError);
    expect(() => createDirectNote({ title: 'Valid', content: 123 })).toThrow(NoteValidationError);

    expect(noteRepository.list()).toEqual([]);
    expect(bookContentRepository.listForBook(bookId)).toEqual([]);
  });

  it.each([null, 123, [], {}])('rejects non-string content input %p', (content) => {
    expect(() => createNote({ title: 'Valid title', content })).toThrow(NoteValidationError);
    expect(noteRepository.list()).toEqual([]);
  });

  it('rejects scalar association input instead of coercing it', () => {
    expect(() => createNote({ title: 'Invalid associations', projectIds: 1 }))
      .toThrow(NoteValidationError);
    expect(() => createNote({ title: 'Invalid associations', assetIds: 1 }))
      .toThrow(NoteValidationError);
    expect(noteRepository.list()).toEqual([]);
  });

  it.each([0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    ('rejects invalid project ID %p', (projectId) => {
      expect(() => createNote({ title: 'Invalid project', projectIds: [projectId] }))
        .toThrow(NoteValidationError);
      expect(noteRepository.list()).toEqual([]);
    });

  it.each([0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    ('rejects invalid asset ID %p', (assetId) => {
      expect(() => createNote({ title: 'Invalid asset', assetIds: [assetId] }))
        .toThrow(NoteValidationError);
      expect(noteRepository.list()).toEqual([]);
    });

  it('rejects a nonexistent project reference before persistence', () => {
    expect(() => createNote({ title: 'Missing project', projectIds: [MISSING_ID] }))
      .toThrow(NoteValidationError);

    expect(noteRepository.list()).toEqual([]);
  });

  it('rejects a nonexistent asset reference before persistence', () => {
    expect(() => createNote({ title: 'Missing asset', assetIds: [MISSING_ID] }))
      .toThrow(NoteValidationError);

    expect(noteRepository.list()).toEqual([]);
  });

  it('rejects nonexistent direct Page associations before persistence', () => {
    expect(() => createDirectNote({ title: 'Missing project', projectIds: [MISSING_ID] }))
      .toThrow(NoteValidationError);
    expect(() => createDirectNote({ title: 'Missing asset', assetIds: [MISSING_ID] }))
      .toThrow(NoteValidationError);

    expect(noteRepository.list()).toEqual([]);
    expect(bookContentRepository.listForBook(bookId)).toEqual([]);
  });

  it('returns note details with project and asset association IDs', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);
    const created = createNote({ title: 'Detail', projectIds: [projectId], assetIds: [assetId] });

    expect(service.getNote(created.id)).toEqual(created);
  });

  it('throws NoteNotFoundError for missing detail, update, and delete operations', () => {
    expect(() => service.getNote(MISSING_ID)).toThrow(NoteNotFoundError);
    expect(() => service.updateNote(MISSING_ID, { title: 'Missing' })).toThrow(NoteNotFoundError);
    expect(() => service.deleteNote(MISSING_ID)).toThrow(NoteNotFoundError);
  });

  it('updates title and content', () => {
    const created = createNote({ title: 'Before', content: 'before' });

    const updated = service.updateNote(created.id, {
      title: '  After  ',
      content: 'after\n',
    });

    expect(updated).toMatchObject({
      id: created.id,
      chapter_id: chapterId,
      title: 'After',
      content: 'after\n',
      projectIds: [],
      assetIds: [],
    });
  });

  it('preserves Chapter membership and rejects implicit moves on update', () => {
    const created = createNote({ title: 'Fixed chapter', content: 'before' });
    const otherChapterId = chapterRepository.create({
      bookId: chapterRepository.findById(chapterId).book_id,
      title: 'Other chapter',
    }).id;

    const updated = service.updateNote(created.id, { content: 'after' });
    expect(updated.chapter_id).toBe(chapterId);

    let error;
    try {
      service.updateNote(created.id, { chapterId: otherChapterId });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(NoteValidationError);
    expect(error.errors).toEqual({
      chapterId: 'chapterId cannot be changed by updating a Note.',
    });
    expect(service.getNote(created.id).chapter_id).toBe(chapterId);
  });

  it('preserves direct Book membership and rejects hierarchy fields on update', () => {
    const created = createDirectNote({ title: 'Fixed Book Page' });
    const otherBookId = createBook();

    expect(() => service.updateNote(created.id, { bookId: otherBookId }))
      .toThrow(NoteValidationError);
    expect(() => service.updateNote(created.id, { chapterId }))
      .toThrow(NoteValidationError);
    expect(service.getNote(created.id)).toMatchObject({ book_id: bookId, chapter_id: null });
  });

  it('replaces associations on update and allows independent sets', () => {
    const firstProjectId = createProject();
    const secondProjectId = createProject();
    const firstAssetId = createAsset(firstProjectId);
    const secondAssetId = createAsset(secondProjectId);
    const created = createNote({
      title: 'Before',
      projectIds: [firstProjectId],
      assetIds: [firstAssetId],
    });

    const updated = service.updateNote(created.id, {
      projectIds: [secondProjectId],
      assetIds: [secondAssetId],
    });

    expect(updated.projectIds).toEqual([secondProjectId]);
    expect(updated.assetIds).toEqual([secondAssetId]);
  });

  it('clears associations with empty replacement arrays', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);
    const created = createNote({
      title: 'Clear me',
      projectIds: [projectId],
      assetIds: [assetId],
    });

    const updated = service.updateNote(created.id, { projectIds: [], assetIds: [] });

    expect(updated.projectIds).toEqual([]);
    expect(updated.assetIds).toEqual([]);
  });

  it('preserves omitted note fields and associations on partial update', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);
    const created = createNote({
      title: 'Keep me',
      content: 'keep',
      projectIds: [projectId],
      assetIds: [assetId],
    });

    const updated = service.updateNote(created.id, { content: 'changed' });

    expect(updated).toMatchObject({
      title: 'Keep me',
      content: 'changed',
      projectIds: [projectId],
      assetIds: [assetId],
    });
  });

  it('leaves the prior note and associations intact after a failed update', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);
    const created = createNote({
      title: 'Stable',
      content: 'original',
      projectIds: [projectId],
      assetIds: [assetId],
    });
    const before = service.getNote(created.id);

    expect(() => service.updateNote(created.id, {
      title: 'Should not persist',
      content: 'changed',
      projectIds: [MISSING_ID],
      assetIds: [],
    })).toThrow(NoteValidationError);

    expect(service.getNote(created.id)).toEqual(before);
  });

  it('leaves no partial note after a failed create', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);

    expect(() => createNote({
      title: 'Should not persist',
      content: 'body',
      projectIds: [projectId],
      assetIds: [assetId, MISSING_ID],
    })).toThrow(NoteValidationError);

    expect(noteRepository.list()).toEqual([]);
    expect(noteRepository.listProjectsForNote(1)).toEqual([]);
    expect(noteRepository.listAssetsForNote(1)).toEqual([]);
  });

  it('rolls back the Note and project association when asset creation fails', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);
    db.exec(`
      CREATE TRIGGER fail_note_asset_create
      BEFORE INSERT ON note_assets
      BEGIN
        SELECT RAISE(ABORT, 'forced note asset create failure');
      END
    `);

    expect(() => createNote({
      title: 'Atomic create',
      projectIds: [projectId],
      assetIds: [assetId],
    })).toThrow(/forced note asset create failure/);

    expect(noteRepository.list()).toEqual([]);
    expect(noteRepository.listProjectsForNote(1)).toEqual([]);
    expect(noteRepository.listAssetsForNote(1)).toEqual([]);
  });

  it('rolls back a direct Page and all associations when membership append fails', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);
    const originalAppend = bookContentRepository.append;
    vi.spyOn(bookContentRepository, 'append').mockImplementation((...args) => {
      originalAppend(...args);
      throw new Error('forced page membership failure');
    });

    expect(() => createDirectNote({
      title: 'Atomic direct Page',
      projectIds: [projectId],
      assetIds: [assetId],
    })).toThrow('forced page membership failure');

    expect(noteRepository.list()).toEqual([]);
    expect(db.prepare('SELECT * FROM note_projects').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM note_assets').all()).toEqual([]);
    expect(bookContentRepository.listForBook(bookId)).toEqual([]);
  });

  it('does not add membership when Note creation fails', () => {
    vi.spyOn(noteRepository, 'saveWithAssociations').mockImplementation(() => {
      throw new Error('forced note creation failure');
    });

    expect(() => createDirectNote({ title: 'Broken direct Page' }))
      .toThrow('forced note creation failure');

    expect(noteRepository.list()).toEqual([]);
    expect(bookContentRepository.listForBook(bookId)).toEqual([]);
  });

  it('rolls back a direct Page and membership when association replacement fails', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);
    db.exec(`
      CREATE TRIGGER fail_direct_note_asset_create
      BEFORE INSERT ON note_assets
      BEGIN
        SELECT RAISE(ABORT, 'forced direct note asset create failure');
      END
    `);

    expect(() => createDirectNote({
      title: 'Atomic direct association failure',
      projectIds: [projectId],
      assetIds: [assetId],
    })).toThrow(/forced direct note asset create failure/);

    expect(noteRepository.list()).toEqual([]);
    expect(db.prepare('SELECT * FROM note_projects').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM note_assets').all()).toEqual([]);
    expect(bookContentRepository.listForBook(bookId)).toEqual([]);
  });

  it('deletes a note and returns true', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);
    const created = createNote({ title: 'Delete me', projectIds: [projectId], assetIds: [assetId] });

    expect(service.deleteNote(created.id)).toBe(true);
    expect(noteRepository.findById(created.id)).toBeUndefined();
    expect(noteRepository.listProjectsForNote(created.id)).toEqual([]);
    expect(noteRepository.listAssetsForNote(created.id)).toEqual([]);
  });

  it('deletes a direct Book Page, removes its exact membership, and compacts its Book-local order', () => {
    const first = createDirectNote({ title: 'First direct' });
    const second = createDirectNote({ title: 'Second direct' });
    const remove = vi.spyOn(bookContentRepository, 'remove');

    expect(service.deleteNote(first.id)).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(bookId, 'page', first.id);
    expect(noteRepository.findById(first.id)).toBeUndefined();
    expect(bookContentRepository.listForBook(bookId)).toEqual([
      { book_id: bookId, item_type: 'page', item_id: second.id, sort_order: 0 },
    ]);
    expect(service.listNotesForBook(bookId)).toEqual([
      expect.objectContaining({ id: second.id, sort_order: 0, chapter_id: null }),
    ]);
  });

  it.each(['first', 'middle', 'last'])
    ('deletes the %s direct Page from mixed Book content and preserves relative order', (position) => {
      const first = createDirectNote({ title: 'First direct' });
      const middle = createDirectNote({ title: 'Middle direct' });
      const last = createDirectNote({ title: 'Last direct' });
      const otherChapterId = createChapterForBook(bookId, 'Second chapter');
      bookContentRepository.append(bookId, 'chapter', chapterId);
      bookContentRepository.append(bookId, 'chapter', otherChapterId);

      const ordered = [
        { type: 'page', id: first.id },
        { type: 'chapter', id: chapterId },
        { type: 'page', id: middle.id },
        { type: 'chapter', id: otherChapterId },
        { type: 'page', id: last.id },
      ];
      bookContentRepository.reorder(bookId, ordered);

      const target = { first, middle, last }[position];
      expect(service.deleteNote(target.id)).toBe(true);

      const remaining = ordered.filter((item) => !(item.type === 'page' && item.id === target.id));
      expect(bookContentRepository.listForBook(bookId)).toEqual(
        remaining.map(({ type, id }, sort_order) => ({
          book_id: bookId,
          item_type: type,
          item_id: id,
          sort_order,
        }))
      );
      expect(service.listNotesForBook(bookId).map(({ id, sort_order }) => ({ id, sort_order })))
        .toEqual([first, middle, last]
          .filter((note) => note.id !== target.id)
          .map((note, sort_order) => ({ id: note.id, sort_order })));
    });

  it('does not change another Book when deleting a direct Page', () => {
    const otherBookId = createBook();
    const otherChapterId = createChapterForBook(otherBookId, 'Other chapter');
    bookContentRepository.append(otherBookId, 'chapter', otherChapterId);
    const otherPage = service.createNote({ bookId: otherBookId, title: 'Other direct Page' });
    const otherBefore = bookContentRepository.listForBook(otherBookId);
    const page = createDirectNote({ title: 'Delete from primary Book' });

    expect(service.deleteNote(page.id)).toBe(true);
    expect(bookContentRepository.listForBook(otherBookId)).toEqual(otherBefore);
    expect(noteRepository.findById(otherPage.id)).toEqual(expect.objectContaining({
      id: otherPage.id,
      book_id: otherBookId,
      chapter_id: null,
    }));
  });

  it('deletes a Chapter Page without touching Book membership and compacts Chapter order', () => {
    const first = createNote({ title: 'First Chapter Page' });
    const second = createNote({ title: 'Second Chapter Page' });
    const remove = vi.spyOn(bookContentRepository, 'remove');

    expect(service.deleteNote(first.id)).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    expect(noteRepository.listForChapter(chapterId).map(({ id, sort_order }) => ({ id, sort_order })))
      .toEqual([{ id: second.id, sort_order: 0 }]);
    expect(bookContentRepository.listForBook(bookId)).toEqual([]);
  });

  it.each(['project', 'asset', 'both'])
    ('deletes a direct Page and cascades its %s associations', (associationKind) => {
      const projectId = createProject();
      const assetId = createAsset(projectId);
      const note = createDirectNote({
        title: `Direct ${associationKind} association`,
        projectIds: associationKind === 'asset' ? [] : [projectId],
        assetIds: associationKind === 'project' ? [] : [assetId],
      });

      expect(service.deleteNote(note.id)).toBe(true);
      expect(noteRepository.findById(note.id)).toBeUndefined();
      expect(noteRepository.listProjectsForNote(note.id)).toEqual([]);
      expect(noteRepository.listAssetsForNote(note.id)).toEqual([]);
      expect(bookContentRepository.listForBook(bookId)).toEqual([]);
    });

  it('rolls back a direct Page deletion when its membership is missing', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);
    const note = createDirectNote({
      title: 'Missing membership',
      projectIds: [projectId],
      assetIds: [assetId],
    });
    db.prepare(`
      DELETE FROM book_contents
      WHERE book_id = ? AND item_type = 'page' AND item_id = ?
    `).run(bookId, note.id);
    const before = noteRepository.findById(note.id);

    let error;
    try {
      service.deleteNote(note.id);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(NoteOperationError);
    expect(error.code).toBe('MEMBERSHIP_NOT_FOUND');
    expect(noteRepository.findById(note.id)).toEqual(before);
    expect(noteRepository.listProjectsForNote(note.id)).toEqual([projectId]);
    expect(noteRepository.listAssetsForNote(note.id)).toEqual([assetId]);
    expect(bookContentRepository.listForBook(bookId)).toEqual([]);
  });

  it('rolls back the Note, associations, and order when membership removal fails', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);
    const note = createDirectNote({
      title: 'Removal failure',
      projectIds: [projectId],
      assetIds: [assetId],
    });
    const beforeNote = noteRepository.findById(note.id);
    const beforeContent = bookContentRepository.listForBook(bookId);
    const originalRemove = bookContentRepository.remove;
    vi.spyOn(bookContentRepository, 'remove').mockImplementation((...args) => {
      expect(originalRemove(...args)).toBe(true);
      throw new Error('forced page membership removal failure');
    });

    expect(() => service.deleteNote(note.id)).toThrow('forced page membership removal failure');
    expect(noteRepository.findById(note.id)).toEqual(beforeNote);
    expect(noteRepository.listProjectsForNote(note.id)).toEqual([projectId]);
    expect(noteRepository.listAssetsForNote(note.id)).toEqual([assetId]);
    expect(bookContentRepository.listForBook(bookId)).toEqual(beforeContent);
  });

  it('leaves membership and associations untouched when Note deletion fails', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);
    const note = createDirectNote({
      title: 'Note deletion failure',
      projectIds: [projectId],
      assetIds: [assetId],
    });
    const beforeContent = bookContentRepository.listForBook(bookId);
    const remove = vi.spyOn(bookContentRepository, 'remove');
    vi.spyOn(noteRepository, 'deleteById').mockImplementation(() => {
      throw new Error('forced Note deletion failure');
    });

    expect(() => service.deleteNote(note.id)).toThrow('forced Note deletion failure');
    expect(remove).not.toHaveBeenCalled();
    expect(noteRepository.findById(note.id)).toBeDefined();
    expect(noteRepository.listProjectsForNote(note.id)).toEqual([projectId]);
    expect(noteRepository.listAssetsForNote(note.id)).toEqual([assetId]);
    expect(bookContentRepository.listForBook(bookId)).toEqual(beforeContent);
  });

  it('preserves canonical global list ordering', () => {
    const first = createNote({ title: 'First' });
    const second = createNote({ title: 'Second' });
    const third = createNote({ title: 'Third' });

    expect(service.listNotes().map((note) => note.id)).toEqual([first.id, second.id, third.id]);
    expect(service.listNotes().map((note) => note.title)).toEqual(['First', 'Second', 'Third']);
  });

  it('lists Notes for a Chapter using the canonical repository result', () => {
    const first = createNote({ title: 'First' });
    const second = createNote({ title: 'Second' });
    const otherChapterId = chapterRepository.create({
      bookId: chapterRepository.findById(chapterId).book_id,
      title: 'Other chapter',
    }).id;
    service.createNote({ chapterId: otherChapterId, title: 'Other note' });
    const listForChapter = vi.spyOn(noteRepository, 'listForChapter');

    const notes = service.listNotesForChapter(chapterId);

    expect(listForChapter).toHaveBeenCalledWith(chapterId);
    expect(notes).toBe(listForChapter.mock.results[0].value);
    expect(notes.map((note) => note.id)).toEqual([first.id, second.id]);
  });

  it('lists only direct Book Pages for a Book', () => {
    const direct = createDirectNote({ title: 'Direct Page' });
    createNote({ title: 'Chapter Page' });
    const otherBookId = createBook();
    const otherDirect = service.createNote({ bookId: otherBookId, title: 'Other direct Page' });
    const listForBook = vi.spyOn(noteRepository, 'listForBook');

    const notes = service.listNotesForBook(bookId);

    expect(listForBook).toHaveBeenCalledWith(bookId);
    expect(notes).toBe(listForBook.mock.results[0].value);
    expect(notes.map((note) => note.id)).toEqual([direct.id]);
    expect(notes.map((note) => note.id)).not.toContain(otherDirect.id);
  });

  it('rejects a nonexistent Book list before delegating', () => {
    const listForBook = vi.spyOn(noteRepository, 'listForBook');

    expect(() => service.listNotesForBook(MISSING_ID)).toThrow(BookNotFoundError);
    expect(listForBook).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    ('rejects invalid Chapter list chapterId %p', (invalidChapterId) => {
      const listForChapter = vi.spyOn(noteRepository, 'listForChapter');

      expect(() => service.listNotesForChapter(invalidChapterId)).toThrow(NoteValidationError);
      expect(listForChapter).not.toHaveBeenCalled();
    });

  it('rejects a nonexistent Chapter list before delegating', () => {
    const listForChapter = vi.spyOn(noteRepository, 'listForChapter');

    expect(() => service.listNotesForChapter(MISSING_ID)).toThrow(ChapterNotFoundError);
    expect(listForChapter).not.toHaveBeenCalled();
  });

  it('reorders only Notes in the requested Chapter and returns the repository result', () => {
    const first = createNote({ title: 'First' });
    const second = createNote({ title: 'Second' });
    const third = createNote({ title: 'Third' });
    const otherChapterId = chapterRepository.create({
      bookId: chapterRepository.findById(chapterId).book_id,
      title: 'Other chapter',
    }).id;
    const otherFirst = service.createNote({ chapterId: otherChapterId, title: 'Other first' });
    const otherSecond = service.createNote({ chapterId: otherChapterId, title: 'Other second' });
    const orderedIds = [third.id, first.id, second.id];
    const reorder = vi.spyOn(noteRepository, 'reorder');

    const reordered = service.reorderNotes(chapterId, orderedIds);

    expect(reorder).toHaveBeenCalledWith(chapterId, orderedIds);
    expect(reordered.map((note) => note.id)).toEqual(orderedIds);
    expect(reordered.map((note) => note.sort_order)).toEqual([0, 1, 2]);
    expect(reordered).toEqual(noteRepository.listForChapter(chapterId));
    expect(noteRepository.listForChapter(otherChapterId).map((note) => note.id))
      .toEqual([otherFirst.id, otherSecond.id]);
  });

  it.each([0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    ('rejects invalid reorder chapterId %p', (invalidChapterId) => {
      let error;
      try {
        service.reorderNotes(invalidChapterId, []);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(NoteValidationError);
      expect(error.errors).toEqual({ chapterId: 'chapterId must be a positive integer.' });
    });

  it('rejects a nonexistent reorder Chapter before delegating', () => {
    expect(() => service.reorderNotes(MISSING_ID, [])).toThrow(ChapterNotFoundError);
  });

  it.each(['not an array', [0], ['1'], [1.5], [NaN]])
    ('rejects malformed reorder orderedIds %p', (orderedIds) => {
      expect(() => service.reorderNotes(chapterId, orderedIds)).toThrow(NoteValidationError);
    });

  it('rejects duplicate reorder IDs using the service validation convention', () => {
    const first = createNote({ title: 'First' });
    const second = createNote({ title: 'Second' });

    expect(() => service.reorderNotes(chapterId, [first.id, first.id])).toThrow(NoteValidationError);
    expect(service.listNotes().map((note) => note.id)).toEqual([first.id, second.id]);
  });

  it('translates repository missing and extra reorder IDs without exposing details', () => {
    const first = createNote({ title: 'First' });
    const second = createNote({ title: 'Second' });

    expect(() => service.reorderNotes(chapterId, [first.id])).toThrow(NoteValidationError);
    expect(() => service.reorderNotes(chapterId, [first.id, second.id, MISSING_ID]))
      .toThrow(NoteValidationError);
    expect(noteRepository.listForChapter(chapterId).map((note) => note.id))
      .toEqual([first.id, second.id]);
  });

  it('translates cross-Chapter reorder IDs and leaves both Chapters unchanged', () => {
    const first = createNote({ title: 'First' });
    const otherChapterId = chapterRepository.create({
      bookId: chapterRepository.findById(chapterId).book_id,
      title: 'Other chapter',
    }).id;
    const other = service.createNote({ chapterId: otherChapterId, title: 'Other' });

    expect(() => service.reorderNotes(chapterId, [other.id])).toThrow(NoteValidationError);
    expect(noteRepository.listForChapter(chapterId).map((note) => note.id)).toEqual([first.id]);
    expect(noteRepository.listForChapter(otherChapterId).map((note) => note.id)).toEqual([other.id]);
  });

  it('delegates an empty Chapter reorder and returns its empty result', () => {
    const emptyChapterId = chapterRepository.create({
      bookId: chapterRepository.findById(chapterId).book_id,
      title: 'Empty chapter',
    }).id;
    const reorder = vi.spyOn(noteRepository, 'reorder');

    expect(service.reorderNotes(emptyChapterId, [])).toEqual([]);
    expect(reorder).toHaveBeenCalledWith(emptyChapterId, []);
  });

  it('reorders only direct Book Pages', () => {
    const first = createDirectNote({ title: 'Direct first' });
    const second = createDirectNote({ title: 'Direct second' });
    const chapterPage = createNote({ title: 'Chapter Page' });
    const reorderForBook = vi.spyOn(noteRepository, 'reorderForBook');

    const reordered = service.reorderBookPages(bookId, [second.id, first.id]);

    expect(reorderForBook).toHaveBeenCalledWith(bookId, [second.id, first.id]);
    expect(reordered.map((note) => note.id)).toEqual([second.id, first.id]);
    expect(reordered.every((note) => note.chapter_id === null)).toBe(true);
    expect(service.listNotesForChapter(chapterId).map((note) => note.id))
      .toEqual([chapterPage.id]);
  });

  it('moves a Note to another Chapter without changing its state or associations', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);
    const created = createNote({
      title: 'Move me',
      content: 'Preserve this content',
      projectIds: [projectId],
      assetIds: [assetId],
    });
    const targetChapterId = chapterRepository.create({
      bookId: chapterRepository.findById(chapterId).book_id,
      title: 'Destination chapter',
    }).id;
    const moveToContainer = vi.spyOn(noteRepository, 'moveToContainer');

    const moved = service.moveNoteToChapter(created.id, targetChapterId);

    expect(moveToContainer).toHaveBeenCalledWith(created.id, {
      bookId: bookId,
      chapterId: targetChapterId,
    });
    expect(moved).toMatchObject({
      id: created.id,
      chapter_id: targetChapterId,
      title: created.title,
      content: created.content,
      created_at: created.created_at,
      updated_at: created.updated_at,
    });
    expect(service.getNote(created.id)).toMatchObject({
      chapter_id: targetChapterId,
      title: created.title,
      content: created.content,
      projectIds: [projectId],
      assetIds: [assetId],
      created_at: created.created_at,
      updated_at: created.updated_at,
    });
  });

  it('moves a Chapter Page to a direct Page in the same Book', () => {
    const created = createNote({ title: 'Chapter to Book' });
    const moveToContainer = vi.spyOn(noteRepository, 'moveToContainer');

    const moved = service.moveNote(created.id, { bookId });

    expect(moveToContainer).toHaveBeenCalledWith(created.id, {
      bookId,
      chapterId: null,
    });
    expect(moved).toMatchObject({ id: created.id, book_id: bookId, chapter_id: null });
  });

  it('appends a moved Chapter Page after all existing mixed Book content and preserves its state', () => {
    const existingPage = createDirectNote({ title: 'Existing direct Page' });
    bookContentRepository.append(bookId, 'chapter', chapterId);
    const projectId = createProject();
    const assetId = createAsset(projectId);
    const created = createNote({
      title: 'Chapter to Book with state',
      content: '# Keep this Markdown',
      projectIds: [projectId],
      assetIds: [assetId],
    });
    const append = vi.spyOn(bookContentRepository, 'append');

    const moved = service.moveNote(created.id, { bookId });

    expect(moved).toMatchObject({
      id: created.id,
      book_id: bookId,
      chapter_id: null,
      title: created.title,
      content: created.content,
    });
    expect(service.getNote(created.id)).toMatchObject({
      id: created.id,
      book_id: bookId,
      chapter_id: null,
      title: created.title,
      content: created.content,
      projectIds: [projectId],
      assetIds: [assetId],
    });
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(bookId, 'page', created.id);
    expect(bookContentRepository.listForBook(bookId)).toEqual([
      { book_id: bookId, item_type: 'page', item_id: existingPage.id, sort_order: 0 },
      { book_id: bookId, item_type: 'chapter', item_id: chapterId, sort_order: 1 },
      { book_id: bookId, item_type: 'page', item_id: created.id, sort_order: 2 },
    ]);
  });

  it.each(['first', 'middle', 'last'])
    ('compacts the source Chapter after moving its %s Page to a direct Book Page', (position) => {
      const first = createNote({ title: 'First Chapter Page' });
      const middle = createNote({ title: 'Middle Chapter Page' });
      const last = createNote({ title: 'Last Chapter Page' });
      const target = { first, middle, last }[position];

      service.moveNote(target.id, { bookId });

      expect(noteRepository.listForChapter(chapterId).map(({ id, sort_order }) => ({ id, sort_order })))
        .toEqual([first, middle, last]
          .filter((note) => note.id !== target.id)
          .map((note, sort_order) => ({ id: note.id, sort_order })));
    });

  it('moves a Chapter Page across Books and appends it at the target mixed-content end', () => {
    const otherBookId = createBook();
    const otherChapterId = createChapterForBook(otherBookId, 'Target chapter');
    createDirectNote({ title: 'Source direct Page' });
    const first = createNote({ title: 'First source Page' });
    const moving = createNote({ title: 'Cross-book Chapter Page' });
    const last = createNote({ title: 'Last source Page' });
    bookContentRepository.append(bookId, 'chapter', chapterId);
    const sourceContentsBefore = bookContentRepository.listForBook(bookId);
    service.createNote({ bookId: otherBookId, title: 'Target direct Page' });
    bookContentRepository.append(otherBookId, 'chapter', otherChapterId);
    const targetContentsBefore = bookContentRepository.listForBook(otherBookId);
    const append = vi.spyOn(bookContentRepository, 'append');

    const moved = service.moveNote(moving.id, { bookId: otherBookId });

    expect(moved).toMatchObject({
      id: moving.id,
      book_id: otherBookId,
      chapter_id: null,
    });
    expect(noteRepository.listForChapter(chapterId).map(({ id, sort_order }) => ({ id, sort_order })))
      .toEqual([
        { id: first.id, sort_order: 0 },
        { id: last.id, sort_order: 1 },
      ]);
    expect(bookContentRepository.listForBook(bookId)).toEqual(sourceContentsBefore);
    expect(bookContentRepository.listForBook(otherBookId)).toEqual([
      ...targetContentsBefore,
      { book_id: otherBookId, item_type: 'page', item_id: moving.id, sort_order: targetContentsBefore.length },
    ]);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(otherBookId, 'page', moving.id);
  });

  it('rolls back Chapter Page movement when target membership append fails', () => {
    createNote({ title: 'First Chapter Page' });
    const moving = createNote({ title: 'Append failure' });
    createNote({ title: 'Last Chapter Page' });
    const beforeNote = noteRepository.findById(moving.id);
    const beforeChapter = noteRepository.listForChapter(chapterId);
    const beforeContents = bookContentRepository.listForBook(bookId);
    const originalAppend = bookContentRepository.append;
    const append = vi.spyOn(bookContentRepository, 'append').mockImplementation((...args) => {
      originalAppend(...args);
      throw new Error('forced movement membership failure');
    });

    expect(() => service.moveNote(moving.id, { bookId })).toThrow('forced movement membership failure');

    expect(noteRepository.findById(moving.id)).toEqual(beforeNote);
    expect(noteRepository.listForChapter(chapterId)).toEqual(beforeChapter);
    expect(bookContentRepository.listForBook(bookId)).toEqual(beforeContents);
    expect(append).toHaveBeenCalledWith(bookId, 'page', moving.id);
  });

  it('rolls back Chapter Page movement when the target already contains its Page membership', () => {
    const moving = createNote({ title: 'Duplicate membership' });
    bookContentRepository.append(bookId, 'page', moving.id);
    const beforeNote = noteRepository.findById(moving.id);
    const beforeChapter = noteRepository.listForChapter(chapterId);
    const beforeContents = bookContentRepository.listForBook(bookId);
    const append = vi.spyOn(bookContentRepository, 'append');

    expect(() => service.moveNote(moving.id, { bookId })).toThrow(/already contains page/);

    expect(noteRepository.findById(moving.id)).toEqual(beforeNote);
    expect(noteRepository.listForChapter(chapterId)).toEqual(beforeChapter);
    expect(bookContentRepository.listForBook(bookId)).toEqual(beforeContents);
    expect(append).toHaveBeenCalledWith(bookId, 'page', moving.id);
  });

  it('does not add membership when Chapter Page movement fails in the repository', () => {
    const moving = createNote({ title: 'Repository failure' });
    const beforeNote = noteRepository.findById(moving.id);
    const beforeChapter = noteRepository.listForChapter(chapterId);
    const originalMove = noteRepository.moveToContainer;
    const append = vi.spyOn(bookContentRepository, 'append');
    vi.spyOn(noteRepository, 'moveToContainer').mockImplementation((...args) => {
      originalMove(...args);
      throw new Error('forced movement repository failure');
    });

    expect(() => service.moveNote(moving.id, { bookId })).toThrow('forced movement repository failure');

    expect(noteRepository.findById(moving.id)).toEqual(beforeNote);
    expect(noteRepository.listForChapter(chapterId)).toEqual(beforeChapter);
    expect(bookContentRepository.listForBook(bookId)).toEqual([]);
    expect(append).not.toHaveBeenCalled();
  });

  it('leaves a Chapter Page unchanged when the target Book does not exist', () => {
    const moving = createNote({ title: 'Invalid target Book' });
    const beforeNote = noteRepository.findById(moving.id);
    const beforeChapter = noteRepository.listForChapter(chapterId);
    const append = vi.spyOn(bookContentRepository, 'append');

    expect(() => service.moveNote(moving.id, { bookId: MISSING_ID })).toThrow(BookNotFoundError);

    expect(noteRepository.findById(moving.id)).toEqual(beforeNote);
    expect(noteRepository.listForChapter(chapterId)).toEqual(beforeChapter);
    expect(bookContentRepository.listForBook(bookId)).toEqual([]);
    expect(append).not.toHaveBeenCalled();
  });

  it('moves a direct Book Page into a Chapter and synchronizes mixed Book content', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);
    const first = createDirectNote({ title: 'First direct Page' });
    const existingTarget = createNote({ title: 'Existing target Page' });
    const created = createDirectNote({
      title: 'Book to Chapter',
      content: '# Preserve this Markdown',
      projectIds: [projectId],
      assetIds: [assetId],
    });
    const last = createDirectNote({ title: 'Last direct Page' });
    bookContentRepository.append(bookId, 'chapter', chapterId);
    bookContentRepository.reorder(bookId, [
      { type: 'page', id: first.id },
      { type: 'chapter', id: chapterId },
      { type: 'page', id: created.id },
      { type: 'page', id: last.id },
    ]);
    const moveToContainer = vi.spyOn(noteRepository, 'moveToContainer');

    const moved = service.moveNote(created.id, { bookId, chapterId });

    expect(moveToContainer).toHaveBeenCalledWith(created.id, { bookId, chapterId });
    expect(moved).toMatchObject({
      id: created.id,
      book_id: bookId,
      chapter_id: chapterId,
      title: created.title,
      content: created.content,
    });
    expect(service.getNote(created.id)).toMatchObject({
      projectIds: [projectId],
      assetIds: [assetId],
    });
    expect(bookContentRepository.listForBook(bookId)).toEqual([
      { book_id: bookId, item_type: 'page', item_id: first.id, sort_order: 0 },
      { book_id: bookId, item_type: 'chapter', item_id: chapterId, sort_order: 1 },
      { book_id: bookId, item_type: 'page', item_id: last.id, sort_order: 2 },
    ]);
    expect(noteRepository.listForChapter(chapterId).map(({ id, sort_order }) => ({ id, sort_order })))
      .toEqual([
        { id: existingTarget.id, sort_order: 0 },
        { id: created.id, sort_order: 1 },
      ]);
    expect(db.prepare(`
      SELECT *
      FROM book_contents
      WHERE item_type = 'page' AND item_id = ?
    `).all(created.id)).toEqual([]);
  });

  it.each(['first', 'middle', 'last'])
    ('compacts the source mixed Book content after moving its %s direct Page into a Chapter', (position) => {
      const first = createDirectNote({ title: 'First direct Page' });
      const middle = createDirectNote({ title: 'Middle direct Page' });
      const last = createDirectNote({ title: 'Last direct Page' });
      bookContentRepository.append(bookId, 'chapter', chapterId);
      const ordered = [
        { type: 'page', id: first.id },
        { type: 'chapter', id: chapterId },
        { type: 'page', id: middle.id },
        { type: 'page', id: last.id },
      ];
      bookContentRepository.reorder(bookId, ordered);

      const target = { first, middle, last }[position];
      service.moveNote(target.id, { bookId, chapterId });

      const remaining = ordered.filter((item) => !(item.type === 'page' && item.id === target.id));
      expect(bookContentRepository.listForBook(bookId)).toEqual(
        remaining.map(({ type, id }, sort_order) => ({
          book_id: bookId,
          item_type: type,
          item_id: id,
          sort_order,
        }))
      );
      expect(noteRepository.listForChapter(chapterId).map(({ id, sort_order }) => ({ id, sort_order })))
        .toEqual([{ id: target.id, sort_order: 0 }]);
    });

  it('moves a direct Book Page across Books into a Chapter without target membership', () => {
    const otherBookId = createBook();
    const targetChapterId = createChapterForBook(otherBookId, 'Cross-book target');
    const first = createDirectNote({ title: 'First source Page' });
    const created = createDirectNote({
      title: 'Cross-book source',
      content: 'Cross-book Markdown',
    });
    const last = createDirectNote({ title: 'Last source Page' });
    bookContentRepository.append(bookId, 'chapter', chapterId);
    const sourceOrder = [
      { type: 'page', id: first.id },
      { type: 'chapter', id: chapterId },
      { type: 'page', id: created.id },
      { type: 'page', id: last.id },
    ];
    bookContentRepository.reorder(bookId, sourceOrder);
    const existingTarget = service.createNote({
      bookId: otherBookId,
      chapterId: targetChapterId,
      title: 'Existing target Page',
    });
    const existingTargetDirect = service.createNote({
      bookId: otherBookId,
      title: 'Existing target direct Page',
    });
    bookContentRepository.append(otherBookId, 'chapter', targetChapterId);
    bookContentRepository.reorder(otherBookId, [
      { type: 'chapter', id: targetChapterId },
      { type: 'page', id: existingTargetDirect.id },
    ]);
    const sourceContentsBefore = bookContentRepository.listForBook(bookId);
    const targetContentsBefore = bookContentRepository.listForBook(otherBookId);

    const moved = service.moveNote(created.id, {
      bookId: otherBookId,
      chapterId: targetChapterId,
    });

    expect(moved).toMatchObject({
      id: created.id,
      book_id: otherBookId,
      chapter_id: targetChapterId,
      title: created.title,
      content: created.content,
    });
    expect(bookContentRepository.listForBook(bookId)).toEqual([
      { book_id: bookId, item_type: 'page', item_id: first.id, sort_order: 0 },
      { book_id: bookId, item_type: 'chapter', item_id: chapterId, sort_order: 1 },
      { book_id: bookId, item_type: 'page', item_id: last.id, sort_order: 2 },
    ]);
    expect(bookContentRepository.listForBook(bookId)).not.toEqual(sourceContentsBefore);
    expect(bookContentRepository.listForBook(otherBookId)).toEqual(targetContentsBefore);
    expect(noteRepository.listForChapter(targetChapterId).map(({ id, sort_order }) => ({ id, sort_order })))
      .toEqual([
        { id: existingTarget.id, sort_order: 0 },
        { id: created.id, sort_order: 1 },
      ]);
    expect(db.prepare(`
      SELECT *
      FROM book_contents
      WHERE item_type = 'page' AND item_id = ?
    `).all(created.id)).toEqual([]);
  });

  it('rolls back direct Book Page to Chapter movement when source membership is missing', () => {
    const created = createDirectNote({ title: 'Missing source membership' });
    const existingTarget = createNote({ title: 'Existing target Page' });
    db.prepare(`
      DELETE FROM book_contents
      WHERE book_id = ? AND item_type = 'page' AND item_id = ?
    `).run(bookId, created.id);
    const beforeNote = noteRepository.findById(created.id);
    const beforeContents = bookContentRepository.listForBook(bookId);
    const beforeTarget = noteRepository.listForChapter(chapterId);

    let error;
    try {
      service.moveNote(created.id, { bookId, chapterId });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(NoteOperationError);
    expect(error.code).toBe('MEMBERSHIP_NOT_FOUND');
    expect(noteRepository.findById(created.id)).toEqual(beforeNote);
    expect(bookContentRepository.listForBook(bookId)).toEqual(beforeContents);
    expect(noteRepository.listForChapter(chapterId)).toEqual(beforeTarget);
    expect(noteRepository.listForChapter(chapterId).map(({ id }) => id)).toEqual([existingTarget.id]);
  });

  it('rolls back direct Book Page to Chapter movement when source membership removal fails', () => {
    const created = createDirectNote({ title: 'Removal failure' });
    createNote({ title: 'Existing target Page' });
    const beforeNote = noteRepository.findById(created.id);
    const beforeContents = bookContentRepository.listForBook(bookId);
    const beforeTarget = noteRepository.listForChapter(chapterId);
    const originalRemove = bookContentRepository.remove;
    const remove = vi.spyOn(bookContentRepository, 'remove').mockImplementation((...args) => {
      expect(args).toEqual([bookId, 'page', created.id]);
      expect(originalRemove(...args)).toBe(true);
      throw new Error('forced direct-to-Chapter membership removal failure');
    });

    expect(() => service.moveNote(created.id, { bookId, chapterId }))
      .toThrow('forced direct-to-Chapter membership removal failure');

    expect(remove).toHaveBeenCalledWith(bookId, 'page', created.id);
    expect(noteRepository.findById(created.id)).toEqual(beforeNote);
    expect(bookContentRepository.listForBook(bookId)).toEqual(beforeContents);
    expect(noteRepository.listForChapter(chapterId)).toEqual(beforeTarget);
  });

  it('leaves direct Page membership unchanged when Note repository movement fails', () => {
    const created = createDirectNote({ title: 'Repository failure' });
    createNote({ title: 'Existing target Page' });
    const beforeNote = noteRepository.findById(created.id);
    const beforeContents = bookContentRepository.listForBook(bookId);
    const beforeTarget = noteRepository.listForChapter(chapterId);
    const originalMove = noteRepository.moveToContainer;
    const remove = vi.spyOn(bookContentRepository, 'remove');
    vi.spyOn(noteRepository, 'moveToContainer').mockImplementation((...args) => {
      originalMove(...args);
      throw new Error('forced direct-to-Chapter repository movement failure');
    });

    expect(() => service.moveNote(created.id, { bookId, chapterId }))
      .toThrow('forced direct-to-Chapter repository movement failure');

    expect(noteRepository.findById(created.id)).toEqual(beforeNote);
    expect(bookContentRepository.listForBook(bookId)).toEqual(beforeContents);
    expect(noteRepository.listForChapter(chapterId)).toEqual(beforeTarget);
    expect(remove).not.toHaveBeenCalled();
  });

  it('leaves a direct Page unchanged when the target Chapter does not exist', () => {
    const created = createDirectNote({ title: 'Invalid target Chapter' });
    const beforeNote = noteRepository.findById(created.id);
    const beforeContents = bookContentRepository.listForBook(bookId);
    const beforeTarget = noteRepository.listForChapter(chapterId);
    const moveToContainer = vi.spyOn(noteRepository, 'moveToContainer');

    expect(() => service.moveNote(created.id, { bookId, chapterId: MISSING_ID }))
      .toThrow(ChapterNotFoundError);

    expect(noteRepository.findById(created.id)).toEqual(beforeNote);
    expect(bookContentRepository.listForBook(bookId)).toEqual(beforeContents);
    expect(noteRepository.listForChapter(chapterId)).toEqual(beforeTarget);
    expect(moveToContainer).not.toHaveBeenCalled();
  });

  it('moves a direct Book Page across Books and synchronizes mixed content and associations', () => {
    const otherBookId = createBook();
    const projectId = createProject();
    const assetId = createAsset(projectId);
    const first = createDirectNote({ title: 'First source Page' });
    const created = createDirectNote({
      title: 'Direct cross-book source',
      content: '# Preserve this Markdown',
      projectIds: [projectId],
      assetIds: [assetId],
    });
    const last = createDirectNote({ title: 'Last source Page' });
    bookContentRepository.append(bookId, 'chapter', chapterId);
    const sourceOrder = [
      { type: 'page', id: first.id },
      { type: 'chapter', id: chapterId },
      { type: 'page', id: created.id },
      { type: 'page', id: last.id },
    ];
    bookContentRepository.reorder(bookId, sourceOrder);

    const targetPage = service.createNote({
      bookId: otherBookId,
      title: 'Existing target Page',
    });
    const targetChapterId = createChapterForBook(otherBookId, 'Existing target Chapter');
    bookContentRepository.append(otherBookId, 'chapter', targetChapterId);
    const targetOrder = [
      { type: 'chapter', id: targetChapterId },
      { type: 'page', id: targetPage.id },
    ];
    bookContentRepository.reorder(otherBookId, targetOrder);
    const targetContentsBefore = bookContentRepository.listForBook(otherBookId);

    const moved = service.moveNote(created.id, { bookId: otherBookId });

    expect(moved).toMatchObject({
      id: created.id,
      book_id: otherBookId,
      chapter_id: null,
      title: created.title,
      content: created.content,
    });
    expect(service.getNote(created.id)).toMatchObject({
      id: created.id,
      book_id: otherBookId,
      chapter_id: null,
      title: created.title,
      content: created.content,
      projectIds: [projectId],
      assetIds: [assetId],
    });

    const remainingSource = sourceOrder.filter(
      (item) => !(item.type === 'page' && item.id === created.id)
    );
    expect(bookContentRepository.listForBook(bookId)).toEqual(
      remainingSource.map(({ type, id }, sort_order) => ({
        book_id: bookId,
        item_type: type,
        item_id: id,
        sort_order,
      }))
    );
    expect(bookContentRepository.listForBook(otherBookId)).toEqual([
      ...targetContentsBefore,
      { book_id: otherBookId, item_type: 'page', item_id: created.id, sort_order: 2 },
    ]);
    expect(db.prepare(`
      SELECT book_id, item_type, item_id, sort_order
      FROM book_contents
      WHERE item_type = 'page' AND item_id = ?
    `).all(created.id)).toEqual([
      { book_id: otherBookId, item_type: 'page', item_id: created.id, sort_order: 2 },
    ]);
  });

  it.each(['first', 'middle', 'last'])
    ('compacts the source mixed Book content after moving its %s direct Page across Books', (position) => {
      const otherBookId = createBook();
      const first = createDirectNote({ title: 'First source Page' });
      const middle = createDirectNote({ title: 'Middle source Page' });
      const last = createDirectNote({ title: 'Last source Page' });
      bookContentRepository.append(bookId, 'chapter', chapterId);
      const sourceOrder = [
        { type: 'page', id: first.id },
        { type: 'chapter', id: chapterId },
        { type: 'page', id: middle.id },
        { type: 'page', id: last.id },
      ];
      bookContentRepository.reorder(bookId, sourceOrder);
      const moving = { first, middle, last }[position];

      service.moveNote(moving.id, { bookId: otherBookId });

      const remaining = sourceOrder.filter(
        (item) => !(item.type === 'page' && item.id === moving.id)
      );
      expect(bookContentRepository.listForBook(bookId)).toEqual(
        remaining.map(({ type, id }, sort_order) => ({
          book_id: bookId,
          item_type: type,
          item_id: id,
          sort_order,
        }))
      );
      expect(bookContentRepository.listForBook(otherBookId)).toEqual([
        { book_id: otherBookId, item_type: 'page', item_id: moving.id, sort_order: 0 },
      ]);
      expect(noteRepository.listForBook(bookId).map(({ id, sort_order }) => ({ id, sort_order })))
        .toEqual([first, middle, last]
          .filter((note) => note.id !== moving.id)
          .map((note, sort_order) => ({ id: note.id, sort_order })));
    });

  it.each(['empty', 'chapters', 'direct Pages', 'mixed'])
    ('appends a moved direct Page at the end of target %s mixed content', (targetKind) => {
      const otherBookId = createBook();
      let targetItems = [];

      if (targetKind === 'chapters') {
        const firstChapterId = createChapterForBook(otherBookId, 'First target Chapter');
        const secondChapterId = createChapterForBook(otherBookId, 'Second target Chapter');
        bookContentRepository.append(otherBookId, 'chapter', firstChapterId);
        bookContentRepository.append(otherBookId, 'chapter', secondChapterId);
        targetItems = [
          { type: 'chapter', id: firstChapterId },
          { type: 'chapter', id: secondChapterId },
        ];
      } else if (targetKind === 'direct Pages') {
        const firstPage = service.createNote({ bookId: otherBookId, title: 'First target Page' });
        const secondPage = service.createNote({ bookId: otherBookId, title: 'Second target Page' });
        targetItems = [
          { type: 'page', id: firstPage.id },
          { type: 'page', id: secondPage.id },
        ];
      } else if (targetKind === 'mixed') {
        const firstPage = service.createNote({ bookId: otherBookId, title: 'First target Page' });
        const secondPage = service.createNote({ bookId: otherBookId, title: 'Second target Page' });
        const firstChapterId = createChapterForBook(otherBookId, 'First target Chapter');
        const secondChapterId = createChapterForBook(otherBookId, 'Second target Chapter');
        bookContentRepository.append(otherBookId, 'chapter', firstChapterId);
        bookContentRepository.append(otherBookId, 'chapter', secondChapterId);
        targetItems = [
          { type: 'chapter', id: firstChapterId },
          { type: 'page', id: firstPage.id },
          { type: 'chapter', id: secondChapterId },
          { type: 'page', id: secondPage.id },
        ];
        bookContentRepository.reorder(otherBookId, targetItems);
      }

      const moving = createDirectNote({ title: 'Target ordering source' });
      const targetContentsBefore = bookContentRepository.listForBook(otherBookId);

      service.moveNote(moving.id, { bookId: otherBookId });

      const expectedItems = [
        ...targetItems,
        { type: 'page', id: moving.id },
      ];
      expect(bookContentRepository.listForBook(otherBookId)).toEqual(
        expectedItems.map(({ type, id }, sort_order) => ({
          book_id: otherBookId,
          item_type: type,
          item_id: id,
          sort_order,
        }))
      );
      expect(bookContentRepository.listForBook(otherBookId)).toHaveLength(targetContentsBefore.length + 1);
    });

  it('rolls back a direct Book Page move when source membership removal fails', () => {
    const otherBookId = createBook();
    const moving = createDirectNote({ title: 'Removal failure' });
    const sourceBefore = bookContentRepository.listForBook(bookId);
    const targetBefore = bookContentRepository.listForBook(otherBookId);
    const beforeNote = noteRepository.findById(moving.id);
    const originalRemove = bookContentRepository.remove;
    const remove = vi.spyOn(bookContentRepository, 'remove').mockImplementation((...args) => {
      expect(args).toEqual([bookId, 'page', moving.id]);
      expect(originalRemove(...args)).toBe(true);
      throw new Error('forced direct-to-direct membership removal failure');
    });
    const append = vi.spyOn(bookContentRepository, 'append');

    expect(() => service.moveNote(moving.id, { bookId: otherBookId }))
      .toThrow('forced direct-to-direct membership removal failure');

    expect(remove).toHaveBeenCalledWith(bookId, 'page', moving.id);
    expect(append).not.toHaveBeenCalled();
    expect(noteRepository.findById(moving.id)).toEqual(beforeNote);
    expect(bookContentRepository.listForBook(bookId)).toEqual(sourceBefore);
    expect(bookContentRepository.listForBook(otherBookId)).toEqual(targetBefore);
  });

  it('rolls back a direct Book Page move when source membership is missing', () => {
    const otherBookId = createBook();
    const moving = createDirectNote({ title: 'Missing source membership' });
    db.prepare(`
      DELETE FROM book_contents
      WHERE book_id = ? AND item_type = 'page' AND item_id = ?
    `).run(bookId, moving.id);
    const sourceBefore = bookContentRepository.listForBook(bookId);
    const targetBefore = bookContentRepository.listForBook(otherBookId);
    const beforeNote = noteRepository.findById(moving.id);

    let error;
    try {
      service.moveNote(moving.id, { bookId: otherBookId });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(NoteOperationError);
    expect(error.code).toBe('MEMBERSHIP_NOT_FOUND');
    expect(noteRepository.findById(moving.id)).toEqual(beforeNote);
    expect(bookContentRepository.listForBook(bookId)).toEqual(sourceBefore);
    expect(bookContentRepository.listForBook(otherBookId)).toEqual(targetBefore);
  });

  it('rolls back a direct Book Page move when target membership append fails', () => {
    const otherBookId = createBook();
    const moving = createDirectNote({ title: 'Append failure' });
    const targetPage = service.createNote({ bookId: otherBookId, title: 'Existing target Page' });
    const sourceBefore = bookContentRepository.listForBook(bookId);
    const targetBefore = bookContentRepository.listForBook(otherBookId);
    const beforeNote = noteRepository.findById(moving.id);
    const originalAppend = bookContentRepository.append;
    const append = vi.spyOn(bookContentRepository, 'append').mockImplementation((...args) => {
      expect(args).toEqual([otherBookId, 'page', moving.id]);
      expect(originalAppend(...args)).toMatchObject({
        book_id: otherBookId,
        item_type: 'page',
        item_id: moving.id,
      });
      throw new Error('forced direct-to-direct membership append failure');
    });

    expect(() => service.moveNote(moving.id, { bookId: otherBookId }))
      .toThrow('forced direct-to-direct membership append failure');

    expect(append).toHaveBeenCalledWith(otherBookId, 'page', moving.id);
    expect(noteRepository.findById(moving.id)).toEqual(beforeNote);
    expect(bookContentRepository.listForBook(bookId)).toEqual(sourceBefore);
    expect(bookContentRepository.listForBook(otherBookId)).toEqual(targetBefore);
    expect(bookContentRepository.listForBook(otherBookId)).toContainEqual({
      book_id: otherBookId,
      item_type: 'page',
      item_id: targetPage.id,
      sort_order: 0,
    });
  });

  it('rolls back a direct Book Page move when target membership is already duplicated', () => {
    const otherBookId = createBook();
    const moving = createDirectNote({ title: 'Duplicate target membership' });
    bookContentRepository.append(otherBookId, 'page', moving.id);
    const sourceBefore = bookContentRepository.listForBook(bookId);
    const targetBefore = bookContentRepository.listForBook(otherBookId);
    const beforeNote = noteRepository.findById(moving.id);
    const append = vi.spyOn(bookContentRepository, 'append');

    expect(() => service.moveNote(moving.id, { bookId: otherBookId }))
      .toThrow(/already contains page/);

    expect(append).toHaveBeenCalledWith(otherBookId, 'page', moving.id);
    expect(noteRepository.findById(moving.id)).toEqual(beforeNote);
    expect(bookContentRepository.listForBook(bookId)).toEqual(sourceBefore);
    expect(bookContentRepository.listForBook(otherBookId)).toEqual(targetBefore);
  });

  it('leaves direct Page membership untouched when Note repository movement fails', () => {
    const otherBookId = createBook();
    const moving = createDirectNote({ title: 'Repository failure' });
    const sourceBefore = bookContentRepository.listForBook(bookId);
    const targetBefore = bookContentRepository.listForBook(otherBookId);
    const beforeNote = noteRepository.findById(moving.id);
    const originalMove = noteRepository.moveToContainer;
    const remove = vi.spyOn(bookContentRepository, 'remove');
    const append = vi.spyOn(bookContentRepository, 'append');
    vi.spyOn(noteRepository, 'moveToContainer').mockImplementation((...args) => {
      originalMove(...args);
      throw new Error('forced direct-to-direct repository movement failure');
    });

    expect(() => service.moveNote(moving.id, { bookId: otherBookId }))
      .toThrow('forced direct-to-direct repository movement failure');

    expect(noteRepository.findById(moving.id)).toEqual(beforeNote);
    expect(bookContentRepository.listForBook(bookId)).toEqual(sourceBefore);
    expect(bookContentRepository.listForBook(otherBookId)).toEqual(targetBefore);
    expect(remove).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('leaves a direct Page unchanged when the target Book does not exist', () => {
    const moving = createDirectNote({ title: 'Invalid target Book' });
    const sourceBefore = bookContentRepository.listForBook(bookId);
    const beforeNote = noteRepository.findById(moving.id);
    const moveToContainer = vi.spyOn(noteRepository, 'moveToContainer');
    const remove = vi.spyOn(bookContentRepository, 'remove');
    const append = vi.spyOn(bookContentRepository, 'append');

    expect(() => service.moveNote(moving.id, { bookId: MISSING_ID })).toThrow(BookNotFoundError);

    expect(noteRepository.findById(moving.id)).toEqual(beforeNote);
    expect(bookContentRepository.listForBook(bookId)).toEqual(sourceBefore);
    expect(moveToContainer).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('preserves same-Book direct movement semantics without changing membership', () => {
    const first = createDirectNote({ title: 'First direct Page' });
    const moving = createDirectNote({ title: 'Same Book move' });
    const last = createDirectNote({ title: 'Last direct Page' });
    bookContentRepository.append(bookId, 'chapter', chapterId);
    bookContentRepository.reorder(bookId, [
      { type: 'page', id: first.id },
      { type: 'chapter', id: chapterId },
      { type: 'page', id: moving.id },
      { type: 'page', id: last.id },
    ]);
    const beforeContents = bookContentRepository.listForBook(bookId);
    const moveToContainer = vi.spyOn(noteRepository, 'moveToContainer');
    const remove = vi.spyOn(bookContentRepository, 'remove');
    const append = vi.spyOn(bookContentRepository, 'append');

    const moved = service.moveNote(moving.id, { bookId });

    expect(moveToContainer).toHaveBeenCalledWith(moving.id, { bookId, chapterId: null });
    expect(moved).toEqual(noteRepository.findById(moving.id));
    expect(bookContentRepository.listForBook(bookId)).toEqual(beforeContents);
    expect(db.prepare(`
      SELECT *
      FROM book_contents
      WHERE book_id = ? AND item_type = 'page' AND item_id = ?
    `).all(bookId, moving.id)).toHaveLength(1);
    expect(remove).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('rejects a mismatched target Book and Chapter before moving', () => {
    const otherBookId = createBook();
    const created = createDirectNote({ title: 'Mismatched target' });
    const moveToContainer = vi.spyOn(noteRepository, 'moveToContainer');

    let error;
    try {
      service.moveNote(created.id, { bookId: otherBookId, chapterId });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(NoteValidationError);
    expect(error.code).toBe('BOOK_CHAPTER_MISMATCH');
    expect(moveToContainer).not.toHaveBeenCalled();
    expect(service.getNote(created.id)).toMatchObject({ book_id: bookId, chapter_id: null });
  });

  it.each([undefined, 0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    ('rejects invalid move noteId %p', (invalidNoteId) => {
      let error;
      try {
        service.moveNoteToChapter(invalidNoteId, chapterId);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(NoteValidationError);
      expect(error.errors).toEqual({ id: 'id must be a positive integer.' });
    });

  it('throws NoteNotFoundError when moving a missing Note', () => {
    const moveToContainer = vi.spyOn(noteRepository, 'moveToContainer');

    expect(() => service.moveNoteToChapter(MISSING_ID, chapterId)).toThrow(NoteNotFoundError);
    expect(moveToContainer).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    ('rejects invalid move targetChapterId %p', (invalidTargetChapterId) => {
      let error;
      try {
        service.moveNoteToChapter(createNote({ title: 'Source' }).id, invalidTargetChapterId);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(NoteValidationError);
      expect(error.errors).toEqual({
        targetChapterId: 'targetChapterId must be a positive integer.',
      });
    });

  it('throws ChapterNotFoundError for a missing move target before delegating', () => {
    const created = createNote({ title: 'Source' });
    const moveToContainer = vi.spyOn(noteRepository, 'moveToContainer');

    expect(() => service.moveNoteToChapter(created.id, MISSING_ID)).toThrow(ChapterNotFoundError);
    expect(moveToContainer).not.toHaveBeenCalled();
  });

  it('returns the unchanged Note for a same-Chapter move', () => {
    const created = createNote({ title: 'Stay here', content: 'No-op' });
    const before = noteRepository.findById(created.id);

    expect(service.moveNoteToChapter(created.id, chapterId)).toEqual(before);
    expect(noteRepository.findById(created.id)).toEqual(before);
  });

  it('translates a target Chapter race from the repository', () => {
    const created = createNote({ title: 'Race source' });
    const targetChapterId = chapterRepository.create({
      bookId: chapterRepository.findById(chapterId).book_id,
      title: 'Race target',
    }).id;
    vi.spyOn(noteRepository, 'moveToContainer').mockImplementationOnce(() => {
      throw new NoteError(`Chapter ${targetChapterId} does not exist.`, {
        code: 'TARGET_CHAPTER_NOT_FOUND',
      });
    });

    expect(() => service.moveNoteToChapter(created.id, targetChapterId)).toThrow(ChapterNotFoundError);
    expect(service.getNote(created.id).chapter_id).toBe(chapterId);
  });

  it('rolls back note fields and project associations when asset persistence fails', () => {
    const firstProjectId = createProject();
    const secondProjectId = createProject();
    const firstAssetId = createAsset(firstProjectId);
    const secondAssetId = createAsset(secondProjectId);
    const created = createNote({
      title: 'Before',
      content: 'original',
      projectIds: [firstProjectId],
      assetIds: [firstAssetId],
    });

    db.exec(`
      CREATE TRIGGER fail_note_asset_save
      BEFORE INSERT ON note_assets
      BEGIN
        SELECT RAISE(ABORT, 'forced note asset save failure');
      END
    `);

    expect(() => service.updateNote(created.id, {
      title: 'After',
      content: 'changed',
      projectIds: [secondProjectId],
      assetIds: [secondAssetId],
    })).toThrow(/forced note asset save failure/);

    expect(service.getNote(created.id)).toMatchObject({
      title: 'Before',
      content: 'original',
      projectIds: [firstProjectId],
      assetIds: [firstAssetId],
    });
  });
});
