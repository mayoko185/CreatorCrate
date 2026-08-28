import { PROJECT_TYPES, STATUSES, WORKFLOW_STATUSES } from '../data/project-repository.js';
import {
  ASSET_LIBRARY_DEFAULTS,
  ASSET_LIBRARY_PAGE_SIZE_VALUES,
} from '../routes/asset-library-query.js';
import { APPLICATION_LOG_LEVELS } from './application-logger.js';

const PROJECTS = 'projects';
const RELEASES = 'releases';
const PROJECT_ASSETS = 'projectAssets';
const ASSET_VIEWER = 'assetViewer';
const NEW_PROJECT = 'new_project';
const LOGS = 'logs';

export const LOGS_PAGE_SIZE_VALUES = Object.freeze(['25', '50', '75', '100']);
export const LOGS_TIMEZONE_VALUES = Object.freeze([
  'local',
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
]);

function definition(key, values, fallback, { multi = false } = {}) {
  return Object.freeze({
    key,
    values: Object.freeze([...values]),
    fallback,
    ...(multi ? { multi: true } : {}),
  });
}

export const PAGE_DEFAULT_DEFINITIONS = Object.freeze({
  [PROJECTS]: Object.freeze({
    view: definition('page_defaults.projects.view', ['grid', 'list'], 'grid'),
    sort: definition('page_defaults.projects.sort', ['updated', 'created', 'title', 'published'], 'created'),
    order: definition('page_defaults.projects.order', ['asc', 'desc'], 'desc'),
    status: definition('page_defaults.projects.status', ['all', ...STATUSES], 'all'),
    projectType: definition('page_defaults.projects.project_type', ['all', ...PROJECT_TYPES], 'all'),
    tag: definition('page_defaults.projects.tag', ['all'], 'all'),
  }),
  [RELEASES]: Object.freeze({
    sort: definition('page_defaults.releases.sort', ['planned', 'updated', 'created', 'title'], 'planned'),
    order: definition('page_defaults.releases.order', ['asc', 'desc'], 'asc'),
  }),
  [PROJECT_ASSETS]: Object.freeze({
    view: definition('page_defaults.project_assets.view', ['grid', 'list'], 'grid'),
    gridSize: definition('page_defaults.project_assets.grid_size', ['compact', 'default', 'large'], 'default'),
    listSize: definition('page_defaults.project_assets.list_size', ['compact', 'large'], 'large'),
    sort: definition('page_defaults.project_assets.sort', ['filename', 'modified', 'size', 'category'], 'filename'),
    order: definition('page_defaults.project_assets.order', ['asc', 'desc'], 'asc'),
    pageSize: definition('page_defaults.project_assets.page_size', ['10', '25', '50', '100'], '25'),
    extension: definition('page_defaults.project_assets.extension', ['all'], 'all', { multi: true }),
    tag: definition('page_defaults.project_assets.tag', ['all'], 'all', { multi: true }),
    gridDetails: definition('page_defaults.project_assets.grid_details', ['shown', 'hidden'], 'shown'),
  }),
  [ASSET_VIEWER]: Object.freeze({
    view: definition('page_defaults.asset_viewer.view', ['grid', 'list'], ASSET_LIBRARY_DEFAULTS.view),
    sort: definition(
      'page_defaults.asset_viewer.sort',
      ['filename', 'modified', 'size', 'category', 'project'],
      ASSET_LIBRARY_DEFAULTS.sort,
    ),
    order: definition('page_defaults.asset_viewer.order', ['asc', 'desc'], ASSET_LIBRARY_DEFAULTS.order),
    pageSize: definition(
      'page_defaults.asset_viewer.page_size',
      ASSET_LIBRARY_PAGE_SIZE_VALUES.map(String),
      String(ASSET_LIBRARY_DEFAULTS.pageSize),
    ),
    extension: definition('page_defaults.asset_viewer.extension', ['all'], 'all'),
    category: definition('page_defaults.asset_viewer.category', ['all'], 'all'),
    presence: definition('page_defaults.asset_viewer.presence', ['all', 'present', 'missing'], 'all'),
    tag: definition('page_defaults.asset_viewer.tag', ['all'], 'all'),
  }),
  [NEW_PROJECT]: Object.freeze({
    status: definition('page_defaults.new_project.status', WORKFLOW_STATUSES, WORKFLOW_STATUSES[0]),
  }),
  [LOGS]: Object.freeze({
    level: definition('page_defaults.logs.level', ['', ...APPLICATION_LOG_LEVELS], ''),
    kind: definition('page_defaults.logs.kind', ['', 'activity', 'diagnostic'], ''),
    subsystem: definition('page_defaults.logs.subsystem', [''], ''),
    time: definition('page_defaults.logs.time', ['', 'hour', 'day', '7d', '30d'], ''),
    pageSize: definition('page_defaults.logs.page_size', LOGS_PAGE_SIZE_VALUES, '50'),
    timezone: definition('page_defaults.logs.timezone', LOGS_TIMEZONE_VALUES, 'local'),
    autoRefresh: definition('page_defaults.logs.auto_refresh', ['enabled', 'disabled'], 'enabled'),
  }),
});

