import { NSFW_TAG_NAME } from '../services/nsfw-filter-settings-service.js';

import { buildProjectAssetBrowserPreferenceModel } from '../services/asset-browser-preference-presenter.js';

import { buildPageDefaultsDialogModel } from './page-defaults.js';

import { buildCanonicalAssetBrowserQuery, buildAssetBrowserQueryString } from '../services/workflow-query-service.js';

import { buildOpenLocallyUri } from '../util/open-locally.js';

const ASSET_BROWSER_QUERY_KEYS = ['category', 'tag', 'search', 'extension', 'presence', 'usage', 'sort', 'order', 'page', 'pageSize', 'view'];

export const ASSET_PAGE_DEFAULTS_PAGE = 'projectAssets';

const NSFW_TAG_NORMALIZED_NAME = NSFW_TAG_NAME.toLowerCase();

export const ASSET_PRESENTATION_OPTIONS = Object.freeze([
  Object.freeze({ key: 'view', option: 'view' }),
  Object.freeze({ key: 'sort', option: 'sort' }),
  Object.freeze({ key: 'order', option: 'order' }),
  Object.freeze({ key: 'pageSize', option: 'pageSize' }),
]);

// The complete set of hidden fields the browser filter, scan, and bulk forms round-trip.

export const ASSET_BROWSER_CONTEXT_FIELDS = ASSET_BROWSER_QUERY_KEYS;

const PROJECT_ASSETS_DEFAULT_VALUE_KEYS = Object.freeze([
  'view',
  'gridSize',
  'listSize',
  'sort',
  'order',
  'pageSize',
  'extension',
  'tag',
]);

const PROJECT_ASSETS_DEFAULT_LABELS = Object.freeze({
  fields: Object.freeze({
    view: 'View',
    gridSize: 'Grid size',
    listSize: 'List size',
    sort: 'Sort',
    order: 'Order',
    pageSize: 'Page Size',
    extension: 'Extension',
    tag: 'Tag',
  }),
  options: Object.freeze({
    view: Object.freeze({ grid: 'Grid', list: 'List' }),
    gridSize: Object.freeze({ compact: 'Compact', default: 'Default', large: 'Large' }),
    listSize: Object.freeze({ compact: 'Compact', large: 'Large' }),
    sort: Object.freeze({
      filename: 'Filename',
      modified: 'Modified date',
      size: 'File size',
      category: 'Category & location',
    }),
    order: Object.freeze({ asc: 'Ascending', desc: 'Descending' }),
    pageSize: Object.freeze({
      '10': '10 assets',
      '25': '25 assets',
      '50': '50 assets',
      '100': '100 assets',
    }),
  }),
});

function buildProjectAssetsDefaultValuesJson(globalDefaults, projectDefaults) {
  const values = { global: {}, project: {} };

  for (const key of PROJECT_ASSETS_DEFAULT_VALUE_KEYS) {
    values.global[key] = globalDefaults[key];
    values.project[key] = projectDefaults[key];
  }

  return JSON.stringify(values).replace(/</g, '\\u003c');
}

function normalizeProjectAssetsDefaultsScope(scope) {
  return scope === 'project' ? 'project' : 'global';
}

export function buildProjectAssetsDefaultOptionCatalogues(workflowQueryService) {
  const extensionValues = workflowQueryService?.getProjectAssetsDefaultExtensions?.() || [];
  const tags = workflowQueryService?.getProjectTagFilterOptions?.() || [];

  return {
    extension: [
      { value: 'all', label: 'All extensions' },
      ...extensionValues.map((value) => ({
        value,
        label: '.' + value,
      })),
    ],
    tag: [
      { value: 'all', label: 'All tags' },
      ...tags.map((tag) => ({
        value: tag.value,
        label: tag.displayName,
      })),
    ],
  };
}

export const PROJECT_ASSETS_NOTICES = Object.freeze({
  defaultsSaved: 'Project Assets defaults saved successfully.',
});

export const PROJECT_ASSET_CATEGORY_NOTICES = Object.freeze({
  category_added: { variant: 'success', text: 'Category added.' },
  category_name_updated: { variant: 'success', text: 'Display name updated.' },
  category_enabled: { variant: 'success', text: 'Category enabled.' },
  category_disabled: { variant: 'success', text: 'Category disabled. Its existing files were not touched.' },
  category_deleted: { variant: 'success', text: 'Category deleted.' },
  category_reordered: { variant: 'success', text: 'Category order updated.' },
  category_reorder_invalid: {
    variant: 'error',
    text: 'The submitted category order is invalid. Submit every project category exactly once.',
  },
  category_reorder_failed: { variant: 'error', text: 'Could not update the order. No changes were made.' },
  category_mutation_failed: { variant: 'error', text: 'Could not save the category. Please try again.' },
  category_archived: { variant: 'warning', text: 'This project is archived and cannot be modified.' },
  category_enable_failed: { variant: 'error', text: "Could not enable the category. Its directory may be inaccessible." },
  category_delete_disable_instead: {
    variant: 'error',
    text: 'This category still has assets or files. Disable it instead of deleting it.',
  },
  category_delete_failed: { variant: 'error', text: 'Could not delete the category. Please try again.' },
  project_default_saved: { variant: 'success', text: 'Project asset default saved.' },
});

