import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { createReleaseService } from '../../src/services/release-service.js';
import { buildAssetPreviewModel } from '../../src/services/asset-presentation.js';
import { makeZip } from '../helpers/zip-fixture.js';

let root;
let app;
let db;
let server;
let baseURL;
let fixtures;
const dialog = '#unified-viewer-dialog';

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-image-sources-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const viteDistRoot = path.join(root, 'client');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot: path.join(root, 'previews') }, {
    appDataRoot, authState: { csrfPepper }, useViteAssets: true, viteDistRoot,
    assetManifest: createAssetManifest({ distRoot: viteDistRoot, manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
  });
  const releases = createReleaseService({ db });
  fixtures = [];
  for (const title of ['Alpha Sources', 'Beta Sources']) {
    const project = app.locals.projectService.create({ title, status: 'tbd' });
    const dir = path.join(projectsRoot, project.project_dir);
    fs.mkdirSync(dir, { recursive: true });
    const filename = 'cover & image.png';
    fs.writeFileSync(path.join(dir, filename), await sharp({ create: {
      width: 2400, height: 1800, channels: 3, background: '#9867af',
    } }).png().toBuffer());
    fs.writeFileSync(path.join(dir, 'book.cbz'), Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]));
    app.locals.assetScanner.scanProjectAssets(project.id);
    const row = db.prepare('SELECT * FROM assets WHERE project_id = ? AND extension = ?').get(project.id, 'png');
    const release = releases.createReleaseWithSelectedAssets(project.id, { title: `${title} Release` }, [row.id]);
    fixtures.push({ project, row, release });
  }
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (db) closeDatabase(db);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function state(page) {
  return page.locator(dialog).evaluate((element) => {
    const state = element.__creatorCrateUnifiedViewer.getState();
    return { ...state, source: state.source, item: state.item };
  });
}

function expectedSources(row) {
  const raw = buildAssetPreviewModel(row, app.locals.projectImageSettingsService.getPresentationPolicy()).imageSources;
  return { ...raw, projectId: String(row.project_id), assetId: String(row.id) };
}

