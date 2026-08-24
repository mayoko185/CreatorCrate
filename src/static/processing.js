import {
  enhanceNumberInputs,
  refreshProjectAssetsLiveRegion,
  requestAppConfirmation,
  syncCreatorCrateDropdownFromNative,
} from './creatorcrate.js';
import {
  creatorCrateDropdownSummaryForNativeSelect,
  initializeCreatorCrateDropdown,
} from './client/dropdowns.js';

/**
 * Processing actions: Convert, Workflow Prompt Editor, Watermark, and Archives
 * dialogs on /projects/:id/assets, plus the global Watermark/scale-map dialogs they
 * link to. One cohesive enhancement module, following the data-attribute +
 * delegated-event conventions used throughout creatorcrate.js.
 *
 * Dialog open/close/focus/Escape/scroll all come from the existing
 * [data-app-dialog] framework (enhanceAppDialogs) — this module only wires
 * the processing-specific behavior inside each dialog body.
 */

const ROOT_SELECTOR = '[data-processing-root]';
const MANAGE_WATERMARKS_SELECTOR = '[data-processing-manage-watermarks]';
const MANAGE_SCALE_MAP_SELECTOR = '[data-processing-manage-scale-map]';
const ASSET_CHECKBOX_SELECTOR = '.asset-select-checkbox';
const OPERATION_PLAN_PATH = (projectId, operation) => `/projects/${projectId}/assets/processing/${operation}/plan`;
const OPERATION_APPLY_PATH = (projectId, operation) => `/projects/${projectId}/assets/processing/${operation}/apply`;
const PROCESSING_JOB_PATH = (jobId) => `/processing/jobs/${encodeURIComponent(jobId)}`;
const PROCESSING_JOB_POLL_INTERVAL_MS = 1_000;
const AUTO_RESCAN_OPERATIONS = new Set(['convert', 'watermark']);
const ACTIVE_PROCESSING_JOB_STATES = new Set(['queued', 'running']);
const TERMINAL_PROCESSING_JOB_STATES = new Set(['succeeded', 'failed', 'cancelled']);
const LEGACY_WATERMARK_ARCHIVE_FIELDS = new Set([
  'makeArchives', 'archiveIncludeResized', 'replaceExistingArchives', 'archiveFormat',
  'zipJpgQuality', 'zipWebpQuality', 'setName', 'archivePrefix', 'zipBaseName',
  'makeCbz', 'cbzJpgQuality', 'cbzPrefix', 'cbzFrom',
]);
const PORTABLE_PRESET_MARKER = 'processing-presets';
const PORTABLE_PRESET_VERSION = 1;
const PORTABLE_PRESET_TYPES = new Set(['convert', 'workflow-prompt', 'watermark']);
const PORTABLE_PRESET_KEYS = new Set(['creatorcrate', 'version', 'operationType', 'presets']);
const PORTABLE_PRESET_ENTRY_KEYS = new Set(['displayName', 'config']);
const PORTABLE_CONVERT_KEYS = new Set(['format', 'quality', 'originalHandling']);
const PORTABLE_WORKFLOW_KEYS = new Set(['positive', 'negative']);
const PORTABLE_WATERMARK_KEYS = new Set([
  'mode', 'workflow', 'position', 'marginRatio', 'margin', 'marginPercent', 'marginPx', 'opacity',
  'primaryFormat', 'secondaryFormat', 'resizedFormat', 'quality', 'maxDimension', 'deleteSource', 'deleteOriginal', 'scale',
  'watermarkScale', 'scaleBasis', 'windowAspect', 'fixedWatermarkWidthPx', 'fixedWmPx', 'nudgeX',
  'nudgeY', 'nudgeXRatio', 'nudgeXPercent', 'nudgeYRatio', 'nudgeYPercent', 'allowOffCanvas',
  'containment', 'overwrite', 'unresizedSuffix', 'resizedSuffix', 'singleSuffix',
  'suffix', 'socialSuffix', 'suffixUnresized', 'suffixResized', 'outputCategorySlug', 'outputDir', 'outputDirectory', 'trimWatermark', 'watermarkBeforeResize', 'webpLossless', 'jpegBackground', 'makeArchives', 'makeCbz', 'archiveIncludeResized',
  'replaceExistingArchives', 'archiveFormat', 'zipJpgQuality', 'zipWebpQuality', 'setName',
  'archivePrefix', 'zipBaseName', 'cbzPrefix', 'cbzFrom', 'cbzJpgQuality',
]);
const PORTABLE_WATERMARK_BOOLEAN_KEYS = new Set([
  'deleteSource', 'deleteOriginal', 'allowOffCanvas', 'overwrite', 'trimWatermark',
  'watermarkBeforeResize', 'webpLossless', 'makeArchives', 'makeCbz', 'archiveIncludeResized',
  'replaceExistingArchives',
]);
const PORTABLE_WATERMARK_INTEGER_KEYS = new Set([
  'marginPx', 'quality', 'maxDimension', 'fixedWatermarkWidthPx', 'fixedWmPx', 'nudgeX', 'nudgeY',
  'zipJpgQuality', 'zipWebpQuality', 'cbzJpgQuality',
]);
const PORTABLE_WATERMARK_NUMBER_KEYS = new Set([
  'marginRatio', 'margin', 'marginPercent', 'opacity', 'scale', 'watermarkScale', 'windowAspect',
  'nudgeXRatio', 'nudgeXPercent', 'nudgeYRatio', 'nudgeYPercent',
]);
const PORTABLE_WATERMARK_STRING_KEYS = new Set([
  'mode', 'workflow', 'position', 'scaleBasis', 'containment',
  'unresizedSuffix', 'resizedSuffix', 'singleSuffix', 'suffix', 'socialSuffix', 'suffixUnresized', 'suffixResized',
  'outputCategorySlug', 'jpegBackground', 'archiveFormat', 'setName',
  'archivePrefix', 'zipBaseName', 'cbzPrefix', 'cbzFrom',
]);
const PORTABLE_WATERMARK_FORMAT_KEYS = new Set(['primaryFormat', 'secondaryFormat', 'resizedFormat']);
const PORTABLE_FORBIDDEN_KEY_NAMES = new Set([
  '__proto__', 'prototype', 'constructor', 'projectid', 'assetid', 'assetids', 'categoryid', 'scope',
  'directory', 'directories', 'outputdir', 'outputdirectory', 'outputcategoryid', 'recursive', 'watermarkid', 'watermarkassetid',
  'scalemapid', 'scalemap', 'absolutepath', 'path', 'relativepath', 'entries', 'watermarkpath',
  'watermarkfile', 'scalemappath', 'scalemapfile', 'generatedoutput', 'generatedstate',
  'systemkey', 'createdat', 'updatedat', 'configversion', 'operationtype', 'displayname', 'presetid', 'id',
]);

function isBound(element, key) {
  return element?.[`__ccProcessingBound_${key}`] === true;
}

function markBound(element, key) {
  if (element) element[`__ccProcessingBound_${key}`] = true;
}

function liveDocument(scope) {
  if (!scope) return globalThis.document || null;
  if (scope.nodeType === 9) return scope;
  return scope.ownerDocument || globalThis.document || null;
}

// ─── Fetch / envelope handling ──────────────────────────────────────────

class ProcessingRequestError extends Error {
  constructor(message, { field, status, code } = {}) {
    super(message);
    this.name = 'ProcessingRequestError';
    this.field = field;
    this.status = status;
    this.code = code;
  }
}

function isPlainJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeWatermarkSuffixAliases(config) {
  const normalized = cloneJson(config);
  const copyLegacySuffix = (canonicalKey, legacyKeys) => {
    if (Object.hasOwn(config, canonicalKey)) return;
    const legacyKey = legacyKeys.find((key) => typeof config[key] === 'string' && config[key].length > 0);
    if (legacyKey) normalized[canonicalKey] = config[legacyKey];
  };
  copyLegacySuffix('unresizedSuffix', ['suffixUnresized', 'singleSuffix', 'suffix', 'socialSuffix']);
  copyLegacySuffix('resizedSuffix', ['suffixResized']);
  ['singleSuffix', 'suffix', 'socialSuffix', 'suffixUnresized', 'suffixResized']
    .forEach((key) => delete normalized[key]);
  if (!Object.hasOwn(config, 'outputCategorySlug')) {
    const legacy = config.outputDir ?? config.outputDirectory;
    if (typeof legacy === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(legacy)) {
      normalized.outputCategorySlug = legacy;
    }
  }
  delete normalized.outputDir;
  delete normalized.outputDirectory;
  return normalized;
}

function normalizeWatermarkOutputSlots(config) {
  const normalized = cloneJson(config);
  const hasCanonicalSlots = ['primaryFormat', 'secondaryFormat', 'resizedFormat']
    .some((key) => Object.hasOwn(config, key));
  const normalizeSlot = (value) => {
    if (value === undefined || value === null || value === '' || value === 'none') return null;
    const format = String(value).toLowerCase();
    return format === 'jpg' ? 'jpeg' : format;
  };

  if (hasCanonicalSlots) {
    normalized.primaryFormat = normalizeSlot(config.primaryFormat);
    normalized.secondaryFormat = normalizeSlot(config.secondaryFormat);
    normalized.resizedFormat = normalizeSlot(config.resizedFormat);
  } else {
    const primary = normalizeSlot(config.outputFormat ?? config.format ?? 'png');
    const secondary = Array.isArray(config.additionalFormats)
      ? normalizeSlot(config.additionalFormats[0])
      : null;
    const maxDimension = Number.isSafeInteger(config.maxDimension) && config.maxDimension > 0
      ? config.maxDimension
      : null;
    const includeNormal = maxDimension === null || config.alsoUnresized === true;
    normalized.primaryFormat = includeNormal ? primary : null;
    normalized.secondaryFormat = includeNormal ? secondary : null;
    normalized.resizedFormat = maxDimension === null ? null : primary;
  }

  ['outputFormat', 'format', 'alsoUnresized', 'additionalFormats', 'additionalFormatsResized']
    .forEach((key) => delete normalized[key]);
  return normalized;
}

function normalizeWatermarkPresetConfig(config) {
  return normalizeWatermarkOutputSlots(normalizeWatermarkSuffixAliases(config));
}

function portableKeyName(key) {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function assertPortablePlainObject(value, label) {
  if (!isPlainJsonObject(value)) throw new ProcessingRequestError(`${label} must be a JSON object.`);
}

function assertPortableKeys(value, allowed, label) {
  assertPortablePlainObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ProcessingRequestError(`${label} contains an unsupported or runtime-only field.`);
    }
  }
}

function assertNoForbiddenPortableKeys(value, label = 'Preset settings') {
  if (Array.isArray(value)) {
    value.forEach((item) => assertNoForbiddenPortableKeys(item, label));
    return;
  }
  if (!isPlainJsonObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (PORTABLE_FORBIDDEN_KEY_NAMES.has(portableKeyName(key))) {
      throw new ProcessingRequestError(`${label} contains an unsupported or runtime-only field.`);
    }
    assertNoForbiddenPortableKeys(item, label);
  }
}

function assertPortableString(value, label) {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new ProcessingRequestError(`${label} is invalid.`);
  }
}

function normalizePortableWorkflowRules(value, side) {
  if (value === undefined) return [];
  let rules = value;
  if (isPlainJsonObject(value)) {
    assertPortableKeys(value, new Set(['rules']), `${side} workflow rules`);
    rules = value.rules;
  }
  if (!Array.isArray(rules)) throw new ProcessingRequestError(`${side} workflow rules must be an array.`);
  return rules.map((rule, index) => {
    if (!isPlainJsonObject(rule) || typeof rule.type !== 'string') {
      throw new ProcessingRequestError(`${side} rule ${index + 1} is invalid.`);
    }
    if (rule.type === 'replace') {
      assertPortableKeys(rule, new Set(['type', 'search', 'replacement']), `${side} rule ${index + 1}`);
      assertPortableString(rule.search, `${side} rule ${index + 1} search`);
      assertPortableString(rule.replacement, `${side} rule ${index + 1} replacement`);
      return { type: 'replace', search: rule.search, replacement: rule.replacement };
    }
    if (!['remove', 'prepend', 'append'].includes(rule.type)) {
      throw new ProcessingRequestError(`${side} rule ${index + 1} has an unsupported type.`);
    }
    assertPortableKeys(rule, new Set(['type', 'text']), `${side} rule ${index + 1}`);
    assertPortableString(rule.text, `${side} rule ${index + 1} text`);
    return { type: rule.type, text: rule.text };
  });
}

function normalizePortableConvertConfig(config) {
  assertPortableKeys(config, PORTABLE_CONVERT_KEYS, 'Convert preset configuration');
  if (!['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'].includes(config.format)) {
    throw new ProcessingRequestError('Convert preset format is invalid.');
  }
  if (!['keep', 'move', 'delete'].includes(config.originalHandling)) {
    throw new ProcessingRequestError('Convert preset original handling is invalid.');
  }
  const quality = config.quality === undefined ? 85 : config.quality;
  if (!Number.isInteger(quality) || quality < 1 || quality > 95) {
    throw new ProcessingRequestError('Convert preset quality is invalid.');
  }
  return { ...cloneJson(config), quality };
}

