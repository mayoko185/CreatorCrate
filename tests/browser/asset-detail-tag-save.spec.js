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

// WP10A1: Edit Asset saves tags in place on the Asset detail page, in real
// Chromium against the compiled client, real routes and templates. Every POST
// and GET is counted from the network, persisted rows are read from the
// database, and the document, media host and dialog are checked by identity.
// All data lives in a temporary root removed afterward.

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;
let webm;

// WP10A1-F3: the real server, seen from inside. Every tag POST that reaches it
// is recorded, and the route's replaceAssetTags calls (the ones made with a
// reviewed-state option) are counted with their outcome. While `upstream.gate`
// is set, the next arriving tag POST is held before Express (so before the
// route and the service) with its request open.
const TAG_POST = /^\/projects\/\d+\/assets\/\d+\/tags$/;
const upstream = { gate: null, arrivals: [], replaceCalls: [] };
const pendingReleases = [];

function holdUpstreamTagSave() {
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
  if (req.method === 'POST' && TAG_POST.test(pathname)) {
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
      await new Promise((resolve) => setTimeout(resolve, 4000));
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-tag-save-'));
  projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const viteDistRoot = path.join(root, 'client');
  // A preview root enables the media router that serves /original (video playback).
  const previewRoot = path.join(root, 'previews');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  fs.mkdirSync(previewRoot);
  await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
  webm = await recordWebm(browser);
  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  app = createApp({ appName: 'CreatorCrate', db, projectsRoot, previewRoot }, {
    appDataRoot, authState: { csrfPepper }, useViteAssets: true, viteDistRoot,
    assetManifest: createAssetManifest({ distRoot: viteDistRoot,
      manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
  });
  // Route-originated replacements only: fixtures call the service directly.
  const assetTagService = app.locals.assetTagService;
  const realReplace = assetTagService.replaceAssetTags;
  assetTagService.replaceAssetTags = (assetId, tagIds, ...rest) => {
    if (rest.length === 0) return realReplace(assetId, tagIds);
    const call = { assetId, tagIds: [...tagIds], outcome: 'pending' };
    upstream.replaceCalls.push(call);
    try {
      const result = realReplace(assetId, tagIds, ...rest);
      call.outcome = 'committed';
      return result;
    } catch (error) {
      call.outcome = error?.name || 'error';
      throw error;
    }
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

async function createFixture({ tags = ['Alpha', 'Beta', 'Gamma'], video = false } = {}) {
  fixtureCount += 1;
  const project = app.locals.projectService.create({ title: `Tag Save ${fixtureCount}`, status: 'tbd' });
  const categories = app.locals.projectAssetCategoryService;
  if (!categories.list(project.id).some((candidate) => candidate.directory_slug === 'wip')) {
    categories.add(project.id, { displayName: 'WIP', directorySlug: 'wip' });
  }
  const directory = path.join(projectsRoot, project.project_dir, 'wip');
  fs.mkdirSync(directory, { recursive: true });
  const files = ['01-first.png', '02-subject.png', '03-last.png'];
  for (const [index, filename] of files.entries()) {
    await sharp({ create: { width: 24, height: 24, channels: 3, background: { r: index * 80, g: 90, b: 160 } } })
      .png().toFile(path.join(directory, filename));
  }
  if (video) fs.writeFileSync(path.join(directory, '02-subject.webm'), webm);
  app.locals.assetScanner.scanProjectAssets(project.id);
  const assetId = (filename) => db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?')
    .get(project.id, filename).id;
  const catalog = Object.fromEntries(tags.map((name) => {
    const existing = app.locals.tagService.listTags().find((tag) => tag.display_name === `${name} ${fixtureCount}`);
    return [name, (existing || app.locals.tagService.createTag({ name: `${name} ${fixtureCount}` })).id];
  }));
  const subject = assetId(video ? '02-subject.webm' : '02-subject.png');
  return {
    projectId: project.id,
    assetId: subject,
    otherAssetIds: files.filter((file) => file !== '02-subject.png').map(assetId),
    tags: catalog,
    url: `/projects/${project.id}/assets/${subject}`,
    savedTagIds: () => db.prepare('SELECT tag_id FROM asset_tags WHERE asset_id = ? ORDER BY tag_id')
      .all(subject).map((row) => row.tag_id),
    assetRow: () => db.prepare('SELECT * FROM assets WHERE id = ?').get(subject),
    assign: (ids) => app.locals.assetTagService.replaceAssetTags(subject, ids),
    assignTo: (id, ids) => app.locals.assetTagService.replaceAssetTags(id, ids),
  };
}

// Network bookkeeping and optional interception of the tag POST and of the
// page's own refresh GET (a fetch of the Asset detail URL).
async function open(page, url) {
  const net = { posts: [], gets: [], navigations: 0, postMode: 'pass', getMode: 'pass', heldPosts: [], heldGets: [] };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST') net.posts.push(new URL(request.url()).pathname);
  });
  await page.route((target) => /^\/projects\/\d+\/assets\/\d+\/tags$/.test(target.pathname), async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    const mode = net.postMode;
    if (mode === 'pass') return route.continue();
    if (mode === 'retain-upstream') {
      // F3: forwarded to the real server, where the gate holds it before the
      // route runs; the browser keeps waiting and receives the real answer
      // once the request is let through.
      net.postMode = 'pass';
      const response = await route.fetch({ timeout: 60_000 });
      return route.fulfill({ response });
    }
    if (mode === 'hold-upstream') {
      // F3: the same request is forwarded to the real server, where the gate
      // holds it before the route runs; the browser's view of it is then lost
      // while the upstream request stays open.
      const before = upstream.arrivals.length;
      net.upstream = route.fetch({ timeout: 60_000 }).then(
        async (response) => ({ status: response.status(), body: await response.json().catch(() => null) }),
        (error) => ({ error: String(error) }),
      );
      for (let i = 0; i < 200 && upstream.arrivals.length === before; i += 1) await new Promise((r) => setTimeout(r, 10));
      net.postMode = 'pass';
      return route.abort('failed');
    }
    // Reaches the real server; only the browser's view of the answer changes.
    const response = await route.fetch();
    if (mode === 'drop') return route.abort('failed');
    if (mode === 'hold') {
      net.heldPosts.push(() => route.fulfill({ response }));
      return undefined;
    }
    return route.fulfill({ response });
  });
  await page.route((target) => /^\/projects\/\d+\/assets\/\d+$/.test(target.pathname), async (route) => {
    const request = route.request();
    if (request.resourceType() !== 'fetch') return route.fallback();
    net.gets.push(request.url());
    const mode = net.getMode;
    if (mode === 'fail' || mode === 'fail-once') {
      if (mode === 'fail-once') net.getMode = 'pass';
      return route.fulfill({ status: 500, contentType: 'text/html', body: 'failed' });
    }
    if (mode === 'hold') {
      net.heldGets.push(route);
      return undefined;
    }
    return route.continue();
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${baseURL}${url}`);
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) net.navigations += 1; });
  await page.evaluate(() => {
    window.__sameDocument = true;
    document.querySelector('[data-asset-viewer-host]').__sameHost = true;
  });
  return { net, errors };
}

const dialog = (page) => page.locator('#asset-edit-dialog');
const tagStatus = (page) => page.locator('#asset-edit-dialog [data-dialog-status] [data-asset-tags-status-text]');
const tagRetry = (page) => page.locator('[data-asset-tags-retry]');
const chips = (page) => page.locator('[data-asset-viewer-region="tags"] .tag-chip');
const tagBox = (page, id) => page.locator(`#asset-tags-form input[name="tagIds[]"][value="${id}"]`);
const confirmedIds = (page) => page.locator('#asset-edit-form').evaluate(
  (form) => form.getAttribute('data-confirmed-tag-ids').split(',').filter(Boolean).map(Number).sort((a, b) => a - b),
);
const checkedIds = (page) => page.locator('#asset-tags-form input[name="tagIds[]"]').evaluateAll(
  (inputs) => inputs.filter((input) => input.checked).map((input) => Number(input.value)).sort((a, b) => a - b),
);
const sorted = (ids) => [...ids].sort((a, b) => a - b);

async function openEditAsset(page) {
  await page.locator('.asset-viewer-edit').click();
  await expect(dialog(page)).toHaveJSProperty('open', true);
}

async function openTagDropdown(page) {
  const dropdown = page.locator('#asset-tags-form');
  if (!(await dropdown.evaluate((node) => node.open))) await dropdown.locator('summary').click();
}

async function toggleTag(page, id) {
  await openTagDropdown(page);
  await tagBox(page, id).click();
}

// The open option panel floats over the status below it, as it does for a user.
async function closeTagDropdown(page) {
  const dropdown = page.locator('#asset-tags-form');
  if (await dropdown.evaluate((node) => node.open)) await dropdown.locator('summary').click();
}

async function clickTagRetry(page) {
  await closeTagDropdown(page);
  await tagRetry(page).click();
}

async function sameDocument(page) {
  return page.evaluate(() => window.__sameDocument === true
    && document.querySelector('[data-asset-viewer-host]').__sameHost === true);
}

async function closeEditAsset(page) {
  await page.keyboard.press('Escape');
  if (await dialog(page).evaluate((node) => node.open)) await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveJSProperty('open', false);
}

test('A: saves a tag change in place with one POST, keeps the document and dialog, and reopens on the saved set', async ({ page }) => {
  const fixture = await createFixture();
  fixture.assign([fixture.tags.Alpha]);
  const { net, errors } = await open(page, fixture.url);
  const urlBefore = page.url();
  await openEditAsset(page);

  await toggleTag(page, fixture.tags.Beta);
  await expect(tagStatus(page)).toHaveText('Asset tags updated.');

  expect(net.posts).toEqual([`/projects/${fixture.projectId}/assets/${fixture.assetId}/tags`]);
  expect(net.navigations).toBe(0);
  expect(page.url()).toBe(urlBefore);
  expect(await sameDocument(page)).toBe(true);
  await expect(dialog(page)).toHaveJSProperty('open', true);
  expect(fixture.savedTagIds()).toEqual(sorted([fixture.tags.Alpha, fixture.tags.Beta]));
  await expect(chips(page)).toHaveText([/Alpha/, /Beta/]);
  expect(await confirmedIds(page)).toEqual(sorted([fixture.tags.Alpha, fixture.tags.Beta]));
  expect(net.gets).toHaveLength(1);

  await closeEditAsset(page);
  await openEditAsset(page);
  expect(await checkedIds(page)).toEqual(sorted([fixture.tags.Alpha, fixture.tags.Beta]));
  expect(net.posts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('B: removing every tag saves an explicit empty set', async ({ page }) => {
  const fixture = await createFixture();
  fixture.assign([fixture.tags.Alpha, fixture.tags.Beta]);
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);

  await toggleTag(page, fixture.tags.Alpha);
  await expect(tagStatus(page)).toHaveText('Asset tags updated.');
  await toggleTag(page, fixture.tags.Beta);
  await expect.poll(() => net.posts.length).toBe(2);
  await expect.poll(() => net.gets.length).toBe(2);
  await expect(tagStatus(page)).toHaveText('Asset tags updated.');

  expect(fixture.savedTagIds()).toEqual([]);
  await expect(page.locator('[data-asset-viewer-region="tags"]')).toContainText('No tags assigned to this asset.');
  await expect(chips(page)).toHaveCount(0);
  expect(await checkedIds(page)).toEqual([]);
  await closeEditAsset(page);
  await openEditAsset(page);
  expect(await checkedIds(page)).toEqual([]);
});

test('C: an unsaved filename and Move destination draft survive a tag save and are not submitted', async ({ page }) => {
  const fixture = await createFixture();
  const rowBefore = fixture.assetRow();
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);

  await page.locator('summary', { hasText: 'Rename file' }).click();
  await page.locator('#rename-filename').fill('draft-name.png');
  await page.locator('#move-destination').evaluate((select) => {
    select.value = 'uncategorized';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });

  await toggleTag(page, fixture.tags.Gamma);
  await expect(tagStatus(page)).toHaveText('Asset tags updated.');

  await expect(page.locator('#rename-filename')).toHaveValue('draft-name.png');
  await expect(page.locator('#move-destination')).toHaveValue('uncategorized');
  expect(net.posts).toEqual([`/projects/${fixture.projectId}/assets/${fixture.assetId}/tags`]);
  expect(fixture.assetRow()).toEqual(rowBefore);
  expect(fixture.savedTagIds()).toEqual([fixture.tags.Gamma]);
  expect(await confirmedIds(page)).toEqual([fixture.tags.Gamma]);
  expect(await sameDocument(page)).toBe(true);
});

test('D: stale catalog and archived refusals stay local, keep the draft and the saved baseline', async ({ page }) => {
  const fixture = await createFixture();
  fixture.assign([fixture.tags.Alpha]);
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);

  // The Gamma option was loaded with the page and deleted from the catalog since.
  app.locals.tagService.deleteTag(fixture.tags.Gamma);
  await toggleTag(page, fixture.tags.Gamma);
  await expect(tagStatus(page)).toContainText('One or more selected tags no longer exists');
  await expect(tagStatus(page)).toContainText('Your selection was kept.');
  expect(await checkedIds(page)).toEqual(sorted([fixture.tags.Alpha, fixture.tags.Gamma]));
  expect(await confirmedIds(page)).toEqual([fixture.tags.Alpha]);
  expect(fixture.savedTagIds()).toEqual([fixture.tags.Alpha]);
  expect(net.navigations).toBe(0);
  expect(await sameDocument(page)).toBe(true);
  await expect(dialog(page)).toHaveJSProperty('open', true);

  // Correcting the draft saves normally.
  await toggleTag(page, fixture.tags.Gamma);
  await expect(tagStatus(page)).toHaveText('Asset tags updated.');
  expect(fixture.savedTagIds()).toEqual([fixture.tags.Alpha]);

  // Archived elsewhere while the dialog is open.
  db.prepare('UPDATE projects SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(fixture.projectId);
  await toggleTag(page, fixture.tags.Beta);
  await expect(tagStatus(page)).toContainText('archived and read-only');
  expect(fixture.savedTagIds()).toEqual([fixture.tags.Alpha]);
  expect(await checkedIds(page)).toEqual(sorted([fixture.tags.Alpha, fixture.tags.Beta]));
  expect(await confirmedIds(page)).toEqual([fixture.tags.Alpha]);
  expect(net.navigations).toBe(0);

  await closeEditAsset(page);
  await openEditAsset(page);
  expect(await checkedIds(page)).toEqual([fixture.tags.Alpha]);
});

test('E: a change attempted while a save is held is refused; one POST per save and the final state is the last save', async ({ page }) => {
  const fixture = await createFixture();
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);
  await openTagDropdown(page);

  net.postMode = 'hold';
  await tagBox(page, fixture.tags.Alpha).click();
  await expect.poll(() => net.heldPosts.length).toBe(1);
  await expect(tagStatus(page)).toHaveText('Saving tags…');
  await expect(page.locator('#asset-edit-form')).toHaveAttribute('aria-busy', 'true');
  // A real pointer click on Beta while the dialog is frozen does not land.
  const box = await tagBox(page, fixture.tags.Beta).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Space');
  expect(await checkedIds(page)).toEqual([fixture.tags.Alpha]);
  expect(net.posts).toHaveLength(1);

  net.postMode = 'pass';
  net.heldPosts.shift()();
  await expect(tagStatus(page)).toHaveText('Asset tags updated.');
  expect(fixture.savedTagIds()).toEqual([fixture.tags.Alpha]);
  expect(await confirmedIds(page)).toEqual([fixture.tags.Alpha]);
  await expect(page.locator('#asset-edit-form')).not.toHaveAttribute('aria-busy', /.*/);

  // The newer choice is made again once the save settles, and is saved.
  await toggleTag(page, fixture.tags.Beta);
  await expect.poll(() => net.posts.length).toBe(2);
  await expect(tagStatus(page)).toHaveText('Asset tags updated.');
  expect(fixture.savedTagIds()).toEqual(sorted([fixture.tags.Alpha, fixture.tags.Beta]));
  expect(await confirmedIds(page)).toEqual(sorted([fixture.tags.Alpha, fixture.tags.Beta]));
  expect(await checkedIds(page)).toEqual(sorted([fixture.tags.Alpha, fixture.tags.Beta]));
});

test('E2: a page refresh read before a newer save never installs over it', async ({ page }) => {
  const fixture = await createFixture();
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);

  net.getMode = 'hold';
  await toggleTag(page, fixture.tags.Alpha);
  await expect.poll(() => net.heldGets.length).toBe(1);
  // What the first refresh would read: the page before the newer save.
  const staleHtml = await (await page.request.get(`${baseURL}${fixture.url}`)).text();
  expect(staleHtml).toContain(`data-confirmed-tag-ids="${fixture.tags.Alpha}"`);
  // Save the newer selection while the first refresh is still out.
  await toggleTag(page, fixture.tags.Beta);
  await expect.poll(() => net.heldGets.length).toBe(2);
  expect(fixture.savedTagIds()).toEqual(sorted([fixture.tags.Alpha, fixture.tags.Beta]));
  // The newer read answers first, then the older one arrives late and stale.
  const [older, newer] = net.heldGets.splice(0);
  await newer.continue();
  await expect(chips(page)).toHaveCount(2);
  await older.fulfill({ status: 200, contentType: 'text/html', body: staleHtml });
  await page.waitForTimeout(300);
  await expect(chips(page)).toHaveCount(2);
  expect(await confirmedIds(page)).toEqual(sorted([fixture.tags.Alpha, fixture.tags.Beta]));
  expect(net.posts).toHaveLength(2);
});

test('F: a dropped response is never resubmitted; GET reconciliation reports what is stored and Check again reads only, while every later save is held', async ({ page }) => {
  // WP10A1-F3: replaces WP10A1's F, which let a read settle the dropped save
  // and sent later saves (and a "Save selection again") while it could still run.
  const fixture = await createFixture();
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);

  net.postMode = 'drop';
  await toggleTag(page, fixture.tags.Alpha);
  await expect(tagStatus(page)).toContainText('The tag save could not be confirmed. The tags saved now match the selection that was sent. This is what is saved now; it does not show whether your request ran.');
  expect(net.posts).toHaveLength(1);
  expect(net.gets).toHaveLength(1);
  expect(fixture.savedTagIds()).toEqual([fixture.tags.Alpha]);
  expect(await confirmedIds(page)).toEqual([fixture.tags.Alpha]);
  await expect(tagRetry(page)).toHaveText('Check again');

  // A later change is refused, never sent: it stays as an unsaved draft.
  await toggleTag(page, fixture.tags.Beta);
  await expect(tagStatus(page)).toContainText('Your latest tag selection was not saved.');
  expect(net.posts).toHaveLength(1);
  expect(await checkedIds(page)).toEqual(sorted([fixture.tags.Alpha, fixture.tags.Beta]));
  expect(fixture.savedTagIds()).toEqual([fixture.tags.Alpha]);

  // The status read fails: the draft and the hold stay; Check again is GET only.
  net.getMode = 'fail-once';
  await clickTagRetry(page);
  await expect(tagStatus(page)).toContainText('The saved tags could not be read. Your selection is kept.');
  await expect(tagRetry(page)).toHaveText('Check again');
  await clickTagRetry(page);
  await expect(tagStatus(page)).toContainText('The tags saved now match the selection that was sent');
  expect(net.posts).toHaveLength(1);
  expect(net.gets).toHaveLength(3);
  expect(await checkedIds(page)).toEqual(sorted([fixture.tags.Alpha, fixture.tags.Beta]));
  expect(fixture.savedTagIds()).toEqual([fixture.tags.Alpha]);
  expect(net.navigations).toBe(0);
});

// ─── WP10A1-F3: retained original POSTs ───────────────────────────────────

const reviewField = (page) => page.locator('#asset-edit-form input[data-asset-tag-review]');

test('F3-B1: an early GET does not unlock a second save while the original POST is retained upstream', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  await openEditAsset(page);
  const callsBefore = upstream.replaceCalls.length;

  // Save A {Alpha}: retained before the route; the browser's answer is lost.
  const held = holdUpstreamTagSave();
  net.postMode = 'hold-upstream';
  await toggleTag(page, fixture.tags.Alpha);
  await expect.poll(() => held.gate.waiting.length).toBe(1);
  expect(held.gate.waiting[0].alive()).toBe(true);
  expect(held.gate.waiting[0].released).toBe(false);
  expect(upstream.replaceCalls.length).toBe(callsBefore);

  // The early GET observes the original (empty) saved set.
  await expect(tagStatus(page)).toContainText('The tags saved now differ from your selection');
  await expect(tagStatus(page)).toContainText('it does not show whether your request ran');
  expect(net.gets).toHaveLength(1);
  expect(fixture.savedTagIds()).toEqual([]);
  expect(await confirmedIds(page)).toEqual([]);

  // Save B {Alpha, Beta}: refused, never sent or queued.
  await toggleTag(page, fixture.tags.Beta);
  await expect(tagStatus(page)).toContainText('Your latest tag selection was not saved.');
  expect(net.posts).toHaveLength(1);
  expect(upstream.replaceCalls.length).toBe(callsBefore);
  await expect(tagStatus(page)).not.toContainText('Asset tags updated');
  await expect(page.locator('#asset-edit-form')).toHaveAttribute('data-asset-tags-hold', 'unresolved');
  expect(await checkedIds(page)).toEqual(sorted([fixture.tags.Alpha, fixture.tags.Beta]));
  expect(await confirmedIds(page)).toEqual([]);
  expect(await sameDocument(page)).toBe(true);

  // Check again: a GET, nothing else.
  await clickTagRetry(page);
  await expect.poll(() => net.gets.length).toBe(2);
  await expect(tagRetry(page)).toHaveText('Check again');
  expect(net.posts).toHaveLength(1);

  // Release the original Save A: it is the only replacement that runs.
  held.release();
  const answer = await net.upstream;
  expect(answer.status).toBe(200);
  expect(answer.body).toEqual(expect.objectContaining({ outcome: 'committed', tagIds: [fixture.tags.Alpha] }));
  expect(upstream.replaceCalls.slice(callsBefore)).toEqual([
    { assetId: fixture.assetId, tagIds: [fixture.tags.Alpha], outcome: 'committed' },
  ]);
  expect(fixture.savedTagIds()).toEqual([fixture.tags.Alpha]);

  // Still held: the page cannot know that answer. A read reports the new set as an observation.
  await clickTagRetry(page);
  await expect(tagStatus(page)).toContainText('The tags saved now match the selection that was sent');
  await expect(tagStatus(page)).toContainText('cannot be saved again');
  expect(await confirmedIds(page)).toEqual([fixture.tags.Alpha]);
  await toggleTag(page, fixture.tags.Gamma);
  expect(net.posts).toHaveLength(1);
  expect(upstream.replaceCalls.length).toBe(callsBefore + 1);
  expect(net.navigations).toBe(0);
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('F3-B1b: while a tag save is unresolved, Rename, Move, primary-image and Delete send nothing; dismissal keeps the hold and drafts', async ({ page }) => {
  const fixture = await createFixture();
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);

  const held = holdUpstreamTagSave();
  net.postMode = 'hold-upstream';
  await toggleTag(page, fixture.tags.Alpha);
  await expect.poll(() => held.gate.waiting.length).toBe(1);
  await expect(tagRetry(page)).toHaveText('Check again');
  await closeTagDropdown(page);

  const HELD = 'This asset cannot be changed from this page while the earlier tag save is unconfirmed.';
  const status = page.locator('#asset-edit-dialog [data-dialog-status]');
  const disclosure = (name) => page.locator('#asset-edit-dialog details > summary', { hasText: name });
  await disclosure('Rename file').click();
  await page.locator('#rename-filename').fill('renamed-draft.png');
  await page.locator('form.asset-rename-form button[type="submit"]').click();
  await expect(status).toContainText(HELD);
  await disclosure('Move file').click();
  await page.locator('form.asset-move-form button[type="submit"]').click();
  // Project primary image (this PNG is eligible): refused, never sent.
  await page.locator('form.asset-primary-image-set-form button[type="submit"]').click();
  await disclosure('Delete asset').click();
  await page.locator('form.asset-delete-form button').first().click();
  await expect(page.locator('[data-asset-delete-status-text]')).toContainText(HELD);
  // No confirmation opened for the refused Delete.
  await expect(page.locator('dialog.app-confirm-dialog[open], [data-app-confirm][open]')).toHaveCount(0);
  expect(net.posts).toEqual([`${fixture.url}/tags`]);
  expect(fixture.assetRow().filename).toBe('02-subject.png');
  expect(fixture.assetRow().relative_path).toBe('wip/02-subject.png');

  // Dismissal keeps the hold, the drafts and Check again; reopening sends nothing.
  await closeEditAsset(page);
  await openEditAsset(page);
  await expect(page.locator('#rename-filename')).toHaveValue('renamed-draft.png');
  expect(await checkedIds(page)).toEqual([fixture.tags.Alpha]);
  await expect(tagRetry(page)).toHaveText('Check again');
  await toggleTag(page, fixture.tags.Beta);
  expect(net.posts).toHaveLength(1);
  held.release();
  await net.upstream;
});

test('F3-B2: a save retained from a second tab is refused as stale and the newer save survives', async ({ page, context }) => {
  const fixture = await createFixture();
  const tabA = await open(page, fixture.url);
  const pageB = await context.newPage();
  const tabB = await open(pageB, fixture.url);
  await openEditAsset(page);
  await openEditAsset(pageB);
  // Both review the same (empty) saved set.
  expect(await reviewField(page).inputValue()).toBe(await reviewField(pageB).inputValue());
  const callsBefore = upstream.replaceCalls.length;

  // Tab A: Save A {Alpha}, retained upstream before the service.
  const held = holdUpstreamTagSave();
  tabA.net.postMode = 'retain-upstream';
  await toggleTag(page, fixture.tags.Alpha);
  await expect.poll(() => held.gate.waiting.length).toBe(1);
  expect(upstream.replaceCalls.length).toBe(callsBefore);

  // Tab B: {Alpha}, then {Alpha, Beta}, each committed.
  await toggleTag(pageB, fixture.tags.Alpha);
  await expect(tagStatus(pageB)).toHaveText('Asset tags updated.');
  await toggleTag(pageB, fixture.tags.Beta);
  await expect.poll(() => tabB.net.gets.length).toBe(2);
  await expect(tagStatus(pageB)).toHaveText('Asset tags updated.');
  await expect(chips(pageB)).toHaveText([/Alpha/, /Beta/]);
  const both = sorted([fixture.tags.Alpha, fixture.tags.Beta]);
  expect(fixture.savedTagIds()).toEqual(both);

  // Release A: refused inside the replacement, before any change.
  held.release();
  await expect(tagStatus(page)).toContainText('The saved tags changed after this selection was reviewed, so it was not saved.');
  await expect(tagStatus(page)).toContainText('The saved tags are shown now; review them, then use Save selection to save your selection.');
  await expect(tagRetry(page)).toHaveText('Save selection');
  expect(fixture.savedTagIds()).toEqual(both);
  expect(upstream.replaceCalls.slice(callsBefore).map(({ outcome }) => outcome))
    .toEqual(['committed', 'committed', 'AssetTagSetStaleError']);
  expect(tabA.net.posts).toHaveLength(1);
  expect(tabB.net.posts).toHaveLength(2);
  // Tab A now shows the saved set; its {Alpha} selection is kept as a draft.
  await expect.poll(() => confirmedIds(page)).toEqual(both);
  expect(await checkedIds(page)).toEqual([fixture.tags.Alpha]);
  await expect(chips(page)).toHaveText([/Alpha/, /Beta/]);
  // Tab B's baseline is still accurate and nothing was repeated.
  expect(await confirmedIds(pageB)).toEqual(both);
  await page.waitForTimeout(200);
  expect(upstream.replaceCalls.length).toBe(callsBefore + 3);
  await pageB.close();
});

test('F3-B3: a save retained across a reload is refused as stale and the newer save survives', async ({ page }) => {
  const fixture = await createFixture();
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);
  const callsBefore = upstream.replaceCalls.length;

  const held = holdUpstreamTagSave();
  net.postMode = 'hold-upstream';
  await toggleTag(page, fixture.tags.Alpha);
  await expect.poll(() => held.gate.waiting.length).toBe(1);
  await expect(tagRetry(page)).toHaveText('Check again');

  await page.reload();
  await openEditAsset(page);
  expect(held.gate.waiting[0].alive()).toBe(true);
  await toggleTag(page, fixture.tags.Beta);
  await expect(tagStatus(page)).toHaveText('Asset tags updated.');
  expect(fixture.savedTagIds()).toEqual([fixture.tags.Beta]);

  held.release();
  const answer = await net.upstream;
  expect(answer.status).toBe(409);
  expect(answer.body).toEqual(expect.objectContaining({ code: 'TAG_SET_STALE', outcome: 'refused' }));
  expect(fixture.savedTagIds()).toEqual([fixture.tags.Beta]);
  expect(upstream.replaceCalls.slice(callsBefore).map(({ outcome }) => outcome))
    .toEqual(['committed', 'AssetTagSetStaleError']);
  expect(await confirmedIds(page)).toEqual([fixture.tags.Beta]);
});

test('F3-B4: the reviewed state advances with each acknowledged save, so repeated editing keeps working', async ({ page }) => {
  const fixture = await createFixture();
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);
  const first = await reviewField(page).inputValue();

  await toggleTag(page, fixture.tags.Alpha);
  await expect(tagStatus(page)).toHaveText('Asset tags updated.');
  await expect.poll(() => net.gets.length).toBe(1);
  const second = await reviewField(page).inputValue();
  expect(second).not.toBe(first);

  await toggleTag(page, fixture.tags.Beta);
  await expect.poll(() => net.gets.length).toBe(2);
  await expect(tagStatus(page)).toHaveText('Asset tags updated.');
  const third = await reviewField(page).inputValue();
  expect(third).not.toBe(second);
  expect(fixture.savedTagIds()).toEqual(sorted([fixture.tags.Alpha, fixture.tags.Beta]));

  // The installed witness is the one a fresh page renders.
  const fresh = await page.request.get(`${baseURL}${fixture.url}?edit=1`);
  expect(await fresh.text()).toContain(`value="${third}" data-asset-tag-review`);
  expect(net.posts).toHaveLength(2);
});

test('F3-B5: an empty set saves with a current review; a stale empty replacement is refused against a newer set', async ({ page }) => {
  const fixture = await createFixture();
  fixture.assign([fixture.tags.Alpha]);
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);

  await toggleTag(page, fixture.tags.Alpha);
  await expect(tagStatus(page)).toHaveText('Asset tags updated.');
  expect(fixture.savedTagIds()).toEqual([]);
  await expect.poll(() => net.gets.length).toBe(1);

  // Saved {Alpha} again (elsewhere); this page reviews it, then clears it while retained.
  await toggleTag(page, fixture.tags.Alpha);
  await expect.poll(() => net.gets.length).toBe(2);
  await expect(tagStatus(page)).toHaveText('Asset tags updated.');
  const held = holdUpstreamTagSave();
  net.postMode = 'retain-upstream';
  await toggleTag(page, fixture.tags.Alpha);
  await expect.poll(() => held.gate.waiting.length).toBe(1);
  // A newer non-empty set is saved meanwhile (another tab's save).
  fixture.assign([fixture.tags.Alpha, fixture.tags.Beta]);
  held.release();

  await expect(tagStatus(page)).toContainText('The saved tags changed after this selection was reviewed, so it was not saved.');
  await expect(tagRetry(page)).toHaveText('Save selection');
  const both = sorted([fixture.tags.Alpha, fixture.tags.Beta]);
  expect(fixture.savedTagIds()).toEqual(both);
  await expect.poll(() => confirmedIds(page)).toEqual(both);
  expect(await checkedIds(page)).toEqual([]);
  expect(net.posts).toHaveLength(3);

  // Saving the kept empty selection is the user's explicit choice, against the set now shown.
  await clickTagRetry(page);
  await expect(tagStatus(page)).toHaveText('Asset tags updated.');
  expect(net.posts).toHaveLength(4);
  expect(fixture.savedTagIds()).toEqual([]);
});

