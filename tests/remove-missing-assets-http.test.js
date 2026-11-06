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

// WP10B: the existing Remove missing assets route answers the Project Assets
// confirmation's enhanced submission (Accept: application/json) as JSON, with
// the real asset action service, repositories, project lock and rules, while
// the native form contract (redirect with counts, controlled errors) stays.
// Every reported count is checked against the database and the disk.

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('Remove missing assets — enhanced JSON', () => {
  let tmpDir;
  let projectsRoot;
  let db;
  let app;
  let agent;
  let csrfToken;
  let coordinator;
  let fixtureCount = 0;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-remove-missing-http-'));
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

  // Files in two categories; `missing` are deleted from disk and a real scan
  // marks their records missing. Nothing but the scanner sets missing status.
  async function createProject({ wip = [], renders = [], missing = [] } = {}) {
    fixtureCount += 1;
    const project = app.locals.projectService.create({ title: `Remove Missing ${fixtureCount}`, status: 'tbd' });
    const categories = app.locals.projectAssetCategoryService;
    const ensure = (slug, name) => categories.list(project.id).find((c) => c.directory_slug === slug)
      || categories.add(project.id, { displayName: name, directorySlug: slug });
    const wipCategory = ensure('wip', 'WIP');
    const rendersCategory = ensure('renders', 'Renders');
    const directory = path.join(projectsRoot, project.project_dir);
    const write = async (slug, filename) => {
      fs.mkdirSync(path.join(directory, slug), { recursive: true });
      await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } })
        .png().toFile(path.join(directory, slug, filename));
    };
    for (const filename of wip) await write('wip', filename);
    for (const filename of renders) await write('renders', filename);
    app.locals.assetScanner.scanProjectAssets(project.id);
    for (const relative of missing) fs.rmSync(path.join(directory, ...relative.split('/')));
    if (missing.length > 0) app.locals.assetScanner.scanProjectAssets(project.id);
    const id = (filename) => db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?')
      .get(project.id, filename)?.id;
    return {
      projectId: project.id,
      directory,
      wipId: wipCategory.id,
      rendersId: rendersCategory.id,
      id,
      onDisk: (relative) => fs.existsSync(path.join(directory, ...relative.split('/'))),
    };
  }

  const route = (f) => `/projects/${f.projectId}/assets/remove-missing`;
  const postJson = (f, body = { _csrf: csrfToken }) => agent.post(route(f)).set('Accept', 'application/json').type('form').send(body);
  const postNative = (f, body = { _csrf: csrfToken }) => agent.post(route(f)).type('form').send(body);
  const assetRow = (id) => db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  const assetIds = (projectId) => db.prepare('SELECT id FROM assets WHERE project_id = ? ORDER BY id').all(projectId).map((r) => r.id);
  const missingIds = (projectId) => db.prepare('SELECT id FROM assets WHERE project_id = ? AND is_present = 0 ORDER BY id')
    .all(projectId).map((r) => r.id);
  const insertRelease = (projectId, title, published = false) => db.prepare(`
    INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url, archived_at)
    VALUES (?, ?, '', '', NULL, ?, NULL, NULL) RETURNING id
  `).get(projectId, title, published ? '2026-08-05' : null).id;
  const linkReleaseAsset = (releaseId, assetId) => db.prepare(
    "INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, 'attachment', 0)",
  ).run(releaseId, assetId);
  const releaseAssetIds = (releaseId) => db.prepare('SELECT asset_id FROM release_assets WHERE release_id = ? ORDER BY asset_id')
    .all(releaseId).map((row) => row.asset_id);
  const removalLogs = (projectId) => db.prepare(
    "SELECT context_json FROM application_logs WHERE project_id = ? AND event = 'project.missing_assets.removed' ORDER BY id",
  ).all(projectId).map((row) => JSON.parse(row.context_json));
  const archive = (projectId) => agent.post(`/projects/${projectId}/archive`).type('form').send({ _csrf: csrfToken }).expect(302);
  const expectNoLeak = (body) => {
    const text = JSON.stringify(body);
    expect(text).not.toContain(tmpDir);
    expect(text).not.toMatch(/[A-Za-z]:\\\\|\/tmp\/|stack|injected|SQLITE|\.png/i);
  };

  describe('H1. JSON success', () => {
    it('removes the missing records once, answers with the service\'s own ids and counts, deletes no file', async () => {
      const f = await createProject({ wip: ['a.png', 'b.png', 'keep.png'], renders: ['c.png'], missing: ['wip/a.png', 'wip/b.png', 'renders/c.png'] });
      const removed = [f.id('a.png'), f.id('b.png'), f.id('c.png')].sort((x, y) => x - y);
      const keep = f.id('keep.png');
      const service = vi.spyOn(app.locals.assetActionService, 'removeMissingAssets');
      const before = fs.readdirSync(path.join(f.directory, 'wip')).sort();

      const response = await postJson(f).expect(200);

      expect(service).toHaveBeenCalledTimes(1);
      expect(service).toHaveBeenCalledWith(f.projectId);
      expect({ ...response.body, removedAssetIds: [...response.body.removedAssetIds].sort((x, y) => x - y) }).toEqual({
        status: 'success',
        outcome: 'removed',
        projectId: f.projectId,
        removedCount: 3,
        protectedCount: 0,
        totalMissingCandidates: 3,
        removedAssetIds: removed,
        protectedAssetIds: [],
        message: 'Removed 3 of 3 missing asset records. No files were deleted.',
        refresh: true,
      });
      expect(assetIds(f.projectId)).toEqual([keep]);
      expect(f.onDisk('wip/keep.png')).toBe(true);
      expect(fs.readdirSync(path.join(f.directory, 'wip')).sort()).toEqual(before);
      expect(removalLogs(f.projectId)).toEqual([{ removedCount: 3, protectedCount: 0, missingCandidateCount: 3 }]);
      expectNoLeak(response.body);
    });

    it('removes draft-release membership, tags and primary image of removed records by cascade only', async () => {
      const f = await createProject({ wip: ['gone.png', 'stay.png'], missing: ['wip/gone.png'] });
      const gone = f.id('gone.png');
      const stay = f.id('stay.png');
      const draft = insertRelease(f.projectId, 'Draft');
      linkReleaseAsset(draft, gone);
      linkReleaseAsset(draft, stay);
      const tag = app.locals.tagService.createTag({ name: 'Remove Missing Tag' });
      db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(gone, tag.id);
      db.prepare('INSERT INTO asset_tags (asset_id, tag_id) VALUES (?, ?)').run(stay, tag.id);

      await postJson(f).expect(200);

      expect(assetRow(gone)).toBeUndefined();
      expect(releaseAssetIds(draft)).toEqual([stay]);
      expect(db.prepare('SELECT asset_id FROM asset_tags WHERE tag_id = ?').all(tag.id).map((r) => r.asset_id)).toEqual([stay]);
    });
  });

  describe('H2. native compatibility (unchanged)', () => {
    it('redirects to Project Assets with the filter context and the service counts', async () => {
      const f = await createProject({ wip: ['a.png', 'keep.png'], missing: ['wip/a.png'] });
      const response = await postNative(f, {
        _csrf: csrfToken, returnTo: `/projects/${f.projectId}/assets?search=keep&view=list&unknown=strip-me`,
      }).expect(302);
      const location = new URL(response.headers.location, 'http://localhost');
      expect(location.pathname).toBe(`/projects/${f.projectId}/assets`);
      expect(location.searchParams.get('search')).toBe('keep');
      expect(location.searchParams.get('view')).toBe('list');
      expect(location.searchParams.get('missing_cleanup')).toBe('ok');
      expect(location.searchParams.get('missing_removed')).toBe('1');
      expect(location.searchParams.get('missing_protected')).toBe('0');
      expect(location.searchParams.get('missing_candidates')).toBe('1');
      expect(location.searchParams.has('unknown')).toBe(false);
      expect(assetIds(f.projectId)).toEqual([f.id('keep.png')]);
    });

    it('keeps native errors: 404 for an unknown project, a controlled 409 page for an archived one', async () => {
      const f = await createProject({ wip: ['a.png'], missing: ['wip/a.png'] });
      const unknown = await agent.post('/projects/999999/assets/remove-missing').type('form').send({ _csrf: csrfToken }).expect(404);
      expect(unknown.headers['content-type']).toMatch(/text\/html/);
      await archive(f.projectId);
      const archived = await postNative(f).expect(409);
      expect(archived.headers['content-type']).toMatch(/text\/html/);
      expect(archived.text).toContain('This project is archived and read-only.');
      expect(missingIds(f.projectId)).toHaveLength(1);
    });

    it('renders the confirmation as an enhanced in-place form with a truthful project-wide scope', async () => {
      const f = await createProject({ wip: ['a.png'], missing: ['wip/a.png'] });
      const page = await agent.get(`/projects/${f.projectId}/assets?category=${f.rendersId}`).expect(200);
      const dialog = page.text.match(/<dialog id="remove-missing-assets-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
      expect(dialog).toContain(`action="/projects/${f.projectId}/assets/remove-missing"`);
      expect(dialog).toContain('data-dialog-async="true"');
      expect(dialog).toContain('data-remove-missing-assets-form');
      expect(dialog).toContain(`data-project-id="${f.projectId}"`);
      // WP10B-F1: the scope is the records missing when the removal is
      // processed under the project lock, not when the user confirms.
      expect(dialog).toContain(`every asset record in Remove Missing ${fixtureCount} that is marked missing when the removal is processed, including any hidden by the current filters or category.`);
      expect(dialog).toContain('A scan or another change may mark more records missing, or fewer, between now and then.');
      expect(dialog).not.toContain('when you confirm');
      expect(dialog).toContain('Missing assets protected by published-release rules will remain.');
      expect(dialog).toContain('removes eligible missing database records');
      expect(dialog).toContain('No files are deleted.');
      expect(dialog).toContain('data-dialog-error hidden');
      expect(dialog).toContain('data-dialog-status');
      expect(page.text).toContain('data-remove-missing-pending role="status" hidden');
    });
  });

  describe('H3. published-release protection', () => {
    it('keeps a missing record of a published release, removes the eligible one, and reports both truthfully', async () => {
      const f = await createProject({ wip: ['free.png', 'pub.png', 'draft.png'], missing: ['wip/free.png', 'wip/pub.png', 'wip/draft.png'] });
      const published = insertRelease(f.projectId, 'Published', true);
      const draft = insertRelease(f.projectId, 'Draft');
      linkReleaseAsset(published, f.id('pub.png'));
      linkReleaseAsset(draft, f.id('draft.png'));

      const ids = { free: f.id('free.png'), pub: f.id('pub.png'), draft: f.id('draft.png') };
      const response = await postJson(f).expect(200);

      expect(response.body).toMatchObject({
        outcome: 'removed', removedCount: 2, protectedCount: 1, totalMissingCandidates: 3,
        protectedAssetIds: [ids.pub],
        message: 'Removed 2 of 3 missing asset records. No files were deleted. Kept 1 missing asset record protected by published-release rules.',
      });
      expect([...response.body.removedAssetIds].sort((x, y) => x - y)).toEqual([ids.free, ids.draft].sort((x, y) => x - y));
      expect(missingIds(f.projectId)).toEqual([ids.pub]);
      expect(releaseAssetIds(published)).toEqual([ids.pub]);
      expect(releaseAssetIds(draft)).toEqual([]);
    });

    it('answers "protected-only" when every missing record is protected; nothing is removed or logged', async () => {
      const f = await createProject({ wip: ['pub1.png', 'pub2.png'], missing: ['wip/pub1.png', 'wip/pub2.png'] });
      const published = insertRelease(f.projectId, 'Published', true);
      linkReleaseAsset(published, f.id('pub1.png'));
      linkReleaseAsset(published, f.id('pub2.png'));

      const response = await postJson(f).expect(200);

      expect(response.body).toMatchObject({
        status: 'success', outcome: 'protected-only', removedCount: 0, protectedCount: 2, totalMissingCandidates: 2,
        removedAssetIds: [], refresh: false,
        message: 'Nothing was removed: 2 missing asset records are protected by published-release rules and were kept.',
      });
      expect(missingIds(f.projectId)).toHaveLength(2);
      expect(removalLogs(f.projectId)).toEqual([]);
    });
  });

  describe('H4. no-op', () => {
    it('answers "none-missing" with zero counts when nothing is marked missing, and again after a removal', async () => {
      const f = await createProject({ wip: ['a.png', 'b.png'], missing: ['wip/a.png'] });
      await postJson(f).expect(200);
      const again = await postJson(f).expect(200);
      expect(again.body).toEqual({
        status: 'success',
        outcome: 'none-missing',
        projectId: f.projectId,
        removedCount: 0,
        protectedCount: 0,
        totalMissingCandidates: 0,
        removedAssetIds: [],
        protectedAssetIds: [],
        message: 'No asset records were marked missing, so nothing was removed.',
        refresh: false,
      });
      expect(assetIds(f.projectId)).toEqual([f.id('b.png')]);
      expect(removalLogs(f.projectId)).toHaveLength(1);
    });
  });

  describe('H5. scope', () => {
    it('is the whole project: the filters the page sends neither narrow nor widen it', async () => {
      const f = await createProject({
        wip: ['w-missing.png', 'w-present.png'], renders: ['r-missing.png', 'r-present.png'],
        missing: ['wip/w-missing.png', 'renders/r-missing.png'],
      });
      const ids = Object.fromEntries(['w-missing', 'w-present', 'r-missing', 'r-present'].map((n) => [n, f.id(`${n}.png`)]));
      const response = await postJson(f, {
        _csrf: csrfToken,
        returnTo: `/projects/${f.projectId}/assets?category=${f.wipId}&search=w-missing`,
        category: String(f.wipId),
        search: 'w-missing',
        assetIds: String(ids['w-present']),
      }).expect(200);
      expect(response.body.removedCount).toBe(2);
      expect([...response.body.removedAssetIds].sort((x, y) => x - y))
        .toEqual([ids['w-missing'], ids['r-missing']].sort((x, y) => x - y));
      expect(assetIds(f.projectId)).toEqual([ids['w-present'], ids['r-present']].sort((x, y) => x - y));
    });

    it('never touches another project\'s missing records', async () => {
      const f = await createProject({ wip: ['a.png'], missing: ['wip/a.png'] });
      const other = await createProject({ wip: ['b.png'], missing: ['wip/b.png'] });
      await postJson(f).expect(200);
      expect(missingIds(other.projectId)).toEqual([other.id('b.png')]);
    });
  });

  describe('H6. authorization and refusals', () => {
    it('refuses an unknown or malformed project as JSON 404 without calling the service', async () => {
      const service = vi.spyOn(app.locals.assetActionService, 'removeMissingAssets');
      for (const id of ['999999', '0', 'abc']) {
        const response = await agent.post(`/projects/${id}/assets/remove-missing`).set('Accept', 'application/json')
          .type('form').send({ _csrf: csrfToken }).expect(404);
        expect(response.body).toEqual({
          status: 'error', outcome: 'refused', code: 'PROJECT_NOT_FOUND', message: 'Project not found. Nothing was removed.',
        });
      }
      expect(service).not.toHaveBeenCalled();
    });

    it('refuses an archived project with nothing removed', async () => {
      const f = await createProject({ wip: ['a.png'], missing: ['wip/a.png'] });
      await archive(f.projectId);
      const response = await postJson(f).expect(409);
      expect(response.body).toEqual({
        status: 'error', outcome: 'refused', code: 'PROJECT_ARCHIVED',
        message: 'This project is archived and read-only. Nothing was removed.',
      });
      expect(missingIds(f.projectId)).toHaveLength(1);
    });

    it('requires a valid CSRF token and a signed-in session; neither removes anything', async () => {
      const f = await createProject({ wip: ['a.png'], missing: ['wip/a.png'] });
      const noToken = await postJson(f, {});
      expect(noToken.status).toBe(403);
      expect(noToken.body).toEqual({ status: 'error', message: 'Invalid or missing CSRF token.' });
      const badToken = await postJson(f, { _csrf: 'not-the-token' });
      expect(badToken.status).toBe(403);
      const anonymous = await request(app).post(route(f)).set('Accept', 'application/json').type('form').send({ _csrf: csrfToken });
      expect([302, 401, 403]).toContain(anonymous.status);
      for (const response of [noToken, badToken, anonymous]) {
        expect(response.text).not.toContain(tmpDir);
        expect(response.body?.status).not.toBe('success');
      }
      await agent.get(route(f)).expect(404);
      expect(missingIds(f.projectId)).toHaveLength(1);
    });
  });

  describe('H7. busy and operational failure', () => {
    it('refuses a busy project (a real held project lock) with nothing removed', async () => {
      const f = await createProject({ wip: ['a.png'], missing: ['wip/a.png'] });
      let release;
      const held = coordinator.runAsync(f.projectId, () => new Promise((resolve) => { release = resolve; }));
      try {
        const response = await postJson(f).expect(409);
        expect(response.body).toEqual({
          status: 'error', outcome: 'refused', code: 'PROJECT_BUSY',
          message: 'Another project operation is already in progress. Try again. Nothing was removed.',
        });
      } finally {
        release();
        await held;
      }
      expect(missingIds(f.projectId)).toHaveLength(1);
    });

    it('a database fault part-way through rolls back every row: "failed", never partial success', async () => {
      const f = await createProject({ wip: ['a.png', 'b.png', 'c.png'], missing: ['wip/a.png', 'wip/b.png', 'wip/c.png'] });
      const before = missingIds(f.projectId);
      // The first DELETE succeeds inside the transaction; the second aborts it.
      db.exec(`CREATE TRIGGER wp10b_fail_second BEFORE DELETE ON assets
        WHEN (SELECT COUNT(*) FROM assets WHERE project_id = OLD.project_id AND is_present = 0) < ${before.length}
        BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
      const response = await postJson(f).expect(500);
      expect(response.body).toEqual({
        status: 'error', outcome: 'failed', code: 'REMOVE_MISSING_DATABASE_OPERATION_FAILED',
        message: 'Missing asset records could not be removed. The change was rolled back, so nothing was removed.',
      });
      expect(missingIds(f.projectId)).toEqual(before);
      expect(removalLogs(f.projectId)).toEqual([]);
      expectNoLeak(response.body);

      // Native keeps its controlled (generic) 500 page.
      const native = await postNative(f).expect(500);
      expect(native.headers['content-type']).toMatch(/text\/html/);
      expect(native.text).toContain('Error 500');
      expect(native.text).not.toContain('injected');
      expect(native.text).not.toContain(tmpDir);
      expect(missingIds(f.projectId)).toEqual(before);
    });

    it('an unexpected failure is "unknown": no claim either way and no detail leaked', async () => {
      const f = await createProject({ wip: ['a.png'], missing: ['wip/a.png'] });
      vi.spyOn(app.locals.assetActionService, 'removeMissingAssets').mockImplementationOnce(() => {
        throw new TypeError(`boom at ${tmpDir}`);
      });
      const response = await postJson(f).expect(500);
      expect(response.body).toEqual({
        status: 'error', outcome: 'unknown', code: 'REMOVE_MISSING_UNCONFIRMED',
        message: 'Could not confirm whether missing asset records were removed.',
      });
      expectNoLeak(response.body);
    });
  });

  describe('H8. concurrent status changes (eligibility is read under the lock)', () => {
    it('a record found again by a scan after the confirmation is no longer removed', async () => {
      const f = await createProject({ wip: ['back.png', 'gone.png'], missing: ['wip/back.png', 'wip/gone.png'] });
      await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .png().toFile(path.join(f.directory, 'wip', 'back.png'));
      app.locals.assetScanner.scanProjectAssets(f.projectId);
      const gone = f.id('gone.png');
      const back = f.id('back.png');

      const response = await postJson(f).expect(200);
      expect(response.body).toMatchObject({ removedCount: 1, totalMissingCandidates: 1, removedAssetIds: [gone] });
      expect(assetRow(back).is_present).toBe(1);
    });

    it('a record that became missing after the confirmation is in scope, as the dialog states', async () => {
      const f = await createProject({ wip: ['first.png', 'later.png'], missing: ['wip/first.png'] });
      const later = f.id('later.png');
      fs.rmSync(path.join(f.directory, 'wip', 'later.png'));
      app.locals.assetScanner.scanProjectAssets(f.projectId);
      const response = await postJson(f).expect(200);
      expect(response.body.removedCount).toBe(2);
      expect(response.body.removedAssetIds).toContain(later);
    });

    it('a release published after the confirmation protects its record; one unpublished no longer does', async () => {
      const f = await createProject({ wip: ['a.png', 'b.png'], missing: ['wip/a.png', 'wip/b.png'] });
      const nowPublished = insertRelease(f.projectId, 'Now Published');
      linkReleaseAsset(nowPublished, f.id('a.png'));
      const wasPublished = insertRelease(f.projectId, 'Was Published', true);
      linkReleaseAsset(wasPublished, f.id('b.png'));
      db.prepare("UPDATE releases SET published_date = '2026-09-01' WHERE id = ?").run(nowPublished);
      db.prepare('UPDATE releases SET published_date = NULL WHERE id = ?').run(wasPublished);
      const a = f.id('a.png');
      const b = f.id('b.png');

      const response = await postJson(f).expect(200);
      expect(response.body).toMatchObject({ removedCount: 1, removedAssetIds: [b], protectedCount: 1, protectedAssetIds: [a] });
      expect(missingIds(f.projectId)).toEqual([a]);
      expect(releaseAssetIds(nowPublished)).toEqual([a]);
    });

    it('another tab removing them first leaves this request a clean "none-missing"', async () => {
      const f = await createProject({ wip: ['a.png', 'b.png'], missing: ['wip/a.png'] });
      await postJson(f).expect(200);
      const second = await postJson(f).expect(200);
      expect(second.body.outcome).toBe('none-missing');
      expect(assetIds(f.projectId)).toEqual([f.id('b.png')]);
    });
  });
});
