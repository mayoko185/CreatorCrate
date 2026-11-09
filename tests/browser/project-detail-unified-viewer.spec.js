import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import yazl from 'yazl';
import { createApp } from '../../src/app.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { createReleaseRepository } from '../../src/data/release-repository.js';
import { createReleaseService } from '../../src/services/release-service.js';

// B7c: Project Detail opens eligible release-strip image thumbnails in the
// unified viewer (single image only) on the real page with isolated SQLite and
// filesystem data. Viewing never changes the project or a release: strip
// membership, order, the display limit and every release link stay as they
// were and nothing but GETs is sent. The Releases section sits outside every
// Project Detail refresh region, so an Edit Project save or an Archive in
// place leaves the strips (and their triggers) as they were; a Delete that
// retires the page withdraws them. Everything lives in a temporary root
// removed afterwards.

const DIALOG = '#unified-viewer-dialog';
const VIDEO_DIALOG = '#asset-video-preview-dialog';
const TRIGGER = 'data-project-detail-viewer-trigger';
const EMPTY_ZIP = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;
let releaseService;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-project-detail-viewer-'));
  projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  app = createApp(
    { appName: 'CreatorCrate', db, projectsRoot, previewRoot: path.join(root, 'previews') },
    { appDataRoot, authState: { csrfPepper } },
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  releaseService = createReleaseService({ db });
});

test.afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (db) closeDatabase(db);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function png(size = 40, shade = 90) {
  return sharp({ create: { width: size, height: size, channels: 3, background: { r: shade, g: 90, b: 160 } } }).png().toBuffer();
}

function kritaArchive(merged) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('application/x-krita'), 'mimetype', { compress: false });
    zip.addBuffer(merged, 'mergedimage.png');
    zip.end();
    const chunks = [];
    zip.outputStream.on('data', (chunk) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

// One project with four releases:
//  - Mixed: b.png, a.png (saved order), a video, a Krita image, a CBZ comic,
//    a text file, an image that goes missing, and one/same.png.
//  - Shared: two/same.png and b.png (b.png is in both strips).
//  - Empty: nothing selected.
//  - Full: 13 images (the strip shows 12 and "+1 more").
let projectCount = 0;
async function createProject() {
  projectCount += 1;
  const project = app.locals.projectService.create({ title: `Strip Viewer ${projectCount}`, status: 'tbd' });
  const dir = path.join(projectsRoot, project.project_dir);
  fs.mkdirSync(path.join(dir, 'one'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'two'), { recursive: true });
  const write = async (relativePath, buffer) => fs.writeFileSync(path.join(dir, relativePath), await buffer);
  await write('a.png', png(40, 10));
  await write('b.png', png(40, 60));
  await write('one/same.png', png(40, 110));
  await write('two/same.png', png(40, 160));
  await write('gone.png', png(40, 200));
  await write('paint.kra', kritaArchive(await png(44, 220)));
  fs.writeFileSync(path.join(dir, 'clip.mp4'), Buffer.from('not really a video'));
  fs.writeFileSync(path.join(dir, 'book.cbz'), EMPTY_ZIP);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'notes');
  for (let index = 0; index < 13; index += 1) await write(`fill-${String(index).padStart(2, '0')}.png`, png(24, index * 15));
  app.locals.assetScanner.scanProjectAssets(project.id);
  const id = (relativePath) => String(db.prepare('SELECT id FROM assets WHERE project_id = ? AND relative_path = ?')
    .get(project.id, relativePath)?.id);
  const create = (title, paths) => releaseService.createReleaseWithSelectedAssets(project.id, { title },
    paths.map((relativePath) => Number(id(relativePath))));
  const mixedPaths = ['b.png', 'a.png', 'clip.mp4', 'paint.kra', 'book.cbz', 'notes.txt', 'gone.png', 'one/same.png'];
  const fillPaths = Array.from({ length: 13 }, (_, index) => `fill-${String(index).padStart(2, '0')}.png`);
  const mixed = create(`Mixed ${projectCount}`, mixedPaths);
  const shared = create(`Shared ${projectCount}`, ['two/same.png', 'b.png']);
  const empty = createReleaseRepository(db).create({
    projectId: project.id, title: `Empty ${projectCount}`, description: '', notes: '', plannedDate: null, plannedTime: null, patreonUrl: null, publishedDate: null,
  });
  const full = create(`Full ${projectCount}`, fillPaths);
  fs.rmSync(path.join(dir, 'gone.png'));
  app.locals.assetScanner.scanProjectAssets(project.id);
  return {
    projectId: String(project.id),
    url: `/projects/${project.id}`,
    id,
    releases: { mixed, shared, empty, full },
    fillIds: fillPaths.map(id),
  };
}