for (const format of ['webp', 'original']) {
  for (const host of ['project-assets', 'library', 'details', 'project-detail', 'release-assets', 'release-detail']) {
    test(`${host} preserves authoritative sources under Preview=${format} with reversible decoded quality selection`, async ({ page }) => {
      app.locals.projectImageSettingsService.saveValidated({ previewFormat: format });
      const { project, row, release } = fixtures[0];
      const routes = {
        'project-assets': [`/projects/${project.id}/assets`, `[data-project-assets-preview-id="${row.id}"]`],
        library: ['/asset-viewer', `[data-asset-library-preview-id="${row.id}"]`],
        details: [`/projects/${project.id}/assets/${row.id}`, '[data-asset-details-viewer-trigger]'],
        'project-detail': [`/projects/${project.id}`, `[data-project-detail-viewer-trigger][data-viewer-asset="${row.id}"]`],
        'release-assets': [`/releases/${release.id}/assets`, `[data-release-assets-viewer-trigger][data-viewer-asset="${row.id}"]`],
        'release-detail': [`/releases/${release.id}`, `[data-release-detail-viewer-trigger][data-viewer-asset="${row.id}"]`],
      };
      const [url, selector] = routes[host];
      const requests = [];
      page.on('request', (request) => requests.push(request.url()));
      await page.goto(baseURL + url);
      const trigger = page.locator(selector).first();
      await expect(trigger).toBeVisible();
      const expected = expectedSources(row);
      if (host !== 'project-assets' && host !== 'library') {
        const descriptor = JSON.parse(await trigger.getAttribute('data-viewer-image-sources'));
        expect(descriptor).toEqual({ ...expected, projectId: row.project_id, assetId: row.id });
      }
      const selection = await page.locator('input[name="selectedAssetIds"]').evaluateAll((nodes) => nodes.map((node) => [node.value, node.checked]));
      await trigger.click();
      await expect.poll(async () => (await state(page)).mediaStatus).toBe('loaded');
      const opened = await state(page);
      expect(opened.item.imageSources).toEqual(expected);
      expect(opened.item.filename).toBe(row.filename);
      expect(opened.item.projectId).toBe(String(project.id));
      expect(opened.item.mediaUrl).toBe(buildAssetPreviewModel(row, app.locals.projectImageSettingsService.getPresentationPolicy()).urls.preview);
      expect(requests.filter((url) => new URL(url).searchParams.has('rendition'))).toContain(baseURL + expected.optimized.url);
      const media = page.locator(`${dialog} [data-viewer-content]`);
      const quality = page.getByRole('button', { name: 'Original source', exact: true });
      await expect(quality).toBeVisible();
      const optimizedWidth = await media.evaluate((img) => img.naturalWidth);
      expect(optimizedWidth).toBeLessThan(2400);
      expect(await quality.evaluate((button) => button.previousElementSibling.hasAttribute('data-unified-viewer-fullscreen') && button.nextElementSibling.hasAttribute('data-unified-viewer-details'))).toBe(true);
      await quality.click();
      await expect(quality).toHaveAttribute('aria-pressed', 'true');
      expect(await media.evaluate((img) => img.naturalWidth)).toBe(2400);
      expect(requests).toContain(baseURL + expected.original.url);
      expect(await page.locator(dialog).evaluate((el) => el.__creatorCrateUnifiedViewer.media.getState().quality.url)).toBe(expected.original.url);
      await quality.click();
      await expect(quality).toHaveAttribute('aria-pressed', 'false');
      expect(await media.evaluate((img) => img.naturalWidth)).toBe(optimizedWidth);
      await expect(page.getByRole('dialog', { name: 'Image Preview', exact: true })).toBeVisible();
      await expect(page.locator(`${dialog} [data-unified-viewer-title]`)).toHaveText(row.filename);
      await expect(page.locator(`${dialog} [data-unified-viewer-details]`)).toHaveAttribute('href', `/projects/${project.id}/assets/${row.id}`);
      expect(await page.locator('input[name="selectedAssetIds"]').evaluateAll((nodes) => nodes.map((node) => [node.value, node.checked]))).toEqual(selection);
      await expect(page.locator(dialog)).toHaveCount(1);
    });
  }
}