export class PageDefaultValidationError extends Error {
  constructor(errors) {
    super('Page default validation failed');
    this.name = 'PageDefaultValidationError';
    this.errors = errors;
  }
}

function invalid(errors) {
  throw new PageDefaultValidationError(errors);
}

function requirePageDefinition(page) {
  const pageDefinition = typeof page === 'string' && Object.hasOwn(PAGE_DEFAULT_DEFINITIONS, page)
    ? PAGE_DEFAULT_DEFINITIONS[page]
    : null;
  if (!pageDefinition) {
    invalid({ page: `Page "${page}" is not supported.` });
  }
  return pageDefinition;
}

function requireDefinition(page, option) {
  const pageDefinition = requirePageDefinition(page);
  if (typeof option !== 'string' || !Object.hasOwn(pageDefinition, option)) {
    invalid({ option: `Option "${option}" is not supported for page "${page}".` });
  }
  return pageDefinition[option];
}

export function getPageDefaultOptionCatalogue(pageDefinition, optionCatalogue) {
  const source = Array.isArray(optionCatalogue) ? optionCatalogue : pageDefinition.values;
  const seen = new Set();

  return source.flatMap((candidate) => {
    const value = typeof candidate === 'string' ? candidate : candidate?.value;
    if (typeof value !== 'string' || seen.has(value)) return [];
    seen.add(value);
    return [{
      value,
      label: typeof candidate === 'object' && typeof candidate?.label === 'string'
        ? candidate.label
        : null,
    }];
  });
}

const PROJECT_ASSET_MULTI_VALUE_OPTIONS = new Set(['extension', 'tag']);

function isProjectAssetMultiValueOption(page, option) {
  return page === PROJECT_ASSETS && PROJECT_ASSET_MULTI_VALUE_OPTIONS.has(option);
}

function isValidValue(pageDefinition, value, optionCatalogue) {
  return typeof value === 'string'
    && getPageDefaultOptionCatalogue(pageDefinition, optionCatalogue)
      .some((candidate) => candidate.value === value);
}

function normalizeProjectAssetMultiValue(value, pageDefinition, optionCatalogue) {
  const values = Array.isArray(value) ? value : [value];
  const catalogue = getPageDefaultOptionCatalogue(pageDefinition, optionCatalogue);
  const allowedValues = new Set(catalogue.map((candidate) => candidate.value));
  const normalized = [...new Set(values)];

  if (normalized.length === 1 && normalized[0] === 'all') return 'all';
  if (normalized.length === 0
    || normalized.includes('all')
    || normalized.some((candidate) => typeof candidate !== 'string' || !allowedValues.has(candidate))) {
    return undefined;
  }

  return normalized;
}

