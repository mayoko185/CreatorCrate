import express from 'express';

function createNotFound() {
  const err = new Error('Not found');
  err.status = 404;
  return err;
}

function parseId(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id < 1 || String(id) !== String(value)) return null;
  return id;
}

/**
 * Create the compatibility router for the former standalone category page.
 * Category reads and all mutations now belong to the Assets page router.
 */
export function createProjectAssetCategoriesRouter({
  projectService,
  assetBrowserPreferenceService,
} = {}) {
  if (!assetBrowserPreferenceService) {
    throw new Error('createProjectAssetCategoriesRouter requires an assetBrowserPreferenceService dependency.');
  }

  const router = express.Router();

  router.get('/:projectId/asset-categories', (req, res, next) => {
    const projectId = parseId(req.params.projectId);
    if (projectId === null) return next(createNotFound());
    if (!projectService.findById(projectId)) return next(createNotFound());
    const notice = typeof req.query?.notice === 'string' && req.query.notice
      ? `&notice=${encodeURIComponent(req.query.notice)}`
      : '';
    return res.redirect(`/projects/${projectId}/assets?manage_categories=1${notice}`);
  });

  return router;
}
