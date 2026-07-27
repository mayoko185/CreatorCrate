import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import slugify from '@sindresorhus/slugify';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('asset repository', () => {
  let tmpDir;
  let dbPath;
  let db;
  let assetRepo;
  let projectRepo;
  let projectId;

  function createProject(title = 'Test Project', overrides = {}) {
    return projectRepo.create({
      title,
      slug: slugify(title, { lowercase: true }),
      description: '',
      notes: '',
      status: 'tbd',
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
});
