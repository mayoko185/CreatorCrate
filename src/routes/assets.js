import express from 'express';
import { ProjectNotFoundError } from '../services/project-service.js';

const SORT_OPTIONS = ['filename', 'size', 'modified'];

/**
 * Create an assets router mounted at /projects.
 *
 * Routes:
 *   GET  /projects/:id/assets — Asset listing page
 *   POST /projects/:id/scan  — Trigger a manual scan
 *
 * @param {object} deps
 * @param {string} deps.appName
 * @param {import('../services/project-service.js').ProjectService} deps.projectService
 * @param {import('../services/asset-scanner.js').AssetScanner} deps.assetScanner
 */
export function createAssetsRouter({ appName, projectService, assetScanner }) {
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

      const { extension, search, sort, order } = parseAssetQuery(req.query);

      const assets = assetScanner.listProjectAssets(id, {
        extension: extension || undefined,
        search: search || undefined,
        sortBy: sort,
        order,
      });

      const extensions = assetScanner.getExtensionList(id);
      const counts = assetScanner.getAssetCounts(id);

      res.render('projects/assets.njk', {
        appName,
        project,
        assets,
        total: counts.total,
        extensions,
        query: { extension, search, sort, order },
        sortOptions: SORT_OPTIONS,
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

      const result = assetScanner.scanProjectAssets(id);

      const parts = [];
      if (result.added > 0) parts.push(`added=${result.added}`);
      if (result.updated > 0) parts.push(`updated=${result.updated}`);
      if (result.removed > 0) parts.push(`removed=${result.removed}`);
      const params = parts.length > 0
        ? `?scan_result=${parts.join('+')}&total=${result.total}`
        : '?scan_result=no_changes';

      res.redirect(`/projects/${id}/assets${params}`);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        return next(createNotFound());
      }
      // Catch filesystem errors and redirect with a safe message
      const id = parseId(req.params.id);
      const targetId = id !== null ? id : '';
      res.redirect(`/projects/${targetId}/assets?scan_error=1`);
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

function parseAssetQuery(query) {
  const extension = typeof query.extension === 'string' ? query.extension.trim() : '';
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  const sort = SORT_OPTIONS.includes(query.sort) ? query.sort : 'filename';
  const order = query.order === 'asc' ? 'asc' : 'desc';
  return { extension, search, sort, order };
}

function createNotFound() {
  const err = new Error('Not found');
  err.status = 404;
  return err;
}
