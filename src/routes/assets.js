import express from 'express';
import { ProjectNotFoundError } from '../services/project-service.js';
import { ReleaseValidationError } from '../services/release-service.js';
import { UNCATEGORIZED } from '../services/asset-action-service.js';
import { PRIMARY_IMAGE_ERROR_CODES } from '../services/project-primary-image-service.js';
import {
  buildCanonicalAssetBrowserQuery,
  isPrimaryImageAssetUsable,
} from '../services/workflow-query-service.js';
import { classifyPreviewable } from '../services/preview-service.js';

const ASSET_BROWSER_QUERY_KEYS = ['category', 'search', 'extension', 'presence', 'usage', 'sort', 'order', 'page', 'pageSize', 'view'];

// The complete set of hidden fields the browser's filter/scan/bulk forms
// round-trip so a POST can rebuild the exact same normalized GET context.
// Same key set as ASSET_BROWSER_QUERY_KEYS — kept as a separate constant so
// the intent (form field allowlist vs. URL query allowlist) stays clear at
// each call site even though the values are identical today.
const ASSET_BROWSER_CONTEXT_FIELDS = ASSET_BROWSER_QUERY_KEYS;
const ASSET_RENAME_ORIGINS = new Set(['assets', 'viewer']);

/**
 * Create an assets router mounted at /projects.
 *
 * Routes:
 *   GET  /projects/:id/assets — Asset listing page
 *   GET  /projects/:projectId/assets/:assetId — Asset viewer page
 *   POST /projects/:id/scan  — Trigger a manual scan
 *   POST /projects/:id/assets/add-to-release — Bulk-add selected present assets to one release
 *   POST /projects/:id/assets/move-selected — Batch-move selected present assets to a category
 *
 * @param {object} deps
 * @param {string} deps.appName
 * @param {import('../services/project-service.js').ProjectService} deps.projectService
 * @param {import('../services/asset-scanner.js').AssetScanner} deps.assetScanner
 * @param {import('../services/workflow-query-service.js').WorkflowQueryService} deps.workflowQueryService
 * @param {import('../services/release-service.js').ReleaseService} deps.releaseService
 * @param {ReturnType<import('../services/asset-action-service.js').createAssetActionService>} [deps.assetActionService]
 *   Rename/move filesystem action service (Phase: asset actions chunk 3).
 *   Used by the single-file and batch asset-action route handlers.
 * @param {ReturnType<import('../services/asset-browser-preference-service.js').createAssetBrowserPreferenceService>} deps.assetBrowserPreferenceService
 *   Application-scoped preference service used only for bare Assets-page
 *   default resolution.
 * @param {ReturnType<import('../services/project-primary-image-service.js').createProjectPrimaryImageService>} deps.projectPrimaryImageService
 *   Application-scoped primary-image service used by the viewer and its
 *   mutation routes.
 * @param {Function} [deps.previewProbe]
 *   Application-scoped bounded Krita preview probe used only by the viewer.
 */
