import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createReleaseService } from '../src/services/release-service.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

// WP11B-1: the existing Release Archive route answers the Edit Release
// dialog's enhanced submission (Accept: application/json) as JSON, with the
// real release service, repository and rules, while the native form contract
// (redirect to Release Detail, error pages) is unchanged. Every reported
// outcome is checked against the database.

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('Release Archive — enhanced JSON and native', () => {
  let tmpDir;
  let db;
  let app;
  let agent;
  let csrfToken;
  let maintenanceState;
  let releaseService;
  let activity;
  let fixtureCount = 0;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-archive-http-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const previewRoot = path.join(tmpDir, 'previews');
    fs.mkdirSync(previewRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    activity = [];
    releaseService = createReleaseService({
      db,
      applicationLogger: { info: (entry) => activity.push({ event: entry.event, releaseId: entry.context?.releaseId }) },
      socialPrepSettingsService: { getPlatforms: () => ['x', 'bluesky'] },
    });
    maintenanceState = { active: false };
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, {
      authConfig: AUTH_CONFIG, maintenanceState, releaseService,
    });
    app.locals.socialPrepSettingsService.setPlatforms(['x', 'bluesky']);
    ({ agent, csrfToken } = await authenticate(app));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { closeDatabase(db); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createProject(overrides = {}) {
    fixtureCount += 1;
    return app.locals.projectService.create({
      title: `Archive Project ${fixtureCount}`,
      description: '',
      notes: '',
      status: 'in-progress',
      ...overrides,
    });
  }

  function createRelease(projectId, overrides = {}) {
    fixtureCount += 1;
    return releaseService.createRelease(projectId, {
      title: `Release ${fixtureCount}`,
      description: 'Kept description',
      notes: 'Kept notes',
      plannedDate: '2031-07-10',
      plannedTime: '09:30',
      patreonUrl: 'https://example.com/kept',
      ...overrides,
    });
  }

  const releaseRow = (id) => db.prepare('SELECT * FROM releases WHERE id = ?').get(id);
  const platformRows = (id) => db.prepare(
    'SELECT platform, is_selected FROM release_social_platforms WHERE release_id = ? ORDER BY platform',
  ).all(id);
  const releaseAssetRows = (id) => db.prepare(
    'SELECT asset_id, role, sort_order FROM release_assets WHERE release_id = ? ORDER BY sort_order, asset_id',
  ).all(id);
  const archiveRoute = (id) => `/releases/${id}/archive`;
  const postJson = (route, body = { _csrf: csrfToken }) => agent.post(route)
    .set('Accept', 'application/json').type('form').send(body);
  const postNative = (route, body = { _csrf: csrfToken }) => agent.post(route)
    .set('Accept', 'text/html,application/xhtml+xml').type('form').send(body);
  const archiveEvents = (releaseId) => activity.filter((entry) => entry.event === 'release.archived'
    && entry.releaseId === releaseId);
  const expectNoLeak = (response) => {
    expect(response.text).not.toContain(tmpDir);
    expect(response.text).not.toMatch(/SQLITE|stack|at [A-Za-z]+ \(|\.js:\d+/);
  };
  const unchangedExceptArchive = (before, after) => {
    const strip = ({ archived_at: archivedAt, updated_at: updatedAt, ...rest }) => rest;
    expect(strip(after)).toEqual(strip(before));
  };

  function insertAsset(projectId, filename) {
    return Number(db.prepare(`INSERT INTO assets (project_id, filename, relative_path)
      VALUES (?, ?, ?)`).run(projectId, filename, filename).lastInsertRowid);
  }

  describe('H1 / H11 / H12 — confirmed archive', () => {
    it('archives with JSON, changes only archived_at, keeps assets, platforms and publication, and logs once', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      const other = createRelease(project.id, { title: 'Untouched sibling' });
      releaseService.updateRelease(release.id, { ...release, selectedPlatforms: ['x'] });
      const assetA = insertAsset(project.id, 'a.png');
      const assetB = insertAsset(project.id, 'b.png');
      releaseService.addAssetToRelease(release.id, assetA, 'attachment', 0);
      releaseService.addAssetToRelease(release.id, assetB, 'attachment', 1);
      activity.length = 0;
      const before = releaseRow(release.id);
      const beforeAssets = releaseAssetRows(release.id);
      const beforePlatforms = platformRows(release.id);
      const otherBefore = releaseRow(other.id);
      const projectBefore = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);

      const response = await postJson(archiveRoute(release.id));

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.vary).toMatch(/Accept/);
      expect(response.body).toEqual({
        status: 'success',
        outcome: 'archived',
        message: `Release “${release.title}” archived.`,
        releaseId: release.id,
        projectId: project.id,
        release: {
          id: release.id,
          projectId: project.id,
          title: release.title,
          url: `/releases/${release.id}`,
          archived: true,
          archivedAt: expect.any(String),
          published: false,
          publishedDate: null,
          plannedDate: '2031-07-10',
        },
        urls: { release: `/releases/${release.id}`, releases: '/releases', project: `/projects/${project.id}` },
        refreshRequired: true,
      });

      const after = releaseRow(release.id);
      expect(after.archived_at).toBe(response.body.release.archivedAt);
      unchangedExceptArchive(before, after);
      expect(releaseAssetRows(release.id)).toEqual(beforeAssets);
      expect(beforeAssets).toHaveLength(2);
      expect(platformRows(release.id)).toEqual(beforePlatforms);
      expect(releaseRow(other.id)).toEqual(otherBefore);
      expect(db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id)).toEqual(projectBefore);
      expect(archiveEvents(release.id)).toHaveLength(1);
      expect(activity.filter((entry) => entry.event !== 'release.archived')).toEqual([]);
    });

    it('archives a published release as the service always has, keeping its publication record', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      releaseService.publishRelease(release.id, '2026-10-01');
      const response = await postJson(archiveRoute(release.id));
      expect(response.status).toBe(200);
      expect(response.body.release).toMatchObject({ archived: true, published: true, publishedDate: '2026-10-01' });
      expect(releaseRow(release.id).published_date).toBe('2026-10-01');
    });
  });

  describe('H2 / H13 / H16 — native and JSON isolation', () => {
    it('keeps the native form contract: a redirect to Release Detail, which still renders archived', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      const response = await postNative(archiveRoute(release.id));
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`/releases/${release.id}`);
      expect(releaseRow(release.id).archived_at).not.toBeNull();
      expect(archiveEvents(release.id)).toHaveLength(1);
      const detail = await agent.get(`/releases/${release.id}`).expect(200);
      expect(detail.text).toContain('data-release-detail-archived');
      expect(detail.text).not.toContain('id="release-edit-dialog"');
    });

    it('never redirects a JSON request and never answers a native one with JSON', async () => {
      const project = createProject();
      const json = await postJson(archiveRoute(createRelease(project.id).id));
      expect(json.status).toBe(200);
      expect(json.headers.location).toBeUndefined();
      expect(json.headers['content-type']).toMatch(/application\/json/);

      const native = await postNative(archiveRoute(999999));
      expect(native.status).toBe(404);
      expect(native.headers['content-type']).toMatch(/text\/html/);
      const nativeArchived = createRelease(project.id);
      await postNative(archiveRoute(nativeArchived.id)).expect(302);
      const again = await postNative(archiveRoute(nativeArchived.id));
      // The native already-archived answer renders Release Detail with the refusal.
      expect(again.status).toBe(422);
      expect(again.headers['content-type']).toMatch(/text\/html/);
      expectNoLeak(again);
    });
  });

  describe('H3 / H4 — missing or invalid release identity', () => {
    it('answers 404 RELEASE_NOT_FOUND as JSON for missing and invalid ids, archiving nothing', async () => {
      const project = createProject();
      const other = createRelease(project.id);
      for (const route of [archiveRoute(999999), '/releases/not-a-number/archive', '/releases/0/archive']) {
        const json = await postJson(route);
        expect(json.status).toBe(404);
        expect(json.body).toEqual({
          status: 'error', code: 'RELEASE_NOT_FOUND', message: 'Release not found.', outcome: 'refused',
        });
      }
      expect(releaseRow(other.id).archived_at).toBeNull();
      expect(activity.filter((entry) => entry.event === 'release.archived')).toEqual([]);
    });

    it('names the owning project from the record itself (the route carries only the release id)', async () => {
      const first = createProject();
      const second = createProject();
      const release = createRelease(second.id);
      const response = await postJson(archiveRoute(release.id));
      expect(response.body.projectId).toBe(second.id);
      expect(response.body.projectId).not.toBe(first.id);
    });
  });

  describe('H5 — authentication and CSRF', () => {
    it('refuses a missing or wrong token and an anonymous request without archiving', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      const noToken = await postJson(archiveRoute(release.id), {});
      expect(noToken.status).toBe(403);
      expect(noToken.body).toMatchObject({ status: 'error' });
      const badToken = await postJson(archiveRoute(release.id), { _csrf: 'not-the-token' });
      expect(badToken.status).toBe(403);
      const anonymous = await request(app).post(archiveRoute(release.id)).set('Accept', 'application/json')
        .type('form').send({ _csrf: csrfToken });
      expect([302, 401, 403]).toContain(anonymous.status);
      for (const response of [noToken, badToken, anonymous]) {
        expectNoLeak(response);
        expect(response.body?.outcome).not.toBe('archived');
      }
      expect(releaseRow(release.id).archived_at).toBeNull();
      expect(archiveEvents(release.id)).toEqual([]);
    });
  });

  describe('H6 / H14 / H15 — eligibility and Edit Save', () => {
    it('offers Archive only while unpublished; an acknowledged Save that clears the published date offers it at once', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      releaseService.publishRelease(release.id, '2026-10-01');
      const published = await agent.get(`/releases/${release.id}/edit`).set('Accept', 'application/json').expect(200);
      expect(published.body.eligibility.archivable).toBe(false);
      expect(published.body.actions.archive).toBeNull();

      const saved = await postJson(`/releases/${release.id}`, {
        _csrf: csrfToken,
        expectedPatreonUrl: 'https://example.com/kept',
        title: release.title,
        description: 'Kept description',
        notes: 'Kept notes',
        plannedDate: '2031-07-10',
        plannedTime: '09:30',
        publishedDate: '',
        patreonUrl: 'https://example.com/kept',
        selectedPlatformsPresent: '1',
      });
      expect(saved.status).toBe(200);
      expect(saved.body.eligibility.archivable).toBe(true);
      expect(saved.body.actions.archive).toBe(`/releases/${release.id}/archive`);
      expect(releaseRow(release.id).published_date).toBeNull();

      const archived = await postJson(archiveRoute(release.id));
      expect(archived.status).toBe(200);
      // Once archived, the edit model refuses (Check again reads exactly this).
      const edit = await agent.get(`/releases/${release.id}/edit`).set('Accept', 'application/json');
      expect(edit.status).toBe(409);
      expect(edit.body).toMatchObject({ status: 'error', code: 'RELEASE_ARCHIVED' });
      // An Edit Save after Archive is refused and changes nothing.
      const before = releaseRow(release.id);
      const lateSave = await postJson(`/releases/${release.id}`, {
        _csrf: csrfToken, expectedPatreonUrl: 'https://example.com/kept', title: 'Late draft',
      });
      expect(lateSave.status).toBe(422);
      expect(lateSave.body.code).toBe('RELEASE_ARCHIVED');
      expect(releaseRow(release.id)).toEqual(before);
    });

    it('never saves Edit Release fields sent with Archive', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      const before = releaseRow(release.id);
      const response = await postJson(archiveRoute(release.id), {
        _csrf: csrfToken,
        title: 'Unsaved draft title',
        description: 'Unsaved draft description',
        plannedDate: '2040-01-01',
        publishedDate: '2026-11-01',
        selectedPlatforms: 'bluesky',
        selectedPlatformsPresent: '1',
      });
      expect(response.status).toBe(200);
      unchangedExceptArchive(before, releaseRow(release.id));
      expect(activity.filter((entry) => entry.event === 'release.updated')).toEqual([]);
    });
  });

  describe('H7 — already archived', () => {
    it('refuses a second archive (409) without changing the record or logging again', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      await postJson(archiveRoute(release.id)).expect(200);
      const archived = releaseRow(release.id);
      const again = await postJson(archiveRoute(release.id));
      expect(again.status).toBe(409);
      expect(again.body).toEqual({
        status: 'error',
        code: 'RELEASE_ALREADY_ARCHIVED',
        message: 'This release was already archived. Nothing was changed.',
        outcome: 'refused',
        releaseId: release.id,
        projectId: project.id,
        release: {
          id: release.id,
          projectId: project.id,
          title: release.title,
          url: `/releases/${release.id}`,
          archived: true,
          archivedAt: archived.archived_at,
          published: false,
          publishedDate: null,
          plannedDate: '2031-07-10',
        },
      });
      expect(releaseRow(release.id)).toEqual(archived);
      expect(archiveEvents(release.id)).toHaveLength(1);
    });
  });

  describe('H8 — archived owning project', () => {
    it('refuses (409 PROJECT_ARCHIVED) for a release of an archived project, as JSON and natively', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      app.locals.projectService.archive(project.id);
      const before = releaseRow(release.id);
      const json = await postJson(archiveRoute(release.id));
      expect(json.status).toBe(409);
      expect(json.body).toEqual({
        status: 'error',
        code: 'PROJECT_ARCHIVED',
        message: 'The parent project is archived, so this release is read-only. Nothing was archived.',
        outcome: 'refused',
        releaseId: release.id,
        projectId: project.id,
      });
      expect(releaseRow(release.id)).toEqual(before);
      const native = await postNative(archiveRoute(release.id));
      expect(native.status).toBe(422);
      expect(releaseRow(release.id)).toEqual(before);
      expect(archiveEvents(release.id)).toEqual([]);
    });
  });

  describe('H9 — busy refusal', () => {
    it('answers maintenance with 503 before the route runs, archiving nothing', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      maintenanceState.active = true;
      const response = await postJson(archiveRoute(release.id));
      maintenanceState.active = false;
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ status: 'error', message: 'Service temporarily unavailable for maintenance.' });
      expect(releaseRow(release.id).archived_at).toBeNull();
    });
  });

  describe('H10 — unexpected failures', () => {
    it('reports a real database fault as a proven failure: the record is still active', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      const before = releaseRow(release.id);
      db.exec(`CREATE TRIGGER fail_release_archive BEFORE UPDATE OF archived_at ON releases
        WHEN NEW.archived_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'archive fault ${tmpDir.replace(/'/g, "''")}'); END`);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await postJson(archiveRoute(release.id));
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        status: 'error',
        code: 'RELEASE_ARCHIVE_FAILED',
        message: 'Release archive failed. Nothing was archived. Please try again.',
        outcome: 'failed',
        releaseId: release.id,
      });
      expectNoLeak(response);
      expect(releaseRow(release.id)).toEqual(before);
      expect(archiveEvents(release.id)).toEqual([]);

      const native = await postNative(archiveRoute(release.id));
      expect(native.status).toBe(500);
      expectNoLeak(native);
    });

    it('never claims nothing changed when the record was archived before the failure', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      const original = releaseService.archiveRelease.bind(releaseService);
      vi.spyOn(releaseService, 'archiveRelease').mockImplementation((id) => {
        original(id);
        throw new Error(`late failure in ${tmpDir}`);
      });
      const response = await postJson(archiveRoute(release.id));
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        status: 'error',
        code: 'RELEASE_ARCHIVE_UNKNOWN',
        message: 'Could not confirm whether the release was archived.',
        outcome: 'unknown',
        releaseId: release.id,
      });
      expectNoLeak(response);
      expect(releaseRow(release.id).archived_at).not.toBeNull();
    });

    it('treats a failure of the opening read as a failure before anything was attempted', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      vi.spyOn(releaseService, 'findRelease').mockImplementation(() => { throw new Error('read fault'); });
      const archive = vi.spyOn(releaseService, 'archiveRelease');
      const response = await postJson(archiveRoute(release.id));
      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ code: 'RELEASE_ARCHIVE_FAILED', outcome: 'failed' });
      expect(archive).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      expect(releaseRow(release.id).archived_at).toBeNull();
    });
  });

  describe('Unarchive', () => {
    it('has no Unarchive or Restore route to pair with Archive', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      await postJson(archiveRoute(release.id)).expect(200);
      for (const route of [`/releases/${release.id}/unarchive`, `/releases/${release.id}/restore`]) {
        const response = await postJson(route);
        expect(response.status).toBe(404);
      }
      expect(releaseRow(release.id).archived_at).not.toBeNull();
    });
  });
});
