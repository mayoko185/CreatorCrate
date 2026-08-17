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
    },
    assetProcessingService: {
      convertAssets: vi.fn(async () => ({ changedCount: 1 })),
      editWorkflowPrompts: vi.fn(async () => ({ changedCount: 1 })),
      watermarkAssets: vi.fn(async () => ({ changedCount: 1 })),
    },
    watermarkService: {
      listWatermarks: vi.fn(() => []),
      createWatermark: vi.fn(async (input) => ({ id: 10, displayName: input.displayName, width: 1, height: 1 })),
      renameWatermark: vi.fn(() => ({ id: 10, displayName: 'Renamed' })),
      replaceWatermark: vi.fn(async () => ({ id: 10, displayName: 'Replaced' })),
      deleteWatermark: vi.fn(),
      resolveForProcessing: vi.fn(() => ({ watermark: { id: 10 }, filePath: 'C:/not-used.png' })),
    },
    watermarkScaleMapService: {
      listScaleMaps: vi.fn(() => []),
      createScaleMap: vi.fn((input) => ({ id: 11, ...input })),
      renameScaleMap: vi.fn(() => ({ id: 11, displayName: 'Renamed' })),
      replaceScaleMap: vi.fn(() => ({ id: 11, definition: {} })),
      deleteScaleMap: vi.fn(),
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

    project.status = 'active';
    services.watermarkScaleMapService.deleteScaleMap.mockImplementation(() => {
      throw new WatermarkScaleMapServiceError('Scale map is in use.', { code: 'SCALE_MAP_IN_USE' });
    });
    const conflict = await request(app).post('/processing/scale-maps/11/delete').send({});
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({
      ok: false,
      error: { code: 'SCALE_MAP_IN_USE', message: 'Scale map is in use.' },
    });
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

  it('supports bounded multipart Watermark creation and safe resource responses', async () => {
    const { app, services } = createHarness();
    const response = await request(app)
      .post('/processing/watermarks')
      .field('displayName', 'Creator mark')
      .attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: 'mark.png', contentType: 'image/png' });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ ok: true, watermark: { id: 10, displayName: 'Creator mark' } });
    expect(services.watermarkService.createWatermark).toHaveBeenCalledWith({
      displayName: 'Creator mark',
      pngBytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
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
