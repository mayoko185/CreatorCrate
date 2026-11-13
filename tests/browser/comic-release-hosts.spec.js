import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import slugify from '@sindresorhus/slugify';
import sharp from 'sharp';
import { build } from 'vite';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { createAssetRepository } from '../../src/data/asset-repository.js';
import { createProjectRepository } from '../../src/data/project-repository.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { defaultComicPreparationCacheRoot } from '../../src/services/comic-preparation-cache.js';
import { createComicRuntime } from '../../src/services/comic-runtime.js';
import { createReleaseService } from '../../src/services/release-service.js';
import { formatProjectDirName } from '../../src/storage/project-storage.js';
import { bindTestProjectOwnership } from '../helpers/project-ownership.js';
import { makeZip } from '../helpers/zip-fixture.js';

// C2c: Read Comic on Release Manage Assets and Release Detail, in real
// Chromium against the compiled production bundle (built here into a temp
// directory) and Milestone A's real project/asset comic routes. An isolated
// installation (temp SQLite database, projects root and comic runtime) holds
// one project per test with real CBZ, CB7 and CBR archives; no user data is
// involved. Every request is recorded, so manifests and pages are proven to
// start only from Read Comic (or an accepted source-hint change) and reading
// is proven to send no mutation. Live refreshes run through each page's own
// lifecycle: the Manage Assets engine's Back/Forward path and Release
// Detail's release-edit-saved refresh (with a routed 404 for retirement).

const DIALOG = '#unified-viewer-dialog';
const VIDEO_DIALOG = '#asset-video-preview-dialog';
const MEDIA = `${DIALOG} [data-unified-viewer-media]`;
const SHOWN = `${MEDIA} img:is(.unified-viewer-image, .unified-viewer-page-image):not([hidden])`;
const POSITION = `${DIALOG} [data-unified-viewer-position]`;
const TITLE = `${DIALOG} [data-unified-viewer-title]`;
const NEXT = `${DIALOG} [data-unified-viewer-next]`;
const DIRECTION_MENU = `${DIALOG} #unified-viewer-direction-dropdown`;
const LAYOUT_MENU = `${DIALOG} #unified-viewer-layout-dropdown`;
const REGION = '[data-release-assets-live-region]';
const SELECTED = '[data-selected-assets]';
const FIXTURES = fileURLToPath(new URL('../fixtures/archive-decoder/', import.meta.url));
const MIME = {
  cbz: 'application/vnd.comicbook+zip',
  cbr: 'application/vnd.comicbook-rar',
  cb7: 'application/x-cb7',
  png: 'image/png',
  mp4: 'video/mp4',
};

let fixture;

async function gradient(width, height, seed) {
  const raw = Buffer.alloc(width * height * 3);
  for (let index = 0; index < raw.length; index += 1) raw[index] = (index * 7 + seed) & 0xff;
  return sharp(raw, { raw: { width, height, channels: 3 } });
}

