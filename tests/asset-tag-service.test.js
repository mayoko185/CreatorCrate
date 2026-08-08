import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createTagRepository } from '../src/data/tag-repository.js';
import {
  createAssetTagService,
  AssetNotFoundError,
  AssetTagValidationError,
  TagNotFoundError,
} from '../src/services/asset-tag-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MISSING_ID = 999999;
const INVALID_IDS = [
  undefined,
  null,
  0,
  -1,
  1.5,
  '1',
  'malformed',
  NaN,
  Infinity,
  Number.MAX_SAFE_INTEGER + 1,
];

describe('asset tag service', () => {
  let tmpDir;
  let db;
  let assetRepository;
  let tagRepository;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-tag-service-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    assetRepository = createAssetRepository(db);
    tagRepository = createTagRepository(db);
    service = createAssetTagService({ tagRepository, assetRepository });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createProject(title = 'Asset Tag Service Project') {
    return Number(db.prepare(`
      INSERT INTO projects (
        title, slug, description, notes, status,
        planned_date, published_date, patreon_url
      ) VALUES (?, ?, '', '', 'tbd', NULL, NULL, NULL)
    `).run(title, title.toLowerCase().replaceAll(' ', '-')).lastInsertRowid);
  }

  function createAsset(projectId, relativePath = 'source/cover.png') {
    const filename = relativePath.split('/').pop();
    return Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename)
      VALUES (?, ?, ?)
    `).run(projectId, relativePath, filename).lastInsertRowid);
  }

  function createTag(displayName, normalizedName = displayName.toLowerCase()) {
    return tagRepository.create({ displayName, normalizedName });
  }

  function markAssetMissing(assetId) {
    db.prepare(`
      UPDATE assets
      SET is_present = 0, missing_since = datetime('now')
      WHERE id = ?
    `).run(assetId);
  }

  function assignmentRows(assetId) {
    return db.prepare(`
      SELECT asset_id, tag_id, created_at
      FROM asset_tags
      WHERE asset_id = ?
      ORDER BY tag_id
    `).all(assetId);
  }

  function snapshot(assetId) {
    return {
      asset: assetRepository.findById(assetId),
      tags: tagRepository.list(),
      assignments: assignmentRows(assetId),
    };
  }

  it('requires both repositories', () => {
    expect(() => createAssetTagService()).toThrow(
      'createAssetTagService requires a tagRepository dependency.'
    );
    expect(() => createAssetTagService({ tagRepository })).toThrow(
      'createAssetTagService requires an assetRepository dependency.'
    );
  });

  it('returns an empty list for an existing asset with no tags', () => {
    const assetId = createAsset(createProject());

    expect(service.listAssetTags(assetId)).toEqual([]);
  });

  it('throws AssetNotFoundError when listing a missing asset', () => {
    expect(() => service.listAssetTags(MISSING_ID)).toThrow(AssetNotFoundError);
  });

  it('preserves repository ordering when listing asset tags', () => {
    const assetId = createAsset(createProject());
    const beta = createTag('beta', 'beta-z');
    const upperBeta = createTag('Beta', 'beta-a');
    const alpha = createTag('Alpha');

    for (const tag of [beta, alpha, upperBeta]) {
      tagRepository.assignToAsset(assetId, tag.id);
    }

    expect(service.listAssetTags(assetId)).toEqual([alpha, upperBeta, beta]);
  });

  it('assigns a tag once and returns false for a duplicate assignment', () => {
    const assetId = createAsset(createProject());
    const tag = createTag('Character Art');
    const assetBefore = assetRepository.findById(assetId);
    const tagsBefore = tagRepository.list();

    expect(service.assignTagToAsset(assetId, tag.id)).toBe(true);
    expect(service.assignTagToAsset(assetId, tag.id)).toBe(false);
    expect(service.listAssetTags(assetId)).toEqual([tag]);
    expect(assetRepository.findById(assetId)).toEqual(assetBefore);
    expect(tagRepository.list()).toEqual(tagsBefore);
  });

  it('rejects invalid asset IDs before assignment mutation', () => {
    const assetId = createAsset(createProject());
    const tag = createTag('Existing');
    const before = snapshot(assetId);
    const assetFind = vi.spyOn(assetRepository, 'findById');
    const assign = vi.spyOn(tagRepository, 'assignToAsset');
    const remove = vi.spyOn(tagRepository, 'removeFromAsset');
    const replace = vi.spyOn(tagRepository, 'replaceForAsset');

    for (const invalidAssetId of INVALID_IDS) {
      expect(() => service.listAssetTags(invalidAssetId)).toThrow(AssetTagValidationError);
      expect(() => service.assignTagToAsset(invalidAssetId, tag.id))
        .toThrow(AssetTagValidationError);
      expect(() => service.removeTagFromAsset(invalidAssetId, tag.id))
        .toThrow(AssetTagValidationError);
      expect(() => service.replaceAssetTags(invalidAssetId, [tag.id]))
        .toThrow(AssetTagValidationError);
    }

    expect(assetFind).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(snapshot(assetId)).toEqual(before);
  });

  it('rejects invalid tag IDs before assignment mutation', () => {
    const assetId = createAsset(createProject());
    const existingTag = createTag('Existing');
    tagRepository.assignToAsset(assetId, existingTag.id);
    const before = snapshot(assetId);
    const assign = vi.spyOn(tagRepository, 'assignToAsset');
    const remove = vi.spyOn(tagRepository, 'removeFromAsset');
    const replace = vi.spyOn(tagRepository, 'replaceForAsset');

    for (const invalidTagId of INVALID_IDS) {
      expect(() => service.assignTagToAsset(assetId, invalidTagId))
        .toThrow(AssetTagValidationError);
      expect(() => service.removeTagFromAsset(assetId, invalidTagId))
        .toThrow(AssetTagValidationError);
      expect(() => service.replaceAssetTags(assetId, [invalidTagId]))
        .toThrow(AssetTagValidationError);
    }

    expect(assign).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(snapshot(assetId)).toEqual(before);
  });

  it('rejects a missing asset for every method without changing existing data', () => {
    const existingAssetId = createAsset(createProject());
    const tag = createTag('Existing');
    tagRepository.assignToAsset(existingAssetId, tag.id);
    const before = snapshot(existingAssetId);
    const assign = vi.spyOn(tagRepository, 'assignToAsset');
    const remove = vi.spyOn(tagRepository, 'removeFromAsset');
    const replace = vi.spyOn(tagRepository, 'replaceForAsset');

    expect(() => service.listAssetTags(MISSING_ID)).toThrow(AssetNotFoundError);
    expect(() => service.assignTagToAsset(MISSING_ID, tag.id)).toThrow(AssetNotFoundError);
    expect(() => service.removeTagFromAsset(MISSING_ID, tag.id)).toThrow(AssetNotFoundError);
    expect(() => service.replaceAssetTags(MISSING_ID, [tag.id])).toThrow(AssetNotFoundError);

    expect(assign).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(snapshot(existingAssetId)).toEqual(before);
  });

  it('rejects a missing tag for assignment, removal, and replacement without changes', () => {
    const assetId = createAsset(createProject());
    const existingTag = createTag('Existing');
    tagRepository.assignToAsset(assetId, existingTag.id);
    const before = snapshot(assetId);
    const assign = vi.spyOn(tagRepository, 'assignToAsset');
    const remove = vi.spyOn(tagRepository, 'removeFromAsset');
    const replace = vi.spyOn(tagRepository, 'replaceForAsset');

    expect(() => service.assignTagToAsset(assetId, MISSING_ID)).toThrow(TagNotFoundError);
    expect(() => service.removeTagFromAsset(assetId, MISSING_ID)).toThrow(TagNotFoundError);
    expect(() => service.replaceAssetTags(assetId, [existingTag.id, MISSING_ID]))
      .toThrow(TagNotFoundError);

    expect(assign).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(snapshot(assetId)).toEqual(before);
  });

  it('removes an assigned tag and returns false when it is not assigned', () => {
    const assetId = createAsset(createProject());
    const tag = createTag('Temporary');
    tagRepository.assignToAsset(assetId, tag.id);
    const assetBefore = assetRepository.findById(assetId);
    const tagsBefore = tagRepository.list();

    expect(service.removeTagFromAsset(assetId, tag.id)).toBe(true);
    expect(service.removeTagFromAsset(assetId, tag.id)).toBe(false);
    expect(service.listAssetTags(assetId)).toEqual([]);
    expect(assetRepository.findById(assetId)).toEqual(assetBefore);
    expect(tagRepository.list()).toEqual(tagsBefore);
  });

  it('replaces assignments with the exact requested set and keeps owners unchanged', () => {
    const assetId = createAsset(createProject());
    const unchanged = createTag('Unchanged');
    const removed = createTag('Removed');
    const added = createTag('Added');
    tagRepository.assignToAsset(assetId, unchanged.id);
    tagRepository.assignToAsset(assetId, removed.id);
    const assetBefore = assetRepository.findById(assetId);
    const tagsBefore = tagRepository.list();

    expect(service.replaceAssetTags(assetId, [unchanged.id, added.id]))
      .toEqual([added, unchanged]);
    expect(service.listAssetTags(assetId)).toEqual([added, unchanged]);
    expect(assignmentRows(assetId).map(({ tag_id: tagId }) => tagId))
      .toEqual([added.id, unchanged.id].sort((a, b) => a - b));
    expect(assetRepository.findById(assetId)).toEqual(assetBefore);
    expect(tagRepository.list()).toEqual(tagsBefore);
    expect(tagRepository.findById(removed.id)).toEqual(removed);
  });

  it('deduplicates replacement IDs before calling the atomic repository method', () => {
    const assetId = createAsset(createProject());
    const first = createTag('First');
    const second = createTag('Second');
    const replace = vi.spyOn(tagRepository, 'replaceForAsset');

    service.replaceAssetTags(assetId, [first.id, first.id, second.id, second.id]);

    expect(replace).toHaveBeenCalledWith(assetId, [first.id, second.id]);
    expect(assignmentRows(assetId).map(({ tag_id: tagId }) => tagId))
      .toEqual([first.id, second.id]);
  });

  it('removes every assignment when replacement receives an empty array', () => {
    const assetId = createAsset(createProject());
    const first = createTag('First');
    const second = createTag('Second');
    tagRepository.assignToAsset(assetId, first.id);
    tagRepository.assignToAsset(assetId, second.id);
    const before = snapshot(assetId);

    expect(service.replaceAssetTags(assetId, [])).toEqual([]);
    expect(service.listAssetTags(assetId)).toEqual([]);
    expect(assignmentRows(assetId)).toEqual([]);
    expect(assetRepository.findById(assetId)).toEqual(before.asset);
    expect(tagRepository.list()).toEqual(before.tags);
  });

  it('rejects non-array replacement input before mutation', () => {
    const assetId = createAsset(createProject());
    const tag = createTag('Existing');
    tagRepository.assignToAsset(assetId, tag.id);
    const before = snapshot(assetId);
    const replace = vi.spyOn(tagRepository, 'replaceForAsset');

    expect(() => service.replaceAssetTags(assetId, null)).toThrow(AssetTagValidationError);
    expect(() => service.replaceAssetTags(assetId, tag.id)).toThrow(AssetTagValidationError);
    expect(replace).not.toHaveBeenCalled();
    expect(snapshot(assetId)).toEqual(before);
  });

  it('does not partially change assignments when one replacement ID is malformed', () => {
    const assetId = createAsset(createProject());
    const first = createTag('First');
    const second = createTag('Second');
    tagRepository.assignToAsset(assetId, first.id);
    tagRepository.assignToAsset(assetId, second.id);
    const before = snapshot(assetId);
    const replace = vi.spyOn(tagRepository, 'replaceForAsset');

    expect(() => service.replaceAssetTags(assetId, [second.id, 'malformed']))
      .toThrow(AssetTagValidationError);
    expect(replace).not.toHaveBeenCalled();
    expect(snapshot(assetId)).toEqual(before);
  });

  it('does not partially change assignments when one replacement tag is missing', () => {
    const assetId = createAsset(createProject());
    const first = createTag('First');
    const second = createTag('Second');
    tagRepository.assignToAsset(assetId, first.id);
    tagRepository.assignToAsset(assetId, second.id);
    const before = snapshot(assetId);
    const replace = vi.spyOn(tagRepository, 'replaceForAsset');

    expect(() => service.replaceAssetTags(assetId, [second.id, MISSING_ID]))
      .toThrow(TagNotFoundError);
    expect(replace).not.toHaveBeenCalled();
    expect(snapshot(assetId)).toEqual(before);
  });

  it('allows all assignment operations for an asset row marked missing', () => {
    const assetId = createAsset(createProject());
    const first = createTag('First');
    const second = createTag('Second');
    markAssetMissing(assetId);

    expect(assetRepository.findById(assetId)).toMatchObject({ id: assetId, is_present: 0 });
    expect(service.listAssetTags(assetId)).toEqual([]);
    expect(service.assignTagToAsset(assetId, first.id)).toBe(true);
    expect(service.listAssetTags(assetId)).toEqual([first]);
    expect(service.replaceAssetTags(assetId, [second.id, second.id])).toEqual([second]);
    expect(service.listAssetTags(assetId)).toEqual([second]);
    expect(assetRepository.findById(assetId)).toMatchObject({ id: assetId, is_present: 0 });
  });
});
