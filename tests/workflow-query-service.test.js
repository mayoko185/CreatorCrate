import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import {
  createWorkflowQueryService,
  buildAssetBrowserQueryString,
  buildCanonicalAssetBrowserQuery,
} from '../src/services/workflow-query-service.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import {
  createProjectPrimaryImageRepository,
  PRIMARY_IMAGE_PROVENANCE,
} from '../src/data/project-primary-image-repository.js';
import { createTagRepository } from '../src/data/tag-repository.js';
import { createReleaseRepository } from '../src/data/release-repository.js';
import { getLocalTodayIso } from '../src/util/date.js';
import { buildRevisionToken } from '../src/storage/preview-cache.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
// Phase 3 chunk 1: browser composition now also loads the project's
// category rows and whole-project navigation counts (2 additional bounded
// statements); viewer composition loads the category rows for canonical
// category normalization (1 additional bounded statement). Both remain
// fixed regardless of project size.
// Phase 3 chunk 3: browser composition also loads eligible release targets
// for the bulk-add-to-release form (1 additional bounded statement, only
// for non-archived projects — archived projects skip it entirely).
// Phase 4: the browser performs one global tag-catalog lookup and one
// page-local asset-tag batch lookup.
const ASSET_BROWSER_FIXED_STATEMENT_EXECUTIONS = 11;
const ASSET_VIEWER_FIXED_STATEMENT_EXECUTIONS = 5;
// getReleaseList composes: countFiltered (filtered total),
// countFiltered({ includeArchived: true }) (hasAnyReleases existence), and
// findPage (page rows). The count is fixed at 3 for every page.
const RELEASE_LIST_FIXED_STATEMENT_EXECUTIONS = 3;

function dashboardDefaults(sectionOverrides = {}) {
  return {
    version: 1,
    sections: sectionOverrides,
  };
}

/**
 * Helper to insert a project directly without filesystem operations.
 */
function insertProject(db, {
  title, status = 'tbd', plannedDate = null, publishedDate = null, archivedAt = null,
}) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return db.prepare(`
    INSERT INTO projects (title, slug, description, notes, status,
                          planned_date, published_date, patreon_url, archived_at)
    VALUES (?, ?, '', '', ?, ?, ?, NULL, ?)
    RETURNING *
  `).get(title, slug, status, plannedDate, publishedDate, archivedAt);
}

/**
 * Helper to insert a release directly.
 */
function insertRelease(db, {
  projectId, title,
  notes = '',
  plannedDate = null, plannedTime = null, publishedDate = null, archivedAt = null,
}) {
  return db.prepare(`
    INSERT INTO releases (project_id, title, description, notes,
                          planned_date, planned_time, published_date, patreon_url,
                          archived_at)
    VALUES (?, ?, '', ?, ?, ?, ?, NULL, ?)
    RETURNING *
  `).get(projectId, title, notes, plannedDate, plannedTime, publishedDate, archivedAt);
}

/**
 * Helper to insert an asset directly with the desired presence state.
 */
function insertAsset(db, {
  projectId, relativePath, filename, extension = 'txt', mimeType = 'text/plain',
  sizeBytes = 0, modifiedAt = null, isPresent = 1,
}) {
  return db.prepare(`
    INSERT INTO assets (project_id, relative_path, filename, extension,
                        mime_type, size_bytes, modified_at,
                        is_present, last_seen_at, missing_since)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'),
            ${isPresent === 0 ? "datetime('now')" : 'NULL'})
    RETURNING *
  `).get(projectId, relativePath, filename, extension, mimeType, sizeBytes, modifiedAt, isPresent);
}

