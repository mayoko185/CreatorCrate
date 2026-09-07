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

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function requestPath(request) {
  return new URL(request.url()).pathname;
}

function processingState(page) {
  return page.locator('#processing-convert-dialog [data-processing-root]').evaluate((root) => ({
    busy: root.__ccProcessingBusy,
    jobId: root.__ccProcessingJob?.id || null,
    jobState: root.__ccProcessingJob?.state || null,
    pollGeneration: root.__ccProcessingJobPollGeneration,
    polling: root.__ccProcessingJobPolling !== null && root.__ccProcessingJobPolling !== undefined,
    timer: root.__ccProcessingJobPollTimer !== null && root.__ccProcessingJobPollTimer !== undefined,
    submission: root.__ccProcessingSubmission
      ? { ...root.__ccProcessingSubmission }
      : null,
  }));
}

let buildRoot;
let viteDistRoot;
let assetManifest;

test.beforeAll(async () => {
  buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-processing-browser-build-'));
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

async function createFixture(page, executeConvert) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-processing-browser-'));
  const projectsRoot = path.join(root, 'projects');
  const appDataRoot = path.join(root, 'app');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(appDataRoot);
  const db = openDatabase(path.join(root, 'test.db'));
  const projectOperationCoordinator = createProjectOperationCoordinator();
  const processingJobService = createProcessingJobService({ projectOperationCoordinator });
  const executionCalls = [];
  let server;

  try {
    runMigrations(db, MIGRATIONS_DIR);
    const { csrfPepper } = ensureAuthEnablement(appDataRoot);
    const alreadyCoordinatedProcessingExecutor = {
      async convertAssets(...args) {
        executionCalls.push(args);
        return executeConvert(...args);
      },
    };
    const app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, {
      appDataRoot,
      assetManifest,
      useViteAssets: true,
      viteDistRoot,
      authState: { csrfPepper },
      projectOperationCoordinator,
      processingJobService,
      alreadyCoordinatedProcessingExecutor,
    });
    const project = app.locals.projectService.create({
      title: 'Processing Browser Lifecycle',
      status: 'tbd',
    });
    expect(project.id).toBe(1);

    const sourcePath = path.join(projectsRoot, project.project_dir, 'final', 'source.png');
    await sharp({
      create: { width: 12, height: 12, channels: 4, background: '#336699' },
    }).png().toFile(sourcePath);
    app.locals.assetScanner.scanProjectAssets(project.id);

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${baseURL}/projects/${project.id}/assets?view=list`, { waitUntil: 'domcontentloaded' });

    const dialog = page.locator('#processing-convert-dialog');
    const processingRoot = dialog.locator('[data-processing-root]');
    await expect(processingRoot).toHaveAttribute('data-project-id', String(project.id));
    await expect(processingRoot).toHaveAttribute('data-project-id', '1');

    return {
      app,
      baseURL,
      dialog,
      executionCalls,
      processingJobService,
      project,
      projectOperationCoordinator,
      root,
      sourcePath,
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

async function openAndPreviewConvert(page, fixture) {
  await page.locator('.asset-select-checkbox').first().setChecked(true);
  await page.getByRole('button', { name: 'Convert', exact: true }).click();
  await expect(fixture.dialog).toBeVisible();
  await expect(fixture.dialog.locator('[data-processing-root]')).toHaveAttribute(
    'data-project-id',
    String(fixture.project.id),
  );

  const previewResponse = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && requestPath(response.request()) === `/projects/${fixture.project.id}/assets/processing/convert/plan`
  ));
  await fixture.dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  expect((await previewResponse).status()).toBe(200);
  await expect(fixture.dialog.locator('[data-processing-status]')).toHaveText('Preview ready.');
  await expect(fixture.dialog.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
}

function startCoordinatorHolder(fixture) {
  const release = deferred();
  const jobId = fixture.processingJobService.enqueue({
    projectId: fixture.project.id,
    operation: 'browser-test-holder',
    assetCount: 0,
    execute: () => release.promise,
  });
  return { jobId, release };
}

test('close and reopen before a delayed 202 keeps only the reopened generation polling', async ({ page }) => {
  const applyCaptured = deferred();
  const releaseApplyResponse = deferred();
  const applyFulfilled = deferred();
  const requests = [];
  const fixture = await createFixture(page, async () => ({
    convertedCount: 1,
    requestedCount: 1,
    convertedAssetIds: [],
    assets: [],
    format: 'webp',
    quality: 85,
    originalHandling: 'keep',
  }));
  const holder = startCoordinatorHolder(fixture);
  const applyPath = `/projects/${fixture.project.id}/assets/processing/convert/apply`;

  page.on('request', (request) => requests.push({ method: request.method(), path: requestPath(request) }));
  await page.route(`**${applyPath}`, async (route) => {
    try {
      const response = await route.fetch();
      const payload = await response.json();
      applyCaptured.resolve({ payload, status: response.status() });
      await releaseApplyResponse.promise;
      await route.fulfill({ response });
      applyFulfilled.resolve();
    } catch (error) {
      applyCaptured.reject(error);
      applyFulfilled.reject(error);
      throw error;
    }
  });

  try {
    await expect.poll(() => fixture.processingJobService.getJob(holder.jobId)?.state).toBe('running');
    await openAndPreviewConvert(page, fixture);
    await fixture.dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    const captured = await applyCaptured.promise;
    expect(captured.status).toBe(202);
    expect(captured.payload.jobId).toEqual(expect.any(String));
    await expect.poll(() => fixture.processingJobService.getJob(captured.payload.jobId)?.state).toBe('queued');

    await fixture.dialog.getByRole('button', { name: 'Close Convert', exact: true }).click();
    await expect(fixture.dialog).toBeHidden();
    await page.getByRole('button', { name: 'Convert', exact: true }).click();
    await expect(fixture.dialog).toBeVisible();
    expect((await processingState(page)).submission).toMatchObject({ closed: false });

    holder.release.resolve({ held: true });
    await expect.poll(() => fixture.processingJobService.getJob(captured.payload.jobId)?.state).toBe('succeeded');
    expect(fixture.executionCalls).toHaveLength(1);
    releaseApplyResponse.resolve();
    await applyFulfilled.promise;

    await expect(fixture.dialog.locator('[data-processing-status]')).toHaveText('Applied. Assets refreshed.');
    const jobPath = `/processing/jobs/${captured.payload.jobId}`;
    expect(requests.filter(({ method, path }) => method === 'GET' && path === jobPath)).toHaveLength(1);
    expect(requests.filter(({ method, path }) => method === 'POST' && path === `${jobPath}/cancel`)).toHaveLength(0);
    expect(await processingState(page)).toMatchObject({
      busy: false,
      jobId: null,
      polling: false,
      timer: false,
      submission: null,
    });
  } finally {
    holder.release.resolve({ held: true });
    releaseApplyResponse.resolve();
    await page.unroute(`**${applyPath}`).catch(() => {});
    await fixture.close();
  }
});

test('closing a genuinely queued job cancels once and prevents delayed execution', async ({ page }) => {
  const requests = [];
  const fixture = await createFixture(page, async () => ({ convertedCount: 1 }));
  const holder = startCoordinatorHolder(fixture);
  page.on('request', (request) => requests.push({ method: request.method(), path: requestPath(request) }));

  try {
    await expect.poll(() => fixture.processingJobService.getJob(holder.jobId)?.state).toBe('running');
    await openAndPreviewConvert(page, fixture);
    const applyResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && requestPath(response.request()) === `/projects/${fixture.project.id}/assets/processing/convert/apply`
    ));
    await fixture.dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    const applyResponse = await applyResponsePromise;
    expect(applyResponse.status()).toBe(202);
    const { jobId } = await applyResponse.json();
    await expect.poll(() => fixture.processingJobService.getJob(jobId)?.state).toBe('queued');

    const cancelPath = `/processing/jobs/${jobId}/cancel`;
    const cancellationResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST' && requestPath(response.request()) === cancelPath
    ));
    await fixture.dialog.getByRole('button', { name: 'Close Convert', exact: true }).click();
    expect((await cancellationResponse).status()).toBe(200);
    await expect.poll(() => fixture.processingJobService.getJob(jobId)?.state).toBe('cancelled');

    holder.release.resolve({ held: true });
    await expect.poll(() => fixture.processingJobService.getJob(holder.jobId)?.state).toBe('succeeded');
    expect(fixture.processingJobService.getJob(jobId)?.state).toBe('cancelled');
    expect(fixture.executionCalls).toHaveLength(0);
    expect(fs.existsSync(fixture.sourcePath.replace(/\.png$/u, '.webp'))).toBe(false);
    expect(requests.filter(({ method, path }) => method === 'POST' && path === cancelPath)).toHaveLength(1);
    expect(await processingState(page)).toMatchObject({
      busy: false,
      jobId: null,
      polling: false,
      timer: false,
      submission: null,
    });
  } finally {
    holder.release.resolve({ held: true });
    await fixture.close();
  }
});

test('overlapping stale and current polls complete, rescan, and refresh exactly once', async ({ page }) => {
  const executionStarted = deferred();
  const releaseExecution = deferred();
  const firstPollCaptured = deferred();
  const releaseFirstPoll = deferred();
  const firstPollFulfilled = deferred();
  const secondPollArrived = deferred();
  const allowSecondPollFetch = deferred();
  const secondPollFulfilled = deferred();
  const requests = [];
  const fixture = await createFixture(page, async (_projectId, _assetIds, _options, updateProgress) => {
    updateProgress({ completed: 0, total: 1 });
    executionStarted.resolve();
    await releaseExecution.promise;
    updateProgress({ completed: 1, total: 1 });
    return {
      convertedCount: 1,
      requestedCount: 1,
      convertedAssetIds: [],
      assets: [],
      format: 'webp',
      quality: 85,
      originalHandling: 'keep',
    };
  });
  let jobId;
  let jobPollCount = 0;

  page.on('request', (request) => requests.push({
    method: request.method(),
    path: requestPath(request),
    resourceType: request.resourceType(),
  }));
  await page.route('**/processing/jobs/*', async (route) => {
    const pathName = requestPath(route.request());
    if (!jobId || pathName !== `/processing/jobs/${jobId}` || route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    jobPollCount += 1;
    try {
      if (jobPollCount === 1) {
        const response = await route.fetch();
        const payload = await response.json();
        firstPollCaptured.resolve({ payload, response });
        await releaseFirstPoll.promise;
        await route.fulfill({ response });
        firstPollFulfilled.resolve();
        return;
      }
      if (jobPollCount === 2) {
        secondPollArrived.resolve();
        await allowSecondPollFetch.promise;
        const response = await route.fetch();
        await route.fulfill({ response });
        secondPollFulfilled.resolve(await response.json());
        return;
      }
      throw new Error(`Unexpected processing poll ${jobPollCount}.`);
    } catch (error) {
      firstPollCaptured.reject(error);
      secondPollArrived.reject(error);
      firstPollFulfilled.reject(error);
      secondPollFulfilled.reject(error);
      throw error;
    }
  });

  try {
    await openAndPreviewConvert(page, fixture);
    const applyResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && requestPath(response.request()) === `/projects/${fixture.project.id}/assets/processing/convert/apply`
    ));
    await fixture.dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    const applyResponse = await applyResponsePromise;
    expect(applyResponse.status()).toBe(202);
    ({ jobId } = await applyResponse.json());
    await executionStarted.promise;
    const firstPoll = await firstPollCaptured.promise;
    expect(firstPoll.payload.job).toMatchObject({ id: jobId, state: 'running' });

    await fixture.dialog.getByRole('button', { name: 'Close Convert', exact: true }).click();
    await expect(fixture.dialog).toBeHidden();
    await page.getByRole('button', { name: 'Convert', exact: true }).click();
    await expect(fixture.dialog).toBeVisible();
    await secondPollArrived.promise;

    releaseExecution.resolve();
    await expect.poll(() => fixture.processingJobService.getJob(jobId)?.state).toBe('succeeded');
    allowSecondPollFetch.resolve();
    const secondPoll = await secondPollFulfilled.promise;
    expect(secondPoll.job).toMatchObject({ id: jobId, state: 'succeeded' });
    await expect(fixture.dialog.locator('[data-processing-status]')).toHaveText('Applied. Assets refreshed.');

    const scanPath = `/projects/${fixture.project.id}/scan`;
    const assetsPath = `/projects/${fixture.project.id}/assets`;
    const completionCounts = () => ({
      scan: requests.filter(({ method, path }) => method === 'POST' && path === scanPath).length,
      refresh: requests.filter(({ method, path, resourceType }) => (
        method === 'GET' && path === assetsPath && resourceType === 'fetch'
      )).length,
      cancel: requests.filter(({ method, path }) => (
        method === 'POST' && path === `/processing/jobs/${jobId}/cancel`
      )).length,
    });
    expect(completionCounts()).toEqual({ scan: 1, refresh: 1, cancel: 0 });

    releaseFirstPoll.resolve();
    await firstPollFulfilled.promise;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
    expect(jobPollCount).toBe(2);
    expect(completionCounts()).toEqual({ scan: 1, refresh: 1, cancel: 0 });
    expect(fixture.executionCalls).toHaveLength(1);
    expect(await processingState(page)).toMatchObject({
      busy: false,
      jobId: null,
      polling: false,
      timer: false,
      submission: null,
    });
  } finally {
    releaseExecution.resolve();
    allowSecondPollFetch.resolve();
    releaseFirstPoll.resolve();
    await page.unroute('**/processing/jobs/*').catch(() => {});
    await fixture.close();
  }
});
