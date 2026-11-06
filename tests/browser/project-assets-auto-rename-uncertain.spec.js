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
import { createAssetRepository } from '../../src/data/asset-repository.js';
import { createAssetCategoryRepository } from '../../src/data/asset-category-repository.js';
import { createProjectDirectoryOwnershipRepository } from '../../src/data/project-directory-ownership-repository.js';
import { createProjectRepository } from '../../src/data/project-repository.js';
import { createAutoRenameService } from '../../src/services/auto-rename-service.js';
import { createProjectOperationCoordinator } from '../../src/services/project-operation-coordinator.js';

// An Auto Rename Apply whose answer is lost, unreadable or delayed, in real
// Chromium against the real Auto Rename service. Its outcome is settled only by
// the server's receipt for that Apply attempt, never by database names or by
// another attempt of an identical signed plan, and until then no other review
// of the project can be applied, whatever dialog was dismissed. Faults are
// injected into the service's own phase-two and compensation steps, and a
// genuine project operation in progress is held on the service's own
// coordinator. All data lives in a temporary root removed afterward.
const FILES = ['a-shot.png', 'b-shot.jpg', 'c-shot.png', 'd-shot.jpg'];
const faults = { phase2: false, compensation: false };
const coordinator = createProjectOperationCoordinator();