function normalizePortableWorkflowConfig(config) {
  assertPortableKeys(config, PORTABLE_WORKFLOW_KEYS, 'Workflow preset configuration');
  assertNoForbiddenPortableKeys(config, 'Workflow preset configuration');
  return {
    positive: normalizePortableWorkflowRules(config.positive, 'Positive'),
    negative: normalizePortableWorkflowRules(config.negative, 'Negative'),
  };
}

function normalizePortableWatermarkConfig(config) {
  const normalizedConfig = normalizeWatermarkPresetConfig(config);
  assertPortableKeys(normalizedConfig, PORTABLE_WATERMARK_KEYS, 'Watermark preset configuration');
  assertNoForbiddenPortableKeys(normalizedConfig, 'Watermark preset configuration');
  for (const [key, value] of Object.entries(normalizedConfig)) {
    if (PORTABLE_WATERMARK_BOOLEAN_KEYS.has(key)) {
      if (typeof value !== 'boolean') throw new ProcessingRequestError(`Watermark field ${key} is invalid.`);
      continue;
    }
    if (PORTABLE_WATERMARK_INTEGER_KEYS.has(key)) {
      if (key === 'maxDimension' && value === null) continue;
      if (!Number.isSafeInteger(value)) throw new ProcessingRequestError(`Watermark field ${key} is invalid.`);
      continue;
    }
    if (PORTABLE_WATERMARK_NUMBER_KEYS.has(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new ProcessingRequestError(`Watermark field ${key} is invalid.`);
      continue;
    }
    if (PORTABLE_WATERMARK_FORMAT_KEYS.has(key)) {
      if (value !== null && !['png', 'jpeg', 'webp'].includes(value)) {
        throw new ProcessingRequestError(`Watermark field ${key} is invalid.`);
      }
      continue;
    }
    if (PORTABLE_WATERMARK_STRING_KEYS.has(key)) {
      assertPortableString(value, `Watermark field ${key}`);
      continue;
    }
    throw new ProcessingRequestError(`Watermark field ${key} is invalid.`);
  }
  if (normalizedConfig.mode !== undefined && !['patreon', 'social', 'custom'].includes(normalizedConfig.mode)) {
    throw new ProcessingRequestError('Watermark mode is invalid.');
  }
  if (normalizedConfig.workflow !== undefined && !['patreon', 'social', 'custom'].includes(normalizedConfig.workflow)) {
    throw new ProcessingRequestError('Watermark workflow is invalid.');
  }
  if (normalizedConfig.position !== undefined && !['br', 'bl', 'tr', 'tl', 'c'].includes(normalizedConfig.position)) {
    throw new ProcessingRequestError('Watermark position is invalid.');
  }
  if (normalizedConfig.scaleBasis !== undefined && !['width', 'height', 'short', 'long', 'geo', 'diagonal', 'window'].includes(normalizedConfig.scaleBasis)) {
    throw new ProcessingRequestError('Watermark scale basis is invalid.');
  }
  if (normalizedConfig.containment !== undefined && !['clamp', 'shrink'].includes(normalizedConfig.containment)) {
    throw new ProcessingRequestError('Watermark containment is invalid.');
  }
  if (normalizedConfig.archiveFormat !== undefined && !['zip', '7z'].includes(normalizedConfig.archiveFormat)) {
    throw new ProcessingRequestError('Watermark archive format is invalid.');
  }
  if (normalizedConfig.cbzFrom !== undefined && !['unresized', 'resized'].includes(normalizedConfig.cbzFrom)) {
    throw new ProcessingRequestError('Watermark CBZ source is invalid.');
  }
  if (normalizedConfig.quality !== undefined && (normalizedConfig.quality < 1 || normalizedConfig.quality > 100)) {
    throw new ProcessingRequestError('Watermark quality is invalid.');
  }
  for (const key of ['zipJpgQuality', 'zipWebpQuality', 'cbzJpgQuality']) {
    if (normalizedConfig[key] !== undefined && (normalizedConfig[key] < 1 || normalizedConfig[key] > 100)) {
      throw new ProcessingRequestError(`Watermark field ${key} is invalid.`);
    }
  }
  for (const key of ['maxDimension', 'fixedWatermarkWidthPx', 'fixedWmPx']) {
    if (normalizedConfig[key] !== undefined && normalizedConfig[key] !== null && normalizedConfig[key] < 0) {
      throw new ProcessingRequestError(`Watermark field ${key} is invalid.`);
    }
  }
  return normalizedConfig;
}

function normalizePortablePresetEntry(value, expectedOperation, index) {
  assertPortableKeys(value, PORTABLE_PRESET_ENTRY_KEYS, `Preset ${index + 1}`);
  assertPortableString(value.displayName, `Preset ${index + 1} display name`);
  const displayName = value.displayName.trim();
  if (!displayName || displayName.length > 200) throw new ProcessingRequestError(`Preset ${index + 1} display name is invalid.`);
  assertNoForbiddenPortableKeys(value.config, `Preset ${index + 1} configuration`);
  let config;
  if (expectedOperation === 'convert') config = normalizePortableConvertConfig(value.config);
  else if (expectedOperation === 'workflow-prompt') config = normalizePortableWorkflowConfig(value.config);
  else config = normalizePortableWatermarkConfig(value.config);
  return { displayName, config };
}

function normalizePortablePresetBundle(value, expectedOperation) {
  assertPortableKeys(value, PORTABLE_PRESET_KEYS, 'Preset bundle');
  if (value.creatorcrate !== PORTABLE_PRESET_MARKER) throw new ProcessingRequestError('This is not a CreatorCrate processing preset bundle.');
  if (value.version !== PORTABLE_PRESET_VERSION) throw new ProcessingRequestError('This processing preset bundle version is unsupported.');
  if (!PORTABLE_PRESET_TYPES.has(value.operationType)) throw new ProcessingRequestError('This preset operation type is unsupported.');
  if (value.operationType !== expectedOperation) throw new ProcessingRequestError('This preset belongs to a different processing dialog.');
  if (!Array.isArray(value.presets)) throw new ProcessingRequestError('Preset bundle presets must be an array.');

  return {
    creatorcrate: PORTABLE_PRESET_MARKER,
    version: PORTABLE_PRESET_VERSION,
    operationType: value.operationType,
    presets: value.presets.map((preset, index) => normalizePortablePresetEntry(preset, value.operationType, index)),
  };
}

function portableConfigValue(value) {
  if (Array.isArray(value)) return value.map(portableConfigValue);
  if (!isPlainJsonObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PORTABLE_FORBIDDEN_KEY_NAMES.has(portableKeyName(key)))
      .map(([key, item]) => [key, portableConfigValue(item)]),
  );
}

function portableConfigForExport(config, operationType) {
  assertPortablePlainObject(config, 'Saved preset configuration');
  const portableConfig = portableConfigValue(
    operationType === 'watermark' ? normalizeWatermarkPresetConfig(config) : config,
  );
  return operationType === 'watermark'
    ? normalizePortableWatermarkConfig(portableConfig)
    : portableConfig;
}

function createPortablePresetBundle(root) {
  const operationType = root.dataset.processingOperation;
  const savedPresets = Array.from(root.__ccPresets?.values?.() || [])
    .filter((preset) => preset.operationType === operationType);
  if (savedPresets.length === 0) throw new ProcessingRequestError('There are no saved presets to export.');
  const document = {
    creatorcrate: PORTABLE_PRESET_MARKER,
    version: PORTABLE_PRESET_VERSION,
    operationType,
    presets: savedPresets.map((preset) => ({
      displayName: preset.displayName,
      config: portableConfigForExport(preset.config, operationType),
    })),
  };
  return normalizePortablePresetBundle(document, operationType);
}

function presetDownloadFilename(operationType) {
  const stem = String(operationType || 'processing-presets')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'processing-presets';
  return `creatorcrate-${stem}-presets.json`;
}

function downloadPresetBundle(root, document) {
  const doc = liveDocument(root);
  const urlApi = globalThis.URL;
  if (!doc?.createElement || typeof globalThis.Blob !== 'function' || typeof urlApi?.createObjectURL !== 'function') {
    throw new ProcessingRequestError('Preset export is unavailable in this browser.');
  }
  const link = doc.createElement('a');
  const url = urlApi.createObjectURL(new Blob([`${JSON.stringify(document, null, 2)}\n`], { type: 'application/json' }));
  link.href = url;
  link.download = presetDownloadFilename(document.operationType);
  link.setAttribute?.('download', link.download);
  link.hidden = true;
  const parent = doc.body || doc.documentElement || doc;
  parent.append?.(link);
  link.click?.();
  link.remove?.();
  urlApi.revokeObjectURL?.(url);
}

async function importPresetFile(root, file) {
  if (!file || root.__ccPresetBusy || typeof file.text !== 'function') return;
  root.__ccPresetBusy = true;
  showError(root, '');
  try {
    let raw;
    try {
      raw = await file.text();
    } catch {
      throw new ProcessingRequestError('The selected preset bundle file could not be read.');
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ProcessingRequestError('The selected preset bundle file is not valid JSON.');
    }
    const bundle = normalizePortablePresetBundle(parsed, root.dataset.processingOperation);
    const payload = await processingFetchJson('/processing/presets/import', {
      csrf: root.dataset.csrf,
      body: bundle,
    });
    await loadPresets(root);
    const imported = Number.isSafeInteger(payload.imported) ? payload.imported : bundle.presets.length;
    const renamed = Number.isSafeInteger(payload.renamed) ? payload.renamed : 0;
    setStatus(root, `Imported ${imported} presets.${renamed ? ` ${renamed} renamed to avoid name conflicts.` : ''}`);
  } catch (error) {
    showError(root, error.message || 'The preset bundle file could not be imported.');
  } finally {
    root.__ccPresetBusy = false;
    const input = root.querySelector('[data-processing-preset-import-input]');
    if (input) input.value = '';
  }
}

async function parseEnvelope(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw new ProcessingRequestError('The server returned an unexpected response. Try again.');
  }
  if (!response.ok || payload?.ok !== true) {
    const message = payload?.error?.message || 'The request could not be completed.';
    throw new ProcessingRequestError(message, {
      field: payload?.error?.field,
      status: response.status,
      code: payload?.error?.code,
    });
  }
  return payload;
}

async function processingFetchJson(url, { method = 'POST', csrf, body } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CSRF-Token': csrf || '',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ProcessingRequestError('Could not reach the server. Check your connection and try again.');
  }
  return parseEnvelope(response);
}

export async function rescanProjectAssetsAfterApply(root, {
  refreshAssets = refreshProjectAssetsLiveRegion,
  refreshUrl,
} = {}) {
  const projectId = root?.dataset?.projectId;
  if (!projectId) throw new ProcessingRequestError('Could not refresh the asset index.');

  const expectedRefreshUrl = `/projects/${encodeURIComponent(projectId)}/assets`;
  const scanUrl = refreshUrl === expectedRefreshUrl
    ? `${expectedRefreshUrl.slice(0, -'/assets'.length)}/scan`
    : `/projects/${encodeURIComponent(projectId)}/scan`;
  await processingFetchJson(scanUrl, {
    csrf: root.dataset.csrf,
  });
  if (!refreshAssets(liveDocument(root))) {
    throw new ProcessingRequestError('Could not refresh the asset browser.');
  }
}

// ─── Scope resolution (read live at Preview/Apply time — never cached) ─

