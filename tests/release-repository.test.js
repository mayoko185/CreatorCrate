import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createReleaseRepository } from '../src/data/release-repository.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { getLocalTodayIso } from '../src/util/date.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function sampleProject(overrides = {}) {
  const title = overrides.title ?? 'Test Project';
  return {
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
  };
}

function sampleRelease(overrides = {}) {
  return {
    title: 'Test Release',
    description: '',
    notes: '',
    plannedDate: null,
    patreonUrl: null,
    ...overrides,
  };
}

function sampleAsset(projectId, overrides = {}) {
  return {
    projectId,
    relativePath: overrides.relativePath ?? 'test.txt',
    filename: overrides.filename ?? 'test.txt',
    extension: overrides.extension ?? 'txt',
    mimeType: overrides.mimeType ?? 'text/plain',
    sizeBytes: overrides.sizeBytes ?? 100,
    modifiedAt: overrides.modifiedAt ?? '2025-01-01T00:00:00Z',
  };
}

describe('release repository', () => {
  let tmpDir;
  let dbPath;
  let db;
  let releaseRepo;
  let projectRepo;
  let assetRepo;
  let projectId;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-repo-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    releaseRepo = createReleaseRepository(db);
    projectRepo = createProjectRepository(db);
    assetRepo = createAssetRepository(db);
    const project = projectRepo.create(sampleProject({ title: 'Parent Project' }));
    projectId = project.id;
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('creates a release without a release-owned status field', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Alpha Release' }) });
      expect(release.title).toBe('Alpha Release');
      expect(release.project_id).toBe(projectId);
      expect(release.id).toBeTruthy();
      expect(release).not.toHaveProperty('status');
    });

    it('creates a release with all fields', () => {
      const input = {
        projectId,
        title: 'Full Release',
        description: 'A description',
        notes: 'Some notes',
        plannedDate: '2025-06-15',
        patreonUrl: 'https://patreon.com/user',
      };
      const release = releaseRepo.create(input);
      expect(release.title).toBe('Full Release');
      expect(release.description).toBe('A description');
      expect(release.notes).toBe('Some notes');
      expect(release.planned_date).toBe('2025-06-15');
      expect(release.patreon_url).toBe('https://patreon.com/user');
      expect(release).not.toHaveProperty('status');
    });

    it('rejects duplicate titles (titles are not unique enforced)', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Same Title' }) });
      const second = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Same Title' }) });
      expect(second.title).toBe('Same Title');
    });

    it('rejects invalid foreign key (non-existent project)', () => {
      expect(() => {
        releaseRepo.create({ projectId: 99999, ...sampleRelease() });
      }).toThrow();
    });

    it('rolls back the release when an initial asset assignment fails', () => {
      const otherProject = projectRepo.create(sampleProject({ title: 'Other Project' }));
      const localAsset = assetRepo.upsert(
        projectId,
        'local.txt',
        sampleAsset(projectId, { relativePath: 'local.txt' }),
      );
      const foreignAsset = assetRepo.upsert(
        otherProject.id,
        'foreign.txt',
        sampleAsset(otherProject.id, { relativePath: 'foreign.txt' }),
      );

      expect(() => releaseRepo.createWithAssetSelections(
        { projectId, ...sampleRelease({ title: 'Atomic Failure' }) },
        [
          { assetId: localAsset.id, role: 'attachment', sortOrder: 0 },
          { assetId: foreignAsset.id, role: 'attachment', sortOrder: 1 },
        ],
      )).toThrow(/same project/);

      expect(releaseRepo.findByProjectId(projectId, { includeArchived: true })).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS count FROM release_assets').get().count).toBe(0);
    });
  });

  describe('findById', () => {
    it('returns a release by id', () => {
      const created = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Find Me' }) });
      const found = releaseRepo.findById(created.id);
      expect(found.title).toBe('Find Me');
    });

    it('returns undefined for non-existent id', () => {
      const found = releaseRepo.findById(99999);
      expect(found).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('removes the release row and cascades to release_assets', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'To Delete' }) });
      const asset = assetRepo.upsert(projectId, 'asset.txt', sampleAsset(projectId, { relativePath: 'asset.txt' }));
      releaseRepo.createWithAssetSelections(
        { projectId, ...sampleRelease({ title: 'Other' }) },
        [{ assetId: asset.id, role: 'attachment', sortOrder: 0 }],
      );

      expect(releaseRepo.delete(release.id)).toBe(true);
      expect(releaseRepo.findById(release.id)).toBeUndefined();
      expect(assetRepo.findById(asset.id)).toBeDefined();
    });

    it('returns false for a non-existent id', () => {
      expect(releaseRepo.delete(99999)).toBe(false);
    });
  });

  describe('findByProjectId', () => {
    it('returns releases for a project', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'R1' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'R2' }) });
      const releases = releaseRepo.findByProjectId(projectId);
      expect(releases).toHaveLength(2);
    });

    it('does not return releases from other projects', () => {
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Mine' }) });
      releaseRepo.create({ projectId: otherProject.id, ...sampleRelease({ title: 'Other\'s' }) });
      const releases = releaseRepo.findByProjectId(projectId);
      expect(releases).toHaveLength(1);
      expect(releases[0].title).toBe('Mine');
    });

    it('ignores obsolete release-status filters without mapping them to project status', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'First' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Second' }) });
      const results = releaseRepo.findByProjectId(projectId, { status: 'planned' });
      expect(results).toHaveLength(2);
      expect(results.every((release) => release.project_status === 'tbd')).toBe(true);
      expect(results.every((release) => !Object.hasOwn(release, 'status'))).toBe(true);
    });

    it('excludes archived releases by default', () => {
      const r1 = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Active' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Archived' }) });
      releaseRepo.archive(r1.id);
      const releases = releaseRepo.findByProjectId(projectId);
      expect(releases).toHaveLength(1);
      expect(releases[0].title).toBe('Archived');
    });

    it('includes archived releases when requested', () => {
      const r1 = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Active' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Archived' }) });
      releaseRepo.archive(r1.id);
      const releases = releaseRepo.findByProjectId(projectId, { includeArchived: true });
      expect(releases).toHaveLength(2);
    });

    it('sorts by updated desc by default', () => {
      const r1 = releaseRepo.create({ projectId, ...sampleRelease({ title: 'First' }) });
      releaseRepo.update(r1.id, { title: 'First Updated', description: '', notes: '', status: 'tbd', plannedDate: null, patreonUrl: null });
      const r2 = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Second' }) });
      const releases = releaseRepo.findByProjectId(projectId);
      expect(releases).toHaveLength(2);
      // r2 has newer updated_at, so should come first in DESC order
      expect(releases[0].id).toBe(r2.id);
      expect(releases[1].id).toBe(r1.id);
    });

    it('sorts by planned_date asc when specified', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Later', plannedDate: '2025-12-01' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Earlier', plannedDate: '2025-06-01' }) });
      const releases = releaseRepo.findByProjectId(projectId, { sortBy: 'planned', order: 'asc' });
      expect(releases[0].title).toBe('Earlier');
      expect(releases[1].title).toBe('Later');
    });
  });

  describe('findCalendarRange', () => {
    it('returns scheduled non-archived releases in date/time order without release-status filtering', () => {
      const untimed = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Untimed', plannedDate: '2025-06-15' }),
      });
      const late = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Late', publishedDate: '2025-01-01', plannedDate: '2025-06-15', plannedTime: '10:00' }),
      });
      const early = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Early', plannedDate: '2025-06-15', plannedTime: '08:00' }),
      });
      const sameTimeLaterTitle = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Zeta', plannedDate: '2025-06-15', plannedTime: '08:00' }),
      });
      const archived = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Archived', plannedDate: '2025-06-15', plannedTime: '07:00' }),
      });
      releaseRepo.archive(archived.id);
      releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Unscheduled', plannedDate: null }),
      });

      const rows = releaseRepo.findCalendarRange('2025-06-01', '2025-07-01');

      expect(rows.map((row) => row.id)).toEqual([early.id, sameTimeLaterTitle.id, late.id, untimed.id]);
      expect(rows.map((row) => row.planned_time)).toEqual(['08:00', '08:00', '10:00', null]);
      expect(rows.every((row) => row.archived_at === null)).toBe(true);
      expect(rows.every((row) => row.project_status === 'tbd')).toBe(true);
      expect(rows.find((row) => row.title === 'Late').published_date).toBe('2025-01-01');
    });

  });

  describe('findReleaseAssetsByReleaseIds', () => {
    it('returns selected assets in each release manual order', () => {
      const firstRelease = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'First Release' }),
      });
      const secondRelease = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Second Release' }),
      });
      const firstAsset = assetRepo.upsert(projectId, 'first.png', sampleAsset(projectId, {
        relativePath: 'first.png',
        filename: 'first.png',
        extension: 'png',
        mimeType: 'image/png',
      }));
      const secondAsset = assetRepo.upsert(projectId, 'second.png', sampleAsset(projectId, {
        relativePath: 'second.png',
        filename: 'second.png',
        extension: 'png',
        mimeType: 'image/png',
      }));
      const thirdAsset = assetRepo.upsert(projectId, 'third.png', sampleAsset(projectId, {
        relativePath: 'third.png',
        filename: 'third.png',
        extension: 'png',
        mimeType: 'image/png',
      }));

      releaseRepo.addReleaseAsset(firstRelease.id, secondAsset.id, 'attachment', 1);
      releaseRepo.addReleaseAsset(firstRelease.id, firstAsset.id, 'primary', 0);
      releaseRepo.addReleaseAsset(secondRelease.id, thirdAsset.id, 'preview', 0);

      const rows = releaseRepo.findReleaseAssetsByReleaseIds([secondRelease.id, firstRelease.id]);

      expect(rows.map((row) => [row.release_id, row.asset_id, row.sort_order])).toEqual([
        [firstRelease.id, firstAsset.id, 0],
        [firstRelease.id, secondAsset.id, 1],
        [secondRelease.id, thirdAsset.id, 0],
      ]);
      expect(rows[0]).toMatchObject({
        selected_asset_id: firstAsset.id,
        release_project_id: projectId,
        asset_project_id: projectId,
        relative_path: 'first.png',
      });
    });
  });

  describe('update', () => {
    it('updates a release', () => {
      const created = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Original' }) });
      const updated = releaseRepo.update(created.id, {
        title: 'Updated',
        description: 'New desc',
        notes: 'New notes',
        plannedDate: '2025-07-01',
        patreonUrl: null,
      });
      expect(updated.title).toBe('Updated');
      expect(updated.planned_date).toBe('2025-07-01');
      expect(updated).not.toHaveProperty('status');
    });

    it('returns undefined for non-existent id', () => {
      const updated = releaseRepo.update(99999, sampleRelease());
      expect(updated).toBeUndefined();
    });

    it('cannot update archived release', () => {
      const created = releaseRepo.create({ projectId, ...sampleRelease() });
      releaseRepo.archive(created.id);
      const updated = releaseRepo.update(created.id, { title: 'Should Not Update' });
      expect(updated).toBeUndefined();
    });
  });

  describe('archive', () => {
    it('sets archived_at on a release', () => {
      const created = releaseRepo.create({ projectId, ...sampleRelease() });
      const archived = releaseRepo.archive(created.id);
      expect(archived.archived_at).toBeTruthy();
      expect(archived.id).toBe(created.id);
    });

    it('returns undefined for non-existent id', () => {
      const archived = releaseRepo.archive(99999);
      expect(archived).toBeUndefined();
    });

    it('cannot archive already-archived release', () => {
      const created = releaseRepo.create({ projectId, ...sampleRelease() });
      releaseRepo.archive(created.id);
      const second = releaseRepo.archive(created.id);
      expect(second).toBeUndefined();
    });
  });

  describe('publish', () => {
    it('sets published_date without a release-owned status column', () => {
      const created = releaseRepo.create({ projectId, ...sampleRelease() });
      const published = releaseRepo.publish(created.id, '2025-06-15');
      expect(published.published_date).toBe('2025-06-15');
      expect(published).not.toHaveProperty('status');
    });

    it('returns undefined for non-existent id', () => {
      const published = releaseRepo.publish(99999, '2025-06-15');
      expect(published).toBeUndefined();
    });
  });

  describe('upcomingReleases', () => {
    it('returns releases with future planned_date sorted asc', () => {
      const today = new Date();
      const future1 = new Date(today);
      future1.setDate(future1.getDate() + 30);
      const future2 = new Date(today);
      future2.setDate(future2.getDate() + 60);
      const fmt = (d) => d.toISOString().split('T')[0];
      const todayIso = fmt(today);

      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Later', plannedDate: fmt(future2), status: 'planned' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Sooner', plannedDate: fmt(future1), status: 'planned' }) });
      const upcoming = releaseRepo.upcomingReleases(todayIso);
      expect(upcoming[0].title).toBe('Sooner');
      expect(upcoming[1].title).toBe('Later');
    });

    it('excludes releases without planned_date', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'No Date', plannedDate: null, status: 'planned' }) });
      const today = getLocalTodayIso();
      const upcoming = releaseRepo.upcomingReleases(today);
      expect(upcoming).toHaveLength(0);
    });

    it('excludes published releases', () => {
      const r1 = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Published', status: 'published', plannedDate: '2099-01-01' }) });
      releaseRepo.publish(r1.id, '2025-01-01');
      const today = getLocalTodayIso();
      const upcoming = releaseRepo.upcomingReleases(today);
      expect(upcoming).toHaveLength(0);
    });

    it('excludes archived releases', () => {
      const r1 = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Archived', plannedDate: '2099-01-01', status: 'planned' }) });
      releaseRepo.archive(r1.id);
      const today = getLocalTodayIso();
      const overdue = releaseRepo.overdueReleases(today);
      expect(overdue).toHaveLength(0);
    });
  });

  // ─── Release Asset Selection ────────────────────────────────────────────────

  describe('addReleaseAsset', () => {
    it('adds an asset selection to a release', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'With Asset' }) });
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      const sel = releaseRepo.addReleaseAsset(release.id, asset.id, 'primary', 1);
      expect(sel.release_id).toBe(release.id);
      expect(sel.asset_id).toBe(asset.id);
      expect(sel.role).toBe('primary');
      expect(sel.sort_order).toBe(1);
      expect(sel.created_at).toBeTruthy();
    });

    it('uses default role and sort_order', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'With Asset' }) });
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      const sel = releaseRepo.addReleaseAsset(release.id, asset.id, 'attachment', 0);
      expect(sel.role).toBe('attachment');
      expect(sel.sort_order).toBe(0);
    });

    it('rejects duplicate selection (same release + asset)', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease() });
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      releaseRepo.addReleaseAsset(release.id, asset.id, 'primary', 0);
      expect(() => {
        releaseRepo.addReleaseAsset(release.id, asset.id, 'preview', 1);
      }).toThrow();
    });
  });

  describe('listReleaseAssets', () => {
    it('returns selected assets for a release', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease() });
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt', filename: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt', filename: 'b.txt' }));

      releaseRepo.addReleaseAsset(release.id, asset1.id, 'primary', 0);
      releaseRepo.addReleaseAsset(release.id, asset2.id, 'attachment', 1);

      const selections = releaseRepo.listReleaseAssets(release.id);
      expect(selections).toHaveLength(2);
      expect(selections.map((s) => s.filename).sort()).toEqual(['a.txt', 'b.txt']);
    });

    it('returns empty array when no assets selected', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease() });
      const selections = releaseRepo.listReleaseAssets(release.id);
      expect(selections).toHaveLength(0);
    });

    it('includes release_assets metadata', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease() });
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      releaseRepo.addReleaseAsset(release.id, asset.id, 'preview', 5);

      const [sel] = releaseRepo.listReleaseAssets(release.id);
      expect(sel.release_id).toBe(release.id);
      expect(sel.asset_id).toBe(asset.id);
      expect(sel.role).toBe('preview');
      expect(sel.sort_order).toBe(5);
    });

    it('returns assets ordered by sort_order then asset_id', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease() });
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt', filename: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt', filename: 'b.txt' }));
      const asset3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt', filename: 'c.txt' }));

      // Add out of order
      releaseRepo.addReleaseAsset(release.id, asset3.id, 'attachment', 0);
      releaseRepo.addReleaseAsset(release.id, asset1.id, 'attachment', 2);
      releaseRepo.addReleaseAsset(release.id, asset2.id, 'attachment', 1);

      const selections = releaseRepo.listReleaseAssets(release.id);
      expect(selections[0].filename).toBe('c.txt');
      expect(selections[1].filename).toBe('b.txt');
      expect(selections[2].filename).toBe('a.txt');
    });

    // Phase 2 chunk 1: category_id/nested_path must survive this projection.
    it('includes category_id and nested_path for a categorized selected asset', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease() });
      const category = db.prepare(`
        INSERT INTO project_asset_categories (project_id, display_name, directory_slug)
        VALUES (?, 'Source', 'source')
        RETURNING id
      `).get(projectId);
      const asset = assetRepo.upsert(projectId, 'source/nested/file.kra', {
        ...sampleAsset(projectId, { relativePath: 'source/nested/file.kra', filename: 'file.kra' }),
        categoryId: category.id,
        nestedPath: 'nested',
      });
      releaseRepo.addReleaseAsset(release.id, asset.id, 'source', 0);

      const [sel] = releaseRepo.listReleaseAssets(release.id);
      expect(sel.category_id).toBe(category.id);
      expect(sel.nested_path).toBe('nested');
    });

    it('returns category_id = null and empty nested_path for an uncategorized selected asset', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease() });
      const asset = assetRepo.upsert(projectId, 'root.txt', sampleAsset(projectId, { relativePath: 'root.txt', filename: 'root.txt' }));
      releaseRepo.addReleaseAsset(release.id, asset.id, 'attachment', 0);

      const [sel] = releaseRepo.listReleaseAssets(release.id);
      expect(sel.category_id).toBeNull();
      expect(sel.nested_path).toBe('');
    });
  });

  describe('removeReleaseAsset', () => {
    it('removes a single asset selection', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease() });
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      releaseRepo.addReleaseAsset(release.id, asset.id, 'attachment', 0);
      const removed = releaseRepo.removeReleaseAsset(release.id, asset.id);
      expect(removed).toBe(true);
      expect(releaseRepo.listReleaseAssets(release.id)).toHaveLength(0);
    });

    it('returns false when selection does not exist', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease() });
      const removed = releaseRepo.removeReleaseAsset(release.id, 99999);
      expect(removed).toBe(false);
    });
  });

  describe('replaceReleaseAssets', () => {
    it('replaces all selections for a release transactionally', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease() });
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      const asset3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));

      // Start with two assets
      releaseRepo.addReleaseAsset(release.id, asset1.id, 'primary', 0);
      releaseRepo.addReleaseAsset(release.id, asset2.id, 'attachment', 1);

      // Replace with new set
      releaseRepo.replaceReleaseAssets(release.id, [
        { assetId: asset2.id, role: 'preview', sortOrder: 0 },
        { assetId: asset3.id, role: 'source', sortOrder: 1 },
      ]);

      const selections = releaseRepo.listReleaseAssets(release.id);
      expect(selections).toHaveLength(2);
      const assetIds = selections.map((s) => s.asset_id).sort();
      expect(assetIds).toEqual([asset2.id, asset3.id]);
      expect(selections.find((s) => s.asset_id === asset2.id).role).toBe('preview');
      expect(selections.find((s) => s.asset_id === asset3.id).role).toBe('source');
    });

    it('removes old selections and inserts new ones (explicit regression)', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease() });
      const oldAsset = assetRepo.upsert(projectId, 'old.txt', sampleAsset(projectId, { relativePath: 'old.txt', filename: 'old.txt' }));
      const newAsset1 = assetRepo.upsert(projectId, 'new1.txt', sampleAsset(projectId, { relativePath: 'new1.txt', filename: 'new1.txt' }));
      const newAsset2 = assetRepo.upsert(projectId, 'new2.txt', sampleAsset(projectId, { relativePath: 'new2.txt', filename: 'new2.txt' }));

      // Step 1: create release with initial selections
      releaseRepo.addReleaseAsset(release.id, oldAsset.id, 'primary', 0);

      // Verify initial state
      let selections = releaseRepo.listReleaseAssets(release.id);
      expect(selections).toHaveLength(1);
      expect(selections[0].asset_id).toBe(oldAsset.id);

      // Step 2: replace selections
      releaseRepo.replaceReleaseAssets(release.id, [
        { assetId: newAsset1.id, role: 'preview', sortOrder: 0 },
        { assetId: newAsset2.id, role: 'attachment', sortOrder: 1 },
      ]);

      // Step 3: verify old selections removed
      selections = releaseRepo.listReleaseAssets(release.id);
      const currentAssetIds = selections.map((s) => s.asset_id).sort();
      expect(currentAssetIds).not.toContain(oldAsset.id);
      expect(currentAssetIds).toEqual([newAsset1.id, newAsset2.id].sort());

      // Verify new selections inserted with correct roles
      expect(selections.find((s) => s.asset_id === newAsset1.id).role).toBe('preview');
      expect(selections.find((s) => s.asset_id === newAsset2.id).role).toBe('attachment');
    });

    it('removes all selections when given empty array', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease() });
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      releaseRepo.addReleaseAsset(release.id, asset.id, 'attachment', 0);
      releaseRepo.replaceReleaseAssets(release.id, []);

      expect(releaseRepo.listReleaseAssets(release.id)).toHaveLength(0);
    });

    it('is atomic (transaction rollback on error)', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease() });
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));

      releaseRepo.addReleaseAsset(release.id, asset1.id, 'primary', 0);

      // Invalid: same asset twice in same replace
      expect(() => {
        releaseRepo.replaceReleaseAssets(release.id, [
          { assetId: asset1.id, role: 'primary', sortOrder: 0 },
          { assetId: asset1.id, role: 'preview', sortOrder: 1 },
        ]);
      }).toThrow();

      // Original selection should be preserved (transaction not applied)
      const selections = releaseRepo.listReleaseAssets(release.id);
      expect(selections).toHaveLength(1);
      expect(selections[0].asset_id).toBe(asset1.id);
    });
  });

  describe('countReleaseAssets', () => {
    it('returns count of selected assets', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease() });
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));

      expect(releaseRepo.countReleaseAssets(release.id)).toBe(0);
      releaseRepo.addReleaseAsset(release.id, asset1.id, 'attachment', 0);
      expect(releaseRepo.countReleaseAssets(release.id)).toBe(1);
      releaseRepo.addReleaseAsset(release.id, asset2.id, 'attachment', 1);
      expect(releaseRepo.countReleaseAssets(release.id)).toBe(2);
    });
  });

  describe('findReleasesByAsset', () => {
    it('finds releases using a given asset', () => {
      const release1 = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R1' }) });
      const release2 = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R2' }) });
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      releaseRepo.addReleaseAsset(release1.id, asset.id, 'primary', 0);
      releaseRepo.addReleaseAsset(release2.id, asset.id, 'preview', 0);

      const releases = releaseRepo.findReleasesByAsset(asset.id);
      expect(releases).toHaveLength(2);
      const releaseIds = releases.map((r) => r.release_id).sort();
      expect(releaseIds).toEqual([release1.id, release2.id]);
    });

    it('returns empty array when asset is not used', () => {
      const asset = assetRepo.upsert(projectId, 'orphan.txt', sampleAsset(projectId, { relativePath: 'orphan.txt' }));
      const releases = releaseRepo.findReleasesByAsset(asset.id);
      expect(releases).toHaveLength(0);
    });
  });

  describe('overdueReleases', () => {
    it('returns releases past their planned_date', () => {
      const today = new Date();
      const past = new Date(today);
      past.setDate(past.getDate() - 10);
      const fmt = (d) => d.toISOString().split('T')[0];
      const todayIso = fmt(today);

      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Overdue', plannedDate: fmt(past), status: 'planned' }) });
      const overdue = releaseRepo.overdueReleases(todayIso);
      expect(overdue).toHaveLength(1);
      expect(overdue[0].title).toBe('Overdue');
    });

    it('excludes releases with future planned_date', () => {
      const today = new Date();
      const future = new Date(today);
      future.setDate(future.getDate() + 30);
      const fmt = (d) => d.toISOString().split('T')[0];
      const todayIso = fmt(today);

      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Future', plannedDate: fmt(future), status: 'planned' }) });
      const overdue = releaseRepo.overdueReleases(todayIso);
      expect(overdue).toHaveLength(0);
    });

    it('excludes releases without planned_date', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'No Date', plannedDate: null, status: 'planned' }) });
      const today = new Date().toISOString().split('T')[0];
      const overdue = releaseRepo.overdueReleases(today);
      expect(overdue).toHaveLength(0);
    });

    it('excludes published releases', () => {
      const today = new Date();
      const past = new Date(today);
      past.setDate(past.getDate() - 10);
      const fmt = (d) => d.toISOString().split('T')[0];
      const todayIso = fmt(today);
      const r1 = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Overdue Pub', plannedDate: fmt(past), status: 'planned' }) });
      releaseRepo.publish(r1.id, fmt(past));
      const overdue = releaseRepo.overdueReleases(todayIso);
      expect(overdue).toHaveLength(0);
    });
  });

  // ─── Phase 6B regression: dashboard queries hide releases under archived parents ──
  //
  // The dashboard queries (findOverdue, findUpcoming,
  // findActiveWithoutPlannedDate, findReleasesWithMissingSelectedAssets,
  // findReleasesWithoutSelectedAssets) used to surface active releases
  // whose parent project had been archived. They now filter by
  // projects.archived_at IS NULL so the dashboard only shows actionable
  // work. Historical release rows remain in the database — the project
  // workspace and per-project recent list still surface them.

  describe('dashboard queries — archived parent project filter', () => {
    function archiveProject(projectId) {
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(projectId);
    }

    it('findOverdue excludes releases whose parent project is archived', () => {
      const overdue = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Overdue In Archived', plannedDate: '2020-01-01', status: 'planned' }),
      });
      archiveProject(projectId);
      const today = new Date().toISOString().split('T')[0];
      expect(releaseRepo.findOverdue(10, today)).toEqual([]);
      // The release row is still in the database — only the dashboard query
      // filters it out.
      const fromDb = db.prepare(`SELECT archived_at FROM releases WHERE id = ?`).get(overdue.id);
      expect(fromDb.archived_at).toBeNull();
    });

    it('findUpcoming excludes releases whose parent project is archived', () => {
      const upcoming = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Upcoming In Archived', plannedDate: '2099-01-01', status: 'planned' }),
      });
      archiveProject(projectId);
      const today = new Date().toISOString().split('T')[0];
      expect(releaseRepo.findUpcoming(10, today)).toEqual([]);
      // Sanity: the release is still in the database.
      expect(db.prepare(`SELECT id FROM releases WHERE id = ?`).get(upcoming.id)).toBeTruthy();
    });

    it('findActiveWithoutPlannedDate excludes releases whose parent project is archived', () => {
      releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'No Date In Archived', plannedDate: null, status: 'in-progress' }),
      });
      archiveProject(projectId);
      expect(releaseRepo.findActiveWithoutPlannedDate(10)).toEqual([]);
    });

    it('findReleasesWithMissingSelectedAssets excludes releases whose parent project is archived', () => {
      const release = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Has Missing In Archived', plannedDate: '2099-01-01', status: 'planned' }),
      });
      const missing = assetRepo.upsert(projectId, 'gone.txt', {
        relativePath: 'gone.txt', filename: 'gone.txt', extension: 'txt',
        mimeType: 'text/plain', sizeBytes: 0, modifiedAt: null,
      });
      db.prepare(`UPDATE assets SET is_present = 0, missing_since = datetime('now') WHERE id = ?`).run(missing.id);
      releaseRepo.addReleaseAsset(release.id, missing.id, 'attachment', 0);
      archiveProject(projectId);
      expect(releaseRepo.findReleasesWithMissingSelectedAssets(10)).toEqual([]);
    });

    it('findReleasesWithoutSelectedAssets excludes releases whose parent project is archived', () => {
      releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'No Selection In Archived', plannedDate: '2099-01-01', status: 'planned' }),
      });
      archiveProject(projectId);
      expect(releaseRepo.findReleasesWithoutSelectedAssets(10)).toEqual([]);
    });

    it('still surfaces releases from non-archived projects alongside an archived sibling', () => {
      // Multi-project control case: only the archived project's releases
      // are hidden — releases from active projects still appear.
      const otherProject = projectRepo.create(sampleProject({ title: 'Other Project' }));
      const archivedRelease = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Hidden Overdue', plannedDate: '2020-01-01', status: 'planned' }),
      });
      const activeOverdue = releaseRepo.create({
        projectId: otherProject.id,
        ...sampleRelease({ title: 'Visible Overdue', plannedDate: '2020-01-01', status: 'planned' }),
      });
      archiveProject(projectId);
      const today = new Date().toISOString().split('T')[0];
      const overdue = releaseRepo.findOverdue(10, today);
      const ids = overdue.map((r) => r.id);
      expect(ids).not.toContain(archivedRelease.id);
      expect(ids).toContain(activeOverdue.id);
    });
  });

  // ─── Phase 6B regression: legacy upcomingReleases / overdueReleases ──
  //
  // The legacy release-repository methods (upcomingReleases, overdueReleases)
  // previously surfaced active releases belonging to archived projects. They
  // now mirror the dashboard queries' parent-project filter so callers that
  // use them directly (e.g. tests, ad-hoc reports) see the same set of
  // actionable releases. The injected `today` parameter is still the
  // single source of truth for the date boundary.

  describe('legacy upcomingReleases / overdueReleases — archived parent project filter', () => {
    function archiveProject(projectId) {
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(projectId);
    }

    it('upcomingReleases excludes releases whose parent project is archived', () => {
      const future = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Upcoming In Archived', plannedDate: '2099-01-01', status: 'planned' }),
      });
      archiveProject(projectId);
      expect(releaseRepo.upcomingReleases('2025-06-15').map((r) => r.id)).not.toContain(future.id);
      // Sanity: the release row is still in the database.
      expect(db.prepare(`SELECT id FROM releases WHERE id = ?`).get(future.id)).toBeTruthy();
    });

    it('overdueReleases excludes releases whose parent project is archived', () => {
      const past = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Overdue In Archived', plannedDate: '2020-01-01', status: 'planned' }),
      });
      archiveProject(projectId);
      expect(releaseRepo.overdueReleases('2025-06-15').map((r) => r.id)).not.toContain(past.id);
      // Sanity: the release row is still in the database.
      expect(db.prepare(`SELECT id FROM releases WHERE id = ?`).get(past.id)).toBeTruthy();
    });

    it('still surfaces releases from non-archived projects alongside an archived sibling', () => {
      const otherProject = projectRepo.create(sampleProject({ title: 'Other Project' }));
      const hiddenUpcoming = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Hidden Upcoming', plannedDate: '2099-01-01', status: 'planned' }),
      });
      const visibleUpcoming = releaseRepo.create({
        projectId: otherProject.id,
        ...sampleRelease({ title: 'Visible Upcoming', plannedDate: '2099-01-01', status: 'planned' }),
      });
      archiveProject(projectId);
      const upcomingIds = releaseRepo.upcomingReleases('2025-06-15').map((r) => r.id);
      expect(upcomingIds).not.toContain(hiddenUpcoming.id);
      expect(upcomingIds).toContain(visibleUpcoming.id);
    });
  });

  // ─── Phase 6B regression: repository methods accept an injected today ──
  //
  // The legacy upcomingReleases / overdueReleases methods previously called
  // `new Date().toISOString()` internally, so two consecutive calls could
  // disagree if the system clock crossed midnight, and the boundary was
  // always UTC. They now require an explicit `today` and must not
  // independently calculate it. The dashboard service injects a single
  // application-local value so every section stays consistent.

  describe('upcomingReleases / overdueReleases — injected today', () => {
    it('upcomingReleases classification changes when today is injected', () => {
      // A release planned for 2025-06-15 must be:
      //   - upcoming when today is 2025-06-14
      //   - NOT upcoming when today is 2025-06-16 (it is in the past)
      const release = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Future Release', plannedDate: '2025-06-15', status: 'planned' }),
      });
      expect(releaseRepo.upcomingReleases('2025-06-14').map((r) => r.id)).toContain(release.id);
      expect(releaseRepo.upcomingReleases('2025-06-16').map((r) => r.id)).not.toContain(release.id);
    });

    it('overdueReleases classification changes when today is injected', () => {
      // A release planned for 2025-06-15 must be:
      //   - overdue when today is 2025-06-16
      //   - NOT overdue when today is 2025-06-14 (it is in the future)
      const release = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Yesterday Release', plannedDate: '2025-06-15', status: 'planned' }),
      });
      expect(releaseRepo.overdueReleases('2025-06-16').map((r) => r.id)).toContain(release.id);
      expect(releaseRepo.overdueReleases('2025-06-14').map((r) => r.id)).not.toContain(release.id);
    });
  });

  // ─── Phase 6C: Release Planning Views — findPage ─────────────────────────

  describe('findPage', () => {
    it('returns paginated releases with project title and asset counts', () => {
      const release = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Paged Release', status: 'planned', plannedDate: '2025-06-15' }),
      });
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));
      releaseRepo.addReleaseAsset(release.id, asset.id, 'primary', 0);

      const rows = releaseRepo.findPage({ today: '2025-06-15' });
      expect(rows).toHaveLength(1);
      expect(rows[0].project_title).toBe('Parent Project');
      expect(rows[0].project_status).toBe('tbd');
      expect(rows[0]).not.toHaveProperty('status');
      expect(rows[0].selected_asset_count).toBe(1);
      expect(rows[0].missing_asset_count).toBe(0);
    });

    it('paginates with limit and offset in SQL', () => {
      for (let i = 0; i < 10; i++) {
        releaseRepo.create({ projectId, ...sampleRelease({ title: `R${i}`, status: 'tbd' }) });
      }
      const page1 = releaseRepo.findPage({ limit: 3, offset: 0, today: '2025-06-15' });
      const page2 = releaseRepo.findPage({ limit: 3, offset: 3, today: '2025-06-15' });
      const page4 = releaseRepo.findPage({ limit: 3, offset: 9, today: '2025-06-15' });

      expect(page1).toHaveLength(3);
      expect(page2).toHaveLength(3);
      expect(page4).toHaveLength(1);
    });

    it('filters by project', () => {
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Mine', status: 'tbd' }) });
      releaseRepo.create({ projectId: otherProject.id, ...sampleRelease({ title: 'Other', status: 'tbd' }) });

      const rows = releaseRepo.findPage({ projectId, today: '2025-06-15' });
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe('Mine');
    });

    it('removes release-status filtering without mapping it to project status', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Idea' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Planned' }) });

      const rows = releaseRepo.findPage({ status: 'planned', today: '2025-06-15' });
      expect(rows.map((row) => row.title)).toEqual(['Planned', 'Idea']);
      expect(rows.every((row) => row.project_status === 'tbd')).toBe(true);
      expect(rows.every((row) => !Object.hasOwn(row, 'status'))).toBe(true);
    });

    it('orders by sort column with stable tie-breaking', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'A', status: 'planned', plannedDate: '2025-06-01' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'B', status: 'planned', plannedDate: '2025-06-01' }) });

      const asc = releaseRepo.findPage({ sortBy: 'title', order: 'asc', today: '2025-06-15' });
      expect(asc[0].title).toBe('A');
      expect(asc[1].title).toBe('B');

      const desc = releaseRepo.findPage({ sortBy: 'title', order: 'desc', today: '2025-06-15' });
      expect(desc[0].title).toBe('B');
      expect(desc[1].title).toBe('A');
    });

    it('returns zero asset count for release with no assets', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'No Assets' }) });
      const rows = releaseRepo.findPage({ today: '2025-06-15' });
      const row = rows.find((r) => r.id === release.id);
      expect(row.selected_asset_count).toBe(0);
      expect(row.missing_asset_count).toBe(0);
    });

    it('returns correct counts when release has multiple assets', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Multi' }) });
      const a1 = assetRepo.upsert(projectId, 'a1.txt', sampleAsset(projectId, { relativePath: 'a1.txt' }));
      const a2 = assetRepo.upsert(projectId, 'a2.txt', sampleAsset(projectId, { relativePath: 'a2.txt' }));
      releaseRepo.addReleaseAsset(release.id, a1.id, 'primary', 0);
      releaseRepo.addReleaseAsset(release.id, a2.id, 'attachment', 1);

      const rows = releaseRepo.findPage({ today: '2025-06-15' });
      const row = rows.find((r) => r.id === release.id);
      expect(row.selected_asset_count).toBe(2);
    });

    it('returns correct missing_asset_count when assets are missing', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Missing' }) });
      const present = assetRepo.upsert(projectId, 'present.txt', sampleAsset(projectId, { relativePath: 'present.txt' }));
      const missing = assetRepo.upsert(projectId, 'gone.txt', sampleAsset(projectId, { relativePath: 'gone.txt' }));
      releaseRepo.addReleaseAsset(release.id, present.id, 'primary', 0);
      releaseRepo.addReleaseAsset(release.id, missing.id, 'attachment', 1);
      db.prepare(`UPDATE assets SET is_present = 0, missing_since = datetime('now') WHERE id = ?`).run(missing.id);

      const rows = releaseRepo.findPage({ today: '2025-06-15' });
      const row = rows.find((r) => r.id === release.id);
      expect(row.selected_asset_count).toBe(2);
      expect(row.missing_asset_count).toBe(1);
    });

    it('excludes archived releases by default', () => {
      const r1 = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Active' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Archived' }) });
      releaseRepo.archive(r1.id);

      const rows = releaseRepo.findPage({ today: '2025-06-15' });
      expect(rows.map((r) => r.title)).toEqual(['Archived']);
    });

    it('includes archived releases when includeArchived is true', () => {
      const r1 = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Active' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Archived' }) });
      releaseRepo.archive(r1.id);

      const rows = releaseRepo.findPage({ includeArchived: true, today: '2025-06-15' });
      expect(rows.map((r) => r.title).sort()).toEqual(['Active', 'Archived']);
    });
  });

  // ─── Phase 6C: Release Planning Views — countFiltered ────────────────────

  describe('countFiltered', () => {
    it('returns total count and ignores obsolete release-status filters', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'R1' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'R2' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'R3' }) });

      expect(releaseRepo.countFiltered({ today: '2025-06-15' })).toBe(3);
      expect(releaseRepo.countFiltered({ status: 'tbd', today: '2025-06-15' })).toBe(3);
      expect(releaseRepo.countFiltered({ status: 'planned', today: '2025-06-15' })).toBe(3);
    });

    it('counts only matching project', () => {
      const other = projectRepo.create(sampleProject({ title: 'Other' }));
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Mine' }) });
      releaseRepo.create({ projectId: other.id, ...sampleRelease({ title: 'Other' }) });

      expect(releaseRepo.countFiltered({ projectId, today: '2025-06-15' })).toBe(1);
    });

    it('returns zero for an empty result set', () => {
      expect(releaseRepo.countFiltered({ search: 'does-not-exist', today: '2025-06-15' })).toBe(0);
    });
  });

  // ─── Phase 6C: Release Planning Views — schedule filters ───────────────────

  describe('findPage — schedule filters', () => {
    const FIXED_TODAY = '2025-06-15';

    it('overdue: planned_date < today', () => {
      const overdue = releaseRepo.create({
        projectId, ...sampleRelease({ title: 'Overdue', status: 'planned', plannedDate: '2025-06-01' }),
      });
      releaseRepo.create({
        projectId, ...sampleRelease({ title: 'Today', status: 'planned', plannedDate: '2025-06-15' }),
      });
      releaseRepo.create({
        projectId, ...sampleRelease({ title: 'Future', status: 'planned', plannedDate: '2025-06-20' }),
      });

      const rows = releaseRepo.findPage({ schedule: 'overdue', today: FIXED_TODAY });
      expect(rows.map((r) => r.title)).toEqual(['Overdue']);
    });

    it('today: planned_date = today', () => {
      releaseRepo.create({
        projectId, ...sampleRelease({ title: 'Yesterday', status: 'planned', plannedDate: '2025-06-14' }),
      });
      const today = releaseRepo.create({
        projectId, ...sampleRelease({ title: 'Today', status: 'planned', plannedDate: '2025-06-15' }),
      });
      releaseRepo.create({
        projectId, ...sampleRelease({ title: 'Tomorrow', status: 'planned', plannedDate: '2025-06-16' }),
      });

      const rows = releaseRepo.findPage({ schedule: 'today', today: FIXED_TODAY });
      expect(rows.map((r) => r.title)).toEqual(['Today']);
    });

    it('upcoming: planned_date > today', () => {
      releaseRepo.create({
        projectId, ...sampleRelease({ title: 'Yesterday', status: 'planned', plannedDate: '2025-06-14' }),
      });
      releaseRepo.create({
        projectId, ...sampleRelease({ title: 'Today', status: 'planned', plannedDate: '2025-06-15' }),
      });
      const upcoming = releaseRepo.create({
        projectId, ...sampleRelease({ title: 'Tomorrow', status: 'planned', plannedDate: '2025-06-20' }),
      });

      const rows = releaseRepo.findPage({ schedule: 'upcoming', today: FIXED_TODAY });
      expect(rows.map((r) => r.title)).toEqual(['Tomorrow']);
    });

    it('unscheduled: planned_date IS NULL', () => {
      releaseRepo.create({
        projectId, ...sampleRelease({ title: 'No Date', status: 'in-progress', plannedDate: null }),
      });
      releaseRepo.create({
        projectId, ...sampleRelease({ title: 'Has Date', status: 'planned', plannedDate: '2025-06-15' }),
      });

      const rows = releaseRepo.findPage({ schedule: 'unscheduled', today: FIXED_TODAY });
      expect(rows.map((r) => r.title)).toEqual(['No Date']);
    });

    it('schedule filters exclude archived parent releases', () => {
      const overdue = releaseRepo.create({
        projectId, ...sampleRelease({ title: 'Overdue In Archived', status: 'planned', plannedDate: '2025-06-01' }),
      });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(projectId);

      const rows = releaseRepo.findPage({ schedule: 'overdue', today: FIXED_TODAY });
      expect(rows.map((r) => r.id)).not.toContain(overdue.id);
      // Sanity: release row is still in DB
      expect(db.prepare(`SELECT id FROM releases WHERE id = ?`).get(overdue.id)).toBeTruthy();
    });
  });

  // ─── Phase 6C: Release Planning Views — findBoard ─────────────────────────

  describe('findBoard', () => {
    it('returns releases ordered by planned_date asc', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Later', status: 'tbd', plannedDate: '2025-07-01' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Earlier', status: 'tbd', plannedDate: '2025-06-01' }) });

      const rows = releaseRepo.findBoard({ today: '2025-06-15' });
      expect(rows[0].title).toBe('Earlier');
      expect(rows[1].title).toBe('Later');
      expect(rows.every((row) => row.project_status === 'tbd')).toBe(true);
      expect(rows.every((row) => !Object.hasOwn(row, 'status'))).toBe(true);
    });

    it('releases with NULL planned_date sort last', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Has Date', status: 'tbd', plannedDate: '2025-06-01' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'No Date', status: 'tbd', plannedDate: null }) });

      const rows = releaseRepo.findBoard({ today: '2025-06-15' });
      expect(rows[0].title).toBe('Has Date');
      expect(rows[rows.length - 1].title).toBe('No Date');
    });

    it('excludes archived parent releases from board by default', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Hidden', status: 'planned', plannedDate: '2025-06-20' }) });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(projectId);

      const rows = releaseRepo.findBoard({ today: '2025-06-15' });
      expect(rows.map((r) => r.title)).toEqual([]);
    });

    it('id DESC is the deterministic tie-breaker when status, planned_date, and updated_at all match', () => {
      // Three releases sharing the same status, the same planned_date, and
      // the same updated_at — the only meaningful difference is the row id.
      // The board view must produce a deterministic order across runs by
      // appending releases.id DESC as the final tie-breaker.
      const r1 = releaseRepo.create({ projectId, ...sampleRelease({ title: 'First Created', status: 'planned', plannedDate: '2025-06-15' }) });
      const r2 = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Second Created', status: 'planned', plannedDate: '2025-06-15' }) });
      const r3 = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Third Created', status: 'planned', plannedDate: '2025-06-15' }) });

      // Force identical updated_at via direct SQL update.
      db.prepare(`UPDATE releases SET updated_at = '2025-06-01 00:00:00' WHERE id IN (?, ?, ?)`).run(r1.id, r2.id, r3.id);

      const rows = releaseRepo.findBoard({ today: '2025-06-15' });
      // With id DESC tie-breaker: r3 (highest id) first, then r2, then r1.
      expect(rows.map((r) => r.id)).toEqual([r3.id, r2.id, r1.id]);
    });
  });

  // ─── Phase 6D: Asset Browser Queries ─────────────────────────────────

  describe('findReleaseUsageForAssetIds', () => {
    /**
     * Helper: insert an asset directly.
     */
    function insertAsset({ projectId, relativePath, filename, isPresent = 1 }) {
      return db.prepare(`
        INSERT INTO assets (project_id, relative_path, filename, extension,
                            mime_type, size_bytes, modified_at,
                            is_present, last_seen_at, missing_since)
        VALUES (?, ?, ?, 'txt', 'text/plain', 0, NULL, ?, datetime('now'),
                ${isPresent === 0 ? "datetime('now')" : 'NULL'})
        RETURNING *
      `).get(projectId, relativePath, filename, isPresent);
    }

    /**
     * Helper: link an asset to a release.
     */
    function linkAssetToRelease({ releaseId, assetId, role = 'attachment', sortOrder = 0 }) {
      db.prepare(`
        INSERT INTO release_assets (release_id, asset_id, role, sort_order)
        VALUES (?, ?, ?, ?)
      `).run(releaseId, assetId, role, sortOrder);
    }

    it('returns empty array for empty input', () => {
      const results = releaseRepo.findReleaseUsageForAssetIds(projectId, []);
      expect(results).toEqual([]);
    });

    it('returns empty array when given IDs that have no release references', () => {
      const a = insertAsset({ projectId, relativePath: 'a.txt', filename: 'a.txt' });
      const results = releaseRepo.findReleaseUsageForAssetIds(projectId, [a.id]);
      expect(results).toEqual([]);
    });

    it('returns release usage details for a single asset', () => {
      const a = insertAsset({ projectId, relativePath: 'a.txt', filename: 'a.txt' });
      const rel = releaseRepo.create({ projectId, title: 'Release One', status: 'tbd', description: '', notes: '' });
      linkAssetToRelease({ releaseId: rel.id, assetId: a.id });

      const results = releaseRepo.findReleaseUsageForAssetIds(projectId, [a.id]);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        asset_id: a.id,
        release_id: rel.id,
        title: 'Release One',
        published_date: null,
        project_status: 'tbd',
        release_archived_at: null,
        project_archived_at: null,
      });
    });

    it('returns multiple release references for a single asset', () => {
      const a = insertAsset({ projectId, relativePath: 'a.txt', filename: 'a.txt' });
      const r1 = releaseRepo.create({ projectId, title: 'R1', status: 'tbd', description: '', notes: '' });
      const r2 = releaseRepo.create({ projectId, title: 'R2', status: 'planned', description: '', notes: '' });
      const r3 = releaseRepo.create({ projectId, title: 'R3', status: 'published', description: '', notes: '' });
      linkAssetToRelease({ releaseId: r1.id, assetId: a.id });
      linkAssetToRelease({ releaseId: r2.id, assetId: a.id });
      linkAssetToRelease({ releaseId: r3.id, assetId: a.id });

      const results = releaseRepo.findReleaseUsageForAssetIds(projectId, [a.id]);
      expect(results).toHaveLength(3);
      expect(results.map((r) => r.release_id).sort()).toEqual([r1.id, r2.id, r3.id].sort());
    });

    it('returns usage across multiple assets in one call', () => {
      const a1 = insertAsset({ projectId, relativePath: 'a1.txt', filename: 'a1.txt' });
      const a2 = insertAsset({ projectId, relativePath: 'a2.txt', filename: 'a2.txt' });
      const a3 = insertAsset({ projectId, relativePath: 'a3.txt', filename: 'a3.txt' });
      const r1 = releaseRepo.create({ projectId, title: 'R1', status: 'tbd', description: '', notes: '' });
      const r2 = releaseRepo.create({ projectId, title: 'R2', status: 'planned', description: '', notes: '' });
      linkAssetToRelease({ releaseId: r1.id, assetId: a1.id });
      linkAssetToRelease({ releaseId: r1.id, assetId: a2.id });
      linkAssetToRelease({ releaseId: r2.id, assetId: a2.id });
      linkAssetToRelease({ releaseId: r2.id, assetId: a3.id });

      const results = releaseRepo.findReleaseUsageForAssetIds(projectId, [a1.id, a2.id, a3.id]);
      expect(results).toHaveLength(4);

      // Index by asset_id for focused assertions
      const byAsset = {};
      for (const row of results) {
        if (!byAsset[row.asset_id]) byAsset[row.asset_id] = [];
        byAsset[row.asset_id].push(row);
      }
      expect(byAsset[a1.id]).toHaveLength(1);
      expect(byAsset[a1.id][0].release_id).toBe(r1.id);
      expect(byAsset[a2.id]).toHaveLength(2);
      expect(byAsset[a3.id]).toHaveLength(1);
      expect(byAsset[a3.id][0].release_id).toBe(r2.id);
    });

    it('includes release_archived_at and project_archived_at', () => {
      const a = insertAsset({ projectId, relativePath: 'a.txt', filename: 'a.txt' });
      // Use direct SQL to set archived_at since create() doesn't support it
      const archivedRelId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url, archived_at)
        VALUES (?, 'Archived Release', '', '', NULL, NULL, NULL, '2024-01-01 00:00:00')
        RETURNING id
      `).get(projectId).id;

      linkAssetToRelease({ releaseId: archivedRelId, assetId: a.id });

      // Archive the parent project
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(projectId);

      const results = releaseRepo.findReleaseUsageForAssetIds(projectId, [a.id]);
      expect(results).toHaveLength(1);
      expect(results[0].release_archived_at).toBeTruthy();
      expect(results[0].project_archived_at).toBeTruthy();
    });

    it('orders results by asset_id, release title, then release id', () => {
      const a1 = insertAsset({ projectId, relativePath: 'a1.txt', filename: 'a1.txt' });
      const a2 = insertAsset({ projectId, relativePath: 'a2.txt', filename: 'a2.txt' });
      const r1 = releaseRepo.create({ projectId, title: 'Alpha', status: 'tbd', description: '', notes: '' });
      const r2 = releaseRepo.create({ projectId, title: 'Beta', status: 'tbd', description: '', notes: '' });
      linkAssetToRelease({ releaseId: r1.id, assetId: a1.id });
      linkAssetToRelease({ releaseId: r1.id, assetId: a2.id });
      linkAssetToRelease({ releaseId: r2.id, assetId: a2.id });

      const results = releaseRepo.findReleaseUsageForAssetIds(projectId, [a1.id, a2.id]);
      // First row: a1's only release (r1)
      // Then a2's releases ordered by title then id (r1 before r2 alphabetically)
      expect(results[0]).toMatchObject({ asset_id: a1.id, release_id: r1.id });
      expect(results[1]).toMatchObject({ asset_id: a2.id, release_id: r1.id });
      expect(results[2]).toMatchObject({ asset_id: a2.id, release_id: r2.id });
    });

    it('safe with duplicate IDs in input', () => {
      const a = insertAsset({ projectId, relativePath: 'a.txt', filename: 'a.txt' });
      const rel = releaseRepo.create({ projectId, title: 'R', status: 'tbd', description: '', notes: '' });
      linkAssetToRelease({ releaseId: rel.id, assetId: a.id });

      // SQLite IN clause with duplicate placeholders returns each matching row once,
      // but the query is written to use assetIds directly without deduplication.
      // The safe behavior is that duplicates in input produce the same result as
      // singletons (each asset's usages appear once).
      const results = releaseRepo.findReleaseUsageForAssetIds(projectId, [a.id, a.id, a.id]);
      expect(results).toHaveLength(1);
    });

    it('historical and archived releases remain visible', () => {
      const a = insertAsset({ projectId, relativePath: 'a.txt', filename: 'a.txt' });
      const publishedId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'Published Release', '', '', NULL, '2020-01-01', NULL)
        RETURNING id
      `).get(projectId).id;
      const unpublishedId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url)
        VALUES (?, 'Unpublished Release', '', '', NULL, NULL, NULL)
        RETURNING id
      `).get(projectId).id;
      const archivedId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url, archived_at)
        VALUES (?, 'Archived Release', '', '', NULL, NULL, NULL, '2024-01-01')
        RETURNING id
      `).get(projectId).id;
      linkAssetToRelease({ releaseId: publishedId, assetId: a.id });
      linkAssetToRelease({ releaseId: unpublishedId, assetId: a.id });
      linkAssetToRelease({ releaseId: archivedId, assetId: a.id });

      const results = releaseRepo.findReleaseUsageForAssetIds(projectId, [a.id]);
      expect(results).toHaveLength(3);
      expect(results.find((r) => r.release_id === publishedId).published_date).toBe('2020-01-01');
      expect(results.find((r) => r.release_id === unpublishedId).published_date).toBeNull();
      expect(results.find((r) => r.release_id === archivedId).release_archived_at).toBeTruthy();
      expect(results.every((r) => r.project_status === 'tbd')).toBe(true);
    });

    // ─── Phase 6D: Project-scoped release usage ──────────────────────

    it('excludes cross-project junction rows (corrupt data)', () => {
      const otherProject = projectRepo.create(sampleProject({ title: 'Other Project' }));
      const a = insertAsset({ projectId, relativePath: 'a.txt', filename: 'a.txt' });
      const rel = releaseRepo.create({ projectId, title: 'Same Project Release', status: 'tbd', description: '', notes: '' });
      linkAssetToRelease({ releaseId: rel.id, assetId: a.id });

      // Create a corrupt cross-project junction: asset from projectId linked
      // to a release from otherProject.
      const otherAsset = insertAsset({ projectId: otherProject.id, relativePath: 'other.txt', filename: 'other.txt' });
      const otherRel = releaseRepo.create({ projectId: otherProject.id, title: 'Other Release', status: 'tbd', description: '', notes: '' });
      // Corrupt junction: otherProject's asset linked to projectId's release
      db.prepare(`
        INSERT INTO release_assets (release_id, asset_id, role, sort_order)
        VALUES (?, ?, 'attachment', 0)
      `).run(rel.id, otherAsset.id);
      // Corrupt junction: projectId's asset linked to otherProject's release
      db.prepare(`
        INSERT INTO release_assets (release_id, asset_id, role, sort_order)
        VALUES (?, ?, 'attachment', 0)
      `).run(otherRel.id, a.id);

      // Query scoped to projectId — should only see the legitimate link
      const results = releaseRepo.findReleaseUsageForAssetIds(projectId, [a.id, otherAsset.id]);
      expect(results).toHaveLength(1);
      expect(results[0].release_id).toBe(rel.id);
      expect(results[0].title).toBe('Same Project Release');
    });

    it('project isolation holds with overlapping asset/release IDs', () => {
      const otherProject = projectRepo.create(sampleProject({ title: 'Other Project' }));
      // Create same-named asset in both projects
      const a1 = insertAsset({ projectId, relativePath: 'shared.txt', filename: 'shared.txt' });
      const a2 = insertAsset({ projectId: otherProject.id, relativePath: 'shared.txt', filename: 'shared.txt' });
      // Create releases with same title in both projects
      const r1 = releaseRepo.create({ projectId, title: 'Shared Title', status: 'tbd', description: '', notes: '' });
      const r2 = releaseRepo.create({ projectId: otherProject.id, title: 'Shared Title', status: 'tbd', description: '', notes: '' });
      linkAssetToRelease({ releaseId: r1.id, assetId: a1.id });
      linkAssetToRelease({ releaseId: r2.id, assetId: a2.id });

      // Query scoped to projectId — should only see projectId's link
      const results = releaseRepo.findReleaseUsageForAssetIds(projectId, [a1.id, a2.id]);
      expect(results).toHaveLength(1);
      expect(results[0].asset_id).toBe(a1.id);
      expect(results[0].release_id).toBe(r1.id);
    });
  });

  describe('findReleaseTitlesForAssetIds', () => {
    function insertAsset(projectId, relativePath) {
      return assetRepo.upsert(projectId, relativePath, sampleAsset(projectId, {
        relativePath,
        filename: relativePath,
      }));
    }

    function linkAssetToRelease(releaseId, assetId) {
      db.prepare(`
        INSERT INTO release_assets (release_id, asset_id, role, sort_order)
        VALUES (?, ?, 'attachment', 0)
      `).run(releaseId, assetId);
    }

    it('returns an empty array for an asset with no release usage', () => {
      const asset = insertAsset(projectId, 'unused.txt');

      expect(releaseRepo.findReleaseTitlesForAssetIds([asset.id])).toEqual([]);
    });

    it('returns the release ID and title for a single release', () => {
      const asset = insertAsset(projectId, 'single.txt');
      const release = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Single Release' }),
      });
      linkAssetToRelease(release.id, asset.id);

      expect(releaseRepo.findReleaseTitlesForAssetIds([asset.id])).toEqual([
        { asset_id: asset.id, release_id: release.id, title: 'Single Release' },
      ]);
    });

    it('returns multiple releases ordered by case-insensitive title and release ID', () => {
      const asset = insertAsset(projectId, 'multiple.txt');
      const zeta = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'zeta Release' }),
      });
      const alpha = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Alpha Release' }),
      });
      const alphaLowercase = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'alpha Release' }),
      });
      linkAssetToRelease(zeta.id, asset.id);
      linkAssetToRelease(alpha.id, asset.id);
      linkAssetToRelease(alphaLowercase.id, asset.id);

      expect(releaseRepo.findReleaseTitlesForAssetIds([asset.id])).toEqual([
        { asset_id: asset.id, release_id: alpha.id, title: 'Alpha Release' },
        { asset_id: asset.id, release_id: alphaLowercase.id, title: 'alpha Release' },
        { asset_id: asset.id, release_id: zeta.id, title: 'zeta Release' },
      ]);
    });

    it('batches assets from multiple projects without cross-assignment', () => {
      const otherProject = projectRepo.create(sampleProject({ title: 'Other Project' }));
      const asset = insertAsset(projectId, 'owned.txt');
      const otherAsset = insertAsset(otherProject.id, 'other.txt');
      const release = releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Owned Release' }),
      });
      const otherRelease = releaseRepo.create({
        projectId: otherProject.id,
        ...sampleRelease({ title: 'Other Release' }),
      });
      linkAssetToRelease(release.id, asset.id);
      linkAssetToRelease(otherRelease.id, otherAsset.id);

      // Corrupt associations must not cross the project boundary.
      linkAssetToRelease(release.id, otherAsset.id);
      linkAssetToRelease(otherRelease.id, asset.id);

      const results = releaseRepo.findReleaseTitlesForAssetIds([asset.id, otherAsset.id]);

      expect(results).toEqual([
        { asset_id: asset.id, release_id: release.id, title: 'Owned Release' },
        { asset_id: otherAsset.id, release_id: otherRelease.id, title: 'Other Release' },
      ]);
    });
  });

  // ─── Phase 9-1: Release Asset Candidate Discovery ──────────────────────

  describe('findReleaseCandidatePage', () => {
    function insertAsset({ projectId, relativePath, filename, extension = 'txt', isPresent = 1 }) {
      return db.prepare(`
        INSERT INTO assets (project_id, relative_path, filename, extension,
                            mime_type, size_bytes, modified_at,
                            is_present, last_seen_at, missing_since)
        VALUES (?, ?, ?, ?, 'text/plain', 100, NULL, ?, datetime('now'),
                ${isPresent === 0 ? "datetime('now')" : 'NULL'})
        RETURNING id
      `).get(projectId, relativePath, filename, extension, isPresent);
    }

    function linkAssetToRelease({ releaseId, assetId, role = 'attachment', sortOrder = 0 }) {
      db.prepare(`
        INSERT INTO release_assets (release_id, asset_id, role, sort_order)
        VALUES (?, ?, ?, ?)
      `).run(releaseId, assetId, role, sortOrder);
    }

    it('returns only same-project candidates', () => {
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const ourAsset = insertAsset({ projectId, relativePath: 'ours.txt', filename: 'ours.txt' });
      insertAsset({ projectId: otherProject.id, relativePath: 'theirs.txt', filename: 'theirs.txt' });

      const candidates = releaseRepo.findReleaseCandidatePage(release.id, projectId);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].id).toBe(ourAsset.id);
    });

    it('excludes selected assets', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const selected = insertAsset({ projectId, relativePath: 'selected.txt', filename: 'selected.txt' });
      const available = insertAsset({ projectId, relativePath: 'available.txt', filename: 'available.txt' });
      linkAssetToRelease({ releaseId: release.id, assetId: selected.id });

      const candidates = releaseRepo.findReleaseCandidatePage(release.id, projectId);
      expect(candidates.map((c) => c.id)).not.toContain(selected.id);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].id).toBe(available.id);
    });

    it('excludes missing unselected assets', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const present = insertAsset({ projectId, relativePath: 'present.txt', filename: 'present.txt' });
      insertAsset({ projectId, relativePath: 'missing.txt', filename: 'missing.txt', isPresent: 0 });

      const candidates = releaseRepo.findReleaseCandidatePage(release.id, projectId);
      expect(candidates).toHaveLength(1);
      expect(candidates[0].id).toBe(present.id);
    });

    it('missing selected assets remain in selected result but not in candidates', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const missingSelected = insertAsset({ projectId, relativePath: 'gone.txt', filename: 'gone.txt', isPresent: 0 });
      linkAssetToRelease({ releaseId: release.id, assetId: missingSelected.id });
      const present = insertAsset({ projectId, relativePath: 'present.txt', filename: 'present.txt' });

      // Selected assets still include the missing one
      const selected = releaseRepo.listReleaseAssets(release.id);
      expect(selected.map((s) => s.asset_id)).toContain(missingSelected.id);

      // Candidates exclude the missing selected asset
      const candidates = releaseRepo.findReleaseCandidatePage(release.id, projectId);
      expect(candidates.map((c) => c.id)).not.toContain(missingSelected.id);
      expect(candidates.map((c) => c.id)).toContain(present.id);
    });

    it('filters by filename search', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      insertAsset({ projectId, relativePath: 'alpha.txt', filename: 'alpha.txt' });
      insertAsset({ projectId, relativePath: 'beta.txt', filename: 'beta.txt' });
      insertAsset({ projectId, relativePath: 'alphabet.txt', filename: 'alphabet.txt' });

      const candidates = releaseRepo.findReleaseCandidatePage(release.id, projectId, { search: 'alpha' });
      expect(candidates).toHaveLength(2);
      expect(candidates.map((c) => c.filename).sort()).toEqual(['alpha.txt', 'alphabet.txt']);
    });

    it('filters by exact extension', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      insertAsset({ projectId, relativePath: 'a.txt', filename: 'a.txt', extension: 'txt' });
      insertAsset({ projectId, relativePath: 'b.png', filename: 'b.png', extension: 'png' });
      insertAsset({ projectId, relativePath: 'c.txt', filename: 'c.txt', extension: 'txt' });

      const candidates = releaseRepo.findReleaseCandidatePage(release.id, projectId, { extension: 'png' });
      expect(candidates).toHaveLength(1);
      expect(candidates[0].filename).toBe('b.png');
    });

    it('filters candidates by category and keeps the count in sync', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const category = db.prepare(`
        INSERT INTO project_asset_categories (project_id, display_name, directory_slug)
        VALUES (?, 'Source', 'source')
        RETURNING id
      `).get(projectId);
      const selectedCategoryAsset = insertAsset({
        projectId,
        relativePath: 'source/selected.txt',
        filename: 'selected.txt',
      });
      const availableCategoryAsset = insertAsset({
        projectId,
        relativePath: 'source/available.txt',
        filename: 'available.txt',
      });
      const otherCategoryAsset = insertAsset({
        projectId,
        relativePath: 'other/available.txt',
        filename: 'available.txt',
      });
      db.prepare('UPDATE assets SET category_id = ? WHERE id IN (?, ?)')
        .run(category.id, selectedCategoryAsset.id, availableCategoryAsset.id);
      linkAssetToRelease({ releaseId: release.id, assetId: selectedCategoryAsset.id });

      const filters = { categoryId: category.id };
      const candidates = releaseRepo.findReleaseCandidatePage(release.id, projectId, filters);

      expect(candidates.map((asset) => asset.id)).toEqual([availableCategoryAsset.id]);
      expect(candidates.map((asset) => asset.id)).not.toContain(otherCategoryAsset.id);
      expect(releaseRepo.countReleaseCandidates(release.id, projectId, filters)).toBe(1);
      expect(releaseRepo.getReleaseCandidateExtensions(release.id, projectId, filters)).toEqual(['txt']);
    });

    it('combines search and extension filters', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      insertAsset({ projectId, relativePath: 'data.txt', filename: 'data.txt', extension: 'txt' });
      insertAsset({ projectId, relativePath: 'data.png', filename: 'data.png', extension: 'png' });
      insertAsset({ projectId, relativePath: 'other.txt', filename: 'other.txt', extension: 'txt' });

      const candidates = releaseRepo.findReleaseCandidatePage(release.id, projectId, { search: 'data', extension: 'txt' });
      expect(candidates).toHaveLength(1);
      expect(candidates[0].filename).toBe('data.txt');
    });

    it('orders by filename case-insensitive, then extension, then asset ID', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      // Insert in non-deterministic order
      const a1 = insertAsset({ projectId, relativePath: 'ALPHA.txt', filename: 'ALPHA.txt', extension: 'txt' });
      const a2 = insertAsset({ projectId, relativePath: 'alpha.png', filename: 'alpha.png', extension: 'png' });
      const a3 = insertAsset({ projectId, relativePath: 'alpha.txt', filename: 'alpha.txt', extension: 'txt' });
      const a4 = insertAsset({ projectId, relativePath: 'beta.txt', filename: 'beta.txt', extension: 'txt' });

      const candidates = releaseRepo.findReleaseCandidatePage(release.id, projectId);
      // Expected: alpha.png (filename=alpha, ext=png), ALPHA.txt (filename=alpha, ext=txt, lower id),
      // alpha.txt (filename=alpha, ext=txt, higher id), beta.txt
      expect(candidates[0].filename).toBe('alpha.png');
      expect(candidates[1].filename).toBe('ALPHA.txt');
      expect(candidates[2].filename).toBe('alpha.txt');
      expect(candidates[3].filename).toBe('beta.txt');
      // ID tie-break: ALPHA.txt before alpha.txt
      expect(candidates[1].id).toBeLessThan(candidates[2].id);
    });

    it('respects page size with a maximum of 100', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      for (let i = 0; i < 10; i++) {
        insertAsset({ projectId, relativePath: `file${i}.txt`, filename: `file${i}.txt` });
      }

      const page = releaseRepo.findReleaseCandidatePage(release.id, projectId, { page: 1, pageSize: 3 });
      expect(page).toHaveLength(3);
    });

    it('returns empty array for empty result', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const candidates = releaseRepo.findReleaseCandidatePage(release.id, projectId);
      expect(candidates).toEqual([]);
    });

    it('returns empty array for page beyond final page', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      insertAsset({ projectId, relativePath: 'only.txt', filename: 'only.txt' });

      const candidates = releaseRepo.findReleaseCandidatePage(release.id, projectId, { page: 5, pageSize: 10 });
      expect(candidates).toEqual([]);
    });

    it('corrupt cross-project junction rows do not hide valid candidates', () => {
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const ourAsset = insertAsset({ projectId, relativePath: 'ours.txt', filename: 'ours.txt' });
      const otherAsset = insertAsset({ projectId: otherProject.id, relativePath: 'theirs.txt', filename: 'theirs.txt' });

      // Corrupt junction: other project's asset linked to our release
      db.prepare(`
        INSERT INTO release_assets (release_id, asset_id, role, sort_order)
        VALUES (?, ?, 'attachment', 0)
      `).run(release.id, otherAsset.id);

      // Our asset must still appear as a candidate (it is not selected)
      const candidates = releaseRepo.findReleaseCandidatePage(release.id, projectId);
      expect(candidates.map((c) => c.id)).toContain(ourAsset.id);
      // The corrupt cross-project asset must not appear (different project)
      expect(candidates.map((c) => c.id)).not.toContain(otherAsset.id);
    });

    // Phase 2 chunk 1: category_id/nested_path must survive this projection.
    it('includes category_id and nested_path for a categorized candidate', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const category = db.prepare(`
        INSERT INTO project_asset_categories (project_id, display_name, directory_slug)
        VALUES (?, 'Source', 'source')
        RETURNING id
      `).get(projectId);
      const asset = assetRepo.upsert(projectId, 'source/nested/file.txt', {
        ...sampleAsset(projectId, { relativePath: 'source/nested/file.txt', filename: 'file.txt' }),
        categoryId: category.id,
        nestedPath: 'nested',
      });

      const [candidate] = releaseRepo.findReleaseCandidatePage(release.id, projectId);
      expect(candidate.id).toBe(asset.id);
      expect(candidate.category_id).toBe(category.id);
      expect(candidate.nested_path).toBe('nested');
    });

    it('returns category_id = null and empty nested_path for an uncategorized candidate', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      insertAsset({ projectId, relativePath: 'root.txt', filename: 'root.txt' });

      const [candidate] = releaseRepo.findReleaseCandidatePage(release.id, projectId);
      expect(candidate.category_id).toBeNull();
      expect(candidate.nested_path).toBe('');
    });
  });

  describe('countReleaseCandidates', () => {
    function insertAsset({ projectId, relativePath, filename, extension = 'txt', isPresent = 1 }) {
      return db.prepare(`
        INSERT INTO assets (project_id, relative_path, filename, extension,
                            mime_type, size_bytes, modified_at,
                            is_present, last_seen_at, missing_since)
        VALUES (?, ?, ?, ?, 'text/plain', 100, NULL, ?, datetime('now'),
                ${isPresent === 0 ? "datetime('now')" : 'NULL'})
        RETURNING id
      `).get(projectId, relativePath, filename, extension, isPresent);
    }

    function linkAssetToRelease({ releaseId, assetId, role = 'attachment', sortOrder = 0 }) {
      db.prepare(`
        INSERT INTO release_assets (release_id, asset_id, role, sort_order)
        VALUES (?, ?, ?, ?)
      `).run(releaseId, assetId, role, sortOrder);
    }

    it('count matches findCandidatePage for same filters', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      insertAsset({ projectId, relativePath: 'a.txt', filename: 'a.txt' });
      insertAsset({ projectId, relativePath: 'b.txt', filename: 'b.txt' });
      insertAsset({ projectId, relativePath: 'c.txt', filename: 'c.txt' });

      const count = releaseRepo.countReleaseCandidates(release.id, projectId);
      const page = releaseRepo.findReleaseCandidatePage(release.id, projectId);
      expect(count).toBe(page.length);
    });

    it('count matches with search filter', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      insertAsset({ projectId, relativePath: 'alpha.txt', filename: 'alpha.txt' });
      insertAsset({ projectId, relativePath: 'beta.txt', filename: 'beta.txt' });
      insertAsset({ projectId, relativePath: 'alphabet.txt', filename: 'alphabet.txt' });

      const count = releaseRepo.countReleaseCandidates(release.id, projectId, { search: 'alpha' });
      const page = releaseRepo.findReleaseCandidatePage(release.id, projectId, { search: 'alpha' });
      expect(count).toBe(page.length);
    });

    it('count matches with extension filter', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      insertAsset({ projectId, relativePath: 'a.txt', filename: 'a.txt', extension: 'txt' });
      insertAsset({ projectId, relativePath: 'b.png', filename: 'b.png', extension: 'png' });

      const count = releaseRepo.countReleaseCandidates(release.id, projectId, { extension: 'png' });
      const page = releaseRepo.findReleaseCandidatePage(release.id, projectId, { extension: 'png' });
      expect(count).toBe(page.length);
    });

    it('count matches with combined filters', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      insertAsset({ projectId, relativePath: 'data.txt', filename: 'data.txt', extension: 'txt' });
      insertAsset({ projectId, relativePath: 'data.png', filename: 'data.png', extension: 'png' });
      insertAsset({ projectId, relativePath: 'other.txt', filename: 'other.txt', extension: 'txt' });

      const count = releaseRepo.countReleaseCandidates(release.id, projectId, { search: 'data', extension: 'txt' });
      const page = releaseRepo.findReleaseCandidatePage(release.id, projectId, { search: 'data', extension: 'txt' });
      expect(count).toBe(page.length);
    });

    it('returns zero for empty result', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      expect(releaseRepo.countReleaseCandidates(release.id, projectId)).toBe(0);
    });

    it('excludes selected assets from count', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const a1 = insertAsset({ projectId, relativePath: 'a.txt', filename: 'a.txt' });
      insertAsset({ projectId, relativePath: 'b.txt', filename: 'b.txt' });
      linkAssetToRelease({ releaseId: release.id, assetId: a1.id });

      expect(releaseRepo.countReleaseCandidates(release.id, projectId)).toBe(1);
    });
  });

  describe('getReleaseCandidateExtensions', () => {
    function insertAsset({ projectId, relativePath, filename, extension = 'txt', isPresent = 1 }) {
      return db.prepare(`
        INSERT INTO assets (project_id, relative_path, filename, extension,
                            mime_type, size_bytes, modified_at,
                            is_present, last_seen_at, missing_since)
        VALUES (?, ?, ?, ?, 'text/plain', 100, NULL, ?, datetime('now'),
                ${isPresent === 0 ? "datetime('now')" : 'NULL'})
        RETURNING id
      `).get(projectId, relativePath, filename, extension, isPresent);
    }

    it('returns distinct extensions for available candidates', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      insertAsset({ projectId, relativePath: 'a.txt', filename: 'a.txt', extension: 'txt' });
      insertAsset({ projectId, relativePath: 'b.png', filename: 'b.png', extension: 'png' });
      insertAsset({ projectId, relativePath: 'c.txt', filename: 'c.txt', extension: 'txt' });

      const exts = releaseRepo.getReleaseCandidateExtensions(release.id, projectId);
      expect(exts).toEqual(['png', 'txt']);
    });

    it('excludes extensions of selected assets', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const selected = insertAsset({ projectId, relativePath: 'a.txt', filename: 'a.txt', extension: 'txt' });
      insertAsset({ projectId, relativePath: 'b.png', filename: 'b.png', extension: 'png' });
      db.prepare(`
        INSERT INTO release_assets (release_id, asset_id, role, sort_order)
        VALUES (?, ?, 'attachment', 0)
      `).run(release.id, selected.id);

      const exts = releaseRepo.getReleaseCandidateExtensions(release.id, projectId);
      expect(exts).toEqual(['png']);
    });

    it('excludes extensions of missing assets', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      insertAsset({ projectId, relativePath: 'a.txt', filename: 'a.txt', extension: 'txt', isPresent: 0 });
      insertAsset({ projectId, relativePath: 'b.png', filename: 'b.png', extension: 'png' });

      const exts = releaseRepo.getReleaseCandidateExtensions(release.id, projectId);
      expect(exts).toEqual(['png']);
    });

    it('returns empty array when no candidates exist', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const exts = releaseRepo.getReleaseCandidateExtensions(release.id, projectId);
      expect(exts).toEqual([]);
    });
  });

  // ─── Phase 9-3: Defensive same-project read guards ─────────────────────

  describe('cross-project junction row isolation', () => {
    let otherProjectId;
    let otherAssetId;

    beforeEach(() => {
      const otherProject = projectRepo.create(sampleProject({ title: 'Other Project' }));
      otherProjectId = otherProject.id;
      const otherAsset = assetRepo.upsert(otherProjectId, 'other.txt', sampleAsset(otherProjectId, { relativePath: 'other.txt' }));
      otherAssetId = otherAsset.id;
    });

    it('listReleaseAssets excludes cross-project junction rows', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const ownAsset = assetRepo.upsert(projectId, 'own.txt', sampleAsset(projectId, { relativePath: 'own.txt' }));
      releaseRepo.addReleaseAsset(release.id, ownAsset.id, 'primary', 0);
      // Insert a malformed cross-project row directly
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(release.id, otherAssetId, 'attachment', 1);

      const selections = releaseRepo.listReleaseAssets(release.id);
      expect(selections).toHaveLength(1);
      expect(selections[0].asset_id).toBe(ownAsset.id);
    });

    it('countReleaseAssets excludes cross-project junction rows', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const ownAsset = assetRepo.upsert(projectId, 'own.txt', sampleAsset(projectId, { relativePath: 'own.txt' }));
      releaseRepo.addReleaseAsset(release.id, ownAsset.id, 'primary', 0);
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(release.id, otherAssetId, 'attachment', 1);

      expect(releaseRepo.countReleaseAssets(release.id)).toBe(1);
    });

    it('findPage selected_asset_count excludes cross-project rows', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const ownAsset = assetRepo.upsert(projectId, 'own.txt', sampleAsset(projectId, { relativePath: 'own.txt' }));
      releaseRepo.addReleaseAsset(release.id, ownAsset.id, 'primary', 0);
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(release.id, otherAssetId, 'attachment', 1);

      const rows = releaseRepo.findPage({ today: '2025-06-15' });
      const row = rows.find((r) => r.id === release.id);
      expect(row.selected_asset_count).toBe(1);
    });

    it('findPage missing_asset_count excludes cross-project rows', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const ownAsset = assetRepo.upsert(projectId, 'own.txt', sampleAsset(projectId, { relativePath: 'own.txt' }));
      releaseRepo.addReleaseAsset(release.id, ownAsset.id, 'primary', 0);
      // Mark own asset as missing
      db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(ownAsset.id);
      // Insert a cross-project row with a present asset
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(release.id, otherAssetId, 'attachment', 1);

      const rows = releaseRepo.findPage({ today: '2025-06-15' });
      const row = rows.find((r) => r.id === release.id);
      expect(row.missing_asset_count).toBe(1);
    });

    it('findReleasesWithMissingSelectedAssets excludes cross-project rows', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const ownAsset = assetRepo.upsert(projectId, 'own.txt', sampleAsset(projectId, { relativePath: 'own.txt' }));
      releaseRepo.addReleaseAsset(release.id, ownAsset.id, 'primary', 0);
      db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(ownAsset.id);
      // Cross-project row with a present asset should not affect the missing count
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(release.id, otherAssetId, 'attachment', 1);

      const rows = releaseRepo.findReleasesWithMissingSelectedAssets(10);
      const row = rows.find((r) => r.id === release.id);
      expect(row).toBeDefined();
      expect(row.missing_asset_count).toBe(1);
    });

    it('countMissingAssetsReferenced excludes cross-project rows', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const ownAsset = assetRepo.upsert(projectId, 'own.txt', sampleAsset(projectId, { relativePath: 'own.txt' }));
      releaseRepo.addReleaseAsset(release.id, ownAsset.id, 'primary', 0);
      db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(ownAsset.id);
      // Cross-project row should not be counted
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(release.id, otherAssetId, 'attachment', 1);

      expect(releaseRepo.countMissingAssetsReferenced()).toBe(1);
    });

    it('countMissingAssetsReferencedByProjectId excludes cross-project rows', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const ownAsset = assetRepo.upsert(projectId, 'own.txt', sampleAsset(projectId, { relativePath: 'own.txt' }));
      releaseRepo.addReleaseAsset(release.id, ownAsset.id, 'primary', 0);
      db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(ownAsset.id);
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(release.id, otherAssetId, 'attachment', 1);

      expect(releaseRepo.countMissingAssetsReferencedByProjectId(projectId)).toBe(1);
    });
  });

  // ─── Phase 9-3: Repository write integrity ────────────────────────────

  describe('ownership-guarded insert', () => {
    it('addReleaseAsset returns undefined for cross-project asset', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const otherAsset = assetRepo.upsert(otherProject.id, 'other.txt', sampleAsset(otherProject.id, { relativePath: 'other.txt' }));

      const result = releaseRepo.addReleaseAsset(release.id, otherAsset.id, 'attachment', 0);
      expect(result).toBeUndefined();
    });

    it('insertReleaseAsset returns undefined for cross-project asset', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const otherAsset = assetRepo.upsert(otherProject.id, 'other.txt', sampleAsset(otherProject.id, { relativePath: 'other.txt' }));

      const result = releaseRepo.insertReleaseAsset(release.id, otherAsset.id, 'attachment', 0);
      expect(result).toBeUndefined();
    });

    it('replaceReleaseAssets throws for cross-project assets', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const ownAsset = assetRepo.upsert(projectId, 'own.txt', sampleAsset(projectId, { relativePath: 'own.txt' }));
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const otherAsset = assetRepo.upsert(otherProject.id, 'other.txt', sampleAsset(otherProject.id, { relativePath: 'other.txt' }));

      // Must throw — ownership mismatch must roll back the entire transaction
      expect(() => {
        releaseRepo.replaceReleaseAssets(release.id, [
          { assetId: ownAsset.id, role: 'primary', sortOrder: 0 },
          { assetId: otherAsset.id, role: 'attachment', sortOrder: 1 },
        ]);
      }).toThrow();

      // Original junction rows must remain exactly unchanged (transaction rolled back)
      const selections = releaseRepo.listReleaseAssets(release.id);
      expect(selections).toHaveLength(0);
    });
  });

  // ─── Phase 9-3: Diagnostic query ──────────────────────────────────────

  describe('findCrossProjectReleaseAssets', () => {
    it('returns empty array when no malformed rows exist', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const ownAsset = assetRepo.upsert(projectId, 'own.txt', sampleAsset(projectId, { relativePath: 'own.txt' }));
      releaseRepo.addReleaseAsset(release.id, ownAsset.id, 'primary', 0);

      const result = releaseRepo.findCrossProjectReleaseAssets();
      expect(result).toEqual([]);
    });

    it('detects malformed cross-project rows', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const otherAsset = assetRepo.upsert(otherProject.id, 'other.txt', sampleAsset(otherProject.id, { relativePath: 'other.txt' }));

      // Insert a malformed cross-project row directly
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(release.id, otherAsset.id, 'attachment', 0);

      const result = releaseRepo.findCrossProjectReleaseAssets();
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        release_id: release.id,
        asset_id: otherAsset.id,
        release_project_id: projectId,
        asset_project_id: otherProject.id,
      });
    });

    it('performs no mutation', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const otherAsset = assetRepo.upsert(otherProject.id, 'other.txt', sampleAsset(otherProject.id, { relativePath: 'other.txt' }));
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(release.id, otherAsset.id, 'attachment', 0);

      const beforeRows = db.prepare('SELECT COUNT(*) AS c FROM release_assets').get().c;
      releaseRepo.findCrossProjectReleaseAssets();
      const afterRows = db.prepare('SELECT COUNT(*) AS c FROM release_assets').get().c;

      expect(afterRows).toBe(beforeRows);
    });

    it('returns deterministic output ordered by release_id, asset_id', () => {
      const release1 = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R1' }) });
      const release2 = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R2' }) });
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const otherAsset1 = assetRepo.upsert(otherProject.id, 'a.txt', sampleAsset(otherProject.id, { relativePath: 'a.txt' }));
      const otherAsset2 = assetRepo.upsert(otherProject.id, 'b.txt', sampleAsset(otherProject.id, { relativePath: 'b.txt' }));

      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(release2.id, otherAsset2.id, 'attachment', 0);
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(release1.id, otherAsset1.id, 'attachment', 0);

      const result = releaseRepo.findCrossProjectReleaseAssets();
      expect(result).toHaveLength(2);
      expect(result[0].release_id).toBeLessThanOrEqual(result[1].release_id);
    });

    it('includes reason column for cross-project rows', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const otherAsset = assetRepo.upsert(otherProject.id, 'other.txt', sampleAsset(otherProject.id, { relativePath: 'other.txt' }));
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(release.id, otherAsset.id, 'attachment', 0);

      const result = releaseRepo.findCrossProjectReleaseAssets();
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('reason');
      expect(result[0].reason).toBe('cross-project');
    });

    it('detects missing release with LEFT JOIN', () => {
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const otherAsset = assetRepo.upsert(otherProject.id, 'orphan.txt', sampleAsset(otherProject.id, { relativePath: 'orphan.txt' }));
      // Disable FK temporarily to insert an orphaned row
      db.pragma('foreign_keys = OFF');
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(99999, otherAsset.id, 'attachment', 0);
      db.pragma('foreign_keys = ON');

      const result = releaseRepo.findCrossProjectReleaseAssets();
      expect(result).toHaveLength(1);
      expect(result[0].release_id).toBe(99999);
      expect(result[0].asset_id).toBe(otherAsset.id);
      expect(result[0].release_project_id).toBeNull();
      expect(result[0].reason).toBe('missing release');
    });

    it('detects missing asset with LEFT JOIN', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      // Disable FK temporarily to insert an orphaned row
      db.pragma('foreign_keys = OFF');
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(release.id, 99999, 'attachment', 0);
      db.pragma('foreign_keys = ON');

      const result = releaseRepo.findCrossProjectReleaseAssets();
      expect(result).toHaveLength(1);
      expect(result[0].release_id).toBe(release.id);
      expect(result[0].asset_id).toBe(99999);
      expect(result[0].asset_project_id).toBeNull();
      expect(result[0].reason).toBe('missing asset');
    });

    it('detects both parents missing with FK-disabled corruption', () => {
      // Disable foreign keys temporarily to insert orphaned rows
      db.pragma('foreign_keys = OFF');
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(88888, 77777, 'attachment', 0);
      db.pragma('foreign_keys = ON');

      const result = releaseRepo.findCrossProjectReleaseAssets();
      expect(result).toHaveLength(1);
      expect(result[0].release_id).toBe(88888);
      expect(result[0].asset_id).toBe(77777);
      expect(result[0].release_project_id).toBeNull();
      expect(result[0].asset_project_id).toBeNull();
      expect(result[0].reason).toBe('both parents missing');
    });
  });

  // ─── Phase 9-4: Bulk replacement rollback tests ─────────────────────────

  describe('replaceReleaseAssets rollback behavior', () => {
    it('rolls back entire transaction when one valid + one cross-project selection is submitted', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const ownBefore = assetRepo.upsert(projectId, 'before.txt', sampleAsset(projectId, { relativePath: 'before.txt' }));
      releaseRepo.addReleaseAsset(release.id, ownBefore.id, 'primary', 0);
      const beforeSelections = releaseRepo.listReleaseAssets(release.id);
      expect(beforeSelections).toHaveLength(1);

      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const otherAsset = assetRepo.upsert(otherProject.id, 'other.txt', sampleAsset(otherProject.id, { relativePath: 'other.txt' }));

      expect(() => {
        releaseRepo.replaceReleaseAssets(release.id, [
          { assetId: ownBefore.id, role: 'primary', sortOrder: 0 },
          { assetId: otherAsset.id, role: 'attachment', sortOrder: 1 },
        ]);
      }).toThrow();

      // Original rows preserved exactly
      const afterSelections = releaseRepo.listReleaseAssets(release.id);
      expect(afterSelections).toEqual(beforeSelections);
    });

    it('rolls back when mismatch is at first position', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const ownAsset = assetRepo.upsert(projectId, 'own.txt', sampleAsset(projectId, { relativePath: 'own.txt' }));
      releaseRepo.addReleaseAsset(release.id, ownAsset.id, 'primary', 0);
      const before = releaseRepo.listReleaseAssets(release.id);

      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const otherAsset = assetRepo.upsert(otherProject.id, 'other.txt', sampleAsset(otherProject.id, { relativePath: 'other.txt' }));
      const ownAsset2 = assetRepo.upsert(projectId, 'own2.txt', sampleAsset(projectId, { relativePath: 'own2.txt' }));

      expect(() => {
        releaseRepo.replaceReleaseAssets(release.id, [
          { assetId: otherAsset.id, role: 'attachment', sortOrder: 0 },
          { assetId: ownAsset2.id, role: 'attachment', sortOrder: 1 },
        ]);
      }).toThrow();

      expect(releaseRepo.listReleaseAssets(release.id)).toEqual(before);
    });

    it('rolls back when mismatch is at middle position', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const ownAsset = assetRepo.upsert(projectId, 'own.txt', sampleAsset(projectId, { relativePath: 'own.txt' }));
      releaseRepo.addReleaseAsset(release.id, ownAsset.id, 'primary', 0);
      const before = releaseRepo.listReleaseAssets(release.id);

      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const otherAsset = assetRepo.upsert(otherProject.id, 'other.txt', sampleAsset(otherProject.id, { relativePath: 'other.txt' }));
      const ownAsset2 = assetRepo.upsert(projectId, 'own2.txt', sampleAsset(projectId, { relativePath: 'own2.txt' }));
      const ownAsset3 = assetRepo.upsert(projectId, 'own3.txt', sampleAsset(projectId, { relativePath: 'own3.txt' }));

      expect(() => {
        releaseRepo.replaceReleaseAssets(release.id, [
          { assetId: ownAsset2.id, role: 'attachment', sortOrder: 0 },
          { assetId: otherAsset.id, role: 'attachment', sortOrder: 1 },
          { assetId: ownAsset3.id, role: 'attachment', sortOrder: 2 },
        ]);
      }).toThrow();

      expect(releaseRepo.listReleaseAssets(release.id)).toEqual(before);
    });

    it('rolls back when mismatch is at last position', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const ownAsset = assetRepo.upsert(projectId, 'own.txt', sampleAsset(projectId, { relativePath: 'own.txt' }));
      releaseRepo.addReleaseAsset(release.id, ownAsset.id, 'primary', 0);
      const before = releaseRepo.listReleaseAssets(release.id);

      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const otherAsset = assetRepo.upsert(otherProject.id, 'other.txt', sampleAsset(otherProject.id, { relativePath: 'other.txt' }));
      const ownAsset2 = assetRepo.upsert(projectId, 'own2.txt', sampleAsset(projectId, { relativePath: 'own2.txt' }));

      expect(() => {
        releaseRepo.replaceReleaseAssets(release.id, [
          { assetId: ownAsset2.id, role: 'attachment', sortOrder: 0 },
          { assetId: otherAsset.id, role: 'attachment', sortOrder: 1 },
        ]);
      }).toThrow();

      expect(releaseRepo.listReleaseAssets(release.id)).toEqual(before);
    });

    it('no empty replacement when all selections mismatch', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'R' }) });
      const ownBefore = assetRepo.upsert(projectId, 'before.txt', sampleAsset(projectId, { relativePath: 'before.txt' }));
      releaseRepo.addReleaseAsset(release.id, ownBefore.id, 'primary', 0);
      const before = releaseRepo.listReleaseAssets(release.id);

      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const otherAsset = assetRepo.upsert(otherProject.id, 'other.txt', sampleAsset(otherProject.id, { relativePath: 'other.txt' }));
      const otherAsset2 = assetRepo.upsert(otherProject.id, 'other2.txt', sampleAsset(otherProject.id, { relativePath: 'other2.txt' }));

      expect(() => {
        releaseRepo.replaceReleaseAssets(release.id, [
          { assetId: otherAsset.id, role: 'attachment', sortOrder: 0 },
          { assetId: otherAsset2.id, role: 'attachment', sortOrder: 1 },
        ]);
      }).toThrow();

      // Original rows preserved exactly — no partial or empty replacement
      expect(releaseRepo.listReleaseAssets(release.id)).toEqual(before);
    });
  });

  // ─── Phase 9-4: findReleasesWithoutSelectedAssets ownership fix ────────

  describe('findReleasesWithoutSelectedAssets ownership', () => {
    let otherProjectId;
    let otherAssetId;

    beforeEach(() => {
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      otherProjectId = otherProject.id;
      const otherAsset = assetRepo.upsert(otherProjectId, 'other.txt', sampleAsset(otherProjectId, { relativePath: 'other.txt' }));
      otherAssetId = otherAsset.id;
    });

    it('shows release with no junction rows as having no selected assets', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'No Jxn', status: 'planned', plannedDate: '2099-01-01' }) });
      const result = releaseRepo.findReleasesWithoutSelectedAssets(10);
      const ids = result.map((r) => r.id);
      expect(ids).toContain(release.id);
    });

    it('does NOT show release with valid same-project selection', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Has Own Asset', status: 'planned', plannedDate: '2099-01-01' }) });
      const ownAsset = assetRepo.upsert(projectId, 'own.txt', sampleAsset(projectId, { relativePath: 'own.txt' }));
      releaseRepo.addReleaseAsset(release.id, ownAsset.id, 'attachment', 0);

      const result = releaseRepo.findReleasesWithoutSelectedAssets(10);
      const ids = result.map((r) => r.id);
      expect(ids).not.toContain(release.id);
    });

    it('shows release with only cross-project selection as having no selected assets', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Only Cross', status: 'planned', plannedDate: '2099-01-01' }) });
      // Direct insert of cross-project row
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(release.id, otherAssetId, 'attachment', 0);

      const result = releaseRepo.findReleasesWithoutSelectedAssets(10);
      const ids = result.map((r) => r.id);
      expect(ids).toContain(release.id);
    });

    it('shows release with mixed valid + cross-project as having selected assets', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Mixed', status: 'planned', plannedDate: '2099-01-01' }) });
      const ownAsset = assetRepo.upsert(projectId, 'own.txt', sampleAsset(projectId, { relativePath: 'own.txt' }));
      releaseRepo.addReleaseAsset(release.id, ownAsset.id, 'primary', 0);
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(release.id, otherAssetId, 'attachment', 1);

      // Has at least one valid same-project selection — not in "no selected assets"
      const result = releaseRepo.findReleasesWithoutSelectedAssets(10);
      const ids = result.map((r) => r.id);
      expect(ids).not.toContain(release.id);
    });
  });

  // ─── Phase 9-4: countMissingAssetsReferencedByProjectId ownership parity ──

  describe('countMissingAssetsReferencedByProjectId ownership parity', () => {
    it('counts only missing assets from releases of the same project', () => {
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const otherRelease = releaseRepo.create({ projectId: otherProject.id, ...sampleRelease({ title: 'Other Release', status: 'tbd', plannedDate: null }) });
      const otherAsset = assetRepo.upsert(otherProject.id, 'other.txt', sampleAsset(otherProject.id, { relativePath: 'other.txt' }));
      releaseRepo.addReleaseAsset(otherRelease.id, otherAsset.id, 'primary', 0);
      db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(otherAsset.id);

      // Project A should NOT see project B's missing asset
      expect(releaseRepo.countMissingAssetsReferencedByProjectId(projectId)).toBe(0);

      // Add a same-project missing asset
      const ownRelease = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Own Release', status: 'tbd', plannedDate: null }) });
      const ownMissing = assetRepo.upsert(projectId, 'missing.txt', sampleAsset(projectId, { relativePath: 'missing.txt' }));
      releaseRepo.addReleaseAsset(ownRelease.id, ownMissing.id, 'primary', 0);
      db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(ownMissing.id);

      expect(releaseRepo.countMissingAssetsReferencedByProjectId(projectId)).toBe(1);
    });

    it('cross-project release from project B referencing project A missing asset does not inflate project A count', () => {
      // Create a missing asset in project A
      const ownRelease = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Own Release', status: 'tbd' }) });
      const aMissing = assetRepo.upsert(projectId, 'a_missing.txt', sampleAsset(projectId, { relativePath: 'a_missing.txt' }));
      releaseRepo.addReleaseAsset(ownRelease.id, aMissing.id, 'primary', 0);
      db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(aMissing.id);
      const directCount = releaseRepo.countMissingAssetsReferencedByProjectId(projectId);
      expect(directCount).toBe(1);

      // Now create a malformed junction: a release from project B referencing
      // the same missing asset from project A via direct insert
      const otherProject = projectRepo.create(sampleProject({ title: 'B' }));
      const bRelease = releaseRepo.create({ projectId: otherProject.id, ...sampleRelease({ title: 'B Release', status: 'tbd' }) });
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(bRelease.id, aMissing.id, 'attachment', 0);

      // Must still count exactly 1 (only the own-release reference counts)
      expect(releaseRepo.countMissingAssetsReferencedByProjectId(projectId)).toBe(1);
    });
  });

  // ─── Phase 9-4: Cross-query parity with one malformed fixture ──────────

  describe('cross-query parity with malformed fixture', () => {
    let otherProjectId;
    let otherAssetId;
    let releaseId;

    beforeEach(() => {
      const otherProject = projectRepo.create(sampleProject({ title: 'Other For Parity' }));
      otherProjectId = otherProject.id;
      const otherAsset = assetRepo.upsert(otherProjectId, 'cross.txt', sampleAsset(otherProjectId, { relativePath: 'cross.txt' }));
      otherAssetId = otherAsset.id;

      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Parity Release', status: 'tbd' }) });
      releaseId = release.id;

      // Valid same-project selection
      const ownAsset = assetRepo.upsert(projectId, 'own.txt', sampleAsset(projectId, { relativePath: 'own.txt' }));
      releaseRepo.addReleaseAsset(release.id, ownAsset.id, 'primary', 0);

      // Malformed cross-project selection (direct insert)
      db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
        .run(release.id, otherAssetId, 'attachment', 1);
    });

    it('selected-assets listing: listReleaseAssets excludes cross-project row', () => {
      const assets = releaseRepo.listReleaseAssets(releaseId);
      expect(assets).toHaveLength(1);
      expect(assets[0].asset_id).not.toBe(otherAssetId);
    });

    it('no-selected-assets discovery: findReleasesWithoutSelectedAssets excludes this release', () => {
      const result = releaseRepo.findReleasesWithoutSelectedAssets(10);
      const ids = result.map((r) => r.id);
      expect(ids).not.toContain(releaseId);
    });

    it('missing-reference counts: countMissingAssetsReferenced is 0 (own asset present)', () => {
      // Neither asset is missing
      expect(releaseRepo.countMissingAssetsReferenced()).toBe(0);
    });

    it('candidate exclusion: findReleaseCandidatePage works', () => {
      const candidates = releaseRepo.findReleaseCandidatePage(releaseId, projectId, { page: 1, pageSize: 25 });
      // Candidates should still be queryable — cross-project row doesn't affect candidate queries
      expect(Array.isArray(candidates)).toBe(true);
    });

    it('diagnostic output: findCrossProjectReleaseAssets detects the malformed row', () => {
      const malformed = releaseRepo.findCrossProjectReleaseAssets();
      const match = malformed.find((r) => r.release_id === releaseId && r.asset_id === otherAssetId);
      expect(match).toBeDefined();
      expect(match.release_project_id).toBe(projectId);
      expect(match.asset_project_id).toBe(otherProjectId);
      expect(match.reason).toBe('cross-project');
    });
  });

  // ─── Phase 9: Transaction rollback tests ────────────────────────────────

  describe('removeAndReindexReleaseAsset rollback', () => {
    /**
     * Snapshot the five junction columns for a release in deterministic order.
     */
    function snapshotJunction(releaseId) {
      return db.prepare(`
        SELECT release_id, asset_id, role, sort_order, created_at
        FROM release_assets
        WHERE release_id = ?
        ORDER BY sort_order ASC, asset_id ASC
      `).all(releaseId);
    }

    it('rolls back when reindex UPDATE fails after DELETE succeeds', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Rollback Remove' }) });
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      releaseRepo.addReleaseAsset(release.id, asset1.id, 'primary', 0);
      releaseRepo.addReleaseAsset(release.id, asset2.id, 'attachment', 1);

      const before = snapshotJunction(release.id);
      expect(before).toHaveLength(2);

      // Create a SQLite trigger that fires on UPDATE of release_assets.sort_order
      // and raises an exception — this simulates a reindex failure after the DELETE.
      db.exec(`
        CREATE TEMP TRIGGER IF NOT EXISTS fail_reindex_sort_order
        AFTER UPDATE OF sort_order ON release_assets
        WHEN (SELECT COUNT(*) FROM release_assets WHERE release_id = NEW.release_id) >= 0
        BEGIN
          SELECT RAISE(ABORT, 'simulated reindex failure');
        END
      `);

      try {
        expect(() => {
          releaseRepo.removeAndReindexReleaseAsset(release.id, asset1.id);
        }).toThrow();

        // The trigger fires on the first UPDATE attempt inside the reindex loop.
        // The DELETE already succeeded but the transaction rolled back.
        const after = snapshotJunction(release.id);
        expect(after).toEqual(before);
      } finally {
        db.exec('DROP TRIGGER IF EXISTS fail_reindex_sort_order');
      }
    });
  });

  describe('reorderReleaseAssets rollback', () => {
    /**
     * Snapshot the five junction columns for a release in deterministic order.
     */
    function snapshotJunction(releaseId) {
      return db.prepare(`
        SELECT release_id, asset_id, role, sort_order, created_at
        FROM release_assets
        WHERE release_id = ?
        ORDER BY sort_order ASC, asset_id ASC
      `).all(releaseId);
    }

    it('rolls back when a later sort_order UPDATE fails after an earlier one succeeded', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Rollback Reorder' }) });
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      const asset3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));
      releaseRepo.addReleaseAsset(release.id, asset1.id, 'primary', 0);
      releaseRepo.addReleaseAsset(release.id, asset2.id, 'attachment', 1);
      releaseRepo.addReleaseAsset(release.id, asset3.id, 'preview', 2);

      const before = snapshotJunction(release.id);
      expect(before).toHaveLength(3);

      // Create a trigger that fires AFTER the first UPDATE of sort_order.
      // The first UPDATE (asset3 -> sort_order=0) succeeds (changes=1), then
      // the trigger fires and aborts — proving rollback after at least one
      // successful sort_order write.
      db.exec(`
        CREATE TEMP TRIGGER IF NOT EXISTS fail_reorder_after_first_update
        AFTER UPDATE OF sort_order ON release_assets
        BEGIN
          SELECT RAISE(ABORT, 'simulated reorder failure');
        END
      `);

      try {
        expect(() => {
          // Reverse order: [asset3, asset2, asset1]
          releaseRepo.reorderReleaseAssets(release.id, [asset3.id, asset2.id, asset1.id]);
        }).toThrow();

        // Every row must be exactly as before — no partial sort_order rewrite
        const after = snapshotJunction(release.id);
        expect(after).toEqual(before);
      } finally {
        db.exec('DROP TRIGGER IF EXISTS fail_reorder_after_first_update');
      }
    });
  });

  // ─── Phase 9: reorderReleaseAssets sequence validation ─────────────────

  describe('reorderReleaseAssets sequence validation', () => {
    /**
     * Snapshot the five junction columns for a release in deterministic order.
     */
    function snapshotJunction(releaseId) {
      return db.prepare(`
        SELECT release_id, asset_id, role, sort_order, created_at
        FROM release_assets
        WHERE release_id = ?
        ORDER BY sort_order ASC, asset_id ASC
      `).all(releaseId);
    }

    it('rejects duplicate ID', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Dup' }) });
      const a1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const a2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      releaseRepo.addReleaseAsset(release.id, a1.id, 'primary', 0);
      releaseRepo.addReleaseAsset(release.id, a2.id, 'attachment', 1);

      const before = snapshotJunction(release.id);
      expect(() => releaseRepo.reorderReleaseAssets(release.id, [a1.id, a1.id])).toThrow();
      expect(snapshotJunction(release.id)).toEqual(before);
    });

    it('rejects missing selected ID (omitted from sequence)', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Missing' }) });
      const a1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const a2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      releaseRepo.addReleaseAsset(release.id, a1.id, 'primary', 0);
      releaseRepo.addReleaseAsset(release.id, a2.id, 'attachment', 1);

      const before = snapshotJunction(release.id);
      expect(() => releaseRepo.reorderReleaseAssets(release.id, [a1.id])).toThrow();
      expect(snapshotJunction(release.id)).toEqual(before);
    });

    it('rejects incomplete sequence (too few IDs)', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Incomplete' }) });
      const a1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const a2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      const a3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));
      releaseRepo.addReleaseAsset(release.id, a1.id, 'primary', 0);
      releaseRepo.addReleaseAsset(release.id, a2.id, 'attachment', 1);
      releaseRepo.addReleaseAsset(release.id, a3.id, 'preview', 2);

      const before = snapshotJunction(release.id);
      expect(() => releaseRepo.reorderReleaseAssets(release.id, [a1.id, a2.id])).toThrow();
      expect(snapshotJunction(release.id)).toEqual(before);
    });

    it('rejects extra foreign ID (not in current selection)', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Extra' }) });
      const a1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const a2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      const a3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));
      releaseRepo.addReleaseAsset(release.id, a1.id, 'primary', 0);
      releaseRepo.addReleaseAsset(release.id, a2.id, 'attachment', 1);

      const before = snapshotJunction(release.id);
      expect(() => releaseRepo.reorderReleaseAssets(release.id, [a1.id, a3.id])).toThrow();
      expect(snapshotJunction(release.id)).toEqual(before);
    });

    it('rejects nonexistent ID', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Nonexist' }) });
      const a1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      releaseRepo.addReleaseAsset(release.id, a1.id, 'primary', 0);

      const before = snapshotJunction(release.id);
      expect(() => releaseRepo.reorderReleaseAssets(release.id, [99999])).toThrow();
      expect(snapshotJunction(release.id)).toEqual(before);
    });

    it('rejects empty sequence when rows exist', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Empty When Rows' }) });
      const a1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      releaseRepo.addReleaseAsset(release.id, a1.id, 'primary', 0);

      const before = snapshotJunction(release.id);
      expect(() => releaseRepo.reorderReleaseAssets(release.id, [])).toThrow();
      expect(snapshotJunction(release.id)).toEqual(before);
    });

    it('accepts valid empty sequence when no rows exist', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Empty No Rows' }) });
      expect(() => releaseRepo.reorderReleaseAssets(release.id, [])).not.toThrow();
    });

    it('accepts valid complete reordered sequence', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Valid Reorder' }) });
      const a1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const a2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      const a3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));
      releaseRepo.addReleaseAsset(release.id, a1.id, 'primary', 0);
      releaseRepo.addReleaseAsset(release.id, a2.id, 'attachment', 1);
      releaseRepo.addReleaseAsset(release.id, a3.id, 'preview', 2);

      // Reverse order
      releaseRepo.reorderReleaseAssets(release.id, [a3.id, a2.id, a1.id]);

      const after = snapshotJunction(release.id);
      expect(after).toHaveLength(3);
      expect(after[0].asset_id).toBe(a3.id);
      expect(after[0].sort_order).toBe(0);
      expect(after[1].asset_id).toBe(a2.id);
      expect(after[1].sort_order).toBe(1);
      expect(after[2].asset_id).toBe(a1.id);
      expect(after[2].sort_order).toBe(2);
    });
  });

  // ─── Phase 3 chunk 3: appendAssetsToRelease (bulk browser association) ──

  describe('appendAssetsToRelease', () => {
    function snapshotJunction(releaseId) {
      return db.prepare(`
        SELECT release_id, asset_id, role, sort_order, created_at
        FROM release_assets
        WHERE release_id = ?
        ORDER BY sort_order ASC, asset_id ASC
      `).all(releaseId);
    }

    it('appends multiple assets transactionally with role attachment, contiguous after the last item', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Bulk' }) });
      const existing = assetRepo.upsert(projectId, 'existing.txt', sampleAsset(projectId, { relativePath: 'existing.txt' }));
      releaseRepo.addReleaseAsset(release.id, existing.id, 'primary', 0);

      const a1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const a2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));

      const result = releaseRepo.appendAssetsToRelease(release.id, [a1.id, a2.id]);

      expect(result).toEqual({ added: 2, alreadyAssociated: 0 });
      const rows = snapshotJunction(release.id);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.asset_id)).toEqual([existing.id, a1.id, a2.id]);
      expect(rows[0].role).toBe('primary');
      expect(rows[0].sort_order).toBe(0);
      expect(rows[1].role).toBe('attachment');
      expect(rows[1].sort_order).toBe(1);
      expect(rows[2].role).toBe('attachment');
      expect(rows[2].sort_order).toBe(2);
    });

    it('skips already-associated assets without touching their existing role/order', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Skip Existing' }) });
      const already = assetRepo.upsert(projectId, 'already.txt', sampleAsset(projectId, { relativePath: 'already.txt' }));
      releaseRepo.addReleaseAsset(release.id, already.id, 'primary', 0);
      const before = snapshotJunction(release.id);

      const fresh = assetRepo.upsert(projectId, 'fresh.txt', sampleAsset(projectId, { relativePath: 'fresh.txt' }));

      const result = releaseRepo.appendAssetsToRelease(release.id, [already.id, fresh.id]);

      expect(result).toEqual({ added: 1, alreadyAssociated: 1 });
      const after = snapshotJunction(release.id);
      // The pre-existing row is byte-for-byte unchanged (role, sort_order, created_at).
      expect(after.find((r) => r.asset_id === already.id)).toEqual(before[0]);
      const newRow = after.find((r) => r.asset_id === fresh.id);
      expect(newRow.role).toBe('attachment');
      expect(newRow.sort_order).toBe(1);
    });

    it('appends new rows after the current maximum sort_order, even when the existing rows have a gap', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Gap' }) });
      const a1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const a2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      // Deliberate gap: sort_order 0 and 5 (simulating legacy curation state
      // that never got reindexed).
      releaseRepo.addReleaseAsset(release.id, a1.id, 'primary', 0);
      db.prepare(`
        INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)
      `).run(release.id, a2.id, 'attachment', 5);

      const a3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));
      const result = releaseRepo.appendAssetsToRelease(release.id, [a3.id]);

      expect(result.added).toBe(1);
      const newRow = snapshotJunction(release.id).find((r) => r.asset_id === a3.id);
      expect(newRow.sort_order).toBe(6);
    });

    it('deduplicates the submitted array — a repeated ID does not consume an extra order slot or insert twice', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Dedupe' }) });
      const a1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const a2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));

      const result = releaseRepo.appendAssetsToRelease(release.id, [a1.id, a1.id, a2.id, a1.id]);

      expect(result).toEqual({ added: 2, alreadyAssociated: 0 });
      const rows = snapshotJunction(release.id);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.asset_id)).toEqual([a1.id, a2.id]);
      expect(rows.map((r) => r.sort_order)).toEqual([0, 1]);
    });

    it('rolls back the entire append when a cross-project asset ID is included', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Rollback' }) });
      const a1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const before = snapshotJunction(release.id);

      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const otherAsset = assetRepo.upsert(otherProject.id, 'other.txt', sampleAsset(otherProject.id, { relativePath: 'other.txt' }));

      expect(() => {
        releaseRepo.appendAssetsToRelease(release.id, [a1.id, otherAsset.id]);
      }).toThrow();

      // No partial append — not even the valid same-project asset was inserted.
      expect(snapshotJunction(release.id)).toEqual(before);
    });

    it('does not reorder or otherwise modify existing release_assets rows', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Preserve Order' }) });
      const a1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const a2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      releaseRepo.addReleaseAsset(release.id, a1.id, 'preview', 0);
      releaseRepo.addReleaseAsset(release.id, a2.id, 'source', 1);
      const before = snapshotJunction(release.id);

      const a3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));
      releaseRepo.appendAssetsToRelease(release.id, [a3.id]);

      const after = snapshotJunction(release.id);
      expect(after.slice(0, 2)).toEqual(before);
    });

    it('does not create or change a release-owned status field', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Publication Stable' }) });
      const a1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));

      releaseRepo.appendAssetsToRelease(release.id, [a1.id]);

      const updated = releaseRepo.findById(release.id);
      expect(updated.published_date).toBeNull();
      expect(updated).not.toHaveProperty('status');
    });
  });

  describe('findEligibleAssetSelectionTargets', () => {
    it('returns only non-archived, non-published releases for the given project', () => {
      const active = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Active', status: 'tbd' }) });
      const cancelled = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Cancelled', status: 'cancelled' }) });
      const published = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Published', status: 'planned' }) });
      releaseRepo.publish(published.id, '2026-01-01');
      const toArchive = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Archived' }) });
      releaseRepo.archive(toArchive.id);

      const targets = releaseRepo.findEligibleAssetSelectionTargets(projectId);
      const ids = targets.map((t) => t.id);

      expect(ids).toContain(active.id);
      expect(ids).toContain(cancelled.id);
      expect(ids).not.toContain(published.id);
      expect(ids).not.toContain(toArchive.id);
    });

    it('does not expose releases from another project', () => {
      const mine = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Mine' }) });
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const theirs = releaseRepo.create({ projectId: otherProject.id, ...sampleRelease({ title: 'Theirs' }) });

      const targets = releaseRepo.findEligibleAssetSelectionTargets(projectId);
      const ids = targets.map((t) => t.id);

      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
    });

    it('returns render-ready id/title/project_status only, ordered by title', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Zebra' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Alpha' }) });

      const targets = releaseRepo.findEligibleAssetSelectionTargets(projectId);

      expect(targets.map((t) => t.title)).toEqual(['Alpha', 'Zebra']);
      expect(Object.keys(targets[0]).sort()).toEqual(['id', 'project_status', 'title']);
      expect(targets.every((target) => target.project_status === 'tbd')).toBe(true);
    });
  });
});
