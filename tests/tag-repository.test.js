import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createTagRepository } from '../src/data/tag-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('tag repository', () => {
  let tmpDir;
  let db;
  let assetRepository;
  let repository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-tag-repository-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    assetRepository = createAssetRepository(db);
    repository = createTagRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createProject(title = 'Tag Repository Project') {
    return Number(db.prepare(`
      INSERT INTO projects (
        title, slug, description, notes, status,
        planned_date, published_date, patreon_url
      ) VALUES (?, ?, '', '', 'tbd', NULL, NULL, NULL)
    `).run(title, title.toLowerCase().replaceAll(' ', '-')).lastInsertRowid);
  }

  function createTag(displayName, normalizedName = displayName.toLowerCase()) {
    return repository.create({ displayName, normalizedName });
  }

  function createAsset(projectId, relativePath) {
    const filename = relativePath.split('/').pop();
    return Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename)
      VALUES (?, ?, ?)
    `).run(projectId, relativePath, filename).lastInsertRowid);
  }

  it('creates and returns the stored row without changing supplied values', () => {
    const tag = repository.create({
      displayName: '  MiXeD Case  ',
      normalizedName: '  mixed case  ',
    });

    expect(tag).toEqual({
      id: expect.any(Number),
      display_name: '  MiXeD Case  ',
      normalized_name: '  mixed case  ',
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
    expect(repository.findByNormalizedName('  mixed case  ')).toEqual(tag);
    expect(repository.findByNormalizedName('mixed case')).toBeUndefined();
  });

  it('finds tags by ID and returns undefined for a missing ID', () => {
    const tag = repository.create({ displayName: 'Character Art', normalizedName: 'character art' });

    expect(repository.findById(tag.id)).toEqual(tag);
    expect(repository.findById(999999)).toBeUndefined();
  });

  it('finds tags by the exact normalized value and returns undefined when absent', () => {
    const tag = repository.create({ displayName: 'Published', normalizedName: 'Published' });

    expect(repository.findByNormalizedName('Published')).toEqual(tag);
    expect(repository.findByNormalizedName('published')).toBeUndefined();
    expect(repository.findByNormalizedName('missing')).toBeUndefined();
  });

  it('lists every tag deterministically by case-insensitive display name and tie-breakers', () => {
    const alpha = repository.create({ displayName: 'Alpha', normalizedName: 'alpha' });
    const lowerAlpha = repository.create({ displayName: 'alpha', normalizedName: 'alpha-a' });
    const beta = repository.create({ displayName: 'beta', normalizedName: 'beta-z' });
    const upperBeta = repository.create({ displayName: 'Beta', normalizedName: 'beta-a' });

    expect(repository.list().map((tag) => tag.id)).toEqual([
      alpha.id,
      lowerAlpha.id,
      upperBeta.id,
      beta.id,
    ]);
    expect(repository.list().map((tag) => tag.display_name)).toEqual([
      'Alpha',
      'alpha',
      'Beta',
      'beta',
    ]);
  });

  describe('project assignments', () => {
    it('assigns one existing tag to one existing project and does not duplicate it', () => {
      const projectId = createProject();
      const tag = createTag('Character Art');

      expect(repository.assignToProject(projectId, tag.id)).toBe(true);
      expect(repository.assignToProject(projectId, tag.id)).toBe(false);
      expect(db.prepare(`
        SELECT COUNT(*) AS count
        FROM project_tags
        WHERE project_id = ? AND tag_id = ?
      `).get(projectId, tag.id).count).toBe(1);
    });

    it('requires an existing project and tag for assignment', () => {
      const projectId = createProject();
      const tag = createTag('Character Art');

      expect(() => repository.assignToProject(999999, tag.id))
        .toThrow(/FOREIGN KEY constraint failed/i);
      expect(() => repository.assignToProject(projectId, 999999))
        .toThrow(/FOREIGN KEY constraint failed/i);
    });

    it('assigns multiple tags to one project and one tag to multiple projects', () => {
      const firstProjectId = createProject('First Project');
      const secondProjectId = createProject('Second Project');
      const firstTag = createTag('First Tag');
      const secondTag = createTag('Second Tag');

      expect(repository.assignToProject(firstProjectId, firstTag.id)).toBe(true);
      expect(repository.assignToProject(firstProjectId, secondTag.id)).toBe(true);
      expect(repository.assignToProject(secondProjectId, firstTag.id)).toBe(true);

      expect(repository.listForProject(firstProjectId).map((tag) => tag.id).sort())
        .toEqual([firstTag.id, secondTag.id].sort());
      expect(repository.listForProject(secondProjectId).map((tag) => tag.id))
        .toEqual([firstTag.id]);
    });

    it('lists tags for requested project IDs in deterministic project/tag order without asset assignments', () => {
      const firstProjectId = createProject('First Batch Project');
      const secondProjectId = createProject('Second Batch Project');
      const assetId = createAsset(firstProjectId, 'source/asset-only.png');
      const shared = createTag('Shared Tag');
      const alpha = createTag('Alpha Tag');
      const upperBeta = createTag('Beta Tag', 'beta-a');
      const lowerBeta = createTag('beta tag', 'beta-z');
      const assetOnly = createTag('Asset Only Tag');

      for (const tag of [lowerBeta, shared, upperBeta, alpha]) {
        repository.assignToProject(firstProjectId, tag.id);
      }
      repository.assignToProject(secondProjectId, shared.id);
      repository.assignToAsset(assetId, assetOnly.id);

      const rows = repository.listForProjectIds([
        secondProjectId,
        firstProjectId,
        firstProjectId,
      ]);

      expect(rows.map(({ project_id: projectId, display_name: displayName }) => [projectId, displayName]))
        .toEqual([
          [firstProjectId, 'Alpha Tag'],
          [firstProjectId, 'Beta Tag'],
          [firstProjectId, 'beta tag'],
          [firstProjectId, 'Shared Tag'],
          [secondProjectId, 'Shared Tag'],
        ]);
      expect(rows).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ display_name: 'Asset Only Tag' }),
      ]));
    });

    it('lists project tags in the same deterministic order as the global catalog', () => {
      const projectId = createProject();
      const alpha = createTag('Alpha', 'alpha');
      const lowerAlpha = createTag('alpha', 'alpha-a');
      const beta = createTag('beta', 'beta-z');
      const upperBeta = createTag('Beta', 'beta-a');

      for (const tag of [beta, upperBeta, lowerAlpha, alpha]) {
        repository.assignToProject(projectId, tag.id);
      }

      expect(repository.listForProject(projectId)).toEqual([
        alpha,
        lowerAlpha,
        upperBeta,
        beta,
      ]);
    });

    it('returns an empty array for a project with no assigned tags', () => {
      expect(repository.listForProject(createProject())).toEqual([]);
    });

    it('returns an empty array for an empty project ID batch', () => {
      expect(repository.listForProjectIds([])).toEqual([]);
    });

    it('removes an existing assignment and reports missing assignments', () => {
      const projectId = createProject();
      const tag = createTag('Temporary');
      repository.assignToProject(projectId, tag.id);

      expect(repository.removeFromProject(projectId, tag.id)).toBe(true);
      expect(repository.removeFromProject(projectId, tag.id)).toBe(false);
      expect(repository.findById(tag.id)).toEqual(tag);
      expect(db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)).toEqual({ id: projectId });
    });

    it('replaces assignments by adding and removing only the changed rows', () => {
      const projectId = createProject();
      const unchanged = createTag('Unchanged');
      const removed = createTag('Removed');
      const added = createTag('Added');
      repository.assignToProject(projectId, unchanged.id);
      repository.assignToProject(projectId, removed.id);
      const unchangedAssignment = db.prepare(`
        SELECT project_id, tag_id, created_at
        FROM project_tags
        WHERE project_id = ? AND tag_id = ?
      `).get(projectId, unchanged.id);

      expect(repository.replaceForProject(projectId, [unchanged.id, added.id]).map((tag) => tag.id))
        .toEqual([added.id, unchanged.id]);
      expect(repository.listForProject(projectId).map((tag) => tag.id))
        .toEqual([added.id, unchanged.id]);
      expect(db.prepare(`
        SELECT project_id, tag_id, created_at
        FROM project_tags
        WHERE project_id = ? AND tag_id = ?
      `).get(projectId, unchanged.id)).toEqual(unchangedAssignment);
      expect(db.prepare(`
        SELECT COUNT(*) AS count
        FROM project_tags
        WHERE project_id = ? AND tag_id = ?
      `).get(projectId, removed.id).count).toBe(0);
    });

    it('deduplicates repeated tag IDs during replacement', () => {
      const projectId = createProject();
      const first = createTag('First');
      const second = createTag('Second');

      expect(repository.replaceForProject(projectId, [first.id, first.id, second.id, second.id])
        .map((tag) => tag.id)).toEqual([first.id, second.id]);
      expect(db.prepare('SELECT COUNT(*) AS count FROM project_tags WHERE project_id = ?')
        .get(projectId).count).toBe(2);
    });

    it('removes all assignments when replacement receives an empty set', () => {
      const projectId = createProject();
      const first = createTag('First');
      const second = createTag('Second');
      repository.assignToProject(projectId, first.id);
      repository.assignToProject(projectId, second.id);

      expect(repository.replaceForProject(projectId, [])).toEqual([]);
      expect(repository.listForProject(projectId)).toEqual([]);
    });

    it('rolls back the complete replacement when a tag ID is invalid', () => {
      const projectId = createProject();
      const first = createTag('First');
      const second = createTag('Second');
      repository.assignToProject(projectId, first.id);
      repository.assignToProject(projectId, second.id);
      const before = db.prepare(`
        SELECT project_id, tag_id, created_at
        FROM project_tags
        WHERE project_id = ?
        ORDER BY tag_id
      `).all(projectId);

      expect(() => repository.replaceForProject(projectId, [second.id, 999999]))
        .toThrow(/FOREIGN KEY constraint failed/i);
      expect(db.prepare(`
        SELECT project_id, tag_id, created_at
        FROM project_tags
        WHERE project_id = ?
        ORDER BY tag_id
      `).all(projectId)).toEqual(before);
    });

    it('returns undefined instead of succeeding for a nonexistent project', () => {
      const tag = createTag('Unused');

      expect(repository.replaceForProject(999999, [tag.id])).toBeUndefined();
      expect(repository.replaceForProject(999999, [])).toBeUndefined();
      expect(repository.findById(tag.id)).toEqual(tag);
    });

    it('cascades project assignments when a tag is deleted without deleting the project', () => {
      const projectId = createProject();
      const deleted = createTag('Deleted');
      const retained = createTag('Retained');
      repository.assignToProject(projectId, deleted.id);
      repository.assignToProject(projectId, retained.id);

      expect(repository.deleteById(deleted.id)).toBe(true);
      expect(repository.listForProject(projectId)).toEqual([retained]);
      expect(db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)).toEqual({ id: projectId });
    });

    it('cascades project assignments when a project is deleted without deleting tags', () => {
      const projectId = createProject();
      const first = createTag('First');
      const second = createTag('Second');
      repository.assignToProject(projectId, first.id);
      repository.assignToProject(projectId, second.id);

      expect(db.prepare('DELETE FROM projects WHERE id = ?').run(projectId).changes).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS count FROM project_tags WHERE project_id = ?')
        .get(projectId).count).toBe(0);
      expect(repository.findById(first.id)).toEqual(first);
      expect(repository.findById(second.id)).toEqual(second);
    });
  });

  describe('asset assignments', () => {
    it('assigns one existing tag to one asset and remains idempotent', () => {
      const projectId = createProject();
      const assetId = createAsset(projectId, 'source/cover.png');
      const tag = createTag('Character Art');

      expect(repository.assignToAsset(assetId, tag.id)).toBe(true);
      expect(repository.assignToAsset(assetId, tag.id)).toBe(false);
      expect(db.prepare(`
        SELECT COUNT(*) AS count
        FROM asset_tags
        WHERE asset_id = ? AND tag_id = ?
      `).get(assetId, tag.id).count).toBe(1);
    });

    it('requires an existing asset and tag for assignment', () => {
      const projectId = createProject();
      const assetId = createAsset(projectId, 'source/cover.png');
      const tag = createTag('Character Art');

      expect(() => repository.assignToAsset(999999, tag.id))
        .toThrow(/FOREIGN KEY constraint failed/i);
      expect(() => repository.assignToAsset(assetId, 999999))
        .toThrow(/FOREIGN KEY constraint failed/i);
    });

    it('assigns multiple tags to one asset and one tag to multiple assets', () => {
      const projectId = createProject();
      const firstAssetId = createAsset(projectId, 'source/first.png');
      const secondAssetId = createAsset(projectId, 'source/second.png');
      const firstTag = createTag('First Tag');
      const secondTag = createTag('Second Tag');

      expect(repository.assignToAsset(firstAssetId, firstTag.id)).toBe(true);
      expect(repository.assignToAsset(firstAssetId, secondTag.id)).toBe(true);
      expect(repository.assignToAsset(secondAssetId, firstTag.id)).toBe(true);

      expect(repository.listForAsset(firstAssetId).map((tag) => tag.id).sort())
        .toEqual([firstTag.id, secondTag.id].sort());
      expect(repository.listForAsset(secondAssetId).map((tag) => tag.id))
        .toEqual([firstTag.id]);
    });

    it('lists tags for requested asset IDs in deterministic asset/tag order without project assignments', () => {
      const projectId = createProject('Batch Asset Tags Project');
      const firstAssetId = createAsset(projectId, 'source/first.png');
      const secondAssetId = createAsset(projectId, 'source/second.png');
      const shared = createTag('Shared Tag');
      const upperBeta = createTag('Beta Tag', 'beta-a');
      const lowerBeta = createTag('beta tag', 'beta-z');
      const projectOnly = createTag('Project Only Tag');

      repository.assignToProject(projectId, projectOnly.id);
      for (const tag of [lowerBeta, shared, upperBeta]) {
        repository.assignToAsset(firstAssetId, tag.id);
      }
      repository.assignToAsset(secondAssetId, shared.id);

      const rows = repository.listForAssetIds([secondAssetId, firstAssetId, secondAssetId]);

      expect(rows.map(({ asset_id: assetId, display_name: displayName }) => [assetId, displayName]))
        .toEqual([
          [firstAssetId, 'Beta Tag'],
          [firstAssetId, 'beta tag'],
          [firstAssetId, 'Shared Tag'],
          [secondAssetId, 'Shared Tag'],
        ]);
      expect(rows).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ display_name: 'Project Only Tag' }),
      ]));
    });

    it('returns an empty array for an empty asset ID batch', () => {
      expect(repository.listForAssetIds([])).toEqual([]);
    });

    it('lists asset tags in the same deterministic order as the global catalog', () => {
      const projectId = createProject();
      const assetId = createAsset(projectId, 'source/cover.png');
      const alpha = createTag('Alpha', 'alpha');
      const lowerAlpha = createTag('alpha', 'alpha-a');
      const beta = createTag('beta', 'beta-z');
      const upperBeta = createTag('Beta', 'beta-a');

      for (const tag of [beta, upperBeta, lowerAlpha, alpha]) {
        repository.assignToAsset(assetId, tag.id);
      }

      expect(repository.listForAsset(assetId)).toEqual([
        alpha,
        lowerAlpha,
        upperBeta,
        beta,
      ]);
    });

    it('returns an empty array for an asset with no assigned tags', () => {
      const projectId = createProject();

      expect(repository.listForAsset(createAsset(projectId, 'source/cover.png'))).toEqual([]);
    });

    it('removes an existing assignment and reports missing assignments', () => {
      const projectId = createProject();
      const assetId = createAsset(projectId, 'source/cover.png');
      const tag = createTag('Temporary');
      repository.assignToAsset(assetId, tag.id);

      expect(repository.removeFromAsset(assetId, tag.id)).toBe(true);
      expect(repository.removeFromAsset(assetId, tag.id)).toBe(false);
      expect(repository.findById(tag.id)).toEqual(tag);
      expect(db.prepare('SELECT id FROM assets WHERE id = ?').get(assetId)).toEqual({ id: assetId });
    });

    it('replaces assignments by adding and removing only the changed rows', () => {
      const projectId = createProject();
      const assetId = createAsset(projectId, 'source/cover.png');
      const unchanged = createTag('Unchanged');
      const removed = createTag('Removed');
      const added = createTag('Added');
      repository.assignToAsset(assetId, unchanged.id);
      repository.assignToAsset(assetId, removed.id);
      const unchangedAssignment = db.prepare(`
        SELECT asset_id, tag_id, created_at
        FROM asset_tags
        WHERE asset_id = ? AND tag_id = ?
      `).get(assetId, unchanged.id);

      expect(repository.replaceForAsset(assetId, [unchanged.id, added.id]).map((tag) => tag.id))
        .toEqual([added.id, unchanged.id]);
      expect(repository.listForAsset(assetId).map((tag) => tag.id))
        .toEqual([added.id, unchanged.id]);
      expect(db.prepare(`
        SELECT asset_id, tag_id, created_at
        FROM asset_tags
        WHERE asset_id = ? AND tag_id = ?
      `).get(assetId, unchanged.id)).toEqual(unchangedAssignment);
      expect(db.prepare(`
        SELECT COUNT(*) AS count
        FROM asset_tags
        WHERE asset_id = ? AND tag_id = ?
      `).get(assetId, removed.id).count).toBe(0);
    });

    it('deduplicates repeated tag IDs during replacement', () => {
      const projectId = createProject();
      const assetId = createAsset(projectId, 'source/cover.png');
      const first = createTag('First');
      const second = createTag('Second');

      expect(repository.replaceForAsset(assetId, [first.id, first.id, second.id, second.id])
        .map((tag) => tag.id)).toEqual([first.id, second.id]);
      expect(db.prepare('SELECT COUNT(*) AS count FROM asset_tags WHERE asset_id = ?')
        .get(assetId).count).toBe(2);
    });

    it('removes all assignments when replacement receives an empty set', () => {
      const projectId = createProject();
      const assetId = createAsset(projectId, 'source/cover.png');
      const first = createTag('First');
      const second = createTag('Second');
      repository.assignToAsset(assetId, first.id);
      repository.assignToAsset(assetId, second.id);

      expect(repository.replaceForAsset(assetId, [])).toEqual([]);
      expect(repository.listForAsset(assetId)).toEqual([]);
    });

    it('rolls back the complete replacement when a tag ID is invalid', () => {
      const projectId = createProject();
      const assetId = createAsset(projectId, 'source/cover.png');
      const first = createTag('First');
      const second = createTag('Second');
      repository.assignToAsset(assetId, first.id);
      repository.assignToAsset(assetId, second.id);
      const before = db.prepare(`
        SELECT asset_id, tag_id, created_at
        FROM asset_tags
        WHERE asset_id = ?
        ORDER BY tag_id
      `).all(assetId);

      expect(() => repository.replaceForAsset(assetId, [second.id, 999999]))
        .toThrow(/FOREIGN KEY constraint failed/i);
      expect(db.prepare(`
        SELECT asset_id, tag_id, created_at
        FROM asset_tags
        WHERE asset_id = ?
        ORDER BY tag_id
      `).all(assetId)).toEqual(before);
    });

    it('returns undefined for replacement of a nonexistent asset and leaves tags unchanged', () => {
      const tag = createTag('Unused');

      expect(repository.listForAsset(999999)).toEqual([]);
      expect(repository.removeFromAsset(999999, tag.id)).toBe(false);
      expect(repository.replaceForAsset(999999, [tag.id])).toBeUndefined();
      expect(repository.replaceForAsset(999999, [])).toBeUndefined();
      expect(repository.findById(tag.id)).toEqual(tag);
    });

    it('lists and replaces tags for an asset row marked missing', () => {
      const projectId = createProject();
      const assetId = createAsset(projectId, 'source/cover.png');
      const first = createTag('First');
      const second = createTag('Second');
      db.prepare(`
        UPDATE assets
        SET is_present = 0, missing_since = datetime('now')
        WHERE id = ?
      `).run(assetId);

      expect(repository.assignToAsset(assetId, first.id)).toBe(true);
      expect(repository.listForAsset(assetId)).toEqual([first]);
      expect(repository.replaceForAsset(assetId, [second.id])).toEqual([second]);
      expect(db.prepare('SELECT is_present FROM assets WHERE id = ?').get(assetId))
        .toEqual({ is_present: 0 });
    });

    it('preserves assignments when reconciliation restores the same asset row', () => {
      const projectId = createProject();
      const assetId = createAsset(projectId, 'source/cover.png');
      const tag = createTag('Restored');
      repository.assignToAsset(assetId, tag.id);
      assetRepository.markAllMissing(projectId);

      expect(assetRepository.reconcileScannedAssets(projectId, [{
        relativePath: 'source/cover.png',
        filename: 'cover.png',
        extension: '',
        mimeType: 'application/octet-stream',
        sizeBytes: 0,
        modifiedAt: null,
        categoryId: null,
        nestedPath: '',
      }])).toEqual({ added: 0, updated: 1, removed: 0, total: 1 });
      expect(assetRepository.findById(assetId)).toMatchObject({ id: assetId, is_present: 1 });
      expect(repository.listForAsset(assetId)).toEqual([tag]);
    });

    it('keeps tags on the old missing row when reconciliation sees an external rename', () => {
      const projectId = createProject();
      const oldAssetId = createAsset(projectId, 'source/old.png');
      const tag = createTag('Retained');
      repository.assignToAsset(oldAssetId, tag.id);
      assetRepository.markAllMissing(projectId);

      expect(assetRepository.reconcileScannedAssets(projectId, [{
        relativePath: 'source/new.png',
        filename: 'new.png',
        extension: '',
        mimeType: 'application/octet-stream',
        sizeBytes: 0,
        modifiedAt: null,
        categoryId: null,
        nestedPath: '',
      }])).toEqual({ added: 1, updated: 0, removed: 0, total: 2 });

      const newAsset = db.prepare('SELECT id, is_present FROM assets WHERE project_id = ? AND relative_path = ?')
        .get(projectId, 'source/new.png');
      expect(newAsset.id).not.toBe(oldAssetId);
      expect(db.prepare('SELECT is_present FROM assets WHERE id = ?').get(oldAssetId))
        .toEqual({ is_present: 0 });
      expect(repository.listForAsset(oldAssetId)).toEqual([tag]);
      expect(repository.listForAsset(newAsset.id)).toEqual([]);
    });

    it('cascades asset assignments when a tag is deleted without deleting the asset', () => {
      const projectId = createProject();
      const assetId = createAsset(projectId, 'source/cover.png');
      const deleted = createTag('Deleted');
      const retained = createTag('Retained');
      repository.assignToAsset(assetId, deleted.id);
      repository.assignToAsset(assetId, retained.id);

      expect(repository.deleteById(deleted.id)).toBe(true);
      expect(repository.listForAsset(assetId)).toEqual([retained]);
      expect(db.prepare('SELECT id FROM assets WHERE id = ?').get(assetId)).toEqual({ id: assetId });
    });

    it('cascades asset assignments when an asset is deleted without deleting tags', () => {
      const projectId = createProject();
      const assetId = createAsset(projectId, 'source/cover.png');
      const first = createTag('First');
      const second = createTag('Second');
      repository.assignToAsset(assetId, first.id);
      repository.assignToAsset(assetId, second.id);

      expect(db.prepare('DELETE FROM assets WHERE id = ?').run(assetId).changes).toBe(1);
      expect(repository.listForAsset(assetId)).toEqual([]);
      expect(repository.findById(first.id)).toEqual(first);
      expect(repository.findById(second.id)).toEqual(second);
    });
  });

  it('rejects duplicate normalized names through the schema constraint', () => {
    repository.create({ displayName: 'Character Art', normalizedName: 'character art' });

    expect(() => repository.create({
      displayName: 'CHARACTER ART',
      normalizedName: 'character art',
    })).toThrow(/UNIQUE constraint failed/i);
    expect(repository.list()).toHaveLength(1);
  });

  it('renames a tag while preserving its ID, creation timestamp, and assignments', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId, 'source/cover.png');
    const tag = repository.create({ displayName: 'Character Art', normalizedName: 'character art' });
    db.prepare('INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)').run(projectId, tag.id);
    db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(assetId, tag.id);
    db.prepare(`
      UPDATE tags
      SET created_at = '2020-01-01 00:00:00', updated_at = '2020-01-01 00:00:00'
      WHERE id = ?
    `).run(tag.id);

    const updated = repository.update(tag.id, {
      displayName: 'Published Character Art',
      normalizedName: 'published character art',
    });

    expect(updated).toMatchObject({
      id: tag.id,
      display_name: 'Published Character Art',
      normalized_name: 'published character art',
      created_at: '2020-01-01 00:00:00',
    });
    expect(updated.updated_at).not.toBe('2020-01-01 00:00:00');
    expect(db.prepare('SELECT project_id, tag_id FROM project_tags WHERE tag_id = ?').all(tag.id))
      .toEqual([{ project_id: projectId, tag_id: tag.id }]);
    expect(db.prepare('SELECT asset_id, tag_id FROM asset_tags WHERE tag_id = ?').all(tag.id))
      .toEqual([{ asset_id: assetId, tag_id: tag.id }]);
  });

  it('rejects a rename collision without changing either tag', () => {
    const first = repository.create({ displayName: 'First', normalizedName: 'first' });
    const second = repository.create({ displayName: 'Second', normalizedName: 'second' });
    const firstBefore = repository.findById(first.id);
    const secondBefore = repository.findById(second.id);

    expect(() => repository.update(first.id, {
      displayName: 'Changed First',
      normalizedName: 'second',
    })).toThrow(/UNIQUE constraint failed/i);

    expect(repository.findById(first.id)).toEqual(firstBefore);
    expect(repository.findById(second.id)).toEqual(secondBefore);
  });

  it('returns undefined when updating a missing tag', () => {
    expect(repository.update(999999, {
      displayName: 'Missing',
      normalizedName: 'missing',
    })).toBeUndefined();
    expect(repository.list()).toEqual([]);
  });

  it('deletes only the requested tag and relies on cascades for its assignments', () => {
    const projectId = createProject();
    const assetId = createAsset(projectId, 'source/cover.png');
    const deleted = repository.create({ displayName: 'Temporary', normalizedName: 'temporary' });
    const retained = repository.create({ displayName: 'Retained', normalizedName: 'retained' });
    db.prepare('INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)').run(projectId, deleted.id);
    db.prepare('INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)').run(projectId, retained.id);
    db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(assetId, deleted.id);
    db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(assetId, retained.id);

    expect(repository.deleteById(deleted.id)).toBe(true);
    expect(repository.deleteById(deleted.id)).toBe(false);
    expect(repository.deleteById(999999)).toBe(false);
    expect(repository.findById(deleted.id)).toBeUndefined();
    expect(repository.findById(retained.id)).toEqual(retained);
    expect(repository.list().map((tag) => tag.id)).toEqual([retained.id]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM assets').get().count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_tags WHERE tag_id = ?').get(deleted.id).count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM asset_tags WHERE tag_id = ?').get(deleted.id).count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_tags WHERE tag_id = ?').get(retained.id).count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM asset_tags WHERE tag_id = ?').get(retained.id).count).toBe(1);
  });
});
