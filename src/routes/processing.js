import express from 'express';
import { AssetProcessingError } from '../services/asset-processing-service.js';
import { AssetProcessingScopeError } from '../services/asset-processing-scope-service.js';
import { WatermarkServiceError } from '../services/watermark-service.js';
import { WatermarkScaleMapServiceError } from '../services/watermark-scale-map-service.js';
import {
  PROCESSING_PRESET_OPERATION_TYPES,
  ProcessingPresetServiceError,
} from '../services/processing-preset-service.js';

const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const FORBIDDEN_PATH_KEYS = new Set(['watermarkPath', 'scaleMapPath', 'projectRoot']);
const OPERATION_METHODS = Object.freeze({
  [PROCESSING_PRESET_OPERATION_TYPES.CONVERT]: { plan: 'planConvert', apply: 'convertAssets' },
  [PROCESSING_PRESET_OPERATION_TYPES.WORKFLOW_PROMPT]: { plan: 'planWorkflowPromptEdit', apply: 'editWorkflowPrompts' },
  [PROCESSING_PRESET_OPERATION_TYPES.WATERMARK]: { plan: 'planWatermark', apply: 'watermarkAssets' },
  archive: { plan: 'planArchives', apply: 'createArchives' },
});

class ProcessingRouteError extends Error {
  constructor(message, { code = 'INVALID_REQUEST', field, status = 400 } = {}) {
    super(message);
    this.name = 'ProcessingRouteError';
    this.code = code;
    this.field = field;
    this.status = status;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeJson(value, field = 'body') {
  if (Array.isArray(value)) {
    for (const item of value) assertSafeJson(item, field);
    return;
  }
  if (!isPlainObject(value)) {
    if (value !== null && typeof value === 'object') {
      throw new ProcessingRouteError(`${field} must contain only plain JSON objects and arrays.`, { field });
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new ProcessingRouteError(`${field} contains a forbidden key.`, { field });
    }
    assertSafeJson(item, field);
  }
}

function assertAllowedKeys(value, allowed, field = 'body') {
  if (!isPlainObject(value)) throw new ProcessingRouteError(`${field} must be a JSON object.`, { field });
  assertSafeJson(value, field);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ProcessingRouteError(`${field} contains an unsupported field: ${key}.`, { field: key });
    }
  }
}

function assertNoForbiddenPathKeys(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenPathKeys(item);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_PATH_KEYS.has(key)) {
      throw new ProcessingRouteError(`${key} is not accepted by processing routes.`, { field: key });
    }
    assertNoForbiddenPathKeys(item);
  }
}

function parsePositiveId(value, field = 'id') {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ProcessingRouteError(`${field} must be a positive integer.`, { code: 'INVALID_ID', field });
  }
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) {
    throw new ProcessingRouteError(`${field} must be a positive integer.`, { code: 'INVALID_ID', field });
  }
  const id = Number(text);
  if (!Number.isSafeInteger(id)) {
    throw new ProcessingRouteError(`${field} must be a positive integer.`, { code: 'INVALID_ID', field });
  }
  return id;
}

function sendError(res, status, code, message, field) {
  return res.status(status).json({
    ok: false,
    error: { code: code || 'INVALID_REQUEST', message, ...(field ? { field } : {}) },
  });
}

function errorStatus(error) {
  if (error instanceof ProcessingRouteError) return error.status;
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 600) return error.status;
  const code = error?.code || 'INVALID_REQUEST';
  if (code.endsWith('_NOT_FOUND') || code === 'PROJECT_NOT_FOUND' || code === 'ASSET_NOT_FOUND') return 404;
  if (/(?:_IN_USE|_TAMPERED|_ARCHIVED|_CONFLICT|_STALE|_BUSY|_RECOVERY_REQUIRED|PUBLISHED_RELEASE|DELETION_WITHHELD)/.test(code)) return 409;
  return 400;
}

function isExpectedError(error) {
  return error instanceof ProcessingRouteError
    || error instanceof AssetProcessingError
    || error instanceof AssetProcessingScopeError
    || error instanceof WatermarkServiceError
    || error instanceof WatermarkScaleMapServiceError
    || error instanceof ProcessingPresetServiceError;
}

function handleError(error, res, next) {
  if (!isExpectedError(error)) return next(error);
  return sendError(res, errorStatus(error), error.code, error.message, error.field);
}

function parseJsonObject(value, field) {
  if (!isPlainObject(value)) throw new ProcessingRouteError(`${field} must be a JSON object.`, { field });
  assertSafeJson(value, field);
  return value;
}

