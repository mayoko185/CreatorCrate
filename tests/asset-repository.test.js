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

  // ─── Delete ──────────────────────────────────────────────────────

  it('deletes assets not in a keep list', () => {
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

    const removed = assetRepo.deleteByProjectIdAndPathNotIn(projectId, ['keep.png']);
    expect(removed).toBe(2);

    const remaining = assetRepo.findByProjectId(projectId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].filename).toBe('keep.png');
  });

  it('deletes all assets for a project with empty keep list', () => {
    assetRepo.upsert(projectId, 'a.png', {
      filename: 'a.png', extension: 'png', mimeType: 'image/png',
      sizeBytes: 100, modifiedAt: null,
    });
    assetRepo.upsert(projectId, 'b.jpg', {
      filename: 'b.jpg', extension: 'jpg', mimeType: 'image/jpeg',
      sizeBytes: 100, modifiedAt: null,
    });

    const removed = assetRepo.deleteByProjectIdAndPathNotIn(projectId, []);
    expect(removed).toBe(2);

    expect(assetRepo.findByProjectId(projectId)).toHaveLength(0);
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
});