export function parseId(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id < 1 || String(id) !== value) {
    return null;
  }
  return id;
}

export function resolveProjectAssetCategoryNotice(code) {
  return Object.prototype.hasOwnProperty.call(PROJECT_ASSET_CATEGORY_NOTICES, code)
    ? PROJECT_ASSET_CATEGORY_NOTICES[code]
    : null;
}

export function buildProjectAssetCategoryManagementModel({
  projectId,
  projectAssetCategoryService,
  assetBrowserPreferenceService,
  notice = null,
  addValues = { enabled: true },
  addErrors = {},
  nameEdit = null,
  preferenceSubmittedValue,
  preferenceError = null,
  enabledControl = null,
} = {}) {
  const categories = projectAssetCategoryService.list(projectId);
  const assetBrowserPreference = buildProjectAssetBrowserPreferenceModel({
    projectId,
    preferenceService: assetBrowserPreferenceService,
    categories,
    submittedValue: preferenceSubmittedValue,
    error: preferenceError,
  });

  return {
    categories,
    assetBrowserPreference,
    notice,
    addValues,
    addErrors,
    nameEdit,
    enabledControl,
  };
}

export function renderProjectAssetsPage(req, res, {
  appName,
  projectService,
  workflowQueryService,
  assetBrowserPreferenceService,
  projectAssetCategoryService,
  projectId = null,
  status = 200,
  rawQuery = null,
  projectAssetsDefaultsDialogOpen = req.query?.defaults === '1',
  removeMissingAssetsDialogOpen = req.query?.remove_missing === '1',
  projectAssetsDefaultsSubmittedValues = null,
  projectAssetsDefaultsErrors = {},
  projectAssetsDefaultsSelectedScope = null,
  projectAssetsNsfwError = null,
  autoRenameConfirmationDialogOpen = false,
  autoRenameConfirmationPlan = null,
  autoRenameConfirmationContext = null,
  autoRenameConfirmationReturnUrl = null,
  categoryManagementDialogOpen = req.query?.manage_categories === '1',
  categoryManagementNotice = null,
  categoryManagementAddValues = { enabled: true },
  categoryManagementAddErrors = {},
  categoryManagementNameEdit = null,
  categoryManagementPreferenceSubmittedValue,
  categoryManagementPreferenceError = null,
  categoryManagementEnabledControl = null,
  allowSavedDefaultsRedirect = true,
  next,
} = {}) {
  const id = projectId === null ? parseId(req.params.id) : projectId;
  if (id === null) return next ? next(createNotFound()) : null;

  const project = projectService.findById(id);
  if (!project) return next ? next(createNotFound()) : null;

  const pageDefaultsService = getPageDefaultsService(req);
  const projectAssetsDefaultOptionCatalogues = buildProjectAssetsDefaultOptionCatalogues(
    workflowQueryService,
  );
  const query = rawQuery && typeof rawQuery === 'object'
    ? rawQuery
    : (req.query && typeof req.query === 'object' ? req.query : {});
  const projectPageDefaultContext = { projectId: id };
  const projectAssetsScopedDefaults = resolveProjectAssetsScopedDefaults(
    pageDefaultsService,
    projectAssetsDefaultOptionCatalogues,
    projectPageDefaultContext,
  );
  const presentation = resolveAssetBrowserPresentation(
    query,
    pageDefaultsService,
    projectPageDefaultContext,
  );
  const filterDefaults = resolveProjectAssetsFilterDefaults(
    pageDefaultsService,
    projectAssetsDefaultOptionCatalogues,
    projectPageDefaultContext,
  );

  // Only a completely bare request may activate the existing category
  // preference redirect. All non-bare requests remain authoritative GETs.
  if (allowSavedDefaultsRedirect && isBareAssetBrowserRequest(query)) {
    const resolution = assetBrowserPreferenceService.resolveEffectiveCategory(id);
    const effective = resolution && resolution.effective;
    if (!effective || (effective.kind !== 'all' && effective.kind !== 'category')) {
      throw new Error('assetBrowserPreferenceService returned an invalid effective category resolution.');
    }
    if (effective.kind === 'category') {
      const categoryId = effective.category && effective.category.id;
      if (!Number.isSafeInteger(categoryId) || categoryId <= 0) {
        throw new Error('assetBrowserPreferenceService returned an invalid effective category ID.');
      }
      return res.redirect(buildAssetDefaultsRedirectUrl(
        id,
        categoryId,
        presentation,
        pageDefaultsService,
        filterDefaults,
      ));
    }

    if (
      hasNonFallbackAssetPresentation(presentation, pageDefaultsService)
      || hasNonNeutralProjectAssetsFilterDefaults(filterDefaults)
    ) {
      return res.redirect(buildAssetDefaultsRedirectUrl(
        id,
        null,
        presentation,
        pageDefaultsService,
        filterDefaults,
      ));
    }
  }

  const data = buildAssetBrowserPageData(workflowQueryService, id, project, presentation);
  if (!data) return next ? next(createNotFound()) : null;

  const nsfwFilterEnabled = getNsfwFilterSettingsService(req).isEnabled();
  const renderModel = buildBrowserRenderModel(
    project,
    data,
    pageDefaultsService,
    req,
    workflowQueryService,
    nsfwFilterEnabled,
  );
  const selectedProjectAssetsDefaultsScope = projectAssetsDefaultsSelectedScope === null
    ? normalizeProjectAssetsDefaultsScope(projectAssetsScopedDefaults.scope)
    : normalizeProjectAssetsDefaultsScope(projectAssetsDefaultsSelectedScope);
  const pageUrl = renderModel.pageUrl({});
  const defaultsUrl = appendQueryValue(pageUrl, 'defaults', '1');
  const queryNotice = buildProjectAssetsQueryNotice(query);
  const categoryManagement = buildProjectAssetCategoryManagementModel({
    projectId: id,
    projectAssetCategoryService,
    assetBrowserPreferenceService,
    notice: categoryManagementNotice || resolveProjectAssetCategoryNotice(query.notice),
    addValues: categoryManagementAddValues,
    addErrors: categoryManagementAddErrors,
    nameEdit: categoryManagementNameEdit,
    preferenceSubmittedValue: categoryManagementPreferenceSubmittedValue,
    preferenceError: categoryManagementPreferenceError,
    enabledControl: categoryManagementEnabledControl,
  });

  const assetActionNotice = query.notice === 'asset-renamed'
    ? { message: ASSET_ACTION_NOTICE_MESSAGES['asset-renamed'] }
    : null;
  const autoRenameNotice = query.notice === 'auto-rename-success'
    && isSmallNonNegativeInt(query.auto_rename_renamed)
    && isSmallNonNegativeInt(query.auto_rename_unchanged)
    ? {
      message: describeAutoRenameSuccess(
        Number(query.auto_rename_renamed),
        Number(query.auto_rename_unchanged),
      ),
    }
    : null;
  const bulkNotice = (isSmallNonNegativeInt(query.bulk_added) && isSmallNonNegativeInt(query.bulk_already))
    ? { added: Number(query.bulk_added), alreadyAssociated: Number(query.bulk_already) }
    : null;

  return res.status(status).render('projects/assets.njk', {
    appName,
    ...renderModel,
    query: queryNotice,
    categoryManagement,
    categories: categoryManagement.categories,
    assetBrowserPreference: categoryManagement.assetBrowserPreference,
    notice: categoryManagement.notice,
    addValues: categoryManagement.addValues,
    addErrors: categoryManagement.addErrors,
    nameEdit: categoryManagement.nameEdit,
    enabledControl: categoryManagement.enabledControl,
    categoryManagementDialogOpen: Boolean(categoryManagementDialogOpen),
    categoryManagementReturnUrl: pageUrl,
    categoryManagementDialogUrl: appendQueryValue(pageUrl, 'manage_categories', '1'),
    categoryManagementNotice: categoryManagement.notice,
    categoryManagementAddValues: categoryManagement.addValues,
    categoryManagementAddErrors: categoryManagement.addErrors,
    categoryManagementNameEdit: categoryManagement.nameEdit,
    categoryManagementEnabledControl: categoryManagement.enabledControl,
    projectAssetsDefaults: buildPageDefaultsDialogModel({
      pageDefaultsService,
      page: ASSET_PAGE_DEFAULTS_PAGE,
      labels: PROJECT_ASSETS_DEFAULT_LABELS,
      submittedValues: projectAssetsDefaultsSubmittedValues || projectAssetsScopedDefaults.effective,
      errors: projectAssetsDefaultsErrors,
      optionCatalogues: projectAssetsDefaultOptionCatalogues,
    }),
    projectAssetsDefaultsScope: projectAssetsScopedDefaults.scope,
    projectAssetsDefaultsSelectedScope: selectedProjectAssetsDefaultsScope,
    projectAssetsDefaultsLoadedScope: selectedProjectAssetsDefaultsScope,
    projectAssetsDefaultsErrors,
    projectAssetsGlobalDefaults: projectAssetsScopedDefaults.global,
    projectAssetsProjectDefaults: projectAssetsScopedDefaults.project,
    projectAssetsDefaultValuesJson: buildProjectAssetsDefaultValuesJson(
      projectAssetsScopedDefaults.global,
      projectAssetsScopedDefaults.project,
    ),
    projectAssetsEffectiveDefaults: projectAssetsScopedDefaults.effective,
    projectAssetsDefaultsDialogOpen: Boolean(projectAssetsDefaultsDialogOpen),
    removeMissingAssetsDialogOpen: Boolean(removeMissingAssetsDialogOpen),
    projectAssetsDefaultsReturnUrl: pageUrl,
    projectAssetsDefaultsUrl: defaultsUrl,
    removeMissingAssetsReturnUrl: pageUrl,
    removeMissingAssetsDialogUrl: appendQueryValue(pageUrl, 'remove_missing', '1'),
    projectAssetsDefaultsNotice: query.notice === 'project_assets_defaults_saved'
      ? { message: PROJECT_ASSETS_NOTICES.defaultsSaved }
      : null,
    nsfwFilterEnabled,
    projectAssetsNsfwReturnUrl: pageUrl,
    assetActionNotice,
    autoRenameNotice,
    bulkNotice,
    moveNotice: isSmallNonNegativeInt(query.assets_moved)
      ? { movedCount: Number(query.assets_moved) }
      : null,
    copyNotice: isSmallNonNegativeInt(query.assets_copied)
      ? { copiedCount: Number(query.assets_copied) }
      : null,
    deleteNotice: isSmallNonNegativeInt(query.assets_deleted)
      ? { deletedCount: Number(query.assets_deleted) }
      : null,
    error: query.scan_error === 'filesystem',
    archivedError: query.scan_error === 'archived',
    projectAssetsNsfwError,
    autoRenameConfirmationDialogOpen: Boolean(autoRenameConfirmationDialogOpen),
    autoRenameConfirmationPlan,
    autoRenameConfirmationContext,
    autoRenameConfirmationReturnUrl: autoRenameConfirmationReturnUrl || pageUrl,
  });
}

