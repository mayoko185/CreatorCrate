import express from 'express';
import {
  ASSET_LIBRARY_PAGE_SIZE_VALUES,
  ASSET_LIBRARY_SEARCH_MAX_LENGTH,
  buildAssetLibraryUrl,
  isBareAssetLibraryRequest,
  parseAssetLibraryQuery,
} from './asset-library-query.js';
import { NSFW_TAG_NAME } from '../services/nsfw-filter-settings-service.js';
import {
  AssetCategoryValidationError,
  parseEnabledField,
} from '../services/asset-category-validation.js';
import {
  buildPageDefaultsDialogModel,
  handlePageDefaultsPost,
} from './page-defaults.js';
import {
  PAGE_DEFAULT_DEFINITIONS,
  PageDefaultsGenerationConflictError,
} from '../services/page-defaults-service.js';

const ASSET_LIBRARY_ORDER_OPTIONS = Object.freeze([
  Object.freeze({ value: 'asc', label: 'Ascending' }),
  Object.freeze({ value: 'desc', label: 'Descending' }),
]);

const ASSET_VIEWER_PAGE_DEFAULTS = 'assetViewer';
const ASSET_LIBRARY_PRESENTATION_OPTIONS = Object.freeze([
  Object.freeze({ key: 'view', option: 'view' }),
  Object.freeze({ key: 'sort', option: 'sort' }),
  Object.freeze({ key: 'order', option: 'order' }),
  Object.freeze({ key: 'pageSize', option: 'pageSize' }),
]);

const NSFW_TAG_NORMALIZED_NAME = NSFW_TAG_NAME.toLowerCase();

const ASSET_VIEWER_DEFAULT_LABELS = Object.freeze({
  fields: Object.freeze({
    view: 'View',
    gridStyle: 'Grid style',
    sort: 'Sort',
    order: 'Order',
    pageSize: 'Page size',
    extension: 'Extension',
    category: 'Category',
    presence: 'Presence',
    tag: 'Tag',
  }),
  options: Object.freeze({
    view: Object.freeze({ grid: 'Grid', list: 'List' }),
    gridStyle: Object.freeze({ uncropped: 'Uncropped', cropped: 'Cropped' }),
    sort: Object.freeze({
      filename: 'Filename',
      modified: 'Modified',
      size: 'Size',
      category: 'Category',
      project: 'Project',
    }),
    order: Object.freeze({ asc: 'Ascending', desc: 'Descending' }),
    pageSize: Object.freeze(Object.fromEntries(ASSET_LIBRARY_PAGE_SIZE_VALUES.map((value) => [
      String(value),
      value === 'all' ? 'View All' : String(value),
    ]))),
    extension: Object.freeze({ all: 'All extensions' }),
    category: Object.freeze({ all: 'All categories' }),
    presence: Object.freeze({ all: 'All assets', present: 'Present', missing: 'Missing' }),
    tag: Object.freeze({ all: 'All tags' }),
  }),
});

const ASSET_VIEWER_NOTICES = Object.freeze({
  defaultsSaved: 'Asset Viewer defaults saved successfully.',
  defaultsReset: 'Asset Viewer defaults reset to the application defaults.',
});

// WP9a: the nine saveable Asset Viewer settings, in definition order. The
// list comes from the page-defaults definitions, never from a request.
const ASSET_VIEWER_DEFAULT_FIELDS = Object.freeze(Object.keys(PAGE_DEFAULT_DEFINITIONS[ASSET_VIEWER_PAGE_DEFAULTS]));
const ASSET_VIEWER_MULTI_FIELDS = Object.freeze(ASSET_VIEWER_DEFAULT_FIELDS
  .filter((field) => PAGE_DEFAULT_DEFINITIONS[ASSET_VIEWER_PAGE_DEFAULTS][field].multi === true));
// Approved Reset filters destination: every default-backed control resolves
// from the effective saved/default values and the temporary filters clear.
const ASSET_VIEWER_RESET_FILTERS_URL = '/asset-viewer?resetFilters=1';

// WP9a F6/F7 mutation protocol. Every Save / Reset defaults request carries
// the defaults generation it was prepared from (`defaultsGeneration`) and a
// client-chosen operation identity (`defaultsOperation`). The handler fences
// the write on the generation inside the write transaction and echoes the
// identity in each JSON answer it produces, so a client can tell this
// handler's answer from any intermediary response.
const ASSET_VIEWER_DEFAULTS_GENERATION_FIELD = 'defaultsGeneration';
const ASSET_VIEWER_DEFAULTS_OPERATION_FIELD = 'defaultsOperation';
const ASSET_VIEWER_DEFAULTS_OPERATION_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const ASSET_VIEWER_DEFAULTS_CONFLICT_CODE = 'DEFAULTS_GENERATION_CONFLICT';
const ASSET_VIEWER_DEFAULTS_CONFLICT_MESSAGE = 'Asset Viewer defaults changed since this page was loaded. '
  + 'No changes were made. Review the current defaults and try again.';

