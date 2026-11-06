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
import { createProjectOperationCoordinator } from '../../src/services/project-operation-coordinator.js';

// WP10A3-B: Edit Asset's Delete runs locally on the Asset detail page up to
// the moment the asset is gone, in real Chromium against the compiled client,
// real routes, templates, the shared confirmation, the asset action service
// and the filesystem. Every POST and GET is counted from the network; records
// and files are read from the database and disk; the document, media host and
// media element are checked by identity. Faults are injected into the real
// server's filesystem calls (it runs in this process). All data lives in a
// temporary root that is removed afterward.

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;
let coordinator;

const STAGING_PREFIX = '.creatorcrate-delete-';

// The real server, seen from inside: every Delete POST that reaches it, and
// how often the Delete service actually ran. While `upstream.gate` is set, a
// Delete POST that has arrived is held before Express (and so before the
// route and the service) sees it; its request stays open until released.
const upstream = { gate: null, arrivals: [], serviceCalls: 0 };

function holdUpstreamDeletes() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  const gate = { promise, waiting: [] };
  upstream.gate = gate;
  return { gate, release: () => { if (upstream.gate === gate) upstream.gate = null; release(); } };
}

function serverHandler(req, res) {
  const pathname = new URL(req.url, 'http://upstream').pathname;
  if (req.method === 'POST' && DELETE_POST.test(pathname)) {
    const arrival = {
      pathname,
      // The client side of this exact request went away before it ran.
      alive: () => !req.destroyed && !req.socket.destroyed && !req.aborted,
      released: false,
    };
    upstream.arrivals.push(arrival);
    const gate = upstream.gate;
    if (gate) {
      gate.waiting.push(arrival);
      gate.promise.then(() => { arrival.released = true; app(req, res); });
      return;
    }
  }
  app(req, res);
}

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-delete-'));
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
  coordinator = createProjectOperationCoordinator();
  app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, {
    appDataRoot, authState: { csrfPepper }, useViteAssets: true, viteDistRoot,
    projectOperationCoordinator: coordinator,
    assetManifest: createAssetManifest({ distRoot: viteDistRoot,
      manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
  });
  const service = app.locals.assetActionService;
  const realDeleteAssets = service.deleteAssets;
  service.deleteAssets = function countedDeleteAssets(...args) {
    upstream.serviceCalls += 1;
    return realDeleteAssets.apply(this, args);
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

async function createFixture() {
  fixtureCount += 1;
  const project = app.locals.projectService.create({ title: `Delete ${fixtureCount}`, status: 'tbd' });
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
  app.locals.assetScanner.scanProjectAssets(project.id);
  const assetId = (filename) => db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?')
    .get(project.id, filename).id;
  const id = assetId('02-subject.png');
  const tag = app.locals.tagService.createTag({ name: `Delete Tag ${fixtureCount}` });
  const stagingDirs = () => fs.readdirSync(directory).filter((name) => name.startsWith(STAGING_PREFIX));
  return {
    projectId: project.id,
    assetId: id,
    otherIds: [assetId('01-first.png'), assetId('03-last.png')],
    wipId: wip.id,
    rendersId: renders.id,
    tag,
    directory,
    url: `/projects/${project.id}/assets/${id}?category=${wip.id}`,
    row: () => db.prepare('SELECT * FROM assets WHERE id = ?').get(id),
    count: () => db.prepare('SELECT COUNT(*) AS n FROM assets WHERE project_id = ?').get(project.id).n,
    onDisk: (relative) => fs.existsSync(path.join(directory, ...relative.split('/'))),
    stagingDirs,
    stagedFiles: () => stagingDirs().flatMap((name) => fs.readdirSync(path.join(directory, name))),
    savedTagIds: () => db.prepare('SELECT tag_id FROM asset_tags WHERE asset_id = ?').all(id).map((row) => row.tag_id),
  };
}

const DELETE_POST = /^\/projects\/\d+\/assets\/\d+\/delete$/;
const MUTATION_POST = /^\/projects\/\d+\/assets\/\d+\/(tags|rename|move|delete|primary-image(\/remove)?|book-primary-image(\/remove)?)$/;

async function open(page, url) {
  const net = { posts: [], gets: [], navigations: [], deleteMode: 'pass', getMode: 'pass', gate: null };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST') net.posts.push(new URL(request.url()).pathname);
  });
  await page.route((target) => MUTATION_POST.test(target.pathname), async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    if (net.gate) await net.gate.promise;
    if (DELETE_POST.test(new URL(route.request().url()).pathname) && net.deleteMode === 'hold-upstream') {
      // The same request is forwarded to the real server, where the gate holds
      // it before the route runs; the browser's view of it is then lost while
      // the upstream request stays open.
      const before = upstream.arrivals.length;
      net.upstream = route.fetch({ timeout: 60_000 }).then(
        async (response) => ({ status: response.status(), body: await response.json().catch(() => null) }),
        (error) => ({ error: String(error) }),
      );
      for (let i = 0; i < 200 && upstream.arrivals.length === before; i += 1) await new Promise((r) => setTimeout(r, 10));
      return route.abort('failed');
    }
    if (DELETE_POST.test(new URL(route.request().url()).pathname) && net.deleteMode === 'lose') {
      // Reaches the real server; only the browser's view of the answer is lost.
      await route.fetch();
      return route.abort('failed');
    }
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
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) net.navigations.push(frame.url()); });
  await page.evaluate(() => {
    window.__sameDocument = true;
    const host = document.querySelector('[data-asset-viewer-host]');
    host.__sameHost = true;
    const media = host.querySelector('img, video');
    if (media) media.__sameMedia = true;
  });
  return { net, errors };
}

function gate(net) {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  net.gate = { promise };
  return () => { net.gate = null; release(); };
}

const dialog = (page) => page.locator('#asset-edit-dialog');
const confirmation = (page) => page.locator('#app-confirmation-dialog');
const confirmButton = (page) => page.locator('[data-app-dialog-confirmation-confirm]');
const cancelButton = (page) => page.locator('[data-app-dialog-confirmation-cancel]');
const deleteButton = (page) => page.locator('form.asset-delete-form button[type="submit"]');
const deleteStatus = (page) => page.locator('#asset-edit-dialog [data-asset-delete-status-text]');
const fileStatus = (page) => page.locator('#asset-edit-dialog [data-asset-file-action-status-text]');
const deletePosts = (net) => net.posts.filter((pathname) => DELETE_POST.test(pathname));

async function openEditAsset(page) {
  await page.locator('.asset-viewer-edit').click();
  await expect(dialog(page)).toHaveJSProperty('open', true);
}

async function openDisclosure(page, label) {
  const summary = page.locator('#asset-edit-dialog summary', { hasText: label });
  if (!(await summary.evaluate((node) => node.parentElement.open))) await summary.click();
}

async function chooseDestination(page, label) {
  await openDisclosure(page, 'Move file');
  await page.locator('#move-destination-dropdown summary').click();
  await page.locator('#move-destination-dropdown label', { hasText: label }).click();
  const dropdown = page.locator('#move-destination-dropdown');
  if (await dropdown.evaluate((node) => node.open)) await dropdown.locator('summary').click();
}

// Unsent drafts in the tag, Rename and Move controls. The tag change is ticked
// in the native input without a change event, so no tag save is sent.
async function enterDrafts(page, fixture) {
  await page.locator(`#asset-tags-form input[value="${fixture.tag.id}"]`).evaluate((input) => { input.checked = true; });
  await openDisclosure(page, 'Rename file');
  await page.locator('#rename-filename').fill('draft-name.png');
  await chooseDestination(page, 'Renders');
}

async function expectDraftsKept(page, fixture) {
  await expect(page.locator(`#asset-tags-form input[value="${fixture.tag.id}"]`)).toBeChecked();
  await expect(page.locator('#rename-filename')).toHaveValue('draft-name.png');
  await expect(page.locator('#rename-filename')).toHaveAttribute('data-confirmed-value', '02-subject.png');
  expect(await page.locator('#move-destination').evaluate((select) => select.selectedOptions[0].textContent.trim())).toBe('Renders');
  await expect(page.locator('#move-destination')).toHaveAttribute('data-confirmed-value', String(fixture.wipId));
  expect(fixture.savedTagIds()).toEqual([]);
}

