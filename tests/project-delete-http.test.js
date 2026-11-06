import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

// WP11A-2: the existing Project Delete route answers the Edit Project
// dialog's enhanced submission (Accept: application/json) as JSON, with the
// real project service (ownership-verified quarantine, transaction, cleanup),
// repository and activity log, while the native form contract (redirect to
// /projects, error pages) is unchanged. Every reported outcome is checked
// against the database and the disposable projects folder.

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MARKER = '.creatorcrate-owner';

describe('Project Delete — enhanced JSON and native', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let app;
  let agent;
  let csrfToken;
  let maintenanceState;
  let fixtureCount = 0;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-delete-http-'));
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
    const project = app.locals.projectService.create({
      title: `Delete ${fixtureCount}`,
      description: 'Kept description',
      notes: 'Kept notes',
      status: 'in-progress',
      ...overrides,
    });
    fs.writeFileSync(path.join(dirOf(project), 'owned-file.txt'), `content ${project.id}`);
    return project;
  }

  const dirOf = (project) => path.join(projectsRoot, project.project_dir);
  const projectRow = (id) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  const count = (sql, ...args) => db.prepare(sql).get(...args).c;
  const quarantineEntries = () => fs.readdirSync(projectsRoot).filter((name) => name.startsWith('.cc-quarantine-'));
  const deleteRoute = (id) => `/projects/${id}/delete`;
  const postJson = (route, body = { _csrf: csrfToken }) => agent.post(route)
    .set('Accept', 'application/json').type('form').send(body);
  const postNative = (route, body = { _csrf: csrfToken }) => agent.post(route).type('form').send(body);
  const deleteLogs = (projectId) => db.prepare(
    "SELECT event FROM application_logs WHERE project_id = ? AND event = 'project.deleted' ORDER BY id",
  ).all(projectId).map((row) => row.event);
  const expectNoLeak = (response) => {
    expect(response.text).not.toContain(tmpDir);
    expect(response.text).not.toContain(projectsRoot);
    expect(response.text).not.toMatch(/\.cc-quarantine-|SQLITE|stack|at [A-Za-z]+ \(|\.js:\d+/);
  };
  const addRelease = (projectId, title = 'Release') => Number(db.prepare(
    'INSERT INTO releases (project_id, title) VALUES (?, ?)',
  ).run(projectId, title).lastInsertRowid);
  const addAsset = (projectId, name = 'a.png') => Number(db.prepare(
    'INSERT INTO assets (project_id, relative_path, filename) VALUES (?, ?, ?)',
  ).run(projectId, `wip/${name}`, name).lastInsertRowid);
  // A real restore failure: the quarantine rename succeeds, putting it back fails.
  function failRestore(project) {
    const original = dirOf(project);
    const actualRename = fs.renameSync;
    const staged = { path: null };
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (source === original && path.basename(destination).startsWith('.cc-quarantine-')) {
        actualRename(source, destination);
        staged.path = destination;
        return undefined;
      }
      if (source === staged.path && destination === original) throw new Error(`restore failed at ${original}`);
      return actualRename(source, destination);
    });
    return staged;
  }
  const failDatabaseDelete = () => db.exec(`CREATE TRIGGER fail_project_delete BEFORE DELETE ON projects
    BEGIN SELECT RAISE(ABORT, 'delete fault ${tmpDir.replace(/'/g, "''")}'); END`);

  describe('H1 / H12 / H15 — JSON clean delete', () => {
    it('deletes the row, its releases and assets, removes its folder, and touches nothing else', async () => {
      const project = createProject();
      const other = createProject();
      const releaseId = addRelease(project.id);
      const assetId = addAsset(project.id);
      db.prepare('INSERT INTO release_assets (release_id, asset_id) VALUES (?, ?)').run(releaseId, assetId);
      const otherRelease = addRelease(other.id, 'Other release');
      const otherAsset = addAsset(other.id);
      const otherBefore = projectRow(other.id);
      const spy = vi.spyOn(app.locals.projectService, 'deleteProject');

      const response = await postJson(deleteRoute(project.id));

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({
        status: 'success',
        outcome: 'deleted',
        message: `Project “${project.title}” deleted.`,
        cleanup: 'complete',
        projectId: project.id,
        project: { id: project.id, title: project.title, deleted: true },
        projectPagesRemain: false,
        redirect: '/projects',
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(projectRow(project.id)).toBeUndefined();
      expect(count('SELECT COUNT(*) AS c FROM releases WHERE project_id = ?', project.id)).toBe(0);
      expect(count('SELECT COUNT(*) AS c FROM assets WHERE project_id = ?', project.id)).toBe(0);
      expect(count('SELECT COUNT(*) AS c FROM release_assets WHERE release_id = ?', releaseId)).toBe(0);
      expect(fs.existsSync(dirOf(project))).toBe(false);
      expect(quarantineEntries()).toEqual([]);
      expect(deleteLogs(project.id)).toEqual(['project.deleted']);
      // H15: the other project, its folder, release and asset are untouched.
      expect(projectRow(other.id)).toEqual(otherBefore);
      expect(fs.readFileSync(path.join(dirOf(other), 'owned-file.txt'), 'utf8')).toBe(`content ${other.id}`);
      expect(count('SELECT COUNT(*) AS c FROM releases WHERE id = ?', otherRelease)).toBe(1);
      expect(count('SELECT COUNT(*) AS c FROM assets WHERE id = ?', otherAsset)).toBe(1);
    });

    it('H10: keeps linked notes but unlinks them (the existing cascade)', async () => {
      const project = createProject();
      const bookId = Number(db.prepare("INSERT INTO books (title, sort_order) VALUES ('Book', 0)").run().lastInsertRowid);
      const noteId = Number(db.prepare('INSERT INTO notes (book_id) VALUES (?)').run(bookId).lastInsertRowid);
      db.prepare('INSERT INTO note_projects (note_id, project_id) VALUES (?, ?)').run(noteId, project.id);

      const response = await postJson(deleteRoute(project.id));

      expect(response.status).toBe(200);
      expect(count('SELECT COUNT(*) AS c FROM notes WHERE id = ?', noteId)).toBe(1);
      expect(count('SELECT COUNT(*) AS c FROM note_projects WHERE note_id = ?', noteId)).toBe(0);
    });
  });

  describe('H2 / H13 — native delete and contract isolation', () => {
    it('keeps the native redirect to Projects without Accept: application/json', async () => {
      const project = createProject();
      const response = await postNative(deleteRoute(project.id));
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe('/projects');
      expect(response.headers['content-type'] || '').not.toContain('application/json');
      expect(projectRow(project.id)).toBeUndefined();
      expect(fs.existsSync(dirOf(project))).toBe(false);
    });

    it('keeps the native 404 page and 500 page (without detail) for missing and failed deletes', async () => {
      const missing = await postNative(deleteRoute(999999));
      expect(missing.status).toBe(404);
      expect(missing.headers['content-type']).toContain('text/html');

      const project = createProject();
      failDatabaseDelete();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const failed = await postNative(deleteRoute(project.id));
      expect(failed.status).toBe(500);
      expect(failed.headers['content-type']).toContain('text/html');
      expectNoLeak(failed);
      expect(projectRow(project.id)).toBeTruthy();
      expect(fs.existsSync(dirOf(project))).toBe(true);
    });
  });

  describe('H3 — service eligibility (unchanged)', () => {
    it('deletes an archived project, as the service always has', async () => {
      const project = createProject();
      app.locals.projectService.archive(project.id);
      const response = await postJson(deleteRoute(project.id));
      expect(response.status).toBe(200);
      expect(response.body.outcome).toBe('deleted');
      expect(projectRow(project.id)).toBeUndefined();
    });

    it('refuses a folder whose ownership marker is missing (409), moving and deleting nothing', async () => {
      const project = createProject();
      fs.rmSync(path.join(dirOf(project), MARKER));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await postJson(deleteRoute(project.id));
      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        status: 'error',
        code: 'PROJECT_OWNERSHIP',
        outcome: 'refused',
        message: 'Project directory ownership marker is missing. Nothing was deleted.',
        projectId: project.id,
      });
      expectNoLeak(response);
      expect(projectRow(project.id)).toBeTruthy();
      expect(fs.readFileSync(path.join(dirOf(project), 'owned-file.txt'), 'utf8')).toBe(`content ${project.id}`);
      expect(quarantineEntries()).toEqual([]);
    });

    it('refuses a missing folder (the share may be unavailable) without deleting the row', async () => {
      const project = createProject();
      fs.rmSync(dirOf(project), { recursive: true, force: true });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await postJson(deleteRoute(project.id));
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: 'PROJECT_OWNERSHIP', outcome: 'refused' });
      expect(response.body.message).toBe('Project directory not found. Nothing was deleted.');
      expect(projectRow(project.id)).toBeTruthy();
    });

    it('answers maintenance with 503 before the route runs, deleting nothing', async () => {
      const project = createProject();
      const spy = vi.spyOn(app.locals.projectService, 'deleteProject');
      maintenanceState.active = true;
      const response = await postJson(deleteRoute(project.id));
      maintenanceState.active = false;
      expect(response.status).toBe(503);
      expect(response.body.outcome).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
      expect(projectRow(project.id)).toBeTruthy();
    });
  });

  describe('H4 — missing project identity', () => {
    it('answers 404 PROJECT_NOT_FOUND (refused) for unknown, malformed and already-deleted ids', async () => {
      const project = createProject();
      const other = createProject();
      const spy = vi.spyOn(app.locals.projectService, 'deleteProject');
      for (const route of [deleteRoute(999999), '/projects/abc/delete', '/projects/0/delete']) {
        const response = await postJson(route);
        expect(response.status).toBe(404);
        expect(response.body).toEqual({
          status: 'error',
          code: 'PROJECT_NOT_FOUND',
          outcome: 'refused',
          message: 'This project no longer exists. Nothing was deleted by this request.',
        });
      }
      expect(spy).not.toHaveBeenCalled();
      expect((await postJson(deleteRoute(project.id))).status).toBe(200);
      const again = await postJson(deleteRoute(project.id));
      expect(again.status).toBe(404);
      expect(again.body.code).toBe('PROJECT_NOT_FOUND');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(projectRow(other.id)).toBeTruthy();
      expect(deleteLogs(project.id)).toEqual(['project.deleted']);
    });
  });

  describe('H5 — authentication and CSRF', () => {
    it('refuses a missing or wrong token and an anonymous request without deleting', async () => {
      const project = createProject();
      const spy = vi.spyOn(app.locals.projectService, 'deleteProject');
      const noToken = await postJson(deleteRoute(project.id), {});
      expect(noToken.status).toBe(403);
      const badToken = await postJson(deleteRoute(project.id), { _csrf: 'not-the-token' });
      expect(badToken.status).toBe(403);
      const nativeBadToken = await postNative(deleteRoute(project.id), { _csrf: 'not-the-token' });
      expect(nativeBadToken.status).toBe(403);
      const anonymous = await request(app).post(deleteRoute(project.id)).set('Accept', 'application/json')
        .type('form').send({ _csrf: csrfToken });
      expect([302, 401, 403]).toContain(anonymous.status);
      for (const response of [noToken, badToken, anonymous]) {
        expectNoLeak(response);
        expect(response.body?.outcome).not.toBe('deleted');
      }
      expect(spy).not.toHaveBeenCalled();
      expect(projectRow(project.id)).toBeTruthy();
      expect(fs.existsSync(dirOf(project))).toBe(true);
    });
  });

  describe('H6 — proven failure with restoration', () => {
    it('reports a database fault as failed: folder put back, row and releases kept', async () => {
      const project = createProject();
      const releaseId = addRelease(project.id);
      const before = projectRow(project.id);
      failDatabaseDelete();
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const response = await postJson(deleteRoute(project.id));

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        status: 'error',
        code: 'PROJECT_DELETE_FAILED',
        outcome: 'failed',
        message: 'The project could not be deleted. Nothing was deleted, and its folder is where it was. Please try again.',
        projectId: project.id,
      });
      expectNoLeak(response);
      expect(projectRow(project.id)).toEqual(before);
      expect(count('SELECT COUNT(*) AS c FROM releases WHERE id = ?', releaseId)).toBe(1);
      expect(fs.readFileSync(path.join(dirOf(project), 'owned-file.txt'), 'utf8')).toBe(`content ${project.id}`);
      expect(quarantineEntries()).toEqual([]);
      expect(deleteLogs(project.id)).toEqual([]);
    });

    it('reports a staging failure before any move as failed: nothing moved', async () => {
      const project = createProject();
      vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        const error = new Error('permission denied');
        error.code = 'EPERM';
        throw error;
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await postJson(deleteRoute(project.id));
      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ code: 'PROJECT_DELETE_FAILED', outcome: 'failed' });
      vi.mocked(fs.renameSync).mockRestore();
      expect(projectRow(project.id)).toBeTruthy();
      expect(fs.existsSync(dirOf(project))).toBe(true);
      expect(quarantineEntries()).toEqual([]);
    });
  });

  describe('H7 — recovery required', () => {
    it('reports a failed restore as recovery-required: row kept, folder left staged', async () => {
      const project = createProject();
      const staged = failRestore(project);
      failDatabaseDelete();
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const response = await postJson(deleteRoute(project.id));

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        status: 'error',
        code: 'PROJECT_DELETE_RECOVERY_REQUIRED',
        outcome: 'recovery-required',
        recoveryRequired: true,
        message: expect.stringContaining('The project was not deleted, but its folder could not be put back'),
        projectId: project.id,
      });
      expectNoLeak(response);
      expect(projectRow(project.id)).toBeTruthy();
      expect(fs.existsSync(dirOf(project))).toBe(false);
      expect(fs.readFileSync(path.join(staged.path, 'owned-file.txt'), 'utf8')).toBe(`content ${project.id}`);
      expect(deleteLogs(project.id)).toEqual([]);
    });

    it('reports a staged folder that fails verification and cannot be put back as recovery-required', async () => {
      const project = createProject();
      const original = dirOf(project);
      const actualRename = fs.renameSync;
      let stagedPath = null;
      vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        if (source === original && path.basename(destination).startsWith('.cc-quarantine-')) {
          actualRename(source, destination);
          stagedPath = destination;
          // The staged copy no longer carries this project's marker.
          fs.writeFileSync(path.join(destination, MARKER), 'tampered');
          return undefined;
        }
        if (source === stagedPath) throw new Error('restore failed');
        return actualRename(source, destination);
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const response = await postJson(deleteRoute(project.id));

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ code: 'PROJECT_DELETE_RECOVERY_REQUIRED', outcome: 'recovery-required' });
      expect(projectRow(project.id)).toBeTruthy();
      expect(fs.existsSync(stagedPath)).toBe(true);
    });
  });

  describe('H8 — committed delete with cleanup incomplete', () => {
    it('never reports a clean delete when the staged folder could not be removed', async () => {
      const project = createProject();
      vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const response = await postJson(deleteRoute(project.id));

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        status: 'error',
        code: 'PROJECT_DELETE_CLEANUP_INCOMPLETE',
        outcome: 'deleted-cleanup-incomplete',
        message: expect.stringMatching(new RegExp(`^Project “${project.title}” was deleted, but its folder could not be fully removed`)),
        projectId: project.id,
        project: { id: project.id, title: project.title, deleted: true },
        projectPagesRemain: false,
        redirect: '/projects',
        recoveryRequired: true,
        cleanup: 'incomplete',
      });
      expectNoLeak(response);
      expect(projectRow(project.id)).toBeUndefined();
      expect(fs.existsSync(dirOf(project))).toBe(false);
      expect(quarantineEntries()).toHaveLength(1);
      // The service logs no completed deletion while cleanup is outstanding.
      expect(deleteLogs(project.id)).toEqual([]);
    });
  });

  describe('H9 — unknown errors', () => {
    it('reports an unexpected service error as unknown, never as a clean refusal', async () => {
      const project = createProject();
      vi.spyOn(app.locals.projectService, 'deleteProject').mockImplementation(() => {
        throw new Error(`surprise at ${projectsRoot}`);
      });
      const response = await postJson(deleteRoute(project.id));
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        status: 'error',
        code: 'PROJECT_DELETE_UNKNOWN',
        outcome: 'unknown',
        message: 'Could not confirm whether the project was deleted.',
        projectId: project.id,
      });
      expectNoLeak(response);
    });

    it('reports unknown when a service outcome contradicts the row, in either direction', async () => {
      const project = createProject();
      const service = app.locals.projectService;
      const actual = service.deleteProject.bind(service);
      // A "failed" outcome whose row is in fact gone.
      vi.spyOn(service, 'deleteProject').mockImplementationOnce((id) => {
        actual(id);
        const { ProjectDeletionError } = failureClasses;
        throw new ProjectDeletionError('Project deletion failed. Please try again.', 'restored');
      });
      const response = await postJson(deleteRoute(project.id));
      expect(response.status).toBe(500);
      expect(response.body.outcome).toBe('unknown');

      // A normal return whose row is still present.
      const other = createProject();
      vi.spyOn(service, 'deleteProject').mockImplementationOnce(() => true);
      const second = await postJson(deleteRoute(other.id));
      expect(second.status).toBe(500);
      expect(second.body.outcome).toBe('unknown');
      expect(projectRow(other.id)).toBeTruthy();
    });

    it('treats a failure of the opening read as failed before anything was attempted', async () => {
      const project = createProject();
      const service = app.locals.projectService;
      const deleteSpy = vi.spyOn(service, 'deleteProject');
      vi.spyOn(service, 'findById').mockImplementationOnce(() => { throw new Error('read fault'); });
      const response = await postJson(deleteRoute(project.id));
      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ code: 'PROJECT_DELETE_FAILED', outcome: 'failed' });
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(projectRow(project.id)).toBeTruthy();
    });
  });

  describe('H11 — canonical destination', () => {
    it('always names /projects, whatever returnTo the request carries', async () => {
      const project = createProject();
      const response = await postJson(deleteRoute(project.id), {
        _csrf: csrfToken, returnTo: `https://evil.example/${project.id}`,
      });
      expect(response.status).toBe(200);
      expect(response.body.redirect).toBe('/projects');
      const nativeProject = createProject();
      const native = await postNative(deleteRoute(nativeProject.id), {
        _csrf: csrfToken, returnTo: '/projects?status=ready',
      });
      expect(native.headers.location).toBe('/projects');
    });
  });

  describe('H14 — stale or delayed review', () => {
    it('deletes the same project identity after it was edited elsewhere (the reviewed decision is the project)', async () => {
      const project = createProject();
      await agent.post(`/projects/${project.id}`).type('form')
        .send({ _csrf: csrfToken, title: 'Renamed elsewhere', status: 'ready', description: '', notes: '' })
        .expect(302);
      const renamed = projectRow(project.id);
      expect(renamed.title).toBe('Renamed elsewhere');
      const response = await postJson(deleteRoute(project.id));
      expect(response.status).toBe(200);
      expect(response.body.project.title).toBe('Renamed elsewhere');
      expect(fs.existsSync(path.join(projectsRoot, renamed.project_dir))).toBe(false);
    });

    it('never reuses a deleted id: a held Delete for it cannot reach a newer project', async () => {
      const project = createProject();
      expect((await postJson(deleteRoute(project.id))).status).toBe(200);
      const newer = createProject();
      expect(newer.id).toBeGreaterThan(project.id);
      const stale = await postJson(deleteRoute(project.id));
      expect(stale.status).toBe(404);
      expect(projectRow(newer.id)).toBeTruthy();
      expect(fs.existsSync(dirOf(newer))).toBe(true);
    });
  });
});

const failureClasses = await import('../src/services/project-service.js');
