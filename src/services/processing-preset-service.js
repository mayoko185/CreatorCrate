import { normalizeConversionOptions } from './asset-processing-service.js';
import { normalizePromptEditOptions } from './workflow-prompt-editor.js';
import { normalizeWatermarkOptions } from './watermark-engine.js';

const CONFIG_VERSION = 1;
const SEED_MARKER_KEY = 'processing_presets.seed_version_2';
export const PROCESSING_PRESET_OPERATION_TYPES = Object.freeze({
  CONVERT: 'convert',
  WORKFLOW_PROMPT: 'workflow-prompt',
  WATERMARK: 'watermark',
});
export const PROCESSING_PRESET_BUNDLE_MARKER = 'processing-presets';
export const PROCESSING_PRESET_BUNDLE_VERSION = 1;
const OPERATION_TYPES = new Set(Object.values(PROCESSING_PRESET_OPERATION_TYPES));
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/u;
const FORBIDDEN_CONFIG_KEYS = new Set([
  'projectid', 'assetid', 'assetids', 'selectedassetid', 'selectedassetids',
  'directory', 'directories', 'scope', 'recursive', 'watermarkid', 'scalemapid',
  'watermarkpath', 'watermarkfile', 'scalemappath', 'scalemapfile', 'scalemap',
]);
const PORTABLE_FORBIDDEN_CONFIG_KEYS = new Set([
  ...FORBIDDEN_CONFIG_KEYS,
  'categoryid', 'outputcategoryid', 'projectroot', 'watermarkassetid', 'path', 'relativepath', 'absolutepath',
  'generatedoutput', 'generatedstate', 'systemkey', 'createdat', 'updatedat',
  'configversion', 'operationtype', 'displayname', 'presetid', 'id',
]);
const CONVERT_KEYS = new Set(['format', 'originalHandling', 'quality']);
const WORKFLOW_KEYS = new Set(['positive', 'negative']);
const WATERMARK_KEYS = new Set([
  'mode', 'workflow', 'position', 'marginRatio', 'margin', 'marginPercent', 'marginPx', 'opacity',
  'primaryFormat', 'secondaryFormat', 'resizedFormat', 'outputFormat', 'format', 'quality', 'maxDimension', 'deleteSource', 'deleteOriginal', 'scale',
  'watermarkScale', 'scaleBasis', 'windowAspect', 'fixedWatermarkWidthPx', 'fixedWmPx', 'nudgeX',
  'nudgeY', 'nudgeXRatio', 'nudgeXPercent', 'nudgeYRatio', 'nudgeYPercent', 'allowOffCanvas',
  'containment', 'overwrite', 'alsoUnresized', 'unresizedSuffix', 'resizedSuffix', 'singleSuffix',
  'suffix', 'socialSuffix', 'suffixUnresized', 'suffixResized', 'outputCategorySlug', 'outputDir', 'outputDirectory', 'trimWatermark', 'watermarkBeforeResize', 'webpLossless',
  'additionalFormats', 'additionalFormatsResized', 'jpegBackground', 'makeArchives', 'makeCbz',
  'archiveIncludeResized', 'replaceExistingArchives', 'archiveFormat', 'zipJpgQuality',
  'zipWebpQuality', 'setName', 'archivePrefix', 'zipBaseName', 'cbzPrefix', 'cbzFrom', 'cbzJpgQuality',
]);
const WATERMARK_DERIVED_KEYS = new Set([
  'scaleMap', 'legacyOutputVariants', 'archiveResizedOnlyBlocked',
  'singleSuffix', 'suffix', 'socialSuffix', 'suffixUnresized', 'suffixResized',
]);

const REFERENCE_SCALE_MAP = Object.freeze({
  '1365x768': 0.35, '1248x832': 0.35, '2496x1664': 0.35, '5376x3072': 0.35, '4992x3328': 0.35,
  '1024x1024': 0.37, '2048x2048': 0.37, '2304x2304': 0.37, '3072x3072': 0.37, '4096x4096': 0.37,
  '1600x2592': 0.31, '2560x6144': 0.28, '832x1248': 0.32, '1365x2048': 0.32, '1664x2496': 0.32,
  '3328x4992': 0.32, default: 0.10,
});

