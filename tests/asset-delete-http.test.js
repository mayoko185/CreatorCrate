import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createProjectOperationCoordinator } from '../src/services/project-operation-coordinator.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';
import { assetDeleteReviewToken } from '../src/services/asset-delete-review.js';

// WP10A3-B: the existing single-asset Delete route answers the Edit Asset
// dialog's enhanced submission (Accept: application/json) as JSON, with the
// real asset action service, repositories, filesystem staging and rules, while
// the native form contract (redirect, re-rendered viewer error) is unchanged.
// Faults are injected into the real service's filesystem and database calls;
// every reported outcome is checked against the database and the disk.

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const STAGING_PREFIX = '.creatorcrate-delete-';

describe('asset Delete — enhanced JSON', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let app;
  let agent;
  let csrfToken;
  let coordinator;
  let fixtureCount = 0;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-delete-http-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const previewRoot = path.join(tmpDir, 'previews');
    fs.mkdirSync(previewRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    coordinator = createProjectOperationCoordinator();
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, {
      authConfig: AUTH_CONFIG, projectOperationCoordinator: coordinator,
    });
    ({ agent, csrfToken } = await authenticate(app));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { closeDatabase(db); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createProject() {
    fixtureCount += 1;
    const project = app.locals.projectService.create({ title: `Delete ${fixtureCount}`, status: 'tbd' });
    const categories = app.locals.projectAssetCategoryService;
    const wip = categories.list(project.id).find((c) => c.directory_slug === 'wip')
      || categories.add(project.id, { displayName: 'WIP', directorySlug: 'wip' });
    const directory = path.join(projectsRoot, project.project_dir);
    fs.mkdirSync(path.join(directory, 'wip'), { recursive: true });
    for (const filename of ['hero.png', 'other.png']) {
      await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
        .png().toFile(path.join(directory, 'wip', filename));
    }
    app.locals.assetScanner.scanProjectAssets(project.id);
    const assetId = (filename) => db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?')
      .get(project.id, filename).id;
    const stagingDirs = () => fs.readdirSync(directory).filter((name) => name.startsWith(STAGING_PREFIX));
    return {
      projectId: project.id,
      directory,
      wipId: wip.id,
      hero: assetId('hero.png'),
      other: assetId('other.png'),
      onDisk: (relative) => fs.existsSync(path.join(directory, ...relative.split('/'))),
      stagingDirs,
      stagedFiles: () => stagingDirs().flatMap((name) => fs.readdirSync(path.join(directory, name))),
    };
  }

  const assetRow = (id) => db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  // F2: the Delete form carries the reviewed state of the asset it showed.
  // These tests review the asset as it is when they send (an absent row gets a
  // well-formed token, so the route's not-found answers are still exercised);
  // the stale-review tests below send an earlier review explicitly.
  const PLACEHOLDER_REVIEW = `v1.${'A'.repeat(43)}`;
  const reviewed = (route, body) => {
    // F2B: the Rename and Move steps these tests take are made from a page
    // showing the asset as it is, so they carry its current reviewed state too.
    const file = /\/assets\/(\d+)\/(rename|move)$/.exec(route);
    if (file && body && !Object.hasOwn(body, 'assetReview')) {
      const row = assetRow(Number(file[1]));
      return { ...body, assetReview: row ? assetDeleteReviewToken(row) : PLACEHOLDER_REVIEW };
    }
    const match = /\/assets\/(\d+)\/delete$/.exec(route);
    if (!match || !body || Object.hasOwn(body, 'deleteReview')) return body;
    const row = assetRow(Number(match[1]));
    return { ...body, deleteReview: row ? assetDeleteReviewToken(row) : PLACEHOLDER_REVIEW };
  };
  const postJson = (route, body) => agent.post(route).set('Accept', 'application/json').type('form').send(reviewed(route, body));
  const postNative = (route, body) => agent.post(route).type('form').send(reviewed(route, body));
  const assetCount = (projectId) => db.prepare('SELECT COUNT(*) AS n FROM assets WHERE project_id = ?').get(projectId).n;
  const deleteRoute = (f, id = f.hero) => `/projects/${f.projectId}/assets/${id}/delete`;
  const archive = (projectId) => agent.post(`/projects/${projectId}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);
  const insertRelease = (projectId, title, published = false) => db.prepare(`
    INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url, archived_at)
    VALUES (?, ?, '', '', NULL, ?, NULL, NULL) RETURNING id
  `).get(projectId, title, published ? '2026-08-05' : null).id;
  const linkReleaseAsset = (releaseId, assetId) => db.prepare(
    "INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, 'attachment', 0)",
  ).run(releaseId, assetId);
  const deletionLogs = (projectId) => db.prepare(
    "SELECT event, context_json FROM application_logs WHERE project_id = ? AND event LIKE 'asset.%deleted' ORDER BY id",
  ).all(projectId).map((row) => ({ event: row.event, context: JSON.parse(row.context_json) }));
  const releaseAssetIds = (releaseId) => db.prepare('SELECT asset_id FROM release_assets WHERE release_id = ? ORDER BY asset_id')
    .all(releaseId).map((row) => row.asset_id);
  // A real database fault inside the service's delete transaction.
  const failAssetDeletes = () => db.exec(
    "CREATE TRIGGER wp10a3b_fail_delete BEFORE DELETE ON assets BEGIN SELECT RAISE(ABORT, 'injected'); END;",
  );
  const expectNoLeak = (body) => {
    const text = JSON.stringify(body);
    expect(text).not.toContain(tmpDir);
    expect(text).not.toMatch(/[A-Za-z]:\\\\|\/tmp\/|stack|injected|\.creatorcrate-delete-[A-Za-z0-9]{3,}/i);
  };

  describe('A. JSON success', () => {
    it('deletes once, removes the record and the file, and answers with the canonical Project Assets URL', async () => {
      const f = await createProject();
      const deleteAssets = vi.spyOn(app.locals.assetActionService, 'deleteAssets');

      const response = await postJson(deleteRoute(f), {
        _csrf: csrfToken, category: String(f.wipId), search: 'hero', unknown: 'strip-me',
      }).expect(200);

      expect(response.body).toEqual({
        status: 'success',
        outcome: 'deleted',
        action: 'asset-deleted',
        message: 'The asset was deleted.',
        projectId: f.projectId,
        assetId: f.hero,
        deletedAssetIds: [f.hero],
        cleanup: 'complete',
        assetsUrl: expect.stringMatching(new RegExp(`^/projects/${f.projectId}/assets\\?`)),
      });
      const destination = new URL(response.body.assetsUrl, 'http://x');
      expect(destination.searchParams.get('category')).toBe(String(f.wipId));
      expect(destination.searchParams.get('search')).toBe('hero');
      expect(destination.searchParams.get('assets_deleted')).toBe('1');
      expect(destination.searchParams.has('unknown')).toBe(false);
      expect(deleteAssets).toHaveBeenCalledExactlyOnceWith(f.projectId, [f.hero], { reviewed: expect.any(Map) });
      expect(assetRow(f.hero)).toBeUndefined();
      expect(f.onDisk('wip/hero.png')).toBe(false);
      expect(f.stagingDirs()).toEqual([]);
      // No other asset is affected.
      expect(assetRow(f.other)).toMatchObject({ filename: 'other.png', is_present: 1 });
      expect(f.onDisk('wip/other.png')).toBe(true);
      expect(deletionLogs(f.projectId)).toEqual([{ event: 'asset.deleted', context: { assetCount: 1 } }]);
      expectNoLeak(response.body);
    });

    it('answers a second Delete of the same asset as missing, changing nothing', async () => {
      const f = await createProject();
      await postJson(deleteRoute(f), { _csrf: csrfToken }).expect(200);
      const again = await postJson(deleteRoute(f), { _csrf: csrfToken }).expect(404);
      expect(again.body).toEqual({
        status: 'error',
        code: 'ASSET_NOT_FOUND',
        outcome: 'refused',
        message: 'This asset no longer exists in this project. It may have been deleted elsewhere.',
      });
      expect(assetRow(f.other)).toBeDefined();
      expect(f.onDisk('wip/other.png')).toBe(true);
    });
  });

  describe('B. native success (unchanged)', () => {
    it('redirects to Project Assets with the filter context and assets_deleted=1', async () => {
      const f = await createProject();
      const response = await postNative(deleteRoute(f), {
        _csrf: csrfToken, category: String(f.wipId), search: 'hero', unknown: 'strip-me',
      }).expect(302);
      const location = new URL(response.headers.location, 'http://x');
      expect(location.pathname).toBe(`/projects/${f.projectId}/assets`);
      expect(location.searchParams.get('category')).toBe(String(f.wipId));
      expect(location.searchParams.get('search')).toBe('hero');
      expect(location.searchParams.get('assets_deleted')).toBe('1');
      expect(location.searchParams.has('unknown')).toBe(false);
      expect(assetRow(f.hero)).toBeUndefined();
      expect(f.onDisk('wip/hero.png')).toBe(false);
      expect(f.stagingDirs()).toEqual([]);
      expect(assetRow(f.other)).toBeDefined();

      const page = await agent.get(response.headers.location).expect(200);
      expect(page.text).toContain('Deleted 1 asset.');
    });

    it('keeps native refusals: an archived project re-renders the viewer (409), an unknown asset is 404', async () => {
      const f = await createProject();
      await postNative(`/projects/${f.projectId}/assets/999999/delete`, { _csrf: csrfToken }).expect(404);
      await archive(f.projectId);
      const archived = await postNative(deleteRoute(f), { _csrf: csrfToken }).expect(409);
      expect(archived.headers['content-type']).toMatch(/text\/html/);
      expect(archived.text).toContain('This project is archived and read-only.');
      expect(assetRow(f.hero)).toBeDefined();
      expect(f.onDisk('wip/hero.png')).toBe(true);
    });
  });

  describe('C. refusals', () => {
    it('refuses an archived project with nothing changed', async () => {
      const f = await createProject();
      await archive(f.projectId);
      const response = await postJson(deleteRoute(f), { _csrf: csrfToken }).expect(409);
      expect(response.body).toEqual({
        status: 'error', code: 'PROJECT_ARCHIVED', outcome: 'refused', message: 'This project is archived and read-only.',
      });
      expect(assetRow(f.hero)).toBeDefined();
      expect(f.onDisk('wip/hero.png')).toBe(true);
      expect(f.stagingDirs()).toEqual([]);
    });

    it('refuses missing, malformed and cross-project identities as JSON 404', async () => {
      const f = await createProject();
      const g = await createProject();
      const cases = [
        [`/projects/not-a-project/assets/${f.hero}/delete`, 'PROJECT_NOT_FOUND'],
        [`/projects/999999/assets/${f.hero}/delete`, 'PROJECT_NOT_FOUND'],
        [`/projects/${f.projectId}/assets/not-an-asset/delete`, 'ASSET_NOT_FOUND'],
        [`/projects/${f.projectId}/assets/999999/delete`, 'ASSET_NOT_FOUND'],
        [`/projects/${f.projectId}/assets/${g.hero}/delete`, 'ASSET_NOT_FOUND'],
      ];
      for (const [route, code] of cases) {
        const response = await postJson(route, { _csrf: csrfToken }).expect(404);
        expect(response.body).toMatchObject({ status: 'error', code, outcome: 'refused' });
        expectNoLeak(response.body);
      }
      expect(assetRow(g.hero)).toBeDefined();
      expect(fs.existsSync(path.join(g.directory, 'wip', 'hero.png'))).toBe(true);
      expect(assetRow(f.hero)).toBeDefined();
    });

    it('refuses a busy project (a real held project lock) with nothing changed', async () => {
      const f = await createProject();
      let release;
      const held = coordinator.runAsync(f.projectId, () => new Promise((resolve) => { release = resolve; }));
      try {
        const response = await postJson(deleteRoute(f), { _csrf: csrfToken }).expect(409);
        expect(response.body).toEqual({
          status: 'error',
          code: 'PROJECT_BUSY',
          outcome: 'refused',
          message: 'Another project operation is already in progress. Try again.',
        });
      } finally {
        release();
        await held;
      }
      expect(assetRow(f.hero)).toBeDefined();
      expect(f.onDisk('wip/hero.png')).toBe(true);
    });

    it('refuses a published-release asset and a missing-at-last-scan asset (precheck) with nothing changed', async () => {
      const f = await createProject();
      const release = insertRelease(f.projectId, 'Published', true);
      linkReleaseAsset(release, f.other);
      const published = await postJson(deleteRoute(f, f.other), { _csrf: csrfToken }).expect(409);
      expect(published.body).toEqual({
        status: 'error',
        code: 'DELETE_PUBLISHED_RELEASE_ASSET',
        outcome: 'refused',
        message: 'This asset is associated with a published release and cannot be permanently deleted.',
      });
      expect(assetRow(f.other)).toBeDefined();
      expect(f.onDisk('wip/other.png')).toBe(true);
      expect(releaseAssetIds(release)).toEqual([f.other]);

      fs.rmSync(path.join(f.directory, 'wip', 'hero.png'));
      app.locals.assetScanner.scanProjectAssets(f.projectId);
      expect(assetRow(f.hero).is_present).toBe(0);
      const missing = await postJson(deleteRoute(f), { _csrf: csrfToken }).expect(422);
      expect(missing.body).toEqual({
        status: 'error',
        code: 'DELETE_PRECHECK_FAILED',
        outcome: 'refused',
        message: 'This asset cannot be deleted because it is missing or inaccessible.',
      });
      expect(assetRow(f.hero)).toBeDefined();
      expect(f.stagingDirs()).toEqual([]);
    });
  });

  describe('D. authentication and CSRF', () => {
    it('requires a valid CSRF token and a signed-in session; neither deletes anything', async () => {
      const f = await createProject();
      const noToken = await postJson(deleteRoute(f), {});
      expect(noToken.status).toBe(403);
      const badToken = await postJson(deleteRoute(f), { _csrf: 'not-the-token' });
      expect(badToken.status).toBe(403);
      const anonymous = await request(app).post(deleteRoute(f)).set('Accept', 'application/json').type('form')
        .send({ _csrf: csrfToken });
      expect([302, 401, 403]).toContain(anonymous.status);
      for (const response of [noToken, badToken, anonymous]) {
        expect(response.text).not.toContain(tmpDir);
        // None of these is a deletion answer.
        expect(response.body?.outcome).not.toBe('deleted');
      }
      expect(assetRow(f.hero)).toBeDefined();
      expect(f.onDisk('wip/hero.png')).toBe(true);
      expect(f.stagingDirs()).toEqual([]);
    });
  });

  describe('E. failures and file cleanup (real service, injected faults)', () => {
    it('a staging-area failure before anything moved is "failed": nothing removed', async () => {
      const f = await createProject();
      vi.spyOn(fs, 'mkdtempSync').mockImplementationOnce(() => { throw Object.assign(new Error(`EACCES ${tmpDir}`), { code: 'EACCES' }); });
      const response = await postJson(deleteRoute(f), { _csrf: csrfToken }).expect(500);
      expect(response.body).toEqual({
        status: 'error',
        code: 'DELETE_FILESYSTEM_OPERATION_FAILED',
        outcome: 'failed',
        message: 'The file could not be deleted. Nothing was removed.',
      });
      expect(assetRow(f.hero)).toBeDefined();
      expect(f.onDisk('wip/hero.png')).toBe(true);
      expect(f.stagingDirs()).toEqual([]);
      expectNoLeak(response.body);
    });

    it('a database failure the service rolls back and restores is "failed": record and file are back', async () => {
      const f = await createProject();
      failAssetDeletes();
      const response = await postJson(deleteRoute(f), { _csrf: csrfToken }).expect(500);
      expect(response.body).toEqual({
        status: 'error',
        code: 'DELETE_DATABASE_OPERATION_FAILED',
        outcome: 'failed',
        message: 'The asset could not be deleted. Its file was restored and nothing was removed.',
      });
      expect(assetRow(f.hero)).toBeDefined();
      expect(f.onDisk('wip/hero.png')).toBe(true);
      expect(f.stagingDirs()).toEqual([]);
      expectNoLeak(response.body);
    });

    it('a committed delete whose staged file cannot be removed is "deleted-cleanup-incomplete", never a clean refusal', async () => {
      const f = await createProject();
      const realRm = fs.rmSync;
      vi.spyOn(fs, 'rmSync').mockImplementation((target, ...rest) => {
        if (String(target).includes(STAGING_PREFIX)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        return realRm(target, ...rest);
      });
      const response = await postJson(deleteRoute(f), { _csrf: csrfToken, category: String(f.wipId) }).expect(500);
      vi.mocked(fs.rmSync).mockRestore();

      expect(response.body).toEqual({
        status: 'error',
        code: 'DELETE_RECOVERY_REQUIRED',
        outcome: 'deleted-cleanup-incomplete',
        recoveryRequired: true,
        assetDeleted: true,
        projectId: f.projectId,
        assetId: f.hero,
        cleanup: 'incomplete',
        message: expect.stringContaining('could not be fully removed'),
        assetsUrl: expect.stringMatching(new RegExp(`^/projects/${f.projectId}/assets`)),
      });
      // Not a success notice: the destination does not claim a clean deletion.
      expect(new URL(response.body.assetsUrl, 'http://x').searchParams.has('assets_deleted')).toBe(false);
      expect(new URL(response.body.assetsUrl, 'http://x').searchParams.get('category')).toBe(String(f.wipId));
      // What the answer says is what the database and the disk hold.
      expect(assetRow(f.hero)).toBeUndefined();
      expect(f.onDisk('wip/hero.png')).toBe(false);
      expect(f.stagingDirs()).toHaveLength(1);
      expect(f.stagedFiles()).toHaveLength(1);
      expect(assetRow(f.other)).toBeDefined();
      // The service logs no completed deletion for this outcome (unchanged).
      expect(deletionLogs(f.projectId)).toEqual([]);
      expectNoLeak({ ...response.body, message: '' });
      expect(response.body.message).not.toContain(tmpDir);
    });

    it('a rollback whose file cannot be put back is "recovery-required": the record remains', async () => {
      const f = await createProject();
      failAssetDeletes();
      const realRename = fs.renameSync;
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        // Staging works; only the restore out of the staging area fails.
        if (String(from).includes(STAGING_PREFIX)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        return realRename(from, to);
      });
      const response = await postJson(deleteRoute(f), { _csrf: csrfToken }).expect(500);
      vi.mocked(fs.renameSync).mockRestore();

      expect(response.body).toEqual({
        status: 'error',
        code: 'DELETE_RECOVERY_REQUIRED',
        outcome: 'recovery-required',
        recoveryRequired: true,
        message: expect.stringContaining('The asset was not deleted'),
      });
      expect(assetRow(f.hero)).toBeDefined();
      expect(f.onDisk('wip/hero.png')).toBe(false);
      expect(f.stagedFiles()).toHaveLength(1);
      expectNoLeak(response.body);
    });

    it('an unexpected failure is "unknown": no claim that nothing happened', async () => {
      const f = await createProject();
      vi.spyOn(app.locals.assetActionService, 'deleteAssets').mockImplementationOnce(() => {
        throw new TypeError(`boom at ${tmpDir}`);
      });
      const response = await postJson(deleteRoute(f), { _csrf: csrfToken }).expect(500);
      expect(response.body).toEqual({
        status: 'error', code: 'ASSET_DELETE_UNCONFIRMED', outcome: 'unknown', message: 'The deletion could not be confirmed.',
      });
      expectNoLeak(response.body);
    });

    it('native recovery failures keep their existing rendering (no JSON, no leak)', async () => {
      const f = await createProject();
      failAssetDeletes();
      const response = await postNative(deleteRoute(f), { _csrf: csrfToken }).expect(500);
      expect(response.headers['content-type']).toMatch(/text\/html/);
      expect(response.text).toContain('The selected files were restored');
      expect(response.text).not.toContain(tmpDir);
      expect(assetRow(f.hero)).toBeDefined();
    });
  });

  describe('F. related state (existing semantics)', () => {
    it('removes draft-release membership, project/book primary images and tags by cascade; counts follow', async () => {
      const f = await createProject();
      const draft = insertRelease(f.projectId, 'Draft');
      linkReleaseAsset(draft, f.hero);
      linkReleaseAsset(draft, f.other);
      app.locals.projectPrimaryImageService.setPrimaryImage(f.projectId, f.hero);
      const tag = app.locals.tagService.createTag({ name: 'Delete Tag' });
      db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(f.hero, tag.id);
      db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(f.other, tag.id);
      expect(assetCount(f.projectId)).toBe(2);

      await postJson(deleteRoute(f), { _csrf: csrfToken }).expect(200);

      expect(assetCount(f.projectId)).toBe(1);
      expect(releaseAssetIds(draft)).toEqual([f.other]);
      expect(app.locals.projectPrimaryImageService.getPrimaryImage(f.projectId)?.id ?? null).toBeNull();
      expect(db.prepare('SELECT asset_id FROM asset_tags WHERE tag_id = ?').all(tag.id).map((r) => r.asset_id)).toEqual([f.other]);
      const page = await agent.get(`/projects/${f.projectId}/assets?category=all`).expect(200);
      expect(page.text).not.toContain('hero.png');
      expect(page.text).toContain('other.png');
    });
  });

  // ─── F2: a Delete is bound to the asset state its confirmation reviewed ──
  // The Asset detail page renders a reviewed-state token into its Delete form;
  // the service compares it with the current row under the project lock, before
  // any file is staged. These run the real service, repositories and files.
  describe('G. reviewed-state precondition (F2)', () => {
    const renameRoute = (f, id = f.hero) => `/projects/${f.projectId}/assets/${id}/rename`;
    const moveRoute = (f, id = f.hero) => `/projects/${f.projectId}/assets/${id}/move`;
    const viewerRoute = (f, id = f.hero) => `/projects/${f.projectId}/assets/${id}`;
    const REVIEW_INPUT = /<input type="hidden" name="deleteReview" value="([^"]*)" data-asset-delete-review>/g;
    // The token exactly as the server rendered it into the page's Delete form.
    const renderedReview = async (f, id = f.hero) => {
      const page = await agent.get(viewerRoute(f, id)).expect(200);
      const matches = [...page.text.matchAll(REVIEW_INPUT)];
      expect(matches).toHaveLength(1);
      return matches[0][1];
    };
    const addRenders = (f) => {
      const renders = app.locals.projectAssetCategoryService.add(f.projectId, { displayName: 'Renders', directorySlug: 'renders' });
      fs.mkdirSync(path.join(f.directory, 'renders'), { recursive: true });
      return renders;
    };
    const expectUntouched = (f) => {
      expect(f.stagingDirs()).toEqual([]);
      expect(deletionLogs(f.projectId)).toEqual([]);
      expect(assetRow(f.other)).toMatchObject({ filename: 'other.png', is_present: 1 });
      expect(f.onDisk('wip/other.png')).toBe(true);
    };
    const STALE = {
      status: 'error',
      code: 'DELETE_STALE_ASSET',
      outcome: 'refused',
      message: 'This asset was renamed, moved or replaced after the deletion was reviewed, so it was not deleted. Review the asset as it is now and delete it again if you still want to.',
    };

    it('H1. a Delete reviewed before a Rename is refused as stale; the renamed row and file survive', async () => {
      const f = await createProject();
      const review = await renderedReview(f);
      expect(review).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/);

      await postJson(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'after-reload.png' }).expect(200);
      expect(f.onDisk('wip/after-reload.png')).toBe(true);
      const deleteAssets = vi.spyOn(app.locals.assetActionService, 'deleteAssets');

      const response = await postJson(deleteRoute(f), { _csrf: csrfToken, deleteReview: review }).expect(409);

      expect(response.body).toEqual(STALE);
      expectNoLeak(response.body);
      expect(response.body.message).not.toContain('after-reload');
      // The request reached the service once; it refused under the lock.
      expect(deleteAssets).toHaveBeenCalledOnce();
      expect(assetRow(f.hero)).toMatchObject({ filename: 'after-reload.png', relative_path: 'wip/after-reload.png', is_present: 1 });
      expect(f.onDisk('wip/after-reload.png')).toBe(true);
      expect(f.onDisk('wip/hero.png')).toBe(false);
      expectUntouched(f);
    });

    it('H2. a Delete reviewed before a Move is refused as stale; the moved row, category and file survive', async () => {
      const f = await createProject();
      const renders = addRenders(f);
      const review = await renderedReview(f);

      await postNative(moveRoute(f), { _csrf: csrfToken, destinationCategory: String(renders.id) }).expect(302);
      expect(assetRow(f.hero)).toMatchObject({ category_id: renders.id, relative_path: 'renders/hero.png' });

      const response = await postJson(deleteRoute(f), { _csrf: csrfToken, deleteReview: review }).expect(409);

      expect(response.body).toEqual(STALE);
      expect(assetRow(f.hero)).toMatchObject({ category_id: renders.id, relative_path: 'renders/hero.png', is_present: 1 });
      expect(f.onDisk('renders/hero.png')).toBe(true);
      expect(fs.readdirSync(path.join(f.directory, 'renders'))).toEqual(['hero.png']);
      expectUntouched(f);
    });

    it('H1/H2. a Rename followed by a Move, and a replaced source, also make the earlier review stale', async () => {
      const f = await createProject();
      const renders = addRenders(f);
      const review = await renderedReview(f);
      await postNative(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'subject.png' }).expect(302);
      await postNative(moveRoute(f), { _csrf: csrfToken, destinationCategory: String(renders.id) }).expect(302);
      await postJson(deleteRoute(f), { _csrf: csrfToken, deleteReview: review }).expect(409);
      expect(f.onDisk('renders/subject.png')).toBe(true);

      // Another recorded change at the same path: a new source instance.
      const current = await renderedReview(f);
      db.prepare('UPDATE assets SET source_generation = source_generation + 1 WHERE id = ?').run(f.hero);
      const replaced = await postJson(deleteRoute(f), { _csrf: csrfToken, deleteReview: current }).expect(409);
      expect(replaced.body.code).toBe('DELETE_STALE_ASSET');
      expect(f.onDisk('renders/subject.png')).toBe(true);
      expectUntouched(f);
    });

    it('H3. a fresh review after a Rename/Move deletes the current asset once, with the canonical destination', async () => {
      const f = await createProject();
      const renders = addRenders(f);
      const stale = await renderedReview(f);
      await postJson(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'current.png' }).expect(200);
      await postNative(moveRoute(f), { _csrf: csrfToken, destinationCategory: String(renders.id) }).expect(302);
      const fresh = await renderedReview(f);
      expect(fresh).not.toBe(stale);
      const deleteAssets = vi.spyOn(app.locals.assetActionService, 'deleteAssets');

      const response = await postJson(deleteRoute(f), {
        _csrf: csrfToken, deleteReview: fresh, category: String(renders.id),
      }).expect(200);

      expect(response.body).toMatchObject({ outcome: 'deleted', deletedAssetIds: [f.hero], cleanup: 'complete' });
      const destination = new URL(response.body.assetsUrl, 'http://x');
      expect(destination.pathname).toBe(`/projects/${f.projectId}/assets`);
      expect(destination.searchParams.get('category')).toBe(String(renders.id));
      expect(destination.searchParams.get('assets_deleted')).toBe('1');
      expect(deleteAssets).toHaveBeenCalledOnce();
      expect(assetRow(f.hero)).toBeUndefined();
      expect(f.onDisk('renders/current.png')).toBe(false);
      expect(f.stagingDirs()).toEqual([]);
      expect(deletionLogs(f.projectId)).toEqual([{ event: 'asset.deleted', context: expect.objectContaining({ assetCount: 1 }) }]);
    });

    it('H4. a missing, malformed, repeated, foreign or tampered review deletes nothing', async () => {
      const f = await createProject();
      const g = await createProject();
      const review = await renderedReview(f);
      const otherAssetReview = await renderedReview(f, f.other);
      const otherProjectReview = await renderedReview(g);
      const tampered = `${review.slice(0, -1)}${review.endsWith('A') ? 'B' : 'A'}`;
      const deleteAssets = vi.spyOn(app.locals.assetActionService, 'deleteAssets');

      // Refused by the route before the service runs.
      for (const body of [
        { _csrf: csrfToken },
        { _csrf: csrfToken, deleteReview: '' },
        { _csrf: csrfToken, deleteReview: 'v1.short' },
        { _csrf: csrfToken, deleteReview: `v2.${review.slice(3)}` },
        { _csrf: csrfToken, deleteReview: `${review} ` },
        { _csrf: csrfToken, 'deleteReview[x]': review },
      ]) {
        const response = await agent.post(deleteRoute(f)).set('Accept', 'application/json').type('form').send(body).expect(422);
        expect(response.body).toMatchObject({ status: 'error', code: 'DELETE_REVIEW_INVALID', outcome: 'refused' });
        expectNoLeak(response.body);
      }
      const repeated = await agent.post(deleteRoute(f)).set('Accept', 'application/json').type('form')
        .send(`_csrf=${encodeURIComponent(csrfToken)}&deleteReview=${review}&deleteReview=${review}`).expect(422);
      expect(repeated.body.code).toBe('DELETE_REVIEW_INVALID');
      const nativeMissing = await agent.post(deleteRoute(f)).type('form').send({ _csrf: csrfToken }).expect(422);
      expect(nativeMissing.text).toContain('does not identify the asset version you reviewed');
      expect(deleteAssets).not.toHaveBeenCalled();

      // Well-formed but naming another asset, another project or another
      // state: refused by the service under the lock.
      for (const deleteReview of [otherAssetReview, otherProjectReview, tampered]) {
        const response = await postJson(deleteRoute(f), { _csrf: csrfToken, deleteReview }).expect(409);
        expect(response.body).toEqual(STALE);
      }
      expect(deleteAssets).toHaveBeenCalledTimes(3);
      expect(assetRow(f.hero)).toMatchObject({ filename: 'hero.png', is_present: 1 });
      expect(f.onDisk('wip/hero.png')).toBe(true);
      expect(assetRow(g.hero)).toMatchObject({ filename: 'hero.png', is_present: 1 });
      expectUntouched(f);
    });

    it('E. a stale Delete for an asset that is already gone keeps the not-found answer', async () => {
      const f = await createProject();
      const review = await renderedReview(f);
      await postJson(deleteRoute(f), { _csrf: csrfToken, deleteReview: review }).expect(200);
      const again = await postJson(deleteRoute(f), { _csrf: csrfToken, deleteReview: review }).expect(404);
      expect(again.body).toMatchObject({ code: 'ASSET_NOT_FOUND', outcome: 'refused' });
    });

    it('H5. native: the rendered form deletes with its review; a stale one re-renders with the current review', async () => {
      const f = await createProject();
      const review = await renderedReview(f);
      await postNative(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'native.png' }).expect(302);

      const stale = await postNative(deleteRoute(f), { _csrf: csrfToken, deleteReview: review, search: 'n' }).expect(409);
      expect(stale.headers['content-type']).toMatch(/text\/html/);
      expect(stale.text).toContain('This asset was renamed, moved or replaced after the deletion was reviewed, so it was not deleted.');
      const rerendered = [...stale.text.matchAll(REVIEW_INPUT)].map((m) => m[1]);
      expect(rerendered).toHaveLength(1);
      expect(rerendered[0]).not.toBe(review);
      expect(rerendered[0]).toBe(await renderedReview(f));
      expect(f.onDisk('wip/native.png')).toBe(true);
      expectUntouched(f);

      const ok = await postNative(deleteRoute(f), { _csrf: csrfToken, deleteReview: rerendered[0], search: 'n' }).expect(302);
      const location = new URL(ok.headers.location, 'http://localhost');
      expect(location.pathname).toBe(`/projects/${f.projectId}/assets`);
      expect(location.searchParams.get('assets_deleted')).toBe('1');
      expect(assetRow(f.hero)).toBeUndefined();
      expect(f.onDisk('wip/native.png')).toBe(false);
    });

    it('H6. Project Assets bulk delete and direct service callers keep their behavior', async () => {
      const f = await createProject();
      const deleteAssets = vi.spyOn(app.locals.assetActionService, 'deleteAssets');
      const bulk = await agent.post(`/projects/${f.projectId}/assets/delete-selected`).type('form')
        .send({ _csrf: csrfToken, selectedAssetIds: String(f.other), category: 'all' }).expect(302);
      expect(new URL(bulk.headers.location, 'http://x').searchParams.get('assets_deleted')).toBe('1');
      expect(deleteAssets).toHaveBeenCalledExactlyOnceWith(f.projectId, [f.other]);
      expect(assetRow(f.other)).toBeUndefined();

      const service = app.locals.assetActionService;
      expect(() => service.deleteAssets(f.projectId, [f.hero], { reviewed: new Map() }))
        .toThrow(expect.objectContaining({ code: 'DELETE_REVIEW_INVALID' }));
      expect(() => service.deleteAssets(f.projectId, [f.hero], { reviewed: new Map([[f.hero, 42]]) }))
        .toThrow(expect.objectContaining({ code: 'DELETE_REVIEW_INVALID' }));
      expect(f.onDisk('wip/hero.png')).toBe(true);
      expect(service.deleteAssets(f.projectId, [f.hero])).toMatchObject({ deletedCount: 1, deletedAssetIds: [f.hero] });
      expect(f.onDisk('wip/hero.png')).toBe(false);
    });

    it('H7. a current review keeps the restore classification; a stale one is refused before any file step', async () => {
      const f = await createProject();
      const review = await renderedReview(f);

      failAssetDeletes();
      const failed = await postJson(deleteRoute(f), { _csrf: csrfToken, deleteReview: review }).expect(500);
      expect(failed.body).toMatchObject({ code: 'DELETE_DATABASE_OPERATION_FAILED', outcome: 'failed' });
      expect(f.onDisk('wip/hero.png')).toBe(true);
      db.exec('DROP TRIGGER wp10a3b_fail_delete');

      // A stale review is refused before staging even while a fault is armed:
      // the faulting step is never reached.
      await postJson(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'later.png' }).expect(200);
      failAssetDeletes();
      const rmSync = vi.spyOn(fs, 'rmSync');
      const renameSync = vi.spyOn(fs, 'renameSync');
      const mkdtempSync = vi.spyOn(fs, 'mkdtempSync');
      const stale = await postJson(deleteRoute(f), { _csrf: csrfToken, deleteReview: review }).expect(409);
      expect(stale.body).toEqual(STALE);
      expect(renameSync).not.toHaveBeenCalled();
      expect(rmSync).not.toHaveBeenCalled();
      expect(mkdtempSync).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      db.exec('DROP TRIGGER wp10a3b_fail_delete');
      expect(f.onDisk('wip/later.png')).toBe(true);
      expectUntouched(f);
    });

    it('documents the A → B → A limit: a row returned to the reviewed path and source is the reviewed asset', async () => {
      const f = await createProject();
      const review = await renderedReview(f);
      await postNative(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'b.png' }).expect(302);
      await postNative(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'hero.png' }).expect(302);
      expect(await renderedReview(f)).toBe(review);
    });
  });
});
