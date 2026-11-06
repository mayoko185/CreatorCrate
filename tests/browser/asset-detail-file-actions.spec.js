import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { assetReviewToken } from '../../src/services/asset-delete-review.js';

// WP10A3-A: Edit Asset's Rename and Move run in place on the Asset detail page,
// in real Chromium against the compiled client, real routes, templates, the
// asset action service and the filesystem. Every POST and GET is counted from
// the network; filenames and locations are read from the database and disk;
// the document, media host and media element are checked by identity. All data
// lives in a temporary root that is removed afterward.

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;
let clipWebm;

// WP10A3-A F2: the real server, seen from inside. Every Rename/Move POST that
// reaches it is recorded, and the service's renameAsset/moveAsset calls are
// counted. While `upstream.gate` is set, an arriving Rename/Move POST is held
// before Express (so before the route and the service) with its request open.
const upstream = { gate: null, arrivals: [], renameCalls: 0, moveCalls: 0 };
const pendingReleases = [];

function holdUpstreamFileActions() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  const gate = { promise, waiting: [] };
  upstream.gate = gate;
  const held = { gate, release: () => { if (upstream.gate === gate) upstream.gate = null; release(); } };
  pendingReleases.push(held.release);
  return held;
}

function serverHandler(req, res) {
  const pathname = new URL(req.url, 'http://upstream').pathname;
  if (req.method === 'POST' && FILE_POST.test(pathname)) {
    const arrival = {
      pathname,
      alive: () => !req.destroyed && !req.socket.destroyed && !req.aborted,
      released: false,
    };
    upstream.arrivals.push(arrival);
    const gate = upstream.gate;
    if (gate) {
      // Exactly one request is retained: any later one reaches the server at once.
      upstream.gate = null;
      gate.waiting.push(arrival);
      gate.promise.then(() => { arrival.released = true; app(req, res); });
      return;
    }
  }
  app(req, res);
}

test.afterEach(() => {
  while (pendingReleases.length) pendingReleases.pop()();
});

async function recordWebm(browser) {
  const page = await browser.newPage();
  try {
    const base64 = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 90;
      const context = canvas.getContext('2d');
      const recorder = new MediaRecorder(canvas.captureStream(15), { mimeType: 'video/webm;codecs=vp8' });
      const chunks = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
      let frame = 0;
      const timer = setInterval(() => {
        context.fillStyle = frame % 2 ? '#4f46e5' : '#f59e0b';
        context.fillRect(0, 0, 160, 90);
        frame += 1;
      }, 60);
      recorder.start();
      await new Promise((resolve) => setTimeout(resolve, 2500));
      recorder.stop();
      clearInterval(timer);
      await stopped;
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      let binary = '';
      bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
      return btoa(binary);
    });
    return Buffer.from(base64, 'base64');
  } finally {
    await page.close();
  }
}

test.beforeAll(async ({ browser }) => {
  clipWebm = await recordWebm(browser);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-file-actions-'));
  projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const viteDistRoot = path.join(root, 'client');
  const previewRoot = path.join(root, 'previews');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  fs.mkdirSync(previewRoot);
  await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, {
    appDataRoot, authState: { csrfPepper }, useViteAssets: true, viteDistRoot,
    assetManifest: createAssetManifest({ distRoot: viteDistRoot,
      manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
  });
  const service = app.locals.assetActionService;
  const realRename = service.renameAsset;
  const realMove = service.moveAsset;
  service.renameAsset = function countedRenameAsset(...args) {
    upstream.renameCalls += 1;
    return realRename.apply(this, args);
  };
  service.moveAsset = function countedMoveAsset(...args) {
    upstream.moveCalls += 1;
    return realMove.apply(this, args);
  };
  server = http.createServer(serverHandler);
  server.listen(0, '127.0.0.1');
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

let fixtureCount = 0;

async function createFixture({ subject = '02-subject.png' } = {}) {
  fixtureCount += 1;
  const project = app.locals.projectService.create({ title: `File Actions ${fixtureCount}`, status: 'tbd' });
  const categories = app.locals.projectAssetCategoryService;
  const ensure = (displayName, directorySlug) => categories.list(project.id).find((c) => c.directory_slug === directorySlug)
    || categories.add(project.id, { displayName, directorySlug });
  const wip = ensure('WIP', 'wip');
  const renders = ensure('Renders', 'renders');
  const directory = path.join(projectsRoot, project.project_dir);
  fs.mkdirSync(path.join(directory, 'wip'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'renders'), { recursive: true });
  for (const [index, filename] of ['01-first.png', '02-subject.png', '03-last.png'].entries()) {
    await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: index * 80, g: 90, b: 160 } } })
      .png().toFile(path.join(directory, 'wip', filename));
  }
  fs.writeFileSync(path.join(directory, 'wip', '04-clip.webm'), clipWebm);
  app.locals.assetScanner.scanProjectAssets(project.id);
  const assetId = (filename) => db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?')
    .get(project.id, filename).id;
  const id = assetId(subject);
  const tag = app.locals.tagService.createTag({ name: `File Tag ${fixtureCount}` });
  return {
    projectId: project.id,
    assetId: id,
    wipId: wip.id,
    rendersId: renders.id,
    tag,
    directory,
    url: `/projects/${project.id}/assets/${id}`,
    row: () => db.prepare('SELECT * FROM assets WHERE id = ?').get(id),
    onDisk: (relative) => fs.existsSync(path.join(directory, ...relative.split('/'))),
    savedTagIds: () => db.prepare('SELECT tag_id FROM asset_tags WHERE asset_id = ?').all(id).map((row) => row.tag_id),
    projectPrimary: () => app.locals.projectPrimaryImageService.getPrimaryImage(project.id)?.id ?? null,
  };
}

const FILE_POST = /^\/projects\/\d+\/assets\/\d+\/(rename|move)$/;
const PRIMARY_POST = /^\/projects\/\d+\/assets\/\d+\/(book-)?primary-image(\/remove)?$/;

async function open(page, url) {
  const net = { posts: [], gets: [], navigations: 0, postMode: 'pass', getMode: 'pass', primaryGate: null };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST') net.posts.push(new URL(request.url()).pathname);
  });
  await page.route((target) => FILE_POST.test(target.pathname), async (route) => {
    if (route.request().method() !== 'POST' || net.postMode === 'pass') return route.fallback();
    if (net.postMode === 'retain-upstream') {
      // F2B: forwarded to the real server, where the gate holds it before the
      // route runs; the browser keeps waiting and receives the real answer
      // once the request is let through.
      net.postMode = 'pass';
      const response = await route.fetch({ timeout: 60_000 });
      return route.fulfill({ response });
    }
    if (net.postMode === 'hold-upstream') {
      // The same request is forwarded to the real server, where the gate holds
      // it before the route runs; the browser's view of it is then lost while
      // the upstream request stays open.
      const before = upstream.arrivals.length;
      net.upstream = route.fetch({ timeout: 60_000 }).then(
        async (response) => ({ status: response.status(), body: await response.json().catch(() => null) }),
        (error) => ({ error: String(error) }),
      );
      for (let i = 0; i < 200 && upstream.arrivals.length === before; i += 1) await new Promise((r) => setTimeout(r, 10));
      net.postMode = 'pass';
      return route.abort('failed');
    }
    // Reaches the real server; only the browser's view of the answer is lost.
    await route.fetch();
    return route.abort('failed');
  });
  await page.route((target) => PRIMARY_POST.test(target.pathname), async (route) => {
    if (net.primaryGate) await net.primaryGate;
    return route.fallback();
  });
  await page.route((target) => /^\/projects\/\d+\/assets\/\d+$/.test(target.pathname), async (route) => {
    const request = route.request();
    if (request.resourceType() !== 'fetch') return route.fallback();
    net.gets.push(request.url());
    if (net.getMode === 'fail' || net.getMode === 'fail-once') {
      if (net.getMode === 'fail-once') net.getMode = 'pass';
      return route.fulfill({ status: 500, contentType: 'text/html', body: 'failed' });
    }
    return route.fallback();
  });
  if ((page.viewportSize()?.width ?? 1280) >= 768) await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${baseURL}${url}`);
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) net.navigations += 1; });
  await page.evaluate(() => {
    window.__sameDocument = true;
    const host = document.querySelector('[data-asset-viewer-host]');
    host.__sameHost = true;
    const media = host.querySelector('img, video');
    if (media) media.__sameMedia = true;
  });
  return { net, errors };
}

const dialog = (page) => page.locator('#asset-edit-dialog');
const status = (page) => page.locator('#asset-edit-dialog [data-asset-file-action-status-text]');
const retry = (page) => page.locator('[data-asset-file-action-retry]');
const renameButton = (page) => page.locator('form.asset-rename-form button[type="submit"]');
const moveButton = (page) => page.locator('form.asset-move-form button[type="submit"]');
const filePosts = (net) => net.posts.filter((pathname) => FILE_POST.test(pathname));

async function openEditAsset(page) {
  await page.locator('.asset-viewer-edit').click();
  await expect(dialog(page)).toHaveJSProperty('open', true);
}

async function openRename(page) {
  const summary = page.locator('summary', { hasText: 'Rename file' });
  if (!(await summary.evaluate((node) => node.parentElement.open))) await summary.click();
}

async function chooseDestination(page, label) {
  const summary = page.locator('summary', { hasText: 'Move file' });
  if (!(await summary.evaluate((node) => node.parentElement.open))) await summary.click();
  await page.locator('#move-destination-dropdown summary').click();
  await page.locator('#move-destination-dropdown label', { hasText: label }).click();
  const dropdown = page.locator('#move-destination-dropdown');
  if (await dropdown.evaluate((node) => node.open)) await dropdown.locator('summary').click();
}

async function chooseTagDraft(page, fixture) {
  // A refused tag save is not wanted here: the tag change is kept unsent by
  // ticking it in the native input without a change event.
  await page.locator(`#asset-tags-form input[value="${fixture.tag.id}"]`).evaluate((input) => { input.checked = true; });
}

