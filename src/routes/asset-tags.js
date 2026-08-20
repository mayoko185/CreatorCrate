import express from 'express';
import {
  AssetNotFoundError,
  AssetTagValidationError,
  TagNotFoundError,
} from '../services/asset-tag-service.js';
import { buildAssetViewerTagFailureRenderModel } from './assets.js';

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
  return req.app?.locals?.previewService?.inspectKritaPreviewSource;
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
 *   POST /:projectId/assets/:assetId/tags
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

  function loadOr404(req, next) {
    const projectId = parseId(req.params.projectId);
    const assetId = parseId(req.params.assetId);
    if (projectId === null || assetId === null) {
      next(createNotFound());
      return null;
    }

    const data = loadAssetPageData(workflowQueryService, projectId, assetId);
    if (!data) {
      next(createNotFound());
      return null;
    }
    return data;
  }

  router.get('/:projectId/assets/:assetId/tags', (req, res, next) => {
    const data = loadOr404(req, next);
    if (!data) return;
    renderAssetTagsPageOrNext(req, res, next, data, { appName }).catch(next);
  });

  router.post('/:projectId/assets/:assetId/tags', (req, res, next) => {
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

    try {
      getAssetTagService(req).replaceAssetTags(data.asset.id, parsed.tagIds);
      const editQuery = assetEditSubmission ? '&edit=1' : '';
      return res.redirect(`/projects/${data.project.id}/assets/${data.asset.id}?notice=asset_tags_updated${editQuery}`);
    } catch (err) {
      if (err instanceof AssetNotFoundError) return next(createNotFound());
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