test('G: a failed page refresh after a confirmed save keeps the save, the dialog and the media; Retry refresh is GET only', async ({ page }) => {
  const fixture = await createFixture();
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);

  net.getMode = 'fail-once';
  await toggleTag(page, fixture.tags.Beta);
  await expect(tagStatus(page)).toContainText('Asset tags updated, but the tags shown on this page could not refresh');
  expect(fixture.savedTagIds()).toEqual([fixture.tags.Beta]);
  await expect(chips(page)).toHaveCount(0);
  await expect(dialog(page)).toHaveJSProperty('open', true);
  expect(await sameDocument(page)).toBe(true);

  await clickTagRetry(page);
  await expect(tagStatus(page)).toHaveText('Asset tags updated.');
  await expect(chips(page)).toHaveText([/Beta/]);
  expect(net.posts).toHaveLength(1);
  expect(net.gets).toHaveLength(2);
  await expect(tagRetry(page)).toHaveCount(0);
});

test('H: the media host, a playing video, viewer navigation, filter context, scroll and focus survive a tag save', async ({ page }) => {
  const fixture = await createFixture({ video: true });
  fixture.assign([fixture.tags.Alpha]);
  // The page carries an asset-browser filter context, which the refresh GET re-sends.
  const { net } = await open(page, `${fixture.url}?sort=filename&order=desc`);
  const urlBefore = page.url();
  const video = page.locator('[data-asset-viewer-host] video');
  await expect(video).toHaveCount(1);
  const srcBefore = await video.getAttribute('src');
  const nav = page.locator('[data-asset-viewer-host] .asset-preview-nav');
  await expect(nav).toHaveCount(2);
  const navHrefs = await nav.evaluateAll((links) => links.map((link) => {
    link.__sameNav = true;
    return link.getAttribute('href');
  }));
  await video.evaluate(async (element) => {
    element.muted = true;
    element.loop = true;
    element.__sameVideo = true;
    await element.play();
  });
  await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeGreaterThan(0.2);
  await page.evaluate(() => window.scrollTo(0, 120));
  const scrollBefore = await page.evaluate(() => window.scrollY);

  await openEditAsset(page);
  await openTagDropdown(page);
  await tagBox(page, fixture.tags.Beta).click();
  await expect(tagStatus(page)).toHaveText('Asset tags updated.');
  await expect(chips(page)).toHaveText([/Alpha/, /Beta/]);

  expect(net.gets).toEqual([`${baseURL}${fixture.url}?sort=filename&order=desc`]);
  expect(await video.evaluate((element) => element.__sameVideo === true && !element.paused)).toBe(true);
  expect(await video.getAttribute('src')).toBe(srcBefore);
  expect(await nav.evaluateAll((links) => links.map((link) => link.__sameNav === true && link.getAttribute('href'))))
    .toEqual(navHrefs);
  expect(await sameDocument(page)).toBe(true);
  expect(page.url()).toBe(urlBefore);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  // Focus returns to the control that was used once the frozen save settles.
  expect(await page.evaluate((id) => document.activeElement?.value === String(id)
    && document.activeElement?.name === 'tagIds[]', fixture.tags.Beta)).toBe(true);
  await expect(dialog(page)).toHaveJSProperty('open', true);
  expect(net.posts).toHaveLength(1);

  await closeEditAsset(page);
  await expect(page.locator('.asset-viewer-edit')).toBeFocused();
  expect(await video.evaluate((element) => element.__sameVideo === true && !element.paused)).toBe(true);
  expect(fixture.savedTagIds()).toEqual(sorted([fixture.tags.Alpha, fixture.tags.Beta]));
});