test('cross-project slideshow keeps each item sources, order, playback and one-item mode', async ({ page }) => {
  app.locals.projectImageSettingsService.saveValidated({ previewFormat: 'original' });
  await page.goto(baseURL + '/asset-viewer?pageSize=all');
  const entries = await page.locator('[data-asset-library-viewer-sequence]').evaluate((element) => JSON.parse(element.textContent));
  expect(entries).toHaveLength(2);
  await page.locator('[data-asset-library-slideshow-trigger]').click();
  await expect.poll(async () => (await state(page)).mediaStatus).toBe('loaded');
  const first = await state(page);
  expect(first.source.items.map((item) => item.assetId)).toEqual(entries.map((item) => String(item.id)));
  expect(first.source.slideshow).toBe(true);
  await page.getByRole('button', { name: 'Original source', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Original source', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.locator(dialog).evaluate((element) => element.__creatorCrateUnifiedViewer.playback.pause());
  await page.locator(`${dialog} [data-unified-viewer-next]`).click();
  await expect.poll(async () => (await state(page)).item.assetId).toBe(String(entries[1].id));
  const second = await state(page);
  expect(second.item.imageSources).toEqual({ ...entries[1].imageSources, projectId: String(entries[1].projectId), assetId: String(entries[1].id) });
  expect(second.item.imageSources.sourceRevision).not.toBe(first.item.imageSources.sourceRevision);
  expect(second.playback.playing).toBe(false);
  await expect(page.getByRole('button', { name: 'Original source', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.goto(baseURL + `/projects/${fixtures[0].project.id}/assets`);
  await page.locator('[data-project-assets-slideshow-trigger]').click();
  const one = await state(page);
  expect(one.source.slideshow).toBe(true);
  expect(one.count).toBe(1);
});

test('accepted release refreshes replace quality revisions; stale renders cannot restore withdrawn sources', async ({ page }) => {
  app.locals.projectImageSettingsService.saveValidated({ previewFormat: 'webp' });
  const { project, row, release } = fixtures[0];
  const url = `/releases/${release.id}`;
  const trigger = `[data-release-detail-viewer-trigger][data-viewer-asset="${row.id}"]`;
  await page.goto(baseURL + url);
  await page.locator(trigger).click();
  await expect.poll(async () => (await state(page)).mediaStatus).toBe('loaded');
  const first = await state(page);
  const refresh = () => page.evaluate((id) => {
    document.dispatchEvent(new CustomEvent('release-edit-saved', { detail: { releaseId: id } }));
  }, release.id);
  const mediaRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === `/projects/${project.id}/assets/${row.id}/preview`) mediaRequests.push(request.url());
  });
  db.prepare('UPDATE releases SET title = ? WHERE id = ?').run('Metadata refresh', release.id);
  await refresh();
  await expect(page.locator('.app-section-title')).toHaveText('Releases — Metadata refresh');
  expect((await state(page)).item.imageSources).toEqual(first.item.imageSources);
  expect(mediaRequests).toEqual([]);
  const staleHtml = await (await page.request.get(baseURL + url)).text();
  db.prepare('UPDATE assets SET source_generation = source_generation + 1 WHERE id = ?').run(row.id);
  const current = db.prepare('SELECT * FROM assets WHERE id = ?').get(row.id);
  let releaseHeld;
  const held = new Promise((resolve) => { releaseHeld = resolve; });
  let calls = 0;
  let settled = false;
  await page.route((candidate) => candidate.pathname === url, async (route) => {
    calls += 1;
    if (calls === 1) {
      await held;
      await route.fulfill({ status: 200, contentType: 'text/html', body: staleHtml }).catch(() => {});
      settled = true;
    } else await route.continue();
  });
  try {
    await refresh();
    await expect.poll(() => calls).toBe(1);
    await refresh();
    await expect.poll(async () => (await state(page)).item.imageSources.sourceRevision).toBe(expectedSources(current).sourceRevision);
    await expect.poll(async () => (await state(page)).mediaStatus).toBe('loaded');
    const fresh = await state(page);
    expect(fresh.session).toBe(first.session);
    expect(fresh.item.imageSources).toEqual(expectedSources(current));
    releaseHeld();
    await expect.poll(() => settled).toBe(true);
    expect((await state(page)).item.imageSources).toEqual(fresh.item.imageSources);
    db.prepare('DELETE FROM release_assets WHERE release_id = ? AND asset_id = ?').run(release.id, row.id);
    await refresh();
    await expect.poll(async () => (await state(page)).open).toBe(false);
    await expect(page.locator('[data-viewer-image-sources]')).toHaveCount(0);
    await expect(page.locator(trigger)).toHaveCount(0);
  } finally {
    releaseHeld();
    await page.unrouteAll({ behavior: 'wait' });
  }
});


async function qualityState(page) {
  return page.locator(dialog).evaluate((el) => el.__creatorCrateUnifiedViewer.media.getState());
}
async function openQualityImage(page) {
  const { project, row } = fixtures[0];
  app.locals.projectImageSettingsService.saveValidated({ previewFormat: 'original' });
  await page.goto(baseURL + `/projects/${project.id}/assets/${row.id}`);
  await page.locator('[data-asset-details-viewer-trigger]').click();
  await expect.poll(async () => (await qualityState(page)).quality.displayed).toBe('optimized');
  return (await state(page)).item;
}
const qualityControl = (page) => page.getByRole('button', { name: 'Original source', exact: true });

test('quality preserves fitted, zoomed and panned geometry; Actual Size does not change quality', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const item = await openQualityImage(page);
  expect((await page.locator(`${dialog} footer`).boundingBox()).height).toBeLessThan(64);
  await qualityControl(page).focus();
  await qualityControl(page).press('Space');
  await expect(qualityControl(page)).toHaveAttribute('aria-pressed', 'true');
  expect((await qualityState(page)).view.mode).toBe('fit');
  await qualityControl(page).click();
  await expect(qualityControl(page)).toHaveAttribute('aria-pressed', 'false');
  // At this width zoom lives in the footer; use the production command for precise geometry setup.
  await page.locator(dialog).evaluate((el) => { el.__creatorCrateUnifiedViewer.media.zoomIn(); el.__creatorCrateUnifiedViewer.media.zoomIn(); });
  const surface = page.locator(`${dialog} [data-unified-viewer-media]`);
  const box = await surface.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 50); await page.mouse.up();
  const before = (await qualityState(page)).view;
  await qualityControl(page).click();
  await expect(qualityControl(page)).toHaveAttribute('aria-pressed', 'true');
  const after = (await qualityState(page)).view;
  expect(after.scale / after.fitScale).toBeCloseTo(before.scale / before.fitScale);
  expect(after.panX / (after.contentWidth * after.scale)).toBeCloseTo(before.panX / (before.contentWidth * before.scale));
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.locator(dialog).evaluate((el) => el.__creatorCrateUnifiedViewer.media.actualSize());
  expect((await qualityState(page)).view.scale).toBe(1);
  expect((await qualityState(page)).quality.url).toBe(item.imageSources.original.url);
  expect(requests.filter((url) => url.includes('/original'))).toEqual([]);
});

