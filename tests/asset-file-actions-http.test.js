import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { AssetActionError } from '../src/services/asset-action-service.js';
import { assetReviewToken } from '../src/services/asset-delete-review.js';
import { authenticate, AUTH_CONFIG } from './helpers/auth.js';

// WP10A3-A: the existing single-asset Rename and Move routes answer the Edit
// Asset dialog's enhanced submission (Accept: application/json) as JSON, with
// the real asset action service, repositories, filesystem and rules, while the
// native form contract (redirects and re-rendered viewer pages) stays as it was.

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('asset Rename and Move — enhanced JSON', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let app;
  let agent;
  let csrfToken;
  let fixtureCount = 0;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-file-actions-http-'));
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const previewRoot = path.join(tmpDir, 'previews');
    fs.mkdirSync(previewRoot, { recursive: true });
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, { authConfig: AUTH_CONFIG });
    ({ agent, csrfToken } = await authenticate(app));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { closeDatabase(db); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createProject() {
    fixtureCount += 1;
    const project = app.locals.projectService.create({ title: `File Actions ${fixtureCount}`, status: 'tbd' });
    const categories = app.locals.projectAssetCategoryService;
    const ensure = (displayName, directorySlug) => categories.list(project.id).find((c) => c.directory_slug === directorySlug)
      || categories.add(project.id, { displayName, directorySlug });
    const wip = ensure('WIP', 'wip');
    const renders = ensure('Renders', 'renders');
    const directory = path.join(projectsRoot, project.project_dir);
    for (const slug of ['wip', 'renders']) fs.mkdirSync(path.join(directory, slug), { recursive: true });
    for (const filename of ['hero.png', 'other.png']) {
      await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
        .png().toFile(path.join(directory, 'wip', filename));
    }
    app.locals.assetScanner.scanProjectAssets(project.id);
    const assetId = (filename) => db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?')
      .get(project.id, filename).id;
    return {
      projectId: project.id,
      directory,
      wipId: wip.id,
      rendersId: renders.id,
      hero: assetId('hero.png'),
      other: assetId('other.png'),
      onDisk: (relative) => fs.existsSync(path.join(directory, ...relative.split('/'))),
    };
  }

  const assetRow = (id) => db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  // F2B: the viewer Rename and Move forms carry the reviewed state of the asset
  // they show. These tests submit from a page showing the asset as it is when
  // they send (an absent row gets a well-formed token, so the route's
  // not-found answers are still exercised); the F2B tests below send an
  // earlier review, or none, explicitly.
  const PLACEHOLDER_REVIEW = `v1.${'A'.repeat(43)}`;
  const reviewed = (route, body) => {
    const match = /\/assets\/(\d+)\/(rename|move)$/.exec(route);
    if (!match || !body || Object.hasOwn(body, 'assetReview') || (match[2] === 'rename' && body.origin === 'assets')) return body;
    const row = assetRow(Number(match[1]));
    return { ...body, assetReview: row ? assetReviewToken(row) : PLACEHOLDER_REVIEW };
  };
  const postJson = (route, body) => agent.post(route).set('Accept', 'application/json').type('form').send(reviewed(route, body));
  const postNative = (route, body) => agent.post(route).type('form').send(reviewed(route, body));
  const tagRows = () => db.prepare('SELECT * FROM asset_tags ORDER BY asset_id, tag_id').all();
  const projectPrimary = (projectId) => app.locals.projectPrimaryImageService.getPrimaryImage(projectId)?.id ?? null;
  const archive = (projectId) => agent.post(`/projects/${projectId}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);
  const renameRoute = (f, id = f.hero) => `/projects/${f.projectId}/assets/${id}/rename`;
  const moveRoute = (f, id = f.hero) => `/projects/${f.projectId}/assets/${id}/move`;
  const expectNoLeak = (body) => {
    const text = JSON.stringify(body);
    expect(text).not.toContain(tmpDir);
    expect(text).not.toMatch(/[A-Za-z]:\\\\|\/tmp\/|stack/i);
  };

  describe('Rename', () => {
    it('1-3. renames with one service call, keeps the complete filename and answers with the saved record', async () => {
      const f = await createProject();
      const rename = vi.spyOn(app.locals.assetActionService, 'renameAsset');
      const basename = vi.spyOn(app.locals.assetActionService, 'renameAssetBasename');
      const tagsBefore = tagRows();

      const response = await postJson(renameRoute(f), {
        _csrf: csrfToken, origin: 'viewer', filename: 'cover-final.png', category: String(f.wipId), search: 'hero',
      }).expect(200);

      expect(response.body).toEqual({
        status: 'success',
        outcome: 'committed',
        action: 'asset-renamed',
        message: 'The file was renamed.',
        projectId: f.projectId,
        assetId: f.hero,
        origin: 'viewer',
        asset: {
          id: f.hero, filename: 'cover-final.png', extension: 'png', categoryId: f.wipId, destinationCategory: String(f.wipId),
        },
        viewerUrl: expect.stringMatching(new RegExp(`^/projects/${f.projectId}/assets/${f.hero}\\?`)),
        refreshRequired: true,
      });
      expect(new URL(response.body.viewerUrl, 'http://x').searchParams.get('search')).toBe('hero');
      // F2B: the viewer's reviewed state reaches the service, which checks it under the lock.
      expect(rename).toHaveBeenCalledExactlyOnceWith(f.projectId, f.hero, 'cover-final.png', { reviewed: expect.stringMatching(/^v1\.[A-Za-z0-9_-]{43}$/) });
      expect(basename).not.toHaveBeenCalled();
      const row = assetRow(f.hero);
      expect(row.filename).toBe('cover-final.png');
      expect(row.relative_path).toBe('wip/cover-final.png');
      expect(f.onDisk('wip/cover-final.png')).toBe(true);
      expect(f.onDisk('wip/hero.png')).toBe(false);
      expect(tagRows()).toEqual(tagsBefore);
      expect(projectPrimary(f.projectId)).toBeNull();
    });

    it('2. sends the viewer filename to the service as submitted: a changed extension is the user’s, not reconstructed', async () => {
      const f = await createProject();
      const response = await postJson(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'hero-copy.jpeg' }).expect(200);
      expect(response.body.asset).toMatchObject({ filename: 'hero-copy.jpeg', extension: 'jpeg' });
      expect(assetRow(f.hero).relative_path).toBe('wip/hero-copy.jpeg');
      // The browser-origin basename contract is unchanged: its extension is kept.
      const basename = await postJson(renameRoute(f, f.other), { _csrf: csrfToken, origin: 'assets', filename: 'other-renamed' }).expect(200);
      expect(basename.body).toMatchObject({ origin: 'assets', asset: { filename: 'other-renamed.png' } });
    });

    it('4-5. refuses a collision, an unchanged name and invalid filenames as JSON with nothing changed', async () => {
      const f = await createProject();
      const before = assetRow(f.hero);
      const cases = [
        ['other.png', 409, 'DESTINATION_CONFLICT', 'Destination already exists.'],
        ['hero.png', 409, 'UNCHANGED_LOCATION', 'That filename is unchanged.'],
        ['HERO.png', 409, 'CASE_ONLY_RENAME_UNSUPPORTED', 'Case-only renames are not supported.'],
        ['../escape.png', 422, 'INVALID_FILENAME', 'Enter a valid filename.'],
        ['', 422, 'INVALID_FILENAME', 'Enter a valid filename.'],
      ];
      for (const [filename, status, code, message] of cases) {
        const response = await postJson(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename }).expect(status);
        expect(response.body).toEqual({ status: 'error', code, outcome: 'refused', message });
        expectNoLeak(response.body);
      }
      const origin = await postJson(renameRoute(f), { _csrf: csrfToken, origin: 'nowhere', filename: 'x.png' }).expect(422);
      expect(origin.body).toMatchObject({ code: 'INVALID_ORIGIN', outcome: 'refused' });
      expect(assetRow(f.hero)).toEqual(before);
      expect(f.onDisk('wip/hero.png')).toBe(true);
    });

    it('6-7. refuses missing, malformed and cross-project identities as JSON 404', async () => {
      const f = await createProject();
      const g = await createProject();
      const cases = [
        [`/projects/not-a-project/assets/${f.hero}/rename`, 'PROJECT_NOT_FOUND'],
        [`/projects/999999/assets/${f.hero}/rename`, 'PROJECT_NOT_FOUND'],
        [`/projects/${f.projectId}/assets/not-an-asset/rename`, 'ASSET_NOT_FOUND'],
        [`/projects/${f.projectId}/assets/999999/rename`, 'ASSET_NOT_FOUND'],
        [`/projects/${f.projectId}/assets/${g.hero}/rename`, 'ASSET_NOT_FOUND'],
      ];
      for (const [route, code] of cases) {
        const response = await postJson(route, { _csrf: csrfToken, origin: 'viewer', filename: 'moved.png' }).expect(404);
        expect(response.body).toMatchObject({ status: 'error', code, outcome: 'refused' });
      }
      expect(assetRow(g.hero).filename).toBe('hero.png');
    });

    it('8. refuses an archived project and a missing-at-last-scan asset', async () => {
      const f = await createProject();
      fs.rmSync(path.join(f.directory, 'wip', 'other.png'));
      app.locals.assetScanner.scanProjectAssets(f.projectId);
      const missing = await postJson(renameRoute(f, f.other), { _csrf: csrfToken, origin: 'viewer', filename: 'x.png' }).expect(409);
      expect(missing.body).toMatchObject({ code: 'ASSET_MISSING', outcome: 'refused' });
      await archive(f.projectId);
      const archived = await postJson(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'x.png' }).expect(409);
      expect(archived.body).toEqual({
        status: 'error', code: 'PROJECT_ARCHIVED', outcome: 'refused', message: 'This project is archived and read-only.',
      });
      expect(assetRow(f.hero).filename).toBe('hero.png');
    });

    it('9-10. reports failed, recovery-required and unknown outcomes without leaking detail', async () => {
      const f = await createProject();
      const spy = vi.spyOn(app.locals.assetActionService, 'renameAsset');
      spy.mockImplementationOnce(() => { throw new AssetActionError(`rename ${tmpDir} failed`, { code: 'FILESYSTEM_OPERATION_FAILED' }); });
      const failed = await postJson(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'x.png' }).expect(500);
      expect(failed.body).toEqual({
        status: 'error', code: 'FILESYSTEM_OPERATION_FAILED', outcome: 'failed', message: 'The operation could not be completed. Please try again.',
      });

      spy.mockImplementationOnce(() => { throw new AssetActionError('moved', { code: 'RECOVERY_REQUIRED' }); });
      const recovery = await postJson(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'x.png' }).expect(500);
      expect(recovery.body).toMatchObject({ code: 'RECOVERY_REQUIRED', outcome: 'recovery-required', recoveryRequired: true });
      expect(recovery.body.message).toContain('Inspect the project folder');

      spy.mockImplementationOnce(() => { throw new Error(`SQLITE at ${tmpDir}`); });
      const unknown = await postJson(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'x.png' }).expect(500);
      expect(unknown.body).toEqual({
        status: 'error', code: 'ASSET_ACTION_FAILED', outcome: 'unknown', message: 'The rename could not be confirmed.',
      });
      [failed, recovery, unknown].forEach((response) => expectNoLeak(response.body));
    });

    it('10. a real post-move record failure reports recovery-required, never a clean refusal', async () => {
      const f = await createProject();
      // The record update fails after the real file rename succeeded.
      db.exec("CREATE TRIGGER wp10a3_block_update BEFORE UPDATE ON assets BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
      const response = await postJson(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'renamed.png' });
      db.exec('DROP TRIGGER wp10a3_block_update');
      expect(response.status).toBe(500);
      expectNoLeak(response.body);
      expect(response.body).toMatchObject({ outcome: 'recovery-required', code: 'RECOVERY_REQUIRED' });
      expect(f.onDisk('wip/renamed.png')).toBe(true);
      expect(assetRow(f.hero).filename).toBe('hero.png');
    });

    it('11. requires CSRF and authentication', async () => {
      const f = await createProject();
      const csrf = await postJson(renameRoute(f), { origin: 'viewer', filename: 'x.png' }).expect(403);
      expect(csrf.body).toMatchObject({ status: 'error' });
      const anonymous = await request(app).post(renameRoute(f)).set('Accept', 'application/json').type('form')
        .send({ _csrf: csrfToken, origin: 'viewer', filename: 'x.png' });
      expect([401, 403]).toContain(anonymous.status);
      expect(assetRow(f.hero).filename).toBe('hero.png');
    });

    it('12. keeps the native redirect and failure render', async () => {
      const f = await createProject();
      const ok = await postNative(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'native.png', search: 'n' }).expect(302);
      const location = new URL(ok.headers.location, 'http://localhost');
      expect(location.pathname).toBe(`/projects/${f.projectId}/assets/${f.hero}`);
      expect(location.searchParams.get('notice')).toBe('asset-renamed');
      expect(location.searchParams.get('edit')).toBe('1');
      const refused = await postNative(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'other.png' }).expect(409);
      expect(refused.text).toContain('Destination already exists.');
      expect(refused.text).toContain('value="other.png"');
      await postNative(`/projects/${f.projectId}/assets/999999/rename`, { _csrf: csrfToken, origin: 'viewer', filename: 'x.png' }).expect(404);
    });
  });

  describe('Move', () => {
    it('13-15. moves with one service call to the canonical destination and answers with the saved record', async () => {
      const f = await createProject();
      const move = vi.spyOn(app.locals.assetActionService, 'moveAsset');
      const response = await postJson(moveRoute(f), {
        _csrf: csrfToken, destinationCategory: String(f.rendersId), category: String(f.wipId),
      }).expect(200);
      expect(response.body).toMatchObject({
        status: 'success', outcome: 'committed', action: 'asset-moved', message: 'The file was moved.',
        projectId: f.projectId, assetId: f.hero,
        asset: { id: f.hero, filename: 'hero.png', categoryId: f.rendersId, destinationCategory: String(f.rendersId) },
        refreshRequired: true,
      });
      expect(response.body).not.toHaveProperty('origin');
      // The filter context is kept as submitted: the asset may now be outside it.
      expect(new URL(response.body.viewerUrl, 'http://x').searchParams.get('category')).toBe(String(f.wipId));
      expect(move).toHaveBeenCalledExactlyOnceWith(f.projectId, f.hero, f.rendersId, { reviewed: expect.stringMatching(/^v1\.[A-Za-z0-9_-]{43}$/) });
      expect(assetRow(f.hero)).toMatchObject({ id: f.hero, project_id: f.projectId, category_id: f.rendersId, relative_path: 'renders/hero.png' });
      expect(f.onDisk('renders/hero.png')).toBe(true);
      expect(f.onDisk('wip/hero.png')).toBe(false);

      const root = await postJson(moveRoute(f), { _csrf: csrfToken, destinationCategory: 'uncategorized' }).expect(200);
      expect(root.body.asset).toMatchObject({ categoryId: null, destinationCategory: 'uncategorized' });
      expect(assetRow(f.hero).relative_path).toBe('hero.png');
    });

    it('16. refuses malformed, foreign, disabled and unchanged destinations', async () => {
      const f = await createProject();
      const g = await createProject();
      app.locals.projectAssetCategoryService.setEnabled(f.projectId, f.rendersId, false);
      const before = assetRow(f.hero);
      const cases = [
        ['renders', 422, 'DESTINATION_CATEGORY_MALFORMED'],
        ['0', 422, 'DESTINATION_CATEGORY_MALFORMED'],
        [String(g.rendersId), 409, 'DESTINATION_CATEGORY_INVALID'],
        [String(f.rendersId), 409, 'DESTINATION_CATEGORY_DISABLED'],
        [String(f.wipId), 409, 'UNCHANGED_LOCATION'],
      ];
      for (const [destinationCategory, status, code] of cases) {
        const response = await postJson(moveRoute(f), { _csrf: csrfToken, destinationCategory }).expect(status);
        expect(response.body).toMatchObject({ status: 'error', code, outcome: 'refused' });
        expectNoLeak(response.body);
      }
      expect(assetRow(f.hero)).toEqual(before);
    });

    it('17. refuses a destination collision on disk', async () => {
      const f = await createProject();
      fs.copyFileSync(path.join(f.directory, 'wip', 'hero.png'), path.join(f.directory, 'hero.png'));
      const response = await postJson(moveRoute(f), { _csrf: csrfToken, destinationCategory: 'uncategorized' }).expect(409);
      expect(response.body).toMatchObject({ code: 'DESTINATION_CONFLICT', outcome: 'refused', message: 'Destination already exists.' });
      expect(assetRow(f.hero).relative_path).toBe('wip/hero.png');
    });

    it('18-20. refuses archived, missing and cross-project identities', async () => {
      const f = await createProject();
      const g = await createProject();
      const foreign = await postJson(moveRoute(f, g.hero), { _csrf: csrfToken, destinationCategory: 'uncategorized' }).expect(404);
      expect(foreign.body).toMatchObject({ code: 'ASSET_NOT_FOUND', outcome: 'refused' });
      const project = await postJson(`/projects/999999/assets/${f.hero}/move`, { _csrf: csrfToken, destinationCategory: 'uncategorized' }).expect(404);
      expect(project.body).toMatchObject({ code: 'PROJECT_NOT_FOUND' });
      const asset = await postJson(`/projects/${f.projectId}/assets/abc/move`, { _csrf: csrfToken, destinationCategory: 'uncategorized' }).expect(404);
      expect(asset.body).toMatchObject({ code: 'ASSET_NOT_FOUND' });
      await archive(f.projectId);
      const archived = await postJson(moveRoute(f), { _csrf: csrfToken, destinationCategory: 'uncategorized' }).expect(409);
      expect(archived.body).toMatchObject({ code: 'PROJECT_ARCHIVED', outcome: 'refused' });
      expect(assetRow(g.hero).relative_path).toBe('wip/hero.png');
    });

    it('21-22. reports busy, failed and recovery-required outcomes truthfully', async () => {
      const f = await createProject();
      const spy = vi.spyOn(app.locals.assetActionService, 'moveAsset');
      spy.mockImplementationOnce(() => { throw new AssetActionError('busy', { code: 'PROJECT_BUSY' }); });
      const busy = await postJson(moveRoute(f), { _csrf: csrfToken, destinationCategory: 'uncategorized' }).expect(409);
      expect(busy.body).toMatchObject({ code: 'PROJECT_BUSY', outcome: 'refused' });
      spy.mockImplementationOnce(() => { throw new AssetActionError('x', { code: 'RECOVERY_REQUIRED' }); });
      const recovery = await postJson(moveRoute(f), { _csrf: csrfToken, destinationCategory: 'uncategorized' }).expect(500);
      expect(recovery.body).toMatchObject({ outcome: 'recovery-required', recoveryRequired: true });
      spy.mockImplementationOnce(() => { throw new TypeError('boom'); });
      const unknown = await postJson(moveRoute(f), { _csrf: csrfToken, destinationCategory: 'uncategorized' }).expect(500);
      expect(unknown.body).toEqual({ status: 'error', code: 'ASSET_ACTION_FAILED', outcome: 'unknown', message: 'The move could not be confirmed.' });
    });

    it('23. requires CSRF', async () => {
      const f = await createProject();
      await postJson(moveRoute(f), { destinationCategory: 'uncategorized' }).expect(403);
      expect(assetRow(f.hero).relative_path).toBe('wip/hero.png');
    });

    it('24. keeps the native redirect and failure render', async () => {
      const f = await createProject();
      const ok = await postNative(moveRoute(f), { _csrf: csrfToken, destinationCategory: String(f.rendersId) }).expect(302);
      const location = new URL(ok.headers.location, 'http://localhost');
      expect(location.pathname).toBe(`/projects/${f.projectId}/assets/${f.hero}`);
      expect(location.searchParams.get('notice')).toBe('asset-moved');
      const refused = await postNative(moveRoute(f), { _csrf: csrfToken, destinationCategory: 'bogus' }).expect(422);
      expect(refused.text).toContain('Choose a valid destination.');
    });
  });

  it('renders the file regions the page refresh reconciles against', async () => {
    const f = await createProject();
    const page = await agent.get(`/projects/${f.projectId}/assets/${f.hero}?category=${f.rendersId}`).expect(200);
    expect(page.text).toContain('data-asset-viewer-region="file-summary"');
    expect(page.text).toContain('data-asset-filename="hero.png"');
    expect(page.text).toContain(`data-asset-destination="${f.wipId}"`);
    expect(page.text).toContain('data-asset-viewer-region="file-details"');
    expect(page.text).toMatch(/data-asset-viewer-region="filter-notice" data-asset-viewer-filtered-out="true"/);
    expect((page.text.match(/aria-live/g) || []).length).toBe(1);
  });
  // ─── F2B: reviewed-state precondition for viewer Rename and Move ──────────
  // A Rename or Move names the asset state the page showed (assetReview). The
  // service compares it with the row it loads under the project lock, before
  // any path is resolved or file touched: a request delayed past a newer change
  // (another tab, a reload) is refused as stale and changes nothing.
  describe('F2B. reviewed-state precondition', () => {
    const REVIEW_INPUT = /<input type="hidden" name="assetReview" value="([^"]*)" data-asset-review>/g;
    const STALE_RENAME = 'This asset was renamed, moved or replaced after this change was reviewed, so it was not renamed. Review the asset as it is now and submit the change again if you still want to.';
    const STALE_MOVE = 'This asset was renamed, moved or replaced after this change was reviewed, so it was not moved. Review the asset as it is now and submit the change again if you still want to.';
    const INVALID_RENAME = 'This request does not identify the asset version you reviewed, so the file was not renamed. Reload the page and try again.';
    const INVALID_MOVE = 'This request does not identify the asset version you reviewed, so the file was not moved. Reload the page and try again.';
    // Sends exactly the given body (no reviewed state is added for it).
    const rawJson = (route, body) => agent.post(route).set('Accept', 'application/json').type('form').send(body);
    const rawNative = (route, body) => agent.post(route).type('form').send(body);
    const reviewOf = (id) => assetReviewToken(assetRow(id));
    const fileLogs = (projectId) => db.prepare(
      "SELECT event FROM application_logs WHERE project_id = ? AND event IN ('asset.renamed', 'asset.moved') ORDER BY id",
    ).all(projectId).map((row) => row.event);
    const tree = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
      ? tree(path.join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`])).sort();
    // The reviewed state the Asset detail page renders into both file forms.
    async function renderedReview(f, id = f.hero) {
      const page = await agent.get(`/projects/${f.projectId}/assets/${id}`).expect(200);
      const values = [...page.text.matchAll(REVIEW_INPUT)].map((match) => match[1]);
      expect(values).toHaveLength(2);
      expect(values[0]).toBe(values[1]);
      expect(values[0]).toBe(reviewOf(id));
      return values[0];
    }
    // Every filesystem rename the service attempts while `run` runs.
    async function renamesDuring(run) {
      const spy = vi.spyOn(fs, 'renameSync');
      try {
        await run();
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    }

    it('H1. a Rename reviewed before a newer Rename is refused as stale; the newer row and file survive', async () => {
      const f = await createProject();
      const reviewA = await renderedReview(f);
      // Tab B: the newer Rename, from the same reviewed state, commits.
      await rawJson(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'latest.png', assetReview: reviewA }).expect(200);
      const latest = assetRow(f.hero);
      const disk = tree(f.directory);
      const logs = fileLogs(f.projectId);
      expect(latest.relative_path).toBe('wip/latest.png');
      expect(logs).toEqual(['asset.renamed']);

      // Tab A's older Rename finally reaches the service.
      let stale;
      const renames = await renamesDuring(async () => {
        stale = await rawJson(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'earlier.png', assetReview: reviewA }).expect(409);
      });
      expect(stale.body).toEqual({ status: 'error', code: 'ASSET_REVIEW_STALE', outcome: 'refused', message: STALE_RENAME });
      expectNoLeak(stale.body);
      expect(renames).toBe(0);
      expect(assetRow(f.hero)).toEqual(latest);
      expect(f.onDisk('wip/latest.png')).toBe(true);
      expect(f.onDisk('wip/earlier.png')).toBe(false);
      expect(tree(f.directory)).toEqual(disk);
      expect(fileLogs(f.projectId)).toEqual(logs);
    });

    it('H2. a Move reviewed before a newer Move is refused as stale; the moved row, category and file survive', async () => {
      const f = await createProject();
      const reviewA = await renderedReview(f);
      await rawJson(moveRoute(f), { _csrf: csrfToken, destinationCategory: String(f.rendersId), assetReview: reviewA }).expect(200);
      const moved = assetRow(f.hero);
      const disk = tree(f.directory);
      expect(moved).toMatchObject({ category_id: f.rendersId, relative_path: 'renders/hero.png' });

      let staleMove;
      let staleRename;
      const renames = await renamesDuring(async () => {
        staleMove = await rawJson(moveRoute(f), { _csrf: csrfToken, destinationCategory: 'uncategorized', assetReview: reviewA }).expect(409);
        // A Rename reviewed before the Move is just as stale.
        staleRename = await rawJson(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'earlier.png', assetReview: reviewA }).expect(409);
      });
      expect(staleMove.body).toEqual({ status: 'error', code: 'ASSET_REVIEW_STALE', outcome: 'refused', message: STALE_MOVE });
      expect(staleRename.body).toMatchObject({ code: 'ASSET_REVIEW_STALE', outcome: 'refused', message: STALE_RENAME });
      expect(renames).toBe(0);
      expect(assetRow(f.hero)).toEqual(moved);
      expect(f.onDisk('renders/hero.png')).toBe(true);
      expect(f.onDisk('hero.png')).toBe(false);
      expect(tree(f.directory)).toEqual(disk);
      expect(fileLogs(f.projectId)).toEqual(['asset.moved']);
    });

    it('H3. a fresh review after a Rename or Move lets the next intentional change run once', async () => {
      const f = await createProject();
      // Rename → Move → Move → Rename → Rename, each with the page's current review.
      const steps = [
        [renameRoute(f), { origin: 'viewer', filename: 'step-1.png' }, 'wip/step-1.png'],
        [moveRoute(f), { destinationCategory: String(f.rendersId) }, 'renders/step-1.png'],
        [moveRoute(f), { destinationCategory: 'uncategorized' }, 'step-1.png'],
        [renameRoute(f), { origin: 'viewer', filename: 'step-2.png' }, 'step-2.png'],
        [renameRoute(f), { origin: 'viewer', filename: 'step-3.png' }, 'step-3.png'],
        [moveRoute(f), { destinationCategory: String(f.wipId) }, 'wip/step-3.png'],
      ];
      const seen = new Set();
      for (const [route, fields, expected] of steps) {
        const review = await renderedReview(f);
        expect(seen.has(review)).toBe(false);
        seen.add(review);
        const response = await rawJson(route, { _csrf: csrfToken, ...fields, assetReview: review }).expect(200);
        expect(response.body.outcome).toBe('committed');
        expect(assetRow(f.hero).relative_path).toBe(expected);
        expect(f.onDisk(expected)).toBe(true);
      }
      expect(fileLogs(f.projectId)).toEqual([
        'asset.renamed', 'asset.moved', 'asset.moved', 'asset.renamed', 'asset.renamed', 'asset.moved',
      ]);
    });

    it('H4. refuses a missing, malformed or repeated review (422) and a foreign, stale or tampered one (409) with no file step', async () => {
      const f = await createProject();
      const g = await createProject();
      const review = await renderedReview(f);
      const row = assetRow(f.hero);
      const before = { row, disk: tree(f.directory), logs: fileLogs(f.projectId) };
      const flip = (token) => `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
      const invalid = [
        {},
        { assetReview: '' },
        { assetReview: 'v1.short' },
        { assetReview: `v2.${review.slice(3)}` },
        { assetReview: `${review} ` },
        { 'assetReview[x]': review },
      ];
      const mismatched = [
        assetReviewToken({ ...row, project_id: g.projectId }), // another project
        reviewOf(f.other), // another asset
        assetReviewToken(assetRow(g.hero)), // another project's asset
        assetReviewToken({ ...row, relative_path: 'renders/hero.png' }), // a stale path
        assetReviewToken({ ...row, category_id: f.rendersId }), // a stale category
        flip(review), // tampered
      ];
      const renames = await renamesDuring(async () => {
        for (const [route, fields, invalidMessage, staleMessage] of [
          [renameRoute(f), { origin: 'viewer', filename: 'x.png' }, INVALID_RENAME, STALE_RENAME],
          [moveRoute(f), { destinationCategory: String(f.rendersId) }, INVALID_MOVE, STALE_MOVE],
        ]) {
          for (const extra of invalid) {
            const response = await rawJson(route, { _csrf: csrfToken, ...fields, ...extra }).expect(422);
            expect(response.body).toEqual({ status: 'error', code: 'ASSET_REVIEW_INVALID', outcome: 'refused', message: invalidMessage });
          }
          const fieldText = Object.entries(fields).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
          const repeated = await agent.post(route).set('Accept', 'application/json').type('form')
            .send(`_csrf=${encodeURIComponent(csrfToken)}&${fieldText}&assetReview=${review}&assetReview=${review}`).expect(422);
          expect(repeated.body.code).toBe('ASSET_REVIEW_INVALID');
          for (const assetReview of mismatched) {
            const response = await rawJson(route, { _csrf: csrfToken, ...fields, assetReview }).expect(409);
            expect(response.body).toEqual({ status: 'error', code: 'ASSET_REVIEW_STALE', outcome: 'refused', message: staleMessage });
          }
        }
        // Native forms fail closed the same way.
        const native = await rawNative(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'x.png' }).expect(422);
        expect(native.text).toContain(INVALID_RENAME);
        const nativeMove = await rawNative(moveRoute(f), { _csrf: csrfToken, destinationCategory: 'uncategorized' }).expect(422);
        expect(nativeMove.text).toContain(INVALID_MOVE);
      });
      expect(renames).toBe(0);
      expect(assetRow(f.hero)).toEqual(before.row);
      expect(tree(f.directory)).toEqual(before.disk);
      expect(fileLogs(f.projectId)).toEqual(before.logs);
      // CSRF still comes first: a valid review never stands in for it.
      await rawJson(renameRoute(f), { origin: 'viewer', filename: 'x.png', assetReview: review }).expect(403);
      // The identity checks keep their answers: a valid-looking review for an
      // unknown asset is still not found.
      await rawJson(`/projects/${f.projectId}/assets/999999/rename`, { _csrf: csrfToken, origin: 'viewer', filename: 'x.png', assetReview: review }).expect(404);
      expect(assetRow(f.hero)).toEqual(before.row);
    });

    it('H5. native: the rendered forms rename and move with their review; a stale one re-renders with the current review', async () => {
      const f = await createProject();
      const first = await renderedReview(f);
      const ok = await rawNative(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'native.png', assetReview: first, search: 'n' }).expect(302);
      expect(new URL(ok.headers.location, 'http://x').searchParams.get('notice')).toBe('asset-renamed');
      expect(assetRow(f.hero).relative_path).toBe('wip/native.png');

      const staleRename = await rawNative(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'earlier.png', assetReview: first }).expect(409);
      expect(staleRename.text).toContain(STALE_RENAME);
      // The entry is kept, and the re-rendered page carries the current review.
      expect(staleRename.text).toContain('value="earlier.png"');
      const rerendered = [...staleRename.text.matchAll(REVIEW_INPUT)].map((match) => match[1]);
      expect(rerendered).toEqual([reviewOf(f.hero), reviewOf(f.hero)]);
      expect(rerendered[0]).not.toBe(first);
      expect(assetRow(f.hero).relative_path).toBe('wip/native.png');

      const second = await renderedReview(f);
      const moved = await rawNative(moveRoute(f), { _csrf: csrfToken, destinationCategory: String(f.rendersId), assetReview: second }).expect(302);
      expect(new URL(moved.headers.location, 'http://x').searchParams.get('notice')).toBe('asset-moved');
      const staleMove = await rawNative(moveRoute(f), { _csrf: csrfToken, destinationCategory: 'uncategorized', assetReview: second }).expect(409);
      expect(staleMove.text).toContain(STALE_MOVE);
      expect(assetRow(f.hero).relative_path).toBe('renders/native.png');
      expect(f.onDisk('native.png')).toBe(false);

      // Resubmitting from the re-rendered page is a new, intentional change.
      const current = [...staleMove.text.matchAll(REVIEW_INPUT)][0][1];
      await rawNative(moveRoute(f), { _csrf: csrfToken, destinationCategory: 'uncategorized', assetReview: current }).expect(302);
      expect(assetRow(f.hero).relative_path).toBe('native.png');
    });

    it('H6. Project Assets basename Rename, bulk Move and direct service callers keep their contracts', async () => {
      const f = await createProject();
      const basename = vi.spyOn(app.locals.assetActionService, 'renameAssetBasename');
      const renamed = await rawJson(renameRoute(f), { _csrf: csrfToken, origin: 'assets', filename: 'browser-name' }).expect(200);
      expect(renamed.body).toMatchObject({ origin: 'assets', asset: { filename: 'browser-name.png' } });
      expect(basename).toHaveBeenCalledExactlyOnceWith(f.projectId, f.hero, 'browser-name');
      await rawNative(renameRoute(f), { _csrf: csrfToken, origin: 'assets', filename: 'browser-native' }).expect(302);
      expect(assetRow(f.hero).relative_path).toBe('wip/browser-native.png');

      const bulk = vi.spyOn(app.locals.assetActionService, 'moveAssets');
      await rawNative(`/projects/${f.projectId}/assets/move-selected`, {
        _csrf: csrfToken, selectedAssetIds: String(f.other), destinationCategory: String(f.rendersId),
      }).expect(302);
      expect(bulk).toHaveBeenCalledExactlyOnceWith(f.projectId, [f.other], f.rendersId);
      expect(assetRow(f.other).relative_path).toBe('renders/other.png');

      // Without the option the service keeps its established contract; an
      // option that is present must be a valid token.
      const service = app.locals.assetActionService;
      expect(service.renameAsset(f.projectId, f.hero, 'service-name.png').relative_path).toBe('wip/service-name.png');
      expect(service.moveAsset(f.projectId, f.hero, f.rendersId).relative_path).toBe('renders/service-name.png');
      expect(() => service.renameAsset(f.projectId, f.hero, 'x.png', { reviewed: undefined }))
        .toThrow(expect.objectContaining({ code: 'ASSET_REVIEW_INVALID' }));
      expect(() => service.moveAsset(f.projectId, f.hero, f.wipId, { reviewed: 'nope' }))
        .toThrow(expect.objectContaining({ code: 'ASSET_REVIEW_INVALID' }));
      expect(assetRow(f.hero).relative_path).toBe('renders/service-name.png');
    });

    it('H7. a source replaced since the review makes it stale; a fresh review after the scan renames', async () => {
      const f = await createProject();
      const review = await renderedReview(f);
      const generation = assetRow(f.hero).source_generation ?? 0;
      // A real replacement: new bytes at the same path, picked up by a scan.
      await sharp({ create: { width: 16, height: 12, channels: 3, background: { r: 200, g: 20, b: 30 } } })
        .png().toFile(path.join(f.directory, 'wip', 'hero-new.png'));
      fs.rmSync(path.join(f.directory, 'wip', 'hero.png'));
      fs.renameSync(path.join(f.directory, 'wip', 'hero-new.png'), path.join(f.directory, 'wip', 'hero.png'));
      const future = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(f.directory, 'wip', 'hero.png'), future, future);
      app.locals.assetScanner.scanProjectAssets(f.projectId);
      const replaced = assetRow(f.hero);
      expect(replaced.relative_path).toBe('wip/hero.png');
      expect(replaced.source_generation).toBeGreaterThan(generation);

      const renames = await renamesDuring(async () => {
        const stale = await rawJson(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'old-bytes.png', assetReview: review }).expect(409);
        expect(stale.body.code).toBe('ASSET_REVIEW_STALE');
        const staleMove = await rawJson(moveRoute(f), { _csrf: csrfToken, destinationCategory: 'uncategorized', assetReview: review }).expect(409);
        expect(staleMove.body.code).toBe('ASSET_REVIEW_STALE');
      });
      expect(renames).toBe(0);
      expect(assetRow(f.hero)).toEqual(replaced);

      const fresh = await renderedReview(f);
      expect(fresh).not.toBe(review);
      await rawJson(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'new-bytes.png', assetReview: fresh }).expect(200);
      expect(assetRow(f.hero).relative_path).toBe('wip/new-bytes.png');
    });

    it('H8. a current review keeps the failed and recovery-required classifications; a stale one is refused before any file step', async () => {
      const f = await createProject();
      const review = await renderedReview(f);
      // A real rename failure on disk, with a current review: nothing moved.
      const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); });
      const failed = await rawJson(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'x.png', assetReview: review }).expect(500);
      spy.mockRestore();
      expect(failed.body).toMatchObject({ code: 'FILESYSTEM_OPERATION_FAILED', outcome: 'failed' });
      expect(assetRow(f.hero).relative_path).toBe('wip/hero.png');

      // A real post-move record failure, with a current review: recovery-required.
      db.exec("CREATE TRIGGER f2b_block_update BEFORE UPDATE ON assets BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
      try {
        const recovery = await rawJson(moveRoute(f), { _csrf: csrfToken, destinationCategory: String(f.rendersId), assetReview: review });
        expect(recovery.status).toBe(500);
        expect(recovery.body).toMatchObject({ code: 'RECOVERY_REQUIRED', outcome: 'recovery-required', recoveryRequired: true });
        expectNoLeak(recovery.body);
        expect(f.onDisk('renders/hero.png')).toBe(true);
        expect(assetRow(f.hero).relative_path).toBe('wip/hero.png');

        // The same blocked update with a stale review is never reached: the
        // refusal is a clean 409, not a recovery or filesystem failure.
        const disk = tree(f.directory);
        let stale;
        const renames = await renamesDuring(async () => {
          stale = await rawJson(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'y.png', assetReview: assetReviewToken({ ...assetRow(f.hero), relative_path: 'wip/old.png' }) });
        });
        expect(stale.status).toBe(409);
        expect(stale.body).toMatchObject({ code: 'ASSET_REVIEW_STALE', outcome: 'refused' });
        expect(stale.body).not.toHaveProperty('recoveryRequired');
        expect(renames).toBe(0);
        expect(tree(f.directory)).toEqual(disk);
      } finally {
        db.exec('DROP TRIGGER IF EXISTS f2b_block_update');
      }
      expect(fileLogs(f.projectId)).toEqual([]);
    });

    it('H9. a stale request writes no activity and changes no related rows', async () => {
      const f = await createProject();
      const review = await renderedReview(f);
      const tagId = db.prepare("INSERT INTO tags (display_name, normalized_name) VALUES ('F2B tag', 'f2b tag') RETURNING id").get().id;
      db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(f.hero, tagId);
      await rawJson(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'latest.png', assetReview: review }).expect(200);
      const snapshot = () => ({
        asset: assetRow(f.hero),
        other: assetRow(f.other),
        tags: tagRows(),
        primary: projectPrimary(f.projectId),
        logs: db.prepare('SELECT id, event FROM application_logs ORDER BY id').all(),
      });
      const before = snapshot();
      await rawJson(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'earlier.png', assetReview: review }).expect(409);
      await rawJson(moveRoute(f), { _csrf: csrfToken, destinationCategory: String(f.rendersId), assetReview: review }).expect(409);
      await rawNative(renameRoute(f), { _csrf: csrfToken, origin: 'viewer', filename: 'earlier.png', assetReview: review }).expect(409);
      await rawNative(moveRoute(f), { _csrf: csrfToken, destinationCategory: String(f.rendersId), assetReview: review }).expect(409);
      expect(snapshot()).toEqual(before);
    });
  });
});