async function open(page, url, { viewport = { width: 1280, height: 900 } } = {}) {
  const control = { mutations: [], errors: [], comic: [] };
  page.on('pageerror', (error) => control.errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() !== 'GET') control.mutations.push(`${request.method()} ${request.url()}`);
    if (/\/comic(\/|$|\?)/.test(new URL(request.url()).pathname)) control.comic.push(request.url());
  });
  await page.setViewportSize(viewport);
  await page.goto(`${baseURL}${url}`);
  await page.waitForFunction(async () => {
    const viewer = await import('/client/unified-viewer.js');
    return Boolean(viewer.unifiedViewerFor(document));
  });
  await page.evaluate(() => { window.__sameDocument = true; });
  return control;
}

async function viewerState(page) {
  return page.evaluate(async () => {
    const { unifiedViewerFor } = await import('/client/unified-viewer.js');
    const viewer = unifiedViewerFor(document);
    const state = viewer.getState();
    const media = viewer.media.getState();
    return {
      open: state.open,
      session: state.session,
      key: state.key,
      sourceKey: state.source?.key ?? null,
      mode: state.source?.mode ?? null,
      slideshow: state.source?.slideshow ?? null,
      wrap: state.source?.wrap ?? null,
      titles: state.source ? state.source.items.map((item) => item.title) : [],
      count: state.count,
      mediaUrl: state.item?.mediaUrl ?? null,
      originalUrl: state.item?.originalUrl ?? null,
      detailsUrl: state.item?.detailsUrl ?? null,
      revision: state.item?.revision ?? null,
      media: { status: media.status, width: media.width },
      original: media.original?.status ?? null,
      playback: state.playback,
      fullscreenElement: document.fullscreenElement
        ? (document.fullscreenElement.matches('[data-unified-viewer-card]') ? 'card' : 'other')
        : null,
    };
  });
}

const item = (page, releaseId) => page.locator(`.project-detail-releases .release-list > li:has(> a[href="/releases/${releaseId}"])`);
const thumb = (page, releaseId, assetId) => item(page, releaseId).locator(`a[${TRIGGER}][data-viewer-asset="${assetId}"]`);
const releaseTitle = (page, releaseId) => item(page, releaseId).locator(`> a[href="/releases/${releaseId}"]`);
const title = (page) => page.locator(`${DIALOG} [data-unified-viewer-title]`);
const shownImage = (page) => page.locator(`${DIALOG} [data-unified-viewer-media] img.unified-viewer-image:not([hidden])`);
// Every strip tile in order: [release, kind, asset].
const presentedStrips = (page) => page.locator('.project-detail-releases .release-thumbnail-strip').evaluateAll((strips) => strips.map((strip) => [
  strip.closest('li').querySelector(':scope > a').getAttribute('href'),
  ...Array.from(strip.querySelectorAll('a')).map((link) => `${link.className}|${link.getAttribute('href')}`),
]));
const savedMembership = () => db.prepare('SELECT release_id, asset_id, role, sort_order FROM release_assets ORDER BY release_id, sort_order')
  .all().map((row) => `${row.release_id}:${row.asset_id}:${row.role}:${row.sort_order}`);
const savedReleases = () => db.prepare('SELECT id, title, published_date, archived_at, updated_at FROM releases ORDER BY id').all();

async function closeViewer(page) {
  await page.locator(`${DIALOG} [data-dialog-close]`).click();
  await expect(page.locator(DIALOG)).toBeHidden();
}