test('I: native and direct requests keep their contract; bad CSRF, wrong identity and archived projects are refused', async ({ page }) => {
  const fixture = await createFixture();
  const other = await createFixture();
  await open(page, fixture.url);
  const csrf = await page.locator('#asset-edit-form input[name="_csrf"]').inputValue();
  // WP10A1-F3: the reviewed-state witness the page rendered for the empty set.
  const tagReview = await page.locator('#asset-edit-form input[name="tagReview"]').inputValue();
  const form = (data) => ({ form: data, maxRedirects: 0 });

  const native = await page.request.post(`${baseURL}${fixture.url}/tags`, form({
    _csrf: csrf, origin: 'asset-edit', 'tagIds[]': String(fixture.tags.Alpha), tagReview,
  }));
  expect(native.status()).toBe(302);
  expect(native.headers().location).toBe(`${fixture.url}?notice=asset_tags_updated&edit=1`);
  expect(fixture.savedTagIds()).toEqual([fixture.tags.Alpha]);

  // The same form again: its witness is stale now, and a missing one is refused.
  const stale = await page.request.post(`${baseURL}${fixture.url}/tags`, form({
    _csrf: csrf, origin: 'asset-edit', tagReview,
  }));
  expect(stale.status()).toBe(409);
  expect(await stale.text()).toContain('The saved tags changed after this selection was reviewed');
  const missing = await page.request.post(`${baseURL}${fixture.url}/tags`, form({ _csrf: csrf, origin: 'asset-edit' }));
  expect(missing.status()).toBe(422);
  expect(fixture.savedTagIds()).toEqual([fixture.tags.Alpha]);

  const badCsrf = await page.request.post(`${baseURL}${fixture.url}/tags`, {
    ...form({ _csrf: 'not-the-token', origin: 'asset-edit' }), headers: { Accept: 'application/json' },
  });
  expect(badCsrf.status()).toBe(403);
  expect(fixture.savedTagIds()).toEqual([fixture.tags.Alpha]);

  const crossProject = await page.request.post(`${baseURL}/projects/${other.projectId}/assets/${fixture.assetId}/tags`, {
    ...form({ _csrf: csrf, origin: 'asset-edit' }), headers: { Accept: 'application/json' },
  });
  expect(crossProject.status()).toBe(404);
  expect((await crossProject.json()).code).toBe('ASSET_NOT_FOUND');
  expect(fixture.savedTagIds()).toEqual([fixture.tags.Alpha]);

  db.prepare('UPDATE projects SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(other.projectId);
  const archived = await page.request.post(`${baseURL}${other.url}/tags`, {
    ...form({ _csrf: csrf, origin: 'asset-edit' }), headers: { Accept: 'application/json' },
  });
  expect(archived.status()).toBe(409);
  expect((await archived.json()).code).toBe('PROJECT_ARCHIVED');
});
