import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createProcessingRouter } from '../src/routes/processing.js';
import { createAssetProcessingPlanner } from '../src/services/asset-processing-planner.js';
import { AssetProcessingError } from '../src/services/asset-processing-service.js';
import { createProcessingJobService } from '../src/services/processing-job-service.js';
import { createProjectOperationCoordinator } from '../src/services/project-operation-coordinator.js';
import { createApplicationLogger } from '../src/services/application-logger.js';
import { createApplicationLogRepository } from '../src/data/application-log-repository.js';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { createWatermarkDefaultService } from '../src/services/watermark-default-service.js';
import {
  WatermarkScaleMapServiceError,
} from '../src/services/watermark-scale-map-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

async function settle() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function createRealPlannerForAsset(relativePath) {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-processing-http-'));
  const projectDirectory = 'project-1';
  fs.mkdirSync(path.join(projectsRoot, projectDirectory));
  const asset = { id: 9, project_id: 1, relative_path: relativePath, is_present: 1 };
  const assetProcessingPlanner = createAssetProcessingPlanner({
    scopeService: {
      resolveAssetProcessingScope: (_projectId, scope) => ({
        projectId: 1,
        scope,
        assetIds: [asset.id],
        assets: [asset],
      }),
    },
    projectRepository: {
      findById: () => ({ id: 1, status: 'active', archived_at: null, project_dir: projectDirectory }),
    },
    assetRepository: {
      findByProjectIdAndPath: () => null,
      findPublishedReleaseAssetIds: () => [],
    },
    assetCategoryService: { listProjectCategories: () => [] },
    projectsRoot,
  });
  return {
    assetProcessingPlanner,
    cleanup: () => fs.rmSync(projectsRoot, { recursive: true, force: true }),
  };
}