function getSelectedAssetIds(document) {
  return Array.from(document.querySelectorAll(ASSET_CHECKBOX_SELECTOR))
    .filter((checkbox) => checkbox.checked && checkbox.name === 'selectedAssetIds')
    .map((checkbox) => Number(checkbox.value))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

function currentCategoryIdFromUrl(window) {
  const params = new window.URLSearchParams(window.location.search || '');
  const category = params.get('category');
  if (!category || category === 'all' || category === 'uncategorized') return null;
  const id = Number(category);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function getSelectedCategoryId(root) {
  const select = root.querySelector('[data-processing-category-select]');
  if (!select) return null;
  const value = Number(select.value);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function resolveScope(root) {
  const document = liveDocument(root);
  const window = document?.defaultView || globalThis;
  const checked = root.querySelector('[data-processing-scope-option]:checked');
  const type = checked?.value;

  if (type === 'selected') {
    const assetIds = getSelectedAssetIds(document);
    if (assetIds.length === 0) {
      throw new ProcessingRequestError('Select at least one asset in the browser list to use this scope.');
    }
    return { type: 'selected', assetIds };
  }
  if (type === 'category') {
    const categoryId = getSelectedCategoryId(root);
    if (!categoryId) throw new ProcessingRequestError('Select a category to use this scope.');
    return { type: 'category', categoryId };
  }
  if (type === 'project') return { type: 'project' };
  throw new ProcessingRequestError('Choose a scope before continuing.');
}

function syncCategoryPickerState(root) {
  const categorySelect = root.querySelector('[data-processing-category-select]');
  if (!categorySelect) return;
  categorySelect.disabled = false;
}

function applyDefaultScope(root) {
  const document = liveDocument(root);
  const window = document?.defaultView || globalThis;
  const selectedIds = getSelectedAssetIds(document);
  const currentCategoryId = currentCategoryIdFromUrl(window);

  const selectedRadio = root.querySelector('[data-processing-scope-option="selected"]');
  const categoryRadio = root.querySelector('[data-processing-scope-option="category"]');
  const projectRadio = root.querySelector('[data-processing-scope-option="project"]');
  const categorySelect = root.querySelector('[data-processing-category-select]');

  if (selectedIds.length > 0) {
    if (selectedRadio) selectedRadio.checked = true;
  } else if (currentCategoryId) {
    if (categoryRadio) categoryRadio.checked = true;
    if (categorySelect) {
      categorySelect.value = String(currentCategoryId);
      syncCreatorCrateDropdownFromNative(categorySelect);
    }
  } else if (projectRadio) {
    projectRadio.checked = true;
  }

  syncCategoryPickerState(root);
}

function updateScopeDisplay(root) {
  const document = liveDocument(root);
  const window = document?.defaultView || globalThis;
  const selectedIds = getSelectedAssetIds(document);
  const countEl = root.querySelector('[data-processing-selected-count]');
  if (countEl) countEl.textContent = String(selectedIds.length);

  const selectedRadio = root.querySelector('[data-processing-scope-option="selected"]');
  const selectedHint = root.querySelector('[data-processing-selected-hint]');
  if (selectedRadio) selectedRadio.disabled = selectedIds.length === 0;
  if (selectedHint) selectedHint.hidden = selectedIds.length > 0;

  syncCategoryPickerState(root);
}

// ─── Generic field serialization ────────────────────────────────────────

function readFieldValue(el) {
  const type = el.dataset.processingType;
  if (type === 'bool') return el.checked;
  if (type === 'list') {
    return Array.from(el.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => cb.value);
  }
  const raw = el.value;
  if (type === 'int' || type === 'int-or-null') {
    if (raw === '' || raw === null || raw === undefined) return type === 'int-or-null' ? null : undefined;
    const parsed = parseInt(raw, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (type === 'float') {
    if (raw === '') return undefined;
    const parsed = parseFloat(raw);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return raw;
}

function collectOptions(root) {
  const options = {};
  root.querySelectorAll('[data-processing-field]').forEach((el) => {
    const field = el.dataset.processingField;
    if (!field) return;
    const type = el.dataset.processingType;
    const omitIfEmpty = el.dataset.processingOmitIfEmpty === 'true';
    const value = readFieldValue(el);
    if (value === undefined) return;
    if (omitIfEmpty && value === '') return;
    if (type === 'list' && value.length === 0) return;
    options[field] = value;
  });
  return options;
}

function validateWatermarkOutputSlots(root) {
  const valueFor = (field) => String(root.querySelector(`[data-processing-field="${field}"]`)?.value || 'none').toLowerCase();
  const primary = valueFor('primaryFormat');
  const secondary = valueFor('secondaryFormat');
  const resized = valueFor('resizedFormat');
  if ([primary, secondary, resized].every((format) => format === 'none' || format === '')) {
    throw new ProcessingRequestError('Choose at least one Watermark output format.');
  }
  if (primary !== 'none' && primary === secondary) {
    throw new ProcessingRequestError('Primary and Secondary formats must differ when both are enabled.');
  }
  if (resized !== 'none') {
    const maxDimension = Number(root.querySelector('[data-processing-field="maxDimension"]')?.value);
    if (!Number.isSafeInteger(maxDimension) || maxDimension <= 0) {
      throw new ProcessingRequestError('Resized format requires a Max dimension.');
    }
  }
}

function processingFormatValues(root, fieldName) {
  const field = root.querySelector(`[data-processing-field="${fieldName}"]`);
  if (!field) return [];
  if (field.dataset.processingType === 'list') {
    return Array.from(field.querySelectorAll('input[type="checkbox"]:checked')).map((checkbox) => checkbox.value);
  }
  return field.value ? [field.value] : [];
}

function formatSettingElement(root, fieldName) {
  const field = root.querySelector(`[data-processing-field="${fieldName}"]`);
  return root.querySelector(`[data-processing-format-setting="${fieldName}"]`)
    || field?.closest?.('.field')
    || field;
}

function setFormatSettingHidden(root, fieldName, hidden) {
  const setting = formatSettingElement(root, fieldName);
  if (!setting) return;
  setting.hidden = hidden;
  if (hidden) setting.setAttribute?.('hidden', '');
  else setting.removeAttribute?.('hidden');
}

export function syncWatermarkFormatSettings(root) {
  if (!root || root.dataset.processingOperation !== 'watermark') return;
  const formats = [
    'primaryFormat', 'secondaryFormat', 'resizedFormat',
  ].flatMap((fieldName) => processingFormatValues(root, fieldName))
    .map((value) => String(value).toLowerCase());
  const hasJpeg = formats.some((format) => format === 'jpg' || format === 'jpeg');
  const hasWebp = formats.includes('webp');
  const webpLossless = root.querySelector('[data-processing-field="webpLossless"]')?.checked === true;
  const hasLossyQuality = hasJpeg || (hasWebp && !webpLossless);
  setFormatSettingHidden(root, 'jpegBackground', !hasJpeg);
  setFormatSettingHidden(root, 'webpLossless', !hasWebp);
  setFormatSettingHidden(root, 'quality', !hasLossyQuality);
}

function dispatchNativeChange(el) {
  const document = liveDocument(el);
  const EventCtor = document?.defaultView?.Event || globalThis.Event;
  el.dispatchEvent(new EventCtor('change', { bubbles: true }));
}

function resetFields(root) {
  root.querySelectorAll('[data-processing-field]').forEach((el) => {
    const type = el.dataset.processingType;
    if (type === 'bool') {
      el.checked = el.hasAttribute('data-processing-default-checked') || el.defaultChecked;
      return;
    }
    if (type === 'list') {
      el.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
      return;
    }
    if (el.tagName === 'SELECT') {
      const defaultOption = Array.from(el.options).find((option) => option.defaultSelected);
      el.value = defaultOption ? defaultOption.value : (el.options[0]?.value ?? '');
      dispatchNativeChange(el);
      return;
    }
    if (el.hasAttribute('value') && el.type === 'hidden') return; // fixed fields (e.g. mode)
    el.value = '';
  });
}

function applyOptionsToForm(root, config) {
  resetFields(root);
  root.querySelectorAll('[data-processing-field]').forEach((el) => {
    const field = el.dataset.processingField;
    if (!Object.hasOwn(config || {}, field)) return;
    const type = el.dataset.processingType;
    const value = config[field];
    if (type === 'bool') {
      el.checked = Boolean(value);
    } else if (type === 'list') {
      const set = new Set((value || []).map(String));
      el.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = set.has(cb.value); });
    } else if (el.tagName === 'SELECT') {
      const isWatermarkOutputSlot = ['primaryFormat', 'secondaryFormat', 'resizedFormat'].includes(field);
      el.value = isWatermarkOutputSlot && (value === null || value === undefined)
        ? 'none'
        : (value === null || value === undefined ? '' : String(value));
      dispatchNativeChange(el);
    } else {
      el.value = value === null || value === undefined ? '' : String(value);
    }
  });
  syncWatermarkFormatSettings(root);
}

// ─── Preview / Apply state ──────────────────────────────────────────────

function setBusy(root, busy) {
  root.__ccProcessingBusy = busy;
  root.querySelectorAll('[data-processing-preview], [data-processing-apply]').forEach((button) => {
    if (button.hasAttribute('data-processing-apply') && !root.__ccPreviewValid) return;
    button.disabled = busy;
    button.setAttribute('aria-disabled', String(busy));
  });
  const previewButton = root.querySelector('[data-processing-preview]');
  if (previewButton) previewButton.disabled = busy;
}

function invalidatePreview(root) {
  root.__ccPreviewValid = false;
  clearWatermarkVisualPreview(root);
  const applyButton = root.querySelector('[data-processing-apply]');
  if (applyButton) {
    applyButton.disabled = true;
    applyButton.setAttribute('aria-disabled', 'true');
    applyButton.classList.remove('button-danger');
  }
}

function setStatus(root, message) {
  const status = root.querySelector('[data-processing-status]');
  if (status) status.textContent = message || '';
}

function showError(root, message) {
  const error = root.querySelector('[data-processing-error]');
  if (!error) return;
  if (!message) {
    error.hidden = true;
    return;
  }
  error.hidden = false;
  const text = error.querySelector('[data-processing-error-text]');
  if (text) text.textContent = message;
}

function clearPlan(root) {
  const plan = root.querySelector('[data-processing-plan]');
  if (plan) plan.hidden = true;
  const result = root.querySelector('[data-processing-result]');
  if (result) result.hidden = true;
}

function clearWatermarkVisualPreview(root) {
  if (root.dataset.processingOperation !== 'watermark') return;
  root.__ccWatermarkPreviewRequest = (root.__ccWatermarkPreviewRequest || 0) + 1;
  const url = root.__ccWatermarkPreviewUrl;
  const urlApi = liveDocument(root)?.defaultView?.URL || globalThis.URL;
  if (url && typeof urlApi?.revokeObjectURL === 'function') urlApi.revokeObjectURL(url);
  root.__ccWatermarkPreviewUrl = null;
  const section = root.querySelector('[data-processing-watermark-preview]');
  const imageWrap = root.querySelector('[data-processing-watermark-preview-image-wrap]');
  const image = root.querySelector('[data-processing-watermark-preview-image]');
  const source = root.querySelector('[data-processing-watermark-preview-source]');
  const state = root.querySelector('[data-processing-watermark-preview-state]');
  if (section) section.hidden = true;
  if (imageWrap) imageWrap.hidden = true;
  if (image) image.removeAttribute('src');
  if (source) { source.hidden = true; source.textContent = ''; }
  if (state) state.textContent = '';
}

function showWatermarkPreviewState(root, message) {
  const section = root.querySelector('[data-processing-watermark-preview]');
  const state = root.querySelector('[data-processing-watermark-preview-state]');
  const source = root.querySelector('[data-processing-watermark-preview-source]');
  const imageWrap = root.querySelector('[data-processing-watermark-preview-image-wrap]');
  if (section) section.hidden = false;
  if (state) state.textContent = message;
  if (source) { source.hidden = true; source.textContent = ''; }
  if (imageWrap) imageWrap.hidden = true;
}

function previewHeaderFilename(response) {
  const encoded = response.headers?.get?.('X-CreatorCrate-Preview-Source');
  if (!encoded) return '';
  try { return decodeURIComponent(encoded); } catch { return ''; }
}

async function fetchWatermarkPreviewImage(root, body) {
  let response;
  try {
    response = await fetch(`/projects/${encodeURIComponent(root.dataset.projectId)}/assets/processing/watermark/preview-image`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'image/*, application/json',
        'X-CSRF-Token': root.dataset.csrf || '',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ProcessingRequestError('Could not reach the image preview service. Check your connection and try again.');
  }
  if (response.status === 204) return null;
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new ProcessingRequestError(payload?.error?.message || 'The image preview could not be rendered.');
  }
  const contentType = response.headers?.get?.('Content-Type') || '';
  if (!contentType.startsWith('image/')) throw new ProcessingRequestError('The image preview service returned an unexpected response.');
  return {
    blob: await response.blob(),
    filename: previewHeaderFilename(response),
    eligibleCount: Number(response.headers?.get?.('X-CreatorCrate-Preview-Eligible-Count')) || 1,
    variant: response.headers?.get?.('X-CreatorCrate-Preview-Variant') || '',
  };
}

async function renderWatermarkPreview(root, body) {
  clearWatermarkVisualPreview(root);
  const request = root.__ccWatermarkPreviewRequest;
  let preview;
  try {
    preview = await fetchWatermarkPreviewImage(root, body);
  } catch (error) {
    if (root.__ccWatermarkPreviewRequest === request) {
      showWatermarkPreviewState(root, error.message || 'The image preview could not be rendered.');
    }
    return false;
  }
  if (root.__ccWatermarkPreviewRequest !== request) return false;
  if (!preview) {
    showWatermarkPreviewState(root, 'No previewable image is available for this scope.');
    return true;
  }
  const urlApi = liveDocument(root)?.defaultView?.URL || globalThis.URL;
  if (typeof urlApi?.createObjectURL !== 'function') {
    showWatermarkPreviewState(root, 'Image preview is unavailable in this browser.');
    return false;
  }
  const url = urlApi.createObjectURL(preview.blob);
  if (root.__ccWatermarkPreviewRequest !== request) {
    urlApi.revokeObjectURL?.(url);
    return false;
  }
  root.__ccWatermarkPreviewUrl = url;
  const section = root.querySelector('[data-processing-watermark-preview]');
  const state = root.querySelector('[data-processing-watermark-preview-state]');
  const source = root.querySelector('[data-processing-watermark-preview-source]');
  const imageWrap = root.querySelector('[data-processing-watermark-preview-image-wrap]');
  const image = root.querySelector('[data-processing-watermark-preview-image]');
  if (section) section.hidden = false;
  if (state) state.textContent = '';
  if (source) {
    const firstOfMany = preview.eligibleCount > 1 ? ` Previewing the first eligible asset of ${preview.eligibleCount}.` : '';
    source.textContent = `Previewing ${preview.filename || 'selected image'}.${firstOfMany}${preview.variant ? ` Variant: ${preview.variant}.` : ''}`;
    source.hidden = false;
  }
  if (image) {
    image.addEventListener?.('error', () => {
      if (root.__ccWatermarkPreviewUrl !== url) return;
      urlApi.revokeObjectURL?.(url);
      root.__ccWatermarkPreviewUrl = null;
      image.removeAttribute('src');
      showWatermarkPreviewState(root, 'The image preview could not be displayed.');
    }, { once: true });
    image.src = url;
  }
  if (imageWrap) imageWrap.hidden = false;
  return true;
}

// ─── Plan rendering ──────────────────────────────────────────────────────

const COUNT_LABELS = {
  total: 'Total', eligible: 'Eligible', changed: 'Changed', unchanged: 'Unchanged',
  skipped: 'Skipped', conflicts: 'Conflicts', destructive: 'Destructive',
};
const MAX_RENDERED_ITEMS = 500;

function renderPlanCounts(root, counts) {
  const dl = root.querySelector('[data-processing-plan-counts]');
  if (!dl || !counts) return;
  dl.innerHTML = '';
  Object.entries(COUNT_LABELS).forEach(([key, label]) => {
    const value = counts[key];
    if (typeof value !== 'number' || (value === 0 && key !== 'total' && key !== 'eligible')) return;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = String(value);
    dl.append(dt, dd);
  });
}

function renderDestructiveWarning(root, counts) {
  const warning = root.querySelector('[data-processing-plan-destructive]');
  const applyButton = root.querySelector('[data-processing-apply]');
  const destructive = counts?.destructive || 0;
  if (warning) {
    warning.hidden = destructive === 0;
    warning.textContent = destructive > 0
      ? `This plan includes ${destructive} destructive action${destructive === 1 ? '' : 's'} (such as deleting originals or watermark sources). Review before applying.`
      : '';
  }
  if (applyButton) applyButton.classList.toggle('button-danger', destructive > 0);
}

function planItemLine(item) {
  const parts = [];
  const destination = item.plannedDestination;
  if (typeof destination === 'string' && destination) {
    parts.push(`→ ${destination}`);
  } else if (destination && typeof destination === 'object' && destination.operation === 'archive') {
    const formats = Array.isArray(destination.formats)
      ? destination.formats.map((format) => String(format).toUpperCase()).join('/')
      : 'archive';
    parts.push(`→ ${formats} archive outputs${destination.cbz ? ' + CBZ' : ''}`);
  }
  if (item.sourceAction && item.sourceAction !== 'keep') parts.push(`(${item.sourceAction} source)`);
  return parts.join(' ');
}

function renderPlanItems(root, items) {
  const list = root.querySelector('[data-processing-plan-items]');
  if (!list) return;
  list.innerHTML = '';
  if (!Array.isArray(items) || items.length === 0) return;
  const document = liveDocument(root);
  const shown = items.slice(0, MAX_RENDERED_ITEMS);
  shown.forEach((item) => {
    const li = document.createElement('li');
    li.className = `processing-plan-item processing-plan-item--${item.status || 'unknown'}`;
    if (item.destructive) li.classList.add('processing-plan-item--destructive');
    const name = document.createElement('span');
    name.className = 'processing-plan-item-name';
    name.textContent = item.relativePath || item.filename || `Asset ${item.assetId ?? ''}`;
    const status = document.createElement('span');
    status.className = 'processing-plan-item-status';
    status.textContent = item.status || '';
    li.append(name, status);
    const detail = planItemLine(item);
    if (detail) {
      const detailEl = document.createElement('span');
      detailEl.className = 'processing-plan-item-detail';
      detailEl.textContent = detail;
      li.append(detailEl);
    }
    if (item.reason) {
      const reason = document.createElement('span');
      reason.className = 'processing-plan-item-reason';
      reason.textContent = item.reason;
      li.append(reason);
    }
    list.append(li);
  });
  if (items.length > MAX_RENDERED_ITEMS) {
    const more = document.createElement('li');
    more.className = 'processing-plan-item-more';
    more.textContent = `…and ${items.length - MAX_RENDERED_ITEMS} more.`;
    list.append(more);
  }
}

function renderPlan(root, plan) {
  const planEl = root.querySelector('[data-processing-plan]');
  if (!planEl) return false;
  planEl.hidden = false;
  renderPlanCounts(root, plan.counts);
  renderDestructiveWarning(root, plan.counts);
  renderPlanItems(root, plan.items);
  if (plan?.operation === 'archive') renderArchivePlanDetails(root, plan);
  return archivePlanCanApply(plan);
}

// ─── Result rendering ────────────────────────────────────────────────────

function resultLine(label, value) {
  return typeof value === 'number' && value > 0 ? `${label}: ${value}` : null;
}

function basename(relativePath) {
  if (typeof relativePath !== 'string') return '';
  return relativePath.split('/').pop();
}

function renderConvertResult(body, result) {
  const p = document.createElement('p');
  p.textContent = `Converted ${result.convertedCount} of ${result.requestedCount} asset${result.requestedCount === 1 ? '' : 's'} to ${String(result.format || '').toUpperCase()}.`;
  body.append(p);
}

function renderWorkflowResult(body, result) {
  [
    resultLine('Changed', result.changedCount),
    resultLine('Unchanged', result.unchangedCount),
    resultLine('No workflow metadata', result.noWorkflowAssetIds?.length),
    resultLine('No prompt change', result.noChangeAssetIds?.length),
  ].filter(Boolean).forEach((line) => {
    const p = document.createElement('p');
    p.textContent = line;
    body.append(p);
  });
}

function renderWatermarkResult(body, result) {
  const document = body.ownerDocument || globalThis.document;
  const p = document.createElement('p');
  p.textContent = `Watermarked ${result.generatedCount} of ${result.requestedCount} asset${result.requestedCount === 1 ? '' : 's'}.`;
  body.append(p);
  if (result.deletedSourceAssetIds?.length) {
    const del = document.createElement('p');
    del.textContent = `Deleted ${result.deletedSourceAssetIds.length} source file${result.deletedSourceAssetIds.length === 1 ? '' : 's'}.`;
    body.append(del);
  }
}

const ARCHIVE_KIND_LABELS = {
  'archive-jpg': 'JPEG archive',
  'archive-webp': 'WebP archive',
  'archive-cbz': 'CBZ',
};

function archiveKindLabel(kind) {
  return ARCHIVE_KIND_LABELS[kind] || 'Archive';
}

function archiveContainerLabel(archive) {
  const format = String(archive.containerFormat || archive.format || '').toUpperCase();
  return archive.kind === 'archive-cbz' ? `CBZ (${format || 'ZIP'} container)` : (format || 'archive');
}

function renderArchivePlanDetails(root, plan) {
  const details = root.querySelector('[data-processing-archive-plan-details]');
  if (!details) return;
  const document = liveDocument(root);
  details.innerHTML = '';

  const summary = document.createElement('p');
  summary.className = 'help-text';
  summary.textContent = `Eligible source assets: ${Number(plan.sourceCount) || 0}. Planned entries: ${Number(plan.entryCount) || 0}.`;
  details.append(summary);

  const archives = Array.isArray(plan.archives) ? plan.archives : [];
  if (archives.length > 0) {
    const heading = document.createElement('h3');
    heading.textContent = 'Planned archives';
    details.append(heading);
    const list = document.createElement('ul');
    list.className = 'processing-plan-items';
    archives.forEach((archive) => {
      const li = document.createElement('li');
      li.className = `processing-plan-item processing-plan-item--${archive.status || 'unknown'}`;
      const status = archive.status || 'unknown';
      const entryLabel = archive.entryCount === 1 ? 'entry' : 'entries';
      li.textContent = `${archiveKindLabel(archive.kind)}: ${basename(archive.relativePath)} — ${archiveContainerLabel(archive)}, quality ${archive.quality}, ${archive.entryCount ?? 0} ${entryLabel}; ${status}.`;
      if (archive.reasonCode) {
        const reason = document.createElement('span');
        reason.className = 'processing-plan-item-reason';
        reason.textContent = `Blocker: ${archive.reasonCode}.`;
        li.append(reason);
      }
      list.append(li);
    });
    details.append(list);
  }

  const blockers = Array.isArray(plan.operationBlockers) ? plan.operationBlockers : [];
  if (blockers.length > 0) {
    const heading = document.createElement('h3');
    heading.textContent = 'Conflicts and blockers';
    details.append(heading);
    const list = document.createElement('ul');
    list.className = 'processing-plan-items';
    blockers.forEach((blocker) => {
      const li = document.createElement('li');
      li.className = 'processing-plan-item processing-plan-item--conflict';
      const target = blocker.relativePath ? ` (${basename(blocker.relativePath)})` : '';
      li.textContent = `${blocker.reason || blocker.code || 'This plan cannot be applied.'}${target}`;
      list.append(li);
    });
    details.append(list);
  }
  details.hidden = false;
}

function archivePlanCanApply(plan) {
  if (plan?.operation !== 'archive') return true;
  const archives = Array.isArray(plan.archives) ? plan.archives : [];
  const blockers = Array.isArray(plan.operationBlockers) ? plan.operationBlockers : [];
  return archives.length > 0 && blockers.length === 0 && archives.every((archive) => archive.status === 'ready');
}

function renderArchiveResult(body, result) {
  const document = body.ownerDocument || globalThis.document;
  const sourceCount = Number(result.sourceCount ?? result.requestedCount) || 0;
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  const summary = document.createElement('p');
  summary.textContent = `Generated ${artifacts.length} archive artifact${artifacts.length === 1 ? '' : 's'} from ${sourceCount} source asset${sourceCount === 1 ? '' : 's'}.`;
  body.append(summary);

  if (artifacts.length > 0) {
    const list = document.createElement('ul');
    artifacts.forEach((artifact) => {
      const li = document.createElement('li');
      const container = String(artifact.containerFormat || artifact.format || '').toUpperCase();
      const entryLabel = artifact.entryCount === 1 ? 'entry' : 'entries';
      li.textContent = `${basename(artifact.relativePath)} — ${container || 'archive'} container, ${artifact.entryCount ?? 0} ${entryLabel}, quality ${artifact.quality ?? 'default'}.`;
      list.append(li);
    });
    body.append(list);
  }
}

const RESULT_RENDERERS = {
  convert: renderConvertResult,
  'workflow-prompt': renderWorkflowResult,
  watermark: renderWatermarkResult,
  archive: renderArchiveResult,
};

function renderResult(root, operation, result) {
  const resultEl = root.querySelector('[data-processing-result]');
  const body = root.querySelector('[data-processing-result-body]');
  if (!resultEl || !body) return;
  body.innerHTML = '';
  resultEl.hidden = false;
  (RESULT_RENDERERS[operation] || (() => {}))(body, result || {});
}

// ─── Preset handling ─────────────────────────────────────────────────────

async function loadPresets(root) {
  const select = root.querySelector('[data-processing-preset-select]');
  if (!select) return;
  const operation = root.dataset.processingOperation;
  const projectId = root.dataset.projectId;
  try {
    const payload = await processingFetchJson(`/processing/presets?operationType=${encodeURIComponent(operation)}`, {
      method: 'GET',
      csrf: root.dataset.csrf,
    });
    root.__ccPresets = new Map((payload.presets || []).map((preset) => [String(preset.id), preset]));
    const current = select.value;
    Array.from(select.querySelectorAll('option:not(:first-child)')).forEach((option) => option.remove());
    (payload.presets || []).forEach((preset) => {
      const option = document.createElement('option');
      option.value = String(preset.id);
      option.textContent = preset.displayName;
      select.append(option);
    });
    if (root.__ccPresets.has(current)) select.value = current;
    syncCreatorCrateDropdownFromNative?.(select);
  } catch {
    // Presets remain unavailable; Custom is always usable.
  }
  updatePresetActionState(root);
  void projectId;
}

function applyPreset(root, preset) {
  const watermarkSelect = root.dataset.processingOperation === 'watermark'
    ? root.querySelector('#watermark-resource-select')
    : null;
  const selectedWatermarkId = watermarkSelect?.value || '';
  const config = root.dataset.processingOperation === 'watermark'
    ? normalizeWatermarkPresetConfig(preset?.config && typeof preset.config === 'object' ? preset.config : {})
    : (preset?.config || {});

  if (root.dataset.processingOperation === 'watermark') {
    root.__ccPreservedWatermarkArchiveConfig = Object.fromEntries(
      Array.from(LEGACY_WATERMARK_ARCHIVE_FIELDS)
        .filter((field) => Object.hasOwn(config, field))
        .map((field) => [field, config[field]]),
    );
  } else {
    root.__ccPreservedWatermarkArchiveConfig = {};
  }
  if (root.dataset.processingOperation === 'workflow-prompt') {
    applyWorkflowRulesToForm(root, 'positive', preset ? preset.config?.positive : null);
    applyWorkflowRulesToForm(root, 'negative', preset ? preset.config?.negative : null);
  } else {
    applyOptionsToForm(root, config);
  }
  if (root.dataset.processingOperation === 'watermark') {
    const outputCategorySelect = root.querySelector('[data-processing-field="outputCategorySlug"]');
    root.__ccMissingPresetOutputCategory = Boolean(
      config.outputCategorySlug && !outputCategorySelect?.value,
    );
    if (watermarkSelect) {
      // Global Watermarks are runtime-only state. Applying a preset may reset
      // the processing options, but it must never source or own the current selection.
      watermarkSelect.value = selectedWatermarkId;
      syncCreatorCrateDropdownFromNative(watermarkSelect);
    }
    syncCreatorCrateDropdownFromNative(outputCategorySelect);
    syncWatermarkProcessingState(root);
    updateWatermarkThumb(root);
  }
  clearModifiedState(root);
  hidePresetNameForm(root);
  updatePresetActionState(root);
  invalidatePreview(root);
  clearPlan(root);
}

function bindPresetSelect(root) {
  const select = root.querySelector('[data-processing-preset-select]');
  if (!select || isBound(select, 'preset')) return;
  markBound(select, 'preset');
  select.addEventListener('change', () => {
    const preset = root.__ccPresets?.get(select.value) || null;
    applyPreset(root, preset);
  });
}

// ─── Preset management (save / update / rename / delete) ────────────────
//
// Presets never carry runtime-only state: no projectId, assetIds, category,
// directory, recursive, or scope. Convert/Workflow configs come straight
// from the same field-collection helpers used for direct (non-preset)
  // requests; Watermark configs strip the global Watermark runtime binding.

function collectPresetConfig(root) {
  if (root.dataset.processingOperation === 'workflow-prompt') {
    return { positive: collectWorkflowRules(root, 'positive'), negative: collectWorkflowRules(root, 'negative') };
  }
  const options = collectOptions(root);
  if (root.dataset.processingOperation === 'watermark') {
    const {
      watermarkId, ...config
    } = options;
    Object.assign(config, root.__ccPreservedWatermarkArchiveConfig || {});
    return normalizeWatermarkPresetConfig(config);
  }
  return options;
}

function selectPresetOption(root, presetId) {
  const select = root.querySelector('[data-processing-preset-select]');
  if (select) select.value = presetId ? String(presetId) : '';
}

function clearModifiedState(root) {
  root.__ccDirty = false;
  const modifiedNote = root.querySelector('[data-processing-preset-modified]');
  if (modifiedNote) modifiedNote.hidden = true;
}

function markPresetChanged(root) {
  invalidatePreview(root);
  clearPlan(root);
}

function updatePresetActionState(root) {
  const select = root.querySelector('[data-processing-preset-select]');
  const hasPreset = Boolean(select?.value);
  ['[data-processing-preset-update]', '[data-processing-preset-rename]', '[data-processing-preset-delete]'].forEach((selector) => {
    const button = root.querySelector(selector);
    if (!button) return;
    button.disabled = !hasPreset;
    button.setAttribute('aria-disabled', String(!hasPreset));
  });
  const exportButton = root.querySelector('[data-processing-preset-export]');
  if (exportButton) {
    const hasSavedPresets = Array.from(root.__ccPresets?.values?.() || [])
      .some((preset) => preset.operationType === root.dataset.processingOperation);
    exportButton.disabled = !hasSavedPresets;
    exportButton.setAttribute('aria-disabled', String(!hasSavedPresets));
  }
}

function hidePresetNameForm(root) {
  const form = root.querySelector('[data-processing-preset-name-form]');
  if (!form) return;
  form.hidden = true;
  form.removeAttribute('data-processing-preset-name-mode');
  const input = form.querySelector('[data-processing-preset-name-input]');
  if (input) input.value = '';
}

function openPresetNameForm(root, mode) {
  const form = root.querySelector('[data-processing-preset-name-form]');
  const input = form?.querySelector('[data-processing-preset-name-input]');
  const label = form?.querySelector('[data-processing-preset-name-label]');
  if (!form || !input) return;
  showError(root, '');
  form.hidden = false;
  form.setAttribute('data-processing-preset-name-mode', mode);
  if (mode === 'rename') {
    const select = root.querySelector('[data-processing-preset-select]');
    const preset = root.__ccPresets?.get(select?.value);
    input.value = preset?.displayName || '';
    if (label) label.textContent = 'Rename preset';
  } else {
    input.value = '';
    if (label) label.textContent = 'New preset name';
  }
  input.focus?.();
}

async function createPresetFromForm(root, displayName) {
  const body = {
    operationType: root.dataset.processingOperation,
    displayName,
    config: collectPresetConfig(root),
  };
  const payload = await processingFetchJson('/processing/presets', { csrf: root.dataset.csrf, body });
  await loadPresets(root);
  selectPresetOption(root, payload.preset.id);
  root.__ccPreservedWatermarkArchiveConfig = {};
  clearModifiedState(root);
  updatePresetActionState(root);
  markPresetChanged(root);
  return payload.preset;
}

async function renameSelectedPreset(root, displayName) {
  const id = root.querySelector('[data-processing-preset-select]')?.value;
  if (!id) return;
  await processingFetchJson(`/processing/presets/${id}/rename`, { csrf: root.dataset.csrf, body: { displayName } });
  await loadPresets(root);
  selectPresetOption(root, id);
  updatePresetActionState(root);
}

async function updateSelectedPreset(root) {
  const id = root.querySelector('[data-processing-preset-select]')?.value;
  if (!id) return;
  const config = collectPresetConfig(root);
  if (root.dataset.processingOperation === 'watermark') {
    Object.assign(config, root.__ccPreservedWatermarkArchiveConfig || {});
  }
  const body = { config };
  await processingFetchJson(`/processing/presets/${id}/replace`, { csrf: root.dataset.csrf, body });
  await loadPresets(root);
  selectPresetOption(root, id);
  clearModifiedState(root);
  updatePresetActionState(root);
  markPresetChanged(root);
}

async function deleteSelectedPreset(root, presetId) {
  const id = presetId || root.querySelector('[data-processing-preset-select]')?.value;
  if (!id) return;
  await processingFetchJson(`/processing/presets/${id}/delete`, { csrf: root.dataset.csrf, body: {} });
  await loadPresets(root);
  selectPresetOption(root, '');
  const select = root.querySelector('[data-processing-preset-select]');
  syncCreatorCrateDropdownFromNative?.(select);
  root.__ccPreservedWatermarkArchiveConfig = {};
  clearModifiedState(root);
  updatePresetActionState(root);
  markPresetChanged(root);
  creatorCrateDropdownSummaryForNativeSelect(select)?.focus?.({ preventScroll: true });
}

function bindPresetActions(root) {
  if (isBound(root, 'presetActions')) return;
  markBound(root, 'presetActions');

  root.querySelector('[data-processing-preset-export]')?.addEventListener('click', () => {
    if (root.__ccPresetBusy) return;
    showError(root, '');
    try {
      const bundle = createPortablePresetBundle(root);
      downloadPresetBundle(root, bundle);
      setStatus(root, `Exported ${bundle.presets.length} presets.`);
    } catch (error) {
      showError(root, error.message);
    }
  });

  const importButton = root.querySelector('[data-processing-preset-import]');
  const importInput = root.querySelector('[data-processing-preset-import-input]');
  importButton?.addEventListener('click', () => {
    if (!root.__ccPresetBusy) importInput?.click?.();
  });
  importInput?.addEventListener('change', () => {
    void importPresetFile(root, importInput.files?.[0]);
  });

  root.querySelector('[data-processing-preset-save]')?.addEventListener('click', () => {
    openPresetNameForm(root, 'save');
  });
  root.querySelector('[data-processing-preset-rename]')?.addEventListener('click', () => {
    if (!root.querySelector('[data-processing-preset-select]')?.value) return;
    openPresetNameForm(root, 'rename');
  });
  root.querySelector('[data-processing-preset-update]')?.addEventListener('click', async () => {
    if (!root.querySelector('[data-processing-preset-select]')?.value || root.__ccPresetBusy) return;
    root.__ccPresetBusy = true;
    showError(root, '');
    try {
      await updateSelectedPreset(root);
      setStatus(root, 'Preset updated.');
    } catch (error) {
      showError(root, error.message);
    } finally {
      root.__ccPresetBusy = false;
    }
  });
  const deleteButton = root.querySelector('[data-processing-preset-delete]');
  deleteButton?.addEventListener('click', async () => {
    const select = root.querySelector('[data-processing-preset-select]');
    const presetId = select?.value;
    const preset = root.__ccPresets?.get(presetId);
    if (!preset || root.__ccPresetBusy) return;
    const message = `Delete the preset "${preset.displayName}"? This does not delete Watermarks, scale maps, or generated files.`;
    root.__ccPresetBusy = true;
    showError(root, '');
    try {
      const confirmed = await requestAppConfirmation(liveDocument(root), {
        title: 'Delete preset',
        message,
        confirmLabel: 'Delete preset',
        opener: deleteButton,
      });
      if (!confirmed) return;
      await deleteSelectedPreset(root, presetId);
      setStatus(root, 'Preset deleted.');
    } catch (error) {
      showError(root, error.message);
    } finally {
      root.__ccPresetBusy = false;
    }
  });

  const nameForm = root.querySelector('[data-processing-preset-name-form]');
  nameForm?.querySelector('[data-processing-preset-name-cancel]')?.addEventListener('click', () => {
    hidePresetNameForm(root);
  });
  nameForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (root.__ccPresetBusy) return;
    const input = nameForm.querySelector('[data-processing-preset-name-input]');
    const mode = nameForm.getAttribute('data-processing-preset-name-mode');
    const displayName = input?.value.trim() || '';
    if (!displayName) { showError(root, 'A preset name is required.'); return; }
    root.__ccPresetBusy = true;
    showError(root, '');
    try {
      if (mode === 'rename') {
        await renameSelectedPreset(root, displayName);
        setStatus(root, 'Preset renamed.');
      } else {
        await createPresetFromForm(root, displayName);
        setStatus(root, 'Preset saved.');
      }
      hidePresetNameForm(root);
    } catch (error) {
      showError(root, error.message);
    } finally {
      root.__ccPresetBusy = false;
    }
  });
}

function bindDirtyTracking(root) {
  if (isBound(root, 'dirty')) return;
  markBound(root, 'dirty');
  const isWatermarkRuntimeSelection = (target) => root.dataset.processingOperation === 'watermark'
    && target?.closest?.('#watermark-resource-select, [data-processing-field="watermarkId"]');
  const handleChange = (event) => {
    if (root.dataset.processingOperation === 'watermark') syncWatermarkFormatSettings(root);
    if (event.target.closest('[data-processing-preset-select]')) return;
    if (isWatermarkRuntimeSelection(event.target)) {
      // A global Watermark changes effective runtime input and therefore
      // invalidates Preview, but it does not modify the reusable preset config.
      invalidatePreview(root);
      syncWatermarkProcessingState(root);
      return;
    }
    if (!event.target.closest('[data-processing-field], [data-processing-scope], [data-processing-category-select], [data-processing-rule-row]')) return;
    if (event.target.closest('[data-processing-field="outputCategorySlug"]')) {
      root.__ccMissingPresetOutputCategory = false;
      syncWatermarkProcessingState(root);
    }
    root.__ccDirty = true;
    const select = root.querySelector('[data-processing-preset-select]');
    const modifiedNote = root.querySelector('[data-processing-preset-modified]');
    if (select?.value && modifiedNote) modifiedNote.hidden = false;
    invalidatePreview(root);
  };
  root.addEventListener('input', (event) => {
    handleChange(event);
  });
  root.addEventListener('change', (event) => {
    handleChange(event);
  });
}

function bindScopeControls(root) {
  if (isBound(root, 'scopeControls')) return;
  markBound(root, 'scopeControls');
  const scopeFieldset = root.querySelector('[data-processing-scope]');
  if (!scopeFieldset) return;
  scopeFieldset.addEventListener('change', (event) => {
    if (event.target.matches('[data-processing-category-select]')) {
      const categoryId = Number(event.target.value);
      if (Number.isSafeInteger(categoryId) && categoryId > 0) {
        syncCreatorCrateDropdownFromNative(event.target);
        const categoryRadio = root.querySelector('[data-processing-scope-option="category"]');
        if (categoryRadio) categoryRadio.checked = true;
        syncCategoryPickerState(root);
        updateScopeDisplay(root);
        invalidatePreview(root);
      }
      return;
    }
    if (event.target.matches('input[type="radio"]')) {
      syncCategoryPickerState(root);
    }
  });
}

// ─── Global Watermark resource select ──────────────────────────────────────

function watermarkOptionLabel(candidate) {
  const filename = candidate.filename || candidate.relativePath || `Watermark ${candidate.id}`;
  const relativePath = candidate.relativePath && candidate.relativePath !== filename
    ? ` — ${candidate.relativePath}`
    : '';
  return `${filename}${relativePath}`;
}

export function decorateWatermarkDropdownOptions(root) {
  const select = root?.querySelector?.('#watermark-resource-select');
  const dropdown = select?.parentElement?.querySelector?.('[data-cc-dropdown]');
  const candidates = root?.__ccWatermarkCandidates;
  const document = root?.ownerDocument || globalThis.document;
  if (!select || !dropdown || !(candidates instanceof Map) || !document?.createElement) return;

  dropdown.querySelectorAll?.('input[type="radio"]').forEach((input) => {
    const candidate = candidates.get(String(input.value ?? ''));
    const label = input.closest?.('label');
    if (!label) return;

    const existing = label.querySelector?.('.processing-watermark-option-content');
    if (!candidate) {
      if (!existing) return;
      const copy = existing.querySelector?.('.processing-watermark-option-copy');
      const text = document.createElement('span');
      text.textContent = copy?.textContent || '';
      existing.remove?.();
      label.appendChild?.(text);
      return;
    }

    const labelText = watermarkOptionLabel(candidate);
    if (existing) {
      const image = existing.querySelector?.('.processing-watermark-option-thumbnail');
      const copy = existing.querySelector?.('.processing-watermark-option-copy');
      if (image) image.setAttribute?.('src', `/processing/watermarks/${encodeURIComponent(candidate.id)}/image`);
      if (copy) copy.textContent = labelText;
      return;
    }

    const text = Array.from(label.children || []).find((child) => child.tagName === 'SPAN');
    const content = document.createElement('span');
    const image = document.createElement('img');
    const copy = document.createElement('span');
    content.setAttribute?.('class', 'processing-watermark-option-content');
    image.setAttribute?.('class', 'processing-watermark-option-thumbnail');
    image.setAttribute?.('src', `/processing/watermarks/${encodeURIComponent(candidate.id)}/image`);
    image.setAttribute?.('alt', '');
    image.setAttribute?.('loading', 'lazy');
    image.addEventListener?.('error', () => { image.hidden = true; });
    copy.setAttribute?.('class', 'processing-watermark-option-copy');
    copy.textContent = labelText;
    text?.remove?.();
    content.append(image, copy);
    label.appendChild?.(content);
  });
}

function selectedWatermarkId(root) {
  const value = root.querySelector('#watermark-resource-select')?.value || '';
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function requireSelectedWatermarkId(root) {
  const id = selectedWatermarkId(root);
  if (!id) {
    throw new ProcessingRequestError('Select a global Watermark before previewing or applying.');
  }
  return id;
}

function syncWatermarkDefaultState(root) {
  if (root.dataset.processingOperation !== 'watermark') return;
  const button = root.querySelector('[data-processing-set-default-watermark]');
  const status = root.querySelector('[data-processing-watermark-default-status]');
  const selected = selectedWatermarkId(root);
  const isDefault = Boolean(selected) && String(root.__ccWatermarkDefaultId || '') === String(selected);
  if (button) {
    button.disabled = !selected || isDefault;
    button.setAttribute('aria-disabled', String(!selected || isDefault));
  }
  if (status) {
    status.hidden = !isDefault;
    status.textContent = isDefault ? 'Default Watermark' : '';
  }
}

function syncWatermarkProcessingState(root) {
  if (root.dataset.processingOperation !== 'watermark') return;
  const outputCategory = root.querySelector('[data-processing-field="outputCategorySlug"]')?.value || '';
  const hasSelection = Boolean(selectedWatermarkId(root)) && Boolean(outputCategory);
  const help = root.querySelector('[data-processing-output-category-help]');
  if (help) {
    help.textContent = root.__ccMissingPresetOutputCategory
      ? "The preset's output category is not available in this project. Choose another category."
      : outputCategory ? 'Generated Watermark outputs will be written beneath this project category.' : 'Choose an output category.';
  }
  const previewButton = root.querySelector('[data-processing-preview]');
  if (previewButton && !root.__ccProcessingBusy) {
    previewButton.disabled = !hasSelection;
    previewButton.setAttribute('aria-disabled', String(!hasSelection));
  }
  if (!hasSelection) invalidatePreview(root);
  syncWatermarkDefaultState(root);
}

async function fetchGlobalWatermarkCandidates(csrf) {
  const payload = await processingFetchJson('/processing/watermarks', { method: 'GET', csrf });
  return Array.isArray(payload.watermarks) ? payload.watermarks : [];
}

async function fetchGlobalWatermarkDefault(csrf) {
  const payload = await processingFetchJson('/processing/watermarks/default', { method: 'GET', csrf });
  return Number.isSafeInteger(payload.watermarkId) && payload.watermarkId > 0 ? String(payload.watermarkId) : '';
}

async function loadGlobalWatermarkCandidates(root, initialCandidates) {
  if (root.dataset.processingOperation !== 'watermark') return;
  const watermarkSelect = root.querySelector('#watermark-resource-select');
  try {
    const candidatesPromise = Array.isArray(initialCandidates)
      ? Promise.resolve(initialCandidates)
      : fetchGlobalWatermarkCandidates(root.dataset.csrf);
    const defaultPromise = fetchGlobalWatermarkDefault(root.dataset.csrf).catch(() => '');
    const [candidates, defaultId] = await Promise.all([candidatesPromise, defaultPromise]);
    root.__ccWatermarkCandidates = new Map(candidates.map((candidate) => [String(candidate.id), candidate]));
    root.__ccWatermarkDefaultId = root.__ccWatermarkCandidates.has(defaultId) ? defaultId : '';
    const current = watermarkSelect?.value;
    if (watermarkSelect) {
      Array.from(watermarkSelect.querySelectorAll('option:not(:first-child)')).forEach((option) => option.remove());
      candidates.forEach((candidate) => {
        const option = document.createElement('option');
        option.value = String(candidate.id);
        option.textContent = watermarkOptionLabel(candidate);
        watermarkSelect.append(option);
      });
      if (current && root.__ccWatermarkCandidates.has(current)) {
        watermarkSelect.value = current;
      } else if (current) {
        watermarkSelect.value = '';
        invalidatePreview(root);
      } else if (!Array.isArray(initialCandidates) && root.__ccWatermarkDefaultId) {
        watermarkSelect.value = root.__ccWatermarkDefaultId;
        root.__ccWatermarkExplicitSelection = false;
      }
      syncCreatorCrateDropdownFromNative(watermarkSelect);
      decorateWatermarkDropdownOptions(root);
      updateWatermarkThumb(root);
    }
  } catch {
    // Global Watermarks remain unavailable; do not invent a fallback option.
  } finally {
    syncWatermarkProcessingState(root);
  }
}

async function loadWatermarkResourceSelects(root, initialCandidates) {
  if (root.dataset.processingOperation !== 'watermark') return;
  await loadGlobalWatermarkCandidates(root, initialCandidates);
}

function updateWatermarkThumb(root) {
  const select = root.querySelector('#watermark-resource-select');
  const thumb = root.querySelector('[data-processing-watermark-thumb]');
  const img = root.querySelector('[data-processing-watermark-thumb-img]');
  if (!select || !thumb || !img) return;
  const id = select.value;
  if (!id) {
    thumb.hidden = true;
    img.removeAttribute('src');
    return;
  }
  const label = select.options[select.selectedIndex]?.textContent || 'Watermark';
  img.src = `/processing/watermarks/${encodeURIComponent(id)}/image`;
  img.alt = `Watermark: ${label}`;
  thumb.hidden = false;
}

function bindWatermarkResourceSelect(root) {
  const select = root.querySelector('#watermark-resource-select');
  if (!select || isBound(select, 'thumb')) return;
  markBound(select, 'thumb');
  select.addEventListener('change', () => {
    root.__ccWatermarkExplicitSelection = true;
    updateWatermarkThumb(root);
    syncWatermarkProcessingState(root);
  });
}

function bindWatermarkDefault(root) {
  const button = root.querySelector('[data-processing-set-default-watermark]');
  if (!button || isBound(button, 'default')) return;
  markBound(button, 'default');
  button.addEventListener('click', async () => {
    const watermarkId = selectedWatermarkId(root);
    if (!watermarkId || button.disabled) return;
    try {
      const payload = await processingFetchJson('/processing/watermarks/default', {
        csrf: root.dataset.csrf,
        body: { watermarkId: Number(watermarkId) },
      });
      root.__ccWatermarkDefaultId = Number.isSafeInteger(payload.watermarkId) ? String(payload.watermarkId) : '';
      syncWatermarkDefaultState(root);
    } catch (error) {
      showError(root, error.message);
    }
  });
}

function bindDeleteSourceWarning(root) {
  const checkbox = root.querySelector('[data-processing-delete-source-toggle] input[type="checkbox"]');
  const warning = root.querySelector('[data-processing-delete-source-warning]');
  if (!checkbox || !warning || isBound(checkbox, 'warning')) return;
  markBound(checkbox, 'warning');
  const sync = () => { warning.hidden = !checkbox.checked; };
  checkbox.addEventListener('change', sync);
  sync();
}

// ─── Workflow rule rows ─────────────────────────────────────────────────

let ruleRowCounter = 0;

function ruleOperationSelect(row) {
  return row.querySelector('[data-processing-rule-operation]');
}

function syncRuleRowFields(row) {
  const type = ruleOperationSelect(row)?.value || 'remove';
  const text = row.querySelector('[data-processing-rule-text]');
  const search = row.querySelector('[data-processing-rule-search]');
  const replacement = row.querySelector('[data-processing-rule-replacement]');
  const isReplace = type === 'replace';
  if (text) text.hidden = isReplace;
  if (search) search.hidden = !isReplace;
  if (replacement) replacement.hidden = !isReplace;
}

function makeRuleRowDropdownIdsUnique(row, rowNumber) {
  const ids = new Map();
  row.querySelectorAll('[id]').forEach((element) => {
    const currentId = element.id;
    if (!currentId) return;
    const nextId = `${currentId}-${rowNumber}`;
    ids.set(currentId, nextId);
    element.id = nextId;
  });

  ['for', 'aria-controls', 'aria-labelledby', 'aria-describedby'].forEach((attribute) => {
    row.querySelectorAll(`[${attribute}]`).forEach((element) => {
      const currentValue = element.getAttribute(attribute);
      if (!currentValue) return;
      const nextValue = currentValue.split(/\s+/).map((id) => ids.get(id) || id).join(' ');
      if (nextValue !== currentValue) element.setAttribute(attribute, nextValue);
    });
  });
}

function createRuleRow(root, side) {
  const template = root.querySelector('[data-processing-rule-row-template]');
  const fragment = template.content.cloneNode(true);
  const row = fragment.querySelector('[data-processing-rule-row]');
  ruleRowCounter += 1;
  makeRuleRowDropdownIdsUnique(row, ruleRowCounter);

  const operation = ruleOperationSelect(row);
  initializeCreatorCrateDropdown(row.querySelector('[data-cc-dropdown]'));
  operation?.addEventListener('change', () => syncRuleRowFields(row));
  row.querySelector('[data-processing-remove-rule]').addEventListener('click', () => {
    row.remove();
    invalidatePreview(root);
    root.__ccDirty = true;
  });
  syncRuleRowFields(row);
  return row;
}

function bindRuleAdders(root) {
  root.querySelectorAll('[data-processing-add-rule]').forEach((button) => {
    if (isBound(button, 'add-rule')) return;
    markBound(button, 'add-rule');
    button.addEventListener('click', () => {
      const side = button.dataset.processingAddRule;
      const list = root.querySelector(`[data-processing-rules="${side}"] [data-processing-rule-list]`);
      if (!list) return;
      list.append(createRuleRow(root, side));
      root.__ccDirty = true;
      invalidatePreview(root);
    });
  });
}

function serializeRuleRow(row) {
  const type = ruleOperationSelect(row)?.value || 'remove';
  if (type === 'replace') {
    return {
      type,
      search: row.querySelector('[data-processing-rule-search]')?.value ?? '',
      replacement: row.querySelector('[data-processing-rule-replacement]')?.value ?? '',
    };
  }
  return { type, text: row.querySelector('[data-processing-rule-text]')?.value ?? '' };
}

function collectWorkflowRules(root, side) {
  const rows = Array.from(root.querySelectorAll(`[data-processing-rules="${side}"] [data-processing-rule-row]`));
  return { rules: rows.map(serializeRuleRow) };
}

function applyWorkflowRulesToForm(root, side, ruleList) {
  const list = root.querySelector(`[data-processing-rules="${side}"] [data-processing-rule-list]`);
  if (!list) return;
  list.innerHTML = '';
  // Stored/returned preset config carries positive/negative as plain rule
  // arrays (see ProcessingPresetService/normalizePromptEditOptions); accept
  // the {rules:[...]} input shape too since some callers still pass that.
  const rules = Array.isArray(ruleList) ? ruleList : (ruleList?.rules || []);
  rules.forEach((rule) => {
    const row = createRuleRow(root, side);
    const operation = ruleOperationSelect(row);
    if (operation?.querySelector(`option[value="${rule.type}"]`)) {
      operation.value = rule.type;
      syncCreatorCrateDropdownFromNative(operation);
    }
    if (rule.type === 'replace') {
      const search = row.querySelector('[data-processing-rule-search]');
      const replacement = row.querySelector('[data-processing-rule-replacement]');
      if (search) search.value = rule.search ?? '';
      if (replacement) replacement.value = rule.replacement ?? '';
    } else {
      const text = row.querySelector('[data-processing-rule-text]');
      if (text) text.value = rule.text ?? '';
    }
    syncRuleRowFields(row);
    list.append(row);
  });
}

// ─── Payload assembly ────────────────────────────────────────────────────

function buildRequestBody(root) {
  const scope = resolveScope(root);
  const operation = root.dataset.processingOperation;
  if (operation === 'watermark' && !root.querySelector('[data-processing-field="outputCategorySlug"]')?.value) {
    throw new ProcessingRequestError('Choose an output category.');
  }
  const presetSelect = root.querySelector('[data-processing-preset-select]');
  const usePreset = Boolean(presetSelect?.value) && !root.__ccDirty;

  if (usePreset) {
    const body = { scope, presetId: Number(presetSelect.value) };
    if (operation === 'watermark') {
      const watermarkId = requireSelectedWatermarkId(root);
      body.runtimeResources = {
        watermarkId,
      };
    }
    return body;
  }

  if (operation === 'workflow-prompt') {
    return { scope, options: { positive: collectWorkflowRules(root, 'positive'), negative: collectWorkflowRules(root, 'negative') } };
  }
  const options = collectOptions(root);
  if (operation === 'watermark') {
    validateWatermarkOutputSlots(root);
    // The selector is the only trusted source for the runtime global Watermark
    // identity. Strip stale runtime identities before constructing the request.
    const normalizedOptions = normalizeWatermarkPresetConfig(options);
    delete normalizedOptions.watermarkId;
    normalizedOptions.watermarkId = requireSelectedWatermarkId(root);
    return { scope, options: normalizedOptions };
  }
  return { scope, options };
}

// ─── Preview / Apply ─────────────────────────────────────────────────────

async function runPreview(root) {
  if (root.__ccProcessingBusy) return;
  showError(root, '');
  clearPlan(root);
  let body;
  try {
    body = buildRequestBody(root);
  } catch (error) {
    showError(root, error.message);
    return;
  }
  setBusy(root, true);
  setStatus(root, 'Loading preview…');
  try {
    const payload = await processingFetchJson(
      OPERATION_PLAN_PATH(root.dataset.projectId, root.dataset.processingOperation),
      { csrf: root.dataset.csrf, body },
    );
    const canApply = renderPlan(root, payload.plan);
    root.__ccPreviewValid = canApply;
    root.__ccLastPreviewBody = JSON.stringify(body);
    const applyButton = root.querySelector('[data-processing-apply]');
    if (applyButton) {
      applyButton.disabled = !canApply;
      applyButton.setAttribute('aria-disabled', String(!canApply));
    }
    if (root.dataset.processingOperation === 'watermark') {
      await renderWatermarkPreview(root, body);
    }
    setStatus(root, canApply ? 'Preview ready.' : 'Preview ready, but conflicts or blockers must be resolved before Apply.');
  } catch (error) {
    showError(root, error.message);
    setStatus(root, '');
  } finally {
    setBusy(root, false);
  }
}

function stopProcessingJobPolling(root) {
  if (root.__ccProcessingJobPollTimer) clearTimeout(root.__ccProcessingJobPollTimer);
  root.__ccProcessingJobPollTimer = null;
  root.__ccProcessingJobPollGeneration = (root.__ccProcessingJobPollGeneration || 0) + 1;
}

function claimProcessingJobCompletion(root, job) {
  if (root.__ccProcessingJobCompletion?.job === job) return null;
  const completion = { job };
  root.__ccProcessingJobCompletion = completion;
  return completion;
}

function processingJobStatus(job) {
  if (job.state === 'queued') return 'Processing queued.';
  if (job.state === 'running') {
    const { completed, total } = job.progress || {};
    if (Number.isFinite(completed) && Number.isFinite(total)) return `Processing… ${completed} of ${total}.`;
    return 'Processing…';
  }
  return '';
}

async function completeApply(root, { result, refreshUrl } = {}) {
  renderResult(root, root.dataset.processingOperation, result);
  invalidatePreview(root);
  if (AUTO_RESCAN_OPERATIONS.has(root.dataset.processingOperation)) {
    setStatus(root, 'Processing completed. Refreshing the asset index…');
    try {
      await rescanProjectAssetsAfterApply(root, { refreshUrl });
      setStatus(root, 'Applied. Assets refreshed.');
    } catch {
      setStatus(root, 'Processing completed, but CreatorCrate could not refresh the asset index.');
    }
  } else {
    setStatus(root, 'Applied.');
  }
}

function scheduleProcessingJobPoll(root, job, generation) {
  if (root.__ccProcessingJob !== job || root.__ccProcessingJobPollGeneration !== generation) return;
  if (root.__ccProcessingJobPollTimer) clearTimeout(root.__ccProcessingJobPollTimer);
  root.__ccProcessingJobPollTimer = setTimeout(() => {
    root.__ccProcessingJobPollTimer = null;
    void pollProcessingJob(root);
  }, PROCESSING_JOB_POLL_INTERVAL_MS);
}

async function pollProcessingJob(root) {
  const job = root.__ccProcessingJob;
  const generation = root.__ccProcessingJobPollGeneration || 0;
  const polling = root.__ccProcessingJobPolling;
  if (!job || (polling?.job === job && polling.generation === generation)) return;
  const attempt = { job, generation };
  root.__ccProcessingJobPolling = attempt;
  try {
    const payload = await processingFetchJson(PROCESSING_JOB_PATH(job.id), {
      method: 'GET',
      csrf: root.dataset.csrf,
    });
    if (root.__ccProcessingJob !== job || root.__ccProcessingJobPollGeneration !== generation) return;

    const nextJob = payload?.job;
    if (!nextJob || nextJob.id !== job.id || typeof nextJob.state !== 'string') {
      throw new ProcessingRequestError('The processing job returned an unexpected response. Try again.');
    }
    job.state = nextJob.state;
    job.progress = nextJob.progress || null;

    if (ACTIVE_PROCESSING_JOB_STATES.has(job.state)) {
      setStatus(root, processingJobStatus(job));
      scheduleProcessingJobPoll(root, job, generation);
      return;
    }

    if (!TERMINAL_PROCESSING_JOB_STATES.has(job.state)) {
      throw new ProcessingRequestError('The processing job returned an unexpected status. Try again.');
    }

    const completion = job.state === 'succeeded' ? claimProcessingJobCompletion(root, job) : null;
    if (job.state === 'succeeded' && !completion) return;

    stopProcessingJobPolling(root);
    try {
      if (job.state === 'succeeded') {
        await completeApply(root, nextJob.result);
      } else if (job.state === 'failed') {
        showError(root, nextJob.error?.message || 'Processing could not be completed.');
        setStatus(root, '');
      } else {
        setStatus(root, 'Processing cancelled.');
      }
    } catch (error) {
      showError(root, error.message);
      setStatus(root, '');
    }
    if (completion && root.__ccProcessingJobCompletion !== completion) return;
    if (completion) root.__ccProcessingJobCompletion = null;
    if (root.__ccProcessingJob !== job) return;
    root.__ccProcessingJob = null;
    setBusy(root, false);
  } catch (error) {
    if (root.__ccProcessingJob === job && root.__ccProcessingJobPollGeneration === generation) {
      if (error.code === 'PROCESSING_JOB_NOT_FOUND') {
        stopProcessingJobPolling(root);
        root.__ccProcessingJob = null;
        setBusy(root, false);
        showError(root, 'The processing result is no longer available.');
        setStatus(root, '');
      } else {
        showError(root, error.message);
        setStatus(root, 'Could not check processing status. Retrying…');
        scheduleProcessingJobPoll(root, job, generation);
      }
    }
  } finally {
    if (root.__ccProcessingJobPolling === attempt) root.__ccProcessingJobPolling = null;
  }
}

function startProcessingJobPolling(root, jobId) {
  stopProcessingJobPolling(root);
  root.__ccProcessingJob = { id: jobId, state: 'queued', progress: null };
  setStatus(root, processingJobStatus(root.__ccProcessingJob));
  void pollProcessingJob(root);
}

async function cancelProcessingJob(root) {
  const job = root.__ccProcessingJob;
  if (!job || job.state !== 'queued') return;
  stopProcessingJobPolling(root);
  try {
    const payload = await processingFetchJson(`${PROCESSING_JOB_PATH(job.id)}/cancel`, {
      csrf: root.dataset.csrf,
    });
    if (root.__ccProcessingJob !== job || payload?.job?.state !== 'cancelled') return;
    root.__ccProcessingJob = null;
    setBusy(root, false);
    setStatus(root, 'Processing cancelled.');
  } catch {
    // A queued job can start between the last poll and this request. The backend
    // rejects that race with 409; retain the job so reopening the dialog resumes polling.
  }
}

function bindProcessingJobLifecycle(root) {
  if (isBound(root, 'jobLifecycle')) return;
  markBound(root, 'jobLifecycle');
  const dialog = root.closest?.('dialog');
  dialog?.addEventListener('close', () => {
    const submission = root.__ccProcessingSubmission;
    if (submission) submission.closed = true;
    const job = root.__ccProcessingJob;
    stopProcessingJobPolling(root);
    if (job?.state === 'queued') void cancelProcessingJob(root);
  });
}

async function runApply(root) {
  if (root.__ccProcessingBusy || root.__ccProcessingJob || !root.__ccPreviewValid) return;
  showError(root, '');
  let body;
  try {
    body = buildRequestBody(root);
  } catch (error) {
    showError(root, error.message);
    return;
  }

  const submission = {
    generation: (root.__ccProcessingSubmissionGeneration || 0) + 1,
    closed: false,
  };
  root.__ccProcessingSubmissionGeneration = submission.generation;
  root.__ccProcessingSubmission = submission;
  setBusy(root, true);
  setStatus(root, 'Applying…');
  try {
    const payload = await processingFetchJson(
      OPERATION_APPLY_PATH(root.dataset.projectId, root.dataset.processingOperation),
      { csrf: root.dataset.csrf, body },
    );
    if (root.__ccProcessingSubmission !== submission) return;

    if (typeof payload.jobId === 'string' && payload.jobId) {
      if (submission.closed) {
        root.__ccProcessingJob = { id: payload.jobId, state: 'queued', progress: null };
        root.__ccProcessingSubmission = null;
        void cancelProcessingJob(root);
      } else {
        root.__ccProcessingSubmission = null;
        startProcessingJobPolling(root, payload.jobId);
      }
    } else {
      await completeApply(root, payload);
    }
  } catch (error) {
    if (root.__ccProcessingSubmission !== submission) return;
    showError(root, error.message);
    setStatus(root, '');
  } finally {
    if (root.__ccProcessingSubmission !== submission) return;
    root.__ccProcessingSubmission = null;
    if (!root.__ccProcessingJob) setBusy(root, false);
  }
}

function bindPreviewApply(root) {
  const previewButton = root.querySelector('[data-processing-preview]');
  const applyButton = root.querySelector('[data-processing-apply]');
  const refreshButton = root.querySelector('[data-processing-refresh]');
  if (previewButton && !isBound(previewButton, 'preview')) {
    markBound(previewButton, 'preview');
    previewButton.addEventListener('click', () => runPreview(root));
  }
  if (applyButton && !isBound(applyButton, 'apply')) {
    markBound(applyButton, 'apply');
    applyButton.addEventListener('click', () => runApply(root));
  }
  if (refreshButton && !isBound(refreshButton, 'refresh')) {
    markBound(refreshButton, 'refresh');
    refreshButton.addEventListener('click', () => {
      const window = liveDocument(root)?.defaultView || globalThis;
      window.location.reload();
    });
  }
}

// ─── Dialog lifecycle ────────────────────────────────────────────────────

function resetDialogState(root) {
  invalidatePreview(root);
  clearPlan(root);
  showError(root, '');
  setStatus(root, '');
  hidePresetNameForm(root);
  syncWatermarkFormatSettings(root);
}

function bindWatermarkPreviewLifecycle(root) {
  if (root.dataset.processingOperation !== 'watermark' || isBound(root, 'watermarkPreviewLifecycle')) return;
  markBound(root, 'watermarkPreviewLifecycle');
  const dialog = root.closest?.('dialog');
  dialog?.addEventListener('close', () => clearWatermarkVisualPreview(root));
}

function onDialogOpen(root) {
  const submission = root.__ccProcessingSubmission;
  if (submission && submission.generation === root.__ccProcessingSubmissionGeneration) submission.closed = false;
  applyDefaultScope(root);
  updateScopeDisplay(root);
  resetDialogState(root);
  loadPresets(root);
  loadWatermarkResourceSelects(root);
  if (root.dataset.processingOperation === 'workflow-prompt') ensureInitialWorkflowRow(root);
  if (root.__ccProcessingJob) {
    setBusy(root, true);
    void pollProcessingJob(root);
  }
}

function bindDialogOpenTriggers(document) {
  if (isBound(document, 'openTriggers')) return;
  markBound(document, 'openTriggers');
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-dialog-open]');
    if (!trigger) return;
    const dialogId = trigger.getAttribute('data-dialog-open');
    const dialog = document.getElementById(dialogId);
    const root = dialog?.querySelector(ROOT_SELECTOR);
    if (root) onDialogOpen(root);
    const manageWatermarks = dialog?.querySelector(MANAGE_WATERMARKS_SELECTOR);
    if (manageWatermarks) loadManagedWatermarks(manageWatermarks);
    const manageScaleMap = dialog?.querySelector(MANAGE_SCALE_MAP_SELECTOR);
    if (manageScaleMap) loadManagedScaleMap(manageScaleMap);
  });

  document.addEventListener('change', (event) => {
    if (!event.target.matches(ASSET_CHECKBOX_SELECTOR)) return;
    document.querySelectorAll(ROOT_SELECTOR).forEach((root) => updateScopeDisplay(root));
  });
}