test.beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-comic-release-hosts-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const previewRoot = path.join(appDataRoot, 'previews');
  const viteDistRoot = path.join(root, 'client');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(previewRoot, { recursive: true });
  await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
  const db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  const runtime = createComicRuntime({ appDataRoot, projectsRoot, cacheOptions: { settleMs: 0 } });
  await runtime.start();
  const app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, {
    appDataRoot, authState: { csrfPepper }, comicRuntime: runtime,
    useViteAssets: true, viteDistRoot,
    assetManifest: createAssetManifest({ distRoot: viteDistRoot,
      manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
  });
  await app.locals.generatedImagePublicationLifecycle.waitForIdle();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));

  const pages = [
    await (await gradient(60, 80, 10)).jpeg().toBuffer(),
    await (await gradient(60, 80, 90)).png().toBuffer(),
    await (await gradient(80, 60, 170)).png().toBuffer(),
  ];
  const projectRepo = createProjectRepository(db);
  const assetRepo = createAssetRepository(db);
  const releaseService = createReleaseService({ db });
  let projects = 0;

  // One project per test: a three-page CBZ (selected), a two-page CBZ (an
  // unselected candidate), a CB7 and a CBR volume, twelve images and a fake
  // video. Sorted by filename, ten per page, page 1 opens with the comics.
  async function createProject() {
    projects += 1;
    const title = `Comic Release ${projects}`;
    const project = projectRepo.create({
      title, projectType: 'images', slug: slugify(title, { lowercase: true }),
      description: '', notes: '', status: 'tbd', priority: 'normal', plannedDate: null, publishedDate: null,
      patreonUrl: null,
    });
    const relDir = formatProjectDirName(project.id, project.slug);
    const absDir = path.resolve(projectsRoot, relDir);
    fs.mkdirSync(absDir, { recursive: true });
    projectRepo.setProjectDir(project.id, relDir);
    bindTestProjectOwnership(db, project.id, absDir);
    const index = (relPath) => {
      const stat = fs.statSync(path.join(absDir, relPath));
      const extension = relPath.split('.').pop();
      return assetRepo.upsert(project.id, relPath, {
        filename: relPath, extension, mimeType: MIME[extension], sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      }).id;
    };
    const write = (relPath, bytes) => {
      fs.writeFileSync(path.join(absDir, relPath), bytes);
      return index(relPath);
    };
    const ids = {
      aIssue: write('a-issue.cbz', makeZip(pages.map((data, number) => ({ name: `p${number + 1}.${number ? 'png' : 'jpg'}`, data })))),
      bIssue: write('b-issue.cbz', makeZip([{ name: 'b1.png', data: pages[2] }, { name: 'b2.png', data: pages[1] }])),
      cb7: write('c-volume.cb7', fs.readFileSync(path.join(FIXTURES, 'pages-nonsolid.7z'))),
      cbr: write('c-volume.cbr', fs.readFileSync(path.join(FIXTURES, 'rar5-compressed.rar'))),
      video: write('v-clip.mp4', Buffer.from('not a real video')),
      images: [],
    };
    for (let number = 1; number <= 12; number += 1) {
      const png = await (await gradient(40, 40, number * 20)).png().toBuffer();
      ids.images.push(write(`p${String(number).padStart(2, '0')}.png`, png));
    }
    return {
      id: project.id,
      title,
      ids,
      // A release with its saved selection, in saved order, and saved roles.
      createRelease(assetIds, roles = {}) {
        const release = releaseService.createReleaseWithSelectedAssets(project.id, { title: `${title} Release` }, assetIds);
        Object.entries(roles).forEach(([assetId, role]) => {
          db.prepare('UPDATE release_assets SET role = ? WHERE release_id = ? AND asset_id = ?').run(role, release.id, Number(assetId));
        });
        return release.id;
      },
      // Replace the three-page issue with a two-page one and re-index it, as
      // a rescan would: its indexed-source hint changes.
      rewriteAIssue() {
        const full = path.join(absDir, 'a-issue.cbz');
        fs.writeFileSync(full, makeZip(pages.slice(0, 2).map((data, number) => ({ name: `r${number + 1}.png`, data }))));
        const later = new Date(Date.now() + 60_000);
        fs.utimesSync(full, later, later);
        index('a-issue.cbz');
      },
      async addEarlierImages(count) {
        for (let number = 1; number <= count; number += 1) {
          write(`0-early-${String(number).padStart(2, '0')}.png`, await (await gradient(40, 40, 200 + number)).png().toBuffer());
        }
      },
    };
  }

  fixture = {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    createProject,
    setPresent(assetId, present) {
      db.prepare('UPDATE assets SET is_present = ?, missing_since = ? WHERE id = ?')
        .run(present ? 1 : 0, present ? null : new Date().toISOString(), assetId);
    },
    unselect(releaseId, assetId) {
      db.prepare('DELETE FROM release_assets WHERE release_id = ? AND asset_id = ?').run(releaseId, assetId);
    },
    savedMembership(releaseId) {
      return db.prepare('SELECT asset_id, role, sort_order FROM release_assets WHERE release_id = ? ORDER BY asset_id')
        .all(releaseId).map((row) => `${row.asset_id}:${row.role}:${row.sort_order}`);
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      app.locals.generatedImageRebuildService.stop();
      app.locals.generatedImagePublicationLifecycle.stop();
      await app.locals.generatedImageRebuildService.waitForIdle();
      await app.locals.generatedImagePublicationLifecycle.waitForIdle();
      app.locals.comicMediaService.stop();
      await app.locals.comicMediaService.pauseForMaintenance().waitForIdle();
      await runtime.close();
      closeDatabase(db);
      fs.rmSync(defaultComicPreparationCacheRoot(appDataRoot), { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    },
  };
});
test.afterAll(async () => { await fixture?.close(); });

const manifestPath = (projectId, assetId) => `/projects/${projectId}/assets/${assetId}/comic`;

// Records every request; mutations and comic API requests are read back by
// path (module imports such as /client/comic-source.js never match).
async function openPage(page, url, { viewport = { width: 1280, height: 900 } } = {}) {
  const control = { requests: [], mutations: [], errors: [] };
  page.on('pageerror', (error) => control.errors.push(error.message));
  page.on('request', (request) => {
    const parsed = new URL(request.url());
    control.requests.push(`${parsed.pathname}${parsed.search}`);
    if (request.method() !== 'GET') control.mutations.push(`${request.method()} ${parsed.pathname}`);
  });
  control.comic = () => control.requests.filter((entry) => /^\/projects\/\d+\/assets\/\d+\/comic(\/pages\/\d+)?(\?|$)/.test(entry));
  control.manifests = (projectId, assetId) => control.requests.filter((entry) => entry === manifestPath(projectId, assetId));
  control.pages = (projectId, assetId) => control.requests.filter((entry) => entry.startsWith(`${manifestPath(projectId, assetId)}/pages/`));
  await page.setViewportSize(viewport);
  await page.goto(`${fixture.baseURL}${url}`);
  expect(await page.evaluate(() => Boolean(document.querySelector('script[type="module"][src^="/vite/"]')))).toBe(true);
  await page.waitForFunction(() => Boolean(document.getElementById('unified-viewer-dialog')?.__creatorCrateUnifiedViewer));
  await page.evaluate(() => {
    window.__sameDocument = true;
    // Keep link navigation in this document while recording whether the
    // page's own handlers took each comic-link click (they run first).
    window.__comicClicks = [];
    const record = (event) => {
      const link = event.target.closest?.('a[data-release-assets-comic-trigger], a[data-release-detail-comic-trigger], a[data-release-detail-comic-withdrawn]');
      if (!link) return;
      window.__comicClicks.push({ type: event.type, prevented: event.defaultPrevented });
      event.preventDefault();
    };
    document.addEventListener('click', record);
    document.addEventListener('auxclick', record);
  });
  return control;
}

