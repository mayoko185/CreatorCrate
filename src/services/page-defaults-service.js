import {
  ARCHIVED_PROJECT_STATUS,
  DEFAULT_PROJECT_STATUS,
  DEFAULT_PROJECT_TYPE,
} from '../data/project-repository.js';
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
const BOOK_DETAIL = 'bookDetail';

const SYSTEM_ARCHIVED_PROJECT_FILTER_OPTION = Object.freeze({
  value: ARCHIVED_PROJECT_STATUS,
  label: 'Archived',
});

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
    sort: definition('page_defaults.projects.sort', ['updated', 'created', 'title'], 'created'),
    order: definition('page_defaults.projects.order', ['asc', 'desc'], 'desc'),
    status: definition('page_defaults.projects.status', ['all'], 'all'),
    projectType: definition('page_defaults.projects.project_type', ['all'], 'all'),
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
    extension: definition('page_defaults.asset_viewer.extension', ['all'], 'all', { multi: true }),
    category: definition('page_defaults.asset_viewer.category', ['all'], 'all'),
    presence: definition('page_defaults.asset_viewer.presence', ['all', 'present', 'missing'], 'all'),
    tag: definition('page_defaults.asset_viewer.tag', ['all'], 'all', { multi: true }),
  }),
  [NEW_PROJECT]: Object.freeze({
    status: definition('page_defaults.new_project.status', [DEFAULT_PROJECT_STATUS], DEFAULT_PROJECT_STATUS),
    projectType: definition(
      'page_defaults.new_project.project_type',
      [DEFAULT_PROJECT_TYPE],
      DEFAULT_PROJECT_TYPE,
    ),
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
  [BOOK_DETAIL]: Object.freeze({
    navigation: definition(
      'page_defaults.book_detail.navigation',
      ['expanded', 'collapsed'],
      'collapsed',
    ),
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
      ...(candidate && typeof candidate === 'object' ? candidate : {}),
      value,
      label: typeof candidate === 'object' && typeof candidate?.label === 'string'
        ? candidate.label
        : null,
    }];
  });
}

function isValidValue(pageDefinition, value, optionCatalogue) {
  return typeof value === 'string'
    && getPageDefaultOptionCatalogue(pageDefinition, optionCatalogue)
      .some((candidate) => candidate.value === value);
}

