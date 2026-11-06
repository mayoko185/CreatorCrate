import express from 'express';
import {
  AssetNotFoundError,
  AssetTagReviewInvalidError,
  AssetTagSetStaleError,
  AssetTagValidationError,
  TagNotFoundError,
  assetTagReviewToken,
  isAssetTagReviewToken,
} from '../services/asset-tag-service.js';
import { buildAssetViewerTagFailureRenderModel } from './assets.js';
import { isEnhancedAssetRequest } from './project-assets-shared.js';

// Stable codes for the enhanced (Accept: application/json) Edit Asset tag save.
// Every refusal below is decided before replaceAssetTags changes anything (the
// stale tag-set check inside its transaction, before the first write), so
// its outcome is 'refused'. An unexpected error cannot say whether the atomic
// replacement committed, so it reports 'unknown' and claims neither.
export const ASSET_TAG_SAVE_ERROR_CODES = Object.freeze({
  ASSET_NOT_FOUND: 'ASSET_NOT_FOUND',
  PROJECT_ARCHIVED: 'PROJECT_ARCHIVED',
  TAG_IDS_INVALID: 'TAG_IDS_INVALID',
  TAG_NOT_FOUND: 'TAG_NOT_FOUND',
  TAG_VALIDATION_FAILED: 'TAG_VALIDATION_FAILED',
  TAG_SAVE_FAILED: 'TAG_SAVE_FAILED',
  // WP10A1-F3: the save's reviewed-state witness (TAG_REVIEW_FIELD) is
  // missing or malformed, or names a saved set the asset no longer has.
  TAG_REVIEW_INVALID: 'TAG_REVIEW_INVALID',
  TAG_SET_STALE: 'TAG_SET_STALE',
});

// Every tag form renders the reviewed-state token of the saved set it shows
// (assetTagReviewToken) in this field; every save must carry it back.
export const TAG_REVIEW_FIELD = 'tagReview';

const ASSET_TAGS_SAVED_MESSAGE = 'Asset tags updated.';
const ASSET_MISSING_MESSAGE = 'This asset no longer exists in this project.';
const ARCHIVED_MESSAGE = 'This project is archived and read-only. Asset tag assignments cannot be changed.';
const TAG_NOT_FOUND_MESSAGE = 'One or more selected tags no longer exists. Refresh and try again.';
const TAG_REVIEW_INVALID_MESSAGE = 'This tag selection could not be checked against the saved tags, so it was not saved. Reload the page and try again.';
const TAG_SET_STALE_MESSAGE = 'The saved tags changed after this selection was reviewed, so it was not saved. Review the saved tags, then save again.';

function createNotFound() {
  const err = new Error('Not found');
  err.status = 404;
  return err;
}

function parseId(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id < 1 || String(id) !== String(value)) {
    return null;
  }
  return id;
}

function isArchivedProject(project) {
  return Boolean(project?.archived_at || project?.status === 'archived');
}

function getTagService(req) {
  const service = req.app?.locals?.tagService;
  if (!service) {
    throw new Error('Asset Tags requires app.locals.tagService.');
  }
  return service;
}

function getAssetTagService(req) {
  const service = req.app?.locals?.assetTagService;
  if (!service) {
    throw new Error('Asset Tags requires app.locals.assetTagService.');
  }
  return service;
}

function getProjectPrimaryImageService(req) {
  const service = req.app?.locals?.projectPrimaryImageService;
  if (!service) {
    throw new Error('Asset Tags requires app.locals.projectPrimaryImageService.');
  }
  return service;
}

function getPreviewProbe(req) {
  // Viewer eligibility hint only: a pure read, never selection authority.
  return req.app?.locals?.previewService?.inspectKritaPreviewPresentation;
}

function isAssetEditSubmission(req) {
  return req.body?.origin === 'asset-edit';
}

function toProjectView(project) {
  return {
    id: project.id,
    title: project.title,
    status: project.status,
    archived_at: project.archived_at,
  };
}

function toAssetView(asset) {
  return {
    id: asset.id,
    filename: asset.filename,
    missing: Boolean(asset.missing),
  };
}

function toTagView(tag) {
  return {
    id: tag.id,
    displayName: tag.display_name,
  };
}

function normalizeTagIdField(raw) {
  if (raw === undefined) return { valid: true, ids: [] };
  if (raw === null) return { valid: false, ids: [] };
  if (typeof raw === 'string' || typeof raw === 'number') {
    return raw === '' ? { valid: true, ids: [] } : { valid: true, ids: [String(raw)] };
  }
  if (Array.isArray(raw)) {
    if (raw.some((value) => typeof value !== 'string' && typeof value !== 'number')) {
      return { valid: false, ids: [] };
    }
    return { valid: true, ids: raw.map(String) };
  }
  if (typeof raw === 'object') {
    const keys = Object.keys(raw);
    if (keys.some((key) => !/^\d+$/.test(key))) return { valid: false, ids: [] };
    const values = Object.values(raw);
    if (values.some((value) => typeof value !== 'string' && typeof value !== 'number')) {
      return { valid: false, ids: [] };
    }
    return { valid: true, ids: values.map(String) };
  }
  return { valid: false, ids: [] };
}

