import {
  ARCHIVED_PROJECT_STATUS,
  DASHBOARD_SORTS,
} from '../data/project-repository.js';

export const DASHBOARD_DEFAULTS_KEY = 'page_defaults.dashboard';
export const DASHBOARD_DEFAULTS_VERSION = 1;
export const DASHBOARD_DEFAULT_ITEM_COUNT = 8;
export const DASHBOARD_ITEM_COUNT_MIN = 1;
export const DASHBOARD_ITEM_COUNT_MAX = 25;
export const DASHBOARD_SORT_VALUES = Object.freeze(Object.keys(DASHBOARD_SORTS));
export const DASHBOARD_ORDER_VALUES = Object.freeze(['asc', 'desc']);

const RECENTLY_UPDATED_SECTION = Object.freeze({
  id: 'recently-updated',
  label: 'Recently updated projects',
});
const SYSTEM_ARCHIVED_SECTION = Object.freeze({
  id: `status:${ARCHIVED_PROJECT_STATUS}`,
  label: 'Archived',
  status: ARCHIVED_PROJECT_STATUS,
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function buildDashboardSectionRegistry(statusCatalogue) {
  if (!Array.isArray(statusCatalogue)) {
    throw new Error('Dashboard status catalogue must be an array.');
  }

  return Object.freeze([
    RECENTLY_UPDATED_SECTION,
    ...statusCatalogue
      .filter(({ value }) => value !== ARCHIVED_PROJECT_STATUS)
      .map(({ value, label }) => Object.freeze({
        id: `status:${value}`,
        label,
        status: value,
      })),
    SYSTEM_ARCHIVED_SECTION,
  ]);
}

function defaultSorting() {
  return { sort: 'updated', order: 'desc' };
}

export function getDashboardSectionDefaultSorting() {
  return defaultSorting();
}

function defaultSection() {
  return {
    visible: true,
    itemCount: DASHBOARD_DEFAULT_ITEM_COUNT,
    ...defaultSorting(),
  };
}

function canonicalDefaults(sectionIds) {
  return {
    version: DASHBOARD_DEFAULTS_VERSION,
    order: [...sectionIds],
    sections: Object.fromEntries(sectionIds.map((sectionId) => [sectionId, defaultSection()])),
  };
}

function normalizeOrder(order, sectionIds, sectionIdSet) {
  const seen = new Set();
  const normalized = [];

  if (Array.isArray(order)) {
    for (const sectionId of order) {
      if (typeof sectionId !== 'string' || !sectionIdSet.has(sectionId) || seen.has(sectionId)) continue;
      seen.add(sectionId);
      normalized.push(sectionId);
    }
  }

  for (const sectionId of sectionIds) {
    if (!seen.has(sectionId)) normalized.push(sectionId);
  }
  return normalized;
}

function normalizeSection(section) {
  const fallback = defaultSection();
  if (!isPlainObject(section)) return fallback;

  return {
    visible: typeof section.visible === 'boolean' ? section.visible : fallback.visible,
    itemCount: Number.isInteger(section.itemCount)
      && section.itemCount >= DASHBOARD_ITEM_COUNT_MIN
      && section.itemCount <= DASHBOARD_ITEM_COUNT_MAX
      ? section.itemCount
      : fallback.itemCount,
    sort: DASHBOARD_SORT_VALUES.includes(section.sort) ? section.sort : fallback.sort,
    order: DASHBOARD_ORDER_VALUES.includes(section.order) ? section.order : fallback.order,
  };
}

export function normalizeDashboardDefaults(document, sectionRegistry) {
  if (!Array.isArray(sectionRegistry)) {
    throw new Error('Dashboard normalization requires a section registry.');
  }
  const sectionIds = sectionRegistry.map(({ id }) => id);
  const sectionIdSet = new Set(sectionIds);

  if (!isPlainObject(document) || document.version !== DASHBOARD_DEFAULTS_VERSION) {
    return canonicalDefaults(sectionIds);
  }

  const sections = isPlainObject(document.sections) ? document.sections : {};
  return {
    version: DASHBOARD_DEFAULTS_VERSION,
    order: normalizeOrder(document.order, sectionIds, sectionIdSet),
    sections: Object.fromEntries(sectionIds.map((sectionId) => [
      sectionId,
      normalizeSection(sections[sectionId]),
    ])),
  };
}

function parseStoredDocument(value) {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function createDashboardDefaultsService({
  appMetaRepository,
  projectOptionCatalogueService,
} = {}) {
  if (!appMetaRepository || typeof appMetaRepository.getValue !== 'function'
    || typeof appMetaRepository.setValue !== 'function') {
    throw new Error('createDashboardDefaultsService requires an appMetaRepository dependency.');
  }
  if (!projectOptionCatalogueService
    || typeof projectOptionCatalogueService.getStatusCatalogue !== 'function') {
    throw new Error('createDashboardDefaultsService requires a projectOptionCatalogueService dependency.');
  }

  function getSectionRegistry() {
    return buildDashboardSectionRegistry(projectOptionCatalogueService.getStatusCatalogue());
  }

  function getDefaults(sectionRegistry = getSectionRegistry()) {
    return normalizeDashboardDefaults(
      parseStoredDocument(appMetaRepository.getValue(DASHBOARD_DEFAULTS_KEY)),
      sectionRegistry,
    );
  }

  function getConfiguration() {
    const sectionRegistry = getSectionRegistry();
    return {
      sectionRegistry,
      defaults: getDefaults(sectionRegistry),
    };
  }

  function saveDefaults(defaults) {
    const normalized = normalizeDashboardDefaults(defaults, getSectionRegistry());
    appMetaRepository.setValue(DASHBOARD_DEFAULTS_KEY, JSON.stringify(normalized));
    return normalized;
  }

  return {
    getConfiguration,
    getDefaults,
    getSectionRegistry,
    saveDefaults,
  };
}
