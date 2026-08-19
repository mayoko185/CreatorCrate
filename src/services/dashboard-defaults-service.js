import { STATUSES } from '../data/project-repository.js';

export const DASHBOARD_DEFAULTS_KEY = 'page_defaults.dashboard';
export const DASHBOARD_DEFAULTS_VERSION = 1;
export const DASHBOARD_DEFAULT_ITEM_COUNT = 8;
export const DASHBOARD_ITEM_COUNT_MIN = 1;
export const DASHBOARD_ITEM_COUNT_MAX = 25;

const STATUS_SECTION_LABELS = Object.freeze({
  tbd: 'TBD',
  planned: 'Planned',
  'in-progress': 'In progress',
  ready: 'Ready',
  completed: 'Completed',
  archived: 'Archived',
});

function getStatusSectionLabel(status) {
  return STATUS_SECTION_LABELS[status]
    ?? `${status.charAt(0).toUpperCase()}${status.slice(1).replaceAll('-', ' ')}`;
}

export const DASHBOARD_SECTION_REGISTRY = Object.freeze([
  Object.freeze({ id: 'overdue', label: 'Overdue' }),
  Object.freeze({ id: 'upcoming', label: 'Upcoming releases' }),
  Object.freeze({ id: 'recently-updated', label: 'Recently updated projects' }),
  ...STATUSES.map((status) => Object.freeze({
    id: `status:${status}`,
    label: getStatusSectionLabel(status),
    status,
  })),
]);

const SECTION_IDS = Object.freeze(DASHBOARD_SECTION_REGISTRY.map(({ id }) => id));
const SECTION_ID_SET = new Set(SECTION_IDS);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defaultSection() {
  return { visible: true, itemCount: DASHBOARD_DEFAULT_ITEM_COUNT };
}

function canonicalDefaults() {
  return {
    version: DASHBOARD_DEFAULTS_VERSION,
    order: [...SECTION_IDS],
    sections: Object.fromEntries(SECTION_IDS.map((sectionId) => [sectionId, defaultSection()])),
  };
}

function normalizeOrder(order) {
  const seen = new Set();
  const normalized = [];

  if (Array.isArray(order)) {
    for (const sectionId of order) {
      if (typeof sectionId !== 'string' || !SECTION_ID_SET.has(sectionId) || seen.has(sectionId)) continue;
      seen.add(sectionId);
      normalized.push(sectionId);
    }
  }

  for (const sectionId of SECTION_IDS) {
    if (!seen.has(sectionId)) normalized.push(sectionId);
  }
  return normalized;
}

function normalizeSection(section) {
  if (!isPlainObject(section)) return defaultSection();

  return {
    visible: typeof section.visible === 'boolean' ? section.visible : true,
    itemCount: Number.isInteger(section.itemCount)
      && section.itemCount >= DASHBOARD_ITEM_COUNT_MIN
      && section.itemCount <= DASHBOARD_ITEM_COUNT_MAX
      ? section.itemCount
      : DASHBOARD_DEFAULT_ITEM_COUNT,
  };
}

export function normalizeDashboardDefaults(document) {
  if (!isPlainObject(document) || document.version !== DASHBOARD_DEFAULTS_VERSION) {
    return canonicalDefaults();
  }

  const sections = isPlainObject(document.sections) ? document.sections : {};
  return {
    version: DASHBOARD_DEFAULTS_VERSION,
    order: normalizeOrder(document.order),
    sections: Object.fromEntries(SECTION_IDS.map((sectionId) => [
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

export function createDashboardDefaultsService({ appMetaRepository } = {}) {
  if (!appMetaRepository || typeof appMetaRepository.getValue !== 'function'
    || typeof appMetaRepository.setValue !== 'function') {
    throw new Error('createDashboardDefaultsService requires an appMetaRepository dependency.');
  }

  function getDefaults() {
    return normalizeDashboardDefaults(parseStoredDocument(appMetaRepository.getValue(DASHBOARD_DEFAULTS_KEY)));
  }

  function saveDefaults(defaults) {
    const normalized = normalizeDashboardDefaults(defaults);
    appMetaRepository.setValue(DASHBOARD_DEFAULTS_KEY, JSON.stringify(normalized));
    return normalized;
  }

  return {
    getDefaults,
    saveDefaults,
  };
}
