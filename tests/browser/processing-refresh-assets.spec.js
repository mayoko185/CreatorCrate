import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { build } from 'vite';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { createProcessingJobService } from '../../src/services/processing-job-service.js';
import { createProjectOperationCoordinator } from '../../src/services/project-operation-coordinator.js';
import { createPngChunk } from '../../src/services/workflow-prompt-editor.js';

// WP12B: a Processing result's Refresh assets re-reads Project Assets through
// the WP09A GET-only refresh. It never reloads the document, repeats Apply,
// submits a job or scans. Every Apply runs through the real routes and job
// service into a recording executor, so no file is processed; all data lives
// in a temporary root removed afterward.

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const FILES = ['01-draft.png', '02-ref.png', '03-draft.png', '04-ref.png', '05-draft.png'];

let buildRoot;
let viteDistRoot;
let assetManifest;

test.beforeAll(async () => {
  buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-wp12b-build-'));
  viteDistRoot = path.join(buildRoot, 'client');
  await build({ build: { outDir: viteDistRoot }, logLevel: 'silent' });
  assetManifest = createAssetManifest({
    distRoot: viteDistRoot,
    manifestPath: path.join(viteDistRoot, '.vite', 'manifest.json'),
  });
});

test.afterAll(() => {
  if (buildRoot) fs.rmSync(buildRoot, { recursive: true, force: true });
});

function requestPath(request) {
  return new URL(request.url()).pathname;
}

function withPngTextChunk(png, key, value) {
  const chunk = createPngChunk('tEXt', Buffer.concat([
    Buffer.from(key, 'latin1'),
    Buffer.from([0]),
    Buffer.from(value, 'utf8'),
  ]));
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
}

async function png(shade, alpha = 1) {
  return sharp({
    create: { width: 12, height: 12, channels: 4, background: { r: shade, g: 90, b: 160, alpha } },
  }).png().toBuffer();
}

