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
import { formatProjectDirName } from '../../src/storage/project-storage.js';
import { bindTestProjectOwnership } from '../helpers/project-ownership.js';
import { makeZip } from '../helpers/zip-fixture.js';

// Read Comic on Project Assets and the Global Asset Library, in real Chromium
// against the compiled production bundle (built here into a temp directory)
// and Milestone A's real comic routes. An isolated installation (temp SQLite
// database, projects root and comic runtime) holds two projects whose comics
// share a filename; no user data is involved. Every request the page makes is
// recorded, so manifest and page requests are proven to start only from Read
// Comic (or an accepted source-hint change), and live refreshes run through
// the pages' own history navigation.

const DIALOG = '#unified-viewer-dialog';
const VIDEO_DIALOG = '#asset-video-preview-dialog';
const MEDIA = `${DIALOG} [data-unified-viewer-media]`;
const SHOWN = `${MEDIA} img:is(.unified-viewer-image, .unified-viewer-page-image):not([hidden])`;
const POSITION = `${DIALOG} [data-unified-viewer-position]`;
const TITLE = `${DIALOG} [data-unified-viewer-title]`;
const NEXT = `${DIALOG} [data-unified-viewer-next]`;
const DIRECTION_MENU = `${DIALOG} #unified-viewer-direction-dropdown`;
const LAYOUT_MENU = `${DIALOG} #unified-viewer-layout-dropdown`;
const LIBRARY = '/asset-viewer';
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-comic-host-activation-'));
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

  function createProject(title) {
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
    return { id: project.id, title, absDir, write, index };
  }

  // Sorted by filename, ten per page: page 1 holds both a-issue.cbz comics
  // and the CB7/CBR volumes; page 2 holds only images and the video.
  const alpha = createProject('Alpha Comics');
  const beta = createProject('Beta Comics');
  const ids = {
    alphaIssue: alpha.write('a-issue.cbz', makeZip(pages.map((data, index) => ({ name: `p${index + 1}.${index ? 'png' : 'jpg'}`, data })))),
    betaIssue: beta.write('a-issue.cbz', makeZip([{ name: 'b1.png', data: pages[2] }, { name: 'b2.png', data: pages[1] }])),
    cb7: alpha.write('c-volume.cb7', fs.readFileSync(path.join(FIXTURES, 'pages-nonsolid.7z'))),
    cbr: alpha.write('c-volume.cbr', fs.readFileSync(path.join(FIXTURES, 'rar5-compressed.rar'))),
    video: alpha.write('v-clip.mp4', Buffer.from('not a real video')),
    alphaImages: [],
    betaImages: [],
  };
  for (let index = 1; index <= 5; index += 1) {
    const png = await (await gradient(40, 40, index * 30)).png().toBuffer();
    ids.alphaImages.push(alpha.write(`p${index}.png`, png));
    ids.betaImages.push(beta.write(`p${index}.png`, png));
  }

  fixture = {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    alpha,
    beta,
    ids,
    // Replace the Alpha issue's bytes and re-index it, as a rescan would:
    // its indexed-source hint (and so its manifest revision) changes.
    rewriteAlphaIssue(count) {
      const full = path.join(alpha.absDir, 'a-issue.cbz');
      fs.writeFileSync(full, makeZip(pages.slice(0, count).map((data, index) => ({ name: `r${index + 1}.png`, data }))));
      const later = new Date(Date.now() + 60_000);
      fs.utimesSync(full, later, later);
      alpha.index('a-issue.cbz');
    },
    setPresent(assetId, present) {
      db.prepare('UPDATE assets SET is_present = ?, missing_since = ? WHERE id = ?')
        .run(present ? 1 : 0, present ? null : new Date().toISOString(), assetId);
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

// Records every request; mutations and comic requests are read back by path.
async function openPage(page, url, { viewport = { width: 1280, height: 900 } } = {}) {
  const control = { requests: [], mutations: [], errors: [] };
  page.on('pageerror', (error) => control.errors.push(error.message));
  page.on('request', (request) => {
    const parsed = new URL(request.url());
    control.requests.push(`${parsed.pathname}${parsed.search}`);
    if (request.method() !== 'GET') control.mutations.push(`${request.method()} ${parsed.pathname}`);
  });
  control.comic = () => control.requests.filter((entry) => /\/comic(\/pages\/\d+)?(\?|$)/.test(entry));
  control.manifests = (projectId, assetId) => control.requests.filter((entry) => entry === manifestPath(projectId, assetId));
  control.pages = (projectId, assetId) => control.requests.filter((entry) => entry.startsWith(`${manifestPath(projectId, assetId)}/pages/`));
  await page.setViewportSize(viewport);
  await page.goto(`${fixture.baseURL}${url}`);
  expect(await page.evaluate(() => Boolean(document.querySelector('script[type="module"][src^="/vite/"]')))).toBe(true);
  await page.waitForFunction(() => Boolean(document.getElementById('unified-viewer-dialog')?.__creatorCrateUnifiedViewer));
  await page.evaluate(() => { window.__sameDocument = true; });
  return control;
}

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
  };
});