function normalizeScope(scope, { projectId, assetRepository }) {
  const input = parseJsonObject(scope, 'scope');
  assertAllowedKeys(input, new Set(['type', 'assetIds', 'relativePath', 'recursive', 'entries', 'categoryId']), 'scope');

  if (input.type === 'project') return { type: 'directory', relativePath: '', recursive: true };
  if (input.type === 'category') {
    const categoryId = parsePositiveId(input.categoryId, 'scope.categoryId');
    const records = assetRepository.findProjectAssetsByCategoryInBrowserOrder(projectId, categoryId)
      .filter((asset) => asset.is_present === 1 || asset.is_present === true);
    if (records.length === 0) {
      throw new ProcessingRouteError('The category has no present assets to process.', {
        code: 'NO_ASSETS_SELECTED',
        field: 'scope.categoryId',
      });
    }
    return { type: 'selected', assetIds: records.map((asset) => asset.id) };
  }
  if (input.type === 'selected' || input.type === 'directory' || input.type === 'mixed') return input;
  throw new ProcessingRouteError('scope.type must be selected, directory, mixed, project, or category.', {
    code: 'INVALID_SCOPE',
    field: 'scope.type',
  });
}

function normalizeWatermarkIdentity(value, field) {
  const hasWatermarkId = Object.hasOwn(value, 'watermarkId');
  if (hasWatermarkId) value.watermarkId = parsePositiveId(value.watermarkId, field + '.watermarkId');
  return value;
}

function normalizeWatermarkRequestOptions(options) {
  return normalizeWatermarkIdentity({ ...options }, 'options');
}

function normalizeRuntimeResources(resources) {
  const normalized = normalizeWatermarkIdentity({ ...resources }, 'runtimeResources');
  for (const key of Object.keys(normalized)) {
    if (key === 'watermarkId') continue;
    if (normalized[key] !== null) normalized[key] = parsePositiveId(
      normalized[key],
      'runtimeResources.' + key,
    );
  }
  return normalized;
}

function parseExecutionRequest(body, { operation, projectId, assetRepository, processingPresetService }) {
  const input = parseJsonObject(body, 'body');
  assertAllowedKeys(input, new Set(['scope', 'options', 'presetId', 'runtimeResources']), 'body');
  const scope = normalizeScope(input.scope, { projectId, assetRepository });

  if (Object.hasOwn(input, 'presetId')) {
    if (Object.hasOwn(input, 'options')) {
      throw new ProcessingRouteError('A request must use either options or presetId, not both.', { field: 'options' });
    }
    const runtimeResources = input.runtimeResources ?? {};
    assertAllowedKeys(runtimeResources, new Set(['watermarkId']), 'runtimeResources');
    const normalizedRuntimeResources = normalizeRuntimeResources(runtimeResources);
    const preset = processingPresetService.resolvePresetForExecution(
      parsePositiveId(input.presetId, 'presetId'),
      normalizedRuntimeResources,
    );
    if (preset.operationType !== operation) {
      throw new ProcessingRouteError('The selected preset belongs to a different processing operation.', {
        code: 'PRESET_OPERATION_MISMATCH',
        field: 'presetId',
      });
    }

    const options = { ...preset.options };
    if (operation === 'watermark') {
      if (Object.hasOwn(normalizedRuntimeResources, 'watermarkId')) {
        options.watermarkId = normalizedRuntimeResources.watermarkId;
      } else if (preset.watermarkId !== null && preset.watermarkId !== undefined) {
        options.watermarkId = preset.watermarkId;
      }
    }
    return { scope, options, preset };
  }

  if (Object.hasOwn(input, 'runtimeResources')) {
    throw new ProcessingRouteError('runtimeResources requires presetId.', { field: 'runtimeResources' });
  }
  let options = parseJsonObject(input.options, 'options');
  assertNoForbiddenPathKeys(options);
  if (operation === 'watermark' && Object.hasOwn(options, 'scaleMapId')) {
    throw new ProcessingRouteError('options contains an unsupported field: scaleMapId.', { field: 'scaleMapId' });
  }
  if (operation === 'watermark') options = normalizeWatermarkRequestOptions(options);
  return { scope, options, preset: null };
}

function assertResourceRequest(body, allowed) {
  const input = parseJsonObject(body, 'body');
  assertAllowedKeys(input, new Set(allowed), 'body');
  return input;
}