function parseSubmittedTagIds(raw) {
  const normalized = normalizeTagIdField(raw);
  if (!normalized.valid) {
    return {
      valid: false,
      tagIds: [],
      submittedTagIds: [],
      error: 'Tag selections must be submitted as a flat list of tag IDs.',
    };
  }

  const tagIds = [];
  for (const rawId of normalized.ids) {
    if (!/^[1-9]\d*$/.test(rawId)) {
      return {
        valid: false,
        tagIds: [],
        submittedTagIds: normalized.ids,
        error: 'Tag selections must contain canonical positive integer IDs.',
      };
    }
    const tagId = Number(rawId);
    if (!Number.isSafeInteger(tagId) || String(tagId) !== rawId) {
      return {
        valid: false,
        tagIds: [],
        submittedTagIds: normalized.ids,
        error: 'Tag selections must contain safe positive integer IDs.',
      };
    }
    tagIds.push(tagId);
  }

  return {
    valid: true,
    tagIds,
    submittedTagIds: normalized.ids,
    error: null,
  };
}

function sendTagSaveJsonError(res, status, code, message, {
  outcome = 'refused',
  errors = null,
  submittedTagIds,
} = {}) {
  return res.status(status).json({
    status: 'error',
    code,
    outcome,
    message,
    ...(errors ? { errors } : {}),
    ...(submittedTagIds === undefined ? {} : { submittedTagIds: [...submittedTagIds] }),
  });
}

// The assignments the atomic replacement returned: the set now stored, in the
// service's display order. Only these are reported as saved.
function buildTagSaveJson(project, asset, resultingTags) {
  const tags = resultingTags.map(toTagView);
  const tagIds = tags.map((tag) => tag.id);
  return {
    status: 'success',
    outcome: 'committed',
    message: ASSET_TAGS_SAVED_MESSAGE,
    projectId: project.id,
    assetId: asset.id,
    tagIds,
    tags,
    // The reviewed-state witness of the set this save stored (read inside its
    // own transaction): what a next save from this page must carry.
    tagReview: assetTagReviewToken({ projectId: project.id, assetId: asset.id, tagIds }),
    // The viewer's tag chips and its tag-filtered navigation are server
    // rendered; the page re-reads them with a GET of the Asset detail URL.
    refreshRequired: true,
  };
}

function loadAssetPageData(workflowQueryService, projectId, assetId) {
  return workflowQueryService.getProjectAssetViewer(projectId, assetId);
}

function renderAssetTagsPage(req, res, data, {
  appName,
  status = 200,
  errors = {},
  submittedTagIds,
} = {}) {
  const tags = getTagService(req).listTags().map(toTagView);
  const assignedTags = getAssetTagService(req).listAssetTags(data.asset.id).map(toTagView);
  const selectedTagIds = submittedTagIds === undefined
    ? assignedTags.map((tag) => String(tag.id))
    : submittedTagIds;

  res.status(status).render('projects/asset-tags.njk', {
    appName,
    project: toProjectView(data.project),
    asset: toAssetView(data.asset),
    tags,
    assignedTags,
    selectedTagIds,
    // The saved set shown here, never the submitted selection.
    tagReviewField: TAG_REVIEW_FIELD,
    tagReview: assetTagReviewToken({
      projectId: data.project.id,
      assetId: data.asset.id,
      tagIds: assignedTags.map((tag) => tag.id),
    }),
    errors,
    errorMessages: Object.values(errors),
  });
}

async function renderAssetTagsPageOrNext(req, res, next, data, options = {}) {
  try {
    if (options.assetEditSubmission) {
      const renderModel = await buildAssetViewerTagFailureRenderModel({
        req,
        data,
        workflowQueryService: options.workflowQueryService,
        assetWorkflowMetadataService: req.app?.locals?.assetWorkflowMetadataService,
        projectPrimaryImageService: getProjectPrimaryImageService(req),
        submittedTagIds: options.submittedTagIds,
        errors: options.errors,
        previewProbe: getPreviewProbe(req),
      });
      return res.status(options.status || 200).render('projects/asset-viewer.njk', {
        appName: options.appName,
        ...renderModel,
      });
    }
    renderAssetTagsPage(req, res, data, options);
  } catch (err) {
    if (err instanceof AssetNotFoundError) return next(createNotFound());
    return next(err);
  }
}