export class ProcessingPresetServiceError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, { cause });
    this.name = 'ProcessingPresetServiceError';
    this.code = code;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isPositiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeDisplayName(value) {
  if (typeof value !== 'string') {
    throw new ProcessingPresetServiceError('Preset display name must be a string.', { code: 'INVALID_PRESET_NAME' });
  }
  const displayName = value.trim();
  if (!displayName || displayName.length > 200 || CONTROL_CHARACTERS.test(displayName)) {
    throw new ProcessingPresetServiceError('Preset display name is invalid.', { code: 'INVALID_PRESET_NAME' });
  }
  return displayName;
}

function normalizeOperationType(value) {
  if (!OPERATION_TYPES.has(value)) {
    throw new ProcessingPresetServiceError('Preset operation type is unsupported.', { code: 'INVALID_PRESET_OPERATION' });
  }
  return value;
}

function assertPlainObject(value, message = 'Preset configuration must be an object.') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProcessingPresetServiceError(message, { code: 'INVALID_PRESET_CONFIG' });
  }
}

function assertAllowedKeys(value, allowed, label) {
  assertPlainObject(value);
  for (const key of Object.keys(value)) {
    const compact = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (FORBIDDEN_CONFIG_KEYS.has(compact) || !allowed.has(key)) {
      throw new ProcessingPresetServiceError(`${label} contains an unsupported or runtime-only field.`, {
        code: 'PRESET_FIELD_NOT_ALLOWED',
      });
    }
  }
}

function assertPortableConfig(value, label = 'Preset configuration') {
  if (Array.isArray(value)) {
    value.forEach((item) => assertPortableConfig(item, label));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    const compact = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (PORTABLE_FORBIDDEN_CONFIG_KEYS.has(compact)) {
      throw new ProcessingPresetServiceError(`${label} contains an unsupported or runtime-only field.`, {
        code: 'PRESET_FIELD_NOT_ALLOWED',
      });
    }
    assertPortableConfig(item, label);
  }
}

function normalizeWorkflowConfig(config) {
  assertAllowedKeys(config, WORKFLOW_KEYS, 'Workflow preset configuration');
  const asInput = (value, label) => {
    if (Array.isArray(value)) return { rules: value };
    if (value === undefined) return undefined;
    assertPlainObject(value, `${label} workflow rules must be an object.`);
    if (Object.keys(value).some((key) => key !== 'rules')) {
      throw new ProcessingPresetServiceError(`${label} workflow rules contain unsupported fields.`, { code: 'PRESET_FIELD_NOT_ALLOWED' });
    }
    return value;
  };
  try {
    return normalizePromptEditOptions({
      positive: asInput(config.positive, 'positive'),
      negative: asInput(config.negative, 'negative'),
    });
  } catch (cause) {
    throw new ProcessingPresetServiceError(cause?.message || 'Workflow preset configuration is invalid.', {
      code: cause?.code || 'INVALID_PRESET_CONFIG', cause,
    });
  }
}

function normalizeConfig(operationType, config) {
  try {
    if (operationType === 'convert') {
      assertAllowedKeys(config, CONVERT_KEYS, 'Convert preset configuration');
      return normalizeConversionOptions(config);
    }
    if (operationType === 'workflow-prompt') return normalizeWorkflowConfig(config);
    assertAllowedKeys(config, WATERMARK_KEYS, 'Watermark preset configuration');
    const normalized = normalizeWatermarkOptions(config, { scaleMap: null, requireOutputCategory: false });
    return Object.fromEntries(Object.entries(normalized)
      .filter(([key, value]) => value !== undefined && !WATERMARK_DERIVED_KEYS.has(key)));
  } catch (cause) {
    if (cause instanceof ProcessingPresetServiceError) throw cause;
    throw new ProcessingPresetServiceError(cause?.message || 'Preset configuration is invalid.', {
      code: cause?.code || 'INVALID_PRESET_CONFIG', cause,
    });
  }
}

