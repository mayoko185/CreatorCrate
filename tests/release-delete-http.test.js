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

// WP11B-2: the existing Release Delete route answers the Edit Release
// dialog's enhanced submission (Accept: application/json) as JSON, with the
// real release service, repository and rules, while the native form contract
// (redirect to /releases, error pages) is unchanged. Every reported outcome is
// checked against the database.

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('Release Delete — enhanced JSON and native', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let app;
  let agent;
  let csrfToken;
  let maintenanceState;
  let releaseService;
  let activity;
  let fixtureCount = 0;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-release-delete-http-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const previewRoot = path.join(tmpDir, 'previews');
    fs.mkdirSync(previewRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    activity = [];
    releaseService = createReleaseService({
      db,
      applicationLogger: {
        info: (entry) => activity.push({ event: entry.event, releaseId: entry.context?.releaseId, context: entry.context }),
      },
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
      title: `Delete Project ${fixtureCount}`,
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
  const assetRow = (id) => db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  const deleteRoute = (id) => `/releases/${id}/delete`;
  const postJson = (route, body = { _csrf: csrfToken }) => agent.post(route)
    .set('Accept', 'application/json').type('form').send(body);
  const postNative = (route, body = { _csrf: csrfToken }) => agent.post(route)
    .set('Accept', 'text/html,application/xhtml+xml').type('form').send(body);
  const deleteEvents = (releaseId) => activity.filter((entry) => entry.event === 'release.deleted'
    && entry.releaseId === releaseId);
  const expectNoLeak = (response) => {
    expect(response.text).not.toContain(tmpDir);
    expect(response.text).not.toMatch(/SQLITE|stack|at [A-Za-z]+ \(|\.js:\d+/);
  };

  function insertAsset(projectId, filename) {
    return Number(db.prepare(`INSERT INTO assets (project_id, filename, relative_path)
      VALUES (?, ?, ?)`).run(projectId, filename, filename).lastInsertRowid);
  }

  describe('H1 / H9 / H10 / H11 / H12 — confirmed delete', () => {
    it('deletes with JSON, cascades only its own relationships, keeps assets and siblings, and logs once', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      const other = createRelease(project.id, { title: 'Untouched sibling' });
      releaseService.updateRelease(release.id, { ...release, selectedPlatforms: ['x'] });
      releaseService.updateRelease(other.id, { ...other, selectedPlatforms: ['bluesky'] });
      const assetA = insertAsset(project.id, 'a.png');
      const assetB = insertAsset(project.id, 'b.png');
      releaseService.addAssetToRelease(release.id, assetA, 'attachment', 0);
      releaseService.addAssetToRelease(release.id, assetB, 'attachment', 1);
      releaseService.addAssetToRelease(other.id, assetA, 'attachment', 0);
      expect(platformRows(release.id)).toHaveLength(1);
      activity.length = 0;
      const otherBefore = releaseRow(other.id);
      const otherAssets = releaseAssetRows(other.id);
      const otherPlatforms = platformRows(other.id);
      const assetBefore = [assetRow(assetA), assetRow(assetB)];
      const projectBefore = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);

      const response = await postJson(deleteRoute(release.id));

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.vary).toMatch(/Accept/);
      expect(response.body).toEqual({
        status: 'success',
        outcome: 'deleted',
        message: `Release “${release.title}” deleted.`,
        releaseId: release.id,
        projectId: project.id,
        release: { id: release.id, projectId: project.id, title: release.title, deleted: true },
        redirect: '/releases',
        refreshRequired: true,
      });
      expect(releaseRow(release.id)).toBeUndefined();
      expect(releaseAssetRows(release.id)).toEqual([]);
      expect(platformRows(release.id)).toEqual([]);
      expect([assetRow(assetA), assetRow(assetB)]).toEqual(assetBefore);
      expect(releaseRow(other.id)).toEqual(otherBefore);
      expect(releaseAssetRows(other.id)).toEqual(otherAssets);
      expect(platformRows(other.id)).toEqual(otherPlatforms);
      expect(db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id)).toEqual(projectBefore);
      expect(deleteEvents(release.id)).toHaveLength(1);
      expect(deleteEvents(release.id)[0].context).toMatchObject({ releaseId: release.id });
      expect(activity.filter((entry) => entry.releaseId === other.id)).toEqual([]);

    });

    it('also removes social preparation sessions and notification occurrences through their cascades', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      db.prepare(`INSERT INTO social_prep_sessions (id, release_id, kind, state, expires_at)
        VALUES ('session-1', ?, 'initial', 'finished', '2031-01-01T00:00:00.000Z')`).run(release.id);
      const sessions = () => db.prepare('SELECT id FROM social_prep_sessions WHERE release_id = ?').all(release.id);
      expect(sessions()).toHaveLength(1);
      await postJson(deleteRoute(release.id)).expect(200);
      expect(sessions()).toEqual([]);
      const dangling = db.prepare(`SELECT COUNT(*) AS n FROM release_notification_occurrences
        WHERE release_id NOT IN (SELECT id FROM releases)`).get();
      expect(dangling.n).toBe(0);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });
  });

  describe('H5 — published release', () => {
    it('deletes a published release, as the service always has', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      releaseService.publishRelease(release.id, '2026-10-01');
      expect(releaseRow(release.id).published_date).toBeTruthy();
      const edit = await agent.get(`/releases/${release.id}/edit`).set('Accept', 'application/json').expect(200);
      expect(edit.body.eligibility.deletable).toBe(true);
      expect(edit.body.actions.delete).toBe(`/releases/${release.id}/delete`);
      const response = await postJson(deleteRoute(release.id));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ outcome: 'deleted', releaseId: release.id });
      expect(releaseRow(release.id)).toBeUndefined();
    });
  });

  describe('H2 / H12 — native compatibility and isolation', () => {
    it('keeps the native form contract: a redirect to /releases, never JSON', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      const response = await postNative(deleteRoute(release.id));
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe('/releases');
      expect(releaseRow(release.id)).toBeUndefined();
      expect(deleteEvents(release.id)).toHaveLength(1);
    });

    it('never redirects a JSON request and never answers a native refusal with JSON', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      releaseService.archiveRelease(release.id);
      const json = await postJson(deleteRoute(release.id));
      expect(json.status).toBe(409);
      expect(json.headers['content-type']).toMatch(/application\/json/);
      expect(json.headers.location).toBeUndefined();
      const native = await postNative(deleteRoute(release.id));
      expect(native.status).toBe(422);
      expect(native.headers['content-type']).toMatch(/text\/html/);
      expect(native.text).toContain('This release is archived and read-only.');
      const missing = await postNative(deleteRoute(999999));
      expect(missing.status).toBe(404);
      expect(missing.headers['content-type']).toMatch(/text\/html/);
      expect(releaseRow(release.id)).toBeDefined();
    });
  });

  describe('H3 / H13 / H14 — missing, invalid identity and a second delete', () => {
    it('answers 404 RELEASE_NOT_FOUND for missing and invalid ids, deleting nothing', async () => {
      const project = createProject();
      const survivor = createRelease(project.id);
      for (const route of [deleteRoute(999999), '/releases/0/delete', '/releases/abc/delete']) {
        const response = await postJson(route);
        expect(response.status).toBe(404);
        expect(response.body).toEqual({
          status: 'error', code: 'RELEASE_NOT_FOUND', message: 'Release not found. Nothing was deleted.', outcome: 'refused',
        });
      }
      expect(releaseRow(survivor.id)).toBeDefined();
      expect(activity.filter((entry) => entry.event === 'release.deleted')).toEqual([]);
    });

    it('refuses a second delete as not found without logging again', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      await postJson(deleteRoute(release.id)).expect(200);
      const second = await postJson(deleteRoute(release.id));
      expect(second.status).toBe(404);
      expect(second.body).toMatchObject({ code: 'RELEASE_NOT_FOUND', outcome: 'refused' });
      expect(deleteEvents(release.id)).toHaveLength(1);
      const native = await postNative(deleteRoute(release.id));
      expect(native.status).toBe(404);
    });

    it('deletes only the release the route names; the project is read from the record itself', async () => {
      const projectA = createProject();
      const projectB = createProject();
      const a = createRelease(projectA.id);
      const b = createRelease(projectB.id);
      const response = await postJson(deleteRoute(b.id), { _csrf: csrfToken, projectId: String(projectA.id), id: String(a.id) });
      expect(response.status).toBe(200);
      expect(response.body.projectId).toBe(projectB.id);
      expect(releaseRow(b.id)).toBeUndefined();
      expect(releaseRow(a.id)).toBeDefined();
    });
  });

  describe('H4 — archived release', () => {
    it('refuses (409 RELEASE_ARCHIVED) as JSON and natively, deleting nothing', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      releaseService.archiveRelease(release.id);
      const before = releaseRow(release.id);
      const json = await postJson(deleteRoute(release.id));
      expect(json.status).toBe(409);
      expect(json.body).toEqual({
        status: 'error',
        code: 'RELEASE_ARCHIVED',
        message: 'Archived releases cannot be deleted. Nothing was deleted.',
        outcome: 'refused',
        releaseId: release.id,
        projectId: project.id,
      });
      expect(releaseRow(release.id)).toEqual(before);
      expect((await postNative(deleteRoute(release.id))).status).toBe(422);
      expect(releaseRow(release.id)).toEqual(before);
      expect(deleteEvents(release.id)).toEqual([]);
    });
  });

  describe('H6 — archived owning project', () => {
    it('refuses (409 PROJECT_ARCHIVED) as JSON and natively, deleting nothing', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      app.locals.projectService.archive(project.id);
      const before = releaseRow(release.id);
      const json = await postJson(deleteRoute(release.id));
      expect(json.status).toBe(409);
      expect(json.body).toEqual({
        status: 'error',
        code: 'PROJECT_ARCHIVED',
        message: 'The parent project is archived, so this release is read-only. Nothing was deleted.',
        outcome: 'refused',
        releaseId: release.id,
        projectId: project.id,
      });
      expect((await postNative(deleteRoute(release.id))).status).toBe(422);
      expect(releaseRow(release.id)).toEqual(before);
      expect(deleteEvents(release.id)).toEqual([]);
    });

    it('re-checks eligibility at execution: a project archived after the opening read still refuses', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      const original = app.locals.projectService.findById.bind(app.locals.projectService);
      // The route's opening read sees the project active; the service's own
      // guard (its repository) then sees it archived.
      vi.spyOn(app.locals.projectService, 'findById').mockImplementationOnce((id) => {
        const row = original(id);
        app.locals.projectService.archive(project.id);
        return row;
      });
      const response = await postJson(deleteRoute(release.id));
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: 'PROJECT_ARCHIVED', outcome: 'refused' });
      expect(releaseRow(release.id)).toBeDefined();
    });
  });

  describe('H7 — authentication, CSRF and maintenance', () => {
    it('refuses a missing or wrong token and an anonymous request without deleting', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      const noToken = await postJson(deleteRoute(release.id), {});
      expect(noToken.status).toBe(403);
      expect(noToken.body).toMatchObject({ status: 'error' });
      const badToken = await postJson(deleteRoute(release.id), { _csrf: 'not-the-token' });
      expect(badToken.status).toBe(403);
      const anonymous = await request(app).post(deleteRoute(release.id)).set('Accept', 'application/json')
        .type('form').send({ _csrf: csrfToken });
      expect([302, 401, 403]).toContain(anonymous.status);
      for (const response of [noToken, badToken, anonymous]) {
        expectNoLeak(response);
        expect(response.body?.outcome).not.toBe('deleted');
      }
      expect(releaseRow(release.id)).toBeDefined();
      expect(deleteEvents(release.id)).toEqual([]);
    });

    it('answers maintenance with 503 before the route runs, deleting nothing', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      maintenanceState.active = true;
      const response = await postJson(deleteRoute(release.id));
      maintenanceState.active = false;
      expect(response.status).toBe(503);
      expect(response.body.outcome).toBeUndefined();
      expect(releaseRow(release.id)).toBeDefined();
    });
  });

  describe('H15 — Edit and Archive interaction', () => {
    it('never saves Edit Release fields sent with Delete, and an archived release stays undeletable', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      const sibling = createRelease(project.id);
      const siblingBefore = releaseRow(sibling.id);
      await postJson(deleteRoute(sibling.id), {
        _csrf: csrfToken, title: 'Hijacked', description: 'x', plannedDate: '2040-01-01',
      }).expect(200);
      expect(releaseRow(sibling.id)).toBeUndefined();
      expect(siblingBefore.title).not.toBe('Hijacked');

      await postJson(`/releases/${release.id}/archive`).expect(200);
      const refused = await postJson(deleteRoute(release.id));
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('RELEASE_ARCHIVED');
      const edit = await agent.get(`/releases/${release.id}/edit`).set('Accept', 'application/json');
      expect(edit.status).toBe(409);
      expect(releaseRow(release.id).archived_at).not.toBeNull();
    });
  });

  describe('H8 / H16 — operational failures and unknown results', () => {
    it('reports a real database fault as a proven failure: the release still exists', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      const before = releaseRow(release.id);
      db.exec(`CREATE TRIGGER fail_release_delete BEFORE DELETE ON releases
        BEGIN SELECT RAISE(ABORT, 'delete fault ${tmpDir.replace(/'/g, "''")}'); END`);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await postJson(deleteRoute(release.id));
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        status: 'error',
        code: 'RELEASE_DELETE_FAILED',
        message: 'Release delete failed. Nothing was deleted. Please try again.',
        outcome: 'failed',
        releaseId: release.id,
      });
      expectNoLeak(response);
      expect(releaseRow(release.id)).toEqual(before);
      expect(deleteEvents(release.id)).toEqual([]);
      const native = await postNative(deleteRoute(release.id));
      expect(native.status).toBe(500);
      expectNoLeak(native);
    });

    it('never claims nothing was deleted when the release was deleted before the failure', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      const original = releaseService.deleteRelease.bind(releaseService);
      vi.spyOn(releaseService, 'deleteRelease').mockImplementation((id) => {
        original(id);
        throw new Error(`late failure in ${tmpDir}`);
      });
      const response = await postJson(deleteRoute(release.id));
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        status: 'error',
        code: 'RELEASE_DELETE_UNKNOWN',
        message: 'Could not confirm whether the release was deleted.',
        outcome: 'unknown',
        releaseId: release.id,
      });
      expectNoLeak(response);
      expect(releaseRow(release.id)).toBeUndefined();
    });

    it('reports unknown when the failure cannot be followed by a readable check', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      const find = vi.spyOn(releaseService, 'findRelease');
      vi.spyOn(releaseService, 'deleteRelease').mockImplementation(() => {
        find.mockImplementation(() => { throw new Error('read fault'); });
        throw new Error('delete fault');
      });
      const response = await postJson(deleteRoute(release.id));
      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ code: 'RELEASE_DELETE_UNKNOWN', outcome: 'unknown' });
    });

    it('treats a failure of the opening read as a failure before anything was attempted', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      vi.spyOn(releaseService, 'findRelease').mockImplementation(() => { throw new Error('read fault'); });
      const remove = vi.spyOn(releaseService, 'deleteRelease');
      const response = await postJson(deleteRoute(release.id));
      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ code: 'RELEASE_DELETE_FAILED', outcome: 'failed' });
      expect(remove).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      expect(releaseRow(release.id)).toBeDefined();
    });

    it('a delete that removed no row is a refusal only when the release is shown gone', async () => {
      const project = createProject();
      const release = createRelease(project.id);
      vi.spyOn(releaseService, 'deleteRelease').mockImplementationOnce(() => false);
      const present = await postJson(deleteRoute(release.id));
      expect(present.status).toBe(500);
      expect(present.body).toMatchObject({ code: 'RELEASE_DELETE_FAILED', outcome: 'failed' });
      expect(releaseRow(release.id)).toBeDefined();
      vi.spyOn(releaseService, 'deleteRelease').mockImplementationOnce((id) => {
        db.prepare('DELETE FROM releases WHERE id = ?').run(id);
        return false;
      });
      const gone = await postJson(deleteRoute(release.id));
      expect(gone.status).toBe(404);
      expect(gone.body).toMatchObject({ code: 'RELEASE_NOT_FOUND', outcome: 'refused' });
    });
  });
});
