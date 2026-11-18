import { test, expect } from '@playwright/test';
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

/*
 * Consolidated review correction F1 — an open dropdown in the Filters &
 * Defaults dialog is a fixed overlay. When dialog content moves its trigger
 * (the failed-GET Retry notice is inserted or removed, preceding content is
 * shown or hidden), the panel must follow the trigger so the trigger's centre
 * stays its own pointer target. Every click here is a real pointer click
 * (no force, no DOM click); requests are held or failed through route gates,
 * never sleeps. All data lives in a temporary root that is removed afterward.
 */

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-dropdown-reanchor-browser-'));
  projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const viteDistRoot = path.join(root, 'client');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
    appDataRoot, authState: { csrfPepper }, useViteAssets: true, viteDistRoot,
    assetManifest: createAssetManifest({ distRoot: viteDistRoot,
      manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
  });
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

// files: [{ name, tag }] in the default 'final' category.
async function createProject(title, files) {
  const project = app.locals.projectService.create({ title, status: 'tbd' });
  const categories = app.locals.projectAssetCategoryService;
  if (!categories.list(project.id).some((candidate) => candidate.directory_slug === 'final')) {
    categories.add(project.id, { displayName: 'FINAL', directorySlug: 'final' });
  }
  const fileOf = (file) => path.join(projectsRoot, project.project_dir, 'final', file.name);
  for (const [index, file] of files.entries()) {
    fs.mkdirSync(path.dirname(fileOf(file)), { recursive: true });
    const image = sharp({ create: { width: 12, height: 12, channels: 3, background: { r: (index * 25) % 255, g: 90, b: 160 } } });
    await (file.name.endsWith('.png') ? image.png() : image.jpeg()).toFile(fileOf(file));
  }
  app.locals.assetScanner.scanProjectAssets(project.id);
  const ids = Object.fromEntries(db.prepare('SELECT filename, id FROM assets WHERE project_id = ?')
    .all(project.id).map((row) => [row.filename, row.id]));
  for (const file of files.filter((candidate) => candidate.tag)) {
    const tag = app.locals.tagService.createTag({ name: `${title} ${file.tag}` });
    app.locals.assetTagService.replaceAssetTags(ids[file.name], [tag.id]);
  }
  return { url: (query = '') => `${baseURL}/projects/${project.id}/assets${query ? `?${query}` : ''}` };
}

const region = (page) => page.locator('[data-project-assets-live-region]');
const filterDialog = (page) => page.locator('#project-assets-filter-dialog');
const settled = (page) => expect(region(page)).not.toHaveAttribute('aria-busy', 'true');
const failureNotice = (page) => filterDialog(page).locator('[data-live-filter-failure]');
const extension = (page) => page.locator('#asset-extension-filter');
const optionFor = (page, dropdown, value) => dropdown.locator('label')
  .filter({ has: page.locator(`input[value="${value}"]`) });

const selectedExtensions = (page) => page.evaluate(() => new FormData(document.getElementById('asset-filters'))
  .getAll('extension').filter(Boolean));

async function openFilters(page) {
  await page.getByRole('link', { name: 'Filters & Defaults', exact: true }).click();
  await expect(filterDialog(page)).toBeVisible();
}

async function openDropdown(dropdown) {
  if (!(await dropdown.evaluate((node) => node.open))) await dropdown.locator('summary').click();
  await expect(dropdown).toHaveJSProperty('open', true);
}

// Two animation frames: any scheduled re-anchor has run and been painted.
const frames = (page) => page.evaluate(() => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
}));

/*
 * Rendered geometry: the trigger's centre hit target, and whether the panel
 * box intersects the trigger box or leaves the viewport.
 */
function geometry(dropdown) {
  return dropdown.evaluate((node) => {
    const summary = node.querySelector('summary');
    const panel = node.querySelector('.asset-filter-multiselect-panel');
    const s = summary.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const hit = document.elementFromPoint(s.left + (s.width / 2), s.top + (s.height / 2));
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    return {
      centreIsTrigger: Boolean(hit && summary.contains(hit)),
      centreIsPanel: Boolean(hit && panel.contains(hit)),
      overlaps: !(p.bottom <= s.top || p.top >= s.bottom || p.right <= s.left || p.left >= s.right),
      anchored: Math.abs(p.top - (s.bottom + 4)) <= 1 || Math.abs(p.bottom - (s.top - 4)) <= 1,
      insideViewport: p.left >= 0 && p.top >= 0 && p.right <= viewportWidth && p.bottom <= viewportHeight,
      panelTop: p.top,
      triggerBottom: s.bottom,
    };
  });
}

