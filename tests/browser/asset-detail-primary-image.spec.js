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

// WP10A2: Edit Asset's Project and Book primary-image actions run in place on
// the Asset detail page, in real Chromium against the compiled client, real
// routes, templates and services. Every POST and GET is counted from the
// network, selections are read from the database, and the document, media host
// and dialog are checked by identity. All data lives in a temporary root that
// is removed afterward.

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-asset-primary-image-'));
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

let fixtureCount = 0;

async function createFixture({ books = ['First Book', 'Second Book'] } = {}) {
  fixtureCount += 1;
  const project = app.locals.projectService.create({ title: `Primary Image ${fixtureCount}`, status: 'tbd' });
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
  app.locals.assetScanner.scanProjectAssets(project.id);
  const assetId = (filename) => db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?')
    .get(project.id, filename).id;
  const subject = assetId('02-subject.png');
  const bookRows = books.map((title) => app.locals.bookService.createBook({ title: `${title} ${fixtureCount}` }));
  const tag = app.locals.tagService.createTag({ name: `Primary Tag ${fixtureCount}` });
  return {
    projectId: project.id,
    assetId: subject,
    otherAssetId: assetId('01-first.png'),
    books: bookRows,
    tag,
    url: `/projects/${project.id}/assets/${subject}`,
    projectPrimary: () => app.locals.projectPrimaryImageService.getPrimaryImage(project.id)?.id ?? null,
    bookPrimary: (book) => app.locals.bookPrimaryImageService.getPrimaryImage(book.id)?.id ?? null,
    setProject: (id) => app.locals.projectPrimaryImageService.setPrimaryImage(project.id, id),
    setBook: (book, id) => app.locals.bookPrimaryImageService.setPrimaryImage(book.id, id),
    savedTagIds: () => db.prepare('SELECT tag_id FROM asset_tags WHERE asset_id = ?').all(subject).map((row) => row.tag_id),
    assetRow: () => db.prepare('SELECT * FROM assets WHERE id = ?').get(subject),
    archive: () => app.locals.projectService.archive(project.id),
  };
}

const PRIMARY_POST = /^\/projects\/\d+\/assets\/\d+\/(book-)?primary-image(\/remove)?$/;