test('a strip thumbnail opens only its image; strips, releases, URL and scroll survive', async ({ page }) => {
  const f = await createProject();
  const { mixed, shared, full } = f.releases;
  const control = await open(page, f.url);
  const [a, b] = ['a.png', 'b.png'].map(f.id);
  const membership = savedMembership();
  const releases = savedReleases();
  const strips = await presentedStrips(page);
  // Mixed: b, a, Krita, one/same; Shared: two/same, b; Full: 12 of 13.
  await expect(page.locator(`[${TRIGGER}]`)).toHaveCount(4 + 2 + 12);
  await expect(page.locator('[data-release-detail-viewer-trigger], [data-release-assets-viewer-trigger]')).toHaveCount(0);
  await expect(item(page, full.id).locator(`a[${TRIGGER}]`)).toHaveCount(12);
  await expect(item(page, full.id).locator('a.release-thumbnail-more')).toHaveText('+1 more');

  await thumb(page, mixed.id, a).click();
  await expect(page.locator(DIALOG)).toBeVisible();
  await expect(title(page)).toHaveText('a.png');
  await expect(shownImage(page)).toBeVisible();
  await expect.poll(async () => (await viewerState(page)).media).toEqual({ status: 'loaded', width: 40 });
  const state = await viewerState(page);
  expect(state).toMatchObject({
    open: true, mode: 'single', slideshow: false, wrap: false, count: 1, titles: ['a.png'],
    sourceKey: `project-detail:${f.projectId}:release:${mixed.id}`,
    originalUrl: `/projects/${f.projectId}/assets/${a}/original`,
    detailsUrl: `/projects/${f.projectId}/assets/${a}`,
    playback: { available: false, playing: false },
  });
  expect(state.mediaUrl.startsWith(`/projects/${f.projectId}/assets/${a}/preview?v=`)).toBe(true);
  expect(state.mediaUrl).toContain(state.revision);
  // Single image: no Previous/Next, no playback; the view tools stay visible.
  await expect(page.locator(`${DIALOG} [data-unified-viewer-controls]`)).toBeHidden();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-playback]`)).toBeHidden();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-view-tools]`)).toBeVisible();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-details]`)).toHaveAttribute('href', `/projects/${f.projectId}/assets/${a}`);
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  const scrollY = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('ArrowRight');
  await expect(title(page)).toHaveText('a.png');

  // Fit, zoom and Original Size.
  await page.locator(`${DIALOG} [data-unified-viewer-zoom-in]`).click();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-fit]`)).toBeEnabled();
  await page.locator(`${DIALOG} [data-unified-viewer-fit]`).click();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-zoom-level]`)).toHaveText('Fit');
  await page.locator(`${DIALOG} [data-unified-viewer-original]`).click();
  await expect.poll(async () => (await viewerState(page)).original).toBe('active');

  // Fullscreen: Escape leaves fullscreen first, then closes.
  await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe('card');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe(null);
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(thumb(page, mixed.id, a)).toBeFocused();
  expect(page.url()).toBe(baseURL + f.url);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');

  // Keyboard activation opens it again.
  await page.keyboard.press('Enter');
  await expect(title(page)).toHaveText('a.png');
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(thumb(page, mixed.id, a)).toBeFocused();

  // Closing from fullscreen with the close button.
  await thumb(page, shared.id, b).click();
  await expect(title(page)).toHaveText('b.png');
  await page.locator(DIALOG).getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe('card');
  await closeViewer(page);
  await expect.poll(async () => (await viewerState(page)).fullscreenElement).toBe(null);
  await expect(thumb(page, shared.id, b)).toBeFocused();

  // A modified click is left to the browser (observed, then stopped here).
  await page.evaluate(() => {
    window.__modifiedClick = null;
    window.addEventListener('click', (event) => {
      window.__modifiedClick = { prevented: event.defaultPrevented };
      event.preventDefault();
    }, { once: true });
  });
  await thumb(page, mixed.id, b).click({ modifiers: ['Control'] });
  expect(await page.evaluate(() => window.__modifiedClick)).toEqual({ prevented: false });
  // Middle click is left to the browser too.
  await page.evaluate(() => {
    window.__auxClick = null;
    window.addEventListener('auxclick', (event) => {
      window.__auxClick = { prevented: event.defaultPrevented };
      event.preventDefault();
    }, { once: true });
  });
  await thumb(page, mixed.id, b).click({ button: 'middle' });
  expect(await page.evaluate(() => window.__auxClick)).toEqual({ prevented: false });
  await expect(page.locator(DIALOG)).toBeHidden();

  // Nothing about the project or its releases changed.
  expect(savedMembership()).toEqual(membership);
  expect(savedReleases()).toEqual(releases);
  expect(await presentedStrips(page)).toEqual(strips);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
  expect(control.comic).toEqual([]);

  // View Details in the viewer navigates to Asset Details.
  await thumb(page, mixed.id, b).click();
  await expect(title(page)).toHaveText('b.png');
  await page.locator(`${DIALOG} [data-unified-viewer-details]`).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${f.projectId}/assets/${b}`);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).pathname).toBe(f.url);

  // Release title and "+N more" still navigate to Release Detail.
  await releaseTitle(page, shared.id).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/releases/${shared.id}`);
  await page.goBack();
  await item(page, full.id).locator('a.release-thumbnail-more').click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/releases/${full.id}`);
});