async function expectTracksTrigger(dropdown) {
  const box = await geometry(dropdown);
  expect(box, JSON.stringify(box)).toMatchObject({
    centreIsTrigger: true, centreIsPanel: false, overlaps: false, anchored: true, insideViewport: true,
  });
}

function watch(page) {
  const control = { posts: [], gets: [], errors: [] };
  page.on('pageerror', (error) => control.errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST') control.posts.push(url.pathname);
    else if (/^\/projects\/\d+\/assets$/.test(url.pathname) && request.resourceType() === 'fetch') {
      control.gets.push(url.searchParams.getAll('extension').join(','));
    }
  });
  return control;
}

async function gateAssetGets(page) {
  const control = { rules: [] };
  await page.route((url) => /^\/projects\/\d+\/assets$/.test(url.pathname), async (route) => {
    const request = route.request();
    if (request.method() !== 'GET' || request.resourceType() !== 'fetch') return route.continue();
    const url = new URL(request.url());
    const index = control.rules.findIndex((rule) => rule.match(url));
    if (index === -1) return route.continue();
    const [rule] = control.rules.splice(index, 1);
    rule.arrived(url);
    const action = await rule.decision;
    try {
      if (action === 'fail') await route.fulfill({ status: 500, body: 'failed' });
      else await route.continue();
    } catch {
      // The page aborted this request when a newer navigation superseded it.
    }
    return undefined;
  });
  control.next = (match, { fail = false } = {}) => {
    const rule = { match };
    const arrival = new Promise((resolve) => { rule.arrived = resolve; });
    let decide;
    rule.decision = new Promise((resolve) => { decide = resolve; });
    if (fail) decide('fail');
    control.rules.push(rule);
    return { arrival, release: () => decide('continue') };
  };
  return control;
}

const hasExtension = (...values) => (url) => JSON.stringify(url.searchParams.getAll('extension')) === JSON.stringify(values);

// Opens Extension, picks PNG alone and fails its GET; the notice is shown.
async function failPngWithExtensionOpen(page, gate) {
  const dropdown = extension(page);
  await openDropdown(dropdown);
  const failed = gate.next(hasExtension('png'), { fail: true });
  await optionFor(page, dropdown, 'png').click();
  await failed.arrival;
  await expect(failureNotice(page)).toBeVisible();
  await expect(failureNotice(page).getByRole('button', { name: 'Retry' })).toBeVisible();
  await frames(page);
  await expect(dropdown).toHaveJSProperty('open', true);
  return dropdown;
}

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1280, height: 900 },
  { width: 800, height: 720 },
  { width: 390, height: 720 },
];

for (const view of ['grid', 'list']) {
  for (const viewport of VIEWPORTS) {
    test(`${view} ${viewport.width}x${viewport.height}: the inserted Retry notice keeps Extension anchored and its trigger closes it`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const f = await createProject(`Reanchor ${view} ${viewport.width}x${viewport.height}`, [{ name: 'shot.png' }, { name: 'shot.jpg' }]);
      const control = watch(page);
      const gate = await gateAssetGets(page);
      await page.goto(f.url(`view=${view}`));
      await openFilters(page);

      const dropdown = await failPngWithExtensionOpen(page, gate);
      await expectTracksTrigger(dropdown);
      expect(await selectedExtensions(page)).toEqual(['png']);
      const getsBefore = [...control.gets];

      // The trigger centre is a real pointer target: the click closes Extension.
      await dropdown.locator('summary').click();
      await expect(dropdown).toHaveJSProperty('open', false);
      await expect(filterDialog(page)).toBeVisible();
      expect(await selectedExtensions(page)).toEqual(['png']);
      await expect(failureNotice(page)).toBeVisible();

      // GET-only Retry repeats exactly the failed PNG load; dismissal added none.
      await failureNotice(page).getByRole('button', { name: 'Retry' }).click();
      await expect(failureNotice(page)).toHaveCount(0);
      await settled(page);
      expect(control.gets).toEqual([...getsBefore, 'png']);
      expect(getsBefore).toEqual(['png']);
      expect(await selectedExtensions(page)).toEqual(['png']);
      expect(control.posts).toEqual([]);
      expect(control.errors).toEqual([]);
    });
  }
}

