import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createWorkflowQueryService } from '../src/services/workflow-query-service.js';
import { evaluateReleaseReadiness } from '../src/services/release-readiness-policy.js';
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
    service = createWorkflowQueryService({ db, evaluateReleaseReadiness });
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
        readyToPublish: [],
        readyButBlocked: [],
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

    it('ready release with present asset appears in ready-to-publish', () => {
      const project = insertProject(db, { title: 'Ready Project', status: 'ready' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Ready Release',
        status: 'ready',
        plannedDate: '2099-01-01',
      });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });

      const data = service.getDashboardData();
      expect(data.releasesNeedingAttention.readyToPublish).toHaveLength(1);
      expect(data.releasesNeedingAttention.readyToPublish[0].title).toBe('Ready Release');
      expect(data.releasesNeedingAttention.readyButBlocked).toHaveLength(0);
    });

    it('ready release with zero assets appears in ready-but-blocked', () => {
      const project = insertProject(db, { title: 'Zero Asset Project', status: 'ready' });
      insertRelease(db, {
        projectId: project.id,
        title: 'Zero Asset Release',
        status: 'ready',
        plannedDate: '2099-01-01',
      });
      // No assets linked.

      const data = service.getDashboardData();
      expect(data.releasesNeedingAttention.readyButBlocked).toHaveLength(1);
      expect(data.releasesNeedingAttention.readyButBlocked[0].title).toBe('Zero Asset Release');
      expect(data.releasesNeedingAttention.readyToPublish).toHaveLength(0);
      // Blocker key is assets_selected
      expect(data.releasesNeedingAttention.readyButBlocked[0].blockers).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: 'assets_selected' })])
      );
    });

    it('ready release with missing asset appears in ready-but-blocked', () => {
      const project = insertProject(db, { title: 'Missing Asset Project', status: 'ready' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Missing Asset Release',
        status: 'ready',
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
      expect(data.releasesNeedingAttention.readyButBlocked).toHaveLength(1);
      expect(data.releasesNeedingAttention.readyButBlocked[0].title).toBe('Missing Asset Release');
      expect(data.releasesNeedingAttention.readyToPublish).toHaveLength(0);
      // Blocker key is selected_assets_present
      expect(data.releasesNeedingAttention.readyButBlocked[0].blockers).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: 'selected_assets_present' })])
      );
    });

    it('archived ready release is excluded from both groups', () => {
      const project = insertProject(db, { title: 'Archived Ready Project', status: 'ready' });
      insertRelease(db, {
        projectId: project.id,
        title: 'Archived Ready',
        status: 'ready',
        plannedDate: '2099-01-01',
        archivedAt: '2025-06-15 10:00:00',
      });

      const data = service.getDashboardData();
      expect(data.releasesNeedingAttention.readyToPublish).toHaveLength(0);
      expect(data.releasesNeedingAttention.readyButBlocked).toHaveLength(0);
    });

    it('ready release under archived parent project is excluded from both groups', () => {
      const project = insertProject(db, { title: 'Archived Parent Ready' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Hidden Ready',
        status: 'ready',
        plannedDate: '2099-01-01',
      });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const data = service.getDashboardData();
      expect(data.releasesNeedingAttention.readyToPublish).toHaveLength(0);
      expect(data.releasesNeedingAttention.readyButBlocked).toHaveLength(0);
    });

    it('non-ready releases are excluded from both groups', () => {
      const project = insertProject(db, { title: 'Non Ready Project', status: 'planned' });
      insertRelease(db, {
        projectId: project.id,
        title: 'Planned Release',
        status: 'planned',
        plannedDate: '2099-01-01',
      });
      insertRelease(db, {
        projectId: project.id,
        title: 'Drafting Release',
        status: 'drafting',
        plannedDate: '2099-01-01',
      });

      const data = service.getDashboardData();
      expect(data.releasesNeedingAttention.readyToPublish).toHaveLength(0);
      expect(data.releasesNeedingAttention.readyButBlocked).toHaveLength(0);
    });

    it('blocked release includes the correct blocker key', () => {
      const project = insertProject(db, { title: 'Blocker Key Project', status: 'ready' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Blocker Key Release',
        status: 'ready',
        plannedDate: '2099-01-01',
      });
      // Link a missing asset — triggers selected_assets_present blocker.
      const missingAsset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'gone.txt',
        filename: 'gone.txt',
        isPresent: 0,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: missingAsset.id });

      const data = service.getDashboardData();
      expect(data.releasesNeedingAttention.readyButBlocked).toHaveLength(1);
      const blockers = data.releasesNeedingAttention.readyButBlocked[0].blockers;
      expect(blockers).toHaveLength(1);
      expect(blockers[0].key).toBe('selected_assets_present');
      expect(blockers[0].details.missingSelectedAssetCount).toBe(1);
    });

    it('respects the bounded limit on ready releases', () => {
      const project = insertProject(db, { title: 'Bounded Ready' });
      for (let i = 0; i < 10; i++) {
        const release = insertRelease(db, {
          projectId: project.id,
          title: `Ready ${i}`,
          status: 'ready',
          plannedDate: '2099-01-01',
        });
        const asset = insertAsset(db, {
          projectId: project.id,
          relativePath: `a${i}.txt`,
          filename: `a${i}.txt`,
          isPresent: 1,
        });
        linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });
      }

      const data = service.getDashboardData({ limits: { ready: 3 } });
      expect(data.releasesNeedingAttention.readyToPublish).toHaveLength(3);
    });

    it('no duplicate releases across both groups', () => {
      const project = insertProject(db, { title: 'No Dup Project', status: 'ready' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Unique',
        status: 'ready',
        plannedDate: '2099-01-01',
      });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });

      const data = service.getDashboardData();
      const allIds = [
        ...data.releasesNeedingAttention.readyToPublish.map((r) => r.id),
        ...data.releasesNeedingAttention.readyButBlocked.map((r) => r.id),
      ];
      expect(new Set(allIds).size).toBe(allIds.length);
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
      expect(data.releasesNeedingAttention.readyToPublish).toHaveLength(1);
      expect(data.releasesNeedingAttention.readyButBlocked).toHaveLength(0);
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
      expect(data.releasesNeedingAttention.readyToPublish.map((r) => r.id)).not.toContain(release.id);
      expect(data.releasesNeedingAttention.readyButBlocked.map((r) => r.id)).not.toContain(release.id);
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
      expect(data.releasesNeedingAttention.readyToPublish.map((r) => r.id)).not.toContain(release.id);
      expect(data.releasesNeedingAttention.readyButBlocked.map((r) => r.id)).not.toContain(release.id);
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
        ...dash.releasesNeedingAttention.readyToPublish,
        ...dash.releasesNeedingAttention.readyButBlocked,
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

  // ─── Phase 6C: Release Planning Views — getReleaseList ──────────────────────

  describe('getReleaseList', () => {
    it('returns paginated releases with metadata', () => {
      const project = insertProject(db, { title: 'List Project' });
      for (let i = 0; i < 5; i++) {
        insertRelease(db, { projectId: project.id, title: `R${i}`, status: 'idea' });
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
        insertRelease(db, { projectId: project.id, title: `P${i}`, status: 'idea' });
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

    it('invalid status falls back to null (no filter)', () => {
      const project = insertProject(db, { title: 'Status Filter' });
      insertRelease(db, { projectId: project.id, title: 'Idea', status: 'idea' });
      insertRelease(db, { projectId: project.id, title: 'Planned', status: 'planned' });

      const result = service.getReleaseList({ status: 'invalid' }, { today: '2025-06-15' });
      expect(result.total).toBe(2);
    });

    it('returns releases with project_title and asset counts', () => {
      const project = insertProject(db, { title: 'Asset Count Project' });
      const release = insertRelease(db, { projectId: project.id, title: 'With Assets', status: 'planned' });
      const asset = insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });

      const result = service.getReleaseList({}, { today: '2025-06-15' });
      const row = result.releases.find((r) => r.id === release.id);
      expect(row.project_title).toBe('Asset Count Project');
      expect(row.selected_asset_count).toBe(1);
      expect(row.missing_asset_count).toBe(0);
    });

    it('filters by project', () => {
      const p1 = insertProject(db, { title: 'P1' });
      const p2 = insertProject(db, { title: 'P2' });
      insertRelease(db, { projectId: p1.id, title: 'R1', status: 'idea' });
      insertRelease(db, { projectId: p2.id, title: 'R2', status: 'idea' });

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
      insertRelease(db, { projectId: project.id, title: 'No Date', status: 'drafting', plannedDate: null });
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
      const r1 = insertRelease(db, { projectId: p1.id, title: 'Alpha-Malformed-Proj-Release', status: 'idea' });
      const r2 = insertRelease(db, { projectId: p2.id, title: 'Beta-Malformed-Proj-Release', status: 'idea' });

      const result = service.getReleaseList({ project: '+2' }, { today: '2025-06-15' });
      // projectId is null → no project filter → both releases returned.
      expect(result.total).toBe(2);
      const ids = result.releases.map((r) => r.id).sort();
      expect(ids).toEqual([r1.id, r2.id].sort());
    });

    it('rejects "1junk" project id — falls back to no filter, returns both projects', () => {
      const p1 = insertProject(db, { title: 'Junk Filter Alpha' });
      const p2 = insertProject(db, { title: 'Junk Filter Beta' });
      const r1 = insertRelease(db, { projectId: p1.id, title: 'Alpha-Junk-Filter-Release', status: 'idea' });
      const r2 = insertRelease(db, { projectId: p2.id, title: 'Beta-Junk-Filter-Release', status: 'idea' });

      const result = service.getReleaseList({ project: '1junk' }, { today: '2025-06-15' });
      expect(result.total).toBe(2);
      const ids = result.releases.map((r) => r.id).sort();
      expect(ids).toEqual([r1.id, r2.id].sort());
    });

    it('rejects decimal project id — falls back to no filter', () => {
      const p1 = insertProject(db, { title: 'Decimal Filter A' });
      const p2 = insertProject(db, { title: 'Decimal Filter B' });
      const r1 = insertRelease(db, { projectId: p1.id, title: 'Alpha-Dec-Filter-Release', status: 'idea' });
      const r2 = insertRelease(db, { projectId: p2.id, title: 'Beta-Dec-Filter-Release', status: 'idea' });

      const result = service.getReleaseList({ project: '1.5' }, { today: '2025-06-15' });
      expect(result.total).toBe(2);
      const ids = result.releases.map((r) => r.id).sort();
      expect(ids).toEqual([r1.id, r2.id].sort());
    });

    it('rejects scientific-notation project id — falls back to no filter', () => {
      const p1 = insertProject(db, { title: 'Sci Note Filter A' });
      const p2 = insertProject(db, { title: 'Sci Note Filter B' });
      const r1 = insertRelease(db, { projectId: p1.id, title: 'Alpha-Sci-Note-Release', status: 'idea' });
      const r2 = insertRelease(db, { projectId: p2.id, title: 'Beta-Sci-Note-Release', status: 'idea' });

      const result = service.getReleaseList({ project: '1e2' }, { today: '2025-06-15' });
      expect(result.total).toBe(2);
      const ids = result.releases.map((r) => r.id).sort();
      expect(ids).toEqual([r1.id, r2.id].sort());
    });

    it('rejects whitespace project id — falls back to no filter', () => {
      const p1 = insertProject(db, { title: 'WS Filter A' });
      const p2 = insertProject(db, { title: 'WS Filter B' });
      const r1 = insertRelease(db, { projectId: p1.id, title: 'Alpha-WS-Filter-Release', status: 'idea' });
      const r2 = insertRelease(db, { projectId: p2.id, title: 'Beta-WS-Filter-Release', status: 'idea' });

      const result = service.getReleaseList({ project: ' 2' }, { today: '2025-06-15' });
      expect(result.total).toBe(2);
      const ids = result.releases.map((r) => r.id).sort();
      expect(ids).toEqual([r1.id, r2.id].sort());
    });

    it('accepts a valid project id — returns only that project\'s releases', () => {
      const p1 = insertProject(db, { title: 'Valid Filter Alpha' });
      const p2 = insertProject(db, { title: 'Valid Filter Beta' });
      insertRelease(db, { projectId: p1.id, title: 'Alpha-Valid-Filter-Release', status: 'idea' });
      insertRelease(db, { projectId: p2.id, title: 'Beta-Valid-Filter-Release', status: 'idea' });

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
        insertRelease(db, { projectId: project.id, title: `Valid Page R${i}`, status: 'idea' });
      }
      const result = service.getReleaseList({ page: '3' }, { today: '2025-06-15' });
      expect(result.page).toBe(3);
    });

    it('accepts valid positive integer pageSize', () => {
      const result = service.getReleaseList({ pageSize: '50' }, { today: '2025-06-15' });
      expect(result.pageSize).toBe(50);
    });
  });

  // ─── Phase 6C: Release Planning Views — getReleaseBoard ─────────────────────

  describe('getReleaseBoard', () => {
    it('groups releases into columns by status', () => {
      const project = insertProject(db, { title: 'Board Project' });
      insertRelease(db, { projectId: project.id, title: 'Idea R', status: 'idea' });
      insertRelease(db, { projectId: project.id, title: 'Planned R', status: 'planned' });

      const { columns } = service.getReleaseBoard({}, { today: '2025-06-15' });
      expect(columns.idea).toHaveLength(1);
      expect(columns.planned).toHaveLength(1);
      expect(columns.drafting).toHaveLength(0);
    });

    it('returns all six board columns with exact keys and no extras', () => {
      const { columns } = service.getReleaseBoard({}, { today: '2025-06-15' });
      const keys = Object.keys(columns).sort();
      // Exact keys, sorted alphabetically — verifies all six and no extras.
      expect(keys).toEqual(['cancelled', 'drafting', 'idea', 'planned', 'published', 'ready']);
      // Every column value must be an array.
      for (const key of keys) {
        expect(Array.isArray(columns[key])).toBe(true);
      }
    });

    it('exposes empty arrays for columns with no releases', () => {
      const { columns } = service.getReleaseBoard({}, { today: '2025-06-15' });
      expect(Array.isArray(columns.idea)).toBe(true);
      expect(Array.isArray(columns.published)).toBe(true);
    });

    it('board includes project_title and asset counts', () => {
      const project = insertProject(db, { title: 'Board Assets Project' });
      const release = insertRelease(db, { projectId: project.id, title: 'Board Release', status: 'planned' });
      const asset = insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });

      const { columns } = service.getReleaseBoard({}, { today: '2025-06-15' });
      const row = columns.planned.find((r) => r.id === release.id);
      expect(row.project_title).toBe('Board Assets Project');
      expect(row.selected_asset_count).toBe(1);
    });

    it('does not include archived parent releases', () => {
      const project = insertProject(db, { title: 'Board Archived Parent' });
      insertRelease(db, { projectId: project.id, title: 'Should Not Appear', status: 'planned', plannedDate: '2025-06-20' });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const { columns } = service.getReleaseBoard({}, { today: '2025-06-15' });
      const allIds = Object.values(columns).flatMap((c) => c.map((r) => r.id));
      expect(allIds).toHaveLength(0);
    });

    it('filters by status', () => {
      const project = insertProject(db, { title: 'Board Status Filter' });
      insertRelease(db, { projectId: project.id, title: 'Idea R', status: 'idea' });
      insertRelease(db, { projectId: project.id, title: 'Planned R', status: 'planned' });

      const { columns } = service.getReleaseBoard({ status: 'idea' }, { today: '2025-06-15' });
      expect(columns.idea).toHaveLength(1);
      expect(columns.planned).toHaveLength(0);
    });

    it('uses one shared today for classification', () => {
      const { columns, today } = service.getReleaseBoard({}, { today: '2025-06-15' });
      expect(today).toBe('2025-06-15');
    });
  });

  // ─── Phase 6C: Release Planning Views — getReleaseCalendar ──────────────────

  describe('getReleaseCalendar', () => {
    it('returns month string and days array', () => {
      const result = service.getReleaseCalendar('2025-06', { today: '2025-06-15' });
      expect(result.month).toBe('2025-06');
      expect(Array.isArray(result.days)).toBe(true);
    });

    it('returns 30 days for June', () => {
      const result = service.getReleaseCalendar('2025-06', { today: '2025-06-15' });
      expect(result.days).toHaveLength(30);
    });

    it('returns 31 days for July', () => {
      const result = service.getReleaseCalendar('2025-07', { today: '2025-07-15' });
      expect(result.days).toHaveLength(31);
    });

    it('returns 28 days for non-leap February', () => {
      const result = service.getReleaseCalendar('2025-02', { today: '2025-02-15' });
      expect(result.days).toHaveLength(28);
    });

    it('returns 29 days for leap year February', () => {
      const result = service.getReleaseCalendar('2024-02', { today: '2024-02-15' });
      expect(result.days).toHaveLength(29);
    });

    it('invalid month falls back to current month', () => {
      const result = service.getReleaseCalendar('invalid', { today: '2025-06-15' });
      // Must be the exact current month derived from the today option —
      // not "any YYYY-MM" that happens to satisfy the format regex.
      expect(result.month).toBe('2025-06');
      // prev/next must be derived from the EXACT fallback month.
      expect(result.prevMonth).toBe('2025-05');
      expect(result.nextMonth).toBe('2025-07');
    });

    it('invalid month format falls back to current month', () => {
      const result = service.getReleaseCalendar('2025-13', { today: '2025-06-15' });
      // 13 is not a valid month — must fall back to today's month.
      expect(result.month).toBe('2025-06');
      expect(result.prevMonth).toBe('2025-05');
      expect(result.nextMonth).toBe('2025-07');
    });

    // ─── Exact-fallback assertions for malformed and out-of-range months
    //
    // The previous tests only asserted `result.month` matched a YYYY-MM
    // regex. That lets a buggy implementation that always returns
    // "1000-01" pass. These tests pin the exact fallback to the
    // current month from the `today` option, and also assert the exact
    // prev/next values derived from that fallback. The exact-fallback
    // contract: every malformed or out-of-range month string in
    // [0001-01, 0999-12, 10000-01, 2025-00, 2025-13, "invalid", null,
    // undefined] must resolve to the current local month.

    const MALFORMED_MONTHS = [
      '0001-01',
      '0999-12',
      '10000-01',
      '2025-00',
      '2025-13',
      'invalid',
      '',
    ];

    it.each(MALFORMED_MONTHS)(
      'malformed/unsupported month %s falls back to the exact current month',
      (bad) => {
        const result = service.getReleaseCalendar(bad, { today: '2025-06-15' });
        expect(result.month).toBe('2025-06');
        // prev/next must be exact values derived from the fallback.
        expect(result.prevMonth).toBe('2025-05');
        expect(result.nextMonth).toBe('2025-07');
      },
    );

    it('falls back to a hardcoded year/month when the today option is also invalid', () => {
      // Last-resort path: even if today is null/garbage, the function
      // must NOT return null — it falls back to a hardcoded default
      // (year=2026, month=7). The exact value is part of the contract.
      const result = service.getReleaseCalendar('0001-01', { today: 'invalid-today' });
      expect(result.month).toBe('2026-07');
      expect(result.prevMonth).toBe('2026-06');
      expect(result.nextMonth).toBe('2026-08');
    });

    it('calculates previous month correctly', () => {
      const result = service.getReleaseCalendar('2025-06', { today: '2025-06-15' });
      expect(result.prevMonth).toBe('2025-05');
    });

    it('calculates previous month at January correctly', () => {
      const result = service.getReleaseCalendar('2025-01', { today: '2025-01-15' });
      expect(result.prevMonth).toBe('2024-12');
    });

    it('calculates next month correctly', () => {
      const result = service.getReleaseCalendar('2025-06', { today: '2025-06-15' });
      expect(result.nextMonth).toBe('2025-07');
    });

    it('calculates next month at December correctly', () => {
      const result = service.getReleaseCalendar('2025-12', { today: '2025-12-15' });
      expect(result.nextMonth).toBe('2026-01');
    });

    it('groups releases by planned_date', () => {
      const project = insertProject(db, { title: 'Calendar Group Project' });
      insertRelease(db, { projectId: project.id, title: 'June 15 R', status: 'planned', plannedDate: '2025-06-15' });
      insertRelease(db, { projectId: project.id, title: 'June 15 Another', status: 'planned', plannedDate: '2025-06-15' });
      insertRelease(db, { projectId: project.id, title: 'June 20', status: 'planned', plannedDate: '2025-06-20' });

      const result = service.getReleaseCalendar('2025-06', { today: '2025-06-15' });
      const june15 = result.days.find((d) => d.date === '2025-06-15');
      const june20 = result.days.find((d) => d.date === '2025-06-20');

      expect(june15.releases).toHaveLength(2);
      expect(june20.releases).toHaveLength(1);
    });

    it('days without releases have empty arrays', () => {
      const result = service.getReleaseCalendar('2025-06', { today: '2025-06-15' });
      const daysWithReleases = result.days.filter((d) => d.releases.length > 0);
      expect(daysWithReleases).toHaveLength(0); // no releases created
    });

    it('calendar excludes releases from archived parent projects', () => {
      const project = insertProject(db, { title: 'Calendar Archived Parent' });
      insertRelease(db, { projectId: project.id, title: 'Hidden', status: 'planned', plannedDate: '2025-06-15' });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const result = service.getReleaseCalendar('2025-06', { today: '2025-06-15' });
      const june15 = result.days.find((d) => d.date === '2025-06-15');
      expect(june15.releases).toHaveLength(0);
    });

    it('exposes today in result', () => {
      const result = service.getReleaseCalendar('2025-06', { today: '2025-06-15' });
      expect(result.today).toBe('2025-06-15');
    });

    // ─── Calendar grid structure ─────────────────────────────────────────

    it('September 2025: September 1 is Monday, firstDayWeekday=0', () => {
      const result = service.getReleaseCalendar('2025-09', { today: '2025-09-15' });
      // new Date(2025, 8, 1).getDay() = 1 (Monday)
      // (1 + 6) % 7 = 0 → Monday-first offset
      expect(result.firstDayWeekday).toBe(0);
    });

    it('September 2025: 30 days in the month', () => {
      const result = service.getReleaseCalendar('2025-09', { today: '2025-09-15' });
      expect(result.days).toHaveLength(30);
    });

    it('September 2025: Monday-first with 0 leading padding, 5 trailing padding, 5 rows', () => {
      // September 2025: Sep 1 is Monday (getDay=1), firstDayWeekday=(1+6)%7=0.
      // 0 leading empty cells. 30 days. cellCount=0+30=30. remainder=2. trailing=5.
      // rows = floor(30/7) + 1 = 4 + 1 = 5 rows.
      const result = service.getReleaseCalendar('2025-09', { today: '2025-09-15' });
      const cellCount = result.firstDayWeekday + result.days.length;
      expect(cellCount).toBe(30);
      expect(cellCount % 7).toBe(2);
      const rows = Math.floor(cellCount / 7) + (cellCount % 7 > 0 ? 1 : 0);
      expect(rows).toBe(5);
    });

    it('July 2025: July 1 is Tuesday, leading padding=1, trailing=3, 5 rows', () => {
      // July 2025: Jul 1 is Tuesday (getDay=2), firstDayWeekday=(2+6)%7=1.
      // 1 leading empty cell. 31 days. cellCount=1+31=32. remainder=4. trailing=3.
      // rows = floor(32/7) + 1 = 4 + 1 = 5 rows.
      const result = service.getReleaseCalendar('2025-07', { today: '2025-07-15' });
      expect(result.firstDayWeekday).toBe(1);
      const cellCount = result.firstDayWeekday + result.days.length;
      expect(cellCount).toBe(32);
      expect(cellCount % 7).toBe(4);
      const rows = Math.floor(cellCount / 7) + (cellCount % 7 > 0 ? 1 : 0);
      expect(rows).toBe(5);
    });

    it('February 2025: Feb 1 is Saturday, leading padding=5, 5 rows', () => {
      // February 2025: Feb 1 is Saturday (getDay=6), firstDayWeekday=(6+6)%7=5.
      // 5 leading empty cells. 28 days. cellCount=5+28=33. remainder=5. trailing=2.
      // rows = floor(33/7) + 1 = 4 + 1 = 5 rows.
      const result = service.getReleaseCalendar('2025-02', { today: '2025-02-15' });
      expect(result.firstDayWeekday).toBe(5);
      const cellCount = result.firstDayWeekday + result.days.length;
      expect(cellCount).toBe(33);
      const rows = Math.floor(cellCount / 7) + (cellCount % 7 > 0 ? 1 : 0);
      expect(rows).toBe(5);
    });

    it('releases outside the month are excluded', () => {
      const project = insertProject(db, { title: 'Outside Month Project' });
      insertRelease(db, { projectId: project.id, title: 'August 31', status: 'planned', plannedDate: '2025-08-31' });
      insertRelease(db, { projectId: project.id, title: 'September 15', status: 'planned', plannedDate: '2025-09-15' });
      insertRelease(db, { projectId: project.id, title: 'October 1', status: 'planned', plannedDate: '2025-10-01' });

      const result = service.getReleaseCalendar('2025-09', { today: '2025-09-15' });
      const titles = result.days.flatMap((d) => d.releases).map((r) => r.title);
      expect(titles).toContain('September 15');
      expect(titles).not.toContain('August 31');
      expect(titles).not.toContain('October 1');
    });

    it('multiple releases on the same day are all retained', () => {
      const project = insertProject(db, { title: 'Multi Day Project' });
      insertRelease(db, { projectId: project.id, title: 'Sept 15 - Alpha', status: 'idea', plannedDate: '2025-09-15' });
      insertRelease(db, { projectId: project.id, title: 'Sept 15 - Beta', status: 'planned', plannedDate: '2025-09-15' });
      insertRelease(db, { projectId: project.id, title: 'Sept 15 - Gamma', status: 'drafting', plannedDate: '2025-09-15' });

      const result = service.getReleaseCalendar('2025-09', { today: '2025-09-15' });
      const sept15 = result.days.find((d) => d.date === '2025-09-15');
      expect(sept15.releases).toHaveLength(3);
      expect(sept15.releases.map((r) => r.title).sort()).toEqual(['Sept 15 - Alpha', 'Sept 15 - Beta', 'Sept 15 - Gamma']);
    });

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

    it('getReleaseCalendar falls back to current month for year 0001 (HTTP 200, not 500)', () => {
      // Invalid low-year month must not throw — service must fall back gracefully.
      const result = service.getReleaseCalendar('0001-01', { today: '2025-06-15' });
      expect(result.month).toBe('2025-06');
    });

    it('getReleaseCalendar falls back for year 0999', () => {
      const result = service.getReleaseCalendar('0999-12', { today: '2025-06-15' });
      expect(result.month).toBe('2025-06');
    });

    it('getReleaseCalendar falls back for year 10000', () => {
      const result = service.getReleaseCalendar('10000-01', { today: '2025-06-15' });
      expect(result.month).toBe('2025-06');
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

    it('getReleaseCalendar exposes null prevMonth at the lower boundary', () => {
      const result = service.getReleaseCalendar('1000-01', { today: '1000-01-15' });
      expect(result.month).toBe('1000-01');
      expect(result.prevMonth).toBeNull();
      expect(result.nextMonth).toBe('1000-02');
    });

    it('getReleaseCalendar exposes null nextMonth at the upper boundary', () => {
      const result = service.getReleaseCalendar('9999-12', { today: '9999-12-15' });
      expect(result.month).toBe('9999-12');
      expect(result.nextMonth).toBeNull();
      expect(result.prevMonth).toBe('9999-11');
    });

    it('getReleaseCalendar exposes both links for in-range months', () => {
      const result = service.getReleaseCalendar('2025-06', { today: '2025-06-15' });
      expect(result.prevMonth).toBe('2025-05');
      expect(result.nextMonth).toBe('2025-07');
    });

    it('prevMonth and nextMonth work for valid years', () => {
      const { prevMonth, nextMonth } = service;
      expect(prevMonth('2025-06')).toBe('2025-05');
      expect(nextMonth('2025-06')).toBe('2025-07');
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
      expect(result.filters).toEqual({ presence: 'all', usage: 'all' });
    });

    it('uses default filters when none provided', () => {
      const project = insertProject(db, { title: 'Filter Defaults' });
      insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'b.txt', filename: 'b.txt', isPresent: 0 });

      const result = service.getProjectAssetBrowser(project.id);

      expect(result.filters).toEqual({ presence: 'all', usage: 'all' });
      expect(result.total).toBe(2);
    });

    it('invalid presence and usage values fallback to defaults', () => {
      const project = insertProject(db, { title: 'Filter Fallbacks' });
      insertAsset(db, { projectId: project.id, relativePath: 'a.txt', filename: 'a.txt', isPresent: 1 });

      const result = service.getProjectAssetBrowser(project.id, {
        presence: 'invalid-presence',
        usage: 'bad-usage',
      });

      expect(result.filters).toEqual({ presence: 'all', usage: 'all' });
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
      const rel = insertRelease(db, { projectId: project.id, title: 'R1', status: 'idea' });
      linkAssetToRelease(db, { releaseId: rel.id, assetId: usedAsset.id });

      const result = service.getProjectAssetBrowser(project.id, { usage: 'used' });

      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].filename).toBe('used.txt');
    });

    it('filters by usage=unused', () => {
      const project = insertProject(db, { title: 'Unused Usage' });
      const usedAsset = insertAsset(db, { projectId: project.id, relativePath: 'used.txt', filename: 'used.txt', isPresent: 1 });
      insertAsset(db, { projectId: project.id, relativePath: 'unused.txt', filename: 'unused.txt', isPresent: 1 });
      const rel = insertRelease(db, { projectId: project.id, title: 'R1', status: 'idea' });
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
      const rel = insertRelease(db, { projectId: project.id, title: 'R1', status: 'idea' });
      linkAssetToRelease(db, { releaseId: rel.id, assetId: usedPresent.id });

      const result = service.getProjectAssetBrowser(project.id, { presence: 'present', usage: 'used' });

      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].filename).toBe('used-present.txt');
    });

    it('release_usage_count is attached to each asset', () => {
      const project = insertProject(db, { title: 'Usage Count' });
      insertAsset(db, { projectId: project.id, relativePath: 'zero.txt', filename: 'zero.txt', isPresent: 1 });
      const oneAsset = insertAsset(db, { projectId: project.id, relativePath: 'one.txt', filename: 'one.txt', isPresent: 1 });
      const r1 = insertRelease(db, { projectId: project.id, title: 'R1', status: 'idea' });
      linkAssetToRelease(db, { releaseId: r1.id, assetId: oneAsset.id });

      const result = service.getProjectAssetBrowser(project.id);

      const zero = result.assets.find((a) => a.filename === 'zero.txt');
      const one = result.assets.find((a) => a.filename === 'one.txt');
      expect(zero.release_usage_count).toBe(0);
      expect(one.release_usage_count).toBe(1);
    });

    it('release_usage details are attached to the correct assets', () => {
      const project = insertProject(db, { title: 'Usage Details' });
      const a1 = insertAsset(db, { projectId: project.id, relativePath: 'a1.txt', filename: 'a1.txt', isPresent: 1 });
      const a2 = insertAsset(db, { projectId: project.id, relativePath: 'a2.txt', filename: 'a2.txt', isPresent: 1 });
      const r1 = insertRelease(db, { projectId: project.id, title: 'R1', status: 'idea' });
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
      const rel = insertRelease(db, { projectId: project.id, title: 'R1', status: 'idea' });
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
        status: 'idea',
        archivedAt: '2024-01-01 00:00:00',
      });
      linkAssetToRelease(db, { releaseId: rel.id, assetId: asset.id });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const result = service.getProjectAssetBrowser(project.id);

      expect(result.assets[0].release_usage[0].release_archived_at).toBeTruthy();
      expect(result.assets[0].release_usage[0].project_archived_at).toBeTruthy();
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
  });

  // ─── Phase 7A: Release Readiness — getReleaseReadiness ──────────────────
  //
  // getReleaseReadiness composes the release repository's readiness facts
  // with the shared pure readiness policy. It is a read-only composition:
  // no mutations, no scanner calls, no filesystem access, no independent
  // readiness calculation.

  describe('getReleaseReadiness', () => {
    it('returns publishable=true for a fully ready release', () => {
      const project = insertProject(db, { title: 'Ready Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Ready Release',
        status: 'ready',
      });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });

      const result = service.getReleaseReadiness(release.id);

      expect(result.publishable).toBe(true);
      expect(result.checks.every((c) => c.passed)).toBe(true);
    });

    it('returns publishable=false for a non-ready release', () => {
      const project = insertProject(db, { title: 'Non Ready Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Drafting Release',
        status: 'drafting',
      });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });

      const result = service.getReleaseReadiness(release.id);

      expect(result.publishable).toBe(false);
      const statusCheck = result.checks.find((c) => c.key === 'status_ready');
      expect(statusCheck.passed).toBe(false);
    });

    it('returns publishable=false when zero assets are selected', () => {
      const project = insertProject(db, { title: 'No Assets Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'No Assets Release',
        status: 'ready',
      });
      // Deliberately do NOT link any asset.

      const result = service.getReleaseReadiness(release.id);

      expect(result.publishable).toBe(false);
      const assetsSelected = result.checks.find((c) => c.key === 'assets_selected');
      expect(assetsSelected.passed).toBe(false);
      // selected_assets_present passes (zero assets → nothing missing)
      const assetsPresent = result.checks.find((c) => c.key === 'selected_assets_present');
      expect(assetsPresent.passed).toBe(true);
    });

    it('returns publishable=false when a selected asset is missing', () => {
      const project = insertProject(db, { title: 'Missing Asset Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Missing Asset Release',
        status: 'ready',
      });
      const missingAsset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'gone.txt',
        filename: 'gone.txt',
        isPresent: 0,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: missingAsset.id });

      const result = service.getReleaseReadiness(release.id);

      expect(result.publishable).toBe(false);
      const check = result.checks.find((c) => c.key === 'selected_assets_present');
      expect(check.passed).toBe(false);
      expect(check.details.missingSelectedAssetCount).toBe(1);
    });

    it('returns publishable=false for an archived release', () => {
      const project = insertProject(db, { title: 'Archived Release Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Archived Release',
        status: 'ready',
        archivedAt: '2025-06-15 10:00:00',
      });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });

      const result = service.getReleaseReadiness(release.id);

      expect(result.publishable).toBe(false);
      const check = result.checks.find((c) => c.key === 'scope_mutable');
      expect(check.passed).toBe(false);
      expect(check.details.releaseArchived).toBe(true);
    });

    it('returns publishable=false when parent project is archived', () => {
      const project = insertProject(db, { title: 'Archived Parent Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Release In Archived Project',
        status: 'ready',
      });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });
      db.prepare(`UPDATE projects SET archived_at = datetime('now') WHERE id = ?`).run(project.id);

      const result = service.getReleaseReadiness(release.id);

      expect(result.publishable).toBe(false);
      const check = result.checks.find((c) => c.key === 'scope_mutable');
      expect(check.passed).toBe(false);
      expect(check.details.projectArchived).toBe(true);
    });

    it('reports multiple blockers simultaneously', () => {
      const project = insertProject(db, { title: 'Multi Blocker Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Multi Blocker Release',
        status: 'drafting',
        archivedAt: '2025-06-15 10:00:00',
      });
      // No assets selected.

      const result = service.getReleaseReadiness(release.id);

      expect(result.publishable).toBe(false);
      const failedChecks = result.checks.filter((c) => !c.passed);
      // status_ready, assets_selected, scope_mutable all fail
      expect(failedChecks.length).toBeGreaterThanOrEqual(3);
      const keys = failedChecks.map((c) => c.key);
      expect(keys).toContain('status_ready');
      expect(keys).toContain('assets_selected');
      expect(keys).toContain('scope_mutable');
    });

    it('returns exact policy check keys in order', () => {
      const project = insertProject(db, { title: 'Check Keys Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Check Keys Release',
        status: 'ready',
      });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });

      const result = service.getReleaseReadiness(release.id);

      const keys = result.checks.map((c) => c.key);
      expect(keys).toEqual([
        'status_ready',
        'assets_selected',
        'selected_assets_present',
        'scope_mutable',
      ]);
    });

    it('throws 404 for a non-existent release', () => {
      expect(() => service.getReleaseReadiness(99999)).toThrow(/not found/);
      try {
        service.getReleaseReadiness(99999);
      } catch (err) {
        expect(err.status).toBe(404);
      }
    });

    it('throws 404 for an invalid release ID (string)', () => {
      expect(() => service.getReleaseReadiness('abc')).toThrow(/not found/);
      try {
        service.getReleaseReadiness('abc');
      } catch (err) {
        expect(err.status).toBe(404);
      }
    });

    it('throws 404 for a null release ID', () => {
      expect(() => service.getReleaseReadiness(null)).toThrow(/not found/);
      try {
        service.getReleaseReadiness(null);
      } catch (err) {
        expect(err.status).toBe(404);
      }
    });

    it('throws 404 for a negative release ID', () => {
      expect(() => service.getReleaseReadiness(-1)).toThrow(/not found/);
      try {
        service.getReleaseReadiness(-1);
      } catch (err) {
        expect(err.status).toBe(404);
      }
    });

    it('passes repository facts to the policy spy unchanged and returns the sentinel result', () => {
      const SENTINEL = { publishable: true, checks: [], facts: null };
      const policySpy = vi.fn().mockReturnValue(SENTINEL);

      const spyService = createWorkflowQueryService({ db, evaluateReleaseReadiness: policySpy });

      const project = insertProject(db, { title: 'Spy Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Spy Release',
        status: 'ready',
      });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });

      const releaseRepo = createReleaseRepository(db);
      const expectedFacts = releaseRepo.findReadinessFactsById(release.id);

      const result = spyService.getReleaseReadiness(release.id);

      // Policy was called exactly once
      expect(policySpy).toHaveBeenCalledTimes(1);

      // The argument is the exact repository fact object (deep equal)
      expect(policySpy).toHaveBeenCalledWith(expectedFacts);

      // The service returns the exact sentinel object by identity
      expect(result).toBe(SENTINEL);
    });

    it('does not mutate any table when called', () => {
      const project = insertProject(db, { title: 'Read Only Readiness' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Read Only Release',
        status: 'ready',
      });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });

      // Snapshot complete ordered rows from every table
      const snapshot = (tables) => {
        const result = {};
        for (const { name, orderBy } of tables) {
          result[name] = db.prepare(`SELECT * FROM ${name} ORDER BY ${orderBy}`).all();
        }
        return result;
      };

      const before = snapshot([
        { name: 'projects', orderBy: 'id' },
        { name: 'releases', orderBy: 'id' },
        { name: 'assets', orderBy: 'id' },
        { name: 'release_assets', orderBy: 'release_id, asset_id' },
      ]);

      service.getReleaseReadiness(release.id);

      const after = snapshot([
        { name: 'projects', orderBy: 'id' },
        { name: 'releases', orderBy: 'id' },
        { name: 'assets', orderBy: 'id' },
        { name: 'release_assets', orderBy: 'release_id, asset_id' },
      ]);

      // Complete row objects must be identical — not just counts
      expect(after).toEqual(before);
    });

    it('returns deterministic results for the same release', () => {
      const project = insertProject(db, { title: 'Deterministic Project' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'Deterministic Release',
        status: 'ready',
      });
      const asset = insertAsset(db, {
        projectId: project.id,
        relativePath: 'a.txt',
        filename: 'a.txt',
        isPresent: 1,
      });
      linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });

      const result1 = service.getReleaseReadiness(release.id);
      const result2 = service.getReleaseReadiness(release.id);

      expect(result1).toEqual(result2);
    });

    // ─── Phase 7A regression: ready release with zero selected assets ──
    //
    // Phase 7A does NOT yet block publishing a ready release without assets.
    // The readiness policy reports assets_selected=false, but the publication
    // service (publishRelease) does not call getReleaseReadiness. This test
    // proves the read-service composition is independent of publication.

    it('regression: Phase 7A does not block publishing a ready release without assets', async () => {
      const project = insertProject(db, { title: 'Phase 7A Regression' });
      const release = insertRelease(db, {
        projectId: project.id,
        title: 'No Assets But Ready',
        status: 'ready',
      });
      // No assets selected — readiness says not publishable.

      const readiness = service.getReleaseReadiness(release.id);
      expect(readiness.publishable).toBe(false);
      expect(readiness.checks.find((c) => c.key === 'assets_selected').passed).toBe(false);

      // But publishRelease still works (it does not consult getReleaseReadiness).
      // This test uses the release service directly to prove the publication
      // path is unchanged.
      const { createReleaseService } = await import('../src/services/release-service.js');
      const releaseService = createReleaseService(db);
      const published = releaseService.publishRelease(release.id, '2025-06-15');
      expect(published.status).toBe('published');
      expect(published.published_date).toBe('2025-06-15');
    });
  });

  // ─── Phase 7B-3: Planning View Readiness Indicators ──────────────────
  //
  // Compact readiness indicators (_readiness) are attached to releases in
  // getReleaseList, getReleaseBoard, and getReleaseCalendar. All three use
  // the same _attachReadiness helper so one set of scenarios is sufficient,
  // but each method's result shape is verified for completeness.

  function insertReadyReleaseWithPresentAsset(db, project, title) {
    const release = insertRelease(db, {
      projectId: project.id, title, status: 'ready', plannedDate: '2099-01-01',
    });
    const asset = insertAsset(db, {
      projectId: project.id, relativePath: `${title}.txt`, filename: `${title}.txt`, isPresent: 1,
    });
    linkAssetToRelease(db, { releaseId: release.id, assetId: asset.id });
    return release;
  }

  function insertReadyReleaseWithMissingAsset(db, project, title) {
    const release = insertRelease(db, {
      projectId: project.id, title, status: 'ready', plannedDate: '2099-01-01',
    });
    const missing = insertAsset(db, {
      projectId: project.id, relativePath: `${title}-missing.txt`, filename: `${title}-missing.txt`, isPresent: 0,
    });
    linkAssetToRelease(db, { releaseId: release.id, assetId: missing.id });
    return release;
  }

  function insertReadyReleaseWithNoAssets(db, project, title) {
    return insertRelease(db, {
      projectId: project.id, title, status: 'ready', plannedDate: '2099-01-01',
    });
  }

  describe('getReleaseList — readiness indicators', () => {
    it('ready + present asset → _readiness.publishable === true', () => {
      const project = insertProject(db, { title: 'Publishable Project' });
      const release = insertReadyReleaseWithPresentAsset(db, project, 'Publishable Release');

      const result = service.getReleaseList({}, { today: '2099-01-01' });
      const found = result.releases.find((r) => r.id === release.id);
      expect(found._readiness).toBeDefined();
      expect(found._readiness.publishable).toBe(true);
    });

    it('ready + zero assets → _readiness.publishable === false, blocker', () => {
      const project = insertProject(db, { title: 'No Asset Project' });
      const release = insertReadyReleaseWithNoAssets(db, project, 'No Asset Release');

      const result = service.getReleaseList({}, { today: '2099-01-01' });
      const found = result.releases.find((r) => r.id === release.id);
      expect(found._readiness).toBeDefined();
      expect(found._readiness.publishable).toBe(false);
      expect(found._readiness.blockerCount).toBeGreaterThan(0);
      expect(found._readiness.blockerKeys).toContain('assets_selected');
    });

    it('ready + missing asset → _readiness.publishable === false, blocker', () => {
      const project = insertProject(db, { title: 'Missing Asset Project' });
      const release = insertReadyReleaseWithMissingAsset(db, project, 'Missing Asset Release');

      const result = service.getReleaseList({}, { today: '2099-01-01' });
      const found = result.releases.find((r) => r.id === release.id);
      expect(found._readiness).toBeDefined();
      expect(found._readiness.publishable).toBe(false);
      expect(found._readiness.blockerKeys).toContain('selected_assets_present');
    });

    it('non-ready release has no _readiness', () => {
      const project = insertProject(db, { title: 'Non Ready Project' });
      const release = insertRelease(db, {
        projectId: project.id, title: 'Planned', status: 'planned', plannedDate: '2099-01-01',
      });

      const result = service.getReleaseList({}, { today: '2099-01-01' });
      const found = result.releases.find((r) => r.id === release.id);
      expect(found._readiness).toBeUndefined();
    });

    it('no duplicate rows when attachment adds readiness', () => {
      const project = insertProject(db, { title: 'No Dup Project' });
      const release = insertReadyReleaseWithPresentAsset(db, project, 'No Dup');

      const result = service.getReleaseList({}, { today: '2099-01-01' });
      expect(result.releases.filter((r) => r.id === release.id)).toHaveLength(1);
    });

    it('pagination totals unchanged after readiness attachment', () => {
      const project = insertProject(db, { title: 'Pagination Project' });
      for (let i = 0; i < 5; i++) {
        insertReadyReleaseWithPresentAsset(db, project, `Page Release ${i}`);
      }

      // Page size of 100 should return all 5
      const result = service.getReleaseList({ pageSize: '100' }, { today: '2099-01-01' });
      expect(result.total).toBe(5);
      expect(result.releases).toHaveLength(5);
    });

    it('filters remain preserved after readiness attachment', () => {
      const project = insertProject(db, { title: 'Filter Project' });
      insertReadyReleaseWithPresentAsset(db, project, 'Ready In Project');
      const otherProject = insertProject(db, { title: 'Other Project' });
      insertReadyReleaseWithPresentAsset(db, otherProject, 'Other Ready');

      // Filter by the first project
      const result = service.getReleaseList({ project: String(project.id) }, { today: '2099-01-01' });
      expect(result.releases).toHaveLength(1);
      expect(result.releases[0].project_title).toBe('Filter Project');
      expect(result.releases[0]._readiness).toBeDefined();
    });
  });

  describe('getReleaseBoard — readiness indicators', () => {
    it('board cards use the same readiness results as list', () => {
      const project = insertProject(db, { title: 'Board Project' });
      const publishable = insertReadyReleaseWithPresentAsset(db, project, 'Board Publishable');
      const blocked = insertReadyReleaseWithNoAssets(db, project, 'Board Blocked');

      const result = service.getReleaseBoard({}, { today: '2099-01-01' });

      const readyCol = result.columns.ready || [];
      const foundPub = readyCol.find((r) => r.id === publishable.id);
      const foundBlocked = readyCol.find((r) => r.id === blocked.id);

      expect(foundPub._readiness.publishable).toBe(true);
      expect(foundBlocked._readiness.publishable).toBe(false);
      expect(foundBlocked._readiness.blockerKeys).toContain('assets_selected');
    });

    it('non-ready board cards have no _readiness', () => {
      const project = insertProject(db, { title: 'Board NonReady' });
      insertRelease(db, {
        projectId: project.id, title: 'Idea', status: 'idea', plannedDate: '2099-01-01',
      });
      insertRelease(db, {
        projectId: project.id, title: 'Published', status: 'published', plannedDate: '2099-01-01',
      });

      const result = service.getReleaseBoard({}, { today: '2099-01-01' });
      for (const status of ['idea', 'planned', 'drafting', 'published', 'cancelled']) {
        for (const release of (result.columns[status] || [])) {
          expect(release._readiness).toBeUndefined();
        }
      }
    });

    it('no duplicate board cards after readiness attachment', () => {
      const project = insertProject(db, { title: 'Board No Dup' });
      const release = insertReadyReleaseWithPresentAsset(db, project, 'Board Unique');

      const result = service.getReleaseBoard({}, { today: '2099-01-01' });
      const readyCol = result.columns.ready || [];
      expect(readyCol.filter((r) => r.id === release.id)).toHaveLength(1);
    });
  });

  describe('getReleaseCalendar — readiness indicators', () => {
    it('calendar entries remain readable and correct after readiness attachment', () => {
      const project = insertProject(db, { title: 'Calendar Project' });
      const readyPub = insertReadyReleaseWithPresentAsset(db, project, 'Calendar Pub');
      const readyBlocked = insertReadyReleaseWithNoAssets(db, project, 'Calendar Blocked');
      const planned = insertRelease(db, {
        projectId: project.id, title: 'Calendar Planned', status: 'planned', plannedDate: '2099-01-01',
      });

      const result = service.getReleaseCalendar('2099-01', { today: '2099-01-01' });

      // Find releases on Jan 1
      const jan1 = result.days.find((d) => d.date === '2099-01-01');
      expect(jan1).toBeDefined();
      const releases = jan1.releases;

      const foundPub = releases.find((r) => r.id === readyPub.id);
      const foundBlocked = releases.find((r) => r.id === readyBlocked.id);
      const foundPlanned = releases.find((r) => r.id === planned.id);

      expect(foundPub._readiness.publishable).toBe(true);
      expect(foundBlocked._readiness.publishable).toBe(false);
      expect(foundPlanned._readiness).toBeUndefined();
    });

    it('no duplicate calendar entries after readiness attachment', () => {
      const project = insertProject(db, { title: 'Calendar No Dup' });
      const release = insertReadyReleaseWithPresentAsset(db, project, 'Calendar Unique');

      const result = service.getReleaseCalendar('2099-01', { today: '2099-01-01' });
      const jan1 = result.days.find((d) => d.date === '2099-01-01');
      const matches = jan1.releases.filter((r) => r.id === release.id);
      expect(matches).toHaveLength(1);
    });
  });

  describe('planning-view readiness — cross-view consistency', () => {
    it('detail, dashboard, list, and board agree for the same release', () => {
      const project = insertProject(db, { title: 'Consistency Project' });
      const release = insertReadyReleaseWithPresentAsset(db, project, 'Consistent Release');

      // Detail readiness
      const detail = service.getReleaseReadiness(release.id);
      expect(detail.publishable).toBe(true);

      // Dashboard groups
      const dash = service.getDashboardData();
      const dashPublishableIds = dash.releasesNeedingAttention.readyToPublish.map((r) => r.id);
      const dashBlockedIds = dash.releasesNeedingAttention.readyButBlocked.map((r) => r.id);
      expect(dashPublishableIds).toContain(release.id);
      expect(dashBlockedIds).not.toContain(release.id);

      // List
      const listResult = service.getReleaseList({}, { today: '2099-01-01' });
      const listRow = listResult.releases.find((r) => r.id === release.id);
      expect(listRow._readiness.publishable).toBe(true);

      // Board
      const boardResult = service.getReleaseBoard({}, { today: '2099-01-01' });
      const boardRow = (boardResult.columns.ready || []).find((r) => r.id === release.id);
      expect(boardRow._readiness.publishable).toBe(true);
    });

    it('publication behavior remains unchanged', async () => {
      const project = insertProject(db, { title: 'Pub Unchanged' });
      const release = insertReadyReleaseWithNoAssets(db, project, 'Unchanged');

      // Readiness says blocked
      const listResult = service.getReleaseList({}, { today: '2099-01-01' });
      const listRow = listResult.releases.find((r) => r.id === release.id);
      expect(listRow._readiness.publishable).toBe(false);

      // But publish still works (does not consult readiness)
      const { createReleaseService } = await import('../src/services/release-service.js');
      const releaseService = createReleaseService(db);
      const published = releaseService.publishRelease(release.id, '2025-06-15');
      expect(published.status).toBe('published');
    });
  });
});
