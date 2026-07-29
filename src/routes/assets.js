import express from 'express';
import { ProjectNotFoundError } from '../services/project-service.js';

const ASSET_BROWSER_QUERY_KEYS = ['view', 'search', 'extension', 'presence', 'usage', 'page', 'pageSize'];

/**
 * Create an assets router mounted at /projects.
 *
 * Routes:
 *   GET  /projects/:id/assets — Asset listing page
 *   GET  /projects/:projectId/assets/:assetId — Asset viewer page
 *   POST /projects/:id/scan  — Trigger a manual scan
 *
 * @param {object} deps
 * @param {string} deps.appName
 * @param {import('../services/project-service.js').ProjectService} deps.projectService
 * @param {import('../services/asset-scanner.js').AssetScanner} deps.assetScanner
 * @param {import('../services/workflow-query-service.js').WorkflowQueryService} deps.workflowQueryService
 */
export function createAssetsRouter({ appName, projectService, assetScanner, workflowQueryService }) {
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
      const sr = req.query.scan_result;
      if (sr === 'no_changes' ||
          /^added=\d{1,5}$/.test(sr) ||
          /^added=\d{1,5} updated=\d{1,5}$/.test(sr) ||
          /^added=\d{1,5} updated=\d{1,5} removed=\d{1,5}$/.test(sr)) {
        query.scan_result = sr;
        if (req.query.total) query.total = req.query.total;
      }
      // Pass scan_error flag only when actually set by the scan catch block.
      // Use scan_error=filesystem or scan_error=archived so it can be
      // distinguished from spoofed values.
      const error = req.query.scan_error === 'filesystem' ? true : null;
      const archivedError = req.query.scan_error === 'archived' ? true : null;

      res.render('projects/assets.njk', {
        appName,
        project,
        assets: data.assets,
        total: data.total,
        page: data.page,
        pageSize: data.pageSize,
        pageCount: data.pageCount,
        filters: data.filters,
        extensionChoices: data.extensionChoices,
        searchMaxLength: data.searchMaxLength,
        query,
        error,
        archivedError,
        pageUrl: buildPageUrl(req, buildCanonicalBrowserQuery(data.filters, data.page, data.pageSize)),
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
        return res.redirect(`/projects/${id}/assets?scan_error=archived`);
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
      // Catch filesystem errors and redirect with an error flag.
      // Use scan_error=filesystem so it can be distinguished from spoofed values.
      const id = parseId(req.params.id);
      const targetId = id !== null ? id : '';
      res.redirect(`/projects/${targetId}/assets?scan_error=filesystem`);
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

function buildPageUrl(req, allowedParams) {
  return function pageUrl(overrides) {
    const query = {};
    for (const key of ASSET_BROWSER_QUERY_KEYS) {
      const value = Object.prototype.hasOwnProperty.call(overrides, key)
        ? overrides[key]
        : allowedParams[key];
      appendCanonicalParam(query, key, value);
    }
    const search = new URLSearchParams(query).toString();
    const basePath = req.baseUrl + req.path;
    return search ? `${basePath}?${search}` : basePath;
  };
}

function buildCanonicalBrowserQuery(filters, page, pageSize) {
  const query = {};
  appendCanonicalParam(query, 'view', filters.view);
  appendCanonicalParam(query, 'search', filters.search);
  appendCanonicalParam(query, 'extension', filters.extension);
  appendCanonicalParam(query, 'presence', filters.presence);
  appendCanonicalParam(query, 'usage', filters.usage);
  appendCanonicalParam(query, 'page', page);
  appendCanonicalParam(query, 'pageSize', pageSize);
  return query;
}

function appendCanonicalParam(query, key, value) {
  if (value === undefined || value === null || value === '') return;
  const normalized = String(value);
  if (key === 'view' && normalized === 'list') return;
  if (key === 'presence' && normalized === 'all') return;
  if (key === 'usage' && normalized === 'all') return;
  if (key === 'page' && normalized === '1') return;
  if (key === 'pageSize' && normalized === '25') return;
  query[key] = normalized;
}

function createNotFound() {
  const err = new Error('Not found');
  err.status = 404;
  return err;
}