test('delayed quality switching suspends countdown, resumes on success/failure and respects pause', async ({ page }) => {
  await openQualityImage(page);
  const first = (await state(page)).item;
  const second = expectedSources(fixtures[1].row);
  const item2 = { ...first, projectId: String(fixtures[1].project.id), assetId: String(fixtures[1].row.id), mediaUrl: second.optimized.url, imageSources: second };
  await page.locator(dialog).evaluate((el, items) => el.__creatorCrateUnifiedViewer.open({ key: 'quality-slideshow', kind: 'image', mode: 'sequence', slideshow: true, wrap: true, items }), [first, item2]);
  await expect.poll(async () => (await qualityState(page)).status).toBe('loaded');
  await page.locator(dialog).evaluate((el) => el.__creatorCrateUnifiedViewer.playback.setSpeed(2000));
  let release; const held = new Promise((resolve) => { release = resolve; }); let started = false;
  await page.route((url) => url.pathname.endsWith('/original') && url.searchParams.has('sourceRevision'), async (route) => { started = true; await held; await route.continue().catch(() => {}); });
  try {
    await qualityControl(page).click(); await expect.poll(() => started).toBe(true);
    await expect(qualityControl(page)).toHaveAttribute('aria-pressed', 'false');
    expect((await qualityState(page)).quality.loading).toBe(true);
    await page.waitForTimeout(2300);
    expect((await state(page)).item.assetId).toBe(first.assetId);
    expect((await state(page)).playback.playing).toBe(true);
    release(); await expect(qualityControl(page)).toHaveAttribute('aria-pressed', 'true');
    expect((await state(page)).playback.speed).toBe(2000);
    await page.locator(dialog).evaluate((el) => el.__creatorCrateUnifiedViewer.playback.pause());
    await qualityControl(page).click(); await expect(qualityControl(page)).toHaveAttribute('aria-pressed', 'false');
    expect((await state(page)).playback.playing).toBe(false);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  await page.route((url) => url.pathname.endsWith('/original'), (route) => route.fulfill({ status: 503, contentType: 'text/plain', body: 'unavailable' }));
  await page.locator(dialog).evaluate((el) => el.__creatorCrateUnifiedViewer.playback.play());
  await qualityControl(page).click();
  await expect.poll(async () => (await qualityState(page)).quality.error).toBe('http');
  expect((await state(page)).playback.playing).toBe(true);
  expect((await qualityState(page)).quality.displayed).toBe('optimized');
});

test('late response cannot cross close/reopen, and 409 retains media until accepted source refresh', async ({ page }) => {
  const item = await openQualityImage(page);
  let release; const held = new Promise((resolve) => { release = resolve; }); let started = false;
  await page.route((url) => url.pathname.endsWith('/original') && url.searchParams.has('sourceRevision'), async (route) => { started = true; await held; await route.continue().catch(() => {}); });
  try {
    await qualityControl(page).click(); await expect.poll(() => started).toBe(true);
    await page.locator(dialog).evaluate((el, item) => { const viewer = el.__creatorCrateUnifiedViewer; viewer.close(); viewer.open({ key: 'reopened', mode: 'single', items: [item] }); }, item);
    release();
    await expect.poll(async () => (await qualityState(page)).quality.displayed).toBe('optimized');
    expect((await qualityState(page)).quality.desired).toBe('optimized');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  const imageBefore = await page.locator(`${dialog} [data-viewer-content]`).getAttribute('src');
  await page.route((url) => url.pathname.endsWith('/original'), (route) => route.fulfill({ status: 409, contentType: 'text/plain', body: 'Image source or rendition changed.' }));
  await qualityControl(page).click();
  await expect.poll(async () => (await qualityState(page)).quality.httpStatus).toBe(409);
  await expect(qualityControl(page)).toBeHidden();
  expect(await page.locator(`${dialog} [data-viewer-content]`).getAttribute('src')).toBe(imageBefore);
  await page.unrouteAll({ behavior: 'wait' });
  // Existing authoritative update is the only mechanism allowed to replace revision metadata.
  db.prepare('UPDATE assets SET source_generation = source_generation + 1 WHERE id = ?').run(fixtures[0].row.id);
  const current = db.prepare('SELECT * FROM assets WHERE id = ?').get(fixtures[0].row.id);
  await page.locator(dialog).evaluate((el, updated) => el.__creatorCrateUnifiedViewer.update([updated]), { ...item, imageSources: expectedSources(current) });
  await expect.poll(async () => (await qualityState(page)).quality.displayed).toBe('original');
  await expect(qualityControl(page)).toBeVisible();
});

test('ineligible slideshow item falls back without erasing desire; withdrawal updates the active choice', async ({ page }) => {
  const first = await openQualityImage(page);
  const sources = expectedSources(fixtures[1].row);
  const second = { ...first, projectId: sources.projectId, assetId: sources.assetId, mediaUrl: sources.optimized.url, imageSources: { ...sources, original: { eligible: false, url: null }, toggleEligible: false } };
  await page.locator(dialog).evaluate((el, items) => el.__creatorCrateUnifiedViewer.open({ key: 'ineligible', mode: 'sequence', slideshow: true, wrap: true, items }, { autoplay: false }), [first, second]);
  await expect.poll(async () => (await qualityState(page)).status).toBe('loaded');
  await qualityControl(page).click(); await expect(qualityControl(page)).toHaveAttribute('aria-pressed', 'true');
  await page.locator(`${dialog} [data-unified-viewer-next]`).click();
  await expect.poll(async () => (await qualityState(page)).status).toBe('loaded');
  await expect(qualityControl(page)).toBeHidden();
  expect((await qualityState(page)).quality).toMatchObject({ desired: 'original', displayed: 'optimized' });
  await page.locator(`${dialog} [data-unified-viewer-next]`).click();
  await expect(qualityControl(page)).toHaveAttribute('aria-pressed', 'true');
  await page.locator(dialog).evaluate((el, updated) => el.__creatorCrateUnifiedViewer.update([updated]), { ...first, imageSources: { ...first.imageSources, original: { eligible: false, url: null }, toggleEligible: false } });
  await expect(qualityControl(page)).toBeHidden();
  await expect.poll(async () => (await qualityState(page)).quality.displayed).toBe('optimized');
});

test('physical footer hit targets remain separate at 320x420 / 24px and fullscreen retains its stage', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 420 });
  const first = await openQualityImage(page);
  const other = expectedSources(fixtures[1].row);
  await page.locator(dialog).evaluate((el, items) => el.__creatorCrateUnifiedViewer.open({ key: 'narrow-slideshow', mode: 'sequence', slideshow: true, wrap: true, items }, { autoplay: false }), [first, { ...first, projectId: other.projectId, assetId: other.assetId, mediaUrl: other.optimized.url, imageSources: other }]);
  await expect.poll(async () => (await qualityState(page)).status).toBe('loaded');
  await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
  await page.locator(dialog).evaluate((el) => el.__creatorCrateUnifiedViewer.media.zoomIn());
  const selectors = ['[data-unified-viewer-fit]', '[data-unified-viewer-fullscreen]', '[data-unified-viewer-quality]', '[data-unified-viewer-details]', '[data-unified-viewer-overflow] > summary', '[data-unified-viewer-play]'];
  for (const selector of selectors) {
    const control = page.locator(`${dialog} ${selector}`); await expect(control).toBeVisible();
    expect(await control.evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
  }
  const rectangles = await Promise.all(selectors.map((selector) => page.locator(`${dialog} ${selector}`).boundingBox()));
  for (let a = 0; a < rectangles.length; a += 1) for (let b = a + 1; b < rectangles.length; b += 1) {
    const x = rectangles[a]; const y = rectangles[b];
    expect(Math.min(x.x + x.width, y.x + y.width) - Math.max(x.x, y.x) > 0 && Math.min(x.y + x.height, y.y + y.height) - Math.max(x.y, y.y) > 0).toBe(false);
  }
  await page.locator(`${dialog} [data-unified-viewer-details]`).evaluate((el) => el.addEventListener('click', (event) => { event.preventDefault(); el.dataset.hit = 'yes'; }));
  await page.locator(`${dialog} [data-unified-viewer-details]`).click();
  await expect(page.locator(`${dialog} [data-unified-viewer-details]`)).toHaveAttribute('data-hit', 'yes');
  await page.locator(`${dialog} [data-unified-viewer-overflow] > summary`).click();
  await expect(page.locator(`${dialog} [data-unified-viewer-overflow]`)).toHaveAttribute('open', '');
  await page.locator(`${dialog} [data-unified-viewer-overflow] > summary`).click();
  await page.locator(`${dialog} [data-unified-viewer-play]`).click();
  expect((await state(page)).playback.playing).toBe(true);
  await page.locator(`${dialog} [data-unified-viewer-play]`).click();
  await qualityControl(page).click(); await expect(qualityControl(page)).toHaveAttribute('aria-pressed', 'true');
  await page.locator(dialog).evaluate((el) => el.__creatorCrateUnifiedViewer.media.zoomIn());
  const fit = page.locator(`${dialog} [data-unified-viewer-fit]`); await fit.click();
  await page.locator(`${dialog} [data-unified-viewer-fullscreen]`).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  const media = page.locator(`${dialog} [data-unified-viewer-media]`); const before = await media.boundingBox();
  await qualityControl(page).click(); await expect(qualityControl(page)).toHaveAttribute('aria-pressed', 'false');
  expect(await media.boundingBox()).toEqual(before);
  expect(await page.locator(`${dialog} [data-unified-viewer-card]`).getAttribute('data-viewer-chrome-hidden')).toBeNull();
  const box = await media.boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + 60 };
  expect(await page.evaluate(({ x, y }) => !document.elementFromPoint(x, y)?.closest('button, a, footer, summary'), point)).toBe(true);
  await page.mouse.click(point.x, point.y);
  await expect(page.locator(`${dialog} [data-unified-viewer-card]`)).toHaveAttribute('data-viewer-chrome-hidden', '');
});


