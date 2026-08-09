import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createNoteRepository } from '../src/data/note-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import {
  createNoteService,
  NOTE_TITLE_MAX,
  NoteNotFoundError,
  NoteValidationError,
} from '../src/services/note-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MISSING_ID = 999999;

describe('note service', () => {
  let tmpDir;
  let db;
  let noteRepository;
  let projectRepository;
  let assetRepository;
  let service;
  let nextProjectNumber;
  let nextAssetNumber;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-note-service-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    noteRepository = createNoteRepository(db);
    projectRepository = createProjectRepository(db);
    assetRepository = createAssetRepository(db);
    service = createNoteService({ noteRepository, projectRepository, assetRepository });
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

  it('requires note, project, and asset repository dependencies', () => {
    expect(() => createNoteService()).toThrow(
      'createNoteService requires a noteRepository dependency.'
    );
    expect(() => createNoteService({ noteRepository })).toThrow(
      'createNoteService requires a projectRepository dependency.'
    );
    expect(() => createNoteService({ noteRepository, projectRepository })).toThrow(
      'createNoteService requires an assetRepository dependency.'
    );
  });

  it('creates a note with a normalized title and plain Markdown content', () => {
    const note = service.createNote({
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

  it('creates a note with project associations', () => {
    const projectId = createProject();

    const note = service.createNote({ title: 'Project note', projectIds: [projectId] });

    expect(note.projectIds).toEqual([projectId]);
    expect(note.assetIds).toEqual([]);
  });

  it('creates a note with asset associations', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);

    const note = service.createNote({ title: 'Asset note', assetIds: [assetId] });

    expect(note.projectIds).toEqual([]);
    expect(note.assetIds).toEqual([assetId]);
  });

  it('supports mixed independent project and asset associations', () => {
    const projectId = createProject();
    const unrelatedProjectId = createProject();
    const assetId = createAsset(projectId);

    const note = service.createNote({
      title: 'Mixed note',
      projectIds: [unrelatedProjectId],
      assetIds: [assetId],
    });

    expect(note.projectIds).toEqual([unrelatedProjectId]);
    expect(note.assetIds).toEqual([assetId]);
    expect(note.projectIds).not.toContain(projectId);
  });

  it('accepts explicit empty association arrays', () => {
    const note = service.createNote({ title: 'Unlinked note', projectIds: [], assetIds: [] });

    expect(note.projectIds).toEqual([]);
    expect(note.assetIds).toEqual([]);
  });

  it('deduplicates association IDs while preserving first-seen order', () => {
    const p1 = createProject();
    const p2 = createProject();
    const a1 = createAsset(p1);
    const a2 = createAsset(p2);

    const note = service.createNote({
      title: 'Deduplicated note',
      projectIds: [p2, p2, p1, p1],
      assetIds: [a2, a2, a1, a1],
    });

    expect(note.projectIds).toEqual([p1, p2]);
    expect(note.assetIds).toEqual([a1, a2]);
  });

  it.each([undefined, null, 123, [], {}])('rejects invalid title input %p', (title) => {
    expect(() => service.createNote({ title, content: '' })).toThrow(NoteValidationError);
    expect(noteRepository.list()).toEqual([]);
  });

  it('rejects an empty or overlong title', () => {
    expect(() => service.createNote({ title: '   ' })).toThrow(NoteValidationError);
    expect(() => service.createNote({ title: 'x'.repeat(NOTE_TITLE_MAX + 1) }))
      .toThrow(NoteValidationError);
    expect(noteRepository.list()).toEqual([]);
  });

  it.each([null, 123, [], {}])('rejects non-string content input %p', (content) => {
    expect(() => service.createNote({ title: 'Valid title', content })).toThrow(NoteValidationError);
    expect(noteRepository.list()).toEqual([]);
  });

  it('rejects scalar association input instead of coercing it', () => {
    expect(() => service.createNote({ title: 'Invalid associations', projectIds: 1 }))
      .toThrow(NoteValidationError);
    expect(() => service.createNote({ title: 'Invalid associations', assetIds: 1 }))
      .toThrow(NoteValidationError);
    expect(noteRepository.list()).toEqual([]);
  });

  it.each([0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    ('rejects invalid project ID %p', (projectId) => {
      expect(() => service.createNote({ title: 'Invalid project', projectIds: [projectId] }))
        .toThrow(NoteValidationError);
      expect(noteRepository.list()).toEqual([]);
    });

  it.each([0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    ('rejects invalid asset ID %p', (assetId) => {
      expect(() => service.createNote({ title: 'Invalid asset', assetIds: [assetId] }))
        .toThrow(NoteValidationError);
      expect(noteRepository.list()).toEqual([]);
    });

  it('rejects a nonexistent project reference before persistence', () => {
    expect(() => service.createNote({ title: 'Missing project', projectIds: [MISSING_ID] }))
      .toThrow(NoteValidationError);

    expect(noteRepository.list()).toEqual([]);
  });

  it('rejects a nonexistent asset reference before persistence', () => {
    expect(() => service.createNote({ title: 'Missing asset', assetIds: [MISSING_ID] }))
      .toThrow(NoteValidationError);

    expect(noteRepository.list()).toEqual([]);
  });

  it('returns note details with project and asset association IDs', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);
    const created = service.createNote({ title: 'Detail', projectIds: [projectId], assetIds: [assetId] });

    expect(service.getNote(created.id)).toEqual(created);
  });

  it('throws NoteNotFoundError for missing detail, update, and delete operations', () => {
    expect(() => service.getNote(MISSING_ID)).toThrow(NoteNotFoundError);
    expect(() => service.updateNote(MISSING_ID, { title: 'Missing' })).toThrow(NoteNotFoundError);
    expect(() => service.deleteNote(MISSING_ID)).toThrow(NoteNotFoundError);
  });

  it('updates title and content', () => {
    const created = service.createNote({ title: 'Before', content: 'before' });

    const updated = service.updateNote(created.id, {
      title: '  After  ',
      content: 'after\n',
    });

    expect(updated).toMatchObject({
      id: created.id,
      title: 'After',
      content: 'after\n',
      projectIds: [],
      assetIds: [],
    });
  });

  it('replaces associations on update and allows independent sets', () => {
    const firstProjectId = createProject();
    const secondProjectId = createProject();
    const firstAssetId = createAsset(firstProjectId);
    const secondAssetId = createAsset(secondProjectId);
    const created = service.createNote({
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
    const created = service.createNote({
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
    const created = service.createNote({
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
    const created = service.createNote({
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

    expect(() => service.createNote({
      title: 'Should not persist',
      content: 'body',
      projectIds: [projectId],
      assetIds: [assetId, MISSING_ID],
    })).toThrow(NoteValidationError);

    expect(noteRepository.list()).toEqual([]);
    expect(noteRepository.listProjectsForNote(1)).toEqual([]);
    expect(noteRepository.listAssetsForNote(1)).toEqual([]);
  });

  it('deletes a note and returns true', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId);
    const created = service.createNote({ title: 'Delete me', projectIds: [projectId], assetIds: [assetId] });

    expect(service.deleteNote(created.id)).toBe(true);
    expect(noteRepository.findById(created.id)).toBeUndefined();
    expect(noteRepository.listProjectsForNote(created.id)).toEqual([]);
    expect(noteRepository.listAssetsForNote(created.id)).toEqual([]);
  });

  it('preserves canonical global list ordering', () => {
    const first = service.createNote({ title: 'First' });
    const second = service.createNote({ title: 'Second' });
    const third = service.createNote({ title: 'Third' });

    expect(service.listNotes().map((note) => note.id)).toEqual([first.id, second.id, third.id]);
    expect(service.listNotes().map((note) => note.title)).toEqual(['First', 'Second', 'Third']);
  });

  it('reorders notes through the repository and returns canonical order', () => {
    const first = service.createNote({ title: 'First' });
    const second = service.createNote({ title: 'Second' });
    const third = service.createNote({ title: 'Third' });
    const orderedIds = [third.id, first.id, second.id];

    const reordered = service.reorderNotes(orderedIds);

    expect(reordered.map((note) => note.id)).toEqual(orderedIds);
    expect(reordered.map((note) => note.sort_order)).toEqual([0, 1, 2]);
    expect(service.listNotes().map((note) => note.id)).toEqual(orderedIds);
  });

  it('translates reorder validation failures into NoteValidationError', () => {
    const first = service.createNote({ title: 'First' });
    const second = service.createNote({ title: 'Second' });

    expect(() => service.reorderNotes('not an array')).toThrow(NoteValidationError);
    expect(() => service.reorderNotes([first.id, first.id])).toThrow(NoteValidationError);
    expect(() => service.reorderNotes([first.id])).toThrow(NoteValidationError);
    expect(() => service.reorderNotes([first.id, MISSING_ID])).toThrow(NoteValidationError);
    expect(service.listNotes().map((note) => note.id)).toEqual([first.id, second.id]);
  });

  it('translates a repository reorder validation error without exposing it', () => {
    const first = service.createNote({ title: 'First' });
    const second = service.createNote({ title: 'Second' });
    vi.spyOn(noteRepository, 'reorder').mockImplementation(() => {
      const error = new Error('repository detail');
      error.code = 'INVALID_SEQUENCE_LENGTH';
      throw error;
    });

    let error;
    try {
      service.reorderNotes([second.id, first.id]);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(NoteValidationError);
    expect(error.errors.orderedIds).toBeTruthy();
    expect(error.message).not.toContain('repository detail');
  });

  it('rolls back note fields and project associations when asset persistence fails', () => {
    const firstProjectId = createProject();
    const secondProjectId = createProject();
    const firstAssetId = createAsset(firstProjectId);
    const secondAssetId = createAsset(secondProjectId);
    const created = service.createNote({
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