function buildProjectAssetsQueryNotice(query) {
  const safeQuery = query && typeof query === 'object' ? query : {};
  const result = {};
  if (safeQuery.scan_result === 'ok' && isSmallNonNegativeInt(safeQuery.total)) {
    result.scan_result = 'ok';
    result.added = isSmallNonNegativeInt(safeQuery.added) ? safeQuery.added : '0';
    result.updated = isSmallNonNegativeInt(safeQuery.updated) ? safeQuery.updated : '0';
    result.missing = isSmallNonNegativeInt(safeQuery.missing) ? safeQuery.missing : '0';
    result.total = safeQuery.total;
  }
  if (
    safeQuery.missing_cleanup === 'ok'
    && isSmallNonNegativeInt(safeQuery.missing_removed)
    && isSmallNonNegativeInt(safeQuery.missing_protected)
    && isSmallNonNegativeInt(safeQuery.missing_candidates)
  ) {
    result.missing_cleanup = 'ok';
    result.missing_removed = safeQuery.missing_removed;
    result.missing_protected = safeQuery.missing_protected;
    result.missing_candidates = safeQuery.missing_candidates;
  }
  return result;
}

function appendQueryValue(pathname, key, value) {
  const url = new URL(pathname, 'http://creatorcrate.local');
  url.searchParams.set(key, value);
  return `${url.pathname}?${url.searchParams.toString()}`;
}