function normalizePresetBundle(bundle) {
  assertPlainObject(bundle, 'Preset bundle');
  const hasMarker = Object.hasOwn(bundle, 'creatorcrate');
  const hasVersion = Object.hasOwn(bundle, 'version');
  if (hasMarker !== hasVersion) {
    throw new ProcessingPresetServiceError('Preset bundle metadata is incomplete.', { code: 'INVALID_PRESET_BUNDLE' });
  }
  const allowedKeys = hasMarker
    ? new Set(['creatorcrate', 'version', 'operationType', 'presets'])
    : new Set(['operationType', 'presets']);
  for (const key of Object.keys(bundle)) {
    if (!allowedKeys.has(key)) {
      throw new ProcessingPresetServiceError('Preset bundle contains an unsupported field.', { code: 'INVALID_PRESET_BUNDLE' });
    }
  }
  if (hasMarker && bundle.creatorcrate !== PROCESSING_PRESET_BUNDLE_MARKER) {
    throw new ProcessingPresetServiceError('This is not a CreatorCrate processing preset bundle.', { code: 'INVALID_PRESET_BUNDLE' });
  }
  if (hasVersion && bundle.version !== PROCESSING_PRESET_BUNDLE_VERSION) {
    throw new ProcessingPresetServiceError('This processing preset bundle version is unsupported.', { code: 'INVALID_PRESET_BUNDLE' });
  }
  const operationType = normalizeOperationType(bundle.operationType);
  if (!Array.isArray(bundle.presets)) {
    throw new ProcessingPresetServiceError('Preset bundle presets must be an array.', { code: 'INVALID_PRESET_BUNDLE' });
  }
  const presets = bundle.presets.map((entry, index) => {
    assertPlainObject(entry, `Preset ${index + 1}`);
    assertAllowedKeys(entry, new Set(['displayName', 'config']), `Preset ${index + 1}`);
    const displayName = normalizeDisplayName(entry.displayName);
    assertPortableConfig(entry.config, `Preset ${index + 1} configuration`);
    return { displayName, config: normalizeConfig(operationType, entry.config) };
  });
  return {
    creatorcrate: PROCESSING_PRESET_BUNDLE_MARKER,
    version: PROCESSING_PRESET_BUNDLE_VERSION,
    operationType,
    presets,
  };
}

function parseStoredConfig(record) {
  if (record.config_version !== CONFIG_VERSION) {
    throw new ProcessingPresetServiceError('Preset configuration version is unsupported.', { code: 'PRESET_INVALID' });
  }
  try {
    return normalizeConfig(record.operation_type, JSON.parse(record.config_json));
  } catch (cause) {
    if (cause instanceof ProcessingPresetServiceError && cause.code === 'PRESET_INVALID') throw cause;
    throw new ProcessingPresetServiceError('Stored preset configuration is invalid.', { code: 'PRESET_INVALID', cause });
  }
}

