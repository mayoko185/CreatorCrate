import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createNoteRepository, NoteError } from '../src/data/note-repository.js';
import { createChapterRepository } from '../src/data/chapter-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import {
  createNoteService,
  NOTE_TITLE_MAX,
  NoteNotFoundError,
  NoteValidationError,
} from '../src/services/note-service.js';
import { ChapterNotFoundError } from '../src/services/chapter-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MISSING_ID = 999999;

describe('note service', () => {
  let tmpDir;
  let db;
  let noteRepository;
  let chapterRepository;
  let projectRepository;
  let assetRepository;
  let service;
  let chapterId;
  let nextProjectNumber;
  let nextAssetNumber;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-note-service-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    noteRepository = createNoteRepository(db);
    chapterRepository = createChapterRepository(db);
    projectRepository = createProjectRepository(db);
    assetRepository = createAssetRepository(db);
    const bookId = Number(db.prepare(`
      INSERT INTO books (title, sort_order)
      VALUES ('Test book', 0)
    `).run().lastInsertRowid);
    chapterId = chapterRepository.create({ bookId, title: 'Test chapter' }).id;
    service = createNoteService({
      noteRepository,
      projectRepository,
      assetRepository,
      chapterRepository,
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

  it('requires chapterId on create', () => {
    expect(() => service.createNote({ title: 'Missing chapter' })).toThrow(NoteValidationError);
    expect(noteRepository.list()).toEqual([]);
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

  it('deletes a note and returns true', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);
    const created = createNote({ title: 'Delete me', projectIds: [projectId], assetIds: [assetId] });

    expect(service.deleteNote(created.id)).toBe(true);
    expect(noteRepository.findById(created.id)).toBeUndefined();
    expect(noteRepository.listProjectsForNote(created.id)).toEqual([]);
    expect(noteRepository.listAssetsForNote(created.id)).toEqual([]);
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
    const moveToChapter = vi.spyOn(noteRepository, 'moveToChapter');

    const moved = service.moveNoteToChapter(created.id, targetChapterId);

    expect(moveToChapter).toHaveBeenCalledWith(created.id, targetChapterId);
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
    const moveToChapter = vi.spyOn(noteRepository, 'moveToChapter');

    expect(() => service.moveNoteToChapter(MISSING_ID, chapterId)).toThrow(NoteNotFoundError);
    expect(moveToChapter).not.toHaveBeenCalled();
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
    const moveToChapter = vi.spyOn(noteRepository, 'moveToChapter');

    expect(() => service.moveNoteToChapter(created.id, MISSING_ID)).toThrow(ChapterNotFoundError);
    expect(moveToChapter).not.toHaveBeenCalled();
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
    vi.spyOn(noteRepository, 'moveToChapter').mockImplementationOnce(() => {
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
