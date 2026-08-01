import express from 'express';
import { ProjectNotFoundError } from '../services/project-service.js';
import { ReleaseValidationError } from '../services/release-service.js';

const ASSET_BROWSER_QUERY_KEYS = ['category', 'search', 'extension', 'presence', 'usage', 'sort', 'order', 'page', 'pageSize', 'view'];

// The complete set of hidden fields the browser's filter/scan/bulk forms
// round-trip so a POST can rebuild the exact same normalized GET context.
// Same key set as ASSET_BROWSER_QUERY_KEYS — kept as a separate constant so
// the intent (form field allowlist vs. URL query allowlist) stays clear at
// each call site even though the values are identical today.
const ASSET_BROWSER_CONTEXT_FIELDS = ASSET_BROWSER_QUERY_KEYS;

/**
 * Create an assets router mounted at /projects.
 *
 * Routes:
 *   GET  /projects/:id/assets — Asset listing page
 *   GET  /projects/:projectId/assets/:assetId — Asset viewer page
 *   POST /projects/:id/scan  — Trigger a manual scan
 *   POST /projects/:id/assets/add-to-release — Bulk-add selected present assets to one release
 *
 * @param {object} deps
 * @param {string} deps.appName
 * @param {import('../services/project-service.js').ProjectService} deps.projectService
 * @param {import('../services/asset-scanner.js').AssetScanner} deps.assetScanner
 * @param {import('../services/workflow-query-service.js').WorkflowQueryService} deps.workflowQueryService
 * @param {import('../services/release-service.js').ReleaseService} deps.releaseService
 */
