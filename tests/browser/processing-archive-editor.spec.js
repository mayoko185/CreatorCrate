import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import yauzl from 'yauzl';
import { createHash } from 'node:crypto';
import { read7zEntryNames } from '../helpers/seven-zip.js';
import { build } from 'vite';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { createProcessingJobService } from '../../src/services/processing-job-service.js';
import { createProjectOperationCoordinator } from '../../src/services/project-operation-coordinator.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
let buildRoot;
let viteDistRoot;
let assetManifest;

test.beforeAll(async () => {
  buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-archive-editor-browser-build-'));
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

async function createFixture(page, { sourceNames = ['source.png'], executeArchive } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-archive-editor-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  const projectOperationCoordinator = createProjectOperationCoordinator();
  const processingJobService = createProcessingJobService({ projectOperationCoordinator });
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
      projectOperationCoordinator, processingJobService,
      alreadyCoordinatedProcessingExecutor: executeArchive ? { createArchives: executeArchive } : undefined,
    });
    const project = app.locals.projectService.create({
      title: 'Archive Editor Browser',
      status: 'tbd',
    });
    const projectDir = path.join(projectsRoot, project.project_dir);
    const originalFiles = new Map();
    for (const name of sourceNames) {
      const sourcePath = path.join(projectDir, 'final', name);
      const bytes = await sharp({
        create: { width: 12, height: 12, channels: 4, background: '#336699' },
      }).png().toBuffer();
      fs.writeFileSync(sourcePath, bytes);
      originalFiles.set(sourcePath, bytes);
    }
    app.locals.assetScanner.scanProjectAssets(project.id);

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${baseURL}/projects/${project.id}/assets?view=list`, { waitUntil: 'domcontentloaded' });

    return {
      project,
      app, db, baseURL, projectDir, originalFiles, processingJobService,
      async close() {
        await processingJobService.waitForIdle();
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

const editor = (page) => page.locator('#processing-archive-dialog');
const entries = (page) => editor(page).locator('[data-archive-entry]');
const field = (entry, name) => entry.locator(`[data-archive-field="${name}"]`);
const formatTrigger = (entry) => entry.locator('[data-cc-dropdown]').first().locator('summary');

async function choose(entry, name, label) {
  const dropdown = field(entry, name).locator('..').locator('[data-cc-dropdown]');
  await dropdown.locator('summary').click();
  const radio = dropdown.getByRole('radio', { name: label, exact: true });
  await dropdown.locator(`label[for="${await radio.getAttribute('id')}"]`).click();
  await expect(dropdown.locator('[data-cc-dropdown-summary-current]')).toHaveText(label);
  if (await dropdown.getAttribute('open') !== null) await dropdown.locator('summary').click();
}

async function openArchive(page) {
  await page.getByRole('button', { name: 'Archives', exact: true }).click();
  await expect(editor(page)).toBeVisible();
  await expect(entries(page)).toHaveCount(1);
}

async function previewArchive(page) {
  const response = page.waitForResponse((response) => /\/processing\/archive\/plan$/.test(response.url()));
  await editor(page).getByRole('button', { name: 'Preview', exact: true }).click();
  const result = await response;
  await expect(editor(page).locator('[data-processing-status]')).not.toHaveText('Loading preview…');
  return { body: result.request().postDataJSON(), payload: await result.json(), status: result.status() };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function zipEntryNames(filename) {
  return new Promise((resolve, reject) => {
    yauzl.open(filename, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const names = [];
      zip.on('error', reject);
      zip.on('entry', (entry) => { names.push(entry.fileName); zip.readEntry(); });
      zip.on('end', () => resolve(names));
      zip.readEntry();
    });
  });
}

test('independent dynamic entries serialize every container and conditional image settings without changing hidden inputs', async ({ page }) => {
  const fixture = await createFixture(page);
  try {
    await openArchive(page);
    const dialog = editor(page);
    await dialog.locator('[data-archive-add]').click();
    await choose(entries(page).nth(1), 'imageFormat', 'WebP');
    await dialog.locator('[data-archive-add]').click();
    await field(entries(page).nth(2), 'setName').fill('removed');
    await dialog.locator('[data-archive-add]').click();
    await entries(page).nth(2).getByRole('button', { name: 'Remove archive 3' }).click();
    await dialog.locator('[data-archive-add]').click();
    const [jpeg, lossy, lossless, png] = [0, 1, 2, 3].map((index) => entries(page).nth(index));
    await field(jpeg, 'jpegQuality').fill('63');
    await choose(lossy, 'archiveFormat', '7Z');
    await field(lossy, 'webpQuality').fill('74');
    await choose(lossless, 'archiveFormat', 'CB7');
    await choose(lossless, 'imageFormat', 'WebP');
    await field(lossless, 'webpQuality').fill('42');
    await field(lossless, 'lossless').check();
    await choose(png, 'archiveFormat', 'CBZ');
    await choose(png, 'imageFormat', 'PNG');
    await field(jpeg, 'setName').fill('Set wins');
    await field(jpeg, 'prefix').fill('ignored-');
    await field(lossy, 'prefix').fill('pre-');
    await dialog.locator('[data-archive-advanced] > summary').click();
    await dialog.locator('[data-archive-replace]').check();
    await dialog.locator('[data-archive-naming]').nth(0).locator('input').fill('ignored-base');
    await dialog.locator('[data-archive-naming]').nth(1).locator('input').fill('independent');
    const { body, payload } = await previewArchive(page);
    expect(body.scope).toEqual({ type: 'project' });
    expect(body.options).toEqual({ archives: [
      { archiveFormat: 'zip', imageFormat: 'jpeg', quality: 63, setName: 'Set wins', prefix: 'ignored-', baseName: 'ignored-base' },
      { archiveFormat: '7z', imageFormat: 'webp', quality: 74, lossless: false, prefix: 'pre-', baseName: 'independent' },
      { archiveFormat: 'cb7', imageFormat: 'webp', lossless: true },
      { archiveFormat: 'cbz', imageFormat: 'png' },
    ], replaceExistingArchives: true });
    expect(payload.plan.archives.map((archive) => archive.filename)).toEqual([
      'Set wins_jpg_q63.zip', 'pre-independent_webp_q74.7z',
      `archive_${fixture.project.slug}_webp_lossless.cb7`, `archive_${fixture.project.slug}_png.cbz`,
    ]);
    await expect(dialog.locator('[data-processing-archive-plan-details]')).toContainText('Archive 3:');
    await expect(dialog.locator('[data-processing-archive-plan-details]')).toContainText('WebP lossless');
    await expect(dialog.locator('[data-processing-archive-plan-details]')).not.toContainText('quality undefined');
    await expect(field(lossless, 'webpQuality')).toHaveValue('42');
    await choose(lossless, 'imageFormat', 'JPEG');
    const changed = await previewArchive(page);
    expect(changed.body.options.archives[2]).toEqual({ archiveFormat: 'cb7', imageFormat: 'jpeg', quality: 80 });
    await expect(field(lossless, 'lossless')).toBeChecked();
    const category = dialog.locator('#archive-category-select-dropdown');
    await category.locator('summary').click();
    await category.locator('label').filter({ hasText: 'Final (1)' }).click();
    const categoryPreview = await previewArchive(page);
    expect(categoryPreview.body.scope).toEqual({ type: 'category', categoryId: Number(await dialog.locator('[data-processing-category-select]').inputValue()) });
    expect(categoryPreview.payload.plan.sourceCount).toBe(1);
  } finally { await fixture.close(); }
});

test('configuration edits, membership and overlapping delayed previews cannot authorize obsolete Apply', async ({ page }) => {
  const fixture = await createFixture(page);
  const old = deferred();
  const received = deferred();
  let requests = 0;
  await page.route('**/processing/archive/plan', async (route) => {
    const response = await route.fetch();
    if (++requests === 1) { received.resolve(); await old.promise; }
    await route.fulfill({ response });
  });
  try {
    await openArchive(page);
    const dialog = editor(page);
    await dialog.locator('[data-archive-add]').click();
    await choose(entries(page).nth(1), 'imageFormat', 'WebP');
    const apply = dialog.getByRole('button', { name: 'Apply', exact: true });
    await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
    await received.promise;
    await field(entries(page).first(), 'setName').fill('Current');
    await previewArchive(page);
    await expect(apply).toBeEnabled();
    old.resolve();
    await expect(dialog.locator('[data-processing-archive-plan-details]')).toContainText('Current_jpg_q80.zip');
    const changes = [
      () => field(entries(page).first(), 'jpegQuality').fill('71'),
      () => field(entries(page).first(), 'prefix').fill('prefix-'),
      () => choose(entries(page).first(), 'archiveFormat', 'CBZ'),
      () => choose(entries(page).first(), 'imageFormat', 'PNG'),
      () => field(entries(page).nth(1), 'lossless').check(),
      () => dialog.locator('[data-archive-add]').click(),
      () => entries(page).last().locator('[data-archive-remove]').click(),
      async () => { await dialog.locator('[data-archive-advanced] > summary').click(); await dialog.locator('[data-archive-replace]').check(); },
      () => dialog.locator('[data-archive-naming]').first().locator('input').fill('base'),
      () => dialog.locator('[data-processing-scope-option="category"]').check(),
    ];
    for (const change of changes) {
      await change();
      await expect(apply).toBeDisabled();
      if (change === changes.at(-1)) break;
      await previewArchive(page);
      await expect(apply).toBeEnabled();
    }
    await dialog.locator('[data-processing-scope-option="project"]').check();
    await previewArchive(page);
    await dialog.locator('[data-processing-root]').evaluate((root) => {
      const checkbox = document.querySelector('.asset-select-checkbox');
      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(apply).toBeDisabled();
    const late = deferred();
    const lateReceived = deferred();
    await page.unrouteAll({ behavior: 'wait' });
    await page.route('**/processing/archive/plan', async (route) => {
      const response = await route.fetch(); lateReceived.resolve(); await late.promise; await route.fulfill({ response });
    });
    await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
    await lateReceived.promise;
    await field(entries(page).first(), 'setName').fill('Changed during request');
    late.resolve();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(apply).toBeDisabled();
    await expect(dialog.locator('[data-processing-plan]')).toBeHidden();
  } finally {
    old.resolve();
    await page.unrouteAll({ behavior: 'wait' });
    await fixture.close();
  }
});

test('invalid quality, names, duplicate destinations, member collisions and preview network errors remain blockers', async ({ page }) => {
  const fixture = await createFixture(page);
  let plans = 0;
  page.on('request', (request) => { if (/\/processing\/archive\/plan$/.test(request.url())) plans += 1; });
  try {
    await openArchive(page);
    const dialog = editor(page);
    for (const value of ['', '1.5', '101']) {
      await field(entries(page).first(), 'jpegQuality').fill(value);
      await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect(dialog.locator('[data-processing-error]')).toContainText('Archive 1: quality');
    }
    expect(plans).toBe(0);
    await field(entries(page).first(), 'jpegQuality').fill('80');
    await field(entries(page).first(), 'setName').fill('bad/name');
    expect((await previewArchive(page)).status).toBe(400);
    await expect(dialog.locator('[data-processing-error]')).toContainText('Archive 1');
    await field(entries(page).first(), 'setName').fill('');
    await dialog.locator('[data-archive-add]').click();
    await previewArchive(page);
    await expect(dialog.locator('[data-processing-archive-plan-details]')).toContainText('Archive 2');
    await expect(dialog.locator('[data-processing-archive-plan-details]')).toContainText('duplicates Archive 1');
    await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
    await entries(page).last().locator('[data-archive-remove]').click();
    await page.route('**/processing/archive/plan', (route) => route.abort());
    await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(dialog.locator('[data-processing-error]')).toContainText('Could not reach the server');
    await page.unrouteAll({ behavior: 'wait' });
    await page.route('**/processing/archive/plan', (route) => route.fulfill({ json: { ok: true, plan: { operation: 'archive' } } }));
    await previewArchive(page);
    await expect(dialog.locator('[data-processing-error]')).toContainText('unexpected response');
    await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
    await page.unrouteAll({ behavior: 'wait' });
    const original = [...fixture.originalFiles.keys()][0];
    fs.copyFileSync(original, path.join(fixture.projectDir, 'final', 'SOURCE.webp'));
    fixture.app.locals.assetScanner.scanProjectAssets(fixture.project.id);
    await page.reload();
    await openArchive(page);
    await previewArchive(page);
    await expect(dialog.locator('[data-processing-archive-plan-details]')).toContainText('Archive 1');
    await expect(dialog.locator('[data-processing-archive-plan-details]')).toContainText('conflicting entry names');
    await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  } finally { await fixture.close(); }
});

test('one mixed batch freezes submission, survives polling interruption and reopening, commits files and records, and refreshes by GET only', async ({ page }) => {
  const fixture = await createFixture(page, { sourceNames: ['z-last.png', 'a-first.png'] });
  const acknowledgement = deferred();
  const accepted = deferred();
  let applyCount = 0;
  let jobId;
  let polls = 0;
  let finishPolling = false;
  let terminalResult;
  const pollInterrupted = deferred();
  await page.route('**/processing/archive/apply', async (route) => {
    applyCount += 1;
    const response = await route.fetch();
    jobId = (await response.json()).jobId;
    accepted.resolve();
    await acknowledgement.promise;
    await route.fulfill({ response });
  });
  await page.route('**/processing/jobs/*', async (route) => {
    polls += 1;
    if (polls === 1) { pollInterrupted.resolve(); return route.abort(); }
    if (!finishPolling) return route.fulfill({ json: { ok: true, job: { id: jobId, state: 'running', progress: { completed: 8, total: 8 } } } });
    const response = await route.fetch();
    terminalResult = (await response.json()).job.result;
    await route.fulfill({ response });
  });
  try {
    for (const checkbox of await page.locator('.asset-select-checkbox').all()) await checkbox.check();
    const ids = await page.locator('.asset-select-checkbox').evaluateAll((nodes) => nodes.map((node) => Number(node.value)));
    await openArchive(page);
    const dialog = editor(page);
    await dialog.locator('[data-archive-add]').click();
    await choose(entries(page).nth(1), 'imageFormat', 'WebP');
    await dialog.locator('[data-archive-add]').click();
    await dialog.locator('[data-archive-add]').click();
    await choose(entries(page).nth(1), 'archiveFormat', '7Z');
    await choose(entries(page).nth(2), 'archiveFormat', 'CBZ');
    await choose(entries(page).nth(2), 'imageFormat', 'PNG');
    await choose(entries(page).nth(3), 'archiveFormat', 'CB7');
    await choose(entries(page).nth(3), 'imageFormat', 'WebP');
    await field(entries(page).nth(3), 'lossless').check();
    const { payload, body } = await previewArchive(page);
    expect(body.scope.assetIds).toEqual(ids);
    const key = await entries(page).first().getAttribute('data-archive-entry');
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await accepted.promise;
    await expect(dialog.locator('[data-archive-add]')).toBeDisabled();
    for (const control of await dialog.locator('[data-archive-field], [data-archive-remove], [data-processing-scope-option], [data-archive-replace]').all()) await expect(control).toBeDisabled();
    await dialog.locator('[data-processing-apply]').evaluate((button) => { button.click(); button.click(); });
    expect(applyCount).toBe(1);
    await expect(dialog.locator('[data-processing-result]')).toBeHidden();
    acknowledgement.resolve();
    await pollInterrupted.promise;
    await expect(dialog.locator('[data-processing-status]')).toHaveText('Could not check processing status. Retrying…');
    await expect(dialog.locator('[data-processing-status]')).toHaveText('Processing… 8 of 8.');
    await expect(dialog.locator('[data-processing-result]')).toBeHidden();
    await dialog.getByRole('button', { name: 'Close Archives', exact: true }).click();
    await page.getByRole('button', { name: 'Archives', exact: true }).click();
    await expect(entries(page)).toHaveCount(4);
    for (const [index, submitted] of body.options.archives.entries()) {
      await expect(field(entries(page).nth(index), 'archiveFormat')).toHaveValue(submitted.archiveFormat);
      await expect(field(entries(page).nth(index), 'imageFormat')).toHaveValue(submitted.imageFormat);
    }
    await expect(entries(page).first()).toHaveAttribute('data-archive-entry', key);
    expect(await dialog.locator('[data-processing-root]').evaluate((root) => root.__ccProcessingJob.id)).toBe(jobId);
    await expect(dialog.locator('[data-archive-add]')).toBeDisabled();
    finishPolling = true;
    await expect(dialog.locator('[data-processing-status]')).toHaveText('Applied.');
    await expect(dialog.locator('[data-processing-error]')).toBeHidden();
    await expect(dialog.locator('[data-processing-result-body] li')).toHaveCount(4);
    await expect(dialog.locator('[data-processing-result-body]')).toContainText('WebP lossless');
    await expect(dialog.locator('[data-archive-add]')).toBeEnabled();
    await expect(field(entries(page).nth(3), 'webpQuality')).toBeDisabled();
    expect(applyCount).toBe(1);
    expect(terminalResult.result.sources.map((source) => source.assetId)).toEqual(ids);
    const rows = fixture.db.prepare('SELECT * FROM generated_artifacts WHERE project_id = ?').all(fixture.project.id);
    expect(rows).toHaveLength(4);
    for (const archive of payload.plan.archives) {
      const filename = path.join(fixture.projectDir, archive.relativePath);
      const bytes = fs.readFileSync(filename);
      const row = rows.find((row) => row.relative_path === archive.relativePath);
      expect(row.generated_by).toBe('archives');
      expect(row.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(archive.containerFormat === '7z' ? await read7zEntryNames(bytes) : await zipEntryNames(filename)).toEqual(archive.entryNames);
      await expect(dialog.locator('[data-processing-result-body]')).toContainText(archive.filename);
    }
    for (const [filename, bytes] of fixture.originalFiles) expect(fs.readFileSync(filename)).toEqual(bytes);
    const resultText = await dialog.locator('[data-processing-result-body]').textContent();
    const mutations = [];
    page.on('request', (request) => { if (request.method() !== 'GET') mutations.push(request.url()); });
    await page.route('**/projects/*/assets?*', (route) => route.abort());
    await dialog.getByRole('button', { name: 'Refresh assets', exact: true }).click();
    await expect(dialog.locator('[data-processing-refresh-status]')).toHaveAttribute('data-state', 'failed');
    await expect(dialog.locator('[data-processing-result-body]')).toHaveText(resultText);
    await page.unroute('**/projects/*/assets?*');
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(dialog.locator('[data-processing-refresh-status]')).toHaveAttribute('data-state', 'installed');
    expect(mutations).toEqual([]);
    await previewArchive(page);
    await expect(dialog.locator('[data-processing-archive-plan-details]')).toContainText('Enable Replace existing archives');
    await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
    await dialog.locator('[data-archive-advanced] > summary').click();
    await dialog.locator('[data-archive-replace]').check();
    await previewArchive(page);
    await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
    const artifactPath = path.join(fixture.projectDir, payload.plan.archives[0].relativePath);
    fs.appendFileSync(artifactPath, 'external change');
    const rejection = page.waitForResponse((response) => /\/processing\/archive\/apply$/.test(response.url()));
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    expect((await rejection).status()).toBe(409);
    await expect(dialog.locator('[data-processing-error]')).toContainText('cannot be safely applied');
    await expect(dialog.locator('[data-archive-add]')).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
    await previewArchive(page);
    await expect(dialog.locator('[data-processing-archive-plan-details]')).toContainText('changed outside CreatorCrate');
    await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Close Archives', exact: true }).click();
    await page.getByRole('button', { name: 'Convert', exact: true }).click();
    const convert = page.locator('#processing-convert-dialog');
    await convert.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(convert.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
    await convert.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(convert.locator('[data-processing-result-body]')).toContainText('Converted 2 of 2');
  } finally {
    acknowledgement.resolve();
    await page.unrouteAll({ behavior: 'wait' });
    await fixture.close();
  }
});

for (const outcome of ['network', 'unreadable']) {
  test(`an accepted Apply with a ${outcome} acknowledgement stays uncertain and cannot resubmit`, async ({ page }) => {
    const fixture = await createFixture(page);
    let applies = 0;
    await page.route('**/processing/archive/apply', async (route) => {
      applies += 1;
      await route.fetch();
      if (outcome === 'network') await route.abort();
      else await route.fulfill({ status: 202, contentType: 'text/html', body: '<html>Unreadable acknowledgement</html>' });
    });
    try {
      await openArchive(page);
      await previewArchive(page);
      const dialog = editor(page);
      await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(dialog.locator('[data-processing-error]')).toContainText('submission outcome is unknown');
      await expect(dialog.locator('[data-archive-add]')).toBeDisabled();
      await expect(dialog.locator('[data-processing-result]')).toBeHidden();
      await dialog.getByRole('button', { name: 'Close Archives', exact: true }).click();
      await page.getByRole('button', { name: 'Archives', exact: true }).click();
      await expect(dialog.locator('[data-processing-apply]')).toBeDisabled();
      await expect(dialog.locator('[data-processing-preview]')).toBeDisabled();
      expect(applies).toBe(1);
    } finally {
      await page.unrouteAll({ behavior: 'wait' });
      await fixture.close();
    }
  });
}

test('job failure and recovery-required outcomes never report archive success or silently resubmit', async ({ page }) => {
  let calls = 0;
  const fixture = await createFixture(page, { executeArchive: async () => {
    calls += 1;
    const error = new Error('Private exception text must not reach the browser');
    if (calls === 2) error.code = 'RECOVERY_REQUIRED';
    throw error;
  } });
  try {
    await openArchive(page);
    const dialog = editor(page);
    for (const expected of ['Processing failed.', 'Manual recovery required.']) {
      await previewArchive(page);
      await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(dialog.locator('[data-processing-error]')).toContainText(expected);
      await expect(dialog.locator('[data-processing-error]')).not.toContainText('Private exception');
      await expect(dialog.locator('[data-processing-result]')).toBeHidden();
      await expect(dialog.locator('[data-processing-apply]')).toBeDisabled();
      await expect(dialog.locator('[data-archive-add]')).toBeEnabled();
    }
    expect(calls).toBe(2);
    await expect(dialog.locator('[data-processing-status]')).toContainText('Manual recovery required');
  } finally { await fixture.close(); }
});

test('Archive editor has two configuration sections, one ZIP/JPEG default and valid control relationships', async ({ page }) => {
  const fixture = await createFixture(page);
  try {
    await openArchive(page);
    const dialog = editor(page);
    const configuration = dialog.locator('.processing-dialog-body > :is(section, details)').filter({ visible: true });
    await expect(configuration).toHaveCount(2);
    await expect(configuration.nth(0).locator(':scope > h3')).toHaveText('Create archives');
    await expect(configuration.nth(1).locator(':scope > summary')).toHaveText('Advanced options');
    await expect(dialog.locator('[data-archive-advanced]')).not.toHaveAttribute('open');
    await expect(dialog.locator('[data-archive-replace]')).toHaveCount(1);
    const jpeg = entries(page).first();
    for (const entry of [jpeg]) {
      await expect(field(entry, 'archiveFormat')).toHaveValue('zip');
      expect(await field(entry, 'archiveFormat').locator('option').allTextContents()).toEqual(['ZIP', '7Z', 'CBZ', 'CB7']);
      await expect(field(entry, 'setName')).toHaveValue('');
      await expect(field(entry, 'prefix')).toHaveValue('');
    }
    await expect(field(jpeg, 'imageFormat')).toHaveValue('jpeg');
    await expect(field(jpeg, 'jpegQuality')).toHaveValue('80');
    await expect(field(jpeg, 'webpQuality')).toHaveValue('90');
    await expect(field(jpeg, 'lossless')).not.toBeChecked();
    await expect(dialog.locator('[data-archive-naming]')).toHaveCount(1);
    for (const base of await dialog.locator('[data-archive-field="baseName"]').all()) {
      await expect(base).toHaveValue('');
      await expect(base).toHaveAttribute('placeholder', 'archive');
    }
    const relationships = await dialog.evaluate((node) => {
      const ids = Array.from(node.querySelectorAll('[id]'), ({ id }) => id);
      const brokenLabels = Array.from(node.querySelectorAll('label[for]')).filter((label) => !label.control || !node.contains(label.control));
      const brokenAria = Array.from(node.querySelectorAll('[aria-controls], [aria-labelledby], [aria-describedby]')).flatMap((element) =>
        ['aria-controls', 'aria-labelledby', 'aria-describedby'].flatMap((attribute) =>
          (element.getAttribute(attribute) || '').split(/\s+/).filter(Boolean).filter((id) => !node.ownerDocument.getElementById(id))));
      return { count: ids.length, unique: new Set(ids).size, brokenLabels: brokenLabels.length, brokenAria };
    });
    expect(relationships.count).toBe(relationships.unique);
    expect(relationships.brokenLabels).toBe(0);
    expect(relationships.brokenAria).toEqual([]);
    await formatTrigger(jpeg).focus();
    await page.keyboard.press('Tab');
    await expect(field(jpeg, 'setName')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(field(jpeg, 'prefix')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(jpeg.locator('[data-cc-dropdown]').nth(1).locator('summary')).toBeFocused();
  } finally { await fixture.close(); }
});

test('Add starts fresh and Remove preserves stable identities, naming and the last entry', async ({ page }) => {
  const fixture = await createFixture(page);
  try {
    await openArchive(page);
    const dialog = editor(page);
    const original = entries(page).nth(0);
    const originalKey = await original.getAttribute('data-archive-entry');
    await expect(original.locator('[data-archive-remove]')).toBeDisabled();
    await dialog.locator('[data-archive-add]').click();
    const secondKey = await entries(page).nth(1).getAttribute('data-archive-entry');
    await field(original, 'setName').fill('First edited set');
    await field(original, 'prefix').fill('first-');
    await field(original, 'jpegQuality').fill('37');
    await choose(original, 'archiveFormat', 'CB7');
    await dialog.locator('[data-archive-advanced] > summary').click();
    await dialog.locator(`[data-archive-naming="${originalKey}"] input`).fill('first-base');
    await expect(field(original, 'prefix')).toHaveAttribute('placeholder', 'archive_');
    await expect(dialog.locator(`[data-archive-naming="${originalKey}"] input`)).toHaveAttribute('placeholder', 'Project slug');
    await dialog.locator('[data-archive-replace]').check();
    await dialog.getByRole('button', { name: '+ archive', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(entries(page)).toHaveCount(3);
    const added = entries(page).nth(2);
    const addedKey = await added.getAttribute('data-archive-entry');
    expect([originalKey, secondKey]).not.toContain(addedKey);
    await expect(formatTrigger(added)).toBeFocused();
    await expect(field(added, 'archiveFormat')).toHaveValue('zip');
    await expect(field(added, 'imageFormat')).toHaveValue('jpeg');
    await expect(field(added, 'jpegQuality')).toHaveValue('80');
    await expect(field(added, 'webpQuality')).toHaveValue('90');
    await expect(field(added, 'lossless')).not.toBeChecked();
    await expect(field(added, 'setName')).toHaveValue('');
    await expect(field(added, 'prefix')).toHaveValue('');
    await expect(dialog.locator(`[data-archive-naming="${addedKey}"] input`)).toHaveValue('');
    await expect(dialog.locator('[data-archive-announcement]')).toHaveText('Archive 3 added.');
    await field(added, 'setName').fill('Survivor');
    await dialog.locator(`[data-archive-naming="${addedKey}"] input`).fill('survivor-base');
    await dialog.getByRole('button', { name: 'Remove archive 2', exact: true }).click();
    await expect(entries(page)).toHaveCount(2);
    await expect(formatTrigger(entries(page).nth(1))).toBeFocused();
    await expect(entries(page).nth(1)).toHaveAttribute('data-archive-entry', addedKey);
    await expect(field(entries(page).nth(0), 'setName')).toHaveValue('First edited set');
    await expect(field(entries(page).nth(0), 'jpegQuality')).toHaveValue('37');
    await expect(field(entries(page).nth(0), 'archiveFormat')).toHaveValue('cb7');
    await dialog.getByRole('button', { name: 'Remove archive 1', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(entries(page)).toHaveCount(1);
    await expect(entries(page).first()).toHaveAttribute('data-archive-entry', addedKey);
    await expect(field(entries(page).first(), 'setName')).toHaveValue('Survivor');
    await expect(dialog.locator(`[data-archive-naming="${addedKey}"] input`)).toHaveValue('survivor-base');
    await expect(dialog.locator('[data-archive-naming-heading]')).toHaveText('Archive 1');
    await expect(dialog.locator('[data-archive-replace]')).toBeChecked();
    await expect(dialog.getByRole('button', { name: 'Remove archive 1', exact: true })).toBeDisabled();
    await dialog.locator('[data-archive-remove]').dispatchEvent('click');
    await expect(entries(page)).toHaveCount(1);
    await expect(dialog.locator('[data-archive-announcement]')).toHaveText('Archive 1 removed. 1 remaining.');
    await dialog.getByRole('button', { name: '+ archive', exact: true }).click();
    await expect(entries(page)).toHaveCount(2);
    const newKey = await entries(page).nth(1).getAttribute('data-archive-entry');
    expect([originalKey, secondKey, addedKey]).not.toContain(newKey);
    const ids = await dialog.locator('[id]').evaluateAll((nodes) => nodes.map(({ id }) => id));
    expect(ids.length).toBe(new Set(ids).size);
  } finally { await fixture.close(); }
});

test('image format switches preserve independent qualities and lossless disables the WebP stepper', async ({ page }) => {
  const fixture = await createFixture(page);
  try {
    await openArchive(page);
    await editor(page).locator('[data-archive-add]').click();
    const entry = entries(page).first();
    await expect(entry.locator('[data-archive-jpeg-options]')).toBeVisible();
    await expect(entry.locator('[data-archive-webp-options]')).toBeHidden();
    await field(entry, 'jpegQuality').fill('43');
    await choose(entry, 'imageFormat', 'WebP');
    await expect(entry.locator('[data-archive-jpeg-options]')).toBeHidden();
    await expect(entry.locator('[data-archive-webp-options]')).toBeVisible();
    await field(entry, 'webpQuality').fill('76');
    await field(entry, 'lossless').check();
    await expect(field(entry, 'webpQuality')).toHaveValue('76');
    await expect(field(entry, 'webpQuality')).toBeDisabled();
    await expect(entry.getByRole('button', { name: 'Increase WebP quality', exact: true })).toBeDisabled();
    await expect(entry.locator('[data-archive-lossless-hint]')).toBeVisible();
    await choose(entry, 'imageFormat', 'PNG');
    await expect(entry.locator('[data-archive-jpeg-options]')).toBeHidden();
    await expect(entry.locator('[data-archive-webp-options]')).toBeHidden();
    await expect(field(entry, 'lossless')).toBeDisabled();
    await choose(entry, 'imageFormat', 'WebP');
    await expect(field(entry, 'lossless')).toBeChecked();
    await field(entry, 'lossless').uncheck();
    await expect(field(entry, 'webpQuality')).toBeEnabled();
    await expect(field(entry, 'webpQuality')).toHaveValue('76');
    await expect(entry.locator('[data-archive-lossless-hint]')).toBeHidden();
    await entry.getByRole('button', { name: 'Increase WebP quality', exact: true }).click();
    await expect(field(entry, 'webpQuality')).toHaveValue('77');
    await choose(entry, 'imageFormat', 'JPEG');
    await expect(field(entry, 'jpegQuality')).toHaveValue('43');
    await expect(field(entries(page).nth(1), 'webpQuality')).toHaveValue('90');
    await field(entry, 'jpegQuality').fill('1');
    await entry.getByRole('button', { name: 'Decrease JPEG quality', exact: true }).click();
    await expect(field(entry, 'jpegQuality')).toHaveValue('1');
    await field(entry, 'jpegQuality').fill('100');
    await entry.getByRole('button', { name: 'Increase JPEG quality', exact: true }).click();
    await expect(field(entry, 'jpegQuality')).toHaveValue('100');
  } finally { await fixture.close(); }
});

test('idle reopen resets entries, advanced options and conditional controls without duplicate handlers', async ({ page }) => {
  const fixture = await createFixture(page);
  try {
    await openArchive(page);
    const dialog = editor(page);
    for (let run = 0; run < 3; run += 1) {
      await dialog.getByRole('button', { name: '+ archive', exact: true }).click();
      await expect(entries(page)).toHaveCount(2);
      await choose(entries(page).first(), 'imageFormat', 'PNG');
      await choose(entries(page).nth(1), 'imageFormat', 'WebP');
      await field(entries(page).nth(1), 'lossless').check();
      await dialog.locator('[data-archive-advanced] > summary').click();
      await dialog.locator('[data-archive-replace]').check();
      await dialog.getByRole('button', { name: 'Close Archives', exact: true }).click();
      await openArchive(page);
      await expect(dialog.locator('[data-archive-advanced]')).not.toHaveAttribute('open');
      await expect(dialog.locator('[data-archive-replace]')).not.toBeChecked();
      await expect(field(entries(page).first(), 'imageFormat')).toHaveValue('jpeg');
      await expect(entries(page).first().locator('[data-archive-jpeg-options]')).toBeVisible();
      await expect(field(entries(page).first(), 'jpegQuality')).toHaveValue('80');
      await expect(field(entries(page).first(), 'lossless')).not.toBeChecked();
    }
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Archives', exact: true })).toBeFocused();
  } finally { await fixture.close(); }
});

test('one untouched entry previews and applies exactly one JPEG archive without hidden WebP; Convert still previews', async ({ page }) => {
  const fixture = await createFixture(page);
  const archiveRequests = [];
  page.on('request', (request) => {
    if (/\/processing\/archive\/(plan|apply)/.test(request.url())) archiveRequests.push(request.postDataJSON());
  });
  try {
    await page.locator('.asset-select-checkbox').first().check();
    await openArchive(page);
    const dialog = editor(page);
    await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(dialog.locator('[data-processing-status]')).toHaveText('Preview ready.');
    await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
    expect(archiveRequests).toHaveLength(1);
    expect(archiveRequests[0]).toEqual({
      scope: { type: 'selected', assetIds: [Number(await page.locator('.asset-select-checkbox').first().inputValue())] },
      options: { archives: [
        { archiveFormat: 'zip', imageFormat: 'jpeg', quality: 80 },
      ], replaceExistingArchives: false },
    });
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(dialog.locator('[data-processing-status]')).toHaveText('Applied.');
    expect(archiveRequests).toHaveLength(2);
    expect(archiveRequests[1]).toEqual(archiveRequests[0]);
    await expect(dialog.locator('[data-processing-result-body] li')).toHaveCount(1);
    const artifacts = fixture.db.prepare('SELECT * FROM generated_artifacts WHERE project_id = ?').all(fixture.project.id);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].relative_path).toBe('archive_jpg_q80.zip');
    expect(fs.readdirSync(fixture.projectDir).filter((name) => name.endsWith('.zip'))).toEqual(['archive_jpg_q80.zip']);
    await dialog.getByRole('button', { name: 'Close Archives', exact: true }).click();
    await page.getByRole('button', { name: 'Convert', exact: true }).click();
    const convert = page.locator('#processing-convert-dialog');
    const response = page.waitForResponse((result) => /\/processing\/convert\/plan$/.test(result.url()));
    await convert.getByRole('button', { name: 'Preview', exact: true }).click();
    expect((await response).status()).toBe(200);
    await expect(convert.locator('[data-processing-status]')).toHaveText('Preview ready.');
    await expect(convert.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  } finally { await fixture.close(); }
});

test('active Archive reopening retains entries, disclosure, output and status while polling resumes', async ({ page }) => {
  const fixture = await createFixture(page);
  let releasePoll;
  const gate = new Promise((resolve) => { releasePoll = resolve; });
  await page.route('**/processing/jobs/retained-archive-job', async (route) => {
    await gate;
    await route.fulfill({ json: { ok: true, job: { id: 'retained-archive-job', state: 'succeeded', result: { result: { artifacts: [], sourceCount: 1 } } } } });
  });
  try {
    await openArchive(page);
    const dialog = editor(page);
    await field(entries(page).first(), 'setName').fill('Retained configuration');
    const key = await entries(page).first().getAttribute('data-archive-entry');
    await dialog.locator('[data-archive-advanced] > summary').click();
    await dialog.getByRole('button', { name: 'Close Archives', exact: true }).click();
    await dialog.locator('[data-processing-root]').evaluate((root) => {
      root.__ccProcessingBusy = true;
      root.__ccProcessingJob = { id: 'retained-archive-job', state: 'running', progress: { completed: 1, total: 2 } };
      root.querySelector('[data-processing-status]').textContent = 'Processing… 1 of 2.';
      root.querySelector('[data-processing-result]').hidden = false;
      root.querySelector('[data-processing-result-body]').textContent = 'Retained result';
    });
    await page.getByRole('button', { name: 'Archives', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(entries(page).first()).toHaveAttribute('data-archive-entry', key);
    await expect(field(entries(page).first(), 'setName')).toHaveValue('Retained configuration');
    await expect(dialog.locator('[data-archive-advanced]')).toHaveAttribute('open', '');
    await expect(dialog.locator('[data-processing-status]')).toHaveText('Processing… 1 of 2.');
    await expect(dialog.locator('[data-processing-result-body]')).toHaveText('Retained result');
    releasePoll();
    await expect(dialog.locator('[data-processing-status]')).toHaveText('Applied.');
  } finally {
    releasePoll();
    await page.unrouteAll({ behavior: 'wait' });
    await fixture.close();
  }
});

test('Archive layout groups fields on desktop and stacks at narrow widths without overflow', async ({ page }) => {
  const fixture = await createFixture(page);
  try {
    await openArchive(page);
    const dialog = editor(page);
    await field(entries(page).first(), 'setName').fill('A very long archive name '.repeat(20));
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const columns = await entries(page).first().locator('.processing-archive-names').evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(' ').length);
      expect(columns).toBe(width > 600 ? 2 : 1);
      await choose(entries(page).first(), 'archiveFormat', 'CBZ');
      await formatTrigger(entries(page).first()).click();
      const metrics = await dialog.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const body = node.querySelector('.processing-dialog-body');
        const outside = Array.from(node.querySelectorAll('input:not([hidden]), [data-cc-dropdown] > summary, .asset-filter-multiselect-panel, [data-archive-add]')).filter((element) => {
          if (!element.checkVisibility()) return false;
          const rect = element.getBoundingClientRect();
          return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
        }).map((node) => node.id || node.className);
        return { width: bounds.width, overflow: body.scrollWidth > body.clientWidth + 1, outside };
      });
      expect(metrics.width).toBeLessThanOrEqual(width);
      expect(metrics.overflow).toBe(false);
      expect(metrics.outside).toEqual([]);
      await formatTrigger(entries(page).first()).click();
      await formatTrigger(entries(page).first()).focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(formatTrigger(entries(page).first())).toBeFocused();
      const focus = await formatTrigger(entries(page).first()).evaluate((node) => ({
        visible: node.matches(':focus-visible'), shadow: getComputedStyle(node).boxShadow,
      }));
      expect(focus.visible).toBe(true);
      expect(focus.shadow).not.toBe('none');
      const screenshotPath = test.info().outputPath(`archive-${width}.png`);
      await page.screenshot({ path: screenshotPath });
      await test.info().attach(`archive-${width}.png`, { path: screenshotPath, contentType: 'image/png' });
    }
    await expect(dialog.locator('[data-archive-create] [data-archive-add]')).toBeVisible();
  } finally { await fixture.close(); }
});

test('Add archive reuses Dashboard New Project styling, states and keyboard activation', async ({ page }) => {
  const fixture = await createFixture(page);
  const appearance = (node) => {
    const properties = ['backgroundColor', 'borderColor', 'borderStyle', 'borderWidth', 'color',
      'fontFamily', 'fontSize', 'fontWeight', 'paddingTop', 'paddingRight', 'paddingBottom',
      'paddingLeft', 'gap', 'borderRadius', 'minHeight', 'outlineStyle', 'outlineWidth', 'outlineOffset'];
    const read = (element) => Object.fromEntries(properties.map((key) => [key, getComputedStyle(element)[key]]));
    return { button: read(node), icon: read(node.querySelector('.project-create-submit-icon')),
      svg: node.querySelector('svg').outerHTML };
  };
  const states = async (button) => {
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    const normal = await button.evaluate(appearance);
    await button.hover();
    await page.waitForTimeout(250);
    const hover = await button.evaluate(appearance);
    await button.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(button).toBeFocused();
    const focus = await button.evaluate(appearance);
    return { normal, hover, focus };
  };
  try {
    await page.goto(fixture.baseURL);
    const reference = page.getByRole('link', { name: 'New Project', exact: true });
    const dashboard = await states(reference);
    await page.goto(`${fixture.baseURL}/projects/${fixture.project.id}/assets?view=list`);
    await openArchive(page);
    const add = editor(page).getByRole('button', { name: '+ archive', exact: true });
    await expect(add).toHaveClass('button button-primary dashboard-create-action');
    expect(await states(add)).toEqual(dashboard);
    await add.evaluate((node) => { node.disabled = true; });
    await expect(add).toBeDisabled();
    await expect(add).toHaveCSS('cursor', 'not-allowed');
    await expect(add.locator('.project-create-submit-icon')).toHaveCSS('color', await add.evaluate((node) => getComputedStyle(node).color));
    await expect(add.locator('.project-create-submit-icon')).toHaveCSS('background-color', dashboard.normal.button.borderColor);
    await add.evaluate((node) => { node.disabled = false; });
    for (const key of ['Space', 'Enter']) {
      await add.focus();
      await page.keyboard.press(key);
      await expect(entries(page)).toHaveCount(2);
      await expect(formatTrigger(entries(page).last())).toBeFocused();
      await entries(page).last().locator('[data-archive-remove]').click();
      await expect(entries(page)).toHaveCount(1);
      await expect(formatTrigger(entries(page).first())).toBeFocused();
    }
  } finally { await fixture.close(); }
});
