import express from 'express';
import { ProjectNotFoundError } from '../services/project-service.js';
import { ReleaseValidationError } from '../services/release-service.js';
import { buildCreateReleaseFormModel } from './releases.js';
import { UNCATEGORIZED } from '../services/asset-action-service.js';
import { PRIMARY_IMAGE_ERROR_CODES } from '../services/project-primary-image-service.js';
import { AUTO_RENAME_ERROR_CODES } from '../services/auto-rename-service.js';
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
  buildCanonicalAssetBrowserQuery,
  buildAssetBrowserQueryString,
  isPrimaryImageAssetUsable,
} from '../services/workflow-query-service.js';
import { buildAssetRevisionToken, classifyPreviewable } from '../services/preview-service.js';
import { buildOpenLocallyUri } from '../util/open-locally.js';

const ASSET_BROWSER_QUERY_KEYS = ['category', 'tag', 'search', 'extension', 'presence', 'usage', 'sort', 'order', 'page', 'pageSize', 'view'];
const ASSET_PAGE_DEFAULTS_PAGE = 'projectAssets';
const NSFW_TAG_NORMALIZED_NAME = NSFW_TAG_NAME.toLowerCase();
const ASSET_PRESENTATION_OPTIONS = Object.freeze([
  Object.freeze({ key: 'view', option: 'view' }),
  Object.freeze({ key: 'sort', option: 'sort' }),
  Object.freeze({ key: 'order', option: 'order' }),
  Object.freeze({ key: 'pageSize', option: 'pageSize' }),
]);

// The complete set of hidden fields the browser's filter/scan/bulk forms
// round-trip so a POST can rebuild the exact same normalized GET context.
// Same key set as ASSET_BROWSER_QUERY_KEYS — kept as a separate constant so
// the intent (form field allowlist vs. URL query allowlist) stays clear at
// each call site even though the values are identical today.
const ASSET_BROWSER_CONTEXT_FIELDS = ASSET_BROWSER_QUERY_KEYS;
const ASSET_RENAME_ORIGINS = new Set(['assets', 'viewer']);

