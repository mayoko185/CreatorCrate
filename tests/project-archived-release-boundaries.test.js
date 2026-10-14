import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectRepository } from '../src/data/project-repository.js';
import { createReleaseRepository } from '../src/data/release-repository.js';
import { createAssetRepository } from '../src/data/asset-repository.js';
import { createReleaseService, ReleaseParentArchivedError } from '../src/services/release-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function projectInput(title) {
  return {
    title,
    slug: title.toLowerCase().replaceAll(' ', '-'),
    description: '',
    notes: '',
    status: 'tbd',
    projectType: 'images',
    priority: 'normal',
    plannedDate: null,
    publishedDate: null,
    patreonUrl: null,
  };
}

function releaseInput(title, plannedDate = null) {
  return {
    title,
    description: '',
    notes: '',
    plannedDate,
    plannedTime: null,
    publishedDate: null,
    patreonUrl: null,
  };
}

function assetInput(projectId, filename) {
  return {
    projectId,
    relativePath: filename,
    filename,
    extension: 'txt',
    mimeType: 'text/plain',
    sizeBytes: 1,
    modifiedAt: '2026-09-09T00:00:00Z',
  };
}

describe('legacy status-only Archived release boundaries', () => {
  let tmpDir;
  let db;
  let projectRepository;
  let releaseRepository;
  let assetRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-archived-release-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    projectRepository = createProjectRepository(db);
    releaseRepository = createReleaseRepository(db);
    assetRepository = createAssetRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects service mutation for a status-only archived parent and preserves active mutation', () => {
    const service = createReleaseService({ db });
    const archivedProject = projectRepository.create(projectInput('Legacy Archived Service'));
    const archivedRelease = service.createRelease(archivedProject.id, releaseInput('Before'));
    db.prepare("UPDATE projects SET status = 'archived', archived_at = NULL WHERE id = ?").run(archivedProject.id);

    expect(() => service.updateRelease(archivedRelease.id, releaseInput('Must Not Change')))
      .toThrow(ReleaseParentArchivedError);
    expect(service.findRelease(archivedRelease.id).title).toBe('Before');

    const activeProject = projectRepository.create(projectInput('Active Service Control'));
    const activeRelease = service.createRelease(activeProject.id, releaseInput('Active Before'));
    expect(service.updateRelease(activeRelease.id, releaseInput('Active After')).title).toBe('Active After');
  });

  it('excludes a status-only archived parent from both active-parent SQL predicates', () => {
    const archivedProject = projectRepository.create(projectInput('Legacy Archived SQL'));
    const activeProject = projectRepository.create(projectInput('Active SQL Control'));
    const archivedRelease = releaseRepository.create({
      projectId: archivedProject.id,
      ...releaseInput('Hidden Overdue', '2020-01-01'),
    });
    const activeRelease = releaseRepository.create({
      projectId: activeProject.id,
      ...releaseInput('Visible Overdue', '2020-01-01'),
    });
    const archivedMissing = assetRepository.upsert(
      archivedProject.id,
      'archived-missing.txt',
      assetInput(archivedProject.id, 'archived-missing.txt'),
    );
    const activeMissing = assetRepository.upsert(
      activeProject.id,
      'active-missing.txt',
      assetInput(activeProject.id, 'active-missing.txt'),
    );
    db.prepare("UPDATE assets SET is_present = 0, missing_since = datetime('now') WHERE id IN (?, ?)")
      .run(archivedMissing.id, activeMissing.id);
    releaseRepository.addReleaseAsset(archivedRelease.id, archivedMissing.id, 'attachment', 0);
    releaseRepository.addReleaseAsset(activeRelease.id, activeMissing.id, 'attachment', 0);
    db.prepare("UPDATE projects SET status = 'archived', archived_at = NULL WHERE id = ?").run(archivedProject.id);

    const overdueIds = releaseRepository.findOverdue(10, '2025-06-15').map((release) => release.id);
    expect(overdueIds).not.toContain(archivedRelease.id);
    expect(overdueIds).toContain(activeRelease.id);

    const missingIds = releaseRepository.findReleasesWithMissingSelectedAssets(10).map((release) => release.id);
    expect(missingIds).not.toContain(archivedRelease.id);
    expect(missingIds).toContain(activeRelease.id);
  });

  it('excludes a status-only archived parent from every Dashboard projection', () => {
    const archivedProject = projectRepository.create(projectInput('Legacy Archived Dashboard'));
    const activeProject = projectRepository.create(projectInput('Active Dashboard Control'));
    for (const project of [archivedProject, activeProject]) {
      releaseRepository.create({ projectId: project.id, ...releaseInput('Overdue', '2025-06-10') });
      releaseRepository.create({ projectId: project.id, ...releaseInput('Undated') });
      releaseRepository.create({
        projectId: project.id,
        ...releaseInput('Published'),
        publishedDate: '2025-06-16',
      });
      const missing = assetRepository.upsert(project.id, 'missing.txt', assetInput(project.id, 'missing.txt'));
      db.prepare("UPDATE assets SET is_present = 0, missing_since = datetime('now') WHERE id = ?").run(missing.id);
      const release = releaseRepository.create({ projectId: project.id, ...releaseInput('Missing', '2025-06-17') });
      releaseRepository.addReleaseAsset(release.id, missing.id, 'attachment', 0);
    }
    db.prepare("UPDATE projects SET status = 'archived', archived_at = NULL WHERE id = ?").run(archivedProject.id);

    const boundaries = { today: '2025-06-15', weekEnd: '2025-06-22' };
    expect(releaseRepository.getDashboardScheduleSummary(boundaries))
      .toMatchObject({ overdue: 1, today: 0, next7: 1, later: 0, undated: 1 });
    const projectIdsOf = (rows) => new Set(rows.map((row) => row.project_id));
    expect(projectIdsOf(releaseRepository.findDashboardScheduledReleases(boundaries))).toEqual(new Set([activeProject.id]));
    expect(projectIdsOf(releaseRepository.findDashboardUndatedReleases())).toEqual(new Set([activeProject.id]));
    expect(projectIdsOf(releaseRepository.findRecentlyPublished())).toEqual(new Set([activeProject.id]));
    expect(releaseRepository.countDashboardCalendarDays({ startDate: '2025-06-09', endDate: '2025-06-23', today: '2025-06-15' }))
      .toEqual([
        { date: '2025-06-10', published: 0, scheduled: 0, overdue: 1 },
        { date: '2025-06-16', published: 1, scheduled: 0, overdue: 0 },
        { date: '2025-06-17', published: 0, scheduled: 1, overdue: 0 },
      ]);
    expect(projectIdsOf(releaseRepository.findReleasesWithMissingSelectedAssets(10))).toEqual(new Set([activeProject.id]));
    expect(assetRepository.countMissingInActiveProjects()).toBe(1);
    expect(releaseRepository.findReleaseScheduleSummaryByProjectIds([archivedProject.id]))
      .toEqual([expect.objectContaining({ next_release_id: null, undated_count: 0 })]);
  });
});