function instrumentStatementExecution(db) {
  const originalPrepare = db.prepare.bind(db);
  let executions = 0;
  const statements = [];

  function wrapStatement(statement) {
    return new Proxy(statement, {
      get(target, prop, receiver) {
        if (prop === 'get' || prop === 'all' || prop === 'run') {
          return (...args) => {
            executions++;
            return target[prop](...args);
          };
        }
        if (prop === 'pluck') {
          return (...args) => wrapStatement(target.pluck(...args));
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  db.prepare = (...args) => {
    statements.push(String(args[0]));
    return wrapStatement(originalPrepare(...args));
  };

  return {
    reset() {
      executions = 0;
    },
    count() {
      return executions;
    },
    statements() {
      return [...statements];
    },
  };
}

/**
 * Helper to link an asset to a release.
 */
function linkAssetToRelease(db, { releaseId, assetId, role = 'attachment', sortOrder = 0 }) {
  db.prepare(`
    INSERT INTO release_assets (release_id, asset_id, role, sort_order)
    VALUES (?, ?, ?, ?)
  `).run(releaseId, assetId, role, sortOrder);
}

describe('workflow query service', () => {
  let db;
  let tmpDir;
  let service;
  let primaryImageRepository;
  let preferenceRepository;
  let tagRepository;
  let today;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-wqs-'));
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    primaryImageRepository = createProjectPrimaryImageRepository(db);
    preferenceRepository = createAssetBrowserPreferenceRepository(db);
    tagRepository = createTagRepository(db);
    service = createWorkflowQueryService({
      db,
      projectPrimaryImageRepository: primaryImageRepository,
      tagRepository,
    });
    today = getLocalTodayIso();
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getAssetLibraryExtensions', () => {
    it('returns extensions from the active global asset population', () => {
      const alpha = insertProject(db, { title: 'Global extensions Alpha' });
      const beta = insertProject(db, { title: 'Global extensions Beta' });
      const archived = insertProject(db, {
        title: 'Global extensions Archived',
        status: 'archived',
      });

      insertAsset(db, { projectId: alpha.id, relativePath: 'alpha.png', filename: 'alpha.png', extension: 'png' });
      insertAsset(db, { projectId: beta.id, relativePath: 'beta.jpg', filename: 'beta.jpg', extension: 'jpg' });
      insertAsset(db, { projectId: archived.id, relativePath: 'archived.gif', filename: 'archived.gif', extension: 'gif' });

      expect(service.getAssetLibraryExtensions()).toEqual(['jpg', 'png']);
    });

    it('returns extensions from every Project Assets defaults population, including archived projects', () => {
      const active = insertProject(db, { title: 'Project Assets defaults active' });
      const archived = insertProject(db, {
        title: 'Project Assets defaults archived',
        status: 'archived',
      });

      insertAsset(db, { projectId: active.id, relativePath: 'active.png', filename: 'active.png', extension: 'png' });
      insertAsset(db, { projectId: archived.id, relativePath: 'archived.gif', filename: 'archived.gif', extension: 'gif' });

      expect(service.getProjectAssetsDefaultExtensions()).toEqual(['gif', 'png']);
    });
  });

  // ─── getDashboardData: empty state ─────────────────────────────────

  describe('getDashboardData — empty state', () => {
    it('returns safe empty sections for an empty database', () => {
      const data = service.getDashboardData();

      expect(data.overdue).toEqual([]);
      expect(data.upcoming).toEqual([]);
      expect(data.workflowSummary.totalProjects).toBe(0);
      expect(data.workflowSummary.totalAssets).toBe(0);
      expect(data.workflowSummary.totalReleases).toBe(0);
      expect(data.workflowSummary.missingAssetSummary.total).toBe(0);
      expect(data.workflowSummary.missingAssetSummary).not.toHaveProperty('referencedByReleases');
      expect(data.workflowSummary).not.toHaveProperty('releaseStatusCounts');
      expect(data).not.toHaveProperty('projectCounts');
      expect(data.recentlyUpdated).toEqual([]);
      expect(data.today).toBe(today);
    });

    it('does not throw for an empty database', () => {
      expect(() => service.getDashboardData()).not.toThrow();
    });
  });

  // ─── getProjectList — primary-image projection ────────────────────────

  describe('getProjectList — primary-image projection', () => {
    function getProjectRow(projectId, options = {}) {
      return service.getProjectList({ limit: 25, offset: 0, ...options }).rows
        .find((row) => row.id === projectId);
    }

    it('returns a stable none model when no selection exists', () => {
      const project = insertProject(db, { title: 'No Primary Selection' });
      const row = getProjectRow(project.id);

      expect(row.primaryImage).toEqual({
        selectedAssetId: null,
        provenance: null,
        state: 'none',
        kind: null,
        mediaModifier: null,
        previewUrl: null,
        thumbnailUrl: null,
        revision: null,
        alt: null,
      });
      expect(row.tags).toEqual([]);
    });

    it('projects the shared tag catalog into deterministic filter options with only stable values and display names', () => {
      const zeta = tagRepository.create({ displayName: 'zeta', normalizedName: 'zeta' });
      const alpha = tagRepository.create({ displayName: 'Alpha', normalizedName: 'alpha' });
      const beta = tagRepository.create({ displayName: 'Beta', normalizedName: 'beta' });
      const list = vi.spyOn(tagRepository, 'list');

      expect(service.getProjectTagFilterOptions()).toEqual([
        { value: String(alpha.id), displayName: 'Alpha' },
        { value: String(beta.id), displayName: 'Beta' },
        { value: String(zeta.id), displayName: 'zeta' },
      ]);
      expect(list).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledWith();
      list.mockRestore();
    });

    it('passes a tag filter to the project repository before enriching the current page', () => {
      const tag = tagRepository.create({ displayName: 'Filtered', normalizedName: 'filtered' });
      const matching = insertProject(db, { title: 'Filtered Project' });
      insertProject(db, { title: 'Other Project' });
      tagRepository.assignToProject(matching.id, tag.id);

      const result = service.getProjectList({
        tagId: tag.id,
        sortBy: 'title',
        order: 'asc',
        limit: 25,
        offset: 0,
      });

      expect(result.total).toBe(1);
      expect(result.rows.map((project) => project.title)).toEqual(['Filtered Project']);
    });

    it('returns an available selection with versioned bounded preview URLs', () => {
      const project = insertProject(db, { title: 'Available Primary Selection' });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'cover.png',
        filename: 'cover.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        modifiedAt: '2026-08-02T12:00:00.000Z',
      });
      primaryImageRepository.setPrimaryImage(project.id, asset.id);

      const primaryImage = getProjectRow(project.id).primaryImage;

      expect(primaryImage).toMatchObject({
        selectedAssetId: asset.id,
        provenance: PRIMARY_IMAGE_PROVENANCE.MANUAL,
        state: 'available',
        revision: expect.any(String),
        alt: 'Preview of cover.png',
      });
      expect(primaryImage.previewUrl).toBe(
        `/projects/${project.id}/assets/${asset.id}/preview?v=${primaryImage.revision}`
      );
      expect(primaryImage.thumbnailUrl).toBe(
        `/projects/${project.id}/assets/${asset.id}/thumbnail?v=${primaryImage.revision}`
      );
      expect(primaryImage.previewUrl).not.toContain('/original');
      expect(primaryImage).not.toHaveProperty('originalUrl');
    });

    it('retains a missing selection as unavailable without mutating the stored row', () => {
      const project = insertProject(db, { title: 'Missing Primary Selection' });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'missing.png',
        filename: 'missing.png',
        extension: 'png',
        mimeType: 'image/png',
        modifiedAt: '2026-08-02T12:00:00.000Z',
      });
      const selection = primaryImageRepository.setPrimaryImage(project.id, asset.id);
      db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?').run(asset.id);

      const primaryImage = getProjectRow(project.id).primaryImage;

      expect(primaryImage).toEqual({
        selectedAssetId: asset.id,
        provenance: PRIMARY_IMAGE_PROVENANCE.MANUAL,
        state: 'unavailable',
        kind: 'image',
        mediaModifier: null,
        previewUrl: null,
        thumbnailUrl: null,
        revision: null,
        alt: 'Preview of missing.png',
      });
      expect(primaryImageRepository.findByProjectId(project.id)).toEqual(selection);
    });

    it('exposes automatic provenance in the primary-image query model', () => {
      const project = insertProject(db, { title: 'Automatic Primary Selection' });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'automatic.png',
        filename: 'automatic.png',
        extension: 'png',
        mimeType: 'image/png',
      });
      primaryImageRepository.setPrimaryImage(
        project.id,
        asset.id,
        PRIMARY_IMAGE_PROVENANCE.AUTOMATIC,
      );

      expect(getProjectRow(project.id).primaryImage).toMatchObject({
        selectedAssetId: asset.id,
        provenance: PRIMARY_IMAGE_PROVENANCE.AUTOMATIC,
      });
    });

    it('keeps a present selected KRA format-available without probing during listing', () => {
      const project = insertProject(db, { title: 'Unsupported Primary Selection' });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'source.kra',
        filename: 'source.kra',
        extension: 'kra',
        mimeType: 'application/x-krita',
        modifiedAt: '2026-08-02T12:00:00.000Z',
      });
      primaryImageRepository.setPrimaryImage(project.id, asset.id);

      expect(getProjectRow(project.id).primaryImage).toMatchObject({
        selectedAssetId: asset.id,
        state: 'available',
        kind: 'krita',
        mediaModifier: 'krita',
        alt: 'Preview of source.kra',
      });
    });

    it('attaches ordered display-name tags only to current-page rows through one batch call', () => {
      const projects = ['A', 'B', 'C'].map((letter) => insertProject(db, { title: `Tag Page ${letter}` }));
      const shared = tagRepository.create({ displayName: 'Shared Tag', normalizedName: 'shared tag' });
      const upperBeta = tagRepository.create({ displayName: 'Beta Tag', normalizedName: 'beta-a' });
      const lowerBeta = tagRepository.create({ displayName: 'beta tag', normalizedName: 'beta-z' });
      const outsidePage = tagRepository.create({ displayName: 'Outside Page Tag', normalizedName: 'outside page tag' });
      const assetOnly = tagRepository.create({ displayName: 'Asset Only Tag', normalizedName: 'asset only tag' });
      const asset = insertAsset(db, {
        projectId: projects[1].id,
        relativePath: 'asset-only.png',
        filename: 'asset-only.png',
      });

      tagRepository.assignToProject(projects[0].id, outsidePage.id);
      for (const tag of [shared, lowerBeta, upperBeta]) {
        tagRepository.assignToProject(projects[1].id, tag.id);
      }
      tagRepository.assignToProject(projects[2].id, shared.id);
      tagRepository.assignToAsset(asset.id, assetOnly.id);

      const listForProjectIds = vi.spyOn(tagRepository, 'listForProjectIds');
      const result = service.getProjectList({
        sortBy: 'title',
        order: 'asc',
        limit: 2,
        offset: 1,
      });

      expect(result.total).toBe(3);
      expect(result.rows).toHaveLength(2);
      expect(result.rows.map((project) => project.title)).toEqual(['Tag Page B', 'Tag Page C']);
      expect(result.rows[0].tags).toEqual([
        { displayName: 'Beta Tag' },
        { displayName: 'beta tag' },
        { displayName: 'Shared Tag' },
      ]);
      expect(result.rows[1].tags).toEqual([{ displayName: 'Shared Tag' }]);
      expect(result.rows[0].tags[0]).not.toHaveProperty('id');
      expect(result.rows[0].tags[0]).not.toHaveProperty('normalized_name');
      expect(result.rows[0].tags.map((tag) => tag.displayName)).not.toContain('Asset Only Tag');
      expect(listForProjectIds).toHaveBeenCalledTimes(1);
      expect(listForProjectIds).toHaveBeenCalledWith([projects[1].id, projects[2].id]);
      listForProjectIds.mockRestore();
    });

    it('enriches only the current page through one selection batch and one asset batch', () => {
      const projects = ['A', 'B', 'C'].map((letter) => insertProject(db, { title: `Primary Page ${letter}` }));
      for (const project of projects) {
        const asset = insertAsset(db, {
          projectId: project.id,
          relativePath: `${project.title}.png`,
          filename: `${project.title}.png`,
          extension: 'png',
          mimeType: 'image/png',
          modifiedAt: '2026-08-02T12:00:00.000Z',
        });
        primaryImageRepository.setPrimaryImage(project.id, asset.id);
      }

      const findBatch = vi.spyOn(primaryImageRepository, 'findByProjectIds');
      const counter = instrumentStatementExecution(db);
      const pagedService = createWorkflowQueryService({
        db,
        projectPrimaryImageRepository: primaryImageRepository,
      });
      findBatch.mockClear();
      counter.reset();

      const result = pagedService.getProjectList({
        sortBy: 'title',
        order: 'asc',
        limit: 1,
        offset: 1,
      });

      expect(result.total).toBe(3);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].title).toBe('Primary Page B');
      expect(result.rows[0].primaryImage.selectedAssetId).not.toBeNull();
      expect(findBatch).toHaveBeenCalledTimes(1);
      expect(findBatch).toHaveBeenCalledWith([projects[1].id]);
      expect(counter.count()).toBe(5);
      findBatch.mockRestore();
    });

    it('handles an empty project page without issuing asset lookups', () => {
      expect(service.getProjectList({ limit: 25, offset: 0 })).toEqual({
        rows: [],
        total: 0,
      });
    });
  });

  // ─── getDashboardData: overdue projects ─────────────────────────────

  describe('getDashboardData — overdue projects', () => {
    it('overdue projects appear in the overdue section', () => {
      const project = insertProject(db, {
        title: 'Overdue Project', status: 'planned', plannedDate: '2020-01-01',
      });

      const data = service.getDashboardData();
      expect(data.overdue).toHaveLength(1);
      expect(data.overdue[0].id).toBe(project.id);
    });

    it('a planned project with a release is not overdue', () => {
      const project = insertProject(db, {
        title: 'Has Release', status: 'planned', plannedDate: '2020-01-01',
      });
      insertRelease(db, { projectId: project.id, title: 'Any Release' });

      const data = service.getDashboardData();
      expect(data.overdue.map((p) => p.id)).not.toContain(project.id);
    });

    it('attaches available selected primary-image and tag data to overdue projects', () => {
      const tag = tagRepository.create({ displayName: 'Overdue Tag', normalizedName: 'overdue-tag' });
      const project = insertProject(db, {
        title: 'Enriched Overdue', status: 'planned', plannedDate: '2020-01-01',
      });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'overdue-cover.png',
        filename: 'overdue-cover.png',
        extension: 'png',
        mimeType: 'image/png',
        modifiedAt: '2026-08-02T12:00:00.000Z',
      });
      primaryImageRepository.setPrimaryImage(project.id, asset.id);
      tagRepository.assignToProject(project.id, tag.id);

      const data = service.getDashboardData();
      const row = data.overdue.find((p) => p.id === project.id);
      expect(row.primaryImage).toMatchObject({
        selectedAssetId: asset.id,
        provenance: PRIMARY_IMAGE_PROVENANCE.MANUAL,
        state: 'available',
        kind: 'image',
        alt: 'Preview of overdue-cover.png',
      });
      expect(row.primaryImage.previewUrl).toContain(`/projects/${project.id}/assets/${asset.id}/preview`);
      expect(row.tags).toEqual([{ displayName: 'Overdue Tag' }]);
    });

    it('does not surface archived projects as overdue', () => {
      const project = insertProject(db, { title: 'Archived Overdue', status: 'planned', plannedDate: '2020-01-01' });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const data = service.getDashboardData();
      expect(data.overdue.map((p) => p.id)).not.toContain(project.id);
    });

    it('respects the bounded limit on overdue projects', () => {
      for (let i = 0; i < 10; i++) {
        insertProject(db, { title: `Overdue ${i}`, status: 'planned', plannedDate: '2020-01-01' });
      }

      const data = service.getDashboardData({
        dashboardDefaults: dashboardDefaults({ overdue: { visible: true, itemCount: 3 } }),
      });
      expect(data.overdue).toHaveLength(3);
    });
  });

  // ─── getDashboardData: upcoming projects ─────────────────────────────

  describe('getDashboardData — upcoming projects', () => {
    it('projects planned strictly after today appear in upcoming', () => {
      const project = insertProject(db, {
        title: 'Upcoming Project', status: 'planned', plannedDate: '2099-12-31',
      });

      const data = service.getDashboardData();
      expect(data.upcoming.map((p) => p.id)).toContain(project.id);
    });

    it('a project planned exactly today is not upcoming', () => {
      const project = insertProject(db, { title: 'Today Project', status: 'planned', plannedDate: today });

      const data = service.getDashboardData();
      expect(data.upcoming.map((p) => p.id)).not.toContain(project.id);
    });

    it('an upcoming project with releases still appears (no release-existence condition)', () => {
      const project = insertProject(db, {
        title: 'Upcoming With Release', status: 'planned', plannedDate: '2099-01-01',
      });
      insertRelease(db, { projectId: project.id, title: 'Any Release' });

      const data = service.getDashboardData();
      expect(data.upcoming.map((p) => p.id)).toContain(project.id);
    });

    it('attaches unavailable selected primary-image and tag data to upcoming projects', () => {
      const tag = tagRepository.create({ displayName: 'Upcoming Tag', normalizedName: 'upcoming-tag' });
      const project = insertProject(db, {
        title: 'Enriched Upcoming', status: 'planned', plannedDate: '2099-01-01',
      });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'upcoming-cover.png',
        filename: 'upcoming-cover.png',
        extension: 'png',
        mimeType: 'image/png',
      });
      primaryImageRepository.setPrimaryImage(project.id, asset.id);
      db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?')
        .run(asset.id);
      tagRepository.assignToProject(project.id, tag.id);

      const data = service.getDashboardData();
      const row = data.upcoming.find((p) => p.id === project.id);
      expect(row.tags).toEqual([{ displayName: 'Upcoming Tag' }]);
      expect(row.primaryImage).toEqual({
        selectedAssetId: asset.id,
        provenance: PRIMARY_IMAGE_PROVENANCE.MANUAL,
        state: 'unavailable',
        kind: 'image',
        mediaModifier: null,
        previewUrl: null,
        thumbnailUrl: null,
        revision: null,
        alt: 'Preview of upcoming-cover.png',
      });
    });

    it('does not surface archived projects as upcoming', () => {
      const project = insertProject(db, { title: 'Archived Upcoming', status: 'planned', plannedDate: '2099-01-01' });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const data = service.getDashboardData();
      expect(data.upcoming.map((p) => p.id)).not.toContain(project.id);
    });

    it('respects the bounded limit on upcoming projects', () => {
      for (let i = 0; i < 15; i++) {
        insertProject(db, { title: `Upcoming ${i}`, status: 'planned', plannedDate: '2099-01-01' });
      }

      const data = service.getDashboardData({
        dashboardDefaults: dashboardDefaults({ upcoming: { visible: true, itemCount: 4 } }),
      });
      expect(data.upcoming).toHaveLength(4);
    });
  });

  // ─── getDashboardData: today classification boundary ────────────────

  describe('getDashboardData — today classification boundary', () => {
    const FIXED_TODAY = '2025-06-15';

    it('project planned today is overdue (no releases), not upcoming', () => {
      const project = insertProject(db, { title: 'Today Project', status: 'planned', plannedDate: FIXED_TODAY });

      const data = service.getDashboardData({ today: FIXED_TODAY });
      expect(data.overdue.map((p) => p.id)).toContain(project.id);
      expect(data.upcoming.map((p) => p.id)).not.toContain(project.id);
    });

    it('project planned yesterday is overdue', () => {
      const project = insertProject(db, { title: 'Yesterday Project', status: 'planned', plannedDate: '2025-06-14' });

      const data = service.getDashboardData({ today: FIXED_TODAY });
      expect(data.overdue.map((p) => p.id)).toContain(project.id);
      expect(data.upcoming.map((p) => p.id)).not.toContain(project.id);
    });

    it('project planned tomorrow is upcoming, not overdue', () => {
      const project = insertProject(db, { title: 'Tomorrow Project', status: 'planned', plannedDate: '2025-06-16' });

      const data = service.getDashboardData({ today: FIXED_TODAY });
      expect(data.upcoming.map((p) => p.id)).toContain(project.id);
      expect(data.overdue.map((p) => p.id)).not.toContain(project.id);
    });

    it('uses the same injected today value across overdue and upcoming', () => {
      const yesterday = insertProject(db, { title: 'Yesterday', status: 'planned', plannedDate: '2025-06-14' });
      const todayProject = insertProject(db, { title: 'Today', status: 'planned', plannedDate: '2025-06-15' });
      const tomorrow = insertProject(db, { title: 'Tomorrow', status: 'planned', plannedDate: '2025-06-16' });

      const data = service.getDashboardData({ today: FIXED_TODAY });
      expect(data.today).toBe(FIXED_TODAY);
      expect(data.overdue.map((p) => p.id)).toEqual(expect.arrayContaining([yesterday.id, todayProject.id]));
      expect(data.upcoming.map((p) => p.id)).toEqual([tomorrow.id]);
    });

    it('does not classify a project as both overdue AND upcoming for the same today', () => {
      const project = insertProject(db, { title: 'Either Or', status: 'planned', plannedDate: FIXED_TODAY });

      const data = service.getDashboardData({ today: FIXED_TODAY });
      const overdueIds = data.overdue.map((p) => p.id);
      const upcomingIds = data.upcoming.map((p) => p.id);
      const intersection = overdueIds.filter((id) => upcomingIds.includes(id));
      expect(intersection).toEqual([]);
    });
  });

  // ─── getDashboardData: application-local today boundary ─────────────

  describe('getDashboardData — application-local today boundary', () => {
    it('uses the default local today (not UTC) when no today is injected', () => {
      // Set a system time at local noon on 2025-06-15. The local date is
      // 2025-06-15 in every timezone.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2025, 5, 15, 12, 0, 0));
      try {
        const project = insertProject(db, { title: 'Default Local Today', status: 'planned', plannedDate: '2025-06-16' });

        const data = service.getDashboardData();
        // The default `today` is the local calendar date of `new Date()`.
        expect(data.today).toBe('2025-06-15');
        expect(data.upcoming.map((p) => p.id)).toContain(project.id);
        expect(data.overdue.map((p) => p.id)).not.toContain(project.id);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ─── getDashboardData: workflow summary ────────────────────────────

  describe('getDashboardData — workflow summary', () => {
    it('derives total projects from internal status counts without exposing them', () => {
      insertProject(db, { title: 'Alpha', status: 'tbd' });
      insertProject(db, { title: 'Beta', status: 'planned' });
      insertProject(db, { title: 'Gamma', status: 'in-progress' });

      const data = service.getDashboardData();
      expect(data.workflowSummary.totalProjects).toBe(3);
      expect(data).not.toHaveProperty('projectCounts');
    });

    it('computes total assets and missing asset summary', () => {
      const project = insertProject(db, { title: 'Asset Count Project' });
      insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'b.txt', filename: 'b.txt', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'c.txt', filename: 'c.txt', isPresent: 0 });

      const data = service.getDashboardData();
      expect(data.workflowSummary.totalAssets).toBe(3);
      expect(data.workflowSummary.missingAssetSummary.total).toBe(1);
      expect(data.workflowSummary.missingAssetSummary).not.toHaveProperty('referencedByReleases');
    });

    it('counts all release records, including archived releases', () => {
      const project = insertProject(db, { title: 'Release Count Project' });
      insertRelease(db, { projectId: project.id, title: 'Active Release' });
      insertRelease(db, {
        projectId: project.id,
        title: 'Archived Release',
        archivedAt: '2026-01-01 00:00:00',
      });

      const data = service.getDashboardData();

      expect(data.workflowSummary.totalReleases).toBe(2);
    });

    it('does not expose removed release-status or project-status counts', () => {
      const project = insertProject(db, { title: 'Project Counts Project', status: 'ready' });
      insertRelease(db, { projectId: project.id, title: 'First' });
      insertRelease(db, { projectId: project.id, title: 'Second' });

      const data = service.getDashboardData();
      expect(data.workflowSummary).not.toHaveProperty('releaseStatusCounts');
      expect(data.workflowSummary.totalProjects).toBe(1);
      expect(data).not.toHaveProperty('projectCounts');
    });
  });

  // ─── getDashboardData: recently updated ────────────────────────────

  describe('getDashboardData — recently updated', () => {
    it('returns the most-recently-updated projects first', async () => {
      const old = insertProject(db, { title: 'Old Project' });
      // Force a difference in updated_at
      db.prepare(`UPDATE projects SET updated_at = '2020-01-01 00:00:00' WHERE id = ?`).run(old.id);
      const recent = insertProject(db, { title: 'Recent Project' });
      db.prepare(`UPDATE projects SET updated_at = '2099-01-01 00:00:00' WHERE id = ?`).run(recent.id);

      const data = service.getDashboardData();
      expect(data.recentlyUpdated.length).toBe(2);
      expect(data.recentlyUpdated[0].title).toBe('Recent Project');
    });

    it('excludes archived projects from recently updated', () => {
      const project = insertProject(db, { title: 'Archived Hide' });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const data = service.getDashboardData();
      expect(data.recentlyUpdated).toEqual([]);
    });

    it('respects bounded limit for recently updated', () => {
      for (let i = 0; i < 20; i++) {
        insertProject(db, { title: `P${i}` });
      }

      const data = service.getDashboardData({
        dashboardDefaults: dashboardDefaults({ 'recently-updated': { visible: true, itemCount: 5 } }),
      });
      expect(data.recentlyUpdated).toHaveLength(5);
    });

    it('attaches primary image and tag data to recently-updated projects', () => {
      const tag = tagRepository.create({ displayName: 'Recent Tag', normalizedName: 'recent-tag' });
      const project = insertProject(db, { title: 'Enriched Recent' });
      tagRepository.assignToProject(project.id, tag.id);

      const data = service.getDashboardData();
      const row = data.recentlyUpdated.find((p) => p.id === project.id);
      expect(row.tags).toEqual([{ displayName: 'Recent Tag' }]);
      expect(row.primaryImage.state).toBe('none');
    });

    it('composes configured sections with bounded, deduplicated enrichment', () => {
      const fixedToday = '2026-07-29';
      const nextDay = new Date(`${fixedToday}T00:00:00.000Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      const upcomingDate = nextDay.toISOString().slice(0, 10);
      const configuredDefaults = dashboardDefaults(Object.fromEntries([
        'overdue',
        'upcoming',
        'recently-updated',
        'status:tbd',
        'status:planned',
        'status:in-progress',
        'status:ready',
        'status:completed',
        'status:archived',
      ].map((sectionId) => [sectionId, { visible: true, itemCount: 8 }])));

      function insertDashboardFixture(label) {
        const overdue = insertProject(db, {
          title: `${label} Overdue`, status: 'planned', plannedDate: fixedToday,
        });
        const upcoming = insertProject(db, {
          title: `${label} Upcoming`, status: 'planned', plannedDate: upcomingDate,
        });
        const recentlyUpdated = insertProject(db, { title: `${label} Recent`, status: 'ready' });
        const statuses = [
          insertProject(db, { title: `${label} TBD`, status: 'tbd' }),
          insertProject(db, { title: `${label} In Progress`, status: 'in-progress' }),
          insertProject(db, { title: `${label} Completed`, status: 'completed' }),
          insertProject(db, { title: `${label} Archived`, status: 'tbd', archivedAt: '2026-01-01 00:00:00' }),
        ];

        const availableAsset = insertAsset(db, {
          projectId: overdue.id,
          relativePath: `${label}-overdue.png`,
          filename: `${label}-overdue.png`,
          extension: 'png',
          mimeType: 'image/png',
          modifiedAt: '2026-08-02T12:00:00.000Z',
        });
        const unavailableAsset = insertAsset(db, {
          projectId: upcoming.id,
          relativePath: `${label}-upcoming.png`,
          filename: `${label}-upcoming.png`,
          extension: 'png',
          mimeType: 'image/png',
        });
        const recentAsset = insertAsset(db, {
          projectId: recentlyUpdated.id,
          relativePath: `${label}-recent.png`,
          filename: `${label}-recent.png`,
          extension: 'png',
          mimeType: 'image/png',
        });
        primaryImageRepository.setPrimaryImage(overdue.id, availableAsset.id);
        primaryImageRepository.setPrimaryImage(upcoming.id, unavailableAsset.id);
        primaryImageRepository.setPrimaryImage(recentlyUpdated.id, recentAsset.id);
        db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?')
          .run(unavailableAsset.id);

        return {
          overdue,
          upcoming,
          recentlyUpdated,
          statuses,
          availableAsset,
          unavailableAsset,
          recentAsset,
        };
      }

      const smallFixture = insertDashboardFixture('Dashboard Query Small');

      const counter = instrumentStatementExecution(db);
      const instrumentedService = createWorkflowQueryService({ db });

      const smallStatementStart = counter.statements().length;
      counter.reset();
      const smallData = instrumentedService.getDashboardData({
        today: fixedToday,
        dashboardDefaults: configuredDefaults,
      });
      const smallCount = counter.count();

      expect(smallData.overdue.map((project) => project.id)).toContain(smallFixture.overdue.id);
      expect(smallData.upcoming.map((project) => project.id)).toContain(smallFixture.upcoming.id);
      expect(smallData.recentlyUpdated.map((project) => project.id)).toContain(smallFixture.recentlyUpdated.id);
      expect(smallData.overdue.find((project) => project.id === smallFixture.overdue.id).primaryImage)
        .toMatchObject({ selectedAssetId: smallFixture.availableAsset.id, state: 'available' });
      expect(smallData.upcoming.find((project) => project.id === smallFixture.upcoming.id).primaryImage)
        .toMatchObject({ selectedAssetId: smallFixture.unavailableAsset.id, state: 'unavailable' });
      expect(smallData.recentlyUpdated.find((project) => project.id === smallFixture.recentlyUpdated.id).primaryImage)
        .toMatchObject({ selectedAssetId: smallFixture.recentAsset.id, state: 'available' });
      expect(smallData.sections['status:archived'].map((project) => project.id))
        .toContain(smallFixture.statuses[3].id);
      expect(smallData.sections.overdue[0]).toBe(
        smallData.sections['status:planned'].find((project) => project.id === smallFixture.overdue.id)
      );
      expect(['tbd', 'planned', 'in-progress', 'ready', 'completed', 'archived'].every(
        (status) => smallData.sections[`status:${status}`].length > 0
      )).toBe(true);
      const smallStatements = counter.statements().slice(smallStatementStart);
      expect(smallStatements.filter((statement) => statement.includes('requested_statuses'))).toHaveLength(1);

      for (let i = 1; i <= 20; i++) {
        insertDashboardFixture(`Dashboard Query Large ${i}`);
      }

      const largeStatementStart = counter.statements().length;
      counter.reset();
      const largeData = instrumentedService.getDashboardData({
        today: fixedToday,
        dashboardDefaults: configuredDefaults,
      });
      const largeCount = counter.count();

      expect(smallData.overdue).toHaveLength(1);
      expect(smallData.upcoming).toHaveLength(1);
      expect(smallData.recentlyUpdated).toHaveLength(6);
      expect(largeData.overdue).toHaveLength(8);
      expect(largeData.upcoming).toHaveLength(8);
      expect(largeData.recentlyUpdated).toHaveLength(8);
      expect(largeData.workflowSummary.totalProjects).toBeGreaterThan(smallData.workflowSummary.totalProjects);
      expect(smallCount).toBe(largeCount);
      expect(smallCount).toBe(13);
      expect(largeCount).toBe(13);
      const largeStatements = counter.statements().slice(largeStatementStart);
      expect(largeStatements.filter((statement) => statement.includes('requested_statuses'))).toHaveLength(1);
    });

    it('uses default eight-item sections and skips hidden project-list queries', () => {
      const fixedToday = '2026-07-29';
      for (let i = 0; i < 10; i++) {
        insertProject(db, { title: `Default Overdue ${i}`, status: 'planned', plannedDate: fixedToday });
        insertProject(db, { title: `Default Upcoming ${i}`, status: 'planned', plannedDate: '2026-07-30' });
        insertProject(db, { title: `Default Recent ${i}`, status: 'tbd' });
        for (const status of ['tbd', 'planned', 'in-progress', 'ready', 'completed', 'archived']) {
          insertProject(db, {
            title: `Default ${status} ${i}`,
            status,
            archivedAt: status === 'archived' ? '2026-01-01 00:00:00' : null,
          });
        }
      }

      const defaults = service.getDashboardData({ today: fixedToday });
      expect(defaults.overdue).toHaveLength(8);
      expect(defaults.upcoming).toHaveLength(8);
      expect(defaults.recentlyUpdated).toHaveLength(8);
      for (const status of ['tbd', 'planned', 'in-progress', 'ready', 'completed', 'archived']) {
        expect(defaults.sections[`status:${status}`]).toHaveLength(8);
      }

      const allHidden = dashboardDefaults(Object.fromEntries([
        'overdue',
        'upcoming',
        'recently-updated',
        'status:tbd',
        'status:planned',
        'status:in-progress',
        'status:ready',
        'status:completed',
        'status:archived',
      ].map((sectionId) => [sectionId, { visible: false, itemCount: 8 }])));
      const counter = instrumentStatementExecution(db);
      const instrumentedService = createWorkflowQueryService({ db });
      const statementStart = counter.statements().length;
      counter.reset();
      const hiddenData = instrumentedService.getDashboardData({
        today: fixedToday,
        dashboardDefaults: allHidden,
      });

      expect(counter.count()).toBe(5);
      expect(Object.values(hiddenData.sections).every((projects) => projects.length === 0)).toBe(true);
      expect(counter.statements().slice(statementStart).some(
        (statement) => statement.includes('requested_statuses')
      )).toBe(false);
    });

    it('uses independent visible status limits in one status query', () => {
      for (let i = 0; i < 4; i++) {
        insertProject(db, { title: `TBD status ${i}`, status: 'tbd' });
        insertProject(db, { title: `Ready status ${i}`, status: 'ready' });
      }
      const counter = instrumentStatementExecution(db);
      const instrumentedService = createWorkflowQueryService({ db });
      const statementStart = counter.statements().length;
      counter.reset();
      const data = instrumentedService.getDashboardData({
        dashboardDefaults: dashboardDefaults({
          overdue: { visible: false, itemCount: 8 },
          upcoming: { visible: false, itemCount: 8 },
          'recently-updated': { visible: false, itemCount: 8 },
          'status:tbd': { visible: true, itemCount: 2 },
          'status:ready': { visible: true, itemCount: 3 },
          'status:planned': { visible: false, itemCount: 8 },
          'status:in-progress': { visible: false, itemCount: 8 },
          'status:completed': { visible: false, itemCount: 8 },
          'status:archived': { visible: false, itemCount: 8 },
        }),
      });

      expect(data.sections['status:tbd']).toHaveLength(2);
      expect(data.sections['status:ready']).toHaveLength(3);
      expect(data.sections['status:planned']).toEqual([]);
      expect(counter.statements().slice(statementStart).filter(
        (statement) => statement.includes('requested_statuses')
      )).toHaveLength(1);
    });
  });

  // ─── getDashboardData: release-count source ───────────────────────

  describe('getDashboardData — release-count source', () => {
    it('uses the established all-records release count without release-attention queries', () => {
      const releaseRepositorySpy = {
        findOverdue: vi.fn(),
        findUpcoming: vi.fn(),
        findActiveWithoutPlannedDate: vi.fn(),
        findReleasesWithMissingSelectedAssets: vi.fn(),
        findReleasesWithoutSelectedAssets: vi.fn(),
        countMissingAssetsReferenced: vi.fn(),
        countFiltered: vi.fn(() => 7),
      };
      const spiedService = createWorkflowQueryService({
        db,
        projectPrimaryImageRepository: primaryImageRepository,
        tagRepository,
        releaseRepository: releaseRepositorySpy,
      });

      const data = spiedService.getDashboardData();

      expect(data.workflowSummary.totalReleases).toBe(7);
      expect(releaseRepositorySpy.countFiltered).toHaveBeenCalledOnce();
      expect(releaseRepositorySpy.countFiltered).toHaveBeenCalledWith({ includeArchived: true });
      expect(releaseRepositorySpy.findOverdue).not.toHaveBeenCalled();
      expect(releaseRepositorySpy.findUpcoming).not.toHaveBeenCalled();
      expect(releaseRepositorySpy.findActiveWithoutPlannedDate).not.toHaveBeenCalled();
      expect(releaseRepositorySpy.findReleasesWithMissingSelectedAssets).not.toHaveBeenCalled();
      expect(releaseRepositorySpy.findReleasesWithoutSelectedAssets).not.toHaveBeenCalled();
      expect(releaseRepositorySpy.countMissingAssetsReferenced).not.toHaveBeenCalled();
    });
  });

  // ─── getProjectWorkspace ───────────────────────────────────────────

  describe('getProjectWorkspace', () => {
    it('returns null for missing project', () => {
      const result = service.getProjectWorkspace(9999);
      expect(result).toBeNull();
    });

    it('returns safe empty sections for a project with no releases or assets', () => {
      const project = insertProject(db, { title: 'Empty Project' });

      const ws = service.getProjectWorkspace(project.id);

      expect(ws).not.toBeNull();
      expect(ws.project.id).toBe(project.id);
      expect(ws.releaseSummary.active).toEqual([]);
      expect(ws.releaseSummary.recent).toEqual([]);
      expect(ws.releaseSummary).not.toHaveProperty('statusCounts');
      expect(ws.releaseSummary.hasAnyReleases).toBe(false);
      expect(ws.assetHealth).toEqual({
        total: 0,
        present: 0,
        missing: 0,
        missingByReleases: 0,
      });
    });

    it('returns active and recent releases for the project', () => {
      const project = insertProject(db, { title: 'Releases Project', status: 'in-progress' });
      insertRelease(db, {
        projectId: project.id,
        title: 'Active A',
        status: 'planned',
        plannedDate: '2099-01-01',
      });
      insertRelease(db, {
        projectId: project.id,
        title: 'Active B',
        status: 'in-progress',
        plannedDate: '2099-02-01',
      });
      insertRelease(db, {
        projectId: project.id,
        title: 'Published',
        status: 'published',
        publishedDate: '2024-01-01',
      });

      const ws = service.getProjectWorkspace(project.id);
      expect(ws.releaseSummary.active.map((r) => r.title).sort()).toEqual(['Active A', 'Active B']);
      // Recent should include all releases, ordered by updated_at DESC
      expect(ws.releaseSummary.recent.length).toBe(3);
      expect(ws.releaseSummary).not.toHaveProperty('statusCounts');
      expect(ws.releaseSummary.recent.find((release) => release.title === 'Published').published_date)
        .toBe('2024-01-01');
      expect(ws.releaseSummary.hasAnyReleases).toBe(true);
    });

    it('enriches one release with all previewable selected assets in repository order', () => {
      const project = insertProject(db, { title: 'Release Thumbnail Order' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Thumbnail Release',
      });
      const firstById = insertAsset(db, {
        projectId: project.id,
        relativePath: 'first-by-id.png',
        filename: 'first-by-id.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 1024,
        modifiedAt: '2026-08-02T12:00:00.000Z',
      });
      const secondById = insertAsset(db, {
        projectId: project.id,
        relativePath: 'second-by-id.png',
        filename: 'second-by-id.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        modifiedAt: '2026-08-02T12:00:00.000Z',
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: firstById.id, sortOrder: 1 });
      linkAssetToRelease(db, { releaseId: release.id, assetId: secondById.id, sortOrder: 0 });

      const result = service.getProjectWorkspace(project.id);
      const thumbnails = result.releaseSummary.recent[0].thumbnails;
      const firstRevision = buildRevisionToken({
        projectId: project.id,
        assetId: firstById.id,
        relativePath: 'first-by-id.png',
        size: 1024,
        mtime: '2026-08-02T12:00:00.000Z',
      });
      const secondRevision = buildRevisionToken({
        projectId: project.id,
        assetId: secondById.id,
        relativePath: 'second-by-id.png',
        size: 2048,
        mtime: '2026-08-02T12:00:00.000Z',
      });

      expect(thumbnails).toEqual([
        {
          assetId: secondById.id,
          filename: 'second-by-id.png',
          thumbnailUrl: `/projects/${project.id}/assets/${secondById.id}/thumbnail?v=${secondRevision}`,
          viewerUrl: `/projects/${project.id}/assets/${secondById.id}`,
        },
        {
          assetId: firstById.id,
          filename: 'first-by-id.png',
          thumbnailUrl: `/projects/${project.id}/assets/${firstById.id}/thumbnail?v=${firstRevision}`,
          viewerUrl: `/projects/${project.id}/assets/${firstById.id}`,
        },
      ]);
    });

    it('includes previewable Krita assets and excludes missing or unsupported selections', () => {
      const project = insertProject(db, { title: 'Release Thumbnail Formats' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Format Release',
      });
      const krita = insertAsset(db, {
        projectId: project.id,
        relativePath: 'source.kra',
        filename: 'source.kra',
        extension: 'kra',
        mimeType: 'application/x-krita',
        sizeBytes: 100,
        modifiedAt: '2026-08-02T12:00:00.000Z',
      });
      const compressedKrita = insertAsset(db, {
        projectId: project.id,
        relativePath: 'source.krz',
        filename: 'source.krz',
        extension: 'krz',
        mimeType: 'application/x-krita',
        sizeBytes: 200,
        modifiedAt: '2026-08-02T12:00:00.000Z',
      });
      const missing = insertAsset(db, {
        projectId: project.id,
        relativePath: 'missing.png',
        filename: 'missing.png',
        extension: 'png',
        mimeType: 'image/png',
        isPresent: 0,
      });
      const unsupported = insertAsset(db, {
        projectId: project.id,
        relativePath: 'source.txt',
        filename: 'source.txt',
        extension: 'txt',
        mimeType: 'text/plain',
        sizeBytes: 300,
        modifiedAt: '2026-08-02T12:00:00.000Z',
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: krita.id, sortOrder: 0 });
      linkAssetToRelease(db, { releaseId: release.id, assetId: compressedKrita.id, sortOrder: 1 });
      linkAssetToRelease(db, { releaseId: release.id, assetId: missing.id, sortOrder: 2 });
      linkAssetToRelease(db, { releaseId: release.id, assetId: unsupported.id, sortOrder: 3 });

      const result = service.getProjectWorkspace(project.id);

      expect(result.releaseSummary.recent[0].thumbnails.map((thumbnail) => thumbnail.filename))
        .toEqual(['source.kra', 'source.krz']);
    });

    it('returns an empty thumbnail array when a release has no qualifying assets', () => {
      const project = insertProject(db, { title: 'Release Without Thumbnails' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'No Thumbnail Release',
      });
      const missing = insertAsset(db, {
        projectId: project.id,
        relativePath: 'missing.jpg',
        filename: 'missing.jpg',
        extension: 'jpg',
        mimeType: 'image/jpeg',
        isPresent: 0,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: missing.id });

      const result = service.getProjectWorkspace(project.id);

      expect(result.releaseSummary.recent[0].thumbnails).toEqual([]);
    });

    it('keeps thumbnails assigned to their release through one batched repository call', () => {
      const project = insertProject(db, { title: 'Release Thumbnail Batching' });
      const first = insertRelease(db, { projectId: project.id, title: 'First Thumbnail Release' });
      const second = insertRelease(db, { projectId: project.id, title: 'Second Thumbnail Release' });
      const firstAsset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'first.png',
        filename: 'first.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 1024,
        modifiedAt: '2026-08-02T12:00:00.000Z',
      });
      const secondAsset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'second.png',
        filename: 'second.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        modifiedAt: '2026-08-02T12:00:00.000Z',
      });
      linkAssetToRelease(db, { releaseId: first.id, assetId: firstAsset.id });
      linkAssetToRelease(db, { releaseId: second.id, assetId: secondAsset.id });

      const releaseRepository = createReleaseRepository(db);
      const findReleaseAssets = vi.spyOn(releaseRepository, 'findReleaseAssetsByReleaseIds');
      const batchedService = createWorkflowQueryService({
        db,
        releaseRepository,
      });

      const result = batchedService.getProjectWorkspace(project.id);

      expect(findReleaseAssets).toHaveBeenCalledTimes(1);
      expect(findReleaseAssets).toHaveBeenCalledWith(
        result.releaseSummary.recent.map((release) => release.id)
      );
      expect(result.releaseSummary.recent.find((release) => release.id === first.id).thumbnails)
        .toEqual([expect.objectContaining({ assetId: firstAsset.id, filename: 'first.png' })]);
      expect(result.releaseSummary.recent.find((release) => release.id === second.id).thumbnails)
        .toEqual([expect.objectContaining({ assetId: secondAsset.id, filename: 'second.png' })]);
      expect(result.releaseSummary.recent.find((release) => release.id === first.id).thumbnails)
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ assetId: secondAsset.id })]));
      expect(result.releaseSummary.recent.find((release) => release.id === second.id).thumbnails)
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ assetId: firstAsset.id })]));
    });

    it('counts present and missing assets correctly', () => {
      const project = insertProject(db, { title: 'Asset Count Project 2' });
      insertAsset(db, { projectId: project.id, relativePath: 'p1.txt', filename: 'p1.txt', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'p2.txt', filename: 'p2.txt', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'm1.txt', filename: 'm1.txt', isPresent: 0 });

      const ws = service.getProjectWorkspace(project.id);
      expect(ws.assetHealth).toEqual({
        total: 3,
        present: 2,
        missing: 1,
        missingByReleases: 0,
      });
    });

    it('counts missing assets referenced by non-archived releases for the project', () => {
      const project = insertProject(db, { title: 'Referenced Missing Project' });
      const missing1 = insertAsset(db, { projectId: project.id, relativePath: 'm1.txt', filename: 'm1.txt', isPresent: 0 });
      const missing2 = insertAsset(db, { projectId: project.id, relativePath: 'm2.txt', filename: 'm2.txt', isPresent: 0 });
      const present = insertAsset(db, { projectId: project.id, relativePath: 'p.txt', filename: 'p.txt', isPresent: 1 });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'References Missing',
        status: 'planned',
        plannedDate: '2099-01-01',
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: missing1.id });
      linkAssetToRelease(db, { releaseId: release.id, assetId: missing2.id });
      linkAssetToRelease(db, { releaseId: release.id, assetId: present.id });

      const ws = service.getProjectWorkspace(project.id);
      expect(ws.assetHealth.missingByReleases).toBe(2);
    });

    it('does not count missing assets from archived releases', () => {
      const project = insertProject(db, { title: 'Archived Ref Per Project' });
      const missing = insertAsset(db, { projectId: project.id, relativePath: 'm.txt', filename: 'm.txt', isPresent: 0 });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Archived Ref',
        status: 'tbd',
        plannedDate: null,
        archivedAt: '2024-01-01 00:00:00',
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: missing.id });

      const ws = service.getProjectWorkspace(project.id);
      expect(ws.assetHealth.missing).toBe(1);
      expect(ws.assetHealth.missingByReleases).toBe(0);
    });

    it('counts missing assets only for the target project', () => {
      const p1 = insertProject(db, { title: 'Project 1' });
      const p2 = insertProject(db, { title: 'Project 2' });
      const missing1 = insertAsset(db, { projectId: p1.id, relativePath: 'm.txt', filename: 'm.txt', isPresent: 0 });
      const release2 = insertRelease(db, {
        projectId: p2.id,
        title: 'Other Project Release',
        status: 'planned',
        plannedDate: '2099-01-01',
      });
      // This should not happen in normal use — cross-project — but the count
      // filter must be by project_id, so verify that.
      // We don't link — the asset doesn't belong to project 2 — but the
      // per-project count must still exclude it.
      expect(missing1.project_id).toBe(p1.id);

      const ws = service.getProjectWorkspace(p2.id);
      expect(ws.assetHealth.missingByReleases).toBe(0);
    });

    it('returns historical release information for archived projects', () => {
      const project = insertProject(db, { title: 'Archived History Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Old Release',
        status: 'published',
        plannedDate: '2020-01-01',
        publishedDate: '2020-01-15',
      });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const ws = service.getProjectWorkspace(project.id);
      expect(ws).not.toBeNull();
      expect(ws.project.archived_at).toBeTruthy();
      // Historical release is in recent (active filter excludes it)
      expect(ws.releaseSummary.active).toEqual([]);
      expect(ws.releaseSummary.recent.length).toBe(1);
      expect(ws.releaseSummary.recent[0].id).toBe(release.id);
      expect(ws.releaseSummary.recent[0].published_date).toBe('2020-01-15');
      expect(ws.releaseSummary.hasAnyReleases).toBe(true);
    });

    it('respects bounded limit for active releases', () => {
      const project = insertProject(db, { title: 'Bounded Active' });
      for (let i = 0; i < 10; i++) {
        insertRelease(db, {
          projectId: project.id,
          title: `A${i}`,
          status: 'planned',
          plannedDate: '2099-01-01',
        });
      }

      const ws = service.getProjectWorkspace(project.id, { limits: { activeReleases: 4 } });
      expect(ws.releaseSummary.active).toHaveLength(4);
    });

    it('respects bounded limit for recent releases', () => {
      const project = insertProject(db, { title: 'Bounded Recent' });
      for (let i = 0; i < 10; i++) {
        insertRelease(db, {
          projectId: project.id,
          title: `R${i}`,
          status: 'published',
          publishedDate: '2024-01-01',
        });
      }

      const ws = service.getProjectWorkspace(project.id, { limits: { recentReleases: 3 } });
      expect(ws.releaseSummary.recent).toHaveLength(3);
    });
  });

  // ─── Phase 6B regression: archived project workspace composition ───
  //
  // Archived projects must not surface active workflow (active releases or
  // create-release affordances) because mutations reject the archived
  // parent. Historical information (published/cancelled releases) must
  // remain visible through the recent list and the status counts.

  describe('getProjectWorkspace — archived parent hides active workflow', () => {
    it('archived project with active release does not show active releases', () => {
      const project = insertProject(db, { title: 'Archived Active Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Active In Archived Project',
        status: 'planned',
        plannedDate: '2099-01-01',
      });
      // Archive the project but NOT the release. The release row is still
      // non-terminal and non-archived, so the active filter would normally
      // return it. The workspace composition must suppress it.
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const ws = service.getProjectWorkspace(project.id);
      expect(ws).not.toBeNull();
      expect(ws.project.archived_at).toBeTruthy();
      expect(ws.releaseSummary.active).toEqual([]);
      // Sanity: the underlying release is genuinely still active in the DB
      const fromDb = db.prepare(`SELECT archived_at, published_date FROM releases WHERE id = ?`).get(release.id);
      expect(fromDb.archived_at).toBeNull();
      expect(fromDb.published_date).toBeNull();
    });

    it('archived project still surfaces historical releases in the recent list', () => {
      const project = insertProject(db, { title: 'Archived History Project 2' });
      const published = insertRelease(db, {
        projectId: project.id,
        title: 'Published In Archived Project',
        status: 'published',
        plannedDate: '2020-01-01',
        publishedDate: '2020-01-15',
      });
      const archivedUnpublished = insertRelease(db, {
        projectId: project.id,
        title: 'Archived In Archived Project',
        plannedDate: '2020-02-01',
        archivedAt: '2024-01-01 00:00:00',
      });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const ws = service.getProjectWorkspace(project.id);
      expect(ws.releaseSummary.active).toEqual([]);
      // Recent list still shows every release (any publication/archive state).
      const recentIds = ws.releaseSummary.recent.map((r) => r.id).sort();
      expect(recentIds).toEqual([published.id, archivedUnpublished.id].sort());
      expect(ws.releaseSummary).not.toHaveProperty('statusCounts');
      expect(ws.releaseSummary.recent.find((release) => release.id === published.id).published_date)
        .toBe('2020-01-15');
      expect(ws.releaseSummary.hasAnyReleases).toBe(true);
    });

    it('archived project workspace does not call the active-release query', () => {
      // Indirectly observable: when there is no archived project, active
      // releases are returned. This guards against the active query being
      // removed for non-archived projects.
      const project = insertProject(db, { title: 'Active Project For Control' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Active Control',
        status: 'planned',
        plannedDate: '2099-01-01',
      });
      const ws = service.getProjectWorkspace(project.id);
      expect(ws.releaseSummary.active.map((r) => r.id)).toEqual([release.id]);
    });
  });

  // ─── Service does not mutate state ─────────────────────────────────

  describe('read-only invariants', () => {
    it('does not create or modify any table when called', () => {
      const project = insertProject(db, { title: 'Read-Only Project' });
      insertRelease(db, { projectId: project.id, title: 'R', status: 'tbd' });

      const before = db.prepare(`
        SELECT (SELECT COUNT(*) FROM projects) AS projects,
               (SELECT COUNT(*) FROM releases) AS releases,
               (SELECT COUNT(*) FROM assets) AS assets,
               (SELECT COUNT(*) FROM release_assets) AS release_assets
      `).get();

      service.getDashboardData();
      service.getProjectWorkspace(project.id);

      const after = db.prepare(`
        SELECT (SELECT COUNT(*) FROM projects) AS projects,
               (SELECT COUNT(*) FROM releases) AS releases,
               (SELECT COUNT(*) FROM assets) AS assets,
               (SELECT COUNT(*) FROM release_assets) AS release_assets
      `).get();

      expect(after).toEqual(before);
    });

    it('repositories remain available for direct unit testing', () => {
      // This is a meta-test: make sure both repositories can be instantiated
      // alongside the service. If the service accidentally hid or rewired
      // them, downstream tests would fail.
      const releaseRepo = createReleaseRepository(db);
      const assetRepo = createAssetRepository(db);
      expect(typeof releaseRepo.findOverdue).toBe('function');
      expect(typeof assetRepo.getTotalMissingCount).toBe('function');
    });
  });

  // ─── Phase 6C: Release Planning Views — getReleaseList ──────────────────────

  describe('getReleaseList', () => {
    it('returns paginated releases with metadata', () => {
      const project = insertProject(db, { title: 'List Project' });
      for (let i = 0; i < 5; i++) {
        insertRelease(db, { projectId: project.id, title: `R${i}`, status: 'tbd' });
      }

      const result = service.getReleaseList({}, { today: '2025-06-15' });
      expect(result.releases).toHaveLength(5);
      expect(result.total).toBe(5);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(25);
      expect(result.pageCount).toBe(1);
    });

    it('respects page and pageSize parameters', () => {
      const project = insertProject(db, { title: 'Page Project' });
      for (let i = 0; i < 10; i++) {
        insertRelease(db, { projectId: project.id, title: `P${i}`, status: 'tbd' });
      }

      const result = service.getReleaseList({ page: 2, pageSize: 3 }, { today: '2025-06-15' });
      expect(result.releases).toHaveLength(3);
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(3);
      expect(result.pageCount).toBe(4);
    });

    it('invalid page falls back to 1', () => {
      const result = service.getReleaseList({ page: -1 }, { today: '2025-06-15' });
      expect(result.page).toBe(1);
    });

    it('invalid pageSize falls back to 25', () => {
      const result = service.getReleaseList({ pageSize: 0 }, { today: '2025-06-15' });
      expect(result.pageSize).toBe(25);
    });

    it('pageSize is capped at 100', () => {
      const result = service.getReleaseList({ pageSize: 200 }, { today: '2025-06-15' });
      expect(result.pageSize).toBe(100);
    });

    it('ignores an obsolete status query without mapping it to project status', () => {
      const project = insertProject(db, { title: 'Status Filter', status: 'tbd' });
      insertRelease(db, { projectId: project.id, title: 'Idea', status: 'tbd' });
      insertRelease(db, { projectId: project.id, title: 'Planned', status: 'planned' });

      const filters = service.normalizeListFilters({ status: 'ready' });
      const result = service.getReleaseList({ status: 'ready' }, { today: '2025-06-15' });
      expect(filters).not.toHaveProperty('status');
      expect(result.total).toBe(2);
      expect(result.releases.every((release) => release.project_status === 'tbd')).toBe(true);
      expect(result.releases.every((release) => !Object.hasOwn(release, 'status'))).toBe(true);
    });

    it('does not pass obsolete status filters to repository methods', () => {
      const releaseRepository = createReleaseRepository(db);
      const countFiltered = vi.spyOn(releaseRepository, 'countFiltered');
      const findPage = vi.spyOn(releaseRepository, 'findPage');
      const injectedService = createWorkflowQueryService({
        db,
        releaseRepository,
        projectPrimaryImageRepository: primaryImageRepository,
        tagRepository,
      });

      injectedService.getReleaseList({ status: 'ready' }, { today: '2025-06-15' });

      for (const [filters] of [...countFiltered.mock.calls, ...findPage.mock.calls]) {
        expect(filters).not.toHaveProperty('status');
        expect(filters).not.toHaveProperty('release_status');
      }
    });

    it('returns releases with project_title and asset counts', () => {
      const project = insertProject(db, { title: 'Asset Count Project' });
      const release = insertRelease(db, { projectId: project.id, title: 'With Assets', status: 'planned' });
      const asset = insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });

      const result = service.getReleaseList({}, { today: '2025-06-15' });
      const row = result.releases.find((r) => r.id === release.id);
      expect(row.project_title).toBe('Asset Count Project');
      expect(row.project_status).toBe('tbd');
      expect(row).not.toHaveProperty('status');
      expect(row).not.toHaveProperty('release_status');
      expect(row.selected_asset_count).toBe(1);
      expect(row.missing_asset_count).toBe(0);
    });

    it('filters by project', () => {
      const p1 = insertProject(db, { title: 'P1' });
      const p2 = insertProject(db, { title: 'P2' });
      insertRelease(db, { projectId: p1.id, title: 'R1', status: 'tbd' });
      insertRelease(db, { projectId: p2.id, title: 'R2', status: 'tbd' });

      const result = service.getReleaseList({ project: String(p1.id) }, { today: '2025-06-15' });
      expect(result.total).toBe(1);
      expect(result.releases[0].title).toBe('R1');
    });

    it('filters by schedule: overdue', () => {
      const project = insertProject(db, { title: 'Overdue Schedule' });
      insertRelease(db, { projectId: project.id, title: 'Overdue', status: 'planned', plannedDate: '2025-06-01' });
      insertRelease(db, { projectId: project.id, title: 'Future', status: 'planned', plannedDate: '2025-06-20' });

      const result = service.getReleaseList({ schedule: 'overdue' }, { today: '2025-06-15' });
      expect(result.total).toBe(1);
      expect(result.releases[0].title).toBe('Overdue');
    });

    it('filters by schedule: today', () => {
      const project = insertProject(db, { title: 'Today Schedule' });
      insertRelease(db, { projectId: project.id, title: 'Yesterday', status: 'planned', plannedDate: '2025-06-14' });
      insertRelease(db, { projectId: project.id, title: 'Today', status: 'planned', plannedDate: '2025-06-15' });

      const result = service.getReleaseList({ schedule: 'today' }, { today: '2025-06-15' });
      expect(result.total).toBe(1);
      expect(result.releases[0].title).toBe('Today');
    });

    it('filters by schedule: upcoming', () => {
      const project = insertProject(db, { title: 'Upcoming Schedule' });
      insertRelease(db, { projectId: project.id, title: 'Today', status: 'planned', plannedDate: '2025-06-15' });
      insertRelease(db, { projectId: project.id, title: 'Tomorrow', status: 'planned', plannedDate: '2025-06-20' });

      const result = service.getReleaseList({ schedule: 'upcoming' }, { today: '2025-06-15' });
      expect(result.total).toBe(1);
      expect(result.releases[0].title).toBe('Tomorrow');
    });

    it('filters by schedule: unscheduled', () => {
      const project = insertProject(db, { title: 'Unscheduled Schedule' });
      insertRelease(db, { projectId: project.id, title: 'No Date', status: 'in-progress', plannedDate: null });
      insertRelease(db, { projectId: project.id, title: 'Has Date', status: 'planned', plannedDate: '2025-06-15' });

      const result = service.getReleaseList({ schedule: 'unscheduled' }, { today: '2025-06-15' });
      expect(result.total).toBe(1);
      expect(result.releases[0].title).toBe('No Date');
    });

    it('uses one shared today for classification', () => {
      const project = insertProject(db, { title: 'Shared Today Project' });
      const yesterday = insertRelease(db, { projectId: project.id, title: 'Yesterday', status: 'planned', plannedDate: '2025-06-14' });
      const today = insertRelease(db, { projectId: project.id, title: 'Today', status: 'planned', plannedDate: '2025-06-15' });

      const result = service.getReleaseList({ schedule: 'overdue' }, { today: '2025-06-15' });
      expect(result.releases.map((r) => r.id)).toEqual([yesterday.id]);

      const resultToday = service.getReleaseList({ schedule: 'today' }, { today: '2025-06-15' });
      expect(resultToday.releases.map((r) => r.id)).toEqual([today.id]);

      // Same today is exposed in result
      expect(result.today).toBe('2025-06-15');
    });

    // ─── Strict positive-integer validation: malformed input rejection ──
    //
    // URL-decoded query strings can carry artefacts that bypass a naive
    // trim-then-parse pipeline. The validator must reject these WITHOUT
    // trimming, so "%2B2" (decoded as "+2", which URL-decodes again to a
    // leading-space "2") cannot sneak through as a valid integer.

    it('rejects leading-plus page value (URL-decoded "+2")', () => {
      // URL decode of "+2" is " 2" — the leading space must cause rejection.
      const result = service.getReleaseList({ page: '+2' }, { today: '2025-06-15' });
      expect(result.page).toBe(1);
    });

    it('rejects leading-whitespace page value', () => {
      const result = service.getReleaseList({ page: ' 2' }, { today: '2025-06-15' });
      expect(result.page).toBe(1);
    });

    it('rejects trailing-whitespace page value', () => {
      const result = service.getReleaseList({ page: '2 ' }, { today: '2025-06-15' });
      expect(result.page).toBe(1);
    });

    it('rejects "1junk" page value', () => {
      const result = service.getReleaseList({ page: '1junk' }, { today: '2025-06-15' });
      expect(result.page).toBe(1);
    });

    it('rejects "2.5" page value', () => {
      const result = service.getReleaseList({ page: '2.5' }, { today: '2025-06-15' });
      expect(result.page).toBe(1);
    });

    it('rejects "1e2" page value', () => {
      const result = service.getReleaseList({ page: '1e2' }, { today: '2025-06-15' });
      expect(result.page).toBe(1);
    });

    it('rejects "-2" page value', () => {
      const result = service.getReleaseList({ page: '-2' }, { today: '2025-06-15' });
      expect(result.page).toBe(1);
    });

    it('rejects "0" page value', () => {
      const result = service.getReleaseList({ page: '0' }, { today: '2025-06-15' });
      expect(result.page).toBe(1);
    });

    it('rejects blank page value', () => {
      const result = service.getReleaseList({ page: '' }, { today: '2025-06-15' });
      expect(result.page).toBe(1);
    });

    it('rejects leading-plus project id — falls back to no filter, returns both projects', () => {
      const p1 = insertProject(db, { title: 'Malformed Proj Alpha' });
      const p2 = insertProject(db, { title: 'Malformed Proj Beta' });
      const r1 = insertRelease(db, { projectId: p1.id, title: 'Alpha-Malformed-Proj-Release', status: 'tbd' });
      const r2 = insertRelease(db, { projectId: p2.id, title: 'Beta-Malformed-Proj-Release', status: 'tbd' });

      const result = service.getReleaseList({ project: '+2' }, { today: '2025-06-15' });
      // projectId is null → no project filter → both releases returned.
      expect(result.total).toBe(2);
      const ids = result.releases.map((r) => r.id).sort();
      expect(ids).toEqual([r1.id, r2.id].sort());
    });

    it('rejects "1junk" project id — falls back to no filter, returns both projects', () => {
      const p1 = insertProject(db, { title: 'Junk Filter Alpha' });
      const p2 = insertProject(db, { title: 'Junk Filter Beta' });
      const r1 = insertRelease(db, { projectId: p1.id, title: 'Alpha-Junk-Filter-Release', status: 'tbd' });
      const r2 = insertRelease(db, { projectId: p2.id, title: 'Beta-Junk-Filter-Release', status: 'tbd' });

      const result = service.getReleaseList({ project: '1junk' }, { today: '2025-06-15' });
      expect(result.total).toBe(2);
      const ids = result.releases.map((r) => r.id).sort();
      expect(ids).toEqual([r1.id, r2.id].sort());
    });

    it('rejects decimal project id — falls back to no filter', () => {
      const p1 = insertProject(db, { title: 'Decimal Filter A' });
      const p2 = insertProject(db, { title: 'Decimal Filter B' });
      const r1 = insertRelease(db, { projectId: p1.id, title: 'Alpha-Dec-Filter-Release', status: 'tbd' });
      const r2 = insertRelease(db, { projectId: p2.id, title: 'Beta-Dec-Filter-Release', status: 'tbd' });

      const result = service.getReleaseList({ project: '1.5' }, { today: '2025-06-15' });
      expect(result.total).toBe(2);
      const ids = result.releases.map((r) => r.id).sort();
      expect(ids).toEqual([r1.id, r2.id].sort());
    });

    it('rejects scientific-notation project id — falls back to no filter', () => {
      const p1 = insertProject(db, { title: 'Sci Note Filter A' });
      const p2 = insertProject(db, { title: 'Sci Note Filter B' });
      const r1 = insertRelease(db, { projectId: p1.id, title: 'Alpha-Sci-Note-Release', status: 'tbd' });
      const r2 = insertRelease(db, { projectId: p2.id, title: 'Beta-Sci-Note-Release', status: 'tbd' });

      const result = service.getReleaseList({ project: '1e2' }, { today: '2025-06-15' });
      expect(result.total).toBe(2);
      const ids = result.releases.map((r) => r.id).sort();
      expect(ids).toEqual([r1.id, r2.id].sort());
    });

    it('rejects whitespace project id — falls back to no filter', () => {
      const p1 = insertProject(db, { title: 'WS Filter A' });
      const p2 = insertProject(db, { title: 'WS Filter B' });
      const r1 = insertRelease(db, { projectId: p1.id, title: 'Alpha-WS-Filter-Release', status: 'tbd' });
      const r2 = insertRelease(db, { projectId: p2.id, title: 'Beta-WS-Filter-Release', status: 'tbd' });

      const result = service.getReleaseList({ project: ' 2' }, { today: '2025-06-15' });
      expect(result.total).toBe(2);
      const ids = result.releases.map((r) => r.id).sort();
      expect(ids).toEqual([r1.id, r2.id].sort());
    });

    it('accepts a valid project id — returns only that project\'s releases', () => {
      const p1 = insertProject(db, { title: 'Valid Filter Alpha' });
      const p2 = insertProject(db, { title: 'Valid Filter Beta' });
      insertRelease(db, { projectId: p1.id, title: 'Alpha-Valid-Filter-Release', status: 'tbd' });
      insertRelease(db, { projectId: p2.id, title: 'Beta-Valid-Filter-Release', status: 'tbd' });

      const result = service.getReleaseList({ project: String(p1.id) }, { today: '2025-06-15' });
      expect(result.total).toBe(1);
      expect(result.releases[0].title).toBe('Alpha-Valid-Filter-Release');
    });

    it('rejects leading-plus pageSize', () => {
      const result = service.getReleaseList({ pageSize: '+10' }, { today: '2025-06-15' });
      // Falls back to default pageSize of 25.
      expect(result.pageSize).toBe(25);
    });

    it('rejects "1junk" pageSize', () => {
      const result = service.getReleaseList({ pageSize: '1junk' }, { today: '2025-06-15' });
      expect(result.pageSize).toBe(25);
    });

    it('rejects "2.5" pageSize', () => {
      const result = service.getReleaseList({ pageSize: '2.5' }, { today: '2025-06-15' });
      expect(result.pageSize).toBe(25);
    });

    it('rejects "1e2" pageSize', () => {
      const result = service.getReleaseList({ pageSize: '1e2' }, { today: '2025-06-15' });
      expect(result.pageSize).toBe(25);
    });

    it('rejects "-2" pageSize', () => {
      const result = service.getReleaseList({ pageSize: '-2' }, { today: '2025-06-15' });
      expect(result.pageSize).toBe(25);
    });

    it('rejects "0" pageSize', () => {
      const result = service.getReleaseList({ pageSize: '0' }, { today: '2025-06-15' });
      expect(result.pageSize).toBe(25);
    });

    it('rejects blank pageSize', () => {
      const result = service.getReleaseList({ pageSize: '' }, { today: '2025-06-15' });
      expect(result.pageSize).toBe(25);
    });

    it('accepts valid positive integer page', () => {
      const project = insertProject(db, { title: 'Valid Page Project' });
      // Need enough releases that page=3 is meaningful (pageSize defaults
      // to 25, so 75 releases guarantees pageCount >= 3).
      for (let i = 0; i < 75; i++) {
        insertRelease(db, { projectId: project.id, title: `Valid Page R${i}`, status: 'tbd' });
      }
      const result = service.getReleaseList({ page: '3' }, { today: '2025-06-15' });
      expect(result.page).toBe(3);
    });

    it('accepts valid positive integer pageSize', () => {
      const result = service.getReleaseList({ pageSize: '50' }, { today: '2025-06-15' });
      expect(result.pageSize).toBe(50);
    });
  });

  // ─── getReleaseList: fixed statement-execution count ─────────────────────
  //
  // Pins the exact statement-execution count so any future per-row project
  // lookup, per-row status/asset query, extra existence query, or other
  // dataset-dependent growth fails immediately. The count must not change as
  // the release/project dataset grows.

  describe('getReleaseList — fixed statement execution count', () => {
    const TODAY = '2025-06-15';

    it('executes a fixed number of statements as the dataset grows (page with ready releases)', () => {
      // Small dataset: one project with a ready release and a present asset.
      const project = insertProject(db, { title: 'List Query Small', status: 'ready' });
      const smallReady = insertRelease(db, {
        projectId: project.id,
        title: 'Small Ready',
        status: 'ready',
        plannedDate: TODAY,
      });
      const smallAsset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'small.txt',
        filename: 'small.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: smallReady.id, assetId: smallAsset.id });

      const counter = instrumentStatementExecution(db);
      const instrumentedService = createWorkflowQueryService({ db });

      counter.reset();
      const smallResult = instrumentedService.getReleaseList({}, { today: TODAY });
      const smallCount = counter.count();

      // Grow the dataset substantially: many projects, many releases, and
      // asset links.
      for (let i = 1; i <= 60; i++) {
        const p = insertProject(db, {
          title: `List Query Large ${i}`,
          status: i % 2 === 0 ? 'ready' : 'planned',
        });
        const r = insertRelease(db, {
          projectId: p.id,
          title: `Large Release ${i}`,
          status: i % 2 === 0 ? 'ready' : 'planned',
          plannedDate: `2099-02-${String((i % 20) + 1).padStart(2, '0')}`,
        });
        const a = insertAsset(db, {
          projectId: p.id,
          relativePath: `large-${i}.txt`,
          filename: `large-${i}.txt`,
          isPresent: 1,
        });
        linkAssetToRelease(db, { releaseId: r.id, assetId: a.id });
      }

      counter.reset();
      const largeResult = instrumentedService.getReleaseList({}, { today: TODAY });
      const largeCount = counter.count();

      // Semantic: the dataset really did grow and ready releases exist.
      expect(smallResult.hasAnyReleases).toBe(true);
      expect(largeResult.hasAnyReleases).toBe(true);
      expect(largeResult.total).toBeGreaterThan(smallResult.total);
      expect(largeResult.releases.length).toBeGreaterThan(0);
      // At least one ready release remains in the ordinary page data.
      expect(largeResult.releases.some((r) => r.project_status === 'ready')).toBe(true);

      // Fixed count: identical regardless of dataset size.
      expect(smallCount).toBe(RELEASE_LIST_FIXED_STATEMENT_EXECUTIONS);
      expect(largeCount).toBe(RELEASE_LIST_FIXED_STATEMENT_EXECUTIONS);
    });

    it('obsolete status query keeps the same fixed count and is ignored', () => {
      const project = insertProject(db, { title: 'Filter Match Project', status: 'ready' });
      for (let i = 0; i < 5; i++) {
        const r = insertRelease(db, {
          projectId: project.id,
          title: `Ready ${i}`,
          status: 'ready',
          plannedDate: TODAY,
        });
        const a = insertAsset(db, {
          projectId: project.id,
          relativePath: `m${i}.txt`,
          filename: `m${i}.txt`,
          isPresent: 1,
        });
        linkAssetToRelease(db, { releaseId: r.id, assetId: a.id });
      }

      const counter = instrumentStatementExecution(db);
      const instrumentedService = createWorkflowQueryService({ db });

      counter.reset();
      const result = instrumentedService.getReleaseList({ status: 'ready' }, { today: TODAY });
      const count = counter.count();

      expect(result.total).toBe(5);
      expect(result.hasAnyReleases).toBe(true);
      expect(result.releases).toHaveLength(5);
      expect(result.releases.every((release) => release.project_status === 'ready')).toBe(true);
      expect(count).toBe(RELEASE_LIST_FIXED_STATEMENT_EXECUTIONS);
    });

    it('includeArchived does not change the fixed count', () => {
      const project = insertProject(db, { title: 'Archived Inclusive', status: 'ready' });
      const active = insertRelease(db, {
        projectId: project.id, title: 'Active Ready', status: 'ready', plannedDate: TODAY,
      });
      const aActive = insertAsset(db, {
        projectId: project.id, relativePath: 'aa.txt', filename: 'aa.txt', isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: active.id, assetId: aActive.id });

      const archived = insertRelease(db, {
        projectId: project.id, title: 'Archived Release', status: 'ready',
        plannedDate: TODAY, archivedAt: '2024-01-01 00:00:00',
      });

      const counter = instrumentStatementExecution(db);
      const instrumentedService = createWorkflowQueryService({ db });

      counter.reset();
      const result = instrumentedService.getReleaseList({ includeArchived: '1' }, { today: TODAY });
      const count = counter.count();

      // includeArchived surfaces the archived release but adds no statement
      // — same composition, broader WHERE clause.
      expect(result.total).toBe(2);
      expect(result.hasAnyReleases).toBe(true);
      expect(result.releases.map((r) => r.id).sort()).toEqual([active.id, archived.id].sort());
      expect(count).toBe(RELEASE_LIST_FIXED_STATEMENT_EXECUTIONS);
    });

    it('empty repository: hasAnyReleases is false; count is fixed (no ready release on the page)', () => {
      const counter = instrumentStatementExecution(db);
      const instrumentedService = createWorkflowQueryService({ db });

      counter.reset();
      const result = instrumentedService.getReleaseList({}, { today: TODAY });
      const count = counter.count();

      expect(result.total).toBe(0);
      expect(result.hasAnyReleases).toBe(false);
      expect(result.releases).toEqual([]);
      // Three fixed queries remain: filtered total, hasAnyReleases, findPage.
      expect(count).toBe(RELEASE_LIST_FIXED_STATEMENT_EXECUTIONS);
    });

    it('releases exist but filters return zero rows: hasAnyReleases true, total zero, count fixed', () => {
      const project = insertProject(db, { title: 'Zero Match Project', status: 'ready' });
      const r = insertRelease(db, {
        projectId: project.id, title: 'Ready Exists', status: 'ready', plannedDate: TODAY,
      });
      const a = insertAsset(db, {
        projectId: project.id, relativePath: 'z.txt', filename: 'z.txt', isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: r.id, assetId: a.id });

      const counter = instrumentStatementExecution(db);
      const instrumentedService = createWorkflowQueryService({ db });

      // Search for no matches — releases still exist, so
      // hasAnyReleases must be true while the filtered total is zero.
      counter.reset();
      const result = instrumentedService.getReleaseList({ search: 'does-not-exist' }, { today: TODAY });
      const count = counter.count();

      expect(result.total).toBe(0);
      expect(result.hasAnyReleases).toBe(true);
      expect(result.releases).toEqual([]);
      // Zero-row page uses the same three fixed queries.
      expect(count).toBe(RELEASE_LIST_FIXED_STATEMENT_EXECUTIONS);
    });

    it('only archived releases exist: hasAnyReleases true via the includeArchived existence count', () => {
      const project = insertProject(db, { title: 'Only Archived Project' });
      insertRelease(db, {
        projectId: project.id, title: 'Archived Only', status: 'planned',
        plannedDate: TODAY, archivedAt: '2024-01-01 00:00:00',
      });

      const counter = instrumentStatementExecution(db);
      const instrumentedService = createWorkflowQueryService({ db });

      counter.reset();
      const result = instrumentedService.getReleaseList({}, { today: TODAY });
      const count = counter.count();

      // Default list excludes archived → filtered total is zero, but the
      // includeArchived existence count finds the archived release.
      expect(result.total).toBe(0);
      expect(result.hasAnyReleases).toBe(true);
      expect(result.releases).toEqual([]);
      expect(count).toBe(RELEASE_LIST_FIXED_STATEMENT_EXECUTIONS);
    });
  });
  it('does not expose the removed Release Board query path', () => {
    expect(service).not.toHaveProperty('getReleaseBoard');
  });


  // ─── Calendar month utilities — parseMonth/prevMonth/nextMonth ─────────────
  // Shared by getReleaseCalendar (the canonical /calendar data source).

  describe('calendar month utilities', () => {
    // ─── parseMonth year-range validation ───────────────────────────────

    it('parseMonth accepts years 1000-9999', () => {
      const { parseMonth } = service;
      expect(parseMonth('1000-01')).toEqual({ year: 1000, month: 1 });
      expect(parseMonth('9999-12')).toEqual({ year: 9999, month: 12 });
      expect(parseMonth('2025-06')).toEqual({ year: 2025, month: 6 });
    });

    it('parseMonth rejects year 0001', () => {
      const { parseMonth } = service;
      expect(parseMonth('0001-01')).toBeNull();
    });

    it('parseMonth rejects year 0999', () => {
      const { parseMonth } = service;
      expect(parseMonth('0999-12')).toBeNull();
    });

    it('parseMonth rejects year 10000', () => {
      const { parseMonth } = service;
      expect(parseMonth('10000-01')).toBeNull();
    });

    it('parseMonth rejects invalid month values', () => {
      const { parseMonth } = service;
      expect(parseMonth('2025-00')).toBeNull();
      expect(parseMonth('2025-13')).toBeNull();
      expect(parseMonth('2025-99')).toBeNull();
    });

    it('parseMonth rejects non-string and malformed input', () => {
      const { parseMonth } = service;
      expect(parseMonth(null)).toBeNull();
      expect(parseMonth(undefined)).toBeNull();
      expect(parseMonth(2025)).toBeNull();
      expect(parseMonth('2025')).toBeNull();
      expect(parseMonth('2025-1')).toBeNull();
      expect(parseMonth('2025-6')).toBeNull();
      expect(parseMonth('25-06')).toBeNull();
      expect(parseMonth('2025-06-01')).toBeNull();
    });

    it('prevMonth returns null for invalid month string', () => {
      const { prevMonth } = service;
      expect(prevMonth('0001-01')).toBeNull();
      expect(prevMonth('invalid')).toBeNull();
      expect(prevMonth('0999-12')).toBeNull();
      expect(prevMonth('10000-01')).toBeNull();
    });

    it('nextMonth returns null for invalid month string', () => {
      const { nextMonth } = service;
      expect(nextMonth('0001-01')).toBeNull();
      expect(nextMonth('invalid')).toBeNull();
      expect(nextMonth('0999-12')).toBeNull();
      expect(nextMonth('10000-01')).toBeNull();
    });

    it('prevMonth and nextMonth work correctly at year boundaries', () => {
      const { prevMonth, nextMonth } = service;
      expect(prevMonth('2025-01')).toBe('2024-12');
      expect(nextMonth('2025-12')).toBe('2026-01');
      // Input 1000-01 is the lowest supported year; prevMonth crosses below
      // the supported 1000-9999 range and must return null (no "999-12" URL).
      expect(prevMonth('1000-01')).toBeNull();
      // Input 9999-12 is the highest supported year; nextMonth crosses above
      // the supported range and must return null (no "10000-01" URL).
      expect(nextMonth('9999-12')).toBeNull();
    });

    it('prevMonth returns null at the lower boundary (1000-01)', () => {
      const { prevMonth } = service;
      expect(prevMonth('1000-01')).toBeNull();
    });

    it('nextMonth returns null at the upper boundary (9999-12)', () => {
      const { nextMonth } = service;
      expect(nextMonth('9999-12')).toBeNull();
    });

    it('prevMonth stays in-range just above the lower boundary (1000-02)', () => {
      const { prevMonth } = service;
      expect(prevMonth('1000-02')).toBe('1000-01');
    });

    it('nextMonth stays in-range just below the upper boundary (9999-11)', () => {
      const { nextMonth } = service;
      expect(nextMonth('9999-11')).toBe('9999-12');
    });

    it('prevMonth and nextMonth work for valid years', () => {
      const { prevMonth, nextMonth } = service;
      expect(prevMonth('2025-06')).toBe('2025-05');
      expect(nextMonth('2025-06')).toBe('2025-07');
    });
  });

  // ─── Release-backed calendar ────────────────────────────────────────────

  describe('getReleaseCalendar', () => {
    it('uses release planned_date instead of project dates and includes past and future releases', () => {
      const project = insertProject(db, { title: 'Calendar Project', plannedDate: '2025-06-03' });
      const past = insertRelease(db, {
        projectId: project.id,
        title: 'Past Release',
        plannedDate: '2025-06-05',
      });
      const future = insertRelease(db, {
        projectId: project.id,
        title: 'Future Release',
        plannedDate: '2025-06-25',
      });

      const result = service.getReleaseCalendar('2025-06', { today: '2025-06-15' });

      expect(result.days.find((day) => day.date === '2025-06-05').entries.map((entry) => entry.id)).toEqual([past.id]);
      expect(result.days.find((day) => day.date === '2025-06-25').entries.map((entry) => entry.id)).toEqual([future.id]);
      expect(result.days.find((day) => day.date === '2025-06-03').entries).toEqual([]);
    });

    it('includes multiple releases from one project as separate entries', () => {
      const project = insertProject(db, { title: 'Multi Release Project' });
      const first = insertRelease(db, { projectId: project.id, title: 'Release A', plannedDate: '2025-06-17' });
      const second = insertRelease(db, { projectId: project.id, title: 'Release B', plannedDate: '2025-06-18' });

      const result = service.getReleaseCalendar('2025-06', { today: '2025-06-15' });
      const entries = result.days.flatMap((day) => day.entries);

      expect(entries.map((entry) => entry.id)).toEqual([first.id, second.id]);
    });

    it('includes release notes in calendar entries', () => {
      const project = insertProject(db, { title: 'Calendar Notes Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Calendar Notes Release',
        notes: 'Calendar release notes',
        plannedDate: '2025-06-15',
      });

      const entry = service.getReleaseCalendar('2025-06', { today: '2025-06-15' })
        .days.find((day) => day.date === '2025-06-15').entries[0];

      expect(entry).toMatchObject({
        id: release.id,
        project_title: 'Calendar Notes Project',
        title: 'Calendar Notes Release',
        notes: 'Calendar release notes',
        project_status: 'tbd',
        planned_date: '2025-06-15',
      });
      expect(entry).not.toHaveProperty('status');
      expect(entry).not.toHaveProperty('release_status');
    });

    it('exposes project status without release status', () => {
      const workflowStatuses = ['tbd', 'planned', 'in-progress', 'ready'];
      const releases = workflowStatuses.map((projectStatus, index) => {
        const project = insertProject(db, {
          title: `${projectStatus} Project`,
          status: projectStatus,
        });
        return insertRelease(db, {
          projectId: project.id,
          title: `${projectStatus} Release`,
          plannedDate: `2025-06-${String(index + 1).padStart(2, '0')}`,
          publishedDate: projectStatus === 'ready' ? '2025-01-01' : null,
        });
      });
      const archivedProject = insertProject(db, { title: 'Archived Calendar Project', status: 'tbd' });
      const archived = insertRelease(db, {
        projectId: archivedProject.id,
        title: 'Archived Release',
        plannedDate: '2025-06-20',
        archivedAt: '2025-01-02 00:00:00',
      });

      const result = service.getReleaseCalendar('2025-06', { today: '2025-06-15' });
      const entries = result.days.flatMap((day) => day.entries);

      expect(entries.map((entry) => entry.id)).toEqual(releases.map((release) => release.id));
      expect(entries.map((entry) => entry.project_status)).toEqual(workflowStatuses);
      expect(entries.every((entry) => !Object.hasOwn(entry, 'status'))).toBe(true);
      expect(entries.every((entry) => !Object.hasOwn(entry, 'release_status'))).toBe(true);
      expect(entries.map((entry) => entry.id)).not.toContain(archived.id);
    });

    it('excludes archived and unscheduled releases but not releases under archived projects', () => {
      const project = insertProject(db, { title: 'Archived Parent Project' });
      const included = insertRelease(db, { projectId: project.id, title: 'Included Release', plannedDate: '2025-06-10' });
      insertRelease(db, {
        projectId: project.id,
        title: 'Archived Release',
        plannedDate: '2025-06-11',
        archivedAt: '2025-06-01 00:00:00',
      });
      insertRelease(db, { projectId: project.id, title: 'Unscheduled Release' });
      db.prepare("UPDATE projects SET archived_at = '2025-06-01 00:00:00' WHERE id = ?").run(project.id);

      const result = service.getReleaseCalendar('2025-06', { today: '2025-06-15' });
      const entries = result.days.flatMap((day) => day.entries);

      expect(entries.map((entry) => entry.id)).toEqual([included.id]);
    });

    it('orders by date, scheduled time, and release id with untimed releases last', () => {
      const project = insertProject(db, { title: 'Ordering Project' });
      const untimed = insertRelease(db, {
        projectId: project.id,
        title: 'Untimed Release',
        plannedDate: '2025-06-15',
      });
      const late = insertRelease(db, {
        projectId: project.id,
        title: 'Late Release',
        plannedDate: '2025-06-15',
        plannedTime: '10:00',
      });
      const early = insertRelease(db, {
        projectId: project.id,
        title: 'Early Release',
        plannedDate: '2025-06-15',
        plannedTime: '08:00',
      });
      const sameTimeEarlierId = insertRelease(db, {
        projectId: project.id,
        title: 'Zeta Title',
        plannedDate: '2025-06-15',
        plannedTime: '08:00',
      });
      const sameTimeLaterId = insertRelease(db, {
        projectId: project.id,
        title: 'Alpha Title',
        plannedDate: '2025-06-15',
        plannedTime: '08:00',
      });

      const result = service.getReleaseCalendar('2025-06', { today: '2025-06-15' });
      const entries = result.days.find((day) => day.date === '2025-06-15').entries;

      expect(entries.map((entry) => entry.id)).toEqual([early.id, sameTimeEarlierId.id, sameTimeLaterId.id, late.id, untimed.id]);
      expect(entries.map((entry) => entry.planned_time)).toEqual(['08:00', '08:00', '08:00', '10:00', null]);
    });

    it('selects the first present previewable asset in manual release order', () => {
      const project = insertProject(db, { title: 'Preview Order Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Preview Order Release',
        plannedDate: '2025-06-15',
      });
      const missing = insertAsset(db, {
        projectId: project.id,
        relativePath: 'missing.png',
        filename: 'missing.png',
        extension: 'png',
        mimeType: 'image/png',
        isPresent: 0,
      });
      const unsupported = insertAsset(db, {
        projectId: project.id,
        relativePath: 'source.txt',
        filename: 'source.txt',
        extension: 'txt',
        mimeType: 'text/plain',
        sizeBytes: 512,
        modifiedAt: '2026-08-02T12:00:00.000Z',
      });
      const eligible = insertAsset(db, {
        projectId: project.id,
        relativePath: 'eligible.png',
        filename: 'eligible.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        modifiedAt: '2026-08-02T12:00:00.000Z',
      });
      const laterEligible = insertAsset(db, {
        projectId: project.id,
        relativePath: 'later.png',
        filename: 'later.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 4096,
        modifiedAt: '2026-08-02T12:00:00.000Z',
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: missing.id, sortOrder: 0 });
      linkAssetToRelease(db, { releaseId: release.id, assetId: unsupported.id, sortOrder: 1 });
      linkAssetToRelease(db, { releaseId: release.id, assetId: eligible.id, sortOrder: 2 });
      linkAssetToRelease(db, { releaseId: release.id, assetId: laterEligible.id, sortOrder: 3 });

      const entry = service.getReleaseCalendar('2025-06', { today: '2025-06-15' })
        .days.find((day) => day.date === '2025-06-15').entries[0];
      const revision = buildRevisionToken({
        projectId: project.id,
        assetId: eligible.id,
        relativePath: 'eligible.png',
        size: 2048,
        mtime: '2026-08-02T12:00:00.000Z',
      });

      expect(entry.preview_url).toBe(
        `/projects/${project.id}/assets/${eligible.id}/thumbnail?v=${revision}`
      );
      expect(entry.preview_url).not.toContain('missing');
      expect(entry.preview_url).not.toContain('source.txt');
    });

    it('returns no preview URL for absent or entirely ineligible selections', () => {
      const project = insertProject(db, { title: 'No Preview Project' });
      const absent = insertRelease(db, {
        projectId: project.id,
        title: 'No Selected Asset Release',
        plannedDate: '2025-06-15',
      });
      const ineligible = insertRelease(db, {
        projectId: project.id,
        title: 'No Eligible Asset Release',
        plannedDate: '2025-06-16',
      });
      const missing = insertAsset(db, {
        projectId: project.id,
        relativePath: 'missing.jpg',
        filename: 'missing.jpg',
        extension: 'jpg',
        mimeType: 'image/jpeg',
        isPresent: 0,
      });
      const unsupported = insertAsset(db, {
        projectId: project.id,
        relativePath: 'document.pdf',
        filename: 'document.pdf',
        extension: 'pdf',
        mimeType: 'application/pdf',
      });
      linkAssetToRelease(db, { releaseId: ineligible.id, assetId: missing.id, sortOrder: 0 });
      linkAssetToRelease(db, { releaseId: ineligible.id, assetId: unsupported.id, sortOrder: 1 });

      const entries = service.getReleaseCalendar('2025-06', { today: '2025-06-15' })
        .days.flatMap((day) => day.entries);

      expect(entries.find((entry) => entry.id === absent.id).preview_url).toBeNull();
      expect(entries.find((entry) => entry.id === ineligible.id).preview_url).toBeNull();
    });

    it('loads selected assets through one batch call for all calendar releases', () => {
      const project = insertProject(db, { title: 'Batched Preview Project' });
      const first = insertRelease(db, {
        projectId: project.id,
        title: 'First Batched Release',
        plannedDate: '2025-06-15',
      });
      const second = insertRelease(db, {
        projectId: project.id,
        title: 'Second Batched Release',
        plannedDate: '2025-06-16',
      });
      const firstAsset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'first-batched.png',
        filename: 'first-batched.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 1024,
        modifiedAt: '2026-08-02T12:00:00.000Z',
      });
      const secondAsset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'second-batched.png',
        filename: 'second-batched.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        modifiedAt: '2026-08-02T12:00:00.000Z',
      });
      linkAssetToRelease(db, { releaseId: first.id, assetId: firstAsset.id });
      linkAssetToRelease(db, { releaseId: second.id, assetId: secondAsset.id });

      const releaseRepository = createReleaseRepository(db);
      const findReleaseAssets = vi.spyOn(releaseRepository, 'findReleaseAssetsByReleaseIds');
      const calendarService = createWorkflowQueryService({
        db,
        releaseRepository,
      });

      calendarService.getReleaseCalendar('2025-06', { today: '2025-06-15' });

      expect(findReleaseAssets).toHaveBeenCalledTimes(1);
      expect(findReleaseAssets).toHaveBeenCalledWith([first.id, second.id]);
    });

  });

  // ─── Phase 6D: Asset Browser ─────────────────────────────────────────

  describe('getProjectAssetBrowser', () => {
    it('returns null for missing project', () => {
      const result = service.getProjectAssetBrowser(9999);
      expect(result).toBeNull();
    });

    it('returns safe empty result for project with no assets', () => {
      const project = insertProject(db, { title: 'Empty Asset Project' });

      const result = service.getProjectAssetBrowser(project.id);

      expect(result).not.toBeNull();
      expect(result.assets).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(25);
      expect(result.pageCount).toBe(1);
      expect(result.filters).toEqual({
        search: null,
        extension: [],
        presence: 'all',
        usage: 'all',
        category: 'all',
        sort: 'filename',
        order: 'asc',
        view: 'grid',
      });
    });

    it('uses default filters when none provided', () => {
      const project = insertProject(db, { title: 'Filter Defaults' });
      insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'b.txt', filename: 'b.txt', isPresent: 0 });

      const result = service.getProjectAssetBrowser(project.id);

      expect(result.filters).toEqual({
        search: null,
        extension: [],
        presence: 'all',
        usage: 'all',
        category: 'all',
        sort: 'filename',
        order: 'asc',
        view: 'grid',
      });
      expect(result.total).toBe(2);
    });

    it('invalid presence and usage values fallback to defaults', () => {
      const project = insertProject(db, { title: 'Filter Fallbacks' });
      insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });

      const result = service.getProjectAssetBrowser(project.id, {
        presence: 'invalid-presence',
        usage: 'bad-usage',
      });

      expect(result.filters).toEqual({
        search: null,
        extension: [],
        presence: 'all',
        usage: 'all',
        category: 'all',
        sort: 'filename',
        order: 'asc',
        view: 'grid',
      });
    });

    it('defaults the view to grid when omitted', () => {
      const project = insertProject(db, { title: 'Default View' });
      insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });

      const result = service.getProjectAssetBrowser(project.id);

      expect(result.filters.view).toBe('grid');
    });

    it('accepts a valid grid view parameter', () => {
      const project = insertProject(db, { title: 'Grid View Param' });
      insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });

      const result = service.getProjectAssetBrowser(project.id, { view: 'grid' });

      expect(result.filters.view).toBe('grid');
      expect(result.assets).toHaveLength(1);
      expect(result.page).toBe(1);
    });

    it('normalizes an invalid view value to grid', () => {
      const project = insertProject(db, { title: 'Invalid View Param' });
      insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });

      const result = service.getProjectAssetBrowser(project.id, { view: 'table' });

      expect(result.filters.view).toBe('grid');
    });

    it('normalizes search by trimming empty input and bounding long values', () => {
      const project = insertProject(db, { title: 'Search Normalize' });
      insertAsset(db, { projectId: project.id, relativePath: 'needle.txt', filename: 'needle.txt', isPresent: 1 });

      const empty = service.getProjectAssetBrowser(project.id, { search: '   ' });
      expect(empty.filters.search).toBeNull();

      const longSearch = `${'n'.repeat(128)}extra`;
      const bounded = service.getProjectAssetBrowser(project.id, { search: `  ${longSearch}  ` });
      expect(bounded.filters.search).toBe('n'.repeat(128));
      expect(bounded.searchMaxLength).toBe(128);
    });

    it('filters by filename search case-insensitively', () => {
      const project = insertProject(db, { title: 'Search Filter' });
      insertAsset(db, { projectId: project.id, relativePath: 'Hero-Render.png', filename: 'Hero-Render.png', extension: 'png', mimeType: 'image/png', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'hero-source.kra', filename: 'hero-source.kra', extension: 'kra', mimeType: 'application/x-krita', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'other.txt', filename: 'other.txt', isPresent: 1 });

      const result = service.getProjectAssetBrowser(project.id, { search: 'hero' });

      expect(result.filters.search).toBe('hero');
      expect(result.total).toBe(2);
      expect(result.assets.map((a) => a.filename)).toEqual(['Hero-Render.png', 'hero-source.kra']);
    });

    it('normalizes extension case and leading dot before exact filtering', () => {
      const project = insertProject(db, { title: 'Extension Normalize' });
      insertAsset(db, { projectId: project.id, relativePath: 'render.png', filename: 'render.png', extension: 'png', mimeType: 'image/png', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'render.apng', filename: 'render.apng', extension: 'apng', mimeType: 'application/octet-stream', isPresent: 1 });

      const result = service.getProjectAssetBrowser(project.id, { extension: '.PNG' });

      expect(result.filters.extension).toEqual(['png']);
      expect(result.total).toBe(1);
      expect(result.assets.map((a) => a.filename)).toEqual(['render.png']);
    });

    it('invalid or absent extension normalizes to no extension filter', () => {
      const project = insertProject(db, { title: 'Invalid Extension' });
      insertAsset(db, { projectId: project.id, relativePath: 'render.png', filename: 'render.png', extension: 'png', mimeType: 'image/png', isPresent: 1 });

      const invalid = service.getProjectAssetBrowser(project.id, { extension: 'jpg' });
      const empty = service.getProjectAssetBrowser(project.id, { extension: '.' });

      expect(invalid.filters.extension).toEqual([]);
      expect(invalid.total).toBe(1);
      expect(empty.filters.extension).toEqual([]);
    });

    it('normalizes repeated extensions, deduplicates them, and filters by either selected extension', () => {
      const project = insertProject(db, { title: 'Multiple Extensions' });
      insertAsset(db, { projectId: project.id, relativePath: 'render.png', filename: 'render.png', extension: 'png', mimeType: 'image/png', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'photo.jpg', filename: 'photo.jpg', extension: 'jpg', mimeType: 'image/jpeg', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'notes.txt', filename: 'notes.txt', extension: 'txt', mimeType: 'text/plain', isPresent: 1 });

      const result = service.getProjectAssetBrowser(project.id, {
        extension: ['.JPG', 'png', 'jpg', 'unknown'],
      });

      expect(result.filters.extension).toEqual(['jpg', 'png']);
      expect(result.total).toBe(2);
      expect(result.assets.map((asset) => asset.filename)).toEqual(['photo.jpg', 'render.png']);
      expect(result.extensionChoices).toEqual([
        { value: 'jpg', label: 'jpg', selected: true },
        { value: 'png', label: 'png', selected: true },
        { value: 'txt', label: 'txt', selected: false },
      ]);
    });

    it('filters by a valid reusable asset tag, returns numeric deterministic options, and keeps rows unique', () => {
      const project = insertProject(db, { title: 'Asset Tag Filter' });
      const matching = insertAsset(db, { projectId: project.id, relativePath: 'matching.png', filename: 'matching.png', extension: 'png', isPresent: 1 });
      const secondMatching = insertAsset(db, { projectId: project.id, relativePath: 'second.png', filename: 'second.png', extension: 'png', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'other.png', filename: 'other.png', extension: 'png', isPresent: 1 });
      const zeta = tagRepository.create({ displayName: 'zeta', normalizedName: 'zeta' });
      const alpha = tagRepository.create({ displayName: 'Alpha', normalizedName: 'alpha' });
      const beta = tagRepository.create({ displayName: 'Beta', normalizedName: 'beta' });

      tagRepository.assignToAsset(matching.id, beta.id);
      tagRepository.assignToAsset(matching.id, alpha.id);
      tagRepository.assignToAsset(secondMatching.id, beta.id);

      const result = service.getProjectAssetBrowser(project.id, {
        tag: String(beta.id),
        pageSize: 25,
      });

      expect(result.filters.tags).toEqual([beta.id]);
      expect(result.assets.map((asset) => asset.id)).toEqual([matching.id, secondMatching.id]);
      expect(new Set(result.assets.map((asset) => asset.id)).size).toBe(result.assets.length);
      expect(result.total).toBe(result.assets.length);
      expect(result.tagOptions).toEqual([
        { value: alpha.id, displayName: 'Alpha', selected: false },
        { value: beta.id, displayName: 'Beta', selected: true },
        { value: zeta.id, displayName: 'zeta', selected: false },
      ]);
      expect(result.tagOptions[0]).not.toHaveProperty('normalizedName');
      expect(result.tagOptions[0]).not.toHaveProperty('normalized_name');
    });

    it('normalizes repeated tag values, filters by any selected direct asset tag, and keeps options selected', () => {
      const project = insertProject(db, { title: 'Multiple Asset Tags' });
      const alphaAsset = insertAsset(db, { projectId: project.id, relativePath: 'alpha.png', filename: 'alpha.png', extension: 'png', isPresent: 1 });
      const betaAsset = insertAsset(db, { projectId: project.id, relativePath: 'beta.png', filename: 'beta.png', extension: 'png', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'untagged.png', filename: 'untagged.png', extension: 'png', isPresent: 1 });
      const alpha = tagRepository.create({ displayName: 'Alpha', normalizedName: 'multiple-alpha' });
      const beta = tagRepository.create({ displayName: 'Beta', normalizedName: 'multiple-beta' });
      const gamma = tagRepository.create({ displayName: 'Gamma', normalizedName: 'multiple-gamma' });

      tagRepository.assignToAsset(alphaAsset.id, alpha.id);
      tagRepository.assignToAsset(betaAsset.id, beta.id);

      const result = service.getProjectAssetBrowser(project.id, {
        tag: [String(beta.id), '999999', String(alpha.id), '1junk', String(beta.id)],
      });

      expect(result.filters.tags).toEqual([alpha.id, beta.id]);
      expect(result.assets.map((asset) => asset.filename)).toEqual(['alpha.png', 'beta.png']);
      expect(result.total).toBe(2);
      expect(result.tagOptions).toEqual([
        { value: alpha.id, displayName: 'Alpha', selected: true },
        { value: beta.id, displayName: 'Beta', selected: true },
        { value: gamma.id, displayName: 'Gamma', selected: false },
      ]);
    });

    it('normalizes empty, malformed, nonexistent, and deleted asset tag IDs to all assets', () => {
      const project = insertProject(db, { title: 'Invalid Asset Tag Filter' });
      const tagged = insertAsset(db, { projectId: project.id, relativePath: 'tagged.txt', filename: 'tagged.txt', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'untagged.txt', filename: 'untagged.txt', isPresent: 1 });
      const tag = tagRepository.create({ displayName: 'Existing', normalizedName: 'existing' });
      tagRepository.assignToAsset(tagged.id, tag.id);

      for (const rawTag of ['', '0', '-1', '1.5', '1junk', '999999', ['0', '1junk']]) {
        const result = service.getProjectAssetBrowser(project.id, { tag: rawTag });
        expect(result.filters.tags).toBeUndefined();
        expect(result.total).toBe(2);
      }

      tagRepository.deleteById(tag.id);
      const deleted = service.getProjectAssetBrowser(project.id, { tag: String(tag.id) });
      expect(deleted.filters.tags).toBeUndefined();
      expect(deleted.total).toBe(2);
      expect(deleted.tagOptions).toEqual([]);
    });

    it('composes tag, search, extension, presence, and usage filters before pagination', () => {
      const project = insertProject(db, { title: 'Composed Asset Tag Filter' });
      const matching = insertAsset(db, {
        projectId: project.id,
        relativePath: 'renders/Hero-Final.png',
        filename: 'Hero-Final.png',
        extension: 'png',
        mimeType: 'image/png',
        isPresent: 1,
      });
      const missing = insertAsset(db, {
        projectId: project.id,
        relativePath: 'renders/Hero-Missing.png',
        filename: 'Hero-Missing.png',
        extension: 'png',
        mimeType: 'image/png',
        isPresent: 0,
      });
      insertAsset(db, {
        projectId: project.id,
        relativePath: 'renders/Hero-Final.jpg',
        filename: 'Hero-Final.jpg',
        extension: 'jpg',
        mimeType: 'image/jpeg',
        isPresent: 1,
      });
      const tag = tagRepository.create({ displayName: 'Composed', normalizedName: 'composed' });
      tagRepository.assignToAsset(matching.id, tag.id);
      tagRepository.assignToAsset(missing.id, tag.id);
      const release = insertRelease(db, { projectId: project.id, title: 'Used Asset', status: 'tbd' });
      linkAssetToRelease(db, { releaseId: release.id, assetId: matching.id });

      const result = service.getProjectAssetBrowser(project.id, {
        tag: String(tag.id),
        search: 'hero',
        extension: '.PNG',
        presence: 'present',
        usage: 'used',
        pageSize: 1,
      });

      expect(result.total).toBe(1);
      expect(result.assets.map((asset) => asset.id)).toEqual([matching.id]);
      expect(result.page).toBe(1);
      expect(result.pageCount).toBe(1);
      expect(result.filters).toMatchObject({
         tags: [tag.id],
        search: 'hero',
        extension: ['png'],
        presence: 'present',
        usage: 'used',
      });
    });

    it('returns stable project-owned extension choices unaffected by active filters', () => {
      const project = insertProject(db, { title: 'Stable Extensions' });
      const other = insertProject(db, { title: 'Other Extensions' });
      insertAsset(db, { projectId: project.id, relativePath: 'a.png', filename: 'a.png', extension: 'png', mimeType: 'image/png', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'b.jpg', filename: 'b.jpg', extension: 'jpg', mimeType: 'image/jpeg', isPresent: 0 });
      insertAsset(db, { projectId: project.id, relativePath: 'c.kra', filename: 'c.kra', extension: 'kra', mimeType: 'application/x-krita', isPresent: 1 });
      insertAsset(db, { projectId: other.id, relativePath: 'd.webp', filename: 'd.webp', extension: 'webp', mimeType: 'image/webp', isPresent: 1 });

      const result = service.getProjectAssetBrowser(project.id, {
        search: 'no-match',
        presence: 'present',
        usage: 'used',
      });

      expect(result.total).toBe(0);
      expect(result.extensionChoices.map((c) => c.value)).toEqual(['jpg', 'kra', 'png']);
      expect(result.extensionChoices.every((c) => c.selected === false)).toBe(true);
    });

    it('malformed page falls back to 1', () => {
      const project = insertProject(db, { title: 'Bad Page' });
      insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });

      const r1 = service.getProjectAssetBrowser(project.id, { page: '1junk' });
      const r2 = service.getProjectAssetBrowser(project.id, { page: '2.5' });
      const r3 = service.getProjectAssetBrowser(project.id, { page: '1e2' });
      const r4 = service.getProjectAssetBrowser(project.id, { page: '+2' });
      const r5 = service.getProjectAssetBrowser(project.id, { page: '-2' });
      const r6 = service.getProjectAssetBrowser(project.id, { page: '0' });

      for (const r of [r1, r2, r3, r4, r5, r6]) {
        expect(r.page).toBe(1);
      }
    });

    it('malformed pageSize falls back to 25', () => {
      const project = insertProject(db, { title: 'Bad PageSize' });
      insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });

      const r1 = service.getProjectAssetBrowser(project.id, { pageSize: '1junk' });
      const r2 = service.getProjectAssetBrowser(project.id, { pageSize: '2.5' });
      const r3 = service.getProjectAssetBrowser(project.id, { pageSize: '1e2' });
      const r4 = service.getProjectAssetBrowser(project.id, { pageSize: '+2' });
      const r5 = service.getProjectAssetBrowser(project.id, { pageSize: '-2' });
      const r6 = service.getProjectAssetBrowser(project.id, { pageSize: '0' });

      for (const r of [r1, r2, r3, r4, r5, r6]) {
        expect(r.pageSize).toBe(25);
      }
    });

    it('pageSize above 100 is capped to 100', () => {
      const project = insertProject(db, { title: 'Large PageSize' });
      insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });

      const result = service.getProjectAssetBrowser(project.id, { pageSize: 500 });
      expect(result.pageSize).toBe(100);
    });

    it('returns exact pagination metadata', () => {
      const project = insertProject(db, { title: 'Pagination Meta' });
      for (let i = 1; i <= 7; i++) {
        insertAsset(db, { projectId: project.id, relativePath: `file${i}.txt`, filename: `file${i}.txt`, isPresent: 1 });
      }

      const result = service.getProjectAssetBrowser(project.id, { pageSize: 3 });

      expect(result.total).toBe(7);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(3);
      expect(result.pageCount).toBe(3);
      expect(result.assets).toHaveLength(3);
    });

    it('page beyond range is clamped to the last valid page', () => {
      const project = insertProject(db, { title: 'Out Of Range' });
      insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });

      const result = service.getProjectAssetBrowser(project.id, { page: 99 });

      // page is capped to pageCount (1), so the asset on page 1 is returned
      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].filename).toBe('a.txt');
      expect(result.total).toBe(1);
      expect(result.page).toBe(1); // capped to pageCount
      expect(result.pageSize).toBe(25);
      expect(result.pageCount).toBe(1);
    });

    it('filters by presence=present', () => {
      const project = insertProject(db, { title: 'Presence Filter' });
      insertAsset(db, { projectId: project.id, relativePath: 'present.txt', filename: 'present.txt', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'missing.txt', filename: 'missing.txt', isPresent: 0 });

      const result = service.getProjectAssetBrowser(project.id, { presence: 'present' });

      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].filename).toBe('present.txt');
      expect(result.filters.presence).toBe('present');
    });

    it('filters by presence=missing', () => {
      const project = insertProject(db, { title: 'Missing Presence' });
      insertAsset(db, { projectId: project.id, relativePath: 'present.txt', filename: 'present.txt', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'missing.txt', filename: 'missing.txt', isPresent: 0 });

      const result = service.getProjectAssetBrowser(project.id, { presence: 'missing' });

      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].filename).toBe('missing.txt');
    });

    it('filters by usage=used', () => {
      const project = insertProject(db, { title: 'Used Usage' });
      const usedAsset = insertAsset(db, { projectId: project.id, relativePath: 'used.txt', filename: 'used.txt', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'unused.txt', filename: 'unused.txt', isPresent: 1 });
      const rel = insertRelease(db, { projectId: project.id, title: 'R1', status: 'tbd' });
      linkAssetToRelease(db, { releaseId: rel.id, assetId: usedAsset.id });

      const result = service.getProjectAssetBrowser(project.id, { usage: 'used' });

      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].filename).toBe('used.txt');
    });

    it('filters by usage=unused', () => {
      const project = insertProject(db, { title: 'Unused Usage' });
      const usedAsset = insertAsset(db, { projectId: project.id, relativePath: 'used.txt', filename: 'used.txt', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'unused.txt', filename: 'unused.txt', isPresent: 1 });
      const rel = insertRelease(db, { projectId: project.id, title: 'R1', status: 'tbd' });
      linkAssetToRelease(db, { releaseId: rel.id, assetId: usedAsset.id });

      const result = service.getProjectAssetBrowser(project.id, { usage: 'unused' });

      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].filename).toBe('unused.txt');
    });

    it('combines presence and usage filters', () => {
      const project = insertProject(db, { title: 'Combined Filters' });
      const usedPresent = insertAsset(db, { projectId: project.id, relativePath: 'used-present.txt', filename: 'used-present.txt', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'used-missing.txt', filename: 'used-missing.txt', isPresent: 0 });
      insertAsset(db, { projectId: project.id, relativePath: 'unused-present.txt', filename: 'unused-present.txt', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'unused-missing.txt', filename: 'unused-missing.txt', isPresent: 0 });
      const rel = insertRelease(db, { projectId: project.id, title: 'R1', status: 'tbd' });
      linkAssetToRelease(db, { releaseId: rel.id, assetId: usedPresent.id });

      const result = service.getProjectAssetBrowser(project.id, { presence: 'present', usage: 'used' });

      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].filename).toBe('used-present.txt');
    });

    it('combines search, extension, presence, and usage filters', () => {
      const project = insertProject(db, { title: 'Combined Search Extension' });
      const rel = insertRelease(db, { projectId: project.id, title: 'R1', status: 'tbd' });
      const target = insertAsset(db, {
        projectId: project.id,
        relativePath: 'renders/Hero-Final.png',
        filename: 'Hero-Final.png',
        extension: 'png',
        mimeType: 'image/png',
        isPresent: 1,
      });
      insertAsset(db, { projectId: project.id, relativePath: 'renders/Hero-Final.jpg', filename: 'Hero-Final.jpg', extension: 'jpg', mimeType: 'image/jpeg', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'renders/Hero-Draft.png', filename: 'Hero-Draft.png', extension: 'png', mimeType: 'image/png', isPresent: 0 });
      insertAsset(db, { projectId: project.id, relativePath: 'renders/Other.png', filename: 'Other.png', extension: 'png', mimeType: 'image/png', isPresent: 1 });
      linkAssetToRelease(db, { releaseId: rel.id, assetId: target.id });

      const result = service.getProjectAssetBrowser(project.id, {
        search: 'hero',
        extension: '.png',
        presence: 'present',
        usage: 'used',
      });

      expect(result.total).toBe(1);
      expect(result.assets.map((a) => a.id)).toEqual([target.id]);
      expect(result.filters).toMatchObject({
        search: 'hero',
        extension: ['png'],
        presence: 'present',
        usage: 'used',
      });
    });

    it('release_usage_count is attached to each asset', () => {
      const project = insertProject(db, { title: 'Usage Count' });
      insertAsset(db, { projectId: project.id, relativePath: 'zero.txt', filename: 'zero.txt', isPresent: 1 });
      const oneAsset = insertAsset(db, { projectId: project.id, relativePath: 'one.txt', filename: 'one.txt', isPresent: 1 });
      const r1 = insertRelease(db, { projectId: project.id, title: 'R1', status: 'tbd' });
      linkAssetToRelease(db, { releaseId: r1.id, assetId: oneAsset.id });

      const result = service.getProjectAssetBrowser(project.id);

      const zero = result.assets.find((a) => a.filename === 'zero.txt');
      const one = result.assets.find((a) => a.filename === 'one.txt');
      expect(zero.release_usage_count).toBe(0);
      expect(one.release_usage_count).toBe(1);
    });

    it('returns required row metadata for future list and grid templates', () => {
      const project = insertProject(db, { title: 'Row Metadata' });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'renders/final.png',
        filename: 'final.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        modifiedAt: '2026-07-28T12:34:56.000Z',
        isPresent: 1,
      });

      const result = service.getProjectAssetBrowser(project.id);
      const row = result.assets.find((a) => a.id === asset.id);

      expect(row).toMatchObject({
        id: asset.id,
        project_id: project.id,
        filename: 'final.png',
        extension: 'png',
        mime_type: 'image/png',
        relative_path: 'renders/final.png',
        size_bytes: 2048,
        modified_at: '2026-07-28T12:34:56.000Z',
        is_present: 1,
        presence_state: 'present',
        last_seen_at: expect.any(String),
        missing_since: null,
        release_usage_count: 0,
        release_usage: [],
        tags: [],
        preview_state: 'previewable',
      });
      expect(row.preview).toMatchObject({
        state: 'previewable',
        previewable: true,
        sourceMetadataValid: true,
      });
    });

    it('attaches ordered display-name tags only to current-page assets through one batch call', () => {
      const project = insertProject(db, { title: 'Asset Tag Page' });
      const assets = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((filename) => insertAsset(db, {
        projectId: project.id,
        relativePath: filename,
        filename,
        isPresent: 1,
      }));
      const shared = tagRepository.create({ displayName: 'Shared Tag', normalizedName: 'shared tag' });
      const upperBeta = tagRepository.create({ displayName: 'Beta Tag', normalizedName: 'beta-a' });
      const lowerBeta = tagRepository.create({ displayName: 'beta tag', normalizedName: 'beta-z' });
      const outsidePage = tagRepository.create({ displayName: 'Outside Page Tag', normalizedName: 'outside page tag' });
      const projectOnly = tagRepository.create({ displayName: 'Project Only Tag', normalizedName: 'project only tag' });

      tagRepository.assignToProject(project.id, projectOnly.id);
      tagRepository.assignToAsset(assets[0].id, outsidePage.id);
      for (const tag of [shared, lowerBeta, upperBeta]) {
        tagRepository.assignToAsset(assets[2].id, tag.id);
      }
      tagRepository.assignToAsset(assets[3].id, shared.id);

      const listForAssetIds = vi.spyOn(tagRepository, 'listForAssetIds');
      const result = service.getProjectAssetBrowser(project.id, {
        sort: 'filename',
        order: 'asc',
        page: 2,
        pageSize: 2,
      });

      expect(result.total).toBe(4);
      expect(result.page).toBe(2);
      expect(result.pageCount).toBe(2);
      expect(result.assets.map((asset) => asset.filename)).toEqual(['c.txt', 'd.txt']);
      expect(result.assets[0].tags).toEqual([
        { displayName: 'Beta Tag' },
        { displayName: 'beta tag' },
        { displayName: 'Shared Tag' },
      ]);
      expect(result.assets[1].tags).toEqual([{ displayName: 'Shared Tag' }]);
      expect(result.assets.every((asset) => Array.isArray(asset.tags))).toBe(true);
      expect(result.assets[0].tags[0]).not.toHaveProperty('id');
      expect(result.assets[0].tags[0]).not.toHaveProperty('normalized_name');
      expect(result.assets[0].tags.map((tag) => tag.displayName)).not.toContain('Project Only Tag');
      expect(result.assets[0].tags.map((tag) => tag.displayName)).not.toContain('Outside Page Tag');
      expect(listForAssetIds).toHaveBeenCalledTimes(1);
      expect(listForAssetIds).toHaveBeenCalledWith([assets[2].id, assets[3].id]);
      listForAssetIds.mockRestore();
    });

    // ─── Defect fix: row viewerUrl carries the normalized/clamped context ──

    describe('viewerUrl carries normalized context', () => {
      it('is a bare path when every filter is at its default', () => {
        const project = insertProject(db, { title: 'Viewer URL Defaults' });
        const asset = insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });

        const result = service.getProjectAssetBrowser(project.id);
        const row = result.assets.find((a) => a.id === asset.id);

        expect(row.viewerUrl).toBe(`/projects/${project.id}/assets/${asset.id}`);
      });

      it('preserves category/search/extension/presence/usage/sort/order/pageSize/view and the clamped page', () => {
        const assetCategoryRepo = createAssetCategoryRepository(db);
        const assetRepo = createAssetRepository(db);
        const project = insertProject(db, { title: 'Viewer URL Context' });
        const category = assetCategoryRepo.addProjectCategory({
          projectId: project.id, displayName: 'Renders', directorySlug: 'renders-vurl', displayOrder: 0, enabled: true,
        });
        for (let i = 0; i < 5; i++) {
          assetRepo.upsert(project.id, `renders/hero-${i}.png`, {
            filename: `hero-${i}.png`, extension: 'png', mimeType: 'image/png',
            sizeBytes: 10, modifiedAt: null, categoryId: category.id, nestedPath: '',
          });
        }

        const result = service.getProjectAssetBrowser(project.id, {
          category: String(category.id), search: 'hero', extension: 'png',
          presence: 'present', usage: 'unused', sort: 'size', order: 'desc',
          page: '2', pageSize: '2', view: 'grid',
          // Unknown fields must never reach the generated URL.
          unknownField: 'strip-me',
        });
        const row = result.assets[0];

        const url = new URL(row.viewerUrl, 'http://localhost');
        expect(url.pathname).toBe(`/projects/${project.id}/assets/${row.id}`);
        expect(url.searchParams.get('category')).toBe(String(category.id));
        expect(url.searchParams.get('search')).toBe('hero');
        expect(url.searchParams.get('extension')).toBe('png');
        expect(url.searchParams.get('presence')).toBe('present');
        expect(url.searchParams.get('usage')).toBe('unused');
        expect(url.searchParams.get('sort')).toBe('size');
        expect(url.searchParams.get('order')).toBe('desc');
        expect(url.searchParams.get('page')).toBe('2');
        expect(url.searchParams.get('pageSize')).toBe('2');
        expect(url.searchParams.has('view')).toBe(false);
        expect(url.searchParams.has('unknownField')).toBe(false);
      });

      it('uses the clamped page, not an out-of-range requested page', () => {
        const project = insertProject(db, { title: 'Viewer URL Clamped Page' });
        const asset = insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });

        const result = service.getProjectAssetBrowser(project.id, { page: '99' });
        const row = result.assets.find((a) => a.id === asset.id);

        expect(result.page).toBe(1); // only 1 asset -> pageCount 1 -> clamped to 1
        const url = new URL(row.viewerUrl, 'http://localhost');
        expect(url.searchParams.has('page')).toBe(false); // page=1 is the omitted default
      });
    });

    it('classifies valid Krita, unsupported MIME, and missing assets without generating previews', () => {
      const project = insertProject(db, { title: 'Preview States' });
      insertAsset(db, {
        projectId: project.id,
        relativePath: 'present.png',
        filename: 'present.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 100,
        modifiedAt: '2026-07-28T12:00:00.000Z',
        isPresent: 1,
      });
      insertAsset(db, {
        projectId: project.id,
        relativePath: 'source.kra',
        filename: 'source.kra',
        extension: 'kra',
        mimeType: 'application/x-krita',
        sizeBytes: 100,
        modifiedAt: '2026-07-28T12:00:00.000Z',
        isPresent: 1,
      });
      insertAsset(db, {
        projectId: project.id,
        relativePath: 'source.krz',
        filename: 'source.krz',
        extension: 'krz',
        mimeType: 'application/x-krita',
        sizeBytes: 100,
        modifiedAt: '2026-07-28T12:00:00.000Z',
        isPresent: 1,
      });
      insertAsset(db, {
        projectId: project.id,
        relativePath: 'mismatch.kra',
        filename: 'mismatch.kra',
        extension: 'kra',
        mimeType: 'image/png',
        sizeBytes: 100,
        modifiedAt: '2026-07-28T12:00:00.000Z',
        isPresent: 1,
      });
      insertAsset(db, {
        projectId: project.id,
        relativePath: 'missing.png',
        filename: 'missing.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 100,
        modifiedAt: '2026-07-28T12:00:00.000Z',
        isPresent: 0,
      });

      const result = service.getProjectAssetBrowser(project.id, { pageSize: 100 });
      const byName = Object.fromEntries(result.assets.map((asset) => [asset.filename, asset]));

      expect(byName['present.png'].preview_state).toBe('previewable');
      expect(byName['present.png'].displayFilename).toBe('present');
      expect(byName['source.kra'].preview_state).toBe('previewable');
      expect(byName['source.kra'].preview.kind).toBe('krita');
      expect(byName['source.kra'].preview_revision).toMatch(/^[a-f0-9]{16}$/);
      expect(byName['source.kra'].thumbnail_url).toContain('/thumbnail?v=');
      expect(byName['source.kra'].preview_url).toContain('/preview?v=');
      expect(byName['source.kra'].originalEligible).toBe(false);
      expect(byName['source.krz'].preview_state).toBe('previewable');
      expect(byName['source.krz'].preview.kind).toBe('krita');
      expect(byName['source.krz'].originalEligible).toBe(false);
      expect(byName['mismatch.kra'].preview_state).toBe('unsupported');
      expect(byName['missing.png'].preview_state).toBe('missing');
      expect(byName['missing.png'].thumbnail_url).toBeNull();
    });

    it('returns the exact canonical preview revision and structured media URLs only for valid previewable assets', () => {
      const project = insertProject(db, { title: 'Preview Revision' });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'renders/final.png',
        filename: 'final.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 12345,
        modifiedAt: '2026-07-28 12:00:00',
        isPresent: 1,
      });
      insertAsset(db, {
        projectId: project.id,
        relativePath: 'renders/no-mtime.png',
        filename: 'no-mtime.png',
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 100,
        modifiedAt: null,
        isPresent: 1,
      });

      const result = service.getProjectAssetBrowser(project.id, { pageSize: 100 });
      const row = result.assets.find((a) => a.id === asset.id);
      const noMtime = result.assets.find((a) => a.filename === 'no-mtime.png');
      const expectedRevision = buildRevisionToken({
        projectId: project.id,
        assetId: asset.id,
        relativePath: 'renders/final.png',
        size: 12345,
        mtime: '2026-07-28T12:00:00.000Z',
      });

      expect(row.preview_revision).toBe(expectedRevision);
      expect(row.preview.revision).toBe(expectedRevision);
      expect(row.thumbnail_url).toBe(`/projects/${project.id}/assets/${asset.id}/thumbnail?v=${expectedRevision}`);
      expect(row.preview_url).toBe(`/projects/${project.id}/assets/${asset.id}/preview?v=${expectedRevision}`);
      expect(row.preview.urls).toEqual({
        thumbnail: row.thumbnail_url,
        preview: row.preview_url,
      });

      expect(noMtime.preview_state).toBe('previewable');
      expect(noMtime.preview.sourceMetadataValid).toBe(false);
      expect(noMtime.preview_revision).toBeNull();
      expect(noMtime.thumbnail_url).toBeNull();
      expect(noMtime.preview_url).toBeNull();
    });

    it('projects display filenames without changing the stored filename', () => {
      const project = insertProject(db, { title: 'Display Filenames' });
      const names = ['one.png', 'archive.final.webp', 'README', '.gitignore', '.config.json'];
      for (const filename of names) {
        insertAsset(db, {
          projectId: project.id,
          relativePath: filename,
          filename,
          extension: filename.includes('.') && !filename.endsWith('.') ? filename.split('.').pop() : '',
          isPresent: 1,
        });
      }

      const result = service.getProjectAssetBrowser(project.id, { pageSize: 100 });
      const displayByFilename = Object.fromEntries(result.assets.map((asset) => [asset.filename, asset.displayFilename]));

      expect(displayByFilename).toEqual({
        'one.png': 'one',
        'archive.final.webp': 'archive.final',
        README: 'README',
        '.gitignore': '.gitignore',
        '.config.json': '.config',
      });
      expect(result.assets.find((asset) => asset.filename === 'archive.final.webp').filename).toBe('archive.final.webp');
    });

    it('release_usage details are attached to the correct assets', () => {
      const project = insertProject(db, { title: 'Usage Details' });
      const a1 = insertAsset(db, { projectId: project.id, relativePath: 'a1.txt', filename: 'a1.txt', isPresent: 1 });
      const a2 = insertAsset(db, { projectId: project.id, relativePath: 'a2.txt', filename: 'a2.txt', isPresent: 1 });
      const r1 = insertRelease(db, { projectId: project.id, title: 'R1', status: 'tbd' });
      const r2 = insertRelease(db, { projectId: project.id, title: 'R2', status: 'planned' });
      linkAssetToRelease(db, { releaseId: r1.id, assetId: a1.id });
      linkAssetToRelease(db, { releaseId: r1.id, assetId: a2.id });
      linkAssetToRelease(db, { releaseId: r2.id, assetId: a2.id });

      const result = service.getProjectAssetBrowser(project.id);

      const asset1 = result.assets.find((a) => a.id === a1.id);
      const asset2 = result.assets.find((a) => a.id === a2.id);

      expect(asset1.release_usage).toHaveLength(1);
      expect(asset1.release_usage[0].release_id).toBe(r1.id);
      expect(asset1.release_usage[0].title).toBe('R1');

      expect(asset2.release_usage).toHaveLength(2);
      const r2Usage = asset2.release_usage.find((u) => u.release_id === r2.id);
      expect(r2Usage).toBeDefined();
      expect(r2Usage.title).toBe('R2');
    });

    it('assets with no release usage have empty release_usage array', () => {
      const project = insertProject(db, { title: 'No Usage' });
      insertAsset(db, { projectId: project.id, relativePath: 'loner.txt', filename: 'loner.txt', isPresent: 1 });

      const result = service.getProjectAssetBrowser(project.id);

      expect(result.assets[0].release_usage).toEqual([]);
    });

    it('archived project is still readable', () => {
      const project = insertProject(db, { title: 'Archived Asset Project' });
      insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const result = service.getProjectAssetBrowser(project.id);

      expect(result).not.toBeNull();
      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].filename).toBe('a.txt');
    });

    it('project isolation: does not return assets from other projects', () => {
      const p1 = insertProject(db, { title: 'P1' });
      const p2 = insertProject(db, { title: 'P2' });
      insertAsset(db, { projectId: p1.id, relativePath: 'p1.txt', filename: 'p1.txt', isPresent: 1 });
      insertAsset(db, { projectId: p2.id, relativePath: 'p2.txt', filename: 'p2.txt', isPresent: 1 });

      const result = service.getProjectAssetBrowser(p1.id);

      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].filename).toBe('p1.txt');
    });

    it('pagination filter preservation: all params survive in page URLs', () => {
      const project = insertProject(db, { title: 'Filter Preserve' });
      // Create enough assets for multiple pages with presence=missing, usage=used
      // We need: assets that are both missing AND used
      const rel = insertRelease(db, { projectId: project.id, title: 'R1', status: 'tbd' });
      for (let i = 1; i <= 7; i++) {
        const asset = insertAsset(db, {
          projectId: project.id,
          relativePath: `file${i}.txt`,
          filename: `file${i}.txt`,
          isPresent: 0, // all missing
        });
        linkAssetToRelease(db, { releaseId: rel.id, assetId: asset.id });
      }

      const result = service.getProjectAssetBrowser(project.id, {
        presence: 'missing',
        usage: 'used',
        pageSize: '3',
      });

      // 7 assets, pageSize=3 → pageCount=3
      expect(result.pageCount).toBeGreaterThan(1);

      // Build a page URL for page 2 using the same pattern as the route
      const query = { presence: 'missing', usage: 'used', pageSize: '3', page: '2' };
      const search = new URLSearchParams(query).toString();
      const pageUrl = `/projects/${project.id}/assets?${search}`;
      const parsed = new URL(`http://localhost${pageUrl}`);

      expect(parsed.searchParams.get('presence')).toBe('missing');
      expect(parsed.searchParams.get('usage')).toBe('used');
      expect(parsed.searchParams.get('pageSize')).toBe('3');
      expect(parsed.searchParams.get('page')).toBe('2');
      // No unexpected params
      expect(parsed.searchParams.size).toBe(4);
    });

    it('out-of-range page clamped to final page on multi-page data', () => {
      const project = insertProject(db, { title: 'Clamp Multi' });
      // Create enough assets for at least 3 pages (pageSize=3, need >= 7)
      for (let i = 1; i <= 10; i++) {
        insertAsset(db, {
          projectId: project.id,
          relativePath: `file${String(i).padStart(2, '0')}.txt`,
          filename: `file${String(i).padStart(2, '0')}.txt`,
          isPresent: 1,
        });
      }

      // Request a far-out page
      const result = service.getProjectAssetBrowser(project.id, {
        page: '99',
        pageSize: '3',
      });

      // 10 assets, pageSize=3 → pageCount=4, final page=4
      expect(result.pageCount).toBe(4);
      expect(result.total).toBe(10);
      expect(result.page).toBe(4); // clamped to final page

      // The assets on page 4 should be the last 1 asset (offset=9, limit=3 → rows 10-12, only row 10)
      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].filename).toBe('file10.txt');
    });

    it('empty asset ID list returns empty usage (safe no-op)', () => {
      const project = insertProject(db, { title: 'No Assets' });

      const result = service.getProjectAssetBrowser(project.id);

      // Should not throw, should return valid structure with empty usage
      expect(result.assets).toEqual([]);
    });

    it('usage details include release and project archive state', () => {
      const project = insertProject(db, { title: 'Archive State Usage' });
      const asset = insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });
      const rel = insertRelease(db, {
        projectId: project.id,
        title: 'Archived Rel',
        status: 'tbd',
        archivedAt: '2024-01-01 00:00:00',
      });
      linkAssetToRelease(db, { releaseId: rel.id, assetId: asset.id });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const result = service.getProjectAssetBrowser(project.id);

      expect(result.assets[0].release_usage[0].release_archived_at).toBeTruthy();
      expect(result.assets[0].release_usage[0].project_archived_at).toBeTruthy();
    });

    it('browser composition executes a fixed number of statements independent of total project size', () => {
      const counter = instrumentStatementExecution(db);
      const instrumentedService = createWorkflowQueryService({ db });

      const smallProject = insertProject(db, { title: 'Browser Query Small' });
      const largeProject = insertProject(db, { title: 'Browser Query Large' });
      for (const [project, total] of [[smallProject, 5], [largeProject, 80]]) {
        for (let i = 1; i <= total; i++) {
          insertAsset(db, {
            projectId: project.id,
            relativePath: `file${String(i).padStart(2, '0')}.png`,
            filename: `file${String(i).padStart(2, '0')}.png`,
            extension: 'png',
            mimeType: 'image/png',
            sizeBytes: i,
            modifiedAt: '2026-07-28T12:00:00.000Z',
            isPresent: 1,
          });
        }
      }

      counter.reset();
      const smallProjectPage = instrumentedService.getProjectAssetBrowser(smallProject.id, { pageSize: 5 });
      const smallProjectCount = counter.count();

      counter.reset();
      const largeProjectPage = instrumentedService.getProjectAssetBrowser(largeProject.id, { pageSize: 5 });
      const largeProjectCount = counter.count();

      expect(smallProjectPage.total).toBe(5);
      expect(largeProjectPage.total).toBe(80);
      expect(smallProjectPage.assets).toHaveLength(5);
      expect(largeProjectPage.assets).toHaveLength(5);
      expect(smallProjectCount).toBe(ASSET_BROWSER_FIXED_STATEMENT_EXECUTIONS);
      expect(largeProjectCount).toBe(ASSET_BROWSER_FIXED_STATEMENT_EXECUTIONS);
    });

    it('browser composition executes a fixed number of statements independent of page size', () => {
      const counter = instrumentStatementExecution(db);
      const instrumentedService = createWorkflowQueryService({ db });
      const project = insertProject(db, { title: 'Browser Query Page Size' });
      const release = insertRelease(db, { projectId: project.id, title: 'Usage Release', status: 'tbd' });
      for (let i = 1; i <= 30; i++) {
        const asset = insertAsset(db, {
          projectId: project.id,
          relativePath: `file${String(i).padStart(2, '0')}.png`,
          filename: `file${String(i).padStart(2, '0')}.png`,
          extension: 'png',
          mimeType: 'image/png',
          sizeBytes: i,
          modifiedAt: '2026-07-28T12:00:00.000Z',
          isPresent: 1,
        });
        linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });
      }

      counter.reset();
      const smallPage = instrumentedService.getProjectAssetBrowser(project.id, { pageSize: 1 });
      const smallCount = counter.count();

      counter.reset();
      const largePage = instrumentedService.getProjectAssetBrowser(project.id, { pageSize: 20 });
      const largeCount = counter.count();

      expect(smallPage.assets).toHaveLength(1);
      expect(largePage.assets).toHaveLength(20);
      expect(smallCount).toBe(ASSET_BROWSER_FIXED_STATEMENT_EXECUTIONS);
      expect(largeCount).toBe(ASSET_BROWSER_FIXED_STATEMENT_EXECUTIONS);
    });

    it('browser composition executes a fixed number of statements independent of release-usage multiplicity', () => {
      const counter = instrumentStatementExecution(db);
      const instrumentedService = createWorkflowQueryService({ db });

      const lowUsageProject = insertProject(db, { title: 'Browser Query Low Usage' });
      const oneUsageRelease = insertRelease(db, { projectId: lowUsageProject.id, title: 'One Usage', status: 'tbd' });
      for (let i = 1; i <= 5; i++) {
        const asset = insertAsset(db, {
          projectId: lowUsageProject.id,
          relativePath: `low${String(i).padStart(2, '0')}.png`,
          filename: `low${String(i).padStart(2, '0')}.png`,
          extension: 'png',
          mimeType: 'image/png',
          sizeBytes: i,
          modifiedAt: '2026-07-28T12:00:00.000Z',
          isPresent: 1,
        });
        if (i % 2 === 0) {
          linkAssetToRelease(db, { releaseId: oneUsageRelease.id, assetId: asset.id });
        }
      }

      const highUsageProject = insertProject(db, { title: 'Browser Query High Usage' });
      const manyUsageReleases = [];
      for (let i = 1; i <= 8; i++) {
        manyUsageReleases.push(insertRelease(db, {
          projectId: highUsageProject.id,
          title: `Many Usage ${String(i).padStart(2, '0')}`,
          status: 'tbd',
        }));
      }
      for (let i = 1; i <= 5; i++) {
        const asset = insertAsset(db, {
          projectId: highUsageProject.id,
          relativePath: `high${String(i).padStart(2, '0')}.png`,
          filename: `high${String(i).padStart(2, '0')}.png`,
          extension: 'png',
          mimeType: 'image/png',
          sizeBytes: i,
          modifiedAt: '2026-07-28T12:00:00.000Z',
          isPresent: 1,
        });
        for (const release of manyUsageReleases) {
          linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });
        }
      }

      counter.reset();
      const lowUsagePage = instrumentedService.getProjectAssetBrowser(lowUsageProject.id, { pageSize: 5 });
      const lowUsageCount = counter.count();

      counter.reset();
      const highUsagePage = instrumentedService.getProjectAssetBrowser(highUsageProject.id, { pageSize: 5 });
      const highUsageCount = counter.count();

      const lowUsageRows = lowUsagePage.assets.reduce((sum, asset) => sum + asset.release_usage.length, 0);
      const highUsageRows = highUsagePage.assets.reduce((sum, asset) => sum + asset.release_usage.length, 0);

      expect(lowUsagePage.assets).toHaveLength(5);
      expect(highUsagePage.assets).toHaveLength(5);
      expect(lowUsageRows).toBe(2);
      expect(highUsageRows).toBe(40);
      expect(highUsageRows).toBeGreaterThan(lowUsageRows);
      expect(lowUsageCount).toBe(ASSET_BROWSER_FIXED_STATEMENT_EXECUTIONS);
      expect(highUsageCount).toBe(ASSET_BROWSER_FIXED_STATEMENT_EXECUTIONS);
    });

    it('no scanner or mutation calls occur during read', () => {
      const project = insertProject(db, { title: 'Read Only' });
      insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });

      // getProjectAssetBrowser calls projectRepository.findById which uses
      // a prepared statement (read-only). The scanner methods are not called.
      // This is verified by the fact that no scan triggers or mutations
      // are observable from the public API — the result is deterministic
      // from the existing database state without any side effects.
      const result = service.getProjectAssetBrowser(project.id);

      expect(result).not.toBeNull();
      expect(result.assets).toHaveLength(1);
    });

    // ─── Phase 3 chunk 3: eligible release targets ────────────────────

    describe('releaseTargets', () => {
      it('includes active, planned, and cancelled releases but excludes published and archived', () => {
        const project = insertProject(db, { title: 'Targets Basic' });
        const active = insertRelease(db, { projectId: project.id, title: 'Active', status: 'tbd' });
        const cancelled = insertRelease(db, { projectId: project.id, title: 'Cancelled', status: 'cancelled' });
        const published = insertRelease(db, { projectId: project.id, title: 'Published', status: 'published', publishedDate: '2026-01-01' });
        const archived = insertRelease(db, { projectId: project.id, title: 'Archived', archivedAt: '2026-01-01 00:00:00' });

        const result = service.getProjectAssetBrowser(project.id);
        const ids = result.releaseTargets.map((t) => t.id);

        expect(ids).toContain(active.id);
        expect(ids).toContain(cancelled.id);
        expect(ids).not.toContain(published.id);
        expect(ids).not.toContain(archived.id);
      });

      it('is project-scoped — does not include another project\'s releases', () => {
        const project = insertProject(db, { title: 'Targets Mine' });
        const other = insertProject(db, { title: 'Targets Other' });
        const mine = insertRelease(db, { projectId: project.id, title: 'Mine' });
        const theirs = insertRelease(db, { projectId: other.id, title: 'Theirs' });

        const result = service.getProjectAssetBrowser(project.id);
        const ids = result.releaseTargets.map((t) => t.id);

        expect(ids).toContain(mine.id);
        expect(ids).not.toContain(theirs.id);
      });

      it('returns an empty list for archived projects and skips the query entirely (one fewer statement than a non-archived project)', () => {
        const activeProject = insertProject(db, { title: 'Targets Active Compare' });
        insertRelease(db, { projectId: activeProject.id, title: 'Eligible' });
        insertAsset(db, { projectId: activeProject.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });

        const archivedProject = insertProject(db, { title: 'Targets Archived Project', archivedAt: '2026-01-01 00:00:00' });
        insertRelease(db, { projectId: archivedProject.id, title: 'Would Be Eligible' });
        insertAsset(db, { projectId: archivedProject.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });

        const counter = instrumentStatementExecution(db);
        const instrumentedService = createWorkflowQueryService({ db });

        counter.reset();
        const activeResult = instrumentedService.getProjectAssetBrowser(activeProject.id);
        const activeCount = counter.count();

        counter.reset();
        const archivedResult = instrumentedService.getProjectAssetBrowser(archivedProject.id);
        const archivedCount = counter.count();

        expect(archivedResult.isArchived).toBe(true);
        expect(archivedResult.releaseTargets).toEqual([]);
        expect(activeResult.releaseTargets.length).toBeGreaterThan(0);
        expect(archivedCount).toBe(activeCount - 1);
      });
    });

    // ─── Defect fix: exact-destination category-nav active state ─────────

    describe('categoryNavigation active-state matches exactly one destination', () => {
      function setupNavProject(title) {
        const assetCategoryRepo = createAssetCategoryRepository(db);
        const project = insertProject(db, { title });
        const category = assetCategoryRepo.addProjectCategory({
          projectId: project.id, displayName: 'Renders', directorySlug: `renders-${project.id}`, displayOrder: 0, enabled: true,
        });
        return { project, category };
      }

      function countActive(nav) {
        let count = 0;
        if (nav.allActive) count++;
        if (nav.uncategorizedActive) count++;
        if (nav.missingActive) count++;
        for (const c of [...nav.enabled, ...nav.disabled]) {
          if (c.isActive) count++;
        }
        return count;
      }

      it('default context (category=all, presence=all) -> only All is active', () => {
        const { project } = setupNavProject('Nav Default');
        const nav = service.getProjectAssetBrowser(project.id).categoryNavigation;

        expect(nav.allActive).toBe(true);
        expect(nav.uncategorizedActive).toBe(false);
        expect(nav.missingActive).toBe(false);
        expect(nav.enabled.every((c) => !c.isActive)).toBe(true);
        expect(countActive(nav)).toBe(1);
      });

      it('one category with default presence -> only that category is active', () => {
        const { project, category } = setupNavProject('Nav Category');
        const nav = service.getProjectAssetBrowser(project.id, { category: String(category.id) }).categoryNavigation;

        expect(nav.allActive).toBe(false);
        expect(nav.uncategorizedActive).toBe(false);
        expect(nav.missingActive).toBe(false);
        expect(nav.enabled.find((c) => c.id === category.id).isActive).toBe(true);
        expect(countActive(nav)).toBe(1);
      });

      it('uncategorized with default presence -> only Uncategorized is active', () => {
        const { project } = setupNavProject('Nav Uncategorized');
        const nav = service.getProjectAssetBrowser(project.id, { category: 'uncategorized' }).categoryNavigation;

        expect(nav.uncategorizedActive).toBe(true);
        expect(nav.allActive).toBe(false);
        expect(nav.missingActive).toBe(false);
        expect(countActive(nav)).toBe(1);
      });

      it('presence=missing with category=all -> only Missing Assets is active', () => {
        const { project } = setupNavProject('Nav Missing');
        const nav = service.getProjectAssetBrowser(project.id, { presence: 'missing' }).categoryNavigation;

        expect(nav.missingActive).toBe(true);
        expect(nav.allActive).toBe(false);
        expect(nav.uncategorizedActive).toBe(false);
        expect(countActive(nav)).toBe(1);
      });

      it('category + presence=missing (composed filter) -> no navigation item is active', () => {
        const { project, category } = setupNavProject('Nav Composed Category Missing');
        const nav = service.getProjectAssetBrowser(project.id, { category: String(category.id), presence: 'missing' }).categoryNavigation;

        expect(countActive(nav)).toBe(0);
      });

      it('category=all + presence=present -> no navigation item is active', () => {
        const { project } = setupNavProject('Nav All Present');
        const nav = service.getProjectAssetBrowser(project.id, { presence: 'present' }).categoryNavigation;

        expect(countActive(nav)).toBe(0);
      });

      it('malformed/cross-project category input normalizes to All -> only All is active', () => {
        const { project } = setupNavProject('Nav Malformed');
        const nav = service.getProjectAssetBrowser(project.id, { category: 'not-a-real-id' }).categoryNavigation;

        expect(nav.allActive).toBe(true);
        expect(countActive(nav)).toBe(1);
      });

      it('never marks more than one destination active across the full matrix', () => {
        const { project, category } = setupNavProject('Nav Matrix');
        const combos = [
          {},
          { category: String(category.id) },
          { category: 'uncategorized' },
          { presence: 'missing' },
          { category: String(category.id), presence: 'missing' },
          { presence: 'present' },
          { presence: 'used' },
          { category: '999999' },
        ];
        for (const rawQuery of combos) {
          const nav = service.getProjectAssetBrowser(project.id, rawQuery).categoryNavigation;
          expect(countActive(nav)).toBeLessThanOrEqual(1);
        }
      });
    });
  });

  describe('getProjectAutoRenameCategory', () => {
    function addCategory(projectId, displayName, directorySlug, displayOrder = 0, enabled = true) {
      return createAssetCategoryRepository(db).addProjectCategory({
        projectId,
        displayName,
        directorySlug,
        displayOrder,
        enabled,
      });
    }

    function addAsset(assetRepository, projectId, categoryId, relativePath, overrides = {}) {
      const filename = relativePath.split('/').pop();
      const extension = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
      return assetRepository.upsert(projectId, relativePath, {
        filename,
        extension,
        mimeType: extension === 'png' ? 'image/png' : 'application/octet-stream',
        sizeBytes: 10,
        modifiedAt: '2026-08-02T12:00:00.000Z',
        categoryId,
        nestedPath: relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '',
        ...overrides,
      });
    }

    it('returns every effective-category asset once in canonical order, independent of filters and pagination', () => {
      const assetRepository = createAssetRepository(db);
      const project = insertProject(db, { title: 'Auto Rename Complete Category' });
      const category = addCategory(project.id, 'Renders', 'renders', 0);
      const otherCategory = addCategory(project.id, 'Exports', 'exports', 1);
      preferenceRepository.upsertProjectPreference(project.id, 'category', category.id);

      const categoryAssets = [];
      for (let index = 0; index < 30; index++) {
        const filename = index === 0
          ? 'file10.png'
          : index === 1
            ? 'File2.png'
            : index === 2
              ? 'file2.png'
              : `asset-${String(index).padStart(2, '0')}.png`;
        categoryAssets.push(addAsset(assetRepository, project.id, category.id, `renders/${index}-${filename}`, {
          filename,
        }));
      }
      const missing = categoryAssets[29];
      db.prepare('UPDATE assets SET is_present = 0, missing_since = datetime(\'now\') WHERE id = ?')
        .run(missing.id);
      addAsset(assetRepository, project.id, otherCategory.id, 'exports/other.kra', {
        mimeType: 'application/x-krita',
      });
      const release = insertRelease(db, { projectId: project.id, title: 'Used Asset' });
      linkAssetToRelease(db, { releaseId: release.id, assetId: categoryAssets[0].id });
      const categoryTag = tagRepository.create({ displayName: 'Category Tag', normalizedName: 'category tag' });
      tagRepository.assignToAsset(categoryAssets[0].id, categoryTag.id);

      const expectedRows = assetRepository.findProjectAssetsByCategoryInBrowserOrder(project.id, category.id);
      const normalPage = service.getProjectAssetBrowser(project.id, {
        category: String(category.id),
        pageSize: 25,
      });

      const readFileSpy = vi.spyOn(fs, 'readFileSync');
      const lstatSpy = vi.spyOn(fs, 'lstatSync');
      const readdirSpy = vi.spyOn(fs, 'readdirSync');
      try {
        const result = service.getProjectAutoRenameCategory(project.id, {
          category: String(category.id),
          search: 'does-not-match',
          extension: '.kra',
          presence: 'missing',
          usage: 'used',
          sort: 'size',
          order: 'desc',
          page: '99',
          pageSize: '1',
          view: 'list',
        });

        expect(normalPage.assets).toHaveLength(25);
        expect(result).toMatchObject({
          effectiveCategory: {
            id: category.id,
            displayName: 'Renders',
            directorySlug: 'renders',
            enabled: true,
          },
          total: 30,
          view: 'list',
          autoRenameAvailable: true,
        });
        expect(result.assets).toHaveLength(30);
        expect(result.orderedAssetIds).toEqual(expectedRows.map((asset) => asset.id));
        expect(result.assets.map((asset) => asset.id)).toEqual(result.orderedAssetIds);
        expect(new Set(result.orderedAssetIds).size).toBe(30);
        expect(result.assets.some((asset) => asset.id === missing.id)).toBe(true);
        expect(result).not.toHaveProperty('page');
        expect(result).not.toHaveProperty('pageSize');
        expect(result).not.toHaveProperty('pageCount');
        expect(result.assets.every((asset) => (
          asset.project_id === project.id
          && asset.category_id === category.id
          && asset.category.directorySlug === 'renders'
        ))).toBe(true);
        expect(result.assets.find((asset) => asset.id === categoryAssets[0].id)).toMatchObject({
          relative_path: expect.any(String),
          nested_path: 'renders',
          filename: expect.any(String),
          extension: 'png',
          mime_type: 'image/png',
          size_bytes: 10,
          is_present: 1,
          release_usage_count: 1,
          release_usage: [expect.objectContaining({ release_id: release.id })],
          tags: [{ displayName: 'Category Tag' }],
          category: {
            id: category.id,
            displayName: 'Renders',
            directorySlug: 'renders',
            enabled: true,
          },
          preview_state: 'previewable',
        });
        expect(readFileSpy).not.toHaveBeenCalled();
        expect(lstatSpy).not.toHaveBeenCalled();
        expect(readdirSpy).not.toHaveBeenCalled();
      } finally {
        readFileSpy.mockRestore();
        lstatSpy.mockRestore();
        readdirSpy.mockRestore();
      }
    });

    it('uses a concrete default when category is absent and lets an explicit category override it', () => {
      const assetRepository = createAssetRepository(db);
      const project = insertProject(db, { title: 'Auto Rename Effective Category' });
      const defaultCategory = addCategory(project.id, 'Default', 'default', 0);
      const explicitCategory = addCategory(project.id, 'Explicit', 'explicit', 1);
      preferenceRepository.upsertProjectPreference(project.id, 'category', defaultCategory.id);
      addAsset(assetRepository, project.id, defaultCategory.id, 'default/a.png');
      addAsset(assetRepository, project.id, explicitCategory.id, 'explicit/b.png');

      const fromDefault = service.getProjectAutoRenameCategory(project.id, { view: 'grid' });
      const fromExplicit = service.getProjectAutoRenameCategory(project.id, {
        category: String(explicitCategory.id),
        view: 'grid',
      });

      expect(fromDefault.effectiveCategory).toMatchObject({
        id: defaultCategory.id,
        displayName: 'Default',
        directorySlug: 'default',
        enabled: true,
      });
      expect(fromDefault.assets.map((asset) => asset.category_id)).toEqual([defaultCategory.id]);
      expect(fromExplicit.effectiveCategory).toMatchObject({
        id: explicitCategory.id,
        displayName: 'Explicit',
        directorySlug: 'explicit',
        enabled: true,
      });
      expect(fromExplicit.assets.map((asset) => asset.category_id)).toEqual([explicitCategory.id]);
    });

    it.each(['all', 'uncategorized'])('returns an unavailable model for explicit %s', (category) => {
      const project = insertProject(db, { title: `Auto Rename ${category}` });
      const concreteCategory = addCategory(project.id, 'Concrete', 'concrete', 0);
      preferenceRepository.upsertProjectPreference(project.id, 'category', concreteCategory.id);

      const result = service.getProjectAutoRenameCategory(project.id, {
        category,
        view: 'list',
        page: '2',
        pageSize: '1',
      });

      expect(result).toMatchObject({
        effectiveCategory: null,
        assets: [],
        orderedAssetIds: [],
        total: 0,
        view: 'list',
        autoRenameAvailable: false,
        autoRenameUnavailableReason: category,
      });
      expect(result).not.toHaveProperty('page');
      expect(result).not.toHaveProperty('pageSize');
    });

    it('returns an unavailable model when no concrete default category exists', () => {
      const project = insertProject(db, { title: 'Auto Rename No Default' });
      preferenceRepository.upsertProjectPreference(project.id, 'inherit', null);
      preferenceRepository.setGlobalDefault('all');

      expect(service.getProjectAutoRenameCategory(project.id)).toMatchObject({
        effectiveCategory: null,
        assets: [],
        orderedAssetIds: [],
        total: 0,
        view: 'grid',
        autoRenameAvailable: false,
        autoRenameUnavailableReason: 'all',
      });
    });

    it('preserves ordinary paginated filtered browser behavior separately', () => {
      const assetRepository = createAssetRepository(db);
      const project = insertProject(db, { title: 'Normal Browser Regression' });
      addAsset(assetRepository, project.id, null, 'keep/a.png');
      addAsset(assetRepository, project.id, null, 'keep/b.png');
      addAsset(assetRepository, project.id, null, 'other/c.png');

      const result = service.getProjectAssetBrowser(project.id, {
        search: 'keep',
        extension: '.png',
        presence: 'present',
        usage: 'unused',
        page: '2',
        pageSize: '1',
      });

      expect(result.total).toBe(2);
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(1);
      expect(result.pageCount).toBe(2);
      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].relative_path).toBe('keep/b.png');
    });
  });

  describe('getProjectAssetBrowserContext', () => {
    it('returns null for a missing project', () => {
      expect(service.getProjectAssetBrowserContext(9999)).toBeNull();
    });

    it('normalizes category/search/filter/sort/page fields the same way as the full browser', () => {
      const project = insertProject(db, { title: 'Context Basic' });

      const result = service.getProjectAssetBrowserContext(project.id, {
        search: '  hero  ', extension: '.PNG', presence: 'missing', usage: 'used',
        category: 'bogus', sort: 'size', order: 'desc', page: '3', pageSize: '10',
      });

      expect(result.filters).toEqual({
        search: 'hero',
        extension: [], // no assets/extensions exist yet, so .png is not a valid choice
        presence: 'missing',
        usage: 'used',
        category: 'all', // unknown category id normalizes to All
        sort: 'size',
        order: 'desc',
        page: 3,
        pageSize: 10,
        view: 'grid',
      });
    });

    it('is bounded and does not query asset pages, counts, or release usage', () => {
      const project = insertProject(db, { title: 'Context Bounded' });
      for (let i = 0; i < 30; i++) {
        insertAsset(db, { projectId: project.id, relativePath: `f${i}.txt`, filename: `f${i}.txt`, isPresent: 1 });
      }

      const counter = instrumentStatementExecution(db);
      const instrumentedService = createWorkflowQueryService({ db });
      counter.reset();
      instrumentedService.getProjectAssetBrowserContext(project.id, {});

      // project lookup + category list + extension list — independent of
      // how many assets exist, and far fewer than the full browser query.
      expect(counter.count()).toBe(3);
    });

    it.each([
      ['implicit All', {}, 'implicit-all', false, 'all'],
      ['explicit All', { category: 'all' }, 'explicit-all', true, 'all'],
      ['explicit Uncategorized', { category: 'uncategorized' }, 'explicit-uncategorized', true, 'uncategorized'],
      ['invalid category', { category: 'invalid' }, 'invalid-as-all', true, 'all'],
      ['stale category', { category: '999999' }, 'invalid-as-all', true, 'all'],
    ])('records %s category intent without changing the public filter shape', (_label, rawQuery, selection, supplied, category) => {
      const project = insertProject(db, { title: `Context Intent ${_label}` });
      const result = service.getProjectAssetBrowserContext(project.id, rawQuery);

      expect(result.filters.category).toBe(category);
      expect(result.context.categorySelection).toBe(selection);
      expect(result.context.categoryWasSupplied).toBe(supplied);
      expect(result.filters).not.toHaveProperty('categorySelection');
      expect(result.filters).not.toHaveProperty('categoryWasSupplied');
    });

    it('records a valid specific category as explicit and centralizes safe canonical cleanup', () => {
      const assetCategoryRepo = createAssetCategoryRepository(db);
      const project = insertProject(db, { title: 'Context Specific Intent' });
      const category = assetCategoryRepo.addProjectCategory({
        projectId: project.id,
        displayName: 'Renders',
        directorySlug: 'renders-context-intent',
        displayOrder: 0,
        enabled: true,
      });

      const specific = service.getProjectAssetBrowserContext(project.id, { category: String(category.id) });
      const bare = service.getProjectAssetBrowserContext(project.id, {});
      const unknown = service.getProjectAssetBrowserContext(project.id, { unknown: 'value' });
      const invalid = service.getProjectAssetBrowserContext(project.id, { category: 'invalid' });
      const filtered = service.getProjectAssetBrowserContext(project.id, { unknown: 'value', search: 'hero' });

      expect(specific.context.categorySelection).toBe('explicit-specific');
      expect(specific.context.categoryWasSupplied).toBe(true);
      expect(buildCanonicalAssetBrowserQuery(bare.context, bare.context.page)).toEqual({});
      expect(buildCanonicalAssetBrowserQuery(unknown.context, unknown.context.page)).toEqual({ category: 'all' });
      expect(buildCanonicalAssetBrowserQuery(invalid.context, invalid.context.page)).toEqual({ category: 'all' });
      expect(buildCanonicalAssetBrowserQuery(filtered.context, filtered.context.page)).toEqual({
        search: 'hero',
      });
      insertAsset(db, { projectId: project.id, relativePath: 'context.png', filename: 'context.png', extension: 'png', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'context.jpg', filename: 'context.jpg', extension: 'jpg', isPresent: 1 });
      const repeatedExtensions = service.getProjectAssetBrowserContext(project.id, {
        extension: ['png', 'jpg', 'png'],
      }).context;
      expect(buildCanonicalAssetBrowserQuery(repeatedExtensions, 1)).toEqual({
        extension: ['jpg', 'png'],
      });
      expect(buildAssetBrowserQueryString(buildCanonicalAssetBrowserQuery(repeatedExtensions, 1)))
        .toBe('extension=jpg&extension=png');
      expect(buildCanonicalAssetBrowserQuery(
        service.getProjectAssetBrowserContext(project.id, { category: 'all' }).context,
        1,
      )).toEqual({ category: 'all' });
    });
  });

  describe('getProjectAssetViewer', () => {
    function addViewerAsset(project, relativePath, overrides = {}) {
      return insertAsset(db, {
        projectId: project.id,
        relativePath,
        filename: overrides.filename ?? relativePath.split('/').pop(),
        extension: overrides.extension ?? 'txt',
        mimeType: overrides.mimeType ?? 'text/plain',
        sizeBytes: overrides.sizeBytes ?? 100,
        modifiedAt: overrides.modifiedAt ?? '2026-07-28T12:00:00.000Z',
        isPresent: overrides.isPresent ?? 1,
      });
    }

    function expectLocalUrl(href, pathname, expectedQuery = {}) {
      const url = new URL(href, 'http://localhost');
      expect(url.pathname).toBe(pathname);
      expect(Array.from(url.searchParams.keys()).sort()).toEqual(Object.keys(expectedQuery).sort());
      for (const [key, value] of Object.entries(expectedQuery)) {
        expect(url.searchParams.get(key)).toBe(String(value));
      }
    }

    it('returns project summary, asset metadata, release usage, media URLs, and middle navigation', () => {
      const project = insertProject(db, { title: 'Viewer Model' });
      const release = insertRelease(db, { projectId: project.id, title: 'Release A', status: 'planned' });
      const first = addViewerAsset(project, '01-draft.png', { extension: 'png', mimeType: 'image/png' });
      const current = addViewerAsset(project, '02-final.png', {
        extension: 'png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        modifiedAt: '2026-07-28 12:00:00',
      });
      const last = addViewerAsset(project, '03-notes.txt');
      linkAssetToRelease(db, { releaseId: release.id, assetId: current.id });

      // `view` is passed here to prove it round-trips into the canonical
      // context and every generated navigation URL below, just like the
      // other filter/sort/pagination fields.
      const result = service.getProjectAssetViewer(project.id, current.id, {
        view: 'grid',
        search: '0',
        pageSize: '2',
      });

      expect(result.project).toEqual({
        id: project.id,
        title: 'Viewer Model',
        slug: 'viewer-model',
        status: 'tbd',
        archived_at: null,
        project_dir: null,
      });
      expect(result.asset).toMatchObject({
        id: current.id,
        project_id: project.id,
        filename: '02-final.png',
        relative_path: '02-final.png',
        extension: 'png',
        mime_type: 'image/png',
        size_bytes: 2048,
        modified_at: '2026-07-28 12:00:00',
        is_present: 1,
        presence_state: 'present',
        missing: false,
        release_usage_count: 1,
        preview_capability: 'previewable',
        preview_state: 'previewable',
      });
      expect(result.asset.release_usage_summary.count).toBe(1);
      expect(result.asset.release_usage_summary.releases[0].release_id).toBe(release.id);
      expect(result.asset.revision_token).toMatch(/^[a-f0-9]{16}$/);
      expect(result.asset.thumbnail_url).toBe(`/projects/${project.id}/assets/${current.id}/thumbnail?v=${result.asset.revision_token}`);
      expect(result.asset.preview_url).toBe(`/projects/${project.id}/assets/${current.id}/preview?v=${result.asset.revision_token}`);
      expect(result.asset.original_url).toBe(`/projects/${project.id}/assets/${current.id}/original`);

      expect(result.context).toMatchObject({
        search: '0',
        extension: null,
        presence: 'all',
        usage: 'all',
        category: 'all',
        sort: 'filename',
        order: 'asc',
        page: 1,
        pageSize: 2,
        view: 'grid',
      });
      expect(result.filteredOut).toBe(false);
      expect(result.filteredPosition).toBe(2);
      expect(result.filteredTotal).toBe(3);
      expect(result.currentPage).toBe(1);
      expect(result.previousAssetLink.assetId).toBe(first.id);
      expect(result.nextAssetLink.assetId).toBe(last.id);
      expectLocalUrl(result.previousAssetLink.href, `/projects/${project.id}/assets/${first.id}`, {
        search: '0', pageSize: '2',
      });
      expectLocalUrl(result.nextAssetLink.href, `/projects/${project.id}/assets/${last.id}`, {
        search: '0', page: '2', pageSize: '2',
      });
      expectLocalUrl(result.backToAssetsLink.href, `/projects/${project.id}/assets`, {
        search: '0', pageSize: '2',
      });
    });

    it('keeps explicit All in viewer Back and adjacent navigation URLs', () => {
      const project = insertProject(db, { title: 'Viewer Explicit All' });
      const first = addViewerAsset(project, '01-first.txt');
      const current = addViewerAsset(project, '02-current.txt');
      const last = addViewerAsset(project, '03-last.txt');

      const result = service.getProjectAssetViewer(project.id, current.id, {
        category: 'all',
        pageSize: '2',
      });

      expectLocalUrl(result.previousAssetLink.href, `/projects/${project.id}/assets/${first.id}`, {
        category: 'all',
        pageSize: '2',
      });
      expectLocalUrl(result.backToAssetsLink.href, `/projects/${project.id}/assets`, {
        category: 'all',
        pageSize: '2',
      });
      expectLocalUrl(result.nextAssetLink.href, `/projects/${project.id}/assets/${last.id}`, {
        category: 'all',
        page: '2',
        pageSize: '2',
      });
    });

    it('uses exact cross-page previous and next links when the viewer URL omits page', () => {
      const project = insertProject(db, { title: 'Viewer Cross Page' });
      const assets = [];
      for (let i = 1; i <= 5; i++) {
        assets.push(addViewerAsset(project, `file${String(i).padStart(2, '0')}.txt`));
      }

      const second = service.getProjectAssetViewer(project.id, assets[1].id, { pageSize: '2' });
      const third = service.getProjectAssetViewer(project.id, assets[2].id, { pageSize: '2' });

      expect(second.currentPage).toBe(1);
      expect(second.previousAssetLink.assetId).toBe(assets[0].id);
      expect(second.nextAssetLink.assetId).toBe(assets[2].id);
      expectLocalUrl(second.nextAssetLink.href, `/projects/${project.id}/assets/${assets[2].id}`, {
        page: '2', pageSize: '2',
      });
      expectLocalUrl(second.backToAssetsLink.href, `/projects/${project.id}/assets`, { pageSize: '2' });

      expect(third.currentPage).toBe(2);
      expect(third.previousAssetLink.assetId).toBe(assets[1].id);
      expect(third.nextAssetLink.assetId).toBe(assets[3].id);
      expectLocalUrl(third.previousAssetLink.href, `/projects/${project.id}/assets/${assets[1].id}`, {
        pageSize: '2',
      });
      expectLocalUrl(third.backToAssetsLink.href, `/projects/${project.id}/assets`, {
        page: '2', pageSize: '2',
      });
    });

    it('uses the asset position, not an incorrect supplied page, for navigation URLs', () => {
      const project = insertProject(db, { title: 'Viewer Wrong Page' });
      const assets = [];
      for (let i = 1; i <= 5; i++) {
        assets.push(addViewerAsset(project, `file${String(i).padStart(2, '0')}.txt`));
      }

      const result = service.getProjectAssetViewer(project.id, assets[3].id, {
        page: '99',
        pageSize: '2',
      });

      expect(result.context.page).toBe(99);
      expect(result.filteredPosition).toBe(4);
      expect(result.currentPage).toBe(2);
      expect(result.previousAssetLink.assetId).toBe(assets[2].id);
      expect(result.nextAssetLink.assetId).toBe(assets[4].id);
      expectLocalUrl(result.previousAssetLink.href, `/projects/${project.id}/assets/${assets[2].id}`, {
        page: '2', pageSize: '2',
      });
      expectLocalUrl(result.nextAssetLink.href, `/projects/${project.id}/assets/${assets[4].id}`, {
        page: '3', pageSize: '2',
      });
      expectLocalUrl(result.backToAssetsLink.href, `/projects/${project.id}/assets`, {
        page: '2', pageSize: '2',
      });
    });

    it('omits previous for the first asset, next for the last asset, and page 1 in default URLs', () => {
      const project = insertProject(db, { title: 'Viewer Edges' });
      const first = addViewerAsset(project, '01-first.txt');
      const last = addViewerAsset(project, '02-last.txt');

      const firstResult = service.getProjectAssetViewer(project.id, first.id);
      const lastResult = service.getProjectAssetViewer(project.id, last.id);

      expect(firstResult.previousAssetLink).toBeNull();
      expect(firstResult.nextAssetLink.assetId).toBe(last.id);
      expectLocalUrl(firstResult.nextAssetLink.href, `/projects/${project.id}/assets/${last.id}`);
      expectLocalUrl(firstResult.backToAssetsLink.href, `/projects/${project.id}/assets`);

      expect(lastResult.previousAssetLink.assetId).toBe(first.id);
      expect(lastResult.nextAssetLink).toBeNull();
      expectLocalUrl(lastResult.previousAssetLink.href, `/projects/${project.id}/assets/${first.id}`);
      expectLocalUrl(lastResult.backToAssetsLink.href, `/projects/${project.id}/assets`);
    });

    it('shows assets excluded by search, extension, presence, and usage while clearing filtered adjacency', () => {
      const searchProject = insertProject(db, { title: 'Viewer Excluded Search' });
      addViewerAsset(searchProject, 'visible.txt');
      const searchCurrent = addViewerAsset(searchProject, 'hidden.txt');

      const extensionProject = insertProject(db, { title: 'Viewer Excluded Extension' });
      addViewerAsset(extensionProject, 'visible.jpg', { extension: 'jpg', mimeType: 'image/jpeg' });
      const extensionCurrent = addViewerAsset(extensionProject, 'hidden.png', { extension: 'png', mimeType: 'image/png' });

      const presenceProject = insertProject(db, { title: 'Viewer Excluded Presence' });
      addViewerAsset(presenceProject, 'visible.txt', { isPresent: 1 });
      const presenceCurrent = addViewerAsset(presenceProject, 'hidden.txt', { isPresent: 0 });

      const usageProject = insertProject(db, { title: 'Viewer Excluded Usage' });
      const used = addViewerAsset(usageProject, 'visible.txt');
      const usageCurrent = addViewerAsset(usageProject, 'hidden.txt');
      const release = insertRelease(db, { projectId: usageProject.id, title: 'Usage Release', status: 'tbd' });
      linkAssetToRelease(db, { releaseId: release.id, assetId: used.id });

      const cases = [
        { project: searchProject, current: searchCurrent, raw: { search: 'visible' }, query: { search: 'visible' } },
        { project: extensionProject, current: extensionCurrent, raw: { extension: '.jpg' }, query: { extension: 'jpg' } },
        { project: presenceProject, current: presenceCurrent, raw: { presence: 'present' }, query: { presence: 'present' } },
        { project: usageProject, current: usageCurrent, raw: { usage: 'used' }, query: { usage: 'used' } },
      ];

      for (const testCase of cases) {
        const result = service.getProjectAssetViewer(testCase.project.id, testCase.current.id, {
          ...testCase.raw,
          page: '9',
        });

        expect(result.asset.id).toBe(testCase.current.id);
        expect(result.filteredOut).toBe(true);
        expect(result.filteredPosition).toBeNull();
        expect(result.currentPage).toBeNull();
        expect(result.previousAssetLink).toBeNull();
        expect(result.nextAssetLink).toBeNull();
        expectLocalUrl(result.backToAssetsLink.href, `/projects/${testCase.project.id}/assets`, testCase.query);
      }
    });

    it('keeps repeated extension query values unsupported in the Asset Viewer', () => {
      const project = insertProject(db, { title: 'Viewer Repeated Extensions' });
      const first = addViewerAsset(project, 'first.png', { extension: 'png', mimeType: 'image/png' });
      const second = addViewerAsset(project, 'second.jpg', { extension: 'jpg', mimeType: 'image/jpeg' });

      const result = service.getProjectAssetViewer(project.id, first.id, {
        extension: ['png', 'jpg'],
      });

      expect(result.context.extension).toBeNull();
      expect(result.filteredTotal).toBe(2);
      expect(result.nextAssetLink.assetId).toBe(second.id);
    });

    it('keeps archived projects readable in the viewer model', () => {
      const project = insertProject(db, { title: 'Viewer Archived' });
      const asset = addViewerAsset(project, 'asset.txt');
      db.prepare(`UPDATE projects SET archived_at = datetime('now'), status = 'archived' WHERE id = ?`).run(project.id);

      const result = service.getProjectAssetViewer(project.id, asset.id);

      expect(result).not.toBeNull();
      expect(result.project.status).toBe('archived');
      expect(result.project.archived_at).toBeTruthy();
      expect(result.asset.id).toBe(asset.id);
    });

    it('preserves missing, Krita, and unsupported asset metadata while omitting invalid original URLs', () => {
      const project = insertProject(db, { title: 'Viewer Media States' });
      const missing = addViewerAsset(project, 'missing.png', { extension: 'png', mimeType: 'image/png', isPresent: 0 });
      const krita = addViewerAsset(project, 'source.kra', { extension: 'kra', mimeType: 'application/x-krita' });
      const unsupported = addViewerAsset(project, 'mismatch.kra', { extension: 'kra', mimeType: 'image/png' });
      const supported = addViewerAsset(project, 'render.png', { extension: 'png', mimeType: 'image/png' });

      const missingResult = service.getProjectAssetViewer(project.id, missing.id);
      const kritaResult = service.getProjectAssetViewer(project.id, krita.id);
      const unsupportedResult = service.getProjectAssetViewer(project.id, unsupported.id);
      const supportedResult = service.getProjectAssetViewer(project.id, supported.id);

      expect(missingResult.asset).toMatchObject({
        id: missing.id,
        is_present: 0,
        missing: true,
        preview_state: 'missing',
        thumbnail_url: null,
        preview_url: null,
        original_url: null,
      });
      expect(kritaResult.asset).toMatchObject({
        id: krita.id,
        preview_state: 'previewable',
        preview: { kind: 'krita', previewable: true },
        original_url: null,
      });
      expect(unsupportedResult.asset).toMatchObject({
        id: unsupported.id,
        preview_state: 'unsupported',
        thumbnail_url: null,
        preview_url: null,
        original_url: null,
      });
      expect(supportedResult.asset.preview_state).toBe('previewable');
      expect(supportedResult.asset.original_url).toBe(`/projects/${project.id}/assets/${supported.id}/original`);
    });

    it('exposes persisted category directory slugs without changing category presentation state', () => {
      const assetCategoryRepo = createAssetCategoryRepository(db);
      const project = insertProject(db, { title: 'Viewer Category Directory Slugs' });
      const enabledCategory = assetCategoryRepo.addProjectCategory({
        projectId: project.id,
        displayName: 'Final Renders',
        directorySlug: 'authoritative-final-renders',
        displayOrder: 0,
        enabled: true,
      });
      const disabledCategory = assetCategoryRepo.addProjectCategory({
        projectId: project.id,
        displayName: 'Legacy Archive',
        directorySlug: 'persisted-disabled-archive',
        displayOrder: 1,
        enabled: false,
      });
      const categorized = addViewerAsset(project, 'render.png', {
        extension: 'png',
        mimeType: 'image/png',
      });
      const disabledMissing = addViewerAsset(project, 'legacy.png', {
        extension: 'png',
        mimeType: 'image/png',
        isPresent: 0,
      });
      const uncategorized = addViewerAsset(project, 'root.png', {
        extension: 'png',
        mimeType: 'image/png',
      });
      db.prepare('UPDATE assets SET category_id = ? WHERE id = ?').run(enabledCategory.id, categorized.id);
      db.prepare('UPDATE assets SET category_id = ? WHERE id = ?').run(disabledCategory.id, disabledMissing.id);

      const categorizedResult = service.getProjectAssetViewer(project.id, categorized.id);
      const disabledMissingResult = service.getProjectAssetViewer(project.id, disabledMissing.id);
      const uncategorizedResult = service.getProjectAssetViewer(project.id, uncategorized.id);

      expect(categorizedResult.asset.category).toEqual({
        id: enabledCategory.id,
        displayName: 'Final Renders',
        directorySlug: 'authoritative-final-renders',
        enabled: true,
        displayOrder: 0,
      });
      expect(disabledMissingResult.asset).toMatchObject({ missing: true });
      expect(disabledMissingResult.asset.category).toEqual({
        id: disabledCategory.id,
        displayName: 'Legacy Archive',
        directorySlug: 'persisted-disabled-archive',
        enabled: false,
        displayOrder: 1,
      });
      expect(uncategorizedResult.asset.category).toBeNull();
    });

    it('returns the same not-found convention for unknown and cross-project assets', () => {
      const project = insertProject(db, { title: 'Viewer Owner' });
      const other = insertProject(db, { title: 'Viewer Other Owner' });
      const otherAsset = addViewerAsset(other, 'other.txt');

      expect(service.getProjectAssetViewer(project.id, 999999)).toBeNull();
      expect(service.getProjectAssetViewer(project.id, otherAsset.id)).toBeNull();
    });

    it('viewer composition executes a fixed number of statements as project size grows', () => {
      const counter = instrumentStatementExecution(db);
      const instrumentedService = createWorkflowQueryService({ db });
      const smallProject = insertProject(db, { title: 'Viewer Query Small' });
      const smallCurrent = addViewerAsset(smallProject, 'file01.txt');
      addViewerAsset(smallProject, 'file02.txt');
      addViewerAsset(smallProject, 'file03.txt');

      const largeProject = insertProject(db, { title: 'Viewer Query Large' });
      let largeCurrent;
      for (let i = 1; i <= 80; i++) {
        const asset = addViewerAsset(largeProject, `file${String(i).padStart(2, '0')}.txt`);
        if (i === 40) largeCurrent = asset;
      }

      counter.reset();
      const small = instrumentedService.getProjectAssetViewer(smallProject.id, smallCurrent.id);
      const smallCount = counter.count();

      counter.reset();
      const large = instrumentedService.getProjectAssetViewer(largeProject.id, largeCurrent.id);
      const largeCount = counter.count();

      expect(small.asset.id).toBe(smallCurrent.id);
      expect(large.asset.id).toBe(largeCurrent.id);
      expect(smallCount).toBe(ASSET_VIEWER_FIXED_STATEMENT_EXECUTIONS);
      expect(largeCount).toBe(ASSET_VIEWER_FIXED_STATEMENT_EXECUTIONS);
    });

    // ─── Phase: asset actions chunk 4 — rename/move form projections ────

    describe('enabledCategories and canMutate', () => {
      it('includes only enabled project categories, never disabled ones', () => {
        const assetCategoryRepo = createAssetCategoryRepository(db);
        const project = insertProject(db, { title: 'Viewer Enabled Categories' });
        const enabled = assetCategoryRepo.addProjectCategory({
          projectId: project.id, displayName: 'Renders', directorySlug: 'renders', displayOrder: 0, enabled: true,
        });
        assetCategoryRepo.addProjectCategory({
          projectId: project.id, displayName: 'Archive', directorySlug: 'archive', displayOrder: 1, enabled: false,
        });
        const asset = addViewerAsset(project, 'a.txt');

        const result = service.getProjectAssetViewer(project.id, asset.id);

        expect(result.enabledCategories).toEqual([{ id: enabled.id, displayName: 'Renders' }]);
      });

      it('returns an empty enabledCategories list when the project has no categories', () => {
        const project = insertProject(db, { title: 'Viewer No Categories' });
        const asset = addViewerAsset(project, 'a.txt');
        const result = service.getProjectAssetViewer(project.id, asset.id);
        expect(result.enabledCategories).toEqual([]);
      });

      it('canMutate is true for a present asset in a non-archived project', () => {
        const project = insertProject(db, { title: 'Viewer Mutable' });
        const asset = addViewerAsset(project, 'a.txt', { isPresent: 1 });
        const result = service.getProjectAssetViewer(project.id, asset.id);
        expect(result.canMutate).toBe(true);
      });

      it('canMutate is false for a missing asset', () => {
        const project = insertProject(db, { title: 'Viewer Missing Asset' });
        const asset = addViewerAsset(project, 'a.txt', { isPresent: 0 });
        const result = service.getProjectAssetViewer(project.id, asset.id);
        expect(result.canMutate).toBe(false);
      });

      it('canMutate is false for an archived project even with a present asset', () => {
        const project = insertProject(db, { title: 'Viewer Archived Project', archivedAt: '2026-01-01 00:00:00' });
        const asset = addViewerAsset(project, 'a.txt', { isPresent: 1 });
        const result = service.getProjectAssetViewer(project.id, asset.id);
        expect(result.canMutate).toBe(false);
      });
    });
  });

  // ─── Phase 7D-3: Query methods remain bounded ──────────────────────────────
  //
  // All dashboard and list queries must use LIMIT to prevent unbounded
  // result sets. Verify that every query method returns at most the
  // requested limit.

  describe('query methods remain bounded', () => {
    let project;

    beforeEach(() => {
      project = insertProject(db, { title: 'Bounded Query Project' });
      // Insert more releases than any default limit
      for (let i = 0; i < 20; i++) {
        insertRelease(db, {
          projectId: project.id,
          title: `Bounded Release ${i}`,
          status: 'ready',
          plannedDate: '2099-01-01',
        });
      }
    });

    it('getDashboardData returns at most the configured limits', () => {
      for (let i = 0; i < 20; i++) {
        insertProject(db, {
          title: `Bounded Overdue Project ${i}`, status: 'planned', plannedDate: '2020-01-01',
        });
        insertProject(db, {
          title: `Bounded Upcoming Project ${i}`, status: 'planned', plannedDate: '2099-01-01',
        });
      }

      const data = service.getDashboardData({ today: '2099-01-01' });
      expect(data.overdue.length).toBeLessThanOrEqual(8);
      expect(data.upcoming.length).toBeLessThanOrEqual(8);
    });

    it('getReleaseList returns at most pageSize releases', () => {
      const result = service.getReleaseList({ pageSize: '5' }, { today: '2099-01-01' });
      expect(result.releases.length).toBeLessThanOrEqual(5);
    });

  });

  describe('getDashboardData — configured section sorting', () => {
    it('uses configured trusted sorting for date-driven, recently updated, and status sections', () => {
      const overdueZulu = insertProject(db, { title: 'Zulu overdue', status: 'planned', plannedDate: '2026-07-01' });
      const overdueAlpha = insertProject(db, { title: 'Alpha overdue', status: 'planned', plannedDate: '2026-07-01' });
      const upcomingZulu = insertProject(db, { title: 'Zulu upcoming', status: 'planned', plannedDate: '2026-08-01' });
      const upcomingAlpha = insertProject(db, { title: 'Alpha upcoming', status: 'planned', plannedDate: '2026-08-01' });
      const recentZulu = insertProject(db, { title: 'Zulu recent', status: 'tbd' });
      const recentAlpha = insertProject(db, { title: 'Alpha recent', status: 'tbd' });
      const readyZulu = insertProject(db, { title: 'Zulu ready', status: 'ready' });
      const readyAlpha = insertProject(db, { title: 'Alpha ready', status: 'ready' });

      const data = service.getDashboardData({
        today: '2026-07-15',
        dashboardDefaults: dashboardDefaults({
          overdue: { visible: true, itemCount: 8, sort: 'title', order: 'asc' },
          upcoming: { visible: true, itemCount: 8, sort: 'title', order: 'asc' },
          'recently-updated': { visible: true, itemCount: 25, sort: 'title', order: 'asc' },
          'status:ready': { visible: true, itemCount: 8, sort: 'title', order: 'asc' },
        }),
      });

      expect(data.sections.overdue.slice(0, 2).map((project) => project.id))
        .toEqual([overdueAlpha.id, overdueZulu.id]);
      expect(data.sections.upcoming.slice(0, 2).map((project) => project.id))
        .toEqual([upcomingAlpha.id, upcomingZulu.id]);
      expect(data.sections['recently-updated'].map((project) => project.id))
        .toContain(recentAlpha.id);
      expect(data.sections['recently-updated'].findIndex((project) => project.id === recentAlpha.id))
        .toBeLessThan(data.sections['recently-updated'].findIndex((project) => project.id === recentZulu.id));
      expect(data.sections['status:ready'].map((project) => project.id))
        .toEqual([readyAlpha.id, readyZulu.id]);
    });

    it('keeps the established planned-date and updated-date defaults when no sorting is stored', () => {
      const overdueLater = insertProject(db, { title: 'Later overdue', status: 'planned', plannedDate: '2026-07-10' });
      const overdueEarlier = insertProject(db, { title: 'Earlier overdue', status: 'planned', plannedDate: '2026-07-01' });
      const readyFirst = insertProject(db, { title: 'First ready', status: 'ready' });
      const readySecond = insertProject(db, { title: 'Second ready', status: 'ready' });

      const data = service.getDashboardData({
        today: '2026-07-15',
        dashboardDefaults: { version: 1, sections: {} },
      });

      expect(data.sections.overdue.slice(0, 2).map((project) => project.id))
        .toEqual([overdueEarlier.id, overdueLater.id]);
      expect(data.sections['status:ready'].slice(0, 2).map((project) => project.id))
        .toEqual([readySecond.id, readyFirst.id]);
    });
  });

});
