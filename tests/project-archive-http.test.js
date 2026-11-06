import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

// WP11A-1: the existing Project Archive route answers the Edit Project
// dialog's enhanced submission (Accept: application/json) as JSON, with the
// real project service, repository, activity log and rules, while the native
// form contract (redirect to /projects, error pages) is unchanged. Every
// reported outcome is checked against the database.

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('Project Archive — enhanced JSON and native', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let app;
  let agent;
  let csrfToken;
  let maintenanceState;
  let fixtureCount = 0;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-archive-http-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const previewRoot = path.join(tmpDir, 'previews');
    fs.mkdirSync(previewRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    maintenanceState = { active: false };
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, {
      authConfig: AUTH_CONFIG, maintenanceState,
    });
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
      title: `Archive ${fixtureCount}`,
      description: 'Kept description',
      notes: 'Kept notes',
      status: 'in-progress',
      ...overrides,
    });
  }

  const projectRow = (id) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  const archiveRoute = (id) => `/projects/${id}/archive`;
  const postJson = (route, body = { _csrf: csrfToken }) => agent.post(route)
    .set('Accept', 'application/json').type('form').send(body);
  const postNative = (route, body = { _csrf: csrfToken }) => agent.post(route).type('form').send(body);
  const archiveLogs = (projectId) => db.prepare(
    "SELECT event, context_json FROM application_logs WHERE project_id = ? AND event = 'project.archived' ORDER BY id",
  ).all(projectId).map((row) => ({ event: row.event, context: JSON.parse(row.context_json) }));
  const expectNoLeak = (response) => {
    expect(response.text).not.toContain(tmpDir);
    expect(response.text).not.toMatch(/SQLITE|stack|at [A-Za-z]+ \(|\.js:\d+/);
  };
  const unchangedExceptArchive = (before, after) => {
    const strip = ({ status, archived_at: archivedAt, updated_at: updatedAt, ...rest }) => rest;
    expect(strip(after)).toEqual(strip(before));
  };

  describe('H1 / H10 / H11 / H12 — confirmed archive', () => {
    it('archives with JSON, changes only the archive fields, and logs the activity once', async () => {
      const project = createProject();
      const before = projectRow(project.id);
      const response = await postJson(archiveRoute(project.id));

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({
        status: 'success',
        outcome: 'archived',
        message: `Project “${project.title}” archived.`,
        projectId: project.id,
        project: {
          id: project.id,
          title: project.title,
          url: `/projects/${project.id}`,
          archived: true,
          archivedAt: expect.any(String),
          status: 'archived',
        },
        urls: { project: `/projects/${project.id}`, projects: '/projects' },
        refreshRequired: true,
      });

      const after = projectRow(project.id);
      expect(after.status).toBe('archived');
      expect(after.archived_at).toBe(response.body.project.archivedAt);
      unchangedExceptArchive(before, after);
      // The project folder is never touched by Archive.
      expect(fs.existsSync(path.join(projectsRoot, project.project_dir))).toBe(true);
      expect(archiveLogs(project.id)).toEqual([{
        event: 'project.archived',
        context: { status: 'archived', projectType: before.project_type },
      }]);
    });

    it('keeps the native form contract: a redirect to Projects', async () => {
      const project = createProject();
      const response = await postNative(archiveRoute(project.id));
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe('/projects');
      expect(projectRow(project.id).status).toBe('archived');
      expect(archiveLogs(project.id)).toHaveLength(1);
    });

    it('archives a project whose folder is missing (Archive is a database transition only)', async () => {
      const project = createProject();
      fs.rmSync(path.join(projectsRoot, project.project_dir), { recursive: true, force: true });
      const response = await postJson(archiveRoute(project.id));
      expect(response.status).toBe(200);
      expect(response.body.outcome).toBe('archived');
      expect(projectRow(project.id).archived_at).not.toBeNull();
    });
  });

  describe('H3 — wrong or missing project identity', () => {
    it('answers 404 PROJECT_NOT_FOUND as JSON and the native 404 page otherwise', async () => {
      const other = createProject();
      for (const route of [archiveRoute(999999), '/projects/not-a-number/archive', '/projects/0/archive']) {
        const json = await postJson(route);
        expect(json.status).toBe(404);
        expect(json.body).toEqual({
          status: 'error', code: 'PROJECT_NOT_FOUND', message: 'Project not found.', outcome: 'refused',
        });
        const native = await postNative(route);
        expect(native.status).toBe(404);
        expect(native.headers['content-type']).toMatch(/text\/html/);
      }
      expect(projectRow(other.id).archived_at).toBeNull();
    });
  });

  describe('H4 — authentication and CSRF', () => {
    it('refuses a missing or wrong token and an anonymous request without archiving', async () => {
      const project = createProject();
      const noToken = await postJson(archiveRoute(project.id), {});
      expect(noToken.status).toBe(403);
      expect(noToken.body).toMatchObject({ status: 'error' });
      const badToken = await postJson(archiveRoute(project.id), { _csrf: 'not-the-token' });
      expect(badToken.status).toBe(403);
      const anonymous = await request(app).post(archiveRoute(project.id)).set('Accept', 'application/json')
        .type('form').send({ _csrf: csrfToken });
      expect([302, 401, 403]).toContain(anonymous.status);
      for (const response of [noToken, badToken, anonymous]) {
        expectNoLeak(response);
        expect(response.body?.outcome).not.toBe('archived');
      }
      expect(projectRow(project.id).archived_at).toBeNull();
      expect(archiveLogs(project.id)).toEqual([]);
    });
  });

  describe('H5 — ownership', () => {
    it('is not gated on project-folder ownership: a single-user app with no per-user owner', async () => {
      // Archive never inspects the folder, so an ownership-attention project
      // archives like any other; authentication above is the only owner check.
      const project = createProject();
      db.prepare('DELETE FROM project_directory_ownership WHERE project_id = ?').run(project.id);
      const response = await postJson(archiveRoute(project.id));
      expect(response.status).toBe(200);
      expect(projectRow(project.id).status).toBe('archived');
    });
  });

  describe('H6 — already archived', () => {
    it('refuses a second archive (409) without changing the record or logging again', async () => {
      const project = createProject();
      await postJson(archiveRoute(project.id)).expect(200);
      const archived = projectRow(project.id);
      const again = await postJson(archiveRoute(project.id));
      expect(again.status).toBe(409);
      expect(again.body).toEqual({
        status: 'error',
        code: 'PROJECT_ALREADY_ARCHIVED',
        message: 'This project was already archived. Nothing was changed.',
        outcome: 'refused',
        projectId: project.id,
        project: {
          id: project.id,
          title: project.title,
          url: `/projects/${project.id}`,
          archived: true,
          archivedAt: archived.archived_at,
          status: 'archived',
        },
      });
      expect(projectRow(project.id)).toEqual(archived);
      expect(archiveLogs(project.id)).toHaveLength(1);
    });

    it('keeps the native already-archived answer (the service refusal reaches the error page)', async () => {
      const project = createProject();
      await postNative(archiveRoute(project.id)).expect(302);
      const again = await postNative(archiveRoute(project.id));
      expect(again.status).toBe(500);
      expect(again.headers['content-type']).toMatch(/text\/html/);
      expectNoLeak(again);
      expect(archiveLogs(project.id)).toHaveLength(1);
    });
  });

  describe('H7 / H14 — eligibility before and after archive and after Edit Save', () => {
    it('offers Archive in the edit model after a save, and withdraws editing once archived', async () => {
      const project = createProject();
      const saved = await agent.post(`/projects/${project.id}`).set('Accept', 'application/json').type('form')
        .send({ _csrf: csrfToken, title: 'Renamed before archive', status: 'ready', description: '', notes: '' });
      expect(saved.status).toBe(200);
      expect(saved.body.actions.archive).toBe(`/projects/${project.id}/archive`);

      const model = await agent.get(`/projects/${project.id}/edit`).set('Accept', 'application/json').expect(200);
      expect(model.body.actions.archive).toBe(`/projects/${project.id}/archive`);

      const archived = await postJson(archiveRoute(project.id));
      expect(archived.body.project.title).toBe('Renamed before archive');

      const refusedModel = await agent.get(`/projects/${project.id}/edit`).set('Accept', 'application/json');
      expect(refusedModel.status).toBe(409);
      expect(refusedModel.body.code).toBe('PROJECT_ARCHIVED');

      const refusedSave = await agent.post(`/projects/${project.id}`).set('Accept', 'application/json').type('form')
        .send({ _csrf: csrfToken, title: 'After archive', status: 'ready', description: '', notes: '' });
      expect(refusedSave.status).toBe(422);
      expect(projectRow(project.id).title).toBe('Renamed before archive');

      // Project Detail survives as the read-only workspace, with no Edit
      // action, no Create release action and the archived regions filled.
      const detail = await agent.get(`/projects/${project.id}`).expect(200);
      expect(detail.text).not.toContain(`data-project-edit-id="${project.id}"`);
      expect(detail.text).not.toContain(`/releases/new?projectId=${project.id}`);
      expect(detail.text).toMatch(/data-project-detail-region="archive-notice">\s*<div class="notice notice--warning"/);
      expect(detail.text).not.toContain('id="project-edit-dialog"');
    });

    it('renders every Project Detail refresh region exactly once, archived or not', async () => {
      const project = createProject();
      const names = (html) => [...html.matchAll(/data-project-detail-region="([^"]+)"/g)].map((m) => m[1]).sort();
      const active = await agent.get(`/projects/${project.id}`).expect(200);
      await postJson(archiveRoute(project.id)).expect(200);
      const archived = await agent.get(`/projects/${project.id}`).expect(200);
      expect(names(active.text)).toEqual(['archive-heading', 'archive-notice', 'hero', 'release-actions']);
      expect(names(archived.text)).toEqual(names(active.text));
    });
  });

  describe('H8 — busy refusal', () => {
    it('answers maintenance with 503 before the route runs, archiving nothing', async () => {
      const project = createProject();
      maintenanceState.active = true;
      const response = await postJson(archiveRoute(project.id));
      maintenanceState.active = false;
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ status: 'error', message: 'Service temporarily unavailable for maintenance.' });
      expect(projectRow(project.id).archived_at).toBeNull();
    });
  });

  describe('H9 — unexpected failures', () => {
    it('reports a real database fault as a proven failure: the record is still active', async () => {
      const project = createProject();
      const before = projectRow(project.id);
      db.exec(`CREATE TRIGGER fail_project_archive BEFORE UPDATE OF archived_at ON projects
        WHEN NEW.archived_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'archive fault ${tmpDir.replace(/'/g, "''")}'); END`);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await postJson(archiveRoute(project.id));
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        status: 'error',
        code: 'PROJECT_ARCHIVE_FAILED',
        message: 'Project archive failed. Nothing was archived. Please try again.',
        outcome: 'failed',
        projectId: project.id,
      });
      expectNoLeak(response);
      expect(projectRow(project.id)).toEqual(before);
      expect(archiveLogs(project.id)).toEqual([]);

      const native = await postNative(archiveRoute(project.id));
      expect(native.status).toBe(500);
      expectNoLeak(native);
    });

    it('never claims nothing changed when the record was archived before the failure', async () => {
      const project = createProject();
      const service = app.locals.projectService;
      const original = service.archive.bind(service);
      vi.spyOn(service, 'archive').mockImplementation((id) => {
        original(id);
        throw new Error(`late failure in ${tmpDir}`);
      });
      const response = await postJson(archiveRoute(project.id));
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        status: 'error',
        code: 'PROJECT_ARCHIVE_UNKNOWN',
        message: 'Could not confirm whether the project was archived.',
        outcome: 'unknown',
        projectId: project.id,
      });
      expectNoLeak(response);
      expect(projectRow(project.id).status).toBe('archived');
    });

    it('treats a failure of the opening read as a failure before anything was attempted', async () => {
      const project = createProject();
      const service = app.locals.projectService;
      vi.spyOn(service, 'findById').mockImplementation(() => { throw new Error('read fault'); });
      const archive = vi.spyOn(service, 'archive');
      const response = await postJson(archiveRoute(project.id));
      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ code: 'PROJECT_ARCHIVE_FAILED', outcome: 'failed' });
      expect(archive).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      expect(projectRow(project.id).archived_at).toBeNull();
    });
  });

  describe('H13 — Unarchive', () => {
    it('has no Unarchive or Restore route to pair with Archive', async () => {
      const project = createProject();
      await postJson(archiveRoute(project.id)).expect(200);
      for (const route of ['unarchive', 'restore']) {
        const response = await agent.post(`/projects/${project.id}/${route}`).set('Accept', 'application/json')
          .type('form').send({ _csrf: csrfToken });
        expect(response.status).toBe(404);
      }
      expect(projectRow(project.id).status).toBe('archived');
    });
  });
});