const lastComicClick = (page) => page.evaluate(() => window.__comicClicks.at(-1) ?? null);

const state = (page) => page.evaluate(() => {
  const viewer = document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer;
  const { open, session, key, count, comic, reader, source, context } = viewer.getState();
  return {
    open, session, key, count, reader, context,
    comic: comic ? { state: comic.state, projectId: comic.projectId, assetId: comic.assetId,
      sourceRevision: comic.sourceRevision, revision: comic.revision, pageCount: comic.pageCount } : null,
    slideshow: source?.slideshow ?? null,
    titles: source ? source.items.map((item) => item.title) : [],
    fullscreen: document.fullscreenElement
      ? (document.fullscreenElement.matches('[data-unified-viewer-card]') ? 'card' : 'other') : null,
    dialogs: document.querySelectorAll('#unified-viewer-dialog').length,
    objectUrls: document.querySelectorAll('#unified-viewer-dialog img[src^="blob:"]').length,
  };
});

async function choose(page, menu, label) {
  await page.locator(`${menu} summary`).click();
  await expect(page.locator(menu)).toHaveAttribute('open', '');
  await page.locator(`${menu} .asset-filter-multiselect-panel`).getByText(label, { exact: true }).click();
  await expect(page.locator(menu)).not.toHaveAttribute('open', '');
}

async function readerReady(page, title) {
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(page.locator(TITLE)).toHaveText(title);
  await expect.poll(async () => (await state(page)).comic?.state).toBe('ready');
}

// ─── Release Manage Assets ──────────────────────────────────────────────────

const maComic = (page, assetId) => page.locator(`${REGION} a[data-release-assets-comic-trigger][data-comic-asset="${assetId}"]:visible`);
const maThumb = (page, assetId) => page.locator(`${REGION} a[data-release-assets-viewer-trigger][data-viewer-asset="${assetId}"]`);
const maCard = (page, assetId) => page.locator(`${REGION} article[data-asset-id="${assetId}"]`);
const maSwitch = (page) => page.locator(`${REGION} nav.view-switcher a[aria-current="page"]`);

// The membership the Save form would submit: visible checkboxes plus the
// hidden off-page inputs.
const draftMembership = (page) => page.evaluate(() => {
  const ids = new Set();
  document.querySelectorAll('[data-release-assets-hidden-membership] input[name="selectedAssetIds"]')
    .forEach((input) => ids.add(input.value));
  document.querySelectorAll('[data-release-assets-live-region] input[name="selectedAssetIds"]:checked')
    .forEach((input) => ids.add(input.value));
  return [...ids].sort();
});

// A real Release Manage Assets live refresh of the current (or a replaced)
// URL through the engine's own Back/Forward path.
async function liveRefresh(page, nextUrl = null) {
  await page.locator(REGION).evaluate((node) => { node.dataset.beforeRefresh = 'true'; });
  await page.evaluate((next) => {
    if (next) window.history.replaceState({ releaseAssets: true }, '', next);
    window.dispatchEvent(new PopStateEvent('popstate', { state: { releaseAssets: true } }));
  }, nextUrl);
  await expect(page.locator(`${REGION}:not([data-before-refresh])`)).toHaveCount(1);
  await expect(page.locator(REGION)).not.toHaveAttribute('aria-busy', 'true');
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
}