test('withdrawal during real browser decode retires the candidate and releases its object URL', async ({ page }) => {
  const item = await openQualityImage(page);
  const before = await page.locator(`${dialog} [data-viewer-content]`).getAttribute('src');
  await page.evaluate(() => {
    const originalDecode = HTMLImageElement.prototype.decode;
    const revoke = URL.revokeObjectURL.bind(URL);
    window.__qualityRevoked = [];
    URL.revokeObjectURL = (url) => { window.__qualityRevoked.push(url); revoke(url); };
    let next = true;
    HTMLImageElement.prototype.decode = async function decode() {
      await originalDecode.call(this);
      if (!next) return;
      next = false; window.__qualityDecodeUrl = this.src;
      await new Promise((resolve) => { window.__releaseQualityDecode = resolve; });
    };
  });
  await qualityControl(page).click();
  await expect.poll(() => page.evaluate(() => Boolean(window.__releaseQualityDecode))).toBe(true);
  expect((await qualityState(page)).quality).toMatchObject({ loading: true, displayed: 'optimized' });
  await page.locator(dialog).evaluate((el, updated) => el.__creatorCrateUnifiedViewer.update([updated]), { ...item, imageSources: { ...item.imageSources, original: { eligible: false, url: null }, toggleEligible: false } });
  await expect(qualityControl(page)).toBeHidden();
  await page.evaluate(() => window.__releaseQualityDecode());
  await expect.poll(() => page.evaluate(() => window.__qualityRevoked.includes(window.__qualityDecodeUrl))).toBe(true);
  expect(await page.locator(`${dialog} [data-viewer-content]`).getAttribute('src')).toBe(before);
  expect((await qualityState(page)).quality).toMatchObject({ loading: false, displayed: 'optimized' });
});