// ─── Global Watermarks dialog ──────────────────────────────────────────────

function watermarkRowMarkup(document, candidate) {
  const li = document.createElement('li');
  li.className = 'processing-resource-row';
  li.dataset.watermarkId = String(candidate.id);

  const img = document.createElement('img');
  img.className = 'processing-resource-thumb';
  img.src = `/processing/watermarks/${encodeURIComponent(candidate.id)}/image`;
  img.alt = `Watermark preview: ${candidate.filename}`;
  img.loading = 'lazy';
  li.append(img);

  const meta = document.createElement('span');
  meta.className = 'processing-resource-meta';
  const dimensions = Number.isSafeInteger(candidate.width) && Number.isSafeInteger(candidate.height)
    ? ` (${candidate.width}×${candidate.height})`
    : '';
  meta.textContent = `${candidate.filename}${dimensions} — ${candidate.relativePath}`;
  li.append(meta);
  return li;
}

function watermarkEmptyStateMarkup(document) {
  const empty = document.createElement('li');
  empty.className = 'processing-resource-empty help-text';
  empty.textContent = "No Watermark PNGs found. Place PNG files in CreatorCrate's global watermarks folder, then Scan.";
  return empty;
}

function updateWatermarkScanButton(manageRoot) {
  const button = manageRoot.querySelector('[data-processing-scan-watermarks]');
  if (!button) return;
  const disabled = manageRoot.__ccBusy === true;
  button.disabled = disabled;
  button.setAttribute('aria-disabled', String(disabled));
}

