import { WORKFLOW_STATUSES, PRIORITIES } from '../data/project-repository.js';
import {
  ASSET_LIBRARY_DEFAULTS,
  ASSET_LIBRARY_PAGE_SIZE_VALUES,
} from '../routes/asset-library-query.js';
import { DEFAULT_PRIORITY } from './project-service.js';

const PROJECTS = 'projects';
const RELEASES = 'releases';
const RELEASE_MANAGEMENT = 'releaseManagement';
const PROJECT_ASSETS = 'projectAssets';
const ASSET_VIEWER = 'assetViewer';
const NEW_PROJECT = 'new_project';

function definition(key, values, fallback) {
  return Object.freeze({
    key,
    values: Object.freeze([...values]),
    fallback,
  });
}

export const PAGE_DEFAULT_DEFINITIONS = Object.freeze({
  [PROJECTS]: Object.freeze({
    view: definition('page_defaults.projects.view', ['grid', 'list'], 'grid'),
    sort: definition('page_defaults.projects.sort', ['updated', 'created', 'title', 'published'], 'created'),
    order: definition('page_defaults.projects.order', ['asc', 'desc'], 'desc'),
  }),
  [RELEASES]: Object.freeze({
    view: definition('page_defaults.releases.view', ['list', 'board'], 'list'),
    sort: definition('page_defaults.releases.sort', ['planned', 'updated', 'created', 'title'], 'planned'),
    order: definition('page_defaults.releases.order', ['asc', 'desc'], 'asc'),
  }),
  [RELEASE_MANAGEMENT]: Object.freeze({
    view: definition('page_defaults.release_management.view', ['list', 'board'], 'list'),
    sort: definition('page_defaults.release_management.sort', ['updated', 'created', 'planned', 'title'], 'updated'),
    order: definition('page_defaults.release_management.order', ['asc', 'desc'], 'desc'),
  }),
  [PROJECT_ASSETS]: Object.freeze({
    view: definition('page_defaults.project_assets.view', ['grid', 'list'], 'grid'),
    sort: definition('page_defaults.project_assets.sort', ['filename', 'modified', 'size', 'category'], 'filename'),
    order: definition('page_defaults.project_assets.order', ['asc', 'desc'], 'asc'),
    pageSize: definition('page_defaults.project_assets.page_size', ['10', '25', '50', '100'], '25'),
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
  }),
  [NEW_PROJECT]: Object.freeze({
    status: definition('page_defaults.new_project.status', WORKFLOW_STATUSES, WORKFLOW_STATUSES[0]),
    priority: definition('page_defaults.new_project.priority', PRIORITIES, DEFAULT_PRIORITY),
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

function requireDefinition(page, option) {
  const pageDefinition = typeof page === 'string' && Object.hasOwn(PAGE_DEFAULT_DEFINITIONS, page)
    ? PAGE_DEFAULT_DEFINITIONS[page]
    : null;
  if (!pageDefinition || typeof option !== 'string' || !Object.hasOwn(pageDefinition, option)) {
    invalid({ option: `Option "${option}" is not supported for page "${page}".` });
  }
  return pageDefinition[option];
}

function isValidValue(pageDefinition, value) {
  return typeof value === 'string' && pageDefinition.values.includes(value);
}

export function createPageDefaultsService({ appMetaRepository, preferenceRepository } = {}) {
  const repository = appMetaRepository ?? preferenceRepository;

  if (!repository || typeof repository.getValue !== 'function' || typeof repository.setValue !== 'function') {
    throw new Error('createPageDefaultsService requires an appMetaRepository dependency.');
  }

  function getSavedDefault(page, option) {
    const pageDefinition = requireDefinition(page, option);
    const storedValue = repository.getValue(pageDefinition.key);
    return isValidValue(pageDefinition, storedValue) ? storedValue : undefined;
  }

  function getFallback(page, option) {
    return requireDefinition(page, option).fallback;
  }

  function resolve(page, option, explicitValue) {
    const pageDefinition = requireDefinition(page, option);

    if (explicitValue !== undefined) {
      return isValidValue(pageDefinition, explicitValue)
        ? explicitValue
        : pageDefinition.fallback;
    }

    const savedValue = repository.getValue(pageDefinition.key);
    return isValidValue(pageDefinition, savedValue)
      ? savedValue
      : pageDefinition.fallback;
  }

  function resolvePageDefaults(page, query = {}) {
    const pageDefinition = typeof page === 'string' && Object.hasOwn(PAGE_DEFAULT_DEFINITIONS, page)
      ? PAGE_DEFAULT_DEFINITIONS[page]
      : null;
    if (!pageDefinition) {
      invalid({ page: `Page "${page}" is not supported.` });
    }

    const rawQuery = query && typeof query === 'object' ? query : {};
    return Object.fromEntries(
      Object.keys(pageDefinition).map((option) => [option, resolve(page, option, rawQuery[option])])
    );
  }

  function validatePageDefaults(page, values = {}) {
    const pageDefinition = typeof page === 'string' && Object.hasOwn(PAGE_DEFAULT_DEFINITIONS, page)
      ? PAGE_DEFAULT_DEFINITIONS[page]
      : null;
    if (!pageDefinition) {
      invalid({ page: `Page "${page}" is not supported.` });
    }

    const rawValues = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
    const errors = {};
    for (const option of Object.keys(pageDefinition)) {
      const definition = pageDefinition[option];
      if (!isValidValue(definition, rawValues[option])) {
        errors[option] = `Value "${rawValues[option]}" is not supported for ${page}.${option}.`;
      }
    }
    if (Object.keys(errors).length > 0) {
      invalid(errors);
    }

    return Object.fromEntries(
      Object.keys(pageDefinition).map((option) => [option, rawValues[option]])
    );
  }

  function saveDefault(page, option, value) {
    const pageDefinition = requireDefinition(page, option);
    if (!isValidValue(pageDefinition, value)) {
      invalid({ value: `Value "${value}" is not supported for ${page}.${option}.` });
    }
    return repository.setValue(pageDefinition.key, value);
  }

  return {
    getSavedDefault,
    getFallback,
    resolve,
    resolvePageDefaults,
    validatePageDefaults,
    saveDefault,
  };
}
