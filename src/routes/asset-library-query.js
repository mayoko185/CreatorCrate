import { validateDirectorySlug } from '../services/asset-category-validation.js';

export const ASSET_LIBRARY_QUERY_KEYS = Object.freeze([
  'project',
  'category',
  'tag',
  'search',
  'extension',
  'presence',
  'usage',
  'sort',
  'order',
  'page',
  'pageSize',
  'view',
]);

export const ASSET_LIBRARY_PAGE_SIZE_VALUES = Object.freeze([10, 25, 50, 100]);

export const ASSET_LIBRARY_DEFAULTS = Object.freeze({
  category: 'all',
  tag: null,
  search: null,
  extension: null,
  presence: 'all',
  usage: 'all',
  sort: 'filename',
  order: 'asc',
  page: 1,
  pageSize: 25,
  view: 'grid',
});

const ASSET_LIBRARY_SEARCH_MAX_LENGTH = 128;
const PRESENTATION_KEYS = Object.freeze(['view', 'sort', 'order', 'pageSize']);
const PRESENTATION_VALUES = Object.freeze({
  view: Object.freeze(['grid', 'list']),
  sort: Object.freeze(['filename', 'modified', 'size', 'category', 'project']),
  order: Object.freeze(['asc', 'desc']),
  pageSize: Object.freeze(ASSET_LIBRARY_PAGE_SIZE_VALUES.map(String)),
});
const PRESENTATION_FALLBACKS = Object.freeze({
  view: 'grid',
  sort: 'filename',
  order: 'asc',
  pageSize: 25,
});
const PRESENCE_VALUES = Object.freeze(['all', 'present', 'missing']);
const USAGE_VALUES = Object.freeze(['all', 'used', 'unused']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function scalarString(value) {
  if (Array.isArray(value) || value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function parsePositiveInteger(value) {
  const stringValue = scalarString(value);
  if (stringValue === null || !/^[1-9]\d*$/.test(stringValue)) return null;

  const parsed = Number(stringValue);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeSearch(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, ASSET_LIBRARY_SEARCH_MAX_LENGTH);
}

function normalizeExtension(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^\./, '').toLowerCase();
  if (normalized === '' || normalized.startsWith('.')) return null;
  return normalized;
}

function normalizeCategorySelectionValue(value) {
  const normalized = scalarString(value);
  if (normalized === null || normalized === 'all') return null;
  if (normalized === 'uncategorized') return normalized;
  if (/^\d+$/.test(normalized)) return null;
  return validateDirectorySlug(normalized) === null ? normalized : null;
}

function compareNumericValues(left, right) {
  return left - right;
}

function compareStringValues(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeSelection(value, normalizeValue, compareValues) {
  if (value === undefined || value === null) return [];

  const values = Array.isArray(value) ? value : [value];
  const unique = new Set();
  for (const candidate of values) {
    const normalized = normalizeValue(candidate);
    if (normalized !== null) unique.add(normalized);
  }

  return [...unique].sort(compareValues);
}

function normalizeEnum(value, values, fallback) {
  const normalized = scalarString(value);
  return normalized !== null && values.includes(normalized) ? normalized : fallback;
}

function parsePresentationValue(raw, key) {
  const fallback = PRESENTATION_FALLBACKS[key];
  if (!hasOwn(raw, key)) {
    return { value: fallback, state: 'omitted' };
  }

  const normalized = scalarString(raw[key]);
  if (normalized === null || !PRESENTATION_VALUES[key].includes(normalized)) {
    return { value: fallback, state: 'invalid' };
  }

  return {
    value: key === 'pageSize' ? Number(normalized) : normalized,
    state: 'valid',
  };
}

/**
 * Whether a raw request contains at least one supported Asset Viewer key.
 * Unknown keys alone deliberately do not make a request meaningful.
 *
 * @param {unknown} rawQuery
 * @returns {boolean}
 */
export function hasAssetLibraryQuery(rawQuery) {
  if (!isRecord(rawQuery)) return false;
  return ASSET_LIBRARY_QUERY_KEYS.some((key) => hasOwn(rawQuery, key));
}

/**
 * The inverse of {@link hasAssetLibraryQuery}, useful for future defaults
 * redirect decisions without treating unknown query keys as Asset Viewer
 * state.
 *
 * @param {unknown} rawQuery
 * @returns {boolean}
 */
export function isBareAssetLibraryRequest(rawQuery) {
  return !hasAssetLibraryQuery(rawQuery);
}

/**
 * Parse raw Asset Viewer query parameters into the input shape expected by
 * `getAssetLibraryPage`. No repository or service lookup is performed.
 *
 * Presentation metadata records whether each value was omitted, explicitly
 * valid, or explicitly invalid so a later route can apply saved defaults only
 * to omitted values.
 *
 * @param {unknown} rawQuery
 * @returns {{
 *   projectId: number|null,
 *   category: string,
 *   categories: string[],
 *   tag: number|null,
 *   tags: number[],
 *   search: string|null,
 *   extension: string|null,
 *   extensions: string[],
 *   presence: 'all'|'present'|'missing',
 *   usage: 'all'|'used'|'unused',
 *   sort: 'filename'|'modified'|'size'|'category'|'project',
 *   order: 'asc'|'desc',
 *   page: number,
 *   pageSize: 10|25|50|100,
 *   view: 'grid'|'list',
 *   presentation: object,
 *   queryWasNonBare: boolean,
 * }}
 */
export function parseAssetLibraryQuery(rawQuery = {}) {
  const raw = isRecord(rawQuery) ? rawQuery : {};
  const presentation = Object.fromEntries(
    PRESENTATION_KEYS.map((key) => [key, parsePresentationValue(raw, key)]),
  );
  const categories = normalizeSelection(raw.category, normalizeCategorySelectionValue, compareStringValues);
  const tags = normalizeSelection(raw.tag, parsePositiveInteger, compareNumericValues);
  const extensions = normalizeSelection(raw.extension, normalizeExtension, compareStringValues);

  return {
    projectId: parsePositiveInteger(raw.project),
    categories,
    category: categories[0] ?? ASSET_LIBRARY_DEFAULTS.category,
    tags,
    tag: tags[0] ?? ASSET_LIBRARY_DEFAULTS.tag,
    search: normalizeSearch(raw.search),
    extensions,
    extension: extensions[0] ?? ASSET_LIBRARY_DEFAULTS.extension,
    presence: normalizeEnum(raw.presence, PRESENCE_VALUES, ASSET_LIBRARY_DEFAULTS.presence),
    usage: normalizeEnum(raw.usage, USAGE_VALUES, ASSET_LIBRARY_DEFAULTS.usage),
    sort: presentation.sort.value,
    order: presentation.order.value,
    page: parsePositiveInteger(raw.page) ?? ASSET_LIBRARY_DEFAULTS.page,
    pageSize: presentation.pageSize.value,
    view: presentation.view.value,
    presentation,
    queryWasNonBare: hasAssetLibraryQuery(raw),
  };
}

export const normalizeAssetLibraryQuery = parseAssetLibraryQuery;

function readStateValue(state, key) {
  if (key === 'projectId') {
    return hasOwn(state, 'projectId') ? state.projectId : state.project;
  }
  return state[key];
}

function readOverride(state, overrides, key) {
  const overrideKeys = key === 'projectId' ? ['projectId', 'project'] : [key];
  for (const overrideKey of overrideKeys) {
    if (hasOwn(overrides, overrideKey)) {
      return { value: overrides[overrideKey], overridden: true };
    }
  }
  return { value: readStateValue(state, key), overridden: false };
}

function readSelectionOverride(state, overrides, key, legacyKey) {
  if (hasOwn(overrides, key)) {
    return { value: overrides[key], overridden: true };
  }
  if (hasOwn(overrides, legacyKey)) {
    return { value: overrides[legacyKey], overridden: true };
  }
  if (hasOwn(state, key)) {
    return { value: state[key], overridden: false };
  }
  return { value: state[legacyKey], overridden: false };
}

function normalizePresentationCandidate(value, key) {
  const normalized = scalarString(value);
  if (normalized === null || !PRESENTATION_VALUES[key].includes(normalized)) {
    return { value: PRESENTATION_FALLBACKS[key], state: 'invalid' };
  }
  return {
    value: key === 'pageSize' ? Number(normalized) : normalized,
    state: 'valid',
  };
}

function shouldPreserveExplicitFallback(state, key, resolved, normalized) {
  if (normalized.value !== PRESENTATION_FALLBACKS[key] || normalized.state !== 'valid') return false;
  if (resolved.overridden) return true;
  return state.presentation?.[key]?.state === 'valid'
    || state.presentation?.[key]?.preserveFallback === true;
}

function appendQueryValue(query, key, value) {
  if (value !== undefined && value !== null && value !== '') {
    query.append(key, String(value));
  }
}

function appendQueryValues(query, key, value, normalizeValue, compareValues) {
  for (const normalized of normalizeSelection(value, normalizeValue, compareValues)) {
    appendQueryValue(query, key, normalized);
  }
}

/**
 * Build a deterministic canonical `/assets` URL from normalized state.
 * Unknown state fields and override keys are ignored. Overrides are applied
 * to a copied view of the state and never mutate either input object.
 *
 * Fallback presentation values are omitted unless they were explicitly valid
 * in the parsed state, supplied as a valid override, or marked by the route as
 * the fallback for an invalid explicit value; this leaves room for a future
 * saved default to apply only when the user did not choose the option.
 *
 * @param {object} [normalizedState]
 * @param {object} [overrides]
 * @returns {string}
 */
export function buildAssetLibraryUrl(normalizedState = {}, overrides = {}) {
  const state = isRecord(normalizedState) ? normalizedState : {};
  const safeOverrides = isRecord(overrides) ? overrides : {};
  const project = readOverride(state, safeOverrides, 'projectId');
  const categories = readSelectionOverride(state, safeOverrides, 'categories', 'category');
  const tags = readSelectionOverride(state, safeOverrides, 'tags', 'tag');
  const search = readOverride(state, safeOverrides, 'search');
  const extensions = readSelectionOverride(state, safeOverrides, 'extensions', 'extension');
  const presence = readOverride(state, safeOverrides, 'presence');
  const usage = readOverride(state, safeOverrides, 'usage');
  const page = readOverride(state, safeOverrides, 'page');

  const normalizedPresentation = Object.fromEntries(
    PRESENTATION_KEYS.map((key) => {
      const resolved = readOverride(state, safeOverrides, key);
      const normalized = normalizePresentationCandidate(resolved.value, key);
      return [key, { ...normalized, preserveFallback: shouldPreserveExplicitFallback(state, key, resolved, normalized) }];
    }),
  );

  const query = new URLSearchParams();
  appendQueryValue(query, 'project', parsePositiveInteger(project.value));

  appendQueryValues(query, 'category', categories.value, normalizeCategorySelectionValue, compareStringValues);
  appendQueryValues(query, 'tag', tags.value, parsePositiveInteger, compareNumericValues);
  appendQueryValue(query, 'search', normalizeSearch(search.value));
  appendQueryValues(query, 'extension', extensions.value, normalizeExtension, compareStringValues);

  const normalizedPresence = normalizeEnum(presence.value, PRESENCE_VALUES, ASSET_LIBRARY_DEFAULTS.presence);
  if (normalizedPresence !== ASSET_LIBRARY_DEFAULTS.presence) appendQueryValue(query, 'presence', normalizedPresence);

  const normalizedUsage = normalizeEnum(usage.value, USAGE_VALUES, ASSET_LIBRARY_DEFAULTS.usage);
  if (normalizedUsage !== ASSET_LIBRARY_DEFAULTS.usage) appendQueryValue(query, 'usage', normalizedUsage);

  for (const key of ['sort', 'order', 'pageSize', 'view']) {
    const normalized = normalizedPresentation[key];
    if (normalized.value !== PRESENTATION_FALLBACKS[key] || normalized.preserveFallback) {
      appendQueryValue(query, key, normalized.value);
    }
  }

  const normalizedPage = parsePositiveInteger(page.value) ?? ASSET_LIBRARY_DEFAULTS.page;
  if (normalizedPage !== ASSET_LIBRARY_DEFAULTS.page) appendQueryValue(query, 'page', normalizedPage);

  // Reinsert pagination fields in the public key order. URLSearchParams has no
  // reorder operation, so the query is rebuilt once from its deterministic map.
  const orderedQuery = new URLSearchParams();
  for (const key of ASSET_LIBRARY_QUERY_KEYS) {
    for (const value of query.getAll(key)) orderedQuery.append(key, value);
  }

  const serialized = orderedQuery.toString();
  return serialized ? `/assets?${serialized}` : '/assets';
}