export function createAssetsRouter({
  appName,
  projectService,
  assetScanner,
  workflowQueryService,
  releaseService,
  assetActionService,
  assetBrowserPreferenceService,
  projectPrimaryImageService,
  previewProbe,
} = {}) {
  if (!assetBrowserPreferenceService || typeof assetBrowserPreferenceService.resolveEffectiveCategory !== 'function') {
    throw new Error('createAssetsRouter requires an assetBrowserPreferenceService dependency.');
  }
  if (!projectPrimaryImageService || typeof projectPrimaryImageService.getPrimaryImage !== 'function'
    || typeof projectPrimaryImageService.setPrimaryImage !== 'function'
    || typeof projectPrimaryImageService.clearPrimaryImage !== 'function') {
    throw new Error('createAssetsRouter requires a projectPrimaryImageService dependency.');
  }

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

      // Only a completely bare parsed query may activate the configured
      // default. Any query key — including unknown, invalid, notice, or
      // pagination input — deliberately blocks default resolution.
      if (isBareAssetBrowserRequest(req.query)) {
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
          return res.redirect(buildDefaultCategoryUrl(id, categoryId));
        }
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
      const assetActionNotice = req.query.notice === 'asset-renamed'
        ? { message: ASSET_ACTION_NOTICE_MESSAGES['asset-renamed'] }
        : null;

      // Bulk release-association result notice, set only after a valid
      // redirect from the add-to-release route (see isSmallNonNegativeInt
      // guard — never trusts unvalidated query input).
      const bulkNotice = (isSmallNonNegativeInt(req.query.bulk_added) && isSmallNonNegativeInt(req.query.bulk_already))
        ? { added: Number(req.query.bulk_added), alreadyAssociated: Number(req.query.bulk_already) }
        : null;

      const moveNotice = isSmallNonNegativeInt(req.query.assets_moved)
        ? { movedCount: Number(req.query.assets_moved) }
        : null;

      res.render('projects/assets.njk', {
        appName,
        ...buildBrowserRenderModel(project, data),
        query,
        error,
        archivedError,
        bulkNotice,
        moveNotice,
        assetActionNotice,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /projects/:projectId/assets/:assetId — Minimal asset viewer page
  router.get('/:projectId/assets/:assetId', async (req, res, next) => {
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

      let primaryImage;
      try {
        primaryImage = projectPrimaryImageService.getPrimaryImage(projectId);
      } catch (err) {
        return handlePrimaryImageFailure(err, { next });
      }

      const viewerEligibility = await probePrimaryImageViewerEligibility(data, previewProbe);

      const notice = ASSET_ACTION_NOTICE_CODES.has(req.query.notice) ? req.query.notice : null;

      res.render('projects/asset-viewer.njk', {
        appName,
        ...buildAssetViewerRenderModel(data, buildPrimaryImageViewerState(data, primaryImage, viewerEligibility)),
        notice,
        noticeMessage: notice ? ASSET_ACTION_NOTICE_MESSAGES[notice] : null,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /projects/:projectId/assets/:assetId/primary-image — Set the
  // displayed eligible asset as the project's retained primary image.
  router.post('/:projectId/assets/:assetId/primary-image', async (req, res, next) => {
    try {
      const projectId = parseId(req.params.projectId);
      const assetId = parseId(req.params.assetId);
      if (projectId === null || assetId === null) {
        return next(createNotFound());
      }

      try {
        await projectPrimaryImageService.setPrimaryImage(projectId, assetId);
      } catch (err) {
        return handlePrimaryImageFailure(err, { next });
      }

      res.redirect(buildAssetViewerRedirectUrl(
        workflowQueryService,
        projectId,
        assetId,
        req.body,
        { notice: 'primary-image-set' },
      ));
    } catch (err) {
      next(err);
    }
  });

  // POST /projects/:projectId/assets/:assetId/primary-image/remove — Remove
  // only the selection that still points at the displayed asset.
  router.post('/:projectId/assets/:assetId/primary-image/remove', (req, res, next) => {
    try {
      const projectId = parseId(req.params.projectId);
      const assetId = parseId(req.params.assetId);
      if (projectId === null || assetId === null) {
        return next(createNotFound());
      }

      try {
        projectPrimaryImageService.clearPrimaryImage(projectId, assetId);
      } catch (err) {
        return handlePrimaryImageFailure(err, { next });
      }

      res.redirect(buildAssetViewerRedirectUrl(
        workflowQueryService,
        projectId,
        assetId,
        req.body,
        { notice: 'primary-image-removed' },
      ));
    } catch (err) {
      next(err);
    }
  });

  // POST /projects/:projectId/assets/:assetId/rename — Rename a single
  // asset's file in place. Browser-origin forms submit a basename and use the
  // service's extension-preserving operation; viewer-origin forms retain the
  // complete-filename action contract.
  router.post('/:projectId/assets/:assetId/rename', (req, res, next) => {
    try {
      const projectId = parseId(req.params.projectId);
      const assetId = parseId(req.params.assetId);
      if (projectId === null || assetId === null) {
        return next(createNotFound());
      }
      const project = projectService.findById(projectId);
      if (!project) {
        return next(createNotFound());
      }

      const filename = req.body.filename;
      const origin = parseRenameOrigin(req.body.origin);

      if (origin === null) {
        return handleAssetActionFailure({ code: 'INVALID_ORIGIN' }, {
          appName, workflowQueryService, projectPrimaryImageService, req, res, next,
          project, projectId, assetId, action: 'rename', origin: 'viewer',
          submittedFilename: typeof filename === 'string' ? filename : '',
        });
      }

      let renamed;
      try {
        renamed = origin === 'assets'
          ? assetActionService.renameAssetBasename(projectId, assetId, filename)
          : assetActionService.renameAsset(projectId, assetId, filename);
      } catch (err) {
        return handleAssetActionFailure(err, {
          appName, workflowQueryService, projectPrimaryImageService, req, res, next,
          project, projectId, assetId, action: 'rename', origin,
          submittedFilename: typeof filename === 'string' ? filename : '',
        });
      }

      const redirectUrl = origin === 'assets'
        ? buildAssetsRedirectUrl(workflowQueryService, projectId, req.body, { notice: 'asset-renamed' })
        : buildAssetViewerRedirectUrl(workflowQueryService, projectId, renamed.id, req.body, { notice: 'asset-renamed' });
      res.redirect(redirectUrl);
    } catch (err) {
      next(err);
    }
  });

  // POST /projects/:projectId/assets/:assetId/move — Move a single asset
  // into an enabled project category's root directory, or to the project
  // root (Uncategorized). `destinationCategory` accepts only "uncategorized"
  // or a canonical positive-integer category ID string; anything else is
  // rejected here (422) before assetActionService.moveAsset is ever called.
  router.post('/:projectId/assets/:assetId/move', (req, res, next) => {
    try {
      const projectId = parseId(req.params.projectId);
      const assetId = parseId(req.params.assetId);
      if (projectId === null || assetId === null) {
        return next(createNotFound());
      }

      const rawDestination = req.body.destinationCategory;
      const parsedDestination = parseDestinationCategoryField(rawDestination);
      const submittedDestinationCategory = typeof rawDestination === 'string' ? rawDestination : '';

      if (!parsedDestination.ok) {
        return handleAssetActionFailure({ code: 'DESTINATION_CATEGORY_MALFORMED' }, {
          appName, workflowQueryService, projectPrimaryImageService, req, res, next,
          projectId, assetId, action: 'move',
          submittedDestinationCategory,
        });
      }

      let moved;
      try {
        moved = assetActionService.moveAsset(projectId, assetId, parsedDestination.value);
      } catch (err) {
        return handleAssetActionFailure(err, {
          appName, workflowQueryService, projectPrimaryImageService, req, res, next,
          projectId, assetId, action: 'move',
          submittedDestinationCategory,
        });
      }

      res.redirect(buildAssetViewerRedirectUrl(workflowQueryService, projectId, moved.id, req.body, { notice: 'asset-moved' }));
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

  // POST /projects/:id/assets/move-selected — Batch-move selected present
  // assets to one category or Uncategorized. All validation (asset presence,
  // destination validity, intra-batch conflicts) runs inside the service under
  // one project lock. The route only extracts and type-checks form fields.
  router.post('/:id/assets/move-selected', (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return next(createNotFound());

      const project = projectService.findById(id);
      if (!project) return next(createNotFound());

      const normalizedSelection = normalizeSelectedAssetIds(req.body.selectedAssetIds);
      const rawDestination = req.body.destinationCategory;
      const parsedDestination = parseDestinationCategoryField(rawDestination);

      const renderMoveError = (status, message, selectedIds = []) => {
        try {
          const data = workflowQueryService.getProjectAssetBrowser(id, req.body);
          if (!data) return next(createNotFound());
          return res.status(status).render('projects/assets.njk', {
            appName,
            ...buildBrowserRenderModel(project, data),
            query: {},
            error: null,
            archivedError: null,
            bulkNotice: null,
            moveNotice: null,
            bulkMoveError: { message },
            submittedSelectedAssetIds: selectedIds,
          });
        } catch (renderErr) {
          return next(renderErr);
        }
      };

      if (!normalizedSelection.valid) {
        return renderMoveError(422, 'Invalid asset selection.');
      }

      if (normalizedSelection.ids.length === 0) {
        return renderMoveError(422, 'Select at least one asset to move.');
      }

      if (!parsedDestination.ok) {
        return renderMoveError(422, 'Choose a valid destination.', normalizedSelection.ids);
      }

      // Convert string IDs to positive integers; parseId rejects non-canonical strings.
      const assetIds = [];
      for (const idStr of normalizedSelection.ids) {
        const assetId = parseId(idStr);
        if (assetId === null) {
          return renderMoveError(422, 'Invalid asset selection.');
        }
        assetIds.push(assetId);
      }

      let result;
      try {
        result = assetActionService.moveAssets(id, assetIds, parsedDestination.value);
      } catch (err) {
        const code = err && err.code;
        const status = BATCH_ASSET_ACTION_ERROR_STATUS[code];
        if (status === undefined) return next(err);
        if (status === 404) return next(createNotFound());
        return renderMoveError(status, describeBatchMoveError(err), normalizedSelection.ids);
      }

      res.redirect(buildAssetsRedirectUrl(workflowQueryService, id, req.body, {
        assets_moved: result.movedCount,
      }));
    } catch (err) {
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

function isBareAssetBrowserRequest(query) {
  return Boolean(query && typeof query === 'object' && Object.keys(query).length === 0);
}

function buildDefaultCategoryUrl(projectId, categoryId) {
  return `/projects/${projectId}/assets?category=${encodeURIComponent(String(categoryId))}`;
}

function parseRenameOrigin(raw) {
  // Omitted origin is retained as the legacy viewer-origin contract for
  // direct callers; an explicit origin must be one of the fixed values.
  if (raw === undefined) return 'viewer';
  return ASSET_RENAME_ORIGINS.has(raw) ? raw : null;
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
  return function pageUrl(overrides = {}) {
    const query = buildCanonicalAssetBrowserQuery(allowedParams, allowedParams.page, overrides);
    const search = new URLSearchParams(query).toString();
    return search ? `${basePath}?${search}` : basePath;
  };
}

/**
 * Render-model fields shared by the GET browser route and any POST route
 * that re-renders the same template (e.g. bulk-add or asset-action failure).
 * Centralizing this keeps both call sites in sync as the browser model grows.
 */
function buildBrowserRenderModel(project, data) {
  const context = {
    ...(data.context || data.filters),
    page: data.page,
    pageSize: data.pageSize,
  };

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
    bulkMoveError: null,
    moveNotice: null,
    assetActionNotice: null,
    renameFailure: null,
    submittedSelectedAssetIds: [],
    submittedReleaseId: null,
    // Flat context + field allowlist so the scan and bulk-add forms can
    // render their hidden context-preservation fields with one loop instead
    // of hardcoding each key.
    context,
    contextFields: ASSET_BROWSER_CONTEXT_FIELDS,
    pageUrl: buildAssetsPageUrl(project.id, context),
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
function buildCanonicalContextQuery(workflowQueryService, projectId, rawContext, extraQuery = {}) {
  const contextResult = workflowQueryService.getProjectAssetBrowserContext(projectId, rawContext);
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
  for (const [key, value] of Object.entries(extraQuery)) {
    if (value === undefined || value === null || value === '') continue;
    query[key] = String(value);
  }
  return query;
}

function buildAssetsRedirectUrl(workflowQueryService, projectId, rawContext, extraQuery = {}) {
  const query = buildCanonicalContextQuery(workflowQueryService, projectId, rawContext, extraQuery);
  const search = new URLSearchParams(query).toString();
  return search ? `/projects/${projectId}/assets?${search}` : `/projects/${projectId}/assets`;
}

/**
 * Same normalized-context redirect contract as buildAssetsRedirectUrl, but
 * pointing back at the single-asset viewer instead of the browser. Used
 * after a successful rename/move so the user lands back on the same asset
 * (by its current, possibly-unchanged id) with the same browser context and
 * a controlled notice code.
 *
 * @param {import('../services/workflow-query-service.js').WorkflowQueryService} workflowQueryService
 * @param {number} projectId
 * @param {number} assetId
 * @param {object} rawContext
 * @param {object} [extraQuery]
 */
function buildAssetViewerRedirectUrl(workflowQueryService, projectId, assetId, rawContext, extraQuery = {}) {
  const query = buildCanonicalContextQuery(workflowQueryService, projectId, rawContext, extraQuery);
  const search = new URLSearchParams(query).toString();
  return search ? `/projects/${projectId}/assets/${assetId}?${search}` : `/projects/${projectId}/assets/${assetId}`;
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

function createNotFound() {
  const err = new Error('Not found');
  err.status = 404;
  return err;
}

// ─── Phase: asset actions chunk 4 — rename/move HTTP integration ─────────

const ASSET_ACTION_NOTICE_CODES = new Set([
  'asset-renamed',
  'asset-moved',
  'primary-image-set',
  'primary-image-removed',
]);

const ASSET_ACTION_NOTICE_MESSAGES = {
  'asset-renamed': 'The file was renamed.',
  'asset-moved': 'The file was moved.',
  'primary-image-set': 'The primary image was set.',
  'primary-image-removed': 'The primary image was removed.',
};

const PRIMARY_IMAGE_ERROR_STATUS = Object.freeze({
  [PRIMARY_IMAGE_ERROR_CODES.INVALID_ID]: 404,
  [PRIMARY_IMAGE_ERROR_CODES.PROJECT_NOT_FOUND]: 404,
  [PRIMARY_IMAGE_ERROR_CODES.PROJECT_ARCHIVED]: 409,
  [PRIMARY_IMAGE_ERROR_CODES.ASSET_NOT_FOUND]: 404,
  [PRIMARY_IMAGE_ERROR_CODES.ASSET_MISSING]: 409,
  [PRIMARY_IMAGE_ERROR_CODES.ASSET_UNSUPPORTED]: 422,
  [PRIMARY_IMAGE_ERROR_CODES.STALE_CLEAR]: 409,
  [PRIMARY_IMAGE_ERROR_CODES.DATABASE_ERROR]: 500,
});

const PRIMARY_IMAGE_ERROR_MESSAGES = Object.freeze({
  [PRIMARY_IMAGE_ERROR_CODES.PROJECT_ARCHIVED]: 'This project is archived and read-only.',
  [PRIMARY_IMAGE_ERROR_CODES.ASSET_MISSING]: 'This asset is missing from the last scan and cannot be selected as the primary image.',
  [PRIMARY_IMAGE_ERROR_CODES.ASSET_UNSUPPORTED]: 'This asset type cannot be selected as the primary image.',
  [PRIMARY_IMAGE_ERROR_CODES.STALE_CLEAR]: 'The primary image changed before it could be removed.',
  [PRIMARY_IMAGE_ERROR_CODES.DATABASE_ERROR]: 'The primary image operation could not be completed. Please try again.',
});

function handlePrimaryImageFailure(err, { next }) {
  const code = err && err.code;
  const status = code ? PRIMARY_IMAGE_ERROR_STATUS[code] : undefined;

  if (status === undefined) {
    return next(err);
  }
  if (status === 404) {
    return next(createNotFound());
  }

  const controlled = new Error(
    PRIMARY_IMAGE_ERROR_MESSAGES[code] || 'The primary image operation could not be completed. Please try again.'
  );
  controlled.status = status;
  return next(controlled);
}

// ─── Phase: asset list actions — batch move ──────────────────────────────

const BATCH_ASSET_ACTION_ERROR_STATUS = {
  NO_ASSETS_SELECTED: 422,
  INVALID_ASSET_SELECTION: 422,
  BATCH_PRECHECK_FAILED: 422,
  BATCH_DESTINATION_CONFLICT: 409,
  BATCH_DUPLICATE_DESTINATION: 409,
  PROJECT_NOT_FOUND: 404,
  PROJECT_ARCHIVED: 409,
  PROJECT_BUSY: 409,
  PROJECT_DIRECTORY_UNSAFE: 500,
  BATCH_PARTIAL_FAILURE: 500,
  BATCH_RECOVERY_REQUIRED: 500,
};

const BATCH_ASSET_ACTION_ERROR_MESSAGES = {
  NO_ASSETS_SELECTED: 'Select at least one asset to move.',
  INVALID_ASSET_SELECTION: 'Invalid asset selection.',
  BATCH_PRECHECK_FAILED: 'One or more selected assets cannot be moved to that destination.',
  BATCH_DESTINATION_CONFLICT: 'Destination already exists for one or more selected assets.',
  BATCH_DUPLICATE_DESTINATION: 'Two or more selected assets have the same filename and would conflict at the destination.',
  PROJECT_ARCHIVED: 'This project is archived and read-only.',
  PROJECT_BUSY: 'Another project operation is already in progress. Try again.',
  PROJECT_DIRECTORY_UNSAFE: 'The operation could not be completed. Please try again.',
  BATCH_PARTIAL_FAILURE: 'A failure occurred before all assets could be moved.',
  BATCH_RECOVERY_REQUIRED: 'A file was moved on disk, but the database could not be updated. Inspect the project folder before scanning.',
};

function describeBatchMoveError(err) {
  const code = err && err.code;
  const ctx = err && err.batchContext;
  if ((code === 'BATCH_PARTIAL_FAILURE' || code === 'BATCH_RECOVERY_REQUIRED') && ctx) {
    const suffix = code === 'BATCH_RECOVERY_REQUIRED'
      ? ' Inspect the project folder before scanning.'
      : '';
    return `Moved ${ctx.movedCount} of ${ctx.requestedCount} asset${ctx.requestedCount !== 1 ? 's' : ''} before a failure occurred.${suffix}`;
  }
  return BATCH_ASSET_ACTION_ERROR_MESSAGES[code] || 'The operation could not be completed.';
}

// Deliberate, explicit whitelist of every AssetActionError code this route
// layer knows how to handle, plus one route-local code (destinationCategory
// form parsing, which never reaches the service). A code not in this map is
// always treated as unexpected and passed to the existing application error
// middleware — never rendered directly, so an error object from anywhere
// else in the stack can never be misinterpreted as one of these.
const ASSET_ACTION_ERROR_STATUS = {
  // 422 — malformed direct user input, never passed to the service.
  INVALID_FILENAME: 422,
  INVALID_ORIGIN: 422,
  DESTINATION_CATEGORY_MALFORMED: 422,

  // 404 — existing not-found convention. Cross-project asset/category
  // access resolves to the same code as "unknown", so neither leaks
  // whether the id exists elsewhere.
  PROJECT_NOT_FOUND: 404,
  ASSET_NOT_FOUND: 404,

  // 409 — state conflicts. The request was well-formed; the current
  // project/asset/filesystem/category state does not allow it right now.
  PROJECT_ARCHIVED: 409,
  ASSET_MISSING: 409,
  SOURCE_MISSING: 409,
  SOURCE_SYMLINK: 409,
  SOURCE_NOT_REGULAR: 409,
  DESTINATION_CONFLICT: 409,
  DESTINATION_CATEGORY_INVALID: 409,
  DESTINATION_CATEGORY_DISABLED: 409,
  DESTINATION_DIRECTORY_MISSING: 409,
  DESTINATION_DIRECTORY_UNSAFE: 409,
  UNCHANGED_LOCATION: 409,
  CASE_ONLY_RENAME_UNSUPPORTED: 409,
  PROJECT_BUSY: 409,

  // 500 — operational failure. Nothing the user submitted was wrong; the
  // filesystem/service could not complete the operation. RECOVERY_REQUIRED
  // specifically means the filesystem may now be in a state the database
  // does not reflect — its message says so explicitly.
  FILESYSTEM_OPERATION_FAILED: 500,
  RECOVERY_REQUIRED: 500,
  PROJECT_DIRECTORY_UNSAFE: 500,
  SOURCE_PATH_UNSAFE: 500,
};

const ASSET_ACTION_ERROR_MESSAGES = {
  INVALID_FILENAME: 'Enter a valid filename.',
  INVALID_ORIGIN: 'The requested action origin is not supported.',
  DESTINATION_CATEGORY_MALFORMED: 'Choose a valid destination.',
  PROJECT_ARCHIVED: 'This project is archived and read-only.',
  ASSET_MISSING: 'This asset is missing from the last scan and cannot be renamed or moved.',
  SOURCE_MISSING: 'The source file is missing from disk.',
  SOURCE_SYMLINK: 'The source file cannot be modified.',
  SOURCE_NOT_REGULAR: 'The source path is not a regular file.',
  DESTINATION_CONFLICT: 'Destination already exists.',
  DESTINATION_CATEGORY_INVALID: 'The selected category is not available for this project.',
  DESTINATION_CATEGORY_DISABLED: 'The selected category is disabled or unavailable.',
  DESTINATION_DIRECTORY_MISSING: 'The destination directory is unavailable.',
  DESTINATION_DIRECTORY_UNSAFE: 'The destination directory is unavailable.',
  CASE_ONLY_RENAME_UNSUPPORTED: 'Case-only renames are not supported.',
  PROJECT_BUSY: 'Another project operation is already in progress. Try again.',
  FILESYSTEM_OPERATION_FAILED: 'The operation could not be completed. Please try again.',
  RECOVERY_REQUIRED: 'The file was moved on disk, but CreatorCrate could not finish updating its records. Inspect the project folder before scanning or trying again.',
  PROJECT_DIRECTORY_UNSAFE: 'The operation could not be completed. Please try again.',
  SOURCE_PATH_UNSAFE: 'The operation could not be completed. Please try again.',
};

/**
 * Fixed, concise user-facing message for a known asset-action error code.
 * UNCHANGED_LOCATION reads differently for rename vs. move — every other
 * code's message is action-independent.
 * @param {string} code
 * @param {'rename'|'move'} action
 * @returns {string}
 */
function describeAssetActionError(code, action) {
  if (code === 'UNCHANGED_LOCATION') {
    return action === 'move' ? 'That destination is unchanged.' : 'That filename is unchanged.';
  }
  return ASSET_ACTION_ERROR_MESSAGES[code] || 'The operation could not be completed. Please try again.';
}

/**
 * Parse the move form's `destinationCategory` field against the exact
 * contract: "uncategorized" -> the exported UNCATEGORIZED sentinel, a
 * canonical positive-integer string -> that number. Everything else
 * (empty, zero, negative, decimal, mixed-numeric, arbitrary text, slugs,
 * any other sentinel-like text) is rejected here — never forwarded to
 * assetActionService.moveAsset as a raw string. Reuses the same strict
 * positive-integer contract as parseId (reject leading zeros, non-digit
 * characters, and any value that does not round-trip exactly).
 * @param {unknown} raw
 * @returns {{ ok: boolean, value: number|typeof UNCATEGORIZED|null }}
 */
function parseDestinationCategoryField(raw) {
  if (raw === 'uncategorized') return { ok: true, value: UNCATEGORIZED };
  if (typeof raw !== 'string') return { ok: false, value: null };
  const id = parseId(raw);
  if (id === null) return { ok: false, value: null };
  return { ok: true, value: id };
}

async function probePrimaryImageViewerEligibility(data, previewProbe) {
  if (isPrimaryImageAssetUsable(data.asset)) return true;

  const projectIsArchived = Boolean(data.project.archived_at) || data.project.status === 'archived';
  const classification = classifyPreviewable(data.asset);
  if (
    projectIsArchived
    || !data.asset?.is_present
    || !classification.supported
    || classification.kind !== 'krita'
    || classification.extension !== 'kra'
    || typeof previewProbe !== 'function'
  ) {
    return false;
  }

  try {
    const result = await previewProbe(data.project, data.asset);
    return result?.quality === 'merged';
  } catch {
    // Viewer eligibility is a presentation hint. A probe failure must not
    // expose archive or filesystem details or make the viewer fail closed.
    return false;
  }
}

function buildPrimaryImageViewerState(data, selectedAsset, isEligiblePresentImage = isPrimaryImageAssetUsable(data.asset)) {
  const projectIsArchived = Boolean(data.project.archived_at) || data.project.status === 'archived';
  const assetBelongsToProject = data.asset.project_id === data.project.id;
  const isPrimaryImage = Boolean(selectedAsset && selectedAsset.id === data.asset.id);
  const isEligible = assetBelongsToProject && isEligiblePresentImage;

  return {
    isPrimaryImage,
    isPrimaryImageAvailable: isPrimaryImage && isEligible,
    canSetAsPrimaryImage: !projectIsArchived && !isPrimaryImage && isEligible,
    canRemovePrimaryImage: !projectIsArchived && isPrimaryImage,
  };
}

/**
 * Shared render-model fields for the asset viewer — used by the GET route
 * and by every controlled-failure re-render, so both stay in sync as the
 * viewer model grows. `overrides` layers success/failure-specific fields
 * (notice, formError, submitted form values) over the defaults.
 * @param {object} data - workflowQueryService.getProjectAssetViewer(...) result
 * @param {object} [overrides]
 */
function buildAssetViewerRenderModel(data, overrides = {}) {
  return {
    project: data.project,
    asset: data.asset,
    context: data.context,
    filters: data.filters,
    contextFields: ASSET_BROWSER_CONTEXT_FIELDS,
    filteredOut: data.filteredOut,
    filteredPosition: data.filteredPosition,
    filteredTotal: data.filteredTotal,
    currentPage: data.currentPage,
    previousAssetLink: data.previousAssetLink,
    nextAssetLink: data.nextAssetLink,
    backToAssetsLink: data.backToAssetsLink,
    enabledCategories: data.enabledCategories,
    canMutate: data.canMutate,
    notice: null,
    noticeMessage: null,
    formError: null,
    submittedFilename: data.asset.filename,
    submittedDestinationCategory: data.asset.category_id != null ? String(data.asset.category_id) : 'uncategorized',
    ...overrides,
  };
}

/**
 * Map a rename/move failure to a controlled HTTP response.
 *
 * - An unrecognized code (not in ASSET_ACTION_ERROR_STATUS) is always
 *   unexpected — passed to `next(err)` so the existing application error
 *   middleware handles it. No AssetActionError code and no filesystem/SQL
 *   detail is ever rendered directly.
 * - PROJECT_NOT_FOUND/ASSET_NOT_FOUND use the existing not-found path.
 * - Viewer-origin failures re-render the viewer directly (never a redirect)
 *   with the submitted form value preserved.
 * - Assets-origin rename failures re-render the browser with the normalized
 *   context and the submitted filename attached to the affected row/card.
 * - If the viewer itself can no longer be rebuilt (the project/asset
 *   vanished between the failed action and this re-render), that also
 *   falls back to the existing not-found behavior rather than a second,
 *   unrelated exception.
 *
 * @param {{code?: string}} err
 * @param {object} ctx
 * @param {string} ctx.appName
 * @param {import('../services/workflow-query-service.js').WorkflowQueryService} ctx.workflowQueryService
 * @param {ReturnType<import('../services/project-primary-image-service.js').createProjectPrimaryImageService>} ctx.projectPrimaryImageService
 * @param {import('express').Request} ctx.req
 * @param {import('express').Response} ctx.res
 * @param {import('express').NextFunction} ctx.next
 * @param {object} [ctx.project]
 * @param {number} ctx.projectId
 * @param {number} ctx.assetId
 * @param {'rename'|'move'} ctx.action
 * @param {'assets'|'viewer'} [ctx.origin]
 * @param {string} [ctx.submittedFilename]
 * @param {string} [ctx.submittedDestinationCategory]
 */
function handleAssetActionFailure(err, {
  appName, workflowQueryService, projectPrimaryImageService, req, res, next,
  project, projectId, assetId, action, origin = 'viewer',
  submittedFilename, submittedDestinationCategory,
}) {
  const code = err && err.code;
  const status = code ? ASSET_ACTION_ERROR_STATUS[code] : undefined;

  if (status === undefined) {
    return next(err);
  }

  if (origin === 'assets') {
    return handleAssetBrowserActionFailure(err, {
      appName, workflowQueryService, req, res, next,
      project, projectId, assetId, action, submittedFilename,
    });
  }

  if (status === 404) {
    return next(createNotFound());
  }

  let data;
  let primaryImageState;
  try {
    data = workflowQueryService.getProjectAssetViewer(projectId, assetId, req.body);
    if (data) {
      primaryImageState = buildPrimaryImageViewerState(
        data,
        projectPrimaryImageService.getPrimaryImage(projectId),
      );
    }
  } catch (renderErr) {
    return next(renderErr);
  }
  if (!data) {
    return next(createNotFound());
  }

  const overrides = {
    formError: { message: describeAssetActionError(code, action) },
  };
  if (submittedFilename !== undefined) overrides.submittedFilename = submittedFilename;
  if (submittedDestinationCategory !== undefined) overrides.submittedDestinationCategory = submittedDestinationCategory;

  res.status(status).render('projects/asset-viewer.njk', {
    appName,
    ...buildAssetViewerRenderModel(data, { ...primaryImageState, ...overrides }),
  });
}

function handleAssetBrowserActionFailure(err, {
  appName, workflowQueryService, req, res, next,
  project, projectId, assetId, action, submittedFilename,
}) {
  const code = err && err.code;
  const status = code ? ASSET_ACTION_ERROR_STATUS[code] : undefined;

  if (status === undefined) {
    return next(err);
  }
  if (status === 404) {
    return next(createNotFound());
  }

  let data;
  try {
    data = workflowQueryService.getProjectAssetBrowser(projectId, req.body);
  } catch (renderErr) {
    return next(renderErr);
  }
  if (!data) {
    return next(createNotFound());
  }

  return res.status(status).render('projects/assets.njk', {
    appName,
    ...buildBrowserRenderModel(project, data),
    query: {},
    error: null,
    archivedError: null,
    bulkNotice: null,
    moveNotice: null,
    assetActionNotice: null,
    renameFailure: {
      assetId,
      message: describeAssetActionError(code, action),
      submittedFilename: submittedFilename ?? '',
    },
  });
}