export function createAssetsRouter({ appName, projectService, assetScanner, workflowQueryService, releaseService }) {
  const router = express.Router({ mergeParams: true });

  // GET /projects/:id/assets — Asset listing page
  router.get('/:id/assets', (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) {
        return next(createNotFound());
      }

      const project = projectService.findById(id);
      if (!project) {
        return next(createNotFound());
      }

      const data = workflowQueryService.getProjectAssetBrowser(id, req.query);

      // Pass scan result params to template only if they are valid scan outputs.
      const query = {};
      if (req.query.scan_result === 'ok' && isSmallNonNegativeInt(req.query.total)) {
        query.scan_result = 'ok';
        query.added = isSmallNonNegativeInt(req.query.added) ? req.query.added : '0';
        query.updated = isSmallNonNegativeInt(req.query.updated) ? req.query.updated : '0';
        query.missing = isSmallNonNegativeInt(req.query.missing) ? req.query.missing : '0';
        query.total = req.query.total;
      }
      // Pass scan_error flag only when actually set by the scan catch block.
      // Use scan_error=filesystem or scan_error=archived so it can be
      // distinguished from spoofed values.
      const error = req.query.scan_error === 'filesystem' ? true : null;
      const archivedError = req.query.scan_error === 'archived' ? true : null;

      // Bulk release-association result notice, set only after a valid
      // redirect from the add-to-release route (see isSmallNonNegativeInt
      // guard — never trusts unvalidated query input).
      const bulkNotice = (isSmallNonNegativeInt(req.query.bulk_added) && isSmallNonNegativeInt(req.query.bulk_already))
        ? { added: Number(req.query.bulk_added), alreadyAssociated: Number(req.query.bulk_already) }
        : null;

      res.render('projects/assets.njk', {
        appName,
        ...buildBrowserRenderModel(project, data),
        query,
        error,
        archivedError,
        bulkNotice,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /projects/:projectId/assets/:assetId — Minimal asset viewer page
  router.get('/:projectId/assets/:assetId', (req, res, next) => {
    try {
      const projectId = parseId(req.params.projectId);
      const assetId = parseId(req.params.assetId);
      if (projectId === null || assetId === null) {
        return next(createNotFound());
      }

      const data = workflowQueryService.getProjectAssetViewer(projectId, assetId, req.query);
      if (!data) {
        return next(createNotFound());
      }

      res.render('projects/asset-viewer.njk', {
        appName,
        project: data.project,
        asset: data.asset,
        context: data.context,
        filters: data.filters,
        filteredOut: data.filteredOut,
        filteredPosition: data.filteredPosition,
        filteredTotal: data.filteredTotal,
        currentPage: data.currentPage,
        previousAssetLink: data.previousAssetLink,
        nextAssetLink: data.nextAssetLink,
        backToAssetsLink: data.backToAssetsLink,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /projects/:id/scan — Trigger a manual scan
  router.post('/:id/scan', (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) {
        return next(createNotFound());
      }

      // Reject scans for archived projects. Archived projects remain readable
      // but must not permit manual scans. This server-side guard prevents
      // bypassing the template-level gating.
      const project = projectService.findById(id);
      if (!project) {
        return next(createNotFound());
      }
      if (project.archived_at) {
        return res.redirect(buildAssetsRedirectUrl(workflowQueryService, id, req.body, { scan_error: 'archived' }));
      }

      const result = assetScanner.scanProjectAssets(id);

      // Scanner field is `removed`; the user-facing label is `Missing` —
      // CreatorCrate never deletes files merely because a scan no longer
      // finds them, so the redirect/template vocabulary avoids "removed".
      res.redirect(buildAssetsRedirectUrl(workflowQueryService, id, req.body, {
        scan_result: 'ok',
        added: result.added,
        updated: result.updated,
        missing: result.removed,
        total: result.total,
      }));
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        return next(createNotFound());
      }
      // Catch filesystem errors and redirect with an error flag.
      // Use scan_error=filesystem so it can be distinguished from spoofed values.
      const id = parseId(req.params.id);
      if (id === null) {
        return res.redirect('/projects');
      }
      res.redirect(buildAssetsRedirectUrl(workflowQueryService, id, req.body, { scan_error: 'filesystem' }));
    }
  });

  // POST /projects/:id/assets/add-to-release — Bulk-add selected present
  // assets (from the current page-local selection) to one mutable release.
  // Delegates all validation and mutation to releaseService.addAssetsToRelease
  // — this route never touches the repository or reimplements mutability
  // rules.
  router.post('/:id/assets/add-to-release', (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) {
        return next(createNotFound());
      }

      const project = projectService.findById(id);
      if (!project) {
        return next(createNotFound());
      }

      const normalizedSelection = normalizeSelectedAssetIds(req.body.selectedAssetIds);
      const submittedReleaseId = typeof req.body.releaseId === 'string' ? req.body.releaseId : '';

      if (!normalizedSelection.valid) {
        throw new ReleaseValidationError({ assetIds: 'Invalid asset selection format.' });
      }

      const result = releaseService.addAssetsToRelease(submittedReleaseId, id, normalizedSelection.ids);

      res.redirect(buildAssetsRedirectUrl(workflowQueryService, id, req.body, {
        bulk_added: result.added,
        bulk_already: result.alreadyAssociated,
      }));
    } catch (err) {
      const id = parseId(req.params.id);
      if (id === null) {
        return next(createNotFound());
      }
      const project = projectService.findById(id);
      if (!project) {
        return next(createNotFound());
      }

      // Any known release-service domain error (ReleaseNotFoundError,
      // ReleaseArchivedError, ReleaseParentArchivedError, ReleasePublishedError,
      // AssetNotFoundError) carries its own `.status` (404 or 422).
      // ReleaseValidationError does not set `.status` on itself — it always
      // maps to 422. Re-render the browser with the submitted selection and
      // release choice preserved, rather than replacing the whole page with a
      // bare error — this is a form submission, not a broken link.
      const status = err instanceof ReleaseValidationError
        ? 422
        : (typeof err.status === 'number' ? err.status : null);

      if (status !== null) {
        try {
          const data = workflowQueryService.getProjectAssetBrowser(id, req.body);
          if (!data) return next(createNotFound());

          const normalizedSelection = normalizeSelectedAssetIds(req.body.selectedAssetIds);
          const submittedReleaseId = typeof req.body.releaseId === 'string' ? req.body.releaseId : '';

          return res.status(status).render('projects/assets.njk', {
            appName,
            ...buildBrowserRenderModel(project, data),
            query: {},
            error: null,
            archivedError: null,
            bulkNotice: null,
            bulkError: { message: describeBulkError(err) },
            submittedSelectedAssetIds: normalizedSelection.valid ? normalizedSelection.ids : [],
            submittedReleaseId,
          });
        } catch (renderErr) {
          return next(renderErr);
        }
      }

      next(err);
    }
  });

  return router;
}

function parseId(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id < 1 || String(id) !== value) {
    return null;
  }
  return id;
}

/**
 * Build a pageUrl(overrides) closure for the asset browser. Deliberately
 * independent of `req.path` — it is reused both by the GET browser route
 * and by POST error re-renders (scan, bulk add-to-release), whose path is
 * not `/projects/:id/assets`, so the generated links must always point back
 * at the canonical browser path regardless of which route is rendering.
 */
function buildAssetsPageUrl(projectId, allowedParams) {
  const basePath = `/projects/${projectId}/assets`;
  return function pageUrl(overrides) {
    const query = {};
    for (const key of ASSET_BROWSER_QUERY_KEYS) {
      const value = Object.prototype.hasOwnProperty.call(overrides, key)
        ? overrides[key]
        : allowedParams[key];
      appendCanonicalParam(query, key, value);
    }
    const search = new URLSearchParams(query).toString();
    return search ? `${basePath}?${search}` : basePath;
  };
}

/**
 * Render-model fields shared by the GET browser route and any POST route
 * that re-renders the same template (e.g. a bulk-add validation failure).
 * Centralizing this keeps both call sites in sync as the browser model grows.
 */
function buildBrowserRenderModel(project, data) {
  return {
    project,
    assets: data.assets,
    total: data.total,
    page: data.page,
    pageSize: data.pageSize,
    pageCount: data.pageCount,
    filters: data.filters,
    extensionChoices: data.extensionChoices,
    categoryNavigation: data.categoryNavigation,
    emptyState: data.emptyState,
    isArchived: data.isArchived,
    releaseTargets: data.releaseTargets,
    searchMaxLength: data.searchMaxLength,
    bulkError: null,
    submittedSelectedAssetIds: [],
    submittedReleaseId: null,
    // Flat context + field allowlist so the scan and bulk-add forms can
    // render their hidden context-preservation fields with one loop instead
    // of hardcoding each key.
    context: { ...data.filters, page: data.page, pageSize: data.pageSize },
    contextFields: ASSET_BROWSER_CONTEXT_FIELDS,
    pageUrl: buildAssetsPageUrl(project.id, buildCanonicalBrowserQuery(data.filters, data.page, data.pageSize)),
  };
}

/**
 * Locally rebuild a normalized `/projects/:id/assets` URL from raw
 * category/search/filter/sort/page context (e.g. hidden hidden form fields
 * echoed back by a POST) plus a small set of extra result-notice query
 * params. Never accepts or forwards an arbitrary return URL supplied by the
 * client — the path is always the canonical browser path for `projectId`,
 * and the context passes through `getProjectAssetBrowserContext`'s
 * normalization (invalid category -> All, unknown fields dropped, etc.)
 * before being re-serialized.
 *
 * @param {import('../services/workflow-query-service.js').WorkflowQueryService} workflowQueryService
 * @param {number} projectId
 * @param {object} rawContext - raw category/search/extension/... fields
 * @param {object} [extraQuery] - additional flat string/number query params
 *   (e.g. scan_result, added, updated, missing, total, bulk_added, bulk_already)
 */
function buildAssetsRedirectUrl(workflowQueryService, projectId, rawContext, extraQuery = {}) {
  const contextResult = workflowQueryService.getProjectAssetBrowserContext(projectId, rawContext);
  const filters = contextResult
    ? contextResult.filters
    : { search: null, extension: null, presence: 'all', usage: 'all', category: 'all', sort: 'filename', order: 'asc', page: 1, pageSize: 25, view: 'list' };

  const query = buildCanonicalBrowserQuery(filters, filters.page, filters.pageSize);
  for (const [key, value] of Object.entries(extraQuery)) {
    if (value === undefined || value === null || value === '') continue;
    query[key] = String(value);
  }

  const search = new URLSearchParams(query).toString();
  return search ? `/projects/${projectId}/assets?${search}` : `/projects/${projectId}/assets`;
}

/**
 * Normalize the bulk-add form's `selectedAssetIds` field into a flat array
 * of strings. Mirrors the equivalent helper in routes/releases.js — kept as
 * a local copy since that one is not exported and the shape contract is
 * small and stable (string | string[] | undefined).
 * @param {unknown} raw
 * @returns {{ valid: boolean, ids: string[] }}
 */
function normalizeSelectedAssetIds(raw) {
  if (raw === undefined) return { valid: true, ids: [] };
  if (raw === null) return { valid: false, ids: [] };
  if (typeof raw === 'string') {
    if (raw === '') return { valid: true, ids: [] };
    return { valid: true, ids: [raw] };
  }
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (typeof v !== 'string' && typeof v !== 'number') return { valid: false, ids: [] };
    }
    return { valid: true, ids: raw.map(String) };
  }
  return { valid: false, ids: [] };
}

