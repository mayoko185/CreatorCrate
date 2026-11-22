import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createReleaseService, ReleaseValidationError, ReleaseNotFoundError, ReleaseArchivedError, ReleaseParentArchivedError, ReleasePublishedError, AssetNotFoundError } from '../src/services/release-service.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createReleaseRepository } from '../src/data/release-repository.js';
import { createSocialPrepRepository } from '../src/data/social-prep-repository.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { AssetCategoryNotFoundError } from '../src/services/asset-category-service.js';
import { AssetCategoryValidationError } from '../src/services/asset-category-validation.js';
import { getLocalTodayIso } from '../src/util/date.js';
import { createApplicationLogger } from '../src/services/application-logger.js';
import { createApplicationLogRepository } from '../src/data/application-log-repository.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { createProjectImageSettingsService } from '../src/services/project-image-settings-service.js';
import { projectImagePresentationPolicy } from '../src/services/project-image-policy.js';
import { buildReleaseAssetPagePresentation } from '../src/services/release-asset-presenter.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function sampleProject(overrides = {}) {
  const title = overrides.title ?? 'Test Project';
  return {
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
  };
}

function validInput(overrides = {}) {
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

/**
 * Create a release with a selected present asset. Returns { release, asset }.
 */
function createPublishableRelease(service, assetRepo, projectId, inputOverrides = {}) {
  const release = service.createRelease(projectId, validInput(inputOverrides));
  const asset = assetRepo.upsert(projectId, 'pub-asset.txt', sampleAsset(projectId, { relativePath: 'pub-asset.txt' }));
  service.selectAssets(release.id, [{ assetId: asset.id, role: 'primary', sortOrder: 0 }]);
  return { release, asset };
}

function snapshotReleaseRow(db, releaseId) {
  return db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
}

describe('release service', () => {
  let tmpDir;
  let dbPath;
  let db;
  let service;
  let projectRepo;
  let assetRepo;
  let categoryRepo;
  let projectId;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-svc-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    service = createReleaseService({ db });
    projectRepo = createProjectRepository(db);
    assetRepo = createAssetRepository(db);
    categoryRepo = createAssetCategoryRepository(db);
    const project = projectRepo.create(sampleProject({ title: 'Parent Project' }));
    projectId = project.id;
    db.prepare("UPDATE projects SET status = 'ready' WHERE id = ?").run(projectId);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('createRelease', () => {
    it('creates a release for a valid project', () => {
      const release = service.createRelease(projectId, validInput({ title: 'New Release' }));
      expect(release.title).toBe('New Release');
      expect(release.project_id).toBe(projectId);
    });

    it('ignores an obsolete submitted status and stores scheduled date and time separately', () => {
      const input = validInput({
        title: 'Scheduled Release',
        status: 'obsolete',
        plannedDate: '2026-08-15',
        plannedTime: '09:45',
      });

      const release = service.createRelease(projectId, input);

      expect(release).not.toHaveProperty('status');
      expect(release.planned_date).toBe('2026-08-15');
      expect(release.planned_time).toBe('09:45');
      expect(snapshotReleaseRow(db, release.id)).toMatchObject({
        planned_date: '2026-08-15',
        planned_time: '09:45',
      });
      expect(snapshotReleaseRow(db, release.id)).not.toHaveProperty('status');
    });

    it('does not pass an obsolete status property to repository create or update', () => {
      const createSpy = vi.spyOn(service.repository, 'create');
      const created = service.createRelease(projectId, validInput({ status: 'stale' }));
      const createInput = createSpy.mock.calls[0][0];

      expect(createInput).not.toHaveProperty('status');

      const updateSpy = vi.spyOn(service.repository, 'update');
      service.updateRelease(created.id, validInput({ title: 'Updated', status: 'stale-again' }));
      const updateInput = updateSpy.mock.calls[0][1];

      expect(updateInput).not.toHaveProperty('status');
    });

    it('rejects an invalid scheduled time', () => {
      expect(() => service.createRelease(projectId, validInput({ plannedTime: '24:00' })))
        .toThrow(ReleaseValidationError);
    });

    it('throws if project does not exist', () => {
      expect(() => {
        service.createRelease(99999, validInput());
      }).toThrow(ReleaseValidationError);
    });

    it('throws if project is archived', () => {
      const archivedProject = projectRepo.create(sampleProject({ title: 'Archived' }));
      projectRepo.archive(archivedProject.id);
      expect(() => {
        service.createRelease(archivedProject.id, validInput());
      }).toThrow(ReleaseValidationError);
    });

    it('rejects title exceeding max length', () => {
      const longTitle = 'a'.repeat(201);
      expect(() => {
        service.createRelease(projectId, validInput({ title: longTitle }));
      }).toThrow(ReleaseValidationError);
    });

    it('rejects empty title', () => {
      expect(() => {
        service.createRelease(projectId, validInput({ title: '' }));
      }).toThrow(ReleaseValidationError);
    });

    it('rejects title that is only whitespace', () => {
      expect(() => {
        service.createRelease(projectId, validInput({ title: '   ' }));
      }).toThrow(ReleaseValidationError);
    });

    it('rejects invalid planned_date format', () => {
      expect(() => {
        service.createRelease(projectId, validInput({ plannedDate: '2025/06/15' }));
      }).toThrow(ReleaseValidationError);
      expect(() => {
        service.createRelease(projectId, validInput({ plannedDate: '06-15-2025' }));
      }).toThrow(ReleaseValidationError);
      expect(() => {
        service.createRelease(projectId, validInput({ plannedDate: '2025-13-01' }));
      }).toThrow(ReleaseValidationError);
      expect(() => {
        service.createRelease(projectId, validInput({ plannedDate: '2025-02-30' }));
      }).toThrow(ReleaseValidationError);
    });

    it.each([
      { url: 'https://example.com/release', label: 'non-Patreon HTTPS URL' },
      { url: 'http://example.com/release', label: 'HTTP URL' },
      { url: 'https://patreon.com/user', label: 'Patreon URL' },
      { url: 'https://mysite.patreon.com/user', label: 'Patreon subdomain URL' },
    ])('accepts a valid $label', ({ url }) => {
      const release = service.createRelease(projectId, validInput({ patreonUrl: url }));
      expect(release.patreon_url).toBe(url);
    });

    it.each([
      { url: 'not-a-url', label: 'URL without a protocol' },
      { url: 'javascript:alert(1)', label: 'unsafe protocol' },
      { url: 'ftp://example.com/release', label: 'unsupported protocol' },
      { url: 'https://[invalid', label: 'malformed URL' },
    ])('rejects a $label', ({ url }) => {
      expect(() => {
        service.createRelease(projectId, validInput({ patreonUrl: url }));
      }).toThrow(ReleaseValidationError);
    });

    it('allows an empty optional release link', () => {
      const release = service.createRelease(projectId, validInput({ patreonUrl: '' }));
      expect(release.patreon_url).toBeNull();
    });

    it('validates the release link on update', () => {
      const created = service.createRelease(projectId, validInput());
      const updated = service.updateRelease(created.id, validInput({ patreonUrl: 'http://example.com/edit' }));
      expect(updated.patreon_url).toBe('http://example.com/edit');

      expect(() => service.updateRelease(created.id, validInput({ patreonUrl: 'file:///tmp/release' }))).toThrow(
        ReleaseValidationError
      );
    });

    it('rejects description exceeding max length', () => {
      const longDesc = 'a'.repeat(4001);
      expect(() => {
        service.createRelease(projectId, validInput({ description: longDesc }));
      }).toThrow(ReleaseValidationError);
    });

    it('rejects notes exceeding max length', () => {
      const longNotes = 'a'.repeat(10001);
      expect(() => {
        service.createRelease(projectId, validInput({ notes: longNotes }));
      }).toThrow(ReleaseValidationError);
    });
  });

  describe('createReleaseFromCategory', () => {
    function addCategory(project, displayName, directorySlug, displayOrder = 0) {
      return categoryRepo.addProjectCategory({
        projectId: project,
        displayName,
        directorySlug,
        displayOrder,
        enabled: true,
      });
    }

    function addAsset(project, filename, categoryId) {
      const data = sampleAsset(project, { relativePath: filename, filename });
      data.categoryId = categoryId;
      return assetRepo.upsert(project, filename, data);
    }

    it('creates exactly one release titled from the project category without a status field', () => {
      const category = addCategory(projectId, 'Launch Assets', 'launch-assets');

      const release = service.createReleaseFromCategory(projectId, category.id);

      expect(release).toMatchObject({
        project_id: projectId,
        title: 'Launch Assets',
      });
      expect(release).not.toHaveProperty('status');
      expect(release.id).toBeTruthy();
      expect(service.listReleases(projectId, { includeArchived: true })).toHaveLength(1);
    });

    it('uses the existing local new-release date and time defaults', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 4, 14, 30));

      try {
        const category = addCategory(projectId, 'Scheduled Assets', 'scheduled-assets');
        const release = service.createReleaseFromCategory(projectId, category.id);

        expect(release.planned_date).toBe('2026-08-04');
        expect(release.planned_time).toBe('14:30');
      } finally {
        vi.useRealTimers();
      }
    });

    it('selects only present category assets in canonical deterministic contiguous order', () => {
      const category = addCategory(projectId, 'Ordered Assets', 'ordered-assets');
      const zeta = addAsset(projectId, 'zeta.txt', category.id);
      const alpha = addAsset(projectId, 'alpha.txt', category.id);
      const alphaTie = addAsset(projectId, 'Alpha.txt', category.id);
      const missing = addAsset(projectId, 'missing.txt', category.id);
      const otherCategory = addCategory(projectId, 'Other Assets', 'other-assets', 1);
      const otherCategoryAsset = addAsset(projectId, 'other.txt', otherCategory.id);
      const otherProject = projectRepo.create(sampleProject({ title: 'Other Project' }));
      const foreignCategory = addCategory(otherProject.id, 'Foreign Assets', 'foreign-assets');
      const foreignAsset = addAsset(otherProject.id, 'foreign.txt', foreignCategory.id);
      db.prepare('UPDATE assets SET is_present = 0 WHERE id = ?').run(missing.id);

      const assetsBefore = db.prepare(
        'SELECT id, project_id, category_id, relative_path, is_present FROM assets ORDER BY id'
      ).all();
      const categoryBefore = categoryRepo.findProjectCategoryById(projectId, category.id);

      const release = service.createReleaseFromCategory(projectId, category.id);
      const selections = service.listReleaseAssets(release.id);

      expect(selections.map((selection) => selection.asset_id)).toEqual([
        alpha.id,
        alphaTie.id,
        zeta.id,
      ]);
      expect(selections.map((selection) => selection.sort_order)).toEqual([0, 1, 2]);
      expect(selections.every((selection) => selection.role === 'attachment')).toBe(true);
      expect(selections.map((selection) => selection.asset_id)).not.toContain(missing.id);
      expect(selections.map((selection) => selection.asset_id)).not.toContain(otherCategoryAsset.id);
      expect(selections.map((selection) => selection.asset_id)).not.toContain(foreignAsset.id);
      expect(db.prepare(
        'SELECT id, project_id, category_id, relative_path, is_present FROM assets ORDER BY id'
      ).all()).toEqual(assetsBefore);
      expect(categoryRepo.findProjectCategoryById(projectId, category.id)).toEqual(categoryBefore);
    });

    it('creates a release with no selected assets for an empty category', () => {
      const category = addCategory(projectId, 'Empty Assets', 'empty-assets');

      const release = service.createReleaseFromCategory(projectId, category.id);

      expect(service.listReleaseAssets(release.id)).toEqual([]);
    });

    it('rejects a missing or cross-project category', () => {
      const otherProject = projectRepo.create(sampleProject({ title: 'Other Category Project' }));
      const foreignCategory = addCategory(otherProject.id, 'Foreign Assets', 'foreign-assets');

      expect(() => service.createReleaseFromCategory(projectId, 999999))
        .toThrow(AssetCategoryNotFoundError);
      expect(() => service.createReleaseFromCategory(projectId, foreignCategory.id))
        .toThrow(AssetCategoryNotFoundError);
      expect(service.listReleases(projectId, { includeArchived: true })).toEqual([]);
    });
  });

  describe('createReleaseFromAssets', () => {
    function addPresentAsset(relativePath) {
      return assetRepo.upsert(projectId, relativePath, sampleAsset(projectId, { relativePath }));
    }

    it('creates an ordered release from multiple present assets and deduplicates IDs', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 4, 14, 30));

      try {
        const first = addPresentAsset('first.txt');
        const second = addPresentAsset('second.txt');

        const release = service.createReleaseFromAssets(
          String(projectId),
          [String(second.id), first.id, second.id],
        );

        expect(release).toMatchObject({
          project_id: projectId,
          title: 'Parent Project',
          planned_date: '2026-08-04',
          planned_time: '14:30',
        });
        expect(release).not.toHaveProperty('status');
        expect(service.listReleaseAssets(release.id).map((asset) => ({
          asset_id: asset.asset_id,
          role: asset.role,
          sort_order: asset.sort_order,
        }))).toEqual([
          { asset_id: second.id, role: 'attachment', sort_order: 0 },
          { asset_id: first.id, role: 'attachment', sort_order: 1 },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      { label: 'a non-array', value: 'not-an-array' },
      { label: 'an empty array', value: [] },
      { label: 'a malformed ID', value: ['abc'] },
      { label: 'a fractional ID', value: [1.5] },
      { label: 'a zero ID', value: [0] },
      { label: 'a negative ID', value: [-1] },
    ])('rejects $label before creating a release', ({ value }) => {
      expect(() => service.createReleaseFromAssets(projectId, value)).toThrow(ReleaseValidationError);
      expect(service.listReleases(projectId, { includeArchived: true })).toEqual([]);
    });

    it('rejects unknown, cross-project, and missing assets before creating a release', () => {
      const otherProject = projectRepo.create(sampleProject({ title: 'Other Project' }));
      const foreign = assetRepo.upsert(
        otherProject.id,
        'foreign.txt',
        sampleAsset(otherProject.id, { relativePath: 'foreign.txt' }),
      );
      const missing = addPresentAsset('missing.txt');
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, []);

      expect(() => service.createReleaseFromAssets(projectId, [999999])).toThrow(AssetNotFoundError);
      expect(() => service.createReleaseFromAssets(projectId, [foreign.id])).toThrow(ReleaseValidationError);
      expect(() => service.createReleaseFromAssets(projectId, [missing.id])).toThrow(ReleaseValidationError);
      expect(service.listReleases(projectId, { includeArchived: true })).toEqual([]);
    });

    it('preserves archived-project rejection behavior', () => {
      const asset = addPresentAsset('archived.txt');
      projectRepo.archive(projectId);

      expect(() => service.createReleaseFromAssets(projectId, [asset.id])).toThrow(ReleaseValidationError);
      expect(service.listReleases(projectId, { includeArchived: true })).toEqual([]);
    });
  });

  describe('createReleaseWithSelectedAssets', () => {
    it('saves the selected-assets release and platform selection together', () => {
      const asset = assetRepo.upsert(projectId, 'platform-asset.txt', sampleAsset(projectId, { relativePath: 'platform-asset.txt' }));
      const releases = createReleaseService({ db, socialPrepSettingsService: { getPlatforms: () => ['x'] } });
      const release = releases.createReleaseWithSelectedAssets(
        projectId, validInput({ selectedPlatforms: ['x'] }), [asset.id],
      );
      expect(releases.listReleaseAssets(release.id).map((row) => row.asset_id)).toEqual([asset.id]);
      expect(createSocialPrepRepository(db).listPlatformsByReleaseId(release.id).filter((row) => row.is_selected)
        .map((row) => row.platform)).toEqual(['x']);
    });

    it('creates an ordered selected-assets release atomically without a status field', () => {
      const first = assetRepo.upsert(projectId, 'first.txt', sampleAsset(projectId, { relativePath: 'first.txt' }));
      const second = assetRepo.upsert(projectId, 'second.txt', sampleAsset(projectId, { relativePath: 'second.txt' }));
      const createSpy = vi.spyOn(service.repository, 'createWithAssetSelections');

      const release = service.createReleaseWithSelectedAssets(
        projectId,
        validInput({ title: 'Selected Assets', status: 'published' }),
        [second.id, first.id],
      );

      expect(release).not.toHaveProperty('status');
      expect(createSpy.mock.calls[0][0]).not.toHaveProperty('status');
      expect(service.listReleaseAssets(release.id).map((asset) => asset.asset_id)).toEqual([second.id, first.id]);
    });
  });

  describe('updateRelease', () => {
    it('retains or removes a saved unconfigured platform without allowing new unconfigured selections', () => {
      let configured = ['x', 'bluesky'];
      const releases = createReleaseService({ db, socialPrepSettingsService: { getPlatforms: () => configured } });
      const platforms = createSocialPrepRepository(db);
      const first = releases.createRelease(projectId, validInput({ title: 'First', selectedPlatforms: ['x'] }));
      const second = releases.createRelease(projectId, validInput({ title: 'Second' }));
      configured = ['bluesky'];

      releases.updateRelease(first.id, validInput({ title: 'Edited', selectedPlatforms: ['x'] }));
      expect(releases.findRelease(first.id).title).toBe('Edited');
      expect(platforms.listPlatformsByReleaseId(first.id).find((row) => row.platform === 'x').is_selected).toBe(1);
      for (const [releaseId, selection] of [[first.id, ['x', 'bogus']], [second.id, ['x']]]) {
        expect(() => releases.updateRelease(releaseId, validInput({ title: 'Rejected', selectedPlatforms: selection })))
          .toThrow(expect.objectContaining({ errors: { selectedPlatforms: 'Select valid configured platforms.' } }));
      }
      expect(() => releases.createRelease(projectId, validInput({ selectedPlatforms: ['x'] })))
        .toThrow(expect.objectContaining({ errors: { selectedPlatforms: 'Select valid configured platforms.' } }));
      expect(releases.findRelease(first.id).title).toBe('Edited');
      expect(releases.findRelease(second.id).title).toBe('Second');

      releases.updateRelease(first.id, validInput({ selectedPlatforms: [] }));
      expect(platforms.listPlatformsByReleaseId(first.id).find((row) => row.platform === 'x').is_selected).toBe(0);
      expect(() => releases.updateRelease(first.id, validInput({ selectedPlatforms: ['x'] })))
        .toThrow(expect.objectContaining({ errors: { selectedPlatforms: 'Select valid configured platforms.' } }));
    });

    it('saves exact configured platform selections with release metadata and preserves them when omitted', () => {
      const releases = createReleaseService({
        db, socialPrepSettingsService: { getPlatforms: () => ['patreon', 'x', 'bluesky'] },
      });
      const platforms = createSocialPrepRepository(db);
      const release = releases.createRelease(projectId, validInput({ selectedPlatforms: ['patreon', 'x'] }));
      expect(platforms.listPlatformsByReleaseId(release.id).filter((row) => row.is_selected).map((row) => row.platform))
        .toEqual(['patreon', 'x']);

      releases.updateRelease(release.id, validInput({ title: 'Edited', selectedPlatforms: ['x', 'bluesky'] }));
      expect(platforms.listPlatformsByReleaseId(release.id).filter((row) => row.is_selected).map((row) => row.platform))
        .toEqual(['bluesky', 'x']);
      releases.updateRelease(release.id, validInput({ title: 'Omitted' }));
      expect(platforms.listPlatformsByReleaseId(release.id).filter((row) => row.is_selected).map((row) => row.platform))
        .toEqual(['bluesky', 'x']);
      releases.updateRelease(release.id, validInput({ selectedPlatforms: [] }));
      expect(platforms.listPlatformsByReleaseId(release.id).filter((row) => row.is_selected)).toEqual([]);
      expect(platforms.listPlatformsByReleaseId(release.id).find((row) => row.platform === 'patreon').is_selected).toBe(0);
      expect(() => releases.createRelease(projectId, validInput({ selectedPlatforms: ['unknown'] })))
        .toThrow(expect.objectContaining({ errors: { selectedPlatforms: 'Select valid configured platforms.' } }));
    });

    it('rolls metadata back when an active session blocks platform deselection', () => {
      const releases = createReleaseService({
        db, socialPrepSettingsService: { getPlatforms: () => ['x', 'bluesky'] },
      });
      const platforms = createSocialPrepRepository(db);
      const release = releases.createRelease(projectId, validInput({ title: 'Before', selectedPlatforms: ['x'] }));
      platforms.insertSession({ id: 'active', releaseId: release.id, kind: 'initial', expiresAt: new Date('2030-01-01') });
      platforms.reassignPlatformsToSession('active', ['x']);
      expect(() => releases.updateRelease(release.id, validInput({ title: 'After', selectedPlatforms: ['bluesky'] })))
        .toThrow(expect.objectContaining({ errors: {
          selectedPlatforms: 'Cannot deselect a platform while its preparation session is active.',
        } }));
      expect(releases.findRelease(release.id).title).toBe('Before');
      expect(platforms.listPlatformsByReleaseId(release.id).map((row) => row.platform)).toEqual(['x']);
    });

    it('updates a release', () => {
      const created = service.createRelease(projectId, validInput({ title: 'Original' }));
      const updated = service.updateRelease(created.id, validInput({ title: 'Updated' }));
      expect(updated.title).toBe('Updated');
    });

    it('updates metadata when status is omitted and ignores an obsolete submitted status', () => {
      const created = service.createRelease(projectId, validInput({
        title: 'Original',
        plannedDate: '2026-08-01',
        plannedTime: '08:00',
      }));
      const input = validInput({
        title: 'Updated',
        status: 'obsolete',
        plannedDate: '2026-08-15',
        plannedTime: '09:45',
      });

      const updated = service.updateRelease(created.id, input);

      expect(updated).not.toHaveProperty('status');
      expect(updated.planned_date).toBe('2026-08-15');
      expect(updated.planned_time).toBe('09:45');
      expect(snapshotReleaseRow(db, created.id)).not.toHaveProperty('status');
    });

    it('throws ReleaseNotFoundError for non-existent id', () => {
      expect(() => {
        service.updateRelease(99999, validInput());
      }).toThrow(ReleaseNotFoundError);
    });

    it('throws ReleaseParentArchivedError if project was archived after release creation', () => {
      const created = service.createRelease(projectId, validInput());
      projectRepo.archive(projectId);
      expect(() => {
        service.updateRelease(created.id, validInput({ title: 'Should Fail' }));
      }).toThrow(ReleaseParentArchivedError);
    });

    it('throws ReleaseArchivedError when updating an archived release', () => {
      const created = service.createRelease(projectId, validInput({ title: 'Original' }));
      service.archiveRelease(created.id);
      expect(() => {
        service.updateRelease(created.id, validInput({ title: 'Should Not Update' }));
      }).toThrow(ReleaseArchivedError);
    });
  });

  describe('publishRelease', () => {
    function selectAssetForRelease(releaseId) {
      const asset = assetRepo.upsert(projectId, 'publish-test.txt', sampleAsset(projectId, { relativePath: 'publish-test.txt' }));
      service.selectAssets(releaseId, [{ assetId: asset.id, role: 'primary', sortOrder: 0 }]);
      return asset;
    }

    it('publishes a release with default date (today)', () => {
      const created = service.createRelease(projectId, validInput());
      selectAssetForRelease(created.id);
      const published = service.publishRelease(created.id);
      expect(published).not.toHaveProperty('status');
      expect(published.published_date).toBeTruthy();
    });

    it('publishes a release with specified date', () => {
      const created = service.createRelease(projectId, validInput());
      selectAssetForRelease(created.id);
      const published = service.publishRelease(created.id, '2025-06-15');
      expect(published).not.toHaveProperty('status');
      expect(published.published_date).toBe('2025-06-15');
    });

    it('throws ReleaseNotFoundError for non-existent id', () => {
      expect(() => {
        service.publishRelease(99999);
      }).toThrow(ReleaseNotFoundError);
    });

    it('throws if release is already published', () => {
      const created = service.createRelease(projectId, validInput());
      selectAssetForRelease(created.id);
      service.publishRelease(created.id);
      const before = snapshotReleaseRow(db, created.id);
      expect(() => {
        service.publishRelease(created.id);
      }).toThrow(ReleaseValidationError);
      expect(snapshotReleaseRow(db, created.id)).toEqual(before);
    });

    it('publishes when the owning project is not ready', () => {
      db.prepare("UPDATE projects SET status = 'tbd' WHERE id = ?").run(projectId);
      const created = service.createRelease(projectId, validInput());
      selectAssetForRelease(created.id);

      const published = service.publishRelease(created.id, '2025-06-15');

      expect(published.published_date).toBe('2025-06-15');
    });

    it('throws if release is archived', () => {
      const created = service.createRelease(projectId, validInput());
      service.archiveRelease(created.id);
      expect(() => {
        service.publishRelease(created.id);
      }).toThrow(ReleaseArchivedError);
    });

    it('keeps ordinary published-date validation free of readiness payloads', () => {
      const created = service.createRelease(projectId, validInput());
      selectAssetForRelease(created.id);

      for (const date of ['invalid', '2025-13-01']) {
        try {
          service.publishRelease(created.id, date);
          expect.fail('Expected invalid published date to be rejected');
        } catch (err) {
          expect(err).toBeInstanceOf(ReleaseValidationError);
          expect(err.errors).toEqual({
            publishedDate: 'Published date must be a valid date (YYYY-MM-DD).',
          });
          expect(err.errors).not.toHaveProperty('readiness');
        }
      }
    });

    it('publishes with zero selected assets without a readiness restriction', () => {
      const created = service.createRelease(projectId, validInput({
        title: 'Zero Asset Release',
      }));

      const published = service.publishRelease(created.id, '2025-06-15');

      expect(published.published_date).toBe('2025-06-15');
    });

    it('publishes with a selected asset that later becomes missing', () => {
      const { release } = createPublishableRelease(service, assetRepo, projectId, {
        title: 'Missing Asset Release',
      });
      // Mark the selected asset as missing
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, []);

      const published = service.publishRelease(release.id, '2025-06-15');

      expect(published.published_date).toBe('2025-06-15');
    });

    it('rejects publish when release is archived without changing the complete release row', () => {
      const { release } = createPublishableRelease(service, assetRepo, projectId, {
        title: 'Archived Release',
        description: 'Description before archived rejection',
        notes: 'Notes before archived rejection',
        plannedDate: '2025-06-15',
        patreonUrl: 'https://patreon.com/creator',
      });
      service.archiveRelease(release.id);
      const before = snapshotReleaseRow(db, release.id);

      expect(() => {
        service.publishRelease(release.id);
      }).toThrow(ReleaseArchivedError);

      expect(snapshotReleaseRow(db, release.id)).toEqual(before);
    });

    it('rejects publish when parent project is archived without changing the complete release row', () => {
      const { release } = createPublishableRelease(service, assetRepo, projectId, {
        title: 'Archived Parent Release',
        description: 'Description before archived parent rejection',
        notes: 'Notes before archived parent rejection',
        plannedDate: '2025-06-15',
        patreonUrl: 'https://patreon.com/creator',
      });
      projectRepo.archive(projectId);
      const before = snapshotReleaseRow(db, release.id);

      expect(() => {
        service.publishRelease(release.id);
      }).toThrow(ReleaseParentArchivedError);

      expect(snapshotReleaseRow(db, release.id)).toEqual(before);
    });

    it('publishes without Readiness machinery', () => {
      const created = service.createRelease(projectId, validInput({
        title: 'No Readiness Dependency Release',
      }));

      const published = service.publishRelease(created.id, '2025-06-15');

      expect(published.published_date).toBe('2025-06-15');
      expect(published).not.toHaveProperty('publishable');
      expect(published).not.toHaveProperty('checks');
      expect(published).not.toHaveProperty('readiness');
    });
  });

  describe('archiveRelease', () => {
    it('archives a release', () => {
      const created = service.createRelease(projectId, validInput());
      const archived = service.archiveRelease(created.id);
      expect(archived.archived_at).toBeTruthy();
    });

    it('throws ReleaseNotFoundError for non-existent id', () => {
      expect(() => {
        service.archiveRelease(99999);
      }).toThrow(ReleaseNotFoundError);
    });

    it('throws if release is already archived', () => {
      const created = service.createRelease(projectId, validInput());
      service.archiveRelease(created.id);
      expect(() => {
        service.archiveRelease(created.id);
      }).toThrow(ReleaseArchivedError);
    });

    it('archives without exposing a release-owned status field', () => {
      const created = service.createRelease(projectId, validInput());
      const archived = service.archiveRelease(created.id);
      expect(archived).not.toHaveProperty('status');
      expect(archived.archived_at).toBeTruthy();
    });
  });

  describe('deleteRelease', () => {
    it('permanently deletes a release', () => {
      const created = service.createRelease(projectId, validInput());
      const deleted = service.deleteRelease(created.id);
      expect(deleted).toBe(true);
      expect(service.findRelease(created.id)).toBeUndefined();
    });

    it('throws ReleaseNotFoundError for non-existent id', () => {
      expect(() => {
        service.deleteRelease(99999);
      }).toThrow(ReleaseNotFoundError);
    });

    it('throws ReleaseArchivedError when release is already archived', () => {
      const created = service.createRelease(projectId, validInput());
      service.archiveRelease(created.id);
      expect(() => {
        service.deleteRelease(created.id);
      }).toThrow(ReleaseArchivedError);
    });

    it('throws ReleaseParentArchivedError when parent project is archived', () => {
      const created = service.createRelease(projectId, validInput());
      db.prepare('UPDATE projects SET archived_at = datetime(\'now\') WHERE id = ?').run(projectId);
      expect(() => {
        service.deleteRelease(created.id);
      }).toThrow(ReleaseParentArchivedError);
    });

    it('removes release_assets rows while leaving project assets intact', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId, { relativePath: 'file.txt' }));
      service.selectAssets(release.id, [{ assetId: asset.id, role: 'primary', sortOrder: 0 }]);

      service.deleteRelease(release.id);

      expect(db.prepare('SELECT COUNT(*) AS c FROM release_assets WHERE release_id = ?').get(release.id).c).toBe(0);
      expect(assetRepo.findById(asset.id)).toBeDefined();
    });

    it('allows deleting a published release', () => {
      const { release, asset } = createPublishableRelease(service, assetRepo, projectId, { title: 'Published To Delete' });
      service.publishRelease(release.id);

      const deleted = service.deleteRelease(release.id);

      expect(deleted).toBe(true);
      expect(service.findRelease(release.id)).toBeUndefined();
      expect(assetRepo.findById(asset.id)).toBeDefined();
    });
  });

  describe('findRelease', () => {
    it('returns a release by id', () => {
      const created = service.createRelease(projectId, validInput({ title: 'Find Me' }));
      const found = service.findRelease(created.id);
      expect(found.title).toBe('Find Me');
    });

    it('returns undefined for non-existent id', () => {
      const found = service.findRelease(99999);
      expect(found).toBeUndefined();
    });
  });

  describe('validation error format', () => {
    it('throws ReleaseValidationError with errors object', () => {
      try {
        service.createRelease(projectId, validInput({ title: '' }));
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ReleaseValidationError);
        expect(err.errors).toBeDefined();
        expect(err.errors.title).toBeDefined();
      }
    });
  });

  // ─── Release Asset Selection ────────────────────────────────────────────────

  describe('selectAssets', () => {
    it('selects assets for a release', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      const result = service.selectAssets(release.id, [{ assetId: asset.id, role: 'primary', sortOrder: 0 }]);
      expect(result).toHaveLength(1);
      expect(result[0].asset_id).toBe(asset.id);
      expect(result[0].role).toBe('primary');
    });

    it('throws ReleaseNotFoundError for non-existent release', () => {
      expect(() => {
        service.selectAssets(99999, []);
      }).toThrow(ReleaseNotFoundError);
    });

    it('throws ReleaseValidationError when asset belongs to different project', () => {
      const release = service.createRelease(projectId, validInput());
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const otherAsset = assetRepo.upsert(otherProject.id, 'other.txt', sampleAsset(otherProject.id));

      expect(() => {
        service.selectAssets(release.id, [{ assetId: otherAsset.id }]);
      }).toThrow(ReleaseValidationError);
    });

    it('throws AssetNotFoundError when asset does not exist', () => {
      const release = service.createRelease(projectId, validInput());

      expect(() => {
        service.selectAssets(release.id, [{ assetId: 99999 }]);
      }).toThrow(AssetNotFoundError);
    });

    it('throws ReleaseValidationError for invalid role', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      expect(() => {
        service.selectAssets(release.id, [{ assetId: asset.id, role: 'invalid' }]);
      }).toThrow(ReleaseValidationError);
    });

    it('throws ReleaseValidationError for negative sortOrder', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      expect(() => {
        service.selectAssets(release.id, [{ assetId: asset.id, sortOrder: -1 }]);
      }).toThrow(ReleaseValidationError);
    });

    it('selects multiple assets', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));

      const result = service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 1 },
      ]);
      expect(result).toHaveLength(2);
    });

    it('replaces existing selections when calling selectAssets again', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));

      service.selectAssets(release.id, [{ assetId: asset1.id }]);
      service.selectAssets(release.id, [{ assetId: asset2.id }]);

      const result = service.listReleaseAssets(release.id);
      expect(result).toHaveLength(1);
      expect(result[0].asset_id).toBe(asset2.id);
    });

    it('allows empty selection to clear all assets', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      service.selectAssets(release.id, [{ assetId: asset.id }]);
      service.selectAssets(release.id, []);

      const result = service.listReleaseAssets(release.id);
      expect(result).toHaveLength(0);
    });

    it('rejects duplicate asset IDs with ReleaseValidationError', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      expect(() => {
        service.selectAssets(release.id, [
          { assetId: asset.id, role: 'primary', sortOrder: 0 },
          { assetId: asset.id, role: 'attachment', sortOrder: 1 },
        ]);
      }).toThrow(ReleaseValidationError);

      // No junction rows must remain after rejection
      const rows = service.listReleaseAssets(release.id);
      expect(rows).toHaveLength(0);
    });

    it('rejects duplicate numeric IDs after normalization', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      expect(() => {
        service.selectAssets(release.id, [
          { assetId: asset.id, role: 'attachment', sortOrder: 0 },
          { assetId: asset.id, role: 'attachment', sortOrder: 1 },
        ]);
      }).toThrow(ReleaseValidationError);
    });

    it('rejects selections with non-integer assetId', () => {
      const release = service.createRelease(projectId, validInput());

      expect(() => {
        service.selectAssets(release.id, [
          { assetId: 1.5, role: 'attachment' },
        ]);
      }).toThrow(ReleaseValidationError);
    });

    it('rejects selections with zero assetId', () => {
      const release = service.createRelease(projectId, validInput());

      expect(() => {
        service.selectAssets(release.id, [
          { assetId: 0, role: 'attachment' },
        ]);
      }).toThrow(ReleaseValidationError);
    });

    it('rejects selections with negative assetId', () => {
      const release = service.createRelease(projectId, validInput());

      expect(() => {
        service.selectAssets(release.id, [
          { assetId: -1, role: 'attachment' },
        ]);
      }).toThrow(ReleaseValidationError);
    });

    it('rejects selections with non-array input', () => {
      const release = service.createRelease(projectId, validInput());

      expect(() => {
        service.selectAssets(release.id, 'not-an-array');
      }).toThrow(ReleaseValidationError);
    });

    it('rejects selections with object entries', () => {
      const release = service.createRelease(projectId, validInput());

      expect(() => {
        service.selectAssets(release.id, [{ assetId: {}, role: 'attachment' }]);
      }).toThrow(ReleaseValidationError);
    });

    it('rejects selections with nested arrays', () => {
      const release = service.createRelease(projectId, validInput());

      expect(() => {
        service.selectAssets(release.id, [{ assetId: [1], role: 'attachment' }]);
      }).toThrow(ReleaseValidationError);
    });

    it('rejects selections with blank/null assetId', () => {
      const release = service.createRelease(projectId, validInput());

      expect(() => {
        service.selectAssets(release.id, [{ assetId: null, role: 'attachment' }]);
      }).toThrow(ReleaseValidationError);
    });

    it('rejects selections with undefined assetId', () => {
      const release = service.createRelease(projectId, validInput());

      expect(() => {
        service.selectAssets(release.id, [{ role: 'attachment' }]);
      }).toThrow(ReleaseValidationError);
    });
  });

  // ─── B-F3: Save validation reads asset state in bounded batches ────────────
  //
  // selectAssets validates ownership and presence for every submitted ID. It
  // must read that state with one bound-parameter statement per 500 unique
  // IDs, never one lookup per ID, while keeping the existing outcomes and the
  // existing sequence-based error precedence:
  //   1. validateSelections (malformed ID / role / sortOrder / duplicate)
  //      rejects before any asset read;
  //   2. the first unknown ID in submitted order throws AssetNotFoundError,
  //      whatever earlier entries reported;
  //   3. otherwise errors.assets carries the LAST offending entry in submitted
  //      order (foreign project or newly selected missing asset).
  describe('selectAssets bounded validation reads (B-F3)', () => {
    const BATCH = 500;
    const VALIDATION_LOOKUP = /^SELECT id, project_id, is_present FROM assets WHERE id IN \(/;
    // Any SELECT that reads one asset row by ID (the pre-B-F3 findById loop).
    const PER_ID_ASSET_READ = /^SELECT\b(?=.*\bFROM assets\b)(?=.*\bWHERE (?:a\.)?id = \?)/;
    const MEMBERSHIP_WRITE = /^(?:INSERT|UPDATE|DELETE)\b.*\brelease_assets\b/;

    let svc;
    let sqlLog;
    let restorePrepare;

    // Record every prepared-statement execution (SQL, method, rows returned,
    // bound parameter count). Installed before the service is created so the
    // repositories' construction-time statements are wrapped too.
    function instrument(targetDb) {
      const originalPrepare = targetDb.prepare.bind(targetDb);
      const log = [];
      targetDb.prepare = (sql, ...args) => {
        const statement = originalPrepare(sql, ...args);
        const text = String(sql).replace(/\s+/g, ' ').trim();
        return new Proxy(statement, {
          get(target, prop, receiver) {
            if (prop === 'get' || prop === 'all' || prop === 'run') {
              return (...params) => {
                const result = target[prop](...params);
                const rows = prop === 'all' ? result.length : (prop === 'get' ? (result ? 1 : 0) : 0);
                log.push({ sql: text, method: prop, rows, params: params.length });
                return result;
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      };
      return { log, restore: () => { targetDb.prepare = originalPrepare; } };
    }

    function measure(fn) {
      sqlLog.length = 0;
      let error = null;
      try {
        fn();
      } catch (err) {
        error = err;
      }
      const entries = [...sqlLog];
      const validation = entries.filter((entry) => VALIDATION_LOOKUP.test(entry.sql));
      return {
        error,
        validation: validation.length,
        validationRows: validation.reduce((sum, entry) => sum + entry.rows, 0),
        maxValidationParams: Math.max(0, ...validation.map((entry) => entry.params)),
        perIdAssetReads: entries.filter((entry) => PER_ID_ASSET_READ.test(entry.sql)).length,
        membershipWrites: entries.filter((entry) => MEMBERSHIP_WRITE.test(entry.sql)).length,
        total: entries.length,
      };
    }

    function seedAssets(targetProjectId, count, prefix = 'a') {
      const rows = Array.from({ length: count }, (_, index) => {
        const filename = `${prefix}-${String(index).padStart(4, '0')}.png`;
        return { relativePath: filename, filename, extension: 'png', mimeType: 'image/png', sizeBytes: 10, modifiedAt: '2025-01-01T00:00:00Z' };
      });
      return assetRepo.upsertMany(targetProjectId, rows).map((asset) => asset.id);
    }

    function membership(releaseId) {
      return db.prepare('SELECT asset_id, role, sort_order FROM release_assets WHERE release_id = ? ORDER BY sort_order, asset_id')
        .all(releaseId)
        .map((row) => [row.asset_id, row.role, row.sort_order]);
    }

    function markMissing(assetId) {
      db.prepare("UPDATE assets SET is_present = 0, missing_since = '2025-02-01T00:00:00Z' WHERE id = ?").run(assetId);
    }

    function unknownIds(count) {
      const max = db.prepare('SELECT MAX(id) AS max FROM assets').get().max;
      return Array.from({ length: count }, (_, index) => max + 1000 + index);
    }

    let ids;
    let foreignIds;
    let release;

    beforeEach(() => {
      ids = seedAssets(projectId, 1000);
      const foreignProject = projectRepo.create(sampleProject({ title: 'B-F3 Foreign' }));
      foreignIds = seedAssets(foreignProject.id, 3, 'foreign');
      const instrumented = instrument(db);
      sqlLog = instrumented.log;
      restorePrepare = instrumented.restore;
      svc = createReleaseService({ db });
      release = svc.createRelease(projectId, validInput({ title: 'B-F3 Release' }));
    });

    afterEach(() => {
      restorePrepare();
    });

    it.each([0, 1, 2, 25, 250, 499, 500, 501, 517, 1000])(
      'validates a %i-ID membership Save with ceil(n / 500) lookups and no per-ID reads',
      (n) => {
        const submitted = ids.slice(0, n);
        const result = measure(() => svc.selectAssets(release.id, submitted.map((assetId) => ({ assetId })), { membershipOnly: true }));

        expect(result.error).toBeNull();
        expect(result.validation).toBe(Math.ceil(n / BATCH));
        expect(result.validationRows).toBe(n);
        expect(result.maxValidationParams).toBeLessThanOrEqual(BATCH);
        expect(result.perIdAssetReads).toBe(0);
        // One DELETE plus one guarded INSERT per persisted row: the existing
        // atomic replace, unchanged by B-F3.
        expect(result.membershipWrites).toBe(1 + n);
        // Everything else is exactly four fixed statements at every size:
        // release lookup, parent project guard, membership before and after.
        expect(result.total - result.validation - result.membershipWrites).toBe(4);
        expect(membership(release.id)).toEqual(submitted.map((assetId, index) => [assetId, 'attachment', index]));
      },
    );

    it('keeps a 517-ID legacy Save role/order associations and submitted sequence', () => {
      const submitted = ids.slice(0, 517).reverse().map((assetId, index) => ({
        assetId,
        role: index === 3 ? 'primary' : (index % 50 === 7 ? 'preview' : 'attachment'),
        sortOrder: 1000 - index,
      }));
      const result = measure(() => svc.selectAssets(release.id, submitted));

      expect(result.error).toBeNull();
      expect(result.validation).toBe(2);
      expect(result.perIdAssetReads).toBe(0);
      const expected = submitted
        .map(({ assetId, role, sortOrder }) => [assetId, role, sortOrder])
        .sort((a, b) => a[2] - b[2] || a[0] - b[0]);
      expect(membership(release.id)).toEqual(expected);
      expect(membership(release.id).filter(([, role]) => role === 'primary')).toEqual([[submitted[3].assetId, 'primary', 997]]);
    });

    it('preserves saved roles, relative order, off-page removals and appends for a membership-only Save', () => {
      // Saved: 600 members (roles on two of them), in an order unlike ID order.
      const saved = ids.slice(0, 600).reverse();
      svc.selectAssets(release.id, saved.map((assetId, index) => ({
        assetId,
        role: index === 0 ? 'primary' : (index === 550 ? 'preview' : 'attachment'),
        sortOrder: index,
      })));
      const removed = new Set([saved[1], saved[300], saved[599]]);
      const additions = [ids[900], ids[650], ids[999]];
      // Draft order differs from saved order; saved members keep their saved
      // relative order and roles, new IDs append in submitted order.
      const draft = [...additions.slice(0, 1), ...saved.filter((id) => !removed.has(id)).reverse(), ...additions.slice(1)];

      const result = measure(() => svc.selectAssets(release.id, draft.map((assetId) => ({ assetId })), { membershipOnly: true }));

      expect(result.error).toBeNull();
      expect(result.validation).toBe(2);
      expect(result.validationRows).toBe(600);
      expect(result.perIdAssetReads).toBe(0);
      const kept = saved.filter((id) => !removed.has(id));
      expect(membership(release.id)).toEqual([
        ...kept.map((assetId, index) => [assetId, assetId === saved[0] ? 'primary' : (assetId === saved[550] ? 'preview' : 'attachment'), index]),
        ...additions.map((assetId, index) => [assetId, 'attachment', kept.length + index]),
      ]);
    });

    it('rejects a 517-ID Save containing a foreign-project ID with bounded reads and no mutation', () => {
      svc.selectAssets(release.id, ids.slice(0, 3).map((assetId) => ({ assetId })), { membershipOnly: true });
      const before = membership(release.id);
      const submitted = [...ids.slice(0, 300), foreignIds[0], ...ids.slice(300, 516)];

      const result = measure(() => svc.selectAssets(release.id, submitted.map((assetId) => ({ assetId })), { membershipOnly: true }));

      expect(result.error).toBeInstanceOf(ReleaseValidationError);
      expect(result.error.errors).toEqual({ assets: `Asset ${foreignIds[0]} does not belong to the release's project.` });
      expect(result.validation).toBe(2);
      expect(result.validationRows).toBe(517);
      expect(result.perIdAssetReads).toBe(0);
      expect(result.membershipWrites).toBe(0);
      expect(membership(release.id)).toEqual(before);
    });

    it('reads only ownership and presence columns, so foreign metadata is never loaded', () => {
      measure(() => svc.selectAssets(release.id, [{ assetId: foreignIds[1] }], { membershipOnly: true }));
      const lookup = sqlLog.find((entry) => VALIDATION_LOOKUP.test(entry.sql));
      expect(lookup.sql).toBe('SELECT id, project_id, is_present FROM assets WHERE id IN (?)');
      expect(assetRepo.findSelectionStatesByIds([foreignIds[1], ids[0], 987654321])
        .sort((a, b) => a.id - b.id))
        .toEqual([
          { id: ids[0], project_id: projectId, is_present: 1 },
          { id: foreignIds[1], project_id: expect.any(Number), is_present: 1 },
        ]);
      expect(assetRepo.findSelectionStatesByIds([])).toEqual([]);
    });

    it('rejects an unknown ID with AssetNotFoundError after bounded reads and no mutation', () => {
      const [unknown] = unknownIds(1);
      const result = measure(() => svc.selectAssets(release.id, [...ids.slice(0, 510), unknown, ...ids.slice(510, 516)].map((assetId) => ({ assetId })), { membershipOnly: true }));

      expect(result.error).toBeInstanceOf(AssetNotFoundError);
      expect(result.error.message).toBe(`Asset ${unknown} not found`);
      expect(result.error.status).toBe(404);
      expect(result.validation).toBe(2);
      expect(result.perIdAssetReads).toBe(0);
      expect(result.membershipWrites).toBe(0);
      expect(membership(release.id)).toEqual([]);
    });

    it.each([
      ['foreign before unknown', (u) => [ids[0], foreignIds[0], ...ids.slice(1, 520), u]],
      ['unknown before foreign', (u) => [ids[0], u, ...ids.slice(1, 520), foreignIds[0]]],
    ])('%s: the unknown ID wins (AssetNotFoundError)', (_label, build) => {
      const [unknown] = unknownIds(1);
      const result = measure(() => svc.selectAssets(release.id, build(unknown).map((assetId) => ({ assetId })), { membershipOnly: true }));
      expect(result.error).toBeInstanceOf(AssetNotFoundError);
      expect(result.error.message).toBe(`Asset ${unknown} not found`);
      expect(result.validation).toBe(2);
      expect(membership(release.id)).toEqual([]);
    });

    it('reports the first unknown ID in submitted order, not SQL or ID order', () => {
      const [lower, higher] = unknownIds(2);
      const result = measure(() => svc.selectAssets(release.id, [ids[0], higher, ...ids.slice(1, 600), lower].map((assetId) => ({ assetId })), { membershipOnly: true }));
      expect(result.error).toBeInstanceOf(AssetNotFoundError);
      expect(result.error.message).toBe(`Asset ${higher} not found`);
    });

    it.each([
      ['foreign then missing new (across the batch boundary)', 'foreignFirst'],
      ['missing new then foreign (across the batch boundary)', 'missingFirst'],
    ])('%s: the last offending entry in submitted order is reported', (_label, orderName) => {
      const missingNew = ids[700];
      markMissing(missingNew);
      const foreign = foreignIds[2];
      const [first, second] = orderName === 'foreignFirst' ? [foreign, missingNew] : [missingNew, foreign];
      const submitted = [...ids.slice(0, 10), first, ...ids.slice(10, 505), second, ...ids.slice(505, 510)];

      const result = measure(() => svc.selectAssets(release.id, submitted.map((assetId) => ({ assetId })), { membershipOnly: true }));

      expect(result.error).toBeInstanceOf(ReleaseValidationError);
      expect(result.error.errors).toEqual({
        assets: second === foreign
          ? `Asset ${foreign} does not belong to the release's project.`
          : `Asset ${missingNew} is currently missing and cannot be selected.`,
      });
      expect(result.validation).toBe(2);
      expect(result.membershipWrites).toBe(0);
    });

    it('rejects a valid-surrounded foreign entry and leaves saved membership unchanged', () => {
      svc.selectAssets(release.id, [{ assetId: ids[5], role: 'primary', sortOrder: 0 }, { assetId: ids[6], role: 'preview', sortOrder: 1 }]);
      const before = membership(release.id);
      const result = measure(() => svc.selectAssets(release.id, [ids[5], foreignIds[0], ids[6]].map((assetId) => ({ assetId })), { membershipOnly: true }));
      expect(result.error.errors).toEqual({ assets: `Asset ${foreignIds[0]} does not belong to the release's project.` });
      expect(result.validation).toBe(1);
      expect(membership(release.id)).toEqual(before);
    });

    it.each([
      ['missing new asset before invalid role', (missing) => [{ assetId: missing, role: 'attachment' }, { assetId: ids[1], role: 'bogus' }]],
      ['invalid role before missing new asset', (missing) => [{ assetId: ids[1], role: 'bogus' }, { assetId: missing, role: 'attachment' }]],
    ])('%s: the role error is reported before any asset read', (_label, build) => {
      const missing = ids[2];
      markMissing(missing);
      const result = measure(() => svc.selectAssets(release.id, build(missing)));
      expect(result.error).toBeInstanceOf(ReleaseValidationError);
      expect(Object.keys(result.error.errors)).toEqual([expect.stringMatching(/^selections\[\d\]\.role$/)]);
      expect(result.validation).toBe(0);
      expect(result.membershipWrites).toBe(0);
    });

    it('rejects a duplicate spread across the batch boundary before any asset read, despite a later foreign ID', () => {
      const submitted = [...ids.slice(0, 499), ids[10], ...ids.slice(499, 520), foreignIds[0]];
      expect(submitted.indexOf(ids[10])).toBe(10);
      expect(submitted.lastIndexOf(ids[10])).toBe(499);
      const result = measure(() => svc.selectAssets(release.id, submitted.map((assetId) => ({ assetId })), { membershipOnly: true }));
      expect(result.error).toBeInstanceOf(ReleaseValidationError);
      expect(result.error.errors).toEqual({ assets: 'Duplicate asset IDs are not allowed.' });
      expect(result.validation).toBe(0);
      expect(result.membershipWrites).toBe(0);
      expect(membership(release.id)).toEqual([]);
    });

    it.each([
      ['invalid numeric ID', [{ assetId: 1.5 }], 'selections[0].assetId'],
      ['negative sortOrder', [{ assetId: 1, sortOrder: -1 }], 'selections[0].sortOrder'],
    ])('rejects an %s before any asset read', (_label, selections, key) => {
      const result = measure(() => svc.selectAssets(release.id, selections));
      expect(result.error).toBeInstanceOf(ReleaseValidationError);
      expect(Object.keys(result.error.errors)).toEqual([key]);
      expect(result.validation).toBe(0);
    });

    it('keeps an already-saved missing member and rejects a newly selected missing asset', () => {
      svc.selectAssets(release.id, [{ assetId: ids[0], role: 'primary', sortOrder: 0 }, { assetId: ids[1], role: 'preview', sortOrder: 1 }]);
      markMissing(ids[1]);
      markMissing(ids[800]);

      const kept = measure(() => svc.selectAssets(release.id, [...ids.slice(0, 2), ...ids.slice(2, 510)].map((assetId) => ({ assetId })), { membershipOnly: true }));
      expect(kept.error).toBeNull();
      expect(kept.validation).toBe(2);
      expect(membership(release.id).slice(0, 2)).toEqual([[ids[0], 'primary', 0], [ids[1], 'preview', 1]]);
      const afterKept = membership(release.id);

      const rejected = measure(() => svc.selectAssets(release.id, [...ids.slice(0, 510), ids[800]].map((assetId) => ({ assetId })), { membershipOnly: true }));
      expect(rejected.error.errors).toEqual({ assets: `Asset ${ids[800]} is currently missing and cannot be selected.` });
      expect(rejected.validation).toBe(2);
      expect(rejected.membershipWrites).toBe(0);
      expect(membership(release.id)).toEqual(afterKept);
    });

    it('clears membership on an empty Save with no asset reads', () => {
      svc.selectAssets(release.id, ids.slice(0, 2).map((assetId) => ({ assetId })), { membershipOnly: true });
      const result = measure(() => svc.selectAssets(release.id, [], { membershipOnly: true }));
      expect(result.error).toBeNull();
      expect(result.validation).toBe(0);
      expect(membership(release.id)).toEqual([]);
    });

    it.each([
      ['published release', () => db.prepare("UPDATE releases SET published_date = '2025-01-01' WHERE id = ?").run(release.id), ReleasePublishedError],
      ['archived release', () => svc.archiveRelease(release.id), ReleaseArchivedError],
      ['archived parent project', () => projectRepo.archive(projectId), ReleaseParentArchivedError],
    ])('refuses a 517-ID Save to a %s before any asset read', (_label, lock, ErrorClass) => {
      svc.selectAssets(release.id, [{ assetId: ids[0], role: 'primary', sortOrder: 0 }]);
      lock();
      const before = membership(release.id);
      const result = measure(() => svc.selectAssets(release.id, ids.slice(0, 517).map((assetId) => ({ assetId })), { membershipOnly: true }));
      expect(result.error).toBeInstanceOf(ErrorClass);
      expect(result.validation).toBe(0);
      expect(result.membershipWrites).toBe(0);
      expect(membership(release.id)).toEqual(before);
    });

    it('rolls back the whole 517-row replace when a late insert fails', () => {
      svc.selectAssets(release.id, [{ assetId: ids[900], role: 'primary', sortOrder: 0 }, { assetId: ids[901], role: 'preview', sortOrder: 1 }]);
      const before = membership(release.id);
      db.exec(`CREATE TRIGGER b_f3_fail BEFORE INSERT ON release_assets WHEN NEW.asset_id = ${ids[516]} BEGIN SELECT RAISE(ABORT, 'b-f3 forced failure'); END`);
      try {
        const result = measure(() => svc.selectAssets(release.id, ids.slice(0, 517).map((assetId) => ({ assetId })), { membershipOnly: true }));
        expect(result.error?.message).toMatch(/b-f3 forced failure/);
        expect(result.validation).toBe(2);
        expect(membership(release.id)).toEqual(before);
      } finally {
        db.exec('DROP TRIGGER b_f3_fail');
      }
    });
  });

  describe('addAssetToRelease', () => {
    it('adds a single asset to a release', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      const result = service.addAssetToRelease(release.id, asset.id, 'preview', 5);
      expect(result.asset_id).toBe(asset.id);
      expect(result.role).toBe('preview');
      expect(result.sort_order).toBe(5);
    });

    it('throws ReleaseNotFoundError for non-existent release', () => {
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));
      expect(() => {
        service.addAssetToRelease(99999, asset.id);
      }).toThrow(ReleaseNotFoundError);
    });

    it('throws ReleaseValidationError for cross-project asset', () => {
      const release = service.createRelease(projectId, validInput());
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const otherAsset = assetRepo.upsert(otherProject.id, 'other.txt', sampleAsset(otherProject.id));

      expect(() => {
        service.addAssetToRelease(release.id, otherAsset.id);
      }).toThrow(ReleaseValidationError);
    });

    it('throws ReleaseValidationError for duplicate selection', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      service.addAssetToRelease(release.id, asset.id);
      expect(() => {
        service.addAssetToRelease(release.id, asset.id);
      }).toThrow(ReleaseValidationError);
    });

    it('throws ReleaseValidationError for invalid role', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      expect(() => {
        service.addAssetToRelease(release.id, asset.id, 'bad-role');
      }).toThrow(ReleaseValidationError);
    });

    it('throws ReleaseValidationError for negative sortOrder', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      expect(() => {
        service.addAssetToRelease(release.id, asset.id, 'attachment', -1);
      }).toThrow(ReleaseValidationError);
    });
  });

  describe('removeAssetFromRelease', () => {
    it('removes a selected asset from a release', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      service.addAssetToRelease(release.id, asset.id);
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, []);
      const removed = service.removeAssetFromRelease(release.id, asset.id);
      expect(removed).toBe(true);
      expect(service.listReleaseAssets(release.id)).toHaveLength(0);
    });

    it('removes only the requested row, leaving other selections unchanged', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));

      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 1 },
      ]);

      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, ['b.txt']);

      const removed = service.removeAssetFromRelease(release.id, asset1.id);
      expect(removed).toBe(true);

      const remaining = service.listReleaseAssets(release.id);
      expect(remaining).toHaveLength(1);
      expect(remaining.map(({ asset_id, role, sort_order }) => ({ asset_id, role, sort_order }))).toEqual([
        { asset_id: asset2.id, role: 'attachment', sort_order: 1 },
      ]);
    });

    it('throws ReleaseNotFoundError for non-existent release', () => {
      expect(() => {
        service.removeAssetFromRelease(99999, 1);
      }).toThrow(ReleaseNotFoundError);
    });

    it('throws AssetNotFoundError for non-existent asset', () => {
      const release = service.createRelease(projectId, validInput());
      expect(() => {
        service.removeAssetFromRelease(release.id, 99999);
      }).toThrow(AssetNotFoundError);
    });

    it('throws ReleaseValidationError when asset is not selected for the release', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      expect(() => {
        service.removeAssetFromRelease(release.id, asset.id);
      }).toThrow(ReleaseValidationError);
    });

    it('throws ReleaseValidationError for cross-project asset', () => {
      const release = service.createRelease(projectId, validInput());
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const otherAsset = assetRepo.upsert(otherProject.id, 'other.txt', sampleAsset(otherProject.id));

      expect(() => {
        service.removeAssetFromRelease(release.id, otherAsset.id);
      }).toThrow(ReleaseValidationError);
    });

    it('throws ReleaseArchivedError for archived release', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));
      service.addAssetToRelease(release.id, asset.id);
      service.archiveRelease(release.id);

      expect(() => {
        service.removeAssetFromRelease(release.id, asset.id);
      }).toThrow(ReleaseArchivedError);
    });

    it('throws ReleaseParentArchivedError when parent project is archived', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));
      service.addAssetToRelease(release.id, asset.id);
      projectRepo.archive(projectId);

      expect(() => {
        service.removeAssetFromRelease(release.id, asset.id);
      }).toThrow(ReleaseParentArchivedError);
    });

    it('exact junction-table rows after successful removal', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));

      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 1 },
      ]);

      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, ['b.txt']);

      service.removeAssetFromRelease(release.id, asset1.id);

      const rows = db.prepare('SELECT release_id, asset_id, role, sort_order, created_at FROM release_assets WHERE release_id = ? ORDER BY sort_order ASC, asset_id ASC').all(release.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ asset_id: asset2.id, role: 'attachment', sort_order: 1 });
    });

    it('rejects removal of a selected present asset without changing the selection', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));
      service.addAssetToRelease(release.id, asset.id);

      const beforeRows = service.listReleaseAssets(release.id);
      const beforeAsset = assetRepo.findById(asset.id);

      expect(() => {
        service.removeAssetFromRelease(release.id, asset.id);
      }).toThrow(ReleaseValidationError);

      expect(service.listReleaseAssets(release.id)).toEqual(beforeRows);
      expect(assetRepo.findById(asset.id)).toEqual(beforeAsset);
    });

    it('exact junction-table rows unchanged after rejection (unselected asset)', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      // No selection exists — rejection must not mutate the table
      expect(() => {
        service.removeAssetFromRelease(release.id, asset.id);
      }).toThrow(ReleaseValidationError);

      const rows = db.prepare('SELECT COUNT(*) AS c FROM release_assets WHERE release_id = ?').get(release.id);
      expect(rows.c).toBe(0);
    });
  });

  describe('listReleaseAssets (service)', () => {
    it('lists assets for a release', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));
      service.addAssetToRelease(release.id, asset.id, 'primary', 0);

      const result = service.listReleaseAssets(release.id);
      expect(result).toHaveLength(1);
      expect(result[0].asset_id).toBe(asset.id);
    });

    it('throws ReleaseNotFoundError for non-existent release', () => {
      expect(() => {
        service.listReleaseAssets(99999);
      }).toThrow(ReleaseNotFoundError);
    });
  });

  describe('findReleasesByAsset (service)', () => {
    it('finds releases using an asset', () => {
      const release1 = service.createRelease(projectId, validInput({ title: 'R1' }));
      const release2 = service.createRelease(projectId, validInput({ title: 'R2' }));
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      service.addAssetToRelease(release1.id, asset.id);
      service.addAssetToRelease(release2.id, asset.id);

      const releases = service.findReleasesByAsset(asset.id);
      expect(releases).toHaveLength(2);
    });
  });

  describe('getReleaseAssetManagementPage category filtering', () => {
    function addCategory(project, displayName, directorySlug, displayOrder = 0) {
      return categoryRepo.addProjectCategory({
        projectId: project,
        displayName,
        directorySlug,
        displayOrder,
        enabled: true,
      });
    }

    function addAsset(filename, categoryId = null) {
      const data = sampleAsset(projectId, {
        relativePath: filename,
        filename,
      });
      data.categoryId = categoryId;
      return assetRepo.upsert(projectId, filename, data);
    }

    it('keeps the existing all-assets behavior and returns categories with explicit all selection', () => {
      const source = addCategory(projectId, 'Source', 'source');
      const categorized = addAsset('source.txt', source.id);
      const uncategorized = addAsset('uncategorized.txt');
      const release = service.createRelease(projectId, validInput());

      const page = service.getReleaseAssetManagementPage(release.id, { selection: 'all' });

      // Package B: no whole-project asset array; project-wide totals come from
      // the category aggregates instead.
      expect(page).not.toHaveProperty('assets');
      expect(page.categoryNavigation).toEqual({
        totalCount: 2, uncategorizedCount: 1, byCategoryId: { [source.id]: 1 },
      });
      expect(page.categories.map((category) => category.id)).toEqual([source.id]);
      expect(page.activeCategoryId).toBeNull();
      expect(page.assetPage.map((asset) => asset.id)).toEqual([categorized.id, uncategorized.id]);
      expect(page.assetTotal).toBe(2);
      expect(page.candidateTotal).toBe(2);
    });

    it('filters the merged project asset page while preserving selection state and release order', () => {
      const source = addCategory(projectId, 'Source', 'source');
      const other = addCategory(projectId, 'Other', 'other', 1);
      const first = addAsset('a-first.txt', source.id);
      const second = addAsset('b-second.txt', source.id);
      const unselectedSource = addAsset('c-unselected.txt', source.id);
      const otherAsset = addAsset('other.txt', other.id);
      const firstRelease = service.createRelease(projectId, validInput({ title: 'First Release' }));
      const secondRelease = service.createRelease(projectId, validInput({ title: 'Second Release' }));

      service.selectAssets(firstRelease.id, [
        { assetId: second.id, role: 'preview', sortOrder: 0 },
        { assetId: first.id, role: 'primary', sortOrder: 1 },
      ]);
      service.selectAssets(secondRelease.id, [
        { assetId: first.id, role: 'attachment', sortOrder: 0 },
      ]);

      const firstPage = service.getReleaseAssetManagementPage(firstRelease.id, { categoryId: String(source.id), selection: 'all' });
      const secondPage = service.getReleaseAssetManagementPage(secondRelease.id, { category: source.id, selection: 'all' });

      expect(firstPage.activeCategoryId).toBe(source.id);
      expect(firstPage).not.toHaveProperty('assets');
      expect(firstPage.categoryNavigation.totalCount).toBe(4);
      expect(firstPage.assetPage.map((asset) => asset.id)).toEqual([first.id, second.id, unselectedSource.id]);
      expect(firstPage.assetTotal).toBe(3);
      expect(firstPage.candidates.map((asset) => asset.id)).toEqual([unselectedSource.id]);
      expect(firstPage.candidateTotal).toBe(1);
      expect(firstPage.releaseAssets.map((asset) => asset.asset_id)).toEqual([second.id, first.id]);
      expect(firstPage.releaseAssets.map((asset) => asset.sort_order)).toEqual([0, 1]);
      expect(firstPage.releaseAssets.map((asset) => asset.role)).toEqual(['preview', 'primary']);
      expect(firstPage.assetPresentation.selected.map((asset) => asset.id)).toEqual([second.id, first.id]);
      expect(firstPage.assetPresentation.selected.map((asset) => asset.releaseContext)).toEqual([
        { selected: true, role: 'preview', sortOrder: 0 },
        { selected: true, role: 'primary', sortOrder: 1 },
      ]);
      expect(firstPage.assetPresentation.candidates.map((asset) => asset.id)).toEqual([unselectedSource.id]);
      expect(firstPage.assetPresentation.candidates[0].releaseContext).toEqual({
        selected: false,
        role: null,
        sortOrder: null,
      });
      expect(firstPage.assetPresentation.selected[0]).toMatchObject({
        categoryLabel: 'Source',
        categoryDisabled: false,
        category: { id: source.id, displayName: 'Source', enabled: true },
      });
      expect(firstPage.assetPresentation.candidates[0].categoryLabel).toBe('Source');
      expect(firstPage.assetPresentation.assets.map((asset) => asset.id)).toEqual([
        first.id,
        second.id,
        unselectedSource.id,
      ]);
      expect(firstPage.assetPresentation.assets.map((asset) => asset.releaseContext.selected)).toEqual([
        true,
        true,
        false,
      ]);

      expect(secondPage).not.toHaveProperty('assets');
      expect(secondPage.categoryNavigation.byCategoryId).toEqual({ [source.id]: 3, [other.id]: 1 });
      expect(secondPage.releaseAssets.map((asset) => asset.asset_id)).toEqual([first.id]);
      expect(secondPage.assetPage.map((asset) => asset.id)).toEqual([
        first.id,
        second.id,
        unselectedSource.id,
      ]);
      expect(firstPage.assetPage.map((asset) => asset.id)).not.toContain(otherAsset.id);
      expect(firstPage.categories.map((category) => category.id)).toEqual([source.id, other.id]);
    });

    it('returns project-wide counts and an empty merged page for a valid empty category', () => {
      const empty = addCategory(projectId, 'Empty', 'empty');
      const release = service.createRelease(projectId, validInput());
      const uncategorized = addAsset('uncategorized.txt');

      const page = service.getReleaseAssetManagementPage(release.id, { category: String(empty.id) });

      expect(page.activeCategoryId).toBe(empty.id);
      expect(page).not.toHaveProperty('assets');
      expect(page.categoryNavigation).toEqual({ totalCount: 1, uncategorizedCount: 1, byCategoryId: {} });
      expect(page.assetPage).toEqual([]);
      expect(page.assetTotal).toBe(0);
      expect(page.assetPresentation.assets).toEqual([]);
      expect(page.candidates).toEqual([]);
      expect(page.candidateTotal).toBe(0);
    });

    it('does not slice release assets for explicit all and keeps single-page metadata', () => {
      const assets = [];
      for (let index = 0; index < 30; index++) {
        assets.push(addAsset(`asset-${String(index).padStart(2, '0')}.txt`));
      }
      const release = service.createRelease(projectId, validInput());
      service.selectAssets(release.id, [{ assetId: assets[0].id, role: 'primary', sortOrder: 0 }]);

      const page = service.getReleaseAssetManagementPage(release.id, { page: '99', pageSize: 'all', selection: 'all' });

      expect(page.assetPage).toHaveLength(30);
      expect(page.assetPageNumber).toBe(1);
      expect(page.assetPageSize).toBe('all');
      expect(page.assetPageCount).toBe(1);
      expect(page.assetTotal).toBe(30);
      expect(page.assetPresentation.selected.map((asset) => asset.id)).toEqual([assets[0].id]);
      expect(page.candidates).toHaveLength(29);
    });

    it('keeps valid empty metadata for explicit all', () => {
      const release = service.createRelease(projectId, validInput());
      const page = service.getReleaseAssetManagementPage(release.id, { page: '99', pageSize: 'all' });

      expect(page.assetPage).toEqual([]);
      expect(page.assetTotal).toBe(0);
      expect(page.assetPageNumber).toBe(1);
      expect(page.assetPageSize).toBe('all');
      expect(page.assetPageCount).toBe(1);
    });

    it('preserves finite slicing and malformed page-size fallback behavior', () => {
      for (let index = 0; index < 30; index++) {
        addAsset(`asset-${String(index).padStart(2, '0')}.txt`);
      }
      const release = service.createRelease(projectId, validInput());

      const finite = service.getReleaseAssetManagementPage(release.id, { page: '2', pageSize: '10', selection: 'all' });
      expect(finite.assetPage).toHaveLength(10);
      expect(finite.assetPageNumber).toBe(2);
      expect(finite.assetPageSize).toBe(10);
      expect(finite.assetPageCount).toBe(3);

      const malformed = service.getReleaseAssetManagementPage(release.id, { pageSize: '1junk', selection: 'all' });
      expect(malformed.assetPage).toHaveLength(25);
      expect(malformed.assetPageSize).toBe(25);
      expect(malformed.assetPageCount).toBe(2);
    });

    it('normalizes requested release-asset page sizes to the supported catalogue (P3-C4)', () => {
      const supported = [['10', 10], ['25', 25], ['50', 50], ['100', 100], ['150', 150], ['200', 200], ['all', 'all']];
      for (const [pageSize, expected] of supported) {
        expect(service.normalizeCandidateQuery({ pageSize }).pageSize).toBe(expected);
      }

      // Any value neither control offers is the default 25: never kept as a
      // custom size, never rounded to a neighbour, never View All.
      const unsupported = [
        '7', '11', '15', '24', '26', '37', '201', '999999', '0', '-1', 'abc', '1.5', '010',
        '1junk', '2.5', '1e2', '+2', '-2', '', ' 25', '25 ', 'ALL', 'All', ' all',
      ];
      for (const pageSize of unsupported) {
        expect(service.normalizeCandidateQuery({ pageSize }).pageSize).toBe(25);
      }
      for (const pageSize of [undefined, null, 50, ['50'], ['50', '10'], ['all', 'all'], ['10', 'abc'], { all: '1' }]) {
        expect(service.normalizeCandidateQuery({ pageSize }).pageSize).toBe(25);
      }
      expect(service.normalizeCandidateQuery({}).pageSize).toBe(25);
    });

    it('queries, slices and paginates an unsupported page size at the effective 25 (P3-C4)', () => {
      const ids = [];
      for (let index = 0; index < 60; index++) {
        ids.push(addAsset(`asset-${String(index).padStart(2, '0')}.txt`).id);
      }
      const release = service.createRelease(projectId, validInput());
      const reference = service.getReleaseAssetManagementPage(release.id, { selection: 'all', pageSize: 'all' });
      const ordered = reference.assetPage.map((asset) => asset.id);
      expect(ordered).toHaveLength(60);
      expect([...ordered].sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));

      for (const pageSize of ['7', '15', '11', '24', '26', '201', '999999', '0', '-1', 'abc', '1.5', '010', 'ALL', ['50', '10']]) {
        const first = service.getReleaseAssetManagementPage(release.id, { selection: 'all', pageSize });
        expect(first.assetPageSize).toBe(25);
        expect(first.candidatePageSize).toBe(25);
        expect(first.assetPageCount).toBe(3);
        expect(first.assetTotal).toBe(60);
        expect(first.assetPage.map((asset) => asset.id)).toEqual(ordered.slice(0, 25));

        const third = service.getReleaseAssetManagementPage(release.id, { selection: 'all', pageSize, page: '3' });
        expect(third.assetPageNumber).toBe(3);
        expect(third.assetPage.map((asset) => asset.id)).toEqual(ordered.slice(50, 60));

        // A page past the end clamps against the effective size, not the raw one.
        const clamped = service.getReleaseAssetManagementPage(release.id, { selection: 'all', pageSize, page: '9' });
        expect(clamped.assetPageNumber).toBe(3);
        expect(clamped.assetPage.map((asset) => asset.id)).toEqual(ordered.slice(50, 60));
      }

      for (const [pageSize, size, pages] of [['10', 10, 6], ['25', 25, 3], ['50', 50, 2], ['100', 100, 1], ['150', 150, 1], ['200', 200, 1]]) {
        const sized = service.getReleaseAssetManagementPage(release.id, { selection: 'all', pageSize, page: '2' });
        expect(sized.assetPageSize).toBe(size);
        expect(sized.assetPageCount).toBe(pages);
        const page = Math.min(2, pages);
        expect(sized.assetPageNumber).toBe(page);
        expect(sized.assetPage.map((asset) => asset.id)).toEqual(ordered.slice((page - 1) * size, page * size));
      }
      const all = service.getReleaseAssetManagementPage(release.id, { selection: 'all', pageSize: 'all', page: '2' });
      expect(all.assetPageSize).toBe('all');
      expect(all.assetPageCount).toBe(1);
      expect(all.assetPage.map((asset) => asset.id)).toEqual(ordered);
    });

    it('uses category validation for malformed IDs and not-found for missing or cross-project IDs', () => {
      const release = service.createRelease(projectId, validInput());
      const otherProject = projectRepo.create(sampleProject({ title: 'Other Category Project' }));
      const foreignCategory = addCategory(otherProject.id, 'Foreign', 'foreign');

      expect(() => service.getReleaseAssetManagementPage(release.id, { categoryId: 'not-an-id' }))
        .toThrow(AssetCategoryValidationError);
      expect(() => service.getReleaseAssetManagementPage(release.id, { categoryId: 999999 }))
        .toThrow(AssetCategoryNotFoundError);
      expect(() => service.getReleaseAssetManagementPage(release.id, { categoryId: foreignCategory.id }))
        .toThrow(AssetCategoryNotFoundError);
    });

    describe('selection filter', () => {
      it('defaults absent or invalid selection to saved selected assets and honors explicit all', () => {
        const a = addAsset('a.txt');
        const b = addAsset('b.txt');
        const c = addAsset('c.txt');
        const release = service.createRelease(projectId, validInput());
        service.selectAssets(release.id, [
          { assetId: c.id, role: 'primary', sortOrder: 0 },
          { assetId: a.id, role: 'preview', sortOrder: 1 },
        ]);

        for (const query of [{}, { selection: 'bogus' }, { selection: ['all'] }, { selection: 'selected' }]) {
          const page = service.getReleaseAssetManagementPage(release.id, query);
          expect(page.assetFilters.selection).toBe('selected');
          expect(page.assetPage.map((asset) => asset.id)).toEqual([a.id, c.id]);
          expect(page.assetTotal).toBe(2);
          expect(page.candidateTotal).toBe(0);
        }

        const all = service.getReleaseAssetManagementPage(release.id, { selection: 'all' });
        expect(all.assetFilters.selection).toBe('all');
        expect(all.assetPage.map((asset) => asset.id)).toEqual([a.id, b.id, c.id]);
        expect(all.assetTotal).toBe(3);
        // Release membership, roles and order are loaded completely either way.
        expect(all.releaseAssets.map((asset) => [asset.asset_id, asset.role, asset.sort_order]))
          .toEqual([[c.id, 'primary', 0], [a.id, 'preview', 1]]);
      });

      it('intersects saved membership with search, extension and category before pagination', () => {
        const addAsset = (filename, categoryId = null) => assetRepo.upsert(projectId, filename, {
          ...sampleAsset(projectId, { relativePath: filename, filename, extension: filename.split('.').pop() }),
          categoryId,
        });
        const source = addCategory(projectId, 'Source', 'source');
        const assets = [];
        // P3-C4: enough shots to paginate at the supported size 10.
        for (let index = 0; index < 32; index++) {
          assets.push(addAsset(`shot-${String(index).padStart(2, '0')}.png`, index % 2 === 0 ? source.id : null));
        }
        const doc = addAsset('shot-doc.txt', source.id);
        addAsset('other.png', source.id);
        const release = service.createRelease(projectId, validInput());
        // Saved: even (Source) shots 0..30 plus the doc; odd shots unselected.
        service.selectAssets(release.id, [
          ...assets.filter((_, index) => index % 2 === 0).map((asset) => ({ assetId: asset.id })),
          { assetId: doc.id },
        ], { membershipOnly: true });

        const page2 = service.getReleaseAssetManagementPage(release.id, {
          search: 'shot', extension: 'png', category: String(source.id), pageSize: '10', page: '2',
        });
        expect(page2.assetTotal).toBe(16);
        expect(page2.assetPageCount).toBe(2);
        expect(page2.assetPageNumber).toBe(2);
        expect(page2.assetPage.map((asset) => asset.filename))
          .toEqual(['shot-20.png', 'shot-22.png', 'shot-24.png', 'shot-26.png', 'shot-28.png', 'shot-30.png']);

        const allMode = service.getReleaseAssetManagementPage(release.id, {
          search: 'shot', extension: 'png', selection: 'all', pageSize: '10',
        });
        expect(allMode.assetTotal).toBe(32);
        expect(allMode.assetPageCount).toBe(4);

        // Extension options and category counts stay whole-project.
        expect(page2.assetExtensions).toEqual(allMode.assetExtensions);
        expect(page2.categoryNavigation).toEqual(allMode.categoryNavigation);
      });

      it('keeps selected missing assets visible despite filters and excludes unselected missing assets', () => {
        const present = addAsset('present.png');
        const missing = addAsset('missing.png');
        const unselectedMissing = addAsset('gone.png');
        const release = service.createRelease(projectId, validInput());
        service.selectAssets(release.id, [{ assetId: present.id }, { assetId: missing.id }], { membershipOnly: true });
        db.prepare('UPDATE assets SET is_present = 0 WHERE id IN (?, ?)').run(missing.id, unselectedMissing.id);

        const selected = service.getReleaseAssetManagementPage(release.id, { search: 'present' });
        expect(selected.assetPage.map((asset) => asset.id)).toEqual([missing.id, present.id]);

        const all = service.getReleaseAssetManagementPage(release.id, { search: 'nothing-matches', selection: 'all' });
        expect(all.assetPage.map((asset) => asset.id)).toEqual([missing.id]);
      });

      it('returns an empty selected page with complete metadata when nothing is saved', () => {
        addAsset('a.txt');
        const release = service.createRelease(projectId, validInput());

        const page = service.getReleaseAssetManagementPage(release.id, {});
        expect(page.assetPage).toEqual([]);
        expect(page.assetTotal).toBe(0);
        expect(page.assetPageCount).toBe(1);
        expect(page.releaseAssets).toEqual([]);
        expect(page.eligibleAssetCount).toBe(1);
      });
    });
  });

  describe('listReleases', () => {
    it('returns releases for a project', () => {
      service.createRelease(projectId, validInput({ title: 'R1' }));
      service.createRelease(projectId, validInput({ title: 'R2' }));
      const releases = service.listReleases(projectId);
      expect(releases).toHaveLength(2);
    });

    it('ignores an obsolete release-status filter without exposing release status', () => {
      service.createRelease(projectId, validInput({ title: 'First' }));
      service.createRelease(projectId, validInput({ title: 'Second' }));
      const releases = service.listReleases(projectId, { status: 'planned' });

      expect(releases).toHaveLength(2);
      expect(releases.every((release) => release.project_status === 'ready')).toBe(true);
      expect(releases.every((release) => !Object.hasOwn(release, 'status'))).toBe(true);
    });

    it('excludes archived releases by default', () => {
      const r1 = service.createRelease(projectId, validInput({ title: 'Active' }));
      service.createRelease(projectId, validInput({ title: 'Archived' }));
      service.archiveRelease(r1.id);
      const releases = service.listReleases(projectId);
      expect(releases).toHaveLength(1);
      expect(releases[0].title).toBe('Archived');
    });

    it('includes archived releases when requested', () => {
      const r1 = service.createRelease(projectId, validInput({ title: 'Active' }));
      service.createRelease(projectId, validInput({ title: 'Archived' }));
      service.archiveRelease(r1.id);
      const releases = service.listReleases(projectId, { includeArchived: true });
      expect(releases).toHaveLength(2);
    });
  });

  describe('upcomingReleases (service)', () => {
    it('returns releases with future planned_date sorted asc', () => {
      const today = new Date();
      const future1 = new Date(today);
      future1.setDate(future1.getDate() + 30);
      const future2 = new Date(today);
      future2.setDate(future2.getDate() + 60);
      const fmt = (d) => d.toISOString().split('T')[0];
      const todayIso = fmt(today);

      service.createRelease(projectId, validInput({ title: 'Later', plannedDate: fmt(future2) }));
      service.createRelease(projectId, validInput({ title: 'Sooner', plannedDate: fmt(future1) }));
      const upcoming = service.upcomingReleases(todayIso);
      expect(upcoming[0].title).toBe('Sooner');
      expect(upcoming[1].title).toBe('Later');
    });

    it('excludes archived releases', () => {
      const today = new Date();
      const future = new Date(today);
      future.setDate(future.getDate() + 30);
      const fmt = (d) => d.toISOString().split('T')[0];
      const todayIso = fmt(today);
      const r1 = service.createRelease(projectId, validInput({ title: 'Archived', plannedDate: fmt(future) }));
      service.archiveRelease(r1.id);
      const upcoming = service.upcomingReleases(todayIso);
      expect(upcoming).toHaveLength(0);
    });
  });

  describe('overdueReleases (service)', () => {
    it('returns releases past their planned_date', () => {
      const today = new Date();
      const past = new Date(today);
      past.setDate(past.getDate() - 10);
      const fmt = (d) => d.toISOString().split('T')[0];
      const todayIso = fmt(today);
      service.createRelease(projectId, validInput({ title: 'Overdue', plannedDate: fmt(past) }));
      const overdue = service.overdueReleases(todayIso);
      expect(overdue).toHaveLength(1);
      expect(overdue[0].title).toBe('Overdue');
    });

    it('excludes archived releases', () => {
      const today = new Date();
      const past = new Date(today);
      past.setDate(past.getDate() - 10);
      const fmt = (d) => d.toISOString().split('T')[0];
      const todayIso = fmt(today);
      const r1 = service.createRelease(projectId, validInput({ title: 'Archived', plannedDate: fmt(past) }));
      service.archiveRelease(r1.id);
      const overdue = service.overdueReleases(todayIso);
      expect(overdue).toHaveLength(0);
    });
  });

  describe('existing missing asset behavior', () => {
    it('rejects selection of a missing asset', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      // Mark asset as missing
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, []);

      expect(() => {
        service.selectAssets(release.id, [{ assetId: asset.id }]);
      }).toThrow(ReleaseValidationError);
    });

    it('allows selecting an asset that was previously missing but is now present', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      // Mark as missing then restore
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, []);
      assetRepo.restorePresent(projectId, ['file.txt']);

      // Should not throw
      const result = service.selectAssets(release.id, [{ assetId: asset.id }]);
      expect(result).toHaveLength(1);
    });
  });

  describe('archived release guards', () => {
    it('selectAssets throws ReleaseArchivedError for archived release', () => {
      const release = service.createRelease(projectId, validInput());
      service.archiveRelease(release.id);
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      expect(() => {
        service.selectAssets(release.id, [{ assetId: asset.id }]);
      }).toThrow(ReleaseArchivedError);
    });

    it('addAssetToRelease throws ReleaseArchivedError for archived release', () => {
      const release = service.createRelease(projectId, validInput());
      service.archiveRelease(release.id);
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      expect(() => {
        service.addAssetToRelease(release.id, asset.id);
      }).toThrow(ReleaseArchivedError);
    });

    it('removeAssetFromRelease throws ReleaseArchivedError for archived release', () => {
      const release = service.createRelease(projectId, validInput());
      service.archiveRelease(release.id);
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));

      expect(() => {
        service.removeAssetFromRelease(release.id, asset.id);
      }).toThrow(ReleaseArchivedError);
    });
  });

  // ─── Phase 6B regression: archived parent project guard ────────────
  //
  // Archived projects must make their releases immutable. Every release
  // mutation (update, publish, archive, asset selection) must reject when
  // the parent project has been archived. Read operations remain available
  // so the project workspace can still display historical information.

  describe('archived parent project guard', () => {
    function archiveProject() {
      projectRepo.archive(projectId);
    }

    it('updateRelease throws ReleaseParentArchivedError when parent project is archived', () => {
      const release = service.createRelease(projectId, validInput());
      archiveProject();

      expect(() => {
        service.updateRelease(release.id, validInput({ title: 'New Title' }));
      }).toThrow(ReleaseParentArchivedError);
    });

    it('publishRelease throws ReleaseParentArchivedError when parent project is archived', () => {
      const { release } = createPublishableRelease(service, assetRepo, projectId);
      archiveProject();

      expect(() => {
        service.publishRelease(release.id);
      }).toThrow(ReleaseParentArchivedError);
    });

    it('archiveRelease throws ReleaseParentArchivedError when parent project is archived', () => {
      const release = service.createRelease(projectId, validInput());
      archiveProject();

      expect(() => {
        service.archiveRelease(release.id);
      }).toThrow(ReleaseParentArchivedError);
    });

    it('selectAssets throws ReleaseParentArchivedError when parent project is archived', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));
      archiveProject();

      expect(() => {
        service.selectAssets(release.id, [{ assetId: asset.id }]);
      }).toThrow(ReleaseParentArchivedError);
    });

    it('addAssetToRelease throws ReleaseParentArchivedError when parent project is archived', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));
      archiveProject();

      expect(() => {
        service.addAssetToRelease(release.id, asset.id);
      }).toThrow(ReleaseParentArchivedError);
    });

    it('removeAssetFromRelease throws ReleaseParentArchivedError when parent project is archived', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));
      service.addAssetToRelease(release.id, asset.id);
      archiveProject();

      expect(() => {
        service.removeAssetFromRelease(release.id, asset.id);
      }).toThrow(ReleaseParentArchivedError);
    });

    it('does not mutate the release when an archived-parent guard rejects', () => {
      // The guard must short-circuit BEFORE any write so a failed update
      // does not change the title, status, or other persisted fields.
      const release = service.createRelease(projectId, validInput({ title: 'Before' }));
      const originalUpdatedAt = release.updated_at;
      archiveProject();

      try {
        service.updateRelease(release.id, validInput({ title: 'After' }));
      } catch (_) {
        // expected
      }
      const after = service.findRelease(release.id);
      expect(after.title).toBe('Before');
      // The repository uses a WHERE id = AND archived_at IS NULL guard for
      // update; a non-archived release in an archived project must not be
      // touched by the failed call.
    });

    it('read operations remain available when parent project is archived', () => {
      // Archived projects do not lose their historical data. Reads through
      // findRelease, listReleaseAssets, listReleases, and findReleasesByAsset
      // must still work so the project workspace can render history.
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'file.txt', sampleAsset(projectId));
      service.addAssetToRelease(release.id, asset.id);
      archiveProject();

      expect(service.findRelease(release.id)).toBeTruthy();
      expect(service.findRelease(release.id).title).toBe(release.title);
      expect(service.listReleaseAssets(release.id)).toHaveLength(1);
      expect(service.listReleases(projectId)).toHaveLength(1);
      expect(service.findReleasesByAsset(asset.id)).toHaveLength(1);
    });

    it('preserves the failed call message so the route can render a useful error', () => {
      const release = service.createRelease(projectId, validInput());
      archiveProject();

      try {
        service.updateRelease(release.id, validInput());
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ReleaseParentArchivedError);
        expect(err.status).toBe(422);
        expect(err.message).toMatch(/archived/i);
      }
    });
  });

  // ─── Phase 8-1: Published release asset-selection lock ──────────────
  //
  // Once a release has status "published", its release_assets junction rows
  // must be immutable. The guard must reject every mutation path before any
  // write, and the junction rows must remain exactly unchanged after every
  // rejection. Scans may still update asset presence/metadata on the assets
  // table — that is tested separately in the HTTP scan-regression test.

  describe('published release asset-selection lock', () => {
    function createPublishedRelease() {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'pub-lock.txt', sampleAsset(projectId, { relativePath: 'pub-lock.txt' }));
      service.selectAssets(release.id, [{ assetId: asset.id, role: 'primary', sortOrder: 0 }]);
      const published = service.publishRelease(release.id, '2025-06-15');
      return { release: published, asset };
    }

    function snapshotReleaseAssets(releaseId) {
      return db.prepare('SELECT release_id, asset_id, role, sort_order, created_at FROM release_assets WHERE release_id = ? ORDER BY sort_order ASC, asset_id ASC').all(releaseId);
    }

    it('rejects bulk replacement of selected assets for a published release', () => {
      const { release, asset } = createPublishedRelease();
      const asset2 = assetRepo.upsert(projectId, 'another.txt', sampleAsset(projectId, { relativePath: 'another.txt' }));
      const before = snapshotReleaseAssets(release.id);

      expect(() => {
        service.selectAssets(release.id, [{ assetId: asset2.id, role: 'attachment', sortOrder: 0 }]);
      }).toThrow(ReleasePublishedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('rejects adding an asset to a published release', () => {
      const { release } = createPublishedRelease();
      const newAsset = assetRepo.upsert(projectId, 'new.txt', sampleAsset(projectId, { relativePath: 'new.txt' }));
      const before = snapshotReleaseAssets(release.id);

      expect(() => {
        service.addAssetToRelease(release.id, newAsset.id, 'attachment', 0);
      }).toThrow(ReleasePublishedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('rejects removing an asset from a published release', () => {
      const { release, asset } = createPublishedRelease();
      const before = snapshotReleaseAssets(release.id);

      expect(() => {
        service.removeAssetFromRelease(release.id, asset.id);
      }).toThrow(ReleasePublishedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('rejects missing-asset corrective removal from a published release', () => {
      const { release, asset } = createPublishedRelease();
      // Mark the asset as missing
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, []);
      const before = snapshotReleaseAssets(release.id);

      expect(() => {
        service.removeAssetFromRelease(release.id, asset.id);
      }).toThrow(ReleasePublishedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('rejects role-only update for a published release', () => {
      const { release, asset } = createPublishedRelease();
      const before = snapshotReleaseAssets(release.id);

      expect(() => {
        service.selectAssets(release.id, [{ assetId: asset.id, role: 'attachment', sortOrder: 0 }]);
      }).toThrow(ReleasePublishedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('rejects sort-order-only update for a published release', () => {
      const { release, asset } = createPublishedRelease();
      const before = snapshotReleaseAssets(release.id);

      expect(() => {
        service.selectAssets(release.id, [{ assetId: asset.id, role: 'primary', sortOrder: 5 }]);
      }).toThrow(ReleasePublishedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('rejects combined role/order update for a published release', () => {
      const { release, asset } = createPublishedRelease();
      const before = snapshotReleaseAssets(release.id);

      expect(() => {
        service.selectAssets(release.id, [{ assetId: asset.id, role: 'attachment', sortOrder: 9 }]);
      }).toThrow(ReleasePublishedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('preserves current behavior for non-published releases (ready)', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'ready-asset.txt', sampleAsset(projectId, { relativePath: 'ready-asset.txt' }));
      service.selectAssets(release.id, [{ assetId: asset.id, role: 'primary', sortOrder: 0 }]);

      // Should not throw — ready releases are not locked
      const asset2 = assetRepo.upsert(projectId, 'ready-asset2.txt', sampleAsset(projectId, { relativePath: 'ready-asset2.txt' }));
      service.addAssetToRelease(release.id, asset2.id, 'attachment', 1);
      const rows = snapshotReleaseAssets(release.id);
      expect(rows).toHaveLength(2);
    });

    it('preserves current behavior for unpublished releases', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'unpublished-asset.txt', sampleAsset(projectId, { relativePath: 'unpublished-asset.txt' }));

      // Should not throw — unpublished releases are not locked by this guard
      service.selectAssets(release.id, [{ assetId: asset.id, role: 'primary', sortOrder: 0 }]);
      const rows = snapshotReleaseAssets(release.id);
      expect(rows).toHaveLength(1);
    });
  });

  describe('preserve missing asset selections', () => {
    it('preserves existing selections for missing assets when replacing selections', () => {
      const release = service.createRelease(projectId, validInput());
      const presentAsset = assetRepo.upsert(projectId, 'present.txt', sampleAsset(projectId, { relativePath: 'present.txt' }));
      const missingAsset = assetRepo.upsert(projectId, 'missing.txt', sampleAsset(projectId, { relativePath: 'missing.txt' }));

      // Select both assets
      service.selectAssets(release.id, [
        { assetId: presentAsset.id, role: 'primary', sortOrder: 0 },
        { assetId: missingAsset.id, role: 'attachment', sortOrder: 1 },
      ]);

      // Mark missing asset as missing
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, ['present.txt']);

      // Replace selection — only select the present asset
      service.selectAssets(release.id, [{ assetId: presentAsset.id, role: 'primary', sortOrder: 0 }]);

      // Both should still be selected (missing asset preserved)
      const result = service.listReleaseAssets(release.id);
      expect(result).toHaveLength(2);
      const assetIds = result.map((r) => r.asset_id).sort();
      expect(assetIds).toContain(presentAsset.id);
      expect(assetIds).toContain(missingAsset.id);
    });

    it('does not preserve missing asset if it is explicitly re-selected', () => {
      const release = service.createRelease(projectId, validInput());
      const presentAsset = assetRepo.upsert(projectId, 'present.txt', sampleAsset(projectId, { relativePath: 'present.txt' }));
      const missingAsset = assetRepo.upsert(projectId, 'missing.txt', sampleAsset(projectId, { relativePath: 'missing.txt' }));

      // Select both assets
      service.selectAssets(release.id, [
        { assetId: presentAsset.id, role: 'primary', sortOrder: 0 },
        { assetId: missingAsset.id, role: 'attachment', sortOrder: 1 },
      ]);

      // Mark missing asset as missing
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, ['present.txt']);

      // Re-select both (including missing asset) — preserves existing missing
      service.selectAssets(release.id, [
        { assetId: presentAsset.id, role: 'primary', sortOrder: 0 },
        { assetId: missingAsset.id, role: 'attachment', sortOrder: 1 },
      ]);

      const result = service.listReleaseAssets(release.id);
      expect(result).toHaveLength(2);
    });

    it('cannot add a NEW selection of a missing asset', () => {
      const release = service.createRelease(projectId, validInput());
      const presentAsset = assetRepo.upsert(projectId, 'present.txt', sampleAsset(projectId, { relativePath: 'present.txt' }));
      const missingAsset = assetRepo.upsert(projectId, 'missing.txt', sampleAsset(projectId, { relativePath: 'missing.txt' }));

      // First select only the present asset
      service.selectAssets(release.id, [{ assetId: presentAsset.id, role: 'primary', sortOrder: 0 }]);

      // Mark missing asset as missing
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, ['present.txt']);

      // Try to add the missing asset as a NEW selection — should fail
      expect(() => {
        service.selectAssets(release.id, [
          { assetId: presentAsset.id, role: 'primary', sortOrder: 0 },
          { assetId: missingAsset.id, role: 'attachment', sortOrder: 1 },
        ]);
      }).toThrow(ReleaseValidationError);
    });
  });

  describe('membership-only asset selection', () => {
    it('retains persisted role/order and appends newly selected IDs', () => {
      const release = service.createRelease(projectId, validInput());
      const first = assetRepo.upsert(projectId, 'first.txt', sampleAsset(projectId, { relativePath: 'first.txt' }));
      const second = assetRepo.upsert(projectId, 'second.txt', sampleAsset(projectId, { relativePath: 'second.txt' }));
      const third = assetRepo.upsert(projectId, 'third.txt', sampleAsset(projectId, { relativePath: 'third.txt' }));

      service.selectAssets(release.id, [
        { assetId: first.id, role: 'primary', sortOrder: 5 },
        { assetId: second.id, role: 'attachment', sortOrder: 9 },
      ]);

      service.selectAssets(release.id, [
        { assetId: third.id },
        { assetId: first.id },
        { assetId: second.id },
      ], { membershipOnly: true });

      expect(service.listReleaseAssets(release.id).map(({ asset_id, role, sort_order }) => ({ asset_id, role, sort_order }))).toEqual([
        { asset_id: first.id, role: 'primary', sort_order: 0 },
        { asset_id: second.id, role: 'attachment', sort_order: 1 },
        { asset_id: third.id, role: 'attachment', sort_order: 2 },
      ]);
    });

    it('preserves a checked missing asset and removes it only when omitted', () => {
      const release = service.createRelease(projectId, validInput());
      const present = assetRepo.upsert(projectId, 'present.txt', sampleAsset(projectId, { relativePath: 'present.txt' }));
      const missing = assetRepo.upsert(projectId, 'missing.txt', sampleAsset(projectId, { relativePath: 'missing.txt' }));
      const added = assetRepo.upsert(projectId, 'added.txt', sampleAsset(projectId, { relativePath: 'added.txt' }));

      service.selectAssets(release.id, [
        { assetId: present.id, role: 'primary', sortOrder: 0 },
        { assetId: missing.id, role: 'preview', sortOrder: 1 },
      ]);
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, ['present.txt', 'added.txt']);

      service.selectAssets(release.id, [
        { assetId: added.id },
        { assetId: missing.id },
        { assetId: present.id },
      ], { membershipOnly: true });

      expect(service.listReleaseAssets(release.id).map(({ asset_id, role, sort_order }) => ({ asset_id, role, sort_order }))).toEqual([
        { asset_id: present.id, role: 'primary', sort_order: 0 },
        { asset_id: missing.id, role: 'preview', sort_order: 1 },
        { asset_id: added.id, role: 'attachment', sort_order: 2 },
      ]);

      service.selectAssets(release.id, [
        { assetId: present.id },
        { assetId: added.id },
      ], { membershipOnly: true });

      expect(service.listReleaseAssets(release.id).map(({ asset_id }) => asset_id)).toEqual([present.id, added.id]);
    });

    it('rejects a newly selected missing asset in membership-only mode', () => {
      const release = service.createRelease(projectId, validInput());
      const missing = assetRepo.upsert(projectId, 'missing-new.txt', sampleAsset(projectId, { relativePath: 'missing-new.txt' }));
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, []);

      expect(() => service.selectAssets(
        release.id,
        [{ assetId: missing.id }],
        { membershipOnly: true },
      )).toThrow(ReleaseValidationError);
    });
  });

  describe('upcomingReleases excludes past dates', () => {
    it('excludes releases with past planned_date', () => {
      const today = new Date();
      const past = new Date(today);
      past.setDate(past.getDate() - 30);
      const fmt = (d) => d.toISOString().split('T')[0];
      const todayIso = fmt(today);

      service.createRelease(projectId, validInput({ title: 'Past Release', plannedDate: fmt(past) }));
      const upcoming = service.upcomingReleases(todayIso);
      expect(upcoming).toHaveLength(0);
    });

    it('excludes releases with today as planned_date', () => {
      const today = '2025-06-15';
      service.createRelease(projectId, validInput({ title: 'Today Release', plannedDate: today }));
      const upcoming = service.upcomingReleases(today);
      expect(upcoming).toHaveLength(0);
    });

  });

  // ─── Published release metadata behavior ────────────────────────────────

  describe('published release metadata', () => {
    it('allows updating the title of a published release', () => {
      const { release: created } = createPublishableRelease(service, assetRepo, projectId);
      const published = service.publishRelease(created.id, '2025-06-15');

      const updated = service.updateRelease(published.id, validInput({
        title: 'Edited Title',
        publishedDate: '2025-06-15',
      }));
      expect(updated).not.toHaveProperty('status');
      expect(updated.title).toBe('Edited Title');
      expect(updated.published_date).toBe('2025-06-15');
    });

    it('allows updating the description of a published release', () => {
      const { release: created } = createPublishableRelease(service, assetRepo, projectId);
      const published = service.publishRelease(created.id, '2025-06-15');

      const updated = service.updateRelease(published.id, validInput({
        description: 'Updated description after publish',
        publishedDate: '2025-06-15',
      }));
      expect(updated).not.toHaveProperty('status');
      expect(updated.description).toBe('Updated description after publish');
    });

    it('archiving a published release preserves its publication date', () => {
      const { release: created } = createPublishableRelease(service, assetRepo, projectId);
      const published = service.publishRelease(created.id, '2025-06-15');

      const archived = service.archiveRelease(published.id);
      expect(archived).not.toHaveProperty('status');
      expect(archived.published_date).toBe('2025-06-15');
      expect(archived.archived_at).toBeTruthy();
    });
  });

  // ─── publishRelease: explicit date handling ─────────────────────────────
  //
  // The service accepts an optional date argument. The route is responsible
  // for resolving the date from the form, the persisted record, or today.
  // These tests pin the service's contract: an explicit date is preserved,
  // null/empty falls back to today, and an invalid date is rejected.

  describe('publishRelease date handling', () => {
    it('uses the explicit date when one is provided', () => {
      const { release: created } = createPublishableRelease(service, assetRepo, projectId);
      const published = service.publishRelease(created.id, '2025-12-15');
      expect(published.published_date).toBe('2025-12-15');
    });

    it('treats a previously-set published_date as already published', () => {
      const { release: created } = createPublishableRelease(service, assetRepo, projectId);
      service.updateRelease(created.id, validInput({
        publishedDate: '2025-08-20',
      }));

      expect(() => service.publishRelease(created.id, '2025-09-30')).toThrow(ReleaseValidationError);
      expect(snapshotReleaseRow(db, created.id).published_date).toBe('2025-08-20');
    });

    it('falls back to the application-local today when no date is provided', () => {
      const { release: created } = createPublishableRelease(service, assetRepo, projectId);
      const published = service.publishRelease(created.id);
      expect(published.published_date).toBe(getLocalTodayIso());
    });

    it('rejects an empty string and falls back to local today', () => {
      const { release: created } = createPublishableRelease(service, assetRepo, projectId);
      const published = service.publishRelease(created.id, '');
      expect(published.published_date).toBe(getLocalTodayIso());
    });
  });

  // ─── Phase 9-2: Explicit Release Asset Curation Mutations ─────────────

  describe('addCandidateAsset', () => {
    it('adds a candidate asset with default role attachment and appended contiguous order', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));

      // Add first asset
      const result1 = service.addCandidateAsset(release.id, asset1.id);
      expect(result1.asset_id).toBe(asset1.id);
      expect(result1.role).toBe('attachment');
      expect(result1.sort_order).toBe(0);

      // Add second asset — appended after first
      const result2 = service.addCandidateAsset(release.id, asset2.id);
      expect(result2.asset_id).toBe(asset2.id);
      expect(result2.role).toBe('attachment');
      expect(result2.sort_order).toBe(1);

      // Verify both in deterministic order
      const all = service.listReleaseAssets(release.id);
      expect(all).toHaveLength(2);
      expect(all[0].asset_id).toBe(asset1.id);
      expect(all[0].sort_order).toBe(0);
      expect(all[1].asset_id).toBe(asset2.id);
      expect(all[1].sort_order).toBe(1);
    });

    it('rejects missing asset', () => {
      const release = service.createRelease(projectId, validInput());
      expect(() => {
        service.addCandidateAsset(release.id, 99999);
      }).toThrow(AssetNotFoundError);
    });

    it('rejects already-selected asset', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'dup.txt', sampleAsset(projectId));
      service.addCandidateAsset(release.id, asset.id);
      expect(() => {
        service.addCandidateAsset(release.id, asset.id);
      }).toThrow(ReleaseValidationError);
    });

    it('rejects cross-project asset', () => {
      const release = service.createRelease(projectId, validInput());
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const otherAsset = assetRepo.upsert(otherProject.id, 'other.txt', sampleAsset(otherProject.id));

      expect(() => {
        service.addCandidateAsset(release.id, otherAsset.id);
      }).toThrow(ReleaseValidationError);
    });

    it('rejects missing (is_present=0) asset', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'missing.txt', sampleAsset(projectId));
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, []);

      expect(() => {
        service.addCandidateAsset(release.id, asset.id);
      }).toThrow(ReleaseValidationError);
    });

    it('throws ReleaseNotFoundError for non-existent release', () => {
      expect(() => {
        service.addCandidateAsset(99999, 1);
      }).toThrow(ReleaseNotFoundError);
    });

    it('throws ReleaseArchivedError for archived release', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'arch.txt', sampleAsset(projectId));
      service.archiveRelease(release.id);
      expect(() => {
        service.addCandidateAsset(release.id, asset.id);
      }).toThrow(ReleaseArchivedError);
    });

    it('throws ReleaseParentArchivedError when parent project is archived', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'parent-arch.txt', sampleAsset(projectId));
      projectRepo.archive(projectId);
      expect(() => {
        service.addCandidateAsset(release.id, asset.id);
      }).toThrow(ReleaseParentArchivedError);
    });

    it('throws ReleasePublishedError for published release', () => {
      const { release } = createPublishableRelease(service, assetRepo, projectId);
      const published = service.publishRelease(release.id, '2025-06-15');
      const newAsset = assetRepo.upsert(projectId, 'new.txt', sampleAsset(projectId, { relativePath: 'new.txt' }));
      expect(() => {
        service.addCandidateAsset(published.id, newAsset.id);
      }).toThrow(ReleasePublishedError);
    });
  });

  describe('removeSelectedAsset', () => {
    it('removes exactly one selected asset and closes order gaps', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      const asset3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));

      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 1 },
        { assetId: asset3.id, role: 'attachment', sortOrder: 2 },
      ]);

      const removed = service.removeSelectedAsset(release.id, asset2.id);
      expect(removed).toBe(true);

      const remaining = service.listReleaseAssets(release.id);
      expect(remaining).toHaveLength(2);
      // Order must be contiguous 0, 1
      expect(remaining[0].asset_id).toBe(asset1.id);
      expect(remaining[0].sort_order).toBe(0);
      expect(remaining[1].asset_id).toBe(asset3.id);
      expect(remaining[1].sort_order).toBe(1);
    });

    it('rejects unselected asset', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'unsel.txt', sampleAsset(projectId));
      expect(() => {
        service.removeSelectedAsset(release.id, asset.id);
      }).toThrow(ReleaseValidationError);
    });

    it('rejects cross-project asset', () => {
      const release = service.createRelease(projectId, validInput());
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const otherAsset = assetRepo.upsert(otherProject.id, 'other.txt', sampleAsset(otherProject.id));
      expect(() => {
        service.removeSelectedAsset(release.id, otherAsset.id);
      }).toThrow(ReleaseValidationError);
    });

    it('leaves asset record and filesystem untouched', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'keep.txt', sampleAsset(projectId));
      service.addCandidateAsset(release.id, asset.id);

      const beforeAsset = assetRepo.findById(asset.id);
      service.removeSelectedAsset(release.id, asset.id);

      const afterAsset = assetRepo.findById(asset.id);
      expect(afterAsset).toEqual(beforeAsset);
    });

    it('throws ReleaseArchivedError for archived release', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'arch-rem.txt', sampleAsset(projectId));
      service.addCandidateAsset(release.id, asset.id);
      service.archiveRelease(release.id);
      expect(() => {
        service.removeSelectedAsset(release.id, asset.id);
      }).toThrow(ReleaseArchivedError);
    });

    it('throws ReleaseParentArchivedError when parent project is archived', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'parent-arch-rem.txt', sampleAsset(projectId));
      service.addCandidateAsset(release.id, asset.id);
      projectRepo.archive(projectId);
      expect(() => {
        service.removeSelectedAsset(release.id, asset.id);
      }).toThrow(ReleaseParentArchivedError);
    });

    it('throws ReleasePublishedError for published release', () => {
      const { release, asset } = createPublishableRelease(service, assetRepo, projectId);
      const published = service.publishRelease(release.id, '2025-06-15');
      expect(() => {
        service.removeSelectedAsset(published.id, asset.id);
      }).toThrow(ReleasePublishedError);
    });
  });

  describe('updateAssetRole', () => {
    it('updates role to primary', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'role.txt', sampleAsset(projectId));
      service.addCandidateAsset(release.id, asset.id);

      const updated = service.updateAssetRole(release.id, asset.id, 'primary');
      expect(updated).toBe(true);

      const rows = service.listReleaseAssets(release.id);
      expect(rows[0].role).toBe('primary');
    });

    it('updates role to preview', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'role-prev.txt', sampleAsset(projectId));
      service.addCandidateAsset(release.id, asset.id);

      service.updateAssetRole(release.id, asset.id, 'preview');
      const rows = service.listReleaseAssets(release.id);
      expect(rows[0].role).toBe('preview');
    });

    it('rejects the obsolete source role', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'role-src.txt', sampleAsset(projectId));
      service.addCandidateAsset(release.id, asset.id);

      expect(() => service.updateAssetRole(release.id, asset.id, 'source')).toThrow(ReleaseValidationError);
      expect(service.listReleaseAssets(release.id)[0].role).toBe('attachment');
    });

    it('rejects invalid role', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'bad-role.txt', sampleAsset(projectId));
      service.addCandidateAsset(release.id, asset.id);

      expect(() => {
        service.updateAssetRole(release.id, asset.id, 'invalid-role');
      }).toThrow(ReleaseValidationError);
    });

    it('only target row changes, other rows unchanged', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));

      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 1 },
      ]);

      service.updateAssetRole(release.id, asset1.id, 'preview');

      const rows = service.listReleaseAssets(release.id);
      expect(rows).toHaveLength(2);
      expect(rows[0].asset_id).toBe(asset1.id);
      expect(rows[0].role).toBe('preview');
      expect(rows[0].sort_order).toBe(0);
      expect(rows[1].asset_id).toBe(asset2.id);
      expect(rows[1].role).toBe('attachment');
      expect(rows[1].sort_order).toBe(1);
    });

    it('order remains unchanged after role update', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));

      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 5 },
      ]);

      service.updateAssetRole(release.id, asset1.id, 'preview');

      const rows = service.listReleaseAssets(release.id);
      expect(rows[0].sort_order).toBe(0);
      expect(rows[1].sort_order).toBe(5);
    });

    it('throws ReleasePublishedError for published release', () => {
      const { release, asset } = createPublishableRelease(service, assetRepo, projectId);
      const published = service.publishRelease(release.id, '2025-06-15');
      expect(() => {
        service.updateAssetRole(published.id, asset.id, 'attachment');
      }).toThrow(ReleasePublishedError);
    });
  });

  describe('moveAssetUp', () => {
    it('moves middle asset up', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      const asset3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));

      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 1 },
        { assetId: asset3.id, role: 'attachment', sortOrder: 2 },
      ]);

      const moved = service.moveAssetUp(release.id, asset2.id);
      expect(moved).toBe(true);

      const rows = service.listReleaseAssets(release.id);
      expect(rows).toHaveLength(3);
      // asset2 should now be first (sort_order 0)
      expect(rows[0].asset_id).toBe(asset2.id);
      expect(rows[0].sort_order).toBe(0);
      expect(rows[1].asset_id).toBe(asset1.id);
      expect(rows[1].sort_order).toBe(1);
      expect(rows[2].asset_id).toBe(asset3.id);
      expect(rows[2].sort_order).toBe(2);
    });

    it('first-item move up is a no-op', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));

      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 1 },
      ]);

      const moved = service.moveAssetUp(release.id, asset1.id);
      expect(moved).toBe(false);

      const rows = service.listReleaseAssets(release.id);
      expect(rows).toHaveLength(2);
      expect(rows[0].asset_id).toBe(asset1.id);
      expect(rows[1].asset_id).toBe(asset2.id);
    });

    it('handles equal legacy orders deterministically', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));

      // Insert with equal sort_order — deterministic tie-break is asset_id ASC
      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 0 },
      ]);

      // asset2 has higher asset_id, so it comes second in sort_order ASC, asset_id ASC
      // Moving asset2 up should swap with asset1
      const moved = service.moveAssetUp(release.id, asset2.id);
      expect(moved).toBe(true);

      const rows = service.listReleaseAssets(release.id);
      expect(rows).toHaveLength(2);
      // After reindex: contiguous 0, 1
      expect(rows[0].sort_order).toBe(0);
      expect(rows[1].sort_order).toBe(1);
    });

    it('throws ReleasePublishedError for published release', () => {
      const { release, asset } = createPublishableRelease(service, assetRepo, projectId);
      const published = service.publishRelease(release.id, '2025-06-15');
      expect(() => {
        service.moveAssetUp(published.id, asset.id);
      }).toThrow(ReleasePublishedError);
    });
  });

  describe('moveAssetDown', () => {
    it('moves middle asset down', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      const asset3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));

      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 1 },
        { assetId: asset3.id, role: 'attachment', sortOrder: 2 },
      ]);

      const moved = service.moveAssetDown(release.id, asset2.id);
      expect(moved).toBe(true);

      const rows = service.listReleaseAssets(release.id);
      expect(rows).toHaveLength(3);
      // asset2 should now be last (sort_order 2)
      expect(rows[0].asset_id).toBe(asset1.id);
      expect(rows[0].sort_order).toBe(0);
      expect(rows[1].asset_id).toBe(asset3.id);
      expect(rows[1].sort_order).toBe(1);
      expect(rows[2].asset_id).toBe(asset2.id);
      expect(rows[2].sort_order).toBe(2);
    });

    it('last-item move down is a no-op', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));

      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 1 },
      ]);

      const moved = service.moveAssetDown(release.id, asset2.id);
      expect(moved).toBe(false);

      const rows = service.listReleaseAssets(release.id);
      expect(rows).toHaveLength(2);
      expect(rows[0].asset_id).toBe(asset1.id);
      expect(rows[1].asset_id).toBe(asset2.id);
    });

    it('order persisted contiguously after move', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      const asset3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));

      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 1 },
        { assetId: asset3.id, role: 'attachment', sortOrder: 2 },
      ]);

      service.moveAssetDown(release.id, asset1.id);

      const rows = service.listReleaseAssets(release.id);
      expect(rows[0].sort_order).toBe(0);
      expect(rows[1].sort_order).toBe(1);
      expect(rows[2].sort_order).toBe(2);
    });

    it('throws ReleasePublishedError for published release', () => {
      const { release, asset } = createPublishableRelease(service, assetRepo, projectId);
      const published = service.publishRelease(release.id, '2025-06-15');
      expect(() => {
        service.moveAssetDown(published.id, asset.id);
      }).toThrow(ReleasePublishedError);
    });
  });

  // ─── Phase 9-2: Mutation guard coverage for all new mutations ──────

  describe('Phase 9-2 mutation guards', () => {
    function snapshotReleaseAssets(releaseId) {
      return db.prepare('SELECT release_id, asset_id, role, sort_order, created_at FROM release_assets WHERE release_id = ? ORDER BY sort_order ASC, asset_id ASC').all(releaseId);
    }

    function createPublishedRelease() {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'pub-lifecycle.txt', sampleAsset(projectId, { relativePath: 'pub-lifecycle.txt' }));
      service.selectAssets(release.id, [{ assetId: asset.id, role: 'primary', sortOrder: 0 }]);
      const published = service.publishRelease(release.id, '2025-06-15');
      return { release: published, asset };
    }

    it('addCandidateAsset rejects published release and leaves rows unchanged', () => {
      const { release } = createPublishedRelease();
      const newAsset = assetRepo.upsert(projectId, 'new-pub.txt', sampleAsset(projectId, { relativePath: 'new-pub.txt' }));
      const before = snapshotReleaseAssets(release.id);

      expect(() => {
        service.addCandidateAsset(release.id, newAsset.id);
      }).toThrow(ReleasePublishedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('addCandidateAsset rejects archived release and leaves rows unchanged', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'arch-add.txt', sampleAsset(projectId));
      service.addCandidateAsset(release.id, asset.id);
      service.archiveRelease(release.id);
      const before = snapshotReleaseAssets(release.id);

      const newAsset = assetRepo.upsert(projectId, 'new-arch.txt', sampleAsset(projectId, { relativePath: 'new-arch.txt' }));
      expect(() => {
        service.addCandidateAsset(release.id, newAsset.id);
      }).toThrow(ReleaseArchivedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('addCandidateAsset rejects archived parent and leaves rows unchanged', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'parent-arch-add.txt', sampleAsset(projectId));
      service.addCandidateAsset(release.id, asset.id);
      projectRepo.archive(projectId);
      const before = snapshotReleaseAssets(release.id);

      const newAsset = assetRepo.upsert(projectId, 'new-parent-arch.txt', sampleAsset(projectId, { relativePath: 'new-parent-arch.txt' }));
      expect(() => {
        service.addCandidateAsset(release.id, newAsset.id);
      }).toThrow(ReleaseParentArchivedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('removeSelectedAsset rejects published release and leaves rows unchanged', () => {
      const { release, asset } = createPublishedRelease();
      const before = snapshotReleaseAssets(release.id);

      expect(() => {
        service.removeSelectedAsset(release.id, asset.id);
      }).toThrow(ReleasePublishedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('removeSelectedAsset rejects archived release and leaves rows unchanged', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'arch-rem2.txt', sampleAsset(projectId));
      service.addCandidateAsset(release.id, asset.id);
      service.archiveRelease(release.id);
      const before = snapshotReleaseAssets(release.id);

      expect(() => {
        service.removeSelectedAsset(release.id, asset.id);
      }).toThrow(ReleaseArchivedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('removeSelectedAsset rejects archived parent and leaves rows unchanged', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'parent-arch-rem2.txt', sampleAsset(projectId));
      service.addCandidateAsset(release.id, asset.id);
      projectRepo.archive(projectId);
      const before = snapshotReleaseAssets(release.id);

      expect(() => {
        service.removeSelectedAsset(release.id, asset.id);
      }).toThrow(ReleaseParentArchivedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('updateAssetRole rejects published release and leaves rows unchanged', () => {
      const { release, asset } = createPublishedRelease();
      const before = snapshotReleaseAssets(release.id);

      expect(() => {
        service.updateAssetRole(release.id, asset.id, 'attachment');
      }).toThrow(ReleasePublishedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('updateAssetRole rejects archived release and leaves rows unchanged', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'arch-role.txt', sampleAsset(projectId));
      service.addCandidateAsset(release.id, asset.id);
      service.archiveRelease(release.id);
      const before = snapshotReleaseAssets(release.id);

      expect(() => {
        service.updateAssetRole(release.id, asset.id, 'preview');
      }).toThrow(ReleaseArchivedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('updateAssetRole rejects archived parent and leaves rows unchanged', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'parent-arch-role.txt', sampleAsset(projectId));
      service.addCandidateAsset(release.id, asset.id);
      projectRepo.archive(projectId);
      const before = snapshotReleaseAssets(release.id);

      expect(() => {
        service.updateAssetRole(release.id, asset.id, 'preview');
      }).toThrow(ReleaseParentArchivedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('moveAssetUp rejects published release and leaves rows unchanged', () => {
      const { release, asset } = createPublishedRelease();
      const before = snapshotReleaseAssets(release.id);

      expect(() => {
        service.moveAssetUp(release.id, asset.id);
      }).toThrow(ReleasePublishedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('moveAssetDown rejects published release and leaves rows unchanged', () => {
      const { release, asset } = createPublishedRelease();
      const before = snapshotReleaseAssets(release.id);

      expect(() => {
        service.moveAssetDown(release.id, asset.id);
      }).toThrow(ReleasePublishedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('addCandidateAsset rejects archived parent and leaves rows unchanged', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'parent-arch-add.txt', sampleAsset(projectId));
      service.addCandidateAsset(release.id, asset.id);
      projectRepo.archive(projectId);
      const before = snapshotReleaseAssets(release.id);

      const newAsset = assetRepo.upsert(projectId, 'new-parent-arch.txt', sampleAsset(projectId, { relativePath: 'new-parent-arch.txt' }));
      expect(() => {
        service.addCandidateAsset(release.id, newAsset.id);
      }).toThrow(ReleaseParentArchivedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('removeSelectedAsset rejects archived parent and leaves rows unchanged', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'parent-arch-rem2.txt', sampleAsset(projectId));
      service.addCandidateAsset(release.id, asset.id);
      projectRepo.archive(projectId);
      const before = snapshotReleaseAssets(release.id);

      expect(() => {
        service.removeSelectedAsset(release.id, asset.id);
      }).toThrow(ReleaseParentArchivedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('updateAssetRole rejects archived parent and leaves rows unchanged', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'parent-arch-role.txt', sampleAsset(projectId));
      service.addCandidateAsset(release.id, asset.id);
      projectRepo.archive(projectId);
      const before = snapshotReleaseAssets(release.id);

      expect(() => {
        service.updateAssetRole(release.id, asset.id, 'preview');
      }).toThrow(ReleaseParentArchivedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('moveAssetUp rejects archived parent and leaves rows unchanged', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      service.addCandidateAsset(release.id, asset1.id);
      service.addCandidateAsset(release.id, asset2.id);
      projectRepo.archive(projectId);
      const before = snapshotReleaseAssets(release.id);

      expect(() => {
        service.moveAssetUp(release.id, asset2.id);
      }).toThrow(ReleaseParentArchivedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('moveAssetDown rejects archived parent and leaves rows unchanged', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      service.addCandidateAsset(release.id, asset1.id);
      service.addCandidateAsset(release.id, asset2.id);
      projectRepo.archive(projectId);
      const before = snapshotReleaseAssets(release.id);

      expect(() => {
        service.moveAssetDown(release.id, asset1.id);
      }).toThrow(ReleaseParentArchivedError);

      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });
  });

  // ─── Phase 9-3: Cross-project write rejection ─────────────────────────

  describe('cross-project write rejection', () => {
    let otherProjectId;
    let otherAsset;

    beforeEach(() => {
      const otherProject = projectRepo.create(sampleProject({ title: 'Other Project' }));
      otherProjectId = otherProject.id;
      otherAsset = assetRepo.upsert(otherProjectId, 'other.txt', sampleAsset(otherProjectId, { relativePath: 'other.txt' }));
    });

    it('addCandidateAsset rejects cross-project asset', () => {
      const release = service.createRelease(projectId, validInput());
      expect(() => {
        service.addCandidateAsset(release.id, otherAsset.id);
      }).toThrow(ReleaseValidationError);
    });

    it('removeSelectedAsset rejects cross-project asset', () => {
      const release = service.createRelease(projectId, validInput());
      expect(() => {
        service.removeSelectedAsset(release.id, otherAsset.id);
      }).toThrow(ReleaseValidationError);
    });

    it('updateAssetRole rejects cross-project asset', () => {
      const release = service.createRelease(projectId, validInput());
      expect(() => {
        service.updateAssetRole(release.id, otherAsset.id, 'preview');
      }).toThrow(ReleaseValidationError);
    });

    it('moveAssetUp rejects cross-project asset', () => {
      const release = service.createRelease(projectId, validInput());
      expect(() => {
        service.moveAssetUp(release.id, otherAsset.id);
      }).toThrow(ReleaseValidationError);
    });

    it('moveAssetDown rejects cross-project asset', () => {
      const release = service.createRelease(projectId, validInput());
      expect(() => {
        service.moveAssetDown(release.id, otherAsset.id);
      }).toThrow(ReleaseValidationError);
    });
  });

  // ─── Phase 9-3: Scan-presence regression ──────────────────────────────

  describe('scan-presence regression', () => {
    it('scanning can change asset presence without changing selections', () => {
      const release = service.createRelease(projectId, validInput());
      const asset = assetRepo.upsert(projectId, 'scan-test.txt', sampleAsset(projectId, { relativePath: 'scan-test.txt' }));
      service.addCandidateAsset(release.id, asset.id);

      // Mark as missing (simulating scan removal)
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, []);
      let selections = service.listReleaseAssets(release.id);
      expect(selections).toHaveLength(1);
      expect(selections[0].is_present).toBe(0);

      // Restore (simulating scan re-discovery)
      assetRepo.restorePresent(projectId, ['scan-test.txt']);
      selections = service.listReleaseAssets(release.id);
      expect(selections).toHaveLength(1);
      expect(selections[0].is_present).toBe(1);
    });
  });

  // ─── Phase 9: Mutation-Transaction Atomicity ──────────────────────────

  describe('Phase 9 mutation-transaction atomicity', () => {
    function snapshotReleaseAssets(releaseId) {
      return db.prepare(
        'SELECT release_id, asset_id, role, sort_order, created_at FROM release_assets WHERE release_id = ? ORDER BY sort_order ASC, asset_id ASC'
      ).all(releaseId);
    }

    it('remove + reindex succeeds atomically', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      const asset3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));

      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 1 },
        { assetId: asset3.id, role: 'attachment', sortOrder: 2 },
      ]);

      const removed = service.removeSelectedAsset(release.id, asset2.id);
      expect(removed).toBe(true);

      const remaining = snapshotReleaseAssets(release.id);
      expect(remaining).toHaveLength(2);
      expect(remaining[0].asset_id).toBe(asset1.id);
      expect(remaining[0].sort_order).toBe(0);
      expect(remaining[1].asset_id).toBe(asset3.id);
      expect(remaining[1].sort_order).toBe(1);
    });

    it('successful remove reindexes atomically through the repository API', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 1 },
      ]);

      const repo = createReleaseRepository(db);
      expect(typeof repo.removeAndReindexReleaseAsset).toBe('function');
      expect(typeof repo.reorderReleaseAssets).toBe('function');

      const result = repo.removeAndReindexReleaseAsset(release.id, asset1.id);
      expect(result).toBe(true);

      const after = snapshotReleaseAssets(release.id);
      expect(after).toHaveLength(1);
      expect(after[0].asset_id).toBe(asset2.id);
      expect(after[0].sort_order).toBe(0);
    });

    it('Move Up succeeds with equal legacy sort_order values', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      const asset3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));

      // All three with equal sort_order — tie-break is asset_id ASC
      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 0 },
        { assetId: asset3.id, role: 'attachment', sortOrder: 0 },
      ]);

      // Order is asset1, asset2, asset3 (asset_id ASC tie-break)
      // Move asset3 up — should become second
      const moved = service.moveAssetUp(release.id, asset3.id);
      expect(moved).toBe(true);

      const rows = snapshotReleaseAssets(release.id);
      expect(rows).toHaveLength(3);
      // After reindex: asset1(0), asset3(1), asset2(2)
      expect(rows[0].asset_id).toBe(asset1.id);
      expect(rows[0].sort_order).toBe(0);
      expect(rows[1].asset_id).toBe(asset3.id);
      expect(rows[1].sort_order).toBe(1);
      expect(rows[2].asset_id).toBe(asset2.id);
      expect(rows[2].sort_order).toBe(2);
    });

    it('Move Down succeeds with equal legacy sort_order values', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      const asset3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));

      // All three with equal sort_order — tie-break is asset_id ASC
      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 0 },
        { assetId: asset3.id, role: 'attachment', sortOrder: 0 },
      ]);

      // Order is asset1, asset2, asset3 (asset_id ASC tie-break)
      // Move asset1 down — should become second
      const moved = service.moveAssetDown(release.id, asset1.id);
      expect(moved).toBe(true);

      const rows = snapshotReleaseAssets(release.id);
      expect(rows).toHaveLength(3);
      // After reindex: asset2(0), asset1(1), asset3(2)
      expect(rows[0].asset_id).toBe(asset2.id);
      expect(rows[0].sort_order).toBe(0);
      expect(rows[1].asset_id).toBe(asset1.id);
      expect(rows[1].sort_order).toBe(1);
      expect(rows[2].asset_id).toBe(asset3.id);
      expect(rows[2].sort_order).toBe(2);
    });

    it('requested asset actually changes position on move up', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      const asset3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));

      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 1 },
        { assetId: asset3.id, role: 'attachment', sortOrder: 2 },
      ]);

      service.moveAssetUp(release.id, asset3.id);

      const rows = snapshotReleaseAssets(release.id);
      // asset3 moved from position 2 to position 1
      expect(rows[1].asset_id).toBe(asset3.id);
    });

    it('requested asset actually changes position on move down', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      const asset3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));

      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 1 },
        { assetId: asset3.id, role: 'attachment', sortOrder: 2 },
      ]);

      service.moveAssetDown(release.id, asset1.id);

      const rows = snapshotReleaseAssets(release.id);
      // asset1 moved from position 0 to position 1
      expect(rows[1].asset_id).toBe(asset1.id);
    });

    it('final ordering is contiguous after remove', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      const asset3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));

      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 5 },
        { assetId: asset3.id, role: 'attachment', sortOrder: 9 },
      ]);

      service.removeSelectedAsset(release.id, asset2.id);

      const rows = snapshotReleaseAssets(release.id);
      expect(rows).toHaveLength(2);
      expect(rows[0].sort_order).toBe(0);
      expect(rows[1].sort_order).toBe(1);
    });

    it('final ordering is contiguous after move', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      const asset3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));

      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 5 },
        { assetId: asset3.id, role: 'attachment', sortOrder: 9 },
      ]);

      service.moveAssetUp(release.id, asset3.id);

      const rows = snapshotReleaseAssets(release.id);
      expect(rows.map((r) => r.sort_order)).toEqual([0, 1, 2]);
    });

    it('successful reorder persists the complete desired order', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      const asset3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));

      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 1 },
        { assetId: asset3.id, role: 'attachment', sortOrder: 2 },
      ]);

      const repo = createReleaseRepository(db);
      expect(typeof repo.reorderReleaseAssets).toBe('function');

      repo.reorderReleaseAssets(release.id, [asset3.id, asset2.id, asset1.id]);

      const after = snapshotReleaseAssets(release.id);
      expect(after).toHaveLength(3);
      expect(after[0].asset_id).toBe(asset3.id);
      expect(after[0].sort_order).toBe(0);
      expect(after[1].asset_id).toBe(asset2.id);
      expect(after[1].sort_order).toBe(1);
      expect(after[2].asset_id).toBe(asset1.id);
      expect(after[2].sort_order).toBe(2);
    });

    it('boundary no-op preserves complete junction rows', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));

      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 1 },
      ]);

      const before = snapshotReleaseAssets(release.id);

      // First-item Move Up — no-op
      const upResult = service.moveAssetUp(release.id, asset1.id);
      expect(upResult).toBe(false);
      expect(snapshotReleaseAssets(release.id)).toEqual(before);

      // Last-item Move Down — no-op
      const downResult = service.moveAssetDown(release.id, asset2.id);
      expect(downResult).toBe(false);
      expect(snapshotReleaseAssets(release.id)).toEqual(before);
    });

    it('existing created_at values remain unchanged during reorder', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      const asset3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));

      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 1 },
        { assetId: asset3.id, role: 'attachment', sortOrder: 2 },
      ]);

      const before = snapshotReleaseAssets(release.id);

      // Move asset3 up — triggers reorder
      service.moveAssetUp(release.id, asset3.id);

      const after = snapshotReleaseAssets(release.id);
      // created_at must be preserved for every row
      for (const row of after) {
        const original = before.find((b) => b.asset_id === row.asset_id);
        expect(row.created_at).toBe(original.created_at);
      }
    });

    it('existing created_at values remain unchanged during remove and reindex', () => {
      const release = service.createRelease(projectId, validInput());
      const asset1 = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt' }));
      const asset2 = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt' }));
      const asset3 = assetRepo.upsert(projectId, 'c.txt', sampleAsset(projectId, { relativePath: 'c.txt' }));

      service.selectAssets(release.id, [
        { assetId: asset1.id, role: 'primary', sortOrder: 0 },
        { assetId: asset2.id, role: 'attachment', sortOrder: 1 },
        { assetId: asset3.id, role: 'attachment', sortOrder: 2 },
      ]);

      const before = snapshotReleaseAssets(release.id);

      service.removeSelectedAsset(release.id, asset2.id);

      const after = snapshotReleaseAssets(release.id);
      // created_at must be preserved for remaining rows
      for (const row of after) {
        const original = before.find((b) => b.asset_id === row.asset_id);
        expect(row.created_at).toBe(original.created_at);
      }
    });

    it('service contains no direct SQL for these operations', () => {
      const serviceSource = fs.readFileSync(
        new URL('../src/services/release-service.js', import.meta.url),
        'utf-8'
      );
      // The service must not contain db.prepare(...) calls
      expect(serviceSource).not.toMatch(/db\.prepare\s*\(/);
    });
  });

  // ─── Phase 9-5: N+1 query instrumentation ────────────────────────────
  //
  // The service calls db.prepare at construction time. To count every
  // statement execution — not just preparations — we patch db.prepare
  // BEFORE creating the service so that every .all() / .get() / .run()
  // on every prepared statement (including the repository's internal
  // pre-prepared statements) is counted.
  // The counter resets between measurements. Data setup is done with
  // raw repositories (created before instrumentation) so that the
  // service itself is the only measured component.

  describe('Phase 9-5 N+1 query instrumentation', () => {
    /**
     * Patch db.prepare so every returned Statement counts
     * .all(), .get(), and .run() invocations on a shared counter.
     * Returns a getter function that returns the current count.
     */
    function instrumentExecutionCount(tmpDb) {
      let count = 0;
      const origPrepare = tmpDb.prepare.bind(tmpDb);
      tmpDb.prepare = function (sql) {
        const stmt = origPrepare(sql);
        const origAll = stmt.all.bind(stmt);
        const origGet = stmt.get.bind(stmt);
        const origRun = stmt.run.bind(stmt);
        stmt.all = function (...args) { count++; return origAll(...args); };
        stmt.get = function (...args) { count++; return origGet(...args); };
        stmt.run = function (...args) { count++; return origRun(...args); };
        return stmt;
      };
      return () => count;
    }

    it('query execution count is bounded as candidate count grows', () => {
      // Create repositories BEFORE instrumenting for data setup
      const localProjectRepo = createProjectRepository(db);
      const localAssetRepo = createAssetRepository(db);
      const localRelRepo = createReleaseRepository(db);

      const project = localProjectRepo.create(sampleProject({ title: 'N+1 Bound Test' }));
      const release = localRelRepo.create({ projectId: project.id, ...validInput({ title: 'N+1 Bound Release' }) });

      // Insert 3 present, unselected assets
      for (let i = 0; i < 3; i++) {
        localAssetRepo.upsert(project.id, `asset${i}.txt`,
          sampleAsset(project.id, { relativePath: `asset${i}.txt` })
        );
      }

      // Instrument BEFORE creating the service so every statement
      // prepared by the repositories inside the service is counted.
      const getCount = instrumentExecutionCount(db);
      const localService = createReleaseService({ db });

      // First measurement: 3 candidates
      const countWith3 = getCount();
      localService.getReleaseAssetManagementPage(release.id, {});
      const execWith3 = getCount() - countWith3;

      // Add 2 more candidates using raw repo (NOT the instrumented service)
      for (let i = 3; i < 5; i++) {
        localAssetRepo.upsert(project.id, `asset${i}.txt`,
          sampleAsset(project.id, { relativePath: `asset${i}.txt` })
        );
      }

      // Second measurement: 5 candidates (same number of queries)
      const countWith5 = getCount();
      localService.getReleaseAssetManagementPage(release.id, {});
      const execWith5 = getCount() - countWith5;

      // The execution count must be identical regardless of candidate count
      expect(execWith5).toBe(execWith3);

      // Document the baseline — a fixed small number of executions:
      // release + project + categories + saved membership + aggregates +
      // filtered COUNT (+ page rows when anything matches) + extensions,
      // plus the image-policy app_meta reads (6) = 13-14 executions.
      expect(execWith3).toBeGreaterThan(0);
      expect(execWith3).toBeLessThanOrEqual(14);
    });

    it('execution count does not grow per-candidate for ownership checks', () => {
      const localProjectRepo = createProjectRepository(db);
      const localAssetRepo = createAssetRepository(db);
      const localRelRepo = createReleaseRepository(db);

      const project = localProjectRepo.create(sampleProject({ title: 'N+1 Own Check' }));
      const release = localRelRepo.create({ projectId: project.id, ...validInput({ title: 'N+1 Own Release' }) });

      // Add 3 present, unselected assets
      for (let i = 0; i < 3; i++) {
        localAssetRepo.upsert(project.id, `own${i}.txt`,
          sampleAsset(project.id, { relativePath: `own${i}.txt` })
        );
      }

      const getCount = instrumentExecutionCount(db);
      const localService = createReleaseService({ db });

      const before = getCount();
      localService.getReleaseAssetManagementPage(release.id, {});
      const initialRun = getCount() - before;

      // Add 3 more candidates
      for (let i = 3; i < 6; i++) {
        localAssetRepo.upsert(project.id, `own${i}.txt`,
          sampleAsset(project.id, { relativePath: `own${i}.txt` })
        );
      }

      const before2 = getCount();
      localService.getReleaseAssetManagementPage(release.id, {});
      const secondRun = getCount() - before2;

      // Execution count must be the same — no per-candidate N+1 queries
      expect(secondRun).toBe(initialRun);
    });
  });

  // ─── Phase 3 chunk 3: addAssetsToRelease (bulk browser association) ─────

  describe('addAssetsToRelease', () => {
    function presentAsset(overrides = {}) {
      return assetRepo.upsert(projectId, overrides.relativePath ?? 'present.txt', sampleAsset(projectId, overrides));
    }

    function missingAsset(overrides = {}) {
      const asset = presentAsset({ relativePath: 'missing.txt', ...overrides });
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, []);
      return assetRepo.findById(asset.id);
    }

    it('adds multiple present assets and returns added/alreadyAssociated counts', () => {
      const release = service.createRelease(projectId, validInput({ title: 'Bulk' }));
      const a1 = presentAsset({ relativePath: 'a.txt' });
      const a2 = presentAsset({ relativePath: 'b.txt' });

      const result = service.addAssetsToRelease(release.id, projectId, [a1.id, a2.id]);

      expect(result).toEqual({ added: 2, alreadyAssociated: 0 });
      const rows = service.listReleaseAssets(release.id);
      expect(rows.map((r) => r.asset_id).sort((x, y) => x - y)).toEqual([a1.id, a2.id].sort((x, y) => x - y));
      expect(rows.every((r) => r.role === 'attachment')).toBe(true);
    });

    it('mixed already-associated and new input returns correct counts and only inserts the new ones', () => {
      const release = service.createRelease(projectId, validInput({ title: 'Mixed' }));
      const already = presentAsset({ relativePath: 'already.txt' });
      service.addCandidateAsset(release.id, already.id);
      const fresh = presentAsset({ relativePath: 'fresh.txt' });

      const result = service.addAssetsToRelease(release.id, projectId, [already.id, fresh.id]);

      expect(result).toEqual({ added: 1, alreadyAssociated: 1 });
      const rows = service.listReleaseAssets(release.id);
      expect(rows).toHaveLength(2);
    });

    it('rejects an empty array', () => {
      const release = service.createRelease(projectId, validInput({ title: 'Empty' }));
      expect(() => service.addAssetsToRelease(release.id, projectId, [])).toThrow(ReleaseValidationError);
    });

    it('rejects a non-array assetIds argument', () => {
      const release = service.createRelease(projectId, validInput({ title: 'NotArray' }));
      expect(() => service.addAssetsToRelease(release.id, projectId, 'not-an-array')).toThrow(ReleaseValidationError);
    });

    it('rejects malformed asset IDs', () => {
      const release = service.createRelease(projectId, validInput({ title: 'Malformed' }));
      expect(() => service.addAssetsToRelease(release.id, projectId, ['abc'])).toThrow(ReleaseValidationError);
      expect(() => service.addAssetsToRelease(release.id, projectId, ['1.5'])).toThrow(ReleaseValidationError);
      expect(() => service.addAssetsToRelease(release.id, projectId, ['0'])).toThrow(ReleaseValidationError);
      expect(() => service.addAssetsToRelease(release.id, projectId, ['-1'])).toThrow(ReleaseValidationError);
    });

    it('rejects duplicate asset IDs in the submitted array', () => {
      const release = service.createRelease(projectId, validInput({ title: 'Dup' }));
      const a1 = presentAsset({ relativePath: 'a.txt' });
      expect(() => service.addAssetsToRelease(release.id, projectId, [a1.id, a1.id])).toThrow(ReleaseValidationError);
    });

    it('rejects a malformed projectId or releaseId before touching the database', () => {
      const release = service.createRelease(projectId, validInput({ title: 'BadIds' }));
      const a1 = presentAsset({ relativePath: 'a.txt' });

      expect(() => service.addAssetsToRelease(release.id, 'not-a-number', [a1.id])).toThrow(ReleaseValidationError);
      expect(() => service.addAssetsToRelease('not-a-number', projectId, [a1.id])).toThrow(ReleaseValidationError);
    });

    it('rejects a release that belongs to a different project (does not leak existence)', () => {
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const release = service.createRelease(otherProject.id, validInput({ title: 'Theirs' }));
      const a1 = presentAsset({ relativePath: 'a.txt' });

      expect(() => service.addAssetsToRelease(release.id, projectId, [a1.id])).toThrow(ReleaseNotFoundError);
    });

    it('rejects an unknown release ID', () => {
      expect(() => service.addAssetsToRelease(999999, projectId, [1])).toThrow(ReleaseNotFoundError);
    });

    it('rejects a cross-project asset', () => {
      const release = service.createRelease(projectId, validInput({ title: 'CrossAsset' }));
      const otherProject = projectRepo.create(sampleProject({ title: 'Other' }));
      const theirAsset = assetRepo.upsert(otherProject.id, 'theirs.txt', sampleAsset(otherProject.id, { relativePath: 'theirs.txt' }));

      expect(() => service.addAssetsToRelease(release.id, projectId, [theirAsset.id])).toThrow(ReleaseValidationError);
    });

    it('rejects a missing (not present) asset', () => {
      const release = service.createRelease(projectId, validInput({ title: 'MissingAsset' }));
      const gone = missingAsset();

      expect(() => service.addAssetsToRelease(release.id, projectId, [gone.id])).toThrow(ReleaseValidationError);
    });

    it('rejects an unknown asset ID', () => {
      const release = service.createRelease(projectId, validInput({ title: 'UnknownAsset' }));
      expect(() => service.addAssetsToRelease(release.id, projectId, [999999])).toThrow(AssetNotFoundError);
    });

    it('rejects mutation on an archived project', () => {
      const release = service.createRelease(projectId, validInput({ title: 'ArchivedProject' }));
      const a1 = presentAsset({ relativePath: 'a.txt' });
      projectRepo.archive(projectId);

      expect(() => service.addAssetsToRelease(release.id, projectId, [a1.id])).toThrow(ReleaseParentArchivedError);
    });

    it('rejects mutation on an archived release', () => {
      const release = service.createRelease(projectId, validInput({ title: 'ArchivedRelease' }));
      const a1 = presentAsset({ relativePath: 'a.txt' });
      service.archiveRelease(release.id);

      expect(() => service.addAssetsToRelease(release.id, projectId, [a1.id])).toThrow(ReleaseArchivedError);
    });

    it('rejects mutation on a published release', () => {
      const { release, asset } = createPublishableRelease(service, assetRepo, projectId, { title: 'Published' });
      service.publishRelease(release.id);
      const a1 = presentAsset({ relativePath: 'extra.txt' });

      expect(() => service.addAssetsToRelease(release.id, projectId, [a1.id])).toThrow(ReleasePublishedError);
      expect(asset.id).toBeGreaterThan(0);
    });

    it('permits mutation on an unpublished release', () => {
      const release = service.createRelease(projectId, validInput({ title: 'Unpublished' }));
      const a1 = presentAsset({ relativePath: 'a.txt' });

      const result = service.addAssetsToRelease(release.id, projectId, [a1.id]);
      expect(result.added).toBe(1);
    });

    it('validates all input before any repository access — an invalid submission never mutates state', () => {
      const release = service.createRelease(projectId, validInput({ title: 'ValidateFirst' }));
      const a1 = presentAsset({ relativePath: 'a.txt' });

      // Trailing malformed ID should reject the whole call — a1 must not
      // have been added despite appearing earlier in the array.
      expect(() => service.addAssetsToRelease(release.id, projectId, [a1.id, 'not-a-number'])).toThrow(ReleaseValidationError);
      expect(service.listReleaseAssets(release.id)).toHaveLength(0);
    });

    it('uses one bounded asset lookup rather than one query per submitted ID', () => {
      // Instrument db.prepare BEFORE constructing the service so its
      // internally-owned assetRepository's statements (cached or ad hoc)
      // are all observed. Each submission includes one missing asset last,
      // so validation always rejects right after the asset lookup and
      // before the repository.appendAssetsToRelease transaction runs —
      // isolating the validation-phase query count (which must not scale
      // with the number of submitted IDs) from the mutation phase (which
      // necessarily writes one row per new asset and would scale). Same
      // technique workflow-query-service's bounded-query tests use.
      const originalPrepare = db.prepare.bind(db);
      let executions = 0;
      function wrapStatement(statement) {
        return new Proxy(statement, {
          get(target, prop, receiver) {
            if (prop === 'get' || prop === 'all' || prop === 'run') {
              return (...args) => {
                executions++;
                return target[prop](...args);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }
      db.prepare = (...args) => wrapStatement(originalPrepare(...args));

      const instrumentedService = createReleaseService({ db });

      const smallRelease = instrumentedService.createRelease(projectId, validInput({ title: 'Small' }));
      // Mark this one asset missing in isolation (it is the only asset that
      // exists in the project so far), then create the rest as present.
      const smallMissing = presentAsset({ relativePath: 'small-missing.txt' });
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, []);
      const smallIds = [
        presentAsset({ relativePath: 'small-1.txt' }).id,
        presentAsset({ relativePath: 'small-2.txt' }).id,
        smallMissing.id,
      ];

      const largeRelease = instrumentedService.createRelease(projectId, validInput({ title: 'Large' }));
      // Same isolation trick: mark everything currently present (including
      // the already-used small-* assets, which are no longer needed) as
      // missing, then create the large-N present assets afterward.
      const largeMissing = presentAsset({ relativePath: 'large-missing.txt' });
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, []);
      const largeIds = [];
      for (let i = 0; i < 20; i++) {
        largeIds.push(presentAsset({ relativePath: `large-${i}.txt` }).id);
      }
      largeIds.push(largeMissing.id);

      executions = 0;
      expect(() => instrumentedService.addAssetsToRelease(smallRelease.id, projectId, smallIds)).toThrow(ReleaseValidationError);
      const smallCount = executions;

      executions = 0;
      expect(() => instrumentedService.addAssetsToRelease(largeRelease.id, projectId, largeIds)).toThrow(ReleaseValidationError);
      const largeCount = executions;

      db.prepare = originalPrepare;

      expect(smallCount).toBe(largeCount);
      // Sanity: the release was never mutated since validation rejected first.
      expect(instrumentedService.listReleaseAssets(smallRelease.id)).toHaveLength(0);
      expect(instrumentedService.listReleaseAssets(largeRelease.id)).toHaveLength(0);
    });
  });
});