function createExecutionHandler({ operation, mode, projectService, assetRepository, assetProcessingScopeService, assetProcessingPlanner, assetProcessingService, processingPresetService }) {
  const methods = OPERATION_METHODS[operation];
  return async (req, res, next) => {
    try {
      const projectId = parsePositiveId(req.params.id, 'projectId');
      const project = projectService.findById(projectId);
      if (!project) return sendError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      if (project.archived_at || project.status === 'archived') {
        return sendError(res, 409, 'PROJECT_ARCHIVED', 'Archived projects cannot be processed.');
      }

      const { scope, options } = parseExecutionRequest(req.body, {
        operation, projectId, assetRepository, processingPresetService,
      });
      if (mode === 'plan') {
        const plan = await assetProcessingPlanner[methods.plan](projectId, scope, options);
        return res.json({ ok: true, operation, plan });
      }

      const resolved = assetProcessingScopeService.resolveAssetProcessingScope(projectId, scope);
      const result = await assetProcessingService[methods.apply](projectId, resolved.assetIds, options);
      return res.json({ ok: true, operation, result, refreshUrl: `/projects/${projectId}/assets` });
    } catch (error) {
      return handleError(error, res, next);
    }
  };
}

/**
 * Global managed resources mount at /processing and project execution routes
 * mount at /projects. Category scope is deliberately concrete-category only:
 * it resolves the current project's present assets in canonical browser order.
 */