async function sameDocument(page) {
  return page.evaluate(() => window.__sameDocument === true
    && document.querySelector('[data-asset-viewer-host]').__sameHost === true
    && (document.querySelector('[data-asset-viewer-host] img, [data-asset-viewer-host] video')?.__sameMedia ?? true) === true);
}

const destinationLabel = (page) => page.locator('#move-destination').evaluate((select) => select.selectedOptions[0].textContent.trim());

// WP10A3-A F2: the standing warnings and refusals of an unresolved or
// recovery-held Rename/Move.
const NOT_PROOF = 'This is what is saved now; it does not show whether your request ran.';
const UNRESOLVED_TAIL = 'Your request may still run, or may have only partly completed, so this asset cannot be renamed, moved or otherwise changed from this page. Check again only reads the saved details and sends nothing; reload the page once that request can no longer be running.';
const RECOVERY_TAIL = 'This asset cannot be renamed, moved or otherwise changed from this page until the project folder has been inspected. Reload the page to try again.';
const HELD_RENAME = 'This asset cannot be changed from this page while the earlier rename is unconfirmed. Use Check again, or reload the page once that request can no longer be running.';
const HELD_MOVE = 'This asset cannot be changed from this page while the earlier move is unconfirmed. Use Check again, or reload the page once that request can no longer be running.';
const HELD_RECOVERY = 'This asset cannot be changed from this page until the project folder has been inspected. Reload the page to try again.';

test('A: renames in place with one POST of the complete filename; database, disk and page agree', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  const urlBefore = page.url();
  const previewBefore = await page.locator('[data-asset-viewer-host] img').getAttribute('src');
  await openEditAsset(page);
  await chooseDestination(page, 'Renders'); // an unsent Move draft
  await chooseTagDraft(page, fixture);
  await openRename(page);
  await page.locator('#rename-filename').fill('02-cover-final.png');
  await renameButton(page).click();
  await expect(status(page)).toHaveText('The file was renamed to “02-cover-final.png”.');

  expect(filePosts(net)).toEqual([`/projects/${fixture.projectId}/assets/${fixture.assetId}/rename`]);
  expect(net.gets).toHaveLength(1);
  expect(net.navigations).toBe(0);
  expect(page.url()).toBe(urlBefore);
  expect(await sameDocument(page)).toBe(true);
  await expect(dialog(page)).toHaveJSProperty('open', true);
  expect(fixture.row()).toMatchObject({ id: fixture.assetId, filename: '02-cover-final.png', relative_path: 'wip/02-cover-final.png' });
  expect(fixture.onDisk('wip/02-cover-final.png')).toBe(true);
  expect(fixture.onDisk('wip/02-subject.png')).toBe(false);
  await expect(page.locator('.asset-metadata--summary code')).toHaveText('02-cover-final.png');
  await expect(page).toHaveTitle(/02-cover-final\.png$/);
  const preview = page.locator('[data-asset-viewer-host] img');
  expect(await preview.getAttribute('src')).not.toBe(previewBefore);
  await expect(page.locator('[data-asset-viewer-host] .asset-preview-link')).toHaveAttribute('aria-label', 'View original 02-cover-final.png');
  await expect(preview).toHaveJSProperty('complete', true);
  expect(await preview.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
  const original = await page.locator('[data-asset-viewer-host] .asset-preview-link').getAttribute('href');
  expect((await page.request.get(`${baseURL}${original}`)).status()).toBe(200);
  await expect(page.locator('#rename-filename')).toHaveAttribute('data-confirmed-value', '02-cover-final.png');
  await expect(page.locator('#rename-filename')).toHaveValue('02-cover-final.png');
  expect(await destinationLabel(page)).toBe('Renders');
  await expect(page.locator('#move-destination')).toHaveAttribute('data-confirmed-value', String(fixture.wipId));
  await expect(page.locator(`#asset-tags-form input[value="${fixture.tag.id}"]`)).toBeChecked();
  expect(fixture.savedTagIds()).toEqual([]);
  expect(await page.locator('[aria-live]').count()).toBe(1);
  expect(errors).toEqual([]);
});

test('B: moves in place; the asset ID stays and the location comes from the server', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await openRename(page);
  await page.locator('#rename-filename').fill('draft-name.png');
  await chooseDestination(page, 'Renders');
  await moveButton(page).click();
  await expect(status(page)).toHaveText('The file was moved to Renders.');

  expect(filePosts(net)).toEqual([`/projects/${fixture.projectId}/assets/${fixture.assetId}/move`]);
  expect(net.navigations).toBe(0);
  expect(await sameDocument(page)).toBe(true);
  await expect(page.locator('[data-asset-viewer-host]')).toHaveAttribute('data-asset-viewer-asset-id', String(fixture.assetId));
  expect(fixture.row()).toMatchObject({ id: fixture.assetId, category_id: fixture.rendersId, relative_path: 'renders/02-subject.png' });
  expect(fixture.onDisk('renders/02-subject.png')).toBe(true);
  expect(fixture.onDisk('wip/02-subject.png')).toBe(false);
  await expect(page.locator('.asset-metadata--summary dd').nth(1)).toContainText('/renders/');
  await expect(page.locator('[data-asset-viewer-region="file-details"] dd').first()).toContainText('Renders');
  await expect(page.locator('#move-destination')).toHaveAttribute('data-confirmed-value', String(fixture.rendersId));
  await expect(page.locator('#rename-filename')).toHaveValue('draft-name.png');
  await expect(page.locator('#rename-filename')).toHaveAttribute('data-confirmed-value', '02-subject.png');
  expect(errors).toEqual([]);
});

