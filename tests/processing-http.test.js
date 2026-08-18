import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createProcessingRouter } from '../src/routes/processing.js';
import {
  WatermarkScaleMapServiceError,
} from '../src/services/watermark-scale-map-service.js';

function createHarness(overrides = {}) {
  const project = { id: 1, status: 'active', archived_at: null };
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
      planConvert: vi.fn(async (_id, scope, options) => ({ scope, options, items: [] })),
      planWorkflowPromptEdit: vi.fn(async (_id, scope, options) => ({ scope, options, items: [] })),
      planWatermark: vi.fn(async (_id, scope, options) => ({ scope, options, items: [] })),
      renderWatermarkPreview: vi.fn(async () => ({
        buffer: Buffer.from('preview-bytes'), contentType: 'image/png', filename: 'source.png', eligibleCount: 2, variant: 'resized',
      })),
      planArchives: vi.fn(async (_id, scope, options) => ({ scope, options, items: [], archives: [] })),
    },
    assetProcessingService: {
      convertAssets: vi.fn(async () => ({ changedCount: 1 })),
      editWorkflowPrompts: vi.fn(async () => ({ changedCount: 1 })),
      watermarkAssets: vi.fn(async () => ({ changedCount: 1 })),
      createArchives: vi.fn(async () => ({ changedCount: 2 })),
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

    expect(apply.status).toBe(200);
    expect(services.assetProcessingService.watermarkAssets).toHaveBeenCalledWith(1, [9], options);

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

    expect(apply.status).toBe(200);
    expect(apply.body).toMatchObject({
      ok: true,
      operation: 'archive',
      refreshUrl: '/projects/1/assets',
    });
    expect(services.assetProcessingScopeService.resolveAssetProcessingScope).toHaveBeenCalledWith(
      1,
      { type: 'selected', assetIds: [4] },
    );
    expect(services.assetProcessingService.createArchives).toHaveBeenCalledWith(
      1,
      [4],
      { makeCbz: true },
    );
  });

  it('resolves a preset once and applies the resulting normalized options', async () => {
    const { app, services } = createHarness();
    const response = await request(app)
      .post('/projects/1/assets/processing/convert/apply')
      .send({ scope: { type: 'project' }, presetId: 12 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, operation: 'convert', refreshUrl: '/projects/1/assets' });
    expect(services.processingPresetService.resolvePresetForExecution).toHaveBeenCalledWith(12, {});
    expect(services.assetProcessingScopeService.resolveAssetProcessingScope).toHaveBeenCalledWith(
      1,
      { type: 'directory', relativePath: '', recursive: true },
    );
    expect(services.assetProcessingService.convertAssets).toHaveBeenCalledWith(
      1,
      [9],
      { format: 'webp', quality: 85, originalHandling: 'keep' },
    );
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

  it('does not turn unexpected failures into successful JSON responses', async () => {
    const { app, services } = createHarness();
    services.assetProcessingService.convertAssets.mockRejectedValue(new Error('C:/secret/staging'));
    const response = await request(app)
      .post('/projects/1/assets/processing/convert/apply')
      .send({ scope: { type: 'project' }, options: { format: 'webp', quality: 85, originalHandling: 'keep' } });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ status: 'error', message: 'Internal server error.' });
  });
});