function readDefaultsMutationRequest(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const generation = body[ASSET_VIEWER_DEFAULTS_GENERATION_FIELD];
  const operation = body[ASSET_VIEWER_DEFAULTS_OPERATION_FIELD];
  const parsedGeneration = typeof generation === 'string' && /^(0|[1-9]\d*)$/.test(generation)
    ? Number(generation)
    : Number.NaN;
  return {
    // Missing or malformed: null, which never matches the stored generation.
    expectedGeneration: Number.isSafeInteger(parsedGeneration) ? parsedGeneration : null,
    operationId: typeof operation === 'string' && ASSET_VIEWER_DEFAULTS_OPERATION_PATTERN.test(operation)
      ? operation
      : null,
  };
}

// The request-correlated acknowledgement. `generation` is the stored
// generation this answer establishes: the new one after a commit, the current
// one on a conflict, and null when the handler made no claim about it.
function defaultsOperationAcknowledgement(kind, mutation, { result, generation = null }) {
  return {
    operation: {
      id: mutation.operationId,
      kind,
      result,
      committed: result === 'committed',
      expectedGeneration: mutation.expectedGeneration,
      generation,
    },
  };
}

function fingerprint(text) {
  // FNV-1a (32-bit): a compact revision token, not a security boundary.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function toDefaultsMultiValue(values) {
  return Array.isArray(values) && values.length > 0 ? values.map(String) : 'all';
}

/**
 * WP9a authoritative Asset Viewer defaults metadata. Saved status is stored
 * key presence (describeSavedDefaults), never a comparison with the
 * fallback, so an explicitly saved fallback-equal value still reports saved.
 * `current` (render only) is the effective state of the rendered page in the
 * same canonical value shapes as `defaults`.
 */
function buildAssetViewerDefaultsAuthority(pageDefaultsService, optionCatalogues, extra = {}) {
  const description = pageDefaultsService.describeSavedDefaults(ASSET_VIEWER_PAGE_DEFAULTS, optionCatalogues);
  const defaults = pageDefaultsService.resolveGlobalPageDefaults(ASSET_VIEWER_PAGE_DEFAULTS, optionCatalogues);
  const fallbacks = Object.fromEntries(ASSET_VIEWER_DEFAULT_FIELDS.map((field) => [
    field,
    pageDefaultsService.getFallback(ASSET_VIEWER_PAGE_DEFAULTS, field),
  ]));
  const saved = Object.fromEntries(ASSET_VIEWER_DEFAULT_FIELDS.map((field) => [field, {
    stored: description.options[field].global.stored,
    valid: description.options[field].global.valid,
  }]));
  const savedKeys = ASSET_VIEWER_DEFAULT_FIELDS.filter((field) => saved[field].stored);
  return {
    page: ASSET_VIEWER_PAGE_DEFAULTS,
    fields: [...ASSET_VIEWER_DEFAULT_FIELDS],
    multiFields: [...ASSET_VIEWER_MULTI_FIELDS],
    fallbacks,
    defaults,
    saved,
    savedKeys,
    hasSavedDefaults: savedKeys.length > 0,
    // WP9a F6: the durable mutation generation a Save / Reset defaults must
    // carry. Unlike `revision` it changes on every accepted write, including
    // a no-op Reset or a write that restores earlier values.
    generation: pageDefaultsService.getMutationGeneration(ASSET_VIEWER_PAGE_DEFAULTS),
    revision: fingerprint(JSON.stringify({ defaults, saved })),
    resetFiltersUrl: ASSET_VIEWER_RESET_FILTERS_URL,
    ...extra,
  };
}

function buildAssetViewerCurrentDefaultsState(page, gridStyle) {
  return {
    view: page.presentation?.view ?? page.filters?.view,
    gridStyle,
    sort: page.filters.sort,
    order: page.filters.order,
    pageSize: String(page.pageSize),
    extension: toDefaultsMultiValue(page.filters.extensions),
    category: toDefaultsMultiValue(page.filters.categories),
    presence: page.filters.presence,
    tag: toDefaultsMultiValue(page.filters.tags),
  };
}

// The temporary (never saved) filter context of a request: Search, the
// repeated Project and Project Type selections, and Usage.
function readTemporaryAssetLibraryContext(parsed) {
  return {
    projectIds: [...parsed.projectIds],
    projectTypes: [...parsed.projectTypes],
    search: parsed.search,
    usage: parsed.usage,
  };
}

function serializeAuthorityJson(authority) {
  return JSON.stringify(authority).replace(/</g, '\\u003c');
}

function resolveAssetViewerDefaultsNotice(value) {
  return value === 'asset_viewer_defaults_saved' ? ASSET_VIEWER_NOTICES.defaultsSaved : null;
}