/**
 * Strict small-non-negative-integer check for untrusted query-string values
 * echoed back into a rendered page (scan/bulk result counts). Bounds the
 * digit count so a spoofed value cannot render an absurd or overflowing
 * number.
 * @param {unknown} value
 * @returns {boolean}
 */
function isSmallNonNegativeInt(value) {
  return typeof value === 'string' && /^\d{1,7}$/.test(value);
}

/**
 * Human-readable message for a bulk-add failure notice. ReleaseValidationError
 * carries the actual field messages in `.errors`; its own `.message` is a
 * generic "Release validation failed" placeholder. Every other release-service
 * error class already has a descriptive `.message`.
 * @param {Error} err
 * @returns {string}
 */
function describeBulkError(err) {
  if (err && err.errors && typeof err.errors === 'object') {
    const values = Object.values(err.errors).filter((v) => typeof v === 'string');
    if (values.length > 0) return values.join(' ');
  }
  return err.message;
}

function buildCanonicalBrowserQuery(filters, page, pageSize) {
  const query = {};
  appendCanonicalParam(query, 'category', filters.category);
  appendCanonicalParam(query, 'search', filters.search);
  appendCanonicalParam(query, 'extension', filters.extension);
  appendCanonicalParam(query, 'presence', filters.presence);
  appendCanonicalParam(query, 'usage', filters.usage);
  appendCanonicalParam(query, 'sort', filters.sort);
  appendCanonicalParam(query, 'order', filters.order);
  appendCanonicalParam(query, 'page', page);
  appendCanonicalParam(query, 'pageSize', pageSize);
  appendCanonicalParam(query, 'view', filters.view);
  return query;
}

function appendCanonicalParam(query, key, value) {
  if (value === undefined || value === null || value === '') return;
  const normalized = String(value);
  if (key === 'category' && normalized === 'all') return;
  if (key === 'presence' && normalized === 'all') return;
  if (key === 'usage' && normalized === 'all') return;
  if (key === 'sort' && normalized === 'filename') return;
  if (key === 'order' && normalized === 'asc') return;
  if (key === 'page' && normalized === '1') return;
  if (key === 'pageSize' && normalized === '25') return;
  if (key === 'view' && normalized === 'list') return;
  query[key] = normalized;
}

function createNotFound() {
  const err = new Error('Not found');
  err.status = 404;
  return err;
}