// Network bookkeeping, with optional interception of the primary-image POSTs,
// the tag POST and the page's own refresh GET (a fetch of the Asset detail URL).
async function open(page, url) {
  const net = { posts: [], gets: [], navigations: 0, postMode: 'pass', tagMode: 'pass', getMode: 'pass' };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST') net.posts.push(new URL(request.url()).pathname);
  });
  await page.route((target) => PRIMARY_POST.test(target.pathname), async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const mode = net.postMode;
    if (mode === 'pass') return route.continue();
    // Reaches the real server; only the browser's view of the answer changes.
    const response = await route.fetch();
    if (mode === 'drop') return route.abort('failed');
    return route.fulfill({ response });
  });
  await page.route((target) => /^\/projects\/\d+\/assets\/\d+\/tags$/.test(target.pathname), async (route) => {
    if (route.request().method() !== 'POST' || net.tagMode === 'pass') return route.fallback();
    // A refusal decided before any change: the selection stays an unsaved draft.
    return route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'error', code: 'TAG_NOT_FOUND', outcome: 'refused', message: 'One or more selected tags no longer exists.' }),
    });
  });
  await page.route((target) => /^\/projects\/\d+\/assets\/\d+$/.test(target.pathname), async (route) => {
    const request = route.request();
    if (request.resourceType() !== 'fetch') return route.fallback();
    net.gets.push(request.url());
    if (net.getMode === 'fail' || net.getMode === 'fail-once') {
      if (net.getMode === 'fail-once') net.getMode = 'pass';
      return route.fulfill({ status: 500, contentType: 'text/html', body: 'failed' });
    }
    return route.continue();
  });
  // The WP10A1 spec's desktop viewport; the narrow test sets its own first.
  if ((page.viewportSize()?.width ?? 1280) >= 768) await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${baseURL}${url}`);
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) net.navigations += 1; });
  await page.evaluate(() => {
    window.__sameDocument = true;
    const host = document.querySelector('[data-asset-viewer-host]');
    host.__sameHost = true;
    const image = host.querySelector('img');
    if (image) image.__sameImage = true;
  });
  return { net, errors };
}

const dialog = (page) => page.locator('#asset-edit-dialog');
const status = (page) => page.locator('#asset-edit-dialog [data-dialog-status] [data-asset-primary-image-status-text]');
const retry = (page) => page.locator('[data-asset-primary-image-retry]');
const projectSet = (page) => page.locator('form.asset-primary-image-set-form button');
const projectRemove = (page) => page.locator('form.asset-primary-image-remove-form button');
const bookSetButton = (page) => page.locator('form.asset-book-primary-image-set-form button[type="submit"]');
const bookRemove = (page, title) => page.getByRole('button', { name: `Remove book primary image from ${title}` });
const usageTitles = (page) => page.locator('.asset-book-primary-image-usage-list strong');

async function openEditAsset(page) {
  await page.locator('.asset-viewer-edit').click();
  await expect(dialog(page)).toHaveJSProperty('open', true);
}

async function chooseBook(page, title) {
  await page.locator('#book-primary-image-book summary').click();
  await page.locator('#book-primary-image-book label', { hasText: title }).click();
  expect(await page.locator('#book-primary-image-book-native').evaluate((select) => select.selectedOptions[0]?.textContent?.trim())).toBe(title);
  const dropdown = page.locator('#book-primary-image-book');
  if (await dropdown.evaluate((node) => node.open)) await dropdown.locator('summary').click();
}

async function sameDocument(page) {
  return page.evaluate(() => window.__sameDocument === true
    && document.querySelector('[data-asset-viewer-host]').__sameHost === true
    && (document.querySelector('[data-asset-viewer-host] img')?.__sameImage ?? true) === true);
}

async function enterDrafts(page) {
  await page.locator('summary', { hasText: 'Rename file' }).click();
  await page.locator('#rename-filename').fill('draft-name.png');
  await page.locator('summary', { hasText: 'Move file' }).click();
  await page.locator('#move-destination-dropdown summary').click();
  await page.locator('#move-destination-dropdown label', { hasText: 'WIP' }).click();
  const dropdown = page.locator('#move-destination-dropdown');
  if (await dropdown.evaluate((node) => node.open)) await dropdown.locator('summary').click();
}

async function expectDrafts(page) {
  await expect(page.locator('#rename-filename')).toHaveValue('draft-name.png');
  expect(await page.locator('#move-destination').evaluate((select) => select.selectedOptions[0].textContent.trim())).toBe('WIP');
}

const primaryPosts = (net) => net.posts.filter((pathname) => PRIMARY_POST.test(pathname));

test('A: sets the Project primary image with one POST, no navigation, and keeps drafts', async ({ page }) => {
  const fixture = await createFixture();
  const { net, errors } = await open(page, fixture.url);
  const urlBefore = page.url();
  await openEditAsset(page);
  await enterDrafts(page);

  await projectSet(page).click();
  await expect(status(page)).toHaveText('The primary image was set.');

  expect(primaryPosts(net)).toEqual([`/projects/${fixture.projectId}/assets/${fixture.assetId}/primary-image`]);
  expect(net.navigations).toBe(0);
  expect(page.url()).toBe(urlBefore);
  expect(await sameDocument(page)).toBe(true);
  await expect(dialog(page)).toHaveJSProperty('open', true);
  expect(fixture.projectPrimary()).toBe(fixture.assetId);
  await expect(page.locator('.asset-primary-image-status')).toHaveText('Currently set as the primary image.');
  await expect(projectRemove(page)).toBeVisible();
  await expect(projectSet(page)).toHaveCount(0);
  await expect(page.locator('[data-asset-viewer-region="project-primary-image"]')).toHaveAttribute('data-primary-image-selected', 'true');
  expect(net.gets).toHaveLength(1);
  await expectDrafts(page);
  expect(fixture.assetRow().filename).toBe('02-subject.png');
  expect(fixture.savedTagIds()).toEqual([]);
  await expect(page.locator('#asset-edit-dialog [aria-live]')).toHaveCount(1);
  expect(await page.locator('[aria-live]').count()).toBe(1);
  expect(errors).toEqual([]);
});

test('B: removes the Project primary image, then refuses a stale Remove and shows the saved state', async ({ page }) => {
  const fixture = await createFixture();
  await fixture.setProject(fixture.assetId);
  let { net } = await open(page, fixture.url);
  await openEditAsset(page);

  await projectRemove(page).click();
  await expect(status(page)).toHaveText('The primary image was removed.');
  expect(primaryPosts(net)).toEqual([`/projects/${fixture.projectId}/assets/${fixture.assetId}/primary-image/remove`]);
  expect(fixture.projectPrimary()).toBeNull();
  await expect(projectSet(page)).toBeVisible();
  expect(net.navigations).toBe(0);

  // The page shows this asset as primary, but another tab moves the selection.
  await fixture.setProject(fixture.assetId);
  const stalePage = await page.context().newPage();
  ({ net } = await open(stalePage, fixture.url));
  await openEditAsset(stalePage);
  await fixture.setProject(fixture.otherAssetId);
  await projectRemove(stalePage).click();
  await expect(status(stalePage)).toHaveText(
    'The primary image changed before it could be removed. Nothing was changed. The saved primary image is shown.',
  );
  expect(primaryPosts(net)).toHaveLength(1);
  expect(fixture.projectPrimary()).toBe(fixture.otherAssetId);
  await expect(projectRemove(stalePage)).toHaveCount(0);
  await expect(projectSet(stalePage)).toBeVisible();
  expect(net.navigations).toBe(0);
  await expect(dialog(stalePage)).toHaveJSProperty('open', true);
});

test('C: sets a Book primary image, updates the usage list, and allows an archived project’s asset', async ({ page }) => {
  const fixture = await createFixture();
  const [first, second] = fixture.books;
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);

  await chooseBook(page, first.title);
  await bookSetButton(page).click();
  await expect(status(page)).toHaveText(`The book primary image was set for “${first.title}”.`);
  expect(primaryPosts(net)).toEqual([`/projects/${fixture.projectId}/assets/${fixture.assetId}/book-primary-image`]);
  expect(fixture.bookPrimary(first)).toBe(fixture.assetId);
  expect(fixture.bookPrimary(second)).toBeNull();
  await expect(usageTitles(page)).toHaveText([first.title]);
  await expect(bookRemove(page, first.title)).toBeVisible();
  // The Book choice survives in the kept Set form.
  expect(await page.locator('#book-primary-image-book-native').evaluate((select) => select.value)).toBe(String(first.id));
  expect(fixture.projectPrimary()).toBeNull();
  expect(net.navigations).toBe(0);

  // Archived: the Project rule removes Project actions; the Book rule does not.
  fixture.archive();
  const archivedPage = await page.context().newPage();
  const archived = await open(archivedPage, `${fixture.url}?edit=1`);
  await expect(dialog(archivedPage)).toHaveJSProperty('open', true);
  await expect(archivedPage.locator('form.asset-primary-image-set-form')).toHaveCount(0);
  await chooseBook(archivedPage, second.title);
  await bookSetButton(archivedPage).click();
  await expect(status(archivedPage)).toHaveText(`The book primary image was set for “${second.title}”.`);
  expect(fixture.bookPrimary(second)).toBe(fixture.assetId);
  await expect(usageTitles(archivedPage)).toHaveText([first.title, second.title]);
  const refused = await archivedPage.evaluate(async (url) => {
    const csrf = document.querySelector('form.asset-book-primary-image-set-form input[name="_csrf"]').value;
    const response = await fetch(`${url}/primary-image`, {
      method: 'POST', headers: { Accept: 'application/json' }, body: new URLSearchParams({ _csrf: csrf }),
    });
    return { status: response.status, body: await response.json() };
  }, fixture.url);
  expect(refused).toEqual({ status: 409, body: expect.objectContaining({ code: 'PROJECT_ARCHIVED', outcome: 'refused' }) });
  expect(fixture.projectPrimary()).toBeNull();
  expect(archived.net.navigations).toBe(0);
});

test('D: removes one Book usage, keeps the other, and refuses a stale Book removal', async ({ page }) => {
  const fixture = await createFixture();
  const [first, second] = fixture.books;
  await fixture.setBook(first, fixture.assetId);
  await fixture.setBook(second, fixture.assetId);
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);
  await expect(usageTitles(page)).toHaveText([first.title, second.title]);

  await bookRemove(page, first.title).click();
  await expect(status(page)).toHaveText(`The book primary image was removed from “${first.title}”.`);
  expect(fixture.bookPrimary(first)).toBeNull();
  expect(fixture.bookPrimary(second)).toBe(fixture.assetId);
  await expect(usageTitles(page)).toHaveText([second.title]);
  // Focus moved from the removed control to its section heading: not the body,
  // and not the next Book's Remove, which a repeated Enter would trigger.
  await expect(page.locator('#asset-book-primary-image-heading')).toBeFocused();

  // Another tab gives the second Book a different cover.
  await fixture.setBook(second, fixture.otherAssetId);
  await bookRemove(page, second.title).click();
  await expect(status(page)).toHaveText(
    'The book primary image changed before it could be removed. Nothing was changed. The saved primary image is shown.',
  );
  expect(fixture.bookPrimary(second)).toBe(fixture.otherAssetId);
  await expect(usageTitles(page)).toHaveCount(0);
  expect(primaryPosts(net)).toHaveLength(2);
  expect(net.navigations).toBe(0);
  await expect(dialog(page)).toHaveJSProperty('open', true);
});

test('E: an unsaved tag selection, filename and destination survive and nothing else is saved', async ({ page }) => {
  const fixture = await createFixture();
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);
  // The tag save is refused, so the checked tag stays an unsaved draft.
  net.tagMode = 'refuse';
  await page.locator('#asset-tags-form summary').click();
  await page.locator(`#asset-tags-form input[value="${fixture.tag.id}"]`).click();
  await expect(page.locator('[data-asset-tags-status-text]')).toContainText('Your selection was kept.');
  await page.locator('#asset-tags-form summary').click();
  await enterDrafts(page);
  const tagPosts = net.posts.length;

  await projectSet(page).click();
  await expect(status(page)).toHaveText('The primary image was set.');
  await expect(page.locator(`#asset-tags-form input[value="${fixture.tag.id}"]`)).toBeChecked();
  await expect(page.locator('#asset-edit-form')).toHaveAttribute('data-confirmed-tag-ids', '');
  await expectDrafts(page);
  expect(net.posts.length).toBe(tagPosts + 1);
  expect(fixture.savedTagIds()).toEqual([]);
  expect(fixture.assetRow().filename).toBe('02-subject.png');
  expect(fixture.projectPrimary()).toBe(fixture.assetId);
});