function buildPageSizeOptions(selectedValue) {
  return ASSET_LIBRARY_PAGE_SIZE_VALUES.map((value) => ({
    value,
    label: value === 'all' ? 'View All' : String(value),
    selected: value === selectedValue,
  }));
}

function buildOrderOptions(selectedValue) {
  return ASSET_LIBRARY_ORDER_OPTIONS.map((option) => ({
    ...option,
    selected: option.value === selectedValue,
  }));
}

function getRequestUrl(req) {
  return typeof req.originalUrl === 'string' ? req.originalUrl : req.url;
}

function getExplicitNeutralAssetLibraryFilters(query) {
  if (!query || typeof query !== 'object') return [];
  return ['category', 'tag', 'extension', 'presence'].filter((key) => {
    const values = Array.isArray(query[key]) ? query[key] : [query[key]];
    return values.some((value) => typeof value === 'string' && value.trim() === 'all');
  });
}

function getPageDefaultsService(req) {
  const service = req.app?.locals?.pageDefaultsService;
  if (!service) {
    throw new Error('Asset Viewer requires app.locals.pageDefaultsService.');
  }
  return service;
}

function getNsfwFilterSettingsService(req) {
  const service = req.app?.locals?.nsfwFilterSettingsService;
  if (!service) {
    throw new Error('Asset Viewer requires app.locals.nsfwFilterSettingsService.');
  }
  return service;
}

function isNsfwTag(tag) {
  return [tag?.displayName, tag?.display_name, tag?.normalizedName, tag?.normalized_name].some((value) => (
    typeof value === 'string' && value.trim().toLowerCase() === NSFW_TAG_NORMALIZED_NAME
  ));
}

function withNsfwBlur(asset, filterEnabled) {
  return {
    ...asset,
    nsfwBlur: Boolean(filterEnabled && Array.isArray(asset.tags) && asset.tags.some(isNsfwTag)),
  };
}

function isEnhancedRequest(req) {
  return String(req.get?.('Accept') || '').toLowerCase().includes('application/json');
}

function readAssetViewerReturnUrl(req) {
  const candidate = typeof req.body?.returnTo === 'string' ? req.body.returnTo : '';
  if (candidate && candidate.startsWith('/asset-viewer')) return candidate;
  return '/asset-viewer';
}

function readAssetViewerNsfwReturnUrl(req) {
  const candidate = typeof req.body?.returnTo === 'string' ? req.body.returnTo : '';
  if (candidate && candidate.startsWith('/asset-viewer')) return candidate;
  return '/asset-viewer';
}

function normalizeSavedPresentationValue(key, value) {
  return key === 'pageSize' && value !== 'all' ? Number(value) : value;
}

function buildAssetViewerOptionCatalogues(page, extensions) {
  return {
    extension: [
      { value: 'all', label: 'All extensions' },
      ...(extensions || []).map((value) => ({
        value,
        label: `.${value}`,
      })),
    ],
    category: (page.categoryOptions || []).map((option) => ({
      value: option.value,
      label: option.label,
    })),
    presence: (page.presenceOptions || []).map((option) => ({
      value: option.value,
      label: option.label,
    })),
    tag: [
      { value: 'all', label: 'All tags' },
      ...(page.tagOptions || []).map((option) => ({
        value: option.value,
        label: option.displayName,
      })),
    ],
  };
}

function normalizeAssetViewerDefaultSelection(value, mapValue = (candidate) => candidate) {
  if (value === 'all') return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map(mapValue);
}

function resolveAssetViewerFilterDefaults(pageDefaultsService, optionCatalogues) {
  const category = pageDefaultsService.resolve(
    ASSET_VIEWER_PAGE_DEFAULTS,
    'category',
    undefined,
    optionCatalogues.category,
  );
  const tag = pageDefaultsService.resolve(
    ASSET_VIEWER_PAGE_DEFAULTS,
    'tag',
    undefined,
    optionCatalogues.tag,
  );
  const extension = pageDefaultsService.resolve(
    ASSET_VIEWER_PAGE_DEFAULTS,
    'extension',
    undefined,
    optionCatalogues.extension,
  );

  return {
    categories: normalizeAssetViewerDefaultSelection(category),
    tags: normalizeAssetViewerDefaultSelection(tag, Number),
    extensions: normalizeAssetViewerDefaultSelection(extension),
    presence: pageDefaultsService.resolve(
      ASSET_VIEWER_PAGE_DEFAULTS,
      'presence',
      undefined,
      optionCatalogues.presence,
    ),
  };
}

function hasSameAssetViewerFilterState(current, resolved) {
  return ['categories', 'tags', 'extensions', 'presence'].every((key) => {
    const currentValue = current?.[key];
    const resolvedValue = resolved[key];

    if (!Array.isArray(currentValue) || !Array.isArray(resolvedValue)) {
      return currentValue === resolvedValue;
    }

    return currentValue.length === resolvedValue.length
      && currentValue.every((value) => resolvedValue.includes(value));
  });
}