describe('release activity logging', () => {
  let tmpDir;
  let db;
  let projectId;
  let assetRepo;
  let applicationLogRepository;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-activity-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const project = createProjectRepository(db).create(sampleProject({ title: 'Release Activity Project' }));
    projectId = project.id;
    assetRepo = createAssetRepository(db);
    applicationLogRepository = createApplicationLogRepository(db);
    service = createReleaseService({
      db,
      applicationLogger: createApplicationLogger({
        repository: applicationLogRepository,
        console: { error: vi.fn() },
        now: () => 1,
      }),
    });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function activityRecords(event) {
    return applicationLogRepository.findPage({ kind: 'activity' })
      .filter((record) => !event || record.event === event);
  }

  it('persists lifecycle activity only after effective successful mutations', () => {
    const created = service.createRelease(projectId, validInput({ title: 'C:\\private\\release' }));
    service.updateRelease(created.id, validInput({ title: 'Updated Release' }));
    service.updateRelease(created.id, validInput({ title: 'Updated Release' }));
    service.publishRelease(created.id, '2025-06-15');
    expect(() => service.publishRelease(created.id, '2025-06-15')).toThrow(ReleaseValidationError);

    const archived = service.createRelease(projectId, validInput({ title: 'Archive Release' }));
    service.archiveRelease(archived.id);
    expect(() => service.archiveRelease(archived.id)).toThrow(ReleaseArchivedError);

    const deleted = service.createRelease(projectId, validInput({ title: 'Delete Release' }));
    service.deleteRelease(deleted.id);

    expect(activityRecords().map(({ event }) => event).sort()).toEqual([
      'release.archived',
      'release.created',
      'release.created',
      'release.created',
      'release.deleted',
      'release.published',
      'release.updated',
    ]);
    expect(activityRecords('release.updated')).toHaveLength(1);
    expect(activityRecords('release.published')).toHaveLength(1);
    expect(activityRecords('release.archived')).toHaveLength(1);
    expect(activityRecords('release.deleted')).toHaveLength(1);

    const createdRecord = activityRecords('release.created').find((record) => record.context_json.includes(`\"releaseId\":${created.id}`));
    expect(createdRecord).toMatchObject({
      level: 'info',
      kind: 'activity',
      subsystem: 'releases',
      project_id: projectId,
    });
    expect(JSON.parse(createdRecord.context_json)).toEqual({ releaseId: created.id, assetCount: 0 });
    expect(String(createdRecord.message) + createdRecord.context_json).not.toContain('C:\\private');
  });

  it('logs committed membership deltas and role changes without asset IDs or raw mappings', () => {
    const release = service.createRelease(projectId, validInput());
    const first = assetRepo.upsert(projectId, 'first.txt', sampleAsset(projectId, { relativePath: 'first.txt' }));
    const second = assetRepo.upsert(projectId, 'second.txt', sampleAsset(projectId, { relativePath: 'second.txt' }));

    service.selectAssets(release.id, [{ assetId: first.id, role: 'attachment', sortOrder: 0 }]);
    service.selectAssets(release.id, [{ assetId: first.id, role: 'attachment', sortOrder: 0 }]);
    service.updateAssetRole(release.id, first.id, 'primary');
    service.updateAssetRole(release.id, first.id, 'primary');
    service.selectAssets(release.id, [{ assetId: second.id, role: 'preview', sortOrder: 0 }]);

    expect(activityRecords('release.assets.added')).toHaveLength(2);
    expect(activityRecords('release.assets.removed')).toHaveLength(1);
    expect(activityRecords('release.asset_role.changed')).toHaveLength(1);

    const records = activityRecords().filter((record) => record.event.startsWith('release.'));
    for (const record of records) {
      const context = JSON.parse(record.context_json);
      expect(context).not.toHaveProperty('assetIds');
      expect(context).not.toHaveProperty('assets');
      expect(context).not.toHaveProperty('mapping');
    }
    expect(activityRecords('release.assets.added').map((record) => JSON.parse(record.context_json))).toEqual([
      { releaseId: release.id, affectedCount: 1 },
      { releaseId: release.id, affectedCount: 1 },
    ]);
    expect(JSON.parse(activityRecords('release.assets.removed')[0].context_json)).toEqual({ releaseId: release.id, affectedCount: 1 });
    expect(JSON.parse(activityRecords('release.asset_role.changed')[0].context_json)).toEqual({
      releaseId: release.id,
      role: 'primary',
      affectedCount: 1,
    });
  });


  it('logs direct candidate membership changes exactly once after commit', () => {
    const release = service.createRelease(projectId, validInput());
    const asset = assetRepo.upsert(projectId, 'candidate.txt', sampleAsset(projectId, { relativePath: 'candidate.txt' }));

    service.addCandidateAsset(release.id, asset.id);
    expect(() => service.addCandidateAsset(release.id, asset.id)).toThrow(ReleaseValidationError);
    expect(activityRecords('release.assets.added')).toHaveLength(1);

    service.removeSelectedAsset(release.id, asset.id);
    expect(() => service.removeSelectedAsset(release.id, asset.id)).toThrow(ReleaseValidationError);
    expect(activityRecords('release.assets.removed')).toHaveLength(1);
  });

  function createCountFailingService() {
    const originalPrepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (sql.includes('SELECT COUNT(*) AS c FROM release_assets ra')) {
        return { get: () => { throw new Error('asset count unavailable'); } };
      }
      return originalPrepare(sql);
    });
    const countFailingService = createReleaseService({
      db,
      applicationLogger: createApplicationLogger({
        repository: applicationLogRepository,
        console: { error: vi.fn() },
        now: () => 1,
      }),
    });
    prepareSpy.mockRestore();
    return countFailingService;
  }

  it('publishes and persists one event without assetCount when count context fails', () => {
    const release = service.createRelease(projectId, validInput());
    const countFailingService = createCountFailingService();

    const published = countFailingService.publishRelease(release.id, '2025-06-15');

    expect(published).toMatchObject({ id: release.id, published_date: '2025-06-15' });
    const records = activityRecords('release.published');
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0].context_json)).toEqual({ releaseId: release.id });
  });

  it('deletes and persists one event without assetCount when count context fails', () => {
    const release = service.createRelease(projectId, validInput());
    const countFailingService = createCountFailingService();

    expect(countFailingService.deleteRelease(release.id)).toBe(true);
    expect(countFailingService.findRelease(release.id)).toBeUndefined();
    const records = activityRecords('release.deleted');
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0].context_json)).toEqual({ releaseId: release.id });
  });

  it('does not emit publish or delete success events when their mutations fail', () => {
    const publishable = service.createRelease(projectId, validInput());
    db.exec(`CREATE TRIGGER fail_activity_publish
      BEFORE UPDATE OF published_date ON releases
      WHEN NEW.id = ${publishable.id}
      BEGIN SELECT RAISE(ABORT, 'publish unavailable'); END;`);

    expect(() => service.publishRelease(publishable.id, '2025-06-15')).toThrow('publish unavailable');
    expect(activityRecords('release.published')).toHaveLength(0);

    const deletable = service.createRelease(projectId, validInput());
    db.exec(`CREATE TRIGGER fail_activity_delete
      BEFORE DELETE ON releases
      WHEN OLD.id = ${deletable.id}
      BEGIN SELECT RAISE(ABORT, 'delete unavailable'); END;`);

    expect(() => service.deleteRelease(deletable.id)).toThrow('delete unavailable');
    expect(activityRecords('release.deleted')).toHaveLength(0);
  });

  it('does not emit success for failures and isolates logger failures', () => {
    const failingLogger = { info: vi.fn(() => { throw new Error('log persistence unavailable'); }) };
    const isolatedService = createReleaseService({ db, applicationLogger: failingLogger });

    expect(() => isolatedService.updateRelease(99999, validInput())).toThrow(ReleaseNotFoundError);
    expect(failingLogger.info).not.toHaveBeenCalled();

    const publishable = service.createRelease(projectId, validInput());
    expect(isolatedService.publishRelease(publishable.id, '2025-06-15')).toMatchObject({ id: publishable.id });
    const deletable = service.createRelease(projectId, validInput());
    expect(isolatedService.deleteRelease(deletable.id)).toBe(true);
    expect(failingLogger.info).toHaveBeenCalledTimes(2);
  });
});