test('F: a failed refresh keeps the success and Retry refresh sends only a GET', async ({ page }) => {
  const fixture = await createFixture();
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);
  net.getMode = 'fail-once';

  await projectSet(page).click();
  await expect(status(page)).toHaveText('The primary image was set. The primary image details shown may be out of date.');
  expect(fixture.projectPrimary()).toBe(fixture.assetId);
  await expect(retry(page)).toHaveText('Retry refresh');
  // The stale Set is held, not resubmitted.
  await expect(projectSet(page)).toHaveAttribute('aria-disabled', 'true');
  // A real click on the held control (Playwright otherwise honours aria-disabled).
  await projectSet(page).click({ force: true });
  await expect(status(page)).toHaveText('The primary image was set. The primary image details shown may be out of date. Use Retry refresh before trying again.');
  expect(primaryPosts(net)).toHaveLength(1);

  await retry(page).click();
  await expect(status(page)).toHaveText('The primary image was set.');
  await expect(projectRemove(page)).toBeVisible();
  expect(primaryPosts(net)).toHaveLength(1);
  expect(net.gets).toHaveLength(2);
  expect(net.navigations).toBe(0);
});

test('G: a lost response is never resent; the saved state is read and reported truthfully', async ({ page }) => {
  const fixture = await createFixture();
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);
  await enterDrafts(page);
  net.postMode = 'drop';

  await projectSet(page).click();
  await expect(status(page)).toHaveText(
    'The primary image change could not be confirmed. This asset is now the project’s primary image. This is what is saved now; it does not show whether your request ran.',
  );
  expect(primaryPosts(net)).toHaveLength(1);
  expect(net.gets).toHaveLength(1);
  expect(fixture.projectPrimary()).toBe(fixture.assetId);
  await expect(projectRemove(page)).toBeVisible();
  await expect(projectRemove(page)).not.toHaveAttribute('aria-disabled', 'true');
  await expectDrafts(page);
  expect(await sameDocument(page)).toBe(true);
  expect(net.navigations).toBe(0);
});

