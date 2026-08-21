import express from 'express';
import {
  ASSET_LIBRARY_PAGE_SIZE_VALUES,
  buildAssetLibraryUrl,
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
    sort: 'Sort',
    order: 'Order',
    pageSize: 'Page size',
  }),
  options: Object.freeze({
    view: Object.freeze({ grid: 'Grid', list: 'List' }),
    sort: Object.freeze({
      filename: 'Filename',
      modified: 'Modified',
      size: 'Size',
      category: 'Category',
      project: 'Project',
    }),
    order: Object.freeze({ asc: 'Ascending', desc: 'Descending' }),
    pageSize: Object.freeze(Object.fromEntries(ASSET_LIBRARY_PAGE_SIZE_VALUES.map((v) => [String(v), String(v)]))),
  }),
});

const ASSET_VIEWER_NOTICES = Object.freeze({
  defaultsSaved: 'Asset Viewer defaults saved successfully.',
});

function resolveAssetViewerDefaultsNotice(value) {
  return value === 'asset_viewer_defaults_saved' ? ASSET_VIEWER_NOTICES.defaultsSaved : null;
}

function buildPageSizeOptions(selectedValue) {
  return ASSET_LIBRARY_PAGE_SIZE_VALUES.map((value) => ({
    value,
    label: String(value),
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
  if (candidate && candidate.startsWith('/assets')) return candidate;
  return '/assets';
}

function readAssetViewerNsfwReturnUrl(req) {
  const candidate = typeof req.body?.returnTo === 'string' ? req.body.returnTo : '';
  if (candidate && candidate.startsWith('/assets')) return candidate;
  return '/assets';
}

function normalizeSavedPresentationValue(key, value) {
  return key === 'pageSize' ? Number(value) : value;
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
  const canonicalState = {
    ...state,
    page: page.page,
    pageSize: page.pageSize,
  };
  const pageUrl = (overrides = {}) => buildAssetLibraryUrl(canonicalState, overrides);
  const currentUrl = buildAssetLibraryUrl(canonicalState);

  return {
    ...page,
    assets: page.assets.map((asset) => withNsfwBlur(asset, nsfwFilterEnabled)),
    categoryFilterOptions,
    categoryFilterSelectedValues,
    tagFilterSelectedValues,
    extensionFilterSelectedValues,
    canonicalUrl: currentUrl,
    currentUrl,
    pageUrl,
    preserveViewQuery: state.presentation?.view?.state === 'valid'
      || state.presentation?.view?.preserveFallback === true,
    orderOptions: buildOrderOptions(page.filters.order),
    pageSizeOptions: buildPageSizeOptions(page.pageSize),
    clearFiltersUrl: buildAssetLibraryUrl({}, { view: state.view }),
    slideshowSequenceJson: JSON.stringify(page.slideshowSequence || []).replace(/<\//g, '<\\/'),
    nsfwFilterEnabled,
    assetViewerNsfwReturnUrl: currentUrl,
    assetViewerDefaults,
    assetViewerDefaultsDialogOpen,
    assetViewerDefaultsReturnUrl: currentUrl,
    assetViewerNsfwError,
    assetViewerDefaultsNotice,
  };
}

function renderAssetLibraryPage(req, res, {
  appName,
  workflowQueryService,
  status = 200,
  assetViewerDefaultsDialogOpen = req.query?.defaults === '1',
  assetViewerDefaultsSubmittedValues = null,
  assetViewerDefaultsErrors = {},
  assetViewerNsfwError = null,
  assetViewerDefaultsNotice = resolveAssetViewerDefaultsNotice(req.query?.notice),
  allowSavedDefaultsRedirect = req.query?.defaults !== '1',
  rawQuery = null,
  next,
} = {}) {
  const pageDefaultsService = getPageDefaultsService(req);
  const nsfwFilterEnabled = getNsfwFilterSettingsService(req).isEnabled();
  const query = rawQuery || req.query;
  const parsed = parseAssetLibraryQuery(query);
  const resolvedPresentation = resolveAssetLibraryPresentation(parsed, pageDefaultsService);
  const input = {
    projectId: parsed.projectId,
    categories: parsed.categories,
    tags: parsed.tags,
    search: parsed.search,
    extensions: parsed.extensions,
    presence: parsed.presence,
    usage: parsed.usage,
    ...resolvedPresentation.values,
    page: parsed.page,
  };
  const page = workflowQueryService.getAssetLibraryPage(input);
  const state = {
    ...input,
    categories: page.filters?.categories ?? input.categories,
    tags: page.filters?.tags ?? input.tags,
    extensions: page.filters?.extensions ?? input.extensions,
    presentation: resolvedPresentation.presentation,
  };
  const canonicalUrl = buildAssetLibraryUrl(state, { page: page.page });

  if (allowSavedDefaultsRedirect && !assetViewerDefaultsNotice && getRequestUrl(req) !== canonicalUrl) {
    return res.redirect(canonicalUrl);
  }

  const assetViewerDefaults = buildPageDefaultsDialogModel({
    pageDefaultsService,
    page: ASSET_VIEWER_PAGE_DEFAULTS,
    labels: ASSET_VIEWER_DEFAULT_LABELS,
    submittedValues: assetViewerDefaultsSubmittedValues,
    errors: assetViewerDefaultsErrors,
  });

  res.status(status).render('assets/index.njk', {
    appName,
    ...buildAssetLibraryRenderModel(page, state, {
      nsfwFilterEnabled,
      assetViewerDefaults,
      assetViewerDefaultsDialogOpen,
      assetViewerNsfwError,
      assetViewerDefaultsNotice,
    }),
  });
}

export function createAssetLibraryRouter({ appName, db, workflowQueryService } = {}) {
  const router = express.Router();

  router.get('/', (req, res, next) => {
    try {
      renderAssetLibraryPage(req, res, {
        appName,
        workflowQueryService,
        next,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/defaults', (req, res, next) => {
    handlePageDefaultsPost(req, res, next, {
      db,
      pageDefaultsService: getPageDefaultsService(req),
      page: ASSET_VIEWER_PAGE_DEFAULTS,
      successMessage: ASSET_VIEWER_NOTICES.defaultsSaved,
      saveErrorMessage: 'Asset Viewer defaults could not be saved. No changes were made.',
      onValidationError: ({ submittedValues, errors }) => {
        renderAssetLibraryPage(req, res, {
          appName,
          workflowQueryService,
          status: 422,
          assetViewerDefaultsDialogOpen: true,
          assetViewerDefaultsSubmittedValues: submittedValues,
          assetViewerDefaultsErrors: errors,
          rawQuery: readAssetViewerReturnQuery(req),
          allowSavedDefaultsRedirect: false,
          next,
        });
      },
      onSuccess: ({ validatedValues }) => {
        const params = new URLSearchParams({
          view: validatedValues.view,
          sort: validatedValues.sort,
          order: validatedValues.order,
          pageSize: validatedValues.pageSize,
          notice: 'asset_viewer_defaults_saved',
        });
        res.redirect(`/assets?${params.toString()}`);
      },
    });
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

      renderAssetLibraryPage(req, res, {
        appName,
        workflowQueryService,
        status: 422,
        assetViewerNsfwError: 'NSFW filter setting is invalid.',
        rawQuery: readAssetViewerReturnQuery(req),
        allowSavedDefaultsRedirect: false,
        next,
      });
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
  if (!returnTo || !returnTo.startsWith('/assets')) return {};
  try {
    const url = new URL(returnTo, 'http://localhost');
    return Object.fromEntries(url.searchParams.entries());
  } catch {
    return {};
  }
}