const PROJECT_ASSETS_DEFAULT_LABELS = Object.freeze({
  fields: Object.freeze({
    view: 'View',
    sort: 'Sort',
    order: 'Order',
    pageSize: 'Page Size',
  }),
  options: Object.freeze({
    view: Object.freeze({ grid: 'Grid', list: 'List' }),
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

const PROJECT_ASSETS_NOTICES = Object.freeze({
  defaultsSaved: 'Project Assets defaults saved successfully.',
});

const REMOVE_MISSING_ASSETS_ERROR_STATUS = Object.freeze({
  PROJECT_NOT_FOUND: 404,
  PROJECT_ARCHIVED: 409,
  PROJECT_BUSY: 409,
  REMOVE_MISSING_DATABASE_OPERATION_FAILED: 500,
});

const REMOVE_MISSING_ASSETS_ERROR_MESSAGES = Object.freeze({
  PROJECT_ARCHIVED: 'This project is archived and read-only.',
  PROJECT_BUSY: 'Another project operation is already in progress. Try again.',
  REMOVE_MISSING_DATABASE_OPERATION_FAILED: 'Missing asset records could not be removed. Please try again.',
});

const AUTO_RENAME_ERROR_STATUS = Object.freeze({
  [AUTO_RENAME_ERROR_CODES.INVALID_PROJECT_ID]: 404,
  [AUTO_RENAME_ERROR_CODES.PROJECT_NOT_FOUND]: 404,
  [AUTO_RENAME_ERROR_CODES.PROJECT_ARCHIVED]: 409,
  [AUTO_RENAME_ERROR_CODES.CATEGORY_REQUIRED]: 422,
  [AUTO_RENAME_ERROR_CODES.CATEGORY_INVALID]: 422,
  [AUTO_RENAME_ERROR_CODES.CATEGORY_DISABLED]: 409,
  [AUTO_RENAME_ERROR_CODES.CATEGORY_EMPTY]: 422,
  [AUTO_RENAME_ERROR_CODES.ORDER_INVALID]: 422,
  [AUTO_RENAME_ERROR_CODES.PROJECT_BUSY]: 409,
  [AUTO_RENAME_ERROR_CODES.PROJECT_DIRECTORY_UNSAFE]: 500,
  [AUTO_RENAME_ERROR_CODES.DATABASE_ERROR]: 500,
  [AUTO_RENAME_ERROR_CODES.FILESYSTEM_INSPECTION_FAILED]: 500,
  [AUTO_RENAME_ERROR_CODES.FILESYSTEM_OPERATION_FAILED]: 500,
  [AUTO_RENAME_ERROR_CODES.SIGNING_FAILED]: 500,
  [AUTO_RENAME_ERROR_CODES.INVALID_TOKEN]: 409,
  [AUTO_RENAME_ERROR_CODES.STALE_PLAN]: 409,
  [AUTO_RENAME_ERROR_CODES.PLAN_BLOCKED]: 409,
  [AUTO_RENAME_ERROR_CODES.NO_CHANGES]: 409,
  [AUTO_RENAME_ERROR_CODES.AUTO_RENAME_FAILED]: 500,
  [AUTO_RENAME_ERROR_CODES.AUTO_RENAME_RECOVERY_REQUIRED]: 500,
});

const AUTO_RENAME_PREVIEW_MESSAGES = Object.freeze({
  [AUTO_RENAME_ERROR_CODES.CATEGORY_REQUIRED]: 'Choose one concrete category before previewing Auto Rename.',
  [AUTO_RENAME_ERROR_CODES.CATEGORY_INVALID]: 'The selected Auto Rename category is invalid or unavailable.',
  [AUTO_RENAME_ERROR_CODES.CATEGORY_DISABLED]: 'The selected category is disabled and cannot be renamed.',
  [AUTO_RENAME_ERROR_CODES.CATEGORY_EMPTY]: 'The selected category contains no assets to rename.',
  [AUTO_RENAME_ERROR_CODES.ORDER_INVALID]: 'The submitted Auto Rename order must contain every category asset exactly once.',
  [AUTO_RENAME_ERROR_CODES.PROJECT_ARCHIVED]: 'This project is archived and read-only.',
  [AUTO_RENAME_ERROR_CODES.PROJECT_BUSY]: 'Another project operation is already in progress. Try again.',
  [AUTO_RENAME_ERROR_CODES.PROJECT_DIRECTORY_UNSAFE]: 'Auto Rename preview could not access the project directory. Please try again.',
  [AUTO_RENAME_ERROR_CODES.DATABASE_ERROR]: 'Auto Rename preview could not be generated. Please try again.',
  [AUTO_RENAME_ERROR_CODES.FILESYSTEM_INSPECTION_FAILED]: 'Auto Rename preview could not inspect the project files. Please try again.',
  [AUTO_RENAME_ERROR_CODES.FILESYSTEM_OPERATION_FAILED]: 'Auto Rename preview could not inspect the project files. Please try again.',
  [AUTO_RENAME_ERROR_CODES.SIGNING_FAILED]: 'Auto Rename preview could not be generated. Please try again.',
});

const AUTO_RENAME_APPLY_MESSAGES = Object.freeze({
  [AUTO_RENAME_ERROR_CODES.CATEGORY_REQUIRED]: 'The Auto Rename category is no longer available. Review the category again.',
  [AUTO_RENAME_ERROR_CODES.CATEGORY_INVALID]: 'The Auto Rename category is no longer available. Review the category again.',
  [AUTO_RENAME_ERROR_CODES.CATEGORY_DISABLED]: 'The Auto Rename category is now disabled. Review the category again.',
  [AUTO_RENAME_ERROR_CODES.CATEGORY_EMPTY]: 'The Auto Rename category is now empty. Review the category again.',
  [AUTO_RENAME_ERROR_CODES.ORDER_INVALID]: 'The Auto Rename preview order is no longer current. Review the category again.',
  [AUTO_RENAME_ERROR_CODES.PROJECT_ARCHIVED]: 'This project is archived and read-only.',
  [AUTO_RENAME_ERROR_CODES.PROJECT_BUSY]: 'Another project operation is already in progress. Try again.',
  [AUTO_RENAME_ERROR_CODES.PROJECT_DIRECTORY_UNSAFE]: 'Auto Rename could not be applied. Please try again.',
  [AUTO_RENAME_ERROR_CODES.DATABASE_ERROR]: 'Auto Rename could not be applied. Please try again.',
  [AUTO_RENAME_ERROR_CODES.FILESYSTEM_INSPECTION_FAILED]: 'Auto Rename could not be applied. Please try again.',
  [AUTO_RENAME_ERROR_CODES.FILESYSTEM_OPERATION_FAILED]: 'Auto Rename could not be applied. Please try again.',
  [AUTO_RENAME_ERROR_CODES.SIGNING_FAILED]: 'Auto Rename could not be applied. Please try again.',
  [AUTO_RENAME_ERROR_CODES.INVALID_TOKEN]: 'The rename preview is no longer current. Review the selected files again.',
  [AUTO_RENAME_ERROR_CODES.STALE_PLAN]: 'The rename preview is no longer current. Review the selected files again.',
  [AUTO_RENAME_ERROR_CODES.PLAN_BLOCKED]: 'Auto Rename could not be applied because one or more files are blocked.',
  [AUTO_RENAME_ERROR_CODES.NO_CHANGES]: 'Auto Rename has no changes to apply.',
  [AUTO_RENAME_ERROR_CODES.AUTO_RENAME_FAILED]: 'Auto Rename failed. No files were renamed.',
  [AUTO_RENAME_ERROR_CODES.AUTO_RENAME_RECOVERY_REQUIRED]: 'Auto Rename could not fully restore the project files. Review the project directory before trying again.',
});

const AUTO_RENAME_BLOCK_REASON_MESSAGES = Object.freeze({
  missing: 'The file is missing at the last scan or is not present on disk.',
  'unsupported-source': 'The source is not a regular file that can be renamed safely.',
  'invalid-name': 'The generated filename is not safe for this project.',
  uncategorized: 'The asset is not assigned to a category.',
  'category-unavailable': 'The assigned category is no longer available for this project.',
  'category-disabled': 'The assigned category is disabled.',
  'invalid-category': 'The assigned category cannot be used for safe file naming.',
  'duplicate-destination': 'Multiple selected assets would receive the same destination.',
  'database-conflict': 'The generated destination is already recorded for another asset.',
  'case-conflict': 'The generated destination conflicts with an existing path.',
  'filesystem-conflict': 'The generated destination is occupied on disk.',
});
/**
 * Create an assets router mounted at /projects.
 *
 * Routes:
 *   GET  /projects/:id/assets — Asset listing page
 *   GET  /projects/:projectId/assets/:assetId — Asset viewer page
 *   POST /projects/:projectId/assets/:assetId/delete — Permanently delete the viewed asset
 *   POST /projects/:id/scan  — Trigger a manual scan
 *   POST /projects/:id/assets/add-to-release — Bulk-add selected present assets to one release
 *   POST /projects/:id/assets/create-release — Open a release form for selected present assets
 *   POST /projects/:id/assets/move-selected — Batch-move selected present assets to a category
 *   POST /projects/:id/assets/copy-selected — Batch-copy selected present assets to a category
 *   POST /projects/:id/assets/delete-selected — Permanently delete selected present assets
 *   POST /projects/:id/assets/remove-missing — Remove eligible missing asset records
 *   POST /projects/:projectId/assets/auto-rename/preview — Preview Auto Rename
 *   POST /projects/:projectId/assets/auto-rename/apply — Apply a signed Auto Rename plan
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
 * @param {ReturnType<import('../services/auto-rename-service.js').createAutoRenameService>} deps.autoRenameService
 *   Application-scoped Auto Rename planner/executor.
 * @param {Function} [deps.previewProbe]
 *   Application-scoped bounded Krita preview probe used only by the viewer.
 */
export function createAssetsRouter({
  appName,
  db,
  projectService,
  assetScanner,
  workflowQueryService,
  releaseService,
  assetActionService,
  assetBrowserPreferenceService,
  autoRenameService,
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
  if (!autoRenameService || typeof autoRenameService.buildPlan !== 'function'
    || typeof autoRenameService.applyPlan !== 'function') {
    throw new Error('createAssetsRouter requires an autoRenameService dependency.');
  }

  const router = express.Router({ mergeParams: true });

  // GET /projects/:id/assets — Asset listing page
  router.get('/:id/assets', (req, res, next) => {
    try {
      renderProjectAssetsPage(req, res, {
        appName,
        projectService,
        workflowQueryService,
        assetBrowserPreferenceService,
        next,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /projects/:id/assets/remove-missing — Remove only eligible missing
  // asset records. The service owns project mutability, release protection,
  // transactional rechecks, and all database cleanup semantics.
  router.post('/:id/assets/remove-missing', (req, res, next) => {
    try {
      const pageDefaultsService = getPageDefaultsService(req);
      const id = parseId(req.params.id);
      if (id === null) return next(createNotFound());

      const project = projectService.findById(id);
      if (!project) return next(createNotFound());

      let result;
      try {
        result = assetActionService.removeMissingAssets(id);
      } catch (err) {
        return handleRemoveMissingAssetsFailure(err, next);
      }

      return res.redirect(buildAssetsRedirectUrl(
        workflowQueryService,
        id,
        readProjectAssetsReturnQuery(req, id),
        {
          missing_cleanup: 'ok',
          missing_removed: result.removedCount,
          missing_protected: result.protectedCount,
          missing_candidates: result.totalMissingCandidates,
        },
        pageDefaultsService,
      ));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/assets/defaults', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null || !projectService.findById(id)) return next(createNotFound());

    handlePageDefaultsPost(req, res, next, {
      db,
      pageDefaultsService: getPageDefaultsService(req),
      page: ASSET_PAGE_DEFAULTS_PAGE,
      successMessage: PROJECT_ASSETS_NOTICES.defaultsSaved,
      saveErrorMessage: 'Project Assets defaults could not be saved. No changes were made.',
      onValidationError: ({ submittedValues, errors }) => {
        renderProjectAssetsPage(req, res, {
          appName,
          projectService,
          workflowQueryService,
          assetBrowserPreferenceService,
          status: 422,
          projectAssetsDefaultsDialogOpen: true,
          projectAssetsDefaultsSubmittedValues: submittedValues,
          projectAssetsDefaultsErrors: errors,
          rawQuery: readProjectAssetsReturnQuery(req, id),
          allowSavedDefaultsRedirect: false,
        });
      },
      onSuccess: ({ validatedValues }) => {
        res.redirect(buildProjectAssetsDefaultsSuccessUrl(req, id, validatedValues));
      },
    });
  });

  router.post('/:id/assets/nsfw-filter', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null || !projectService.findById(id)) return next(createNotFound());

    const enhanced = isEnhancedAssetRequest(req);
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
      return renderProjectAssetsPage(req, res, {
        appName,
        projectService,
        workflowQueryService,
        assetBrowserPreferenceService,
        status: 422,
        projectAssetsNsfwError: 'NSFW filter setting is invalid.',
        rawQuery: readProjectAssetsReturnQuery(req, id),
        allowSavedDefaultsRedirect: false,
      });
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

    res.redirect(readProjectAssetsNsfwReturnUrl(req, id));
  });

  // POST /projects/:projectId/assets/auto-rename/preview — Build a signed,
  // read-only plan for one complete concrete category. The order is supplied
  // as one strict JSON array and the service remains authoritative for
  // membership and category state.
  router.post('/:projectId/assets/auto-rename/preview', (req, res, next) => {
    try {
      const pageDefaultsService = getPageDefaultsService(req);
      const projectId = parseId(req.params.projectId);
      if (projectId === null) return next(createNotFound());

      const project = projectService.findById(projectId);
      if (!project) return next(createNotFound());

      const body = req.body || {};
      const categoryId = parseCanonicalPositiveId(body.categoryId);
      if (categoryId === null) {
        return renderAutoRenameBrowserError({
          appName,
          project,
          projectId,
          req,
          res,
          next,
          workflowQueryService,
          pageDefaultsService,
          status: AUTO_RENAME_ERROR_STATUS[AUTO_RENAME_ERROR_CODES.CATEGORY_REQUIRED],
          message: AUTO_RENAME_PREVIEW_MESSAGES[AUTO_RENAME_ERROR_CODES.CATEGORY_REQUIRED],
          returnContext: buildAutoRenameReturnContext(body),
        });
      }

      const parsedOrder = parseStrictAutoRenameOrder(body.orderedAssetIds);
      if (!parsedOrder.valid) {
        return renderAutoRenameBrowserError({
          appName,
          project,
          projectId,
          req,
          res,
          next,
          workflowQueryService,
          pageDefaultsService,
          status: AUTO_RENAME_ERROR_STATUS[AUTO_RENAME_ERROR_CODES.ORDER_INVALID],
          message: AUTO_RENAME_PREVIEW_MESSAGES[AUTO_RENAME_ERROR_CODES.ORDER_INVALID],
          returnContext: buildAutoRenameReturnContext({
            ...body,
            categoryId: String(categoryId),
          }),
        });
      }

      try {
        const plan = autoRenameService.buildPlan({
          projectId,
          categoryId,
          orderedAssetIds: parsedOrder.ids,
        });
        const context = buildAutoRenameReturnContext({
          ...body,
          categoryId: String(categoryId),
        });
        return res.render('projects/auto-rename-confirm.njk', {
          appName,
          project,
          plan: buildAutoRenamePlanRenderModel(plan),
          context,
          cancelUrl: buildAssetsRedirectUrl(
            workflowQueryService,
            projectId,
            context,
            {},
            pageDefaultsService,
          ),
        });
      } catch (err) {
        return handleAutoRenameFailure(err, {
          operation: 'preview',
          appName,
          project,
          projectId,
          req,
          res,
          next,
          workflowQueryService,
          pageDefaultsService,
          returnContext: buildAutoRenameReturnContext({
            ...body,
            categoryId: String(categoryId),
          }),
        });
      }
    } catch (err) {
      next(err);
    }
  });

  // POST /projects/:projectId/assets/auto-rename/apply — Apply only the
  // server-recomputed plan represented by the opaque signed token. The route
  // deliberately extracts no destination path or proposed filename from the
  // request.
  router.post('/:projectId/assets/auto-rename/apply', (req, res, next) => {
    try {
      const pageDefaultsService = getPageDefaultsService(req);
      const projectId = parseId(req.params.projectId);
      if (projectId === null) return next(createNotFound());

      const project = projectService.findById(projectId);
      if (!project) return next(createNotFound());

      const body = req.body || {};
      const token = typeof body.planToken === 'string'
        ? body.planToken
        : null;

      let result;
      try {
        result = autoRenameService.applyPlan(projectId, token);
      } catch (err) {
        return handleAutoRenameFailure(err, {
          operation: 'apply',
          appName,
          project,
          projectId,
          req,
          res,
          next,
          workflowQueryService,
          pageDefaultsService,
          returnContext: buildAutoRenameReturnContext(body),
        });
      }

      return res.redirect(buildAssetsRedirectUrl(
        workflowQueryService,
        projectId,
        buildAutoRenameReturnContext(body),
        {
          notice: 'auto-rename-success',
          auto_rename_renamed: result.renamed,
          auto_rename_unchanged: result.unchanged,
        },
        pageDefaultsService,
      ));
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

      const assetTags = getAssetTagsForViewer(req, data.asset.id);

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
        ...buildAssetViewerRenderModel(data, buildPrimaryImageViewerState(data, primaryImage, viewerEligibility), req),
        assetTags,
        notice,
        noticeMessage: notice ? ASSET_ACTION_NOTICE_MESSAGES[notice] : null,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /projects/:projectId/assets/:assetId/delete — Permanently delete
  // the viewed asset from disk and the index through the existing one-lock
  // batch service operation.
  router.post('/:projectId/assets/:assetId/delete', (req, res, next) => {
    try {
      const pageDefaultsService = getPageDefaultsService(req);
      const projectId = parseId(req.params.projectId);
      const assetId = parseId(req.params.assetId);
      if (projectId === null || assetId === null) {
        return next(createNotFound());
      }

      try {
        assetActionService.deleteAssets(projectId, [assetId]);
      } catch (err) {
        return handleAssetActionFailure(err, {
          appName, workflowQueryService, projectPrimaryImageService, req, res, next,
          projectId, assetId, action: 'delete',
        });
      }

      return res.redirect(buildAssetsRedirectUrl(
        workflowQueryService,
        projectId,
        req.body,
        { assets_deleted: 1 },
        pageDefaultsService,
      ));
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
      const pageDefaultsService = getPageDefaultsService(req);
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
          pageDefaultsService,
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
          pageDefaultsService,
          project, projectId, assetId, action: 'rename', origin,
          submittedFilename: typeof filename === 'string' ? filename : '',
        });
      }

      const redirectUrl = origin === 'assets'
        ? buildAssetsRedirectUrl(
          workflowQueryService,
          projectId,
          req.body,
          { notice: 'asset-renamed' },
          pageDefaultsService,
        )
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
      const pageDefaultsService = getPageDefaultsService(req);
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
        return res.redirect(buildAssetsRedirectUrl(
          workflowQueryService,
          id,
          req.body,
          { scan_error: 'archived' },
          pageDefaultsService,
        ));
      }

      const result = assetScanner.scanProjectAssets(id);

      // Scanner field is `removed`; the user-facing label is `Missing` —
      // CreatorCrate never deletes files merely because a scan no longer
      // finds them, so the redirect/template vocabulary avoids "removed".
      res.redirect(buildAssetsRedirectUrl(
        workflowQueryService,
        id,
        req.body,
        {
          scan_result: 'ok',
          added: result.added,
          updated: result.updated,
          missing: result.removed,
          total: result.total,
        },
        pageDefaultsService,
      ));
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
      const pageDefaultsService = getPageDefaultsService(req);
      res.redirect(buildAssetsRedirectUrl(
        workflowQueryService,
        id,
        req.body,
        { scan_error: 'filesystem' },
        pageDefaultsService,
      ));
    }
  });

  // POST /projects/:id/assets/add-to-release — Bulk-add selected present
  // assets (from the current page-local selection) to one mutable release.
  // Delegates all validation and mutation to releaseService.addAssetsToRelease
  // — this route never touches the repository or reimplements mutability
  // rules.
  router.post('/:id/assets/add-to-release', (req, res, next) => {
    try {
      const pageDefaultsService = getPageDefaultsService(req);
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

      res.redirect(buildAssetsRedirectUrl(
        workflowQueryService,
        id,
        req.body,
        {
          bulk_added: result.added,
          bulk_already: result.alreadyAssociated,
        },
        pageDefaultsService,
      ));
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
          const pageDefaultsService = getPageDefaultsService(req);
          const presentation = resolveAssetBrowserPresentation(req.body, pageDefaultsService);
          const data = buildAssetBrowserPageData(workflowQueryService, id, project, presentation);
          if (!data) return next(createNotFound());

          const normalizedSelection = normalizeSelectedAssetIds(req.body.selectedAssetIds);
          const submittedReleaseId = typeof req.body.releaseId === 'string' ? req.body.releaseId : '';

          return res.status(status).render('projects/assets.njk', {
            appName,
            ...buildBrowserRenderModel(project, data, pageDefaultsService, req),
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

  // POST /projects/:id/assets/create-release — Open the normal release-create
  // form with the selected present assets carried forward. This intermediate
  // route validates only; release creation and asset association remain owned
  // by their existing later flows.
  router.post('/:id/assets/create-release', (req, res, next) => {
    const body = req.body || {};

    try {
      const id = parseId(req.params.id);
      if (id === null) {
        return next(createNotFound());
      }

      const project = projectService.findById(id);
      if (!project) {
        return next(createNotFound());
      }

      const normalizedSelection = normalizeSelectedAssetIds(body.selectedAssetIds);
      if (!normalizedSelection.valid) {
        throw new ReleaseValidationError({ assetIds: 'Invalid asset selection format.' });
      }

      const selectedAssetIds = releaseService.validateAndNormalizeSelectedAssetIds(
        id,
        normalizedSelection.ids,
      );

      return res.render('releases/form.njk', buildCreateReleaseFormModel({
        appName,
        projectService,
        values: {
          projectId: String(id),
          selectedAssetIds: selectedAssetIds.map(String),
        },
        errors: {},
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

      const status = err instanceof ReleaseValidationError
        ? 422
        : (typeof err.status === 'number' ? err.status : null);

      if (status !== null) {
        try {
          const pageDefaultsService = getPageDefaultsService(req);
          const presentation = resolveAssetBrowserPresentation(body, pageDefaultsService);
          const data = buildAssetBrowserPageData(workflowQueryService, id, project, presentation);
          if (!data) return next(createNotFound());

          const normalizedSelection = normalizeSelectedAssetIds(body.selectedAssetIds);
          return res.status(status).render('projects/assets.njk', {
            appName,
            ...buildBrowserRenderModel(project, data, pageDefaultsService, req),
            query: {},
            error: null,
            archivedError: null,
            bulkNotice: null,
            bulkError: { message: describeBulkError(err) },
            submittedSelectedAssetIds: normalizedSelection.valid ? normalizedSelection.ids : [],
            submittedReleaseId: null,
          });
        } catch (renderErr) {
          return next(renderErr);
        }
      }

      return next(err);
    }
  });

  // POST /projects/:id/assets/move-selected — Batch-move selected present
  // assets to one category or Uncategorized. All validation (asset presence,
  // destination validity, intra-batch conflicts) runs inside the service under
  // one project lock. The route only extracts and type-checks form fields.
  router.post('/:id/assets/move-selected', (req, res, next) => {
    try {
      const pageDefaultsService = getPageDefaultsService(req);
      const id = parseId(req.params.id);
      if (id === null) return next(createNotFound());

      const project = projectService.findById(id);
      if (!project) return next(createNotFound());

      const normalizedSelection = normalizeSelectedAssetIds(req.body.selectedAssetIds);
      const rawDestination = req.body.destinationCategory;
      const parsedDestination = parseDestinationCategoryField(rawDestination);

      const renderMoveError = (status, message, selectedIds = []) => {
        try {
          const presentation = resolveAssetBrowserPresentation(req.body, pageDefaultsService);
          const data = buildAssetBrowserPageData(workflowQueryService, id, project, presentation);
          if (!data) return next(createNotFound());
          return res.status(status).render('projects/assets.njk', {
            appName,
            ...buildBrowserRenderModel(project, data, pageDefaultsService, req),
            query: {},
            error: null,
            archivedError: null,
            bulkNotice: null,
            moveNotice: null,
            copyNotice: null,
            bulkMoveError: { message },
            copyError: null,
            submittedSelectedAssetIds: selectedIds,
            submittedDestinationCategory: typeof rawDestination === 'string' ? rawDestination : '',
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

      res.redirect(buildAssetsRedirectUrl(
        workflowQueryService,
        id,
        req.body,
        { assets_moved: result.movedCount },
        pageDefaultsService,
      ));
    } catch (err) {
      next(err);
    }
  });

  // POST /projects/:id/assets/copy-selected — Batch-copy selected present
  // assets to one category or Uncategorized. The route mirrors Move's strict
  // form parsing and browser-context handling; the service owns all project,
  // filesystem, lock, and indexed-row validation.
  router.post('/:id/assets/copy-selected', (req, res, next) => {
    try {
      const pageDefaultsService = getPageDefaultsService(req);
      const id = parseId(req.params.id);
      if (id === null) return next(createNotFound());

      const project = projectService.findById(id);
      if (!project) return next(createNotFound());

      const normalizedSelection = normalizeSelectedAssetIds(req.body.selectedAssetIds);
      const rawDestination = req.body.destinationCategory;
      const parsedDestination = parseDestinationCategoryField(rawDestination);
      const submittedDestinationCategory = typeof rawDestination === 'string' ? rawDestination : '';

      const renderCopyError = (status, message, selectedIds = []) => {
        try {
          const presentation = resolveAssetBrowserPresentation(req.body, pageDefaultsService);
          const data = buildAssetBrowserPageData(workflowQueryService, id, project, presentation);
          if (!data) return next(createNotFound());
          return res.status(status).render('projects/assets.njk', {
            appName,
            ...buildBrowserRenderModel(project, data, pageDefaultsService, req),
            query: {},
            error: null,
            archivedError: null,
            bulkNotice: null,
            moveNotice: null,
            copyNotice: null,
            bulkMoveError: null,
            copyError: { message },
            submittedSelectedAssetIds: selectedIds,
            submittedDestinationCategory,
          });
        } catch (renderErr) {
          return next(renderErr);
        }
      };

      if (!normalizedSelection.valid) {
        return renderCopyError(422, 'Invalid asset selection.');
      }

      if (normalizedSelection.ids.length === 0) {
        return renderCopyError(422, 'Select at least one asset to copy.');
      }

      if (!parsedDestination.ok) {
        return renderCopyError(422, 'Choose a valid destination category.', normalizedSelection.ids);
      }

      const assetIds = [];
      for (const idStr of normalizedSelection.ids) {
        const assetId = parseId(idStr);
        if (assetId === null) {
          return renderCopyError(422, 'Invalid asset selection.');
        }
        assetIds.push(assetId);
      }

      let result;
      try {
        result = assetActionService.copyAssets(id, assetIds, parsedDestination.value);
      } catch (err) {
        const code = err && err.code;
        const status = COPY_ASSET_ACTION_ERROR_STATUS[code];
        if (status === undefined) return next(err);
        if (status === 404) return next(createNotFound());
        return renderCopyError(status, describeBatchCopyError(err), normalizedSelection.ids);
      }

      return res.redirect(buildAssetsRedirectUrl(
        workflowQueryService,
        id,
        req.body,
        { assets_copied: result.copiedCount },
        pageDefaultsService,
      ));
    } catch (err) {
      next(err);
    }
  });

  // POST /projects/:id/assets/delete-selected — Permanently delete selected
  // present assets from disk and the index. The locked service owns all
  // validation, staging, rollback, cascade, and published-release policy.
  router.post('/:id/assets/delete-selected', (req, res, next) => {
    try {
      const pageDefaultsService = getPageDefaultsService(req);
      const id = parseId(req.params.id);
      if (id === null) return next(createNotFound());

      const project = projectService.findById(id);
      if (!project) return next(createNotFound());

      const body = req.body || {};
      const normalizedSelection = normalizeSelectedAssetIds(body.selectedAssetIds);
      const submittedReleaseId = typeof body.releaseId === 'string' ? body.releaseId : '';
      const submittedDestinationCategory = typeof body.destinationCategory === 'string'
        ? body.destinationCategory
        : '';

      const renderDeleteError = (status, message, selectedIds = []) => {
        try {
          const presentation = resolveAssetBrowserPresentation(body, pageDefaultsService);
          const data = buildAssetBrowserPageData(workflowQueryService, id, project, presentation);
          if (!data) return next(createNotFound());
          return res.status(status).render('projects/assets.njk', {
            appName,
            ...buildBrowserRenderModel(project, data, pageDefaultsService, req),
            query: {},
            error: null,
            archivedError: null,
            bulkNotice: null,
            moveNotice: null,
            copyNotice: null,
            deleteNotice: null,
            bulkMoveError: null,
            copyError: null,
            deleteError: { message },
            submittedSelectedAssetIds: selectedIds,
            submittedReleaseId,
            submittedDestinationCategory,
          });
        } catch (renderErr) {
          return next(renderErr);
        }
      };

      if (!normalizedSelection.valid) {
        return renderDeleteError(422, 'Invalid asset selection.');
      }

      if (normalizedSelection.ids.length === 0) {
        return renderDeleteError(422, 'Select at least one asset to delete.');
      }

      const assetIds = [];
      for (const idStr of normalizedSelection.ids) {
        const assetId = parseId(idStr);
        if (assetId === null) {
          return renderDeleteError(422, 'Invalid asset selection.', normalizedSelection.ids);
        }
        assetIds.push(assetId);
      }

      let result;
      try {
        result = assetActionService.deleteAssets(id, assetIds);
      } catch (err) {
        const code = err && err.code;
        const status = DELETE_ASSET_ACTION_ERROR_STATUS[code];
        if (status === undefined) return next(err);
        if (status === 404) return next(createNotFound());
        return renderDeleteError(status, describeBatchDeleteError(err), normalizedSelection.ids);
      }

      return res.redirect(buildAssetsRedirectUrl(
        workflowQueryService,
        id,
        body,
        { assets_deleted: result.deletedCount },
        pageDefaultsService,
      ));
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

function renderProjectAssetsPage(req, res, {
  appName,
  projectService,
  workflowQueryService,
  assetBrowserPreferenceService,
  status = 200,
  rawQuery = null,
  projectAssetsDefaultsDialogOpen = req.query?.defaults === '1',
  removeMissingAssetsDialogOpen = req.query?.remove_missing === '1',
  projectAssetsDefaultsSubmittedValues = null,
  projectAssetsDefaultsErrors = {},
  projectAssetsNsfwError = null,
  allowSavedDefaultsRedirect = true,
  next,
} = {}) {
  const id = parseId(req.params.id);
  if (id === null) return next ? next(createNotFound()) : null;

  const project = projectService.findById(id);
  if (!project) return next ? next(createNotFound()) : null;

  const pageDefaultsService = getPageDefaultsService(req);
  const query = rawQuery && typeof rawQuery === 'object'
    ? rawQuery
    : (req.query && typeof req.query === 'object' ? req.query : {});
  const presentation = resolveAssetBrowserPresentation(query, pageDefaultsService);

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
      ));
    }

    if (hasNonFallbackAssetPresentation(presentation, pageDefaultsService)) {
      return res.redirect(buildAssetDefaultsRedirectUrl(
        id,
        null,
        presentation,
        pageDefaultsService,
      ));
    }
  }

  const data = buildAssetBrowserPageData(workflowQueryService, id, project, presentation);
  if (!data) return next ? next(createNotFound()) : null;

  const nsfwFilterEnabled = getNsfwFilterSettingsService(req).isEnabled();
  const renderModel = buildBrowserRenderModel(project, data, pageDefaultsService, req, nsfwFilterEnabled);
  const pageUrl = renderModel.pageUrl({});
  const defaultsUrl = appendQueryValue(pageUrl, 'defaults', '1');
  const queryNotice = buildProjectAssetsQueryNotice(query);

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
    projectAssetsDefaults: buildPageDefaultsDialogModel({
      pageDefaultsService,
      page: ASSET_PAGE_DEFAULTS_PAGE,
      labels: PROJECT_ASSETS_DEFAULT_LABELS,
      submittedValues: projectAssetsDefaultsSubmittedValues,
      errors: projectAssetsDefaultsErrors,
    }),
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

function handleRemoveMissingAssetsFailure(err, next) {
  const code = err && err.code;
  const status = code ? REMOVE_MISSING_ASSETS_ERROR_STATUS[code] : undefined;
  if (status === undefined) return next(err);
  if (status === 404) return next(createNotFound());

  const controlled = new Error(
    REMOVE_MISSING_ASSETS_ERROR_MESSAGES[code]
      || 'Missing asset records could not be removed. Please try again.'
  );
  controlled.status = status;
  return next(controlled);
}

function appendQueryValue(pathname, key, value) {
  const url = new URL(pathname, 'http://creatorcrate.local');
  url.searchParams.set(key, value);
  return `${url.pathname}?${url.searchParams.toString()}`;
}

function getNsfwFilterSettingsService(req) {
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

function isEnhancedAssetRequest(req) {
  return String(req.get?.('Accept') || '').toLowerCase().includes('application/json');
}

function readProjectAssetsReturnUrl(req, projectId) {
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

function readProjectAssetsReturnQuery(req, projectId) {
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

function buildProjectAssetsDefaultsSuccessUrl(req, projectId, values) {
  const url = new URL(readProjectAssetsReturnUrl(req, projectId), 'http://creatorcrate.local');
  Object.entries(values || {}).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  url.searchParams.set('notice', 'project_assets_defaults_saved');
  return `${url.pathname}?${url.searchParams.toString()}`;
}

function readProjectAssetsNsfwReturnUrl(req, projectId) {
  return readProjectAssetsReturnUrl(req, projectId);
}

function getPageDefaultsService(req) {
  const service = req.app?.locals?.pageDefaultsService;
  if (!service) {
    throw new Error('Project Assets requires app.locals.pageDefaultsService.');
  }
  return service;
}

function getOpenLocallySettingsService(req) {
  const service = req.app?.locals?.openLocallySettingsService;
  if (!service) {
    throw new Error('Assets routes require app.locals.openLocallySettingsService.');
  }
  return service;
}

function getAssetTagService(req) {
  const service = req.app?.locals?.assetTagService;
  if (!service) {
    throw new Error('Asset Viewer requires app.locals.assetTagService.');
  }
  return service;
}

function getAssetTagsForViewer(req, assetId) {
  return getAssetTagService(req)
    .listAssetTags(assetId)
    .map((tag) => ({ displayName: tag.display_name }));
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

function resolveAssetBrowserPresentation(rawQuery, pageDefaultsService) {
  const safeRawQuery = rawQuery && typeof rawQuery === 'object' ? rawQuery : {};
  const query = { ...safeRawQuery };
  const saved = {};
  const forceFallback = {};

  for (const { key, option } of ASSET_PRESENTATION_OPTIONS) {
    const fallback = pageDefaultsService.getFallback(ASSET_PAGE_DEFAULTS_PAGE, option);
    const savedValue = pageDefaultsService.resolve(ASSET_PAGE_DEFAULTS_PAGE, option);
    const isExplicit = Object.hasOwn(safeRawQuery, key);
    const explicitValue = safeRawQuery[key];
    const resolvedValue = key === 'pageSize'
      ? (isExplicit
        ? parseAssetBrowserPageSize(explicitValue, fallback)
        : Number(savedValue))
      : (isExplicit
        ? pageDefaultsService.resolve(ASSET_PAGE_DEFAULTS_PAGE, option, explicitValue)
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

function buildAssetDefaultsRedirectUrl(projectId, categoryId, presentation, pageDefaultsService) {
  const context = {
    category: categoryId === null ? 'all' : String(categoryId),
    categoryWasSupplied: categoryId !== null,
    categorySelection: categoryId === null ? undefined : 'explicit-specific',
    queryWasNonBare: false,
    sort: presentation.saved.sort,
    order: presentation.saved.order,
    page: 1,
    pageSize: presentation.saved.pageSize,
    view: presentation.saved.view,
  };
  const query = buildCanonicalAssetBrowserQuery(context, 1);
  appendForcedAssetPresentationQuery(query, context, presentation, {}, pageDefaultsService);
  const search = buildAssetBrowserQueryString(query);
  return search ? `/projects/${projectId}/assets?${search}` : `/projects/${projectId}/assets`;
}

function appendForcedAssetPresentationQuery(
  query,
  context,
  presentation,
  overrides,
  pageDefaultsService,
) {
  if (!pageDefaultsService) return;

  const metadata = presentation || context?.assetPresentation || {};
  const rawOverrides = overrides && typeof overrides === 'object' ? overrides : {};

  for (const { key, option } of ASSET_PRESENTATION_OPTIONS) {
    const fallback = pageDefaultsService.getFallback(ASSET_PAGE_DEFAULTS_PAGE, option);
    const saved = metadata.saved?.[key] ?? pageDefaultsService.resolve(ASSET_PAGE_DEFAULTS_PAGE, option);
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
    );
    const search = buildAssetBrowserQueryString(query);
    return search ? `${basePath}?${search}` : basePath;
  };
}

/**
 * Render-model fields shared by the GET browser route and any POST route
 * that re-renders the same template (e.g. bulk-add or asset-action failure).
 * Centralizing this keeps both call sites in sync as the browser model grows.
 */
function buildBrowserRenderModel(project, data, pageDefaultsService, req, nsfwFilterEnabled = null) {
  const effectiveNsfwFilterEnabled = nsfwFilterEnabled === null
    ? Boolean(req?.app?.locals?.nsfwFilterSettingsService?.isEnabled?.())
    : nsfwFilterEnabled;
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
    emptyState: data.emptyState,
    isArchived: data.isArchived,
    releaseTargets: data.releaseTargets,
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
    }),
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

function buildAssetBrowserPageData(
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
function buildCanonicalContextQuery(
  workflowQueryService,
  projectId,
  rawContext,
  extraQuery = {},
  pageDefaultsService = null,
) {
  const presentation = pageDefaultsService
    ? resolveAssetBrowserPresentation(rawContext, pageDefaultsService)
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
  appendForcedAssetPresentationQuery(query, context, presentation, {}, pageDefaultsService);
  for (const [key, value] of Object.entries(extraQuery)) {
    if (value === undefined || value === null || value === '') continue;
    query[key] = String(value);
  }
  return query;
}

function buildAssetsRedirectUrl(
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

function parseCanonicalPositiveId(raw) {
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseStrictAutoRenameOrder(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { valid: false, ids: [] };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, ids: [] };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return { valid: false, ids: [] };

  const ids = [];
  const seen = new Set();
  for (const value of parsed) {
    if (!Number.isSafeInteger(value) || value <= 0 || seen.has(value)) {
      return { valid: false, ids: [] };
    }
    seen.add(value);
    ids.push(value);
  }
  return { valid: true, ids };
}

function buildAutoRenameReturnContext(rawContext = {}) {
  const context = {};
  const categoryId = parseCanonicalPositiveId(rawContext.categoryId);
  if (categoryId !== null) context.category = String(categoryId);
  const tagId = parseCanonicalPositiveId(rawContext.tag);
  if (tagId !== null) context.tag = String(tagId);
  if (rawContext.view === 'list' || rawContext.view === 'grid') context.view = rawContext.view;
  return context;
}

function safeDisplayRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) return '—';
  if (
    value.startsWith('/')
    || value.startsWith('\\')
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.split(/[\\/]/).some((segment) => segment === '..')
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return 'Unavailable';
  }
  return value;
}

function safeDisplayOptionalRelativePath(value) {
  if (value === null || value === undefined || value === '') return null;
  const display = safeDisplayRelativePath(value);
  return display === '—' ? null : display;
}

function safeDisplayFilename(value) {
  if (typeof value !== 'string' || value.length === 0) return '—';
  if (
    value.includes('/')
    || value.includes('\\')
    || value === '.'
    || value === '..'
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return 'Unavailable';
  }
  return value;
}

function extensionFromFilename(filename) {
  if (typeof filename !== 'string') return '';
  const dot = filename.lastIndexOf('.');
  return dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLowerCase() : '';
}

function buildAutoRenameItemPreviewModel(projectId, item) {
  const extension = typeof item.extension === 'string' && item.extension.length > 0
    ? item.extension.toLowerCase()
    : extensionFromFilename(item.currentFilename);
  const typeLabel = extension ? extension.toUpperCase() : 'File';
  const present = item.presenceState === 'present'
    || item.isPresent === true
    || item.is_present === 1
    || item.is_present === true;

  if (!present || item.reason === 'missing' || item.reason === 'unsupported-source') {
    return {
      thumbnailUrl: null,
      previewKind: null,
      previewState: 'missing',
      previewRevision: null,
      typeLabel,
    };
  }

  const classification = classifyPreviewable({
    extension,
    mime_type: item.mimeType ?? item.mime_type,
  });
  if (!classification.supported) {
    return {
      thumbnailUrl: null,
      previewKind: null,
      previewState: 'unsupported',
      previewRevision: null,
      typeLabel,
    };
  }

  const revision = buildAssetRevisionToken({
    project_id: projectId,
    id: item.assetId,
    relative_path: item.currentRelativePath,
    size_bytes: item.sizeBytes ?? item.size_bytes,
    modified_at: item.modifiedAt ?? item.modified_at,
  });
  const query = revision ? new URLSearchParams({ v: revision }).toString() : null;

  return {
    thumbnailUrl: query
      ? `/projects/${projectId}/assets/${item.assetId}/thumbnail?${query}`
      : null,
    previewKind: classification.kind,
    previewState: 'previewable',
    previewRevision: revision,
    typeLabel,
  };
}

function categoryGroupKey(item) {
  if (Number.isSafeInteger(item.categoryId) && item.categoryId > 0) {
    return `category:${item.categoryId}`;
  }
  return item.reason === 'uncategorized' ? 'uncategorized' : 'unavailable-category';
}

function categoryGroupLabel(item) {
  if (typeof item.categoryDisplayName === 'string' && item.categoryDisplayName.length > 0) {
    return item.categoryDisplayName;
  }
  if (item.reason === 'uncategorized') return 'Uncategorized';
  return 'Unavailable category';
}

export function buildAutoRenamePlanRenderModel(plan) {
  const sourceItems = Array.isArray(plan?.items) ? plan.items : [];
  const sourceItemsById = new Map(sourceItems.map((item) => [item.assetId, item]));
  const items = sourceItems.map((item) => {
    const blockedReason = item.status === 'blocked'
      ? (AUTO_RENAME_BLOCK_REASON_MESSAGES[item.reason] || 'This asset cannot be renamed safely.')
      : null;
    const preview = buildAutoRenameItemPreviewModel(plan.projectId, item);
    return {
      assetId: item.assetId,
      categoryId: item.categoryId ?? null,
      categoryDisplayName: item.categoryDisplayName ?? null,
      categoryDirectorySlug: safeDisplayOptionalRelativePath(item.categoryDirectorySlug),
      currentRelativePath: safeDisplayRelativePath(item.currentRelativePath),
      proposedRelativePath: safeDisplayRelativePath(item.proposedRelativePath),
      currentFilename: safeDisplayFilename(item.currentFilename),
      proposedFilename: safeDisplayFilename(item.proposedFilename),
      status: item.status,
      statusLabel: item.status === 'rename'
        ? 'Rename'
        : item.status === 'unchanged'
          ? 'Unchanged'
          : 'Blocked',
      blockedReason,
      // Keep the existing confirmation template compatible until chunk 4
      // switches it to the grouped model's explicit blockedReason field.
      reason: blockedReason,
      thumbnailUrl: preview.thumbnailUrl,
      previewKind: preview.previewKind,
      previewState: preview.previewState,
      previewRevision: preview.previewRevision,
      typeLabel: preview.typeLabel,
    };
  });

  const groupsByKey = new Map();
  for (const item of items) {
    const sourceItem = sourceItemsById.get(item.assetId) || {};
    const key = categoryGroupKey(sourceItem);
    if (!groupsByKey.has(key)) {
      groupsByKey.set(key, {
        categoryId: item.categoryId,
        categoryDisplayName: categoryGroupLabel(sourceItem),
        categoryDirectorySlug: item.categoryDirectorySlug,
        items: [],
      });
    }
    const group = groupsByKey.get(key);
    group.items.push({
      ...item,
      position: group.items.length + 1,
      groupSize: 0,
    });
  }

  const categoryGroups = [...groupsByKey.values()].map((group) => ({
    ...group,
    items: group.items.map((item) => ({ ...item, groupSize: group.items.length })),
  }));

  return {
    ...(plan || {}),
    orderedAssetIds: Array.isArray(plan?.orderedAssetIds)
      ? [...plan.orderedAssetIds]
      : items.map((item) => item.assetId),
    items,
    categoryGroups,
  };
}

function renderAutoRenameBrowserError({
  appName,
  project,
  projectId,
  req,
  res,
  next,
  workflowQueryService,
  pageDefaultsService,
  status,
  message,
  returnContext,
}) {
  if (status === 404) return next(createNotFound());

  let data;
  try {
    const presentation = resolveAssetBrowserPresentation(returnContext || {}, pageDefaultsService);
    data = buildAssetBrowserPageData(workflowQueryService, projectId, project, presentation);
  } catch {
    const fallback = new Error('Auto Rename could not be completed. Please try again.');
    fallback.status = 500;
    return next(fallback);
  }
  if (!data) return next(createNotFound());

  return res.status(status).render('projects/assets.njk', {
    appName,
    ...buildBrowserRenderModel(project, data, pageDefaultsService, req),
    query: {},
    error: null,
    archivedError: null,
    bulkNotice: null,
    moveNotice: null,
    assetActionNotice: null,
    autoRenameNotice: null,
    autoRenameError: { message },
    submittedSelectedAssetIds: [],
    submittedReleaseId: null,
  });
}

function handleAutoRenameFailure(err, {
  operation,
  appName,
  project,
  projectId,
  req,
  res,
  next,
  workflowQueryService,
  pageDefaultsService,
  returnContext,
}) {
  const code = err && err.code;
  const status = code ? AUTO_RENAME_ERROR_STATUS[code] : undefined;
  if (status === 404) return next(createNotFound());

  const messages = operation === 'preview' ? AUTO_RENAME_PREVIEW_MESSAGES : AUTO_RENAME_APPLY_MESSAGES;
  const message = messages[code]
    || (operation === 'preview'
      ? 'Auto Rename preview could not be generated. Please try again.'
      : 'Auto Rename could not be applied. Please try again.');

  return renderAutoRenameBrowserError({
    appName,
    project,
    projectId,
    req,
    res,
    next,
    workflowQueryService,
    pageDefaultsService,
    status: status || 500,
    message,
    returnContext,
  });
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
  const search = buildAssetBrowserQueryString(query);
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
  'asset_tags_updated',
]);

const ASSET_ACTION_NOTICE_MESSAGES = {
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

const COPY_ASSET_ACTION_ERROR_STATUS = {
  COPY_PRECHECK_FAILED: 422,
  COPY_DESTINATION_CONFLICT: 409,
  COPY_DUPLICATE_DESTINATION: 409,
  COPY_FILESYSTEM_OPERATION_FAILED: 500,
  COPY_RECOVERY_REQUIRED: 500,
  PROJECT_NOT_FOUND: 404,
  PROJECT_ARCHIVED: 409,
  PROJECT_BUSY: 409,
  PROJECT_DIRECTORY_UNSAFE: 500,
};

const COPY_ASSET_ACTION_ERROR_MESSAGES = {
  COPY_PRECHECK_FAILED: 'One or more selected assets cannot be copied to that destination.',
  COPY_DESTINATION_CONFLICT: 'Destination already exists for one or more selected assets.',
  COPY_DUPLICATE_DESTINATION: 'Two or more selected assets have the same filename and would conflict at the destination.',
  COPY_FILESYSTEM_OPERATION_FAILED: 'The selected files could not be copied. No copied files were retained.',
  COPY_RECOVERY_REQUIRED: 'Files were copied, but CreatorCrate could not safely finish or clean up the batch. Inspect the project folder before scanning.',
  PROJECT_ARCHIVED: 'This project is archived and read-only.',
  PROJECT_BUSY: 'Another project operation is already in progress. Try again.',
  PROJECT_DIRECTORY_UNSAFE: 'The operation could not be completed. Please try again.',
};

function describeBatchCopyError(err) {
  const code = err && err.code;
  return COPY_ASSET_ACTION_ERROR_MESSAGES[code] || 'The copy operation could not be completed.';
}

const DELETE_ASSET_ACTION_ERROR_STATUS = {
  NO_ASSETS_SELECTED: 422,
  INVALID_ASSET_SELECTION: 422,
  DELETE_PUBLISHED_RELEASE_ASSET: 409,
  DELETE_PRECHECK_FAILED: 422,
  DELETE_FILESYSTEM_OPERATION_FAILED: 500,
  DELETE_DATABASE_OPERATION_FAILED: 500,
  DELETE_RECOVERY_REQUIRED: 500,
  PROJECT_NOT_FOUND: 404,
  PROJECT_ARCHIVED: 409,
  PROJECT_BUSY: 409,
  PROJECT_DIRECTORY_UNSAFE: 500,
};

const DELETE_ASSET_ACTION_ERROR_MESSAGES = {
  NO_ASSETS_SELECTED: 'Select at least one asset to delete.',
  INVALID_ASSET_SELECTION: 'Invalid asset selection.',
  DELETE_PUBLISHED_RELEASE_ASSET: 'One or more selected assets are associated with a published release and cannot be deleted.',
  DELETE_PRECHECK_FAILED: 'One or more selected assets cannot be deleted.',
  DELETE_FILESYSTEM_OPERATION_FAILED: 'The selected files could not be deleted. No selected files were removed.',
  DELETE_DATABASE_OPERATION_FAILED: 'The selected files were restored because CreatorCrate could not remove all indexed asset records.',
  DELETE_RECOVERY_REQUIRED: 'Deletion could not be completed safely. Inspect the project folder before scanning.',
  PROJECT_ARCHIVED: 'This project is archived and read-only.',
  PROJECT_BUSY: 'Another project operation is already in progress. Try again.',
  PROJECT_DIRECTORY_UNSAFE: 'The operation could not be completed. Please try again.',
};

function describeBatchDeleteError(err) {
  const code = err && err.code;
  return DELETE_ASSET_ACTION_ERROR_MESSAGES[code] || 'The delete operation could not be completed.';
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

  // Permanent deletion reuses the same viewer failure renderer as rename and
  // move, but its service exposes batch-specific codes.
  ...DELETE_ASSET_ACTION_ERROR_STATUS,
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

  // Keep these fixed and path-free: service messages can contain asset IDs or
  // filesystem details that must never be rendered directly by the route.
  ...DELETE_ASSET_ACTION_ERROR_MESSAGES,
};

/**
 * Fixed, concise user-facing message for a known asset-action error code.
 * UNCHANGED_LOCATION reads differently for rename vs. move — every other
 * code's message is action-independent.
 * @param {string} code
 * @param {'rename'|'move'|'delete'} action
 * @returns {string}
 */
function describeAssetActionError(code, action) {
  if (code === 'UNCHANGED_LOCATION') {
    return action === 'move' ? 'That destination is unchanged.' : 'That filename is unchanged.';
  }
  if (action === 'delete' && code === 'DELETE_PUBLISHED_RELEASE_ASSET') {
    return 'This asset is associated with a published release and cannot be permanently deleted.';
  }
  if (action === 'delete' && (code === 'DELETE_PRECHECK_FAILED' || code === 'ASSET_MISSING')) {
    return 'This asset cannot be deleted because it is missing or inaccessible.';
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
 * Build the Assets-page model with the complete category ordering surface for
 * default numeric-category controls, and the ordinary browser surface when a
 * numeric category request uses meaningful search or non-default sorting.
 */
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

function hasNonDefaultCategoryBrowserControls(rawQuery = {}) {
  return (
    (typeof rawQuery.search === 'string' && rawQuery.search.trim() !== '')
    || rawQuery.sort === 'modified'
    || rawQuery.sort === 'size'
    || rawQuery.sort === 'category'
    || rawQuery.order === 'desc'
  );
}

/**
 * Shared render-model fields for the asset viewer — used by the GET route
 * and by every controlled-failure re-render, so both stay in sync as the
 * viewer model grows. `overrides` layers success/failure-specific fields
 * (notice, formError, submitted form values) over the defaults.
 * @param {object} data - workflowQueryService.getProjectAssetViewer(...) result
 * @param {object} [overrides]
 */
function buildAssetViewerRenderModel(data, overrides = {}, req) {
  return {
    project: data.project,
    asset: data.asset,
    assetTags: [],
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
    canManageTags: !data.project.archived_at && data.project.status !== 'archived',
    openLocallyUri: buildOpenLocallyUri({
      windowsRoot: req ? getOpenLocallySettingsService(req).getWindowsProjectsPath() : null,
      projectDir: data.project.project_dir,
      assetRelativePath: data.asset.relative_path,
    }),
    notice: null,
    noticeMessage: null,
    formError: null,
    submittedFilename: data.asset.filename,
    submittedDestinationCategory: data.asset.category_id != null ? String(data.asset.category_id) : 'uncategorized',
    ...overrides,
  };
}

/**
 * Map a rename/move/delete failure to a controlled HTTP response.
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
 * @param {'rename'|'move'|'delete'} ctx.action
 * @param {'assets'|'viewer'} [ctx.origin]
 * @param {string} [ctx.submittedFilename]
 * @param {string} [ctx.submittedDestinationCategory]
 */
function handleAssetActionFailure(err, {
  appName, workflowQueryService, projectPrimaryImageService, req, res, next,
  pageDefaultsService,
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
      pageDefaultsService,
      project, projectId, assetId, action, submittedFilename,
    });
  }

  if (status === 404) {
    return next(createNotFound());
  }

  let data;
  let primaryImageState;
  let assetTags;
  try {
    data = workflowQueryService.getProjectAssetViewer(projectId, assetId, req.body);
    if (data) {
      primaryImageState = buildPrimaryImageViewerState(
        data,
        projectPrimaryImageService.getPrimaryImage(projectId),
      );
      assetTags = getAssetTagsForViewer(req, data.asset.id);
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
    ...buildAssetViewerRenderModel(data, { ...primaryImageState, assetTags, ...overrides }, req),
  });
}

function handleAssetBrowserActionFailure(err, {
  appName, workflowQueryService, req, res, next,
  pageDefaultsService,
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
    const presentation = resolveAssetBrowserPresentation(req.body, pageDefaultsService);
    data = buildAssetBrowserPageData(workflowQueryService, projectId, project, presentation);
  } catch (renderErr) {
    return next(renderErr);
  }
  if (!data) {
    return next(createNotFound());
  }

  return res.status(status).render('projects/assets.njk', {
    appName,
    ...buildBrowserRenderModel(project, data, pageDefaultsService, req),
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
