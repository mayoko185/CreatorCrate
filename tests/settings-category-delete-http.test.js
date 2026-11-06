import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetCategoryService } from '../src/services/asset-category-service.js';
import { PREVIEW_CATEGORY_KEY } from '../src/services/preview-category-settings-service.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

// WP11C: the existing Settings asset-category default Delete route answers the
// in-place Settings Delete (Accept: application/json) as JSON with the real
// service, repository and SQLite, while the native contract (redirect with
// notice, 404 page) is unchanged. Every reported outcome is checked against
// the database. A default is a global template only: deleting it never
// reaches categories already copied into projects.

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const LEAK = /SQLITE|sqlite|constraint|stack|at \w+ \(|[A-Z]:\\|\/tmp\/|node_modules|asset_category_defaults/;

describe('Settings category default Delete — enhanced JSON and native', () => {
  let tmpDir;
  let db;
  let app;
  let agent;
  let csrfToken;
  let maintenanceState;
  let service;
  let fault;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-category-delete-http-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const real = createAssetCategoryService(createAssetCategoryRepository(db));
    fault = { deleteDefault: null, listDefaults: null };
    // The real service, with optional faults injected around its own calls.
    service = {
      ...real,
      listDefaults: () => (fault.listDefaults ? fault.listDefaults(real) : real.listDefaults()),
      deleteDefault: (id) => (fault.deleteDefault ? fault.deleteDefault(real, id) : real.deleteDefault(id)),
    };
    maintenanceState = { active: false };
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
      authConfig: AUTH_CONFIG, maintenanceState, assetCategoryService: service,
    });
    ({ agent, csrfToken } = await authenticate(app));
  });

  afterEach(() => {
    try { closeDatabase(db); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const route = (id) => `/settings/asset-categories/${id}/delete`;
  const postJson = (url, body = { _csrf: csrfToken }) => agent.post(url)
    .set('Accept', 'application/json').type('form').send(body);
  const defaults = () => db.prepare('SELECT id, display_name, directory_slug, display_order, enabled FROM asset_category_defaults ORDER BY display_order, id').all();
  const defaultRow = (id) => db.prepare('SELECT * FROM asset_category_defaults WHERE id = ?').get(id);
  const appMeta = () => db.prepare('SELECT key, value FROM app_meta ORDER BY key').all();
  const projectCategories = () => db.prepare('SELECT * FROM project_asset_categories ORDER BY id').all();
  const assets = () => db.prepare('SELECT * FROM assets ORDER BY id').all();
  const releaseAssets = () => db.prepare('SELECT * FROM release_assets ORDER BY release_id, asset_id').all();

  function addDefault(displayName, directorySlug, enabled = true) {
    return service.addDefault({ displayName, directorySlug, enabled });
  }

  function expectNoLeak(response) {
    expect(JSON.stringify(response.body ?? {})).not.toMatch(LEAK);
  }

  async function createProject(title) {
    return app.locals.projectService.create({ title, description: '', notes: '', status: 'in-progress' });
  }

  describe('H1 / H16 — confirmed JSON Delete', () => {
    it('deletes exactly the identified default and reports it, with a safe message and the Settings destination', async () => {
      const target = addDefault('Disposable “Sketches”', 'disposable-sketches');
      const before = defaults();
      const response = await postJson(route(target.id));
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.vary).toMatch(/Accept/);
      expect(response.body).toEqual({
        status: 'success',
        outcome: 'deleted',
        message: 'Asset category default “Disposable “Sketches”” deleted.',
        categoryId: target.id,
        category: { id: target.id, displayName: 'Disposable “Sketches”', directorySlug: 'disposable-sketches', deleted: true },
        affects: { browserDefault: false, previewCategory: false },
        refresh: true,
        redirect: '/settings/asset-categories',
      });
      expectNoLeak(response);
      expect(defaultRow(target.id)).toBeUndefined();
      expect(defaults()).toEqual(before.filter((row) => row.id !== target.id));
    });
  });

  describe('H2 / H17 — native and negotiation', () => {
    it('keeps the native redirect with its notice and the native 404 page', async () => {
      const target = addDefault('Native', 'native-delete');
      const response = await agent.post(route(target.id)).type('form').send({ _csrf: csrfToken });
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe('/settings/asset-categories?notice=category_deleted');
      expect(defaultRow(target.id)).toBeUndefined();
      const missing = await agent.post(route(target.id)).type('form').send({ _csrf: csrfToken });
      expect(missing.status).toBe(404);
      expect(missing.headers['content-type']).toMatch(/html/);
      const invalid = await agent.post('/settings/asset-categories/01/delete').type('form').send({ _csrf: csrfToken });
      expect(invalid.status).toBe(404);
      expect(invalid.headers['content-type']).toMatch(/html/);
    });

    it('answers HTML-preferring and wildcard requests natively and only an explicit JSON request with JSON', async () => {
      const a = addDefault('Negotiate A', 'negotiate-a');
      const b = addDefault('Negotiate B', 'negotiate-b');
      const html = await agent.post(route(a.id)).set('Accept', 'text/html,application/json;q=0.9').type('form').send({ _csrf: csrfToken });
      expect(html.status).toBe(302);
      const wildcard = await agent.post(route(b.id)).set('Accept', '*/*').type('form').send({ _csrf: csrfToken });
      expect(wildcard.status).toBe(302);
      const c = addDefault('Negotiate C', 'negotiate-c');
      const json = await postJson(route(c.id));
      expect(json.headers['content-type']).toMatch(/json/);
      expect(json.body.outcome).toBe('deleted');
      // GET never deletes.
      const d = addDefault('Negotiate D', 'negotiate-d');
      const get = await agent.get(route(d.id)).set('Accept', 'application/json');
      expect(get.status).toBe(404);
      expect(defaultRow(d.id)).toBeDefined();
    });
  });

  describe('H3 / H15 — missing default and repeated Delete', () => {
    it('refuses a missing or malformed id with nothing deleted', async () => {
      const before = defaults();
      const missing = await postJson(route(999999));
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({
        status: 'error',
        code: 'ASSET_CATEGORY_DEFAULT_NOT_FOUND',
        message: 'This asset category default no longer exists. Nothing was deleted.',
        outcome: 'refused',
        categoryId: 999999,
      });
      for (const raw of ['01', 'abc', '0', '-1', '1.5']) {
        const response = await postJson(`/settings/asset-categories/${raw}/delete`);
        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({ code: 'ASSET_CATEGORY_DEFAULT_NOT_FOUND', outcome: 'refused' });
        expect(response.body.categoryId).toBeUndefined();
      }
      expect(defaults()).toEqual(before);
    });

    it('a second Delete of the same default is refused as missing; ids are never reused', async () => {
      const target = addDefault('Twice', 'twice');
      expect((await postJson(route(target.id))).body.outcome).toBe('deleted');
      const again = await postJson(route(target.id));
      expect(again.status).toBe(404);
      expect(again.body).toMatchObject({ code: 'ASSET_CATEGORY_DEFAULT_NOT_FOUND', outcome: 'refused', categoryId: target.id });
      // AUTOINCREMENT: a new default never takes the deleted id, so a late
      // Delete of that id can only find it gone.
      const replacement = addDefault('Twice', 'twice');
      expect(replacement.id).toBeGreaterThan(target.id);
      const late = await postJson(route(target.id));
      expect(late.status).toBe(404);
      expect(defaultRow(replacement.id)).toBeDefined();
    });
  });

  describe('H4 / H5 / H13 — no protected defaults; projects are never touched', () => {
    it('deletes seeded defaults too (there is no built-in or required default)', async () => {
      const seeded = defaults();
      expect(seeded.map((row) => row.directory_slug)).toEqual(expect.arrayContaining(['final', 'wip']));
      for (const row of seeded) {
        expect((await postJson(route(row.id))).body.outcome).toBe('deleted');
      }
      expect(defaults()).toEqual([]);
    });

    it('a default copied into projects (and in use by their assets and releases) deletes as a template only', async () => {
      const target = addDefault('In Use', 'in-use');
      const project = await createProject('Category Delete Existing Project');
      const copied = projectCategories().find((row) => row.project_id === project.id && row.directory_slug === 'in-use');
      expect(copied).toBeDefined();
      const assetId = Number(db.prepare(`INSERT INTO assets (project_id, filename, relative_path, category_id)
        VALUES (?, 'a.png', 'in-use/a.png', ?)`).run(project.id, copied.id).lastInsertRowid);
      const releaseId = db.prepare(`INSERT INTO releases (project_id, title) VALUES (?, 'Kept release') RETURNING id`).get(project.id).id;
      db.prepare(`INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, 'attachment', 0)`).run(releaseId, assetId);
      db.prepare('UPDATE projects SET archived_at = datetime(\'now\') WHERE id = ?').run(project.id);
      const before = { categories: projectCategories(), assets: assets(), releaseAssets: releaseAssets() };

      const response = await postJson(route(target.id));
      expect(response.body.outcome).toBe('deleted');
      expect(defaultRow(target.id)).toBeUndefined();
      expect(projectCategories()).toEqual(before.categories);
      expect(assets()).toEqual(before.assets);
      expect(releaseAssets()).toEqual(before.releaseAssets);
      expect(fs.existsSync(path.join(tmpDir, 'projects'))).toBe(true);

      // New projects no longer get it; the earlier project still has it.
      const later = await createProject('Category Delete New Project');
      const laterSlugs = projectCategories().filter((row) => row.project_id === later.id).map((row) => row.directory_slug);
      expect(laterSlugs).not.toContain('in-use');
      expect(laterSlugs).toEqual(defaults().filter((row) => row.enabled === 1).map((row) => row.directory_slug));
      expect(projectCategories().filter((row) => row.project_id === project.id)).toEqual(
        before.categories.filter((row) => row.project_id === project.id),
      );
    });
  });

  describe('H6 / H7 — authentication, CSRF and maintenance', () => {
    it('refuses a missing or wrong token and an anonymous request without deleting', async () => {
      const target = addDefault('Guarded', 'guarded');
      const noToken = await postJson(route(target.id), {});
      expect(noToken.status).toBe(403);
      expect(noToken.body).toMatchObject({ status: 'error' });
      expect(noToken.body.outcome).toBeUndefined();
      const badToken = await postJson(route(target.id), { _csrf: 'not-the-token' });
      expect(badToken.status).toBe(403);
      const anonymous = await request(app).post(route(target.id)).set('Accept', 'application/json')
        .type('form').send({ _csrf: csrfToken });
      expect([302, 401, 403]).toContain(anonymous.status);
      for (const response of [noToken, badToken, anonymous]) {
        expectNoLeak(response);
        expect(response.body?.outcome).not.toBe('deleted');
      }
      expect(defaultRow(target.id)).toBeDefined();
    });

    it('answers maintenance with 503 before the route runs, deleting nothing', async () => {
      const target = addDefault('Maintenance', 'maintenance-delete');
      maintenanceState.active = true;
      const response = await postJson(route(target.id));
      maintenanceState.active = false;
      expect(response.status).toBe(503);
      expect(response.body.outcome).toBeUndefined();
      expect(defaultRow(target.id)).toBeDefined();
    });
  });

  describe('H8 / H18 — identity, stale and concurrent Deletes', () => {
    it('deletes by id: a default renamed elsewhere is still the one deleted, and only it', async () => {
      const a = addDefault('Stale A', 'stale-a');
      const b = addDefault('Stale B', 'stale-b');
      const c = addDefault('Stale C', 'stale-c');
      service.editDefault(b.id, { displayName: 'Renamed B', directorySlug: 'renamed-b' });
      const response = await postJson(route(b.id));
      expect(response.body.category).toEqual({ id: b.id, displayName: 'Renamed B', directorySlug: 'renamed-b', deleted: true });
      expect(defaultRow(a.id)).toBeDefined();
      expect(defaultRow(c.id)).toBeDefined();
      expect(defaultRow(b.id)).toBeUndefined();
    });

    it('two Deletes of one default in parallel: one deletes, the other is refused as missing', async () => {
      const target = addDefault('Parallel', 'parallel');
      const answers = await Promise.all([postJson(route(target.id)), postJson(route(target.id))]);
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 404]);
      expect(answers.filter((answer) => answer.body.outcome === 'deleted')).toHaveLength(1);
      expect(defaultRow(target.id)).toBeUndefined();
    });
  });

  describe('H9 / H10 / H11 — failure classification', () => {
    it('a failed delete that left the default in place reports failed with nothing deleted', async () => {
      const target = addDefault('Fails', 'fails');
      fault.deleteDefault = () => { throw new Error('SQLITE_BUSY: database is locked at C:\\secret\\db.sqlite'); };
      const response = await postJson(route(target.id));
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        status: 'error',
        code: 'ASSET_CATEGORY_DEFAULT_DELETE_FAILED',
        message: 'The asset category default could not be deleted. Nothing was deleted. Please try again.',
        outcome: 'failed',
        categoryId: target.id,
      });
      expectNoLeak(response);
      expect(defaultRow(target.id)).toBeDefined();
    });

    it('a failure whose result cannot be shown reports unknown, never failed', async () => {
      const target = addDefault('Unknown', 'unknown-delete');
      fault.deleteDefault = (real, id) => { real.deleteDefault(id); throw new Error('lost after commit'); };
      const response = await postJson(route(target.id));
      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ code: 'ASSET_CATEGORY_DEFAULT_DELETE_UNKNOWN', outcome: 'unknown', categoryId: target.id });
      expectNoLeak(response);
      expect(defaultRow(target.id)).toBeUndefined();

      const other = addDefault('Unreadable', 'unreadable-delete');
      let reads = 0;
      fault.deleteDefault = () => { throw new Error('boom'); };
      fault.listDefaults = (real) => { reads += 1; if (reads > 1) throw new Error('read failed'); return real.listDefaults(); };
      const unreadable = await postJson(route(other.id));
      expect(unreadable.body).toMatchObject({ code: 'ASSET_CATEGORY_DEFAULT_DELETE_UNKNOWN', outcome: 'unknown' });
      expect(defaultRow(other.id)).toBeDefined();
    });

    it('an unreadable default before anything ran is a failure with nothing attempted', async () => {
      const target = addDefault('No read', 'no-read');
      let deletes = 0;
      fault.listDefaults = () => { throw new Error('read failed'); };
      fault.deleteDefault = () => { deletes += 1; };
      const response = await postJson(route(target.id));
      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({ code: 'ASSET_CATEGORY_DEFAULT_DELETE_FAILED', outcome: 'failed' });
      expect(deletes).toBe(0);
      expect(defaultRow(target.id)).toBeDefined();
    });

    it('no row removed: refused as missing when it is gone, failed when it is still there', async () => {
      const gone = addDefault('Raced', 'raced');
      fault.deleteDefault = (real, id) => { db.prepare('DELETE FROM asset_category_defaults WHERE id = ?').run(id); return false; };
      const refused = await postJson(route(gone.id));
      expect(refused.status).toBe(404);
      expect(refused.body).toMatchObject({ code: 'ASSET_CATEGORY_DEFAULT_NOT_FOUND', outcome: 'refused' });
      const kept = addDefault('Kept', 'kept-delete');
      fault.deleteDefault = () => false;
      const failed = await postJson(route(kept.id));
      expect(failed.status).toBe(500);
      expect(failed.body).toMatchObject({ code: 'ASSET_CATEGORY_DEFAULT_DELETE_FAILED', outcome: 'failed' });
      expect(defaultRow(kept.id)).toBeDefined();
    });
  });

  describe('H12 / H14 — ordering and unrelated settings', () => {
    it('survivors keep their saved order; a later add appends after the highest position', async () => {
      db.prepare('DELETE FROM asset_category_defaults').run();
      const rows = ['One', 'Two', 'Three', 'Four'].map((name) => addDefault(name, name.toLowerCase()));
      service.reorderDefaults([rows[3].id, rows[1].id, rows[0].id, rows[2].id]);
      const before = defaults();
      await postJson(route(rows[1].id));
      expect(defaults()).toEqual(before.filter((row) => row.id !== rows[1].id));
      expect(defaults().map((row) => row.display_order)).toEqual([0, 2, 3]);
      const added = addDefault('Five', 'five');
      expect(defaultRow(added.id).display_order).toBe(4);
    });

    it('never rewrites the saved browser default or preview category; says when they named the deleted default', async () => {
      const target = addDefault('Named Default', 'named-default');
      const other = addDefault('Other Default', 'other-default');
      await agent.post('/settings/asset-categories/browser-default').type('form')
        .send({ defaultCategory: 'named-default', _csrf: csrfToken }).expect(302);
      await agent.post('/settings/asset-categories/preview-category').type('form')
        .send({ previewCategory: 'named-default', _csrf: csrfToken }).expect(302);
      const before = appMeta();
      const response = await postJson(route(target.id));
      expect(response.body.affects).toEqual({ browserDefault: true, previewCategory: true });
      expect(appMeta()).toEqual(before);
      expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').pluck().get(PREVIEW_CATEGORY_KEY)).toBe('named-default');
      const page = await agent.get('/settings/asset-categories').expect(200);
      expect(page.text).toMatch(/unavailable/i);
      expect((await postJson(route(other.id))).body.affects).toEqual({ browserDefault: false, previewCategory: false });
    });

    it('ignores any other field sent with Delete', async () => {
      const target = addDefault('Extra', 'extra-fields');
      const other = addDefault('Untouched', 'untouched');
      const before = appMeta();
      await postJson(route(target.id), {
        _csrf: csrfToken, displayName: 'Changed', directorySlug: 'changed', enabled: '0',
        orderedCategoryIds: String(other.id), defaultCategory: 'untouched',
      });
      expect(defaultRow(other.id)).toMatchObject({ display_name: 'Untouched', directory_slug: 'untouched', enabled: 1 });
      expect(appMeta()).toEqual(before);
    });
  });
});
