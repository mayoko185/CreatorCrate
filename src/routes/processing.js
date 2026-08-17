import express from 'express';
import Busboy from 'busboy';
import { AssetProcessingError } from '../services/asset-processing-service.js';
import { AssetProcessingScopeError } from '../services/asset-processing-scope-service.js';
import { WatermarkServiceError } from '../services/watermark-service.js';
import { WatermarkScaleMapServiceError } from '../services/watermark-scale-map-service.js';
import { ProcessingPresetServiceError } from '../services/processing-preset-service.js';

const MAX_WATERMARK_UPLOAD_BYTES = 5 * 1024 * 1024;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const FORBIDDEN_PATH_KEYS = new Set(['watermarkPath', 'scaleMapPath', 'projectRoot']);
const OPERATION_METHODS = Object.freeze({
  convert: { plan: 'planConvert', apply: 'convertAssets' },
  'workflow-prompt': { plan: 'planWorkflowPromptEdit', apply: 'editWorkflowPrompts' },
  watermark: { plan: 'planWatermark', apply: 'watermarkAssets' },
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

function parseExecutionRequest(body, { operation, projectId, assetRepository, processingPresetService }) {
  const input = parseJsonObject(body, 'body');
  assertAllowedKeys(input, new Set(['scope', 'options', 'presetId', 'runtimeResources']), 'body');
  const scope = normalizeScope(input.scope, { projectId, assetRepository });

  if (Object.hasOwn(input, 'presetId')) {
    if (Object.hasOwn(input, 'options')) {
      throw new ProcessingRouteError('A request must use either options or presetId, not both.', { field: 'options' });
    }
    const runtimeResources = input.runtimeResources ?? {};
    assertAllowedKeys(runtimeResources, new Set(['watermarkId', 'scaleMapId']), 'runtimeResources');
    for (const key of Object.keys(runtimeResources)) {
      if (runtimeResources[key] !== null) parsePositiveId(runtimeResources[key], `runtimeResources.${key}`);
    }
    const preset = processingPresetService.resolvePresetForExecution(
      parsePositiveId(input.presetId, 'presetId'),
      runtimeResources,
    );
    if (preset.operationType !== operation) {
      throw new ProcessingRouteError('The selected preset belongs to a different processing operation.', {
        code: 'PRESET_OPERATION_MISMATCH',
        field: 'presetId',
      });
    }
    return { scope, options: preset.options, preset };
  }

  if (Object.hasOwn(input, 'runtimeResources')) {
    throw new ProcessingRouteError('runtimeResources requires presetId.', { field: 'runtimeResources' });
  }
  const options = parseJsonObject(input.options, 'options');
  assertNoForbiddenPathKeys(options);
  return { scope, options, preset: null };
}

function parseMultipartWatermark(req) {
  return new Promise((resolve, reject) => {
    if (!/^multipart\/form-data(?:;|$)/i.test(req.headers['content-type'] || '')) {
      reject(new ProcessingRouteError('Watermark uploads must use multipart/form-data.', { code: 'INVALID_UPLOAD', field: 'file' }));
      return;
    }

    let settled = false;
    let fileBytes = null;
    let displayName;
    let failure = null;
    const fail = (error) => {
      if (!failure) failure = error;
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      if (failure) reject(failure);
      else if (!fileBytes) reject(new ProcessingRouteError('A PNG file is required.', { code: 'PNG_REQUIRED', field: 'file' }));
      else resolve({ displayName, pngBytes: fileBytes });
    };

    let parser;
    try {
      parser = Busboy({
        headers: req.headers,
        limits: { files: 1, fields: 4, parts: 6, fileSize: MAX_WATERMARK_UPLOAD_BYTES },
      });
    } catch {
      reject(new ProcessingRouteError('Watermark upload is malformed.', { code: 'INVALID_UPLOAD' }));
      return;
    }

    parser.on('field', (name, value) => {
      if (name !== 'displayName') {
        fail(new ProcessingRouteError(`Unsupported upload field: ${name}.`, { field: name }));
        return;
      }
      displayName = value;
    });
    parser.on('file', (name, stream) => {
      if (name !== 'file' || fileBytes) {
        stream.resume();
        fail(new ProcessingRouteError('Exactly one PNG file field is required.', { code: 'INVALID_UPLOAD', field: 'file' }));
        return;
      }
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('limit', () => fail(new ProcessingRouteError('Watermark upload exceeds the 5 MiB limit.', {
        code: 'UPLOAD_TOO_LARGE',
        field: 'file',
      })));
      stream.on('end', () => {
        if (!failure) fileBytes = Buffer.concat(chunks);
      });
      stream.on('error', () => fail(new ProcessingRouteError('Watermark upload could not be read.', { code: 'INVALID_UPLOAD', field: 'file' })));
    });
    parser.on('filesLimit', () => fail(new ProcessingRouteError('Exactly one PNG file field is required.', { code: 'INVALID_UPLOAD', field: 'file' })));
    parser.on('fieldsLimit', () => fail(new ProcessingRouteError('Too many upload fields.', { code: 'INVALID_UPLOAD' })));
    parser.on('partsLimit', () => fail(new ProcessingRouteError('Watermark upload has too many parts.', { code: 'INVALID_UPLOAD' })));
    parser.on('error', () => fail(new ProcessingRouteError('Watermark upload is malformed.', { code: 'INVALID_UPLOAD' })));
    parser.on('close', finish);
    req.pipe(parser);
  });
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
  watermarkScaleMapService,
  processingPresetService,
} = {}) {
  if (!watermarkService || typeof watermarkService.listWatermarks !== 'function') throw new TypeError('watermarkService is required');
  if (!watermarkScaleMapService || typeof watermarkScaleMapService.listScaleMaps !== 'function') throw new TypeError('watermarkScaleMapService is required');
  if (!processingPresetService || typeof processingPresetService.listPresets !== 'function') throw new TypeError('processingPresetService is required');

  const router = express.Router();
  const hasExecutionSurface = projectService
    && assetRepository
    && assetProcessingScopeService
    && assetProcessingPlanner
    && assetProcessingService
    && typeof projectService.findById === 'function'
    && typeof assetRepository.findProjectAssetsByCategoryInBrowserOrder === 'function'
    && typeof assetProcessingScopeService.resolveAssetProcessingScope === 'function'
    && Object.values(OPERATION_METHODS).every(({ plan }) => typeof assetProcessingPlanner[plan] === 'function')
    && Object.values(OPERATION_METHODS).every(({ apply }) => typeof assetProcessingService[apply] === 'function');

  if (hasExecutionSurface) {
    for (const operation of Object.keys(OPERATION_METHODS)) {
      router.post(`/projects/:id/assets/processing/${operation}/plan`, createExecutionHandler({
        operation, mode: 'plan', projectService, assetRepository, assetProcessingScopeService, assetProcessingPlanner, assetProcessingService, processingPresetService,
      }));
      router.post(`/projects/:id/assets/processing/${operation}/apply`, createExecutionHandler({
        operation, mode: 'apply', projectService, assetRepository, assetProcessingScopeService, assetProcessingPlanner, assetProcessingService, processingPresetService,
      }));
    }
  }

  router.get('/processing/watermarks', (_req, res, next) => {
    try { return res.json({ ok: true, watermarks: watermarkService.listWatermarks() }); } catch (error) { return handleError(error, res, next); }
  });
  router.post('/processing/watermarks', async (req, res, next) => {
    try {
      const upload = await parseMultipartWatermark(req);
      const watermark = await watermarkService.createWatermark(upload);
      return res.status(201).json({ ok: true, watermark });
    } catch (error) { return handleError(error, res, next); }
  });
  router.post('/processing/watermarks/:id/rename', (req, res, next) => {
    try {
      const body = assertResourceRequest(req.body, ['displayName']);
      const watermark = watermarkService.renameWatermark(parsePositiveId(req.params.id, 'watermarkId'), body.displayName);
      return res.json({ ok: true, watermark });
    } catch (error) { return handleError(error, res, next); }
  });
  router.post('/processing/watermarks/:id/replace', async (req, res, next) => {
    try {
      const upload = await parseMultipartWatermark(req);
      const watermark = await watermarkService.replaceWatermark(parsePositiveId(req.params.id, 'watermarkId'), upload);
      return res.json({ ok: true, watermark });
    } catch (error) { return handleError(error, res, next); }
  });
  router.post('/processing/watermarks/:id/delete', (req, res, next) => {
    try {
      const id = parsePositiveId(req.params.id, 'watermarkId');
      watermarkService.deleteWatermark(id);
      return res.json({ ok: true, id });
    } catch (error) { return handleError(error, res, next); }
  });
  router.get('/processing/watermarks/:id/image', (req, res, next) => {
    try {
      const resolved = watermarkService.resolveForProcessing(parsePositiveId(req.params.id, 'watermarkId'));
      return res.type('png').set('Cache-Control', 'private, max-age=3600').sendFile(resolved.filePath);
    } catch (error) { return handleError(error, res, next); }
  });

  router.get('/processing/scale-maps', (_req, res, next) => {
    try { return res.json({ ok: true, scaleMaps: watermarkScaleMapService.listScaleMaps() }); } catch (error) { return handleError(error, res, next); }
  });
  router.post('/processing/scale-maps', (req, res, next) => {
    try {
      const body = assertResourceRequest(req.body, ['displayName', 'definition']);
      const scaleMap = watermarkScaleMapService.createScaleMap(body);
      return res.status(201).json({ ok: true, scaleMap });
    } catch (error) { return handleError(error, res, next); }
  });
  router.post('/processing/scale-maps/:id/rename', (req, res, next) => {
    try {
      const body = assertResourceRequest(req.body, ['displayName']);
      const scaleMap = watermarkScaleMapService.renameScaleMap(parsePositiveId(req.params.id, 'scaleMapId'), body.displayName);
      return res.json({ ok: true, scaleMap });
    } catch (error) { return handleError(error, res, next); }
  });
  router.post('/processing/scale-maps/:id/replace', (req, res, next) => {
    try {
      const body = assertResourceRequest(req.body, ['definition']);
      const scaleMap = watermarkScaleMapService.replaceScaleMap(parsePositiveId(req.params.id, 'scaleMapId'), body.definition);
      return res.json({ ok: true, scaleMap });
    } catch (error) { return handleError(error, res, next); }
  });
  router.post('/processing/scale-maps/:id/delete', (req, res, next) => {
    try {
      const id = parsePositiveId(req.params.id, 'scaleMapId');
      watermarkScaleMapService.deleteScaleMap(id);
      return res.json({ ok: true, id });
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
      const body = assertResourceRequest(req.body, ['operationType', 'displayName', 'config', 'watermarkId', 'scaleMapId']);
      assertNoForbiddenPathKeys(body.config);
      const preset = processingPresetService.createPreset(body);
      return res.status(201).json({ ok: true, preset });
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
      const body = assertResourceRequest(req.body, ['config', 'watermarkId', 'scaleMapId']);
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