function publicRecord(record) {
  const config = parseStoredConfig(record);
  return {
    id: record.id,
    operationType: record.operation_type,
    displayName: record.display_name,
    systemKey: record.system_key,
    configVersion: record.config_version,
    config,
    watermarkId: null,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function seededWorkflow(positive = [], negative = []) {
  return { positive, negative };
}

const SEEDED_PRESETS = Object.freeze([
  { operationType: 'watermark', displayName: 'Patreon Watermark', systemKey: 'watermark-patreon', config: { mode: 'patreon', scaleBasis: 'window', marginRatio: 0.02, opacity: 1, primaryFormat: 'png', secondaryFormat: null, resizedFormat: null, position: 'bl', overwrite: true, deleteSource: false, outputCategorySlug: 'wm' } },
  { operationType: 'watermark', displayName: 'Social Watermark', systemKey: 'watermark-social', config: { mode: 'social', scaleBasis: 'window', marginRatio: 0.02, opacity: 1, primaryFormat: null, secondaryFormat: null, resizedFormat: 'png', position: 'bl', overwrite: true, maxDimension: 1100, deleteSource: true, watermarkBeforeResize: false, outputCategorySlug: 'wm-lq' } },
  { operationType: 'convert', displayName: 'WebP 85 — Delete Originals', systemKey: 'convert-webp-85-delete-originals', config: { format: 'webp', quality: 85, originalHandling: 'delete' } },
  { operationType: 'convert', displayName: 'WebP 85 — Move Originals', systemKey: 'convert-webp-85-move-originals', config: { format: 'webp', quality: 85, originalHandling: 'move' } },
  { operationType: 'workflow-prompt', displayName: 'General', systemKey: 'workflow-general', config: seededWorkflow([
    { type: 'remove', text: 'masterwork, ' }, { type: 'remove', text: ', matte skin, skin texture, masterpiece, best quality, absurdres, newest' },
    { type: 'replace', search: '<lora:Illustrious\\concept\\LoraBYIL_penis_through_leghole.safetensors:1.0>', replacement: '<lora:Illustrious/concept/LoraBYIL_penis_through_leghole:0.8>' },
    { type: 'replace', search: '<lora:Illustrious\\concept\\erection_under_clothes.safetensors:1.0>', replacement: '<lora:Illustrious/concept/erection_under_clothes:0.8>' },
    { type: 'replace', search: '<lora:Illustrious\\concept\\erection_under_clothes.safetensors:0.8>', replacement: '<lora:Illustrious/concept/erection_under_clothes:0.7>' },
    { type: 'remove', text: '<lora:Illustrious\\concept\\Penis Size Slider - Illustrious - V5_alpha1.0_rank4_noxattn_last.safetensors:-1.0>' },
    { type: 'remove', text: '<lora:Illustrious\\concept\\Penis Size Slider - Illustrious - V5_alpha1.0_rank4_noxattn_last.safetensors:-2.0>' },
    { type: 'replace', search: '<lora:Illustrious\\character\\SokkaIllustrious9.safetensors:1.0>', replacement: '<lora:Illustrious/character/SokkaIllustrious9:0.8>' },
    { type: 'replace', search: '<lora:Illustrious\\character\\80144a74-d3c8-4242-9865-5690e2641d0a.TA_trained.safetensors:0.8>', replacement: '<lora:Illustrious/character/80144a74-d3c8-4242-9865-5690e2641d0a.TA_trained:0.7>' },
    { type: 'remove', text: '<lora:Illustrious\\style\\heightRatioSliderIllustrious.safetensors:-0.4>' },
    { type: 'remove', text: '<lora:Illustrious\\clothing\\jockstrap.safetensors:1.0>' },
  ], [{ type: 'remove', text: '1girl, 2girl, woman, breasts, (spots:1.1), (dots:1.1), (dust:1.1), (particles:1.1), shine, gloss, laytex, sweatdrop, lowres, (bad), bad anatomy, bad hands, extra digits, multiple views,fewer, extra, missing, text, error, worst quality, jpeg artifacts, low quality, watermark, unfinished, displeasing, oldest, early,chromatic aberration, signature,artistic error, username, scan' }]) },
  { operationType: 'workflow-prompt', displayName: 'Benji', systemKey: 'workflow-benji', config: seededWorkflow([{ type: 'remove', text: '<lora:Illustrious\\style\\heightRatioSliderIllustrious.safetensors:0.5>' }, { type: 'replace', search: '<lora:Mayoko\\benji\\benji_run15_2026-03-23_1392-40.safetensors:0.8>', replacement: '<lora:Mayoko/benji/benji_run15_2026-03-23_1392-40:0.7>' }], [{ type: 'prepend', text: 'extra abs, ' }]) },
  { operationType: 'workflow-prompt', displayName: 'Max', systemKey: 'workflow-max', config: seededWorkflow([{ type: 'replace', search: '<lora:Mayoko\\max\\max_run5_2026-03-23_1600_40.safetensors:0.8>', replacement: '<lora:Mayoko/max/max_run5_2026-03-23_1600_40:0.7>' }, { type: 'remove', text: '<lora:Illustrious\\style\\heightRatioSliderIllustrious.safetensors:0.5>' }], [{ type: 'prepend', text: 'red penis, ' }]) },
  { operationType: 'workflow-prompt', displayName: 'Oliver', systemKey: 'workflow-oliver', config: seededWorkflow([{ type: 'remove', text: '<lora:Illustrious\\style\\heightRatioSliderIllustrious.safetensors:0.5>' }, { type: 'replace', search: '<lora:Mayoko\\oliver\\oliver_run3_2026-05-04-1360-40.safetensors:0.8>', replacement: '<lora:Mayoko/oliver/oliver_run3_2026-05-04-1360-40:0.7>' }]) },
  { operationType: 'workflow-prompt', displayName: 'Rory', systemKey: 'workflow-rory', config: seededWorkflow([{ type: 'remove', text: '<lora:Illustrious\\style\\heightRatioSliderIllustrious.safetensors:0.5>' }, { type: 'replace', search: '<lora:Mayoko\\rory\\rory_run2_2026-06-1280.safetensors:0.8>', replacement: '<lora:Mayoko/rory/rory_run2_2026-06-1280:0.7>' }]) },
]);

export function createProcessingPresetService({ repository, watermarkService } = {}) {
  if (!repository || !['findById', 'list', 'create', 'rename', 'replace', 'delete', 'seedReferenceData'].every((method) => typeof repository[method] === 'function')) {
    throw new Error('createProcessingPresetService requires a processing preset repository.');
  }
  if (!watermarkService || typeof watermarkService.getWatermark !== 'function' || typeof watermarkService.resolveForProcessing !== 'function') {
    throw new Error('createProcessingPresetService requires a managed Watermark service.');
  }
  function requireRecord(id) {
    if (!isPositiveId(id)) throw new ProcessingPresetServiceError('presetId must be a positive integer.', { code: 'INVALID_PRESET_ID' });
    const record = repository.findById(id);
    if (!record) throw new ProcessingPresetServiceError('Processing preset not found.', { code: 'PRESET_NOT_FOUND' });
    return record;
  }

  function normalizeBindings() {
    // The column remains legacy schema; Scale Maps are no longer preset resources.
    return { watermarkId: null, scaleMapId: null };
  }

  function resolveWatermarkForExecution(watermarkId) {
    try {
      return watermarkService.resolveForProcessing(watermarkId).watermark;
    } catch (cause) {
      throw new ProcessingPresetServiceError(cause?.message || 'Watermark is unavailable.', {
        code: cause?.code || 'WATERMARK_NOT_FOUND', cause,
      });
    }
  }

  function mapRepositoryError(cause) {
    if (cause?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new ProcessingPresetServiceError('A preset with that operation type and display name already exists.', { code: 'PRESET_NAME_CONFLICT', cause });
    }
    throw cause;
  }

  return {
    listPresets({ operationType } = {}) {
      if (operationType !== undefined) normalizeOperationType(operationType);
      return repository.list(operationType).map((record) => {
        try { return publicRecord(record); } catch (error) {
          if (error?.code !== 'PRESET_INVALID') throw error;
          return { id: record.id, operationType: record.operation_type, displayName: record.display_name, systemKey: record.system_key, invalid: true };
        }
      });
    },
    getPreset(id) { return publicRecord(requireRecord(id)); },
    createPreset({ operationType, displayName, config } = {}) {
      const normalizedOperation = normalizeOperationType(operationType);
      // Transition: accept the legacy UI field but never store a Scale Map binding.
      const bindings = normalizeBindings();
      try {
        return publicRecord(repository.create({ operationType: normalizedOperation, displayName: normalizeDisplayName(displayName), configVersion: CONFIG_VERSION, configJson: stableJson(normalizeConfig(normalizedOperation, config)), ...bindings }));
      } catch (cause) { mapRepositoryError(cause); }
    },
    importPresetBundle(bundle = {}) {
      if (typeof repository.importPresets !== 'function') {
        throw new ProcessingPresetServiceError('Processing preset bundle import is unavailable.', { code: 'PRESET_IMPORT_UNAVAILABLE' });
      }
      const normalized = normalizePresetBundle(bundle);
      try {
        const records = repository.importPresets({
          operationType: normalized.operationType,
          presets: normalized.presets.map((preset) => ({
            displayName: preset.displayName,
            configVersion: CONFIG_VERSION,
            configJson: stableJson(preset.config),
          })),
        });
        const presets = records.map(publicRecord);
        const renamed = presets.reduce((count, preset, index) => (
          count + (preset.displayName === normalized.presets[index].displayName ? 0 : 1)
        ), 0);
        return { imported: presets.length, renamed, presets };
      } catch (cause) { mapRepositoryError(cause); }
    },
    renamePreset(id, displayName) {
      requireRecord(id);
      try {
        const record = repository.rename(id, normalizeDisplayName(displayName));
        if (!record) throw new ProcessingPresetServiceError('Processing preset not found.', { code: 'PRESET_NOT_FOUND' });
        return publicRecord(record);
      } catch (cause) { mapRepositoryError(cause); }
    },
    replacePreset(id, { config } = {}) {
      const current = requireRecord(id);
      const normalizedConfig = normalizeConfig(current.operation_type, config);
      // A submitted legacy scaleMapId is intentionally ignored during this transition.
      const bindings = normalizeBindings();
      try {
        return publicRecord(repository.replace(id, { configJson: stableJson(normalizedConfig), ...bindings }));
      } catch (cause) { mapRepositoryError(cause); }
    },
    deletePreset(id) {
      requireRecord(id);
      const record = repository.delete(id);
      if (!record) throw new ProcessingPresetServiceError('Processing preset not found.', { code: 'PRESET_NOT_FOUND' });
      return publicRecord(record);
    },
    resolvePresetForExecution(id, runtimeResources = {}) {
      const preset = publicRecord(requireRecord(id));
      if (!runtimeResources || typeof runtimeResources !== 'object' || Array.isArray(runtimeResources)) {
        throw new ProcessingPresetServiceError('Runtime preset resources must be an object.', { code: 'INVALID_PRESET_RESOURCES' });
      }
      if (preset.operationType !== 'watermark') return { ...preset, options: preset.config, watermark: null };
      const hasWatermarkOverride = Object.hasOwn(runtimeResources, 'watermarkId');
      if (!hasWatermarkOverride || runtimeResources.watermarkId === null || runtimeResources.watermarkId === undefined) {
        throw new ProcessingPresetServiceError('A global Watermark must be selected before execution.', { code: 'WATERMARK_REQUIRED' });
      }
      if (!isPositiveId(runtimeResources.watermarkId)) {
        throw new ProcessingPresetServiceError('watermarkId must be a positive integer.', { code: 'INVALID_WATERMARK_ID' });
      }
      const watermarkId = runtimeResources.watermarkId;
      // Scale maps resolve in Planner/Apply through the canonical singleton.
      // A legacy runtime scaleMapId is accepted by the route but intentionally ignored.
      const watermark = resolveWatermarkForExecution(watermarkId);
      return {
        ...preset,
        options: { ...preset.config, watermarkId },
        watermarkId,
        watermark,
      };
    },
    seedReferencePresets() {
      const scaleMapConfig = stableJson(REFERENCE_SCALE_MAP);
      const presets = SEEDED_PRESETS.map((preset) => ({
        ...preset,
        configVersion: CONFIG_VERSION,
        configJson: stableJson(normalizeConfig(preset.operationType, preset.config)),
        watermarkId: null,
        scaleMapId: null,
      }));
      return repository.seedReferenceData({
        markerKey: SEED_MARKER_KEY,
        scaleMap: { systemKey: 'reference-watermark-scale-map', displayName: 'Reference Watermark Scale Map', definitionJson: scaleMapConfig },
        presets,
      });
    },
  };
}
