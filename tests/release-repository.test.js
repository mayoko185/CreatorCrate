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
      expect(rows[0].selected_asset_count).toBe(1);
      expect(rows[0].missing_asset_count).toBe(0);
    });

    it('paginates with limit and offset in SQL', () => {
      for (let i = 0; i < 10; i++) {
        releaseRepo.create({ projectId, ...sampleRelease({ title: `R${i}`, status: 'idea' }) });
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
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Mine', status: 'idea' }) });
      releaseRepo.create({ projectId: otherProject.id, ...sampleRelease({ title: 'Other', status: 'idea' }) });

      const rows = releaseRepo.findPage({ projectId, today: '2025-06-15' });
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe('Mine');
    });

    it('filters by status', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Idea', status: 'idea' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Planned', status: 'planned' }) });

      const ideaRows = releaseRepo.findPage({ status: 'idea', today: '2025-06-15' });
      expect(ideaRows).toHaveLength(1);
      expect(ideaRows[0].title).toBe('Idea');

      const plannedRows = releaseRepo.findPage({ status: 'planned', today: '2025-06-15' });
      expect(plannedRows).toHaveLength(1);
      expect(plannedRows[0].title).toBe('Planned');
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
    it('returns total count matching filters', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'R1', status: 'idea' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'R2', status: 'idea' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'R3', status: 'planned' }) });

      expect(releaseRepo.countFiltered({ today: '2025-06-15' })).toBe(3);
      expect(releaseRepo.countFiltered({ status: 'idea', today: '2025-06-15' })).toBe(2);
      expect(releaseRepo.countFiltered({ status: 'planned', today: '2025-06-15' })).toBe(1);
    });

    it('counts only matching project', () => {
      const other = projectRepo.create(sampleProject({ title: 'Other' }));
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Mine' }) });
      releaseRepo.create({ projectId: other.id, ...sampleRelease({ title: 'Other' }) });

      expect(releaseRepo.countFiltered({ projectId, today: '2025-06-15' })).toBe(1);
    });

    it('returns zero for empty result set', () => {
      expect(releaseRepo.countFiltered({ status: 'published', today: '2025-06-15' })).toBe(0);
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
        projectId, ...sampleRelease({ title: 'No Date', status: 'drafting', plannedDate: null }),
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
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Later', status: 'idea', plannedDate: '2025-07-01' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Earlier', status: 'idea', plannedDate: '2025-06-01' }) });

      const rows = releaseRepo.findBoard({ today: '2025-06-15' });
      expect(rows[0].title).toBe('Earlier');
      expect(rows[1].title).toBe('Later');
    });

    it('releases with NULL planned_date sort last', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Has Date', status: 'idea', plannedDate: '2025-06-01' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'No Date', status: 'idea', plannedDate: null }) });

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

  // ─── Phase 6C: Release Planning Views — findCalendarRange ──────────────────

  describe('findCalendarRange', () => {
    it('returns releases with planned_date in [start, end)', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'June 15', status: 'planned', plannedDate: '2025-06-15' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'June 30', status: 'planned', plannedDate: '2025-06-30' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'July 1', status: 'planned', plannedDate: '2025-07-01' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'May 31', status: 'planned', plannedDate: '2025-05-31' }) });

      const rows = releaseRepo.findCalendarRange('2025-06-01', '2025-07-01', {});
      expect(rows.map((r) => r.title).sort()).toEqual(['June 15', 'June 30']);
    });

    it('end-exclusive boundary: release on end date is NOT included', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'July 1', status: 'planned', plannedDate: '2025-07-01' }) });

      const rows = releaseRepo.findCalendarRange('2025-06-01', '2025-07-01', {});
      expect(rows.map((r) => r.title)).toEqual([]);
    });

    it('start-inclusive boundary: release on start date IS included', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'June 1', status: 'planned', plannedDate: '2025-06-01' }) });

      const rows = releaseRepo.findCalendarRange('2025-06-01', '2025-07-01', {});
      expect(rows.map((r) => r.title)).toEqual(['June 1']);
    });

    it('excludes releases without planned_date', () => {
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'No Date', status: 'planned', plannedDate: null }) });

      const rows = releaseRepo.findCalendarRange('2025-06-01', '2025-07-01', {});
      expect(rows.map((r) => r.title)).toEqual([]);
    });

    it('filters by project', () => {
      const other = projectRepo.create(sampleProject({ title: 'Other' }));
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Mine', status: 'planned', plannedDate: '2025-06-15' }) });
      releaseRepo.create({ projectId: other.id, ...sampleRelease({ title: 'Other', status: 'planned', plannedDate: '2025-06-15' }) });

      const rows = releaseRepo.findCalendarRange('2025-06-01', '2025-07-01', { projectId });
      expect(rows.map((r) => r.title)).toEqual(['Mine']);
    });

    it('excludes archived parent releases when activeScheduleFilter is true', () => {
      const hidden = releaseRepo.create({
        projectId, ...sampleRelease({ title: 'Hidden', status: 'planned', plannedDate: '2025-06-15' }),
      });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(projectId);

      const rows = releaseRepo.findCalendarRange('2025-06-01', '2025-07-01', { activeScheduleFilter: true });
      expect(rows.map((r) => r.id)).not.toContain(hidden.id);
    });

    it('leap year February has 29 days (findCalendarRange boundary)', () => {
      // 2024 is a leap year
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Feb 28', status: 'planned', plannedDate: '2024-02-28' }) });
      releaseRepo.create({ projectId, ...sampleRelease({ title: 'Mar 1', status: 'planned', plannedDate: '2024-03-01' }) });

      const rows = releaseRepo.findCalendarRange('2024-02-01', '2024-03-01', {});
      expect(rows.map((r) => r.title)).toEqual(['Feb 28']);
    });

    it('id DESC is the final tie-breaker when planned_date and updated_at match', () => {
      // Insert three releases on the same planned_date with forced identical updated_at.
      const r1 = releaseRepo.create({ projectId, ...sampleRelease({ title: 'First Created', status: 'planned', plannedDate: '2025-06-15' }) });
      const r2 = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Second Created', status: 'planned', plannedDate: '2025-06-15' }) });
      const r3 = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Third Created', status: 'planned', plannedDate: '2025-06-15' }) });

      // Force identical updated_at via direct SQL update.
      db.prepare(`UPDATE releases SET updated_at = '2025-06-01 00:00:00' WHERE id IN (?, ?, ?)`).run(r1.id, r2.id, r3.id);

      const rows = releaseRepo.findCalendarRange('2025-06-01', '2025-07-01', {});
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
      const rel = releaseRepo.create({ projectId, title: 'Release One', status: 'idea', description: '', notes: '' });
      linkAssetToRelease({ releaseId: rel.id, assetId: a.id });

      const results = releaseRepo.findReleaseUsageForAssetIds(projectId, [a.id]);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        asset_id: a.id,
        release_id: rel.id,
        title: 'Release One',
        status: 'idea',
        release_archived_at: null,
        project_archived_at: null,
      });
    });

    it('returns multiple release references for a single asset', () => {
      const a = insertAsset({ projectId, relativePath: 'a.txt', filename: 'a.txt' });
      const r1 = releaseRepo.create({ projectId, title: 'R1', status: 'idea', description: '', notes: '' });
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
      const r1 = releaseRepo.create({ projectId, title: 'R1', status: 'idea', description: '', notes: '' });
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
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url, archived_at)
        VALUES (?, 'Archived Release', '', '', 'idea', NULL, NULL, NULL, '2024-01-01 00:00:00')
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
      const r1 = releaseRepo.create({ projectId, title: 'Alpha', status: 'idea', description: '', notes: '' });
      const r2 = releaseRepo.create({ projectId, title: 'Beta', status: 'idea', description: '', notes: '' });
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
      const rel = releaseRepo.create({ projectId, title: 'R', status: 'idea', description: '', notes: '' });
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
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'Published Release', '', '', 'published', NULL, '2020-01-01', NULL)
        RETURNING id
      `).get(projectId).id;
      const cancelledId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url)
        VALUES (?, 'Cancelled Release', '', '', 'cancelled', NULL, NULL, NULL)
        RETURNING id
      `).get(projectId).id;
      const archivedId = db.prepare(`
        INSERT INTO releases (project_id, title, description, notes, status, planned_date, published_date, patreon_url, archived_at)
        VALUES (?, 'Archived Release', '', '', 'idea', NULL, NULL, NULL, '2024-01-01')
        RETURNING id
      `).get(projectId).id;
      linkAssetToRelease({ releaseId: publishedId, assetId: a.id });
      linkAssetToRelease({ releaseId: cancelledId, assetId: a.id });
      linkAssetToRelease({ releaseId: archivedId, assetId: a.id });

      const results = releaseRepo.findReleaseUsageForAssetIds(projectId, [a.id]);
      expect(results).toHaveLength(3);
      const statuses = results.map((r) => r.status);
      expect(statuses).toContain('published');
      expect(statuses).toContain('cancelled');
      expect(results.find((r) => r.status === 'idea').release_archived_at).toBeTruthy();
    });

    // ─── Phase 6D: Project-scoped release usage ──────────────────────

    it('excludes cross-project junction rows (corrupt data)', () => {
      const otherProject = projectRepo.create(sampleProject({ title: 'Other Project' }));
      const a = insertAsset({ projectId, relativePath: 'a.txt', filename: 'a.txt' });
      const rel = releaseRepo.create({ projectId, title: 'Same Project Release', status: 'idea', description: '', notes: '' });
      linkAssetToRelease({ releaseId: rel.id, assetId: a.id });

      // Create a corrupt cross-project junction: asset from projectId linked
      // to a release from otherProject.
      const otherAsset = insertAsset({ projectId: otherProject.id, relativePath: 'other.txt', filename: 'other.txt' });
      const otherRel = releaseRepo.create({ projectId: otherProject.id, title: 'Other Release', status: 'idea', description: '', notes: '' });
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
      const r1 = releaseRepo.create({ projectId, title: 'Shared Title', status: 'idea', description: '', notes: '' });
      const r2 = releaseRepo.create({ projectId: otherProject.id, title: 'Shared Title', status: 'idea', description: '', notes: '' });
      linkAssetToRelease({ releaseId: r1.id, assetId: a1.id });
      linkAssetToRelease({ releaseId: r2.id, assetId: a2.id });

      // Query scoped to projectId — should only see projectId's link
      const results = releaseRepo.findReleaseUsageForAssetIds(projectId, [a1.id, a2.id]);
      expect(results).toHaveLength(1);
      expect(results[0].asset_id).toBe(a1.id);
      expect(results[0].release_id).toBe(r1.id);
    });
  });

  // ─── Phase 7A-1: Release Readiness Facts ──────────────────────────────

  describe('findReadinessFactsById', () => {
    it('returns undefined for non-existent release ID', () => {
      const facts = releaseRepo.findReadinessFactsById(99999);
      expect(facts).toBeUndefined();
    });

    it('returns zero counts for release with no selected assets', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'No Assets' }) });
      const facts = releaseRepo.findReadinessFactsById(release.id);
      expect(facts.release_id).toBe(release.id);
      expect(facts.project_id).toBe(projectId);
      expect(facts.selected_asset_count).toBe(0);
      expect(facts.present_selected_asset_count).toBe(0);
      expect(facts.missing_selected_asset_count).toBe(0);
      expect(facts.primary_role_count).toBe(0);
      expect(facts.preview_role_count).toBe(0);
      expect(facts.attachment_role_count).toBe(0);
      expect(facts.source_role_count).toBe(0);
    });

    it('returns correct facts for one present asset', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'One Present' }) });
      const asset = assetRepo.upsert(projectId, 'present.txt', sampleAsset(projectId, { relativePath: 'present.txt' }));
      releaseRepo.addReleaseAsset(release.id, asset.id, 'primary', 0);

      const facts = releaseRepo.findReadinessFactsById(release.id);
      expect(facts.selected_asset_count).toBe(1);
      expect(facts.present_selected_asset_count).toBe(1);
      expect(facts.missing_selected_asset_count).toBe(0);
      expect(facts.primary_role_count).toBe(1);
    });

    it('returns correct facts for multiple present assets', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Multi Present' }) });
      const a1 = assetRepo.upsert(projectId, 'a1.txt', sampleAsset(projectId, { relativePath: 'a1.txt' }));
      const a2 = assetRepo.upsert(projectId, 'a2.txt', sampleAsset(projectId, { relativePath: 'a2.txt' }));
      releaseRepo.addReleaseAsset(release.id, a1.id, 'primary', 0);
      releaseRepo.addReleaseAsset(release.id, a2.id, 'attachment', 1);

      const facts = releaseRepo.findReadinessFactsById(release.id);
      expect(facts.selected_asset_count).toBe(2);
      expect(facts.present_selected_asset_count).toBe(2);
      expect(facts.missing_selected_asset_count).toBe(0);
    });

    it('returns correct facts for one missing asset', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'One Missing' }) });
      const asset = assetRepo.upsert(projectId, 'gone.txt', sampleAsset(projectId, { relativePath: 'gone.txt' }));
      releaseRepo.addReleaseAsset(release.id, asset.id, 'preview', 0);
      db.prepare(`UPDATE assets SET is_present = 0, missing_since = datetime('now') WHERE id = ?`).run(asset.id);

      const facts = releaseRepo.findReadinessFactsById(release.id);
      expect(facts.selected_asset_count).toBe(1);
      expect(facts.present_selected_asset_count).toBe(0);
      expect(facts.missing_selected_asset_count).toBe(1);
      expect(facts.preview_role_count).toBe(1);
    });

    it('returns correct facts for multiple missing assets', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Multi Missing' }) });
      const a1 = assetRepo.upsert(projectId, 'g1.txt', sampleAsset(projectId, { relativePath: 'g1.txt' }));
      const a2 = assetRepo.upsert(projectId, 'g2.txt', sampleAsset(projectId, { relativePath: 'g2.txt' }));
      releaseRepo.addReleaseAsset(release.id, a1.id, 'attachment', 0);
      releaseRepo.addReleaseAsset(release.id, a2.id, 'source', 1);
      db.prepare(`UPDATE assets SET is_present = 0, missing_since = datetime('now') WHERE id IN (?, ?)`).run(a1.id, a2.id);

      const facts = releaseRepo.findReadinessFactsById(release.id);
      expect(facts.selected_asset_count).toBe(2);
      expect(facts.present_selected_asset_count).toBe(0);
      expect(facts.missing_selected_asset_count).toBe(2);
    });

    it('returns correct facts for mixed present and missing assets', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Mixed' }) });
      const present = assetRepo.upsert(projectId, 'present.txt', sampleAsset(projectId, { relativePath: 'present.txt' }));
      const missing = assetRepo.upsert(projectId, 'missing.txt', sampleAsset(projectId, { relativePath: 'missing.txt' }));
      releaseRepo.addReleaseAsset(release.id, present.id, 'primary', 0);
      releaseRepo.addReleaseAsset(release.id, missing.id, 'attachment', 1);
      db.prepare(`UPDATE assets SET is_present = 0, missing_since = datetime('now') WHERE id = ?`).run(missing.id);

      const facts = releaseRepo.findReadinessFactsById(release.id);
      expect(facts.selected_asset_count).toBe(2);
      expect(facts.present_selected_asset_count).toBe(1);
      expect(facts.missing_selected_asset_count).toBe(1);
    });

    it('returns correct role counts for every role', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'All Roles' }) });
      const primary = assetRepo.upsert(projectId, 'primary.txt', sampleAsset(projectId, { relativePath: 'primary.txt' }));
      const preview = assetRepo.upsert(projectId, 'preview.txt', sampleAsset(projectId, { relativePath: 'preview.txt' }));
      const attachment = assetRepo.upsert(projectId, 'attachment.txt', sampleAsset(projectId, { relativePath: 'attachment.txt' }));
      const source = assetRepo.upsert(projectId, 'source.txt', sampleAsset(projectId, { relativePath: 'source.txt' }));
      releaseRepo.addReleaseAsset(release.id, primary.id, 'primary', 0);
      releaseRepo.addReleaseAsset(release.id, preview.id, 'preview', 1);
      releaseRepo.addReleaseAsset(release.id, attachment.id, 'attachment', 2);
      releaseRepo.addReleaseAsset(release.id, source.id, 'source', 3);

      const facts = releaseRepo.findReadinessFactsById(release.id);
      expect(facts.primary_role_count).toBe(1);
      expect(facts.preview_role_count).toBe(1);
      expect(facts.attachment_role_count).toBe(1);
      expect(facts.source_role_count).toBe(1);
      expect(facts.selected_asset_count).toBe(4);
    });

    it('returns release_archived_at for archived release', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Archived Release' }) });
      releaseRepo.archive(release.id);

      const facts = releaseRepo.findReadinessFactsById(release.id);
      expect(facts.release_archived_at).toBeTruthy();
      expect(facts.release_status).toBe('idea');
    });

    it('returns project_archived_at for archived parent project', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Archived Parent' }) });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(projectId);

      const facts = releaseRepo.findReadinessFactsById(release.id);
      expect(facts.project_archived_at).toBeTruthy();
    });

    it('ignores corrupt cross-project junction rows', () => {
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Cross Project' }) });
      const ourAsset = assetRepo.upsert(projectId, 'ours.txt', sampleAsset(projectId, { relativePath: 'ours.txt' }));
      const otherAsset = assetRepo.upsert(otherProject.id, 'theirs.txt', sampleAsset(otherProject.id, { relativePath: 'theirs.txt' }));

      // Legitimate link
      releaseRepo.addReleaseAsset(release.id, ourAsset.id, 'primary', 0);
      // Corrupt cross-project link: other project's asset linked to our release
      db.prepare(`
        INSERT INTO release_assets (release_id, asset_id, role, sort_order)
        VALUES (?, ?, 'attachment', 1)
      `).run(release.id, otherAsset.id);

      const facts = releaseRepo.findReadinessFactsById(release.id);
      // Only ourAsset should be counted — otherAsset is filtered out by the
      // a.project_id = r.project_id guard in the LEFT JOIN.
      expect(facts.selected_asset_count).toBe(1);
      expect(facts.primary_role_count).toBe(1);
      expect(facts.attachment_role_count).toBe(0);
    });

    it('does not duplicate counts when same asset is linked multiple times', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'No Duplicates' }) });
      const asset = assetRepo.upsert(projectId, 'unique.txt', sampleAsset(projectId, { relativePath: 'unique.txt' }));
      releaseRepo.addReleaseAsset(release.id, asset.id, 'primary', 0);

      // Attempt duplicate link (should fail due to PK constraint)
      expect(() => {
        releaseRepo.addReleaseAsset(release.id, asset.id, 'preview', 1);
      }).toThrow();

      const facts = releaseRepo.findReadinessFactsById(release.id);
      expect(facts.selected_asset_count).toBe(1);
      expect(facts.primary_role_count).toBe(1);
      expect(facts.preview_role_count).toBe(0);
    });

    // ─── Phase 7A regression: malformed duplicate junction rows ──────
    //
    // A database with duplicate (release_id, asset_id) rows in
    // release_assets must not inflate readiness counts. The normal
    // composite PK prevents this, but a malformed database (e.g. from
    // a manual edit, a bug in a past migration, or a partial restore)
    // could have duplicates. The aggregates use COUNT(DISTINCT a.id) to
    // remain correct regardless.

    it('handles malformed duplicate release_assets rows without inflating counts', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Dup Test' }) });
      const asset = assetRepo.upsert(projectId, 'unique.txt', sampleAsset(projectId, { relativePath: 'unique.txt' }));

      // Bypass the composite PK constraint by creating a table without it
      db.exec(`
        CREATE TEMP TABLE release_assets_dup (
          release_id INTEGER NOT NULL,
          asset_id INTEGER NOT NULL,
          role TEXT NOT NULL DEFAULT 'attachment',
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      // Insert the same asset twice with the same role
      db.exec(`INSERT INTO release_assets_dup (release_id, asset_id, role, sort_order) VALUES (${release.id}, ${asset.id}, 'primary', 0)`);
      db.exec(`INSERT INTO release_assets_dup (release_id, asset_id, role, sort_order) VALUES (${release.id}, ${asset.id}, 'primary', 0)`);
      // Swap tables
      db.exec(`DROP TABLE release_assets`);
      db.exec(`ALTER TABLE release_assets_dup RENAME TO release_assets`);

      const facts = releaseRepo.findReadinessFactsById(release.id);
      expect(facts.selected_asset_count).toBe(1);
      expect(facts.present_selected_asset_count).toBe(1);
      expect(facts.missing_selected_asset_count).toBe(0);
      expect(facts.primary_role_count).toBe(1);
      expect(facts.preview_role_count).toBe(0);
      expect(facts.attachment_role_count).toBe(0);
      expect(facts.source_role_count).toBe(0);
    });

    it('genuinely distinct assets still count separately alongside duplicate guard', () => {
      const release = releaseRepo.create({ projectId, ...sampleRelease({ title: 'Distinct Control' }) });
      const a1 = assetRepo.upsert(projectId, 'a1.txt', sampleAsset(projectId, { relativePath: 'a1.txt' }));
      const a2 = assetRepo.upsert(projectId, 'a2.txt', sampleAsset(projectId, { relativePath: 'a2.txt' }));
      const a3 = assetRepo.upsert(projectId, 'a3.txt', sampleAsset(projectId, { relativePath: 'a3.txt' }));

      // Bypass PK to create one duplicate and two distinct rows
      db.exec(`
        CREATE TEMP TABLE release_assets_dup (
          release_id INTEGER NOT NULL,
          asset_id INTEGER NOT NULL,
          role TEXT NOT NULL DEFAULT 'attachment',
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      // a1 duplicated, a2 and a3 distinct
      db.exec(`INSERT INTO release_assets_dup (release_id, asset_id, role, sort_order) VALUES (${release.id}, ${a1.id}, 'primary', 0)`);
      db.exec(`INSERT INTO release_assets_dup (release_id, asset_id, role, sort_order) VALUES (${release.id}, ${a1.id}, 'primary', 0)`);
      db.exec(`INSERT INTO release_assets_dup (release_id, asset_id, role, sort_order) VALUES (${release.id}, ${a2.id}, 'attachment', 1)`);
      db.exec(`INSERT INTO release_assets_dup (release_id, asset_id, role, sort_order) VALUES (${release.id}, ${a3.id}, 'source', 2)`);
      db.exec(`DROP TABLE release_assets`);
      db.exec(`ALTER TABLE release_assets_dup RENAME TO release_assets`);

      const facts = releaseRepo.findReadinessFactsById(release.id);
      // 3 distinct assets despite 4 rows
      expect(facts.selected_asset_count).toBe(3);
      expect(facts.present_selected_asset_count).toBe(3);
      expect(facts.missing_selected_asset_count).toBe(0);
      // Role counts: primary=1 (a1), attachment=1 (a2), source=1 (a3)
      expect(facts.primary_role_count).toBe(1);
      expect(facts.preview_role_count).toBe(0);
      expect(facts.attachment_role_count).toBe(1);
      expect(facts.source_role_count).toBe(1);
    });
  });
});