test('Release Manage Assets: Read Comic in Grid and List reads real pages and leaves every draft alone', async ({ page }) => {
  const project = await fixture.createProject();
  const { ids } = project;
  const releaseId = project.createRelease([ids.aIssue, ids.images[0], ids.video], { [ids.images[0]]: 'primary' });
  const url = `/releases/${releaseId}/assets`;
  const saved = fixture.savedMembership(releaseId);
  const control = await openPage(page, `${url}?selection=all&view=grid&pageSize=all`);

  // Every readable comic, selected (a-issue) or not, offers Read comic.
  for (const [assetId, format] of [[ids.aIssue, 'CBZ'], [ids.bIssue, 'CBZ'], [ids.cb7, 'CB7'], [ids.cbr, 'CBR']]) {
    await expect(maComic(page, assetId)).toHaveCount(1);
    await expect(maComic(page, assetId)).not.toContainText(`${format} comic`);
    await expect(maComic(page, assetId)).toHaveAccessibleName(/^Read comic /);
    const image = maCard(page, assetId).locator('img[data-preview-image]');
    await expect(image).toHaveAttribute('alt', /^Preview of /);
    await expect(image).toHaveAttribute('src', new RegExp(`^/projects/${project.id}/assets/${assetId}/preview\\?v=[a-f0-9]{16}$`));
    await expect(image).toHaveAttribute('loading', 'lazy');
    await expect(maCard(page, assetId).locator('[data-comic-thumbnail]')).toHaveCount(0);
    await expect(maComic(page, assetId)).toHaveAttribute('href', `/projects/${project.id}/assets/${assetId}`);
  }
  await expect(maThumb(page, ids.aIssue)).toHaveCount(0);
  // An unsaved draft: select an image candidate.
  await page.locator(`label[for="release-asset-select-${ids.images[3]}"]`).click();
  const draft = await draftMembership(page);
  expect(draft).toContain(String(ids.images[3]));

  // Hover, information card and selection request no Reader manifest or pages.
  await maComic(page, ids.bIssue).hover();
  await maCard(page, ids.bIssue).locator('.asset-details-link').hover();
  await page.waitForTimeout(300);
  expect(control.comic()).toEqual([]);

  // Activation of the unselected b-issue: the shared dialog, one manifest, a real page.
  await maComic(page, ids.bIssue).click();
  expect(await lastComicClick(page)).toEqual({ type: 'click', prevented: true });
  await readerReady(page, 'b-issue.cbz');
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 2');
  await expect(page.locator(SHOWN)).toHaveCount(1);
  expect(control.manifests(project.id, ids.bIssue)).toHaveLength(1);
  expect(control.pages(project.id, ids.bIssue)[0]).toMatch(/\/pages\/1\?v=[0-9a-f]{32}$/);
  const opened = await state(page);
  expect(opened).toMatchObject({ open: true, dialogs: 1, comic: { projectId: project.id, assetId: ids.bIssue }, context: { projectId: String(project.id), assetId: String(ids.bIssue), filename: 'b-issue.cbz', projectName: project.title, detailsUrl: `/projects/${project.id}/assets/${ids.bIssue}` } });
  expect(opened.comic.sourceRevision).toBe(await maComic(page, ids.bIssue).getAttribute('data-comic-source-revision'));
  expect(opened.comic.sourceRevision).not.toBe(opened.comic.revision);
  // Reading selected nothing.
  await expect(page.locator(`#release-asset-select-${ids.bIssue}`)).not.toBeChecked();
  expect(await draftMembership(page)).toEqual(draft);

  // Reader controls: RTL and a two-page spread pairing from page 1.
  await choose(page, DIRECTION_MENU, 'Right-to-Left');
  await choose(page, LAYOUT_MENU, 'Two-Page Spread — Pair from Page 1');
  await expect(page.locator(POSITION)).toHaveText('Pages 1–2 of 2');
  await expect(page.locator(SHOWN)).toHaveCount(2);
  expect((await state(page)).reader).toMatchObject({ direction: 'rtl', layout: 'spread' });
  expect(control.manifests(project.id, ids.bIssue)).toHaveLength(1);

  // Fullscreen-first Escape, then Close returns focus to the opener.
  await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(async () => (await state(page)).fullscreen).toBe('card');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).fullscreen).toBe(null);
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(maComic(page, ids.bIssue)).toBeFocused();
  expect((await state(page)).objectUrls).toBe(0);

  // Keyboard activation of the selected a-issue; replacement by CB7/CBR in
  // the same dialog through their own project/asset endpoints.
  await maComic(page, ids.aIssue).focus();
  await page.keyboard.press('Enter');
  await readerReady(page, 'a-issue.cbz');
  const first = (await state(page)).session;
  await page.locator(`${DIALOG} [data-dialog-close]`).click();
  await expect(maComic(page, ids.aIssue)).toBeFocused();
  for (const assetId of [ids.cb7, ids.cbr]) {
    await maComic(page, assetId).click();
    await expect(page.locator(TITLE)).toHaveText(assetId === ids.cb7 ? 'c-volume.cb7' : 'c-volume.cbr');
    await expect.poll(async () => (await state(page)).comic?.state).not.toBe('loading');
    expect(control.manifests(project.id, assetId)).toHaveLength(1);
    expect((await state(page)).session).toBeGreaterThan(first);
    await page.keyboard.press('Escape');
    await expect(page.locator(DIALOG)).toBeHidden();
  }

  // Modified and middle clicks are left to the Asset Details link.
  const before = control.comic().length;
  for (const modifiers of [['Control'], ['Shift'], ['Alt']]) {
    await maComic(page, ids.bIssue).click({ modifiers });
    expect(await lastComicClick(page)).toEqual({ type: 'click', prevented: false });
  }
  await maComic(page, ids.bIssue).click({ button: 'middle' });
  expect((await lastComicClick(page)).prevented).toBe(false);
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(control.comic()).toHaveLength(before);

  // Images still open alone; the video keeps its own dialog.
  await maThumb(page, ids.images[1]).click();
  await expect.poll(async () => (await state(page)).titles).toEqual(['p02.png']);
  expect((await state(page)).comic).toBeNull();
  expect((await state(page)).slideshow).toBe(false);
  await page.keyboard.press('Escape');
  await page.locator(`${REGION} a[data-asset-video-preview-trigger]`).click();
  await expect(page.locator(VIDEO_DIALOG)).toBeVisible();
  await expect(page.locator(DIALOG)).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator(VIDEO_DIALOG)).toBeHidden();

  // List view (a real live refresh): the same reader, drafts intact.
  await liveRefresh(page, `${url}?selection=all&view=list&pageSize=all`);
  await expect(maComic(page, ids.aIssue)).toHaveClass(/asset-list-card-media-link/);
  expect(await draftMembership(page)).toEqual(draft);
  await maComic(page, ids.aIssue).click();
  await readerReady(page, 'a-issue.cbz');
  await expect(page.locator(POSITION)).toHaveText(/Page 1 of 3|Pages 1–2 of 3/);
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(maComic(page, ids.aIssue)).toBeFocused();

  // Nothing was mutated: drafts, hidden membership and saved rows as before.
  expect(await draftMembership(page)).toEqual(draft);
  expect(fixture.savedMembership(releaseId)).toEqual(saved);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
  // Only the comics deliberately read were requested.
  expect(new Set(control.comic().map((entry) => entry.match(/assets\/(\d+)\/comic/)[1])))
    .toEqual(new Set([ids.bIssue, ids.aIssue, ids.cb7, ids.cbr].map(String)));
});

