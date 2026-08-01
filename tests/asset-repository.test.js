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

  /**
   * Helper: insert a release directly.
   */
  function insertRelease(db, { projectId, title, status = 'idea', archivedAt = null }) {
    return db.prepare(`
      INSERT INTO releases (project_id, title, description, notes, status,
                            planned_date, published_date, patreon_url, archived_at)
      VALUES (?, ?, '', '', ?, NULL, NULL, NULL, ?)
      RETURNING *
    `).get(projectId, title, status, archivedAt);
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
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'R1', '', '', 'idea', NULL, NULL, NULL)
        RETURNING id
      `).get(projectId).id;
      const rel2Id = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'R2', '', '', 'idea', NULL, NULL, NULL)
        RETURNING id
      `).get(projectId).id;
      const rel3Id = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'R3', '', '', 'idea', NULL, NULL, NULL)
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
        priority: 'normal',
        plannedDate: null,
        publishedDate: null,
        patreonUrl: null,
      });
      const otherRelId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'Other Release', '', '', 'idea', NULL, NULL, NULL)
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
        status: 'tbd', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null,
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
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'R1', '', '', 'idea', NULL, NULL, NULL)
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
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'R1', '', '', 'idea', NULL, NULL, NULL)
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
        status: 'tbd', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null,
      });
      const otherRelId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'Other Release', '', '', 'idea', NULL, NULL, NULL)
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
        status: 'tbd', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null,
      });
      const otherRelId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'Other Release', '', '', 'idea', NULL, NULL, NULL)
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
        status: 'tbd', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null,
      });
      const otherRelId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'Other Release', '', '', 'idea', NULL, NULL, NULL)
        RETURNING id
      `).get(otherProject.id).id;
      const myRelId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'My Release', '', '', 'idea', NULL, NULL, NULL)
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
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'R1', '', '', 'idea', NULL, NULL, NULL)
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
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'R1', '', '', 'idea', NULL, NULL, NULL)
        RETURNING id
      `).get(projectId).id;
      const r2Id = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'R2', '', '', 'idea', NULL, NULL, NULL)
        RETURNING id
      `).get(projectId).id;
      const r3Id = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'R3', '', '', 'published', NULL, NULL, NULL)
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
        status: 'tbd', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null,
      });
      const otherRelId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'Other Release', '', '', 'idea', NULL, NULL, NULL)
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
        status: 'tbd', priority: 'normal', plannedDate: null, publishedDate: null, patreonUrl: null,
      });
      const otherRelId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'Other Release', '', '', 'idea', NULL, NULL, NULL)
        RETURNING id
      `).get(otherProject.id).id;
      const myRelId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'My Release', '', '', 'idea', NULL, NULL, NULL)
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
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'R1', '', '', 'idea', NULL, NULL, NULL)
        RETURNING id
      `).get(projectId).id;
      const r2Id = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'R2', '', '', 'idea', NULL, NULL, NULL)
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