test('the same asset in two strips and duplicate filenames keep their own release and identity', async ({ page }) => {
  const f = await createProject();
  const { mixed, shared } = f.releases;
  const control = await open(page, f.url);
  const b = f.id('b.png');
  const [sameOne, sameTwo] = ['one/same.png', 'two/same.png'].map(f.id);

  await thumb(page, mixed.id, b).click();
  const first = await viewerState(page);
  expect(first.sourceKey).toBe(`project-detail:${f.projectId}:release:${mixed.id}`);
  await page.keyboard.press('Escape');
  await expect(thumb(page, mixed.id, b)).toBeFocused();

  await thumb(page, shared.id, b).click();
  const second = await viewerState(page);
  expect(second).toMatchObject({ count: 1, titles: ['b.png'], sourceKey: `project-detail:${f.projectId}:release:${shared.id}` });
  expect(second.session).not.toBe(first.session);
  expect(second.mediaUrl).toBe(first.mediaUrl);
  await page.keyboard.press('Escape');
  await expect(thumb(page, shared.id, b)).toBeFocused();

  // Duplicate filenames: each thumbnail opens its own asset.
  await thumb(page, mixed.id, sameOne).click();
  await expect(title(page)).toHaveText('same.png');
  const one = await viewerState(page);
  await page.keyboard.press('Escape');
  await thumb(page, shared.id, sameTwo).click();
  const two = await viewerState(page);
  expect(one.detailsUrl).toBe(`/projects/${f.projectId}/assets/${sameOne}`);
  expect(two.detailsUrl).toBe(`/projects/${f.projectId}/assets/${sameTwo}`);
  expect(one.mediaUrl).not.toBe(two.mediaUrl);
  await page.keyboard.press('Escape');

  // A replaced opener: focus returns to the same asset's thumbnail in the
  // SAME release, never to the other release's thumbnail of that asset.
  await thumb(page, shared.id, b).click();
  await expect(title(page)).toHaveText('b.png');
  await thumb(page, shared.id, b).evaluate((node) => {
    const copy = node.cloneNode(true);
    copy.dataset.replacement = 'yes';
    node.replaceWith(copy);
  });
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(thumb(page, shared.id, b)).toHaveAttribute('data-replacement', 'yes');
  await expect(thumb(page, shared.id, b)).toBeFocused();

  // Without one, focus goes to that release's title link.
  await thumb(page, shared.id, b).click();
  await expect(title(page)).toHaveText('b.png');
  await thumb(page, shared.id, b).evaluate((node) => node.remove());
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  await expect(releaseTitle(page, shared.id)).toBeFocused();
  await expect(thumb(page, mixed.id, b)).not.toBeFocused();

  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('video keeps its player; Krita is preview-only; comics, missing and empty strips never open the viewer', async ({ page }) => {
  const f = await createProject();
  const { mixed, empty } = f.releases;
  const control = await open(page, f.url);
  const [clip, paint, comic, notes, gone] = ['clip.mp4', 'paint.kra', 'book.cbz', 'notes.txt', 'gone.png'].map(f.id);

  // Comic, text and missing assets are not strip tiles; the empty release has no strip.
  for (const id of [comic, notes, gone]) await expect(item(page, mixed.id).locator(`a[href="/projects/${f.projectId}/assets/${id}"]`)).toHaveCount(0);
  await expect(item(page, empty.id)).toHaveCount(1);
  await expect(item(page, empty.id).locator('.release-thumbnail-strip')).toHaveCount(0);

  // The video tile opens the separate video player, never the image viewer.
  const video = item(page, mixed.id).locator(`.release-thumbnail-video a[data-asset-video-preview-trigger][href="/projects/${f.projectId}/assets/${clip}"]`);
  await expect(video).toHaveCount(1);
  await expect(video).not.toHaveAttribute(TRIGGER, /.*/);
  await video.click();
  await expect(page.locator(VIDEO_DIALOG)).toBeVisible();
  await expect(page.locator(DIALOG)).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator(VIDEO_DIALOG)).toBeHidden();
  expect((await viewerState(page)).open).toBe(false);

  // Krita: the preview opens and zooms, with no Original Size.
  await thumb(page, mixed.id, paint).click();
  await expect(title(page)).toHaveText('paint.kra');
  await expect.poll(async () => (await viewerState(page)).media.status).toBe('loaded');
  expect(await viewerState(page)).toMatchObject({ mode: 'single', count: 1, originalUrl: null });
  await expect(page.locator(`${DIALOG} [data-unified-viewer-original]`)).toBeHidden();
  await page.locator(`${DIALOG} [data-unified-viewer-zoom-in]`).click();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-zoom-level]`)).not.toHaveText('Fit');
  await page.locator(`${DIALOG} [data-unified-viewer-fit]`).click();
  await expect(page.locator(`${DIALOG} [data-unified-viewer-zoom-level]`)).toHaveText('Fit');
  await page.keyboard.press('Escape');
  await expect(thumb(page, mixed.id, paint)).toBeFocused();

  expect(new URL(page.url()).pathname).toBe(f.url);
  expect(control.comic).toEqual([]);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('Edit Project save and Archive in place refresh their regions; strips and triggers stay; published/archived releases view', async ({ page }) => {
  const f = await createProject();
  const { mixed, shared } = f.releases;
  const a = f.id('a.png');
  const b = f.id('b.png');
  db.prepare("UPDATE releases SET published_date = '2026-01-02' WHERE id = ?").run(mixed.id);
  db.prepare("UPDATE releases SET archived_at = datetime('now') WHERE id = ?").run(shared.id);
  const control = await open(page, f.url);
  await expect(item(page, mixed.id)).toContainText('published 2026-01-02');
  await page.locator('.project-detail-releases .release-list').evaluate((node) => { node.dataset.kept = 'yes'; });

  // Published and archived releases still view their images.
  await thumb(page, mixed.id, a).click();
  await expect(title(page)).toHaveText('a.png');
  await page.keyboard.press('Escape');
  await thumb(page, shared.id, b).click();
  await expect(title(page)).toHaveText('b.png');
  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toBeHidden();
  expect(control.mutations).toEqual([]);

  // The Edit Project dialog opens and saves on this page.
  await page.locator(`[data-project-edit-id="${f.projectId}"]`).click();
  const edit = page.locator('#project-edit-dialog');
  await expect(edit).toBeVisible();
  await expect(edit.locator('button[data-dialog-submit]')).toBeEnabled();
  await edit.locator('input[name="title"]').fill(`Renamed Strip Viewer ${f.projectId}`);
  await edit.locator('button[data-dialog-submit]').click();
  await expect(edit).toBeHidden();
  await expect(page.locator('[data-dialog-feedback]')).toHaveText('Project updated.');
  await expect(page.locator('.app-section-title')).toContainText(`Renamed Strip Viewer ${f.projectId}`);
  await expect(page.locator('.project-detail-releases .release-list[data-kept="yes"]')).toHaveCount(1);
  expect(control.mutations).toHaveLength(1);

  // The strips still open the viewer after the refresh.
  await thumb(page, mixed.id, a).click();
  await expect(title(page)).toHaveText('a.png');
  await page.keyboard.press('Escape');
  await expect(thumb(page, mixed.id, a)).toBeFocused();

  // Archive in place: the project becomes read-only, the strips stay and view.
  await page.locator(`[data-project-edit-id="${f.projectId}"]`).click();
  await expect(edit.locator('button[data-dialog-submit]')).toBeEnabled();
  const archive = edit.locator('[data-project-edit-action="archive"]');
  if (!(await archive.evaluate((node) => node.open))) await archive.locator('summary').click();
  await archive.getByRole('button', { name: 'Archive project' }).click();
  await page.locator('#app-confirmation-dialog [data-app-dialog-confirmation-confirm]').click();
  await expect(edit).toBeHidden();
  await expect(page.getByText('This project is archived and read-only. Editing, releases, and asset scanning are restricted.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create release record' })).toHaveCount(0);
  await expect(page.locator('.project-detail-releases .release-list[data-kept="yes"]')).toHaveCount(1);
  const mutations = control.mutations.length;
  await thumb(page, mixed.id, a).click();
  await expect(title(page)).toHaveText('a.png');
  await page.keyboard.press('Escape');
  await expect(thumb(page, mixed.id, a)).toBeFocused();
  await expect(page.locator(`[data-project-edit-id="${f.projectId}"]`)).toHaveCount(0);
  expect(control.mutations).toHaveLength(mutations);
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  expect(control.errors).toEqual([]);
});

test('a Delete that retires the page closes an open session and withdraws every trigger', async ({ page }) => {
  const f = await createProject();
  const { mixed } = f.releases;
  const control = await open(page, f.url);
  const a = f.id('a.png');
  await thumb(page, mixed.id, a).click();
  await expect(title(page)).toHaveText('a.png');

  // What project-delete.js does once the page's own project is gone (the real
  // retire and event; the page is kept so the result can be observed).
  await page.evaluate(async (projectId) => {
    const { retireProjectPage } = await import('/client/project-delete.js');
    const { PROJECT_DELETED_EVENT } = await import('/client/project-edit-dialog.js');
    retireProjectPage(document, projectId, { destination: '/projects', navigate: false });
    document.dispatchEvent(new CustomEvent(PROJECT_DELETED_EVENT, { detail: { projectId, hostRetired: true } }));
  }, f.projectId);
  await expect(page.locator(DIALOG)).toBeHidden();
  expect((await viewerState(page)).open).toBe(false);
  await expect(page.locator(`[${TRIGGER}]`)).toHaveCount(0);
  await expect(page.locator('#main-content')).toBeFocused();
  // The thumbnail is the plain (inert) Asset Details link it always was.
  const link = item(page, mixed.id).locator(`a.release-thumbnail-link[href="/projects/${f.projectId}/assets/${a}"]`);
  await expect(link).toHaveCount(1);
  // Even a synthetic click (inert stops real ones) is left to the link:
  // observed unprevented at the window, then stopped there.
  await page.evaluate(() => {
    window.__retiredClick = null;
    window.addEventListener('click', (event) => {
      window.__retiredClick = { prevented: event.defaultPrevented };
      event.preventDefault();
    }, { once: true });
  });
  await link.dispatchEvent('click');
  expect(await page.evaluate(() => window.__retiredClick)).toEqual({ prevented: false });
  expect((await viewerState(page)).open).toBe(false);
  expect(new URL(page.url()).pathname).toBe(f.url);
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('narrow 375px viewport: the single image fits and closes back to its thumbnail', async ({ page }) => {
  const f = await createProject();
  const { mixed } = f.releases;
  const control = await open(page, f.url, { viewport: { width: 375, height: 740 } });
  const b = f.id('b.png');
  await thumb(page, mixed.id, b).scrollIntoViewIfNeeded();
  await thumb(page, mixed.id, b).click();
  await expect(shownImage(page)).toBeVisible();
  const box = await page.locator(`${DIALOG} [data-unified-viewer-card]`).boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375.5);
  await expect(page.locator(`${DIALOG} [data-dialog-close]`)).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await closeViewer(page);
  await expect(thumb(page, mixed.id, b)).toBeFocused();
  expect(control.mutations).toEqual([]);
  expect(control.errors).toEqual([]);
});