function resolveAssetLibraryPresentation(parsed, pageDefaultsService) {
  const values = {};
  const presentation = {};

  for (const { key, option } of ASSET_LIBRARY_PRESENTATION_OPTIONS) {
    const parsedOption = parsed.presentation[key];
    const fallback = pageDefaultsService.getFallback(ASSET_VIEWER_PAGE_DEFAULTS, option);
    const savedValue = pageDefaultsService.resolve(ASSET_VIEWER_PAGE_DEFAULTS, option);

    const value = parsedOption.state === 'valid'
      ? parsedOption.value
      : parsedOption.state === 'omitted'
        ? normalizeSavedPresentationValue(key, savedValue)
        : normalizeSavedPresentationValue(key, fallback);

    values[key] = value;
    presentation[key] = {
      ...parsedOption,
      // An invalid explicit value resolves to the application fallback. When
      // a saved non-fallback exists, retain that choice in the canonical URL
      // so the redirected request cannot be mistaken for an omission.
      preserveFallback: parsedOption.state === 'invalid'
        && String(savedValue) !== String(fallback),
    };
  }

  return { values, presentation };
}

function buildAssetLibraryRenderModel(page, state, {
  nsfwFilterEnabled = false,
  assetViewerDefaults = null,
  assetViewerDefaultsDialogOpen = false,
  assetViewerNsfwError = null,
  assetViewerDefaultsNotice = null,
  assetViewerDefaultsAuthority = null,
  assetViewerDefaultsError = null,
} = {}) {
  const categoryFilterOptions = (page.categoryOptions || [])
    .filter((option) => option.value !== 'all');
  const categoryFilterSelectedValues = categoryFilterOptions
    .filter((option) => option.selected)
    .map((option) => option.value);
  const tagFilterSelectedValues = (page.tagOptions || [])
    .filter((option) => option.selected)
    .map((option) => option.value);
  const extensionFilterSelectedValues = (page.extensionOptions || [])
    .filter((option) => option.selected)
    .map((option) => option.value);
  // Normalized temporary Project / Project Type selections. These include
  // selected Project IDs that are absent from the active option list
  // (unknown or archived), which match no assets.
  const projectFilterSelectedValues = (page.filters?.projectIds || []).map(String);
  const projectTypeFilterSelectedValues = [...(page.filters?.projectTypes || [])];
  // WP9b: the Projects multi-select choices. Active Projects come from the
  // unpaged option catalogue; a selected ID missing from it (unknown,
  // deleted or archived) stays a checked, ID-labelled choice so the dialog
  // never silently drops the restriction or presents it as All projects.
  const activeProjectValues = new Set((page.projectOptions || []).map((project) => String(project.id)));
  const projectFilterOptions = [
    ...projectFilterSelectedValues
      .filter((value) => !activeProjectValues.has(value))
      .map((value) => ({
        value,
        label: `Unavailable project (ID ${value})`,
        selected: true,
        unavailable: true,
        classes: 'asset-library-project-option--unavailable',
        attributes: [['data-asset-library-unavailable-project', true]],
      })),
    ...(page.projectOptions || []).map((project) => ({
      value: String(project.id),
      label: project.title,
      selected: projectFilterSelectedValues.includes(String(project.id)),
    })),
  ];
  const projectFilterUnavailableValues = projectFilterOptions
    .filter((option) => option.unavailable)
    .map((option) => option.value);
  const canonicalState = {
    ...state,
    page: page.page,
    pageSize: page.pageSize,
  };
  const pageUrl = (overrides = {}) => buildAssetLibraryUrl(canonicalState, overrides);
  const currentUrl = buildAssetLibraryUrl(canonicalState);

  return {
    ...page,
    assets: page.assets.map((asset) => ({
      ...withNsfwBlur(asset, nsfwFilterEnabled),
      detailUrl: page.pageSize === 'all'
        ? `/projects/${asset.project_id}/assets/${asset.id}?pageSize=all`
        : `/projects/${asset.project_id}/assets/${asset.id}`,
    })),
    categoryFilterOptions,
    categoryFilterSelectedValues,
    tagFilterSelectedValues,
    extensionFilterSelectedValues,
    projectFilterSelectedValues,
    projectTypeFilterSelectedValues,
    projectFilterOptions,
    projectFilterUnavailableValues,
    projectTypeFilterOptions: (page.projectTypeOptions || []).map((option) => ({
      value: option.value,
      label: option.label,
      selected: projectTypeFilterSelectedValues.includes(option.value),
    })),
    searchMaxLength: ASSET_LIBRARY_SEARCH_MAX_LENGTH,
    canonicalUrl: currentUrl,
    currentUrl,
    pageUrl,
    preserveViewQuery: state.presentation?.view?.state === 'valid'
      || state.presentation?.view?.preserveFallback === true,
    orderOptions: buildOrderOptions(page.filters.order),
    pageSizeOptions: buildPageSizeOptions(page.pageSize),
    // Approved Milestone 2 contract: Reset filters restores the effective
    // saved/default View too, so the destination no longer carries the
    // current View.
    clearFiltersUrl: ASSET_VIEWER_RESET_FILTERS_URL,
    slideshowSequenceJson: JSON.stringify(page.slideshowSequence || []).replace(/<\//g, '<\\/'),
    nsfwFilterEnabled,
    assetViewerNsfwReturnUrl: currentUrl,
    assetViewerDefaults,
    assetViewerDefaultsDialogOpen,
    assetViewerDefaultsReturnUrl: currentUrl,
    assetViewerNsfwError,
    assetViewerDefaultsNotice,
    assetViewerDefaultsAuthority,
    assetViewerDefaultsAuthorityJson: assetViewerDefaultsAuthority
      ? serializeAuthorityJson(assetViewerDefaultsAuthority)
      : null,
    // The generation a native or legacy-autosave Save submits (hidden field).
    assetViewerDefaultsGeneration: assetViewerDefaultsAuthority?.generation ?? null,
    assetViewerDefaultsError,
  };
}

async function renderAssetLibraryPage(req, res, {
  appName,
  workflowQueryService,
  projectOptionPresentation = null,
  status = 200,
  assetViewerDefaultsDialogOpen = req.query?.defaults === '1',
  assetViewerDefaultsSubmittedValues = null,
  assetViewerDefaultsErrors = {},
  assetViewerNsfwError = null,
  assetViewerDefaultsError = null,
  assetViewerDefaultsNotice = resolveAssetViewerDefaultsNotice(req.query?.notice),
  allowSavedDefaultsRedirect = req.query?.defaults !== '1',
  rawQuery = null,
  resetFilters = false,
  next,
} = {}) {
  const pageDefaultsService = getPageDefaultsService(req);
  const nsfwFilterEnabled = getNsfwFilterSettingsService(req).isEnabled();
  // Reset filters resolves from an empty (bare) query: every default-backed
  // control takes its effective saved/default value, including View, and
  // Search, Projects, Project Types, Usage and the page clear.
  const query = resetFilters ? {} : rawQuery || req.query;
  const parsed = parseAssetLibraryQuery(query);
  const resolvedPresentation = resolveAssetLibraryPresentation(parsed, pageDefaultsService);
  const input = {
    projectIds: parsed.projectIds,
    projectTypes: parsed.projectTypes,
    categories: parsed.categories,
    tags: parsed.tags,
    search: parsed.search,
    extensions: parsed.extensions,
    presence: parsed.presence,
    usage: parsed.usage,
    ...resolvedPresentation.values,
    page: parsed.page,
  };
  const resolvedProjectOptionPresentation = projectOptionPresentation
    || workflowQueryService.buildAssetLibraryProjectOptionPresentation();
  const getAssetLibraryPage = () => workflowQueryService.getAssetLibraryPage(input, {
    projectOptionPresentation: resolvedProjectOptionPresentation,
    clockFormat: res.locals.clockFormat,
  });
  let page = getAssetLibraryPage();
  const optionCatalogues = buildAssetViewerOptionCatalogues(
    page,
    workflowQueryService.getAssetLibraryExtensions(),
  );

  if (resetFilters || isBareAssetLibraryRequest(query)) {
    const resolvedFilterDefaults = resolveAssetViewerFilterDefaults(pageDefaultsService, optionCatalogues);
    const defaultsChangedEffectiveQuery = !hasSameAssetViewerFilterState(
      page.filters,
      resolvedFilterDefaults,
    );
    Object.assign(input, resolvedFilterDefaults);
    if (defaultsChangedEffectiveQuery) page = getAssetLibraryPage();
  }

  const state = {
    ...input,
    projectIds: page.filters?.projectIds ?? input.projectIds,
    projectTypes: page.filters?.projectTypes ?? input.projectTypes,
    categories: page.filters?.categories ?? input.categories,
    tags: page.filters?.tags ?? input.tags,
    extensions: page.filters?.extensions ?? input.extensions,
    explicitNeutralFilters: getExplicitNeutralAssetLibraryFilters(query),
    presentation: resolvedPresentation.presentation,
  };
  const canonicalUrl = buildAssetLibraryUrl(state, { page: page.page });

  if (resetFilters || (allowSavedDefaultsRedirect && !assetViewerDefaultsNotice && getRequestUrl(req) !== canonicalUrl)) {
    return res.redirect(canonicalUrl);
  }

  if (page.presentation.view === 'grid') {
    page = {
      ...page,
      assets: await workflowQueryService.enrichAssetLibraryImageDimensions(page.assets),
    };
  }

  const assetViewerDefaults = buildPageDefaultsDialogModel({
    pageDefaultsService,
    page: ASSET_VIEWER_PAGE_DEFAULTS,
    labels: ASSET_VIEWER_DEFAULT_LABELS,
    submittedValues: assetViewerDefaultsSubmittedValues,
    errors: assetViewerDefaultsErrors,
    optionCatalogues,
  });

  const gridStyle = pageDefaultsService.resolve(ASSET_VIEWER_PAGE_DEFAULTS, 'gridStyle');
  const assetViewerDefaultsAuthority = buildAssetViewerDefaultsAuthority(pageDefaultsService, optionCatalogues, {
    current: buildAssetViewerCurrentDefaultsState(page, gridStyle),
    temporary: readTemporaryAssetLibraryContext({
      projectIds: state.projectIds,
      projectTypes: state.projectTypes,
      search: state.search,
      usage: state.usage,
    }),
    currentUrl: buildAssetLibraryUrl(state, { page: page.page }),
  });

  res.status(status).render('assets/index.njk', {
    appName,
    ...buildAssetLibraryRenderModel(page, state, {
      nsfwFilterEnabled,
      assetViewerDefaults,
      assetViewerDefaultsDialogOpen,
      assetViewerNsfwError,
      assetViewerDefaultsNotice,
      assetViewerDefaultsAuthority,
      assetViewerDefaultsError,
    }),
    gridStyle,
  });
}

export function createAssetLibraryRouter({ appName, db, workflowQueryService } = {}) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const resetFilters = Object.prototype.hasOwnProperty.call(req.query, 'resetFilters');
      if (resetFilters) {
        // WP9a: the Reset intent is validated on its own. A legacy scalar
        // `view` is still accepted on a Reset URL but never chooses the
        // destination; every other request key is discarded by the redirect.
        if (req.query.resetFilters !== '1'
          || (Object.prototype.hasOwnProperty.call(req.query, 'view')
            && (typeof req.query.view !== 'string' || !['grid', 'list'].includes(req.query.view)))) {
          const error = new Error('Invalid Asset Viewer Reset request.');
          error.status = 400;
          throw error;
        }
        res.set('Cache-Control', 'no-store');
      }
      await renderAssetLibraryPage(req, res, {
        appName,
        workflowQueryService,
        resetFilters,
        next,
      });
    } catch (err) {
      next(err);
    }
  });

  function buildReturnContextOptionCatalogues(req, parsedReturnQuery, projectOptionPresentation) {
    return buildAssetViewerOptionCatalogues(
      workflowQueryService.getAssetLibraryPage({
        projectIds: parsedReturnQuery.projectIds,
        projectTypes: parsedReturnQuery.projectTypes,
        categories: parsedReturnQuery.categories,
        tags: parsedReturnQuery.tags,
        search: parsedReturnQuery.search,
        extensions: parsedReturnQuery.extensions,
        presence: parsedReturnQuery.presence,
        usage: parsedReturnQuery.usage,
        ...resolveAssetLibraryPresentation(parsedReturnQuery, getPageDefaultsService(req)).values,
        page: parsedReturnQuery.page,
      }, { projectOptionPresentation }),
      workflowQueryService.getAssetLibraryExtensions(),
    );
  }

  // WP9a F6: a stale or missing generation. Nothing was written (the fence
  // threw inside the write transaction, which rolled back). JSON clients get
  // a correlated 409 with the current authority when it can be read; a native
  // form re-renders the page with the conflict, never a success redirect.
  function respondDefaultsConflict(req, res, next, {
    kind, mutation, err, enhanced, submittedValues = null, optionCatalogues = null,
  }) {
    if (enhanced) {
      let authority = null;
      try {
        authority = buildAssetViewerDefaultsAuthority(
          getPageDefaultsService(req),
          optionCatalogues || buildReturnContextOptionCatalogues(
            req, parseAssetLibraryQuery({}), workflowQueryService.buildAssetLibraryProjectOptionPresentation(),
          ),
        );
      } catch {
        authority = null;
      }
      res.status(409).json({
        ...defaultsOperationAcknowledgement(kind, mutation, {
          result: 'conflict', generation: err.currentGeneration,
        }),
        status: 'error',
        code: ASSET_VIEWER_DEFAULTS_CONFLICT_CODE,
        message: ASSET_VIEWER_DEFAULTS_CONFLICT_MESSAGE,
        ...(authority && authority.generation === err.currentGeneration ? { authority } : {}),
      });
      return;
    }
    void renderAssetLibraryPage(req, res, {
      appName,
      workflowQueryService,
      status: 409,
      assetViewerDefaultsDialogOpen: kind === 'save',
      assetViewerDefaultsSubmittedValues: submittedValues,
      assetViewerDefaultsError: ASSET_VIEWER_DEFAULTS_CONFLICT_MESSAGE,
      rawQuery: readAssetViewerReturnQuery(req),
      allowSavedDefaultsRedirect: false,
      next,
    }).catch(next);
  }

  // WP9a read-only authority: the current saved-state metadata for
  // reconciling an uncertain Save / Reset defaults outcome, or for reopening
  // the defaults dialog. It never writes. A non-JSON request (a typed URL)
  // opens the Asset Viewer with its defaults dialog instead.
  router.get('/defaults', (req, res, next) => {
    if (!isEnhancedRequest(req)) {
      res.redirect('/asset-viewer?defaults=1');
      return;
    }
    try {
      const projectOptionPresentation = workflowQueryService.buildAssetLibraryProjectOptionPresentation();
      const optionCatalogues = buildReturnContextOptionCatalogues(
        req, parseAssetLibraryQuery({}), projectOptionPresentation,
      );
      res.set('Cache-Control', 'no-store');
      res.json({
        status: 'success',
        authority: buildAssetViewerDefaultsAuthority(getPageDefaultsService(req), optionCatalogues),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/defaults', (req, res, next) => {
    const returnQuery = readAssetViewerReturnQuery(req);
    const parsedReturnQuery = parseAssetLibraryQuery(returnQuery);
    const projectOptionPresentation = workflowQueryService.buildAssetLibraryProjectOptionPresentation();
    const optionCatalogues = buildReturnContextOptionCatalogues(req, parsedReturnQuery, projectOptionPresentation);
    const mutation = readDefaultsMutationRequest(req);

    handlePageDefaultsPost(req, res, next, {
      db,
      pageDefaultsService: getPageDefaultsService(req),
      page: ASSET_VIEWER_PAGE_DEFAULTS,
      successMessage: ASSET_VIEWER_NOTICES.defaultsSaved,
      saveErrorMessage: 'Asset Viewer defaults could not be saved. No changes were made.',
      optionCatalogues,
      validateSubmission: () => ({ generation: null }),
      // WP9a F6: the generation fence runs inside the same transaction as the
      // nine writes; a stale generation throws before anything is written,
      // and any later failure rolls the generation back with the writes.
      saveValidatedValues: ({ validatedValues, submission }) => {
        const service = getPageDefaultsService(req);
        submission.generation = service.advanceMutationGeneration(
          ASSET_VIEWER_PAGE_DEFAULTS, mutation.expectedGeneration,
        );
        for (const option of ASSET_VIEWER_DEFAULT_FIELDS) {
          const optionCatalogue = optionCatalogues?.[option];
          if (optionCatalogue !== undefined) {
            service.saveDefault(ASSET_VIEWER_PAGE_DEFAULTS, option, validatedValues[option], optionCatalogue);
          } else {
            service.saveDefault(ASSET_VIEWER_PAGE_DEFAULTS, option, validatedValues[option]);
          }
        }
      },
      enhancedOperationPayload: ({ outcome, submission }) => defaultsOperationAcknowledgement('save', mutation, {
        result: outcome,
        generation: outcome === 'committed' ? submission?.generation ?? null : null,
      }),
      handleSaveError: ({ err, enhanced, submittedValues }) => {
        if (!(err instanceof PageDefaultsGenerationConflictError)) return false;
        respondDefaultsConflict(req, res, next, {
          kind: 'save', mutation, err, enhanced, submittedValues, optionCatalogues,
        });
        return true;
      },
      onValidationError: ({ submittedValues, errors }) => {
        void renderAssetLibraryPage(req, res, {
          appName,
          workflowQueryService,
          projectOptionPresentation,
          status: 422,
          assetViewerDefaultsDialogOpen: true,
          assetViewerDefaultsSubmittedValues: submittedValues,
          assetViewerDefaultsErrors: errors,
          rawQuery: readAssetViewerReturnQuery(req),
          allowSavedDefaultsRedirect: false,
          next,
        }).catch(next);
      },
      // WP9a: the JSON acknowledgement carries the post-commit authority so
      // the client can update saved status without a second request.
      enhancedSuccessPayload: () => ({
        authority: buildAssetViewerDefaultsAuthority(getPageDefaultsService(req), optionCatalogues),
      }),
      onSuccess: ({ validatedValues }) => {
        // Saved values are the new presentation and filters; the temporary
        // context (repeated Projects / Project Types, Search, Usage) of the
        // return URL is kept as it was and is never persisted.
        const defaultsUrl = buildAssetLibraryUrl({
          ...validatedValues,
          ...readTemporaryAssetLibraryContext(parsedReturnQuery),
          categories: normalizeAssetViewerDefaultSelection(validatedValues.category),
          tags: normalizeAssetViewerDefaultSelection(validatedValues.tag),
          extensions: normalizeAssetViewerDefaultSelection(validatedValues.extension),
        });
        res.redirect(`${defaultsUrl}${defaultsUrl.includes('?') ? '&' : '?'}notice=asset_viewer_defaults_saved`);
      },
    });
  });

  // WP9a Reset defaults: deletes only the allowlisted assetViewer keys (the
  // list comes from PAGE_DEFAULT_DEFINITIONS, never the request). Every other
  // page's defaults, Project Assets scoped defaults and app settings stay.
  // The refresh destination keeps the temporary filter context and lets every
  // default-backed control resolve to its application fallback, page 1.
  router.post('/defaults/reset', (req, res, next) => {
    const enhanced = isEnhancedRequest(req);
    const pageDefaultsService = getPageDefaultsService(req);
    const parsedReturnQuery = parseAssetLibraryQuery(readAssetViewerReturnQuery(req));
    const refreshUrl = buildAssetLibraryUrl(readTemporaryAssetLibraryContext(parsedReturnQuery));
    const mutation = readDefaultsMutationRequest(req);

    let reset;
    let generation = null;
    try {
      // WP9a F6: fence and deletion in one transaction. A no-op Reset (no
      // saved keys) still advances the generation, so an older request
      // prepared before it is rejected as stale.
      reset = db.transaction(() => {
        generation = pageDefaultsService.advanceMutationGeneration(
          ASSET_VIEWER_PAGE_DEFAULTS, mutation.expectedGeneration,
        );
        return pageDefaultsService.resetGlobalPageDefaults(ASSET_VIEWER_PAGE_DEFAULTS);
      })();
    } catch (err) {
      if (err instanceof PageDefaultsGenerationConflictError) {
        respondDefaultsConflict(req, res, next, { kind: 'resetDefaults', mutation, err, enhanced });
        return;
      }
      if (enhanced) {
        res.status(500).json({
          ...defaultsOperationAcknowledgement('resetDefaults', mutation, { result: 'failed' }),
          status: 'error',
          message: 'Asset Viewer defaults could not be reset. No changes were made.',
        });
        return;
      }
      next(err);
      return;
    }

    if (!enhanced) {
      res.redirect(refreshUrl);
      return;
    }

    try {
      const optionCatalogues = buildReturnContextOptionCatalogues(
        req, parseAssetLibraryQuery({}), workflowQueryService.buildAssetLibraryProjectOptionPresentation(),
      );
      res.json({
        ...defaultsOperationAcknowledgement('resetDefaults', mutation, { result: 'committed', generation }),
        status: 'success',
        message: ASSET_VIEWER_NOTICES.defaultsReset,
        reset,
        refreshUrl,
        authority: buildAssetViewerDefaultsAuthority(pageDefaultsService, optionCatalogues),
      });
    } catch {
      // The deletion committed; only the follow-up read failed. Say so rather
      // than claiming nothing changed, so the client never repeats it.
      res.status(500).json({
        ...defaultsOperationAcknowledgement('resetDefaults', mutation, { result: 'committed', generation }),
        status: 'error',
        committed: true,
        message: 'Asset Viewer defaults were reset, but the updated defaults could not be read. Reload the page.',
        reset,
        refreshUrl,
      });
    }
  });

  router.post('/nsfw-filter', (req, res, next) => {
    const enhanced = isEnhancedRequest(req);
    let enabled;

    try {
      enabled = parseEnabledField(req.body?.enabled, { fieldLabel: 'enabled' });
    } catch (err) {
      if (!(err instanceof AssetCategoryValidationError)) return next(err);

      if (enhanced) {
        res.status(422).json({
          status: 'error',
          errors: err.errors || {},
          message: 'NSFW filter setting is invalid.',
        });
        return;
      }

      void renderAssetLibraryPage(req, res, {
        appName,
        workflowQueryService,
        status: 422,
        assetViewerNsfwError: 'NSFW filter setting is invalid.',
        rawQuery: readAssetViewerReturnQuery(req),
        allowSavedDefaultsRedirect: false,
        next,
      }).catch(next);
      return;
    }

    try {
      getNsfwFilterSettingsService(req).setEnabled(enabled);
    } catch (err) {
      if (enhanced) {
        res.status(500).json({
          status: 'error',
          message: 'NSFW filter could not be updated. The previous setting was kept.',
        });
        return;
      }
      return next(err);
    }

    if (enhanced) {
      res.json({
        status: 'success',
        enabled,
        message: `NSFW filter ${enabled ? 'enabled' : 'disabled'}.`,
      });
      return;
    }

    res.redirect(readAssetViewerNsfwReturnUrl(req));
  });

  return router;
}

function readAssetViewerReturnQuery(req) {
  const returnTo = typeof req.body?.returnTo === 'string' ? req.body.returnTo : '';
  if (!returnTo || !returnTo.startsWith('/asset-viewer')) return {};
  try {
    const url = new URL(returnTo, 'http://localhost');
    // Mirror Express' query shape: a repeated key becomes an array so
    // multi-value filters (project, type, category, tag, extension) are not
    // collapsed to their last occurrence.
    return Object.fromEntries([...new Set(url.searchParams.keys())].map((key) => {
      const values = url.searchParams.getAll(key);
      return [key, values.length > 1 ? values : values[0]];
    }));
  } catch {
    return {};
  }
}
