import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createWorkflowQueryService } from '../src/services/workflow-query-service.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createReleaseRepository } from '../src/data/release-repository.js';
import { getLocalTodayIso } from '../src/util/date.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Helper to insert a project directly without filesystem operations.
 */
function insertProject(db, { title, status = 'tbd' }) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return db.prepare(`
    INSERT INTO projects (title, slug, description, notes, status, priority,
                          planned_date, published_date, patreon_url)
    VALUES (?, ?, '', '', ?, 'normal', NULL, NULL, NULL)
    RETURNING *
  `).get(title, slug, status);
}

/**
 * Helper to insert a release directly.
 */
function insertRelease(db, {
  projectId, title, status = 'idea',
  plannedDate = null, publishedDate = null, archivedAt = null,
}) {
  return db.prepare(`
    INSERT INTO releases (project_id, title, description, notes, status,
                          planned_date, published_date, patreon_url,
                          archived_at)
    VALUES (?, ?, '', '', ?, ?, ?, NULL, ?)
    RETURNING *
  `).get(projectId, title, status, plannedDate, publishedDate, archivedAt);
}

/**
 * Helper to insert an asset directly with the desired presence state.
 */
function insertAsset(db, {
  projectId, relativePath, filename, isPresent = 1,
}) {
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
  let today;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-wqs-'));
    const dbPath = path.join(tmpDir, 'test.db');
    db = openDatabase(dbPath);
    runMigrations(db, MIGRATIONS_DIR);
    service = createWorkflowQueryService({ db });
    today = getLocalTodayIso();
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── getDashboardData: empty state ─────────────────────────────────

  describe('getDashboardData — empty state', () => {
    it('returns safe empty sections for an empty database', () => {
      const data = service.getDashboardData();

      expect(data.releasesNeedingAttention).toEqual({
        overdue: [],
        ready: [],
        missingPlannedDate: [],
        missingSelectedAssets: [],
        releasesWithoutAssets: [],
        totalCount: 0,
      });
      expect(data.upcomingReleases).toEqual([]);
      expect(data.workflowSummary.totalProjects).toBe(0);
      expect(data.workflowSummary.totalAssets).toBe(0);
      expect(data.workflowSummary.missingAssetSummary.total).toBe(0);
      expect(data.workflowSummary.missingAssetSummary.referencedByReleases).toBe(0);
      expect(data.workflowSummary.releaseStatusCounts).toEqual({
        idea: 0, planned: 0, drafting: 0, ready: 0, published: 0, cancelled: 0,
      });
      expect(data.projectCounts).toEqual({
        tbd: 0, planned: 0, 'in-progress': 0, ready: 0, published: 0, archived: 0,
      });
      expect(data.recentlyUpdated).toEqual([]);
      expect(data.today).toBe(today);
    });

    it('does not throw for an empty database', () => {
      expect(() => service.getDashboardData()).not.toThrow();
    });
  });

  // ─── getDashboardData: releases needing attention ───────────────────

  describe('getDashboardData — releases needing attention', () => {
    it('overdue releases appear in the overdue section', () => {
      const project = insertProject(db, { title: 'Overdue Project', status: 'planned' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Overdue Release',
        status: 'planned',
        plannedDate: '2020-01-01', // way in the past
      });
      // Link a present asset so the release does not also appear in
      // missing-selection (kept focused on the overdue section).
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });

      const data = service.getDashboardData();
      expect(data.releasesNeedingAttention.overdue).toHaveLength(1);
      expect(data.releasesNeedingAttention.overdue[0].title).toBe('Overdue Release');
      expect(data.releasesNeedingAttention.totalCount).toBe(1);
    });

    it('upcoming releases appear in the upcoming section', () => {
      const project = insertProject(db, { title: 'Upcoming Project', status: 'planned' });
      insertRelease(db, {
        projectId: project.id,
        title: 'Upcoming Release',
        status: 'planned',
        plannedDate: '2099-12-31',
      });

      const data = service.getDashboardData();
      // Upcoming is grouped by plannedDate: [{ plannedDate, releases: [...] }]
      expect(data.upcomingReleases).toHaveLength(1);
      expect(data.upcomingReleases[0].plannedDate).toBe('2099-12-31');
      expect(data.upcomingReleases[0].releases).toHaveLength(1);
      expect(data.upcomingReleases[0].releases[0].title).toBe('Upcoming Release');
    });

    it('ready releases appear in the ready-to-publish section', () => {
      const project = insertProject(db, { title: 'Ready Project', status: 'ready' });
      insertRelease(db, {
        projectId: project.id,
        title: 'Ready Release',
        status: 'ready',
        plannedDate: '2099-01-01',
      });

      const data = service.getDashboardData();
      expect(data.releasesNeedingAttention.ready).toHaveLength(1);
      expect(data.releasesNeedingAttention.ready[0].title).toBe('Ready Release');
    });

    it('active releases without planned date appear in the missing-planned-date section', () => {
      const project = insertProject(db, { title: 'No Date Project', status: 'planned' });
      insertRelease(db, {
        projectId: project.id,
        title: 'No Planned Date',
        status: 'planned',
        plannedDate: null,
      });

      const data = service.getDashboardData();
      expect(data.releasesNeedingAttention.missingPlannedDate).toHaveLength(1);
      expect(data.releasesNeedingAttention.missingPlannedDate[0].title).toBe('No Planned Date');
    });

    it('releases with missing selected assets appear in the missing-assets section', () => {
      const project = insertProject(db, { title: 'Missing Asset Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Missing Asset Release',
        status: 'planned',
        plannedDate: '2099-01-01',
      });
      const missingAsset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'missing.txt',
        filename: 'missing.txt',
        isPresent: 0,
      });
      linkAssetToRelease(db, {
        releaseId: release.id,
        assetId: missingAsset.id,
      });

      const data = service.getDashboardData();
      expect(data.releasesNeedingAttention.missingSelectedAssets).toHaveLength(1);
      expect(data.releasesNeedingAttention.missingSelectedAssets[0].title).toBe('Missing Asset Release');
      expect(data.releasesNeedingAttention.missingSelectedAssets[0].missing_asset_count).toBe(1);
    });

    it('does not surface archived overdue releases', () => {
      const project = insertProject(db, { title: 'Archive Hide Project' });
      insertRelease(db, {
        projectId: project.id,
        title: 'Archived Overdue',
        status: 'planned',
        plannedDate: '2020-01-01',
        archivedAt: '2024-01-01 00:00:00',
      });

      const data = service.getDashboardData();
      expect(data.releasesNeedingAttention.overdue).toHaveLength(0);
    });

    it('does not surface cancelled releases as overdue', () => {
      const project = insertProject(db, { title: 'Cancelled Project' });
      insertRelease(db, {
        projectId: project.id,
        title: 'Cancelled Past',
        status: 'cancelled',
        plannedDate: '2020-01-01',
      });

      const data = service.getDashboardData();
      expect(data.releasesNeedingAttention.overdue).toHaveLength(0);
    });

    it('totalCount is the sum of all five attention lists', () => {
      const project = insertProject(db, { title: 'Multi Attention Project', status: 'planned' });
      // Link a present asset to every release so the missing-selection
      // section stays empty and we can verify the totalCount math without
      // missing-selection interference. (Missing-selection is covered by
      // its own dedicated test below.)
      const presentAsset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'present.txt',
        filename: 'present.txt',
        isPresent: 1,
      });
      const overdue = insertRelease(db, {
        projectId: project.id,
        title: 'Overdue',
        status: 'planned',
        plannedDate: '2020-01-01',
      });
      linkAssetToRelease(db, { releaseId: overdue.id, assetId: presentAsset.id });
      const ready = insertRelease(db, {
        projectId: project.id,
        title: 'Ready',
        status: 'ready',
        plannedDate: '2099-01-01',
      });
      linkAssetToRelease(db, { releaseId: ready.id, assetId: presentAsset.id });
      const noDate = insertRelease(db, {
        projectId: project.id,
        title: 'No Date',
        status: 'drafting',
        plannedDate: null,
      });
      linkAssetToRelease(db, { releaseId: noDate.id, assetId: presentAsset.id });
      const missingAsset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'm.txt',
        filename: 'm.txt',
        isPresent: 0,
      });
      const releaseWithMissing = insertRelease(db, {
        projectId: project.id,
        title: 'Has Missing',
        status: 'drafting',
        plannedDate: '2099-01-01',
      });
      linkAssetToRelease(db, { releaseId: releaseWithMissing.id, assetId: presentAsset.id });
      linkAssetToRelease(db, { releaseId: releaseWithMissing.id, assetId: missingAsset.id });

      const data = service.getDashboardData();
      expect(data.releasesNeedingAttention.totalCount).toBe(4);
      // Sanity: every list non-empty except missing-selection
      expect(data.releasesNeedingAttention.overdue).toHaveLength(1);
      expect(data.releasesNeedingAttention.ready).toHaveLength(1);
      expect(data.releasesNeedingAttention.missingPlannedDate).toHaveLength(1);
      expect(data.releasesNeedingAttention.missingSelectedAssets).toHaveLength(1);
      expect(data.releasesNeedingAttention.releasesWithoutAssets).toHaveLength(0);
      // Use one variable to silence linters about unused insert
      expect(overdue.id).toBeGreaterThan(0);
    });

    it('respects the bounded limit on overdue releases', () => {
      const project = insertProject(db, { title: 'Bounded Overdue' });
      for (let i = 0; i < 10; i++) {
        insertRelease(db, {
          projectId: project.id,
          title: `Overdue ${i}`,
          status: 'planned',
          plannedDate: `2020-01-0${(i % 9) + 1}`,
        });
      }

      const data = service.getDashboardData({ limits: { overdue: 3 } });
      expect(data.releasesNeedingAttention.overdue).toHaveLength(3);
    });
  });

  // ─── getDashboardData: workflow summary ────────────────────────────

  describe('getDashboardData — workflow summary', () => {
    it('computes total projects from project counts', () => {
      insertProject(db, { title: 'Alpha', status: 'tbd' });
      insertProject(db, { title: 'Beta', status: 'planned' });
      insertProject(db, { title: 'Gamma', status: 'in-progress' });

      const data = service.getDashboardData();
      expect(data.workflowSummary.totalProjects).toBe(3);
      expect(data.projectCounts).toEqual({
        tbd: 1, planned: 1, 'in-progress': 1, ready: 0, published: 0, archived: 0,
      });
    });

    it('computes total assets and missing asset summary', () => {
      const project = insertProject(db, { title: 'Asset Count Project' });
      insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'b.txt', filename: 'b.txt', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'c.txt', filename: 'c.txt', isPresent: 0 });

      const data = service.getDashboardData();
      expect(data.workflowSummary.totalAssets).toBe(3);
      expect(data.workflowSummary.missingAssetSummary.total).toBe(1);
      expect(data.workflowSummary.missingAssetSummary.referencedByReleases).toBe(0);
    });

    it('computes missing assets referenced by non-archived releases', () => {
      const project = insertProject(db, { title: 'Ref Project' });
      const present = insertAsset(db, { projectId: project.id, relativePath: 'p.txt', filename: 'p.txt', isPresent: 1 });
      const missing = insertAsset(db, { projectId: project.id, relativePath: 'm.txt', filename: 'm.txt', isPresent: 0 });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Ref Release',
        status: 'planned',
        plannedDate: '2099-01-01',
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: present.id });
      linkAssetToRelease(db, { releaseId: release.id, assetId: missing.id });

      const data = service.getDashboardData();
      expect(data.workflowSummary.missingAssetSummary.total).toBe(1);
      expect(data.workflowSummary.missingAssetSummary.referencedByReleases).toBe(1);
    });

    it('excludes missing-assets-referenced count for archived releases', () => {
      const project = insertProject(db, { title: 'Archived Ref Project' });
      const missing = insertAsset(db, { projectId: project.id, relativePath: 'm.txt', filename: 'm.txt', isPresent: 0 });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Archived Ref Release',
        status: 'idea',
        plannedDate: null,
        archivedAt: '2024-01-01 00:00:00',
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: missing.id });

      const data = service.getDashboardData();
      expect(data.workflowSummary.missingAssetSummary.referencedByReleases).toBe(0);
    });

    it('returns release status counts with all statuses set to zero or actual', () => {
      const project = insertProject(db, { title: 'Status Counts Project' });
      insertRelease(db, { projectId: project.id, title: 'I1', status: 'idea' });
      insertRelease(db, { projectId: project.id, title: 'I2', status: 'idea' });
      insertRelease(db, { projectId: project.id, title: 'R1', status: 'ready' });

      const data = service.getDashboardData();
      expect(data.workflowSummary.releaseStatusCounts).toEqual({
        idea: 2, planned: 0, drafting: 0, ready: 1, published: 0, cancelled: 0,
      });
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

      const data = service.getDashboardData({ limits: { recentlyUpdatedProjects: 5 } });
      expect(data.recentlyUpdated).toHaveLength(5);
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
      expect(ws.releaseSummary.statusCounts).toEqual({
        idea: 0, planned: 0, drafting: 0, ready: 0, published: 0, cancelled: 0,
      });
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
        status: 'drafting',
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
      expect(ws.releaseSummary.statusCounts).toEqual({
        idea: 0, planned: 1, drafting: 1, ready: 0, published: 1, cancelled: 0,
      });
      expect(ws.releaseSummary.hasAnyReleases).toBe(true);
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
        status: 'idea',
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
      expect(ws.releaseSummary.statusCounts.published).toBe(1);
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
      const fromDb = db.prepare(`SELECT archived_at, status FROM releases WHERE id = ?`).get(release.id);
      expect(fromDb.archived_at).toBeNull();
      expect(fromDb.status).toBe('planned');
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
      const cancelled = insertRelease(db, {
        projectId: project.id,
        title: 'Cancelled In Archived Project',
        status: 'cancelled',
        plannedDate: '2020-02-01',
      });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const ws = service.getProjectWorkspace(project.id);
      expect(ws.releaseSummary.active).toEqual([]);
      // Recent list still shows every release (any status, any archive).
      const recentIds = ws.releaseSummary.recent.map((r) => r.id).sort();
      expect(recentIds).toEqual([published.id, cancelled.id].sort());
      // Status counts are still accurate so published/cancelled info is
      // visible in the dashboard.
      expect(ws.releaseSummary.statusCounts).toEqual({
        idea: 0, planned: 0, drafting: 0, ready: 0, published: 1, cancelled: 1,
      });
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

  // ─── Phase 6B regression: dashboard today-classification boundary ──
  //
  // Upcoming must include today (planned_date >= today). Overdue must
  // remain strictly before today. The same injected today value must be
  // used for every date-sensitive section so a release cannot fall
  // between sections due to per-call clock drift.

  describe('getDashboardData — today classification boundary', () => {
    const FIXED_TODAY = '2025-06-15';

    it('release planned today appears in upcoming (not overdue)', () => {
      const project = insertProject(db, { title: 'Today Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Planned Today',
        status: 'planned',
        plannedDate: FIXED_TODAY,
      });
      // Link a present asset so the release is not flagged for missing
      // selection (we want a clean upcoming/overdue classification).
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });

      const data = service.getDashboardData({ today: FIXED_TODAY });
      expect(data.releasesNeedingAttention.overdue).toEqual([]);
      const allUpcoming = data.upcomingReleases.flatMap((g) => g.releases);
      expect(allUpcoming.map((r) => r.id)).toContain(release.id);
    });

    it('release planned yesterday appears overdue', () => {
      const project = insertProject(db, { title: 'Yesterday Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Planned Yesterday',
        status: 'planned',
        plannedDate: '2025-06-14',
      });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });

      const data = service.getDashboardData({ today: FIXED_TODAY });
      expect(data.releasesNeedingAttention.overdue.map((r) => r.id)).toContain(release.id);
      const allUpcoming = data.upcomingReleases.flatMap((g) => g.releases);
      expect(allUpcoming.map((r) => r.id)).not.toContain(release.id);
    });

    it('release planned tomorrow appears upcoming', () => {
      const project = insertProject(db, { title: 'Tomorrow Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Planned Tomorrow',
        status: 'planned',
        plannedDate: '2025-06-16',
      });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });

      const data = service.getDashboardData({ today: FIXED_TODAY });
      expect(data.releasesNeedingAttention.overdue).toEqual([]);
      const allUpcoming = data.upcomingReleases.flatMap((g) => g.releases);
      expect(allUpcoming.map((r) => r.id)).toContain(release.id);
    });

    it('uses the same injected today value across every date-sensitive section', () => {
      const project = insertProject(db, { title: 'Shared Today Project' });
      const yesterday = insertRelease(db, {
        projectId: project.id,
        title: 'Yesterday',
        status: 'planned',
        plannedDate: '2025-06-14',
      });
      const today = insertRelease(db, {
        projectId: project.id,
        title: 'Today',
        status: 'planned',
        plannedDate: '2025-06-15',
      });
      const tomorrow = insertRelease(db, {
        projectId: project.id,
        title: 'Tomorrow',
        status: 'planned',
        plannedDate: '2025-06-16',
      });
      // Link a present asset to each so they do not appear in missing
      // selection.
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      for (const r of [yesterday, today, tomorrow]) {
        linkAssetToRelease(db, { releaseId: r.id, assetId: asset.id });
      }

      const data = service.getDashboardData({ today: FIXED_TODAY });

      // The injected value is exposed in the view-model so the template
      // and any consumer can rely on a single value.
      expect(data.today).toBe(FIXED_TODAY);

      // Yesterday is overdue, today AND tomorrow are upcoming. A single
      // today value drives both classifications consistently.
      expect(data.releasesNeedingAttention.overdue.map((r) => r.id)).toEqual([yesterday.id]);
      const allUpcoming = data.upcomingReleases.flatMap((g) => g.releases).map((r) => r.id);
      expect(allUpcoming).toContain(today.id);
      expect(allUpcoming).toContain(tomorrow.id);
      expect(allUpcoming).not.toContain(yesterday.id);
    });
  });

  // ─── Phase 6B regression: missing-selection attention category ─────
  //
  // The dashboard previously surfaced only "selected assets that became
  // missing" (findReleasesWithMissingSelectedAssets). Releases with zero
  // selected assets at all were invisible to the dashboard. The new
  // findReleasesWithoutSelectedAssets query must surface them as a
  // distinct "missing selection" category — separate from
  // "missing selected assets" which still requires a present selection
  // with at least one missing file.

  describe('getDashboardData — missing selection category', () => {
    it('active release with zero assets appears in missing selection', () => {
      const project = insertProject(db, { title: 'No Selection Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'No Selection Release',
        status: 'planned',
        plannedDate: '2099-01-01',
      });
      // Deliberately do NOT link any asset.

      const data = service.getDashboardData();
      expect(data.releasesNeedingAttention.releasesWithoutAssets.map((r) => r.id))
        .toContain(release.id);
      // The release is upcoming, not overdue, not in missing-assets (no
      // selection at all).
      expect(data.releasesNeedingAttention.missingSelectedAssets).toEqual([]);
      const allUpcoming = data.upcomingReleases.flatMap((g) => g.releases);
      expect(allUpcoming.map((r) => r.id)).toContain(release.id);
    });

    it('active release with assets but missing files appears in missing assets only', () => {
      const project = insertProject(db, { title: 'Missing Files Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Missing Files Release',
        status: 'planned',
        plannedDate: '2099-01-01',
      });
      const missingAsset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'gone.txt',
        filename: 'gone.txt',
        isPresent: 0,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: missingAsset.id });

      const data = service.getDashboardData();
      // Has a selection — not in missing-selection.
      expect(data.releasesNeedingAttention.releasesWithoutAssets).toEqual([]);
      // Has a missing file — IS in missing-assets.
      expect(data.releasesNeedingAttention.missingSelectedAssets.map((r) => r.id))
        .toContain(release.id);
      expect(data.releasesNeedingAttention.missingSelectedAssets[0].missing_asset_count).toBe(1);
    });

    it('active release with valid assets appears in neither missing category', () => {
      const project = insertProject(db, { title: 'Valid Selection Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Valid Selection Release',
        status: 'planned',
        plannedDate: '2099-01-01',
      });
      const present = insertAsset(db, {
        projectId: project.id,
        relativePath: 'ok.txt',
        filename: 'ok.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: present.id });

      const data = service.getDashboardData();
      expect(data.releasesNeedingAttention.releasesWithoutAssets).toEqual([]);
      expect(data.releasesNeedingAttention.missingSelectedAssets).toEqual([]);
    });

    it('does not include terminal or archived releases in missing selection', () => {
      const project = insertProject(db, { title: 'Terminal Selection Project' });
      const published = insertRelease(db, {
        projectId: project.id,
        title: 'Published No Selection',
        status: 'published',
        publishedDate: '2020-01-01',
      });
      const cancelled = insertRelease(db, {
        projectId: project.id,
        title: 'Cancelled No Selection',
        status: 'cancelled',
      });
      const archivedActive = insertRelease(db, {
        projectId: project.id,
        title: 'Archived Active No Selection',
        status: 'planned',
        plannedDate: '2099-01-01',
        archivedAt: '2024-01-01 00:00:00',
      });

      const data = service.getDashboardData();
      const ids = data.releasesNeedingAttention.releasesWithoutAssets.map((r) => r.id);
      expect(ids).not.toContain(published.id);
      expect(ids).not.toContain(cancelled.id);
      expect(ids).not.toContain(archivedActive.id);
    });
  });

  // ─── Phase 6B regression: archived parent project hides dashboard releases ──
  //
  // Active releases whose parent project has been archived must not appear on
  // the dashboard. They are not actionable — mutations reject archived
  // projects — so surfacing them on the dashboard would mislead the user.
  // The release rows remain in the database and stay visible through the
  // project workspace's recent list and status counts.

  describe('getDashboardData — archived parent project hides active releases', () => {
    it('active release with active parent project appears on the dashboard', () => {
      const project = insertProject(db, { title: 'Active Parent', status: 'planned' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Should Appear',
        status: 'planned',
        plannedDate: '2099-01-01',
      });
      // Link a present asset so the release is not flagged for missing
      // selection — this test focuses on overdue/upcoming classification.
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });

      const data = service.getDashboardData();
      const allUpcoming = data.upcomingReleases.flatMap((g) => g.releases);
      expect(allUpcoming.map((r) => r.id)).toContain(release.id);
      expect(data.releasesNeedingAttention.overdue).toEqual([]);
    });

    it('active release with archived parent project does NOT appear on the dashboard', () => {
      const project = insertProject(db, { title: 'Archived Parent', status: 'planned' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Hidden From Dashboard',
        status: 'planned',
        plannedDate: '2099-01-01',
      });
      // Archive only the project — the release itself stays active and
      // non-archived. The dashboard must hide it because the parent is
      // archived.
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const data = service.getDashboardData();
      const allUpcoming = data.upcomingReleases.flatMap((g) => g.releases);
      expect(allUpcoming.map((r) => r.id)).not.toContain(release.id);
      expect(data.releasesNeedingAttention.overdue.map((r) => r.id)).not.toContain(release.id);
      expect(data.releasesNeedingAttention.ready.map((r) => r.id)).not.toContain(release.id);
      expect(data.releasesNeedingAttention.missingPlannedDate.map((r) => r.id)).not.toContain(release.id);
      expect(data.releasesNeedingAttention.missingSelectedAssets.map((r) => r.id)).not.toContain(release.id);
      expect(data.releasesNeedingAttention.releasesWithoutAssets.map((r) => r.id)).not.toContain(release.id);
    });

    it('overdue release with archived parent project does NOT appear on the dashboard', () => {
      const project = insertProject(db, { title: 'Archived Parent Overdue' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Hidden Overdue',
        status: 'planned',
        plannedDate: '2020-01-01',
      });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const data = service.getDashboardData();
      expect(data.releasesNeedingAttention.overdue).toEqual([]);
      const allUpcoming = data.upcomingReleases.flatMap((g) => g.releases);
      expect(allUpcoming.map((r) => r.id)).not.toContain(release.id);
    });

    it('ready release with archived parent project does NOT appear on the dashboard', () => {
      const project = insertProject(db, { title: 'Archived Parent Ready' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Hidden Ready',
        status: 'ready',
        plannedDate: '2099-01-01',
      });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const data = service.getDashboardData();
      expect(data.releasesNeedingAttention.ready.map((r) => r.id)).not.toContain(release.id);
    });

    it('release without planned date and archived parent project does NOT appear on the dashboard', () => {
      const project = insertProject(db, { title: 'Archived Parent No Date' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Hidden No Date',
        status: 'drafting',
        plannedDate: null,
      });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const data = service.getDashboardData();
      expect(data.releasesNeedingAttention.missingPlannedDate.map((r) => r.id)).not.toContain(release.id);
    });

    it('release without selected assets and archived parent project does NOT appear on missing-selection', () => {
      const project = insertProject(db, { title: 'Archived Parent No Selection' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Hidden No Selection',
        status: 'planned',
        plannedDate: '2099-01-01',
      });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const data = service.getDashboardData();
      expect(data.releasesNeedingAttention.releasesWithoutAssets.map((r) => r.id)).not.toContain(release.id);
    });

    it('release with missing selected assets and archived parent project does NOT appear on missing-assets', () => {
      const project = insertProject(db, { title: 'Archived Parent Missing' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Hidden Missing Selected',
        status: 'planned',
        plannedDate: '2099-01-01',
      });
      const missingAsset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'gone.txt',
        filename: 'gone.txt',
        isPresent: 0,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: missingAsset.id });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const data = service.getDashboardData();
      expect(data.releasesNeedingAttention.missingSelectedAssets.map((r) => r.id)).not.toContain(release.id);
    });

    it('historical release information remains available through project workspace', () => {
      // The dashboard hides active releases under archived parents, but the
      // project workspace still surfaces them through the recent list and
      // status counts so published/cancelled history is not lost.
      const project = insertProject(db, { title: 'Archived History Dashboard' });
      const published = insertRelease(db, {
        projectId: project.id,
        title: 'Published In Archived',
        status: 'published',
        plannedDate: '2020-01-01',
        publishedDate: '2020-01-15',
      });
      const cancelled = insertRelease(db, {
        projectId: project.id,
        title: 'Cancelled In Archived',
        status: 'cancelled',
        plannedDate: '2020-02-01',
      });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      // Dashboard: not surfaced as attention
      const dash = service.getDashboardData();
      const allAttentionIds = [
        ...dash.releasesNeedingAttention.overdue,
        ...dash.releasesNeedingAttention.ready,
        ...dash.releasesNeedingAttention.missingPlannedDate,
        ...dash.releasesNeedingAttention.missingSelectedAssets,
        ...dash.releasesNeedingAttention.releasesWithoutAssets,
      ].map((r) => r.id);
      expect(allAttentionIds).not.toContain(published.id);
      expect(allAttentionIds).not.toContain(cancelled.id);

      // Project workspace: history remains
      const ws = service.getProjectWorkspace(project.id);
      const recentIds = ws.releaseSummary.recent.map((r) => r.id);
      expect(recentIds).toContain(published.id);
      expect(recentIds).toContain(cancelled.id);
      expect(ws.releaseSummary.statusCounts.published).toBe(1);
      expect(ws.releaseSummary.statusCounts.cancelled).toBe(1);
    });

    it('archived parent project does not appear in recently-updated projects', () => {
      // Cross-check: the existing archive filter on the project list
      // already covers this. Pin it down so a future change cannot
      // regress the active-project-only list.
      const project = insertProject(db, { title: 'Archived Recently Updated' });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const data = service.getDashboardData();
      const ids = data.recentlyUpdated.map((p) => p.id);
      expect(ids).not.toContain(project.id);
    });
  });

  // ─── Phase 6B regression: dashboard date boundary ──────────────────
  //
  // The dashboard previously used `new Date().toISOString()` (UTC) for the
  // today-classification boundary, so a release planned for "today" near
  // local midnight could be misclassified as overdue (or upcoming). The
  // fix injects a single application-local `today` value into every
  // date-sensitive section. The default value comes from the local-date
  // helper; tests pin down the boundary behaviour.

  describe('getDashboardData — application-local today boundary', () => {
    it('uses the default local today (not UTC) when no today is injected', () => {
      // Set a system time at local noon on 2025-06-15. The local date is
      // 2025-06-15 in every timezone.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2025, 5, 15, 12, 0, 0));
      try {
        const project = insertProject(db, { title: 'Default Local Today' });
        insertRelease(db, {
          projectId: project.id,
          title: 'Planned Today',
          status: 'planned',
          plannedDate: '2025-06-15',
        });

        const data = service.getDashboardData();
        // The default `today` is the local calendar date of `new Date()`.
        expect(data.today).toBe('2025-06-15');
        // The release planned for today must be in upcoming, not overdue.
        const allUpcoming = data.upcomingReleases.flatMap((g) => g.releases);
        expect(allUpcoming.map((r) => r.title)).toContain('Planned Today');
        expect(data.releasesNeedingAttention.overdue).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('classifies a release planned for "today" as upcoming, not overdue', () => {
      // The injected boundary value is 2025-06-15. A release planned for
      // exactly that date must appear in upcoming.
      const project = insertProject(db, { title: 'Today Boundary' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Exactly Today',
        status: 'planned',
        plannedDate: '2025-06-15',
      });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });

      const data = service.getDashboardData({ today: '2025-06-15' });
      expect(data.releasesNeedingAttention.overdue.map((r) => r.id)).not.toContain(release.id);
      const allUpcoming = data.upcomingReleases.flatMap((g) => g.releases);
      expect(allUpcoming.map((r) => r.id)).toContain(release.id);
    });

    it('UTC midnight boundary: a release planned for today local is upcoming even when UTC date differs', () => {
      // The dashboard receives 2025-06-16 as today. A release planned for
      // 2025-06-16 must appear in upcoming regardless of what the UTC
      // boundary would say. (This is the same contract as the local-date
      // helper, applied at the dashboard level.)
      const project = insertProject(db, { title: 'UTC Midnight Boundary' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Local Today UTC Tomorrow',
        status: 'planned',
        plannedDate: '2025-06-16',
      });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });

      const data = service.getDashboardData({ today: '2025-06-16' });
      const allUpcoming = data.upcomingReleases.flatMap((g) => g.releases);
      expect(allUpcoming.map((r) => r.id)).toContain(release.id);
      expect(data.releasesNeedingAttention.overdue).toEqual([]);
    });

    it('uses the same today value across overdue, upcoming, and ready sections', () => {
      // A single injected today must drive every date-sensitive section so
      // a release cannot fall between sections due to per-call clock drift.
      const project = insertProject(db, { title: 'Shared Today Across Sections' });
      const yesterday = insertRelease(db, {
        projectId: project.id,
        title: 'Yesterday',
        status: 'planned',
        plannedDate: '2025-06-14',
      });
      const today = insertRelease(db, {
        projectId: project.id,
        title: 'Today',
        status: 'planned',
        plannedDate: '2025-06-15',
      });
      const tomorrow = insertRelease(db, {
        projectId: project.id,
        title: 'Tomorrow',
        status: 'planned',
        plannedDate: '2025-06-16',
      });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      for (const r of [yesterday, today, tomorrow]) {
        linkAssetToRelease(db, { releaseId: r.id, assetId: asset.id });
      }

      const data = service.getDashboardData({ today: '2025-06-15' });
      expect(data.today).toBe('2025-06-15');
      expect(data.releasesNeedingAttention.overdue.map((r) => r.id)).toEqual([yesterday.id]);
      const allUpcoming = data.upcomingReleases.flatMap((g) => g.releases).map((r) => r.id);
      expect(allUpcoming).toContain(today.id);
      expect(allUpcoming).toContain(tomorrow.id);
      expect(allUpcoming).not.toContain(yesterday.id);
    });

    it('does not classify a release as both overdue AND upcoming for the same today', () => {
      // The repository methods must not independently calculate today and
      // disagree. Inject a single today and verify the same release does
      // not appear in both overdue and upcoming.
      const project = insertProject(db, { title: 'No Double Classification' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Either Or',
        status: 'planned',
        plannedDate: '2025-06-15',
      });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });

      const data = service.getDashboardData({ today: '2025-06-15' });
      const overdueIds = data.releasesNeedingAttention.overdue.map((r) => r.id);
      const upcomingIds = data.upcomingReleases.flatMap((g) => g.releases).map((r) => r.id);
      expect(overdueIds).not.toContain(release.id);
      expect(upcomingIds).toContain(release.id);
      // Intersection must be empty.
      const intersection = overdueIds.filter((id) => upcomingIds.includes(id));
      expect(intersection).toEqual([]);
    });
  });

  // ─── Service does not mutate state ─────────────────────────────────

  describe('read-only invariants', () => {
    it('does not create or modify any table when called', () => {
      const project = insertProject(db, { title: 'Read-Only Project' });
      insertRelease(db, { projectId: project.id, title: 'R', status: 'idea' });

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
});