async function loadManagedWatermarks(manageRoot, candidates) {
  const list = manageRoot.querySelector('[data-processing-watermark-list]');
  if (!list) return;
  try {
    const resolvedCandidates = Array.isArray(candidates)
      ? candidates
      : await fetchGlobalWatermarkCandidates(manageRoot.dataset.csrf);
    const document = liveDocument(manageRoot);
    manageRoot.__ccWatermarkCandidates = new Map(
      resolvedCandidates.map((candidate) => [String(candidate.id), candidate]),
    );
    list.innerHTML = '';
    if (resolvedCandidates.length === 0) {
      list.append(watermarkEmptyStateMarkup(document));
    } else {
      resolvedCandidates.forEach((candidate) => list.append(
        watermarkRowMarkup(document, candidate),
      ));
    }
    showError(manageRoot, '');
  } catch (error) {
    showError(manageRoot, error.message);
  } finally {
    updateWatermarkScanButton(manageRoot);
  }
}

function refreshWatermarkConsumers(manageRoot, candidates) {
  const document = liveDocument(manageRoot);
  const loads = [];
  document.querySelectorAll(ROOT_SELECTOR).forEach((root) => {
    if (root.dataset.processingOperation === 'watermark') loads.push(loadGlobalWatermarkCandidates(root, candidates));
  });
  return Promise.all(loads);
}