export function getNsfwFilterSettingsService(req) {
  const service = req.app?.locals?.nsfwFilterSettingsService;
  if (!service) {
    throw new Error('Project Assets requires app.locals.nsfwFilterSettingsService.');
  }
  return service;
}

function isNsfwTag(tag) {
  return [tag?.displayName, tag?.display_name, tag?.normalizedName, tag?.normalized_name].some((value) => (
    typeof value === 'string' && value.trim().toLowerCase() === NSFW_TAG_NORMALIZED_NAME
  ));
}

export function getPageDefaultsService(req) {
  const service = req.app?.locals?.pageDefaultsService;
  if (!service) {
    throw new Error('Project Assets requires app.locals.pageDefaultsService.');
  }
  return service;
}

export function getOpenLocallySettingsService(req) {
  const service = req.app?.locals?.openLocallySettingsService;
  if (!service) {
    throw new Error('Assets routes require app.locals.openLocallySettingsService.');
  }
  return service;
}

function isBareAssetBrowserRequest(query) {
  return Boolean(query && typeof query === 'object' && Object.keys(query).length === 0);
}

function parseAssetBrowserPageSize(value, fallback) {
  if (value === undefined || value === null) return Number(fallback);
  const normalized = String(value);
  if (!/^[1-9]\d*$/.test(normalized)) return Number(fallback);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return Number(fallback);
  return Math.min(parsed, 100);
}

export function resolveAssetBrowserPresentation(rawQuery, pageDefaultsService, context = undefined) {
  const safeRawQuery = rawQuery && typeof rawQuery === 'object' ? rawQuery : {};
  const query = { ...safeRawQuery };
  const saved = {};
  const forceFallback = {};

  for (const { key, option } of ASSET_PRESENTATION_OPTIONS) {
    const fallback = pageDefaultsService.getFallback(ASSET_PAGE_DEFAULTS_PAGE, option);
    const savedValue = pageDefaultsService.resolve(ASSET_PAGE_DEFAULTS_PAGE, option, undefined, undefined, context);
    const isExplicit = Object.hasOwn(safeRawQuery, key);
    const explicitValue = safeRawQuery[key];
    const resolvedValue = key === 'pageSize'
      ? (isExplicit
        ? parseAssetBrowserPageSize(explicitValue, fallback)
        : Number(savedValue))
      : (isExplicit
        ? pageDefaultsService.resolve(
          ASSET_PAGE_DEFAULTS_PAGE,
          option,
          explicitValue,
          undefined,
          context,
        )
        : savedValue);

    saved[key] = savedValue;
    forceFallback[key] = isExplicit
      && String(resolvedValue) === String(fallback)
      && String(savedValue) !== String(fallback);

    if (!isExplicit && String(savedValue) !== String(fallback)) {
      query[key] = String(savedValue);
    }
  }

  return {
    query,
    saved,
    forceFallback,
  };
}

