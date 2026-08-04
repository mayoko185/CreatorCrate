import express from 'express';
import {
  ASSET_LIBRARY_PAGE_SIZE_VALUES,
  buildAssetLibraryUrl,
  parseAssetLibraryQuery,
} from './asset-library-query.js';

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

function buildAssetLibraryRenderModel(page, state) {
  const canonicalState = {
    ...state,
    page: page.page,
    pageSize: page.pageSize,
  };
  const pageUrl = (overrides = {}) => buildAssetLibraryUrl(canonicalState, overrides);

  return {
    ...page,
    canonicalUrl: buildAssetLibraryUrl(canonicalState),
    currentUrl: buildAssetLibraryUrl(canonicalState),
    pageUrl,
    preserveViewQuery: state.presentation?.view?.state === 'valid'
      || state.presentation?.view?.preserveFallback === true,
    orderOptions: buildOrderOptions(page.filters.order),
    pageSizeOptions: buildPageSizeOptions(page.pageSize),
    clearFiltersUrl: pageUrl({
      projectId: null,
      categories: null,
      tags: null,
      search: null,
      extensions: null,
      presence: 'all',
      usage: 'all',
      page: 1,
    }),
  };
}

export function createAssetLibraryRouter({ appName, workflowQueryService } = {}) {
  const router = express.Router();

  router.get('/', (req, res, next) => {
    try {
      const pageDefaultsService = getPageDefaultsService(req);
      const parsed = parseAssetLibraryQuery(req.query);
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

      if (getRequestUrl(req) !== canonicalUrl) {
        return res.redirect(canonicalUrl);
      }

      res.render('assets/index.njk', {
        appName,
        ...buildAssetLibraryRenderModel(page, state),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