async function scanGlobalWatermarks(manageRoot) {
  if (manageRoot.__ccBusy) return;
  manageRoot.__ccBusy = true;
  updateWatermarkScanButton(manageRoot);
  showError(manageRoot, '');
  setStatus(manageRoot, 'Scanning Watermarks…');
  try {
    const payload = await processingFetchJson('/processing/watermarks/scan', {
      csrf: manageRoot.dataset.csrf,
      body: {},
    });
    const candidates = Array.isArray(payload.watermarks)
      ? payload.watermarks
      : await fetchGlobalWatermarkCandidates(manageRoot.dataset.csrf);
    await loadManagedWatermarks(manageRoot, candidates);
    await refreshWatermarkConsumers(manageRoot, candidates);
    const scan = payload.scan || {};
    const counts = [
      ['added', 'added'],
      ['updated', 'updated'],
      ['restored', 'restored'],
      ['removed', 'removed'],
      ['total', 'total'],
    ]
      .filter(([key]) => Number.isSafeInteger(scan[key]))
      .map(([key, label]) => `${scan[key]} ${label}`);
    setStatus(manageRoot, counts.length > 0 ? `Scan complete — ${counts.join(', ')}.` : 'Scan complete.');
  } catch (error) {
    showError(manageRoot, error.message);
    setStatus(manageRoot, '');
  } finally {
    manageRoot.__ccBusy = false;
    updateWatermarkScanButton(manageRoot);
  }
}