describe('scheduleRelease', () => {
  let tmpDir;
  let db;
  let projectRepo;
  let assetRepo;
  let socialPrepRepo;
  let logger;
  let notify;
  let service;
  let projectId;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-schedule-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    projectRepo = createProjectRepository(db);
    assetRepo = createAssetRepository(db);
    socialPrepRepo = createSocialPrepRepository(db);
    logger = { info: vi.fn() };
    notify = vi.fn();
    service = createReleaseService({
      db,
      applicationLogger: logger,
      onReleaseNotificationStateChanged: notify,
      socialPrepSettingsService: { getPlatforms: () => ['x', 'bluesky'] },
    });
    projectId = projectRepo.create(sampleProject({ title: 'Schedule Project' })).id;
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createRelease(overrides = {}) {
    const release = service.createRelease(projectId, validInput(overrides));
    logger.info.mockClear();
    notify.mockClear();
    return release;
  }

  function backdate(releaseId) {
    db.prepare("UPDATE releases SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(releaseId);
  }

  function schedule(id, plannedDate, expectedPlannedDate = null, expectedPlannedTime = null, extra = {}) {
    return service.scheduleRelease(id, { plannedDate, expectedPlannedDate, expectedPlannedTime, ...extra });
  }

  function updatedActivityCount() {
    return logger.info.mock.calls.filter(([entry]) => entry.event === 'release.updated').length;
  }

  function snapshotAll(releaseId) {
    const release = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
    const { planned_date: _date, planned_time: _time, updated_at: _updated, ...rest } = release;
    return {
      release: rest,
      project: db.prepare('SELECT * FROM projects WHERE id = ?').get(release.project_id),
      assets: db.prepare('SELECT * FROM release_assets WHERE release_id = ? ORDER BY asset_id').all(releaseId),
      platforms: db.prepare('SELECT * FROM release_social_platforms WHERE release_id = ? ORDER BY platform').all(releaseId),
      sessions: db.prepare('SELECT * FROM social_prep_sessions WHERE release_id = ? ORDER BY id').all(releaseId),
    };
  }

  it('schedules an undated release date-only and returns both schedule pairs', () => {
    const release = createRelease();
    backdate(release.id);

    const result = schedule(release.id, '2026-10-13');

    expect(result.changed).toBe(true);
    expect(result.previousSchedule).toEqual({ plannedDate: null, plannedTime: null });
    expect(result.schedule).toEqual({ plannedDate: '2026-10-13', plannedTime: null });
    const row = db.prepare('SELECT planned_date, planned_time, updated_at FROM releases WHERE id = ?').get(release.id);
    expect(row.planned_date).toBe('2026-10-13');
    expect(row.planned_time).toBeNull();
    expect(row.updated_at).not.toBe('2000-01-01 00:00:00');
  });

  it('undoes back to an undated schedule', () => {
    const release = createRelease();
    schedule(release.id, '2026-10-13');

    const result = schedule(release.id, null, '2026-10-13', null);

    expect(result.previousSchedule).toEqual({ plannedDate: '2026-10-13', plannedTime: null });
    expect(result.schedule).toEqual({ plannedDate: null, plannedTime: null });
    expect(service.findRelease(release.id).planned_date).toBeNull();
  });

  it('accepts a blank target date as Undo', () => {
    const release = createRelease({ plannedDate: '2026-10-13' });
    expect(schedule(release.id, '  ', '2026-10-13', '').schedule).toEqual({ plannedDate: null, plannedTime: null });
  });

  it('clears an existing planned time when rescheduling date-only', () => {
    const release = createRelease({ plannedDate: '2026-10-13', plannedTime: '09:30' });

    const result = schedule(release.id, '2026-10-20', '2026-10-13', '09:30');

    expect(result.previousSchedule).toEqual({ plannedDate: '2026-10-13', plannedTime: '09:30' });
    expect(result.schedule).toEqual({ plannedDate: '2026-10-20', plannedTime: null });
    expect(db.prepare('SELECT planned_time FROM releases WHERE id = ?').get(release.id).planned_time).toBeNull();
  });

  it('treats a blank stored planned time as date-only', () => {
    const release = createRelease({ plannedDate: '2026-10-13' });
    db.prepare("UPDATE releases SET planned_time = '' WHERE id = ?").run(release.id);

    expect(schedule(release.id, '2026-10-14', '2026-10-13', null).changed).toBe(true);
  });

  it('requires every schedule field except plannedTime to be explicitly supplied', () => {
    const release = createRelease();
    for (const field of ['plannedDate', 'expectedPlannedDate', 'expectedPlannedTime']) {
      const input = { plannedDate: '2026-10-13', expectedPlannedDate: null, expectedPlannedTime: null };
      delete input[field];
      expect(() => service.scheduleRelease(release.id, input))
        .toThrow(expect.objectContaining({ name: 'ReleaseValidationError', errors: { [field]: expect.any(String) } }));
    }
    expect(() => service.scheduleRelease(release.id, undefined)).toThrow(ReleaseValidationError);
    expect(service.findRelease(release.id).planned_date).toBeNull();
  });

  it.each([
    ['2026-02-30'],
    ['2026-13-01'],
    ['2026-1-01'],
    ['20261013'],
    ['not-a-date'],
    [20261013],
    [true],
    [{}],
    [['2026-10-13']],
  ])('rejects invalid target date %j', (plannedDate) => {
    const release = createRelease();
    expect(() => schedule(release.id, plannedDate))
      .toThrow(expect.objectContaining({ errors: { plannedDate: expect.any(String) } }));
  });

  it('accepts a real leap day and rejects a non-leap one', () => {
    const release = createRelease();
    expect(schedule(release.id, '2028-02-29').schedule.plannedDate).toBe('2028-02-29');
    expect(() => schedule(release.id, '2027-02-29', '2028-02-29')).toThrow(ReleaseValidationError);
  });

  it('rejects invalid expected values', () => {
    const release = createRelease();
    expect(() => schedule(release.id, '2026-10-13', '2026-02-31'))
      .toThrow(expect.objectContaining({ errors: { expectedPlannedDate: expect.any(String) } }));
    expect(() => schedule(release.id, '2026-10-13', null, '25:00'))
      .toThrow(expect.objectContaining({ errors: { expectedPlannedTime: expect.any(String) } }));
    expect(() => schedule(release.id, '2026-10-13', null, 930))
      .toThrow(expect.objectContaining({ errors: { expectedPlannedTime: expect.any(String) } }));
  });

  it('rejects a nonempty target time and accepts a blank or null one', () => {
    const release = createRelease();
    expect(() => schedule(release.id, '2026-10-13', null, null, { plannedTime: '10:00' }))
      .toThrow(expect.objectContaining({ errors: { plannedTime: expect.any(String) } }));
    expect(() => schedule(release.id, '2026-10-13', null, null, { plannedTime: 0 })).toThrow(ReleaseValidationError);
    expect(service.findRelease(release.id).planned_date).toBeNull();

    expect(schedule(release.id, '2026-10-13', null, null, { plannedTime: '' }).changed).toBe(true);
    expect(schedule(release.id, '2026-10-14', '2026-10-13', null, { plannedTime: null }).changed).toBe(true);
  });

  it('throws ReleaseNotFoundError for an unknown release', () => {
    expect(() => schedule(999999, '2026-10-13')).toThrow(ReleaseNotFoundError);
  });

  it('rejects releases of an archived project', () => {
    const release = createRelease();
    projectRepo.archive(projectId);
    expect(() => schedule(release.id, '2026-10-13')).toThrow(ReleaseParentArchivedError);
    expect(notify).not.toHaveBeenCalled();
  });

  it('rejects releases of a project with legacy archived status', () => {
    const release = createRelease();
    db.prepare("UPDATE projects SET status = 'archived', archived_at = NULL WHERE id = ?").run(projectId);
    expect(() => schedule(release.id, '2026-10-13')).toThrow(ReleaseParentArchivedError);
    expect(service.findRelease(release.id).planned_date).toBeNull();
  });

  it('rejects an archived release', () => {
    const release = createRelease();
    service.archiveRelease(release.id);
    expect(() => schedule(release.id, '2026-10-13')).toThrow(ReleaseArchivedError);
  });

  it('rejects an already-published release without changing it', () => {
    const release = createRelease();
    service.publishRelease(release.id, '2026-10-01');
    const before = db.prepare('SELECT * FROM releases WHERE id = ?').get(release.id);

    expect(() => schedule(release.id, '2026-10-13'))
      .toThrow(expect.objectContaining({ name: 'ReleaseValidationError', errors: { plannedDate: expect.any(String) } }));
    expect(db.prepare('SELECT * FROM releases WHERE id = ?').get(release.id)).toEqual(before);
  });

  it('rejects a stale expected date or time with the current schedule', () => {
    const release = createRelease({ plannedDate: '2026-10-13', plannedTime: '09:30' });

    expect(() => schedule(release.id, '2026-10-20', '2026-10-12', '09:30'))
      .toThrow(expect.objectContaining({
        name: 'ReleaseScheduleConflictError',
        status: 409,
        currentSchedule: { plannedDate: '2026-10-13', plannedTime: '09:30' },
      }));
    expect(() => schedule(release.id, '2026-10-20', '2026-10-13', null))
      .toThrow(expect.objectContaining({ name: 'ReleaseScheduleConflictError' }));
    expect(service.findRelease(release.id).planned_date).toBe('2026-10-13');
  });

  it('does not treat a matching target as a no-op when the expected schedule is stale', () => {
    const release = createRelease({ plannedDate: '2026-10-13' });
    expect(() => schedule(release.id, '2026-10-13', null, null))
      .toThrow(expect.objectContaining({ name: 'ReleaseScheduleConflictError' }));
  });

  it('refuses Undo after a full edit changed the schedule in between', () => {
    const release = createRelease();
    schedule(release.id, '2026-10-13');
    service.updateRelease(release.id, validInput({ plannedDate: '2026-11-01', plannedTime: '18:00' }));

    expect(() => schedule(release.id, null, '2026-10-13', null))
      .toThrow(expect.objectContaining({
        name: 'ReleaseScheduleConflictError',
        currentSchedule: { plannedDate: '2026-11-01', plannedTime: '18:00' },
      }));
    const row = service.findRelease(release.id);
    expect([row.planned_date, row.planned_time]).toEqual(['2026-11-01', '18:00']);
  });

  describe('compare-and-update atomicity', () => {
    // Simulates another writer committing between the service read and the
    // conditional write.
    function interleave(change) {
      const original = service.repository.updateSchedule;
      service.repository.updateSchedule = (...args) => {
        change();
        return original(...args);
      };
    }

    it('does not overwrite a schedule changed after the service read', () => {
      const release = createRelease();
      interleave(() => db.prepare("UPDATE releases SET planned_date = '2026-12-24', planned_time = '08:00' WHERE id = ?").run(release.id));

      expect(() => schedule(release.id, '2026-10-13'))
        .toThrow(expect.objectContaining({
          name: 'ReleaseScheduleConflictError',
          currentSchedule: { plannedDate: '2026-12-24', plannedTime: '08:00' },
        }));
      expect(service.findRelease(release.id).planned_date).toBe('2026-12-24');
      expect(updatedActivityCount()).toBe(0);
      expect(notify).not.toHaveBeenCalled();
    });

    it('reports a publication that lands after the service read as a lifecycle rejection', () => {
      const release = createRelease();
      interleave(() => db.prepare("UPDATE releases SET published_date = '2026-10-10' WHERE id = ?").run(release.id));
      expect(() => schedule(release.id, '2026-10-13')).toThrow(ReleaseValidationError);
      expect(service.findRelease(release.id).planned_date).toBeNull();
    });

    it('reports an archive that lands after the service read', () => {
      const release = createRelease();
      interleave(() => db.prepare("UPDATE releases SET archived_at = datetime('now') WHERE id = ?").run(release.id));
      expect(() => schedule(release.id, '2026-10-13')).toThrow(ReleaseArchivedError);
    });

    it('reports a parent project archive that lands after the service read', () => {
      const release = createRelease();
      interleave(() => db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(projectId));
      expect(() => schedule(release.id, '2026-10-13')).toThrow(ReleaseParentArchivedError);
      expect(service.findRelease(release.id).planned_date).toBeNull();
    });

    it('reports a deletion that lands after the service read', () => {
      const release = createRelease();
      interleave(() => db.prepare('DELETE FROM releases WHERE id = ?').run(release.id));
      expect(() => schedule(release.id, '2026-10-13')).toThrow(ReleaseNotFoundError);
    });

    it('repository updateSchedule applies only when the expected schedule matches', () => {
      const release = createRelease({ plannedDate: '2026-10-13', plannedTime: '09:30' });
      const repo = createReleaseRepository(db);

      expect(repo.updateSchedule(release.id, { plannedDate: '2026-10-20', plannedTime: null },
        { plannedDate: '2026-10-13', plannedTime: null })).toBeUndefined();
      expect(repo.updateSchedule(release.id, { plannedDate: '2026-10-20', plannedTime: null },
        { plannedDate: '2026-10-13', plannedTime: '09:30' })).toMatchObject({ planned_date: '2026-10-20', planned_time: null });
    });
  });

  it('preserves every unrelated release field and associated record', () => {
    const release = createRelease({
      title: 'Keep Title',
      description: 'Keep description',
      notes: 'Keep notes',
      patreonUrl: 'https://example.com/post',
      selectedPlatforms: ['x', 'bluesky'],
    });
    const first = assetRepo.upsert(projectId, 'a.txt', sampleAsset(projectId, { relativePath: 'a.txt', filename: 'a.txt' }));
    const second = assetRepo.upsert(projectId, 'b.txt', sampleAsset(projectId, { relativePath: 'b.txt', filename: 'b.txt' }));
    service.selectAssets(release.id, [
      { assetId: second.id, role: 'primary', sortOrder: 0 },
      { assetId: first.id, role: 'preview', sortOrder: 1 },
    ]);
    socialPrepRepo.insertSession({ id: 'prep', releaseId: release.id, kind: 'initial', expiresAt: new Date('2030-01-01') });
    socialPrepRepo.reassignPlatformsToSession('prep', ['x']);
    const before = snapshotAll(release.id);

    schedule(release.id, '2026-10-13');
    schedule(release.id, null, '2026-10-13', null);

    expect(snapshotAll(release.id)).toEqual(before);
    expect(before.release).toMatchObject({ title: 'Keep Title', notes: 'Keep notes', patreon_url: 'https://example.com/post' });
    expect(before.assets).toHaveLength(2);
    expect(before.platforms.filter((row) => row.is_selected)).toHaveLength(2);
    expect(before.sessions).toHaveLength(1);
  });

  it('does not write, log, or notify for a no-op schedule', () => {
    const release = createRelease({ plannedDate: '2026-10-13' });
    backdate(release.id);
    const writeSpy = vi.spyOn(service.repository, 'updateSchedule');
    const before = db.prepare('SELECT * FROM releases WHERE id = ?').get(release.id);

    const result = schedule(release.id, '2026-10-13', '2026-10-13', null);

    expect(result).toMatchObject({
      changed: false,
      previousSchedule: { plannedDate: '2026-10-13', plannedTime: null },
      schedule: { plannedDate: '2026-10-13', plannedTime: null },
    });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(db.prepare('SELECT * FROM releases WHERE id = ?').get(release.id)).toEqual(before);
    expect(logger.info).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();

    const undated = createRelease();
    expect(schedule(undated.id, null, null, null).changed).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('logs release.updated and notifies once after a changed schedule is committed', () => {
    const release = createRelease();
    let plannedDateSeenByNotifier;
    notify.mockImplementation((id) => {
      plannedDateSeenByNotifier = db.prepare('SELECT planned_date FROM releases WHERE id = ?').get(id).planned_date;
    });

    schedule(release.id, '2026-10-13');

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][0]).toMatchObject({
      event: 'release.updated', kind: 'activity', projectId, context: { releaseId: release.id },
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(release.id);
    expect(plannedDateSeenByNotifier).toBe('2026-10-13');
  });

  it('keeps the committed schedule when logging or notification fails', () => {
    const release = createRelease();
    logger.info.mockImplementation(() => { throw new Error('log down'); });
    notify.mockImplementation(() => { throw new Error('notify down'); });

    expect(schedule(release.id, '2026-10-13').changed).toBe(true);
    expect(service.findRelease(release.id).planned_date).toBe('2026-10-13');
  });
});

// ─── Manage Assets bounded SQL pagination — Package B service integration ──
//
// Expected IDs and counts are computed independently in JavaScript from the
// rows each test creates (filenames are unique, zero-padded ASCII so the
// canonical filename-then-ID order is plain string order), never from the
// Package A repository APIs under test.

describe('Manage Assets bounded SQL integration (Package B)', () => {
  let tmpDir;
  let dbPath;
  let db;
  let service;
  let projectRepo;
  let assetRepo;
  let categoryRepo;
  let projectId;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-pkgb-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    service = createReleaseService({ db });
    projectRepo = createProjectRepository(db);
    assetRepo = createAssetRepository(db);
    categoryRepo = createAssetCategoryRepository(db);
    projectId = projectRepo.create(sampleProject({ title: 'Package B Project' })).id;
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function addAssets(count, {
    prefix = 'asset', extension = 'txt', categoryId = null, project = projectId, start = 0,
  } = {}) {
    const rows = [];
    db.transaction(() => {
      for (let i = start; i < start + count; i++) {
        const filename = `${prefix}-${String(i).padStart(5, '0')}.${extension}`;
        const data = sampleAsset(project, { relativePath: filename, filename, extension });
        data.categoryId = categoryId;
        rows.push(assetRepo.upsert(project, filename, data));
      }
    })();
    return rows;
  }

  function addCategory(displayName, directorySlug, project = projectId) {
    return categoryRepo.addProjectCategory({
      projectId: project, displayName, directorySlug, displayOrder: 0, enabled: true,
    });
  }

  function markMissing(ids) {
    const stmt = db.prepare("UPDATE assets SET is_present = 0, missing_since = '2025-02-01T00:00:00Z' WHERE id = ?");
    for (const id of ids) stmt.run(id);
  }

  // Persist membership directly (it may include missing assets, which Save
  // would refuse to newly select). entries: [{ id, role, sortOrder }].
  function persistMembership(releaseId, entries) {
    db.prepare('DELETE FROM release_assets WHERE release_id = ?').run(releaseId);
    const insert = db.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)');
    for (const entry of entries) insert.run(releaseId, entry.id, entry.role ?? 'attachment', entry.sortOrder);
  }

  function byFilename(rows) {
    return [...rows].sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : a.id - b.id));
  }

  function ids(rows) {
    return rows.map((row) => row.id);
  }

  /**
   * Patch db.prepare (BEFORE the measured service is created, so repository
   * statements prepared at construction are included) to record every
   * execution: SQL, bound args, rows returned, whether rows carried asset
   * metadata, and whether the connection was inside a transaction.
   */
  function instrumentStatements(targetDb, { onExecute = null } = {}) {
    const log = [];
    const original = targetDb.prepare;
    targetDb.prepare = function prepare(sql) {
      const stmt = original.call(this, sql);
      const text = sql.replace(/\s+/g, ' ').trim();
      for (const method of ['all', 'get', 'run', 'iterate']) {
        const fn = stmt[method];
        stmt[method] = function execute(...args) {
          const entry = { sql: text, method, args, inTransaction: targetDb.inTransaction };
          onExecute?.(entry, 'before');
          const result = fn.apply(this, args);
          const rows = method === 'all' ? result : (method === 'get' && result ? [result] : []);
          entry.rows = rows.length;
          entry.metadataRows = rows.filter((row) => row && typeof row === 'object' && 'filename' in row).length;
          log.push(entry);
          onExecute?.(entry, 'after');
          return result;
        };
      }
      return stmt;
    };
    return { log, restore: () => { targetDb.prepare = original; } };
  }

  const isPageRowsSql = (entry) => entry.sql.includes('is_saved_member') && entry.sql.includes('LIMIT ? OFFSET ?');
  const isViewAllRowsSql = (entry) => entry.sql.includes('is_saved_member') && !entry.sql.includes('LIMIT');
  const isFilteredCountSql = (entry) => entry.sql.includes('AS candidate_total');
  const isAggregateSql = (entry) => entry.sql.includes('present_candidates') && entry.sql.includes('GROUP BY a.category_id');
  const isMembershipSql = (entry) => entry.sql.startsWith('SELECT ra.asset_id, ra.role, ra.sort_order, a.is_present');
  const isAppMetaSql = (entry) => entry.sql.includes('FROM app_meta');

  function buildScaleFixture(assetCount, project = projectId) {
    const category = addCategory('Scale', 'scale', project);
    const assets = addAssets(assetCount, { categoryId: category.id, project });
    const release = service.createRelease(project, validInput({ title: `Scale ${assetCount}` }));
    // 40 saved members spread across the project, stored order reversed
    // relative to filename so saved order and browse order differ.
    const step = Math.floor(assetCount / 40);
    const members = Array.from({ length: 40 }, (_, i) => assets[i * step]);
    persistMembership(release.id, members.map((asset, index) => ({
      id: asset.id,
      role: index === 0 ? 'primary' : index === 1 ? 'preview' : 'attachment',
      sortOrder: members.length - 1 - index,
    })));
    // Two saved members and three non-members go missing.
    const missingSaved = [members[3], members[7]];
    const missingNonMembers = [assets[1], assets[2], assets[3]];
    markMissing([...missingSaved, ...missingNonMembers].map((asset) => asset.id));
    return { category, assets, release, members, missingSaved, missingNonMembers };
  }

  describe('real integration at scale', () => {
    const SCALES = [250, 2000, 10000];

    // Build one deterministic scale fixture in `project`, measure a single
    // Manage Assets page read with a freshly constructed (instrumented)
    // service, verify the page and its statement shape, and return this
    // scale's statement counts. Returns a fresh value per call; nothing is
    // shared between tests.
    function measureScale(assetCount, project = projectId) {
      const fixture = buildScaleFixture(assetCount, project);
      const missingIds = new Set([...fixture.missingSaved, ...fixture.missingNonMembers].map((a) => a.id));
      const memberIds = new Set(fixture.members.map((a) => a.id));

      const { log, restore } = instrumentStatements(db);
      let page;
      try {
        const measured = createReleaseService({ db });
        log.length = 0;
        page = measured.getReleaseAssetManagementPage(fixture.release.id, { selection: 'all', page: '3', pageSize: '25' });
      } finally {
        restore();
      }

      // Independent expectation: present assets plus saved-missing ones,
      // filename order, page 3 of 25.
      const eligible = byFilename(fixture.assets.filter((a) => !missingIds.has(a.id) || memberIds.has(a.id)));
      expect(page.assetTotal).toBe(assetCount - 3);
      expect(eligible).toHaveLength(assetCount - 3);
      expect(ids(page.assetPage)).toEqual(ids(eligible.slice(50, 75)));
      expect(page.assetPageNumber).toBe(3);
      expect(page.assetPageSize).toBe(25);
      expect(page.assetPageCount).toBe(Math.ceil((assetCount - 3) / 25));
      expect(page.candidateTotal).toBe(assetCount - 3 - 40);
      expect(page.eligibleAssetCount).toBe(assetCount - 5);
      expect(page.eligibleCandidateCount).toBe(assetCount - 5 - 38);
      expect(page.categoryNavigation).toEqual({
        totalCount: assetCount, uncategorizedCount: 0, byCategoryId: { [fixture.category.id]: assetCount },
      });

      // Complete saved membership independently of the page.
      const expectedSaved = [...fixture.members].reverse();
      expect(page.releaseAssets.map((m) => m.asset_id)).toEqual(ids(expectedSaved));
      expect(page.releaseAssets[page.releaseAssets.length - 1].role).toBe('primary');
      expect(page.releaseAssets[page.releaseAssets.length - 2].role).toBe('preview');

      // Statement evidence.
      const pageRows = log.filter(isPageRowsSql);
      expect(pageRows).toHaveLength(1);
      expect(pageRows[0].args.slice(-2)).toEqual([25, 50]); // LIMIT 25 OFFSET 50
      expect(pageRows[0].rows).toBe(25);
      expect(log.filter(isFilteredCountSql)).toHaveLength(1);
      expect(log.filter(isViewAllRowsSql)).toHaveLength(0);
      const membership = log.filter(isMembershipSql);
      expect(membership).toHaveLength(1);
      expect(membership[0].rows).toBe(40);
      expect(membership[0].metadataRows).toBe(0);
      const aggregates = log.filter(isAggregateSql);
      expect(aggregates).toHaveLength(1);
      expect(aggregates[0].rows).toBe(1);
      // No statement returned more asset-metadata rows than the page size,
      // and in total only the 25 page rows carried asset metadata.
      expect(Math.max(...log.map((e) => e.metadataRows))).toBe(25);
      expect(log.reduce((sum, e) => sum + e.metadataRows, 0)).toBe(25);
      // No unbounded asset read of any shape.
      expect(log.filter((e) => /FROM assets\b/.test(e.sql) && !/LIMIT|GROUP BY|DISTINCT/.test(e.sql))).toEqual([]);

      return { assetCount, statements: log.length, nonMeta: log.filter((e) => !isAppMetaSql(e)).length };
    }

    for (const assetCount of SCALES) {
      it(`reads one bounded SQL page for pageSize=25 with ${assetCount} assets and no whole-project read`, () => {
        measureScale(assetCount);
      }, 120000);
    }

    it('keeps the statement count constant across 250, 2,000 and 10,000 assets', () => {
      // Self-contained: every scale is built and measured here, each in its
      // own project inside this test's database, so the test never depends
      // on the per-scale tests above having run.
      const results = SCALES.map((assetCount) => measureScale(
        assetCount,
        projectRepo.create(sampleProject({ title: `Scale ${assetCount} Project` })).id,
      ));
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.statements > 0)).toBe(true);
      expect(results.map((r) => r.assetCount)).toEqual([250, 2000, 10000]);
      expect(new Set(results.map((r) => r.statements)).size).toBe(1);
      // release, project, categories, membership, aggregates, COUNT, page
      // rows, extensions — plus the image-policy app_meta reads.
      expect(results[0].nonMeta).toBe(8);
    }, 120000);
  });

  describe('read snapshot', () => {
    it('runs every database read of the page model inside one transaction', () => {
      const fixture = buildScaleFixture(250);
      const { log, restore } = instrumentStatements(db);
      const measured = createReleaseService({ db });
      log.length = 0;
      measured.getReleaseAssetManagementPage(fixture.release.id, { selection: 'all' });
      restore();

      const dataReads = log.filter((e) => !isAppMetaSql(e));
      expect(dataReads).toHaveLength(8);
      expect(dataReads.every((e) => e.inTransaction)).toBe(true);
      expect(db.inTransaction).toBe(false);
    });

    it('is not affected by a write committed by another connection mid-read', () => {
      const fixture = buildScaleFixture(250);
      const other = openDatabase(dbPath);
      try {
        let wrote = false;
        let newAssetId = null;
        const { restore } = instrumentStatements(db, {
          onExecute(entry, phase) {
            // Just after the saved membership is read (snapshot established),
            // another connection adds an asset, saves it and deletes a member.
            if (phase !== 'after' || wrote || !isMembershipSql(entry)) return;
            wrote = true;
            const otherAssets = createAssetRepository(other);
            const filename = 'aaa-concurrent.txt';
            newAssetId = otherAssets.upsert(projectId, filename,
              { ...sampleAsset(projectId, { relativePath: filename, filename }), categoryId: fixture.category.id }).id;
            other.prepare('INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, ?, ?)')
              .run(fixture.release.id, newAssetId, 'attachment', 99);
            other.prepare('DELETE FROM release_assets WHERE release_id = ? AND asset_id = ?')
              .run(fixture.release.id, fixture.members[10].id);
          },
        });
        const measured = createReleaseService({ db });
        const page = measured.getReleaseAssetManagementPage(fixture.release.id, { selection: 'selected', pageSize: 'all' });
        restore();
        expect(wrote).toBe(true);

        // Everything reflects the pre-write snapshot.
        expect(page.releaseAssets).toHaveLength(40);
        expect(page.assetTotal).toBe(40);
        expect(ids(page.assetPage)).toEqual(ids(byFilename(fixture.members)));
        expect(page.categoryNavigation.totalCount).toBe(250);
        expect(page.eligibleCandidateCount).toBe(250 - 5 - 38);
        expect(ids(page.assetPage)).not.toContain(newAssetId);

        // A later read sees the committed change coherently.
        const after = service.getReleaseAssetManagementPage(fixture.release.id, { selection: 'selected', pageSize: 'all' });
        expect(after.releaseAssets).toHaveLength(40);
        expect(after.assetTotal).toBe(40);
        expect(ids(after.assetPage)).toContain(newAssetId);
        expect(ids(after.assetPage)).not.toContain(fixture.members[10].id);
        expect(after.categoryNavigation.totalCount).toBe(251);
      } finally {
        closeDatabase(other);
      }
    });

    it('rolls back cleanly and writes nothing when a SQL read fails', () => {
      const fixture = buildScaleFixture(250);
      const changesBefore = db.prepare('SELECT total_changes() AS c').get().c;
      const { restore } = instrumentStatements(db, {
        onExecute(entry, phase) {
          if (phase === 'before' && isFilteredCountSql(entry)) throw new Error('simulated SQL failure');
        },
      });
      const measured = createReleaseService({ db });
      expect(() => measured.getReleaseAssetManagementPage(fixture.release.id, { selection: 'all' }))
        .toThrow('simulated SQL failure');
      restore();
      expect(db.inTransaction).toBe(false);
      expect(db.prepare('SELECT total_changes() AS c').get().c).toBe(changesBefore);
      // The connection remains usable.
      expect(service.getReleaseAssetManagementPage(fixture.release.id, { selection: 'all' }).assetTotal).toBe(247);
    });

    it('leaves no open transaction after category validation errors', () => {
      const release = service.createRelease(projectId, validInput());
      expect(() => service.getReleaseAssetManagementPage(release.id, { category: 'abc' }))
        .toThrow(AssetCategoryValidationError);
      expect(db.inTransaction).toBe(false);
      expect(() => service.getReleaseAssetManagementPage(release.id, { category: '999999' }))
        .toThrow(AssetCategoryNotFoundError);
      expect(db.inTransaction).toBe(false);
    });
  });

  describe('page size, page and filter normalization', () => {
    let assets;
    let release;

    beforeEach(() => {
      assets = byFilename(addAssets(237));
      release = service.createRelease(projectId, validInput());
    });

    it('defaults to 25 and honours every supported numeric size', () => {
      const def = service.getReleaseAssetManagementPage(release.id, { selection: 'all' });
      expect(def.assetPageSize).toBe(25);
      expect(ids(def.assetPage)).toEqual(ids(assets.slice(0, 25)));
      for (const size of [10, 25, 50, 100, 150, 200]) {
        const page = service.getReleaseAssetManagementPage(release.id, { selection: 'all', pageSize: String(size) });
        expect(page.assetPageSize).toBe(size);
        expect(page.assetPageCount).toBe(Math.ceil(237 / size));
        expect(ids(page.assetPage)).toEqual(ids(assets.slice(0, size)));
      }
    });

    it('returns every filtered row for explicit View All without a cap', () => {
      const page = service.getReleaseAssetManagementPage(release.id, { selection: 'all', pageSize: 'all', page: '4' });
      expect(page.assetPageSize).toBe('all');
      expect(page.assetPageNumber).toBe(1);
      expect(page.assetPageCount).toBe(1);
      expect(ids(page.assetPage)).toEqual(ids(assets));
    });

    it.each([
      ['unsupported 7', '7'],
      ['unsupported 15', '15'],
      ['repeated sizes', ['10', '50']],
      ['single-element array', ['50']],
      ['differently-cased All', 'ALL'],
      ['leading zero', '025'],
      ['empty', ''],
    ])('falls back to 25 for %s (never View All or a custom size)', (_label, pageSize) => {
      const page = service.getReleaseAssetManagementPage(release.id, { selection: 'all', pageSize, page: '2' });
      expect(page.assetPageSize).toBe(25);
      expect(page.assetPageNumber).toBe(2);
      expect(ids(page.assetPage)).toEqual(ids(assets.slice(25, 50)));
    });

    it('serves first, middle and last pages and clamps beyond the end', () => {
      const expectPage = (raw, number, slice) => {
        const page = service.getReleaseAssetManagementPage(release.id, { selection: 'all', pageSize: '50', page: raw });
        expect(page.assetPageNumber).toBe(number);
        expect(page.assetPageCount).toBe(5);
        expect(ids(page.assetPage)).toEqual(ids(slice));
      };
      expectPage('1', 1, assets.slice(0, 50));
      expectPage('3', 3, assets.slice(100, 150));
      expectPage('5', 5, assets.slice(200, 237));
      expectPage('6', 5, assets.slice(200, 237));
      expectPage('99999999999999999999', 5, assets.slice(200, 237));
    });

    it('preserves the service page normalization before calling the repository', () => {
      const pageOf = (raw) => service.getReleaseAssetManagementPage(release.id, { selection: 'all', page: raw }).assetPageNumber;
      // Service-level coercion: a single-element array is its string value.
      expect(pageOf(['3'])).toBe(3);
      for (const malformed of [['3', '3'], '1e2', '2.5', '-1', '0', '', '+2', 'abc', `9${'9'.repeat(400)}`]) {
        expect(pageOf(malformed)).toBe(1);
      }
    });

    it('returns a valid empty model for an empty filtered result', () => {
      const page = service.getReleaseAssetManagementPage(release.id, { selection: 'all', search: 'no-such-file', page: '3' });
      expect(page.assetPage).toEqual([]);
      expect(page.assetTotal).toBe(0);
      expect(page.candidateTotal).toBe(0);
      expect(page.assetPageNumber).toBe(1);
      expect(page.assetPageCount).toBe(1);
      expect(page.assetPresentation.assets).toEqual([]);
    });
  });

  describe('filter semantics and counts', () => {
    it('applies Search/Category/Extension with the saved-missing bypass and missing non-member exclusion', () => {
      const art = addCategory('Art', 'art');
      const artPng = addAssets(6, { prefix: 'art', extension: 'png', categoryId: art.id });
      const artTxt = addAssets(4, { prefix: 'art', extension: 'txt', categoryId: art.id, start: 100 });
      const loose = addAssets(5, { prefix: 'loose', extension: 'png' });
      const release = service.createRelease(projectId, validInput());
      // Saved: artPng[0] (primary), loose[0] (missing; matches nothing below),
      // artTxt[0] (preview). Missing non-member: artPng[5].
      persistMembership(release.id, [
        { id: artPng[0].id, role: 'primary', sortOrder: 0 },
        { id: loose[0].id, sortOrder: 1 },
        { id: artTxt[0].id, role: 'preview', sortOrder: 2 },
      ]);
      markMissing([loose[0].id, artPng[5].id]);

      const query = { selection: 'all', category: String(art.id), extension: 'PNG', search: '  ART-0000  ' };
      const page = service.getReleaseAssetManagementPage(release.id, query);
      // Present art png whose filename contains "art-0000" → art-00000..art-00004 (00005 missing),
      // plus the saved missing loose[0] (bypass).
      const expected = byFilename([...artPng.slice(0, 5), loose[0]]);
      expect(ids(page.assetPage)).toEqual(ids(expected));
      expect(page.assetFilters).toEqual({ search: 'ART-0000', extension: 'png', selection: 'all' });
      expect(page.activeCategoryId).toBe(art.id);
      expect(page.assetTotal).toBe(6);
      expect(page.candidateTotal).toBe(4);
      expect(ids(page.assetPage)).not.toContain(artPng[5].id);

      const selected = service.getReleaseAssetManagementPage(release.id, { ...query, selection: 'selected' });
      expect(ids(selected.assetPage)).toEqual(ids(byFilename([artPng[0], loose[0]])));
      expect(selected.candidateTotal).toBe(0);

      // Category navigation is project-wide and independent of filters.
      expect(page.categoryNavigation).toEqual({ totalCount: 15, uncategorizedCount: 5, byCategoryId: { [art.id]: 10 } });
      expect(page.eligibleAssetCount).toBe(13);
      expect(page.eligibleCandidateCount).toBe(11);
    });

    it('treats NULL category as Uncategorized in navigation and presentation', () => {
      const art = addCategory('Art', 'art');
      addCategory('Empty', 'empty');
      const categorized = addAssets(2, { prefix: 'c', categoryId: art.id });
      const uncategorized = addAssets(3, { prefix: 'u' });
      const release = service.createRelease(projectId, validInput());
      const page = service.getReleaseAssetManagementPage(release.id, { selection: 'all' });
      expect(page.categoryNavigation).toEqual({ totalCount: 5, uncategorizedCount: 3, byCategoryId: { [art.id]: 2 } });
      expect(page.categories.map((c) => c.display_name)).toEqual(['Art', 'Empty']);
      const labels = Object.fromEntries(page.assetPresentation.assets.map((a) => [a.id, a.categoryLabel]));
      for (const asset of uncategorized) expect(labels[asset.id]).toBe('Uncategorized');
      for (const asset of categorized) expect(labels[asset.id]).toBe('Art');
    });

    it('does not count unsaved draft membership: only persisted membership drives counts', () => {
      const assets = byFilename(addAssets(30));
      const release = service.createRelease(projectId, validInput());
      persistMembership(release.id, [{ id: assets[29].id, sortOrder: 0 }]);
      const page = service.getReleaseAssetManagementPage(release.id, { selectedAssetIds: [assets[0].id] });
      expect(ids(page.assetPage)).toEqual([assets[29].id]);
      expect(page.assetTotal).toBe(1);
    });

    it('rejects invalid Category syntax with 422 and unknown/foreign Category with 404', () => {
      const foreignProject = projectRepo.create(sampleProject({ title: 'Foreign Project' }));
      const foreignCategory = addCategory('Foreign', 'foreign', foreignProject.id);
      const release = service.createRelease(projectId, validInput());
      for (const bad of ['abc', '1.5', '-2', '0']) {
        let error;
        try { service.getReleaseAssetManagementPage(release.id, { category: bad }); } catch (err) { error = err; }
        expect(error).toBeInstanceOf(AssetCategoryValidationError);
        expect(error.status).toBe(422);
      }
      expect(() => service.getReleaseAssetManagementPage(release.id, { category: String(foreignCategory.id) }))
        .toThrow(AssetCategoryNotFoundError);
      expect(() => service.getReleaseAssetManagementPage(release.id, { categoryId: '999999' }))
        .toThrow(AssetCategoryNotFoundError);
      // Accepted coercion: surrounding whitespace.
      const own = addCategory('Own', 'own');
      expect(service.getReleaseAssetManagementPage(release.id, { category: ` ${own.id} ` }).activeCategoryId).toBe(own.id);
    });

    it('isolates releases and projects', () => {
      const foreignProject = projectRepo.create(sampleProject({ title: 'Other Project' }));
      const own = addAssets(3, { prefix: 'own' });
      const foreign = addAssets(4, { prefix: 'foreign', project: foreignProject.id });
      const release = service.createRelease(projectId, validInput());
      const otherRelease = service.createRelease(projectId, validInput({ title: 'Other release' }));
      const foreignRelease = service.createRelease(foreignProject.id, validInput({ title: 'Foreign release' }));
      persistMembership(otherRelease.id, [{ id: own[0].id, sortOrder: 0 }]);
      persistMembership(foreignRelease.id, [{ id: foreign[0].id, sortOrder: 0 }]);
      // A junction row pointing at a foreign-project asset is never shown.
      persistMembership(release.id, [{ id: own[1].id, sortOrder: 0 }, { id: foreign[1].id, sortOrder: 1 }]);

      const page = service.getReleaseAssetManagementPage(release.id, { selection: 'all' });
      expect(ids(page.assetPage)).toEqual(ids(byFilename(own)));
      expect(page.releaseAssets.map((m) => m.asset_id)).toEqual([own[1].id]);
      expect(page.categoryNavigation.totalCount).toBe(3);
      expect(page.candidateTotal).toBe(2);
      expect(() => service.getReleaseAssetManagementPage(999999, {})).toThrow(ReleaseNotFoundError);
    });
  });

  describe('saved membership and presentation', () => {
    it('keeps the complete saved base (off-page, missing, roles, order) while rendering only the page', () => {
      const assets = byFilename(addAssets(120));
      const release = service.createRelease(projectId, validInput());
      const saved = [assets[100], assets[5], assets[60], assets[110]];
      persistMembership(release.id, [
        { id: saved[0].id, role: 'primary', sortOrder: 0 },
        { id: saved[1].id, role: 'preview', sortOrder: 1 },
        { id: saved[2].id, sortOrder: 2 },
        { id: saved[3].id, sortOrder: 3 },
      ]);
      markMissing([saved[3].id]);

      const page = service.getReleaseAssetManagementPage(release.id, { selection: 'all', pageSize: '10' });
      expect(page.releaseAssets).toEqual([
        { asset_id: saved[0].id, role: 'primary', sort_order: 0, is_present: 1 },
        { asset_id: saved[1].id, role: 'preview', sort_order: 1, is_present: 1 },
        { asset_id: saved[2].id, role: 'attachment', sort_order: 2, is_present: 1 },
        { asset_id: saved[3].id, role: 'attachment', sort_order: 3, is_present: 0 },
      ]);
      expect(ids(page.assetPage)).toEqual(ids(assets.slice(0, 10)));
      const card = page.assetPresentation.assets.find((a) => a.id === saved[1].id);
      expect(card.releaseContext).toEqual({ selected: true, role: 'preview', sortOrder: 1 });
      expect(page.assetPresentation.selected.map((a) => a.id)).toEqual([saved[1].id]);
      expect(page.candidates.map((a) => a.id)).not.toContain(saved[1].id);
      expect(page.candidates).toHaveLength(9);
    });

    it('presents editable page cards identically to an independent full-read presentation', () => {
      const category = addCategory('Images', 'images');
      const assets = byFilename([
        ...addAssets(20, { prefix: 'img', extension: 'png', categoryId: category.id }),
        ...addAssets(8, { prefix: 'doc', extension: 'txt' }),
      ]);
      db.prepare('UPDATE assets SET source_animated = 1, source_generation = 3 WHERE id = ?').run(assets[2].id);
      const release = service.createRelease(projectId, validInput());
      persistMembership(release.id, [
        { id: assets[4].id, role: 'primary', sortOrder: 0 },
        { id: assets[1].id, role: 'preview', sortOrder: 1 },
      ]);
      markMissing([assets[1].id]);

      const page = service.getReleaseAssetManagementPage(release.id, { selection: 'all', pageSize: '10', page: '1' }, '12h');

      const settings = createProjectImageSettingsService({ appMetaRepository: createAppMetaRepository(db) });
      const fingerprint = settings.getPresentationPolicy?.() ?? projectImagePresentationPolicy(settings.getPolicy());
      const full = assetRepo.findByProjectId(projectId, { sortBy: 'filename', order: 'asc' });
      const savedRows = createReleaseRepository(db).listReleaseAssets(release.id);
      const savedIds = new Set(savedRows.map((r) => r.asset_id));
      const oldPage = full.filter((a) => a.is_present === 1 || savedIds.has(a.id)).slice(0, 10);
      const expected = buildReleaseAssetPagePresentation({
        policyFingerprint: fingerprint,
        selectedAssets: savedRows,
        assets: oldPage,
        candidateAssets: oldPage.filter((a) => !savedIds.has(a.id)),
        categories: categoryRepo.listProjectCategories(projectId),
        clockFormat: '12h',
      });
      expect(page.assetPresentation.assets).toEqual(expected.assets);
      expect(page.assetPresentation.candidates).toEqual(expected.candidates);
    });

    it.each([
      ['published release', (release) => db.prepare("UPDATE releases SET published_date = '2026-01-01' WHERE id = ?").run(release.id)],
      ['archived release', (release) => db.prepare("UPDATE releases SET archived_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(release.id)],
      ['archived parent project', () => db.prepare("UPDATE projects SET archived_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(projectId)],
    ])('read-only %s displays the complete saved selection with metadata in stored order', (_label, makeReadOnly) => {
      const assets = byFilename(addAssets(80));
      const release = service.createRelease(projectId, validInput());
      const saved = Array.from({ length: 60 }, (_, i) => assets[79 - i]);
      persistMembership(release.id, saved.map((asset, index) => ({
        id: asset.id, role: index === 0 ? 'primary' : index === 1 ? 'preview' : 'attachment', sortOrder: index,
      })));
      markMissing([saved[30].id]);
      makeReadOnly(release);

      const page = service.getReleaseAssetManagementPage(release.id, { pageSize: '10' });
      expect(page.readOnly).toBe(true);
      expect(page.releaseAssets.map((r) => r.asset_id)).toEqual(ids(saved));
      expect(page.assetPresentation.selected.map((a) => a.id)).toEqual(ids(saved));
      expect(page.assetPresentation.selected.map((a) => a.filename)).toEqual(saved.map((a) => a.filename));
      expect(page.assetPresentation.selected[0].releaseContext).toEqual({ selected: true, role: 'primary', sortOrder: 0 });
      expect(page.assetPresentation.selected[1].releaseContext).toEqual({ selected: true, role: 'preview', sortOrder: 1 });
      expect(page.assetPresentation.selected[30].presence_state).toBe('missing');
    });
  });

  describe('read-only query contract (B-F1)', () => {
    const READ_ONLY_STATES = [
      ['published release', (release) => db.prepare("UPDATE releases SET published_date = '2026-01-01' WHERE id = ?").run(release.id)],
      ['archived release', (release) => db.prepare("UPDATE releases SET archived_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(release.id)],
      ['archived parent project', () => db.prepare("UPDATE projects SET archived_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(projectId)],
    ];
    const EXPECTED_SIZE = { 10: 10, 25: 25, 200: 200, all: 'all', 7: 25, 15: 25 };

    const isEditablePageSql = (entry) => isPageRowsSql(entry) || isViewAllRowsSql(entry) || isFilteredCountSql(entry);
    const isSavedCollectionSql = (entry) => entry.sql.startsWith('SELECT ra.release_id, ra.asset_id, ra.role, ra.sort_order, ra.created_at, a.project_id');

    // 3,000 assets (1,500 categorized PNG + 1,500 uncategorized TXT) and 120
    // saved members spread across the project, stored in an order that is
    // neither filename nor ID order. The saved IDs are known independently.
    function buildReadOnlyFixture() {
      const category = addCategory('Scale', 'scale');
      const pngs = addAssets(1500, { prefix: 'img', extension: 'png', categoryId: category.id });
      const txts = addAssets(1500, { prefix: 'doc', extension: 'txt' });
      const assets = byFilename([...pngs, ...txts]);
      const release = service.createRelease(projectId, validInput({ title: 'Read-only scale' }));
      const picked = Array.from({ length: 120 }, (_, i) => assets[i * 25]);
      const saved = picked.map((_, i) => (i % 2 === 0 ? picked[i / 2] : picked[119 - (i - 1) / 2]));
      persistMembership(release.id, saved.map((asset, index) => ({
        id: asset.id, role: index === 0 ? 'primary' : index === 1 ? 'preview' : 'attachment', sortOrder: index,
      })));
      db.prepare('UPDATE assets SET source_animated = 1, source_generation = 3 WHERE id = ?').run(saved[3].id);
      const missingSaved = saved[5];
      const missingNonMember = assets[1];
      markMissing([missingSaved.id, missingNonMember.id]);
      return { category, assets, release, saved, missingSaved, nonMember: assets[2] };
    }

    function queryCases(categoryId) {
      return [
        { pageSize: '10' },
        { pageSize: '25', selection: 'all' },
        { pageSize: '200', view: 'list' },
        { pageSize: 'all', selection: 'all' },
        { pageSize: 'all', view: 'grid' },
        { pageSize: '7' },
        { pageSize: '15', selection: 'all', page: '4' },
        { pageSize: '10', selection: 'all', search: 'img-0', extension: 'PNG', category: String(categoryId), view: 'list', page: '2' },
        { pageSize: 'all', selection: 'all', search: 'doc', extension: 'txt', view: 'grid' },
      ];
    }

    function measure(fn) {
      const changesBefore = db.prepare('SELECT total_changes() AS c').get().c;
      const { log, restore } = instrumentStatements(db);
      const measured = createReleaseService({ db });
      log.length = 0;
      let result;
      try { result = fn(measured); } finally { restore(); }
      const changesAfter = db.prepare('SELECT total_changes() AS c').get().c;
      return { result, log, changed: changesAfter - changesBefore };
    }

    function expectedSavedPresentation(releaseId) {
      // The approved saved-asset path, presented exactly as the read-only page
      // presents it: the pre-correction read-only display collection.
      const settings = createProjectImageSettingsService({ appMetaRepository: createAppMetaRepository(db) });
      const fingerprint = settings.getPresentationPolicy?.() ?? projectImagePresentationPolicy(settings.getPolicy());
      return buildReleaseAssetPagePresentation({
        policyFingerprint: fingerprint,
        selectedAssets: createReleaseRepository(db).listReleaseAssets(releaseId),
        assets: [],
        candidateAssets: [],
        categories: categoryRepo.listProjectCategories(projectId),
        clockFormat: '24h',
      }).selected;
    }

    it.each(READ_ONLY_STATES)('%s renders the complete saved collection with zero editable page reads', (_label, makeReadOnly) => {
      const f = buildReadOnlyFixture();
      makeReadOnly(f.release);
      const savedIds = f.saved.map((asset) => asset.id);
      const expectedSelected = expectedSavedPresentation(f.release.id);
      const membershipBefore = db.prepare('SELECT * FROM release_assets WHERE release_id = ? ORDER BY asset_id').all(f.release.id);

      for (const query of queryCases(f.category.id)) {
        const context = JSON.stringify(query);
        const { result: page, log, changed } = measure((measured) => measured.getReleaseAssetManagementPage(f.release.id, query, '24h'));

        expect(page.readOnly, context).toBe(true);
        // L. No database mutation.
        expect(changed, context).toBe(0);
        expect(log.filter((entry) => entry.method === 'run'), context).toEqual([]);
        // I. Zero editable page reads: no filtered COUNT, numeric page or View All rows.
        expect(log.filter(isEditablePageSql).map((entry) => entry.sql), context).toEqual([]);
        // J/K. Full metadata comes only from ONE saved-collection statement
        // whose rows are exactly the saved members: no whole-project read and
        // no per-member lookup.
        const metadataStatements = log.filter((entry) => entry.metadataRows > 0);
        expect(metadataStatements, context).toHaveLength(1);
        expect(isSavedCollectionSql(metadataStatements[0]), context).toBe(true);
        expect(metadataStatements[0].metadataRows, context).toBe(savedIds.length);
        expect(Math.max(...log.map((entry) => entry.rows)), context).toBeLessThanOrEqual(savedIds.length);
        // Coherent snapshot: every database read but the image policy runs
        // inside the one read transaction.
        expect(log.filter((entry) => !isAppMetaSql(entry) && !entry.inTransaction), context).toEqual([]);

        // D/E. Complete saved selection, exact IDs, stored order, no duplicates.
        const selected = page.assetPresentation.selected;
        expect(selected.map((asset) => asset.id), context).toEqual(savedIds);
        expect(new Set(selected.map((asset) => asset.id)).size).toBe(savedIds.length);
        expect(page.releaseAssets.map((row) => row.asset_id), context).toEqual(savedIds);
        expect(selected.map((asset) => asset.releaseContext.sortOrder)).toEqual(savedIds.map((_, index) => index));
        // G. Primary and Preview roles.
        expect(selected[0].releaseContext).toEqual({ selected: true, role: 'primary', sortOrder: 0 });
        expect(selected[1].releaseContext).toEqual({ selected: true, role: 'preview', sortOrder: 1 });
        expect(selected.slice(2).every((asset) => asset.releaseContext.role === 'attachment')).toBe(true);
        // F. Missing saved member stays in place.
        expect(selected.filter((asset) => asset.presence_state === 'missing').map((asset) => asset.id)).toEqual([f.missingSaved.id]);
        expect(selected[5].id).toBe(f.missingSaved.id);
        // H. Full saved metadata.
        expect(selected.map((asset) => asset.filename)).toEqual(f.saved.map((asset) => asset.filename));
        expect(selected.map((asset) => asset.extension)).toEqual(f.saved.map((asset) => asset.extension));
        // Generated/animated metadata reaches the presenter from the saved rows.
        expect(page.releaseAssets[3]).toMatchObject({ asset_id: f.saved[3].id, source_animated: 1, source_generation: 3 });
        expect(page.releaseAssets.every((row) => typeof row.filename === 'string' && row.relative_path)).toBe(true);
        for (const asset of selected) {
          expect(asset.categoryLabel).toBe(asset.extension === 'png' ? 'Scale' : 'Uncategorized');
        }
        expect(selected, context).toEqual(expectedSelected);

        // No editable page is exposed; size/selection stay normalized for URLs.
        expect(page.assetPage).toEqual([]);
        expect(page.candidates).toEqual([]);
        expect(page.assetPresentation.assets).toEqual([]);
        expect(page.assetPresentation.candidates).toEqual([]);
        expect(page.assetPageNumber).toBe(1);
        expect(page.assetPageCount).toBe(1);
        expect(page.assetPageSize, context).toBe(EXPECTED_SIZE[query.pageSize]);
        expect(page.candidatePageSize).toBe(EXPECTED_SIZE[query.pageSize]);
        expect(page.assetTotal).toBeNull();
        expect(page.candidateTotal).toBeNull();
        expect(page.assetFilters.selection).toBe(query.selection === 'all' ? 'all' : 'selected');
        // Category and eligibility aggregates are unchanged.
        expect(page.categoryNavigation).toEqual({ totalCount: 3000, uncategorizedCount: 1500, byCategoryId: { [f.category.id]: 1500 } });
        expect(page.eligibleAssetCount).toBe(2998);
        expect(page.eligibleCandidateCount).toBe(2998 - 119);
        expect(page.assetExtensions).toEqual(['png', 'txt']);
        expect(page.activeCategoryId).toBe(query.category ? f.category.id : null);
      }

      expect(db.prepare('SELECT * FROM release_assets WHERE release_id = ? ORDER BY asset_id').all(f.release.id))
        .toEqual(membershipBefore);
    });

    it.each(READ_ONLY_STATES)('%s keeps category validation (422 syntax, 404 foreign) without editable reads', (_label, makeReadOnly) => {
      const release = service.createRelease(projectId, validInput());
      addAssets(5);
      const foreignProject = projectRepo.create(sampleProject({ title: 'Foreign RO Project' }));
      const foreignCategory = addCategory('Foreign', 'foreign', foreignProject.id);
      makeReadOnly(release);
      let error;
      try { service.getReleaseAssetManagementPage(release.id, { category: 'abc' }); } catch (err) { error = err; }
      expect(error).toBeInstanceOf(AssetCategoryValidationError);
      expect(error.status).toBe(422);
      expect(() => service.getReleaseAssetManagementPage(release.id, { category: String(foreignCategory.id) }))
        .toThrow(AssetCategoryNotFoundError);
    });

    it('editable control: the same fixture still reads one bounded page of 25 and View All reads every eligible row', () => {
      const f = buildReadOnlyFixture();
      const numeric = measure((measured) => measured.getReleaseAssetManagementPage(f.release.id, { selection: 'all', pageSize: '25', page: '3' }));
      expect(numeric.result.readOnly).toBe(false);
      expect(numeric.log.filter(isFilteredCountSql)).toHaveLength(1);
      const pageRows = numeric.log.filter(isPageRowsSql);
      expect(pageRows).toHaveLength(1);
      expect(pageRows[0].metadataRows).toBe(25);
      expect(numeric.log.reduce((sum, entry) => sum + entry.metadataRows, 0)).toBe(25);
      expect(numeric.result.assetTotal).toBe(2999);
      expect(numeric.result.assetPageNumber).toBe(3);
      expect(numeric.result.assetPageCount).toBe(120);
      expect(numeric.result.candidateTotal).toBe(2999 - 120);
      expect(numeric.changed).toBe(0);

      const viewAll = measure((measured) => measured.getReleaseAssetManagementPage(f.release.id, { selection: 'all', pageSize: 'all' }));
      expect(viewAll.log.filter(isViewAllRowsSql)[0].metadataRows).toBe(2999);
      expect(viewAll.result.assetPage).toHaveLength(2999);
      expect(viewAll.result.assetPageSize).toBe('all');
    });

    // B-F4: a read-only page displays only the persisted saved collection, so
    // a rejected Save's submitted IDs are never hydrated there; persisted and
    // submitted membership stay distinct in the model.
    it.each(READ_ONLY_STATES)('%s rejected Save reads only the saved collection: no editable page, no submitted-ID hydration', (_label, makeReadOnly) => {
      const f = buildReadOnlyFixture();
      makeReadOnly(f.release);
      const savedIds = f.saved.map((asset) => asset.id);
      const submitted = [
        { asset_id: f.saved[1].id, role: 'primary', sort_order: 0 },
        { asset_id: f.nonMember.id, role: 'attachment', sort_order: 1 },
      ];
      const { result: model, log, changed } = measure((measured) => measured.getReleaseAssetSaveErrorPage(
        f.release.id, { selection: 'all', pageSize: '25' }, submitted, '24h',
      ));
      expect(changed).toBe(0);
      expect(log.filter((entry) => entry.method === 'run')).toEqual([]);
      expect(log.filter(isEditablePageSql)).toEqual([]);
      expect(log.filter((entry) => entry.sql.includes('a.project_id = ? AND a.id IN ('))).toEqual([]);
      expect(model.readOnly).toBe(true);

      // Persisted display: complete saved collection, stored order, roles,
      // missing member and metadata.
      const selected = model.assetPresentation.selected;
      expect(selected.map((asset) => asset.id)).toEqual(savedIds);
      expect(model.releaseAssets.map((row) => row.asset_id)).toEqual(savedIds);
      expect(selected[0].releaseContext).toEqual({ selected: true, role: 'primary', sortOrder: 0 });
      expect(selected[1].releaseContext).toEqual({ selected: true, role: 'preview', sortOrder: 1 });
      expect(selected.filter((asset) => asset.presence_state === 'missing').map((asset) => asset.id)).toEqual([f.missingSaved.id]);
      expect(selected.map((asset) => asset.filename)).toEqual(f.saved.map((asset) => asset.filename));
      expect(model.releaseAssets[3]).toMatchObject({ source_animated: 1, source_generation: 3 });

      // Submitted draft kept separate; the non-member gains no metadata.
      expect(model.submittedReleaseAssets).toEqual(submitted);
      expect(model.submittedAssetPresentation.selected.map((asset) => asset.filename))
        .toEqual([f.saved[1].filename, '']);

      // Only metadata read: the one saved-collection statement.
      const metadataStatements = log.filter((entry) => entry.metadataRows > 0);
      expect(metadataStatements).toHaveLength(1);
      expect(isSavedCollectionSql(metadataStatements[0])).toBe(true);
      expect(metadataStatements[0].metadataRows).toBe(savedIds.length);
    });
  });

  describe('Save validation-error recovery', () => {
    function buildSaveFixture() {
      const assets = byFilename([
        ...addAssets(60, { prefix: 'a', extension: 'txt' }),
        ...addAssets(1, { prefix: 'z-hidden', extension: 'png' }),
      ]);
      const hidden = assets.find((a) => a.extension === 'png');
      const release = service.createRelease(projectId, validInput());
      const primary = assets[0];
      const preview = assets[1];
      const offPageRemoval = assets[40];
      persistMembership(release.id, [
        { id: primary.id, role: 'primary', sortOrder: 0 },
        { id: preview.id, role: 'preview', sortOrder: 1 },
        { id: hidden.id, sortOrder: 2 },
        { id: offPageRemoval.id, sortOrder: 3 },
      ]);
      const foreignProject = projectRepo.create(sampleProject({ title: 'Foreign Save Project' }));
      const [foreign] = addAssets(1, { prefix: 'foreign', project: foreignProject.id });
      return { assets, hidden, release, primary, preview, offPageRemoval, offPageAddition: assets[50], foreign };
    }

    it('retains the submitted selection with project-scoped batched metadata and no mutation', () => {
      const f = buildSaveFixture();
      const rawQuery = { selection: 'all', extension: 'txt', pageSize: '10', page: '1' };
      // Submitted draft: keep Primary/Preview/hidden, add an off-page asset,
      // drop the off-page saved asset, and an invalid role triggers 422.
      const submitted = [
        { asset_id: f.preview.id, role: 'preview', sort_order: 0 },
        { asset_id: f.primary.id, role: 'primary', sort_order: 1 },
        { asset_id: f.hidden.id, role: 'attachment', sort_order: 2 },
        { asset_id: f.offPageAddition.id, role: 'attachment', sort_order: 3 },
        { asset_id: f.assets[2].id, role: 'bogus', sort_order: 4 },
        { asset_id: f.foreign.id, role: 'attachment', sort_order: 5 },
      ];
      const membershipBefore = db.prepare('SELECT * FROM release_assets WHERE release_id = ? ORDER BY asset_id').all(f.release.id);
      expect(() => service.selectAssets(f.release.id, submitted.map((s) => ({
        assetId: s.asset_id, role: s.role, sortOrder: s.sort_order,
      })))).toThrow(ReleaseValidationError);

      const changesBefore = db.prepare('SELECT total_changes() AS c').get().c;
      const { log, restore } = instrumentStatements(db);
      const measured = createReleaseService({ db });
      log.length = 0;
      const model = measured.getReleaseAssetSaveErrorPage(f.release.id, rawQuery, submitted, '24h');
      restore();

      expect(db.prepare('SELECT total_changes() AS c').get().c).toBe(changesBefore);
      expect(db.prepare('SELECT * FROM release_assets WHERE release_id = ? ORDER BY asset_id').all(f.release.id))
        .toEqual(membershipBefore);

      // Submitted and persisted membership stay distinct.
      expect(model.submittedReleaseAssets).toEqual(submitted);
      expect(model.releaseAssets.map((m) => [m.asset_id, m.role, m.sort_order])).toEqual([
        [f.primary.id, 'primary', 0], [f.preview.id, 'preview', 1], [f.hidden.id, 'attachment', 2],
        [f.offPageRemoval.id, 'attachment', 3],
      ]);

      // Draft presentation: exact IDs, order and roles; off-page and hidden
      // submitted assets hydrated; the foreign ID gets no metadata.
      const selected = model.submittedAssetPresentation.selected;
      expect(selected.map((a) => a.id)).toEqual(submitted.map((s) => s.asset_id));
      expect(selected.map((a) => a.releaseContext.role)).toEqual(submitted.map((s) => s.role));
      expect(selected.map((a) => a.releaseContext.sortOrder)).toEqual(submitted.map((s) => s.sort_order));
      expect(selected[2].filename).toBe(f.hidden.filename);
      expect(selected[3].filename).toBe(f.offPageAddition.filename);
      expect(selected[5]).toMatchObject({ id: f.foreign.id, filename: '', project_id: null, relative_path: null });
      expect(selected.map((a) => a.id)).not.toContain(f.offPageRemoval.id);

      // Visible page is the bounded page with draft membership applied.
      expect(ids(model.assetPage)).toEqual(ids(f.assets.filter((a) => a.extension === 'txt').slice(0, 10)));
      const cards = Object.fromEntries(model.submittedAssetPresentation.assets.map((a) => [a.id, a.releaseContext]));
      expect(cards[f.primary.id]).toEqual({ selected: true, role: 'primary', sortOrder: 1 });
      expect(cards[f.assets[3].id].selected).toBe(false);

      // One batched project-scoped lookup of only the off-page project IDs.
      const lookups = log.filter((e) => e.sql.includes('a.project_id = ? AND a.id IN ('));
      expect(lookups).toHaveLength(1);
      expect(lookups[0].args[0]).toBe(projectId);
      expect(lookups[0].args.slice(1).sort((x, y) => x - y))
        .toEqual([f.hidden.id, f.offPageAddition.id, f.foreign.id].sort((x, y) => x - y));
      expect(lookups[0].rows).toBe(2);
      expect(log.reduce((sum, e) => sum + e.metadataRows, 0)).toBe(12);
      expect(log.filter((e) => /FROM assets\b/.test(e.sql) && !/LIMIT|GROUP BY|DISTINCT|IN \(/.test(e.sql))).toEqual([]);
    });

    it('never lets a foreign submitted ID supply presentation metadata', () => {
      const f = buildSaveFixture();
      const model = service.getReleaseAssetSaveErrorPage(f.release.id, { selection: 'all' }, [
        { asset_id: f.foreign.id, role: 'primary', sort_order: 0 },
      ]);
      expect(model.submittedAssetPresentation.selected).toHaveLength(1);
      expect(model.submittedAssetPresentation.selected[0]).toMatchObject({
        id: f.foreign.id, filename: '', project_id: null, relative_path: null,
      });
      expect(model.submittedAssetPresentation.assets.map((a) => a.id)).not.toContain(f.foreign.id);
    });

    // C4b: recovery hydration has two layers — the project-scoped batched
    // lookup and the same-project filter on metadata sources. The second is
    // proved on its own by rewriting the lookup to ignore the project (a
    // simulated repository regression) and checking that the foreign row is
    // actually returned yet still supplies no rendering metadata.
    it('C4b: a foreign submitted ID never hydrates filename, path, category or project into the recovery model, even if the lookup returns its row', () => {
      const f = buildSaveFixture();
      const foreignProject = projectRepo.create(sampleProject({ title: 'Quokka Isolation Project' }));
      const foreignCategory = addCategory('Quokka Vault Category', 'quokka-vault', foreignProject.id);
      const [foreign] = addAssets(1, { prefix: 'quokka-secret', extension: 'png', project: foreignProject.id, categoryId: foreignCategory.id });
      const FOREIGN_STRINGS = [foreign.filename, foreign.relative_path, 'Quokka', 'quokka'];
      expect(foreign.filename).toContain('quokka-secret');
      const rawQuery = { selection: 'all', extension: 'txt', pageSize: '10', page: '1' };
      const submitted = [
        { asset_id: f.primary.id, role: 'primary', sort_order: 0 },
        { asset_id: f.offPageAddition.id, role: 'attachment', sort_order: 1 },
        { asset_id: foreign.id, role: 'preview', sort_order: 2 },
        { asset_id: f.hidden.id, role: 'attachment', sort_order: 3 },
      ];
      const membershipBefore = db.prepare('SELECT * FROM release_assets WHERE release_id = ? ORDER BY asset_id').all(f.release.id);

      // The foreign ID cannot persist as membership (membership-only Save).
      let refusal = null;
      try {
        service.selectAssets(f.release.id, submitted.map((s) => ({ assetId: s.asset_id })), { membershipOnly: true });
      } catch (err) {
        refusal = err;
      }
      expect(refusal).toBeInstanceOf(ReleaseValidationError);
      expect(refusal.errors).toEqual({ assets: `Asset ${foreign.id} does not belong to the release's project.` });
      expect(db.prepare('SELECT * FROM release_assets WHERE release_id = ? ORDER BY asset_id').all(f.release.id))
        .toEqual(membershipBefore);

      // Every string reachable from the model, for a leak scan.
      const strings = (value, out = []) => {
        if (typeof value === 'string') out.push(value);
        else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
        else if (value && typeof value === 'object') Object.values(value).forEach((item) => strings(item, out));
        return out;
      };
      const objects = (value, out = []) => {
        if (Array.isArray(value)) value.forEach((item) => objects(item, out));
        else if (value && typeof value === 'object') { out.push(value); Object.values(value).forEach((item) => objects(item, out)); }
        return out;
      };
      const expectIsolated = (model, label) => {
        const leaked = strings(model).filter((text) => FOREIGN_STRINGS.some((needle) => text.includes(needle)));
        expect(leaked, label).toEqual([]);
        expect(objects(model).filter((o) => o.project_id === foreignProject.id || o.category_id === foreignCategory.id), label).toEqual([]);
        // The foreign entry keeps only its submitted ID, role and order.
        const presentation = model.submittedAssetPresentation;
        const entry = presentation.selected.find((asset) => asset.id === foreign.id);
        expect(entry, label).toMatchObject({ id: foreign.id, filename: '', project_id: null, relative_path: null });
        expect(entry.releaseContext, label).toEqual({ selected: true, role: 'preview', sortOrder: 2 });
        expect([...presentation.assets, ...presentation.candidates].map((asset) => asset.id), label).not.toContain(foreign.id);
        expect(model.submittedReleaseAssets, label).toEqual(submitted);
        // Local recovery metadata stays intact: on-page, off-page and hidden.
        const byId = new Map(presentation.selected.map((asset) => [asset.id, asset]));
        expect(byId.get(f.primary.id).filename, label).toBe(f.primary.filename);
        expect(byId.get(f.offPageAddition.id).filename, label).toBe(f.offPageAddition.filename);
        expect(byId.get(f.hidden.id).filename, label).toBe(f.hidden.filename);
        expect(byId.get(f.hidden.id).relative_path, label).toBe(f.hidden.relative_path);
      };

      // 1. Real service, all layers.
      expectIsolated(service.getReleaseAssetSaveErrorPage(f.release.id, rawQuery, submitted, '24h'), 'all layers');

      // 2. Project scope removed from the recovery lookup only.
      const LOOKUP = 'WHERE a.project_id = ? AND a.id IN (';
      const lookupRows = [];
      const original = db.prepare;
      db.prepare = function prepare(sql) {
        if (!sql.includes(LOOKUP)) return original.call(this, sql);
        const stmt = original.call(this, sql.replace(LOOKUP, 'WHERE (a.project_id = ? OR 1) AND a.id IN ('));
        const all = stmt.all;
        stmt.all = function execute(...args) {
          const rows = all.apply(this, args);
          lookupRows.push(...rows);
          return rows;
        };
        return stmt;
      };
      let unscoped;
      try {
        unscoped = createReleaseService({ db }).getReleaseAssetSaveErrorPage(f.release.id, rawQuery, submitted, '24h');
      } finally {
        db.prepare = original;
      }
      // The simulated regression really returned the foreign row ...
      expect(lookupRows.map((row) => row.id).sort((x, y) => x - y))
        .toEqual([f.hidden.id, f.offPageAddition.id, foreign.id].sort((x, y) => x - y));
      expect(lookupRows.find((row) => row.id === foreign.id)).toMatchObject({
        project_id: foreignProject.id, filename: foreign.filename, category_display_name: 'Quokka Vault Category',
      });
      // ... and the same-project filter still keeps it out of the model.
      expectIsolated(unscoped, 'unscoped lookup');
      expect(db.prepare('SELECT * FROM release_assets WHERE release_id = ? ORDER BY asset_id').all(f.release.id))
        .toEqual(membershipBefore);
    });
  });
});