function normalizeMultiValue(value, pageDefinition, optionCatalogue) {
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

function deserializeMultiValue(value) {
  if (typeof value !== 'string') return undefined;
  if (value === 'all') return 'all';

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function serializeMultiValue(value) {
  return Array.isArray(value) ? JSON.stringify(value) : value;
}

function normalizeValue(pageDefinition, value, optionCatalogue) {
  if (pageDefinition.multi === true) {
    return normalizeMultiValue(value, pageDefinition, optionCatalogue);
  }
  return isValidValue(pageDefinition, value, optionCatalogue) ? value : undefined;
}

function readStoredValue(pageDefinition, value) {
  return pageDefinition.multi === true
    ? deserializeMultiValue(value)
    : value;
}

function persistValue(pageDefinition, value) {
  return pageDefinition.multi === true
    ? serializeMultiValue(value)
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
  projectOptionCatalogueService,
} = {}) {
  const repository = appMetaRepository ?? preferenceRepository;

  if (!repository || typeof repository.getValue !== 'function' || typeof repository.setValue !== 'function') {
    throw new Error('createPageDefaultsService requires an appMetaRepository dependency.');
  }
  if (projectOptionCatalogueService
    && (typeof projectOptionCatalogueService.getStatusCatalogue !== 'function'
      || typeof projectOptionCatalogueService.getProjectTypeCatalogue !== 'function')) {
    throw new Error('createPageDefaultsService received an invalid projectOptionCatalogueService dependency.');
  }

  function getLiveOptionCatalogue(page, option) {
    if (!projectOptionCatalogueService) return undefined;

    if (page === NEW_PROJECT && option === 'status') {
      return projectOptionCatalogueService.getStatusCatalogue();
    }
    if (page === NEW_PROJECT && option === 'projectType') {
      return projectOptionCatalogueService.getProjectTypeCatalogue();
    }
    if (page === PROJECTS && option === 'status') {
      return [
        { value: 'all', label: 'All active' },
        ...projectOptionCatalogueService.getStatusCatalogue()
          .filter(({ value }) => value !== ARCHIVED_PROJECT_STATUS),
        SYSTEM_ARCHIVED_PROJECT_FILTER_OPTION,
      ];
    }
    if (page === PROJECTS && option === 'projectType') {
      return [{ value: 'all', label: 'All types' }, ...projectOptionCatalogueService.getProjectTypeCatalogue()];
    }
    return undefined;
  }

  function resolveOptionCatalogue(page, option, optionCatalogue) {
    return optionCatalogue ?? getLiveOptionCatalogue(page, option);
  }

  function getOptionCatalogue(page, option, optionCatalogue) {
    return getPageDefaultOptionCatalogue(
      requireDefinition(page, option),
      resolveOptionCatalogue(page, option, optionCatalogue),
    );
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
    const storedValue = readStoredValue(pageDefinition, repository.getValue(pageDefinition.key));
    const value = normalizeValue(
      pageDefinition, storedValue, resolveOptionCatalogue(page, option, optionCatalogue),
    );
    return value;
  }

  function getFallback(page, option) {
    return requireDefinition(page, option).fallback;
  }

  function resolveGlobalDefault(page, option, optionCatalogue) {
    const pageDefinition = requireDefinition(page, option);
    const savedValue = readStoredValue(pageDefinition, repository.getValue(pageDefinition.key));
    return normalizeValue(
      pageDefinition, savedValue, resolveOptionCatalogue(page, option, optionCatalogue),
    )
      ?? pageDefinition.fallback;
  }

  function resolveProjectDefault(page, option, optionCatalogue, context) {
    const pageDefinition = requireDefinition(page, option);
    const projectId = requireProjectId(context);
    const projectRepository = requireProjectRepository();
    const projectValue = readStoredValue(
      pageDefinition,
      projectRepository.getOption(projectId, page, option),
    );

    const resolvedCatalogue = resolveOptionCatalogue(page, option, optionCatalogue);
    return normalizeValue(pageDefinition, projectValue, resolvedCatalogue)
      ?? resolveGlobalDefault(page, option, resolvedCatalogue);
  }

  function resolve(page, option, explicitValue, optionCatalogue, context) {
    const pageDefinition = requireDefinition(page, option);
    const projectId = getProjectId(context);

    const normalizedExplicitValue = normalizeValue(
      pageDefinition,
      explicitValue,
      resolveOptionCatalogue(page, option, optionCatalogue),
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
        definition,
        rawValues[option],
        resolveOptionCatalogue(page, option, optionCatalogues?.[option]),
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
    const normalizedValue = normalizeValue(
      pageDefinition, value, resolveOptionCatalogue(page, option, optionCatalogue),
    );
    if (normalizedValue === undefined) {
      invalid({ value: `Value "${value}" is not supported for ${page}.${option}.` });
    }
    repository.setValue(pageDefinition.key, persistValue(pageDefinition, normalizedValue));
    return normalizedValue;
  }

  function saveDefaultWithOutcome(page, option, value, optionCatalogue) {
    const pageDefinition = requireDefinition(page, option);
    const normalizedValue = normalizeValue(
      pageDefinition, value, resolveOptionCatalogue(page, option, optionCatalogue),
    );
    if (normalizedValue === undefined) {
      invalid({ value: `Value "${value}" is not supported for ${page}.${option}.` });
    }
    return repository.setValueWithOutcome(pageDefinition.key, persistValue(pageDefinition, normalizedValue), {
      fallbackValue: pageDefinition.fallback,
    });
  }

  function saveProjectDefault(page, option, value, optionCatalogue, context) {
    const pageDefinition = requireDefinition(page, option);
    const projectId = requireProjectId(context);
    const normalizedValue = normalizeValue(
      pageDefinition, value, resolveOptionCatalogue(page, option, optionCatalogue),
    );
    if (normalizedValue === undefined) {
      invalid({ value: `Value "${value}" is not supported for ${page}.${option}.` });
    }
    requireProjectRepository().setOption(
      projectId,
      page,
      option,
      persistValue(pageDefinition, normalizedValue),
    );
    return normalizedValue;
  }

  function clearProjectPageDefaults(page, context) {
    requirePageDefinition(page);
    const projectId = requireProjectId(context);
    return requireProjectRepository().deletePageOptions(projectId, page);
  }

  return {
    getOptionCatalogue,
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