function hasNonFallbackAssetPresentation(presentation, pageDefaultsService) {
  return ASSET_PRESENTATION_OPTIONS.some(({ key, option }) => (
    String(presentation.saved[key]) !== String(pageDefaultsService.getFallback(ASSET_PAGE_DEFAULTS_PAGE, option))
  ));
}

function resolveProjectAssetsScopedDefaults(pageDefaultsService, optionCatalogues, context) {
  return {
    scope: pageDefaultsService.getPageDefaultScope(ASSET_PAGE_DEFAULTS_PAGE, context),
    global: pageDefaultsService.resolveGlobalPageDefaults(
      ASSET_PAGE_DEFAULTS_PAGE,
      optionCatalogues,
    ),
    project: pageDefaultsService.resolveProjectPageDefaults(
      ASSET_PAGE_DEFAULTS_PAGE,
      optionCatalogues,
      context,
    ),
    effective: pageDefaultsService.resolvePageDefaults(
      ASSET_PAGE_DEFAULTS_PAGE,
      {},
      optionCatalogues,
      context,
    ),
  };
}

function resolveProjectAssetsFilterDefaults(pageDefaultsService, optionCatalogues, context) {
  return {
    extension: pageDefaultsService.resolve(
      ASSET_PAGE_DEFAULTS_PAGE,
      'extension',
      undefined,
      optionCatalogues.extension,
      context,
    ),
    tag: pageDefaultsService.resolve(
      ASSET_PAGE_DEFAULTS_PAGE,
      'tag',
      undefined,
      optionCatalogues.tag,
      context,
    ),
  };
}

function hasNonNeutralProjectAssetsFilterDefaults(filterDefaults) {
  return filterDefaults.extension !== 'all' || filterDefaults.tag !== 'all';
}

function buildAssetDefaultsRedirectUrl(
  projectId,
  categoryId,
  presentation,
  pageDefaultsService,
  filterDefaults,
) {
  const context = {
    category: categoryId === null ? 'all' : String(categoryId),
    categoryWasSupplied: categoryId !== null,
    categorySelection: categoryId === null ? undefined : 'explicit-specific',
    queryWasNonBare: false,
    tag: filterDefaults.tag === 'all' ? undefined : filterDefaults.tag,
    extension: filterDefaults.extension === 'all' ? undefined : filterDefaults.extension,
    sort: presentation.saved.sort,
    order: presentation.saved.order,
    page: 1,
    pageSize: presentation.saved.pageSize,
    view: presentation.saved.view,
  };
  const query = buildCanonicalAssetBrowserQuery(context, 1);
  appendForcedAssetPresentationQuery(
    query,
    context,
    presentation,
    {},
    pageDefaultsService,
    { projectId },
  );
  const search = buildAssetBrowserQueryString(query);
  return search ? `/projects/${projectId}/assets?${search}` : `/projects/${projectId}/assets`;
}

function appendForcedAssetPresentationQuery(
  query,
  context,
  presentation,
  overrides,
  pageDefaultsService,
  pageDefaultContext = undefined,
) {
  if (!pageDefaultsService) return;

  const metadata = presentation || context?.assetPresentation || {};
  const rawOverrides = overrides && typeof overrides === 'object' ? overrides : {};

  for (const { key, option } of ASSET_PRESENTATION_OPTIONS) {
    const fallback = pageDefaultsService.getFallback(ASSET_PAGE_DEFAULTS_PAGE, option);
    const saved = metadata.saved?.[key] ?? pageDefaultsService.resolve(
      ASSET_PAGE_DEFAULTS_PAGE,
      option,
      undefined,
      undefined,
      pageDefaultContext,
    );
    const hasOverride = Object.hasOwn(rawOverrides, key);
    const value = hasOverride ? rawOverrides[key] : context?.[key];
    const shouldPreserveExplicitFallback = metadata.forceFallback?.[key] === true;
    const shouldPreserveOverride = hasOverride;

    if ((!shouldPreserveExplicitFallback && !shouldPreserveOverride)
      || value === undefined
      || value === null
      || value === '') {
      continue;
    }

    if (String(value) === String(fallback) && String(saved) !== String(fallback)) {
      query[key] = String(value);
    }
  }
}

function buildAssetsPageUrl(projectId, allowedParams, pageDefaultsService) {
  const basePath = `/projects/${projectId}/assets`;
  return function pageUrl(overrides = {}) {
    const query = buildCanonicalAssetBrowserQuery(allowedParams, allowedParams.page, overrides);
    appendForcedAssetPresentationQuery(
      query,
      allowedParams,
      allowedParams.assetPresentation,
      overrides,
      pageDefaultsService,
      { projectId },
    );
    const search = buildAssetBrowserQueryString(query);
    return search ? `${basePath}?${search}` : basePath;
  };
}