test('H: the media host and its image element survive without a reload', async ({ page }) => {
  const fixture = await createFixture();
  await open(page, fixture.url);
  const imageLoads = () => page.evaluate(() => performance.getEntriesByType('resource')
    .filter((entry) => entry.name.includes('/preview')).length);
  await page.locator('[data-asset-viewer-host] img').evaluate((image) => image.decode());
  const before = await imageLoads();
  const src = await page.locator('[data-asset-viewer-host] img').getAttribute('src');
  await openEditAsset(page);
  await projectSet(page).click();
  await expect(status(page)).toHaveText('The primary image was set.');
  await chooseBook(page, fixture.books[0].title);
  await bookSetButton(page).click();
  await expect(status(page)).toHaveText(`The book primary image was set for “${fixture.books[0].title}”.`);
  expect(await sameDocument(page)).toBe(true);
  await expect(page.locator('[data-asset-viewer-host] img')).toHaveAttribute('src', src);
  expect(await page.locator('[data-asset-viewer-host] img').evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  expect(await imageLoads()).toBe(before);
  await expect(page.locator('.asset-preview-nav--next')).toBeVisible();
});

test('I: native submission still works without JavaScript; tag Save stays local; file forms are unchanged', async ({ browser, page }) => {
  const fixture = await createFixture();
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const native = await context.newPage();
    await native.goto(`${baseURL}${fixture.url}?edit=1`);
    await native.locator('form.asset-primary-image-set-form button').click();
    await native.waitForURL(/notice=primary-image-set/);
    expect(fixture.projectPrimary()).toBe(fixture.assetId);
    await native.locator('form.asset-primary-image-remove-form button').click();
    await native.waitForURL(/notice=primary-image-removed/);
    expect(fixture.projectPrimary()).toBeNull();
  } finally {
    await context.close();
  }

  const { net } = await open(page, fixture.url);
  await openEditAsset(page);
  await page.locator('#asset-tags-form summary').click();
  await page.locator(`#asset-tags-form input[value="${fixture.tag.id}"]`).click();
  await expect(page.locator('[data-asset-tags-status-text]')).toHaveText('Asset tags updated.');
  expect(fixture.savedTagIds()).toEqual([fixture.tag.id]);
  await page.locator(`#asset-tags-form input[value="${fixture.tag.id}"]`).click();
  await expect(page.locator('[data-asset-tags-status-text]')).toHaveText('Asset tags updated.');
  expect(fixture.savedTagIds()).toEqual([]);
  await page.locator('#asset-tags-form summary').click();
  await projectSet(page).click();
  await expect(status(page)).toHaveText('The primary image was set.');
  // The latest action owns the status: the settled tag message gave way.
  await expect(page.locator('[data-asset-tags-status-text]')).toHaveText('');
  expect(net.navigations).toBe(0);
  for (const [cls, suffix] of [['asset-rename-form', 'rename'], ['asset-move-form', 'move'], ['asset-delete-form', 'delete']]) {
    await expect(page.locator(`form.${cls}`)).toHaveAttribute('action', `/projects/${fixture.projectId}/assets/${fixture.assetId}/${suffix}`);
  }
  expect(await page.locator('[id]').evaluateAll((nodes) => {
    const ids = nodes.map((node) => node.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  })).toEqual([]);
});

test('keyboard: repeated Enter submits once, focus lands on the section heading, Escape closes', async ({ page }) => {
  const fixture = await createFixture();
  const { net } = await open(page, fixture.url);
  await openEditAsset(page);
  await projectSet(page).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(status(page)).toHaveText('The primary image was set.');
  await expect(page.locator('#asset-primary-image-heading')).toBeFocused();
  // A late repeat lands on the heading, never on the new Remove control.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  expect(primaryPosts(net)).toHaveLength(1);
  expect(fixture.projectPrimary()).toBe(fixture.assetId);
  await page.keyboard.press('Tab');
  await expect(projectRemove(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveJSProperty('open', false);
  await openEditAsset(page);
  await expect(projectRemove(page)).toBeVisible();
  expect(primaryPosts(net)).toHaveLength(1);
});

test('narrow layout: long Book titles and several usages stay readable without horizontal scroll', async ({ page }) => {
  const long = 'An Exceptionally Long Book Title That Keeps Going Well Past The Width Of A Phone Screen';
  const fixture = await createFixture({ books: [long, 'Second', 'Third'] });
  for (const book of fixture.books.slice(1)) await fixture.setBook(book, fixture.assetId);
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, fixture.url);
  await openEditAsset(page);
  await chooseBook(page, fixture.books[0].title);
  await bookSetButton(page).click();
  await expect(status(page)).toHaveText(`The book primary image was set for “${fixture.books[0].title}”.`);
  await expect(usageTitles(page)).toHaveCount(3);
  const overflow = await page.locator('#asset-edit-dialog').evaluate((node) => {
    const card = node.querySelector('.app-dialog-card') || node;
    return {
      dialog: card.scrollWidth - card.clientWidth,
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      longest: Math.max(...Array.from(node.querySelectorAll('.asset-book-primary-image-usage-list > li'))
        .map((li) => li.getBoundingClientRect().right)),
      viewport: window.innerWidth,
    };
  });
  expect(overflow.dialog).toBeLessThanOrEqual(1);
  expect(overflow.page).toBeLessThanOrEqual(1);
  expect(overflow.longest).toBeLessThanOrEqual(overflow.viewport);
});