let server;
let db;
let app;
let root;
let projectsRoot;
let baseURL;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-auto-rename-uncertain-'));
  projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  const viteDistRoot = path.join(root, 'client');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
  db = openDatabase(path.join(root, 'test.db'));
  runMigrations(db, fileURLToPath(new URL('../../migrations', import.meta.url)));
  const autoRenameService = createAutoRenameService({
    projectDirectoryOwnershipRepository: createProjectDirectoryOwnershipRepository(db),
    projectRepository: createProjectRepository(db),
    assetRepository: createAssetRepository(db),
    assetCategoryRepository: createAssetCategoryRepository(db),
    projectsRoot,
    projectOperationCoordinator: coordinator,
    signingKey: Buffer.from('creatorcrate-auto-rename-uncertain-browser-key'),
    _hooks: {
      beforePhase2Move({ index }) {
        if (faults.phase2 && index === 1) throw new Error('injected phase two failure');
      },
      beforeCompensationMove() {
        if (faults.compensation) throw new Error('injected compensation failure');
      },
    },
  });
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
    appDataRoot, authState: { csrfPepper }, useViteAssets: true, viteDistRoot, autoRenameService,
    assetManifest: createAssetManifest({ distRoot: viteDistRoot,
      manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json') }),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});

test.afterEach(() => {
  faults.phase2 = false;
  faults.compensation = false;
});

test.afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (db) closeDatabase(db);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function writeImage(filePath, shade = 90) {
  const image = sharp({ create: { width: 12, height: 12, channels: 3, background: { r: shade, g: 90, b: 160 } } });
  await (filePath.endsWith('.png') ? image.png() : image.jpeg()).toFile(filePath);
}

async function createProject(title) {
  const project = app.locals.projectService.create({ title, status: 'tbd' });
  const categories = app.locals.projectAssetCategoryService;
  if (!categories.list(project.id).some((candidate) => candidate.directory_slug === 'wip')) {
    categories.add(project.id, { displayName: 'WIP', directorySlug: 'wip' });
  }
  const category = categories.list(project.id).find((candidate) => candidate.directory_slug === 'wip');
  const categoryDir = path.join(projectsRoot, project.project_dir, 'wip');
  fs.mkdirSync(categoryDir, { recursive: true });
  for (const [index, filename] of FILES.entries()) await writeImage(path.join(categoryDir, filename), index * 40);
  app.locals.assetScanner.scanProjectAssets(project.id);
  const { slug } = db.prepare('SELECT slug FROM projects WHERE id = ?').get(project.id);
  const assetId = (filename) => db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?').get(project.id, filename).id;
  return {
    id: project.id,
    categoryId: category.id,
    url: `/projects/${project.id}/assets`,
    assetId,
    generated: (number, extension) => `${slug}-wip-${String(number).padStart(2, '0')}.${extension}`,
    row: (id) => db.prepare('SELECT filename, relative_path FROM assets WHERE id = ?').get(id),
    files: () => fs.readdirSync(categoryDir).sort(),
  };
}

// Records every request and lets a test lose, drop (never deliver), corrupt or
// fail the Apply POST and the state GET.
async function open(page, url) {
  const control = { posts: [], applies: [], states: [], apply: 'pass', state: 'pass', dropped: [], stale: [] };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() !== 'GET') control.posts.push(new URL(request.url()).pathname);
  });
  await page.route('**/assets/auto-rename/apply', async (route) => {
    control.applies.push(route.request());
    if (control.apply === 'lose') {
      // The service runs; its answer never arrives.
      await route.fetch();
      return route.abort('failed');
    }
    if (control.apply === 'malformed') {
      await route.fetch();
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"succ' });
    }
    if (control.apply === 'drop') {
      // Held in the network: the browser gives up before the server sees it.
      control.dropped.push(route.request());
      return route.abort('failed');
    }
    return route.continue();
  });
  await page.route('**/assets/auto-rename/state?*', async (route) => {
    control.states.push(route.request());
    if (control.state === 'fail') return route.fulfill({ status: 500, contentType: 'text/html', body: 'failed' });
    if (control.state === 'stale') {
      // Read now, answered later.
      const response = await route.fetch();
      control.stale.push(() => route.fulfill({ response }));
      return undefined;
    }
    return route.continue();
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${baseURL}${url}`);
  await page.evaluate(() => { window.__sameDocument = true; });
  return { control, errors };
}

// Delivers a dropped Apply to the server as the network finally would.
async function deliver(page, request) {
  const response = await page.request.post(request.url(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    data: request.postData(),
  });
  return { status: response.status(), body: await response.json() };
}

const surface = (page) => page.locator('[data-auto-rename-surface]');
const item = (page, name) => surface(page).locator(`[data-auto-rename-asset][aria-label="Reorder ${name}"]`);
const box = (page, id) => page.locator(`input[name="selectedAssetIds"][value="${id}"]`);
const autoRename = (page) => page.locator('[data-auto-rename-submit]');
const dialog = (page) => page.locator('#auto-rename-confirmation-dialog');
const dialogError = (page) => dialog(page).locator('[data-dialog-error-text]');
const applyButton = (page) => dialog(page).getByRole('button', { name: 'Apply Auto Rename' });
const cancelButton = (page) => dialog(page).getByRole('button', { name: 'Cancel', exact: true });
const feedback = (page) => page.locator('[data-dialog-feedback]');
const notice = (page) => page.locator('[data-auto-rename-pending]');
const noticeCheck = (page) => notice(page).getByRole('button', { name: 'Check again' });
const orderValue = async (page) => JSON.parse(await page.locator('[data-auto-rename-order-input]').inputValue());
const sameDocument = (page) => page.evaluate(() => window.__sameDocument === true);
const applyPosts = (control) => control.posts.filter((post) => post.endsWith('/auto-rename/apply'));
const applyFields = (control, index) => new URLSearchParams(control.applies[index].postData());
const stateAttempts = (control) => control.states.map((request) => new URL(request.url()).searchParams.get('attempt'));

async function select(page, id) {
  await page.locator(`label[for$="-select-${id}"]`).click();
  await expect(box(page, id)).toBeChecked();
}

// Filtered to the PNGs (A, C), with C moved before A: complete order C, B, A, D.
async function filteredReview(page, f) {
  const [a, b, c, d] = FILES.map(f.assetId);
  await item(page, 'c-shot.png').focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  expect(await orderValue(page)).toEqual([c, b, a, d]);
  await select(page, c);
  await select(page, a);
  return { a, b, c, d };
}

async function preview(page) {
  await autoRename(page).click();
  await expect(dialog(page)).toBeVisible();
}

// A second review of the held project: it opens, but Apply cannot be sent.
async function expectBlockedReview(page, control) {
  const before = applyPosts(control).length;
  await preview(page);
  await expect(applyButton(page)).toBeDisabled();
  await expect(dialogError(page)).toContainText('An earlier Auto Rename for this project is not settled');
  await applyButton(page).evaluate((button) => button.form.requestSubmit());
  expect(applyPosts(control)).toHaveLength(before);
  await cancelButton(page).click();
  await expect(dialog(page)).toHaveCount(0);
}

test('F1A: a lost answer of a failed, uncompensated Apply is reported from its receipt, never as not applied', async ({ page }) => {
  const f = await createProject('Uncertain F1A');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&extension=png`);
  const { a, b, c, d } = await filteredReview(page, f);
  await preview(page);
  faults.phase2 = true;
  faults.compensation = true;
  control.apply = 'lose';
  await applyButton(page).click();

  await expect(dialogError(page)).toContainText('Auto Rename could not fully restore the project files.');
  await expect(dialogError(page)).toContainText('Auto Rename stays unavailable for this project on this page.');
  const text = await dialogError(page).textContent();
  expect(text).not.toMatch(/had not been applied|was not applied|No files were renamed|restored the/);
  await expect(dialog(page).getByRole('button', { name: 'Check again' })).toHaveCount(0);
  await expect(applyButton(page)).toBeDisabled();
  await expect(notice(page)).toBeVisible();
  await expect(notice(page)).toHaveClass(/notice--error/);

  // The real partial state: one file renamed, the other in a temporary file;
  // the database still lists the original names.
  const files = f.files();
  expect(files).toContain(f.generated(1, 'png'));
  expect(files).not.toContain('c-shot.png');
  expect(files.some((name) => name.includes('__creatorcrate_auto_rename_'))).toBe(true);
  expect(f.row(c).filename).toBe('c-shot.png');
  expect(f.row(a).filename).toBe('a-shot.png');
  // The read saw the original names and still did not conclude anything from them.
  expect(control.states).toHaveLength(1);
  expect(stateAttempts(control)).toEqual([applyFields(control, 0).get('attemptId')]);
  expect(stateAttempts(control)[0]).toMatch(/^[0-9a-f]{32}$/);

  await cancelButton(page).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(notice(page)).toContainText('could not fully restore the project files');
  faults.phase2 = false;
  faults.compensation = false;
  await expectBlockedReview(page, control);
  expect(applyPosts(control)).toHaveLength(1);
  expect(await orderValue(page)).toEqual([c, b, a, d]);
  // The established processing recovery entry point is still on the page.
  expect(await page.locator('[data-recovery-details-entry]').count()).toBeGreaterThan(0);
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('F1B: matching final names from another Apply are not claimed as this Apply’s success', async ({ page }) => {
  const f = await createProject('Uncertain F1B');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&extension=png`);
  const { a, b, c, d } = await filteredReview(page, f);
  await preview(page);
  control.apply = 'drop';
  await applyButton(page).click();
  await expect(dialogError(page)).toContainText('The server has no result for this Auto Rename yet');

  // Another tab applies a different plan (another hidden order) that produces
  // exactly the reviewed names; the identical plan is covered by attempt tests.
  const other = await page.request.post(`${baseURL}${f.url}/auto-rename/preview`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    data: new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(control.dropped[0].postData())),
      orderedAssetIds: JSON.stringify([c, a, b, d]),
      selectedAssetIds: JSON.stringify([c, a]) }).toString(),
  });
  const reviewed = await other.json();
  expect(reviewed.planToken).not.toBe(new URLSearchParams(control.dropped[0].postData()).get('planToken'));
  const applied = await page.request.post(`${baseURL}${f.url}/auto-rename/apply`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    data: new URLSearchParams({
      _csrf: new URLSearchParams(control.dropped[0].postData()).get('_csrf'),
      planToken: reviewed.planToken,
      attemptId: reviewed.attemptId,
    }).toString(),
  });
  expect((await applied.json()).outcome).toBe('committed');
  expect(f.row(c).filename).toBe(f.generated(1, 'png'));

  await dialog(page).getByRole('button', { name: 'Check again' }).click();
  await expect(dialogError(page)).toContainText('new names; that alone does not show this Auto Rename renamed them');
  await expect(dialogError(page)).not.toContainText('Renamed');
  await expect(feedback(page)).toBeHidden();
  await expect(applyButton(page)).toBeDisabled();
  await expect(noticeCheck(page)).toBeVisible();

  // The original finally arrives: refused as stale, and that receipt settles it.
  const late = await deliver(page, control.dropped[0]);
  expect(late.body).toMatchObject({ outcome: 'refused' });
  await dialog(page).getByRole('button', { name: 'Check again' }).click();
  await expect(dialogError(page)).toContainText('The rename preview is no longer current.');
  await expect(dialogError(page)).toContainText('It was not sent again.');
  await expect(notice(page)).toBeHidden();
  expect(applyPosts(control)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('F1C: a malformed Apply answer is never retried and is settled only by the receipt', async ({ page }) => {
  const failing = await createProject('Uncertain F1C failing');
  const { control, errors } = await open(page, `${failing.url}?category=${failing.categoryId}&extension=png`);
  await filteredReview(page, failing);
  await preview(page);
  faults.phase2 = true;
  faults.compensation = true;
  control.apply = 'malformed';
  await applyButton(page).click();
  await expect(dialogError(page)).toContainText('could not fully restore the project files');
  await expect(feedback(page)).toBeHidden();
  expect(applyPosts(control)).toHaveLength(1);
  expect(errors).toEqual([]);

  // The same unreadable answer for an Apply that committed reports the real counts.
  faults.phase2 = false;
  faults.compensation = false;
  const committed = await createProject('Uncertain F1C committed');
  const second = await open(page, `${committed.url}?category=${committed.categoryId}&extension=png`);
  const { a, c } = await filteredReview(page, committed);
  await preview(page);
  second.control.apply = 'malformed';
  await applyButton(page).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(feedback(page)).toHaveText('Auto Rename was applied. Renamed 2 assets. Skipped 0 unchanged assets.');
  expect(committed.row(c).filename).toBe(committed.generated(1, 'png'));
  expect(committed.row(a).filename).toBe(committed.generated(2, 'png'));
  expect(applyPosts(second.control)).toHaveLength(1);
  expect(second.errors).toEqual([]);
});

test('F2A: a delayed original Apply keeps the project held across dismissal and a fresh review until it settles', async ({ page }) => {
  const f = await createProject('Uncertain F2A');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&extension=png`);
  const startUrl = page.url();
  const { a, b, c, d } = await filteredReview(page, f);
  await preview(page);
  control.apply = 'drop';
  await applyButton(page).click();
  // The early read sees the original names; it unlocks nothing.
  await expect(dialogError(page)).toContainText('original names; that alone does not show whether files on disk changed');
  expect(f.row(c).filename).toBe('c-shot.png');
  await cancelButton(page).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(autoRename(page)).toBeFocused();
  await expect(notice(page)).toBeVisible();
  await expect(notice(page)).toContainText('stays unavailable for this project');

  await expectBlockedReview(page, control);
  expect(applyPosts(control)).toHaveLength(1);
  expect(page.url()).toBe(startUrl);

  // A read taken now answers only after the original has run.
  control.state = 'stale';
  await noticeCheck(page).click();
  await expect.poll(() => control.stale.length).toBe(1);

  const late = await deliver(page, control.dropped[0]);
  expect(late).toMatchObject({ status: 200, body: { outcome: 'committed', renamed: 2 } });
  control.state = 'pass';
  await noticeCheck(page).click();
  await expect(feedback(page)).toHaveText('Auto Rename was applied. Renamed 2 assets. Skipped 0 unchanged assets.');
  await expect(notice(page)).toBeHidden();
  // The stale read arrives last and changes nothing.
  control.stale.shift()();
  await page.waitForTimeout(100);
  await expect(feedback(page)).toHaveText('Auto Rename was applied. Renamed 2 assets. Skipped 0 unchanged assets.');
  await expect(notice(page)).toBeHidden();
  expect(f.row(c).filename).toBe(f.generated(1, 'png'));
  expect(f.row(a).filename).toBe(f.generated(2, 'png'));
  expect(f.files()).toEqual(expect.arrayContaining([f.generated(1, 'png'), f.generated(2, 'png'), 'b-shot.jpg', 'd-shot.jpg']));
  expect(f.files().some((name) => name.includes('__creatorcrate_auto_rename_'))).toBe(false);

  // Released: a fresh review is no longer held.
  await preview(page);
  await expect(dialogError(page)).not.toContainText('not settled');
  await cancelButton(page).click();
  expect(applyPosts(control)).toHaveLength(1);
  expect(await orderValue(page)).toEqual([c, b, a, d]);
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('F2B: a failed reconciliation read keeps the operation and Apply held; Check again only reads', async ({ page }) => {
  const f = await createProject('Uncertain F2B');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&extension=png`);
  const { a, b, c, d } = await filteredReview(page, f);
  await preview(page);
  control.apply = 'drop';
  control.state = 'fail';
  await applyButton(page).click();
  await expect(dialogError(page)).toContainText('Could not check whether Auto Rename was applied.');
  await cancelButton(page).click();
  await expect(autoRename(page)).toBeFocused();

  await expectBlockedReview(page, control);
  await noticeCheck(page).click();
  await expect.poll(() => control.states.length).toBe(2);
  await expect(notice(page)).toContainText('Could not check whether Auto Rename was applied.');
  await expect(noticeCheck(page)).toBeVisible();
  expect(control.states.every((request) => request.method() === 'GET')).toBe(true);
  await expectBlockedReview(page, control);
  expect(applyPosts(control)).toHaveLength(1);
  expect(control.posts.filter((post) => !post.endsWith('/auto-rename/preview'))).toEqual([`/projects/${f.id}/assets/auto-rename/apply`]);
  expect(f.row(a).filename).toBe('a-shot.png');
  expect(await orderValue(page)).toEqual([c, b, a, d]);
  await expect(box(page, a)).toBeChecked();
  await expect(box(page, c)).toBeChecked();
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('F2C: rapid reviews, one lost Apply and a late result never duplicate the Apply', async ({ page }) => {
  const f = await createProject('Uncertain F2C');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&extension=png`);
  const { a, c } = await filteredReview(page, f);
  await preview(page);
  await cancelButton(page).click();
  await preview(page);
  await cancelButton(page).click();
  await preview(page);
  control.apply = 'drop';
  await applyButton(page).dblclick();
  await expect(dialogError(page)).toContainText('The server has no result for this Auto Rename yet');
  await cancelButton(page).click();
  await expectBlockedReview(page, control);
  await expectBlockedReview(page, control);
  expect(control.dropped).toHaveLength(1);

  const late = await deliver(page, control.dropped[0]);
  expect(late.body).toMatchObject({ outcome: 'committed' });
  await noticeCheck(page).click();
  await expect(feedback(page)).toHaveText('Auto Rename was applied. Renamed 2 assets. Skipped 0 unchanged assets.');
  await expect(notice(page)).toBeHidden();
  expect(applyPosts(control)).toHaveLength(1);
  expect(control.posts.filter((post) => post.endsWith('/auto-rename/preview'))).toHaveLength(5);
  expect(f.row(c).filename).toBe(f.generated(1, 'png'));
  expect(f.row(a).filename).toBe(f.generated(2, 'png'));
  expect(errors).toEqual([]);
});

// Two reviews of one unchanged filtered selection sign the same plan; each
// Apply is still its own attempt.
function expectIdenticalPlans(control) {
  const [first, second] = [applyFields(control, 0), applyFields(control, 1)];
  expect(second.get('planToken')).toBe(first.get('planToken'));
  expect(first.get('attemptId')).toMatch(/^[0-9a-f]{32}$/);
  expect(second.get('attemptId')).toMatch(/^[0-9a-f]{32}$/);
  expect(second.get('attemptId')).not.toBe(first.get('attemptId'));
  return { attemptA: first.get('attemptId'), attemptB: second.get('attemptId') };
}

// Holds a genuine project operation on the service's coordinator.
function holdProject(projectId) {
  let release;
  const held = coordinator.runAsync(projectId, () => new Promise((resolve) => { release = resolve; }));
  return async () => { release(); await held; };
}

async function restoredAttempt(page) {
  await preview(page);
  faults.phase2 = true;
  await applyButton(page).click();
  await expect(dialogError(page)).toContainText('Auto Rename failed. No files were renamed.');
  faults.phase2 = false;
  await cancelButton(page).click();
  await expect(dialog(page)).toHaveCount(0);
}

test('F: an earlier restored attempt of the same plan never reports a later recovery-required one as not applied', async ({ page }) => {
  const f = await createProject('Attempt F');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&extension=png`);
  const { a, b, c, d } = await filteredReview(page, f);
  const originalFiles = f.files();
  await restoredAttempt(page);
  expect(f.files()).toEqual(originalFiles);

  await preview(page);
  await expect(applyButton(page)).toBeEnabled();
  faults.phase2 = true;
  faults.compensation = true;
  control.apply = 'lose';
  await applyButton(page).click();
  await expect(dialogError(page)).toContainText('Auto Rename could not fully restore the project files.');
  const text = await dialogError(page).textContent();
  expect(text).not.toMatch(/No files were renamed|was not applied|It was not sent again\. Choose/);
  const { attemptB } = expectIdenticalPlans(control);
  expect(stateAttempts(control)).toEqual([attemptB]);
  await expect(notice(page)).toHaveClass(/notice--error/);

  // The real partial state behind the report.
  const files = f.files();
  expect(files).toContain(f.generated(1, 'png'));
  expect(files).not.toContain('c-shot.png');
  expect(files.some((name) => name.includes('__creatorcrate_auto_rename_'))).toBe(true);
  expect(f.row(c).filename).toBe('c-shot.png');
  expect(f.row(a).filename).toBe('a-shot.png');

  await cancelButton(page).click();
  faults.phase2 = false;
  faults.compensation = false;
  await expectBlockedReview(page, control);
  expect(applyPosts(control)).toHaveLength(2);
  expect(await orderValue(page)).toEqual([c, b, a, d]);
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('G: an earlier refused attempt never unlocks a later Apply that has not run yet', async ({ page }) => {
  const f = await createProject('Attempt G');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&extension=png`);
  const { a, b, c, d } = await filteredReview(page, f);
  await preview(page);
  const release = holdProject(f.id);
  await applyButton(page).click();
  await expect(dialogError(page)).toContainText('Another project operation is already in progress.');
  await release();
  await cancelButton(page).click();
  await expect(dialog(page)).toHaveCount(0);

  // B: the identical plan; its POST is held in the network.
  await preview(page);
  control.apply = 'drop';
  await applyButton(page).click();
  await expect(dialogError(page)).toContainText('The server has no result for this Auto Rename yet');
  const { attemptA, attemptB } = expectIdenticalPlans(control);
  expect(stateAttempts(control)).toEqual([attemptB]);
  await cancelButton(page).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(notice(page)).toContainText('stays unavailable for this project');

  await expectBlockedReview(page, control);
  await noticeCheck(page).click();
  await expect.poll(() => control.states.length).toBe(2);
  await expect(notice(page)).toContainText('The server has no result for this Auto Rename yet');
  await expectBlockedReview(page, control);
  expect(applyPosts(control)).toHaveLength(2);
  expect(control.states.every((request) => request.method() === 'GET')).toBe(true);
  expect(f.row(c).filename).toBe('c-shot.png');

  // B finally arrives and commits; only B's receipt settles B.
  const late = await deliver(page, control.dropped[0]);
  expect(late).toMatchObject({ status: 200, body: { outcome: 'committed', renamed: 2, attemptId: attemptB } });
  await noticeCheck(page).click();
  await expect(feedback(page)).toHaveText('Auto Rename was applied. Renamed 2 assets. Skipped 0 unchanged assets.');
  await expect(notice(page)).toBeHidden();
  expect(stateAttempts(control)).toEqual([attemptB, attemptB, attemptB]);
  expect(stateAttempts(control)).not.toContain(attemptA);
  expect(f.row(c).filename).toBe(f.generated(1, 'png'));
  expect(f.row(a).filename).toBe(f.generated(2, 'png'));
  expect(applyPosts(control)).toHaveLength(2);
  expect(await orderValue(page)).toEqual([c, b, a, d]);
  expect(await sameDocument(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('H: an unreadable answer of a second identical plan is reconciled from that attempt alone', async ({ page }) => {
  const f = await createProject('Attempt H');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&extension=png`);
  const { a, c } = await filteredReview(page, f);
  await restoredAttempt(page);

  await preview(page);
  control.apply = 'malformed';
  await applyButton(page).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(feedback(page)).toHaveText('Auto Rename was applied. Renamed 2 assets. Skipped 0 unchanged assets.');
  const { attemptB } = expectIdenticalPlans(control);
  expect(stateAttempts(control)).toEqual([attemptB]);
  expect(applyPosts(control)).toHaveLength(2);
  expect(f.row(c).filename).toBe(f.generated(1, 'png'));
  expect(f.row(a).filename).toBe(f.generated(2, 'png'));
  await expect(notice(page)).toBeHidden();
  expect(errors).toEqual([]);
});

test('I: the attempt survives dismissal, failed and out-of-order reads and reopening; no other project is held', async ({ page }) => {
  const f = await createProject('Attempt I');
  const other = await createProject('Attempt I other');
  const { control, errors } = await open(page, `${f.url}?category=${f.categoryId}&extension=png`);
  const { a, b, c, d } = await filteredReview(page, f);
  await restoredAttempt(page);

  await preview(page);
  control.apply = 'drop';
  control.state = 'fail';
  await applyButton(page).click();
  await expect(dialogError(page)).toContainText('Could not check whether Auto Rename was applied.');
  const { attemptB } = expectIdenticalPlans(control);
  await cancelButton(page).click();
  await expectBlockedReview(page, control);

  // A read taken now answers only after B has run.
  control.state = 'stale';
  await noticeCheck(page).click();
  await expect.poll(() => control.stale.length).toBe(1);
  const late = await deliver(page, control.dropped[0]);
  expect(late.body).toMatchObject({ outcome: 'committed', attemptId: attemptB });
  control.state = 'pass';
  await noticeCheck(page).click();
  await expect(feedback(page)).toHaveText('Auto Rename was applied. Renamed 2 assets. Skipped 0 unchanged assets.');
  control.stale.shift()();
  await page.waitForTimeout(100);
  await expect(feedback(page)).toHaveText('Auto Rename was applied. Renamed 2 assets. Skipped 0 unchanged assets.');
  await expect(notice(page)).toBeHidden();
  expect(stateAttempts(control)).toEqual([attemptB, attemptB, attemptB]);
  expect(applyPosts(control)).toHaveLength(2);
  expect(f.row(c).filename).toBe(f.generated(1, 'png'));
  expect(f.row(a).filename).toBe(f.generated(2, 'png'));
  expect(await orderValue(page)).toEqual([c, b, a, d]);
  expect(await sameDocument(page)).toBe(true);

  // Another project's page was never held.
  const otherPage = await page.context().newPage();
  const second = await open(otherPage, `${other.url}?category=${other.categoryId}&extension=png`);
  await filteredReview(otherPage, other);
  await preview(otherPage);
  await expect(applyButton(otherPage)).toBeEnabled();
  await cancelButton(otherPage).click();
  expect(applyPosts(second.control)).toHaveLength(0);
  await otherPage.close();
  expect(errors).toEqual([]);
  expect(second.errors).toEqual([]);
});