test('C: collision, invalid filename and invalid destination are refused locally with nothing changed', async ({ page }) => {
  const fixture = await createFixture();
  const { net } = await open(page, fixture.url);
  const before = fixture.row();
  await openEditAsset(page);
  await openRename(page);
  for (const [filename, message] of [
    ['01-first.png', 'Destination already exists.'],
    ['../escape.png', 'Enter a valid filename.'],
  ]) {
    await page.locator('#rename-filename').fill(filename);
    await renameButton(page).click();
    await expect(status(page)).toHaveText(`${message} Nothing was changed, and your entry was kept.`);
    await expect(page.locator('#rename-filename')).toHaveValue(filename);
    await expect(page.locator('#rename-filename')).toHaveAttribute('data-confirmed-value', '02-subject.png');
  }
  // A destination the form never offers (a tampered value) is refused by the route.
  await page.locator('#move-destination').evaluate((select) => {
    const option = document.createElement('option');
    option.value = 'not-a-category';
    option.textContent = 'Bogus';
    select.append(option);
    select.value = 'not-a-category';
  });
  await page.locator('form.asset-move-form').evaluate((form) => form.requestSubmit());
  await expect(status(page)).toHaveText('Choose a valid destination. Nothing was changed, and your entry was kept.');
  expect(filePosts(net)).toHaveLength(3);
  expect(net.gets).toHaveLength(0);
  expect(net.navigations).toBe(0);
  expect(await sameDocument(page)).toBe(true);
  expect(fixture.row()).toEqual(before);
  expect(fixture.onDisk('wip/02-subject.png')).toBe(true);
  await expect(page.locator('.asset-metadata--summary code')).toHaveText('02-subject.png');
});

test('D: media host — the image element stays with a fresh preview URL; a playing position survives a video rename', async ({ page }) => {
  const fixture = await createFixture({ subject: '04-clip.webm' });
  const { net, errors } = await open(page, fixture.url);
  const video = page.locator('[data-asset-viewer-host] video');
  await expect.poll(() => video.evaluate((node) => node.readyState)).toBeGreaterThanOrEqual(1);
  await video.evaluate(async (node) => {
    node.muted = true;
    await node.play().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 400));
    node.pause();
    node.currentTime = 1;
    await new Promise((resolve) => { node.addEventListener('seeked', resolve, { once: true }); setTimeout(resolve, 1000); });
  });
  const srcBefore = await video.getAttribute('src');
  const positionBefore = await video.evaluate((node) => node.currentTime);
  expect(positionBefore).toBeGreaterThan(0.5);
  await page.locator('[data-asset-video-loop]').check();
  const loopBefore = await video.evaluate((node) => node.loop);
  expect(loopBefore).toBe(true);
  await openEditAsset(page);
  await openRename(page);
  await page.locator('#rename-filename').fill('04-clip-renamed.webm');
  await renameButton(page).click();
  await expect(status(page)).toHaveText('The file was renamed to “04-clip-renamed.webm”.');
  expect(await sameDocument(page)).toBe(true);
  expect(await video.getAttribute('src')).toBe(srcBefore);
  expect(await video.evaluate((node) => node.currentTime)).toBeCloseTo(positionBefore, 3);
  expect(await video.evaluate((node) => node.loop)).toBe(loopBefore);
  await expect(page.locator('[data-asset-video-loop]')).toBeChecked();
  expect(await video.evaluate((node) => node.paused)).toBe(true);
  expect(fixture.row().filename).toBe('04-clip-renamed.webm');
  // The playback URL names the asset, so it still plays the renamed file.
  expect((await page.request.get(`${baseURL}${srcBefore}`)).status()).toBe(200);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveJSProperty('open', false);
  await expect(page.locator('.asset-preview-nav--previous')).toBeVisible();
  expect(filePosts(net)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('E: a move outside the current filter keeps the asset shown and says so truthfully', async ({ page }) => {
  const fixture = await createFixture();
  const { net } = await open(page, `${fixture.url}?category=${fixture.wipId}`);
  const urlBefore = page.url();
  await expect(page.locator('.asset-preview-nav--previous')).toHaveCount(1);
  await openEditAsset(page);
  await chooseTagDraft(page, fixture);
  await openRename(page);
  await page.locator('#rename-filename').fill('draft.png');
  await chooseDestination(page, 'Renders');
  await moveButton(page).click();
  await expect(status(page)).toHaveText('The file was moved to Renders. This asset no longer matches the current asset-browser filters, so Previous and Next are unavailable.');
  expect(page.url()).toBe(urlBefore);
  expect(await sameDocument(page)).toBe(true);
  expect(net.navigations).toBe(0);
  await expect(page.locator('[data-asset-viewer-region="filter-notice"]')).toHaveAttribute('data-asset-viewer-filtered-out', 'true');
  await expect(page.locator('[data-asset-viewer-region="filter-notice"] .notice')).toContainText('outside the current asset-browser filters');
  await expect(page.locator('.asset-preview-nav')).toHaveCount(0);
  await expect(page.locator('[data-asset-viewer-host] img')).toBeVisible();
  await expect(status(page)).not.toContainText('deleted');
  await expect(page.locator('#rename-filename')).toHaveValue('draft.png');
  await expect(page.locator(`#asset-tags-form input[value="${fixture.tag.id}"]`)).toBeChecked();
  expect(fixture.row().category_id).toBe(fixture.rendersId);
});

test('F: a failed refresh keeps the acknowledged rename; Retry refresh sends a GET only', async ({ page }) => {
  const fixture = await createFixture();
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);
  await openRename(page);
  net.getMode = 'fail-once';
  await page.locator('#rename-filename').fill('02-retry.png');
  await renameButton(page).click();
  await expect(status(page)).toHaveText('The file was renamed to “02-retry.png”. The file details shown on this page may be out of date.');
  expect(fixture.row().filename).toBe('02-retry.png');
  await expect(page.locator('.asset-metadata--summary code')).toHaveText('02-subject.png');
  await expect(renameButton(page)).toHaveAttribute('aria-disabled', 'true');
  await retry(page).click();
  await expect(status(page)).toHaveText('The file was renamed to “02-retry.png”.');
  expect(filePosts(net)).toHaveLength(1);
  expect(net.gets).toHaveLength(2);
  await expect(page.locator('.asset-metadata--summary code')).toHaveText('02-retry.png');
  await expect(renameButton(page)).not.toHaveAttribute('aria-disabled', 'true');
  expect(await sameDocument(page)).toBe(true);
});

test('G: a lost answer is never resent; Check again reads by GET and claims nothing', async ({ page }) => {
  const fixture = await createFixture();
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);
  await openRename(page);
  net.postMode = 'drop';
  net.getMode = 'fail-once';
  await page.locator('#rename-filename').fill('02-lost.png');
  await renameButton(page).click();
  await expect(status(page)).toHaveText(`The rename could not be confirmed. The saved file details could not be read. ${UNRESOLVED_TAIL}`);
  // The server did run it, but the page claims neither outcome.
  expect(fixture.row().filename).toBe('02-lost.png');
  await expect(retry(page)).toHaveText('Check again');
  // No competing file action while unresolved.
  await chooseDestination(page, 'Renders');
  await moveButton(page).click({ force: true });
  await expect(status(page)).toContainText(HELD_RENAME);
  expect(filePosts(net)).toHaveLength(1);
  await retry(page).click();
  await expect(status(page)).toHaveText(`The rename could not be confirmed. The saved filename is “02-lost.png”. ${NOT_PROOF} ${UNRESOLVED_TAIL}`);
  expect(filePosts(net)).toHaveLength(1);
  expect(net.gets).toHaveLength(2);
  await expect(page.locator('#rename-filename')).toHaveAttribute('data-confirmed-value', '02-lost.png');
  expect(fixture.row().category_id).toBe(fixture.wipId);
  expect(net.navigations).toBe(0);
});