function deserializeProjectAssetMultiValue(value) {
  if (typeof value !== 'string') return undefined;
  if (value === 'all') return 'all';

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function serializeProjectAssetMultiValue(value) {
  return Array.isArray(value) ? JSON.stringify(value) : value;
}

function normalizeValue(page, option, pageDefinition, value, optionCatalogue) {
  if (isProjectAssetMultiValueOption(page, option)) {
    return normalizeProjectAssetMultiValue(value, pageDefinition, optionCatalogue);
  }
  return isValidValue(pageDefinition, value, optionCatalogue) ? value : undefined;
}

function readStoredValue(page, option, value) {
  return isProjectAssetMultiValueOption(page, option)
    ? deserializeProjectAssetMultiValue(value)
    : value;
}

function persistValue(page, option, value) {
  return isProjectAssetMultiValueOption(page, option)
    ? serializeProjectAssetMultiValue(value)
    : value;
}

function requireProjectId(context) {
  const projectId = context?.projectId;
  if (!Number.isInteger(projectId) || projectId <= 0) {
    invalid({ projectId: 'A valid project ID is required for project page defaults.' });
  }
  return projectId;
}

function getProjectId(context) {
  if (context === undefined) return undefined;
  return requireProjectId(context);
}

export function createPageDefaultsService({
  appMetaRepository,
  preferenceRepository,
  projectPageDefaultRepository,
} = {}) {
  const repository = appMetaRepository ?? preferenceRepository;

  if (!repository || typeof repository.getValue !== 'function' || typeof repository.setValue !== 'function') {
    throw new Error('createPageDefaultsService requires an appMetaRepository dependency.');
  }

  function requireProjectRepository() {
    if (!projectPageDefaultRepository
      || typeof projectPageDefaultRepository.getOption !== 'function'
      || typeof projectPageDefaultRepository.setOption !== 'function'
      || typeof projectPageDefaultRepository.deletePageOptions !== 'function'
      || typeof projectPageDefaultRepository.hasPageOptions !== 'function') {
      throw new Error(
        'createPageDefaultsService requires a projectPageDefaultRepository for project-scoped defaults.'
      );
    }
    return projectPageDefaultRepository;
  }

  function getSavedDefault(page, option, optionCatalogue) {
    const pageDefinition = requireDefinition(page, option);
    const storedValue = readStoredValue(page, option, repository.getValue(pageDefinition.key));
    const value = normalizeValue(page, option, pageDefinition, storedValue, optionCatalogue);
    return value;
  }

  function getFallback(page, option) {
    return requireDefinition(page, option).fallback;
  }

  function resolveGlobalDefault(page, option, optionCatalogue) {
    const pageDefinition = requireDefinition(page, option);
    const savedValue = readStoredValue(page, option, repository.getValue(pageDefinition.key));
    return normalizeValue(page, option, pageDefinition, savedValue, optionCatalogue)
      ?? pageDefinition.fallback;
  }

  function resolveProjectDefault(page, option, optionCatalogue, context) {
    const pageDefinition = requireDefinition(page, option);
    const projectId = requireProjectId(context);
    const projectRepository = requireProjectRepository();
    const projectValue = readStoredValue(
      page,
      option,
      projectRepository.getOption(projectId, page, option),
    );

    return normalizeValue(page, option, pageDefinition, projectValue, optionCatalogue)
      ?? resolveGlobalDefault(page, option, optionCatalogue);
  }

  function resolve(page, option, explicitValue, optionCatalogue, context) {
    const pageDefinition = requireDefinition(page, option);
    const projectId = getProjectId(context);

    const normalizedExplicitValue = normalizeValue(
      page,
      option,
      pageDefinition,
      explicitValue,
      optionCatalogue,
    );
    if (normalizedExplicitValue !== undefined) {
      return normalizedExplicitValue;
    }

    if (explicitValue !== undefined) {
      return pageDefinition.fallback;
    }

    return projectId === undefined
      ? resolveGlobalDefault(page, option, optionCatalogue)
      : resolveProjectDefault(page, option, optionCatalogue, context);
  }

  function resolvePageDefaults(page, query = {}, optionCatalogues = {}, context) {
    const pageDefinition = requirePageDefinition(page);
    const rawQuery = query && typeof query === 'object' ? query : {};

    return Object.fromEntries(
      Object.keys(pageDefinition).map((option) => [
        option,
        resolve(page, option, rawQuery[option], optionCatalogues?.[option], context),
      ])
    );
  }

  function resolveGlobalPageDefaults(page, optionCatalogues = {}) {
    const pageDefinition = requirePageDefinition(page);
    return Object.fromEntries(
      Object.keys(pageDefinition).map((option) => [
        option,
        resolveGlobalDefault(page, option, optionCatalogues?.[option]),
      ])
    );
  }

  function resolveProjectPageDefaults(page, optionCatalogues = {}, context) {
    const pageDefinition = requirePageDefinition(page);
    requireProjectId(context);
    requireProjectRepository();

    return Object.fromEntries(
      Object.keys(pageDefinition).map((option) => [
        option,
        resolveProjectDefault(page, option, optionCatalogues?.[option], context),
      ])
    );
  }

  function getPageDefaultScope(page, context) {
    requirePageDefinition(page);
    const projectId = requireProjectId(context);
    return requireProjectRepository().hasPageOptions(projectId, page) ? 'project' : 'global';
  }

  function validatePageDefaults(page, values = {}, optionCatalogues = {}) {
    const pageDefinition = requirePageDefinition(page);
    const rawValues = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
    const errors = {};
    const normalizedValues = {};

    for (const option of Object.keys(pageDefinition)) {
      const definition = pageDefinition[option];
      const value = normalizeValue(
        page,
        option,
        definition,
        rawValues[option],
        optionCatalogues?.[option],
      );
      if (value === undefined) {
        errors[option] = `Value "${rawValues[option]}" is not supported for ${page}.${option}.`;
      } else {
        normalizedValues[option] = value;
      }
    }
    if (Object.keys(errors).length > 0) {
      invalid(errors);
    }

    return normalizedValues;
  }

  function saveDefault(page, option, value, optionCatalogue) {
    const pageDefinition = requireDefinition(page, option);
    const normalizedValue = normalizeValue(page, option, pageDefinition, value, optionCatalogue);
    if (normalizedValue === undefined) {
      invalid({ value: `Value "${value}" is not supported for ${page}.${option}.` });
    }
    repository.setValue(pageDefinition.key, persistValue(page, option, normalizedValue));
    return normalizedValue;
  }

  function saveDefaultWithOutcome(page, option, value, optionCatalogue) {
    const pageDefinition = requireDefinition(page, option);
    const normalizedValue = normalizeValue(page, option, pageDefinition, value, optionCatalogue);
    if (normalizedValue === undefined) {
      invalid({ value: `Value "${value}" is not supported for ${page}.${option}.` });
    }
    return repository.setValueWithOutcome(pageDefinition.key, persistValue(page, option, normalizedValue), {
      fallbackValue: pageDefinition.fallback,
    });
  }

  function saveProjectDefault(page, option, value, optionCatalogue, context) {
    const pageDefinition = requireDefinition(page, option);
    const projectId = requireProjectId(context);
    const normalizedValue = normalizeValue(page, option, pageDefinition, value, optionCatalogue);
    if (normalizedValue === undefined) {
      invalid({ value: `Value "${value}" is not supported for ${page}.${option}.` });
    }
    requireProjectRepository().setOption(
      projectId,
      page,
      option,
      persistValue(page, option, normalizedValue),
    );
    return normalizedValue;
  }

  function clearProjectPageDefaults(page, context) {
    requirePageDefinition(page);
    const projectId = requireProjectId(context);
    return requireProjectRepository().deletePageOptions(projectId, page);
  }

  return {
    getSavedDefault,
    getFallback,
    resolve,
    resolvePageDefaults,
    resolveGlobalPageDefaults,
    resolveProjectPageDefaults,
    getPageDefaultScope,
    validatePageDefaults,
    saveDefault,
    saveDefaultWithOutcome,
    saveGlobalDefault: saveDefault,
    saveProjectDefault,
    clearProjectPageDefaults,
  };
}