/**
 * Create the existing-asset tag assignment router, mounted at /projects.
 *
 * Routes:
 *   GET  /:projectId/assets/:assetId/tags
 *   POST /:projectId/assets/:assetId/tags  (native redirect; JSON for the
 *                                           Edit Asset dialog's enhanced save)
 *
 * Project/asset ownership is delegated to the existing project-scoped viewer
 * query service. Catalog and assignment operations use only app.locals
 * services; this router never opens a database or accesses a repository.
 */
export function createAssetTagsRouter({ appName, workflowQueryService } = {}) {
  if (!workflowQueryService || typeof workflowQueryService.getProjectAssetViewer !== 'function') {
    throw new Error('createAssetTagsRouter requires a workflowQueryService dependency.');
  }

  const router = express.Router();

  // `res` is passed only by the enhanced save, which is told that the record
  // is gone (or belongs to another project) as JSON instead of a 404 page.
  function loadOr404(req, next, res = null) {
    const refuseMissing = () => {
      if (res) sendTagSaveJsonError(res, 404, ASSET_TAG_SAVE_ERROR_CODES.ASSET_NOT_FOUND, ASSET_MISSING_MESSAGE);
      else next(createNotFound());
      return null;
    };
    const projectId = parseId(req.params.projectId);
    const assetId = parseId(req.params.assetId);
    if (projectId === null || assetId === null) return refuseMissing();

    const data = loadAssetPageData(workflowQueryService, projectId, assetId);
    if (!data) return refuseMissing();
    return data;
  }

  // The Edit Asset dialog's enhanced save: the same ownership, archive, input
  // and service rules as the native POST, answered as JSON so the Asset detail
  // document stays mounted. The submitted set is complete: a form with no
  // tagIds field (nothing checked) replaces the assignments with an empty set,
  // exactly as the native form always has.
  function handleEnhancedTagSave(req, res) {
    const data = loadOr404(req, null, res);
    if (!data) return undefined;

    if (isArchivedProject(data.project)) {
      return sendTagSaveJsonError(res, 409, ASSET_TAG_SAVE_ERROR_CODES.PROJECT_ARCHIVED, ARCHIVED_MESSAGE, {
        errors: { tagIds: ARCHIVED_MESSAGE },
      });
    }

    const parsed = parseSubmittedTagIds(req.body?.tagIds);
    if (!parsed.valid) {
      return sendTagSaveJsonError(res, 422, ASSET_TAG_SAVE_ERROR_CODES.TAG_IDS_INVALID, parsed.error, {
        errors: { tagIds: parsed.error },
        submittedTagIds: parsed.submittedTagIds,
      });
    }

    const review = req.body?.[TAG_REVIEW_FIELD];
    if (!isAssetTagReviewToken(review)) {
      return sendTagSaveJsonError(res, 422, ASSET_TAG_SAVE_ERROR_CODES.TAG_REVIEW_INVALID, TAG_REVIEW_INVALID_MESSAGE, {
        errors: { tagIds: TAG_REVIEW_INVALID_MESSAGE },
        submittedTagIds: parsed.submittedTagIds,
      });
    }

    let resultingTags;
    try {
      resultingTags = getAssetTagService(req).replaceAssetTags(data.asset.id, parsed.tagIds, { expectedReview: review });
    } catch (err) {
      if (err instanceof AssetNotFoundError) {
        return sendTagSaveJsonError(res, 404, ASSET_TAG_SAVE_ERROR_CODES.ASSET_NOT_FOUND, ASSET_MISSING_MESSAGE);
      }
      // Decided inside the replacement transaction, before any assignment
      // changed: the newer saved set is untouched.
      if (err instanceof AssetTagSetStaleError) {
        return sendTagSaveJsonError(res, 409, ASSET_TAG_SAVE_ERROR_CODES.TAG_SET_STALE, TAG_SET_STALE_MESSAGE, {
          errors: { tagIds: TAG_SET_STALE_MESSAGE },
          submittedTagIds: parsed.submittedTagIds,
        });
      }
      if (err instanceof AssetTagReviewInvalidError) {
        return sendTagSaveJsonError(res, 422, ASSET_TAG_SAVE_ERROR_CODES.TAG_REVIEW_INVALID, TAG_REVIEW_INVALID_MESSAGE, {
          errors: { tagIds: TAG_REVIEW_INVALID_MESSAGE },
          submittedTagIds: parsed.submittedTagIds,
        });
      }
      if (err instanceof TagNotFoundError) {
        return sendTagSaveJsonError(res, 422, ASSET_TAG_SAVE_ERROR_CODES.TAG_NOT_FOUND, TAG_NOT_FOUND_MESSAGE, {
          errors: { tagIds: TAG_NOT_FOUND_MESSAGE },
          submittedTagIds: parsed.submittedTagIds,
        });
      }
      if (err instanceof AssetTagValidationError) {
        const errors = err.errors || { tagIds: err.message };
        return sendTagSaveJsonError(res, 422, ASSET_TAG_SAVE_ERROR_CODES.TAG_VALIDATION_FAILED, Object.values(errors).join(' '), {
          errors,
          submittedTagIds: parsed.submittedTagIds,
        });
      }
      // No detail leaves the server: the message is fixed and the outcome open.
      return sendTagSaveJsonError(
        res,
        500,
        ASSET_TAG_SAVE_ERROR_CODES.TAG_SAVE_FAILED,
        'The asset tag save could not be confirmed.',
        { outcome: 'unknown' },
      );
    }

    // The transaction found no asset row (deleted after the ownership read)
    // and returned before changing anything.
    if (!Array.isArray(resultingTags)) {
      return sendTagSaveJsonError(res, 404, ASSET_TAG_SAVE_ERROR_CODES.ASSET_NOT_FOUND, ASSET_MISSING_MESSAGE);
    }
    return res.json(buildTagSaveJson(data.project, data.asset, resultingTags));
  }

  router.get('/:projectId/assets/:assetId/tags', (req, res, next) => {
    const data = loadOr404(req, next);
    if (!data) return;
    renderAssetTagsPageOrNext(req, res, next, data, { appName }).catch(next);
  });

  router.post('/:projectId/assets/:assetId/tags', (req, res, next) => {
    if (isEnhancedAssetRequest(req)) return handleEnhancedTagSave(req, res);
    const data = loadOr404(req, next);
    if (!data) return;
    const assetEditSubmission = isAssetEditSubmission(req);
    const failureOptions = { appName, assetEditSubmission, workflowQueryService };

    if (isArchivedProject(data.project)) {
      return renderAssetTagsPageOrNext(req, res, next, data, {
        ...failureOptions,
        status: 409,
        errors: { tagIds: 'This project is archived and read-only. Asset tag assignments cannot be changed.' },
      }).catch(next);
    }

    const parsed = parseSubmittedTagIds(req.body?.tagIds);
    if (!parsed.valid) {
      return renderAssetTagsPageOrNext(req, res, next, data, {
        ...failureOptions,
        status: 422,
        submittedTagIds: parsed.submittedTagIds,
        errors: { tagIds: parsed.error },
      }).catch(next);
    }

    const review = req.body?.[TAG_REVIEW_FIELD];
    if (!isAssetTagReviewToken(review)) {
      return renderAssetTagsPageOrNext(req, res, next, data, {
        ...failureOptions,
        status: 422,
        submittedTagIds: parsed.submittedTagIds,
        errors: { tagIds: TAG_REVIEW_INVALID_MESSAGE },
      }).catch(next);
    }

    try {
      getAssetTagService(req).replaceAssetTags(data.asset.id, parsed.tagIds, { expectedReview: review });
      const editQuery = assetEditSubmission ? '&edit=1' : '';
      return res.redirect(`/projects/${data.project.id}/assets/${data.asset.id}?notice=asset_tags_updated${editQuery}`);
    } catch (err) {
      if (err instanceof AssetNotFoundError) return next(createNotFound());
      // Refused before anything changed; the page shows the saved set now
      // (and its fresh witness) with the submitted selection kept as a draft.
      if (err instanceof AssetTagSetStaleError || err instanceof AssetTagReviewInvalidError) {
        const stale = err instanceof AssetTagSetStaleError;
        return renderAssetTagsPageOrNext(req, res, next, data, {
          ...failureOptions,
          status: stale ? 409 : 422,
          submittedTagIds: parsed.submittedTagIds,
          errors: { tagIds: stale ? TAG_SET_STALE_MESSAGE : TAG_REVIEW_INVALID_MESSAGE },
        }).catch(next);
      }
      if (err instanceof TagNotFoundError) {
        return renderAssetTagsPageOrNext(req, res, next, data, {
          ...failureOptions,
          status: 422,
          submittedTagIds: parsed.submittedTagIds,
          errors: { tagIds: 'One or more selected tags no longer exists. Refresh and try again.' },
        }).catch(next);
      }
      if (err instanceof AssetTagValidationError) {
        return renderAssetTagsPageOrNext(req, res, next, data, {
          ...failureOptions,
          status: 422,
          submittedTagIds: parsed.submittedTagIds,
          errors: err.errors || { tagIds: err.message },
        }).catch(next);
      }
      return next(err);
    }
  });

  return router;
}