test('Release Manage Assets: paginated omission keeps the reader; a new hint reloads once; ineligibility retires', async ({ page, request }) => {
  const project = await fixture.createProject();
  const { ids } = project;
  const releaseId = project.createRelease([ids.aIssue, ids.images[0]]);
  const url = `/releases/${releaseId}/assets`;
  const pageUrl = `${url}?selection=all&view=list&pageSize=10&page=1`;
  const control = await openPage(page, pageUrl);
  await expect(page.locator(`${REGION} .pagination-info`)).toHaveText('Page 1 of 2');
  await page.locator(`label[for="release-asset-select-${ids.images[4]}"]`).click();
  const draft = await draftMembership(page);
  const saved = fixture.savedMembership(releaseId);

  await maComic(page, ids.aIssue).click();
  await readerReady(page, 'a-issue.cbz');
  await page.locator(NEXT).click();
  await expect(page.locator(POSITION)).toHaveText('Page 2 of 3');
  const { session } = await state(page);

  // Ten earlier filenames displace the comic off page 1 under the same query.
  await project.addEarlierImages(10);
  await liveRefresh(page);
  await expect(maCard(page, ids.aIssue)).toHaveCount(0);
  await expect(page.locator(`${REGION} .pagination-info`)).toHaveText('Page 1 of 3');
  expect(await state(page)).toMatchObject({ open: true, session, comic: { state: 'ready', assetId: ids.aIssue } });
  await expect(page.locator(POSITION)).toHaveText('Page 2 of 3');
  expect(control.manifests(project.id, ids.aIssue)).toHaveLength(1);
  // A separate server render proves it simply moved to page 2.
  const page2 = await request.get(`${fixture.baseURL}${url}?selection=all&view=list&pageSize=10&page=2`);
  expect(await page2.text()).toContain(`data-release-assets-comic-trigger data-comic-project="${project.id}" data-comic-asset="${ids.aIssue}"`);
  // Filtered away entirely: still no evidence of anything.
  await liveRefresh(page, `${url}?selection=all&view=list&pageSize=10&search=p03`);
  expect(await state(page)).toMatchObject({ open: true, session });
  expect(control.manifests(project.id, ids.aIssue)).toHaveLength(1);

  // The page that shows it, with a changed indexed hint: exactly one manifest.
  const hint = await page.evaluate(() => document.getElementById('unified-viewer-dialog')
    .__creatorCrateUnifiedViewer.getState().comic.sourceRevision);
  project.rewriteAIssue();
  await liveRefresh(page, `${url}?selection=all&view=list&pageSize=10&page=2`);
  await expect(maComic(page, ids.aIssue)).toHaveCount(1);
  await expect.poll(() => control.manifests(project.id, ids.aIssue).length).toBe(2);
  await expect.poll(async () => (await state(page)).comic?.pageCount).toBe(2);
  expect(await state(page)).toMatchObject({ open: true, session, comic: { state: 'ready' } });
  expect((await state(page)).comic.sourceRevision).not.toBe(hint);
  await liveRefresh(page);
  await liveRefresh(page, `${url}?selection=all&view=grid&pageSize=10&page=2`);
  await page.waitForTimeout(200);
  expect(control.manifests(project.id, ids.aIssue)).toHaveLength(2);
  expect((await state(page)).session).toBe(session);

  // Its own card rendered without Read comic (missing): the reader retires
  // and focus falls back to the connected Grid/List switch.
  fixture.setPresent(ids.aIssue, false);
  await liveRefresh(page);
  await expect(maCard(page, ids.aIssue)).toHaveCount(1);
  await expect(maComic(page, ids.aIssue)).toHaveCount(0);
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(await state(page)).toMatchObject({ open: false, comic: null, objectUrls: 0 });
  await expect(maSwitch(page)).toBeFocused();
  const settled = control.comic().length;
  await liveRefresh(page);
  await page.waitForTimeout(200);
  expect(control.comic()).toHaveLength(settled);
  expect((await state(page)).open).toBe(false);

  expect(await draftMembership(page)).toEqual(draft);
  expect(fixture.savedMembership(releaseId)).toEqual(saved);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
  fixture.setPresent(ids.aIssue, true);
});