async function sameDocument(page) {
  return page.evaluate(() => window.__sameDocument === true
    && document.querySelector('[data-asset-viewer-host]').__sameHost === true
    && (document.querySelector('[data-asset-viewer-host] img, [data-asset-viewer-host] video')?.__sameMedia ?? true) === true);
}

async function startDelete(page) {
  await openDisclosure(page, 'Delete asset');
  await deleteButton(page).click();
  await expect(confirmation(page)).toHaveJSProperty('open', true);
}

const settle = (page, ms = 400) => page.waitForTimeout(ms);

const STILL_LISTED = 'The deletion could not be confirmed. The asset is still listed in this project, but the earlier Delete request may still run or may have left its file needing recovery. Nothing will be sent again by itself. Your unsaved changes were kept.';
const HELD = 'This asset cannot be changed from this page while the earlier deletion is unconfirmed. Use Check again, or reload the page once that request can no longer be running.';
const GONE_UNCONFIRMED = 'The deletion could not be confirmed. This asset no longer exists in this project, but CreatorCrate cannot tell whether your request removed it or whether its file was fully removed from the project folder.';
const RENAME_POST = /^\/projects\/\d+\/assets\/\d+\/rename$/;
const MOVE_POST = /^\/projects\/\d+\/assets\/\d+\/move$/;

test('A: Cancel, Escape and the backdrop dismiss the confirmation locally with every draft kept and no POST', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  const urlBefore = page.url();
  await openEditAsset(page);
  await enterDrafts(page, fixture);

  await startDelete(page);
  await expect(page.locator('#app-confirmation-dialog-title')).toHaveText('Delete asset with unsaved changes?');
  const message = page.locator('[data-app-dialog-confirmation-message]');
  await expect(message).toContainText('Delete “02-subject.png” from this project?');
  await expect(message).toContainText('(tag selection, new filename and move destination) will not be saved');
  await expect(message).toContainText('lost if it is deleted');
  await expect(cancelButton(page)).toHaveText('Keep editing');
  await expect(confirmButton(page)).toHaveText('Delete asset');
  await cancelButton(page).click();
  await expect(confirmation(page)).toHaveJSProperty('open', false);
  await expect(deleteButton(page)).toBeFocused();
  await expect(cancelButton(page)).toHaveText('Cancel');

  await deleteButton(page).click();
  await expect(confirmation(page)).toHaveJSProperty('open', true);
  await page.keyboard.press('Escape');
  await expect(confirmation(page)).toHaveJSProperty('open', false);
  await expect(dialog(page)).toHaveJSProperty('open', true);

  await deleteButton(page).click();
  await expect(confirmation(page)).toHaveJSProperty('open', true);
  await page.mouse.click(4, 4);
  await expect(confirmation(page)).toHaveJSProperty('open', false);
  await expect(dialog(page)).toHaveJSProperty('open', true);

  await settle(page);
  expect(net.posts).toEqual([]);
  expect(net.gets).toEqual([]);
  expect(net.navigations).toEqual([]);
  expect(page.url()).toBe(urlBefore);
  expect(await sameDocument(page)).toBe(true);
  await expectDraftsKept(page, fixture);
  expect(fixture.row()).toBeDefined();
  expect(fixture.onDisk('wip/02-subject.png')).toBe(true);
  expect(await page.locator('[aria-live]').count()).toBe(1);
  expect(errors).toEqual([]);
});

test('B: a confirmed Delete sends one POST, removes the record and the file, and replaces the page once with filtered Project Assets', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  const historyBefore = await page.evaluate(() => history.length);
  await openEditAsset(page);
  await enterDrafts(page, fixture);
  await startDelete(page);
  await Promise.all([
    page.waitForURL((url) => url.pathname === `/projects/${fixture.projectId}/assets`),
    confirmButton(page).click(),
  ]);
  await settle(page);

  expect(net.posts).toEqual([`/projects/${fixture.projectId}/assets/${fixture.assetId}/delete`]);
  const landed = new URL(page.url());
  expect(landed.searchParams.get('category')).toBe(String(fixture.wipId));
  expect(landed.searchParams.get('assets_deleted')).toBe('1');
  expect(net.navigations).toHaveLength(1);
  // Replaced, not pushed: Back does not lead to the deleted asset's page.
  expect(await page.evaluate(() => history.length)).toBe(historyBefore);
  await expect(page.locator('body')).toContainText('Deleted 1 asset.');
  expect(await page.locator('#asset-edit-dialog').count()).toBe(0);
  expect(await page.locator('form.asset-delete-form').count()).toBe(0);
  expect(fixture.row()).toBeUndefined();
  expect(fixture.onDisk('wip/02-subject.png')).toBe(false);
  expect(fixture.stagingDirs()).toEqual([]);
  expect(fixture.count()).toBe(2);
  expect(fixture.otherIds.every((id) => db.prepare('SELECT 1 FROM assets WHERE id = ?').get(id))).toBe(true);
  expect(fixture.savedTagIds()).toEqual([]);
  expect(errors).toEqual([]);
});

test('C: refusals (published release, archived elsewhere, busy, deleted elsewhere) stay local with drafts and media kept', async ({ page }) => {
  const fixture = await createFixture();
  const release = db.prepare(`
    INSERT INTO releases (project_id, title, description, notes, planned_date, published_date, patreon_url, archived_at)
    VALUES (?, 'Published', '', '', NULL, '2026-08-05', NULL, NULL) RETURNING id`).get(fixture.projectId).id;
  db.prepare("INSERT INTO release_assets (release_id, asset_id, role, sort_order) VALUES (?, ?, 'attachment', 0)").run(release, fixture.assetId);
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await enterDrafts(page, fixture);

  await startDelete(page);
  await confirmButton(page).click();
  await expect(deleteStatus(page)).toHaveText('This asset is associated with a published release and cannot be permanently deleted. Nothing was deleted. Your unsaved changes were kept.');
  await expect(deleteButton(page)).toBeFocused();
  expect(deletePosts(net)).toHaveLength(1);
  expect(net.gets).toEqual([]);
  await expectDraftsKept(page, fixture);
  db.prepare('DELETE FROM release_assets WHERE release_id = ?').run(release);

  // A real held project lock.
  let unlock;
  const held = coordinator.runAsync(fixture.projectId, () => new Promise((resolve) => { unlock = resolve; }));
  await startDelete(page);
  await confirmButton(page).click();
  await expect(deleteStatus(page)).toHaveText('Another project operation is already in progress. Try again. Nothing was deleted. Your unsaved changes were kept.');
  unlock();
  await held;

  // Archived in another session after this page loaded.
  app.locals.projectService.archive?.(fixture.projectId)
    ?? db.prepare("UPDATE projects SET archived_at = datetime('now') WHERE id = ?").run(fixture.projectId);
  await startDelete(page);
  await confirmButton(page).click();
  await expect(deleteStatus(page)).toHaveText('This project is archived and read-only. Nothing was deleted. Your unsaved changes were kept.');
  expect(deletePosts(net)).toHaveLength(3);
  expect(net.navigations).toEqual([]);
  expect(await sameDocument(page)).toBe(true);
  await expectDraftsKept(page, fixture);
  expect(fixture.row()).toBeDefined();
  expect(fixture.onDisk('wip/02-subject.png')).toBe(true);
  expect(fixture.stagingDirs()).toEqual([]);
  await expect(dialog(page)).toHaveJSProperty('open', true);
  expect(await page.locator('[aria-live]').count()).toBe(1);
  expect(errors).toEqual([]);
});