test('H: a pending primary-image change blocks Rename without losing the draft; tags and primary stay correct', async ({ page }) => {
  const fixture = await createFixture();
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);
  await page.locator('#asset-tags-form summary').click();
  await page.locator(`#asset-tags-form input[value="${fixture.tag.id}"]`).click();
  await expect(page.locator('[data-asset-tags-status-text]')).toHaveText('Asset tags updated.');
  await page.locator('#asset-tags-form summary').click();
  await openRename(page);
  let release;
  net.primaryGate = new Promise((resolve) => { release = resolve; });
  await page.locator('form.asset-primary-image-set-form button').click();
  // The dialog is frozen while the primary POST is out: the submit is refused, not queued.
  await page.locator('form.asset-rename-form').evaluate((form) => {
    form.querySelector('#rename-filename').value = '02-blocked.png';
    form.requestSubmit();
  });
  await expect(status(page)).toHaveText('Wait for the current change to finish, then try again.');
  expect(filePosts(net)).toHaveLength(0);
  net.primaryGate = null;
  release();
  await expect(page.locator('[data-asset-primary-image-status-text]')).toHaveText('The primary image was set.');
  await expect(page.locator('#rename-filename')).toHaveValue('02-blocked.png');
  await renameButton(page).click();
  await expect(status(page)).toHaveText('The file was renamed to “02-blocked.png”.');
  expect(filePosts(net)).toHaveLength(1);
  expect(fixture.projectPrimary()).toBe(fixture.assetId);
  expect(fixture.savedTagIds()).toEqual([fixture.tag.id]);
  await expect(page.locator('.asset-primary-image-status')).toHaveText('Currently set as the primary image.');
  await expect(page.locator('[data-asset-viewer-region="tags"] .tag-chip')).toHaveCount(1);
  await expect(page.locator(`#asset-tags-form input[value="${fixture.tag.id}"]`)).toBeChecked();
});

test('I: keyboard — repeated Enter renames once, focus stays meaningful, Escape closes; one live region', async ({ page }) => {
  const fixture = await createFixture();
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);
  await openRename(page);
  await page.locator('#rename-filename').fill('02-keyboard.png');
  await page.locator('#rename-filename').press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(status(page)).toHaveText('The file was renamed to “02-keyboard.png”.');
  // Focus moved to the section heading: a late repeat cannot rename again.
  await expect(page.locator('#asset-actions-heading')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  expect(filePosts(net)).toHaveLength(1);
  expect(fixture.row().filename).toBe('02-keyboard.png');
  expect(await page.locator('[aria-live]').count()).toBe(1);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveJSProperty('open', false);
  await openEditAsset(page);
  await openRename(page);
  await expect(page.locator('#rename-filename')).toHaveValue('02-keyboard.png');
  expect(filePosts(net)).toHaveLength(1);
});

test('I: native Rename and Move still work without JavaScript', async ({ browser }) => {
  const fixture = await createFixture();
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto(`${baseURL}${fixture.url}?edit=1`);
    await page.locator('summary', { hasText: 'Rename file' }).click();
    await page.locator('#rename-filename').fill('02-native.png');
    await Promise.all([page.waitForNavigation(), renameButton(page).click()]);
    expect(new URL(page.url()).searchParams.get('notice')).toBe('asset-renamed');
    expect(fixture.row().filename).toBe('02-native.png');
    await page.locator('summary', { hasText: 'Move file' }).click();
    await page.locator('#move-destination').selectOption(String(fixture.rendersId));
    await Promise.all([page.waitForNavigation(), moveButton(page).click()]);
    expect(new URL(page.url()).searchParams.get('notice')).toBe('asset-moved');
    expect(fixture.row().relative_path).toBe('renders/02-native.png');
  } finally {
    await context.close();
  }
});

