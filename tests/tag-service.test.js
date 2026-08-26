import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createTagRepository } from '../src/data/tag-repository.js';
import { createApplicationLogRepository } from '../src/data/application-log-repository.js';
import { createApplicationLogger } from '../src/services/application-logger.js';
import {
  createTagService,
  isDuplicateTagNameError,
  TAG_NAME_MAX,
  TagNotFoundError,
  TagValidationError,
} from '../src/services/tag-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('tag service', () => {
  let tmpDir;
  let db;
  let repository;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-tag-service-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    repository = createTagRepository(db);
    service = createTagService({ tagRepository: repository });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createProject(title = 'Tag Service Project') {
    return Number(db.prepare(`
      INSERT INTO projects (
        title, slug, description, notes, status,
        planned_date, published_date, patreon_url
      ) VALUES (?, ?, '', '', 'tbd', NULL, NULL, NULL)
    `).run(title, title.toLowerCase().replaceAll(' ', '-')).lastInsertRowid);
  }

  function createAsset(projectId, relativePath) {
    const filename = relativePath.split('/').pop();
    return Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename)
      VALUES (?, ?, ?)
    `).run(projectId, relativePath, filename).lastInsertRowid);
  }

  function makeFakeRepository(overrides = {}) {
    return {
      list: vi.fn(() => []),
      findById: vi.fn(() => ({
        id: 1,
        display_name: 'Existing',
        normalized_name: 'existing',
      })),
      create: vi.fn((values) => ({ id: 1, ...values })),
      update: vi.fn((id, values) => ({ id, ...values })),
      deleteById: vi.fn(() => true),
      ...overrides,
    };
  }

  function expectNameValidation(callback, expectedMessage = undefined) {
    try {
      callback();
      throw new Error('expected tag validation to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TagValidationError);
      expect(error.errors.name).toBeTruthy();
      if (expectedMessage) expect(error.errors.name).toBe(expectedMessage);
    }
  }

  it('requires an injected tag repository', () => {
    expect(() => createTagService()).toThrow(
      'createTagService requires a tagRepository dependency.'
    );
  });

  it('lists an empty catalog without adding metadata', () => {
    expect(service.listTags()).toEqual([]);
  });

  it('returns the repository list unchanged in deterministic repository order', () => {
    const tags = [
      { id: 2, display_name: 'Alpha', normalized_name: 'alpha' },
      { id: 1, display_name: 'beta', normalized_name: 'beta' },
    ];
    const fakeRepository = makeFakeRepository({ list: vi.fn(() => tags) });
    const fakeService = createTagService({ tagRepository: fakeRepository });

    expect(fakeService.listTags()).toBe(tags);
    expect(fakeRepository.list).toHaveBeenCalledTimes(1);
  });

  it('gets an existing tag through the repository', () => {
    const tag = service.createTag({ name: 'Existing' });

    expect(service.getTag(tag.id)).toEqual(tag);
  });

  it('throws TagNotFoundError when getting a missing tag', () => {
    expect(() => service.getTag(999999)).toThrow(TagNotFoundError);
  });

  it('lists real repository rows in deterministic catalog order', () => {
    repository.create({ displayName: 'beta', normalizedName: 'beta' });
    repository.create({ displayName: 'Alpha', normalizedName: 'alpha' });
    repository.create({ displayName: 'alpha', normalizedName: 'alpha-a' });

    expect(service.listTags().map((tag) => tag.display_name)).toEqual([
      'Alpha',
      'alpha',
      'beta',
    ]);
  });

  it('trims outer whitespace, preserves display capitalization, and normalizes before repository create', () => {
    const fakeRepository = makeFakeRepository();
    const fakeService = createTagService({ tagRepository: fakeRepository });

    fakeService.createTag({ name: '  Landscape  ' });

    expect(fakeRepository.create).toHaveBeenCalledWith({
      displayName: 'Landscape',
      normalizedName: 'landscape',
    });
  });

  it('preserves internal repeated whitespace while normalizing case', () => {
    const fakeRepository = makeFakeRepository();
    const fakeService = createTagService({ tagRepository: fakeRepository });

    fakeService.createTag({ name: '  Client  Draft / 日本語!  ' });

    expect(fakeRepository.create).toHaveBeenCalledWith({
      displayName: 'Client  Draft / 日本語!',
      normalizedName: 'client  draft / 日本語!',
    });
  });

  it('rejects a case-only duplicate through the real normalized-name constraint', () => {
    service.createTag({ name: 'Landscape' });

    let error;
    try {
      service.createTag({ name: ' LANDSCAPE ' });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TagValidationError);
    expect(error.errors).toEqual({ name: 'A tag with this name already exists.' });
    expect(service.listTags()).toHaveLength(1);
  });

  it.each([undefined, null, '', '   '])('rejects missing or whitespace-only name %p', (name) => {
    expectNameValidation(() => service.createTag({ name }));
    expect(service.listTags()).toEqual([]);
  });

  it('rejects non-string form input instead of coercing arbitrary values', () => {
    const fakeRepository = makeFakeRepository();
    const fakeService = createTagService({ tagRepository: fakeRepository });

    expectNameValidation(() => fakeService.createTag({ name: 123 }));
    expect(fakeRepository.create).not.toHaveBeenCalled();
  });

  it('accepts the maximum-length boundary', () => {
    const name = 'x'.repeat(TAG_NAME_MAX);
    const tag = service.createTag({ name });

    expect(tag.display_name).toBe(name);
    expect(tag.normalized_name).toBe(name);
  });

  it('rejects names over the maximum length with a field error', () => {
    expectNameValidation(
      () => service.createTag({ name: 'x'.repeat(TAG_NAME_MAX + 1) }),
      `Tag name must be ${TAG_NAME_MAX} characters or fewer.`,
    );
    expect(service.listTags()).toEqual([]);
  });

  it('accepts ordinary spaces, punctuation, Unicode, and mixed capitalization', () => {
    const tag = service.createTag({ name: "  Client's Café 日本語 #1!  " });

    expect(tag).toMatchObject({
      display_name: "Client's Café 日本語 #1!",
      normalized_name: "client's café 日本語 #1!",
    });
  });

  it('rejects an invalid input object before repository access', () => {
    const fakeRepository = makeFakeRepository();
    const fakeService = createTagService({ tagRepository: fakeRepository });

    expect(() => fakeService.createTag(null)).toThrow(TagValidationError);
    expect(fakeRepository.create).not.toHaveBeenCalled();
  });

  it('renames a tag while preserving its ID, creation timestamp, and assignments', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId, 'source/cover.png');
    const tag = service.createTag({ name: 'Landscape' });
    db.prepare(`
      UPDATE tags
      SET created_at = '2020-01-01 00:00:00', updated_at = '2020-01-01 00:00:00'
      WHERE id = ?
    `).run(tag.id);
    db.prepare('INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)').run(projectId, tag.id);
    db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(assetId, tag.id);

    const renamed = service.renameTag(tag.id, { name: 'Published Landscape' });

    expect(renamed).toMatchObject({
      id: tag.id,
      display_name: 'Published Landscape',
      normalized_name: 'published landscape',
      created_at: '2020-01-01 00:00:00',
    });
    expect(db.prepare('SELECT project_id, tag_id FROM project_tags WHERE tag_id = ?').all(tag.id))
      .toEqual([{ project_id: projectId, tag_id: tag.id }]);
    expect(db.prepare('SELECT asset_id, tag_id FROM asset_tags WHERE tag_id = ?').all(tag.id))
      .toEqual([{ asset_id: assetId, tag_id: tag.id }]);
  });

  it('allows a capitalization-only rename of the same tag', () => {
    const tag = service.createTag({ name: 'Landscape' });

    const renamed = service.renameTag(tag.id, { name: ' LANDSCAPE ' });

    expect(renamed).toMatchObject({
      id: tag.id,
      display_name: 'LANDSCAPE',
      normalized_name: 'landscape',
    });
    expect(service.listTags()).toHaveLength(1);
  });

  it('logs a capitalization-only rename after persisting its display-name change', () => {
    const applicationLogger = { info: vi.fn() };
    const tag = service.createTag({ name: 'Landscape' });
    const loggingService = createTagService({ tagRepository: repository, applicationLogger });

    const renamed = loggingService.renameTag(tag.id, { name: ' LANDSCAPE ' });

    expect(renamed.display_name).toBe('LANDSCAPE');
    expect(applicationLogger.info).toHaveBeenCalledOnce();
    expect(applicationLogger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'tag.renamed',
      context: { tagId: tag.id },
    }));
  });

  it('does not log a true semantic no-op rename', () => {
    const applicationLogger = { info: vi.fn() };
    const tag = service.createTag({ name: 'Landscape' });
    const loggingService = createTagService({ tagRepository: repository, applicationLogger });

    loggingService.renameTag(tag.id, { name: ' Landscape ' });

    expect(applicationLogger.info).not.toHaveBeenCalled();
  });

  it('logs an ordinary rename', () => {
    const applicationLogger = { info: vi.fn() };
    const tag = service.createTag({ name: 'Landscape' });
    const loggingService = createTagService({ tagRepository: repository, applicationLogger });

    loggingService.renameTag(tag.id, { name: 'Published Landscape' });

    expect(applicationLogger.info).toHaveBeenCalledOnce();
    expect(applicationLogger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'tag.renamed',
      context: { tagId: tag.id },
    }));
  });

  it('does not log a failed rename', () => {
    const applicationLogger = { info: vi.fn() };
    const fakeRepository = makeFakeRepository({
      update: vi.fn(() => { throw new Error('Database unavailable'); }),
    });
    const failingService = createTagService({ tagRepository: fakeRepository, applicationLogger });

    expect(() => failingService.renameTag(1, { name: 'Renamed' })).toThrow('Database unavailable');
    expect(applicationLogger.info).not.toHaveBeenCalled();
  });

  it('keeps a successful rename successful when activity logging fails', () => {
    const tag = service.createTag({ name: 'Landscape' });
    const applicationLogger = { info: vi.fn(() => { throw new Error('Log sink unavailable'); }) };
    const loggingService = createTagService({ tagRepository: repository, applicationLogger });

    expect(loggingService.renameTag(tag.id, { name: 'Published Landscape' })).toMatchObject({
      display_name: 'Published Landscape',
    });
  });

  it('persists a capitalization-only rename through the real application logger', () => {
    const applicationLogRepository = createApplicationLogRepository(db);
    const applicationLogger = createApplicationLogger({ repository: applicationLogRepository });
    const tag = service.createTag({ name: 'Landscape' });
    const loggingService = createTagService({ tagRepository: repository, applicationLogger });

    loggingService.renameTag(tag.id, { name: ' LANDSCAPE ' });

    expect(applicationLogRepository.findPage().filter((record) => record.event === 'tag.renamed')).toEqual([
      expect.objectContaining({ context_json: JSON.stringify({ tagId: tag.id }) }),
    ]);
  });

  it('rejects a rename collision without modifying either tag', () => {
    const first = service.createTag({ name: 'First' });
    const second = service.createTag({ name: 'Second' });
    const firstBefore = repository.findById(first.id);
    const secondBefore = repository.findById(second.id);

    expectNameValidation(() => service.renameTag(first.id, { name: ' second ' }), 'A tag with this name already exists.');

    expect(repository.findById(first.id)).toEqual(firstBefore);
    expect(repository.findById(second.id)).toEqual(secondBefore);
  });

  it('validates a rename name before looking up the tag', () => {
    const fakeRepository = makeFakeRepository({ findById: vi.fn(() => undefined) });
    const fakeService = createTagService({ tagRepository: fakeRepository });

    expectNameValidation(() => fakeService.renameTag(404, { name: '   ' }));
    expect(fakeRepository.findById).not.toHaveBeenCalled();
  });

  it('distinguishes a missing tag during rename', () => {
    expect(() => service.renameTag(999999, { name: 'Missing' })).toThrow(TagNotFoundError);
    expect(repository.list()).toEqual([]);
  });

  it('deletes an existing tag and returns a successful result', () => {
    const tag = service.createTag({ name: 'Temporary' });

    expect(service.deleteTag(tag.id)).toBe(true);
    expect(repository.findById(tag.id)).toBeUndefined();
  });

  it('distinguishes a missing tag during delete', () => {
    expect(() => service.deleteTag(999999)).toThrow(TagNotFoundError);
  });

  it('deletes project and asset assignments through cascades without deleting owners', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId, 'source/cover.png');
    const deleted = service.createTag({ name: 'Deleted' });
    const retained = service.createTag({ name: 'Retained' });
    db.prepare('INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)').run(projectId, deleted.id);
    db.prepare('INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)').run(projectId, retained.id);
    db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(assetId, deleted.id);
    db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(assetId, retained.id);

    expect(service.deleteTag(deleted.id)).toBe(true);

    expect(db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)).toEqual({ id: projectId });
    expect(db.prepare('SELECT id FROM assets WHERE id = ?').get(assetId)).toEqual({ id: assetId });
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_tags WHERE tag_id = ?').get(deleted.id).count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM asset_tags WHERE tag_id = ?').get(deleted.id).count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_tags WHERE tag_id = ?').get(retained.id).count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM asset_tags WHERE tag_id = ?').get(retained.id).count).toBe(1);
  });

  it('does not mislabel an unrelated SQLite uniqueness error as a duplicate tag name', () => {
    const unexpected = Object.assign(new Error('UNIQUE constraint failed: another_table.name'), {
      code: 'SQLITE_CONSTRAINT_UNIQUE',
    });
    const fakeRepository = makeFakeRepository({ create: vi.fn(() => { throw unexpected; }) });
    const fakeService = createTagService({ tagRepository: fakeRepository });

    expect(() => fakeService.createTag({ name: 'Unexpected' })).toThrow(unexpected);
    expect(isDuplicateTagNameError(unexpected)).toBe(false);
  });

  it('recognizes only the intended tag normalized-name SQLite error shape', () => {
    expect(isDuplicateTagNameError({
      code: 'SQLITE_CONSTRAINT_UNIQUE',
      message: 'UNIQUE constraint failed: tags.normalized_name',
    })).toBe(true);
    expect(isDuplicateTagNameError({
      code: 'SQLITE_CONSTRAINT_UNIQUE',
      message: 'UNIQUE constraint failed: tags.display_name',
    })).toBe(false);
    expect(isDuplicateTagNameError({
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
      message: 'UNIQUE constraint failed: tags.normalized_name',
    })).toBe(false);
  });
});