function bindManagedWatermarksDialog(manageRoot) {
  if (isBound(manageRoot, 'manageWatermarks')) return;
  markBound(manageRoot, 'manageWatermarks');
  manageRoot.querySelector('[data-processing-scan-watermarks]')?.addEventListener('click', () => {
    void scanGlobalWatermarks(manageRoot);
  });
  updateWatermarkScanButton(manageRoot);
}

// ─── Managed scale maps dialog ───────────────────────────────────────────

async function loadManagedScaleMap(manageRoot) {
  try {
    const payload = await processingFetchJson('/processing/scale-map', { method: 'GET', csrf: manageRoot.dataset.csrf });
    openScaleMapEditor(manageRoot, payload.definition);
    showError(manageRoot, '');
  } catch (error) {
    showError(manageRoot, error.message);
  }
}

function invalidateWatermarkPreviews(manageRoot) {
  const document = liveDocument(manageRoot);
  document.querySelectorAll(ROOT_SELECTOR).forEach((root) => {
    if (root.dataset.processingOperation === 'watermark') invalidatePreview(root);
  });
}

function scaleMapRow(document, width = '', height = '', scale = '') {
  const row = document.createElement('div');
  row.className = 'processing-scale-map-grid-row';
  const widthInput = document.createElement('input');
  widthInput.type = 'number'; widthInput.min = '1'; widthInput.step = '1'; widthInput.value = width;
  widthInput.setAttribute('aria-label', 'Width');
  const heightInput = document.createElement('input');
  heightInput.type = 'number'; heightInput.min = '1'; heightInput.step = '1'; heightInput.value = height;
  heightInput.setAttribute('aria-label', 'Height');
  const scaleInput = document.createElement('input');
  scaleInput.type = 'number'; scaleInput.min = '0'; scaleInput.step = 'any'; scaleInput.value = scale;
  scaleInput.setAttribute('aria-label', 'Scale');
  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'button button-small button-secondary';
  removeButton.textContent = 'Remove';
  removeButton.addEventListener('click', () => row.remove());
  row.append(widthInput, heightInput, scaleInput, removeButton);
  return row;
}