const paComic = (page, assetId) => page.locator(`a[data-project-assets-comic-trigger][data-comic-asset="${assetId}"]:visible`);
const libComic = (page, projectId, assetId) => page.locator(
  `a[data-asset-library-comic-trigger][data-comic-project="${projectId}"][data-comic-asset="${assetId}"]:visible`,
);
const libRegion = (page) => page.locator('[data-asset-library-live-region]');

async function choose(page, menu, label) {
  await page.locator(`${menu} summary`).click();
  await expect(page.locator(menu)).toHaveAttribute('open', '');
  await page.locator(`${menu} .asset-filter-multiselect-panel`).getByText(label, { exact: true }).click();
  await expect(page.locator(menu)).not.toHaveAttribute('open', '');
}

async function waitForRegionSwap(page, action, selector = '[data-asset-library-live-region]') {
  await page.locator(selector).evaluate((node) => { node.dataset.beforeSwap = 'true'; });
  await action();
  await expect(page.locator(`${selector}:not([data-before-swap])`)).toHaveCount(1);
  await expect(page.locator(selector)).not.toHaveAttribute('aria-busy', 'true');
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
}

async function readerReady(page, title) {
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(page.locator(TITLE)).toHaveText(title);
  await expect.poll(async () => (await state(page)).comic?.state).toBe('ready');
}