export function buildBrowserRenderModel(
  project,
  data,
  pageDefaultsService,
  req,
  workflowQueryService = null,
  nsfwFilterEnabled = null,
) {
  const projectAssetsDefaultOptionCatalogues = buildProjectAssetsDefaultOptionCatalogues(
    workflowQueryService,
  );
  const effectiveNsfwFilterEnabled = nsfwFilterEnabled === null
    ? Boolean(req?.app?.locals?.nsfwFilterSettingsService?.isEnabled?.())
    : nsfwFilterEnabled;
  const projectAssetsScopedDefaults = resolveProjectAssetsScopedDefaults(
    pageDefaultsService,
    projectAssetsDefaultOptionCatalogues,
    { projectId: project.id },
  );
  const projectAssetsGridSizeDefault = projectAssetsScopedDefaults.effective.gridSize;
  const projectAssetsListSizeDefault = projectAssetsScopedDefaults.effective.listSize;
  const context = {
    ...(data.context || data.filters),
    page: data.page,
    pageSize: data.pageSize,
  };
  const presentation = context.assetPresentation || null;
  const pageUrl = buildAssetsPageUrl(project.id, context, pageDefaultsService);
  const defaultsUrl = appendQueryValue(pageUrl({}), 'defaults', '1');

  return {
    project,
    openLocallyUri: buildOpenLocallyUri({
      windowsRoot: req ? getOpenLocallySettingsService(req).getWindowsProjectsPath() : null,
      projectDir: project.project_dir,
      // When filtered to one concrete category, open that category's folder.
      categoryDir: data.activeCategoryDirectorySlug || null,
    }),
    assets: data.assets.map((asset) => ({
      ...asset,
      nsfwBlur: Boolean(effectiveNsfwFilterEnabled && Array.isArray(asset.tags) && asset.tags.some(isNsfwTag)),
    })),
    total: data.total,
    page: data.page,
    pageSize: data.pageSize,
    pageCount: data.pageCount,
    filters: data.filters,
    extensionChoices: data.extensionChoices,
    tagOptions: data.tagOptions || [],
    categoryNavigation: data.categoryNavigation,
    categoryFilterOptions: buildProjectAssetCategoryFilterOptions(data.categoryNavigation, data.filters),
    emptyState: data.emptyState,
    isArchived: data.isArchived,
    releaseTargets: data.releaseTargets,
    releaseActionOptions: (data.releaseTargets || []).map((target) => ({
      value: String(target.id),
      label: target.title,
    })),
    destinationCategoryActionOptions: [
      { value: 'uncategorized', label: 'Uncategorized' },
      ...(data.categoryNavigation?.enabled || []).map((category) => ({
        value: String(category.id),
        label: category.displayName,
      })),
    ],
    processingCategoryOptions: [
      ...(data.categoryNavigation?.enabled || []).map((category) => ({
        value: String(category.id),
        label: `${category.displayName} (${category.assetCount || 0})`,
        selected: String(data.filters?.category || '') === String(category.id),
      })),
      ...(data.categoryNavigation?.disabled || []).map((category) => ({
        value: String(category.id),
        label: `${category.displayName} (${category.assetCount || 0}) (disabled)`,
        selected: String(data.filters?.category || '') === String(category.id),
      })),
    ],
    processingOutputCategoryOptions: (data.categoryNavigation?.enabled || []).map((category) => ({
      value: category.directorySlug,
      label: category.displayName,
    })),
    searchMaxLength: data.searchMaxLength,
    bulkError: null,
    bulkMoveError: null,
    copyError: null,
    deleteError: null,
    moveNotice: null,
    copyNotice: null,
    deleteNotice: null,
    assetActionNotice: null,
    autoRenameNotice: null,
    autoRenameError: null,
    completeCategorySurface: Boolean(data.completeCategorySurface),
    autoRenameSurface: Boolean(data.autoRenameSurface),
    autoRenameCategory: data.autoRenameCategory || null,
    autoRenameConfirmationDialogOpen: false,
    autoRenameConfirmationPlan: null,
    autoRenameConfirmationContext: null,
    autoRenameConfirmationReturnUrl: pageUrl({}),
    renameFailure: null,
    submittedSelectedAssetIds: [],
    submittedReleaseId: null,
    submittedDestinationCategory: null,
    preserveViewQuery: Boolean(presentation?.forceFallback?.view),
    preserveSortQuery: Boolean(presentation?.forceFallback?.sort),
    preserveOrderQuery: Boolean(presentation?.forceFallback?.order),
    preservePageSizeQuery: Boolean(presentation?.forceFallback?.pageSize),
    // Flat context + field allowlist so the scan and bulk-add forms can
    // render their hidden context-preservation fields with one loop instead
    // of hardcoding each key.
    context,
    contextFields: data.contextFields || ASSET_BROWSER_CONTEXT_FIELDS,
    pageUrl,
    projectAssetsDefaults: buildPageDefaultsDialogModel({
      pageDefaultsService,
      page: ASSET_PAGE_DEFAULTS_PAGE,
      labels: PROJECT_ASSETS_DEFAULT_LABELS,
      submittedValues: projectAssetsScopedDefaults.effective,
      optionCatalogues: projectAssetsDefaultOptionCatalogues,
    }),
    projectAssetsDefaultsScope: projectAssetsScopedDefaults.scope,
    projectAssetsDefaultsSelectedScope: normalizeProjectAssetsDefaultsScope(projectAssetsScopedDefaults.scope),
    projectAssetsDefaultsLoadedScope: normalizeProjectAssetsDefaultsScope(projectAssetsScopedDefaults.scope),
    projectAssetsGlobalDefaults: projectAssetsScopedDefaults.global,
    projectAssetsProjectDefaults: projectAssetsScopedDefaults.project,
    projectAssetsDefaultValuesJson: buildProjectAssetsDefaultValuesJson(
      projectAssetsScopedDefaults.global,
      projectAssetsScopedDefaults.project,
    ),
    projectAssetsEffectiveDefaults: projectAssetsScopedDefaults.effective,
    projectAssetsGridSizeDefault,
    projectAssetsListSizeDefault,
    projectAssetsDefaultsDialogOpen: false,
    projectAssetsDefaultsReturnUrl: pageUrl({}),
    projectAssetsDefaultsUrl: defaultsUrl,
    removeMissingAssetsDialogOpen: false,
    removeMissingAssetsReturnUrl: pageUrl({}),
    removeMissingAssetsDialogUrl: appendQueryValue(pageUrl({}), 'remove_missing', '1'),
    projectAssetsDefaultsNotice: null,
    nsfwFilterEnabled: effectiveNsfwFilterEnabled,
    projectAssetsNsfwReturnUrl: pageUrl({}),
    projectAssetsNsfwError: null,
    slideshowSequenceJson: JSON.stringify(data.slideshowSequence || []).replace(/<\//g, '<\\/'),
  };
}

export function buildAssetBrowserPageData(
  workflowQueryService,
  projectId,
  project,
  presentation,
) {
  const data = buildAssetsPageData(workflowQueryService, projectId, project, presentation.query);
  if (!data) return data;

  return {
    ...data,
    context: {
      ...(data.context || data.filters),
      assetPresentation: presentation,
    },
  };
}

export function buildCanonicalContextQuery(
  workflowQueryService,
  projectId,
  rawContext,
  extraQuery = {},
  pageDefaultsService = null,
) {
  const presentation = pageDefaultsService
    ? resolveAssetBrowserPresentation(rawContext, pageDefaultsService, { projectId })
    : null;
  const normalizedRawContext = presentation ? presentation.query : rawContext;
  const contextResult = workflowQueryService.getProjectAssetBrowserContext(projectId, normalizedRawContext);
  const context = contextResult
    ? (contextResult.context || contextResult.filters)
    : {
      search: null,
      extension: null,
      presence: 'all',
      usage: 'all',
      category: 'all',
      categorySelection: 'invalid-as-all',
      categoryWasSupplied: true,
      sort: 'filename',
      order: 'asc',
      page: 1,
      pageSize: 25,
      view: 'grid',
      queryWasNonBare: true,
    };

  const query = buildCanonicalAssetBrowserQuery(context, context.page);
  appendForcedAssetPresentationQuery(
    query,
    context,
    presentation,
    {},
    pageDefaultsService,
    { projectId },
  );
  for (const [key, value] of Object.entries(extraQuery)) {
    if (value === undefined || value === null || value === '') continue;
    query[key] = String(value);
  }
  return query;
}

export function buildAssetsRedirectUrl(
  workflowQueryService,
  projectId,
  rawContext,
  extraQuery = {},
  pageDefaultsService = null,
) {
  const query = buildCanonicalContextQuery(
    workflowQueryService,
    projectId,
    rawContext,
    extraQuery,
    pageDefaultsService,
  );
  const search = buildAssetBrowserQueryString(query);
  return search ? `/projects/${projectId}/assets?${search}` : `/projects/${projectId}/assets`;
}

export function parseCanonicalPositiveId(raw) {
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isSmallNonNegativeInt(value) {
  return typeof value === 'string' && /^\d{1,7}$/.test(value);
}

function buildAssetsPageData(workflowQueryService, projectId, project, rawQuery = {}) {
  const hasExplicitCategory = Object.prototype.hasOwnProperty.call(rawQuery || {}, 'category');
  const hasTagQuery = Object.prototype.hasOwnProperty.call(rawQuery || {}, 'tag');
  const hasConcreteCategory = parseCanonicalPositiveId(rawQuery.category) !== null;
  if (
    hasTagQuery
    || (hasConcreteCategory && hasNonDefaultCategoryBrowserControls(rawQuery))
    || (hasExplicitCategory && (
      rawQuery.category === 'all'
      || rawQuery.category === 'uncategorized'
      || parseCanonicalPositiveId(rawQuery.category) === null
    ))
  ) {
    const ordinary = workflowQueryService.getProjectAssetBrowser(projectId, rawQuery);
    return ordinary
      ? { ...ordinary, completeCategorySurface: false, autoRenameSurface: false, autoRenameCategory: null }
      : ordinary;
  }

  const categorySurface = workflowQueryService.getProjectAutoRenameCategory(projectId, rawQuery);
  const category = categorySurface?.effectiveCategory;
  const canRenderCompleteCategory = Boolean(category && !project.archived_at && categorySurface);

  if (!canRenderCompleteCategory) {
    const ordinary = workflowQueryService.getProjectAssetBrowser(projectId, rawQuery);
    return ordinary
      ? { ...ordinary, completeCategorySurface: false, autoRenameSurface: false, autoRenameCategory: null }
      : ordinary;
  }

  const safeCategoryQuery = {
    category: String(category.id),
    view: categorySurface.view,
  };
  const shell = workflowQueryService.getProjectAssetBrowser(projectId, safeCategoryQuery);
  if (!shell) return shell;

  const completeContext = {
    category: String(category.id),
    view: categorySurface.view,
  };
  const autoRenameAvailable = categorySurface.total > 0;

  return {
    ...shell,
    assets: categorySurface.assets,
    total: categorySurface.total,
    page: 1,
    pageSize: shell.pageSize,
    pageCount: 1,
    filters: {
      ...shell.filters,
      search: null,
      extension: null,
      presence: 'all',
      usage: 'all',
      sort: 'filename',
      order: 'asc',
      category: category.id,
      view: categorySurface.view,
    },
    context: completeContext,
    contextFields: ['category', 'view'],
    emptyState: categorySurface.total > 0 ? null : shell.emptyState,
    completeCategorySurface: true,
    autoRenameSurface: autoRenameAvailable,
    autoRenameCategory: autoRenameAvailable
      ? {
        ...categorySurface,
        categoryId: category.id,
        displayName: category.displayName,
        directorySlug: category.directorySlug,
        orderedAssetIdsJson: JSON.stringify(categorySurface.orderedAssetIds),
      }
      : null,
  };
}

function buildProjectAssetCategoryFilterOptions(categoryNavigation, filters) {
  const navigation = categoryNavigation || {};
  const selectedCategory = String(filters?.category ?? 'all');
  const selectedPresence = String(filters?.presence ?? 'all');
  const option = ({ id, value, label, presence = 'all', selected, suffix = null }) => ({
    id,
    value: String(value),
    label,
    selected,
    suffix,
    suffixClass: suffix ? 'asset-category-disabled-marker' : null,
    attributes: [['data-asset-category-presence', presence]],
  });

  return [
    option({
      id: 'asset-category-option-all',
      value: 'all',
      label: `All categories (${navigation.totalCount || 0})`,
      selected: selectedCategory === 'all' && selectedPresence !== 'missing',
    }),
    option({
      id: 'asset-category-option-uncategorized',
      value: 'uncategorized',
      label: `Uncategorized (${navigation.uncategorizedCount || 0})`,
      selected: selectedCategory === 'uncategorized',
    }),
    ...(navigation.enabled || []).map((category) => option({
      id: `asset-category-option-${category.id}`,
      value: category.id,
      label: `${category.displayName} (${category.assetCount || 0})`,
      selected: selectedCategory === String(category.id),
    })),
    ...(navigation.disabled || []).map((category) => option({
      id: `asset-category-option-${category.id}`,
      value: category.id,
      label: `${category.displayName} (${category.assetCount || 0})`,
      selected: selectedCategory === String(category.id),
      suffix: '(disabled)',
    })),
    option({
      id: 'asset-category-option-missing',
      value: 'all',
      label: `Missing (${navigation.missingCount || 0})`,
      presence: 'missing',
      selected: selectedCategory === 'all' && selectedPresence === 'missing',
    }),
  ];
}

function hasNonDefaultCategoryBrowserControls(rawQuery = {}) {
  return (
    (typeof rawQuery.search === 'string' && rawQuery.search.trim() !== '')
    || (typeof rawQuery.extension === 'string' && rawQuery.extension.trim() !== '')
    || rawQuery.presence === 'present'
    || rawQuery.presence === 'missing'
    || rawQuery.usage === 'used'
    || rawQuery.usage === 'unused'
    || rawQuery.sort === 'modified'
    || rawQuery.sort === 'size'
    || rawQuery.sort === 'category'
    || rawQuery.order === 'desc'
  );
}

export function createNotFound() {
  const err = new Error('Not found');
  err.status = 404;
  return err;
}

export const ASSET_ACTION_NOTICE_MESSAGES = {
  'asset-renamed': 'The file was renamed.',
  'asset-moved': 'The file was moved.',
  'primary-image-set': 'The primary image was set.',
  'primary-image-removed': 'The primary image was removed.',
  asset_tags_updated: 'Asset tags updated successfully.',
};

function describeAutoRenameSuccess(renamed, unchanged) {
  const renamedLabel = `asset${renamed === 1 ? '' : 's'}`;
  const unchangedLabel = `asset${unchanged === 1 ? '' : 's'}`;
  return `Renamed ${renamed} ${renamedLabel}. Skipped ${unchanged} unchanged ${unchangedLabel}.`;
}


export function isEnhancedAssetRequest(req) {
  return String(req.get?.('Accept') || '').toLowerCase().includes('application/json');
}

export function readProjectAssetsReturnUrl(req, projectId) {
  const candidate = typeof req.body?.returnTo === 'string' ? req.body.returnTo : '';
  const fallback = `/projects/${projectId}/assets`;
  if (!candidate.startsWith(`/projects/${projectId}/assets`) || candidate.startsWith('//')) return fallback;

  try {
    const url = new URL(candidate, 'http://creatorcrate.local');
    if (url.pathname !== `/projects/${projectId}/assets`) return fallback;
    url.hash = '';
    return `${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
}

export function readProjectAssetsReturnQuery(req, projectId) {
  const url = new URL(readProjectAssetsReturnUrl(req, projectId), 'http://creatorcrate.local');
  const query = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (Object.hasOwn(query, key)) {
      query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
    } else {
      query[key] = value;
    }
  }
  return query;
}