function openScaleMapEditor(manageRoot, definition) {
  const editor = manageRoot.querySelector('[data-processing-scale-map-editor]');
  const defaultInput = manageRoot.querySelector('[data-processing-scale-map-default]');
  const rows = manageRoot.querySelector('[data-processing-scale-map-rows]');
  if (!editor || !rows) return;
  const document = liveDocument(manageRoot);
  editor.hidden = false;
  rows.innerHTML = '';
  let defaultScale = '';
  Object.entries(definition || {}).forEach(([key, scale]) => {
    if (key === 'default') { defaultScale = String(scale); return; }
    const [width, height] = key.split('x');
    rows.append(scaleMapRow(document, width, height, String(scale)));
  });
  if (defaultInput) defaultInput.value = defaultScale;
  if (rows.children.length === 0) rows.append(scaleMapRow(document));
  enhanceNumberInputs(rows);
}

function collectScaleMapDefinition(manageRoot) {
  const rowsContainer = manageRoot.querySelector('[data-processing-scale-map-rows]');
  const rows = Array.from(rowsContainer?.children || []);
  const definition = {};
  for (const row of rows) {
    const [widthInput, heightInput, scaleInput] = Array.from(row.querySelectorAll('input'));
    const width = widthInput.value.trim();
    const height = heightInput.value.trim();
    const scale = scaleInput.value.trim();
    if (!width && !height && !scale) continue;
    if (!/^[1-9]\d*$/.test(width) || !/^[1-9]\d*$/.test(height)) {
      throw new ProcessingRequestError('Each resolution row needs a positive integer width and height.');
    }
    const scaleValue = Number(scale);
    if (!Number.isFinite(scaleValue) || scaleValue <= 0) {
      throw new ProcessingRequestError('Each resolution row needs a scale greater than 0.');
    }
    definition[`${width}x${height}`] = scaleValue;
  }
  const defaultInput = manageRoot.querySelector('[data-processing-scale-map-default]');
  const defaultRaw = defaultInput?.value.trim();
  if (defaultRaw) {
    const defaultValue = Number(defaultRaw);
    if (!Number.isFinite(defaultValue) || defaultValue <= 0) {
      throw new ProcessingRequestError('Default scale must be greater than 0.');
    }
    definition.default = defaultValue;
  }
  return definition;
}

function bindManagedScaleMapDialog(manageRoot) {
  if (isBound(manageRoot, 'manageScaleMap')) return;
  markBound(manageRoot, 'manageScaleMap');

  manageRoot.querySelector('[data-processing-scale-map-add-row]')?.addEventListener('click', () => {
    const rows = manageRoot.querySelector('[data-processing-scale-map-rows]');
    if (!rows) return;
    rows.append(scaleMapRow(liveDocument(manageRoot)));
    enhanceNumberInputs(rows);
  });
  manageRoot.addEventListener('click', async (event) => {
    const saveButton = event.target.closest('[data-processing-scale-map-save]');
    if (saveButton) {
      let definition;
      try {
        definition = collectScaleMapDefinition(manageRoot);
      } catch (error) {
        showError(manageRoot, error.message);
        return;
      }
      try {
        const payload = await processingFetchJson('/processing/scale-map/replace', {
          csrf: manageRoot.dataset.csrf, body: { definition },
        });
        openScaleMapEditor(manageRoot, payload.definition);
        invalidateWatermarkPreviews(manageRoot);
        setStatus(manageRoot, 'Scale Map saved. Preview has been invalidated.');
      } catch (error) {
        showError(manageRoot, error.message);
      }
    }
  });
}

// ─── Public entry point ──────────────────────────────────────────────────

export function enhanceProcessingDialogs(scope = globalThis.document) {
  const document = liveDocument(scope);
  if (!document || typeof document.querySelectorAll !== 'function') return 0;

  bindDialogOpenTriggers(document);

  let count = 0;
  document.querySelectorAll(ROOT_SELECTOR).forEach((root) => {
    if (isBound(root, 'root')) { count += 1; return; }
    markBound(root, 'root');
    bindPresetSelect(root);
    bindPresetActions(root);
    bindScopeControls(root);
    bindDirtyTracking(root);
    bindPreviewApply(root);
    bindProcessingJobLifecycle(root);
    bindWatermarkResourceSelect(root);
    bindWatermarkDefault(root);
    bindWatermarkPreviewLifecycle(root);
    bindDeleteSourceWarning(root);
    bindRuleAdders(root);
    updateScopeDisplay(root);
    syncWatermarkFormatSettings(root);
    syncWatermarkProcessingState(root);
    count += 1;
  });

  document.querySelectorAll(MANAGE_WATERMARKS_SELECTOR).forEach(bindManagedWatermarksDialog);
  document.querySelectorAll(MANAGE_SCALE_MAP_SELECTOR).forEach(bindManagedScaleMapDialog);

  return count;
}

// Exposed for the Workflow dialog's initial-empty-state convenience — one
// row per side so the dialog never opens with an empty, confusing list.
export function ensureInitialWorkflowRow(root) {
  ['positive', 'negative'].forEach((side) => {
    const list = root.querySelector(`[data-processing-rules="${side}"] [data-processing-rule-list]`);
    if (list && list.children.length === 0) list.append(createRuleRow(root, side));
  });
}

if (typeof document !== 'undefined') {
  const run = () => enhanceProcessingDialogs(document);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
}