async function createFixture(page) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-wp12b-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  const projectOperationCoordinator = createProjectOperationCoordinator();
  const processingJobService = createProcessingJobService({ projectOperationCoordinator });
  const executions = [];
  const record = (operation, result) => async (projectId, assetIds, options, updateProgress) => {
    executions.push({ operation, assetIds });
    updateProgress?.({ completed: assetIds.length, total: assetIds.length });
    return result(assetIds, options);
  };
  let server;

  try {
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
      appDataRoot,
      assetManifest,
      useViteAssets: true,
      viteDistRoot,
      authState: { csrfPepper },
      projectOperationCoordinator,
      processingJobService,
      alreadyCoordinatedProcessingExecutor: {
        renameAssets: record('rename', (assetIds, options) => ({
          requestedCount: assetIds.length, changedCount: options.renames.length,
        })),
        convertAssets: record('convert', (assetIds) => ({
          convertedCount: assetIds.length, requestedCount: assetIds.length, format: 'webp',
        })),
        editWorkflowPrompts: record('workflow-prompt', (assetIds) => ({
          changedCount: assetIds.length, unchangedCount: 0, noWorkflowAssetIds: [], noChangeAssetIds: [],
        })),
        watermarkAssets: record('watermark', (assetIds) => ({
          generatedCount: assetIds.length, requestedCount: assetIds.length, deletedSourceAssetIds: [],
        })),
        createArchives: record('archive', (assetIds) => ({
          sourceCount: assetIds.length,
          artifacts: [{
            relativePath: 'wip/wp12b-set.zip', containerFormat: 'zip', entryCount: assetIds.length, quality: 90,
          }],
        })),
      },
    });
    const project = app.locals.projectService.create({ title: 'WP12B Refresh Assets', status: 'tbd' });
    const categories = app.locals.projectAssetCategoryService;
    if (!categories.list(project.id).some((candidate) => candidate.directory_slug === 'wip')) {
      categories.add(project.id, { displayName: 'WIP', directorySlug: 'wip' });
    }
    const category = categories.list(project.id).find((candidate) => candidate.directory_slug === 'wip');
    const categoryDir = path.join(projectsRoot, project.project_dir, 'wip');
    fs.mkdirSync(categoryDir, { recursive: true });
    for (const [index, filename] of FILES.entries()) {
      const bytes = await png(index * 40);
      fs.writeFileSync(path.join(categoryDir, filename), filename.includes('draft')
        ? withPngTextChunk(bytes, 'parameters', 'sunset portrait\nNegative prompt: blurry\nSteps: 20')
        : bytes);
    }
    app.locals.assetScanner.scanProjectAssets(project.id);
    // Global Watermarks are source-backed: one PNG in the disposable root.
    fs.mkdirSync(path.join(projectsRoot, 'watermarks'), { recursive: true });
    fs.writeFileSync(path.join(projectsRoot, 'watermarks', 'wp12b-mark.png'), await png(250, 0.6));
    await app.locals.watermarkService.scanWatermarks();
    const [watermark] = app.locals.watermarkService.listWatermarks();
    app.locals.processingPresetService.createPreset({
      operationType: 'workflow-prompt',
      displayName: 'WP12B Workflow',
      config: { positive: [{ type: 'append', text: ', wp12b' }], negative: [{ type: 'remove', text: 'blurry' }] },
    });
    const id = (filename) => db.prepare('SELECT id FROM assets WHERE project_id = ? AND filename = ?')
      .get(project.id, filename).id;

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const baseURL = `http://127.0.0.1:${server.address().port}`;

    // Real request counts. The region GET can fail or be held on demand.
    const control = { mode: 'pass', held: [] };
    const requests = [];
    const navigations = [];
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations.push(request.url());
      requests.push({ method: request.method(), path: requestPath(request), type: request.resourceType() });
    });
    await page.route((target) => /^\/projects\/\d+\/assets$/.test(target.pathname), async (route) => {
      if (route.request().resourceType() !== 'fetch') return route.fallback();
      if (control.mode === 'fail') return route.fulfill({ status: 500, contentType: 'text/html', body: 'failed' });
      if (control.mode === 'hold') {
        control.held.push(route);
        return undefined;
      }
      return route.continue();
    });

    return {
      app,
      baseURL,
      category,
      control,
      errors,
      executions,
      navigations,
      project,
      requests,
      watermark,
      id,
      url: `/projects/${project.id}/assets`,
      count(method, matcher) {
        return requests.filter((entry) => entry.method === method
          && (typeof matcher === 'string' ? entry.path === matcher : matcher.test(entry.path))).length;
      },
      // Mutating counts: any Processing Apply or Preview, job, or scan.
      mutations() {
        return {
          plans: this.count('POST', /\/assets\/processing\/[^/]+\/plan$/),
          applies: this.count('POST', /\/assets\/processing\/[^/]+\/apply$/),
          scans: this.count('POST', `/projects/${project.id}/scan`),
          jobPolls: this.count('GET', /^\/processing\/jobs\//),
          otherPosts: requests.filter((entry) => entry.method !== 'GET'
            && !/\/assets\/processing\/[^/]+\/(plan|apply)$/.test(entry.path)
            && entry.path !== `/projects/${project.id}/scan`).length,
          executions: executions.length,
        };
      },
      regionGets() {
        return requests.filter((entry) => entry.method === 'GET' && entry.type === 'fetch'
          && entry.path === `/projects/${project.id}/assets`).length;
      },
      // An out-of-band change only a new Project Assets read can show:
      // the same asset identity under a new name, still matching search=draft.
      renameRowOutOfBand(from, to) {
        db.prepare('UPDATE assets SET filename = ?, relative_path = ? WHERE id = ?').run(to, `wip/${to}`, id(from));
      },
      archiveProject() {
        app.locals.projectService.archive(project.id);
      },
      async close() {
        if (server) {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
          server = null;
        }
        closeDatabase(db);
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

const region = (page) => page.locator('[data-project-assets-live-region]');
const surface = (page) => page.locator('[data-auto-rename-surface]');
const item = (page, name) => surface(page).locator(`[data-auto-rename-asset][aria-label="Reorder ${name}"]`);
const box = (page, id) => page.locator(`input[name="selectedAssetIds"][value="${id}"]`);
const orderValue = async (page) => JSON.parse(await page.locator('[data-auto-rename-order-input]').inputValue());

async function openAssets(page, fixture, query) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${fixture.baseURL}${fixture.url}?${query}`, { waitUntil: 'domcontentloaded' });
  await expect(region(page)).toBeVisible();
  // A document reload drops this marker.
  await page.evaluate(() => { window.__wp12bDocument = 'mounted'; });
}

const documentMounted = (page) => page.evaluate(() => window.__wp12bDocument === 'mounted');

async function select(page, id) {
  await page.locator(`label[for$="-select-${id}"]`).click();
  await expect(box(page, id)).toBeChecked();
}

// Moves one rendered asset with the keyboard, leaving an unsaved order draft.
async function moveBefore(page, name) {
  await item(page, name).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
}

async function chooseNativeSelect(select, value) {
  await select.evaluate((select, next) => {
    select.value = next;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, String(value));
}

const OPERATIONS = {
  rename: {
    dialogId: 'processing-rename-dialog',
    trigger: 'Rename',
    applyLabel: 'Save',
    async configure(dialog) {
      const inputs = dialog.locator('[data-processing-rename-basename]');
      await inputs.nth(0).fill('first-renamed');
      await inputs.nth(1).fill('second-renamed');
    },
    summary: /Renamed 2 of 2 files\./,
    settled: 'Applied. Assets refreshed.',
  },
  convert: {
    dialogId: 'processing-convert-dialog',
    trigger: 'Convert',
    summary: /Converted 2 of 2 assets to WEBP\./,
    settled: 'Applied. Assets refreshed.',
  },
  'workflow-prompt': {
    dialogId: 'processing-workflow-dialog',
    trigger: 'Image workflows editor',
    async configure(dialog) {
      await dialog.locator('[data-processing-scope-option="selected"]').check();
      const dropdown = dialog.locator('#workflow-preset-select-dropdown');
      await dropdown.locator('summary').click();
      const option = dropdown.getByRole('radio', { name: 'WP12B Workflow', exact: true });
      await dropdown.locator(`label[for="${await option.getAttribute('id')}"]`).click();
      await expect(dialog.locator('[data-processing-preset-select]')).toHaveValue(/\d+/);
    },
    summary: /Changed: 2/,
    settled: 'Applied.',
  },
  watermark: {
    dialogId: 'processing-watermark-dialog',
    trigger: 'Watermark',
    async configure(dialog, fixture) {
      await dialog.locator('[data-processing-scope-option="selected"]').check();
      const select = dialog.locator('select[data-processing-field="watermarkId"]');
      await expect(select.locator(`option[value="${fixture.watermark.id}"]`)).toBeAttached();
      await chooseNativeSelect(select, fixture.watermark.id);
      const output = dialog.locator('select[data-processing-field="outputCategorySlug"]');
      await expect(output.locator('option[value="wip"]')).toBeAttached();
      await chooseNativeSelect(output, 'wip');
    },
    summary: /Watermarked 2 of 2 assets\./,
    settled: 'Applied. Assets refreshed.',
  },
  archive: {
    dialogId: 'processing-archive-dialog',
    trigger: 'Archives',
    async configure(dialog) {
      await dialog.locator('[data-processing-scope-option="selected"]').check();
    },
    summary: /Generated 1 archive artifact from 2 source assets\./,
    output: 'wp12b-set.zip',
    settled: 'Applied.',
  },
};

async function previewAndApply(page, fixture, operation) {
  const spec = OPERATIONS[operation];
  const dialog = page.locator(`#${spec.dialogId}`);
  await page.getByRole('button', { name: spec.trigger, exact: true }).first().click();
  await expect(dialog).toBeVisible();
  await spec.configure?.(dialog, fixture);
  const planPath = `/projects/${fixture.project.id}/assets/processing/${operation}/plan`;
  const applyPath = `/projects/${fixture.project.id}/assets/processing/${operation}/apply`;
  const plan = page.waitForResponse((response) => response.request().method() === 'POST'
    && requestPath(response.request()) === planPath);
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  expect((await plan).status()).toBe(200);
  const applyButton = dialog.getByRole('button', { name: spec.applyLabel || 'Apply', exact: true });
  await expect(applyButton).toBeEnabled();
  const apply = page.waitForResponse((response) => response.request().method() === 'POST'
    && requestPath(response.request()) === applyPath);
  await applyButton.click();
  expect((await apply).status()).toBe(202);
  await expect(dialog.locator('[data-processing-result-body]')).toContainText(spec.summary, { timeout: 10_000 });
  await expect(dialog.locator('[data-processing-status]')).toHaveText(spec.settled, { timeout: 10_000 });
  return dialog;
}

// The dialog's own state: its result, settings and status.
function dialogSnapshot(dialog) {
  return dialog.evaluate((node) => ({
    open: node.open,
    result: node.querySelector('[data-processing-result-body]').innerHTML,
    resultHidden: node.querySelector('[data-processing-result]').hidden,
    status: node.querySelector('[data-processing-status]').textContent,
    fields: Array.from(node.querySelectorAll('input, select, textarea'))
      .filter((field) => field.name || field.dataset.processingRenameBasename !== undefined)
      .map((field) => [field.name || field.dataset.assetId, field.type === 'checkbox' || field.type === 'radio'
        ? field.checked : field.value]),
  }));
}

function viewSnapshot(page) {
  return page.evaluate(() => ({
    url: `${location.pathname}${location.search}`,
    search: document.querySelector('#search')?.value ?? null,
    category: document.querySelector('#asset-category-filter input:checked')?.value ?? null,
    gridStyle: document.querySelector('[data-project-assets-live-region] .asset-grid')?.getAttribute('data-grid-style') ?? null,
    view: document.querySelector('[data-project-assets-live-region] [aria-current="true"][data-view], [data-project-assets-live-region] .view-switcher [aria-pressed="true"]')?.textContent?.trim() ?? null,
  }));
}

test('negative control: Convert Refresh assets keeps the document mounted and only reads', async ({ page }) => {
  const fixture = await createFixture(page);
  try {
    await openAssets(page, fixture, `category=${fixture.category.id}&search=draft`);
    await select(page, fixture.id('01-draft.png'));
    await select(page, fixture.id('03-draft.png'));
    const dialog = await previewAndApply(page, fixture, 'convert');

    const navigationsBefore = fixture.navigations.length;
    const mutationsBefore = fixture.mutations();
    const getsBefore = fixture.regionGets();
    await dialog.getByRole('button', { name: 'Refresh assets', exact: true }).click();
    await expect(dialog.locator('[data-processing-refresh-status]')).toHaveText('Assets refreshed.');
    expect({
      mounted: await documentMounted(page),
      navigations: fixture.navigations.length - navigationsBefore,
      gets: fixture.regionGets() - getsBefore,
      mutations: fixture.mutations(),
    }).toEqual({ mounted: true, navigations: 0, gets: 1, mutations: mutationsBefore });
  } finally {
    await fixture.close();
  }
});

for (const operation of Object.keys(OPERATIONS)) {
  test(`${operation}: Refresh assets installs current assets and keeps the dialog, result and page state`, async ({ page }) => {
    const fixture = await createFixture(page);
    try {
      await openAssets(page, fixture, `category=${fixture.category.id}&search=draft`);
      const first = fixture.id('01-draft.png');
      const third = fixture.id('03-draft.png');
      const fifth = fixture.id('05-draft.png');
      await select(page, first);
      await select(page, third);
      await moveBefore(page, '03-draft.png');
      const draft = await orderValue(page);
      expect(draft).toEqual([third, fixture.id('02-ref.png'), first, fixture.id('04-ref.png'), fifth]
        .filter((id) => draft.includes(id)));

      const dialog = await previewAndApply(page, fixture, operation);
      // The established automatic scan: exactly one for Rename/Convert/Watermark, none otherwise.
      const expectedScans = ['rename', 'convert', 'watermark'].includes(operation) ? 1 : 0;
      expect(fixture.mutations()).toMatchObject({ plans: 1, applies: 1, scans: expectedScans, executions: 1 });
      await expect(dialog.locator('[data-processing-refresh-status]')).toBeHidden();

      const dialogBefore = await dialogSnapshot(dialog);
      const viewBefore = await viewSnapshot(page);
      const mutationsBefore = fixture.mutations();
      const getsBefore = fixture.regionGets();
      const navigationsBefore = fixture.navigations.length;
      await region(page).evaluate((node) => { node.dataset.beforeRefresh = 'true'; });
      fixture.renameRowOutOfBand('05-draft.png', '05-draft-current.png');

      // Pending: the GET is held, so nothing may report refreshed yet.
      fixture.control.mode = 'hold';
      const refresh = dialog.getByRole('button', { name: 'Refresh assets', exact: true });
      await refresh.evaluate((button) => { button.click(); button.click(); button.click(); });
      await expect.poll(() => fixture.control.held.length).toBe(1);
      await expect(dialog.locator('[data-processing-refresh-status]')).toHaveText('Refreshing assets…');
      await expect(refresh).toBeDisabled();
      await expect(refresh).toHaveAttribute('aria-busy', 'true');
      await refresh.evaluate((button) => button.click());
      expect(fixture.control.held).toHaveLength(1);

      fixture.control.mode = 'pass';
      await fixture.control.held.shift().continue();
      await expect(dialog.locator('[data-processing-refresh-status]')).toHaveText('Assets refreshed.');
      await expect(page.locator('[data-project-assets-live-region]:not([data-before-refresh])')).toHaveCount(1);
      await expect(refresh).toBeEnabled();

      // A: no reload. B/C: the same dialog, result and settings. D: current data.
      expect(await documentMounted(page)).toBe(true);
      expect(fixture.navigations.length - navigationsBefore).toBe(0);
      expect(await dialogSnapshot(dialog)).toEqual(dialogBefore);
      if (OPERATIONS[operation].output) {
        await expect(dialog.locator('[data-processing-result-body]')).toContainText(OPERATIONS[operation].output);
      }
      await expect(item(page, '05-draft-current.png')).toHaveCount(1);
      await expect(item(page, '05-draft.png')).toHaveCount(0);
      // E: selection, order draft and filters survive.
      await expect(box(page, first)).toBeChecked();
      await expect(box(page, third)).toBeChecked();
      await expect(box(page, fifth)).not.toBeChecked();
      expect(await orderValue(page)).toEqual(draft);
      await expect(surface(page)).toHaveAttribute('data-auto-rename-draft', 'true');
      expect(await viewSnapshot(page)).toEqual(viewBefore);
      // G/H/J: one GET; no Apply, Preview, job, scan or other write.
      expect(fixture.regionGets() - getsBefore).toBe(1);
      expect(fixture.mutations()).toEqual(mutationsBefore);
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
}

test('a failed refresh keeps the Archives result and Retry reads with GET only', async ({ page }) => {
  const fixture = await createFixture(page);
  try {
    await openAssets(page, fixture, `category=${fixture.category.id}&search=draft`);
    const first = fixture.id('01-draft.png');
    await select(page, first);
    await select(page, fixture.id('03-draft.png'));
    await moveBefore(page, '03-draft.png');
    const draft = await orderValue(page);
    const dialog = await previewAndApply(page, fixture, 'archive');
    const dialogBefore = await dialogSnapshot(dialog);
    const mutationsBefore = fixture.mutations();
    const getsBefore = fixture.regionGets();
    fixture.renameRowOutOfBand('05-draft.png', '05-draft-current.png');

    fixture.control.mode = 'fail';
    await dialog.getByRole('button', { name: 'Refresh assets', exact: true }).click();
    await expect(dialog.locator('[data-processing-refresh-status]'))
      .toHaveText('Assets could not be refreshed. This result is unchanged. Use Retry to try again.');
    await expect(dialog.locator('[data-processing-refresh-status]')).toHaveAttribute('data-state', 'failed');
    // F: the result offers its own Retry inside the open modal dialog.
    const retry = dialog.locator('[data-processing-refresh]');
    await expect(retry).toHaveText('Retry');
    await expect(retry).toBeEnabled();
    expect(await dialogSnapshot(dialog)).toEqual(dialogBefore);
    await expect(dialog.locator('[data-processing-result-body]')).toContainText('wp12b-set.zip');
    await expect(item(page, '05-draft.png')).toHaveCount(1);
    await expect(box(page, first)).toBeChecked();
    expect(await orderValue(page)).toEqual(draft);

    fixture.control.mode = 'pass';
    await retry.click();
    await expect(dialog.locator('[data-processing-refresh-status]')).toHaveText('Assets refreshed.');
    await expect(retry).toHaveText('Refresh assets');
    await expect(page.locator('[data-live-filter-failure]')).toHaveCount(0);
    await expect(item(page, '05-draft-current.png')).toHaveCount(1);
    await expect(box(page, first)).toBeChecked();
    expect(await orderValue(page)).toEqual(draft);
    expect(await dialogSnapshot(dialog)).toEqual(dialogBefore);
    expect(await documentMounted(page)).toBe(true);
    expect(fixture.regionGets() - getsBefore).toBe(2);
    expect(fixture.mutations()).toEqual(mutationsBefore);
  } finally {
    await fixture.close();
  }
});

test('archived eligibility: a refresh after archiving installs the archived controls and keeps the dialog', async ({ page }) => {
  const fixture = await createFixture(page);
  try {
    await openAssets(page, fixture, `category=${fixture.category.id}&search=draft`);
    await select(page, fixture.id('01-draft.png'));
    await select(page, fixture.id('03-draft.png'));
    const dialog = await previewAndApply(page, fixture, 'convert');
    const dialogBefore = await dialogSnapshot(dialog);
    const mutationsBefore = fixture.mutations();
    await expect(region(page).locator('.processing-actions-archived-note')).toHaveCount(0);

    fixture.archiveProject();
    await dialog.getByRole('button', { name: 'Refresh assets', exact: true }).click();
    await expect(dialog.locator('[data-processing-refresh-status]')).toHaveText('Assets refreshed.');
    expect(await dialogSnapshot(dialog)).toEqual(dialogBefore);
    // I: the installed region carries the established archived eligibility.
    await expect(region(page).locator('.processing-actions-archived-note').first()).toBeAttached();
    await expect(region(page).getByRole('button', { name: 'Watermark', exact: true }).first()).toBeDisabled();
    expect(fixture.mutations()).toEqual(mutationsBefore);
    expect(await documentMounted(page)).toBe(true);

    // A freshly loaded archived project offers no Processing dialogs at all.
    await page.goto(`${fixture.baseURL}${fixture.url}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-processing-root]')).toHaveCount(0);
    await expect(page.locator('[data-processing-refresh]')).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});