test('I: narrow layout with a long filename stays within the viewport', async ({ page }) => {
  const fixture = await createFixture();
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, fixture.url);
  await openEditAsset(page);
  await openRename(page);
  const long = `02-${'an-exceptionally-long-filename-segment-'.repeat(4)}final.png`;
  await page.locator('#rename-filename').fill(long);
  await renameButton(page).click();
  await expect(status(page)).toHaveText(`The file was renamed to “${long}”.`);
  expect(fixture.row().filename).toBe(long);
  const overflow = await page.evaluate(() => {
    const card = document.querySelector('#asset-edit-dialog .app-dialog-card') || document.querySelector('#asset-edit-dialog');
    return {
      dialog: card.scrollWidth - card.clientWidth,
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(overflow.dialog).toBeLessThanOrEqual(1);
  expect(overflow.page).toBeLessThanOrEqual(1);
});

// ─── WP10A3-A F2: an unresolved Rename or Move outlives every read ──────────
// The original POST is held at the real server, before the route and the
// service, with its request still open; only the browser's view of it is lost.
// A GET of the page then observes the unchanged row. No read may release the
// hold: when the held request is finally let through it runs exactly once,
// and nothing newer was admitted that it could overwrite.

const MUTATION_POST = /^\/projects\/\d+\/assets\/\d+\/(tags|rename|move|delete|primary-image(\/remove)?|book-primary-image(\/remove)?)$/;
const mutationPosts = (net) => net.posts.filter((pathname) => MUTATION_POST.test(pathname));
const fileHold = (page) => page.locator('form.asset-rename-form');
const settle = (page, ms = 300) => page.waitForTimeout(ms);
async function openDelete(page) {
  const summary = page.locator('#asset-edit-dialog summary', { hasText: 'Delete asset' });
  if (!(await summary.evaluate((node) => node.parentElement.open))) await summary.click();
}

async function heldAtServer(fixture, net, held, { renameCalls, moveCalls, arrivals }) {
  expect(upstream.arrivals.length - arrivals).toBe(1);
  expect(held.gate.waiting).toHaveLength(1);
  expect(held.gate.waiting[0].alive()).toBe(true);
  expect(held.gate.waiting[0].released).toBe(false);
  expect(upstream.renameCalls).toBe(renameCalls);
  expect(upstream.moveCalls).toBe(moveCalls);
}

const counters = () => ({ renameCalls: upstream.renameCalls, moveCalls: upstream.moveCalls, arrivals: upstream.arrivals.length });

test('F2-B1: a retained Rename POST stays held through an early GET; no second Rename is admitted', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  const before = counters();
  await openEditAsset(page);
  await openRename(page);
  await page.locator('#rename-filename').fill('earlier.png');
  const held = holdUpstreamFileActions();
  net.postMode = 'hold-upstream';
  await renameButton(page).click();

  // The early viewer GET observed the original row and installed it.
  const warning = `The rename could not be confirmed. The saved filename is “02-subject.png”. ${NOT_PROOF} ${UNRESOLVED_TAIL}`;
  await expect(status(page)).toHaveText(warning);
  await heldAtServer(fixture, net, held, before);
  expect(net.gets).toHaveLength(1);
  expect(fixture.row().filename).toBe('02-subject.png');
  await expect(page.locator('.asset-metadata--summary code')).toHaveText('02-subject.png');
  await expect(fileHold(page)).toHaveAttribute('data-asset-file-action-hold', 'unresolved');
  await expect(page.locator('#rename-filename')).toHaveAttribute('data-confirmed-value', '02-subject.png');

  // A second Rename by click, Enter and requestSubmit, and a Move: none is sent.
  await page.locator('#rename-filename').fill('latest.png');
  await renameButton(page).click({ force: true });
  await page.locator('#rename-filename').press('Enter');
  await page.locator('form.asset-rename-form').evaluate((form) => form.requestSubmit());
  await chooseDestination(page, 'Renders');
  await moveButton(page).click({ force: true });
  await settle(page);
  expect(filePosts(net)).toHaveLength(1);
  expect(upstream.arrivals.length - before.arrivals).toBe(1);
  await expect(status(page)).toHaveText(`${warning} ${HELD_RENAME}`);
  await expect(page.locator('#rename-filename')).toHaveValue('latest.png');
  await expect(page.locator('#rename-filename')).toHaveAttribute('data-confirmed-value', '02-subject.png');

  // Check again reads by GET only and keeps the hold.
  await retry(page).click();
  await expect(status(page)).toHaveText(warning);
  expect(net.gets).toHaveLength(2);
  expect(filePosts(net)).toHaveLength(1);
  await expect(fileHold(page)).toHaveAttribute('data-asset-file-action-hold', 'unresolved');
  expect(upstream.renameCalls).toBe(before.renameCalls);

  // The original request is let through: it runs exactly once.
  expect(held.gate.waiting[0].alive()).toBe(true);
  held.release();
  await expect.poll(() => upstream.renameCalls).toBe(before.renameCalls + 1);
  const answer = await net.upstream;
  expect(answer.status).toBe(200);
  expect(answer.body.outcome).toBe('committed');
  expect(fixture.row()).toMatchObject({ filename: 'earlier.png', relative_path: 'wip/earlier.png' });
  expect(fixture.onDisk('wip/earlier.png')).toBe(true);
  expect(fixture.onDisk('wip/02-subject.png')).toBe(false);
  expect(fixture.onDisk('wip/latest.png')).toBe(false);
  expect(upstream.arrivals.length - before.arrivals).toBe(1);
  expect(upstream.moveCalls).toBe(before.moveCalls);

  // The page claims nothing about it from reads: Check again shows what is
  // saved now, still as an observation, and the hold stands.
  await settle(page);
  await expect(status(page)).not.toContainText('was renamed');
  await retry(page).click();
  await expect(status(page)).toHaveText(`The rename could not be confirmed. The saved filename is “earlier.png”. ${NOT_PROOF} ${UNRESOLVED_TAIL}`);
  await expect(fileHold(page)).toHaveAttribute('data-asset-file-action-hold', 'unresolved');
  await expect(page.locator('#rename-filename')).toHaveValue('latest.png');
  expect(filePosts(net)).toHaveLength(1);
  expect(net.navigations).toBe(0);
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('F2-B2: a retained Move POST stays held through a GET of the original category', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  const before = counters();
  await openEditAsset(page);
  await chooseDestination(page, 'Renders');
  const held = holdUpstreamFileActions();
  net.postMode = 'hold-upstream';
  await moveButton(page).click();
  const warning = `The move could not be confirmed. The asset is saved in WIP. ${NOT_PROOF} ${UNRESOLVED_TAIL}`;
  await expect(status(page)).toHaveText(warning);
  await heldAtServer(fixture, net, held, before);
  expect(fixture.row().category_id).toBe(fixture.wipId);
  await expect(page.locator('#move-destination')).toHaveAttribute('data-confirmed-value', String(fixture.wipId));

  await chooseDestination(page, 'Uncategorized');
  await moveButton(page).click({ force: true });
  await openRename(page);
  await page.locator('#rename-filename').fill('02-other.png');
  await renameButton(page).click({ force: true });
  await settle(page);
  expect(filePosts(net)).toHaveLength(1);
  await expect(status(page)).toHaveText(`${warning} ${HELD_MOVE}`);
  await expect(fileHold(page)).toHaveAttribute('data-asset-file-action-hold', 'unresolved');

  held.release();
  await expect.poll(() => upstream.moveCalls).toBe(before.moveCalls + 1);
  const answer = await net.upstream;
  expect(answer.body.outcome).toBe('committed');
  expect(fixture.row()).toMatchObject({ category_id: fixture.rendersId, relative_path: 'renders/02-subject.png', filename: '02-subject.png' });
  expect(fixture.onDisk('renders/02-subject.png')).toBe(true);
  expect(fixture.onDisk('wip/02-subject.png')).toBe(false);
  expect(upstream.renameCalls).toBe(before.renameCalls);
  expect(upstream.arrivals.length - before.arrivals).toBe(1);
  await settle(page);
  await expect(status(page)).not.toContainText('was moved');
  await retry(page).click();
  await expect(status(page)).toHaveText(`The move could not be confirmed. The asset is saved in Renders. ${NOT_PROOF} ${UNRESOLVED_TAIL}`);
  expect(filePosts(net)).toHaveLength(1);
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('F2-B3: a real recovery-required Rename holds through the read of the original record', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await openRename(page);
  await page.locator('#rename-filename').fill('02-recovery.png');
  // The record update fails after the real file rename succeeded.
  const trigger = `wp10a3_f2_block_${fixture.assetId}`;
  db.exec(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON assets WHEN OLD.id = ${fixture.assetId} BEGIN SELECT RAISE(ABORT, 'blocked'); END;`);
  try {
    await renameButton(page).click();
    await expect(status(page)).toContainText(RECOVERY_TAIL);
  } finally {
    db.exec(`DROP TRIGGER ${trigger}`);
  }
  await expect(status(page)).toContainText('The details shown are CreatorCrate’s records, which may not match the project folder.');
  // The records still name the original file; the folder holds the new one.
  expect(fixture.row().filename).toBe('02-subject.png');
  expect(fixture.onDisk('wip/02-recovery.png')).toBe(true);
  expect(fixture.onDisk('wip/02-subject.png')).toBe(false);
  await expect(page.locator('.asset-metadata--summary code')).toHaveText('02-subject.png');
  await expect(fileHold(page)).toHaveAttribute('data-asset-file-action-hold', 'recovery');
  await expect(retry(page)).toHaveCount(0);
  const warning = await status(page).textContent();

  // Every other Edit Asset action stays refused, and nothing is resent.
  await renameButton(page).click({ force: true });
  await chooseDestination(page, 'Renders');
  await moveButton(page).click({ force: true });
  await page.locator('form.asset-primary-image-set-form button').click();
  await expect(page.locator('[data-asset-primary-image-status-text]')).toHaveText(HELD_RECOVERY);
  await openDelete(page);
  await page.locator('form.asset-delete-form button[type="submit"]').click();
  await expect(page.locator('[data-asset-delete-status-text]')).toHaveText(HELD_RECOVERY);
  await expect(page.locator('#app-confirmation-dialog')).toHaveJSProperty('open', false);
  await settle(page);
  expect(mutationPosts(net)).toHaveLength(1);
  await expect(status(page)).toContainText(warning);

  // Dismissed and reopened: the guidance and the hold are still there.
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveJSProperty('open', false);
  await openEditAsset(page);
  await expect(status(page)).toContainText(RECOVERY_TAIL);
  await expect(fileHold(page)).toHaveAttribute('data-asset-file-action-hold', 'recovery');
  await openRename(page);
  await expect(page.locator('#rename-filename')).toHaveValue('02-recovery.png');
  expect(mutationPosts(net)).toHaveLength(1);
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('F2-B4: a confirmed Move with a failed read stays acknowledged; Retry refresh is a GET only', async ({ page }) => {
  const fixture = await createFixture();
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);
  net.getMode = 'fail-once';
  await chooseDestination(page, 'Renders');
  await moveButton(page).click();
  await expect(status(page)).toHaveText('The file was moved to Renders. The file details shown on this page may be out of date.');
  expect(fixture.row().category_id).toBe(fixture.rendersId);
  await expect(fileHold(page)).toHaveAttribute('data-asset-file-action-hold', 'stale');
  await expect(retry(page)).toHaveText('Retry refresh');
  await expect(page.locator('#move-destination')).toHaveAttribute('data-confirmed-value', String(fixture.rendersId));
  await moveButton(page).click({ force: true });
  expect(filePosts(net)).toHaveLength(1);
  await retry(page).click();
  await expect(status(page)).toHaveText('The file was moved to Renders.');
  expect(filePosts(net)).toHaveLength(1);
  expect(net.gets).toHaveLength(2);
  await expect(page.locator('[data-asset-viewer-region="file-details"] dd').first()).toContainText('Renders');
  await expect(fileHold(page)).not.toHaveAttribute('data-asset-file-action-hold', /.+/);
  // Not a standing hold: the next change is sent normally.
  await openRename(page);
  await page.locator('#rename-filename').fill('02-after.png');
  await renameButton(page).click();
  await expect(status(page)).toHaveText('The file was renamed to “02-after.png”.');
  expect(fixture.row().relative_path).toBe('renders/02-after.png');
  expect(await sameDocument(page)).toBe(true);
});

test('F2-B5: dismissing and reopening keeps the hold, the drafts and the media; the held request runs once', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  const before = counters();
  await openEditAsset(page);
  await openRename(page);
  await page.locator('#rename-filename').fill('earlier.png');
  const held = holdUpstreamFileActions();
  net.postMode = 'hold-upstream';
  await renameButton(page).click();
  await expect(status(page)).toContainText(UNRESOLVED_TAIL);
  await heldAtServer(fixture, net, held, before);

  await page.locator('#rename-filename').fill('latest.png');
  await chooseDestination(page, 'Renders');
  await chooseTagDraft(page, fixture);
  const warning = await status(page).textContent();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveJSProperty('open', false);
  await openEditAsset(page);
  await expect(status(page)).toHaveText(warning);
  await expect(retry(page)).toHaveText('Check again');
  await openRename(page);
  await expect(page.locator('#rename-filename')).toHaveValue('latest.png');
  await expect(page.locator('#rename-filename')).toHaveAttribute('data-confirmed-value', '02-subject.png');
  expect(await destinationLabel(page)).toBe('Renders');
  await expect(page.locator('#move-destination')).toHaveAttribute('data-confirmed-value', String(fixture.wipId));
  await expect(page.locator(`#asset-tags-form input[value="${fixture.tag.id}"]`)).toBeChecked();
  await expect(fileHold(page)).toHaveAttribute('data-asset-file-action-hold', 'unresolved');
  await renameButton(page).click({ force: true });
  await moveButton(page).click({ force: true });
  await settle(page);
  expect(mutationPosts(net)).toHaveLength(1);

  held.release();
  await expect.poll(() => upstream.renameCalls).toBe(before.renameCalls + 1);
  await net.upstream;
  expect(fixture.row().filename).toBe('earlier.png');
  expect(fixture.savedTagIds()).toEqual([]);
  expect(upstream.arrivals.length - before.arrivals).toBe(1);
  expect(await sameDocument(page)).toBe(true);
  expect(net.navigations).toBe(0);
  expect(errors).toEqual([]);
});

test('F2-B6: ordinary Rename, Move and refusals still save locally; a proven refusal leaves the next action free', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await openRename(page);
  await page.locator('#rename-filename').fill('01-first.png');
  await renameButton(page).click();
  await expect(status(page)).toHaveText('Destination already exists. Nothing was changed, and your entry was kept.');
  await expect(fileHold(page)).not.toHaveAttribute('data-asset-file-action-hold', /.+/);
  await page.locator('#rename-filename').fill('02-ordinary.png');
  await renameButton(page).click();
  await expect(status(page)).toHaveText('The file was renamed to “02-ordinary.png”.');
  await chooseDestination(page, 'Renders');
  await moveButton(page).click();
  await expect(status(page)).toHaveText('The file was moved to Renders.');
  expect(fixture.row()).toMatchObject({ filename: '02-ordinary.png', relative_path: 'renders/02-ordinary.png', category_id: fixture.rendersId });
  await expect(page.locator('#rename-filename')).toHaveAttribute('data-confirmed-value', '02-ordinary.png');
  await expect(page.locator('#move-destination')).toHaveAttribute('data-confirmed-value', String(fixture.rendersId));
  expect(filePosts(net)).toHaveLength(3);
  expect(net.navigations).toBe(0);
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('F2-B7: with an unresolved Rename, Tag Save, primary image, Delete, Rename and Move send nothing', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  const before = counters();
  await openEditAsset(page);
  await openRename(page);
  await page.locator('#rename-filename').fill('earlier.png');
  const held = holdUpstreamFileActions();
  net.postMode = 'hold-upstream';
  await renameButton(page).click();
  await expect(status(page)).toContainText(UNRESOLVED_TAIL);
  await heldAtServer(fixture, net, held, before);
  const warning = await status(page).textContent();

  await page.locator('#asset-tags-form summary').click();
  await page.locator(`#asset-tags-form input[value="${fixture.tag.id}"]`).click();
  await expect(page.locator('[data-asset-tags-status-text]')).toHaveText(`${HELD_RENAME} Your latest tag selection was not saved.`); // WP10A1-F3: the draft is kept, not reset
  await page.locator('#asset-tags-form summary').click();
  await page.locator('form.asset-primary-image-set-form button').click();
  await expect(page.locator('[data-asset-primary-image-status-text]')).toHaveText(HELD_RENAME);
  await openDelete(page);
  await page.locator('form.asset-delete-form button[type="submit"]').click();
  await expect(page.locator('[data-asset-delete-status-text]')).toHaveText(HELD_RENAME);
  await expect(page.locator('#app-confirmation-dialog')).toHaveJSProperty('open', false);
  await page.locator('form.asset-delete-form').evaluate((form) => form.requestSubmit());
  await renameButton(page).click({ force: true });
  await moveButton(page).click({ force: true });
  await settle(page);
  expect(mutationPosts(net)).toEqual([`/projects/${fixture.projectId}/assets/${fixture.assetId}/rename`]);
  await expect(status(page)).toHaveText(`${warning} ${HELD_RENAME}`);
  expect(fixture.savedTagIds()).toEqual([]);
  expect(fixture.projectPrimary()).toBeNull();

  held.release();
  await expect.poll(() => upstream.renameCalls).toBe(before.renameCalls + 1);
  await net.upstream;
  expect(fixture.row().filename).toBe('earlier.png');
  expect(mutationPosts(net)).toHaveLength(1);
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

// ─── WP10A3-A F2B: a delayed Rename or Move never overwrites a newer state ──
// Tab A's POST is held at the real server before the route and the service,
// with its request open. Meanwhile another document (a second tab, or the same
// tab after a reload) commits a newer change. When the held request is let
// through, the service compares its reviewed state with the row under the
// project lock and refuses it before any file step: the newer row and file
// survive, nothing is retried, and the page that sent it is told the truth.

const STALE_RENAME = 'This asset was renamed, moved or replaced after this change was reviewed, so it was not renamed. Review the asset as it is now and submit the change again if you still want to.';
const STALE_MOVE = 'This asset was renamed, moved or replaced after this change was reviewed, so it was not moved. Review the asset as it is now and submit the change again if you still want to.';
const KEPT = 'Nothing was changed, and your entry was kept.';
const shownReviews = (page) => page.locator('#asset-edit-dialog input[data-asset-review]')
  .evaluateAll((inputs) => inputs.map((input) => input.value));
const tree = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
  ? tree(path.join(dir, entry.name), `${prefix}${entry.name}/`)
  : [`${prefix}${entry.name}`])).sort();
const fileLogs = (projectId) => db.prepare(
  "SELECT event FROM application_logs WHERE project_id = ? AND event IN ('asset.renamed', 'asset.moved') ORDER BY id",
).all(projectId).map((row) => row.event);
async function arrived(count) {
  await expect.poll(() => upstream.arrivals.length).toBe(count);
}

test('F2B-B1: a Rename retained before the service, overtaken by a second tab, is refused as stale', async ({ page }) => {
  const fixture = await createFixture();
  const tabA = await open(page, fixture.url);
  const pageB = await page.context().newPage();
  const tabB = await open(pageB, fixture.url);
  const before = counters();
  const reviewA = assetReviewToken(fixture.row());
  expect(await shownReviews(page)).toEqual([reviewA, reviewA]);

  // Tab A: Rename to earlier.png, retained upstream with its request open.
  await openEditAsset(page);
  await openRename(page);
  await page.locator('#rename-filename').fill('earlier.png');
  const held = holdUpstreamFileActions();
  tabA.net.postMode = 'retain-upstream';
  await renameButton(page).click();
  await arrived(before.arrivals + 1);
  expect(held.gate.waiting).toHaveLength(1);
  expect(held.gate.waiting[0].alive()).toBe(true);
  expect(held.gate.waiting[0].released).toBe(false);
  expect(upstream.renameCalls).toBe(before.renameCalls);
  await expect(status(page)).toHaveText('Renaming the file to “earlier.png”…');

  // Tab B: Rename to latest.png commits, and its viewer refresh installs it.
  await openEditAsset(pageB);
  await openRename(pageB);
  await pageB.locator('#rename-filename').fill('latest.png');
  await renameButton(pageB).click();
  await expect(status(pageB)).toHaveText('The file was renamed to “latest.png”.');
  expect(upstream.renameCalls).toBe(before.renameCalls + 1);
  expect(upstream.arrivals.length - before.arrivals).toBe(2);
  const latest = fixture.row();
  expect(latest).toMatchObject({ filename: 'latest.png', relative_path: 'wip/latest.png' });
  expect(fixture.onDisk('wip/latest.png')).toBe(true);
  const reviewB = assetReviewToken(latest);
  expect(await shownReviews(pageB)).toEqual([reviewB, reviewB]);
  await expect(pageB.locator('#rename-filename')).toHaveAttribute('data-confirmed-value', 'latest.png');
  const disk = tree(fixture.directory);
  const logs = fileLogs(fixture.projectId);
  expect(held.gate.waiting[0].alive()).toBe(true);

  // Tab A's original Rename is let through: the service runs once and refuses it.
  held.release();
  await expect.poll(() => upstream.renameCalls).toBe(before.renameCalls + 2);
  await expect(status(page)).toHaveText(`${STALE_RENAME} ${KEPT}`);
  expect(fixture.row()).toEqual(latest);
  expect(fixture.onDisk('wip/latest.png')).toBe(true);
  expect(fixture.onDisk('wip/earlier.png')).toBe(false);
  expect(fixture.onDisk('wip/02-subject.png')).toBe(false);
  expect(tree(fixture.directory)).toEqual(disk);
  expect(fileLogs(fixture.projectId)).toEqual(logs);

  // Tab A read the page once (GET only): it shows latest.png, keeps the entry,
  // carries tab B's reviewed state and sent nothing again.
  expect(filePosts(tabA.net)).toHaveLength(1);
  expect(tabA.net.gets).toHaveLength(1);
  expect(upstream.arrivals.length - before.arrivals).toBe(2);
  await expect(page.locator('.asset-metadata--summary code')).toHaveText('latest.png');
  await expect(page.locator('#rename-filename')).toHaveValue('earlier.png');
  await expect(page.locator('#rename-filename')).toHaveAttribute('data-confirmed-value', 'latest.png');
  expect(await shownReviews(page)).toEqual([reviewB, reviewB]);
  await expect(fileHold(page)).not.toHaveAttribute('data-asset-file-action-hold', /.+/);
  expect(tabA.net.navigations).toBe(0);
  expect(await sameDocument(page)).toBe(true);

  // Tab B stays valid and truthful.
  await expect(pageB.locator('.asset-metadata--summary code')).toHaveText('latest.png');
  expect(filePosts(tabB.net)).toHaveLength(1);
  expect(tabA.errors).toEqual([]);
  expect(tabB.errors).toEqual([]);
  await pageB.close();
});

test('F2B-B2: a Move retained before the service, overtaken by a second tab, is refused as stale', async ({ page }) => {
  const fixture = await createFixture();
  const tabA = await open(page, fixture.url);
  const pageB = await page.context().newPage();
  const tabB = await open(pageB, fixture.url);
  const before = counters();

  // Tab A: Move to Renders, retained upstream.
  await openEditAsset(page);
  await chooseDestination(page, 'Renders');
  const held = holdUpstreamFileActions();
  tabA.net.postMode = 'retain-upstream';
  await moveButton(page).click();
  await arrived(before.arrivals + 1);
  expect(held.gate.waiting[0].alive()).toBe(true);
  expect(upstream.moveCalls).toBe(before.moveCalls);

  // Tab B: Move to Uncategorized, then Rename, both commit.
  await openEditAsset(pageB);
  await chooseDestination(pageB, 'Uncategorized');
  await moveButton(pageB).click();
  await expect(status(pageB)).toHaveText('The file was moved to Uncategorized.');
  await openRename(pageB);
  await pageB.locator('#rename-filename').fill('02-newer.png');
  await renameButton(pageB).click();
  await expect(status(pageB)).toHaveText('The file was renamed to “02-newer.png”.');
  const newer = fixture.row();
  expect(newer).toMatchObject({ category_id: null, relative_path: '02-newer.png' });
  expect(upstream.moveCalls).toBe(before.moveCalls + 1);
  const disk = tree(fixture.directory);

  held.release();
  await expect.poll(() => upstream.moveCalls).toBe(before.moveCalls + 2);
  await expect(status(page)).toHaveText(`${STALE_MOVE} ${KEPT}`);
  expect(fixture.row()).toEqual(newer);
  expect(fixture.onDisk('02-newer.png')).toBe(true);
  expect(fixture.onDisk('renders/02-newer.png')).toBe(false);
  expect(fixture.onDisk('renders/02-subject.png')).toBe(false);
  expect(tree(fixture.directory)).toEqual(disk);
  expect(fileLogs(fixture.projectId)).toEqual(['asset.moved', 'asset.renamed']);

  // No false success, no navigation; the page shows the newer state and keeps
  // the Renders choice as an unsent draft.
  expect(filePosts(tabA.net)).toHaveLength(1);
  expect(tabA.net.navigations).toBe(0);
  expect(new URL(page.url()).pathname).toBe(fixture.url);
  await expect(page.locator('.asset-metadata--summary code')).toHaveText('02-newer.png');
  expect(await destinationLabel(page)).toBe('Renders');
  await expect(page.locator('#move-destination')).toHaveAttribute('data-confirmed-value', 'uncategorized');
  expect(await shownReviews(page)).toEqual([assetReviewToken(newer), assetReviewToken(newer)]);
  expect(await sameDocument(page)).toBe(true);
  expect(filePosts(tabB.net)).toHaveLength(2);
  expect(tabA.errors).toEqual([]);
  await pageB.close();
});

test('F2B-B3: after a reload, a newer change survives the release of the original retained Rename', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  const before = counters();
  await openEditAsset(page);
  await openRename(page);
  await page.locator('#rename-filename').fill('earlier.png');
  const held = holdUpstreamFileActions();
  net.postMode = 'hold-upstream';
  await renameButton(page).click();
  // The browser loses track of it; the request stays open at the server.
  await expect(status(page)).toContainText(UNRESOLVED_TAIL);
  await heldAtServer(fixture, net, held, before);

  // A reload is a new document: it cannot inherit the old page's hold.
  await page.reload();
  await openEditAsset(page);
  await chooseDestination(page, 'Renders');
  await moveButton(page).click();
  await expect(status(page)).toHaveText('The file was moved to Renders.');
  const moved = fixture.row();
  expect(moved).toMatchObject({ category_id: fixture.rendersId, relative_path: 'renders/02-subject.png' });
  const disk = tree(fixture.directory);
  expect(upstream.renameCalls).toBe(before.renameCalls);

  expect(held.gate.waiting[0].alive()).toBe(true);
  held.release();
  await expect.poll(() => upstream.renameCalls).toBe(before.renameCalls + 1);
  const answer = await net.upstream;
  expect(answer.status).toBe(409);
  expect(answer.body).toEqual({ status: 'error', code: 'ASSET_REVIEW_STALE', outcome: 'refused', message: STALE_RENAME });
  expect(fixture.row()).toEqual(moved);
  expect(fixture.onDisk('renders/02-subject.png')).toBe(true);
  expect(fixture.onDisk('wip/earlier.png')).toBe(false);
  expect(fixture.onDisk('renders/earlier.png')).toBe(false);
  expect(tree(fixture.directory)).toEqual(disk);
  // Nothing replays it: two file POSTs in all (the held one and the Move).
  await settle(page);
  expect(upstream.arrivals.length - before.arrivals).toBe(2);
  expect(filePosts(net)).toHaveLength(2);
  expect(fileLogs(fixture.projectId)).toEqual(['asset.moved']);
  expect(errors).toEqual([]);
});

test('F2B-B4: in one document, each confirmed change installs the next reviewed state', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await chooseTagDraft(page, fixture); // an unrelated unsent draft
  const seen = [];
  const expectCurrent = async () => {
    const review = assetReviewToken(fixture.row());
    expect(await shownReviews(page)).toEqual([review, review]);
    // Every change moves the page to a new reviewed state (A → B → A returns
    // to A's: see the WIP move-back below).
    if (seen.length) expect(review).not.toBe(seen[seen.length - 1]);
    seen.push(review);
  };
  await expectCurrent();

  await openRename(page);
  await page.locator('#rename-filename').fill('02-step-one.png');
  await renameButton(page).click();
  await expect(status(page)).toHaveText('The file was renamed to “02-step-one.png”.');
  await expectCurrent();

  await chooseDestination(page, 'Renders');
  await moveButton(page).click();
  await expect(status(page)).toHaveText('The file was moved to Renders.');
  await expectCurrent();

  await chooseDestination(page, 'WIP');
  await moveButton(page).click();
  await expect(status(page)).toHaveText('The file was moved to WIP.');
  await expectCurrent();
  // Back at wip/02-step-one.png with the same source: in every recorded
  // respect the asset after the first Rename, so its reviewed state repeats.
  expect(seen[3]).toBe(seen[1]);

  await openRename(page);
  await page.locator('#rename-filename').fill('02-step-two.png');
  await renameButton(page).click();
  await expect(status(page)).toHaveText('The file was renamed to “02-step-two.png”.');
  await expectCurrent();

  expect(fixture.row().relative_path).toBe('wip/02-step-two.png');
  expect(filePosts(net)).toHaveLength(4);
  expect(net.gets).toHaveLength(4);
  await expect(page.locator(`#asset-tags-form input[value="${fixture.tag.id}"]`)).toBeChecked();
  expect(fixture.savedTagIds()).toEqual([]);
  // The media and its source still follow the saved file.
  const original = await page.locator('[data-asset-viewer-host] .asset-preview-link').getAttribute('href');
  expect((await page.request.get(`${baseURL}${original}`)).status()).toBe(200);
  await expect(page.locator('[data-asset-viewer-host] .asset-preview-link')).toHaveAttribute('aria-label', 'View original 02-step-two.png');
  expect(new URL(page.url()).pathname).toBe(fixture.url);
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('F2B-B5: after a failed refresh the old reviewed state is refused, by the page and by the server', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  const reviewA = assetReviewToken(fixture.row());
  await openEditAsset(page);
  net.getMode = 'fail-once';
  await openRename(page);
  await page.locator('#rename-filename').fill('02-renamed.png');
  await renameButton(page).click();
  await expect(status(page)).toHaveText('The file was renamed to “02-renamed.png”. The file details shown on this page may be out of date.');
  const renamed = fixture.row();
  expect(renamed.relative_path).toBe('wip/02-renamed.png');
  // The page still carries the review of what it last read.
  expect(await shownReviews(page)).toEqual([reviewA, reviewA]);

  // The page sends nothing more while the shown details are unconfirmed.
  await chooseDestination(page, 'Renders');
  await moveButton(page).click({ force: true });
  await settle(page);
  expect(filePosts(net)).toHaveLength(1);

  // Even sent directly, the old reviewed state is refused before any file step.
  const csrf = await page.locator('form.asset-move-form input[name="_csrf"]').inputValue();
  const direct = await page.request.post(`${baseURL}/projects/${fixture.projectId}/assets/${fixture.assetId}/move`, {
    headers: { Accept: 'application/json' },
    form: { _csrf: csrf, destinationCategory: String(fixture.rendersId), assetReview: reviewA },
  });
  expect(direct.status()).toBe(409);
  expect(await direct.json()).toMatchObject({ code: 'ASSET_REVIEW_STALE', outcome: 'refused' });
  expect(fixture.row()).toEqual(renamed);

  // Retry refresh is a GET only; it installs the current review, and the
  // Move kept as a draft is then a new, intentional change that runs.
  await retry(page).click();
  await expect(status(page)).toHaveText('The file was renamed to “02-renamed.png”.');
  expect(filePosts(net)).toHaveLength(1);
  expect(await shownReviews(page)).toEqual([assetReviewToken(renamed), assetReviewToken(renamed)]);
  expect(await destinationLabel(page)).toBe('Renders');
  await moveButton(page).click();
  await expect(status(page)).toHaveText('The file was moved to Renders.');
  expect(fixture.row().relative_path).toBe('renders/02-renamed.png');
  expect(errors).toEqual([]);
});

test('F2B-B6: native forms carry the reviewed state; a missing or stale one is refused and re-rendered', async ({ browser }) => {
  const fixture = await createFixture();
  const context = await browser.newContext({ javaScriptEnabled: false });
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  try {
    await pageA.goto(`${baseURL}${fixture.url}?edit=1`);
    await pageB.goto(`${baseURL}${fixture.url}?edit=1`);
    const reviewA = assetReviewToken(fixture.row());
    expect(await pageA.locator('input[data-asset-review]').evaluateAll((inputs) => inputs.map((input) => input.value)))
      .toEqual([reviewA, reviewA]);

    // Tab B renames natively.
    await pageB.locator('summary', { hasText: 'Rename file' }).click();
    await pageB.locator('#rename-filename').fill('02-native-b.png');
    await Promise.all([pageB.waitForNavigation(), renameButton(pageB).click()]);
    expect(new URL(pageB.url()).searchParams.get('notice')).toBe('asset-renamed');
    const renamed = fixture.row();
    expect(renamed.filename).toBe('02-native-b.png');

    // Tab A's form, rendered before that, is refused and re-rendered.
    await pageA.locator('summary', { hasText: 'Rename file' }).click();
    await pageA.locator('#rename-filename').fill('02-native-a.png');
    const [response] = await Promise.all([pageA.waitForNavigation(), renameButton(pageA).click()]);
    expect(response.status()).toBe(409);
    await expect(pageA.locator('#asset-edit-dialog')).toContainText(STALE_RENAME);
    await expect(pageA.locator('#rename-filename')).toHaveValue('02-native-a.png');
    expect(fixture.row()).toEqual(renamed);
    expect(fixture.onDisk('wip/02-native-b.png')).toBe(true);
    expect(fixture.onDisk('wip/02-native-a.png')).toBe(false);

    // A stale native Move is refused the same way.
    await pageB.locator('summary', { hasText: 'Move file' }).click();
    await pageB.locator('#move-destination').selectOption(String(fixture.rendersId));
    const staleMoveReview = await pageB.locator('form.asset-move-form input[data-asset-review]').inputValue();
    expect(staleMoveReview).toBe(assetReviewToken(renamed));
    // (pageA's re-render now carries the current review; it moves first.)
    await pageA.locator('summary', { hasText: 'Move file' }).click();
    await pageA.locator('#move-destination').selectOption('uncategorized');
    await Promise.all([pageA.waitForNavigation(), moveButton(pageA).click()]);
    expect(new URL(pageA.url()).searchParams.get('notice')).toBe('asset-moved');
    expect(fixture.row().relative_path).toBe('02-native-b.png');
    const [staleMove] = await Promise.all([pageB.waitForNavigation(), moveButton(pageB).click()]);
    expect(staleMove.status()).toBe(409);
    await expect(pageB.locator('#asset-edit-dialog')).toContainText(STALE_MOVE);
    expect(fixture.row().relative_path).toBe('02-native-b.png');
    expect(fixture.onDisk('renders/02-native-b.png')).toBe(false);

    // A request without the field is refused before the service.
    const calls = upstream.renameCalls;
    const csrf = await pageA.locator('form.asset-rename-form input[name="_csrf"]').inputValue();
    const missing = await pageA.request.post(`${baseURL}/projects/${fixture.projectId}/assets/${fixture.assetId}/rename`, {
      form: { _csrf: csrf, origin: 'viewer', filename: '02-no-review.png' },
      maxRedirects: 0,
    });
    expect(missing.status()).toBe(422);
    expect(await missing.text()).toContain('This request does not identify the asset version you reviewed, so the file was not renamed. Reload the page and try again.');
    expect(upstream.renameCalls).toBe(calls + 1);
    expect(fixture.row().relative_path).toBe('02-native-b.png');
  } finally {
    await context.close();
  }
});