test('notice removal by a held newer load re-anchors the open panel; selection, Escape and outside click still work', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const f = await createProject('Reanchor removal', [{ name: 'shot.png' }, { name: 'shot.jpg' }]);
  const control = watch(page);
  const gate = await gateAssetGets(page);
  await page.goto(f.url('view=grid'));
  await openFilters(page);

  const dropdown = await failPngWithExtensionOpen(page, gate);
  const withNotice = await geometry(dropdown);
  await expectTracksTrigger(dropdown);

  // A legitimate option choice starts a newer (held) load, which ends the
  // failure: the notice leaves, the trigger moves up and the panel follows.
  const held = gate.next(hasExtension('jpg', 'png'));
  await optionFor(page, dropdown, 'jpg').click();
  await held.arrival;
  await expect(failureNotice(page)).toHaveCount(0);
  await frames(page);
  await expect(dropdown).toHaveJSProperty('open', true);
  const withoutNotice = await geometry(dropdown);
  expect(withoutNotice.triggerBottom).toBeLessThan(withNotice.triggerBottom);
  await expectTracksTrigger(dropdown);
  expect((await selectedExtensions(page)).sort()).toEqual(['jpg', 'png']);

  // Escape closes it and returns focus to the trigger; the dialog stays open.
  await page.keyboard.press('Escape');
  await expect(dropdown).toHaveJSProperty('open', false);
  await expect(dropdown.locator('summary')).toBeFocused();
  await expect(filterDialog(page)).toBeVisible();

  // Preceding content shown or hidden (the R2/R3 visibility mechanism is the
  // hidden attribute) moves the trigger without resizing it.
  await openDropdown(dropdown);
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.id = 'reanchor-spacer';
    spacer.style.height = '60px';
    spacer.hidden = true;
    document.querySelector('#asset-filters').prepend(spacer);
  });
  await frames(page);
  await expectTracksTrigger(dropdown);
  await page.evaluate(() => { document.getElementById('reanchor-spacer').hidden = false; });
  await frames(page);
  await expectTracksTrigger(dropdown);
  await page.evaluate(() => { document.getElementById('reanchor-spacer').hidden = true; });
  await frames(page);
  await expectTracksTrigger(dropdown);

  // An outside click (the dialog heading) dismisses it; the dialog stays open.
  await filterDialog(page).getByRole('heading').first().click();
  await expect(dropdown).toHaveJSProperty('open', false);
  await expect(filterDialog(page)).toBeVisible();

  held.release();
  await settled(page);
  expect(control.gets).toEqual(['png', 'jpg,png']);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});

test('a long option list stays inside the viewport and scrolls without being re-placed', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const files = Array.from({ length: 30 }, (_, index) => ({ name: `long-${String(index).padStart(2, '0')}.png`, tag: `T${index}` }));
  const f = await createProject('Reanchor long', files);
  const control = watch(page);
  await page.goto(f.url('view=grid'));
  await openFilters(page);

  const tags = page.locator('#asset-tag-filter');
  await openDropdown(tags);
  const panel = tags.locator('.asset-filter-multiselect-panel');
  const before = await panel.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, scrollable: node.scrollHeight > node.clientHeight };
  });
  expect(before.scrollable).toBe(true);
  expect(before.bottom).toBeLessThanOrEqual(720);
  await expectTracksTrigger(tags);

  await panel.hover();
  await page.mouse.wheel(0, 240);
  await expect.poll(() => panel.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await frames(page);
  const after = await panel.evaluate((node) => ({ top: node.getBoundingClientRect().top, scrollTop: node.scrollTop }));
  expect(after.top).toBe(before.top);
  expect(after.scrollTop).toBeGreaterThan(0);
  await expectTracksTrigger(tags);

  await tags.locator('summary').click();
  await expect(tags).toHaveJSProperty('open', false);
  expect(control.gets).toEqual([]);
  expect(control.posts).toEqual([]);
  expect(control.errors).toEqual([]);
});