test('C2: an asset deleted in another session is reported missing without navigating or claiming this Delete removed it', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await enterDrafts(page, fixture);
  app.locals.assetActionService.deleteAssets(fixture.projectId, [fixture.assetId]);
  await startDelete(page);
  await confirmButton(page).click();
  await expect(deleteStatus(page)).toHaveText('This asset no longer exists in this project. It may have been deleted elsewhere. This Delete request did not remove it.');
  const link = page.locator('[data-asset-delete-assets-link]');
  await expect(link).toBeFocused();
  expect(new URL(await link.getAttribute('href'), baseURL).pathname).toBe(`/projects/${fixture.projectId}/assets`);
  await settle(page);
  expect(deletePosts(net)).toHaveLength(1);
  expect(net.navigations).toEqual([]);
  expect(await sameDocument(page)).toBe(true);
  await expectDraftsKept(page, fixture);
  // Other actions on the gone asset are refused locally.
  await page.locator('form.asset-rename-form').evaluate((form) => form.requestSubmit());
  await settle(page, 200);
  expect(net.posts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('D: a committed Delete whose staged file cannot be removed is reported truthfully, with no automatic second Delete', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await startDelete(page);
  const realRm = fs.rmSync;
  fs.rmSync = function failingStagedRemove(target, ...rest) {
    if (String(target).includes(STAGING_PREFIX)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    return realRm.call(this, target, ...rest);
  };
  try {
    await confirmButton(page).click();
    await expect(deleteStatus(page)).toContainText('The asset was deleted from CreatorCrate, but its file could not be fully removed');
  } finally {
    fs.rmSync = realRm;
  }
  await expect(deleteStatus(page)).toContainText('Inspect the project folder before scanning.');
  const link = page.locator('[data-asset-delete-assets-link]');
  await expect(link).toBeFocused();
  const href = new URL(await link.getAttribute('href'), baseURL);
  expect(href.pathname).toBe(`/projects/${fixture.projectId}/assets`);
  expect(href.searchParams.has('assets_deleted')).toBe(false);
  await settle(page);
  expect(deletePosts(net)).toHaveLength(1);
  expect(net.navigations).toEqual([]);
  expect(await sameDocument(page)).toBe(true);
  // The answer matches the database and the disk.
  expect(fixture.row()).toBeUndefined();
  expect(fixture.onDisk('wip/02-subject.png')).toBe(false);
  expect(fixture.stagedFiles()).toHaveLength(1);
  await expect(page.locator('form.asset-delete-form')).toHaveAttribute('data-asset-delete-hold', 'cleanup');
  await page.locator('form.asset-delete-form').evaluate((form) => form.requestSubmit());
  await settle(page, 200);
  expect(deletePosts(net)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('E: a lost answer is never resent; the GET reports the asset absent without navigating', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await enterDrafts(page, fixture);
  net.deleteMode = 'lose';
  await startDelete(page);
  await confirmButton(page).click();
  await expect(deleteStatus(page)).toHaveText('The deletion could not be confirmed. This asset no longer exists in this project, but CreatorCrate cannot tell whether your request removed it or whether its file was fully removed from the project folder.');
  await settle(page);
  expect(deletePosts(net)).toHaveLength(1);
  expect(net.gets).toHaveLength(1);
  expect(net.navigations).toEqual([]);
  expect(await sameDocument(page)).toBe(true);
  await expectDraftsKept(page, fixture);
  expect(fixture.row()).toBeUndefined();
  expect(fixture.onDisk('wip/02-subject.png')).toBe(false);
  await expect(page.locator('[data-asset-delete-assets-link]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('E2: a lost answer with a failed check offers GET-only Check again; dismissal and a listed asset keep the hold', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await enterDrafts(page, fixture);
  net.deleteMode = 'lose';
  net.getMode = 'fail-once';
  // The server refuses this Delete (a held lock), but the browser never sees it.
  let unlock;
  const held = coordinator.runAsync(fixture.projectId, () => new Promise((resolve) => { unlock = resolve; }));
  await startDelete(page);
  await confirmButton(page).click();
  await expect(deleteStatus(page)).toHaveText('The deletion could not be confirmed. The asset could not be checked. Your unsaved changes were kept.');
  const retry = page.locator('[data-asset-delete-retry]');
  await expect(retry).toHaveText('Check again');
  unlock();
  await held;
  // Still locked meanwhile: neither Delete nor another action is sent.
  await page.locator('form.asset-delete-form').evaluate((form) => form.requestSubmit());
  await page.locator('form.asset-rename-form').evaluate((form) => form.requestSubmit());
  await settle(page, 200);
  expect(net.posts).toHaveLength(1);
  await expect(confirmation(page)).toHaveJSProperty('open', false);

  await retry.click();
  await expect(deleteStatus(page)).toHaveText(STILL_LISTED);
  expect(net.gets).toHaveLength(2);
  expect(deletePosts(net)).toHaveLength(1);
  expect(net.navigations).toEqual([]);
  expect(await sameDocument(page)).toBe(true);
  await expectDraftsKept(page, fixture);
  expect(fixture.row()).toBeDefined();
  expect(fixture.onDisk('wip/02-subject.png')).toBe(true);
  // The listed asset is not this request's answer: Delete stays refused
  // before any confirmation, and Rename is refused before any POST.
  net.deleteMode = 'pass';
  await deleteButton(page).click({ force: true });
  await expect(confirmation(page)).toHaveJSProperty('open', false);
  // Dismissing and reopening Edit Asset does not clear the hold.
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveJSProperty('open', false);
  await openEditAsset(page);
  await expect(page.locator('form.asset-delete-form')).toHaveAttribute('data-asset-delete-hold', 'unresolved');
  await openDisclosure(page, 'Rename file');
  await page.locator('#rename-filename').fill('after-reopen.png');
  await page.locator('form.asset-rename-form button[type="submit"]').click();
  await expect(fileStatus(page)).toHaveText(HELD);
  await openDisclosure(page, 'Delete asset');
  await deleteButton(page).click({ force: true });
  await expect(confirmation(page)).toHaveJSProperty('open', false);
  // A failed Check again keeps the hold too.
  net.getMode = 'fail-once';
  await page.locator('[data-asset-delete-retry]').click();
  await expect(deleteStatus(page)).toHaveText('The deletion could not be confirmed. The asset could not be checked. Your unsaved changes were kept.');
  await page.locator('form.asset-rename-form').evaluate((form) => form.requestSubmit());
  await settle(page, 200);
  expect(net.posts).toHaveLength(1);
  expect(net.gets).toHaveLength(3);
  expect(fixture.row().filename).toBe('02-subject.png');
  expect(errors).toEqual([]);
});

test('F: Delete and the other Edit Asset actions never run at once, and nothing is queued', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await openDisclosure(page, 'Rename file');
  await page.locator('#rename-filename').fill('02-renamed.png');
  const releaseRename = gate(net);
  await page.locator('form.asset-rename-form button[type="submit"]').click();
  await expect(fileStatus(page)).toHaveText('Renaming the file to “02-renamed.png”…');
  // Delete while the Rename is out: refused before any confirmation opens.
  await page.locator('form.asset-delete-form').evaluate((form) => form.requestSubmit());
  await expect(deleteStatus(page)).toHaveText('Wait for the current change to finish, then delete the asset.');
  await expect(confirmation(page)).toHaveJSProperty('open', false);
  releaseRename();
  await expect(fileStatus(page)).toHaveText('The file was renamed to “02-renamed.png”.');
  expect(net.posts).toEqual([`/projects/${fixture.projectId}/assets/${fixture.assetId}/rename`]);
  expect(fixture.row().filename).toBe('02-renamed.png');

  // Now Delete is out; the other actions are refused, not queued.
  await page.locator('#rename-filename').fill('02-other-draft.png');
  await startDelete(page);
  const releaseDelete = gate(net);
  await confirmButton(page).click();
  await expect(deleteStatus(page)).toHaveText('Deleting “02-renamed.png”…');
  await page.locator('form.asset-rename-form').evaluate((form) => form.requestSubmit());
  await page.locator('form.asset-delete-form').evaluate((form) => form.requestSubmit());
  await expect(confirmation(page)).toHaveJSProperty('open', false);
  // Escape does not close the dialog while the Delete may be committing.
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveJSProperty('open', true);
  await expect(page.locator('#rename-filename')).toHaveValue('02-other-draft.png');
  await settle(page, 200);
  expect(net.posts).toHaveLength(2);
  await Promise.all([
    page.waitForURL((url) => url.pathname === `/projects/${fixture.projectId}/assets`),
    releaseDelete(),
  ]);
  expect(deletePosts(net)).toHaveLength(1);
  expect(net.posts).toHaveLength(2);
  expect(fixture.row()).toBeUndefined();
  expect(fixture.onDisk('wip/02-renamed.png')).toBe(false);
  expect(errors).toEqual([]);
});

test('G: double click, Enter, repeated Enter and requestSubmit each lead to exactly one POST per confirmation', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await openDisclosure(page, 'Delete asset');

  // The first click opens the shared confirmation; the second lands on its
  // backdrop, which dismisses it (the shared dialog's existing behavior).
  // Either way nothing is sent and the Edit Asset dialog stays.
  await deleteButton(page).dblclick();
  await settle(page, 200);
  if (await confirmation(page).evaluate((node) => node.open)) await cancelButton(page).click();
  await expect(confirmation(page)).toHaveJSProperty('open', false);
  await expect(dialog(page)).toHaveJSProperty('open', true);
  expect(net.posts).toEqual([]);

  await deleteButton(page).focus();
  await page.keyboard.press('Enter');
  await expect(confirmation(page)).toHaveJSProperty('open', true);
  await page.keyboard.press('Escape');
  await expect(confirmation(page)).toHaveJSProperty('open', false);

  await page.locator('form.asset-delete-form').evaluate((form) => form.requestSubmit());
  await expect(confirmation(page)).toHaveJSProperty('open', true);
  await cancelButton(page).click();
  await settle(page, 200);
  expect(net.posts).toEqual([]);

  // Confirmed from the keyboard, with Enter held down while the POST is out.
  await page.locator('form.asset-delete-form').evaluate((form) => form.requestSubmit());
  await expect(confirmation(page)).toHaveJSProperty('open', true);
  const release = gate(net);
  await confirmButton(page).focus();
  await page.keyboard.press('Enter');
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('Enter');
  await deleteButton(page).dispatchEvent('click');
  await page.locator('form.asset-delete-form').evaluate((form) => form.requestSubmit());
  await settle(page, 300);
  expect(net.posts).toHaveLength(1);
  await expect(confirmation(page)).toHaveJSProperty('open', false);
  await Promise.all([
    page.waitForURL((url) => url.pathname === `/projects/${fixture.projectId}/assets`),
    release(),
  ]);
  await settle(page);
  expect(deletePosts(net)).toHaveLength(1);
  expect(fixture.row()).toBeUndefined();
  expect(errors).toEqual([]);
});

test('H: without JavaScript the native Delete form and redirect work, and CSRF still applies', async ({ browser }) => {
  const fixture = await createFixture();
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto(`${baseURL}${fixture.url}&edit=1`);
    const dialogNode = page.locator('#asset-edit-dialog');
    if (!(await dialogNode.evaluate((node) => node.open))) {
      await page.goto(`${baseURL}${await page.locator('.asset-viewer-edit').getAttribute('href')}`);
    }
    await page.locator('#asset-edit-dialog summary', { hasText: 'Delete asset' }).click();
    await Promise.all([
      page.waitForURL((url) => url.pathname === `/projects/${fixture.projectId}/assets`),
      deleteButton(page).click(),
    ]);
    const landed = new URL(page.url());
    expect(landed.searchParams.get('category')).toBe(String(fixture.wipId));
    expect(landed.searchParams.get('assets_deleted')).toBe('1');
    await expect(page.locator('body')).toContainText('Deleted 1 asset.');
    expect(fixture.row()).toBeUndefined();
    expect(fixture.onDisk('wip/02-subject.png')).toBe(false);

    const other = fixture.otherIds[0];
    const forged = await page.request.post(`${baseURL}/projects/${fixture.projectId}/assets/${other}/delete`, {
      form: { category: 'all' }, maxRedirects: 0,
    });
    expect(forged.status()).toBe(403);
    expect(db.prepare('SELECT 1 FROM assets WHERE id = ?').get(other)).toBeDefined();
  } finally {
    await context.close();
  }
});

test('I: a refused Delete leaves Tag Save, Rename and the viewer refresh working in place', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await enterDrafts(page, fixture);
  let unlock;
  const held = coordinator.runAsync(fixture.projectId, () => new Promise((resolve) => { unlock = resolve; }));
  await startDelete(page);
  await confirmButton(page).click();
  await expect(deleteStatus(page)).toContainText('Nothing was deleted.');
  unlock();
  await held;

  // Rename still runs in place and keeps the other drafts.
  await page.locator('form.asset-rename-form button[type="submit"]').click();
  await expect(fileStatus(page)).toHaveText('The file was renamed to “draft-name.png”.');
  expect(fixture.row().filename).toBe('draft-name.png');
  // The Delete message gave way to the new action.
  await expect(deleteStatus(page)).toHaveText('');
  await expect(page.locator(`#asset-tags-form input[value="${fixture.tag.id}"]`)).toBeChecked();
  // Tag save still works in place.
  await page.locator(`#asset-tags-form input[value="${fixture.tag.id}"]`).evaluate((input) => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(() => fixture.savedTagIds()).toEqual([fixture.tag.id]);
  await expect(page.locator('#asset-edit-dialog [data-asset-tags-status-text]')).toHaveText('Asset tags updated.');
  await settle(page);
  expect(net.navigations).toEqual([]);
  expect(await sameDocument(page)).toBe(true);
  expect(deletePosts(net)).toHaveLength(1);
  expect(await page.locator('[aria-live]').count()).toBe(1);
  expect(errors).toEqual([]);
});

// ── P2 correction: an unconfirmed Delete stays held until its own answer ──
// The original request reaches the real server and is held there, open and
// not yet run, while the browser loses its answer. A read then finds the
// record still present. Nothing the page can still send may conflict with the
// Delete that is still going to run.

// A failed test never leaves a Delete held for the next one.
const pendingReleases = [];
test.afterEach(() => {
  while (pendingReleases.length) pendingReleases.pop()();
});

async function delayedDeleteWithLostAnswer(page, fixture, net) {
  const callsBefore = upstream.serviceCalls;
  const arrivalsBefore = upstream.arrivals.length;
  const held = holdUpstreamDeletes();
  pendingReleases.push(held.release);
  net.deleteMode = 'hold-upstream';
  await startDelete(page);
  await confirmButton(page).click();
  await expect(deleteStatus(page)).toHaveText(STILL_LISTED);
  // The original request is at the server, still open, and has not run.
  expect(upstream.arrivals.length - arrivalsBefore).toBe(1);
  expect(held.gate.waiting).toHaveLength(1);
  expect(held.gate.waiting[0].alive()).toBe(true);
  expect(held.gate.waiting[0].released).toBe(false);
  expect(upstream.serviceCalls).toBe(callsBefore);
  expect(net.gets).toHaveLength(1);
  expect(fixture.row()).toBeDefined();
  expect(fixture.onDisk('wip/02-subject.png')).toBe(true);
  await expect(page.locator('form.asset-delete-form')).toHaveAttribute('data-asset-delete-hold', 'unresolved');
  return { held, callsBefore, arrivalsBefore };
}

async function releaseAndVerifyDeleted(page, fixture, net, { held, callsBefore, arrivalsBefore }) {
  expect(held.gate.waiting[0].alive()).toBe(true);
  held.release();
  await expect.poll(() => upstream.serviceCalls).toBe(callsBefore + 1);
  await expect.poll(() => fixture.row()).toBeUndefined();
  const answer = await net.upstream;
  expect(answer.status).toBe(200);
  expect(answer.body.outcome).toBe('deleted');
  expect(upstream.arrivals.length - arrivalsBefore).toBe(1);
  expect(fixture.onDisk('wip/02-subject.png')).toBe(false);
  expect(fixture.stagingDirs()).toEqual([]);
  expect(fixture.count()).toBe(2);
  // The page still claims nothing: no completion and no navigation.
  await settle(page, 200);
  await expect(deleteStatus(page)).not.toContainText('The asset was deleted.');
  expect(net.navigations).toEqual([]);
  // Check again (GET only) observes the absence and retires the page.
  await page.locator('[data-asset-delete-retry]').click();
  await expect(deleteStatus(page)).toHaveText(GONE_UNCONFIRMED);
  await expect(page.locator('form.asset-delete-form')).toHaveAttribute('data-asset-delete-hold', 'missing');
  await expect(page.locator('[data-asset-viewer-host]')).toHaveAttribute('data-asset-viewer-retired', /.*/);
  await settle(page, 200);
  expect(net.navigations).toEqual([]);
  expect(await sameDocument(page)).toBe(true);
  expect(deletePosts(net)).toHaveLength(1);
}

test('J1: a Delete held upstream with its answer lost keeps Rename from being sent until that Delete has run', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await enterDrafts(page, fixture);
  const run = await delayedDeleteWithLostAnswer(page, fixture, net);
  try {
    await page.locator('form.asset-rename-form button[type="submit"]').click();
    await expect(fileStatus(page)).toHaveText(HELD);
    await page.locator('#rename-filename').press('Enter');
    await settle(page, 300);
    expect(net.posts.filter((pathname) => RENAME_POST.test(pathname))).toHaveLength(0);
    expect(deletePosts(net)).toHaveLength(1);
    await expect(deleteStatus(page)).toHaveText(STILL_LISTED);
    await expectDraftsKept(page, fixture);
    expect(await sameDocument(page)).toBe(true);
    expect(fixture.row().filename).toBe('02-subject.png');
  } finally {
    await releaseAndVerifyDeleted(page, fixture, net, run);
  }
  // No Rename ever ran: neither name is on disk.
  expect(fixture.onDisk('wip/draft-name.png')).toBe(false);
  expect(net.posts.filter((pathname) => RENAME_POST.test(pathname))).toHaveLength(0);
  await page.locator('form.asset-rename-form').evaluate((form) => form.requestSubmit());
  await settle(page, 200);
  expect(net.posts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('J2: a Delete held upstream with its answer lost keeps Move from being sent until that Delete has run', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await enterDrafts(page, fixture);
  const run = await delayedDeleteWithLostAnswer(page, fixture, net);
  try {
    await page.locator('form.asset-move-form button[type="submit"]').click();
    await expect(fileStatus(page)).toHaveText(HELD);
    await settle(page, 300);
    expect(net.posts.filter((pathname) => MOVE_POST.test(pathname))).toHaveLength(0);
    expect(deletePosts(net)).toHaveLength(1);
    await expectDraftsKept(page, fixture);
    expect(fixture.row().category_id).toBe(fixture.wipId);
  } finally {
    await releaseAndVerifyDeleted(page, fixture, net, run);
  }
  expect(fixture.onDisk('renders/02-subject.png')).toBe(false);
  expect(net.posts.filter((pathname) => MOVE_POST.test(pathname))).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('J3: no second Delete is sent while the first is held upstream, even after dismissing and reopening Edit Asset', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  const run = await delayedDeleteWithLostAnswer(page, fixture, net);
  try {
    await deleteButton(page).click({ force: true });
    await expect(confirmation(page)).toHaveJSProperty('open', false);
    await expect(deleteStatus(page)).toHaveText(`${STILL_LISTED} The earlier deletion has not been confirmed, so this asset cannot be deleted again from this page.`);
    // The Edit Asset dialog can be dismissed and reopened; the hold stays.
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveJSProperty('open', false);
    await openEditAsset(page);
    await openDisclosure(page, 'Delete asset');
    await deleteButton(page).click({ force: true });
    await expect(confirmation(page)).toHaveJSProperty('open', false);
    await deleteButton(page).focus();
    await page.keyboard.press('Enter');
    await page.locator('form.asset-delete-form').evaluate((form) => form.requestSubmit());
    await settle(page, 300);
    await expect(confirmation(page)).toHaveJSProperty('open', false);
    expect(deletePosts(net)).toHaveLength(1);
    expect(upstream.arrivals.length - run.arrivalsBefore).toBe(1);
    // The original warning is still first, not replaced by another answer.
    expect((await deleteStatus(page).textContent()).startsWith(STILL_LISTED)).toBe(true);
  } finally {
    await releaseAndVerifyDeleted(page, fixture, net, run);
  }
  expect(errors).toEqual([]);
});

test('J4: a lost recovery-required answer (file staged, database delete failed, restore failed) keeps everything held', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await enterDrafts(page, fixture);
  const callsBefore = upstream.serviceCalls;
  net.deleteMode = 'lose';
  db.exec("CREATE TRIGGER wp10a3b_browser_fail_delete BEFORE DELETE ON assets BEGIN SELECT RAISE(ABORT, 'injected'); END;");
  const realRename = fs.renameSync;
  fs.renameSync = function failingRestore(from, to) {
    // Staging works; only putting the file back from staging fails.
    if (String(from).includes(STAGING_PREFIX)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    return realRename.call(this, from, to);
  };
  try {
    await startDelete(page);
    await confirmButton(page).click();
    await expect(deleteStatus(page)).toHaveText(STILL_LISTED);
  } finally {
    fs.renameSync = realRename;
    db.exec('DROP TRIGGER IF EXISTS wp10a3b_browser_fail_delete;');
  }
  expect(upstream.serviceCalls).toBe(callsBefore + 1);
  // The database row remains; the source file is gone; the file is staged.
  expect(fixture.row()).toBeDefined();
  expect(fixture.onDisk('wip/02-subject.png')).toBe(false);
  expect(fixture.stagedFiles()).toHaveLength(1);
  await expect(deleteStatus(page)).not.toContainText('restored');

  await deleteButton(page).click({ force: true });
  await expect(confirmation(page)).toHaveJSProperty('open', false);
  await page.locator('form.asset-rename-form button[type="submit"]').click();
  await expect(fileStatus(page)).toHaveText(HELD);
  await page.locator('form.asset-move-form button[type="submit"]').click();
  await settle(page, 300);
  expect(net.posts).toHaveLength(1);
  expect(upstream.serviceCalls).toBe(callsBefore + 1);
  expect((await deleteStatus(page).textContent()).startsWith(STILL_LISTED)).toBe(true);
  await expect(page.locator('form.asset-delete-form')).toHaveAttribute('data-asset-delete-hold', 'unresolved');
  // Check again stays a GET and the staged file is left for recovery.
  await page.locator('[data-asset-delete-retry]').click();
  await expect(deleteStatus(page)).toHaveText(STILL_LISTED);
  expect(net.gets).toHaveLength(2);
  expect(net.posts).toHaveLength(1);
  expect(fixture.stagedFiles()).toHaveLength(1);
  expect(fixture.row()).toBeDefined();
  expect(net.navigations).toEqual([]);
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

// ── F2: a Delete is bound to the asset state its confirmation reviewed ──
// The page's Delete form carries the reviewed state the server rendered; the
// service compares it with the current row under the project lock. A Delete
// held upstream (open, not yet run) while the asset is renamed or moved from a
// reloaded page or another tab is refused as stale when it finally runs.

const STALE = 'This asset was renamed, moved or replaced after the deletion was reviewed, so it was not deleted. Review the asset as it is now and delete it again if you still want to.';
const reviewValue = (page) => page.locator('form.asset-delete-form input[data-asset-delete-review]').getAttribute('value');
const renamePosts = (net) => net.posts.filter((pathname) => RENAME_POST.test(pathname));
const movePosts = (net) => net.posts.filter((pathname) => MOVE_POST.test(pathname));

async function renameInPlace(page, filename) {
  await openDisclosure(page, 'Rename file');
  await page.locator('#rename-filename').fill(filename);
  await page.locator('form.asset-rename-form button[type="submit"]').click();
  await expect(fileStatus(page)).toHaveText(`The file was renamed to “${filename}”.`);
}

// Released, the original request runs once and is refused as stale: the newer
// state of the asset is left exactly as it is.
async function releaseAndVerifyStale(fixture, net, { held, callsBefore, arrivalsBefore }) {
  expect(held.gate.waiting).toHaveLength(1);
  expect(held.gate.waiting[0].alive()).toBe(true);
  expect(held.gate.waiting[0].released).toBe(false);
  expect(upstream.serviceCalls).toBe(callsBefore);
  held.release();
  await expect.poll(() => upstream.serviceCalls).toBe(callsBefore + 1);
  const answer = await net.upstream;
  expect(answer.status).toBe(409);
  expect(answer.body).toEqual({ status: 'error', code: 'DELETE_STALE_ASSET', outcome: 'refused', message: STALE });
  // Exactly the one original request reached the server; nothing replayed it.
  expect(upstream.arrivals.length - arrivalsBefore).toBe(1);
  expect(held.gate.waiting[0].released).toBe(true);
  expect(fixture.stagingDirs()).toEqual([]);
  expect(fixture.count()).toBe(3);
}

test('K1: a Delete held upstream, then a reload and Rename: the old Delete is refused as stale and the renamed asset survives', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  const reviewedBefore = await reviewValue(page);
  const run = await delayedDeleteWithLostAnswer(page, fixture, net);
  const released = { done: false };
  try {
    // A new document: its own state knows nothing of the request held upstream.
    net.deleteMode = 'pass';
    await page.reload();
    const navigationsAfterReload = net.navigations.length;
    await openEditAsset(page);
    await expect(page.locator('form.asset-delete-form')).not.toHaveAttribute('data-asset-delete-hold', /.*/);
    await renameInPlace(page, 'after-reload.png');
    expect(fixture.row()).toMatchObject({ filename: 'after-reload.png', relative_path: 'wip/after-reload.png' });
    expect(fixture.onDisk('wip/after-reload.png')).toBe(true);
    // The Rename ran while the Delete was still held, unrun, upstream.
    expect(upstream.serviceCalls).toBe(run.callsBefore);
    expect(renamePosts(net)).toHaveLength(1);
    // The refreshed page carries the new reviewed state.
    await expect.poll(() => reviewValue(page)).not.toBe(reviewedBefore);

    await releaseAndVerifyStale(fixture, net, run);
    released.done = true;
    expect(fixture.row()).toMatchObject({ filename: 'after-reload.png', relative_path: 'wip/after-reload.png', is_present: 1 });
    expect(fixture.onDisk('wip/after-reload.png')).toBe(true);
    expect(fixture.onDisk('wip/02-subject.png')).toBe(false);

    // The reloaded page is not invalidated by the old request.
    await settle(page, 300);
    await expect(fileStatus(page)).toHaveText('The file was renamed to “after-reload.png”.');
    await expect(page.locator('[data-asset-viewer-host]')).not.toHaveAttribute('data-asset-viewer-retired', /.*/);
    await expect(page.locator('[data-asset-viewer-region="file-summary"]')).toHaveAttribute('data-asset-filename', 'after-reload.png');
    expect(net.navigations).toHaveLength(navigationsAfterReload);
    expect(deletePosts(net)).toHaveLength(1);
    expect(renamePosts(net)).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    if (!released.done) run.held.release();
  }
});

test('K2: a Delete held upstream in tab A, then a Move in tab B: the old Delete is refused as stale and the moved asset survives', async ({ page, context }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  const run = await delayedDeleteWithLostAnswer(page, fixture, net);
  const released = { done: false };
  const tabB = await context.newPage();
  try {
    const b = await open(tabB, fixture.url);
    await openEditAsset(tabB);
    await chooseDestination(tabB, 'Renders');
    await tabB.locator('form.asset-move-form button[type="submit"]').click();
    await expect(tabB.locator('#asset-edit-dialog [data-asset-file-action-status-text]')).toHaveText(/^The file was moved to Renders\./);
    expect(fixture.row()).toMatchObject({ category_id: fixture.rendersId, relative_path: 'renders/02-subject.png' });
    expect(upstream.serviceCalls).toBe(run.callsBefore);

    await releaseAndVerifyStale(fixture, net, run);
    released.done = true;
    expect(fixture.row()).toMatchObject({ category_id: fixture.rendersId, relative_path: 'renders/02-subject.png', is_present: 1 });
    expect(fixture.onDisk('renders/02-subject.png')).toBe(true);
    expect(fixture.onDisk('wip/02-subject.png')).toBe(false);

    // Tab B keeps its truthful Move result; nothing claims a deletion.
    await settle(tabB, 300);
    await expect(tabB.locator('#asset-edit-dialog [data-asset-file-action-status-text]')).toHaveText(/^The file was moved to Renders\./);
    await expect(tabB.locator('[data-asset-viewer-host]')).not.toHaveAttribute('data-asset-viewer-retired', /.*/);
    expect(b.net.navigations).toEqual([]);
    expect(movePosts(b.net)).toHaveLength(1);
    expect(deletePosts(b.net)).toHaveLength(0);
    // Tab A never claims a deletion either, and sent nothing more.
    await expect(deleteStatus(page)).not.toContainText('The asset was deleted.');
    expect(net.navigations).toEqual([]);
    expect(deletePosts(net)).toHaveLength(1);
    expect(movePosts(net)).toHaveLength(0);
    expect(b.errors).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    if (!released.done) run.held.release();
    await tabB.close();
  }
});

test('K3: after a Rename and Move in place, a new confirmed Delete sends the refreshed reviewed state and deletes once', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  const bodies = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && DELETE_POST.test(new URL(request.url()).pathname)) bodies.push(request.postData());
  });
  await openEditAsset(page);
  const original = await reviewValue(page);
  await renameInPlace(page, 'fresh.png');
  await chooseDestination(page, 'Renders');
  await page.locator('form.asset-move-form button[type="submit"]').click();
  await expect(fileStatus(page)).toHaveText(/^The file was moved to Renders\./);
  await expect.poll(() => reviewValue(page)).not.toBe(original);
  const refreshed = await reviewValue(page);
  // The installed value is the server's own render for the current row.
  const served = await page.request.get(`${baseURL}${fixture.url}`);
  expect((await served.text()).match(/name="deleteReview" value="([^"]+)"/)[1]).toBe(refreshed);

  const callsBefore = upstream.serviceCalls;
  await startDelete(page);
  await Promise.all([
    page.waitForURL((url) => url.pathname === `/projects/${fixture.projectId}/assets`),
    confirmButton(page).click(),
  ]);
  expect(bodies).toHaveLength(1);
  expect(new URLSearchParams(bodies[0]).getAll('deleteReview')).toEqual([refreshed]);
  expect(upstream.serviceCalls).toBe(callsBefore + 1);
  expect(fixture.row()).toBeUndefined();
  expect(fixture.onDisk('renders/fresh.png')).toBe(false);
  expect(fixture.stagingDirs()).toEqual([]);
  expect(new URL(page.url()).searchParams.get('assets_deleted')).toBe('1');
  expect(errors).toEqual([]);
});

test('K4: an open Delete form whose asset is renamed in another tab is refused locally, drafts kept; a new review deletes', async ({ page, context }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await enterDrafts(page, fixture);
  const tabB = await context.newPage();
  try {
    await open(tabB, fixture.url);
    await openEditAsset(tabB);
    await renameInPlace(tabB, 'renamed-elsewhere.png');
  } finally {
    await tabB.close();
  }
  const callsBefore = upstream.serviceCalls;
  await startDelete(page);
  await confirmButton(page).click();
  await expect(deleteStatus(page)).toHaveText(`${STALE} Nothing was deleted. Your unsaved changes were kept.`);
  expect(upstream.serviceCalls).toBe(callsBefore + 1);
  // The page now shows the asset as it is, without navigating.
  await expect(page.locator('[data-asset-viewer-region="file-summary"]')).toHaveAttribute('data-asset-filename', 'renamed-elsewhere.png');
  await expect(page.locator('#rename-filename')).toHaveAttribute('data-confirmed-value', 'renamed-elsewhere.png');
  expect(net.navigations).toEqual([]);
  expect(await sameDocument(page)).toBe(true);
  expect(deletePosts(net)).toHaveLength(1);
  // Drafts are untouched.
  await expect(page.locator(`#asset-tags-form input[value="${fixture.tag.id}"]`)).toBeChecked();
  await expect(page.locator('#rename-filename')).toHaveValue('draft-name.png');
  expect(await page.locator('#move-destination').evaluate((select) => select.selectedOptions[0].textContent.trim())).toBe('Renders');
  expect(fixture.savedTagIds()).toEqual([]);
  expect(fixture.row()).toMatchObject({ filename: 'renamed-elsewhere.png', is_present: 1 });
  expect(fixture.onDisk('wip/renamed-elsewhere.png')).toBe(true);
  expect(fixture.stagingDirs()).toEqual([]);
  await settle(page, 300);
  expect(deletePosts(net)).toHaveLength(1);

  // Only a new, explicitly confirmed Delete removes the asset now shown.
  await startDelete(page);
  await expect(page.locator('[data-app-dialog-confirmation-message]')).toContainText('“renamed-elsewhere.png”');
  await Promise.all([
    page.waitForURL((url) => url.pathname === `/projects/${fixture.projectId}/assets`),
    confirmButton(page).click(),
  ]);
  expect(deletePosts(net)).toHaveLength(2);
  expect(fixture.row()).toBeUndefined();
  expect(fixture.onDisk('wip/renamed-elsewhere.png')).toBe(false);
  expect(errors).toEqual([]);
});

test('K5: without JavaScript a stale native Delete is refused with the current asset re-rendered; its new form deletes', async ({ browser }) => {
  const fixture = await createFixture();
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto(`${baseURL}${fixture.url}&edit=1`);
    const reviewed = await page.locator('form.asset-delete-form input[name="deleteReview"]').getAttribute('value');
    // Another session moves the asset after this form was rendered.
    app.locals.assetActionService.moveAsset(fixture.projectId, fixture.assetId, fixture.rendersId);
    await page.locator('#asset-edit-dialog summary', { hasText: 'Delete asset' }).click();
    const [refusal] = await Promise.all([
      page.waitForResponse((response) => DELETE_POST.test(new URL(response.url()).pathname)),
      deleteButton(page).click(),
    ]);
    expect(refusal.status()).toBe(409);
    await expect(page.locator('#asset-edit-dialog')).toContainText(STALE);
    expect(fixture.row()).toMatchObject({ relative_path: 'renders/02-subject.png', is_present: 1 });
    expect(fixture.onDisk('renders/02-subject.png')).toBe(true);
    expect(fixture.stagingDirs()).toEqual([]);
    const current = await page.locator('form.asset-delete-form input[name="deleteReview"]').getAttribute('value');
    expect(current).not.toBe(reviewed);

    await page.locator('#asset-edit-dialog summary', { hasText: 'Delete asset' }).click();
    await Promise.all([
      page.waitForURL((url) => url.pathname === `/projects/${fixture.projectId}/assets`),
      deleteButton(page).click(),
    ]);
    expect(new URL(page.url()).searchParams.get('assets_deleted')).toBe('1');
    expect(fixture.row()).toBeUndefined();
    expect(fixture.onDisk('renders/02-subject.png')).toBe(false);
  } finally {
    await context.close();
  }
});

// ── F3: dismissing Edit Asset while Delete is unresolved keeps every draft ──
// A Delete whose answer was lost (or that needs recovery) keeps the asset and
// the Edit Asset drafts it said were kept: Escape, Close and the backdrop
// leave them in place; they are still unsaved and every action stays held.
// With no held Delete, dismissal still resets to the saved values.

async function createBook() {
  fixtureCount += 1;
  return app.locals.bookService.createBook({ title: `F3 Book ${fixtureCount}` });
}

async function chooseBook(page, title) {
  await page.locator('#book-primary-image-book summary').click();
  await page.locator('#book-primary-image-book label', { hasText: title }).click();
  const dropdown = page.locator('#book-primary-image-book');
  if (await dropdown.evaluate((node) => node.open)) await dropdown.locator('summary').click();
}

async function enterAllDrafts(page, fixture, book) {
  await enterDrafts(page, fixture);
  await chooseBook(page, book.title);
}

const bookChoice = (page) => page.locator('#book-primary-image-book-native').evaluate((select) => select.value);
const bookPrimary = (book) => app.locals.bookPrimaryImageService.getPrimaryImage(book.id)?.id ?? null;

async function expectAllDraftsKept(page, fixture, book) {
  // Each disclosure closes on dismissal; its control keeps the draft.
  await openDisclosure(page, 'Rename file');
  await openDisclosure(page, 'Move file');
  await expectDraftsKept(page, fixture);
  expect(await bookChoice(page)).toBe(String(book.id));
  await expect(page.locator('#book-primary-image-book summary')).toContainText(book.title);
  expect(bookPrimary(book)).toBeNull();
  expect(await page.locator('[data-asset-viewer-region="book-primary-image"]').getAttribute('data-book-primary-image-book-ids')).toBe('');
}

// Dismissed by `via`, then reopened from its trigger.
async function dismissAndReopen(page, via) {
  if (via === 'escape') await page.keyboard.press('Escape');
  else if (via === 'close') await page.locator('#asset-edit-dialog [data-dialog-close]').click();
  else await page.mouse.click(4, 4);
  await expect(dialog(page)).toHaveJSProperty('open', false);
  await expect(page.locator('.asset-viewer-edit')).toBeFocused();
  await openEditAsset(page);
  // Initial focus is inside the dialog and never on a held mutation button.
  const focus = await page.evaluate(() => {
    const active = document.activeElement;
    return {
      inside: Boolean(active?.closest?.('#asset-edit-dialog')),
      held: active?.getAttribute?.('aria-disabled') === 'true',
    };
  });
  expect(focus).toEqual({ inside: true, held: false });
}

// Every Edit Asset mutation, through its real control.
async function attemptAllMutations(page) {
  await openDisclosure(page, 'Rename file');
  await page.locator('form.asset-rename-form button[type="submit"]').click();
  await openDisclosure(page, 'Move file');
  await page.locator('form.asset-move-form button[type="submit"]').click();
  await page.locator('form.asset-book-primary-image-set-form button[type="submit"]').click();
  const projectSet = page.locator('form.asset-primary-image-set-form button[type="submit"]');
  if (await projectSet.count()) await projectSet.click();
  await openDisclosure(page, 'Delete asset');
  await deleteButton(page).click({ force: true });
  await expect(confirmation(page)).toHaveJSProperty('open', false);
  await settle(page, 300);
}

test('F3-B1: a Delete held upstream, a GET finding it listed, then Escape and reopen keep all four drafts and the hold', async ({ page }) => {
  const fixture = await createFixture();
  const book = await createBook();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await enterAllDrafts(page, fixture, book);
  const run = await delayedDeleteWithLostAnswer(page, fixture, net);
  try {
    await dismissAndReopen(page, 'escape');
    await expectAllDraftsKept(page, fixture, book);
    await expect(page.locator('form.asset-delete-form')).toHaveAttribute('data-asset-delete-hold', 'unresolved');
    await expect(deleteStatus(page)).toHaveText(STILL_LISTED);
    await page.keyboard.press('Enter');
    await attemptAllMutations(page);
    await expect(fileStatus(page)).toHaveText(HELD);
    expect(net.posts).toHaveLength(1);
    expect(upstream.arrivals.length - run.arrivalsBefore).toBe(1);
    expect(upstream.serviceCalls).toBe(run.callsBefore);
    await dismissAndReopen(page, 'escape');
    await expectAllDraftsKept(page, fixture, book);
    expect(fixture.row().filename).toBe('02-subject.png');
    expect(fixture.row().category_id ?? null).toBe(fixture.wipId);
    expect(net.navigations).toEqual([]);
    expect(await sameDocument(page)).toBe(true);
    expect(await page.locator('[aria-live]').count()).toBe(1);
  } finally {
    await releaseAndVerifyDeleted(page, fixture, net, run);
  }
  expect(errors).toEqual([]);
});

test('F3-B2: a Delete held upstream with a failed check keeps the drafts through Close and backdrop; Check again is GET only', async ({ page }) => {
  const fixture = await createFixture();
  const book = await createBook();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await enterAllDrafts(page, fixture, book);
  const callsBefore = upstream.serviceCalls;
  const arrivalsBefore = upstream.arrivals.length;
  const held = holdUpstreamDeletes();
  pendingReleases.push(held.release);
  net.deleteMode = 'hold-upstream';
  net.getMode = 'fail-once';
  const run = { held, callsBefore, arrivalsBefore };
  try {
    await startDelete(page);
    await confirmButton(page).click();
    await expect(deleteStatus(page)).toHaveText('The deletion could not be confirmed. The asset could not be checked. Your unsaved changes were kept.');
    expect(held.gate.waiting).toHaveLength(1);
    expect(upstream.serviceCalls).toBe(callsBefore);

    await dismissAndReopen(page, 'close');
    await expectAllDraftsKept(page, fixture, book);
    await dismissAndReopen(page, 'backdrop');
    await expectAllDraftsKept(page, fixture, book);
    await expect(page.locator('[data-asset-delete-retry]')).toHaveText('Check again');
    await attemptAllMutations(page);
    expect(net.posts).toHaveLength(1);

    const getsBefore = net.gets.length;
    await page.locator('[data-asset-delete-retry]').click();
    await expect(deleteStatus(page)).toHaveText(STILL_LISTED);
    expect(net.gets).toHaveLength(getsBefore + 1);
    expect(net.posts).toHaveLength(1);
    await dismissAndReopen(page, 'escape');
    await expectAllDraftsKept(page, fixture, book);
    await expect(page.locator('form.asset-delete-form')).toHaveAttribute('data-asset-delete-hold', 'unresolved');
    expect(upstream.arrivals.length - arrivalsBefore).toBe(1);
    expect(net.navigations).toEqual([]);
    expect(await sameDocument(page)).toBe(true);
  } finally {
    await releaseAndVerifyDeleted(page, fixture, net, run);
  }
  expect(errors).toEqual([]);
});

test('F3-B3: an acknowledged recovery-required Delete keeps drafts and its hold through dismissal, and sends nothing more', async ({ page }) => {
  const fixture = await createFixture();
  const book = await createBook();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await enterAllDrafts(page, fixture, book);
  const callsBefore = upstream.serviceCalls;
  db.exec("CREATE TRIGGER f3_browser_fail_delete BEFORE DELETE ON assets BEGIN SELECT RAISE(ABORT, 'injected'); END;");
  const realRename = fs.renameSync;
  fs.renameSync = function failingRestore(from, to) {
    if (String(from).includes(STAGING_PREFIX)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    return realRename.call(this, from, to);
  };
  try {
    await startDelete(page);
    await confirmButton(page).click();
    await expect(page.locator('form.asset-delete-form')).toHaveAttribute('data-asset-delete-hold', 'recovery');
  } finally {
    fs.renameSync = realRename;
    db.exec('DROP TRIGGER IF EXISTS f3_browser_fail_delete;');
  }
  expect(upstream.serviceCalls).toBe(callsBefore + 1);
  expect(fixture.row()).toBeDefined();
  expect(fixture.onDisk('wip/02-subject.png')).toBe(false);
  expect(fixture.stagedFiles()).toHaveLength(1);
  await settle(page, 300);
  const warning = await deleteStatus(page).textContent();
  expect(warning).toContain('Your unsaved changes were kept.');
  expect(warning).not.toContain('restored');

  await dismissAndReopen(page, 'escape');
  await expectAllDraftsKept(page, fixture, book);
  await expect(page.locator('form.asset-delete-form')).toHaveAttribute('data-asset-delete-hold', 'recovery');
  await attemptAllMutations(page);
  await dismissAndReopen(page, 'backdrop');
  await expectAllDraftsKept(page, fixture, book);
  expect(net.posts).toHaveLength(1);
  expect(upstream.serviceCalls).toBe(callsBefore + 1);
  expect((await deleteStatus(page).textContent()).startsWith(warning)).toBe(true);
  expect(fixture.row().filename).toBe('02-subject.png');
  expect(fixture.stagedFiles()).toHaveLength(1);
  expect(net.navigations).toEqual([]);
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('F3-B4: with no held Delete, dismissing Edit Asset still resets every draft to the saved values', async ({ page }) => {
  const fixture = await createFixture();
  const book = await createBook();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await enterAllDrafts(page, fixture, book);
  await dismissAndReopen(page, 'escape');
  await expect(page.locator(`#asset-tags-form input[value="${fixture.tag.id}"]`)).not.toBeChecked();
  await expect(page.locator('#rename-filename')).toHaveValue('02-subject.png');
  expect(await page.locator('#move-destination').evaluate((select) => select.value)).toBe(String(fixture.wipId));
  expect(await bookChoice(page)).toBe('');
  expect(net.posts).toEqual([]);
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('F3-B5: a confirmed Delete with all four drafts deletes once and leaves the page once, with no drafts or controls left', async ({ page }) => {
  const fixture = await createFixture();
  const book = await createBook();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await enterAllDrafts(page, fixture, book);
  const callsBefore = upstream.serviceCalls;
  await startDelete(page);
  await expect(page.locator('[data-app-dialog-confirmation-message]')).toContainText('(tag selection, Book choice, new filename and move destination) will not be saved');
  await Promise.all([
    page.waitForURL((url) => url.pathname === `/projects/${fixture.projectId}/assets`),
    confirmButton(page).click(),
  ]);
  await settle(page);
  expect(net.posts).toEqual([`/projects/${fixture.projectId}/assets/${fixture.assetId}/delete`]);
  expect(upstream.serviceCalls).toBe(callsBefore + 1);
  expect(net.navigations).toHaveLength(1);
  expect(await page.locator('#asset-edit-dialog').count()).toBe(0);
  expect(fixture.row()).toBeUndefined();
  expect(fixture.onDisk('wip/02-subject.png')).toBe(false);
  expect(fixture.savedTagIds()).toEqual([]);
  expect(bookPrimary(book)).toBeNull();
  expect(errors).toEqual([]);
});

test('F3-B6: a refused Delete keeps the document and drafts, releases its hold, and leaves the other actions usable', async ({ page }) => {
  const fixture = await createFixture();
  const book = await createBook();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  await enterAllDrafts(page, fixture, book);
  let unlock;
  const lock = coordinator.runAsync(fixture.projectId, () => new Promise((resolve) => { unlock = resolve; }));
  const callsBefore = upstream.serviceCalls;
  await startDelete(page);
  await confirmButton(page).click();
  await expect(deleteStatus(page)).toHaveText('Another project operation is already in progress. Try again. Nothing was deleted. Your unsaved changes were kept.');
  unlock();
  await lock;
  expect(deletePosts(net)).toHaveLength(1);
  expect(upstream.serviceCalls).toBe(callsBefore + 1);
  expect(fixture.row().filename).toBe('02-subject.png');
  expect(fixture.onDisk('wip/02-subject.png')).toBe(true);
  expect(await sameDocument(page)).toBe(true);
  await expectAllDraftsKept(page, fixture, book);
  await expect(page.locator('form.asset-delete-form')).not.toHaveAttribute('data-asset-delete-hold', /.*/);
  await expect(page.locator('form.asset-rename-form button[type="submit"]')).not.toHaveAttribute('aria-disabled', 'true');
  // Delete opens its confirmation again (cancelled here: nothing is sent).
  await openDisclosure(page, 'Delete asset');
  await deleteButton(page).click();
  await expect(confirmation(page)).toHaveJSProperty('open', true);
  await cancelButton(page).click();
  // The kept Rename draft can be applied explicitly: one Rename POST.
  await openDisclosure(page, 'Rename file');
  await page.locator('form.asset-rename-form button[type="submit"]').click();
  await expect(fileStatus(page)).toHaveText('The file was renamed to “draft-name.png”.');
  expect(net.posts.filter((pathname) => RENAME_POST.test(pathname))).toHaveLength(1);
  expect(deletePosts(net)).toHaveLength(1);
  expect(fixture.row().filename).toBe('draft-name.png');
  expect(net.navigations).toEqual([]);
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});