// ─── Release Detail ─────────────────────────────────────────────────────────

const rdComic = (page, assetId) => page.locator(`${SELECTED} a[data-release-detail-comic-trigger][data-comic-asset="${assetId}"]:visible`);
const rdCardLink = (page, assetId) => page.locator(`${SELECTED} article[data-asset-id="${assetId}"] a[data-release-detail-comic-withdrawn]:visible`);
const rdSwitch = (page) => page.locator(`${SELECTED} nav.view-switcher a[aria-current="page"]`);

async function editSaved(page, releaseId) {
  await page.evaluate((id) => {
    document.dispatchEvent(new CustomEvent('release-edit-saved', { detail: { releaseId: id } }));
  }, releaseId);
}
async function markHeading(page) {
  await page.locator('[data-release-detail-region="heading"]').evaluate((node) => { node.dataset.beforeRefresh = 'true'; });
}
async function headingReplaced(page) {
  await expect(page.locator('[data-release-detail-region="heading"]:not([data-before-refresh])')).toHaveCount(1);
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
}
async function acceptedRefresh(page, releaseId) {
  await markHeading(page);
  await editSaved(page, releaseId);
  await headingReplaced(page);
}
const savedPresentation = (page) => page.locator(`${SELECTED} .release-asset-card-details`).allInnerTexts();

test('Release Detail: a connected failed cover returns Reader focus to its visible fallback and recovers', async ({ page }, testInfo) => {
  const project = await fixture.createProject();
  const { ids } = project;
  const releaseId = project.createRelease([ids.aIssue, ids.images[0]]);
  const saved = fixture.savedMembership(releaseId);
  const control = await openPage(page, `/releases/${releaseId}`);
  const card = page.locator(`${SELECTED} article[data-asset-id="${ids.aIssue}"]`);
  const primary = card.locator('a[data-release-detail-comic-trigger]:not([data-preview-fallback])');
  const fallback = card.locator('a[data-preview-fallback]');
  const image = card.locator('img[data-preview-image]');
  await expect(card.locator('[data-preview-enhancement]')).toHaveAttribute('data-preview-state', 'loaded');
  await primary.evaluate((node) => { window.__focusOpener = node; });
  await primary.click();
  await readerReady(page, 'a-issue.cbz');
  await page.locator(`${DIALOG} [data-dialog-close]`).click();
  await expect(primary).toBeFocused();

  await primary.click();
  await readerReady(page, 'a-issue.cbz');
  await image.evaluate((node) => { node.src = '/missing-cover-focus-regression.png'; });
  await expect(primary).toBeHidden();
  await expect(fallback).toBeVisible();
  expect(await page.evaluate(() => window.__focusOpener.isConnected)).toBe(true);
  expect((await state(page)).comic.state).toBe('ready');
  await page.locator(`${DIALOG} [data-dialog-close]`).click();
  await expect(fallback).toBeFocused();
  await expect(fallback).toHaveAttribute('href', `/projects/${project.id}/assets/${ids.aIssue}`);
  await page.screenshot({ path: testInfo.outputPath('failed-cover-visible-focus.png'), fullPage: true });

  await acceptedRefresh(page, releaseId);
  await expect(card.locator('[data-preview-enhancement]')).toHaveAttribute('data-preview-state', 'loaded');
  await expect(primary).toBeFocused();
  expect(await primary.evaluate((node) => node === window.__focusOpener)).toBe(true);
  await primary.click();
  await readerReady(page, 'a-issue.cbz');
  await page.locator(`${DIALOG} [data-dialog-close]`).click();
  await expect(primary).toBeFocused();
  expect(control.mutations).toEqual([]);
  expect(fixture.savedMembership(releaseId)).toEqual(saved);
});

