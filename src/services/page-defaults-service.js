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
const CALENDAR = 'calendar';
const PROJECT_ASSETS = 'projectAssets';
const ASSET_VIEWER = 'assetViewer';
const NEW_PROJECT = 'new_project';
const LOGS = 'logs';
const BOOK_DETAIL = 'bookDetail';
const PAGE_DEFAULT_SCOPES = Object.freeze(['global', 'project']);

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
    gridStyle: definition('page_defaults.projects.grid_style', ['uncropped', 'cropped'], 'uncropped'),
    sort: definition('page_defaults.projects.sort', ['updated', 'created', 'title'], 'created'),
    order: definition('page_defaults.projects.order', ['asc', 'desc'], 'desc'),
    // WP2: Status, Project Type and Tag store complete selections. A legacy
    // scalar resolves as the equivalent one-value selection; nothing is
    // rewritten on read.
    status: definition('page_defaults.projects.status', ['all'], 'all', { multi: true }),
    projectType: definition('page_defaults.projects.project_type', ['all'], 'all', { multi: true }),
    tag: definition('page_defaults.projects.tag', ['all'], 'all', { multi: true }),
  }),
  [RELEASES]: Object.freeze({
    sort: definition('page_defaults.releases.sort', ['planned', 'updated', 'created', 'title'], 'planned'),
    order: definition('page_defaults.releases.order', ['asc', 'desc'], 'asc'),
  }),
  [CALENDAR]: Object.freeze({
    view: definition('page_defaults.calendar.view', ['grid', 'list'], 'grid'),
    status: definition('page_defaults.calendar.status', ['all', 'planned', 'published'], 'all'),
    weekStart: definition('page_defaults.calendar.week_start', ['monday', 'sunday'], 'monday'),
  }),
  [PROJECT_ASSETS]: Object.freeze({
    view: definition('page_defaults.project_assets.view', ['grid', 'list'], 'grid'),
    gridStyle: definition('page_defaults.project_assets.grid_style', ['uncropped', 'cropped'], 'uncropped'),
    gridSize: definition('page_defaults.project_assets.grid_size', ['compact', 'default', 'large'], 'default'),
    listSize: definition('page_defaults.project_assets.list_size', ['compact', 'large'], 'large'),
    sort: definition('page_defaults.project_assets.sort', ['filename', 'modified', 'size', 'category'], 'filename'),
    order: definition('page_defaults.project_assets.order', ['asc', 'desc'], 'asc'),
    pageSize: definition(
      'page_defaults.project_assets.page_size',
      ['10', '25', '50', '100', '150', '200', 'all'],
      '25',
    ),
    extension: definition('page_defaults.project_assets.extension', ['all'], 'all', { multi: true }),
    tag: definition('page_defaults.project_assets.tag', ['all'], 'all', { multi: true }),
  }),
  [ASSET_VIEWER]: Object.freeze({
    view: definition('page_defaults.asset_viewer.view', ['grid', 'list'], ASSET_LIBRARY_DEFAULTS.view),
    gridStyle: definition('page_defaults.asset_viewer.grid_style', ['uncropped', 'cropped'], 'uncropped'),
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
    category: definition('page_defaults.asset_viewer.category', ['all'], 'all', { multi: true }),
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

// WP9a F6: durable mutation generations, one per page that fences its
// Save / Reset defaults writes. These protocol records live in app_meta beside
// (never among) the page's saved default keys, so Reset defaults never deletes
// its own generation and no generation is ever reported as a saved setting.
const PAGE_DEFAULTS_GENERATION_KEYS = Object.freeze({
  [ASSET_VIEWER]: 'page_defaults_generation.asset_viewer',
  // WP10b: the Projects combined dialog uses the same fenced explicit Save /
  // Reset defaults protocol.
  [PROJECTS]: 'page_defaults_generation.projects',
});

export class PageDefaultsGenerationConflictError extends Error {
  constructor({ page, expectedGeneration, currentGeneration }) {
    super('Page defaults changed since the request was prepared.');
    this.name = 'PageDefaultsGenerationConflictError';
    this.page = page;
    this.expectedGeneration = expectedGeneration;
    this.currentGeneration = currentGeneration;
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
      || typeof projectPageDefaultRepository.getPageScope !== 'function'
      || typeof projectPageDefaultRepository.setPageScope !== 'function') {
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

    if (projectId === undefined || getPageDefaultScope(page, context) === 'global') {
      return resolveGlobalDefault(page, option, optionCatalogue);
    }

    return resolveProjectDefault(page, option, optionCatalogue, context);
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
    const storedScope = requireProjectRepository().getPageScope(projectId, page);
    return PAGE_DEFAULT_SCOPES.includes(storedScope) ? storedScope : 'global';
  }

  function setPageDefaultScope(page, activeScope, context) {
    requirePageDefinition(page);
    const projectId = requireProjectId(context);
    if (!PAGE_DEFAULT_SCOPES.includes(activeScope)) {
      invalid({ activeScope: `Scope "${activeScope}" is not supported.` });
    }
    return requireProjectRepository().setPageScope(projectId, page, activeScope);
  }

  /**
   * WP3 scope activation: makes one project's stored Global or Project-only
   * defaults active without saving any option value. Option rows (including
   * dormant project overrides), Global defaults and other projects are never
   * written. Activating the scope that already resolves as active writes
   * nothing, so a repeat is a no-op.
   */
  function activatePageDefaultScope(page, targetScope, context) {
    requirePageDefinition(page);
    const projectId = requireProjectId(context);
    if (!PAGE_DEFAULT_SCOPES.includes(targetScope)) {
      invalid({ scope: `Scope "${targetScope}" is not supported.` });
    }
    const projectRepository = requireProjectRepository();
    const storedScope = projectRepository.getPageScope(projectId, page);
    const previousScope = PAGE_DEFAULT_SCOPES.includes(storedScope) ? storedScope : 'global';
    const changed = previousScope !== targetScope;
    const activeScope = changed
      ? projectRepository.setPageScope(projectId, page, targetScope)
      : previousScope;
    return {
      page,
      projectId,
      previousScope,
      activeScope,
      changed,
    };
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

  function describeStoredOption(pageDefinition, storedValue, optionCatalogue) {
    // Presence is key/row existence, never a comparison with the fallback:
    // a stored '' or a stored fallback-equal value is still a saved default,
    // and a retained invalid value is reported as stored but not valid.
    const stored = storedValue !== undefined && storedValue !== null;
    return {
      stored,
      valid: stored && normalizeValue(
        pageDefinition, readStoredValue(pageDefinition, storedValue), optionCatalogue,
      ) !== undefined,
    };
  }

  /**
   * Read-only saved-state metadata for one page. With a project context it
   * also reports that project's persisted scope, its stored overrides, and
   * where each option's effective default comes from, mirroring resolve().
   */
  function describeSavedDefaults(page, optionCatalogues = {}, context) {
    const pageDefinition = requirePageDefinition(page);
    const projectId = getProjectId(context);
    const projectRepository = projectId === undefined ? null : requireProjectRepository();
    const storedScope = projectRepository ? projectRepository.getPageScope(projectId, page) : undefined;
    const activeScope = PAGE_DEFAULT_SCOPES.includes(storedScope) ? storedScope : 'global';
    const projectActive = projectRepository !== null && activeScope === 'project';
    const options = {};

    for (const option of Object.keys(pageDefinition)) {
      const definition = pageDefinition[option];
      const optionCatalogue = resolveOptionCatalogue(page, option, optionCatalogues?.[option]);
      const globalState = describeStoredOption(
        definition, repository.getValue(definition.key), optionCatalogue,
      );
      const projectState = projectRepository
        ? describeStoredOption(
          definition, projectRepository.getOption(projectId, page, option), optionCatalogue,
        )
        : null;
      let source = globalState.valid ? 'global' : 'fallback';
      if (projectActive && projectState.valid) source = 'project';

      options[option] = {
        global: globalState,
        ...(projectState ? { project: projectState } : {}),
        source,
      };
    }

    const states = Object.values(options);
    const globalSummary = {
      saved: states.some((state) => state.global.stored),
      invalid: states.some((state) => state.global.stored && !state.global.valid),
      active: !projectActive,
    };
    let projectSummary = null;
    if (projectRepository) {
      const overridden = states.filter((state) => state.source === 'project').length;
      projectSummary = {
        projectId,
        storedScope: storedScope ?? null,
        active: projectActive,
        saved: states.some((state) => state.project.stored),
        invalid: states.some((state) => state.project.stored && !state.project.valid),
        // Which options the active defaults take from Global (or the
        // fallback): all of them while Global is active.
        inheritance: !projectActive || overridden === 0
          ? 'full'
          : (overridden === states.length ? 'none' : 'partial'),
      };
    }

    return {
      page,
      activeScope,
      hasSavedDefaults: globalSummary.saved || Boolean(projectSummary?.saved),
      global: globalSummary,
      ...(projectSummary ? { project: projectSummary } : {}),
      options,
    };
  }

  /**
   * Deletes the page's recognized Global default keys only. The key list comes
   * from PAGE_DEFAULT_DEFINITIONS, never from the caller; project overrides,
   * project scopes, and every other app_meta key are untouched.
   */
  function resetGlobalPageDefaults(page) {
    const pageDefinition = requirePageDefinition(page);
    if (typeof repository.deleteValues !== 'function') {
      throw new Error('createPageDefaultsService requires appMetaRepository.deleteValues to reset defaults.');
    }
    const optionKeys = Object.keys(pageDefinition);
    const deletedKeys = new Set(repository.deleteValues(
      optionKeys.map((option) => pageDefinition[option].key),
    ));
    const deletedOptions = optionKeys.filter((option) => deletedKeys.has(pageDefinition[option].key));
    return {
      page,
      scope: 'global',
      changed: deletedOptions.length > 0,
      deletedOptions,
    };
  }

  /**
   * Deletes one project's overrides for the page and restores Global as its
   * active scope in one repository transaction. Global defaults and other
   * projects are untouched. This is a reset, not a scope switch.
   */
  function resetProjectPageDefaults(page, context) {
    requirePageDefinition(page);
    const projectId = requireProjectId(context);
    const projectRepository = requireProjectRepository();
    if (typeof projectRepository.resetPageToGlobal !== 'function') {
      throw new Error(
        'createPageDefaultsService requires projectPageDefaultRepository.resetPageToGlobal to reset defaults.'
      );
    }
    const { deletedOptions, previousScope } = projectRepository.resetPageToGlobal(projectId, page);
    const normalizedPreviousScope = PAGE_DEFAULT_SCOPES.includes(previousScope) ? previousScope : 'global';
    const scopeChanged = normalizedPreviousScope !== 'global';
    return {
      page,
      scope: 'project',
      projectId,
      changed: deletedOptions.length > 0 || scopeChanged,
      deletedOptions,
      previousScope: normalizedPreviousScope,
      activeScope: 'global',
      scopeChanged,
    };
  }

  function requireGenerationKey(page) {
    requirePageDefinition(page);
    const key = PAGE_DEFAULTS_GENERATION_KEYS[page];
    if (!key) throw new Error(`Page "${page}" has no defaults mutation generation.`);
    if (typeof repository.getCounter !== 'function' || typeof repository.compareAndIncrement !== 'function') {
      throw new Error('createPageDefaultsService requires appMetaRepository counters for mutation generations.');
    }
    return key;
  }

  /** The page's current defaults mutation generation (0 before any write). */
  function getMutationGeneration(page) {
    return repository.getCounter(requireGenerationKey(page));
  }

  /**
   * Fences one defaults mutation: advances the page's generation only when it
   * still equals `expectedGeneration`, else throws
   * PageDefaultsGenerationConflictError. Call it inside the same transaction
   * as the mutation so a rollback also rolls the generation back.
   */
  function advanceMutationGeneration(page, expectedGeneration) {
    const key = requireGenerationKey(page);
    const outcome = repository.compareAndIncrement(key, expectedGeneration);
    if (!outcome.advanced) {
      throw new PageDefaultsGenerationConflictError({
        page,
        expectedGeneration: Number.isSafeInteger(expectedGeneration) ? expectedGeneration : null,
        currentGeneration: outcome.current,
      });
    }
    return outcome.current;
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
    setPageDefaultScope,
    activatePageDefaultScope,
    validatePageDefaults,
    saveDefault,
    saveDefaultWithOutcome,
    saveGlobalDefault: saveDefault,
    saveProjectDefault,
    clearProjectPageDefaults,
    describeSavedDefaults,
    resetGlobalPageDefaults,
    resetProjectPageDefaults,
    getMutationGeneration,
    advanceMutationGeneration,
  };
}
