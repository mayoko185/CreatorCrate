import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  openDatabase, runMigrations, closeDatabase, registerSqlFunctions, JS_LOWER_SQL_FUNCTION,
} from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createTagRepository } from '../src/data/tag-repository.js';
import { createReleaseRepository } from '../src/data/release-repository.js';
import { buildAssetRevisionToken } from '../src/services/preview-service.js';
import slugify from '@sindresorhus/slugify';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('asset repository', () => {
  let tmpDir;
  let dbPath;
  let db;
  let assetRepo;
  let projectRepo;
  let tagRepo;
  let projectId;

  function createProject(title = 'Test Project', overrides = {}) {
    return projectRepo.create({
      title,
      slug: slugify(title, { lowercase: true }),
      description: '',
      notes: '',
      status: 'tbd',
      projectType: 'images',
      priority: 'normal',
      plannedDate: null,
      publishedDate: null,
      patreonUrl: null,
      ...overrides,
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-repo-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    assetRepo = createAssetRepository(db);
    projectRepo = createProjectRepository(db);
    tagRepo = createTagRepository(db);
    const project = createProject();
    projectId = project.id;
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── CRUD ────────────────────────────────────────────────────────

  it('inserts an asset and returns it', () => {
    const asset = assetRepo.upsert(projectId, 'source/render.png', {
      filename: 'render.png',
      extension: 'png',
      mimeType: 'image/png',
      sizeBytes: 1024,
      modifiedAt: '2026-07-26T12:00:00.000Z',
    });

    expect(asset.project_id).toBe(projectId);
    expect(asset.relative_path).toBe('source/render.png');
    expect(asset.filename).toBe('render.png');
    expect(asset.extension).toBe('png');
    expect(asset.mime_type).toBe('image/png');
    expect(asset.size_bytes).toBe(1024);
    expect(asset.id).toBeGreaterThan(0);
  });

  it('finds assets by project id', () => {
    assetRepo.upsert(projectId, 'file1.png', {
      filename: 'file1.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'file2.jpg', {
      filename: 'file2.jpg', extension: 'jpg', mimeType: 'image/jpeg',
      sizeBytes: 200, modifiedAt: null,
    });

    const assets = assetRepo.findByProjectId(projectId);
    expect(assets).toHaveLength(2);
  });

  it('does not return assets from other projects', () => {
    const other = createProject('Other');
    assetRepo.upsert(projectId, 'mine.png', {
      filename: 'mine.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(other.id, 'theirs.png', {
      filename: 'theirs.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });

    const assets = assetRepo.findByProjectId(projectId);
    expect(assets).toHaveLength(1);
    expect(assets[0].filename).toBe('mine.png');
  });

  it('updates an existing asset on upsert with same path', () => {
    assetRepo.upsert(projectId, 'render.png', {
      filename: 'render.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 1024, modifiedAt: '2026-07-26T12:00:00.000Z',
    });

    const updated = assetRepo.upsert(projectId, 'render.png', {
      filename: 'render.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 2048, modifiedAt: '2026-07-27T12:00:00.000Z',
    });

    expect(updated.size_bytes).toBe(2048);
    expect(updated.modified_at).toBe('2026-07-27T12:00:00.000Z');

    const all = assetRepo.findByProjectId(projectId);
    expect(all).toHaveLength(1);
  });

  it('finds an asset by project id and path', () => {
    assetRepo.upsert(projectId, 'sub/file.kra', {
      filename: 'file.kra', extension: 'kra', mimeType: 'application/x-krita',
      sizeBytes: 5000, modifiedAt: null,
    });

    const found = assetRepo.findByProjectIdAndPath(projectId, 'sub/file.kra');
    expect(found).toBeTruthy();
    expect(found.filename).toBe('file.kra');

    const missing = assetRepo.findByProjectIdAndPath(projectId, 'nonexistent.kra');
    expect(missing).toBeUndefined();
  });

  it('finds only selected project assets associated with published releases', () => {
    const published = assetRepo.upsert(projectId, 'published.png', {
      filename: 'published.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    const unpublished = assetRepo.upsert(projectId, 'unpublished.png', {
      filename: 'unpublished.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    const otherProject = createProject('Other Project');
    const foreign = assetRepo.upsert(otherProject.id, 'foreign.png', {
      filename: 'foreign.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    const publishedRelease = db.prepare(`
      INSERT INTO releases (project_id, title, published_date)
      VALUES (?, ?, '2026-01-01')
      RETURNING id
    `).get(projectId, 'Published Release');
    const unpublishedRelease = db.prepare(`
      INSERT INTO releases (project_id, title)
      VALUES (?, ?)
      RETURNING id
    `).get(projectId, 'Draft Release');
    const foreignRelease = db.prepare(`
      INSERT INTO releases (project_id, title, published_date)
      VALUES (?, ?, '2026-01-01')
      RETURNING id
    `).get(otherProject.id, 'Foreign Published Release');

    db.prepare('INSERT INTO release_assets (release_id, asset_id) VALUES (?, ?)')
      .run(publishedRelease.id, published.id);
    db.prepare('INSERT INTO release_assets (release_id, asset_id) VALUES (?, ?)')
      .run(unpublishedRelease.id, unpublished.id);
    db.prepare('INSERT INTO release_assets (release_id, asset_id) VALUES (?, ?)')
      .run(foreignRelease.id, foreign.id);

    expect(assetRepo.findPublishedReleaseAssetIds(projectId, [published.id, unpublished.id, foreign.id]))
      .toEqual([published.id]);
  });

  it('deletes several expected asset rows and returns the deleted records', () => {
    const first = assetRepo.upsert(projectId, 'first.png', {
      filename: 'first.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    const second = assetRepo.upsert(projectId, 'second.png', {
      filename: 'second.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 200, modifiedAt: null,
    });

    const deleted = assetRepo.deleteMany(projectId, [
      { assetId: first.id, relativePath: first.relative_path },
      { assetId: second.id, relativePath: second.relative_path },
    ]);

    expect(deleted.map((asset) => asset.id)).toEqual([first.id, second.id]);
    expect(assetRepo.findById(first.id)).toBeUndefined();
    expect(assetRepo.findById(second.id)).toBeUndefined();
  });

  it('deletes only missing rows and rolls back when an expected row is present', () => {
    const present = assetRepo.upsert(projectId, 'present.png', {
      filename: 'present.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    const missing = assetRepo.upsert(projectId, 'missing.png', {
      filename: 'missing.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.markMissingByProjectIdAndPathNotIn(projectId, ['present.png']);

    expect(() => assetRepo.deleteMissingMany(projectId, [
      { assetId: missing.id, relativePath: missing.relative_path },
      { assetId: present.id, relativePath: present.relative_path },
    ])).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));

    expect(assetRepo.findById(missing.id)).toBeDefined();
    expect(assetRepo.findById(present.id)).toBeDefined();

    const deleted = assetRepo.deleteMissingMany(projectId, [
      { assetId: missing.id, relativePath: missing.relative_path },
    ]);
    expect(deleted.map((asset) => asset.id)).toEqual([missing.id]);
    expect(assetRepo.findById(missing.id)).toBeUndefined();
    expect(assetRepo.findById(present.id)).toBeDefined();
  });

  it('rolls back the complete deletion when an expected path is stale', () => {
    const first = assetRepo.upsert(projectId, 'first.png', {
      filename: 'first.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    const second = assetRepo.upsert(projectId, 'second.png', {
      filename: 'second.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 200, modifiedAt: null,
    });

    expect(() => assetRepo.deleteMany(projectId, [
      { assetId: first.id, relativePath: first.relative_path },
      { assetId: second.id, relativePath: 'stale-second.png' },
    ])).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));

    expect(assetRepo.findById(first.id)).toBeDefined();
    expect(assetRepo.findById(second.id)).toBeDefined();
  });

  // ─── Presence marking (replaces delete) ─────────────────────────

  it('marks missing assets instead of deleting', () => {
    assetRepo.upsert(projectId, 'keep.png', {
      filename: 'keep.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'remove.png', {
      filename: 'remove.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'also-remove.jpg', {
      filename: 'also-remove.jpg', extension: 'jpg', mimeType: 'image/jpeg',
      sizeBytes: 100, modifiedAt: null,
    });

    const marked = assetRepo.markMissingByProjectIdAndPathNotIn(projectId, ['keep.png']);
    expect(marked).toBe(2);

    // All assets still exist, but some are marked missing
    const remaining = assetRepo.findByProjectId(projectId);
    expect(remaining).toHaveLength(3);

    const missing = assetRepo.findMissingByProjectId(projectId);
    expect(missing).toHaveLength(2);
  });

  it('marks all assets as missing with empty keep list', () => {
    assetRepo.upsert(projectId, 'a.png', {
      filename: 'a.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'b.jpg', {
      filename: 'b.jpg', extension: 'jpg', mimeType: 'image/jpeg',
      sizeBytes: 100, modifiedAt: null,
    });

    const marked = assetRepo.markMissingByProjectIdAndPathNotIn(projectId, []);
    expect(marked).toBe(2);

    // All assets still exist, all are now missing
    expect(assetRepo.findByProjectId(projectId)).toHaveLength(2);
    expect(assetRepo.findMissingByProjectId(projectId)).toHaveLength(2);
  });

  it('deletes all assets for a project', () => {
    assetRepo.upsert(projectId, 'a.png', {
      filename: 'a.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });

    const removed = assetRepo.deleteByProjectId(projectId);
    expect(removed).toBe(1);
    expect(assetRepo.findByProjectId(projectId)).toHaveLength(0);
  });

  // ─── Count ───────────────────────────────────────────────────────

  it('counts assets by project', () => {
    expect(assetRepo.countByProjectId(projectId)).toBe(0);

    assetRepo.upsert(projectId, 'a.png', {
      filename: 'a.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    expect(assetRepo.countByProjectId(projectId)).toBe(1);
  });

  it('counts assets for multiple projects, including zero counts, and deduplicates IDs', () => {
    const p2 = createProject('Project Two');
    const empty = createProject('Empty Project');

    assetRepo.upsert(projectId, 'a.png', {
      filename: 'a.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'b.png', {
      filename: 'b.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(p2.id, 'c.jpg', {
      filename: 'c.jpg', extension: 'jpg', mimeType: 'image/jpeg',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.markAllMissing(p2.id);

    const batchCounts = assetRepo.countByProjectIds([p2.id, empty.id, projectId, p2.id]);
    expect(batchCounts).toEqual([
      { project_id: projectId, asset_count: 2, missing_asset_count: 0 },
      { project_id: p2.id, asset_count: 1, missing_asset_count: 1 },
      { project_id: empty.id, asset_count: 0, missing_asset_count: 0 },
    ]);
    expect(batchCounts.map(({ project_id, asset_count }) => [
      project_id,
      asset_count,
    ])).toEqual(batchCounts.map(({ project_id }) => [
      project_id,
      assetRepo.countByProjectId(project_id),
    ]));
  });

  it('does not query for empty batch-count input', () => {
    const prepareSpy = vi.spyOn(db, 'prepare');

    expect(assetRepo.countByProjectIds([])).toEqual([]);
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('counts assets across all projects', () => {
    const p2 = createProject('Project Two');

    assetRepo.upsert(projectId, 'a.png', {
      filename: 'a.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(p2.id, 'b.jpg', {
      filename: 'b.jpg', extension: 'jpg', mimeType: 'image/jpeg',
      sizeBytes: 100, modifiedAt: null,
    });

    expect(assetRepo.getTotalCount()).toBe(2);
  });

  // ─── Filtering ───────────────────────────────────────────────────

  it('filters by extension', () => {
    assetRepo.upsert(projectId, 'a.png', {
      filename: 'a.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'b.jpg', {
      filename: 'b.jpg', extension: 'jpg', mimeType: 'image/jpeg',
      sizeBytes: 200, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'c.gif', {
      filename: 'c.gif', extension: 'gif', mimeType: 'image/gif',
      sizeBytes: 300, modifiedAt: null,
    });

    const pngs = assetRepo.findByProjectId(projectId, { extension: 'png' });
    expect(pngs).toHaveLength(1);
    expect(pngs[0].filename).toBe('a.png');
  });

  it('filters project assets by category ID', () => {
    const category = db.prepare(`
      INSERT INTO project_asset_categories (project_id, display_name, directory_slug, display_order, enabled)
      VALUES (?, ?, ?, ?, 1)
      RETURNING id
    `).get(projectId, 'Source', 'source', 0);

    const categorized = assetRepo.upsert(projectId, 'source/a.png', {
      filename: 'a.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null, categoryId: category.id,
    });
    assetRepo.upsert(projectId, 'other/b.png', {
      filename: 'b.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });

    const filtered = assetRepo.findByProjectId(projectId, { categoryId: category.id });

    expect(filtered.map((asset) => asset.id)).toEqual([categorized.id]);
  });

  it('searches by filename', () => {
    assetRepo.upsert(projectId, 'sunset-render.png', {
      filename: 'sunset-render.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'sunset-sketch.kra', {
      filename: 'sunset-sketch.kra', extension: 'kra', mimeType: 'application/x-krita',
      sizeBytes: 200, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'other.jpg', {
      filename: 'other.jpg', extension: 'jpg', mimeType: 'image/jpeg',
      sizeBytes: 300, modifiedAt: null,
    });

    const results = assetRepo.findByProjectId(projectId, { search: 'sunset' });
    expect(results).toHaveLength(2);
  });

  it('handles search wildcards as literals', () => {
    assetRepo.upsert(projectId, 'file_100%.png', {
      filename: 'file_100%.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'normal.png', {
      filename: 'normal.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });

    const percent = assetRepo.findByProjectId(projectId, { search: '%' });
    expect(percent).toHaveLength(1);
    expect(percent[0].filename).toBe('file_100%.png');
  });

  // ─── Sorting ─────────────────────────────────────────────────────

  it('sorts by filename', () => {
    assetRepo.upsert(projectId, 'b.png', {
      filename: 'b.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'a.png', {
      filename: 'a.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });

    const asc = assetRepo.findByProjectId(projectId, { sortBy: 'filename', order: 'asc' });
    expect(asc[0].filename).toBe('a.png');

    const desc = assetRepo.findByProjectId(projectId, { sortBy: 'filename', order: 'desc' });
    expect(desc[0].filename).toBe('b.png');
  });

  it('sorts by size', () => {
    assetRepo.upsert(projectId, 'small.png', {
      filename: 'small.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'large.png', {
      filename: 'large.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 9999, modifiedAt: null,
    });

    const asc = assetRepo.findByProjectId(projectId, { sortBy: 'size', order: 'asc' });
    expect(asc[0].filename).toBe('small.png');

    const desc = assetRepo.findByProjectId(projectId, { sortBy: 'size', order: 'desc' });
    expect(desc[0].filename).toBe('large.png');
  });

  it('sorts by modified date', () => {
    assetRepo.upsert(projectId, 'old.png', {
      filename: 'old.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: '2026-01-01T00:00:00.000Z',
    });
    assetRepo.upsert(projectId, 'new.png', {
      filename: 'new.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: '2026-07-26T00:00:00.000Z',
    });

    const asc = assetRepo.findByProjectId(projectId, { sortBy: 'modified', order: 'asc' });
    expect(asc[0].filename).toBe('old.png');

    const desc = assetRepo.findByProjectId(projectId, { sortBy: 'modified', order: 'desc' });
    expect(desc[0].filename).toBe('new.png');
  });

  // ─── Extensions ──────────────────────────────────────────────────

  it('returns distinct extensions for a project', () => {
    assetRepo.upsert(projectId, 'a.png', {
      filename: 'a.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'b.jpg', {
      filename: 'b.jpg', extension: 'jpg', mimeType: 'image/jpeg',
      sizeBytes: 200, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'c.png', {
      filename: 'c.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 300, modifiedAt: null,
    });

    const extensions = assetRepo.getExtensions(projectId);
    expect(extensions).toEqual(['jpg', 'png']);
  });

  it('returns stable normalized browser extension choices for the owning project only', () => {
    const other = createProject('Extension Other');
    assetRepo.upsert(projectId, 'a.PNG', {
      filename: 'a.PNG', extension: 'PNG', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'b.jpg', {
      filename: 'b.jpg', extension: 'jpg', mimeType: 'image/jpeg',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'README', {
      filename: 'README', extension: '', mimeType: 'application/octet-stream',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(other.id, 'c.kra', {
      filename: 'c.kra', extension: 'kra', mimeType: 'application/x-krita',
      sizeBytes: 100, modifiedAt: null,
    });

    expect(assetRepo.listProjectAssetExtensions(projectId)).toEqual(['jpg', 'png']);
  });

  // ─── Presence tracking ─────────────────────────────────────────────

  it('upsert marks new assets as present', () => {
    const asset = assetRepo.upsert(projectId, 'present.png', {
      filename: 'present.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });

    expect(asset.is_present).toBe(1);
    expect(asset.last_seen_at).toBeTruthy();
    expect(asset.missing_since).toBeNull();
  });

  it('upsert restores previously missing assets', () => {
    // Create asset initially
    assetRepo.upsert(projectId, 'file.png', {
      filename: 'file.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });

    // Mark it as missing
    assetRepo.markMissingByProjectIdAndPathNotIn(projectId, []);

    const missing = assetRepo.findMissingByProjectId(projectId);
    expect(missing).toHaveLength(1);
    expect(missing[0].relative_path).toBe('file.png');

    // Upsert with updated data
    const restored = assetRepo.upsert(projectId, 'file.png', {
      filename: 'file.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 200, modifiedAt: '2026-07-27T00:00:00.000Z',
    });

    expect(restored.is_present).toBe(1);
    expect(restored.missing_since).toBeNull();
    expect(restored.last_seen_at).toBeTruthy();
  });

  it('markMissingByProjectIdAndPathNotIn marks absent assets', () => {
    assetRepo.upsert(projectId, 'keep.png', {
      filename: 'keep.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'remove.png', {
      filename: 'remove.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });

    const marked = assetRepo.markMissingByProjectIdAndPathNotIn(projectId, ['keep.png']);
    expect(marked).toBe(1);

    const missing = assetRepo.findMissingByProjectId(projectId);
    expect(missing).toHaveLength(1);
    expect(missing[0].filename).toBe('remove.png');
    expect(missing[0].missing_since).toBeTruthy();
  });

  it('markMissingByProjectIdAndPathNotIn preserves existing missing_since', () => {
    assetRepo.upsert(projectId, 'gone.png', {
      filename: 'gone.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });

    // Mark as missing first time
    assetRepo.markMissingByProjectIdAndPathNotIn(projectId, []);
    const first = assetRepo.findMissingByProjectId(projectId)[0];
    const firstMissingSince = first.missing_since;

    // Wait a bit then mark missing again (simulating another scan cycle)
    assetRepo.markMissingByProjectIdAndPathNotIn(projectId, []);
    const second = assetRepo.findMissingByProjectId(projectId)[0];

    // missing_since should not change on subsequent marks
    expect(second.missing_since).toBe(firstMissingSince);
  });

  it('markAllMissing marks all assets as missing', () => {
    assetRepo.upsert(projectId, 'a.png', {
      filename: 'a.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'b.png', {
      filename: 'b.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });

    const marked = assetRepo.markAllMissing(projectId);
    expect(marked).toBe(2);

    const missing = assetRepo.findMissingByProjectId(projectId);
    expect(missing).toHaveLength(2);
  });

  it('restorePresent restores missing assets', () => {
    assetRepo.upsert(projectId, 'was-gone.png', {
      filename: 'was-gone.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.markMissingByProjectIdAndPathNotIn(projectId, []);

    const missing = assetRepo.findMissingByProjectId(projectId);
    expect(missing).toHaveLength(1);

    const restored = assetRepo.restorePresent(projectId, ['was-gone.png']);
    expect(restored).toBe(1);

    const present = assetRepo.findPresentByProjectId(projectId);
    expect(present).toHaveLength(1);
    expect(present[0].filename).toBe('was-gone.png');
  });

  it('restorePresent only affects currently missing assets', () => {
    assetRepo.upsert(projectId, 'present.png', {
      filename: 'present.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });

    const restored = assetRepo.restorePresent(projectId, ['present.png']);
    expect(restored).toBe(0);
  });

  it('restorePresent ignores empty path list', () => {
    assetRepo.upsert(projectId, 'a.png', {
      filename: 'a.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });

    const restored = assetRepo.restorePresent(projectId, []);
    expect(restored).toBe(0);
  });

  it('findPresentByProjectId returns only present assets', () => {
    assetRepo.upsert(projectId, 'present.png', {
      filename: 'present.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'missing.png', {
      filename: 'missing.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });

    assetRepo.markMissingByProjectIdAndPathNotIn(projectId, ['present.png']);

    const present = assetRepo.findPresentByProjectId(projectId);
    expect(present).toHaveLength(1);
    expect(present[0].filename).toBe('present.png');
  });

  it('findMissingByProjectId returns only missing assets', () => {
    assetRepo.upsert(projectId, 'present.png', {
      filename: 'present.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'missing.png', {
      filename: 'missing.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });

    assetRepo.markMissingByProjectIdAndPathNotIn(projectId, ['present.png']);

    const missing = assetRepo.findMissingByProjectId(projectId);
    expect(missing).toHaveLength(1);
    expect(missing[0].filename).toBe('missing.png');
  });

  it('identity preserved: missing asset keeps same ID', () => {
    const original = assetRepo.upsert(projectId, 'file.png', {
      filename: 'file.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });

    assetRepo.markMissingByProjectIdAndPathNotIn(projectId, []);

    const missing = assetRepo.findMissingByProjectId(projectId)[0];
    expect(missing.id).toBe(original.id);
    expect(missing.is_present).toBe(0);
    expect(missing.filename).toBe('file.png'); // metadata preserved
  });

  // ─── Phase 6D: Asset Browser Queries ─────────────────────────────────

  describe('findProjectAssetsByIdsInBrowserOrder', () => {
    function insertCategory(displayName, directorySlug, enabled = 1) {
      return db.prepare(`
        INSERT INTO project_asset_categories (project_id, display_name, directory_slug, display_order, enabled)
        VALUES (?, ?, ?, ?, ?)
        RETURNING *
      `).get(projectId, displayName, directorySlug, 0, enabled);
    }

    it('returns joined category state in canonical filename order and retains a deleted-category row', () => {
      const source = insertCategory('Source Display', 'source', 1);
      const disabled = insertCategory('Disabled Display', 'disabled', 0);
      const deleted = insertCategory('Deleted Display', 'deleted', 1);
      const first = assetRepo.upsert(projectId, 'z.png', {
        filename: 'z.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, modifiedAt: null,
        categoryId: source.id,
      });
      const second = assetRepo.upsert(projectId, 'a.png', {
        filename: 'a.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, modifiedAt: null,
        categoryId: disabled.id,
      });
      const uncategorized = assetRepo.upsert(projectId, 'm.png', {
        filename: 'm.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, modifiedAt: null,
      });
      const deletedAsset = assetRepo.upsert(projectId, 'd.png', {
        filename: 'd.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, modifiedAt: null,
        categoryId: deleted.id,
      });

      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare('DELETE FROM project_asset_categories WHERE id = ?').run(deleted.id);
      db.exec('PRAGMA foreign_keys = ON');

      const rows = assetRepo.findProjectAssetsByIdsInBrowserOrder(projectId, [first.id, uncategorized.id, deletedAsset.id, second.id]);
      expect(rows.map((row) => row.filename)).toEqual(['a.png', 'd.png', 'm.png', 'z.png']);
      expect(rows.find((row) => row.id === first.id)).toMatchObject({
        category_id: source.id,
        category_record_id: source.id,
        category_project_id: projectId,
        category_display_name: 'Source Display',
        category_directory_slug: 'source',
        category_enabled: 1,
      });
      expect(rows.find((row) => row.id === second.id)).toMatchObject({
        category_record_id: disabled.id,
        category_directory_slug: 'disabled',
        category_enabled: 0,
      });
      expect(rows.find((row) => row.id === uncategorized.id)).toMatchObject({
        category_id: null,
        category_record_id: null,
        category_directory_slug: null,
        category_enabled: null,
      });
      expect(rows.find((row) => row.id === deletedAsset.id)).toMatchObject({
        category_id: deleted.id,
        category_record_id: null,
        category_directory_slug: null,
        category_enabled: null,
      });
    });
  });

  describe('findProjectAssetsByCategoryInBrowserOrder', () => {
    function insertCategoryFor(targetProjectId, displayName, directorySlug, displayOrder, enabled = 1) {
      return db.prepare(`
        INSERT INTO project_asset_categories (project_id, display_name, directory_slug, display_order, enabled)
        VALUES (?, ?, ?, ?, ?)
        RETURNING *
      `).get(targetProjectId, displayName, directorySlug, displayOrder, enabled);
    }

    it('returns a complete exact category without pagination, reuses canonical order, and preserves row metadata', () => {
      const category = insertCategoryFor(projectId, 'Rename Category', 'rename-category', 3, 1);
      const otherCategory = insertCategoryFor(projectId, 'Other Category', 'other-category', 4, 1);
      const foreignProject = createProject('Foreign Category Project');
      const foreignCategory = insertCategoryFor(foreignProject.id, 'Foreign Category', 'foreign-category', 0, 1);

      const categoryAssets = [];
      for (let index = 0; index < 30; index++) {
        const filename = index === 0
          ? 'file-10.png'
          : index === 1
            ? 'file-2.png'
            : index === 2
              ? 'same.png'
              : index === 3
                ? 'same.png'
                : `asset-${String(index).padStart(2, '0')}.png`;
        const directory = index === 2 ? 'first' : index === 3 ? 'second' : 'category';
        categoryAssets.push(assetRepo.upsert(projectId, `${directory}/${index}-${filename}`, {
          filename,
          extension: 'png',
          mimeType: 'image/png',
          sizeBytes: index + 1,
          modifiedAt: null,
          categoryId: category.id,
          nestedPath: directory,
        }));
      }
      const excludedCategoryAsset = assetRepo.upsert(projectId, 'other/other.png', {
        filename: 'other.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 1,
        modifiedAt: null,
        categoryId: otherCategory.id,
        nestedPath: 'other',
      });
      const foreignAsset = assetRepo.upsert(foreignProject.id, 'foreign/asset.png', {
        filename: 'asset.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 1,
        modifiedAt: null,
        categoryId: foreignCategory.id,
        nestedPath: 'foreign',
      });

      const complete = assetRepo.findProjectAssetsByCategoryInBrowserOrder(projectId, category.id);
      const firstPage = assetRepo.findProjectAssetPage(projectId, {
        category: category.id,
        page: 1,
        pageSize: 25,
      });
      const secondPage = assetRepo.findProjectAssetPage(projectId, {
        category: category.id,
        page: 2,
        pageSize: 25,
      });

      expect(complete).toHaveLength(30);
      expect(new Set(complete.map((asset) => asset.id)).size).toBe(30);
      expect(complete.map((asset) => asset.id)).toEqual([
        ...firstPage,
        ...secondPage,
      ].map((asset) => asset.id));
      expect(complete.map((asset) => asset.id)).not.toContain(excludedCategoryAsset.id);
      expect(complete.map((asset) => asset.id)).not.toContain(foreignAsset.id);
      expect(complete.every((asset) => (
        asset.project_id === projectId && asset.category_id === category.id
      ))).toBe(true);

      const sameFilenameIds = complete
        .filter((asset) => asset.filename === 'same.png')
        .map((asset) => asset.id);
      expect(sameFilenameIds).toEqual([...sameFilenameIds].sort((left, right) => left - right));

      expect(complete[0]).toMatchObject({
        id: expect.any(Number),
        project_id: projectId,
        category_id: category.id,
        relative_path: expect.any(String),
        nested_path: expect.any(String),
        filename: expect.any(String),
        extension: 'png',
        mime_type: 'image/png',
        size_bytes: expect.any(Number),
        modified_at: null,
        is_present: 1,
        last_seen_at: expect.any(String),
        missing_since: null,
        created_at: expect.any(String),
        updated_at: expect.any(String),
        category_record_id: category.id,
        category_project_id: projectId,
        category_display_name: 'Rename Category',
        category_directory_slug: 'rename-category',
        category_display_order: 3,
        category_enabled: 1,
        release_usage_count: 0,
      });
    });

    it('orders the complete category by the active browser sort and direction, matching filtered and paged browser rows', () => {
      const category = insertCategoryFor(projectId, 'Sorted Category', 'sorted-category', 2, 1);
      const otherCategory = insertCategoryFor(projectId, 'Sorted Other', 'sorted-other', 5, 1);
      const specs = [
        { filename: 'delta.png', sizeBytes: 5, modifiedAt: '2026-01-03T00:00:00.000Z', nestedPath: 'b' },
        { filename: 'alpha.png', sizeBytes: 5, modifiedAt: null, nestedPath: 'a' },
        { filename: 'Charlie.png', sizeBytes: 1, modifiedAt: '2026-01-01T00:00:00.000Z', nestedPath: 'b' },
        { filename: 'bravo.png', sizeBytes: 3, modifiedAt: '2026-01-03T00:00:00.000Z', nestedPath: 'a' },
        { filename: 'echo.png', sizeBytes: 9, modifiedAt: '2026-01-02T00:00:00.000Z', nestedPath: 'a' },
        { filename: 'alpha.png', sizeBytes: 1, modifiedAt: '2026-01-02T00:00:00.000Z', nestedPath: 'b' },
        { filename: 'foxtrot.png', sizeBytes: 3, modifiedAt: null, nestedPath: 'b' },
      ];
      specs.forEach((spec, index) => assetRepo.upsert(projectId, `${spec.nestedPath}/${index}-${spec.filename}`, {
        ...spec,
        extension: 'png',
        mimeType: 'image/png',
        categoryId: category.id,
      }));
      const outsider = assetRepo.upsert(projectId, 'other/alpha.png', {
        filename: 'alpha.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 5,
        modifiedAt: null,
        categoryId: otherCategory.id,
        nestedPath: 'other',
      });

      const ids = (rows) => rows.map((asset) => asset.id);
      const defaultOrder = ids(assetRepo.findProjectAssetsByCategoryInBrowserOrder(projectId, category.id));
      expect(defaultOrder).toEqual(ids(assetRepo.findProjectAssetsByCategoryInBrowserOrder(
        projectId,
        category.id,
        { sort: 'filename', order: 'asc' },
      )));

      for (const sort of ['filename', 'modified', 'size', 'category']) {
        for (const order of ['asc', 'desc']) {
          const full = ids(assetRepo.findProjectAssetsByCategoryInBrowserOrder(projectId, category.id, { sort, order }));
          expect(full).toHaveLength(specs.length);
          expect(new Set(full).size).toBe(specs.length);
          expect(full).not.toContain(outsider.id);
          expect([...full].sort((left, right) => left - right))
            .toEqual([...defaultOrder].sort((left, right) => left - right));

          const paged = [1, 2, 3].flatMap((page) => ids(assetRepo.findProjectAssetPage(projectId, {
            category: category.id, sort, order, page, pageSize: 3,
          })));
          expect(paged).toEqual(full);

          const filtered = ids(assetRepo.findProjectAssetPage(projectId, {
            category: category.id, search: 'a', sort, order, pageSize: 'all',
          }));
          expect(filtered.length).toBeGreaterThan(0);
          expect(filtered.length).toBeLessThan(full.length);
          expect(filtered).toEqual(full.filter((id) => filtered.includes(id)));
        }
      }
    });
  });

  /**
   * Helper: insert a release directly.
   */
  function insertRelease(db, { projectId, title, archivedAt = null }) {
    return db.prepare(`
      INSERT INTO releases (project_id, title, description, notes,
                            planned_date, published_date, patreon_url, archived_at)
      VALUES (?, ?, '', '', NULL, NULL, NULL, ?)
      RETURNING *
    `).get(projectId, title, archivedAt);
  }

  /**
   * Helper: link an asset to a release.
   */
  function linkAssetToRelease(db, { releaseId, assetId, role = 'attachment', sortOrder = 0 }) {
    db.prepare(`
      INSERT INTO release_assets (release_id, asset_id, role, sort_order)
      VALUES (?, ?, ?, ?)
    `).run(releaseId, assetId, role, sortOrder);
  }

  // These tests need the full DB (release_assets table), so we use the
  // already-created db from the test suite's beforeEach.

  describe('findProjectAssetPage', () => {
    it('returns empty array when project has no assets', () => {
      const result = assetRepo.findProjectAssetPage(projectId);
      expect(result).toEqual([]);
    });

    it('omits LIMIT/OFFSET only for explicit all and preserves the default page size', () => {
      for (let index = 0; index < 30; index++) {
        assetRepo.upsert(projectId, `asset-${String(index).padStart(2, '0')}.png`, {
          filename: `asset-${String(index).padStart(2, '0')}.png`,
          extension: 'png', mimeType: 'image/png', sizeBytes: 100, modifiedAt: null,
        });
      }
      const prepareSpy = vi.spyOn(db, 'prepare');

      expect(assetRepo.findProjectAssetPage(projectId)).toHaveLength(25);
      const defaultSql = prepareSpy.mock.calls.at(-1)[0];
      expect(defaultSql).toMatch(/LIMIT \? OFFSET \?/);

      expect(assetRepo.findProjectAssetPage(projectId, { page: 99, pageSize: 'all' })).toHaveLength(30);
      const allSql = prepareSpy.mock.calls.at(-1)[0];
      expect(allSql).not.toMatch(/\bLIMIT\b|\bOFFSET\b/);
    });

    it('returns assets with all default columns', () => {
      assetRepo.upsert(projectId, 'a.png', {
        filename: 'a.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: '2026-07-28T10:00:00.000Z',
      });

      const [asset] = assetRepo.findProjectAssetPage(projectId);
      expect(asset).toMatchObject({
        id: expect.any(Number),
        project_id: projectId,
        relative_path: 'a.png',
        filename: 'a.png',
        extension: 'png',
        mime_type: 'image/png',
        size_bytes: 100,
        modified_at: '2026-07-28T10:00:00.000Z',
        is_present: 1,
        last_seen_at: expect.any(String),
        missing_since: null,
        release_usage_count: 0,
      });
    });

    it('filters by case-insensitive filename search with LIKE wildcards treated literally', () => {
      assetRepo.upsert(projectId, 'Sun_100%.png', {
        filename: 'Sun_100%.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.upsert(projectId, 'sunset.jpg', {
        filename: 'sunset.jpg', extension: 'jpg', mimeType: 'image/jpeg',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.upsert(projectId, 'plain.png', {
        filename: 'plain.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });

      const caseInsensitive = assetRepo.findProjectAssetPage(projectId, { search: 'sun', pageSize: 100 });
      expect(caseInsensitive.map((a) => a.filename)).toEqual(['Sun_100%.png', 'sunset.jpg']);

      const literalPercent = assetRepo.findProjectAssetPage(projectId, { search: '100%', pageSize: 100 });
      expect(literalPercent.map((a) => a.filename)).toEqual(['Sun_100%.png']);

      const literalUnderscore = assetRepo.findProjectAssetPage(projectId, { search: '_', pageSize: 100 });
      expect(literalUnderscore.map((a) => a.filename)).toEqual(['Sun_100%.png']);
    });

    it('filters by exact normalized extension', () => {
      assetRepo.upsert(projectId, 'a.png', {
        filename: 'a.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.upsert(projectId, 'b.apng', {
        filename: 'b.apng', extension: 'apng', mimeType: 'application/octet-stream',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.upsert(projectId, 'c.jpg', {
        filename: 'c.jpg', extension: 'jpg', mimeType: 'image/jpeg',
        sizeBytes: 100, modifiedAt: null,
      });

      const results = assetRepo.findProjectAssetPage(projectId, { extension: 'png', pageSize: 100 });
      expect(results.map((a) => a.filename)).toEqual(['a.png']);
    });

    it('applies LIMIT and OFFSET correctly', () => {
      for (let i = 1; i <= 10; i++) {
        // Use leading zeros so filename sort is predictable
        assetRepo.upsert(projectId, `file${String(i).padStart(2, '0')}.png`, {
          filename: `file${String(i).padStart(2, '0')}.png`, extension: 'png', mimeType: 'image/png',
          sizeBytes: 100, modifiedAt: null,
        });
      }

      const page1 = assetRepo.findProjectAssetPage(projectId, { page: 1, pageSize: 3 });
      expect(page1).toHaveLength(3);
      expect(page1[0].filename).toBe('file01.png');

      const page2 = assetRepo.findProjectAssetPage(projectId, { page: 2, pageSize: 3 });
      expect(page2).toHaveLength(3);
      expect(page2[0].filename).toBe('file04.png');

      const page4 = assetRepo.findProjectAssetPage(projectId, { page: 4, pageSize: 3 });
      expect(page4).toHaveLength(1);
      expect(page4[0].filename).toBe('file10.png');
    });

    it('orders by filename, extension, id deterministically', () => {
      // Same filename with different extensions
      assetRepo.upsert(projectId, 'a.txt', {
        filename: 'a.txt', extension: 'txt', mimeType: 'text/plain',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.upsert(projectId, 'a.png', {
        filename: 'a.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.upsert(projectId, 'b.txt', {
        filename: 'b.txt', extension: 'txt', mimeType: 'text/plain',
        sizeBytes: 100, modifiedAt: null,
      });

      const results = assetRepo.findProjectAssetPage(projectId);
      expect(results.map((a) => a.filename)).toEqual(['a.png', 'a.txt', 'b.txt']);
    });

    it('ends with unique asset-id tie-breaker for deterministic order', () => {
      // Insert two assets with the same case-insensitive filename and extension
      // so the only tie-breaker is asset id.
      const a1 = assetRepo.upsert(projectId, 'same.txt', {
        filename: 'same.txt', extension: 'txt', mimeType: 'text/plain',
        sizeBytes: 100, modifiedAt: null,
      });
      const a2 = assetRepo.upsert(projectId, 'same.txt', {
        filename: 'same.txt', extension: 'txt', mimeType: 'text/plain',
        sizeBytes: 200, modifiedAt: null,
      });

      // a1 was inserted first, a2 second — a1.id < a2.id
      const results = assetRepo.findProjectAssetPage(projectId);
      const sameAssets = results.filter((a) => a.filename === 'same.txt');
      expect(sameAssets).toHaveLength(1); // upsert replaces, so only one row
    });

    it('deterministic order with same filename, different case, different ids', () => {
      // Insert two assets with same case-insensitive filename but different
      // relative_path so they are distinct rows.
      const a1 = assetRepo.upsert(projectId, 'sub/Readme.txt', {
        filename: 'Readme.txt', extension: 'txt', mimeType: 'text/plain',
        sizeBytes: 100, modifiedAt: null,
      });
      const a2 = assetRepo.upsert(projectId, 'sub/README.txt', {
        filename: 'README.txt', extension: 'txt', mimeType: 'text/plain',
        sizeBytes: 200, modifiedAt: null,
      });

      const results = assetRepo.findProjectAssetPage(projectId);
      // COLLATE NOCASE groups them; id ASC breaks the tie deterministically
      expect(results).toHaveLength(2);
      // The order must be stable across calls
      const first = results[0];
      const second = results[1];
      expect(first.id).toBeLessThan(second.id);
    });

    it('does not duplicate asset rows when asset belongs to multiple releases', () => {
      // Insert releases directly via SQL to avoid the create() helper signature issue
      const rel1Id = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'R1', '', '', NULL, NULL, NULL)
        RETURNING id
      `).get(projectId).id;
      const rel2Id = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'R2', '', '', NULL, NULL, NULL)
        RETURNING id
      `).get(projectId).id;
      const rel3Id = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'R3', '', '', NULL, NULL, NULL)
        RETURNING id
      `).get(projectId).id;

      assetRepo.upsert(projectId, 'shared.png', {
        filename: 'shared.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      const asset = assetRepo.findByProjectIdAndPath(projectId, 'shared.png');

      linkAssetToRelease(db, { releaseId: rel1Id, assetId: asset.id });
      linkAssetToRelease(db, { releaseId: rel2Id, assetId: asset.id });
      linkAssetToRelease(db, { releaseId: rel3Id, assetId: asset.id });

      const results = assetRepo.findProjectAssetPage(projectId);
      const sharedAsset = results.find((a) => a.relative_path === 'shared.png');
      expect(results.filter((a) => a.id === asset.id)).toHaveLength(1);
      expect(sharedAsset.release_usage_count).toBe(3);
    });

    it('isolates project: does not return assets from other projects', () => {
      // Insert a release for the other project via direct SQL
      const otherProject = projectRepo.create({
        title: 'Other',
        slug: 'other',
        description: '',
        notes: '',
        status: 'tbd',
        projectType: 'images',
        priority: 'normal',
        plannedDate: null,
        publishedDate: null,
        patreonUrl: null,
      });
      const otherRelId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'Other Release', '', '', NULL, NULL, NULL)
        RETURNING id
      `).get(otherProject.id).id;

      assetRepo.upsert(projectId, 'mine.png', {
        filename: 'mine.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.upsert(otherProject.id, 'theirs.png', {
        filename: 'theirs.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      const theirAsset = assetRepo.findByProjectIdAndPath(otherProject.id, 'theirs.png');
      linkAssetToRelease(db, { releaseId: otherRelId, assetId: theirAsset.id });

      const results = assetRepo.findProjectAssetPage(projectId);
      expect(results.map((a) => a.relative_path)).toEqual(['mine.png']);
      expect(results[0].release_usage_count).toBe(0);
    });

    it('matches project-scoped tags directly or by project inheritance without duplicates or cross-project matches', () => {
      const otherProject = createProject('Other Tagged Project');
      const shared = tagRepo.create({ displayName: 'Shared', normalizedName: 'shared' });
      const additional = tagRepo.create({ displayName: 'Additional', normalizedName: 'additional' });
      const projectOnly = tagRepo.create({ displayName: 'Project Only', normalizedName: 'project-only' });
      const unused = tagRepo.create({ displayName: 'Unused', normalizedName: 'unused' });
      const first = assetRepo.upsert(projectId, 'first.png', {
        filename: 'first.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, modifiedAt: null,
      });
      const second = assetRepo.upsert(projectId, 'second.png', {
        filename: 'second.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, modifiedAt: null,
      });
      const other = assetRepo.upsert(projectId, 'other.png', {
        filename: 'other.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, modifiedAt: null,
      });
      const foreign = assetRepo.upsert(otherProject.id, 'foreign.png', {
        filename: 'foreign.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, modifiedAt: null,
      });

      tagRepo.assignToAsset(first.id, shared.id);
      tagRepo.assignToAsset(first.id, additional.id);
      tagRepo.assignToAsset(second.id, shared.id);
      tagRepo.assignToAsset(other.id, additional.id);
      tagRepo.assignToProject(projectId, projectOnly.id);
      // The same tag both directly on an asset and inherited from its project.
      tagRepo.assignToAsset(first.id, projectOnly.id);
      tagRepo.assignToAsset(foreign.id, shared.id);
      tagRepo.assignToAsset(foreign.id, projectOnly.id);

      const filenames = (rows) => rows.map((asset) => asset.filename);
      const expectUniqueCounted = (filters, rows) => {
        expect(new Set(rows.map((asset) => asset.id)).size).toBe(rows.length);
        expect(assetRepo.countProjectAssets(projectId, filters)).toBe(rows.length);
      };

      // Direct asset tags keep matching exactly the directly tagged assets.
      const direct = assetRepo.findProjectAssetPage(projectId, { tag: shared.id, pageSize: 100 });
      expect(filenames(direct)).toEqual(['first.png', 'second.png']);
      expectUniqueCounted({ tag: shared.id }, direct);

      // An inherited project tag matches every project asset exactly once.
      const inherited = assetRepo.findProjectAssetPage(projectId, { tag: projectOnly.id, pageSize: 100 });
      expect(filenames(inherited)).toEqual(['first.png', 'other.png', 'second.png']);
      expectUniqueCounted({ tag: projectOnly.id }, inherited);
      expect(filenames(assetRepo.findProjectAssetPage(projectId, { tag: projectOnly.id, page: 2, pageSize: 2 })))
        .toEqual(['second.png']);

      // Multiple tags keep OR semantics across direct and inherited matches.
      const multiple = assetRepo.findProjectAssetPage(projectId, {
        tag: [shared.id, additional.id, shared.id],
        pageSize: 100,
      });
      expect(filenames(multiple)).toEqual(['first.png', 'other.png', 'second.png']);
      expectUniqueCounted({ tag: [shared.id, additional.id] }, multiple);
      const mixed = assetRepo.findProjectAssetPage(projectId, { tag: [shared.id, projectOnly.id], pageSize: 100 });
      expect(filenames(mixed)).toEqual(['first.png', 'other.png', 'second.png']);
      expectUniqueCounted({ tag: [shared.id, projectOnly.id] }, mixed);
      expect(assetRepo.findProjectAssetPage(projectId, { tag: unused.id, pageSize: 100 })).toEqual([]);

      // Project tag changes are reflected by the next query without caching.
      tagRepo.removeFromProject(projectId, projectOnly.id);
      expect(filenames(assetRepo.findProjectAssetPage(projectId, { tag: projectOnly.id, pageSize: 100 })))
        .toEqual(['first.png']);

      tagRepo.deleteById(shared.id);
      expect(assetRepo.countProjectAssets(projectId, { tag: shared.id })).toBe(0);
    });

    it('matches an inherited project tag across every category and composes with other filters', () => {
      const insertCategory = (displayName, directorySlug, displayOrder) => db.prepare(`
        INSERT INTO project_asset_categories (project_id, display_name, directory_slug, display_order, enabled)
        VALUES (?, ?, ?, ?, 1)
        RETURNING id
      `).get(projectId, displayName, directorySlug, displayOrder);
      const renders = insertCategory('Renders', 'renders', 0);
      const source = insertCategory('Source', 'source', 1);
      const max = tagRepo.create({ displayName: 'Max', normalizedName: 'max' });
      const benji = tagRepo.create({ displayName: 'Benji', normalizedName: 'benji' });
      const add = (relativePath, extension, categoryId) => assetRepo.upsert(projectId, relativePath, {
        filename: path.posix.basename(relativePath), extension, mimeType: 'image/png',
        sizeBytes: 1, modifiedAt: null, categoryId,
      });
      const heroRender = add('renders/hero.png', 'png', renders.id);
      const heroSource = add('source/hero.psd', 'psd', source.id);
      const plainSource = add('source/plain.png', 'png', source.id);
      const loose = add('loose.png', 'png', null);
      tagRepo.assignToProject(projectId, max.id);
      tagRepo.assignToAsset(heroRender.id, benji.id);

      const ids = (filters) => assetRepo.findProjectAssetPage(projectId, { ...filters, pageSize: 100 })
        .map((asset) => asset.id);
      const all = [heroRender.id, heroSource.id, loose.id, plainSource.id];

      expect(ids({ tag: max.id, category: 'all' }).sort()).toEqual([...all].sort());
      expect(assetRepo.countProjectAssets(projectId, { tag: max.id, category: 'all' })).toBe(all.length);
      expect(ids({ tag: max.id, category: source.id }).sort()).toEqual([heroSource.id, plainSource.id].sort());
      expect(ids({ tag: max.id, category: 'uncategorized' })).toEqual([loose.id]);
      expect(ids({ tag: benji.id, category: 'all' })).toEqual([heroRender.id]);

      // Inherited matches still honor search and extension filters.
      expect(ids({ tag: max.id, search: 'hero' }).sort()).toEqual([heroRender.id, heroSource.id].sort());
      expect(assetRepo.countProjectAssets(projectId, { tag: max.id, search: 'hero' })).toBe(2);
      expect(ids({ tag: max.id, extension: 'png', search: 'hero' })).toEqual([heroRender.id]);
    });

    it('applies tag filtering before pagination and composes with search, extension, presence, and usage', () => {
      const tag = tagRepo.create({ displayName: 'Filtered', normalizedName: 'filtered' });
      const releaseId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'Filtered Release', '', '', NULL, NULL, NULL)
        RETURNING id
      `).get(projectId).id;
      const matching = assetRepo.upsert(projectId, 'renders/hero.png', {
        filename: 'hero.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, modifiedAt: null,
      });
      const wrongExtension = assetRepo.upsert(projectId, 'renders/hero.jpg', {
        filename: 'hero.jpg', extension: 'jpg', mimeType: 'image/jpeg', sizeBytes: 1, modifiedAt: null,
      });
      const missing = assetRepo.upsert(projectId, 'renders/hero-missing.png', {
        filename: 'hero-missing.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, modifiedAt: null,
      });
      tagRepo.assignToAsset(matching.id, tag.id);
      tagRepo.assignToAsset(wrongExtension.id, tag.id);
      tagRepo.assignToAsset(missing.id, tag.id);
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, ['renders/hero.png', 'renders/hero.jpg']);
      linkAssetToRelease(db, { releaseId, assetId: matching.id });

      const filters = { tag: tag.id, search: 'hero', extension: 'png', presence: 'present', usage: 'used' };
      const rows = assetRepo.findProjectAssetPage(projectId, { ...filters, page: 1, pageSize: 1 });

      expect(rows.map((asset) => asset.id)).toEqual([matching.id]);
      expect(assetRepo.countProjectAssets(projectId, filters)).toBe(1);
      expect(assetRepo.findProjectAssetPage(projectId, { tag: tag.id, page: 2, pageSize: 1 })
        .map((asset) => asset.id)).toEqual([wrongExtension.id]);
    });
  });

  describe('countProjectAssets', () => {
    it('returns 0 for project with no assets', () => {
      expect(assetRepo.countProjectAssets(projectId)).toBe(0);
    });

    it('counts all assets with no filters', () => {
      for (let i = 1; i <= 5; i++) {
        assetRepo.upsert(projectId, `file${i}.png`, {
          filename: `file${i}.png`, extension: 'png', mimeType: 'image/png',
          sizeBytes: 100, modifiedAt: null,
        });
      }
      expect(assetRepo.countProjectAssets(projectId)).toBe(5);
    });

    it('parity: count matches filtered page results across all filter combinations', () => {
      for (let i = 1; i <= 5; i++) {
        assetRepo.upsert(projectId, `file${i}.png`, {
          filename: `file${i}.png`, extension: 'png', mimeType: 'image/png',
          sizeBytes: 100, modifiedAt: null,
        });
      }
      assetRepo.upsert(projectId, 'file6.jpg', {
        filename: 'file6.jpg', extension: 'jpg', mimeType: 'image/jpeg',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.upsert(projectId, 'other.txt', {
        filename: 'other.txt', extension: 'txt', mimeType: 'text/plain',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, ['file1.png']);

      const combinations = [
        { presence: 'all', usage: 'all' },
        { presence: 'present', usage: 'all' },
        { presence: 'missing', usage: 'all' },
        { presence: 'all', usage: 'used' },
        { presence: 'all', usage: 'unused' },
        { presence: 'present', usage: 'unused' },
        { presence: 'missing', usage: 'used' },
        { search: 'file', presence: 'all', usage: 'all' },
        { search: 'FILE', extension: 'png', presence: 'all', usage: 'all' },
        { search: 'other', extension: 'txt', presence: 'present', usage: 'unused' },
        { search: 'missing', extension: 'png', presence: 'all', usage: 'all' },
      ];

      for (const combo of combinations) {
        const count = assetRepo.countProjectAssets(projectId, combo);
        const page = assetRepo.findProjectAssetPage(projectId, { ...combo, page: 1, pageSize: 100 });
        expect(count).toBe(page.length);
      }
    });
  });

  describe('findAssetsForNoteAssociation', () => {
    it('returns project context for all indexed assets, including archived and missing rows', () => {
      const archivedProject = createProject('Archived Note Assets');
      const present = assetRepo.upsert(projectId, 'notes/present.txt', {
        filename: 'present.txt',
        extension: 'txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        modifiedAt: null,
      });
      const missing = assetRepo.upsert(archivedProject.id, 'history/missing.bin', {
        filename: 'missing.bin',
        extension: 'bin',
        mimeType: 'application/octet-stream',
        sizeBytes: 20,
        modifiedAt: null,
      });
      assetRepo.markAllMissing(archivedProject.id);
      projectRepo.archive(archivedProject.id);

      const all = assetRepo.findAssetsForNoteAssociation();
      expect(all).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: present.id,
          project_id: projectId,
          project_title: 'Test Project',
          relative_path: 'notes/present.txt',
          filename: 'present.txt',
          is_present: 1,
        }),
        expect.objectContaining({
          id: missing.id,
          project_id: archivedProject.id,
          project_title: 'Archived Note Assets',
          relative_path: 'history/missing.bin',
          filename: 'missing.bin',
          is_present: 0,
        }),
      ]));

      expect(assetRepo.findAssetsForNoteAssociation([missing.id, present.id, missing.id])
        .map((asset) => asset.id))
        .toEqual([missing.id, present.id]);
    });
  });

  describe('searchAssetsForPicker', () => {
    it('returns bounded canonical pages for only one project without omissions or duplicates', () => {
      const otherProject = createProject('Picker Foreign Project');
      const expected = [];
      for (let index = 1; index <= 12; index += 1) {
        expected.push(assetRepo.upsert(projectId, `picker/asset-${String(index).padStart(2, '0')}.png`, {
          filename: `asset-${String(index).padStart(2, '0')}.png`,
          extension: 'png', mimeType: 'image/png', sizeBytes: index, modifiedAt: null,
        }));
      }
      const foreign = assetRepo.upsert(otherProject.id, 'picker/asset-00.png', {
        filename: 'asset-00.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, modifiedAt: null,
      });

      const first = assetRepo.searchAssetsForPicker({ projectId, limit: 5 });
      const second = assetRepo.searchAssetsForPicker({
        projectId, limit: 5, cursor: first.nextCursor,
      });
      const third = assetRepo.searchAssetsForPicker({
        projectId, limit: 5, cursor: second.nextCursor,
      });

      expect(first.rows).toHaveLength(5);
      expect(second.rows).toHaveLength(5);
      expect(third.rows).toHaveLength(2);
      expect([...first.rows, ...second.rows, ...third.rows].map((asset) => asset.id))
        .toEqual(expected.map((asset) => asset.id));
      expect(new Set([...first.rows, ...second.rows, ...third.rows].map((asset) => asset.id)).size).toBe(12);
      expect([...first.rows, ...second.rows, ...third.rows].every((asset) => asset.project_id === projectId))
        .toBe(true);
      expect([...first.rows, ...second.rows, ...third.rows].map((asset) => asset.id)).not.toContain(foreign.id);
      expect(first.rows[0]).toEqual({
        id: expected[0].id,
        project_id: projectId,
        filename: 'asset-01.png',
        relative_path: 'picker/asset-01.png',
        is_present: 1,
      });
      expect(third.nextCursor).toBeNull();
    });

    it('includes missing assets and assets owned by archived projects', () => {
      const archivedProject = createProject('Archived Picker Project');
      const missing = assetRepo.upsert(archivedProject.id, 'history/missing.png', {
        filename: 'missing.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, modifiedAt: null,
      });
      assetRepo.markAllMissing(archivedProject.id);
      projectRepo.archive(archivedProject.id);

      expect(assetRepo.searchAssetsForPicker({ projectId: archivedProject.id, limit: 5 }).rows)
        .toEqual([{
          id: missing.id,
          project_id: archivedProject.id,
          filename: 'missing.png',
          relative_path: 'history/missing.png',
          is_present: 0,
        }]);
    });

    it('searches case-insensitively across filename and relative path with LIKE metacharacters escaped', () => {
      const filenameMatch = assetRepo.upsert(projectId, 'source/Sun_100%.png', {
        filename: 'Sun_100%.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, modifiedAt: null,
      });
      const pathMatch = assetRepo.upsert(projectId, 'archive/hidden-item.png', {
        filename: 'plain.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, modifiedAt: null,
      });
      const escapeMatch = assetRepo.upsert(projectId, 'archive\\backslash.png', {
        filename: 'backslash.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, modifiedAt: null,
      });
      assetRepo.upsert(projectId, 'plain.png', {
        filename: 'plain.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, modifiedAt: null,
      });

      expect(assetRepo.searchAssetsForPicker({ projectId, query: 'sun', limit: 10 }).rows.map((asset) => asset.id))
        .toEqual([filenameMatch.id]);
      expect(assetRepo.searchAssetsForPicker({ projectId, query: 'HIDDEN-', limit: 10 }).rows.map((asset) => asset.id))
        .toEqual([pathMatch.id]);
      expect(assetRepo.searchAssetsForPicker({ projectId, query: '%', limit: 10 }).rows.map((asset) => asset.id))
        .toEqual([filenameMatch.id]);
      expect(assetRepo.searchAssetsForPicker({ projectId, query: '_', limit: 10 }).rows.map((asset) => asset.id))
        .toEqual([filenameMatch.id]);
      expect(assetRepo.searchAssetsForPicker({ projectId, query: '\\', limit: 10 }).rows.map((asset) => asset.id))
        .toEqual([escapeMatch.id]);
    });

    it('uses the canonical filename/id tie-breaker and rejects malformed or mismatched cursors', () => {
      const first = assetRepo.upsert(projectId, 'one/same.png', {
        filename: 'same.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, modifiedAt: null,
      });
      const second = assetRepo.upsert(projectId, 'two/same.png', {
        filename: 'same.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, modifiedAt: null,
      });
      const otherProject = createProject('Cursor Foreign Project');

      const page = assetRepo.searchAssetsForPicker({ projectId, query: 'same', limit: 1 });
      const continuation = assetRepo.searchAssetsForPicker({
        projectId, query: 'same', limit: 1, cursor: page.nextCursor,
      });

      expect(page.rows.map((asset) => asset.id)).toEqual([first.id]);
      expect(continuation.rows.map((asset) => asset.id)).toEqual([second.id]);
      expect(continuation.nextCursor).toBeNull();
      expect(() => assetRepo.searchAssetsForPicker({ projectId, cursor: 'not-a-cursor' }))
        .toThrow(/Invalid asset picker cursor/);
      expect(() => assetRepo.searchAssetsForPicker({
        projectId, query: 'other', limit: 1, cursor: page.nextCursor,
      })).toThrow(/Invalid asset picker cursor/);
      expect(() => assetRepo.searchAssetsForPicker({
        projectId: otherProject.id, query: 'same', limit: 1, cursor: page.nextCursor,
      })).toThrow(/Invalid asset picker cursor/);
    });
  });

  describe('findAllAssets and countAllAssets', () => {
    function insertCategory(forProjectId, {
      displayName,
      directorySlug,
      displayOrder = 0,
      enabled = 1,
    }) {
      return db.prepare(`
        INSERT INTO project_asset_categories (project_id, display_name, directory_slug, display_order, enabled)
        VALUES (?, ?, ?, ?, ?)
        RETURNING *
      `).get(forProjectId, displayName, directorySlug, displayOrder, enabled);
    }

    function addAsset(forProjectId, relativePath, overrides = {}) {
      return assetRepo.upsert(forProjectId, relativePath, {
        filename: overrides.filename ?? relativePath.split('/').pop(),
        extension: overrides.extension ?? 'png',
        mimeType: overrides.mimeType ?? 'image/png',
        sizeBytes: overrides.sizeBytes ?? 100,
        modifiedAt: overrides.modifiedAt ?? null,
        categoryId: overrides.categoryId ?? null,
        nestedPath: overrides.nestedPath ?? '',
      });
    }

    it('lists assets across active projects with project and browser context', () => {
      const other = createProject('Other Project');
      const category = insertCategory(projectId, {
        displayName: 'Source Files',
        directorySlug: 'source',
        displayOrder: 2,
      });
      const categorized = addAsset(projectId, 'source/alpha.png', { categoryId: category.id });
      const uncategorized = addAsset(other.id, 'beta.jpg', { extension: 'jpg' });

      const rows = assetRepo.findAllAssets({ limit: 10 });

      expect(rows.map((row) => row.id)).toEqual([categorized.id, uncategorized.id]);
      expect(rows.find((row) => row.id === categorized.id)).toMatchObject({
        project_id: projectId,
        project_title: 'Test Project',
        category_id: category.id,
        category_display_name: 'Source Files',
        category_directory_slug: 'source',
        category_enabled: 1,
        category_display_order: 2,
        is_present: 1,
        release_usage_count: 0,
      });
      expect(rows.find((row) => row.id === uncategorized.id)).toMatchObject({
        project_id: other.id,
        project_title: 'Other Project',
        category_id: null,
        category_display_name: null,
        category_directory_slug: null,
        category_enabled: null,
        category_display_order: null,
        release_usage_count: 0,
      });
    });

    it('treats only explicit null as unbounded while omission keeps the 25-row default', () => {
      for (let index = 0; index < 30; index++) {
        addAsset(projectId, `asset-${String(index).padStart(2, '0')}.png`);
      }
      const prepareSpy = vi.spyOn(db, 'prepare');

      expect(assetRepo.findAllAssets()).toHaveLength(25);
      expect(prepareSpy.mock.calls.at(-1)[0]).toMatch(/LIMIT \? OFFSET \?/);

      expect(assetRepo.findAllAssets({ limit: null })).toHaveLength(30);
      expect(prepareSpy.mock.calls.at(-1)[0]).not.toMatch(/\bLIMIT\b|\bOFFSET\b/);
    });

    it('narrows the global list and count by project ID', () => {
      const other = createProject('Other Project');
      addAsset(projectId, 'mine.png');
      addAsset(other.id, 'theirs.png');

      const rows = assetRepo.findAllAssets({ projectId: other.id, limit: 10 });

      expect(rows).toHaveLength(1);
      expect(rows[0].project_id).toBe(other.id);
      expect(assetRepo.countAllAssets({ projectId: other.id })).toBe(1);
    });

    describe('WP8 owning Project and Project Type predicates', () => {
      let scope;

      beforeEach(() => {
        const comic = createProject('WP8 Comic', { projectType: 'comic' });
        const animation = createProject('WP8 Animation', { projectType: 'animation' });
        const archived = createProject('WP8 Archived Comic', { projectType: 'comic' });
        const rows = {
          base: addAsset(projectId, 'base.png'),
          baseJpg: addAsset(projectId, 'base.jpg', { extension: 'jpg', mimeType: 'image/jpeg' }),
          comicCbz: addAsset(comic.id, 'issue.cbz', { extension: 'cbz', mimeType: 'application/vnd.comicbook+zip' }),
          comicPng: addAsset(comic.id, 'page.png'),
          animMp4: addAsset(animation.id, 'clip.mp4', { extension: 'mp4', mimeType: 'video/mp4' }),
          archivedTiff: addAsset(archived.id, 'old.tiff', { extension: 'tiff', mimeType: 'image/tiff' }),
        };
        db.prepare(`UPDATE projects SET status = 'archived', archived_at = datetime('now') WHERE id = ?`)
          .run(archived.id);
        scope = { comic, animation, archived, rows };
      });

      const rowIds = (rows) => rows.map((row) => row.id);
      const sortedIds = (...rows) => rows.map((row) => row.id).sort((left, right) => left - right);

      it('ORs Project IDs and ORs Project Types, AND-ing the dimensions on every query surface', () => {
        const { comic, animation, rows } = scope;
        const filters = { projectIds: [animation.id, comic.id], projectTypes: ['comic'] };

        expect(rowIds(assetRepo.findAllAssets({ ...filters, limit: null })).sort((l, r) => l - r))
          .toEqual(sortedIds(rows.comicCbz, rows.comicPng));
        expect(assetRepo.countAllAssets(filters)).toBe(2);
        expect(rowIds(assetRepo.findAllAssetsSlideshowSequence(filters)).sort((l, r) => l - r))
          .toEqual(sortedIds(rows.comicCbz, rows.comicPng));
        expect(assetRepo.listAllAssetExtensions(filters)).toEqual(['cbz', 'png']);

        expect(assetRepo.countAllAssets({ projectIds: [projectId, animation.id] })).toBe(3);
        expect(assetRepo.countAllAssets({ projectTypes: ['images', 'animation'] })).toBe(3);
        expect(assetRepo.listAllAssetExtensions({ projectTypes: ['images', 'animation'] }))
          .toEqual(['jpg', 'mp4', 'png']);
      });

      it('applies the predicates before LIMIT/OFFSET with stable ordering', () => {
        const filters = { projectTypes: ['images', 'comic'], sort: 'filename', order: 'asc' };
        const all = rowIds(assetRepo.findAllAssets({ ...filters, limit: null }));
        const pages = [0, 2].flatMap((offset) => rowIds(assetRepo.findAllAssets({ ...filters, limit: 2, offset })));

        expect(all).toHaveLength(4);
        expect(pages).toEqual(all);
        expect(rowIds(assetRepo.findAllAssetsSlideshowSequence(filters))).toEqual(all);
      });

      it('imposes no restriction for empty or null selections and never emits an empty IN()', () => {
        const prepareSpy = vi.spyOn(db, 'prepare');
        const unrestricted = assetRepo.countAllAssets();

        expect(assetRepo.countAllAssets({ projectIds: [], projectTypes: [] })).toBe(unrestricted);
        expect(assetRepo.countAllAssets({ projectIds: null, projectTypes: null })).toBe(unrestricted);
        expect(unrestricted).toBe(5);
        expect(prepareSpy.mock.calls.map((call) => call[0]).join('\n')).not.toMatch(/IN \(\)/);
      });

      it('keeps archived and unknown Projects ineligible instead of broadening results', () => {
        const { archived, rows } = scope;
        expect(assetRepo.countAllAssets({ projectIds: [archived.id] })).toBe(0);
        expect(assetRepo.countAllAssets({ projectIds: [archived.id, 999999] })).toBe(0);
        expect(rowIds(assetRepo.findAllAssets({ projectIds: [archived.id, projectId], limit: null })).sort((l, r) => l - r))
          .toEqual(sortedIds(rows.base, rows.baseJpg));
        expect(assetRepo.listAllAssetExtensions({ projectIds: [archived.id] })).toEqual([]);
        expect(assetRepo.listAllAssetExtensions({ projectTypes: ['comic'] })).toEqual(['cbz', 'png']);
        expect(assetRepo.listAllAssetExtensions({ projectTypes: ['comic'], includeArchived: true }))
          .toEqual(['cbz', 'png', 'tiff']);
      });

      it('fails closed for non-empty selections without a usable value', () => {
        expect(assetRepo.countAllAssets({ projectIds: ['x', 0, -1] })).toBe(0);
        expect(assetRepo.countAllAssets({ projectTypes: [''] })).toBe(0);
        expect(assetRepo.findAllAssetsSlideshowSequence({ projectTypes: [7] })).toEqual([]);
      });

      it('binds Project Type values as parameters', () => {
        const prepareSpy = vi.spyOn(db, 'prepare');
        const hostile = "comic') OR 1=1 --";
        expect(assetRepo.countAllAssets({ projectTypes: [hostile] })).toBe(0);
        const sql = prepareSpy.mock.calls.at(-1)[0];
        expect(sql).toContain('p.project_type IN (?)');
        expect(sql).not.toContain(hostile);
      });

      it('keeps the legacy scalar projectId filter working', () => {
        const { comic, rows } = scope;
        expect(rowIds(assetRepo.findAllAssets({ projectId: comic.id, limit: null })).sort((l, r) => l - r))
          .toEqual(sortedIds(rows.comicCbz, rows.comicPng));
        expect(assetRepo.listAllAssetExtensions({ projectId: comic.id })).toEqual(['cbz', 'png']);
      });
    });

    it('filters global assets by effective tags across projects before pagination without duplicates', () => {
      const other = createProject('Other Tagged Project');
      const category = insertCategory(projectId, {
        displayName: 'Source Files',
        directorySlug: 'source',
      });
      const otherCategory = insertCategory(other.id, {
        displayName: 'Other Source Files',
        directorySlug: 'source',
      });
      const shared = tagRepo.create({ displayName: 'Global Shared', normalizedName: 'global-shared-secret' });
      const additional = tagRepo.create({ displayName: 'Global Additional', normalizedName: 'global-additional-secret' });
      const projectOnly = tagRepo.create({ displayName: 'Global Project Only', normalizedName: 'global-project-only-secret' });
      const first = addAsset(projectId, 'source/a-first.png', { categoryId: category.id });
      const multiple = addAsset(projectId, 'source/b-multiple.png', { categoryId: category.id });
      const missing = addAsset(projectId, 'source/c-missing.png', { categoryId: category.id });
      const foreign = addAsset(other.id, 'source/d-foreign.png', { categoryId: otherCategory.id });
      const untagged = addAsset(projectId, 'source/e-untagged.png', { categoryId: category.id });
      const wrongExtension = addAsset(projectId, 'source/f-wrong.jpg', {
        categoryId: category.id,
        extension: 'jpg',
      });

      tagRepo.assignToAsset(first.id, shared.id);
      tagRepo.assignToAsset(multiple.id, shared.id);
      tagRepo.assignToAsset(multiple.id, additional.id);
      tagRepo.assignToAsset(missing.id, shared.id);
      tagRepo.assignToAsset(foreign.id, shared.id);
      tagRepo.assignToAsset(wrongExtension.id, shared.id);
      tagRepo.assignToProject(projectId, projectOnly.id);
      tagRepo.assignToAsset(first.id, projectOnly.id);
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, [
        'source/a-first.png',
        'source/b-multiple.png',
        'source/e-untagged.png',
        'source/f-wrong.jpg',
      ]);

      const allMatching = assetRepo.findAllAssets({ tag: shared.id, limit: 100 });
      const firstPage = assetRepo.findAllAssets({ tag: shared.id, limit: 2, offset: 0 });
      const secondPage = assetRepo.findAllAssets({ tag: shared.id, limit: 2, offset: 2 });
      const composedFilters = {
        tag: shared.id,
        projectId,
        category: 'source',
        search: 'source/',
        extension: 'png',
        presence: 'present',
        usage: 'used',
      };
      const release = insertRelease(db, { projectId, title: 'Global Tag Release' });
      linkAssetToRelease(db, { releaseId: release.id, assetId: first.id });

      expect(allMatching.map((asset) => asset.id)).toEqual([
        first.id,
        multiple.id,
        missing.id,
        foreign.id,
        wrongExtension.id,
      ]);
      expect(new Set(allMatching.map((asset) => asset.id)).size).toBe(allMatching.length);
      expect(assetRepo.countAllAssets({ tag: shared.id })).toBe(allMatching.length);
      expect([...firstPage, ...secondPage].map((asset) => asset.id)).toEqual(
        allMatching.slice(0, 4).map((asset) => asset.id),
      );
      expect(allMatching.find((asset) => asset.id === missing.id).is_present).toBe(0);
      const effectiveMatching = assetRepo.findAllAssets({ tag: projectOnly.id, limit: 100 });
      const effectivePages = [0, 2, 4].map((offset) => assetRepo.findAllAssets({
        tag: projectOnly.id,
        limit: 2,
        offset,
      }));

      expect(effectiveMatching.map((asset) => asset.id)).toEqual([
        first.id,
        multiple.id,
        missing.id,
        untagged.id,
        wrongExtension.id,
      ]);
      expect(effectiveMatching.filter((asset) => asset.id === first.id)).toHaveLength(1);
      expect(new Set(effectiveMatching.map((asset) => asset.id)).size).toBe(effectiveMatching.length);
      expect(assetRepo.countAllAssets({ tag: projectOnly.id })).toBe(effectiveMatching.length);
      expect(effectivePages.flat().map((asset) => asset.id)).toEqual(effectiveMatching.map((asset) => asset.id));
      expect(assetRepo.findAllAssets(composedFilters).map((asset) => asset.id)).toEqual([first.id]);
      expect(assetRepo.countAllAssets(composedFilters)).toBe(1);
    });

    it('matches any selected effective tag without duplicate rows and combines category/extension OR sets with AND', () => {
      const beta = createProject('Multi-Value Beta Project');
      const gamma = createProject('Multi-Value Gamma Project');
      const alphaFinal = insertCategory(projectId, {
        displayName: 'Final',
        directorySlug: 'final',
        displayOrder: 1,
      });
      const alphaKrz = insertCategory(projectId, {
        displayName: 'KRZ',
        directorySlug: 'krz',
        displayOrder: 2,
      });
      const betaKrz = insertCategory(beta.id, {
        displayName: 'KRZ',
        directorySlug: 'krz',
        displayOrder: 1,
      });
      const gammaFinal = insertCategory(gamma.id, {
        displayName: 'Final',
        directorySlug: 'final',
        displayOrder: 1,
      });
      const tagA = tagRepo.create({ displayName: 'Tag A', normalizedName: 'multi-tag-a' });
      const tagB = tagRepo.create({ displayName: 'Tag B', normalizedName: 'multi-tag-b' });
      const directA = addAsset(projectId, 'a-final.png', { categoryId: alphaFinal.id });
      const directB = addAsset(projectId, 'b-krz.krz', { categoryId: alphaKrz.id, extension: 'krz' });
      const overlap = addAsset(projectId, 'c-final.krz', { categoryId: alphaFinal.id, extension: 'krz' });
      const inherited = addAsset(beta.id, 'd-krz.png', { categoryId: betaKrz.id });
      const untagged = addAsset(gamma.id, 'e-final.png', { categoryId: gammaFinal.id });

      tagRepo.assignToAsset(directA.id, tagA.id);
      tagRepo.assignToAsset(directB.id, tagB.id);
      tagRepo.assignToAsset(overlap.id, tagA.id);
      tagRepo.assignToAsset(overlap.id, tagB.id);
      tagRepo.assignToProject(projectId, tagA.id);
      tagRepo.assignToProject(projectId, tagB.id);
      tagRepo.assignToProject(beta.id, tagB.id);

      const selectedTags = { tags: [tagB.id, tagA.id, tagB.id], limit: 100 };
      const effectiveRows = assetRepo.findAllAssets(selectedTags);
      const effectiveIds = effectiveRows.map((asset) => asset.id);

      expect(effectiveIds).toEqual([directA.id, directB.id, overlap.id, inherited.id]);
      expect(effectiveRows.filter((asset) => asset.id === overlap.id)).toHaveLength(1);
      expect(new Set(effectiveIds).size).toBe(effectiveIds.length);
      expect(assetRepo.countAllAssets(selectedTags)).toBe(effectiveRows.length);

      const effectivePages = [0, 2].flatMap((offset) => assetRepo.findAllAssets({
        ...selectedTags,
        limit: 2,
        offset,
      }));
      expect(effectivePages.map((asset) => asset.id)).toEqual(effectiveIds);

      const composedFilters = {
        tags: [tagA.id],
        categories: ['krz', 'final'],
        extensions: ['krz', 'png'],
        limit: 100,
      };
      const composedRows = assetRepo.findAllAssets(composedFilters);
      expect(composedRows.map((asset) => asset.id)).toEqual([directA.id, directB.id, overlap.id]);
      expect(assetRepo.countAllAssets(composedFilters)).toBe(composedRows.length);

      const composedPages = [0, 1, 2].flatMap((offset) => assetRepo.findAllAssets({
        ...composedFilters,
        limit: 1,
        offset,
      }));
      expect(composedPages.map((asset) => asset.id)).toEqual(composedRows.map((asset) => asset.id));
      expect(composedRows).not.toContainEqual(expect.objectContaining({ id: inherited.id }));
      expect(composedRows).not.toContainEqual(expect.objectContaining({ id: untagged.id }));
    });

    it('searches filename and relative path across project boundaries', () => {
      const other = createProject('Other Project');
      addAsset(projectId, 'renders/sunset/final.png', { filename: 'final.png' });
      addAsset(other.id, 'exports/SUNSET-cover.jpg', { filename: 'SUNSET-cover.jpg', extension: 'jpg' });
      addAsset(other.id, 'exports/daylight.jpg', { filename: 'daylight.jpg', extension: 'jpg' });

      const rows = assetRepo.findAllAssets({ search: 'sunset', limit: 10 });

      expect(rows.map((row) => row.filename)).toEqual(['final.png', 'SUNSET-cover.jpg']);
      expect(assetRepo.countAllAssets({ search: 'sunset' })).toBe(2);
    });

    it('filters by extension across projects', () => {
      const other = createProject('Other Project');
      addAsset(projectId, 'one.PNG', { filename: 'one.PNG', extension: 'PNG' });
      addAsset(other.id, 'two.jpg', { filename: 'two.jpg', extension: 'jpg' });

      const rows = assetRepo.findAllAssets({ extension: 'png', limit: 10 });

      expect(rows.map((row) => row.filename)).toEqual(['one.PNG']);
      expect(assetRepo.countAllAssets({ extension: 'png' })).toBe(1);
    });

    it('filters by presence across projects', () => {
      const other = createProject('Other Project');
      const present = addAsset(projectId, 'present.png');
      const missing = addAsset(projectId, 'missing.png');
      const otherMissing = addAsset(other.id, 'other-missing.png');
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, ['present.png']);
      assetRepo.markAllMissing(other.id);

      const rows = assetRepo.findAllAssets({ presence: 'missing', limit: 10 });

      expect(rows.map((row) => row.id)).toEqual([missing.id, otherMissing.id]);
      expect(rows.every((row) => row.is_present === 0)).toBe(true);
      expect(assetRepo.countAllAssets({ presence: 'present' })).toBe(1);
      expect(present.id).not.toBe(missing.id);
    });

    it('filters release usage without duplicating assets and counts distinct releases', () => {
      const used = addAsset(projectId, 'used.png');
      addAsset(projectId, 'unused.png');
      const releaseOne = insertRelease(db, { projectId, title: 'Release One' });
      const releaseTwo = insertRelease(db, { projectId, title: 'Release Two' });
      linkAssetToRelease(db, { releaseId: releaseOne.id, assetId: used.id });
      linkAssetToRelease(db, { releaseId: releaseTwo.id, assetId: used.id });

      const usedRows = assetRepo.findAllAssets({ usage: 'used', limit: 10 });
      const unusedRows = assetRepo.findAllAssets({ usage: 'unused', limit: 10 });

      expect(usedRows).toHaveLength(1);
      expect(usedRows[0]).toMatchObject({ id: used.id, release_usage_count: 2 });
      expect(unusedRows).toHaveLength(1);
      expect(unusedRows[0].filename).toBe('unused.png');
      expect(assetRepo.countAllAssets({ usage: 'used' })).toBe(1);
    });

    it('filters categories by stable project-category slug and all includes uncategorized assets', () => {
      const other = createProject('Other Project');
      const source = insertCategory(projectId, {
        displayName: 'Source Files',
        directorySlug: 'source',
      });
      const otherSource = insertCategory(other.id, {
        displayName: 'Imported Source',
        directorySlug: 'source',
      });
      const sameNameDifferentSlug = insertCategory(other.id, {
        displayName: 'Source Files',
        directorySlug: 'references',
      });
      const first = addAsset(projectId, 'source/first.png', { categoryId: source.id });
      const second = addAsset(other.id, 'source/second.png', { categoryId: otherSource.id });
      const differentSlug = addAsset(other.id, 'references/third.png', {
        categoryId: sameNameDifferentSlug.id,
      });
      const uncategorized = addAsset(projectId, 'root.png');

      const sourceRows = assetRepo.findAllAssets({ category: 'source', limit: 10 });
      const allRows = assetRepo.findAllAssets({ category: 'all', limit: 10 });
      const uncategorizedRows = assetRepo.findAllAssets({ category: 'uncategorized', limit: 10 });

      expect(sourceRows.map((row) => row.id)).toEqual([first.id, second.id]);
      expect(sourceRows.every((row) => row.category_directory_slug === 'source')).toBe(true);
      expect(allRows.map((row) => row.id)).toEqual([
        first.id,
        uncategorized.id,
        second.id,
        differentSlug.id,
      ]);
      expect(uncategorizedRows.map((row) => row.id)).toEqual([uncategorized.id]);
      expect(assetRepo.findAllAssets({ category: source.id, limit: 10 })).toEqual([]);
      expect(assetRepo.countAllAssets({ category: 'all' })).toBe(4);
    });

    it('orders every supported sort deterministically, including project sort', () => {
      const alphaProject = createProject('Alpha Project');
      const zetaProject = createProject('Zeta Project');
      const alphaCategory = insertCategory(alphaProject.id, {
        displayName: 'Alpha Category',
        directorySlug: 'alpha',
        displayOrder: 2,
      });
      const zetaCategory = insertCategory(zetaProject.id, {
        displayName: 'Zeta Category',
        directorySlug: 'zeta',
        displayOrder: 1,
      });

      const alphaSame = addAsset(alphaProject.id, 'nested/same.txt', {
        filename: 'same.txt',
        extension: 'txt',
        sizeBytes: 10,
        modifiedAt: '2026-01-01T00:00:00.000Z',
        categoryId: alphaCategory.id,
      });
      const zetaSame = addAsset(zetaProject.id, 'nested/same.txt', {
        filename: 'same.txt',
        extension: 'txt',
        sizeBytes: 20,
        modifiedAt: '2026-02-01T00:00:00.000Z',
        categoryId: zetaCategory.id,
      });
      const alphaUncategorized = addAsset(alphaProject.id, 'A.png', {
        filename: 'A.png',
        sizeBytes: 20,
        modifiedAt: '2026-03-01T00:00:00.000Z',
      });
      const zetaLast = addAsset(zetaProject.id, 'z.png', {
        filename: 'z.png',
        sizeBytes: 30,
        modifiedAt: null,
        categoryId: zetaCategory.id,
      });

      const expected = {
        filename: [alphaUncategorized, alphaSame, zetaSame, zetaLast],
        modified: [alphaSame, zetaSame, alphaUncategorized, zetaLast],
        size: [alphaSame, zetaSame, alphaUncategorized, zetaLast],
        category: [zetaSame, zetaLast, alphaSame, alphaUncategorized],
        project: [alphaSame, alphaUncategorized, zetaSame, zetaLast],
      };

      for (const [sort, assets] of Object.entries(expected)) {
        const firstRun = assetRepo.findAllAssets({ sort, order: 'asc', limit: 10 });
        const secondRun = assetRepo.findAllAssets({ sort, order: 'asc', limit: 10 });
        const expectedIds = assets.map((asset) => asset.id);

        expect(firstRun.map((row) => row.id), sort).toEqual(expectedIds);
        expect(secondRun.map((row) => row.id), sort).toEqual(expectedIds);
      }
    });

    it('paginates after sorting and keeps count independent of pagination', () => {
      const other = createProject('Other Project');
      addAsset(projectId, 'charlie.png', { filename: 'charlie.png' });
      addAsset(other.id, 'alpha.png', { filename: 'alpha.png' });
      addAsset(projectId, 'delta.png', { filename: 'delta.png' });
      addAsset(other.id, 'bravo.png', { filename: 'bravo.png' });

      const page = assetRepo.findAllAssets({ sort: 'filename', order: 'asc', limit: 2, offset: 1 });

      expect(page.map((row) => row.filename)).toEqual(['bravo.png', 'charlie.png']);
      expect(assetRepo.countAllAssets()).toBe(4);
    });

    it('keeps count equal to an unpaged filtered listing total', () => {
      const category = insertCategory(projectId, {
        displayName: 'Source',
        directorySlug: 'source',
      });
      addAsset(projectId, 'source/match.png', { categoryId: category.id });
      addAsset(projectId, 'source/missing.png', { categoryId: category.id });
      addAsset(projectId, 'source/other.jpg', { categoryId: category.id, extension: 'jpg' });
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, ['source/match.png', 'source/other.jpg']);

      const filters = {
        projectId,
        category: 'source',
        search: 'match',
        extension: 'png',
        presence: 'present',
        usage: 'unused',
      };
      const rows = assetRepo.findAllAssets({ ...filters, limit: 100, offset: 0 });

      expect(assetRepo.countAllAssets(filters)).toBe(rows.length);
      expect(rows).toHaveLength(1);
    });

    it('excludes projects archived by either archive indicator from active browsing', () => {
      const active = createProject('Active Assets');
      const archived = createProject('Archived Assets');
      const statusOnlyArchived = createProject('Status Only Archived Assets', { status: 'archived' });
      projectRepo.archive(archived.id);
      const activeAsset = addAsset(active.id, 'active.png');
      addAsset(archived.id, 'archived.png');
      addAsset(statusOnlyArchived.id, 'status-only-archived.png');

      const rows = assetRepo.findAllAssets({ limit: 100 });

      expect(rows.map((row) => row.id)).toEqual([activeAsset.id]);
      expect(assetRepo.countAllAssets()).toBe(1);
      expect(assetRepo.findAllAssets({ projectId: archived.id, limit: 100 })).toEqual([]);
    });

    it('lists normalized extensions across active projects and selected active scope', () => {
      const other = createProject('Extension Other');
      const archived = createProject('Extension Archived', { status: 'archived' });
      projectRepo.archive(archived.id);
      addAsset(projectId, 'one.PNG', { extension: 'PNG' });
      addAsset(other.id, 'two.jpg', { extension: 'jpg' });
      addAsset(archived.id, 'three.kra', { extension: 'kra' });

      expect(assetRepo.listAllAssetExtensions()).toEqual(['jpg', 'png']);
      expect(assetRepo.listAllAssetExtensions({ projectId: other.id })).toEqual(['jpg']);
    });
  });

  describe('findProjectAssetViewerContext', () => {
    function addViewerAsset(relativePath, overrides = {}) {
      return assetRepo.upsert(projectId, relativePath, {
        filename: overrides.filename ?? relativePath.split('/').pop(),
        extension: overrides.extension ?? 'txt',
        mimeType: overrides.mimeType ?? 'text/plain',
        sizeBytes: overrides.sizeBytes ?? 100,
        modifiedAt: overrides.modifiedAt ?? null,
      });
    }

    it('returns exact adjacent IDs for first, middle, and last assets', () => {
      const first = addViewerAsset('01-first.txt');
      const middle = addViewerAsset('02-middle.txt');
      const last = addViewerAsset('03-last.txt');

      const firstContext = assetRepo.findProjectAssetViewerContext(projectId, first.id);
      const middleContext = assetRepo.findProjectAssetViewerContext(projectId, middle.id);
      const lastContext = assetRepo.findProjectAssetViewerContext(projectId, last.id);

      expect(firstContext.filtered_position).toBe(1);
      expect(firstContext.previous_asset_id).toBeNull();
      expect(firstContext.next_asset_id).toBe(middle.id);
      expect(firstContext.filtered_total).toBe(3);

      expect(middleContext.filtered_position).toBe(2);
      expect(middleContext.previous_asset_id).toBe(first.id);
      expect(middleContext.next_asset_id).toBe(last.id);
      expect(middleContext.filtered_total).toBe(3);

      expect(lastContext.filtered_position).toBe(3);
      expect(lastContext.previous_asset_id).toBe(middle.id);
      expect(lastContext.next_asset_id).toBeNull();
      expect(lastContext.filtered_total).toBe(3);
    });

    it('returns the current project asset with null adjacency when excluded by filters', () => {
      const visible = addViewerAsset('visible.txt');
      const current = addViewerAsset('hidden.txt');

      const context = assetRepo.findProjectAssetViewerContext(projectId, current.id, { search: 'visible' });

      expect(context.id).toBe(current.id);
      expect(context.filtered_position).toBeNull();
      expect(context.previous_asset_id).toBeNull();
      expect(context.next_asset_id).toBeNull();
      expect(context.filtered_total).toBe(1);
      expect(visible.id).toBeGreaterThan(0);
    });

    it('returns undefined for unknown and cross-project assets', () => {
      const otherProject = projectRepo.create({
        title: 'Viewer Other', slug: 'viewer-other', description: '', notes: '',
        status: 'tbd', projectType: 'images', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null,
      });
      const otherAsset = assetRepo.upsert(otherProject.id, 'other.txt', {
        filename: 'other.txt', extension: 'txt', mimeType: 'text/plain',
        sizeBytes: 100, modifiedAt: null,
      });

      expect(assetRepo.findProjectAssetViewerContext(projectId, 999999)).toBeUndefined();
      expect(assetRepo.findProjectAssetViewerContext(projectId, otherAsset.id)).toBeUndefined();
    });

    it('uses asset ID to break deterministic case-insensitive filename ties', () => {
      const lower = addViewerAsset('one/readme.txt', { filename: 'readme.txt' });
      const upper = addViewerAsset('two/README.txt', { filename: 'README.txt' });

      const lowerContext = assetRepo.findProjectAssetViewerContext(projectId, lower.id);
      const upperContext = assetRepo.findProjectAssetViewerContext(projectId, upper.id);

      expect(lower.id).toBeLessThan(upper.id);
      expect(lowerContext.filtered_position).toBe(1);
      expect(lowerContext.next_asset_id).toBe(upper.id);
      expect(upperContext.filtered_position).toBe(2);
      expect(upperContext.previous_asset_id).toBe(lower.id);
    });

    it('uses asset ID (not extension) to break equal-filename ties — canonical filename sort has no natural/extension tiebreak', () => {
      const png = addViewerAsset('renders/png-file', { filename: 'asset', extension: 'png', mimeType: 'image/png' });
      const jpg = addViewerAsset('renders/jpg-file', { filename: 'asset', extension: 'jpg', mimeType: 'image/jpeg' });

      const jpgContext = assetRepo.findProjectAssetViewerContext(projectId, jpg.id);
      const pngContext = assetRepo.findProjectAssetViewerContext(projectId, png.id);

      expect(jpg.id).toBeGreaterThan(png.id);
      // Filenames are identical ("asset"), so the only tie-breaker is a.id ASC.
      expect(pngContext.filtered_position).toBe(1);
      expect(pngContext.next_asset_id).toBe(jpg.id);
      expect(jpgContext.filtered_position).toBe(2);
      expect(jpgContext.previous_asset_id).toBe(png.id);
    });

    it('uses asset ID to break exact filename and extension ties', () => {
      const first = addViewerAsset('one/duplicate', { filename: 'duplicate', extension: 'bin', mimeType: 'application/octet-stream' });
      const second = addViewerAsset('two/duplicate', { filename: 'duplicate', extension: 'bin', mimeType: 'application/octet-stream' });

      const firstContext = assetRepo.findProjectAssetViewerContext(projectId, first.id);
      const secondContext = assetRepo.findProjectAssetViewerContext(projectId, second.id);

      expect(first.id).toBeLessThan(second.id);
      expect(firstContext.filtered_position).toBe(1);
      expect(firstContext.next_asset_id).toBe(second.id);
      expect(secondContext.filtered_position).toBe(2);
      expect(secondContext.previous_asset_id).toBe(first.id);
    });
  });

  describe('presence filter', () => {
    it('presence=all returns all assets', () => {
      assetRepo.upsert(projectId, 'present.png', {
        filename: 'present.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.upsert(projectId, 'missing.png', {
        filename: 'missing.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, ['present.png']);

      const results = assetRepo.findProjectAssetPage(projectId, { presence: 'all', pageSize: 100 });
      expect(results).toHaveLength(2);
    });

    it('presence=present returns only present assets', () => {
      assetRepo.upsert(projectId, 'present.png', {
        filename: 'present.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.upsert(projectId, 'missing.png', {
        filename: 'missing.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, ['present.png']);

      const results = assetRepo.findProjectAssetPage(projectId, { presence: 'present', pageSize: 100 });
      expect(results).toHaveLength(1);
      expect(results[0].filename).toBe('present.png');
    });

    it('presence=missing returns only missing assets', () => {
      assetRepo.upsert(projectId, 'present.png', {
        filename: 'present.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.upsert(projectId, 'missing.png', {
        filename: 'missing.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, ['present.png']);

      const results = assetRepo.findProjectAssetPage(projectId, { presence: 'missing', pageSize: 100 });
      expect(results).toHaveLength(1);
      expect(results[0].filename).toBe('missing.png');
    });
  });

  describe('usage filter', () => {
    it('usage=all returns all assets', () => {
      assetRepo.upsert(projectId, 'used.png', {
        filename: 'used.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.upsert(projectId, 'unused.png', {
        filename: 'unused.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });

      const results = assetRepo.findProjectAssetPage(projectId, { usage: 'all', pageSize: 100 });
      expect(results).toHaveLength(2);
    });

    it('usage=used returns only assets with release_assets rows', () => {
      const relId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'R1', '', '', NULL, NULL, NULL)
        RETURNING id
      `).get(projectId).id;

      assetRepo.upsert(projectId, 'used.png', {
        filename: 'used.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.upsert(projectId, 'unused.png', {
        filename: 'unused.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      const usedAsset = assetRepo.findByProjectIdAndPath(projectId, 'used.png');
      linkAssetToRelease(db, { releaseId: relId, assetId: usedAsset.id });

      const results = assetRepo.findProjectAssetPage(projectId, { usage: 'used', pageSize: 100 });
      expect(results).toHaveLength(1);
      expect(results[0].filename).toBe('used.png');
    });

    it('usage=unused returns only assets with no release_assets rows', () => {
      const relId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'R1', '', '', NULL, NULL, NULL)
        RETURNING id
      `).get(projectId).id;

      assetRepo.upsert(projectId, 'used.png', {
        filename: 'used.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.upsert(projectId, 'unused.png', {
        filename: 'unused.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      const usedAsset = assetRepo.findByProjectIdAndPath(projectId, 'used.png');
      linkAssetToRelease(db, { releaseId: relId, assetId: usedAsset.id });

      const results = assetRepo.findProjectAssetPage(projectId, { usage: 'unused', pageSize: 100 });
      expect(results).toHaveLength(1);
      expect(results[0].filename).toBe('unused.png');
    });

    it('usage=used with no releases returns empty', () => {
      assetRepo.upsert(projectId, 'unused.png', {
        filename: 'unused.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });

      const results = assetRepo.findProjectAssetPage(projectId, { usage: 'used', pageSize: 100 });
      expect(results).toHaveLength(0);
    });

    it('cross-project corrupt reference does not count as used', () => {
      const otherProject = projectRepo.create({
        title: 'Other', slug: 'other', description: '', notes: '',
        status: 'tbd', projectType: 'images', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null,
      });
      const otherRelId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'Other Release', '', '', NULL, NULL, NULL)
        RETURNING id
      `).get(otherProject.id).id;

      assetRepo.upsert(projectId, 'mine.png', {
        filename: 'mine.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      const myAsset = assetRepo.findByProjectIdAndPath(projectId, 'mine.png');
      // Corrupt cross-project junction row: myAsset belongs to projectId,
      // but the release belongs to otherProject.
      linkAssetToRelease(db, { releaseId: otherRelId, assetId: myAsset.id });

      const results = assetRepo.findProjectAssetPage(projectId, { usage: 'used', pageSize: 100 });
      expect(results).toHaveLength(0);
    });

    it('asset with only corrupt cross-project references is unused', () => {
      const otherProject = projectRepo.create({
        title: 'Other', slug: 'other', description: '', notes: '',
        status: 'tbd', projectType: 'images', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null,
      });
      const otherRelId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'Other Release', '', '', NULL, NULL, NULL)
        RETURNING id
      `).get(otherProject.id).id;

      assetRepo.upsert(projectId, 'mine.png', {
        filename: 'mine.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      const myAsset = assetRepo.findByProjectIdAndPath(projectId, 'mine.png');
      linkAssetToRelease(db, { releaseId: otherRelId, assetId: myAsset.id });

      const results = assetRepo.findProjectAssetPage(projectId, { usage: 'unused', pageSize: 100 });
      expect(results).toHaveLength(1);
      expect(results[0].filename).toBe('mine.png');
    });

    it('mixed valid and corrupt references: only valid releases count for used filter', () => {
      const otherProject = projectRepo.create({
        title: 'Other', slug: 'other', description: '', notes: '',
        status: 'tbd', projectType: 'images', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null,
      });
      const otherRelId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'Other Release', '', '', NULL, NULL, NULL)
        RETURNING id
      `).get(otherProject.id).id;
      const myRelId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'My Release', '', '', NULL, NULL, NULL)
        RETURNING id
      `).get(projectId).id;

      assetRepo.upsert(projectId, 'mine.png', {
        filename: 'mine.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      const myAsset = assetRepo.findByProjectIdAndPath(projectId, 'mine.png');
      // Corrupt cross-project reference
      linkAssetToRelease(db, { releaseId: otherRelId, assetId: myAsset.id });
      // Valid same-project reference
      linkAssetToRelease(db, { releaseId: myRelId, assetId: myAsset.id });

      const results = assetRepo.findProjectAssetPage(projectId, { usage: 'used', pageSize: 100 });
      expect(results).toHaveLength(1);
      expect(results[0].filename).toBe('mine.png');
    });
  });

  describe('combined filters', () => {
    it('presence=present and usage=used together', () => {
      const relId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'R1', '', '', NULL, NULL, NULL)
        RETURNING id
      `).get(projectId).id;

      assetRepo.upsert(projectId, 'present-used.png', {
        filename: 'present-used.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.upsert(projectId, 'present-unused.png', {
        filename: 'present-unused.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.upsert(projectId, 'missing-used.png', {
        filename: 'missing-used.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.upsert(projectId, 'missing-unused.png', {
        filename: 'missing-unused.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, ['present-used.png', 'present-unused.png']);

      const presentUsed = assetRepo.findByProjectIdAndPath(projectId, 'present-used.png');
      const missingUsed = assetRepo.findByProjectIdAndPath(projectId, 'missing-used.png');
      linkAssetToRelease(db, { releaseId: relId, assetId: presentUsed.id });
      linkAssetToRelease(db, { releaseId: relId, assetId: missingUsed.id });

      const results = assetRepo.findProjectAssetPage(projectId, {
        presence: 'present',
        usage: 'used',
        pageSize: 100,
      });
      expect(results).toHaveLength(1);
      expect(results[0].filename).toBe('present-used.png');
    });
  });

  describe('release_usage_count', () => {
    it('counts distinct releases for an asset', () => {
      const r1Id = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'R1', '', '', NULL, NULL, NULL)
        RETURNING id
      `).get(projectId).id;
      const r2Id = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'R2', '', '', NULL, NULL, NULL)
        RETURNING id
      `).get(projectId).id;
      const r3Id = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'R3', '', '', NULL, '2026-01-01', NULL)
        RETURNING id
      `).get(projectId).id;

      assetRepo.upsert(projectId, 'multi.png', {
        filename: 'multi.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      const asset = assetRepo.findByProjectIdAndPath(projectId, 'multi.png');
      linkAssetToRelease(db, { releaseId: r1Id, assetId: asset.id });
      linkAssetToRelease(db, { releaseId: r2Id, assetId: asset.id });
      linkAssetToRelease(db, { releaseId: r3Id, assetId: asset.id });

      const results = assetRepo.findProjectAssetPage(projectId, { pageSize: 100 });
      const result = results.find((a) => a.id === asset.id);
      expect(result.release_usage_count).toBe(3);
    });

    it('zero for assets with no release references', () => {
      assetRepo.upsert(projectId, 'loner.png', {
        filename: 'loner.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });

      const results = assetRepo.findProjectAssetPage(projectId, { pageSize: 100 });
      const result = results.find((a) => a.filename === 'loner.png');
      expect(result.release_usage_count).toBe(0);
    });

    it('cross-project corrupt reference does not increase release_usage_count', () => {
      const otherProject = projectRepo.create({
        title: 'Other', slug: 'other', description: '', notes: '',
        status: 'tbd', projectType: 'images', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null,
      });
      const otherRelId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'Other Release', '', '', NULL, NULL, NULL)
        RETURNING id
      `).get(otherProject.id).id;

      assetRepo.upsert(projectId, 'mine.png', {
        filename: 'mine.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      const myAsset = assetRepo.findByProjectIdAndPath(projectId, 'mine.png');
      linkAssetToRelease(db, { releaseId: otherRelId, assetId: myAsset.id });

      const results = assetRepo.findProjectAssetPage(projectId, { pageSize: 100 });
      const result = results.find((a) => a.id === myAsset.id);
      expect(result.release_usage_count).toBe(0);
    });

    it('mixed valid and corrupt references count only valid releases', () => {
      const otherProject = projectRepo.create({
        title: 'Other', slug: 'other', description: '', notes: '',
        status: 'tbd', projectType: 'images', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null,
      });
      const otherRelId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'Other Release', '', '', NULL, NULL, NULL)
        RETURNING id
      `).get(otherProject.id).id;
      const myRelId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'My Release', '', '', NULL, NULL, NULL)
        RETURNING id
      `).get(projectId).id;

      assetRepo.upsert(projectId, 'mine.png', {
        filename: 'mine.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      const myAsset = assetRepo.findByProjectIdAndPath(projectId, 'mine.png');
      // Corrupt cross-project reference
      linkAssetToRelease(db, { releaseId: otherRelId, assetId: myAsset.id });
      // Valid same-project reference
      linkAssetToRelease(db, { releaseId: myRelId, assetId: myAsset.id });

      const results = assetRepo.findProjectAssetPage(projectId, { pageSize: 100 });
      const result = results.find((a) => a.id === myAsset.id);
      expect(result.release_usage_count).toBe(1);
    });

    it('rendered usage count equals rendered release references', () => {
      const r1Id = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'R1', '', '', NULL, NULL, NULL)
        RETURNING id
      `).get(projectId).id;
      const r2Id = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'R2', '', '', NULL, NULL, NULL)
        RETURNING id
      `).get(projectId).id;

      assetRepo.upsert(projectId, 'multi.png', {
        filename: 'multi.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });
      const asset = assetRepo.findByProjectIdAndPath(projectId, 'multi.png');
      linkAssetToRelease(db, { releaseId: r1Id, assetId: asset.id });
      linkAssetToRelease(db, { releaseId: r2Id, assetId: asset.id });

      const results = assetRepo.findProjectAssetPage(projectId, { pageSize: 100 });
      const result = results.find((a) => a.id === asset.id);
      // release_usage_count is the number of distinct releases
      // The rendered release_usage array length should match
      expect(result.release_usage_count).toBe(2);
    });
  });

  describe('out-of-range pages', () => {
    it('page beyond total returns empty array', () => {
      assetRepo.upsert(projectId, 'a.png', {
        filename: 'a.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });

      const results = assetRepo.findProjectAssetPage(projectId, { page: 99, pageSize: 25 });
      expect(results).toHaveLength(0);
    });

    it('page 0 falls back to page 1 behavior', () => {
      assetRepo.upsert(projectId, 'a.png', {
        filename: 'a.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });

      const results = assetRepo.findProjectAssetPage(projectId, { page: 0, pageSize: 25 });
      expect(results).toHaveLength(1);
    });

    it('negative page falls back to page 1 behavior', () => {
      assetRepo.upsert(projectId, 'a.png', {
        filename: 'a.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null,
      });

      const results = assetRepo.findProjectAssetPage(projectId, { page: -5, pageSize: 25 });
      expect(results).toHaveLength(1);
    });
  });

  // ─── Phase 2 chunk 1: category_id / nested_path ─────────────────────

  function createCategory(forProjectId, displayName, directorySlug) {
    return db.prepare(`
      INSERT INTO project_asset_categories (project_id, display_name, directory_slug)
      VALUES (?, ?, ?)
      RETURNING id, project_id, display_name, directory_slug
    `).get(forProjectId, displayName, directorySlug);
  }

  describe('category_id and nested_path', () => {
    it('upsert persists category_id and nested_path', () => {
      const category = createCategory(projectId, 'Source', 'source');

      const asset = assetRepo.upsert(projectId, 'source/file.kra', {
        filename: 'file.kra', extension: 'kra', mimeType: 'application/x-krita',
        sizeBytes: 100, modifiedAt: null, categoryId: category.id, nestedPath: '',
      });

      expect(asset.category_id).toBe(category.id);
      expect(asset.nested_path).toBe('');
    });

    it('upsert defaults to NULL category_id and empty nested_path', () => {
      const asset = assetRepo.upsert(projectId, 'cover.png', {
        filename: 'cover.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 10, modifiedAt: null,
      });

      expect(asset.category_id).toBeNull();
      expect(asset.nested_path).toBe('');
    });

    it('exposes category_id and nested_path on every relevant projection', () => {
      const category = createCategory(projectId, 'Exports', 'exports');
      const asset = assetRepo.upsert(projectId, 'exports/web/final.png', {
        filename: 'final.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: null, categoryId: category.id, nestedPath: 'web',
      });

      expect(assetRepo.findById(asset.id).category_id).toBe(category.id);
      expect(assetRepo.findById(asset.id).nested_path).toBe('web');

      const byPath = assetRepo.findByProjectIdAndPath(projectId, 'exports/web/final.png');
      expect(byPath.category_id).toBe(category.id);
      expect(byPath.nested_path).toBe('web');

      const listed = assetRepo.findByProjectId(projectId).find((a) => a.id === asset.id);
      expect(listed.category_id).toBe(category.id);
      expect(listed.nested_path).toBe('web');

      const page = assetRepo.findProjectAssetPage(projectId, { pageSize: 10 }).find((a) => a.id === asset.id);
      expect(page.category_id).toBe(category.id);
      expect(page.nested_path).toBe('web');

      const viewer = assetRepo.findProjectAssetViewerContext(projectId, asset.id);
      expect(viewer.category_id).toBe(category.id);
      expect(viewer.nested_path).toBe('web');
    });
  });

  // ─── Phase 2 chunk 1: atomic scan reconciliation ────────────────────

  describe('reconcileSource', () => {
    function stored() {
      return assetRepo.upsert(projectId, 'r.png', {
        filename: 'r.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: '2026-01-01T00:00:00.000Z',
      });
    }

    it('advances the generation in the same write for a proven same-tuple replacement', () => {
      const asset = stored();
      const sameTuple = { size: 100, mtime: '2026-01-01T00:00:00.000Z' };
      expect(assetRepo.reconcileSource(asset, sameTuple).source_generation).toBe(0);
      const replaced = assetRepo.reconcileSource(asset, sameTuple, { replaced: true });
      expect(replaced).toMatchObject({ size_bytes: 100, source_generation: 1 });
    });

    it('advances once for a changed tuple and never twice for one transition', () => {
      const asset = stored();
      const changed = { size: 101, mtime: '2026-01-02T00:00:00.000Z' };
      expect(assetRepo.reconcileSource(asset, changed)).toMatchObject({ size_bytes: 101, source_generation: 1 });
      // A loser still holding the old row matches nothing and writes nothing.
      expect(assetRepo.reconcileSource(asset, changed, { replaced: true })).toBeUndefined();
      expect(assetRepo.findById(asset.id).source_generation).toBe(1);
    });

    it('rejects a row whose source generation moved on even with an equal tuple', () => {
      const asset = stored();
      db.prepare('UPDATE assets SET source_generation = 1 WHERE id = ?').run(asset.id);
      expect(assetRepo.reconcileSource(asset, { size: 100, mtime: '2026-01-01T00:00:00.000Z' },
        { replaced: true })).toBeUndefined();
      expect(assetRepo.findById(asset.id).source_generation).toBe(1);
    });

    it('keeps the generation when an unknown animation state is learned', () => {
      const asset = stored();
      const learned = assetRepo.reconcileSource(asset,
        { size: 100, mtime: '2026-01-01T00:00:00.000Z', animated: false });
      expect(learned).toMatchObject({ source_animated: 0, source_generation: 0 });
      expect(assetRepo.reconcileSource(learned,
        { size: 100, mtime: '2026-01-01T00:00:00.000Z', animated: true }).source_generation).toBe(1);
    });

    it('keeps the generation for an idempotent upsert and advances it for a changed or restored one', () => {
      stored();
      expect(stored().source_generation).toBe(0);
      const changed = assetRepo.upsert(projectId, 'r.png', {
        filename: 'r.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 200, modifiedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(changed.source_generation).toBe(1);
      assetRepo.markAllMissing(projectId);
      expect(assetRepo.restorePresent(projectId, ['r.png'])).toBe(1);
      expect(assetRepo.findById(changed.id).source_generation).toBe(2);
    });
  });

  describe('applyAssetConversions re-encode', () => {
    function storedWebp(sourceAnimated) {
      return assetRepo.upsert(projectId, 'c.webp', {
        filename: 'c.webp', extension: 'webp', mimeType: 'image/webp',
        sizeBytes: 100, modifiedAt: '2026-01-01T00:00:00.000Z', sourceAnimated,
      });
    }

    function reencode(asset, sourceAnimated) {
      return {
        assetId: asset.id,
        expectedRelativePath: asset.relative_path,
        expectedSizeBytes: asset.size_bytes,
        expectedModifiedAt: asset.modified_at,
        sizeBytes: 60,
        modifiedAt: '2026-01-02T00:00:00.000Z',
        sourceAnimated,
      };
    }

    it('writes the new animation state in the same update that advances the generation', () => {
      const asset = storedWebp(true);
      expect(asset).toMatchObject({ source_animated: 1, source_generation: 0 });
      const { reencoded } = assetRepo.applyAssetConversions(projectId, {
        reencodes: [reencode(asset, false)],
      });
      expect(reencoded[0]).toMatchObject({
        size_bytes: 60,
        modified_at: '2026-01-02T00:00:00.000Z',
        source_animated: 0,
        source_generation: 1,
      });
      expect(assetRepo.findById(asset.id)).toMatchObject({ source_animated: 0, source_generation: 1 });
    });

    it('records an unclassified output as unknown instead of inheriting the old state', () => {
      const asset = storedWebp(true);
      const { reencoded } = assetRepo.applyAssetConversions(projectId, {
        reencodes: [reencode(asset, null)],
      });
      expect(reencoded[0]).toMatchObject({ source_animated: null, source_generation: 1 });
    });

    it('leaves generation and animation untouched when the expected row is stale', () => {
      const asset = storedWebp(true);
      expect(() => assetRepo.applyAssetConversions(projectId, {
        reencodes: [{ ...reencode(asset, false), expectedSizeBytes: 99 }],
      })).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
      expect(assetRepo.findById(asset.id)).toMatchObject({
        size_bytes: 100, source_animated: 1, source_generation: 0,
      });
    });
  });

  describe('applyAssetWatermarks replacement', () => {
    const SHA = 'a'.repeat(64);

    function storedGeneratedWebp(sourceAnimated) {
      const source = assetRepo.upsert(projectId, 'w.png', {
        filename: 'w.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 50, modifiedAt: '2026-01-01T00:00:00.000Z',
      });
      const { outputs: [output] } = assetRepo.applyAssetWatermarks(projectId, {
        outputs: [{
          relativePath: 'wm/w_wm.webp', filename: 'w_wm.webp', extension: 'webp', mimeType: 'image/webp',
          sizeBytes: 100, modifiedAt: '2026-01-01T00:00:00.000Z',
          generatedSourceAssetId: source.id, generatedSourceRelativePath: 'w.png',
          generatedMode: 'patreon', generatedOutputSha256: SHA,
        }],
      });
      db.prepare('UPDATE assets SET source_animated = ? WHERE id = ?').run(sourceAnimated, output.id);
      return { source, output: assetRepo.findById(output.id) };
    }

    function replacement({ source, output }, sourceAnimated) {
      return {
        assetId: output.id,
        expectedOldRelativePath: output.relative_path,
        generatedSourceAssetId: source.id,
        generatedSourceRelativePath: 'w.png',
        generatedMode: 'patreon',
        generatedOutputSha256: 'b'.repeat(64),
        expectedGeneratedSourceAssetId: source.id,
        expectedGeneratedSourceRelativePath: 'w.png',
        expectedGeneratedMode: 'patreon',
        expectedGeneratedOutputSha256: SHA,
        expectedExtension: output.extension,
        expectedSizeBytes: output.size_bytes,
        expectedModifiedAt: output.modified_at,
        expectedIsPresent: output.is_present,
        expectedSourceAnimated: output.source_animated,
        expectedSourceGeneration: output.source_generation,
        data: {
          relativePath: output.relative_path, filename: output.filename, extension: 'webp',
          mimeType: 'image/webp', categoryId: null, nestedPath: '',
          sizeBytes: 60, modifiedAt: '2026-01-02T00:00:00.000Z', sourceAnimated,
        },
      };
    }

    it('writes the new animation state in the same update that advances the generation', () => {
      const stored = storedGeneratedWebp(1);
      expect(stored.output).toMatchObject({ source_animated: 1, source_generation: 0 });
      const { replaced } = assetRepo.applyAssetWatermarks(projectId, {
        replacements: [replacement(stored, false)],
      });
      expect(replaced[0]).toMatchObject({
        size_bytes: 60,
        modified_at: '2026-01-02T00:00:00.000Z',
        source_animated: 0,
        source_generation: 1,
      });
      expect(assetRepo.findById(stored.output.id)).toMatchObject({ source_animated: 0, source_generation: 1 });
    });

    it('records an unclassified output as unknown instead of inheriting the old state', () => {
      const stored = storedGeneratedWebp(1);
      const { replaced } = assetRepo.applyAssetWatermarks(projectId, {
        replacements: [replacement(stored, undefined)],
      });
      expect(replaced[0]).toMatchObject({ source_animated: null, source_generation: 1 });
    });

    it('leaves generation and animation untouched when the expected ownership is stale', () => {
      const stored = storedGeneratedWebp(1);
      expect(() => assetRepo.applyAssetWatermarks(projectId, {
        replacements: [{ ...replacement(stored, false), expectedGeneratedOutputSha256: 'c'.repeat(64) }],
      })).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
      expect(assetRepo.findById(stored.output.id)).toMatchObject({
        size_bytes: 100, source_animated: 1, source_generation: 0,
      });
    });

    it('rejects a stale replacement after reconciliation advanced the source generation', () => {
      const stored = storedGeneratedWebp(1);
      // Captured at generation N before rendering.
      const captured = replacement(stored, false);
      // Request-time Preview reconciliation establishes a new source instance
      // (N -> N+1) without touching generated ownership.
      const newer = assetRepo.reconcileSource(stored.output,
        { size: 100, mtime: '2026-01-01T00:00:00.000Z' }, { replaced: true });
      expect(newer).toMatchObject({ source_generation: 1, generated_output_sha256: SHA });
      expect(() => assetRepo.applyAssetWatermarks(projectId, {
        replacements: [captured],
      })).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
      expect(assetRepo.findById(stored.output.id)).toMatchObject({
        size_bytes: 100, modified_at: '2026-01-01T00:00:00.000Z',
        source_animated: 1, source_generation: 1, generated_output_sha256: SHA,
      });
    });

    it('rejects a stale replacement after a scan-style tuple change', () => {
      const stored = storedGeneratedWebp(1);
      const captured = replacement(stored, false);
      const newer = assetRepo.reconcileSource(stored.output,
        { size: 101, mtime: '2026-01-03T00:00:00.000Z', animated: true });
      expect(newer).toMatchObject({ size_bytes: 101, source_generation: 1 });
      expect(() => assetRepo.applyAssetWatermarks(projectId, {
        replacements: [captured],
      })).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
      expect(assetRepo.findById(stored.output.id)).toMatchObject({
        size_bytes: 101, modified_at: '2026-01-03T00:00:00.000Z',
        source_animated: 1, source_generation: 1,
      });
    });

    it.each([
      ['size', { expectedSizeBytes: 99 }],
      ['mtime', { expectedModifiedAt: '2025-12-31T00:00:00.000Z' }],
      ['animation', { expectedSourceAnimated: 0 }],
      ['extension', { expectedExtension: 'png' }],
      ['presence', { expectedIsPresent: 0 }],
      ['generation', { expectedSourceGeneration: 1 }],
    ])('pins the captured source %s in the replacement condition', (_field, override) => {
      const stored = storedGeneratedWebp(1);
      expect(() => assetRepo.applyAssetWatermarks(projectId, {
        replacements: [{ ...replacement(stored, false), ...override }],
      })).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
      expect(assetRepo.findById(stored.output.id)).toMatchObject({
        size_bytes: 100, source_animated: 1, source_generation: 0,
      });
    });

    it('requires the captured source generation', () => {
      const stored = storedGeneratedWebp(1);
      const { expectedSourceGeneration: _omitted, ...withoutGeneration } = replacement(stored, false);
      expect(() => assetRepo.applyAssetWatermarks(projectId, {
        replacements: [withoutGeneration],
      })).toThrow(TypeError);
      expect(assetRepo.findById(stored.output.id)).toMatchObject({ source_generation: 0 });
    });

    it('matches unchanged unknown animation authority', () => {
      const stored = storedGeneratedWebp(null);
      expect(stored.output.source_animated).toBeNull();
      const { replaced } = assetRepo.applyAssetWatermarks(projectId, {
        replacements: [replacement(stored, false)],
      });
      expect(replaced[0]).toMatchObject({ size_bytes: 60, source_animated: 0, source_generation: 1 });
    });

    it('rejects a stale replacement after unknown animation authority was classified', () => {
      const stored = storedGeneratedWebp(null);
      const captured = replacement(stored, false);
      // Learning the classification keeps the generation; only the captured
      // NULL animation authority detects it.
      const learned = assetRepo.reconcileSource(stored.output,
        { size: 100, mtime: '2026-01-01T00:00:00.000Z', animated: true });
      expect(learned).toMatchObject({ source_animated: 1, source_generation: 0 });
      expect(() => assetRepo.applyAssetWatermarks(projectId, {
        replacements: [captured],
      })).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
      expect(assetRepo.findById(stored.output.id)).toMatchObject({
        size_bytes: 100, source_animated: 1, source_generation: 0,
      });
    });
  });

  describe('applyAssetWatermarks comic source updates', () => {
    const OLD_TIME = '2026-01-01T00:00:00.000Z';
    const NEW_TIME = '2026-01-02T00:00:00.000Z';

    function storedComic(extension = 'cbz', generatedBy = 'archives') {
      const relativePath = `comics/book.${extension}`;
      const category = createCategory(projectId, `Comics ${extension}`, `comics-${extension}`);
      const asset = assetRepo.upsert(projectId, relativePath, {
        filename: `book.${extension}`, extension, mimeType: 'application/octet-stream',
        categoryId: category.id, nestedPath: 'custom', sizeBytes: 100, modifiedAt: OLD_TIME,
      });
      const { artifactOutputs: [artifact] } = assetRepo.applyAssetWatermarks(projectId, {
        artifactOutputs: [{
          relativePath, kind: generatedBy === 'archives' ? 'archive-cbz' : 'watermark-cbz',
          generatedBy, generatedMode: generatedBy === 'archives' ? 'standalone' : 'patreon',
          sha256: 'a'.repeat(64), sizeBytes: 100, outputProvenance: 'v1:1:2:3',
        }],
      });
      const tag = tagRepo.create({ displayName: `Comic ${extension}`, normalizedName: `comic-${extension}` });
      db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(asset.id, tag.id);
      const release = insertRelease(db, { projectId, title: 'Comic release' });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id, role: 'preview', sortOrder: 7 });
      return { asset, artifact };
    }

    function changesFor({ asset, artifact }) {
      return {
        comicSourceUpdates: [{
          assetId: asset.id, relativePath: asset.relative_path,
          expectedExtension: asset.extension, expectedSizeBytes: asset.size_bytes,
          expectedModifiedAt: asset.modified_at, expectedIsPresent: asset.is_present,
          expectedSourceAnimated: asset.source_animated, expectedSourceGeneration: asset.source_generation,
          data: { sizeBytes: 200, modifiedAt: NEW_TIME },
        }],
        artifactReplacements: [{
          id: artifact.id, relativePath: artifact.relative_path, kind: artifact.kind,
          generatedBy: artifact.generated_by, generatedMode: artifact.generated_mode,
          expectedSha256: artifact.sha256, expectedGeneratedWatermarkId: artifact.generated_watermark_id,
          expectedOutputProvenance: artifact.output_provenance,
          sha256: 'b'.repeat(64), sizeBytes: 200, outputProvenance: 'v1:1:4:5',
        }],
      };
    }

    function snapshot() {
      return {
        assets: db.prepare('SELECT * FROM assets ORDER BY id').all(),
        artifacts: db.prepare('SELECT * FROM generated_artifacts ORDER BY id').all(),
        tags: db.prepare('SELECT * FROM asset_tags ORDER BY asset_id, tag_id').all(),
        releases: db.prepare('SELECT * FROM release_assets ORDER BY release_id, asset_id').all(),
      };
    }

    it.each(['cbz', 'cbr', 'cb7'])('atomically refreshes an existing %s and preserves all unrelated columns and links', (extension) => {
      const stored = storedComic(extension);
      const before = snapshot();
      const result = assetRepo.applyAssetWatermarks(projectId, changesFor(stored));
      const after = snapshot();
      const updated = result.comicSourceUpdated[0];
      expect(result.comicSourceUpdated).toHaveLength(1);
      expect(updated).toMatchObject({
        id: stored.asset.id, size_bytes: 200, modified_at: NEW_TIME,
        is_present: 1, missing_since: null, source_animated: null, source_generation: 1,
      });
      expect(updated.last_seen_at).toBeTruthy();
      expect(after.assets).toEqual([{
        ...before.assets[0], size_bytes: 200, modified_at: NEW_TIME, source_generation: 1,
        last_seen_at: updated.last_seen_at, updated_at: updated.updated_at,
      }]);
      expect(after.tags).toEqual(before.tags);
      expect(after.releases).toEqual(before.releases);
      expect(result.artifactReplaced[0]).toMatchObject({
        id: stored.artifact.id, project_id: projectId, sha256: 'b'.repeat(64), size_bytes: 200,
        output_provenance: 'v1:1:4:5', generated_by: 'archives',
      });
      expect(after.artifacts).toEqual(result.artifactReplaced);
    });

    it.each([
      ['unchanged size', 100, NEW_TIME],
      ['unchanged mtime', 200, OLD_TIME],
      ['unchanged size and mtime', 100, OLD_TIME],
    ])('advances generation and the indexed viewer revision with %s', (_label, sizeBytes, modifiedAt) => {
      const stored = storedComic();
      const changes = changesFor(stored);
      changes.comicSourceUpdates[0].data = { sizeBytes, modifiedAt };
      changes.artifactReplacements[0].sizeBytes = sizeBytes;
      const { comicSourceUpdated: [updated] } = assetRepo.applyAssetWatermarks(projectId, changes);
      expect(updated).toMatchObject({ size_bytes: sizeBytes, modified_at: modifiedAt, source_generation: 1 });
      expect(buildAssetRevisionToken(updated)).not.toBe(buildAssetRevisionToken(stored.asset));
      expect(() => assetRepo.applyAssetWatermarks(projectId, changes)).toThrow();
      expect(assetRepo.findById(updated.id).source_generation).toBe(1);
    });

    it('restores a missing indexed comic with cleared missing state and animation', () => {
      const stored = storedComic();
      db.prepare("UPDATE assets SET is_present = 0, missing_since = ?, last_seen_at = NULL, source_animated = 1 WHERE id = ?")
        .run(OLD_TIME, stored.asset.id);
      stored.asset = assetRepo.findById(stored.asset.id);
      const { comicSourceUpdated: [updated] } = assetRepo.applyAssetWatermarks(projectId, changesFor(stored));
      expect(updated).toMatchObject({ id: stored.asset.id, is_present: 1, missing_since: null, source_animated: null, source_generation: 1 });
      expect(updated.last_seen_at).toBeTruthy();
    });

    it('binds a new artifact publication to an already indexed destination without inserting an asset', () => {
      const stored = storedComic();
      db.prepare('DELETE FROM generated_artifacts WHERE id = ?').run(stored.artifact.id);
      const changes = changesFor(stored);
      changes.artifactOutputs = changes.artifactReplacements;
      changes.artifactReplacements = [];
      const result = assetRepo.applyAssetWatermarks(projectId, changes);
      expect(result.comicSourceUpdated[0].id).toBe(stored.asset.id);
      expect(assetRepo.findByProjectId(projectId)).toHaveLength(1);
      expect(result.artifactOutputs).toHaveLength(1);
    });

    it('rejects a foreign project even when its artifact destination matches', () => {
      const stored = storedComic();
      const other = createProject('Other comic project');
      const changes = changesFor(stored);
      changes.artifactReplacements = [];
      changes.artifactOutputs = [{
        relativePath: stored.asset.relative_path, kind: 'archive-cbz', generatedBy: 'archives',
        sha256: 'b'.repeat(64), sizeBytes: 200,
      }];
      const before = snapshot();
      expect(() => assetRepo.applyAssetWatermarks(other.id, changes)).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
      expect(snapshot()).toEqual(before);
    });

    it.each([
      ['wrong asset', { assetId: 999999 }],
      ['wrong destination', { relativePath: 'comics/other.cbz' }],
      ['stale generation', { expectedSourceGeneration: 1 }],
      ['stale size', { expectedSizeBytes: 101 }],
      ['stale mtime', { expectedModifiedAt: null }],
      ['stale presence', { expectedIsPresent: 0 }],
      ['stale animation', { expectedSourceAnimated: 1 }],
    ])('rejects %s without committing catalogue or artifact changes', (_label, override) => {
      const changes = changesFor(storedComic());
      Object.assign(changes.comicSourceUpdates[0], override);
      const before = snapshot();
      expect(() => assetRepo.applyAssetWatermarks(projectId, changes)).toThrow();
      expect(snapshot()).toEqual(before);
    });

    it('rejects a different existing asset at another path', () => {
      const changes = changesFor(storedComic());
      const other = assetRepo.upsert(projectId, 'other.cbz', {
        filename: 'other.cbz', extension: 'cbz', mimeType: 'application/octet-stream', sizeBytes: 100, modifiedAt: OLD_TIME,
      });
      changes.comicSourceUpdates[0].assetId = other.id;
      const before = snapshot();
      expect(() => assetRepo.applyAssetWatermarks(projectId, changes)).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
      expect(snapshot()).toEqual(before);
    });

    it('does not insert a missing asset', () => {
      const stored = storedComic();
      const changes = changesFor(stored);
      assetRepo.deleteMany(projectId, [{ assetId: stored.asset.id, relativePath: stored.asset.relative_path }]);
      const before = snapshot();
      expect(() => assetRepo.applyAssetWatermarks(projectId, changes)).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
      expect(snapshot()).toEqual(before);
      expect(assetRepo.findByProjectId(projectId)).toEqual([]);
    });

    it('rejects an older publication after same-tuple reconciliation advanced the real row', () => {
      const stored = storedComic();
      const changes = changesFor(stored);
      assetRepo.reconcileSource(stored.asset, { size: 100, mtime: OLD_TIME }, { replaced: true });
      const before = snapshot();
      expect(before.assets[0].source_generation).toBe(1);
      expect(() => assetRepo.applyAssetWatermarks(projectId, changes)).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
      expect(snapshot()).toEqual(before);
    });

    it('compares a captured null mtime without treating it as an omitted expectation', () => {
      const stored = storedComic();
      stored.asset = assetRepo.upsert(projectId, stored.asset.relative_path, {
        filename: stored.asset.filename, extension: 'cbz', mimeType: stored.asset.mime_type,
        categoryId: stored.asset.category_id, nestedPath: stored.asset.nested_path,
        sizeBytes: 100, modifiedAt: null,
      });
      const { comicSourceUpdated: [updated] } = assetRepo.applyAssetWatermarks(projectId, changesFor(stored));
      expect(updated.modified_at).toBe(NEW_TIME);
      expect(updated.source_generation).toBe(stored.asset.source_generation + 1);
    });

    it('requires the exact asset destination even when the artifact mutation matches the wrong path', () => {
      const changes = changesFor(storedComic());
      changes.comicSourceUpdates[0].relativePath = 'comics/other.cbz';
      changes.artifactReplacements[0].relativePath = 'comics/other.cbz';
      const before = snapshot();
      expect(() => assetRepo.applyAssetWatermarks(projectId, changes)).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
      expect(snapshot()).toEqual(before);
    });

    it.each([
      ['duplicate asset', (changes) => changes.comicSourceUpdates.push(structuredClone(changes.comicSourceUpdates[0]))],
      ['duplicate destination', (changes) => changes.comicSourceUpdates.push({ ...changes.comicSourceUpdates[0], assetId: 999 })],
      ['conflicting artifact mutations', (changes) => { changes.artifactOutputs = [changes.artifactReplacements[0]]; }],
      ['unbound publication', (changes) => { changes.artifactReplacements = []; }],
      ['different published size', (changes) => { changes.artifactReplacements[0].sizeBytes = 201; }],
      ['delete overlap', (changes) => { changes.deletes = [{ assetId: changes.comicSourceUpdates[0].assetId, relativePath: 'other.cbz' }]; }],
      ['output overlap', (changes) => { changes.outputs = [{ relativePath: changes.comicSourceUpdates[0].relativePath }]; }],
      ['replacement overlap', (changes) => { changes.replacements = [{ assetId: changes.comicSourceUpdates[0].assetId, data: {} }]; }],
    ])('rejects %s before mutation', (_label, mutate) => {
      const changes = changesFor(storedComic());
      mutate(changes);
      const before = snapshot();
      expect(() => assetRepo.applyAssetWatermarks(projectId, changes)).toThrow(expect.objectContaining({ code: 'DESTINATION_CONFLICT' }));
      expect(snapshot()).toEqual(before);
    });

    it.each(['../book.cbz', '/book.cbz', 'comics\\book.cbz', 'comics//book.cbz', 'comics/./book.cbz', 'C:/book.cbz', 'book.zip', 'book.7z', 'book.png', 'book.mp4'])('rejects a noncanonical or noncomic destination %s', (relativePath) => {
      const changes = changesFor(storedComic());
      changes.comicSourceUpdates[0].relativePath = relativePath;
      changes.comicSourceUpdates[0].expectedExtension = relativePath.split('.').at(-1);
      const before = snapshot();
      expect(() => assetRepo.applyAssetWatermarks(projectId, changes)).toThrow(TypeError);
      expect(snapshot()).toEqual(before);
    });

    it.each(['expectedSourceGeneration', 'expectedSizeBytes', 'expectedModifiedAt', 'expectedIsPresent', 'expectedSourceAnimated', 'expectedExtension'])('requires explicit %s', (field) => {
      const changes = changesFor(storedComic());
      delete changes.comicSourceUpdates[0][field];
      const before = snapshot();
      expect(() => assetRepo.applyAssetWatermarks(projectId, changes)).toThrow(TypeError);
      expect(snapshot()).toEqual(before);
    });

    it.each([
      ['hash', { expectedSha256: 'c'.repeat(64) }],
      ['artifact identity', { id: 999999 }],
      ['kind', { kind: 'foreign-operation' }],
      ['watermark identity', { expectedGeneratedWatermarkId: 999 }],
      ['file provenance', { expectedOutputProvenance: 'v1:9:8:7' }],
    ])('rolls back the asset update when existing artifact %s checks fail', (_label, override) => {
      const changes = changesFor(storedComic());
      Object.assign(changes.artifactReplacements[0], override);
      const before = snapshot();
      expect(() => assetRepo.applyAssetWatermarks(projectId, changes)).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
      expect(snapshot()).toEqual(before);
    });

    it('rolls back assets and an already updated artifact when later artifact persistence fails', () => {
      const changes = changesFor(storedComic());
      changes.artifactOutputs = [{
        relativePath: 'other.cbz', kind: 'archive-cbz', generatedBy: 'archives',
        sha256: 'c'.repeat(64), sizeBytes: -1,
      }];
      const before = snapshot();
      expect(() => assetRepo.applyAssetWatermarks(projectId, changes)).toThrow(/CHECK constraint/);
      expect(snapshot()).toEqual(before);
    });

    it('rolls back an earlier comic update and ordinary asset mutation when a later comic is stale', () => {
      const first = changesFor(storedComic());
      const second = changesFor(storedComic('cb7'));
      second.comicSourceUpdates[0].expectedSourceGeneration = 1;
      const ordinary = assetRepo.upsert(projectId, 'ordinary.png', {
        filename: 'ordinary.png', extension: 'png', mimeType: 'image/png', sizeBytes: 10, modifiedAt: null,
      });
      const before = snapshot();
      expect(() => assetRepo.applyAssetWatermarks(projectId, {
        comicSourceUpdates: [...first.comicSourceUpdates, ...second.comicSourceUpdates],
        artifactReplacements: [...first.artifactReplacements, ...second.artifactReplacements],
        deletes: [{ assetId: ordinary.id, relativePath: ordinary.relative_path }],
      })).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
      expect(snapshot()).toEqual(before);
    });

    it('commits multiple indexed destinations together', () => {
      const first = changesFor(storedComic());
      const second = changesFor(storedComic('cb7'));
      const result = assetRepo.applyAssetWatermarks(projectId, {
        comicSourceUpdates: [...first.comicSourceUpdates, ...second.comicSourceUpdates],
        artifactReplacements: [...first.artifactReplacements, ...second.artifactReplacements],
      });
      expect(result.comicSourceUpdated.map((asset) => asset.source_generation)).toEqual([1, 1]);
      expect(result.artifactReplaced.map((artifact) => artifact.sha256)).toEqual(['b'.repeat(64), 'b'.repeat(64)]);
    });

    it('participates in the caller transaction so a later failure rolls back assets and artifacts', () => {
      const changes = changesFor(storedComic());
      const before = snapshot();
      expect(() => db.transaction(() => {
        assetRepo.applyAssetWatermarks(projectId, changes);
        throw new Error('recovery evidence failed');
      })()).toThrow('recovery evidence failed');
      expect(snapshot()).toEqual(before);
    });

    it.each(['archives', 'watermark'])('preserves %s publication without optional comic updates or indexed destinations', (generatedBy) => {
      const changes = changesFor(storedComic('cbz', generatedBy));
      delete changes.comicSourceUpdates;
      const before = snapshot();
      const result = assetRepo.applyAssetWatermarks(projectId, changes);
      expect(snapshot().assets).toEqual(before.assets);
      expect(result.comicSourceUpdated).toEqual([]);
      expect(result.artifactReplaced).toHaveLength(1);
      const outputs = assetRepo.applyAssetWatermarks(projectId, { artifactOutputs: [{
        relativePath: 'unindexed.cbz', kind: 'archive-cbz', generatedBy,
        sha256: 'c'.repeat(64), sizeBytes: 10,
      }] });
      expect(outputs.artifactOutputs).toHaveLength(1);
      expect(assetRepo.findByProjectIdAndPath(projectId, 'unindexed.cbz')).toBeUndefined();
      expect(assetRepo.applyAssetWatermarks(projectId, { comicSourceUpdates: [] }).comicSourceUpdated).toEqual([]);
    });
  });

  describe('reconcileScannedAssets', () => {
    function discoveredFile(overrides = {}) {
      return {
        relativePath: 'a.png',
        filename: 'a.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 100,
        modifiedAt: '2026-01-01T00:00:00.000Z',
        categoryId: null,
        nestedPath: '',
        ...overrides,
      };
    }

    describe('generated comic discovery', () => {
      function registerArtifact(relativePath, generatedBy = 'archives', owner = projectId) {
        return assetRepo.applyAssetWatermarks(owner, { artifactOutputs: [{
          relativePath, kind: 'archive-cbz', generatedBy, generatedMode: 'standalone',
          sha256: 'a'.repeat(64), sizeBytes: 100, outputProvenance: 'v1:1:2:3',
        }] }).artifactOutputs[0];
      }

      function comicFile(extension = 'cbz', overrides = {}) {
        return discoveredFile({ relativePath: `comics/book.${extension}`, filename: `book.${extension}`,
          extension, mimeType: 'application/octet-stream', nestedPath: 'comics', ...overrides });
      }

      const artifacts = () => db.prepare('SELECT * FROM generated_artifacts ORDER BY id').all();

      it.each(['cbz', 'cbr', 'cb7', 'CbZ', 'CBR', 'cB7'])(
        'indexes a new generated %s without changing artifact identity or provenance', (extension) => {
          const file = comicFile(extension);
          registerArtifact(file.relativePath);
          const before = artifacts();
          expect(assetRepo.findByProjectIdAndPath(projectId, file.relativePath)).toBeUndefined();
          expect(assetRepo.reconcileScannedAssets(projectId, [file]))
            .toEqual({ added: 1, updated: 0, removed: 0, total: 1 });
          const row = assetRepo.findByProjectIdAndPath(projectId, file.relativePath);
          expect(row).toMatchObject({ extension, mime_type: file.mimeType, is_present: 1, source_generation: 0,
            generated_by: null });
          expect(db.prepare('SELECT generated_output_provenance FROM assets WHERE id = ?').get(row.id))
            .toEqual({ generated_output_provenance: null });
          expect(assetRepo.reconcileScannedAssets(projectId, [file]))
            .toEqual({ added: 0, updated: 0, removed: 0, total: 1 });
          expect(assetRepo.findById(row.id)).toEqual(row);
          expect(artifacts()).toEqual(before);
        },
      );

      it('also preserves Watermark producer provenance', () => {
        const file = comicFile();
        registerArtifact(file.relativePath, 'watermark');
        const before = artifacts();
        assetRepo.reconcileScannedAssets(projectId, [file]);
        expect(assetRepo.findByProjectIdAndPath(projectId, file.relativePath)).toBeTruthy();
        expect(artifacts()).toEqual(before);
      });

      it.each(['png', 'webp', 'jpg', 'jpeg', 'mp4', 'webm', 'zip', '7z', 'rar', 'tar', 'cbt'])(
        'keeps new generated %s output excluded', (extension) => {
          const file = comicFile(extension);
          registerArtifact(file.relativePath);
          const before = artifacts();
          expect(assetRepo.reconcileScannedAssets(projectId, [file]))
            .toEqual({ added: 0, updated: 0, removed: 0, total: 0 });
          expect(assetRepo.findByProjectId(projectId)).toEqual([]);
          expect(artifacts()).toEqual(before);
        },
      );

      it('keeps existing noncomic asset reconciliation at an artifact-owned path', () => {
        const file = comicFile('png');
        const row = assetRepo.upsert(projectId, file.relativePath, { ...file, sizeBytes: 1 });
        registerArtifact(file.relativePath);
        const before = artifacts();
        expect(assetRepo.reconcileScannedAssets(projectId, [file]))
          .toEqual({ added: 0, updated: 1, removed: 0, total: 1 });
        expect(assetRepo.findById(row.id)).toMatchObject({ size_bytes: 100, is_present: 1, source_generation: 1 });
        expect(artifacts()).toEqual(before);
      });

      it('preserves category, tags and releases through repeat, missing and restored scans', () => {
        const category = createCategory(projectId, 'Comics', 'comics');
        const file = comicFile('cbz', { categoryId: category.id, nestedPath: '' });
        registerArtifact(file.relativePath);
        assetRepo.reconcileScannedAssets(projectId, [file]);
        const row = assetRepo.findByProjectIdAndPath(projectId, file.relativePath);
        const tag = tagRepo.create({ displayName: 'Comic', normalizedName: 'comic' });
        db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(row.id, tag.id);
        const release = insertRelease(db, { projectId, title: 'Comic release' });
        linkAssetToRelease(db, { releaseId: release.id, assetId: row.id, role: 'preview', sortOrder: 7 });
        const links = () => ({ tags: db.prepare('SELECT * FROM asset_tags').all(),
          releases: db.prepare('SELECT * FROM release_assets').all() });
        const beforeLinks = links();
        const beforeArtifacts = artifacts();
        assetRepo.reconcileScannedAssets(projectId, [file]);
        expect(assetRepo.findById(row.id)).toEqual(row);
        expect(assetRepo.reconcileScannedAssets(projectId, []).removed).toBe(1);
        expect(assetRepo.findById(row.id)).toMatchObject({ is_present: 0, source_generation: 0 });
        expect(assetRepo.reconcileScannedAssets(projectId, [file]).updated).toBe(1);
        expect(assetRepo.findById(row.id)).toMatchObject({ id: row.id, category_id: category.id,
          is_present: 1, missing_since: null, source_generation: 1 });
        assetRepo.reconcileScannedAssets(projectId, [file]);
        expect(assetRepo.findById(row.id).source_generation).toBe(1);
        expect(links()).toEqual(beforeLinks);
        expect(artifacts()).toEqual(beforeArtifacts);
      });

      it('does not fabricate artifact provenance for an imported comic', () => {
        assetRepo.reconcileScannedAssets(projectId, [comicFile()]);
        expect(assetRepo.findByProjectId(projectId)).toHaveLength(1);
        expect(artifacts()).toEqual([]);
      });

      it('keeps artifact path matching platform-specific and scoped to its project', () => {
        registerArtifact('Comics/Book.PNG');
        const file = comicFile('png', { relativePath: 'comics/book.png' });
        expect(assetRepo.reconcileScannedAssets(projectId, [file]).added)
          .toBe(process.platform === 'win32' ? 0 : 1);
        const other = createProject('Foreign artifact owner');
        registerArtifact('foreign.png', 'archives', other.id);
        expect(assetRepo.reconcileScannedAssets(projectId,
          [discoveredFile({ relativePath: 'foreign.png', filename: 'foreign.png' })]).added).toBe(1);
        expect(artifacts()).toHaveLength(2);
      });

      it('rolls back a comic insertion and earlier updates when a foreign category fails', () => {
        const file = comicFile();
        registerArtifact(file.relativePath);
        assetRepo.reconcileScannedAssets(projectId, [discoveredFile()]);
        const before = assetRepo.findByProjectId(projectId);
        const beforeArtifacts = artifacts();
        const other = createProject('Foreign comic category');
        const category = createCategory(other.id, 'Comics', 'comics');
        expect(() => assetRepo.reconcileScannedAssets(projectId, [
          discoveredFile({ sizeBytes: 200 }), file,
          comicFile('cb7', { categoryId: category.id }),
        ])).toThrow();
        expect(assetRepo.findByProjectId(projectId)).toEqual(before);
        expect(artifacts()).toEqual(beforeArtifacts);
      });

      it('rolls back inserted comics and missing transitions when missing handling fails', () => {
        const file = comicFile();
        registerArtifact(file.relativePath);
        assetRepo.reconcileScannedAssets(projectId, [discoveredFile()]);
        const before = assetRepo.findByProjectId(projectId);
        const beforeArtifacts = artifacts();
        db.exec(`CREATE TEMP TRIGGER fail_comic_missing AFTER UPDATE OF is_present ON assets
          WHEN NEW.is_present = 0 BEGIN SELECT RAISE(ABORT, 'missing failure'); END`);
        expect(() => assetRepo.reconcileScannedAssets(projectId, [file])).toThrow('missing failure');
        expect(assetRepo.findByProjectId(projectId)).toEqual(before);
        expect(artifacts()).toEqual(beforeArtifacts);
      });

      it('supports atomic publication after discovery without a second generation advance on scan', () => {
        const file = comicFile();
        const artifact = registerArtifact(file.relativePath);
        assetRepo.reconcileScannedAssets(projectId, [file]);
        const row = assetRepo.findByProjectIdAndPath(projectId, file.relativePath);
        const data = { sizeBytes: 200, modifiedAt: '2026-01-02T00:00:00.000Z' };
        const changes = {
          comicSourceUpdates: [{ assetId: row.id, relativePath: file.relativePath,
            expectedExtension: row.extension, expectedSizeBytes: row.size_bytes,
            expectedModifiedAt: row.modified_at, expectedIsPresent: row.is_present,
            expectedSourceAnimated: row.source_animated, expectedSourceGeneration: row.source_generation, data }],
          artifactReplacements: [{ id: artifact.id, relativePath: file.relativePath, kind: artifact.kind,
            generatedBy: artifact.generated_by, generatedMode: artifact.generated_mode,
            expectedSha256: artifact.sha256, expectedGeneratedWatermarkId: artifact.generated_watermark_id,
            expectedOutputProvenance: artifact.output_provenance,
            sha256: 'b'.repeat(64), sizeBytes: 200, outputProvenance: 'v1:1:4:5' }],
        };
        expect(assetRepo.applyAssetWatermarks(projectId, changes).comicSourceUpdated[0])
          .toMatchObject({ id: row.id, source_generation: 1 });
        expect(assetRepo.reconcileScannedAssets(projectId, [{ ...file, ...data }]))
          .toEqual({ added: 0, updated: 0, removed: 0, total: 1 });
        expect(assetRepo.findById(row.id)).toMatchObject({ size_bytes: 200, source_generation: 1 });
        expect(artifacts()[0]).toMatchObject({ id: artifact.id, sha256: 'b'.repeat(64) });
        const before = { rows: assetRepo.findByProjectId(projectId), artifacts: artifacts() };
        expect(() => assetRepo.applyAssetWatermarks(projectId, changes)).toThrow();
        expect({ rows: assetRepo.findByProjectId(projectId), artifacts: artifacts() }).toEqual(before);
      });
    });

    it('inserts newly discovered files', () => {
      const result = assetRepo.reconcileScannedAssets(projectId, [discoveredFile()]);
      expect(result).toEqual({ added: 1, updated: 0, removed: 0, total: 1 });
      expect(assetRepo.findByProjectIdAndPath(projectId, 'a.png')).toBeTruthy();
    });

    it('does not count a fully unchanged row as updated', () => {
      assetRepo.reconcileScannedAssets(projectId, [discoveredFile()]);
      const result = assetRepo.reconcileScannedAssets(projectId, [discoveredFile()]);
      expect(result).toEqual({ added: 0, updated: 0, removed: 0, total: 1 });
    });

    it('counts a category_id change as updated even when size and mtime match', () => {
      const category = createCategory(projectId, 'Source', 'source');
      assetRepo.reconcileScannedAssets(projectId, [discoveredFile()]);

      const result = assetRepo.reconcileScannedAssets(projectId, [
        discoveredFile({ categoryId: category.id }),
      ]);

      expect(result).toEqual({ added: 0, updated: 1, removed: 0, total: 1 });
      expect(assetRepo.findByProjectIdAndPath(projectId, 'a.png').category_id).toBe(category.id);
    });

    it('repairs a stale nested_path even when size and mtime are unchanged', () => {
      assetRepo.reconcileScannedAssets(projectId, [discoveredFile({ nestedPath: 'stale' })]);

      const result = assetRepo.reconcileScannedAssets(projectId, [discoveredFile({ nestedPath: 'fixed' })]);

      expect(result.updated).toBe(1);
      expect(assetRepo.findByProjectIdAndPath(projectId, 'a.png').nested_path).toBe('fixed');
    });

    it('restores a missing file that reappears and counts it as updated', () => {
      assetRepo.reconcileScannedAssets(projectId, [
        discoveredFile(),
        discoveredFile({ relativePath: 'b.png', filename: 'b.png' }),
      ]);

      const afterRemoval = assetRepo.reconcileScannedAssets(projectId, [discoveredFile()]);
      expect(afterRemoval.removed).toBe(1);
      expect(assetRepo.findByProjectIdAndPath(projectId, 'b.png').is_present).toBe(0);

      const afterRestore = assetRepo.reconcileScannedAssets(projectId, [
        discoveredFile(),
        discoveredFile({ relativePath: 'b.png', filename: 'b.png' }),
      ]);
      expect(afterRestore).toEqual({ added: 0, updated: 1, removed: 0, total: 2 });
      expect(assetRepo.findByProjectIdAndPath(projectId, 'b.png').is_present).toBe(1);
    });

    it('marks all assets missing on an empty discovered snapshot', () => {
      assetRepo.reconcileScannedAssets(projectId, [discoveredFile()]);
      const result = assetRepo.reconcileScannedAssets(projectId, []);
      expect(result).toEqual({ added: 0, updated: 0, removed: 1, total: 1 });
    });

    describe('source generation', () => {
      const generation = () => assetRepo.findByProjectIdAndPath(projectId, 'a.png').source_generation;

      it('starts new rows at generation 0 and keeps it across unchanged and path-only scans', () => {
        const category = createCategory(projectId, 'Source', 'source');
        assetRepo.reconcileScannedAssets(projectId, [discoveredFile()]);
        expect(generation()).toBe(0);
        assetRepo.reconcileScannedAssets(projectId, [discoveredFile()]);
        assetRepo.reconcileScannedAssets(projectId, [discoveredFile({ categoryId: category.id, nestedPath: 'x' })]);
        expect(generation()).toBe(0);
      });

      it('increments once per changed observed source tuple', () => {
        assetRepo.reconcileScannedAssets(projectId, [discoveredFile()]);
        assetRepo.reconcileScannedAssets(projectId, [discoveredFile({ sizeBytes: 101 })]);
        expect(generation()).toBe(1);
        assetRepo.reconcileScannedAssets(projectId, [discoveredFile({ sizeBytes: 101 })]);
        expect(generation()).toBe(1);
        assetRepo.reconcileScannedAssets(projectId, [
          discoveredFile({ sizeBytes: 101, modifiedAt: '2026-01-02T00:00:00.000Z' }),
        ]);
        expect(generation()).toBe(2);
      });

      it('keeps the generation when animation is first classified but advances on a known flip', () => {
        assetRepo.reconcileScannedAssets(projectId, [discoveredFile({ sourceAnimated: null })]);
        assetRepo.reconcileScannedAssets(projectId, [discoveredFile({ sourceAnimated: false })]);
        expect(generation()).toBe(0);
        assetRepo.reconcileScannedAssets(projectId, [discoveredFile({ sourceAnimated: true })]);
        expect(generation()).toBe(1);
      });

      it('does not advance on removal but gives a restored row a new generation', () => {
        assetRepo.reconcileScannedAssets(projectId, [discoveredFile()]);
        assetRepo.reconcileScannedAssets(projectId, []);
        expect(generation()).toBe(0);
        // The same path/size/mtime reappearing is still a newly observed
        // instance: its old immutable revision must not become current again.
        assetRepo.reconcileScannedAssets(projectId, [discoveredFile()]);
        expect(generation()).toBe(1);
        assetRepo.reconcileScannedAssets(projectId, [discoveredFile()]);
        expect(generation()).toBe(1);
      });
    });

    it('rolls back the entire reconciliation, including missing-state changes, on failure', () => {
      const other = createProject('Reconcile Rollback Other');
      const otherCategory = createCategory(other.id, 'Source', 'source');

      assetRepo.reconcileScannedAssets(projectId, [discoveredFile({ relativePath: 'keep.png', filename: 'keep.png' })]);
      expect(assetRepo.findByProjectIdAndPath(projectId, 'keep.png').is_present).toBe(1);

      expect(() => {
        // categoryId belongs to a different project — violates the composite
        // foreign key (project_id, category_id) and must roll back the
        // whole batch, including the implicit "keep.png missing" transition
        // this same call would otherwise have made.
        assetRepo.reconcileScannedAssets(projectId, [
          discoveredFile({ relativePath: 'bad.png', filename: 'bad.png', categoryId: otherCategory.id }),
        ]);
      }).toThrow();

      expect(assetRepo.findByProjectIdAndPath(projectId, 'bad.png')).toBeUndefined();
      const keep = assetRepo.findByProjectIdAndPath(projectId, 'keep.png');
      expect(keep.is_present).toBe(1);
      expect(keep.missing_since).toBeNull();
    });
  });

  // ─── Phase 2 chunk 2: project-category mutation support ────────────────

  describe('countByCategoryId', () => {
    it('counts present and missing rows referencing a category', () => {
      const category = createCategory(projectId, 'Source', 'source');
      const present = assetRepo.upsert(projectId, 'source/a.png', {
        filename: 'a.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 1, modifiedAt: null, categoryId: category.id,
      });
      assetRepo.upsert(projectId, 'source/b.png', {
        filename: 'b.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 1, modifiedAt: null, categoryId: category.id,
      });
      assetRepo.markAllMissing(projectId);

      expect(assetRepo.countByCategoryId(projectId, category.id)).toBe(2);
      expect(assetRepo.findById(present.id).is_present).toBe(0);
    });

    it('returns 0 for a category with no referencing assets', () => {
      const category = createCategory(projectId, 'Empty', 'empty');
      expect(assetRepo.countByCategoryId(projectId, category.id)).toBe(0);
    });

    it('does not count assets from a different category', () => {
      const source = createCategory(projectId, 'Source', 'source');
      const exports_ = createCategory(projectId, 'Exports', 'exports');
      assetRepo.upsert(projectId, 'exports/a.png', {
        filename: 'a.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 1, modifiedAt: null, categoryId: exports_.id,
      });
      expect(assetRepo.countByCategoryId(projectId, source.id)).toBe(0);
    });
  });

  // ─── Phase: asset actions chunk 1 — updateAssetLocation ─────────────────

  describe('updateAssetLocation', () => {
    function baseAsset(overrides = {}) {
      return assetRepo.upsert(projectId, 'source/original.png', {
        filename: 'original.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 100, modifiedAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
      });
    }

    it('updates location and metadata for a successful same-ID rename', () => {
      const asset = baseAsset();

      const result = assetRepo.updateAssetLocation(projectId, asset.id, 'source/original.png', {
        relativePath: 'source/renamed.png',
        filename: 'renamed.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 200,
        modifiedAt: '2026-02-02T00:00:00.000Z',
      });

      expect(result.ok).toBe(true);
      expect(result.asset.relative_path).toBe('source/renamed.png');
      expect(result.asset.filename).toBe('renamed.png');
      expect(result.asset.size_bytes).toBe(200);
      expect(result.asset.modified_at).toBe('2026-02-02T00:00:00.000Z');
    });

    it('updates category_id and nested_path on move', () => {
      const asset = baseAsset();
      const category = createCategory(projectId, 'Exports', 'exports');

      const result = assetRepo.updateAssetLocation(projectId, asset.id, 'source/original.png', {
        relativePath: 'exports/sub/original.png',
        filename: 'original.png',
        extension: 'png',
        mimeType: 'image/png',
        categoryId: category.id,
        nestedPath: 'sub',
        sizeBytes: 100,
        modifiedAt: null,
      });

      expect(result.ok).toBe(true);
      expect(result.asset.category_id).toBe(category.id);
      expect(result.asset.nested_path).toBe('sub');
    });

    it('moves to Uncategorized using category_id = null', () => {
      const category = createCategory(projectId, 'Exports', 'exports');
      const asset = baseAsset({ categoryId: category.id, nestedPath: '' });

      const result = assetRepo.updateAssetLocation(projectId, asset.id, 'source/original.png', {
        relativePath: 'uncategorized.png',
        filename: 'uncategorized.png',
        extension: 'png',
        mimeType: 'image/png',
        categoryId: null,
        nestedPath: '',
        sizeBytes: 100,
        modifiedAt: null,
      });

      expect(result.ok).toBe(true);
      expect(result.asset.category_id).toBeNull();
    });

    it('preserves the asset ID across the update', () => {
      const asset = baseAsset();

      const result = assetRepo.updateAssetLocation(projectId, asset.id, 'source/original.png', {
        relativePath: 'source/renamed.png',
        filename: 'renamed.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 100,
        modifiedAt: null,
      });

      expect(result.asset.id).toBe(asset.id);
    });

    it('does not change created_at', () => {
      const asset = baseAsset();

      const result = assetRepo.updateAssetLocation(projectId, asset.id, 'source/original.png', {
        relativePath: 'source/renamed.png',
        filename: 'renamed.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 100,
        modifiedAt: null,
      });

      expect(result.asset.created_at).toBe(asset.created_at);
    });

    it('normalizes presence/missing fields on update', () => {
      const asset = baseAsset();
      assetRepo.markAllMissing(projectId);
      expect(assetRepo.findById(asset.id).is_present).toBe(0);

      const result = assetRepo.updateAssetLocation(projectId, asset.id, 'source/original.png', {
        relativePath: 'source/renamed.png',
        filename: 'renamed.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 100,
        modifiedAt: null,
      });

      expect(result.ok).toBe(true);
      expect(result.asset.is_present).toBe(1);
      expect(result.asset.missing_since).toBeNull();
      expect(result.asset.last_seen_at).toBeTruthy();
    });

    it('performs no update when the expected old path does not match', () => {
      const asset = baseAsset();

      const result = assetRepo.updateAssetLocation(projectId, asset.id, 'source/wrong-path.png', {
        relativePath: 'source/renamed.png',
        filename: 'renamed.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 100,
        modifiedAt: null,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('NOT_FOUND');
      expect(assetRepo.findById(asset.id).relative_path).toBe('source/original.png');
    });

    it('cannot update an asset belonging to a different project', () => {
      const asset = baseAsset();
      const other = createProject('Other Project');

      const result = assetRepo.updateAssetLocation(other.id, asset.id, 'source/original.png', {
        relativePath: 'source/renamed.png',
        filename: 'renamed.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 100,
        modifiedAt: null,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('NOT_FOUND');
      expect(assetRepo.findById(asset.id).project_id).toBe(projectId);
      expect(assetRepo.findById(asset.id).relative_path).toBe('source/original.png');
    });

    it('conflicts when the destination path is owned by another present asset', () => {
      const asset = baseAsset();
      assetRepo.upsert(projectId, 'source/taken.png', {
        filename: 'taken.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 1, modifiedAt: null,
      });

      const result = assetRepo.updateAssetLocation(projectId, asset.id, 'source/original.png', {
        relativePath: 'source/taken.png',
        filename: 'taken.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 100,
        modifiedAt: null,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('DESTINATION_CONFLICT');
      // Neither row was mutated.
      expect(assetRepo.findById(asset.id).relative_path).toBe('source/original.png');
    });

    it('conflicts when the destination path is owned by a missing asset', () => {
      const asset = baseAsset();
      assetRepo.upsert(projectId, 'source/taken.png', {
        filename: 'taken.png', extension: 'png', mimeType: 'image/png',
        sizeBytes: 1, modifiedAt: null,
      });
      // Mark everything but the target asset missing.
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, ['source/original.png']);
      expect(assetRepo.findByProjectIdAndPath(projectId, 'source/taken.png').is_present).toBe(0);

      const result = assetRepo.updateAssetLocation(projectId, asset.id, 'source/original.png', {
        relativePath: 'source/taken.png',
        filename: 'taken.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 100,
        modifiedAt: null,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('DESTINATION_CONFLICT');
    });

    it('leaves release_assets associations, roles, and sort_order unchanged', () => {
      const asset = baseAsset();
      const release = insertRelease(db, { projectId, title: 'R1' });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id, role: 'primary', sortOrder: 3 });

      const result = assetRepo.updateAssetLocation(projectId, asset.id, 'source/original.png', {
        relativePath: 'source/renamed.png',
        filename: 'renamed.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 100,
        modifiedAt: null,
      });

      expect(result.ok).toBe(true);

      const link = db.prepare(
        'SELECT release_id, asset_id, role, sort_order FROM release_assets WHERE release_id = ? AND asset_id = ?'
      ).get(release.id, asset.id);

      expect(link).toMatchObject({
        release_id: release.id,
        asset_id: asset.id,
        role: 'primary',
        sort_order: 3,
      });
    });
  });

});

// ─── Release Manage Assets bounded SQL pagination (Package A) ─────────────

describe('asset repository — Manage Assets bounded pagination', () => {
  let tmpDir;
  let dbPath;
  let db;
  let assetRepo;
  let projectRepo;
  let releaseRepo;
  let pathCounter;
  const extraConnections = [];

  function createProject(title) {
    return projectRepo.create({
      title,
      slug: slugify(title, { lowercase: true }),
      description: '',
      notes: '',
      status: 'tbd',
      projectType: 'images',
      priority: 'normal',
      plannedDate: null,
      publishedDate: null,
      patreonUrl: null,
    });
  }

  function createRelease(projectId, title = 'Release') {
    return releaseRepo.create({
      projectId, title, description: '', notes: '', plannedDate: null, patreonUrl: null,
    });
  }

  function createCategory(projectId, slug) {
    return db.prepare(`
      INSERT INTO project_asset_categories (project_id, display_name, directory_slug, display_order, enabled)
      VALUES (?, ?, ?, 0, 1)
      RETURNING id
    `).get(projectId, slug, slug).id;
  }

  /** Insert one asset row; returns a plain fixture record held in JS. */
  function insertAsset(projectId, {
    filename, extension = 'png', categoryId = null, isPresent = 1,
  }) {
    pathCounter += 1;
    const id = db.prepare(`
      INSERT INTO assets (project_id, category_id, relative_path, filename, extension, is_present)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `).get(projectId, categoryId, `fixture-${pathCounter}/${filename}`, filename, extension, isPresent).id;
    return { id, projectId, filename, extension, categoryId, isPresent };
  }

  /** Bulk-insert `count` present ASCII-named assets in one transaction. */
  function seedBulk(projectId, count, { prefix = 'bulk', every = null } = {}) {
    const stmt = db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, extension, is_present)
      VALUES (?, ?, ?, 'png', ?)
      RETURNING id
    `);
    const records = [];
    db.transaction(() => {
      for (let i = 0; i < count; i += 1) {
        const filename = `${prefix}-${String(count - i).padStart(6, '0')}.png`;
        const isPresent = every && i % every === 0 ? 0 : 1;
        const { id } = stmt.get(projectId, `${prefix}/${i}/${filename}`, filename, isPresent);
        records.push({ id, projectId, filename, extension: 'png', categoryId: null, isPresent });
      }
    })();
    return records;
  }

  function addMember(releaseId, assetId, sortOrder = 0, role = 'attachment') {
    db.prepare(`
      INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)
    `).run(releaseId, assetId, role, sortOrder);
  }

  // Independent reference model of the existing service filter (written from
  // the contract, not from the repository SQL).
  function asciiFold(value) {
    return value.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  }
  function nocaseThenId(a, b) {
    const fa = asciiFold(a.filename);
    const fb = asciiFold(b.filename);
    if (fa < fb) return -1;
    if (fa > fb) return 1;
    return a.id - b.id;
  }
  function expectedIds(records, savedIds, {
    search = null, extension = null, categoryId = null, selection = 'selected',
  } = {}) {
    return records
      .filter((asset) => {
        const saved = savedIds.has(asset.id);
        if (selection !== 'all' && !saved) return false;
        if (saved && asset.isPresent !== 1) return true;
        if (asset.isPresent !== 1) return false;
        if (categoryId !== null && asset.categoryId !== categoryId) return false;
        if (extension && String(asset.extension).toLowerCase() !== extension) return false;
        if (search && !asset.filename.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
      })
      .sort(nocaseThenId)
      .map((asset) => asset.id);
  }

  /**
   * Open a second, instrumented connection to the same database file. Every
   * statement it prepares is wrapped so the test records the executed SQL,
   * its bound arguments and the number of rows actually returned to
   * JavaScript. The connection is opened with plain `new Database` (not
   * openDatabase) and `verbose`, so this also proves the repository factory
   * registers the JavaScript-lowercase function on any connection.
   */
  function openInstrumented({ afterStatement = null } = {}) {
    const executed = [];
    const verboseLog = [];
    const conn = new Database(dbPath, { verbose: (sql) => verboseLog.push(String(sql)) });
    extraConnections.push(conn);
    const prepare = conn.prepare.bind(conn);
    conn.prepare = (sql) => {
      const stmt = prepare(sql);
      return new Proxy(stmt, {
        get(target, prop) {
          const value = target[prop];
          if (prop === 'all' || prop === 'get') {
            return (...args) => {
              const result = value.apply(target, args);
              const rowCount = prop === 'all' ? result.length : (result === undefined ? 0 : 1);
              executed.push({ sql, args, method: prop, rowCount });
              if (afterStatement) afterStatement({ sql, args, method: prop });
              return result;
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    const repo = createAssetRepository(conn);
    // Only statements issued by the call under test are of interest.
    executed.length = 0;
    verboseLog.length = 0;
    return { conn, repo, executed, verboseLog };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-manage-assets-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    assetRepo = createAssetRepository(db);
    projectRepo = createProjectRepository(db);
    releaseRepo = createReleaseRepository(db);
    pathCounter = 0;
  });

  afterEach(() => {
    while (extraConnections.length > 0) extraConnections.pop().close();
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function pageIds(result) {
    return result.rows.map((row) => row.id);
  }

  function readAllPages(scope, pageSize) {
    const first = assetRepo.getManageAssetsPage({ ...scope, page: 1, pageSize });
    const ids = [...pageIds(first)];
    for (let page = 2; page <= first.pageCount; page += 1) {
      ids.push(...pageIds(assetRepo.getManageAssetsPage({ ...scope, page, pageSize })));
    }
    return { first, ids };
  }

  describe('A–C scale fixtures (25 / 250 / 2,000 assets)', () => {
    for (const size of [25, 250, 2000]) {
      it(`pages ${size} assets with accurate totals and exact IDs`, () => {
        const project = createProject(`Scale ${size}`);
        const release = createRelease(project.id);
        const records = seedBulk(project.id, size, { every: 9 });
        const saved = new Set();
        records.forEach((asset, index) => {
          if (index % 5 === 0) {
            addMember(release.id, asset.id, index);
            saved.add(asset.id);
          }
        });
        const scope = { releaseId: release.id, projectId: project.id, selection: 'all' };
        const expected = expectedIds(records, saved, { selection: 'all' });
        const expectedCandidates = expected.filter((id) => !saved.has(id)).length;

        const { first, ids } = readAllPages(scope, '50');
        expect(first.total).toBe(expected.length);
        expect(first.candidateTotal).toBe(expectedCandidates);
        expect(first.pageCount).toBe(Math.max(1, Math.ceil(expected.length / 50)));
        expect(ids).toEqual(expected);

        const selected = assetRepo.getManageAssetsPage({ ...scope, selection: undefined, pageSize: 'all' });
        expect(pageIds(selected)).toEqual(expectedIds(records, saved));
        expect(selected.candidateTotal).toBe(0);
      });
    }
  });

  describe('E–H saved/unsaved and present/missing membership rules', () => {
    let project;
    let release;
    let category;
    let otherCategory;
    let records;
    let saved;
    let byName;

    beforeEach(() => {
      project = createProject('Membership Project');
      release = createRelease(project.id);
      category = createCategory(project.id, 'source');
      otherCategory = createCategory(project.id, 'other');
      records = [
        insertAsset(project.id, { filename: 'alpha.png', categoryId: category }),
        insertAsset(project.id, { filename: 'beta.jpg', extension: 'jpg', categoryId: otherCategory }),
        insertAsset(project.id, { filename: 'gamma.png' }),
        insertAsset(project.id, { filename: 'zzz-saved-missing.webp', extension: 'webp', isPresent: 0, categoryId: otherCategory }),
        insertAsset(project.id, { filename: 'alpha-missing-nonmember.png', isPresent: 0, categoryId: category }),
        insertAsset(project.id, { filename: 'delta-saved.png', categoryId: category }),
        insertAsset(project.id, { filename: 'epsilon-saved.jpg', extension: 'jpg' }),
      ];
      byName = Object.fromEntries(records.map((asset) => [asset.filename, asset.id]));
      saved = new Set([byName['zzz-saved-missing.webp'], byName['delta-saved.png'], byName['epsilon-saved.jpg']]);
      let order = 0;
      for (const id of saved) addMember(release.id, id, order++);
    });

    function read(filters) {
      return assetRepo.getManageAssetsPage({
        releaseId: release.id, projectId: project.id, pageSize: 'all', ...filters,
      });
    }

    it('E/O: saved-selected is the default; exact "all" adds unsaved present assets', () => {
      expect(pageIds(read({}))).toEqual([
        byName['delta-saved.png'], byName['epsilon-saved.jpg'], byName['zzz-saved-missing.webp'],
      ]);
      const all = read({ selection: 'all' });
      expect(pageIds(all)).toEqual(expectedIds(records, saved, { selection: 'all' }));
      expect(pageIds(all)).toEqual([
        byName['alpha.png'], byName['beta.jpg'], byName['delta-saved.png'],
        byName['epsilon-saved.jpg'], byName['gamma.png'], byName['zzz-saved-missing.webp'],
      ]);
      expect(all.total).toBe(6);
      expect(all.candidateTotal).toBe(3);
      expect(all.rows.map((row) => row.is_saved_member)).toEqual([0, 0, 1, 1, 0, 1]);
    });

    it('O: only the exact scalar "all" selects All assets', () => {
      for (const selection of ['ALL', 'All', ' all', ['all'], ['all', 'all'], 1, null, 'selected']) {
        const result = read({ selection });
        expect(result.selection).toBe('selected');
        expect(pageIds(result)).toEqual(expectedIds(records, saved));
      }
    });

    it('F/G: a saved missing asset bypasses Search, Category and Extension', () => {
      const filters = { search: 'alpha', categoryId: category, extension: 'png' };
      for (const selection of ['all', 'selected']) {
        const ids = pageIds(read({ ...filters, selection }));
        expect(ids).toEqual(expectedIds(records, saved, { ...filters, selection }));
        expect(ids).toContain(byName['zzz-saved-missing.webp']);
      }
      expect(pageIds(read({ ...filters, selection: 'all' }))).toEqual([
        byName['alpha.png'], byName['zzz-saved-missing.webp'],
      ]);
    });

    it('H: a missing non-member is excluded even with no filters and when it matches', () => {
      const ids = pageIds(read({ selection: 'all', search: 'missing-nonmember' }));
      expect(ids).toEqual([byName['zzz-saved-missing.webp']]);
      expect(pageIds(read({ selection: 'all' }))).not.toContain(byName['alpha-missing-nonmember.png']);
    });

    it('saved present members still have to satisfy the filters', () => {
      const ids = pageIds(read({ selection: 'selected', extension: 'png' }));
      expect(ids).toEqual([byName['delta-saved.png'], byName['zzz-saved-missing.webp']]);
    });

    it('M: combined Search/Category/Extension narrow present rows together', () => {
      const filters = { search: 'A', categoryId: category, extension: 'PNG' };
      const result = read({ ...filters, selection: 'all' });
      expect(pageIds(result)).toEqual(expectedIds(records, saved, {
        search: 'A', categoryId: category, extension: 'png', selection: 'all',
      }));
      expect(pageIds(result)).toEqual([
        byName['alpha.png'], byName['delta-saved.png'], byName['zzz-saved-missing.webp'],
      ]);
      expect(result.candidateTotal).toBe(1);
    });

    it('N: no category includes uncategorized assets; a category matches exactly', () => {
      const all = pageIds(read({ selection: 'all' }));
      expect(all).toContain(byName['gamma.png']);
      expect(pageIds(read({ selection: 'all', categoryId: otherCategory }))).toEqual([
        byName['beta.jpg'], byName['zzz-saved-missing.webp'],
      ]);
      expect(pageIds(read({ selection: 'all', categoryId: null }))).toEqual(all);
    });

    it('rejects an unvalidated category instead of widening to all categories', () => {
      for (const categoryId of ['1', 0, -1, 1.5, Number.NaN, [category], { id: category }]) {
        expect(() => read({ categoryId })).toThrow(TypeError);
      }
    });
  });

  describe('I–L Search and Extension semantics', () => {
    let project;
    let release;
    let records;
    let byName;

    beforeEach(() => {
      project = createProject('Search Project');
      release = createRelease(project.id);
      records = [
        'MixedCase.PNG', 'mixedcase-two.png', 'Église.png', 'église-lower.png', 'eglise-plain.png',
        'KELVIN-K.png', 'kite.png', '100%_done.png', 'a_b.png', 'axb.png', 'back\\slash.png',
        'percent.png', 'tar.gz.png',
      ].map((filename) => insertAsset(project.id, { filename }));
      records.push(insertAsset(project.id, { filename: 'upper-ext.PNG', extension: 'PNG' }));
      records.push(insertAsset(project.id, { filename: 'archive.png.bak', extension: 'png.bak' }));
      records.push(insertAsset(project.id, { filename: 'noext', extension: '' }));
      byName = Object.fromEntries(records.map((asset) => [asset.filename, asset.id]));
    });

    function searchIds(search, extra = {}) {
      return pageIds(assetRepo.getManageAssetsPage({
        releaseId: release.id, projectId: project.id, selection: 'all', pageSize: 'all', search, ...extra,
      }));
    }

    function expectedSearch(search, extra = {}) {
      return expectedIds(records, new Set(), {
        selection: 'all', search: typeof search === 'string' && search.trim() ? search.trim() : null, ...extra,
      });
    }

    it('I: ASCII search is a case-insensitive substring and is trimmed', () => {
      // NOCASE order: "mixedcase-" sorts before "mixedcase." ('-' < '.').
      expect(searchIds('mixedcase')).toEqual([byName['mixedcase-two.png'], byName['MixedCase.PNG']]);
      expect(searchIds('mixedcase')).toEqual(expectedSearch('mixedcase'));
      expect(searchIds('  MIXEDCASE  ')).toEqual(searchIds('mixedcase'));
      expect(searchIds('MiXeDcAsE-TWO')).toEqual([byName['mixedcase-two.png']]);
    });

    it('I: blank, repeated and non-string searches are unrestricted', () => {
      const unrestricted = searchIds(null);
      expect(unrestricted).toHaveLength(records.length);
      for (const search of ['', '   ', ['mixed'], ['mixed', 'kite'], 42, { q: 'kite' }, undefined]) {
        expect(searchIds(search)).toEqual(unrestricted);
      }
    });

    it('J: Unicode search follows JavaScript toLowerCase(), not SQLite LOWER()', () => {
      // SQLite's built-in LOWER() only folds ASCII; prove the divergence.
      expect(db.prepare("SELECT lower('É') AS v").get().v).toBe('É');
      expect(db.prepare("SELECT lower('K') AS v").get().v).toBe('K');
      expect('K'.toLowerCase()).toBe('k');

      // NOCASE does not fold non-ASCII, so 'É' (U+00C9) sorts before 'é' (U+00E9).
      expect(searchIds('ÉGLISE')).toEqual([byName['Église.png'], byName['église-lower.png']]);
      expect(searchIds('ÉGLISE')).toEqual(expectedSearch('ÉGLISE'));
      expect(searchIds('église')).toEqual(expectedSearch('église'));
      expect(searchIds('église')).not.toContain(byName['eglise-plain.png']);
      // Kelvin sign lowercases to ASCII "k" in JavaScript.
      expect(searchIds('kelvin-k')).toEqual([byName['KELVIN-K.png']]);
      expect(searchIds('K')).toEqual(expectedSearch('K'));
      expect(searchIds('K')).toEqual(expect.arrayContaining([byName['kite.png'], byName['KELVIN-K.png']]));
    });

    it('K: %, _ and backslash are literal characters', () => {
      expect(searchIds('%')).toEqual([byName['100%_done.png']]);
      expect(searchIds('_')).toEqual(expectedSearch('_'));
      expect(searchIds('_')).toEqual([byName['100%_done.png'], byName['a_b.png']]);
      expect(searchIds('a_b')).toEqual([byName['a_b.png']]);
      expect(searchIds('\\')).toEqual([byName['back\\slash.png']]);
      expect(searchIds('%_')).toEqual([byName['100%_done.png']]);
      expect(searchIds('a%b')).toEqual([]);
    });

    it('L: extension matches the whole normalized stored extension only', () => {
      const png = searchIds(null, { extension: 'png' });
      expect(png).toEqual(expectedSearch(null, { extension: 'png' }));
      expect(png).toContain(byName['upper-ext.PNG']);
      expect(png).not.toContain(byName['archive.png.bak']);
      expect(searchIds(null, { extension: ' PNG ' })).toEqual(png);
      expect(searchIds(null, { extension: 'pn' })).toEqual([]);
      expect(searchIds(null, { extension: 'png.bak' })).toEqual([byName['archive.png.bak']]);
    });

    it('L: invalid, blank, repeated or non-string extensions are unrestricted', () => {
      const unrestricted = searchIds(null);
      for (const extension of ['', '  ', 'p ng', 'png;', '%', ['png'], ['png', 'jpg'], 7, null]) {
        expect(searchIds(null, { extension })).toEqual(unrestricted);
      }
    });
  });

  describe('P/Y release/project isolation', () => {
    it('never returns or counts rows for a foreign or mismatched release/project', () => {
      const projectA = createProject('Isolation A');
      const projectB = createProject('Isolation B');
      const releaseA = createRelease(projectA.id);
      const releaseB = createRelease(projectB.id);
      const a1 = insertAsset(projectA.id, { filename: 'a1.png' });
      const b1 = insertAsset(projectB.id, { filename: 'b1.png' });
      const bMissing = insertAsset(projectB.id, { filename: 'b-missing.png', isPresent: 0 });
      addMember(releaseA.id, a1.id, 0);
      // Malformed cross-project junction rows inserted directly (bypassing the
      // repository's ownership-aware insert) must never leak.
      addMember(releaseA.id, b1.id, 1);
      addMember(releaseA.id, bMissing.id, 2);

      const own = assetRepo.getManageAssetsPage({
        releaseId: releaseA.id, projectId: projectA.id, selection: 'all', pageSize: 'all',
      });
      expect(pageIds(own)).toEqual([a1.id]);
      expect(own.total).toBe(1);
      expect(own.candidateTotal).toBe(0);

      const mismatches = [
        { releaseId: releaseA.id, projectId: projectB.id },
        { releaseId: releaseB.id, projectId: projectA.id },
        { releaseId: 999999, projectId: projectA.id },
        { releaseId: releaseA.id, projectId: 999999 },
      ];
      for (const scope of mismatches) {
        for (const selection of ['all', 'selected']) {
          const result = assetRepo.getManageAssetsPage({ ...scope, selection, pageSize: '10' });
          expect(result).toEqual({
            rows: [], total: 0, candidateTotal: 0, page: 1, pageCount: 1, pageSize: 10, selection,
          });
        }
        expect(assetRepo.getManageAssetsAggregates(scope)).toEqual({
          categoryNavigation: { totalCount: 0, uncategorizedCount: 0, byCategoryId: {} },
          eligibleAssetCount: 0,
          eligibleCandidateCount: 0,
        });
      }

      const aggregates = assetRepo.getManageAssetsAggregates({ releaseId: releaseA.id, projectId: projectA.id });
      expect(aggregates.categoryNavigation.totalCount).toBe(1);
      expect(aggregates.eligibleCandidateCount).toBe(0);
    });

    it('returns the empty shape without SQL for invalid identifiers', () => {
      const { repo, executed } = openInstrumented();
      for (const scope of [
        {}, { releaseId: '1', projectId: 1 }, { releaseId: 1, projectId: '1' },
        { releaseId: 0, projectId: 1 }, { releaseId: 1.5, projectId: 1 }, { releaseId: 1, projectId: -1 },
      ]) {
        expect(repo.getManageAssetsPage(scope)).toEqual({
          rows: [], total: 0, candidateTotal: 0, page: 1, pageCount: 1, pageSize: 25, selection: 'selected',
        });
        expect(repo.getManageAssetsAggregates(scope).categoryNavigation.totalCount).toBe(0);
      }
      expect(executed).toEqual([]);
    });
  });

  describe('Q stable ordering with filename ties', () => {
    it('breaks NOCASE filename ties by asset ID across page boundaries', () => {
      const project = createProject('Tie Project');
      const release = createRelease(project.id);
      const records = [];
      records.push(insertAsset(project.id, { filename: 'aaa.png' }));
      for (let i = 0; i < 12; i += 1) {
        const variants = ['tie.png', 'TIE.png', 'Tie.png'];
        records.push(insertAsset(project.id, { filename: variants[i % 3] }));
      }
      records.push(insertAsset(project.id, { filename: 'zzz.png' }));
      records.push(insertAsset(project.id, { filename: 'Bbb.png' }));
      const scope = { releaseId: release.id, projectId: project.id, selection: 'all' };

      const expected = expectedIds(records, new Set(), { selection: 'all' });
      const tieIds = records.filter((asset) => asciiFold(asset.filename) === 'tie.png').map((asset) => asset.id);
      // Expected order: aaa, Bbb, the 12 ties in ascending ID order, zzz.
      expect(expected).toEqual([records[0].id, records[14].id, ...tieIds, records[13].id]);

      const { first, ids } = readAllPages(scope, '10');
      expect(first.pageCount).toBe(2);
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(ids.length);
      // The tie group straddles the boundary: page 1 ends and page 2 starts inside it.
      const page2 = pageIds(assetRepo.getManageAssetsPage({ ...scope, page: 2, pageSize: '10' }));
      expect(tieIds).toContain(first.rows[9].id);
      expect(tieIds).toContain(page2[0]);

      for (let repeat = 0; repeat < 3; repeat += 1) {
        expect(readAllPages(scope, '10').ids).toEqual(expected);
      }
    });
  });

  describe('R–T page clamping and page-size normalization', () => {
    let project;
    let release;
    let records;
    let scope;

    beforeEach(() => {
      project = createProject('Paging Project');
      release = createRelease(project.id);
      records = seedBulk(project.id, 23);
      scope = { releaseId: release.id, projectId: project.id, selection: 'all' };
    });

    it('R: empty collection is page 1 of 1 with total 0', () => {
      const emptyProject = createProject('Empty Project');
      const emptyRelease = createRelease(emptyProject.id);
      expect(assetRepo.getManageAssetsPage({
        releaseId: emptyRelease.id, projectId: emptyProject.id, selection: 'all', page: '7', pageSize: '50',
      })).toEqual({ rows: [], total: 0, candidateTotal: 0, page: 1, pageCount: 1, pageSize: 50, selection: 'all' });
    });

    it('R: the last page holds the remainder', () => {
      const expected = expectedIds(records, new Set(), { selection: 'all' });
      const last = assetRepo.getManageAssetsPage({ ...scope, page: '3', pageSize: '10' });
      expect(last.page).toBe(3);
      expect(last.pageCount).toBe(3);
      expect(pageIds(last)).toEqual(expected.slice(20));
    });

    it('S: huge or malformed page numbers clamp before OFFSET is computed', () => {
      const expected = expectedIds(records, new Set(), { selection: 'all' });
      for (const page of ['999999999999999999999999', 1e300, Number.MAX_SAFE_INTEGER, '4', 4]) {
        const result = assetRepo.getManageAssetsPage({ ...scope, page, pageSize: '10' });
        expect(result.page).toBe(3);
        expect(pageIds(result)).toEqual(expected.slice(20));
      }
      for (const page of [0, -1, '0', '-2', '1.5', 2.5, 'abc', '+2', ' 2', ['2'], Number.NaN, Infinity, null]) {
        const result = assetRepo.getManageAssetsPage({ ...scope, page, pageSize: '10' });
        expect(result.page).toBe(1);
        expect(pageIds(result)).toEqual(expected.slice(0, 10));
      }
    });

    it('T: only supported sizes are honoured; everything else is 25', () => {
      const fifty = seedBulk(project.id, 40, { prefix: 'more' });
      const all = expectedIds([...records, ...fifty], new Set(), { selection: 'all' });
      for (const [pageSize, effective] of [
        ['10', 10], [10, 10], ['25', 25], ['50', 50], [50, 50], ['100', 100], ['150', 150], ['200', 200], [200, 200],
      ]) {
        const result = assetRepo.getManageAssetsPage({ ...scope, pageSize });
        expect(result.pageSize).toBe(effective);
        expect(pageIds(result)).toEqual(all.slice(0, effective));
      }
      for (const pageSize of [
        '30', 30, '0', 0, '-10', '25.0', '010', '1000', 1000, 1e9, Infinity, Number.NaN,
        ['25', '50'], ['all'], ['all', 'all'], ['all', '10'], 'ALL', 'All', ' all', 'all ', '', null, undefined,
      ]) {
        const result = assetRepo.getManageAssetsPage({ ...scope, pageSize });
        expect(result.pageSize).toBe(25);
        expect(result.rows).toHaveLength(25);
        expect(pageIds(result)).toEqual(all.slice(0, 25));
      }
    });
  });

  describe('U explicit View All', () => {
    it('returns every matching row (beyond 200) as page 1 of 1 in stable order', () => {
      const project = createProject('View All Project');
      const release = createRelease(project.id);
      const records = seedBulk(project.id, 250, { every: 10 });
      const saved = new Set([records[0].id, records[5].id]);
      addMember(release.id, records[0].id, 0);
      addMember(release.id, records[5].id, 1);
      const expected = expectedIds(records, saved, { selection: 'all' });
      expect(expected.length).toBeGreaterThan(200);

      const result = assetRepo.getManageAssetsPage({
        releaseId: release.id, projectId: project.id, selection: 'all', page: '9', pageSize: 'all',
      });
      expect(result.page).toBe(1);
      expect(result.pageCount).toBe(1);
      expect(result.pageSize).toBe('all');
      expect(result.total).toBe(expected.length);
      expect(pageIds(result)).toEqual(expected);
    });
  });

  describe('X grouped category aggregates', () => {
    it('counts present and missing rows per category plus eligible totals in one statement', () => {
      const project = createProject('Aggregate Project');
      const other = createProject('Aggregate Other');
      const release = createRelease(project.id);
      const source = createCategory(project.id, 'source');
      const renders = createCategory(project.id, 'renders');
      const empty = createCategory(project.id, 'empty');
      const s1 = insertAsset(project.id, { filename: 's1.png', categoryId: source });
      insertAsset(project.id, { filename: 's2.png', categoryId: source, isPresent: 0 });
      insertAsset(project.id, { filename: 'r1.png', categoryId: renders });
      insertAsset(project.id, { filename: 'u1.png' });
      const uMissing = insertAsset(project.id, { filename: 'u2.png', isPresent: 0 });
      insertAsset(project.id, { filename: 'u3.png' });
      const foreign = insertAsset(other.id, { filename: 'foreign.png' });
      addMember(release.id, s1.id, 0);
      addMember(release.id, uMissing.id, 1);
      addMember(release.id, foreign.id, 2);

      const { repo, executed } = openInstrumented();
      const aggregates = repo.getManageAssetsAggregates({ releaseId: release.id, projectId: project.id });
      expect(aggregates).toEqual({
        categoryNavigation: {
          totalCount: 6,
          uncategorizedCount: 3,
          byCategoryId: { [source]: 2, [renders]: 1 },
        },
        eligibleAssetCount: 4,
        eligibleCandidateCount: 3,
      });
      expect(aggregates.categoryNavigation.byCategoryId).not.toHaveProperty(String(empty));
      expect(executed).toHaveLength(1);
      expect(executed[0].sql).toMatch(/GROUP BY a\.category_id/);
      expect(executed[0].rowCount).toBeLessThanOrEqual(3);

      // Parity with the existing project navigation helper.
      const navigation = assetRepo.getProjectAssetNavigationCounts(project.id);
      expect(aggregates.categoryNavigation.totalCount).toBe(navigation.total);
      expect(aggregates.categoryNavigation.uncategorizedCount).toBe(navigation.uncategorized);
      expect(aggregates.categoryNavigation.byCategoryId).toEqual(navigation.byCategoryId);
    });
  });

  describe('SQL bounds instrumentation', () => {
    const NUMERIC_SIZES = [10, 25, 50, 100, 150, 200];

    function assertBoundedRead(executed, { pageSize, offset }) {
      expect(executed).toHaveLength(2);
      const [count, page] = executed;
      expect(count.method).toBe('get');
      expect(count.sql).toMatch(/SELECT\s+COUNT\(\*\) AS total/);
      expect(count.sql).not.toMatch(/LIMIT/);
      expect(page.method).toBe('all');
      expect(page.sql).toMatch(/LIMIT \? OFFSET \?\s*$/);
      // The ID tie-breaker must be explicit: an index scan on
      // (project_id, filename NOCASE, id) can otherwise mask its absence.
      expect(page.sql).toMatch(/ORDER BY a\.filename COLLATE NOCASE ASC, a\.id ASC\s+LIMIT/);
      expect(page.args.slice(-2)).toEqual([pageSize, offset]);
      expect(page.rowCount).toBeLessThanOrEqual(pageSize);
      // No whole-project full-asset SELECT: every statement touching assets
      // is either the aggregate COUNT or the LIMITed page read.
      for (const statement of executed) {
        expect(statement.sql.includes('COUNT(*)') || /LIMIT \? OFFSET \?/.test(statement.sql)).toBe(true);
      }
    }

    it('B–D: statement count and transferred rows stay fixed as the project grows', () => {
      const project = createProject('Bounds Project');
      const release = createRelease(project.id);
      const sizes = [25, 250, 2000, 10000];
      let seeded = [];
      const observations = [];
      for (const target of sizes) {
        seeded = seeded.concat(seedBulk(project.id, target - seeded.length, { prefix: `grow${target}`, every: 11 }));
        const saved = new Set(seeded.filter((_, index) => index % 13 === 0).map((asset) => asset.id));
        db.prepare('DELETE FROM release_assets WHERE release_id = ?').run(release.id);
        let order = 0;
        db.transaction(() => { for (const id of saved) addMember(release.id, id, order++); })();
        const expected = expectedIds(seeded, saved, { selection: 'all' });

        const { repo, executed, verboseLog } = openInstrumented();
        const result = repo.getManageAssetsPage({
          releaseId: release.id, projectId: project.id, selection: 'all', page: '2', pageSize: '10',
        });
        assertBoundedRead(executed, { pageSize: 10, offset: 10 });
        expect(result.total).toBe(expected.length);
        expect(result.candidateTotal).toBe(expected.filter((id) => !saved.has(id)).length);
        expect(pageIds(result)).toEqual(expected.slice(10, 20));
        // better-sqlite3 verbose logs the executed SQL with bound values expanded.
        // Both statements run inside one transaction (one read snapshot).
        expect(verboseLog[0]).toBe('BEGIN');
        expect(verboseLog.at(-1)).toBe('COMMIT');
        expect(verboseLog.filter((sql) => !/^(BEGIN|COMMIT)$/.test(sql))).toHaveLength(2);
        expect(verboseLog.filter((sql) => /LIMIT 10(\.0)? OFFSET 10(\.0)?\s*$/.test(sql))).toHaveLength(1);
        observations.push({
          target, statements: executed.length, rowsReturned: executed.map((statement) => statement.rowCount),
        });
      }
      expect(observations).toEqual(sizes.map((target) => ({ target, statements: 2, rowsReturned: [1, 10] })));
    });

    it('every numeric size reads at most pageSize rows from a 2,000-asset project (deep and last pages)', () => {
      const project = createProject('Sizes Project');
      const release = createRelease(project.id);
      const records = seedBulk(project.id, 2000);
      const expected = expectedIds(records, new Set(), { selection: 'all' });
      for (const pageSize of NUMERIC_SIZES) {
        const pageCount = Math.ceil(2000 / pageSize);
        for (const page of [1, Math.ceil(pageCount / 2), pageCount, pageCount + 50]) {
          const { repo, executed } = openInstrumented();
          const result = repo.getManageAssetsPage({
            releaseId: release.id, projectId: project.id, selection: 'all', page, pageSize: String(pageSize),
          });
          const effectivePage = Math.min(page, pageCount);
          assertBoundedRead(executed, { pageSize, offset: (effectivePage - 1) * pageSize });
          expect(result.page).toBe(effectivePage);
          expect(pageIds(result)).toEqual(expected.slice((effectivePage - 1) * pageSize, effectivePage * pageSize));
        }
      }
    });

    it('filtered numeric reads stay bounded and the count matches the reference model', () => {
      const project = createProject('Filtered Bounds');
      const release = createRelease(project.id);
      const records = seedBulk(project.id, 2000, { every: 7 });
      const saved = new Set(records.filter((_, index) => index % 3 === 0).map((asset) => asset.id));
      let order = 0;
      db.transaction(() => { for (const id of saved) addMember(release.id, id, order++); })();
      for (const selection of ['all', 'selected']) {
        const { repo, executed } = openInstrumented();
        const result = repo.getManageAssetsPage({
          releaseId: release.id, projectId: project.id, selection, search: '-0001', page: '2', pageSize: '10',
        });
        const expected = expectedIds(records, saved, { selection, search: '-0001' });
        assertBoundedRead(executed, { pageSize: 10, offset: 10 });
        expect(result.total).toBe(expected.length);
        expect(pageIds(result)).toEqual(expected.slice(10, 20));
      }
    });

    it('View All is the only unbounded read and is not LIMITed', () => {
      const project = createProject('All Bounds');
      const release = createRelease(project.id);
      seedBulk(project.id, 300);
      const { repo, executed } = openInstrumented();
      const result = repo.getManageAssetsPage({
        releaseId: release.id, projectId: project.id, selection: 'all', pageSize: 'all',
      });
      expect(executed).toHaveLength(2);
      expect(executed[1].sql).not.toMatch(/LIMIT/);
      expect(executed[1].rowCount).toBe(300);
      expect(result.rows).toHaveLength(300);
    });

    it('an empty match issues only the count statement', () => {
      const project = createProject('Empty Bounds');
      const release = createRelease(project.id);
      seedBulk(project.id, 50);
      const { repo, executed } = openInstrumented();
      const result = repo.getManageAssetsPage({
        releaseId: release.id, projectId: project.id, selection: 'all', search: 'no-such-file',
      });
      expect(result.total).toBe(0);
      expect(executed).toHaveLength(1);
      expect(executed[0].rowCount).toBe(1);
    });
  });

  describe('read consistency', () => {
    it('count and page read share one snapshot even if a write lands between them', () => {
      const project = createProject('Snapshot Project');
      const release = createRelease(project.id);
      const records = seedBulk(project.id, 30);
      const expected = expectedIds(records, new Set(), { selection: 'all' });
      let injected = false;
      const { repo } = openInstrumented({
        afterStatement: ({ sql }) => {
          if (injected || !sql.includes('COUNT(*)')) return;
          injected = true;
          // A concurrent writer (separate connection) adds a row that sorts
          // first and would shift page 1 if the page read saw it.
          db.prepare(`
            INSERT INTO assets (project_id, relative_path, filename, extension, is_present)
            VALUES (?, 'late/0.png', '0-late.png', 'png', 1)
          `).run(project.id);
        },
      });
      const result = repo.getManageAssetsPage({
        releaseId: release.id, projectId: project.id, selection: 'all', page: '1', pageSize: '10',
      });
      expect(injected).toBe(true);
      expect(result.total).toBe(30);
      expect(pageIds(result)).toEqual(expected.slice(0, 10));
      // The write is visible to the next read.
      expect(repo.getManageAssetsPage({
        releaseId: release.id, projectId: project.id, selection: 'all', page: '1', pageSize: '10',
      }).total).toBe(31);
    });

    it('participates in a caller-owned outer transaction without nesting conflicts', () => {
      const project = createProject('Outer Tx Project');
      const release = createRelease(project.id);
      const records = seedBulk(project.id, 12);
      addMember(release.id, records[0].id, 0);
      const snapshot = db.transaction(() => {
        expect(db.inTransaction).toBe(true);
        const membership = releaseRepo.listReleaseAssetMembership(release.id, { projectId: project.id });
        const aggregates = assetRepo.getManageAssetsAggregates({ releaseId: release.id, projectId: project.id });
        const page = assetRepo.getManageAssetsPage({
          releaseId: release.id, projectId: project.id, selection: 'all', pageSize: '10',
        });
        expect(db.inTransaction).toBe(true);
        return { membership, aggregates, page };
      })();
      expect(db.inTransaction).toBe(false);
      expect(snapshot.membership.map((row) => row.asset_id)).toEqual([records[0].id]);
      expect(snapshot.aggregates.eligibleCandidateCount).toBe(11);
      expect(snapshot.page.total).toBe(12);
      expect(snapshot.page.rows).toHaveLength(10);
    });
  });

  describe('JavaScript lowercase SQL function registration', () => {
    it('is registered by openDatabase and idempotently by the repository factory', () => {
      expect(db.prepare(`SELECT ${JS_LOWER_SQL_FUNCTION}('ÉK') AS v`).get().v).toBe('ék');
      expect(db.prepare(`SELECT ${JS_LOWER_SQL_FUNCTION}(NULL) AS v`).get().v).toBeNull();
      // A second factory on the same connection must not re-register it.
      expect(() => createAssetRepository(db)).not.toThrow();
      expect(registerSqlFunctions(db)).toBe(db);

      const raw = new Database(dbPath);
      extraConnections.push(raw);
      expect(() => raw.prepare(`SELECT ${JS_LOWER_SQL_FUNCTION}('A')`).get()).toThrow(/no such function/);
      createAssetRepository(raw);
      expect(raw.prepare(`SELECT ${JS_LOWER_SQL_FUNCTION}('Ä') AS v`).get().v).toBe('ä');
    });
  });

  describe('existing generic reads are unchanged', () => {
    it('findByProjectId still returns the whole project collection', () => {
      const project = createProject('Generic Project');
      const records = seedBulk(project.id, 60, { every: 6 });
      const rows = assetRepo.findByProjectId(project.id, { sortBy: 'filename', order: 'asc' });
      expect(rows).toHaveLength(60);
      expect(rows[0]).not.toHaveProperty('is_saved_member');
      expect(new Set(rows.map((row) => row.id))).toEqual(new Set(records.map((asset) => asset.id)));
    });
  });
});