test('Project Assets Grid: Read Comic opens the shared reader only on activation, reads pages and restores focus', async ({ page }) => {
  const { alpha, ids } = fixture;
  const control = await openPage(page, `/projects/${alpha.id}/assets?view=grid&sort=filename&order=asc`);
  const link = paComic(page, ids.alphaIssue);
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', new RegExp(`^/projects/${alpha.id}/assets/${ids.alphaIssue}(\\?|$)`));
  await expect(link.locator('img[data-preview-image]')).toBeVisible();
  await expect(link).not.toContainText('CBZ comic');
  await expect(link).toHaveAccessibleName('Read comic a-issue.cbz');
  for (const id of [ids.cb7, ids.cbr]) {
    await expect(page.locator(`article[data-asset-id="${id}"] img[data-preview-image]`)).toHaveAttribute('loading', 'lazy');
    await expect(paComic(page, id)).toBeVisible();
  }
  // The decorative Preview stays separate from Reader page requests.
  await expect(link.locator('img[data-preview-image]')).toHaveAttribute('loading', 'lazy');
  await expect(link.locator('img[data-preview-image]')).toHaveAttribute('src',
    new RegExp(`^/projects/${alpha.id}/assets/${ids.alphaIssue}/preview\\?v=[a-f0-9]{16}$`));
  await expect(link.locator('[data-comic-thumbnail]')).toHaveCount(0);

  // Hovering and selecting request no Reader manifest or pages.
  await link.hover();
  await page.locator(`a[data-project-assets-preview-id="${ids.alphaImages[0]}"]`).hover();
  const imageBox = page.locator(`#asset-card-select-${ids.alphaImages[1]}`);
  await imageBox.check();
  const comicBox = page.locator(`#asset-card-select-${ids.alphaIssue}`);
  await expect(comicBox).not.toBeChecked();
  await page.waitForTimeout(300);
  expect(control.comic()).toEqual([]);

  // Activation: the one shared dialog, one manifest, then page 1.
  await link.click();
  await readerReady(page, 'a-issue.cbz');
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 3');
  await expect(page.locator(SHOWN)).toHaveCount(1);
  expect(control.manifests(alpha.id, ids.alphaIssue)).toHaveLength(1);
  expect(control.pages(alpha.id, ids.alphaIssue)[0]).toMatch(/\/pages\/1\?v=[0-9a-f]{32}$/);
  const opened = await state(page);
  expect(opened).toMatchObject({ open: true, dialogs: 1, comic: { projectId: alpha.id, assetId: ids.alphaIssue }, context: { projectId: String(alpha.id), assetId: String(ids.alphaIssue), filename: 'a-issue.cbz', projectName: alpha.title, detailsUrl: await link.getAttribute('href') } });
  // The host passes the server's indexed hint, not the manifest revision.
  expect(opened.comic.sourceRevision).toBe(await link.getAttribute('data-comic-source-revision'));
  expect(opened.comic.sourceRevision).not.toBe(opened.comic.revision);
  // Reading toggled neither checkbox.
  await expect(imageBox).toBeChecked();
  await expect(comicBox).not.toBeChecked();

  await page.locator(NEXT).click();
  await expect(page.locator(POSITION)).toHaveText('Page 2 of 3');
  await choose(page, DIRECTION_MENU, 'Right-to-Left');
  await choose(page, LAYOUT_MENU, 'Two-Page Spread — Cover Alone');
  await expect(page.locator(POSITION)).toHaveText('Pages 2–3 of 3');
  await expect(page.locator(SHOWN)).toHaveCount(2);
  expect((await state(page)).reader).toMatchObject({ direction: 'rtl', layout: 'spread' });
  expect(control.manifests(alpha.id, ids.alphaIssue)).toHaveLength(1);

  // Fullscreen first, then close: focus returns to the connected opener.
  await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(async () => (await state(page)).fullscreen).toBe('card');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await state(page)).fullscreen).toBe(null);
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(link).toBeFocused();

  // CB7 and CBR activate through the same project-qualified endpoints.
  for (const [assetId, title] of [[ids.cb7, 'c-volume.cb7'], [ids.cbr, 'c-volume.cbr']]) {
    await paComic(page, assetId).click();
    await expect(page.locator(TITLE)).toHaveText(title);
    await expect.poll(async () => (await state(page)).comic?.state).not.toBe('loading');
    expect(control.manifests(alpha.id, assetId)).toHaveLength(1);
    await page.keyboard.press('Escape');
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(paComic(page, assetId)).toBeFocused();
  }

  // The image thumbnail still opens one image; the slideshow stays image-only.
  await page.locator(`a[data-project-assets-preview-id="${ids.alphaImages[2]}"]`).click();
  await expect.poll(async () => (await state(page)).titles).toEqual(['p3.png']);
  expect((await state(page)).comic).toBeNull();
  await page.keyboard.press('Escape');
  await page.locator('[data-project-assets-slideshow-trigger]').click();
  await expect.poll(async () => (await state(page)).titles).toEqual(['p1.png', 'p2.png', 'p3.png', 'p4.png', 'p5.png']);
  expect((await state(page)).slideshow).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();

  // The video keeps its own preview dialog.
  await page.locator('a[data-asset-video-preview-trigger]').click();
  await expect(page.locator(VIDEO_DIALOG)).toBeVisible();
  await expect(page.locator(DIALOG)).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator(VIDEO_DIALOG)).toBeHidden();

  // A live refresh (List, then Back to Grid) while the reader is open keeps
  // it and its page; Close focuses the connected replacement link.
  const PA_REGION = '[data-project-assets-live-region]';
  await waitForRegionSwap(page, () => page.locator('nav.view-switcher a[aria-label="List view"]').click(), PA_REGION);
  expect(control.comic().filter((entry) => !entry.startsWith(manifestPath(alpha.id, ids.cb7))
    && !entry.startsWith(manifestPath(alpha.id, ids.cbr)) && !entry.startsWith(manifestPath(alpha.id, ids.alphaIssue)))).toEqual([]);
  await paComic(page, ids.alphaIssue).focus();
  await page.keyboard.press('Enter');
  await readerReady(page, 'a-issue.cbz');
  await page.locator(NEXT).click();
  const { session } = await state(page);
  await waitForRegionSwap(page, () => page.goBack(), PA_REGION);
  await expect(page.locator(POSITION)).toHaveText(/Pages? 2/);
  expect(await state(page)).toMatchObject({ open: true, session, comic: { state: 'ready' } });
  expect(control.manifests(alpha.id, ids.alphaIssue)).toHaveLength(2);
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(paComic(page, ids.alphaIssue)).toBeFocused();
  await expect(paComic(page, ids.alphaIssue)).toHaveClass('asset-card-media-link');
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('Project Assets List: keyboard activation, modified and middle clicks, and Details navigation', async ({ page }) => {
  const { alpha, ids } = fixture;
  const control = await openPage(page, `/projects/${alpha.id}/assets?view=list&sort=filename&order=asc`);
  const link = paComic(page, ids.alphaIssue);
  await expect(link).toHaveAttribute('aria-label', 'Read comic a-issue.cbz from Alpha Comics');
  await link.hover();
  await page.locator(`#asset-list-card-select-${ids.alphaImages[0]}`).check();
  expect(control.comic()).toEqual([]);

  // Keyboard: Enter on the focused link opens the same reader.
  await link.focus();
  await page.keyboard.press('Enter');
  await readerReady(page, 'a-issue.cbz');
  expect(control.manifests(alpha.id, ids.alphaIssue)).toHaveLength(1);
  expect(page.url()).toContain(`/projects/${alpha.id}/assets`);
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(link).toBeFocused();

  // Ctrl+Click and Shift+Click open the details page in a new tab/window.
  const href = new URL(await link.getAttribute('href'), fixture.baseURL).href;
  for (const modifiers of [['Control'], ['Shift']]) {
    const popup = page.context().waitForEvent('page');
    await link.click({ modifiers });
    const opened = await popup;
    await opened.waitForURL((url) => url.pathname === new URL(href).pathname);
    await opened.close();
    await expect(page.locator(DIALOG)).toBeHidden();
  }
  // Middle click is left to the browser (its auxclick is never prevented).
  // Headless Chromium opens that tab blank, for image links alike, so the
  // tab's URL is not asserted.
  await page.evaluate(() => {
    window.__auxclicks = [];
    window.addEventListener('auxclick', (event) => window.__auxclicks.push(event.defaultPrevented));
  });
  const middlePopup = page.context().waitForEvent('page');
  await link.click({ button: 'middle' });
  await (await middlePopup).close();
  expect(await page.evaluate(() => window.__auxclicks)).toEqual([false]);
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(control.manifests(alpha.id, ids.alphaIssue)).toHaveLength(1);
  await expect(page.locator(`#asset-list-card-select-${ids.alphaImages[0]}`)).toBeChecked();
  expect(control.mutations).toEqual([]);

  // An unmodified click on the row's own details navigation still navigates.
  await page.locator(`.asset-list-card[data-asset-id="${ids.alphaIssue}"] .dashboard-title-info-trigger, .asset-list-card[data-asset-id="${ids.alphaIssue}"] [data-dashboard-title-info] button`).first().click();
  const openAsset = page.locator(`#project-asset-list-info-${ids.alphaIssue}`).getByRole('link', { name: 'Open asset' });
  await expect(openAsset).toBeVisible();
  await openAsset.click();
  await page.waitForURL(new RegExp(`/projects/${alpha.id}/assets/${ids.alphaIssue}(\\?|$)`));
  expect(control.errors).toEqual([]);
});

