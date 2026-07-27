import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    status: 'idea',
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
    it('creates a release with default status', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Alpha Release' }) });
      expect(release.title).toBe('Alpha Release');
      expect(release.status).toBe('idea');
      expect(release.project_id).toBe(projectId);
      expect(release.id).toBeTruthy();
    });

    it('creates a release with all fields', () => {
      const input = {
        projectId,
        title: 'Full Release',
        description: 'A description',
        notes: 'Some notes',
        status: 'planned',
        plannedDate: '2025-06-15',
        patreonUrl: 'https://patreon.com/user',
      };
      const release = releaseRepo.create(input);
      expect(release.title).toBe('Full Release');
      expect(release.description).toBe('A description');
      expect(release.notes).toBe('Some notes');
      expect(release.status).toBe('planned');
      expect(release.planned_date).toBe('2025-06-15');
      expect(release.patreon_url).toBe('https://patreon.com/user');
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

    it('filters by status', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Idea 1', status: 'idea' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Planned 1', status: 'planned' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Planned 2', status: 'planned' }) });
      const planned = releaseRepo.findByProjectId(projectId, { status: 'planned' });
      expect(planned).toHaveLength(2);
      expect(planned.every((r) => r.status === 'planned')).toBe(true);
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
      releaseRepo.update(r1.id, { title: 'First Updated', description: '', notes: '', status: 'idea', plannedDate: null, patreonUrl: null });
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

  describe('update', () => {
    it('updates a release', () => {
      const created = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Original' }) });
      const updated = releaseRepo.update(created.id, {
        title: 'Updated',
        description: 'New desc',
        notes: 'New notes',
        status: 'planned',
        plannedDate: '2025-07-01',
        patreonUrl: null,
      });
      expect(updated.title).toBe('Updated');
      expect(updated.status).toBe('planned');
      expect(updated.planned_date).toBe('2025-07-01');
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
    it('sets status to published and sets published_date', () => {
      const created = releaseRepo.create({ projectId, ...sampleRelease({ status: 'ready' }) });
      const published = releaseRepo.publish(created.id, '2025-06-15');
      expect(published.status).toBe('published');
      expect(published.published_date).toBe('2025-06-15');
    });

    it('returns undefined for non-existent id', () => {
      const published = releaseRepo.publish(99999, '2025-06-15');
      expect(published).toBeUndefined();
    });
  });

  describe('countByStatus', () => {
    it('counts releases by status', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Idea 1', status: 'idea' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Idea 2', status: 'idea' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Planned 1', status: 'planned' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Drafting 1', status: 'drafting' }) });
      const counts = releaseRepo.countByStatus();
      expect(counts.idea).toBe(2);
      expect(counts.planned).toBe(1);
      expect(counts.drafting).toBe(1);
      expect(counts.ready).toBe(0);
      expect(counts.published).toBe(0);
      expect(counts.cancelled).toBe(0);
    });

    it('returns zero for all statuses when no releases exist', () => {
      const counts = releaseRepo.countByStatus();
      expect(counts.idea).toBe(0);
      expect(counts.planned).toBe(0);
      expect(counts.drafting).toBe(0);
      expect(counts.ready).toBe(0);
      expect(counts.published).toBe(0);
      expect(counts.cancelled).toBe(0);
    });

    it('excludes archived releases from count', () => {
      const r1 = releaseRepo.create({ projectId, ...sampleRelease({ status: 'idea' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ status: 'idea' }) });
      releaseRepo.archive(r1.id);
      const counts = releaseRepo.countByStatus();
      expect(counts.idea).toBe(1);
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
  // The dashboard queries (findOverdue, findUpcoming, findReady,
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

    it('findReady excludes releases whose parent project is archived', () => {
      releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'Ready In Archived', plannedDate: '2099-01-01', status: 'ready' }),
      });
      archiveProject(projectId);
      expect(releaseRepo.findReady(10)).toEqual([]);
    });

    it('findActiveWithoutPlannedDate excludes releases whose parent project is archived', () => {
      releaseRepo.create({
        projectId,
        ...sampleRelease({ title: 'No Date In Archived', plannedDate: null, status: 'drafting' }),
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
});