test('Release Detail: Read Comic follows accepted renders, saved-selection removal and an authoritative 404', async ({ page }) => {
  const project = await fixture.createProject();
  const { ids } = project;
  const releaseId = project.createRelease(
    [ids.bIssue, ids.images[0], ids.aIssue, ids.cb7, ids.video],
    { [ids.images[0]]: 'primary', [ids.aIssue]: 'preview' },
  );
  const url = `/releases/${releaseId}`;
  const control = await openPage(page, url);
  for (const [assetId, format] of [[ids.bIssue, 'CBZ'], [ids.aIssue, 'CBZ'], [ids.cb7, 'CB7']]) {
    await expect(rdComic(page, assetId)).not.toContainText(`${format} comic`);
    await expect(rdComic(page, assetId)).toHaveAccessibleName(/^Read comic /);
    await expect(rdComic(page, assetId)).toHaveAttribute('href', `/projects/${project.id}/assets/${assetId}`);
  }
  // Not in the release: never on the page.
  await expect(page.locator(`a[data-comic-asset="${ids.cbr}"]`)).toHaveCount(0);
  const presentation = await savedPresentation(page);
  expect(presentation.join('\n')).toContain('Role Preview');
  await rdComic(page, ids.aIssue).hover();
  await page.waitForTimeout(300);
  expect(control.comic()).toEqual([]);

  // Read the saved a-issue: its own project/asset source, real pages.
  await rdComic(page, ids.aIssue).click();
  expect(await lastComicClick(page)).toEqual({ type: 'click', prevented: true });
  await readerReady(page, 'a-issue.cbz');
  expect(await state(page)).toMatchObject({ dialogs: 1, comic: { projectId: project.id, assetId: ids.aIssue, pageCount: 3 }, context: { filename: 'a-issue.cbz', projectName: project.title, projectId: String(project.id), assetId: String(ids.aIssue), detailsUrl: `/projects/${project.id}/assets/${ids.aIssue}` } });
  expect(control.manifests(project.id, ids.aIssue)).toHaveLength(1);
  expect(control.pages(project.id, ids.aIssue)[0]).toMatch(/\/pages\/1\?v=[0-9a-f]{32}$/);
  await choose(page, DIRECTION_MENU, 'Right-to-Left');
  await choose(page, LAYOUT_MENU, 'Two-Page Spread — Cover Alone');
  await page.locator(NEXT).click();
  await expect(page.locator(POSITION)).toHaveText('Pages 2–3 of 3');
  const { session } = await state(page);

  // An accepted refresh with unchanged hints reloads nothing.
  await acceptedRefresh(page, releaseId);
  expect(await state(page)).toMatchObject({ open: true, session, comic: { state: 'ready' } });
  await expect(page.locator(POSITION)).toHaveText('Pages 2–3 of 3');
  expect(control.manifests(project.id, ids.aIssue)).toHaveLength(1);
  expect(await savedPresentation(page)).toEqual(presentation);

  // Accept changed metadata with the same source hint through the real refresh.
  await page.evaluate(() => { window.p2bReleaseImage = document.querySelector('#unified-viewer-dialog .unified-viewer-page-image'); });
  const metadataUrl = (requestUrl) => requestUrl.pathname === url;
  await page.route(metadataUrl, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace('data-comic-filename="a-issue.cbz"', 'data-comic-filename="巻 01 café &amp; final!.cbz"')
      .replaceAll('data-comic-project-name="' + project.title + '"', 'data-comic-project-name="Updated project"');
    await route.fulfill({ response, body });
  });
  await acceptedRefresh(page, releaseId);
  expect((await state(page)).context).toMatchObject({ filename: '巻 01 café & final!.cbz', projectName: 'Updated project' });
  expect(control.manifests(project.id, ids.aIssue)).toHaveLength(1);
  expect(await page.evaluate(() => window.p2bReleaseImage === document.querySelector('#unified-viewer-dialog .unified-viewer-page-image'))).toBe(true);
  await page.unroute(metadataUrl);
  await acceptedRefresh(page, releaseId);
  expect((await state(page)).context).toMatchObject({ filename: 'a-issue.cbz', projectName: project.title });
  await page.evaluate(() => { delete window.p2bReleaseImage; });

  // A changed indexed hint: one fresh manifest in the same session, and the
  // page's link carries the current hint.
  const oldHint = await rdComic(page, ids.aIssue).getAttribute('data-comic-source-revision');
  project.rewriteAIssue();
  await acceptedRefresh(page, releaseId);
  await expect.poll(() => control.manifests(project.id, ids.aIssue).length).toBe(2);
  await expect.poll(async () => (await state(page)).comic?.pageCount).toBe(2);
  expect(await state(page)).toMatchObject({ open: true, session, comic: { state: 'ready' } });
  await expect(rdComic(page, ids.aIssue)).not.toHaveAttribute('data-comic-source-revision', oldHint);
  await acceptedRefresh(page, releaseId);
  await page.waitForTimeout(200);
  expect(control.manifests(project.id, ids.aIssue)).toHaveLength(2);
  expect((await state(page)).reader).toMatchObject({ direction: 'rtl', layout: 'spread' });

  // Removed from the saved selection (another tab's save): the reader
  // retires and its link becomes the plain Asset Details link.
  fixture.unselect(releaseId, ids.aIssue);
  await acceptedRefresh(page, releaseId);
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(await state(page)).toMatchObject({ open: false, comic: null, objectUrls: 0 });
  await expect(rdComic(page, ids.aIssue)).toHaveCount(0);
  const withdrawn = rdCardLink(page, ids.aIssue);
  await expect(withdrawn).toHaveAttribute('data-release-detail-comic-withdrawn', '');
  await expect(withdrawn).toHaveAttribute('aria-label', 'View details for a-issue.cbz');
  await expect(withdrawn).toHaveAttribute('href', `/projects/${project.id}/assets/${ids.aIssue}`);
  await expect(page.locator(':focus')).toHaveCount(1);
  expect(await page.evaluate(() => document.activeElement.isConnected && document.activeElement !== document.body)).toBe(true);
  const removed = control.comic().length;
  await withdrawn.click();
  expect(await lastComicClick(page)).toEqual({ type: 'click', prevented: false });
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(control.comic()).toHaveLength(removed);

  // The other saved comics still read; open b-issue in fullscreen.
  await rdComic(page, ids.bIssue).click();
  await readerReady(page, 'b-issue.cbz');
  await rdComic(page, ids.bIssue).evaluate((node) => {
    window.__oldComic = node;
    window.__cachedComic = node.cloneNode(true);
  });
  await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(async () => (await state(page)).fullscreen).toBe('card');
  const bManifests = control.manifests(project.id, ids.bIssue).length;

  // A current authoritative 404 retires the release: the reader closes,
  // fullscreen exits, every Read comic link is withdrawn for good.
  await page.route((requestUrl) => requestUrl.pathname === url, (route) => route.fulfill({
    status: 404, contentType: 'text/html', body: 'Release not found',
  }));
  await editSaved(page, releaseId);
  await expect(page.locator(`${SELECTED} [data-release-detail-comic-trigger]`)).toHaveCount(0);
  await expect(page.locator(`${SELECTED} [data-release-detail-viewer-trigger]`)).toHaveCount(0);
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect.poll(async () => (await state(page)).fullscreen).toBe(null);
  expect(await state(page)).toMatchObject({ open: false, comic: null, objectUrls: 0 });
  await expect(page.locator(`${DIALOG} img[src]`)).toHaveCount(0);
  await expect(rdSwitch(page)).toBeFocused();
  expect(await page.evaluate(() => window.__oldComic.isConnected)).toBe(false);
  await expect(page.locator('[data-dialog-feedback-text]')).toHaveText('This release no longer exists.');

  // Neither the withdrawn link, the detached opener nor a cached copy reopens.
  const retiredAt = control.comic().length;
  await rdCardLink(page, ids.bIssue).click();
  expect(await lastComicClick(page)).toEqual({ type: 'click', prevented: false });
  expect(await page.evaluate(async () => {
    const { openReleaseDetailComic } = await import('/client/release-detail-viewer.js');
    const cached = window.__cachedComic;
    document.querySelector('[data-selected-assets]').appendChild(cached);
    const result = [openReleaseDetailComic(document, window.__oldComic), openReleaseDetailComic(document, cached)];
    cached.remove();
    return result;
  })).toEqual([0, 0]);
  await editSaved(page, releaseId);
  await page.waitForTimeout(300);
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(control.comic()).toHaveLength(retiredAt);
  expect(control.manifests(project.id, ids.bIssue)).toHaveLength(bManifests);
  await page.unroute(() => true);

  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('Release Detail: List Read Comic, image and video behavior, and a 5xx that does not retire', async ({ page }) => {
  const project = await fixture.createProject();
  const { ids } = project;
  const releaseId = project.createRelease([ids.images[0], ids.cbr, ids.video]);
  const url = `/releases/${releaseId}`;
  const control = await openPage(page, `${url}?view=list`);
  await expect(rdComic(page, ids.cbr)).toHaveClass(/asset-list-card-media-(?:link|fallback)/);
  await expect(rdComic(page, ids.cbr)).toHaveAccessibleName('Read comic c-volume.cbr');
  await expect(page.locator(`${SELECTED} article[data-asset-id="${ids.cbr}"] [data-preview-image]`))
    .toHaveClass(/asset-list-card-media-image/);
  await page.waitForTimeout(200);
  expect(control.comic()).toEqual([]);

  // Keyboard activation in List.
  await rdComic(page, ids.cbr).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(TITLE)).toHaveText('c-volume.cbr');
  await expect.poll(async () => (await state(page)).comic?.state).toBe('ready');
  expect(control.manifests(project.id, ids.cbr)).toHaveLength(1);
  const { session } = await state(page);

  // A failing refresh (HTTP 503) is no evidence: the reader stays.
  await page.route((requestUrl) => requestUrl.pathname === url, (route) => route.fulfill({
    status: 503, contentType: 'text/html', body: 'Busy',
  }));
  await editSaved(page, releaseId);
  await expect(page.locator('[data-release-detail-refresh-retry]')).toHaveCount(1);
  expect(await state(page)).toMatchObject({ open: true, session, comic: { state: 'ready' } });
  await expect(rdComic(page, ids.cbr)).toHaveCount(1);
  await page.unroute(() => true);
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(rdComic(page, ids.cbr)).toBeFocused();

  // Image opens alone (never with the comic); video keeps its own dialog.
  await page.locator(`${SELECTED} a[data-release-detail-viewer-trigger][data-viewer-asset="${ids.images[0]}"]`).click();
  await expect.poll(async () => (await state(page)).titles).toEqual(['p01.png']);
  expect(await state(page)).toMatchObject({ comic: null, slideshow: false });
  await page.keyboard.press('Escape');
  await page.locator(`${SELECTED} a[data-asset-video-preview-trigger]`).click();
  await expect(page.locator(VIDEO_DIALOG)).toBeVisible();
  await expect(page.locator(DIALOG)).toBeHidden();
  await page.keyboard.press('Escape');
  expect(control.manifests(project.id, ids.cbr)).toHaveLength(1);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});