test('Asset Library: project-qualified Read Comic in Grid and List, image-only slideshow', async ({ page }) => {
  const { alpha, beta, ids } = fixture;
  const control = await openPage(page, `${LIBRARY}?view=grid&sort=filename&order=asc&pageSize=10`);
  await expect(page.locator('a[data-asset-library-comic-trigger]:visible')).toHaveCount(4);
  await libComic(page, beta.id, ids.betaIssue).hover();
  await page.waitForTimeout(300);
  expect(control.comic()).toEqual([]);

  // Same filename in two projects: each opens its own endpoints.
  for (const [project, assetId, pageCount] of [[beta, ids.betaIssue, 2], [alpha, ids.alphaIssue, 3]]) {
    await libComic(page, project.id, assetId).focus();
    await page.keyboard.press('Enter');
    await readerReady(page, 'a-issue.cbz');
    expect(await state(page)).toMatchObject({ dialogs: 1, comic: { projectId: project.id, assetId, pageCount }, context: { projectId: String(project.id), assetId: String(assetId), filename: 'a-issue.cbz', projectName: project.title, detailsUrl: await libComic(page, project.id, assetId).getAttribute('href') } });
    expect(control.manifests(project.id, assetId)).toHaveLength(1);
    expect(control.pages(project.id, assetId).length).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(page.locator(DIALOG)).toBeHidden();
    await expect(libComic(page, project.id, assetId)).toBeFocused();
  }
  expect(control.comic().every((entry) => entry.startsWith(manifestPath(alpha.id, ids.alphaIssue))
    || entry.startsWith(manifestPath(beta.id, ids.betaIssue)))).toBe(true);

  // List view (a live refresh) keeps the project-qualified links; a mouse
  // click opens the reader.
  await waitForRegionSwap(page, () => page.locator('nav.view-switcher a[aria-label="List view"]').click());
  await libComic(page, beta.id, ids.betaIssue).click();
  await readerReady(page, 'a-issue.cbz');
  expect((await state(page)).comic).toMatchObject({ projectId: beta.id, assetId: ids.betaIssue });
  await page.keyboard.press('Escape');
  await expect(libComic(page, beta.id, ids.betaIssue)).toBeFocused();

  // The image slideshow holds only images from both projects (all pages).
  await page.locator('[data-asset-library-slideshow-trigger]').click();
  await expect.poll(async () => (await state(page)).count).toBe(10);
  expect((await state(page)).titles.every((title) => title.endsWith('.png'))).toBe(true);
  const contexts = await page.evaluate(() => {
    const viewer = document.getElementById('unified-viewer-dialog').__creatorCrateUnifiedViewer;
    viewer.playback.pause();
    const entries = JSON.parse(document.querySelector('[data-asset-library-viewer-sequence]').textContent);
    const contexts = [];
    for (let index = 0; index < entries.length; index += 1) {
      const context = viewer.getState().context;
      const entry = entries.find((item) => String(item.id) === context.assetId && String(item.projectId) === context.projectId);
      contexts.push({ context, entry });
      viewer.next();
    }
    return contexts;
  });
  expect(new Set(contexts.map(({ context }) => context.projectId)).size).toBe(2);
  for (const { context, entry } of contexts) {
    expect(context).toEqual({ filename: entry.filename, projectId: String(entry.projectId), assetId: String(entry.id), projectName: null, detailsUrl: entry.viewerUrl });
  }
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('reader preferences follow the comic between Project Assets and Asset Library despite identical filenames', async ({ page }) => {
  const { alpha, beta, ids } = fixture;
  await openPage(page, `/projects/${alpha.id}/assets?view=grid&sort=filename&order=asc`);
  await paComic(page, ids.alphaIssue).click();
  await readerReady(page, 'a-issue.cbz');
  await choose(page, DIRECTION_MENU, 'Right-to-Left');
  await choose(page, LAYOUT_MENU, 'Two-Page Spread — Cover Alone');
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();

  await openPage(page, `${LIBRARY}?view=grid&sort=filename&order=asc&pageSize=10`);
  await libComic(page, beta.id, ids.betaIssue).click();
  await readerReady(page, 'a-issue.cbz');
  await expect(page.locator(`${DIRECTION_MENU} [data-cc-dropdown-summary-current]`)).toHaveText('Left-to-Right');
  await expect(page.locator(`${LAYOUT_MENU} [data-cc-dropdown-summary-current]`)).toHaveText('Single Page');
  await choose(page, LAYOUT_MENU, 'Two-Page Spread — Pair from Page 1');
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();

  await libComic(page, alpha.id, ids.alphaIssue).click();
  await readerReady(page, 'a-issue.cbz');
  await expect(page.locator(`${DIRECTION_MENU} [data-cc-dropdown-summary-current]`)).toHaveText('Right-to-Left');
  await expect(page.locator(`${LAYOUT_MENU} [data-cc-dropdown-summary-current]`)).toHaveText('Two-Page Spread — Cover Alone');
  await expect(page.locator(POSITION)).toHaveText('Page 1 of 3');
  await page.locator(NEXT).click();
  await expect(page.locator(POSITION)).toHaveText('Pages 2–3 of 3');
});

test('Asset Library refresh: off-page omission keeps the reader, a changed hint reloads once, stale and foreign results change nothing', async ({ page }) => {
  const { alpha, beta, ids } = fixture;
  const firstUrl = `${LIBRARY}?view=grid&sort=filename&order=asc&pageSize=10`;
  const control = await openPage(page, firstUrl);
  const pageOneUrl = page.url();
  // History: page 1 → page 2 → back to page 1, all live refreshes.
  await waitForRegionSwap(page, () => page.locator('nav.pagination a', { hasText: /Next/ }).click());
  const pageTwoUrl = page.url();
  expect(pageTwoUrl).not.toBe(pageOneUrl);
  await expect(page.locator('a[data-asset-library-comic-trigger]')).toHaveCount(0);
  await waitForRegionSwap(page, () => page.goBack());
  // Rendering and paginating requested no comic data.
  expect(control.comic()).toEqual([]);

  await libComic(page, alpha.id, ids.alphaIssue).focus();
  await page.keyboard.press('Enter');
  await readerReady(page, 'a-issue.cbz');
  await page.locator(NEXT).click();
  await expect(page.locator(POSITION)).toHaveText('Page 2 of 3');
  const { session, context } = await state(page);
  const manifests = () => control.manifests(alpha.id, ids.alphaIssue).length;
  expect(manifests()).toBe(1);

  // Off-page: the comic is absent from page 2. Not a deletion.
  await waitForRegionSwap(page, () => page.goForward());
  expect(page.url()).toBe(pageTwoUrl);
  await expect(page.locator(POSITION)).toHaveText('Page 2 of 3');
  expect(await state(page)).toMatchObject({ open: true, session, comic: { state: 'ready', assetId: ids.alphaIssue } });

  // Back on page 1 with an unchanged hint: page and media kept, no request.
  await waitForRegionSwap(page, () => page.goBack());
  await expect(page.locator(POSITION)).toHaveText('Page 2 of 3');
  expect(await state(page)).toMatchObject({ open: true, session });
  expect(manifests()).toBe(1);

  // A foreign result: only project Beta, whose a-issue.cbz is now missing.
  fixture.setPresent(ids.betaIssue, false);
  try {
    await waitForRegionSwap(page, () => page.goForward());
    await waitForRegionSwap(page, () => page.goBack());
    expect(await state(page)).toMatchObject({ open: true, session, comic: { assetId: ids.alphaIssue } });
    expect(manifests()).toBe(1);
  } finally {
    fixture.setPresent(ids.betaIssue, true);
  }

  // A stale result proving ineligibility is superseded and never installed.
  let releaseStale;
  const held = new Promise((resolve) => { releaseStale = resolve; });
  let staleRequests = 0;
  const isPageOne = (url) => url.pathname === LIBRARY && !url.searchParams.has('page');
  await waitForRegionSwap(page, () => page.goForward());
  await page.route(isPageOne, async (route) => {
    staleRequests += 1;
    await held;
    await route.continue().catch(() => {});
  });
  await page.goBack();
  await expect.poll(() => staleRequests).toBe(1);
  await waitForRegionSwap(page, () => page.goForward());
  fixture.setPresent(ids.alphaIssue, false);
  releaseStale();
  await page.waitForTimeout(500);
  await page.unroute(isPageOne);
  fixture.setPresent(ids.alphaIssue, true);
  expect(page.url()).toBe(pageTwoUrl);
  expect(await state(page)).toMatchObject({ open: true, session, context, comic: { state: 'ready' } });
  expect(manifests()).toBe(1);

  // A changed authoritative hint on the current page reloads exactly once.
  await choose(page, DIRECTION_MENU, 'Right-to-Left');
  await choose(page, LAYOUT_MENU, 'Two-Page Spread — Pair from Page 1');
  const before = (await state(page)).comic;
  fixture.rewriteAlphaIssue(2);
  await waitForRegionSwap(page, () => page.goBack());
  await expect.poll(manifests).toBe(2);
  await expect.poll(async () => (await state(page)).comic?.state).toBe('ready');
  const after = (await state(page)).comic;
  expect(after).toMatchObject({ pageCount: 2 });
  expect(after.sourceRevision).not.toBe(before.sourceRevision);
  expect(after.revision).not.toBe(before.revision);
  expect(await state(page)).toMatchObject({ open: true, session });
  await expect(page.locator(POSITION)).toHaveText('Pages 1–2 of 2');
  await waitForRegionSwap(page, () => page.goForward());
  await waitForRegionSwap(page, () => page.goBack());
  await page.waitForTimeout(300);
  expect(manifests()).toBe(2);

  // The opener was replaced by refreshes: Close focuses the connected
  // replacement link of the same project-qualified comic.
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(libComic(page, alpha.id, ids.alphaIssue)).toBeFocused();
  expect(page.url()).toBe(pageOneUrl);
  expect(control.comic().some((entry) => entry.startsWith(manifestPath(beta.id, ids.betaIssue)))).toBe(false);
  await libComic(page, alpha.id, ids.alphaIssue).click();
  await readerReady(page, 'a-issue.cbz');
  await expect(page.locator(`${DIRECTION_MENU} [data-cc-dropdown-summary-current]`)).toHaveText('Right-to-Left');
  await expect(page.locator(`${LAYOUT_MENU} [data-cc-dropdown-summary-current]`)).toHaveText('Two-Page Spread — Pair from Page 1');
  await expect(page.locator(POSITION)).toHaveText('Pages 1–2 of 2');
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('Asset Library refresh: an accepted card proving the comic missing retires the reader with connected focus', async ({ page }) => {
  const { alpha, ids } = fixture;
  const control = await openPage(page, `${LIBRARY}?view=list&sort=filename&order=asc&pageSize=10`);
  await waitForRegionSwap(page, () => page.locator('nav.pagination a', { hasText: /Next/ }).click());
  await waitForRegionSwap(page, () => page.goBack());
  await libComic(page, alpha.id, ids.alphaIssue).click();
  await readerReady(page, 'a-issue.cbz');
  fixture.setPresent(ids.alphaIssue, false);
  try {
    await waitForRegionSwap(page, () => page.goForward());
    await expect(page.locator(DIALOG)).toBeVisible();
    await waitForRegionSwap(page, () => page.goBack());
    await expect(page.locator(DIALOG)).toBeHidden();
    expect((await state(page)).open).toBe(false);
    await expect(libComic(page, alpha.id, ids.alphaIssue)).toHaveCount(0);
    // The opener is gone: focus lands on the connected Slideshow button.
    await expect(page.locator('[data-asset-library-slideshow-trigger]')).toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.isConnected)).toBe(true);
    expect(control.manifests(alpha.id, ids.alphaIssue)).toHaveLength(1);
  } finally {
    fixture.setPresent(ids.alphaIssue, true);
  }
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});


for (const host of ['project-assets', 'asset-library']) {
  test(host + ': accepted metadata-only hints preserve media and partial fields', async ({ page }) => {
    const { alpha, ids } = fixture;
    const url = host === 'project-assets' ? '/projects/' + alpha.id + '/assets?view=grid&pageSize=all' : LIBRARY + '?view=grid&pageSize=all';
    const control = await openPage(page, url);
    const link = host === 'project-assets' ? paComic(page, ids.alphaIssue) : libComic(page, alpha.id, ids.alphaIssue);
    await link.click();
    await readerReady(page, 'a-issue.cbz');
    const initial = (await state(page)).context;
    const requests = control.comic().length;
    await page.evaluate(() => { window.p2bImage = document.querySelector('#unified-viewer-dialog .unified-viewer-page-image'); });
    async function hint(attributes) {
      await link.evaluate(async (node, { host, attributes }) => {
        for (const [key, value] of Object.entries(attributes)) {
          if (value === null) node.removeAttribute(key); else node.setAttribute(key, value);
        }
        const adapter = await import('/client/' + host + '-viewer.js');
        adapter[host === 'project-assets' ? 'refreshProjectAssetsViewer' : 'refreshAssetLibraryViewer'](document);
      }, { host, attributes });
    }
    await hint({ 'data-comic-filename': '巻 01 café & final!.cbz', 'data-comic-project-name': 'Updated project' });
    expect((await state(page)).context).toEqual({ ...initial, filename: '巻 01 café & final!.cbz', projectName: 'Updated project' });
    await hint({ 'data-comic-filename': null, 'data-comic-project-name': null, 'data-comic-details-url': null });
    expect((await state(page)).context).toEqual({ ...initial, filename: '巻 01 café & final!.cbz', projectName: 'Updated project' });
    await hint({ 'data-comic-project-name': '' });
    expect((await state(page)).context.projectName).toBeNull();
    await hint({ 'data-comic-filename': '' });
    expect((await state(page)).context.filename).toBe('');
    expect(await page.evaluate(() => window.p2bImage === document.querySelector('#unified-viewer-dialog .unified-viewer-page-image'))).toBe(true);
    expect(control.comic()).toHaveLength(requests);
    await page.locator(DIALOG).locator('[data-unified-viewer-details]').evaluate((node, href) => { if (node.getAttribute('href') !== href) throw Error('Wrong details destination'); }, initial.detailsUrl);
    // No project-name decoration is required to reopen this comic.
    await page.keyboard.press('Escape');
    await link.click();
    await expect.poll(async () => (await state(page)).comic?.state).toBe('ready');
    expect((await state(page)).context).toEqual({ ...initial, filename: '', projectName: null, detailsUrl: '/projects/' + alpha.id + '/assets/' + ids.alphaIssue });
    // An authoritative card proving ineligibility retires actionable context.
    const card = page.locator('article[data-asset-id="' + ids.alphaIssue + '"]' +
      (host === 'asset-library' ? '[data-asset-project-id="' + alpha.id + '"]' : ''));
    const triggers = card.locator('[data-' + host + '-comic-trigger]');
    await expect(triggers).toHaveCount(2);
    expect(await card.evaluate(async (node, host) => {
      node.querySelectorAll('[data-' + host + '-comic-trigger]').forEach((trigger) => trigger.remove());
      const adapter = await import('/client/' + host + '-viewer.js');
      adapter[host === 'project-assets' ? 'refreshProjectAssetsViewer' : 'refreshAssetLibraryViewer'](document);
      return node.isConnected && node === document.querySelector('article[data-asset-id="' + node.dataset.assetId + '"]' +
        (host === 'asset-library' ? '[data-asset-project-id="' + node.dataset.assetProjectId + '"]' : ''));
    }, host)).toBe(true);
    await expect(triggers).toHaveCount(0);
    expect((await state(page)).context).toBeNull();
    await expect(page.locator(DIALOG)).toBeHidden();
    await page.evaluate(() => { delete window.p2bImage; });
  });
}
