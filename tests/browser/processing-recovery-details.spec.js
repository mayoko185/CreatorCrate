import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { build } from 'vite';
import { createApp } from '../../src/app.js';
import { createAssetManifest } from '../../src/asset-manifest.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { closeDatabase, openDatabase, runMigrations } from '../../src/db.js';
import { createProcessingRecoveryGateRepository } from '../../src/data/processing-recovery-gate-repository.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const TOKEN = '0123456789abcdef';
const PROMPT_BACKUP = `.creatorcrate-workflow-prompts-staging/${TOKEN}.0.original`;
const CONVERT_STAGE = `.creatorcrate-convert-staging/${TOKEN}.0.output`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

let buildRoot;
let viteDistRoot;
let assetManifest;

test.beforeAll(async () => {
  buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-recovery-details-build-'));
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

async function createFixture(page) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-recovery-details-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  let server;
  const close = async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
      appDataRoot, assetManifest, useViteAssets: true, viteDistRoot, authState: { csrfPepper },
    });
    const project = app.locals.projectService.create({ title: 'Recovery Details Browser', status: 'tbd' });
    const projectDir = path.join(projectsRoot, project.project_dir);
    const sourcePath = path.join(projectDir, 'final', 'source.png');
    fs.writeFileSync(sourcePath, await sharp({
      create: { width: 12, height: 12, channels: 4, background: '#336699' },
    }).png().toBuffer());
    app.locals.assetScanner.scanProjectAssets(project.id);

    const repository = app.locals.processingRecoveryEvidenceRepository;
    const writePrivate = (relative, bytes) => {
      const target = path.join(projectDir, ...relative.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
      const stats = fs.lstatSync(target, { bigint: true });
      return { target, identity: { dev: stats.dev, ino: stats.ino } };
    };

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const baseURL = `http://127.0.0.1:${server.address().port}`;

    const requests = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin === baseURL) requests.push({ method: request.method(), path: url.pathname });
    });

    return {
      app, db, project, projectDir, sourcePath, repository, writePrivate, baseURL, requests, close,
      // A unique Workflow Prompt original backup: its bytes match no accepted project file.
      addCriticalBackup() {
        const bytes = Buffer.from('UNIQUE ORIGINAL BYTES');
        const { target, identity } = writePrivate(PROMPT_BACKUP, bytes);
        const group = repository.createMutationGroup({
          projectId: project.id, operation: 'workflow-prompt', runId: 'run-wp9', itemKey: 'asset:1',
        });
        repository.markMutationCheckpoint(project.id, group.groupId, 'unlink');
        const row = repository.createEvidence({
          projectId: project.id, mutationGroupId: group.groupId, artifactRole: 'original-backup',
          retentionReason: 'restoration-failed', artifactPath: PROMPT_BACKUP, sourcePath: 'final/source.png',
          destinationPath: null, identity, expectedSize: bytes.length, expectedSha256: sha256(bytes),
          lifecycle: 'recovery-critical',
        });
        return { row, target };
      },
      // A resolved, eligible Conversion residue file.
      addEligibleResidue() {
        const bytes = Buffer.from('STAGED OUTPUT');
        const { target, identity } = writePrivate(CONVERT_STAGE, bytes);
        const group = repository.createMutationGroup({
          projectId: project.id, operation: 'convert', runId: 'run-wp9-residue', itemKey: 'final/source.png',
        });
        const row = repository.createEvidence({
          projectId: project.id, mutationGroupId: group.groupId, artifactRole: 'stage-output',
          retentionReason: 'conversion-cleanup-residue', artifactPath: CONVERT_STAGE,
          sourcePath: 'final/source.png', destinationPath: 'final/source.webp',
          identity, expectedSize: bytes.length, expectedSha256: sha256(bytes), lifecycle: 'dispensable',
        });
        return { row, target };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

const recoveryPath = (fixture, action = '') => `/projects/${fixture.project.id}/assets/processing/recovery${action ? `/${action}` : ''}`;

function waitForRequest(page, method, pathname) {
  return page.waitForResponse((response) => (
    response.request().method() === method && new URL(response.url()).pathname === pathname
  ));
}

test('gated recovery moves to a restrained Recovery Details state after a manual scan', async ({ page }) => {
  const fixture = await createFixture(page);
  try {
    const { row, target } = fixture.addCriticalBackup();
    createProcessingRecoveryGateRepository(fixture.db).markRecoveryRequired(fixture.project.id);

    const initialGet = waitForRequest(page, 'GET', recoveryPath(fixture));
    await page.goto(`${fixture.baseURL}/projects/${fixture.project.id}/assets?view=list`);
    expect((await initialGet).status()).toBe(200);

    // B: the page shows the strong gated warning with Recovery Details.
    const pageEntry = page.locator('.processing-recovery-entry-point--page');
    const gated = pageEntry.locator('[data-recovery-entry-variant="gated"]');
    const restrained = pageEntry.locator('[data-recovery-entry-variant="evidence"]');
    await expect(gated).toBeVisible();
    await expect(gated).toContainText('Manual recovery required.');
    await expect(restrained).toBeHidden();

    // K (before): Preview is still refused by the server's existing gate.
    await page.locator('.asset-select-checkbox').first().setChecked(true);
    await page.locator('[data-dialog-open="processing-convert-dialog"]').first().click();
    const convertDialog = page.locator('#processing-convert-dialog');
    await expect(convertDialog).toBeVisible();
    const refusedPreview = waitForRequest(page, 'POST', `/projects/${fixture.project.id}/assets/processing/convert/plan`);
    await convertDialog.getByRole('button', { name: 'Preview', exact: true }).click();
    expect((await refusedPreview).status()).toBe(409);
    await expect(convertDialog.locator('[data-processing-error]')).toContainText('Inspect the project folder');
    await expect(convertDialog.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
    const dialogEntry = convertDialog.locator('[data-recovery-details-entry] [data-recovery-entry-variant="gated"]');
    await expect(dialogEntry).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(convertDialog).toBeHidden();

    // C/D: opening reads stored state only.
    const dialog = page.locator('#processing-recovery-details-dialog');
    const openGet = waitForRequest(page, 'GET', recoveryPath(fixture));
    await gated.getByRole('button', { name: 'Recovery Details' }).click();
    await expect(dialog).toBeVisible();
    await openGet;
    await expect(dialog.locator('[data-recovery-details-summary]')).toContainText('Processing is blocked until you inspect the project');
    const entry = dialog.locator(`[data-recovery-entry="evidence:${row.evidenceId}"]`);
    await expect(entry).toContainText('Workflow Prompt');
    await expect(entry).toContainText('Original backup');
    await expect(entry).toContainText('Recovery copy retained');
    await expect(entry).toContainText('Not refreshed');
    await expect(entry).toContainText(PROMPT_BACKUP);
    await expect(entry.getByRole('button', { name: 'Retry safe cleanup' })).toHaveCount(0);
    expect(fixture.requests.filter((request) => request.path.startsWith(recoveryPath(fixture, 'refresh')))).toEqual([]);
    expect(fixture.requests.filter((request) => request.method === 'POST' && request.path.startsWith(recoveryPath(fixture)))).toEqual([]);
    expect(fixture.repository.findEvidence(fixture.project.id, row.evidenceId).observation).toBe('unchecked');

    // E: explicit Refresh inspects the listed file.
    const refreshed = waitForRequest(page, 'POST', recoveryPath(fixture, 'refresh'));
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
    const refreshResponse = await refreshed;
    expect(refreshResponse.status()).toBe(200);
    expect(refreshResponse.request().postDataJSON()).toEqual({ evidenceIds: [row.evidenceId] });
    await expect(entry).toContainText('File present');
    await expect(dialog.locator('[data-recovery-details-status]')).toHaveText('Recovery files checked.');

    // F/G: the manual scan accepts current state; the unique copy stays retained.
    const scan = waitForRequest(page, 'POST', `/projects/${fixture.project.id}/scan/manual`);
    await dialog.getByRole('button', { name: 'Run Manual Scan' }).click();
    expect((await scan).status()).toBe(200);
    await expect(dialog.locator('[data-recovery-details-summary]')).toContainText('Processing can continue. Recovery evidence remains');
    await expect(dialog.locator('[data-recovery-details-status]')).toHaveText('Manual scan complete.');
    await expect(dialog.getByRole('button', { name: 'Run Manual Scan' })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Run Manual Scan' })).not.toHaveAttribute('aria-busy', 'true');

    // H/I/J: no strong warning; the restrained link remains; the copy is still listed.
    await expect(dialog).toBeVisible();
    await expect(entry).toContainText('Recovery copy retained');
    await expect(entry.getByRole('button', { name: 'Retry safe cleanup' })).toHaveCount(0);
    await expect(gated).toBeHidden();
    await expect(restrained).toBeVisible();
    await expect(restrained).toContainText('Recovery evidence remains');
    expect(fs.existsSync(target)).toBe(true);
    const stored = fixture.repository.findEvidence(fixture.project.id, row.evidenceId);
    expect(stored.lifecycle).toBe('recovery-critical');
    expect(createProcessingRecoveryGateRepository(fixture.db).isRecoveryRequired(fixture.project.id)).toBe(false);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // K (after): Preview is governed by the existing rules again.
    await page.locator('.asset-select-checkbox').first().setChecked(true);
    await page.locator('[data-dialog-open="processing-convert-dialog"]').first().click();
    await expect(convertDialog).toBeVisible();
    await expect(convertDialog.locator('[data-recovery-details-entry] [data-recovery-entry-variant="evidence"]')).toBeVisible();
    const preview = waitForRequest(page, 'POST', `/projects/${fixture.project.id}/assets/processing/convert/plan`);
    await convertDialog.getByRole('button', { name: 'Preview', exact: true }).click();
    expect((await preview).status()).toBe(200);
    await expect(convertDialog.locator('[data-processing-status]')).toHaveText('Preview ready.');
    await expect(convertDialog.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();

    expect(fixture.requests.filter((request) => request.path === recoveryPath(fixture, 'refresh'))).toHaveLength(1);
    expect(fixture.requests.filter((request) => request.path === recoveryPath(fixture, 'cleanup'))).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test('safe cleanup removes only the eligible residue and the entry point disappears', async ({ page }) => {
  const fixture = await createFixture(page);
  try {
    const { row, target } = fixture.addEligibleResidue();
    const bystander = path.join(fixture.projectDir, '.creatorcrate-convert-staging', 'keep-me.txt');
    fs.writeFileSync(bystander, 'unrelated');

    await page.goto(`${fixture.baseURL}/projects/${fixture.project.id}/assets?view=list`);
    const pageEntry = page.locator('.processing-recovery-entry-point--page');
    const restrained = pageEntry.locator('[data-recovery-entry-variant="evidence"]');
    await expect(restrained).toBeVisible();
    await expect(pageEntry.locator('[data-recovery-entry-variant="gated"]')).toBeHidden();

    await restrained.getByRole('button', { name: 'Recovery Details' }).click();
    const dialog = page.locator('#processing-recovery-details-dialog');
    await expect(dialog).toBeVisible();
    const entry = dialog.locator(`[data-recovery-entry="evidence:${row.evidenceId}"]`);
    await expect(entry).toContainText('Staged converted image');
    await expect(entry).toContainText('Safe cleanup can be retried');
    await expect(dialog.getByRole('button', { name: 'Run Manual Scan' })).toBeHidden();

    const cleanup = waitForRequest(page, 'POST', recoveryPath(fixture, 'cleanup'));
    await entry.getByRole('button', { name: 'Retry safe cleanup' }).click();
    const cleanupResponse = await cleanup;
    expect(cleanupResponse.request().postDataJSON()).toEqual({ evidenceIds: [row.evidenceId] });
    expect(cleanupResponse.status()).toBe(200);
    await expect(dialog.locator('[data-recovery-details-status]')).toHaveText('Cleanup completed.');
    await expect(entry).toHaveCount(0);
    await expect(dialog.locator('[data-recovery-details-summary]')).toContainText('No registered recovery evidence is currently listed');
    // The final row is gone: focus lands on the dialog's Close, never <body>.
    await expect(dialog.locator('.app-dialog-footer [data-dialog-close]')).toBeFocused();
    await expect(pageEntry).toBeHidden();
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(bystander, 'utf8')).toBe('unrelated');
    expect(fs.existsSync(fixture.sourcePath)).toBe(true);
  } finally {
    await fixture.close();
  }
});

test('Recovery Details fits a 360px viewport', async ({ page }) => {
  const fixture = await createFixture(page);
  try {
    fixture.addCriticalBackup();
    fixture.addEligibleResidue();
    createProcessingRecoveryGateRepository(fixture.db).markRecoveryRequired(fixture.project.id);
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`${fixture.baseURL}/projects/${fixture.project.id}/assets?view=list`);
    const gated = page.locator('.processing-recovery-entry-point--page [data-recovery-entry-variant="gated"]');
    await expect(gated).toBeVisible();
    await gated.getByRole('button', { name: 'Recovery Details' }).click();
    const dialog = page.locator('#processing-recovery-details-dialog');
    await expect(dialog.locator('[data-recovery-entry]')).toHaveCount(2);

    const layout = await dialog.evaluate((element) => {
      const card = element.querySelector('.app-dialog-card');
      const rect = element.getBoundingClientRect();
      const close = element.querySelector('[data-dialog-close]').getBoundingClientRect();
      const overflowing = Array.from(element.querySelectorAll('.processing-recovery-entry, .processing-recovery-path, .processing-recovery-entry-actions'))
        .filter((node) => node.scrollWidth > node.clientWidth + 1).length;
      return {
        left: rect.left, right: rect.right, viewport: window.innerWidth,
        cardScroll: card.scrollWidth, cardClient: card.clientWidth,
        closeVisible: close.left >= 0 && close.right <= window.innerWidth && close.top >= 0,
        overflowing,
        pageScroll: document.documentElement.scrollWidth,
      };
    });
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(layout.viewport);
    expect(layout.cardScroll).toBeLessThanOrEqual(layout.cardClient);
    expect(layout.overflowing).toBe(0);
    expect(layout.closeVisible).toBe(true);
    expect(layout.pageScroll).toBeLessThanOrEqual(360);
    await page.screenshot({ path: test.info().outputPath('recovery-details-360.png') });
  } finally {
    await fixture.close();
  }
});

// Holds one matching request until the test releases it.
async function holdRoute(page, method, pathname) {
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  let arrived;
  const arrival = new Promise((resolve) => { arrived = resolve; });
  await page.route((url) => url.pathname === pathname, async (route) => {
    if (route.request().method() !== method) return route.fallback();
    arrived();
    await released;
    await route.continue();
  }, { times: 1 });
  return { arrival, release: () => release() };
}

const activeElement = (page) => page.evaluate(() => {
  const active = document.activeElement;
  return {
    isBody: active === document.body || active === null,
    tag: active?.tagName,
    disabled: Boolean(active?.disabled),
    cleanup: active?.getAttribute('data-recovery-cleanup') ?? null,
    list: active?.hasAttribute('data-recovery-details-list') ?? false,
    technicalFor: active?.hasAttribute('data-recovery-technical')
      ? active.closest('[data-recovery-entry]')?.getAttribute('data-recovery-entry') ?? null
      : null,
  };
});

test('retained cleanup returns keyboard focus to the re-enabled button in Chromium', async ({ page }) => {
  const fixture = await createFixture(page);
  try {
    const { row, target } = fixture.addEligibleResidue();
    await page.goto(`${fixture.baseURL}/projects/${fixture.project.id}/assets?view=list`);
    const opener = page.locator('.processing-recovery-entry-point--page [data-recovery-entry-variant="evidence"]')
      .getByRole('button', { name: 'Recovery Details' });
    await opener.click();
    const dialog = page.locator('#processing-recovery-details-dialog');
    const entry = dialog.locator(`[data-recovery-entry="evidence:${row.evidenceId}"]`);
    const button = entry.getByRole('button', { name: /Retry safe cleanup|Cleaning up/ });
    await expect(button).toHaveText('Retry safe cleanup');

    // Same file, different bytes: fresh-proof cleanup retains it ('changed').
    fs.writeFileSync(target, 'STAGED OUTPUX');

    const held = await holdRoute(page, 'POST', recoveryPath(fixture, 'cleanup'));
    await button.focus();
    await page.keyboard.press('Enter');
    await held.arrival;
    // Busy: the button is disabled; focus is parked on the list, not <body>.
    await expect(button).toBeDisabled();
    await expect(dialog.locator('[data-recovery-details-list]')).toBeFocused();
    expect(await activeElement(page)).toMatchObject({ isBody: false, disabled: false, list: true });

    const cleanup = waitForRequest(page, 'POST', recoveryPath(fixture, 'cleanup'));
    const followUp = waitForRequest(page, 'GET', recoveryPath(fixture));
    held.release();
    expect((await cleanup).status()).toBe(200);
    await followUp;
    await expect(dialog.locator('[data-recovery-details-status]')).toHaveText('The file contents changed, so nothing was removed.');
    await expect(entry).toBeVisible();
    await expect(button).toBeEnabled();
    await expect(button).toBeFocused();
    expect(await activeElement(page)).toMatchObject({ isBody: false, disabled: false, cleanup: row.evidenceId });
    expect(fs.existsSync(target)).toBe(true);

    // Closing still returns focus to the opener.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  } finally {
    await fixture.close();
  }
});

test('focus the user moves to Technical details during cleanup is never stolen back in Chromium', async ({ page }) => {
  const fixture = await createFixture(page);
  try {
    const { row, target } = fixture.addEligibleResidue();
    await page.goto(`${fixture.baseURL}/projects/${fixture.project.id}/assets?view=list`);
    await page.locator('.processing-recovery-entry-point--page [data-recovery-entry-variant="evidence"]')
      .getByRole('button', { name: 'Recovery Details' }).click();
    const dialog = page.locator('#processing-recovery-details-dialog');
    const entry = dialog.locator(`[data-recovery-entry="evidence:${row.evidenceId}"]`);
    const button = entry.getByRole('button', { name: /Retry safe cleanup|Cleaning up/ });
    const technical = entry.locator('summary', { hasText: 'Technical details' });
    await expect(button).toHaveText('Retry safe cleanup');

    // Same file, different bytes: fresh-proof cleanup retains it ('changed').
    fs.writeFileSync(target, 'STAGED OUTPUX');

    const held = await holdRoute(page, 'POST', recoveryPath(fixture, 'cleanup'));
    await button.focus();
    await page.keyboard.press('Enter');
    await held.arrival;
    await expect(button).toBeDisabled();
    await expect(dialog.locator('[data-recovery-details-list]')).toBeFocused();

    // The user tabs from the parked list past the disabled button to Technical details.
    await page.keyboard.press('Tab');
    await expect(technical).toBeFocused();
    const before = await technical.elementHandle();

    const cleanup = waitForRequest(page, 'POST', recoveryPath(fixture, 'cleanup'));
    const followUp = waitForRequest(page, 'GET', recoveryPath(fixture));
    held.release();
    expect((await cleanup).status()).toBe(200);
    await followUp;
    // aria-busy clears when the authoritative GET is applied; cleanup's focus
    // settlement runs in the same task, so focus is final from here on.
    await expect(page.locator('[data-recovery-details]')).not.toHaveAttribute('aria-busy', 'true');
    await expect(dialog.locator('[data-recovery-details-status]')).toHaveText('The file contents changed, so nothing was removed.');
    await expect(button).toBeEnabled();
    // The authoritative GET re-rendered the entry: focus is on the replacement summary.
    expect(await before.evaluate((node) => node.isConnected)).toBe(false);
    await expect(technical).toBeFocused();
    await expect(button).not.toBeFocused();
    expect(await activeElement(page)).toMatchObject({
      isBody: false, cleanup: null, list: false, technicalFor: `evidence:${row.evidenceId}`,
    });
    expect(fs.existsSync(target)).toBe(true);
  } finally {
    await fixture.close();
  }
});

test('cleaned row with other entries remaining moves focus to the entries list', async ({ page }) => {
  const fixture = await createFixture(page);
  try {
    fixture.addCriticalBackup();
    const { row } = fixture.addEligibleResidue();
    await page.goto(`${fixture.baseURL}/projects/${fixture.project.id}/assets?view=list`);
    await page.locator('.processing-recovery-entry-point--page [data-recovery-entry-variant="evidence"]')
      .getByRole('button', { name: 'Recovery Details' }).click();
    const dialog = page.locator('#processing-recovery-details-dialog');
    const entry = dialog.locator(`[data-recovery-entry="evidence:${row.evidenceId}"]`);
    await entry.getByRole('button', { name: 'Retry safe cleanup' }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog.locator('[data-recovery-details-status]')).toHaveText('Cleanup completed.');
    await expect(entry).toHaveCount(0);
    await expect(dialog.locator('[data-recovery-entry]')).toHaveCount(1);
    await expect(dialog.locator('[data-recovery-details-list]')).toBeFocused();
    expect((await activeElement(page)).isBody).toBe(false);
  } finally {
    await fixture.close();
  }
});

test('archived project keeps read-only Recovery Details with no mutation controls', async ({ page }) => {
  const fixture = await createFixture(page);
  try {
    const { row: critical } = fixture.addCriticalBackup();
    const { row: residue } = fixture.addEligibleResidue();
    createProcessingRecoveryGateRepository(fixture.db).markRecoveryRequired(fixture.project.id);
    fixture.app.locals.projectService.archive(fixture.project.id);

    const initialGet = waitForRequest(page, 'GET', recoveryPath(fixture));
    await page.goto(`${fixture.baseURL}/projects/${fixture.project.id}/assets?view=list`);
    expect((await initialGet).status()).toBe(200);

    const pageEntry = page.locator('.processing-recovery-entry-point--page');
    const gated = pageEntry.locator('[data-recovery-entry-variant="gated"]');
    await expect(gated).toBeVisible();
    await expect(gated).toContainText('Recovery state is unresolved. This archived project is read-only.');
    await expect(gated).not.toContainText(/manual scan/i);
    await expect(page.locator('#processing-recovery-details-dialog')).toHaveCount(1);

    const openGet = waitForRequest(page, 'GET', recoveryPath(fixture));
    await gated.getByRole('button', { name: 'Recovery Details' }).click();
    const dialog = page.locator('#processing-recovery-details-dialog');
    await expect(dialog).toBeVisible();
    expect((await openGet).status()).toBe(200);
    await expect(dialog.locator('[data-recovery-details-summary]')).toContainText('This archived project is read-only. Recovery information is available for review.');
    await expect(dialog.locator('[data-recovery-details-summary]')).toContainText('unresolved');
    await expect(dialog.locator(`[data-recovery-entry="evidence:${critical.evidenceId}"]`)).toContainText('Original backup');
    const residueEntry = dialog.locator(`[data-recovery-entry="evidence:${residue.evidenceId}"]`);
    await expect(residueEntry).toContainText(CONVERT_STAGE);

    await expect(dialog.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Run Manual Scan' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Retry safe cleanup' })).toHaveCount(0);
    await expect(dialog).not.toContainText(/run a manual scan|cleanup can be retried/i);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(fixture.requests.filter((request) => request.method === 'POST')).toEqual([]);
    expect(fixture.repository.findEvidence(fixture.project.id, residue.evidenceId).observation).toBe('unchecked');
  } finally {
    await fixture.close();
  }
});

test('a Recovery Details GET begun before a Processing 409 cannot hide the new gate', async ({ page }) => {
  const fixture = await createFixture(page);
  try {
    fixture.addEligibleResidue();
    await page.goto(`${fixture.baseURL}/projects/${fixture.project.id}/assets?view=list`);
    const pageEntry = page.locator('.processing-recovery-entry-point--page');
    const restrained = pageEntry.locator('[data-recovery-entry-variant="evidence"]');
    const gated = pageEntry.locator('[data-recovery-entry-variant="gated"]');
    await expect(restrained).toBeVisible();

    // GET A reads the ungated server state now; its response is held back.
    let releaseA;
    const heldA = new Promise((resolve) => { releaseA = resolve; });
    let answeredA;
    const fetchedA = new Promise((resolve) => { answeredA = resolve; });
    await page.route((url) => url.pathname === recoveryPath(fixture), async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      answeredA(body);
      await heldA;
      await route.fulfill({ response, json: body });
    }, { times: 1 });
    await restrained.getByRole('button', { name: 'Recovery Details' }).click();
    expect((await fetchedA).recoveryRequired).toBe(false);
    await page.keyboard.press('Escape');

    // The server becomes gated; Preview is refused with 409 and Processing syncs.
    createProcessingRecoveryGateRepository(fixture.db).markRecoveryRequired(fixture.project.id);
    await page.locator('.asset-select-checkbox').first().setChecked(true);
    await page.locator('[data-dialog-open="processing-convert-dialog"]').first().click();
    const convertDialog = page.locator('#processing-convert-dialog');
    await expect(convertDialog).toBeVisible();
    const refused = waitForRequest(page, 'POST', `/projects/${fixture.project.id}/assets/processing/convert/plan`);
    const getB = waitForRequest(page, 'GET', recoveryPath(fixture));
    await convertDialog.getByRole('button', { name: 'Preview', exact: true }).click();
    expect((await refused).status()).toBe(409);
    const responseB = await getB;
    expect((await responseB.json()).recoveryRequired).toBe(true);
    await expect(gated).toBeVisible();

    // The stale ungated GET A lands last and is ignored.
    const responseA = waitForRequest(page, 'GET', recoveryPath(fixture));
    releaseA();
    expect((await (await responseA).json()).recoveryRequired).toBe(false);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(gated).toBeVisible();
    await expect(restrained).toBeHidden();
    await expect(convertDialog.locator('[data-recovery-details-entry] [data-recovery-entry-variant="gated"]')).toBeVisible();
    expect(fixture.requests.filter((request) => request.method === 'POST' && request.path.startsWith(recoveryPath(fixture)))).toEqual([]);
  } finally {
    await fixture.close();
  }
});