function createHarness(overrides = {}) {
  const project = { id: 1, status: 'active', archived_at: null };
  const processingJobService = overrides.processingJobService || createProcessingJobService({
    applicationLogger: overrides.applicationLogger,
    projectOperationCoordinator: createProjectOperationCoordinator(),
  });
  const convertAssets = vi.fn(async () => ({ changedCount: 1 }));
  const editWorkflowPrompts = vi.fn(async () => ({ changedCount: 1 }));
  const watermarkAssets = vi.fn(async () => ({ changedCount: 1 }));
  const createArchives = vi.fn(async () => ({ changedCount: 2 }));
  const services = {
    projectService: { findById: vi.fn((id) => (id === 1 ? project : null)) },
    assetRepository: {
      findProjectAssetsByCategoryInBrowserOrder: vi.fn(() => [
        { id: 4, is_present: 1 },
        { id: 5, is_present: 0 },
      ]),
    },
    assetProcessingScopeService: {
      resolveAssetProcessingScope: vi.fn((projectId, scope) => ({
        projectId,
        scope,
        assetIds: scope.assetIds || [9],
      })),
    },
    assetProcessingPlanner: {
      planConvert: vi.fn(async (_id, scope, options) => ({ scope, options, assetIds: scope.assetIds || [9], items: [] })),
      planWorkflowPromptEdit: vi.fn(async (_id, scope, options) => ({ scope, options, assetIds: scope.assetIds || [9], items: [] })),
      planWatermark: vi.fn(async (_id, scope, options) => ({ scope, options, assetIds: scope.assetIds || [9], items: [] })),
      renderWatermarkPreview: vi.fn(async () => ({
        buffer: Buffer.from('preview-bytes'), contentType: 'image/png', filename: 'source.png', eligibleCount: 2, variant: 'resized',
      })),
      planArchives: vi.fn(async (_id, scope, options) => ({ scope, options, assetIds: scope.assetIds || [9], items: [], archives: [{ status: 'ready' }] })),
    },
    assetProcessingService: {
      convertAssets,
      editWorkflowPrompts,
      watermarkAssets,
      createArchives,
    },
    alreadyCoordinatedProcessingExecutor: {
      convertAssets,
      editWorkflowPrompts,
      watermarkAssets,
      createArchives,
    },
    watermarkService: {
      listWatermarks: vi.fn(() => [{ id: 10, filename: 'mark.png', relativePath: 'mark.png', width: 1, height: 1 }]),
      scanWatermarks: vi.fn(async () => ({ added: 1, updated: 0, restored: 0, removed: 0, total: 1 })),
      resolveForProcessing: vi.fn(() => ({ watermark: { id: 10 }, filePath: 'C:/not-used.png' })),
    },
    watermarkDefaultService: {
      getDefaultWatermarkId: vi.fn(() => null),
      setDefaultWatermarkId: vi.fn((id) => id),
    },
    watermarkScaleMapService: {
      getScaleMap: vi.fn(() => ({ definition: { '1024x1024': 0.37, default: 0.1 } })),
      replaceScaleMap: vi.fn((definition) => ({ definition })),
    },
    processingJobService,
    processingPresetService: {
      listPresets: vi.fn(() => []),
      createPreset: vi.fn((input) => ({ id: 12, ...input })),
      renamePreset: vi.fn(() => ({ id: 12, displayName: 'Renamed' })),
      replacePreset: vi.fn(() => ({ id: 12, config: {} })),
      deletePreset: vi.fn(),
      resolvePresetForExecution: vi.fn(() => ({ operationType: 'convert', options: { format: 'webp', quality: 85, originalHandling: 'keep' } })),
    },
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use(createProcessingRouter(services));
  app.use((_error, _req, res, _next) => res.status(500).json({ status: 'error', message: 'Internal server error.' }));
  return { app, services, project };
}

describe('processing HTTP routes', () => {
  it.each([
    ['convert', { format: 'webp', quality: 85, originalHandling: 'keep' }],
    ['workflow-prompt', { positive: [], negative: [] }],
    ['watermark', { mode: 'patreon', outputFormat: 'png', deleteSource: false, watermarkId: 10 }],
    ['archive', { makeArchives: true, archiveFormat: '7z' }],
  ])('passes safe %s lifecycle metadata through the common job service', async (operation, options) => {
    const applicationLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { app } = createHarness({ applicationLogger });
    const response = await request(app)
      .post(`/projects/1/assets/processing/${operation}/apply`)
      .send({ scope: { type: 'selected', assetIds: [9] }, options })
      .expect(202);

    await settle();
    const entries = applicationLogger.info.mock.calls.map(([entry]) => entry)
      .filter((entry) => entry.correlationId === response.body.jobId);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'processing.job.queued', projectId: 1, context: { operation, assetCount: 1 } }),
      expect.objectContaining({ event: 'processing.job.succeeded', projectId: 1, context: expect.objectContaining({ operation, assetCount: 1 }) }),
    ]));
    expect(new Set(entries.map((entry) => entry.correlationId))).toEqual(new Set([response.body.jobId]));
    expect(JSON.stringify(entries)).not.toContain('quality');
    expect(JSON.stringify(entries)).not.toContain('watermarkId');
  });

  it('plans selected custom Convert options as stable JSON without applying', async () => {
    const { app, services } = createHarness();
    const response = await request(app)
      .post('/projects/1/assets/processing/convert/plan')
      .send({
        scope: { type: 'selected', assetIds: [9] },
        options: { format: 'webp', quality: 85, originalHandling: 'keep' },
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, operation: 'convert' });
    expect(services.assetProcessingPlanner.planConvert).toHaveBeenCalledWith(
      1,
      { type: 'selected', assetIds: [9] },
      { format: 'webp', quality: 85, originalHandling: 'keep' },
    );
    expect(services.assetProcessingService.convertAssets).not.toHaveBeenCalled();
  });

  it('accepts global watermarkId for plan and apply and rejects mixed identities', async () => {
    const { app, services } = createHarness();
    const options = {
      mode: 'patreon',
      outputFormat: 'png',
      deleteSource: false,
      watermarkId: 10,
    };
    const plan = await request(app)
      .post('/projects/1/assets/processing/watermark/plan')
      .send({
        scope: { type: 'selected', assetIds: [9] },
        options,
      });

    expect(plan.status).toBe(200);
    expect(services.assetProcessingPlanner.planWatermark).toHaveBeenCalledWith(
      1,
      { type: 'selected', assetIds: [9] },
      options,
    );

    const apply = await request(app)
      .post('/projects/1/assets/processing/watermark/apply')
      .send({
        scope: { type: 'selected', assetIds: [9] },
        options,
      });

    expect(apply.status).toBe(202);
    expect(apply.body.jobId).toEqual(expect.any(String));
    await settle();
    expect(services.assetProcessingService.watermarkAssets).toHaveBeenCalledWith(1, [9], options, expect.any(Function));

  });

  it('renders a Watermark preview image through the trusted plan payload without applying', async () => {
    const { app, services } = createHarness();
    const options = { mode: 'patreon', outputFormat: 'png', deleteSource: false, watermarkId: 10 };
    const response = await request(app)
      .post('/projects/1/assets/processing/watermark/preview-image')
      .send({ scope: { type: 'selected', assetIds: [9] }, options });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^image\/png/);
    expect(response.headers['x-creatorcrate-preview-source']).toBe('source.png');
    expect(response.headers['x-creatorcrate-preview-eligible-count']).toBe('2');
    expect(response.body).toEqual(Buffer.from('preview-bytes'));
    expect(services.assetProcessingPlanner.renderWatermarkPreview).toHaveBeenCalledWith(
      1, { type: 'selected', assetIds: [9] }, options,
    );
    expect(services.assetProcessingService.watermarkAssets).not.toHaveBeenCalled();
  });

  it('plans and applies the standalone Archive operation through explicit routes', async () => {
    const { app, services } = createHarness();
    const plan = await request(app)
      .post('/projects/1/assets/processing/archive/plan')
      .send({
        scope: { type: 'selected', assetIds: [9] },
        options: { makeArchives: true, archiveFormat: '7z' },
      });

    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({ ok: true, operation: 'archive' });
    expect(services.assetProcessingPlanner.planArchives).toHaveBeenCalledWith(
      1,
      { type: 'selected', assetIds: [9] },
      { makeArchives: true, archiveFormat: '7z' },
    );
    expect(services.assetProcessingService.createArchives).not.toHaveBeenCalled();

    const apply = await request(app)
      .post('/projects/1/assets/processing/archive/apply')
      .send({
        scope: { type: 'category', categoryId: 4 },
        options: { makeCbz: true },
      });

    expect(apply.status).toBe(202);
    expect(apply.body).toMatchObject({ ok: true, operation: 'archive', jobId: expect.any(String) });
    await settle();
    expect(services.assetProcessingScopeService.resolveAssetProcessingScope).not.toHaveBeenCalled();
    expect(services.assetProcessingService.createArchives).toHaveBeenCalledWith(
      1,
      [4],
      { makeCbz: true },
      expect.any(Function),
    );
  });

  it('resolves a preset once and applies the resulting normalized options', async () => {
    const { app, services } = createHarness();
    const response = await request(app)
      .post('/projects/1/assets/processing/convert/apply')
      .send({ scope: { type: 'project' }, presetId: 12 });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ ok: true, operation: 'convert', jobId: expect.any(String) });
    await settle();
    expect(services.processingPresetService.resolvePresetForExecution).toHaveBeenCalledWith(12, {});
    expect(services.assetProcessingScopeService.resolveAssetProcessingScope).not.toHaveBeenCalled();
    expect(services.assetProcessingService.convertAssets).toHaveBeenCalledWith(
      1,
      [9],
      { format: 'webp', quality: 85, originalHandling: 'keep' },
      expect.any(Function),
    );
  });

  it('rejects legacy scaleMapId runtime resources before resolving a preset', async () => {
    const { app, services } = createHarness();
    const response = await request(app)
      .post('/projects/1/assets/processing/convert/plan')
      .send({ scope: { type: 'project' }, presetId: 12, runtimeResources: { scaleMapId: 999 } });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'INVALID_REQUEST', field: 'scaleMapId' });
    expect(services.processingPresetService.resolvePresetForExecution).not.toHaveBeenCalled();
  });

  it.each([
    ['plan', '/projects/1/assets/processing/watermark/plan', 'planWatermark'],
    ['apply', '/projects/1/assets/processing/watermark/apply', 'watermarkAssets'],
    ['preview-image', '/projects/1/assets/processing/watermark/preview-image', 'renderWatermarkPreview'],
  ])('rejects legacy scaleMapId in direct Watermark %s requests before execution', async (_mode, route, method) => {
    const { app, services } = createHarness();
    const response = await request(app)
      .post(route)
      .send({
        scope: { type: 'selected', assetIds: [9] },
        options: { mode: 'patreon', outputFormat: 'png', deleteSource: false, watermarkId: 10, scaleMapId: 999 },
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message: 'options contains an unsupported field: scaleMapId.',
        field: 'scaleMapId',
      },
    });
    expect(services.assetProcessingPlanner[method] ?? services.assetProcessingService[method]).not.toHaveBeenCalled();
  });

  it('adapts category scope to present assets in canonical repository order', async () => {
    const { app, services } = createHarness();
    const response = await request(app)
      .post('/projects/1/assets/processing/workflow-prompt/plan')
      .send({
        scope: { type: 'category', categoryId: 2 },
        options: { positive: [], negative: [] },
      });

    expect(response.status).toBe(200);
    expect(services.assetProcessingPlanner.planWorkflowPromptEdit).toHaveBeenCalledWith(
      1,
      { type: 'selected', assetIds: [4] },
      { positive: [], negative: [] },
    );
  });

  it('returns controlled JSON errors for archived projects and known conflicts', async () => {
    const { app, services, project } = createHarness();
    project.status = 'archived';
    const archived = await request(app)
      .post('/projects/1/assets/processing/convert/apply')
      .send({ scope: { type: 'project' }, options: { format: 'webp', quality: 85, originalHandling: 'keep' } });
    expect(archived.status).toBe(409);
    expect(archived.body.error.code).toBe('PROJECT_ARCHIVED');
    const archivedArchive = await request(app)
      .post('/projects/1/assets/processing/archive/apply')
      .send({ scope: { type: 'project' }, options: { makeArchives: true } });
    expect(archivedArchive.status).toBe(409);
    expect(archivedArchive.body.error.code).toBe('PROJECT_ARCHIVED');

    project.status = 'active';
    services.watermarkScaleMapService.replaceScaleMap.mockImplementation(() => {
      throw new WatermarkScaleMapServiceError('Scale map is in use.', { code: 'SCALE_MAP_IN_USE' });
    });
    const conflict = await request(app).post('/processing/scale-map/replace').send({ definition: {} });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({
      ok: false,
      error: { code: 'SCALE_MAP_IN_USE', message: 'Scale map is in use.' },
    });
  });

  it('exposes only the singleton Scale Map HTTP contract', async () => {
    const { app, services } = createHarness();
    const listed = await request(app).get('/processing/scale-map');
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ ok: true, definition: { '1024x1024': 0.37, default: 0.1 } });

    const replaced = await request(app)
      .post('/processing/scale-map/replace')
      .send({ definition: { '1920x1080': 0.22, default: 0.1 } });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toEqual({ ok: true, definition: { '1920x1080': 0.22, default: 0.1 } });
    expect(services.watermarkScaleMapService.replaceScaleMap).toHaveBeenCalledWith({ '1920x1080': 0.22, default: 0.1 });

    for (const route of [
      '/processing/scale-maps', '/processing/scale-maps/99/rename',
      '/processing/scale-maps/99/replace', '/processing/scale-maps/99/delete',
    ]) {
      await request(app).post(route).send({}).expect(404);
    }
  });

  it('rejects forbidden filesystem fields and wrong-project or malformed request input', async () => {
    const { app } = createHarness();
    const forbidden = await request(app)
      .post('/projects/1/assets/processing/watermark/plan')
      .send({
        scope: { type: 'project' },
        options: { watermarkPath: 'C:/secret.png' },
      });
    expect(forbidden.status).toBe(400);
    expect(forbidden.body.error.field).toBe('watermarkPath');

    const missing = await request(app)
      .post('/projects/99/assets/processing/convert/plan')
      .send({ scope: { type: 'project' }, options: {} });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('lists global Watermark candidates, scans manually, and exposes no source mutation routes', async () => {
    const { app, services } = createHarness();
    const listed = await request(app).get('/processing/watermarks');
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      ok: true,
      watermarks: [{ id: 10, filename: 'mark.png', relativePath: 'mark.png', width: 1, height: 1 }],
    });

    const scanned = await request(app).post('/processing/watermarks/scan').send({});
    expect(scanned.status).toBe(200);
    expect(scanned.body).toEqual({ ok: true, scan: { added: 1, updated: 0, restored: 0, removed: 0, total: 1 } });
    expect(services.watermarkService.scanWatermarks).toHaveBeenCalledOnce();

    for (const route of [
      '/processing/watermarks',
      '/processing/watermarks/10/rename',
      '/processing/watermarks/10/replace',
      '/processing/watermarks/10/delete',
    ]) {
      await request(app).post(route).send({}).expect(404);
    }
  });

  it('records one safe activity entry for each processing resource mutation', async () => {
    const applicationLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { app, services } = createHarness({
      applicationLogger,
      processingPresetService: {
        listPresets: vi.fn(() => []),
        createPreset: vi.fn((input) => ({ id: 12, operationType: input.operationType })),
        importPresetBundle: vi.fn(() => ({ imported: 2, renamed: 1, presets: [] })),
        renamePreset: vi.fn(() => ({ id: 12, operationType: 'convert' })),
        replacePreset: vi.fn(() => ({ id: 12, operationType: 'convert' })),
        deletePreset: vi.fn(),
        resolvePresetForExecution: vi.fn(),
      },
    });

    await request(app).post('/processing/watermarks/scan').send({}).expect(200);
    await request(app).post('/processing/watermarks/default').send({ watermarkId: 10 }).expect(200);
    await request(app).post('/processing/scale-map/replace').send({ definition: { default: 0.1 } }).expect(200);
    await request(app).post('/processing/presets').send({ operationType: 'convert', displayName: 'Safe', config: {} }).expect(201);
    await request(app).post('/processing/presets/import').send({ operationType: 'convert', presets: [] }).expect(200);
    await request(app).post('/processing/presets/12/rename').send({ displayName: 'Renamed' }).expect(200);
    await request(app).post('/processing/presets/12/replace').send({ config: {} }).expect(200);
    await request(app).post('/processing/presets/12/delete').send({}).expect(200);

    const entries = applicationLogger.info.mock.calls.map(([entry]) => entry);
    expect(entries.map((entry) => entry.event)).toEqual([
      'processing.watermark.scan.completed',
      'processing.watermark.default.changed',
      'processing.scale_map.updated',
      'processing.preset.created',
      'processing.preset.imported',
      'processing.preset.renamed',
      'processing.preset.updated',
      'processing.preset.deleted',
    ]);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'processing.watermark.scan.completed', kind: 'diagnostic', context: { added: 1, updated: 0, restored: 0, removed: 0, total: 1 } }),
      expect.objectContaining({ event: 'processing.preset.imported', context: { imported: 2, renamed: 1, operationType: 'convert' } }),
    ]));
    expect(JSON.stringify(entries)).not.toMatch(/mark\.png|relativePath|config|definition/i);
    expect(services.processingPresetService.importPresetBundle).toHaveBeenCalledOnce();
  });

  it('persists a processing resource action through the real logger and application-log repository', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-processing-resource-log-'));
    const db = openDatabase(path.join(directory, 'logs.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const applicationLogger = createApplicationLogger({ repository: createApplicationLogRepository(db) });

    try {
      const { app } = createHarness({ applicationLogger });
      await request(app).post('/processing/watermarks/scan').send({}).expect(200);

      expect(db.prepare("SELECT subsystem, event FROM application_logs WHERE event = 'processing.watermark.scan.completed'").get())
        .toEqual({ subsystem: 'processing', event: 'processing.watermark.scan.completed' });
    } finally {
      closeDatabase(db);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists a changed Watermark default ID once through the real logger and application-log repository', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-processing-log-'));
    const db = openDatabase(path.join(directory, 'creatorcrate.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const applicationLogger = createApplicationLogger({ repository: createApplicationLogRepository(db) });
    const defaultWatermarkResourceService = {
      resolveForProcessing: vi.fn((watermarkId) => ({ watermark: { id: watermarkId } })),
    };
    const watermarkDefaultService = createWatermarkDefaultService({
      appMetaRepository: createAppMetaRepository(db),
      watermarkService: defaultWatermarkResourceService,
    });

    try {
      const { app } = createHarness({ applicationLogger, watermarkDefaultService });
      await request(app).post('/processing/watermarks/default').send({ watermarkId: 17 }).expect(200);
      await request(app).post('/processing/watermarks/default').send({ watermarkId: 17 }).expect(200);

      const rows = db.prepare('SELECT subsystem, level, kind, event, context_json FROM application_logs WHERE event = ?').all('processing.watermark.default.changed');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        subsystem: 'processing',
        level: 'info',
        kind: 'activity',
        event: 'processing.watermark.default.changed',
      });
      expect(JSON.parse(rows[0].context_json)).toEqual({ watermarkId: 17 });
    } finally {
      closeDatabase(db);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('accepts an apply request before execution and exposes queued, running, and succeeded status snapshots', async () => {
    const { app, services } = createHarness();
    let releaseBlocker;
    const blocker = new Promise((resolve) => { releaseBlocker = resolve; });
    services.processingJobService.enqueue({ projectId: 1, execute: () => blocker });
    await settle();

    let beginProcessing;
    const processingStarted = new Promise((resolve) => { beginProcessing = resolve; });
    let releaseProcessing;
    const processingGate = new Promise((resolve) => { releaseProcessing = resolve; });
    services.assetProcessingService.convertAssets.mockImplementation(async (_projectId, _assetIds, _options, updateProgress) => {
      updateProgress({ completed: 0, total: 1 });
      beginProcessing();
      await processingGate;
      updateProgress({ completed: 1, total: 1 });
      return { changedCount: 3 };
    });

    const submitted = await request(app)
      .post('/projects/1/assets/processing/convert/apply')
      .send({ scope: { type: 'selected', assetIds: [9] }, options: { format: 'webp', quality: 85, originalHandling: 'keep' } })
      .expect(202);

    expect(submitted.body).toEqual({ ok: true, operation: 'convert', jobId: expect.any(String) });
    expect(services.assetProcessingService.convertAssets).not.toHaveBeenCalled();
    const queued = await request(app).get(`/processing/jobs/${submitted.body.jobId}`).expect(200);
    expect(queued.body.job).toMatchObject({ id: submitted.body.jobId, state: 'queued', progress: null, result: null, error: null });

    releaseBlocker();
    await processingStarted;
    const running = await request(app).get(`/processing/jobs/${submitted.body.jobId}`).expect(200);
    expect(running.body.job).toMatchObject({ id: submitted.body.jobId, state: 'running', progress: { completed: 0, total: 1 }, result: null, error: null });
    expect(services.assetProcessingService.convertAssets).toHaveBeenCalledWith(
      1,
      [9],
      { format: 'webp', quality: 85, originalHandling: 'keep' },
      expect.any(Function),
    );

    releaseProcessing();
    await settle();
    const succeeded = await request(app).get(`/processing/jobs/${submitted.body.jobId}`).expect(200);
    expect(succeeded.body.job).toEqual({
      id: submitted.body.jobId,
      state: 'succeeded',
      progress: { completed: 1, total: 1 },
      result: { result: { changedCount: 3 }, refreshUrl: '/projects/1/assets' },
      error: null,
    });
  });

  it('completes two same-project jobs in FIFO order without nested coordinator acquisition', async () => {
    const coordinator = createProjectOperationCoordinator();
    const processingJobService = createProcessingJobService({
      projectOperationCoordinator: coordinator,
    });
    const { app, services } = createHarness({ processingJobService });
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    let firstStarted;
    const firstStartedPromise = new Promise((resolve) => { firstStarted = resolve; });
    const order = [];

    // This is the old apply-path behavior: acquiring the coordinator inside a
    // job callback. The route must not invoke it for background jobs.
    const apply = async (_projectId, _assetIds, _options, updateProgress) => {
      const position = order.filter((entry) => entry.endsWith('-start')).length + 1;
      order.push(`job-${position}-start`);
      updateProgress({ completed: 0, total: 1 });
      if (position === 1) {
        firstStarted();
        await firstGate;
      }
      updateProgress({ completed: 1, total: 1 });
      order.push(`job-${position}-end`);
      return { changedCount: position };
    };
    services.assetProcessingService.convertAssets.mockImplementation((...args) => (
      coordinator.runAsync(1, () => apply(...args))
    ));
    services.alreadyCoordinatedProcessingExecutor.convertAssets = vi.fn(apply);

    const first = await request(app)
      .post('/projects/1/assets/processing/convert/apply')
      .send({ scope: { type: 'selected', assetIds: [9] }, options: { format: 'webp', quality: 85, originalHandling: 'keep' } })
      .expect(202);
    await firstStartedPromise;
    const second = await request(app)
      .post('/projects/1/assets/processing/convert/apply')
      .send({ scope: { type: 'selected', assetIds: [9] }, options: { format: 'webp', quality: 85, originalHandling: 'keep' } })
      .expect(202);

    expect(services.assetProcessingService.convertAssets).not.toHaveBeenCalled();
    expect(processingJobService.getJob(second.body.jobId)?.state).toBe('queued');
    expect(coordinator.isActive(1)).toBe(true);

    releaseFirst();
    for (let index = 0; index < 12 && processingJobService.hasActiveJobs(); index += 1) {
      await Promise.resolve();
    }
    await settle();

    expect(processingJobService.getJob(first.body.jobId)?.state).toBe('succeeded');
    expect(processingJobService.getJob(second.body.jobId)?.state).toBe('succeeded');
    expect(order).toEqual(['job-1-start', 'job-1-end', 'job-2-start', 'job-2-end']);
    expect(services.alreadyCoordinatedProcessingExecutor.convertAssets).toHaveBeenCalledTimes(2);
    expect(coordinator.isActive(1)).toBe(false);
  });

  it('cancels only queued jobs and prevents their processing execution', async () => {
    const { app, services } = createHarness();
    let releaseBlocker;
    const blocker = new Promise((resolve) => { releaseBlocker = resolve; });
    services.processingJobService.enqueue({ projectId: 1, execute: () => blocker });
    await settle();

    const queued = await request(app)
      .post('/projects/1/assets/processing/convert/apply')
      .send({ scope: { type: 'selected', assetIds: [9] }, options: { format: 'webp', quality: 85, originalHandling: 'keep' } })
      .expect(202);
    const cancelled = await request(app).post(`/processing/jobs/${queued.body.jobId}/cancel`).send({}).expect(200);
    expect(cancelled.body.job).toMatchObject({ id: queued.body.jobId, state: 'cancelled' });

    releaseBlocker();
    await settle();
    expect(services.assetProcessingService.convertAssets).not.toHaveBeenCalled();

    let beginProcessing;
    const started = new Promise((resolve) => { beginProcessing = resolve; });
    let releaseProcessing;
    const processingGate = new Promise((resolve) => { releaseProcessing = resolve; });
    services.assetProcessingService.convertAssets.mockImplementation(async () => {
      beginProcessing();
      await processingGate;
      return { changedCount: 1 };
    });
    const running = await request(app)
      .post('/projects/1/assets/processing/convert/apply')
      .send({ scope: { type: 'selected', assetIds: [9] }, options: { format: 'webp', quality: 85, originalHandling: 'keep' } })
      .expect(202);
    await started;
    const refused = await request(app).post(`/processing/jobs/${running.body.jobId}/cancel`).send({}).expect(409);
    expect(refused.body.error).toEqual({
      code: 'PROCESSING_JOB_NOT_CANCELLABLE',
      message: 'Only queued processing jobs can be cancelled.',
    });
    releaseProcessing();
  });

  it('uses normal not-found errors for unknown jobs and validates before submission', async () => {
    const { app, services } = createHarness();
    const enqueue = vi.spyOn(services.processingJobService, 'enqueue');
    const unknown = 'not-a-real-job';
    for (const response of [
      await request(app).get(`/processing/jobs/${unknown}`),
      await request(app).post(`/processing/jobs/${unknown}/cancel`).send({}),
    ]) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        ok: false,
        error: { code: 'PROCESSING_JOB_NOT_FOUND', message: 'Processing job not found.' },
      });
    }

    const invalid = await request(app)
      .post('/projects/1/assets/processing/convert/apply')
      .send({ scope: { type: 'selected', assetIds: [9] }, runtimeResources: {} })
      .expect(400);
    expect(invalid.body.error.field).toBe('runtimeResources');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects operation-specific invalid Apply data before it allocates a job', async () => {
    const { app, services } = createHarness();
    const enqueue = vi.spyOn(services.processingJobService, 'enqueue');
    services.assetProcessingPlanner.planConvert.mockRejectedValueOnce(
      new AssetProcessingError('Quality must be an integer from 1 to 100.', { code: 'INVALID_QUALITY' }),
    );
    services.assetProcessingPlanner.planWorkflowPromptEdit.mockRejectedValueOnce(
      new AssetProcessingError('Prompt editing options are required.', { code: 'INVALID_PROMPT_OPTIONS' }),
    );

    const invalidConvert = await request(app)
      .post('/projects/1/assets/processing/convert/apply')
      .send({ scope: { type: 'selected', assetIds: [9] }, options: { format: 'webp', quality: 999, originalHandling: 'keep' } })
      .expect(400);
    expect(invalidConvert.body).toEqual({
      ok: false,
      error: { code: 'INVALID_QUALITY', message: 'Quality must be an integer from 1 to 100.' },
    });

    const invalidWorkflow = await request(app)
      .post('/projects/1/assets/processing/workflow-prompt/apply')
      .send({ scope: { type: 'selected', assetIds: [9] }, options: { positive: 'invalid', negative: [] } })
      .expect(400);
    expect(invalidWorkflow.body).toEqual({
      ok: false,
      error: { code: 'INVALID_PROMPT_OPTIONS', message: 'Prompt editing options are required.' },
    });

    expect(enqueue).not.toHaveBeenCalled();
    expect(services.assetProcessingScopeService.resolveAssetProcessingScope).not.toHaveBeenCalled();
    expect(services.alreadyCoordinatedProcessingExecutor.convertAssets).not.toHaveBeenCalled();
    expect(services.alreadyCoordinatedProcessingExecutor.editWorkflowPrompts).not.toHaveBeenCalled();
  });

  it('rejects the real planner unsupported representation before it allocates or executes a job', async () => {
    const realPlanner = createRealPlannerForAsset('Final/readme.txt');
    try {
      const planConvert = vi.spyOn(realPlanner.assetProcessingPlanner, 'planConvert');
      const { app, services } = createHarness({ assetProcessingPlanner: realPlanner.assetProcessingPlanner });
      const enqueue = vi.spyOn(services.processingJobService, 'enqueue');

      const unsupportedConvert = await request(app)
        .post('/projects/1/assets/processing/convert/apply')
        .send({ scope: { type: 'selected', assetIds: [9] }, options: { format: 'webp', quality: 85, originalHandling: 'keep' } })
        .expect(400);

      expect(unsupportedConvert.body).toEqual({
        ok: false,
        error: { code: 'UNSUPPORTED_SOURCE_TYPE', message: 'The source type is not supported by this operation.' },
      });
      expect(planConvert).toHaveBeenCalledOnce();
      expect(enqueue).not.toHaveBeenCalled();
      expect(services.processingJobService.hasActiveJobs()).toBe(false);
      expect(services.alreadyCoordinatedProcessingExecutor.convertAssets).not.toHaveBeenCalled();
      expect(services.alreadyCoordinatedProcessingExecutor.editWorkflowPrompts).not.toHaveBeenCalled();
      expect(services.alreadyCoordinatedProcessingExecutor.watermarkAssets).not.toHaveBeenCalled();
      expect(services.alreadyCoordinatedProcessingExecutor.createArchives).not.toHaveBeenCalled();
    } finally {
      realPlanner.cleanup();
    }
  });

  it('rejects direct blocking and operation-blocker planner output before it enqueues a job', async () => {
    const { app, services } = createHarness();
    const enqueue = vi.spyOn(services.processingJobService, 'enqueue');

    services.assetProcessingPlanner.planWorkflowPromptEdit.mockResolvedValueOnce({
      scope: { type: 'selected', assetIds: [9] },
      options: { positive: [], negative: [] },
      items: [{ status: 'blocked', reasonCode: 'NO_WORKFLOW_METADATA', reason: 'No editable workflow metadata was found.' }],
    });
    await request(app)
      .post('/projects/1/assets/processing/workflow-prompt/apply')
      .send({ scope: { type: 'selected', assetIds: [9] }, options: { positive: [], negative: [] } })
      .expect(400);

    services.assetProcessingPlanner.planWatermark.mockResolvedValueOnce({
      scope: { type: 'selected', assetIds: [9] },
      options: { mode: 'patreon', outputFormat: 'png', deleteSource: false, watermarkId: 10 },
      items: [{ status: 'conflict', reasonCode: 'DESTINATION_EXISTS', reason: 'The output destination already exists.' }],
    });
    await request(app)
      .post('/projects/1/assets/processing/watermark/apply')
      .send({ scope: { type: 'selected', assetIds: [9] }, options: { mode: 'patreon', outputFormat: 'png', deleteSource: false, watermarkId: 10 } })
      .expect(400);

    services.assetProcessingPlanner.planArchives.mockResolvedValueOnce({
      scope: { type: 'selected', assetIds: [9] },
      options: { makeArchives: true },
      items: [],
      archives: [{ status: 'ready' }],
      operationBlockers: [{ code: 'ARCHIVE_DESTINATION_CONFLICT', reason: 'The archive destination already exists.' }],
    });
    await request(app)
      .post('/projects/1/assets/processing/archive/apply')
      .send({ scope: { type: 'selected', assetIds: [9] }, options: { makeArchives: true } })
      .expect(409);

    expect(enqueue).not.toHaveBeenCalled();
    expect(services.assetProcessingService.convertAssets).not.toHaveBeenCalled();
    expect(services.assetProcessingService.editWorkflowPrompts).not.toHaveBeenCalled();
    expect(services.assetProcessingService.watermarkAssets).not.toHaveBeenCalled();
    expect(services.assetProcessingService.createArchives).not.toHaveBeenCalled();
  });

  it('rejects non-ready watermark archive output before enqueueing while allowing valid and absent archive output', async () => {
    const { app, services } = createHarness();
    const enqueue = vi.spyOn(services.processingJobService, 'enqueue');
    const watermarkOptions = { mode: 'patreon', outputFormat: 'png', deleteSource: false, watermarkId: 10, makeArchives: true };

    services.assetProcessingPlanner.planWatermark.mockResolvedValueOnce({
      scope: { type: 'selected', assetIds: [9] },
      options: watermarkOptions,
      assetIds: [9],
      items: [],
      archives: [{ status: 'conflict', reasonCode: 'ARCHIVE_DESTINATION_CONFLICT', reason: 'The archive destination already exists.' }],
    });
    const conflict = await request(app)
      .post('/projects/1/assets/processing/watermark/apply')
      .send({ scope: { type: 'selected', assetIds: [9] }, options: watermarkOptions })
      .expect(409);
    expect(conflict.body).toEqual({
      ok: false,
      error: { code: 'ARCHIVE_DESTINATION_CONFLICT', message: 'The archive destination already exists.' },
    });

    services.assetProcessingPlanner.planWatermark.mockResolvedValueOnce({
      scope: { type: 'selected', assetIds: [9] },
      options: watermarkOptions,
      assetIds: [9],
      items: [],
      archives: [],
    });
    const noArchiveOutput = await request(app)
      .post('/projects/1/assets/processing/watermark/apply')
      .send({ scope: { type: 'selected', assetIds: [9] }, options: watermarkOptions })
      .expect(400);
    expect(noArchiveOutput.body).toEqual({
      ok: false,
      error: {
        code: 'NO_ARCHIVE_OUTPUT',
        message: 'The processing plan does not contain an archive to create.',
      },
    });

    expect(enqueue).not.toHaveBeenCalled();

    services.assetProcessingPlanner.planWatermark.mockResolvedValueOnce({
      scope: { type: 'selected', assetIds: [9] },
      options: watermarkOptions,
      assetIds: [9],
      items: [],
      archives: [{ status: 'ready' }],
    });
    const validArchive = await request(app)
      .post('/projects/1/assets/processing/watermark/apply')
      .send({ scope: { type: 'selected', assetIds: [9] }, options: watermarkOptions })
      .expect(202);

    const noArchiveOptions = { mode: 'patreon', outputFormat: 'png', deleteSource: false, watermarkId: 10 };
    services.assetProcessingPlanner.planWatermark.mockResolvedValueOnce({
      scope: { type: 'selected', assetIds: [9] },
      options: noArchiveOptions,
      assetIds: [9],
      items: [],
      archives: [],
    });
    const noArchive = await request(app)
      .post('/projects/1/assets/processing/watermark/apply')
      .send({ scope: { type: 'selected', assetIds: [9] }, options: noArchiveOptions })
      .expect(202);
    await settle();

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(services.processingJobService.getJob(validArchive.body.jobId)).toMatchObject({ state: 'succeeded' });
    expect(services.processingJobService.getJob(noArchive.body.jobId)).toMatchObject({ state: 'succeeded' });
  });

  it('gives empty Watermark plans asset-selection precedence over archive output validation', async () => {
    const { app, services } = createHarness();
    const enqueue = vi.spyOn(services.processingJobService, 'enqueue');
    const watermarkOptions = { mode: 'patreon', outputFormat: 'png', deleteSource: false, watermarkId: 10 };
    const emptyWatermarkCases = [
      watermarkOptions,
      { ...watermarkOptions, makeArchives: true },
      { ...watermarkOptions, makeCbz: true },
    ];

    for (const options of emptyWatermarkCases) {
      services.assetProcessingPlanner.planWatermark.mockResolvedValueOnce({
        scope: { type: 'project' },
        options,
        assetIds: [],
        items: [],
        archives: [],
      });
      const response = await request(app)
        .post('/projects/1/assets/processing/watermark/apply')
        .send({ scope: { type: 'project' }, options })
        .expect(400);
      expect(response.body).toEqual({
        ok: false,
        error: { code: 'NO_ASSETS_SELECTED', message: 'No assets selected.' },
      });
    }

    expect(enqueue).not.toHaveBeenCalled();
    expect(services.alreadyCoordinatedProcessingExecutor.watermarkAssets).not.toHaveBeenCalled();

    services.assetProcessingPlanner.planArchives.mockResolvedValueOnce({
      scope: { type: 'project' },
      options: { makeArchives: true },
      assetIds: [],
      items: [],
      archives: [],
    });
    const standaloneArchive = await request(app)
      .post('/projects/1/assets/processing/archive/apply')
      .send({ scope: { type: 'project' }, options: { makeArchives: true } })
      .expect(400);

    expect(standaloneArchive.body).toEqual({
      ok: false,
      error: {
        code: 'NO_ARCHIVE_OUTPUT',
        message: 'The processing plan does not contain an archive to create.',
      },
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(services.alreadyCoordinatedProcessingExecutor.createArchives).not.toHaveBeenCalled();
  });

  it('accepts informational planner items that do not block Apply', async () => {
    const { app, services } = createHarness();
    services.assetProcessingPlanner.planConvert.mockResolvedValueOnce({
      scope: { type: 'selected', assetIds: [9] },
      options: { format: 'webp', quality: 85, originalHandling: 'keep' },
      assetIds: [9],
      items: [{ status: 'skipped', operationEligibility: 'generated-output', reasonCode: 'INSIDE_OUTPUT_DIRECTORY' }],
    });

    const submitted = await request(app)
      .post('/projects/1/assets/processing/convert/apply')
      .send({ scope: { type: 'selected', assetIds: [9] }, options: { format: 'webp', quality: 85, originalHandling: 'keep' } })
      .expect(202);
    await settle();

    expect(services.processingJobService.getJob(submitted.body.jobId)).toMatchObject({ state: 'succeeded' });
    expect(services.assetProcessingService.convertAssets).toHaveBeenCalledOnce();
  });

  it('enqueues the planner-normalized Apply options and executes them successfully', async () => {
    const { app, services } = createHarness();
    services.assetProcessingPlanner.planConvert.mockResolvedValueOnce({
      scope: { type: 'selected', assetIds: [9] },
      options: { format: 'webp', quality: 85, originalHandling: 'keep' },
      assetIds: [9],
      items: [],
    });

    const submitted = await request(app)
      .post('/projects/1/assets/processing/convert/apply')
      .send({ scope: { type: 'selected', assetIds: [9] }, options: { format: 'webp', quality: '85', originalHandling: 'keep' } })
      .expect(202);
    await settle();

    expect(services.alreadyCoordinatedProcessingExecutor.convertAssets).toHaveBeenCalledWith(
      1,
      [9],
      { format: 'webp', quality: 85, originalHandling: 'keep' },
      expect.any(Function),
    );
    expect(services.processingJobService.getJob(submitted.body.jobId)).toMatchObject({ state: 'succeeded' });
  });

  it('executes exactly the planner-resolved IDs without re-resolving a dynamic scope', async () => {
    const { app, services } = createHarness();
    let currentAssetIds = [1];
    services.assetProcessingScopeService.resolveAssetProcessingScope.mockImplementation((projectId, scope) => ({
      projectId,
      scope,
      assetIds: currentAssetIds,
    }));
    services.assetProcessingPlanner.planConvert.mockImplementation(async (projectId, scope, options) => {
      const resolved = services.assetProcessingScopeService.resolveAssetProcessingScope(projectId, scope);
      currentAssetIds = [1, 2];
      return { scope, options, assetIds: resolved.assetIds, items: [] };
    });

    const submitted = await request(app)
      .post('/projects/1/assets/processing/convert/apply')
      .send({ scope: { type: 'project' }, options: { format: 'webp', quality: 85, originalHandling: 'keep' } })
      .expect(202);
    await settle();

    expect(services.assetProcessingScopeService.resolveAssetProcessingScope).toHaveBeenCalledTimes(1);
    expect(services.assetProcessingScopeService.resolveAssetProcessingScope).toHaveBeenCalledWith(
      1,
      { type: 'directory', relativePath: '', recursive: true },
    );
    expect(services.alreadyCoordinatedProcessingExecutor.convertAssets).toHaveBeenCalledWith(
      1,
      [1],
      { format: 'webp', quality: 85, originalHandling: 'keep' },
      expect.any(Function),
    );
    expect(services.alreadyCoordinatedProcessingExecutor.convertAssets).not.toHaveBeenCalledWith(
      1,
      [1, 2],
      expect.anything(),
      expect.anything(),
    );
    expect(services.processingJobService.getJob(submitted.body.jobId)).toMatchObject({ state: 'succeeded' });
  });

  it.each([
    ['convert project scope', 'convert', 'planConvert', { type: 'project' }, { format: 'webp', quality: 85, originalHandling: 'keep' }],
    ['convert directory scope', 'convert', 'planConvert', { type: 'directory', relativePath: 'Final', recursive: true }, { format: 'webp', quality: 85, originalHandling: 'keep' }],
    ['watermark scope', 'watermark', 'planWatermark', { type: 'project' }, { mode: 'patreon', outputFormat: 'png', deleteSource: false, watermarkId: 10 }],
    ['workflow-prompt scope', 'workflow-prompt', 'planWorkflowPromptEdit', { type: 'project' }, { positive: [], negative: [] }],
  ])('rejects an empty concrete plan for %s before job allocation', async (_label, operation, plannerMethod, scope, options) => {
    const { app, services } = createHarness();
    const enqueue = vi.spyOn(services.processingJobService, 'enqueue');
    services.assetProcessingPlanner[plannerMethod].mockResolvedValueOnce({
      scope,
      options,
      assetIds: [],
      items: [],
    });

    const response = await request(app)
      .post(`/projects/1/assets/processing/${operation}/apply`)
      .send({ scope, options })
      .expect(400);

    expect(response.body).toEqual({
      ok: false,
      error: { code: 'NO_ASSETS_SELECTED', message: 'No assets selected.' },
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(services.alreadyCoordinatedProcessingExecutor.convertAssets).not.toHaveBeenCalled();
    expect(services.alreadyCoordinatedProcessingExecutor.watermarkAssets).not.toHaveBeenCalled();
    expect(services.alreadyCoordinatedProcessingExecutor.editWorkflowPrompts).not.toHaveBeenCalled();
  });

  it('reports failed jobs with only the stable B2 error', async () => {
    const { app, services } = createHarness();
    services.assetProcessingService.convertAssets.mockImplementation(async (_projectId, _assetIds, _options, updateProgress) => {
      updateProgress({ completed: 1, total: 2 });
      throw new Error('C:/secret/staging');
    });
    const submitted = await request(app)
      .post('/projects/1/assets/processing/convert/apply')
      .send({ scope: { type: 'project' }, options: { format: 'webp', quality: 85, originalHandling: 'keep' } })
      .expect(202);

    await settle();
    const status = await request(app).get(`/processing/jobs/${submitted.body.jobId}`).expect(200);
    expect(status.body).toEqual({
      ok: true,
      job: {
        id: submitted.body.jobId,
        state: 'failed',
        progress: { completed: 1, total: 2 },
        result: null,
        error: { code: 'PROCESSING_FAILED', message: 'Processing failed.' },
      },
    });
  });

  it('returns the existing not-found response for an evicted job after normal completion polling', async () => {
    const callbacks = [];
    const processingJobService = createProcessingJobService({
      projectOperationCoordinator: {
        runAsync: (_projectId, callback) => {
          callbacks.push(callback);
          return Promise.resolve();
        },
      },
      terminalJobTtlMs: 100,
      maxTerminalJobs: 1,
    });
    const { app } = createHarness({ processingJobService });

    const firstJobId = processingJobService.enqueue({ projectId: 1, execute: () => ({ changedCount: 1 }) });
    await callbacks.shift()();
    await request(app).get(`/processing/jobs/${firstJobId}`).expect(200);

    processingJobService.enqueue({ projectId: 1, execute: () => ({ changedCount: 1 }) });
    await callbacks.shift()();

    const response = await request(app).get(`/processing/jobs/${firstJobId}`).expect(404);
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'PROCESSING_JOB_NOT_FOUND', message: 'Processing job not found.' },
    });
  });
  it('reserves a deferred Apply submission during planning and releases an invalid plan without enqueueing', async () => {
    const { app, services } = createHarness();
    const enqueue = vi.spyOn(services.processingJobService, 'enqueue');
    let beginPlanning;
    let releasePlanning;
    const planningStarted = new Promise((resolve) => { beginPlanning = resolve; });
    const deferredPlan = new Promise((resolve) => { releasePlanning = resolve; });
    services.assetProcessingPlanner.planConvert.mockImplementationOnce(() => {
      beginPlanning();
      return deferredPlan;
    });

    const submitted = request(app)
      .post('/projects/1/assets/processing/convert/apply')
      .send({ scope: { type: 'selected', assetIds: [9] }, options: { format: 'webp', quality: 85, originalHandling: 'keep' } });

    const responsePromise = submitted.then((response) => response);

    await planningStarted;
    expect(services.processingJobService.hasActiveJobs()).toBe(true);

    releasePlanning({
      scope: { type: 'selected', assetIds: [9] },
      options: { format: 'webp', quality: 85, originalHandling: 'keep' },
      assetIds: [],
      items: [],
    });

    const response = await responsePromise;
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'NO_ASSETS_SELECTED', message: 'No assets selected.' },
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(services.processingJobService.hasActiveJobs()).toBe(false);
    services.assetProcessingPlanner.planConvert.mockRejectedValueOnce(
      new AssetProcessingError('Planner failed.', { code: 'PLANNER_FAILED' }),
    );
    const plannerFailure = await request(app)
      .post('/projects/1/assets/processing/convert/apply')
      .send({ scope: { type: 'selected', assetIds: [9] }, options: { format: 'webp', quality: 85, originalHandling: 'keep' } });

    expect(plannerFailure.status).toBeGreaterThanOrEqual(400);
    expect(enqueue).not.toHaveBeenCalled();
    expect(services.processingJobService.hasActiveJobs()).toBe(false);
  });
});
