import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createReleaseService, ReleaseValidationError, ReleaseNotFoundError, ReleaseArchivedError, ReleaseParentArchivedError, AssetNotFoundError } from '../src/services/release-service.js';
import { evaluateReleaseReadiness } from '../src/services/release-readiness-policy.js';
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

function validInput(overrides = {}) {
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

/**
 * Create a ready release with a selected present asset so it passes the
 * readiness policy. Returns { release, asset }.
 */
function createPublishableRelease(service, assetRepo, projectId, inputOverrides = {}) {
  const release = service.createRelease(projectId, validInput({ status: 'ready', ...inputOverrides }));
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
  let projectId;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-svc-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    service = createReleaseService({ db, evaluateReleaseReadiness });
    projectRepo = createProjectRepository(db);
    assetRepo = createAssetRepository(db);
    const project = projectRepo.create(sampleProject({ title: 'Parent Project' }));
    projectId = project.id;
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

    it('rejects invalid status', () => {
      expect(() => {
        service.createRelease(projectId, validInput({ status: 'invalid' }));
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

    it('rejects invalid patreon_url', () => {
      expect(() => {
        service.createRelease(projectId, validInput({ patreonUrl: 'not-a-url' }));
      }).toThrow(ReleaseValidationError);
      expect(() => {
        service.createRelease(projectId, validInput({ patreonUrl: 'http://patreon.com/user' }));
      }).toThrow(ReleaseValidationError);
      expect(() => {
        service.createRelease(projectId, validInput({ patreonUrl: 'https://google.com/user' }));
      }).toThrow(ReleaseValidationError);
    });

    it('accepts valid patreon_url', () => {
      const release = service.createRelease(projectId, validInput({
        patreonUrl: 'https://patreon.com/user',
      }));
      expect(release.patreon_url).toBe('https://patreon.com/user');
    });

    it('accepts valid subdomain patreon_url', () => {
      const release = service.createRelease(projectId, validInput({
        patreonUrl: 'https://mysite.patreon.com/user',
      }));
      expect(release.patreon_url).toBe('https://mysite.patreon.com/user');
    });

    it('accepts null patreon_url', () => {
      const release = service.createRelease(projectId, validInput({ patreonUrl: null }));
      expect(release.patreon_url).toBeNull();
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

  describe('updateRelease', () => {
    it('updates a release', () => {
      const created = service.createRelease(projectId, validInput({ title: 'Original' }));
      const updated = service.updateRelease(created.id, validInput({ title: 'Updated' }));
      expect(updated.title).toBe('Updated');
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

    it('rejects invalid status on update', () => {
      const created = service.createRelease(projectId, validInput());
      expect(() => {
        service.updateRelease(created.id, validInput({ status: 'invalid' }));
      }).toThrow(ReleaseValidationError);
    });

    it('throws ReleaseNotFoundError when updating an archived release', () => {
      const created = service.createRelease(projectId, validInput({ title: 'Original' }));
      service.archiveRelease(created.id);
      expect(() => {
        service.updateRelease(created.id, validInput({ title: 'Should Not Update' }));
      }).toThrow(ReleaseNotFoundError);
    });
  });

  describe('publishRelease', () => {
    function selectAssetForRelease(releaseId) {
      const asset = assetRepo.upsert(projectId, 'publish-test.txt', sampleAsset(projectId, { relativePath: 'publish-test.txt' }));
      service.selectAssets(releaseId, [{ assetId: asset.id, role: 'primary', sortOrder: 0 }]);
      return asset;
    }

    it('publishes a release with default date (today)', () => {
      const created = service.createRelease(projectId, validInput({ status: 'ready' }));
      selectAssetForRelease(created.id);
      const published = service.publishRelease(created.id);
      expect(published.status).toBe('published');
      expect(published.published_date).toBeTruthy();
    });

    it('publishes a release with specified date', () => {
      const created = service.createRelease(projectId, validInput({ status: 'ready' }));
      selectAssetForRelease(created.id);
      const published = service.publishRelease(created.id, '2025-06-15');
      expect(published.status).toBe('published');
      expect(published.published_date).toBe('2025-06-15');
    });

    it('throws ReleaseNotFoundError for non-existent id', () => {
      expect(() => {
        service.publishRelease(99999);
      }).toThrow(ReleaseNotFoundError);
    });

    it('throws if release is already published', () => {
      const created = service.createRelease(projectId, validInput({ status: 'ready' }));
      selectAssetForRelease(created.id);
      service.publishRelease(created.id);
      const before = snapshotReleaseRow(db, created.id);
      expect(() => {
        service.publishRelease(created.id);
      }).toThrow(ReleaseValidationError);
      expect(snapshotReleaseRow(db, created.id)).toEqual(before);
    });

    it('throws if release is cancelled', () => {
      const created = service.createRelease(projectId, validInput({ status: 'cancelled' }));
      expect(() => {
        service.publishRelease(created.id);
      }).toThrow(ReleaseValidationError);
    });

    it('throws if release is archived', () => {
      const created = service.createRelease(projectId, validInput());
      service.archiveRelease(created.id);
      expect(() => {
        service.publishRelease(created.id);
      }).toThrow(ReleaseValidationError);
    });

    it('throws for invalid published date', () => {
      const created = service.createRelease(projectId, validInput({ status: 'ready' }));
      selectAssetForRelease(created.id);
      expect(() => {
        service.publishRelease(created.id, 'invalid');
      }).toThrow(ReleaseValidationError);
      expect(() => {
        service.publishRelease(created.id, '2025-13-01');
      }).toThrow(ReleaseValidationError);
    });

    it('throws if release is not ready', () => {
      const statuses = ['idea', 'planned', 'drafting', 'cancelled'];
      for (const status of statuses) {
        const created = service.createRelease(projectId, validInput({
          title: `Non-Ready ${status} Release`,
          description: `Description before ${status} rejection`,
          notes: `Notes before ${status} rejection`,
          status,
          plannedDate: '2025-06-15',
          patreonUrl: 'https://patreon.com/creator',
        }));
        const before = snapshotReleaseRow(db, created.id);

        expect(() => {
          service.publishRelease(created.id);
        }).toThrow(ReleaseValidationError);

        expect(snapshotReleaseRow(db, created.id)).toEqual(before);
      }
    });

    // ─── Phase 7C-1: Readiness enforcement ────────────────────────────────

    it('rejects publish when no assets are selected (zero assets) without changing the complete release row', () => {
      const created = service.createRelease(projectId, validInput({
        title: 'Zero Asset Release',
        description: 'Description before rejection',
        notes: 'Notes before rejection',
        status: 'ready',
        plannedDate: '2025-06-15',
        patreonUrl: 'https://patreon.com/creator',
      }));
      const before = snapshotReleaseRow(db, created.id);

      expect(() => {
        service.publishRelease(created.id);
      }).toThrow(ReleaseValidationError);

      expect(snapshotReleaseRow(db, created.id)).toEqual(before);
    });

    it('rejects publish when a selected asset is missing without changing the complete release row', () => {
      const { release } = createPublishableRelease(service, assetRepo, projectId, {
        title: 'Missing Asset Release',
        description: 'Description before missing asset rejection',
        notes: 'Notes before missing asset rejection',
        plannedDate: '2025-06-15',
        patreonUrl: 'https://patreon.com/creator',
      });
      // Mark the selected asset as missing
      assetRepo.markMissingByProjectIdAndPathNotIn(projectId, []);
      const before = snapshotReleaseRow(db, release.id);

      expect(() => {
        service.publishRelease(release.id);
      }).toThrow(ReleaseValidationError);

      expect(snapshotReleaseRow(db, release.id)).toEqual(before);
    });

    it('rejects publish when release is archived (readiness scope_mutable) without changing the complete release row', () => {
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
      }).toThrow(ReleaseValidationError);

      expect(snapshotReleaseRow(db, release.id)).toEqual(before);
    });

    it('rejects publish when parent project is archived (readiness scope_mutable) without changing the complete release row', () => {
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

    it('rejects publish for a non-ready release without changing the complete release row', () => {
      const created = service.createRelease(projectId, validInput({
        title: 'Non-Ready Release',
        description: 'Description before non-ready rejection',
        notes: 'Notes before non-ready rejection',
        status: 'planned',
        plannedDate: '2025-06-15',
        patreonUrl: 'https://patreon.com/creator',
      }));
      selectAssetForRelease(created.id);
      const before = snapshotReleaseRow(db, created.id);

      expect(() => {
        service.publishRelease(created.id);
      }).toThrow(ReleaseValidationError);

      expect(snapshotReleaseRow(db, created.id)).toEqual(before);
    });

    it('rejects publish with multiple readiness blockers without changing the complete release row', () => {
      const created = service.createRelease(projectId, validInput({
        title: 'Multiple Blockers Release',
        description: 'Description before multiple-blocker rejection',
        notes: 'Notes before multiple-blocker rejection',
        status: 'ready',
        plannedDate: '2025-06-15',
        patreonUrl: 'https://patreon.com/creator',
      }));
      service.archiveRelease(created.id);
      const before = snapshotReleaseRow(db, created.id);

      const facts = service.repository.findReadinessFactsById(created.id);
      const policyResult = evaluateReleaseReadiness(facts);
      expect(policyResult.checks.filter((check) => !check.passed).map((check) => check.key)).toEqual([
        'assets_selected',
        'scope_mutable',
      ]);

      expect(() => {
        service.publishRelease(created.id);
      }).toThrow(ReleaseValidationError);

      expect(snapshotReleaseRow(db, created.id)).toEqual(before);
    });

    it('reports readiness blockers when publish is rejected', () => {
      // Create a ready release with no assets — readiness check runs and
      // reports the assets_selected blocker.
      const created = service.createRelease(projectId, validInput({ status: 'ready' }));
      const before = snapshotReleaseRow(db, created.id);
      try {
        service.publishRelease(created.id);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ReleaseValidationError);
        expect(err.errors.readiness).toBeDefined();
        // Should have the assets_selected blocker
        expect(err.errors.readiness.assets_selected).toBeDefined();
        expect(err.errors.readiness.assets_selected.selectedAssetCount).toBe(0);
      }
      expect(snapshotReleaseRow(db, created.id)).toEqual(before);
    });

    it('does not change the complete release row when readiness check fails', () => {
      const created = service.createRelease(projectId, validInput({
        title: 'Readiness Failure Release',
        description: 'Description before readiness failure',
        notes: 'Notes before readiness failure',
        status: 'ready',
        plannedDate: '2025-06-15',
        patreonUrl: 'https://patreon.com/creator',
      }));
      const before = snapshotReleaseRow(db, created.id);

      expect(() => {
        service.publishRelease(created.id);
      }).toThrow(ReleaseValidationError);

      expect(snapshotReleaseRow(db, created.id)).toEqual(before);
    });

    it('calls the shared readiness policy exactly once for successful publication', () => {
      const { release } = createPublishableRelease(service, assetRepo, projectId, {
        title: 'Spy Successful Release',
      });
      const expectedFacts = service.repository.findReadinessFactsById(release.id);
      expect(expectedFacts).toEqual({
        release_id: release.id,
        project_id: projectId,
        release_status: 'ready',
        release_archived_at: null,
        project_archived_at: null,
        selected_asset_count: 1,
        present_selected_asset_count: 1,
        missing_selected_asset_count: 0,
        primary_role_count: 1,
        preview_role_count: 0,
        attachment_role_count: 0,
        source_role_count: 0,
      });
      const evaluateReleaseReadinessSpy = vi.fn().mockReturnValue({
        publishable: true,
        checks: [],
        facts: expectedFacts,
      });
      const publishingService = createReleaseService({
        db,
        evaluateReleaseReadiness: evaluateReleaseReadinessSpy,
      });

      const published = publishingService.publishRelease(release.id, '2025-06-15');

      expect(published.status).toBe('published');
      expect(evaluateReleaseReadinessSpy).toHaveBeenCalledTimes(1);
      expect(evaluateReleaseReadinessSpy).toHaveBeenCalledWith(expectedFacts);
    });

    it('calls the shared readiness policy exactly once for blocked publication', () => {
      const created = service.createRelease(projectId, validInput({
        title: 'Spy Blocked Release',
        status: 'ready',
      }));
      const expectedFacts = service.repository.findReadinessFactsById(created.id);
      expect(expectedFacts).toEqual({
        release_id: created.id,
        project_id: projectId,
        release_status: 'ready',
        release_archived_at: null,
        project_archived_at: null,
        selected_asset_count: 0,
        present_selected_asset_count: 0,
        missing_selected_asset_count: 0,
        primary_role_count: 0,
        preview_role_count: 0,
        attachment_role_count: 0,
        source_role_count: 0,
      });
      const evaluateReleaseReadinessSpy = vi.fn().mockReturnValue({
        publishable: false,
        checks: [{
          key: 'assets_selected',
          passed: false,
          severity: 'blocker',
          details: { selectedAssetCount: expectedFacts.selected_asset_count },
        }],
        facts: expectedFacts,
      });
      const publishingService = createReleaseService({
        db,
        evaluateReleaseReadiness: evaluateReleaseReadinessSpy,
      });

      expect(() => {
        publishingService.publishRelease(created.id);
      }).toThrow(ReleaseValidationError);

      expect(evaluateReleaseReadinessSpy).toHaveBeenCalledTimes(1);
      expect(evaluateReleaseReadinessSpy).toHaveBeenCalledWith(expectedFacts);
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
      }).toThrow(ReleaseValidationError);
    });

    it('does not change status when archiving', () => {
      const created = service.createRelease(projectId, validInput({ status: 'planned' }));
      const archived = service.archiveRelease(created.id);
      expect(archived.status).toBe('planned');
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

      const rows = db.prepare('SELECT asset_id, role, sort_order FROM release_assets WHERE release_id = ? ORDER BY sort_order ASC').all(release.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ asset_id: asset2.id, role: 'attachment', sort_order: 1 });
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

  describe('listReleases', () => {
    it('returns releases for a project', () => {
      service.createRelease(projectId, validInput({ title: 'R1' }));
      service.createRelease(projectId, validInput({ title: 'R2' }));
      const releases = service.listReleases(projectId);
      expect(releases).toHaveLength(2);
    });

    it('filters by status', () => {
      service.createRelease(projectId, validInput({ title: 'Idea', status: 'idea' }));
      service.createRelease(projectId, validInput({ title: 'Planned', status: 'planned' }));
      const planned = service.listReleases(projectId, { status: 'planned' });
      expect(planned).toHaveLength(1);
      expect(planned[0].status).toBe('planned');
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

  describe('countByStatus (service)', () => {
    it('returns counts of releases by status', () => {
      service.createRelease(projectId, validInput({ title: 'Idea 1', status: 'idea' }));
      service.createRelease(projectId, validInput({ title: 'Idea 2', status: 'idea' }));
      service.createRelease(projectId, validInput({ title: 'Planned 1', status: 'planned' }));
      const counts = service.countByStatus();
      expect(counts.idea).toBe(2);
      expect(counts.planned).toBe(1);
      expect(counts.drafting).toBe(0);
    });

    it('excludes archived releases from count', () => {
      const r1 = service.createRelease(projectId, validInput({ status: 'idea' }));
      service.createRelease(projectId, validInput({ status: 'idea' }));
      service.archiveRelease(r1.id);
      const counts = service.countByStatus();
      expect(counts.idea).toBe(1);
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

      service.createRelease(projectId, validInput({ title: 'Later', plannedDate: fmt(future2), status: 'planned' }));
      service.createRelease(projectId, validInput({ title: 'Sooner', plannedDate: fmt(future1), status: 'planned' }));
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
      const r1 = service.createRelease(projectId, validInput({ title: 'Archived', plannedDate: fmt(future), status: 'planned' }));
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
      service.createRelease(projectId, validInput({ title: 'Overdue', plannedDate: fmt(past), status: 'planned' }));
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
      const r1 = service.createRelease(projectId, validInput({ title: 'Archived', plannedDate: fmt(past), status: 'planned' }));
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

  describe('lifecycle transitions', () => {
    it('createRelease rejects status=published', () => {
      expect(() => {
        service.createRelease(projectId, validInput({
          status: 'published',
          publishedDate: '2025-06-15',
        }));
      }).toThrow(ReleaseValidationError);
    });

    it('createRelease allows status=cancelled (historical/imported releases)', () => {
      // Cancelled is allowed as initial status for imported/historical releases
      const release = service.createRelease(projectId, validInput({ status: 'cancelled' }));
      expect(release.status).toBe('cancelled');
    });

    it('updateRelease rejects transition to status=published', () => {
      const created = service.createRelease(projectId, validInput({ status: 'idea' }));
      expect(() => {
        service.updateRelease(created.id, validInput({
          status: 'published',
          publishedDate: '2025-07-01',
        }));
      }).toThrow(ReleaseValidationError);
    });

    it('updateRelease rejects transition from cancelled to any other status', () => {
      const created = service.createRelease(projectId, validInput({ status: 'cancelled' }));
      // Try to move from cancelled to idea
      expect(() => {
        service.updateRelease(created.id, validInput({ status: 'idea' }));
      }).toThrow(ReleaseValidationError);
      // Try to move from cancelled to ready
      expect(() => {
        service.updateRelease(created.id, validInput({ status: 'ready' }));
      }).toThrow(ReleaseValidationError);
    });

    it('updateRelease rejects transition from published to any other status', () => {
      const { release: created } = createPublishableRelease(service, assetRepo, projectId);
      service.publishRelease(created.id);
      // Try to move from published back to ready
      expect(() => {
        service.updateRelease(created.id, validInput({ status: 'ready' }));
      }).toThrow(ReleaseValidationError);
    });

    it('updateRelease allows valid transitions', () => {
      const created = service.createRelease(projectId, validInput({ status: 'idea' }));
      // idea → planned
      let updated = service.updateRelease(created.id, validInput({ status: 'planned' }));
      expect(updated.status).toBe('planned');
      // planned → drafting
      updated = service.updateRelease(created.id, validInput({ status: 'drafting' }));
      expect(updated.status).toBe('drafting');
      // drafting → ready
      updated = service.updateRelease(created.id, validInput({ status: 'ready' }));
      expect(updated.status).toBe('ready');
      // ready → cancelled
      updated = service.updateRelease(created.id, validInput({ status: 'cancelled' }));
      expect(updated.status).toBe('cancelled');
    });

    it('createRelease allows valid initial statuses', () => {
      for (const status of ['idea', 'planned', 'drafting', 'ready', 'cancelled']) {
        const release = service.createRelease(projectId, validInput({ status }));
        expect(release.status).toBe(status);
      }
    });
  });

  describe('upcomingReleases excludes past dates', () => {
    it('excludes releases with past planned_date', () => {
      const today = new Date();
      const past = new Date(today);
      past.setDate(past.getDate() - 30);
      const fmt = (d) => d.toISOString().split('T')[0];
      const todayIso = fmt(today);

      service.createRelease(projectId, validInput({ title: 'Past Release', plannedDate: fmt(past), status: 'planned' }));
      const upcoming = service.upcomingReleases(todayIso);
      expect(upcoming).toHaveLength(0);
    });

    it('excludes releases with today as planned_date', () => {
      const today = '2025-06-15';
      service.createRelease(projectId, validInput({ title: 'Today Release', plannedDate: today, status: 'planned' }));
      const upcoming = service.upcomingReleases(today);
      expect(upcoming).toHaveLength(0);
    });

    it('excludes cancelled releases', () => {
      const today = new Date();
      const future = new Date(today);
      future.setDate(future.getDate() + 30);
      const fmt = (d) => d.toISOString().split('T')[0];
      const todayIso = fmt(today);

      service.createRelease(projectId, validInput({ title: 'Cancelled Future', plannedDate: fmt(future), status: 'cancelled' }));
      const upcoming = service.upcomingReleases(todayIso);
      expect(upcoming).toHaveLength(0);
    });
  });

  // ─── Terminal release metadata behavior ─────────────────────────────────
  //
  // "Terminal" statuses are `published` and `cancelled`. They cannot transition
  // to any other status (see lifecycle transitions above), but the user is
  // still allowed to edit other metadata. These tests pin down the expected
  // behavior of terminal releases so future changes cannot silently regress it.

  describe('terminal release metadata', () => {
    it('allows updating the title of a published release', () => {
      const { release: created } = createPublishableRelease(service, assetRepo, projectId);
      const published = service.publishRelease(created.id, '2025-06-15');

      const updated = service.updateRelease(published.id, validInput({
        title: 'Edited Title',
        status: 'published',
        publishedDate: '2025-06-15',
      }));
      expect(updated.status).toBe('published');
      expect(updated.title).toBe('Edited Title');
      expect(updated.published_date).toBe('2025-06-15');
    });

    it('allows updating the description of a published release', () => {
      const { release: created } = createPublishableRelease(service, assetRepo, projectId);
      const published = service.publishRelease(created.id, '2025-06-15');

      const updated = service.updateRelease(published.id, validInput({
        description: 'Updated description after publish',
        status: 'published',
        publishedDate: '2025-06-15',
      }));
      expect(updated.status).toBe('published');
      expect(updated.description).toBe('Updated description after publish');
    });

    it('allows updating the title of a cancelled release', () => {
      const created = service.createRelease(projectId, validInput({ status: 'cancelled' }));

      const updated = service.updateRelease(created.id, validInput({
        title: 'Cancelled But Edited',
        status: 'cancelled',
      }));
      expect(updated.status).toBe('cancelled');
      expect(updated.title).toBe('Cancelled But Edited');
    });

    it('archiving a published release preserves its published status and date', () => {
      const { release: created } = createPublishableRelease(service, assetRepo, projectId);
      const published = service.publishRelease(created.id, '2025-06-15');

      const archived = service.archiveRelease(published.id);
      expect(archived.status).toBe('published');
      expect(archived.published_date).toBe('2025-06-15');
      expect(archived.archived_at).toBeTruthy();
    });

    it('archiving a cancelled release preserves its cancelled status', () => {
      const created = service.createRelease(projectId, validInput({ status: 'cancelled' }));

      const archived = service.archiveRelease(created.id);
      expect(archived.status).toBe('cancelled');
      expect(archived.archived_at).toBeTruthy();
    });

    it('rejects status change for a published release even when other fields change', () => {
      const { release: created } = createPublishableRelease(service, assetRepo, projectId);
      const published = service.publishRelease(created.id);

      // Any change to status away from 'published' must be rejected, even
      // when the new title is otherwise valid.
      for (const newStatus of ['idea', 'planned', 'drafting', 'ready', 'cancelled']) {
        expect(() => {
          service.updateRelease(published.id, validInput({
            title: 'New Title',
            status: newStatus,
          }));
        }).toThrow(ReleaseValidationError);
      }
    });

    it('rejects status change for a cancelled release even when other fields change', () => {
      const created = service.createRelease(projectId, validInput({ status: 'cancelled' }));

      for (const newStatus of ['idea', 'planned', 'drafting', 'ready', 'published']) {
        expect(() => {
          service.updateRelease(created.id, validInput({
            title: 'New Title',
            status: newStatus,
          }));
        }).toThrow(ReleaseValidationError);
      }
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

    it('overrides a previously-set published_date with the explicit publish date', () => {
      const { release: created } = createPublishableRelease(service, assetRepo, projectId);
      service.updateRelease(created.id, validInput({
        status: 'ready',
        publishedDate: '2025-08-20',
      }));

      const published = service.publishRelease(created.id, '2025-09-30');
      expect(published.published_date).toBe('2025-09-30');
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
});