export function createProcessingRouter({
  projectService,
  assetRepository,
  assetProcessingScopeService,
  assetProcessingPlanner,
  assetProcessingService,
  watermarkService,
  watermarkDefaultService,
  watermarkScaleMapService,
  processingPresetService,
} = {}) {
  if (!watermarkService || typeof watermarkService.listWatermarks !== 'function') throw new TypeError('watermarkService is required');
  if (!watermarkDefaultService || typeof watermarkDefaultService.getDefaultWatermarkId !== 'function'
    || typeof watermarkDefaultService.setDefaultWatermarkId !== 'function') throw new TypeError('watermarkDefaultService is required');
  if (!watermarkScaleMapService || typeof watermarkScaleMapService.getScaleMap !== 'function'
    || typeof watermarkScaleMapService.replaceScaleMap !== 'function') throw new TypeError('watermarkScaleMapService is required');
  if (!processingPresetService || typeof processingPresetService.listPresets !== 'function') throw new TypeError('processingPresetService is required');

  const router = express.Router();
  const hasExecutionSurface = projectService
    && assetRepository
    && assetProcessingScopeService
    && assetProcessingPlanner
    && assetProcessingService
    && typeof projectService.findById === 'function'
    && typeof assetRepository.findProjectAssetsByCategoryInBrowserOrder === 'function'
    && typeof assetProcessingScopeService.resolveAssetProcessingScope === 'function';

  if (hasExecutionSurface) {
    for (const [operation, methods] of Object.entries(OPERATION_METHODS)) {
      if (typeof assetProcessingPlanner[methods.plan] !== 'function'
        || typeof assetProcessingService[methods.apply] !== 'function') continue;
      router.post(`/projects/:id/assets/processing/${operation}/plan`, createExecutionHandler({
        operation, mode: 'plan', projectService, assetRepository, assetProcessingScopeService, assetProcessingPlanner, assetProcessingService, processingPresetService,
      }));
      router.post(`/projects/:id/assets/processing/${operation}/apply`, createExecutionHandler({
        operation, mode: 'apply', projectService, assetRepository, assetProcessingScopeService, assetProcessingPlanner, assetProcessingService, processingPresetService,
      }));
    }

    if (typeof assetProcessingPlanner.renderWatermarkPreview === 'function') {
      router.post('/projects/:id/assets/processing/watermark/preview-image', async (req, res, next) => {
        try {
          const projectId = parsePositiveId(req.params.id, 'projectId');
          const project = projectService.findById(projectId);
          if (!project) return sendError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
          if (project.archived_at || project.status === 'archived') {
            return sendError(res, 409, 'PROJECT_ARCHIVED', 'Archived projects cannot be processed.');
          }
          const { scope, options } = parseExecutionRequest(req.body, {
            operation: 'watermark', projectId, assetRepository, processingPresetService,
          });
          const preview = await assetProcessingPlanner.renderWatermarkPreview(projectId, scope, options);
          if (!preview) return res.status(204).end();
          return res
            .type(preview.contentType)
            .set('Cache-Control', 'no-store')
            .set('X-CreatorCrate-Preview-Source', encodeURIComponent(preview.filename))
            .set('X-CreatorCrate-Preview-Eligible-Count', String(preview.eligibleCount))
            .set('X-CreatorCrate-Preview-Variant', preview.variant)
            .send(preview.buffer);
        } catch (error) {
          return handleError(error, res, next);
        }
      });
    }
  }

  router.get('/processing/watermarks', (_req, res, next) => {
    try { return res.json({ ok: true, watermarks: watermarkService.listWatermarks() }); } catch (error) { return handleError(error, res, next); }
  });
  router.post('/processing/watermarks/scan', async (_req, res, next) => {
    try {
      const scan = await watermarkService.scanWatermarks();
      return res.json({ ok: true, scan });
    } catch (error) { return handleError(error, res, next); }
  });
  router.get('/processing/watermarks/default', (_req, res, next) => {
    try { return res.json({ ok: true, watermarkId: watermarkDefaultService.getDefaultWatermarkId() }); } catch (error) { return handleError(error, res, next); }
  });
  router.post('/processing/watermarks/default', (req, res, next) => {
    try {
      const body = assertResourceRequest(req.body, ['watermarkId']);
      return res.json({ ok: true, watermarkId: watermarkDefaultService.setDefaultWatermarkId(parsePositiveId(body.watermarkId, 'watermarkId')) });
    } catch (error) { return handleError(error, res, next); }
  });
  router.get('/processing/watermarks/:id/image', (req, res, next) => {
    try {
      const resolved = watermarkService.resolveForProcessing(parsePositiveId(req.params.id, 'watermarkId'));
      const response = res.type('png').set('Cache-Control', 'private, max-age=3600');
      return resolved.bytes ? response.send(resolved.bytes) : response.sendFile(resolved.filePath);
    } catch (error) { return handleError(error, res, next); }
  });

  router.get('/processing/scale-map', (_req, res, next) => {
    try { return res.json({ ok: true, definition: watermarkScaleMapService.getScaleMap().definition }); } catch (error) { return handleError(error, res, next); }
  });
  router.post('/processing/scale-map/replace', (req, res, next) => {
    try {
      const body = assertResourceRequest(req.body, ['definition']);
      return res.json({ ok: true, definition: watermarkScaleMapService.replaceScaleMap(body.definition).definition });
    } catch (error) { return handleError(error, res, next); }
  });

  router.get('/processing/presets', (req, res, next) => {
    try {
      const operationType = req.query.operationType;
      if (operationType !== undefined && Array.isArray(operationType)) {
        throw new ProcessingRouteError('operationType must be a string.', { field: 'operationType' });
      }
      return res.json({ ok: true, presets: processingPresetService.listPresets({ operationType }) });
    } catch (error) { return handleError(error, res, next); }
  });
  router.post('/processing/presets', (req, res, next) => {
    try {
      const body = assertResourceRequest(req.body, ['operationType', 'displayName', 'config', 'watermarkId']);
      assertNoForbiddenPathKeys(body.config);
      const preset = processingPresetService.createPreset(body);
      return res.status(201).json({ ok: true, preset });
    } catch (error) { return handleError(error, res, next); }
  });
  router.post('/processing/presets/import', (req, res, next) => {
    try {
      const body = assertResourceRequest(req.body, ['creatorcrate', 'version', 'operationType', 'presets']);
      const result = processingPresetService.importPresetBundle(body);
      return res.json({ ok: true, ...result });
    } catch (error) { return handleError(error, res, next); }
  });
  router.post('/processing/presets/:id/rename', (req, res, next) => {
    try {
      const body = assertResourceRequest(req.body, ['displayName']);
      const preset = processingPresetService.renamePreset(parsePositiveId(req.params.id, 'presetId'), body.displayName);
      return res.json({ ok: true, preset });
    } catch (error) { return handleError(error, res, next); }
  });
  router.post('/processing/presets/:id/replace', (req, res, next) => {
    try {
      const body = assertResourceRequest(req.body, ['config', 'watermarkId']);
      assertNoForbiddenPathKeys(body.config);
      const preset = processingPresetService.replacePreset(parsePositiveId(req.params.id, 'presetId'), body);
      return res.json({ ok: true, preset });
    } catch (error) { return handleError(error, res, next); }
  });
  router.post('/processing/presets/:id/delete', (req, res, next) => {
    try {
      const id = parsePositiveId(req.params.id, 'presetId');
      processingPresetService.deletePreset(id);
      return res.json({ ok: true, id });
    } catch (error) { return handleError(error, res, next); }
  });

  return router;
}