test('pending original cannot replace the next manually selected slide', async ({ page }) => {
  const first = await openQualityImage(page);
  const sources = expectedSources(fixtures[1].row);
  const second = { ...first, projectId: sources.projectId, assetId: sources.assetId, mediaUrl: sources.optimized.url, imageSources: sources };
  await page.locator(dialog).evaluate((el, items) => el.__creatorCrateUnifiedViewer.open({ key: 'manual-race', mode: 'sequence', slideshow: true, wrap: true, items }, { autoplay: false }), [first, second]);
  await expect.poll(async () => (await qualityState(page)).status).toBe('loaded');
  let release; const held = new Promise((resolve) => { release = resolve; }); let started = false;
  await page.route((url) => url.pathname === new URL(baseURL + first.imageSources.original.url).pathname, async (route) => { started = true; await held; await route.continue().catch(() => {}); });
  try {
    await qualityControl(page).click(); await expect.poll(() => started).toBe(true);
    await page.locator(`${dialog} [data-unified-viewer-next]`).click();
    await expect.poll(async () => (await qualityState(page)).quality.url).toBe(second.imageSources.original.url);
    release();
    await expect(qualityControl(page)).toHaveAttribute('aria-pressed', 'true');
    expect((await state(page)).item.assetId).toBe(second.assetId);
    expect((await qualityState(page)).quality.url).toBe(second.imageSources.original.url);
    expect((await state(page)).playback.playing).toBe(false);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('comic, Krita, missing choices and the separate video dialog never offer source quality', async ({ page }) => {
  const item = await openQualityImage(page);
  for (const imageSources of [null, { ...item.imageSources, optimized: { ...item.imageSources.optimized, eligible: false, url: null }, toggleEligible: false }, { ...item.imageSources, original: { eligible: false, url: null }, toggleEligible: false }]) {
    await page.locator(dialog).evaluate((el, updated) => el.__creatorCrateUnifiedViewer.update([updated]), { ...item, imageSources });
    await expect(qualityControl(page)).toBeHidden();
  }
  const book = db.prepare('SELECT * FROM assets WHERE project_id = ? AND extension = ?').get(fixtures[0].project.id, 'cbz');
  await page.locator(dialog).evaluate((el, asset) => el.__creatorCrateUnifiedViewer.openComic({ projectId: asset.project_id, assetId: asset.id, filename: asset.filename }), book);
  await expect.poll(async () => Boolean((await state(page)).comic)).toBe(true);
  await expect(qualityControl(page)).toBeHidden();
  const project = app.locals.projectService.create({ title: 'Quality exclusions', status: 'tbd' });
  const dir = path.join(root, 'projects', project.project_dir); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'drawing.kra'), makeZip([{ name: 'mergedimage.png', data: await sharp({ create: { width: 400, height: 300, channels: 3, background: '#4267ab' } }).png().toBuffer() }]));
  fs.writeFileSync(path.join(dir, 'movie.mp4'), Buffer.alloc(32));
  app.locals.assetScanner.scanProjectAssets(project.id);
  const kra = db.prepare('SELECT * FROM assets WHERE project_id = ? AND extension = ?').get(project.id, 'kra');
  await page.goto(baseURL + `/projects/${project.id}/assets/${kra.id}`);
  await page.locator('[data-asset-details-viewer-trigger]').click();
  await expect(qualityControl(page)).toBeHidden();
  expect((await state(page)).item.imageSources.original.eligible).toBe(false);
  await page.goto(baseURL + `/projects/${project.id}/assets`);
  await page.locator('[data-asset-video-preview-trigger]').first().click();
  await expect(page.locator('#asset-video-preview-dialog')).toBeVisible();
  expect(await page.locator('#asset-video-preview-dialog [data-unified-viewer-quality]').count()).toBe(0);
});
