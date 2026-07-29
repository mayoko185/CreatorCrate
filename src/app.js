import path from 'node:path';
import express from 'express';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'node:url';
import { createIndexRouter } from './routes/index.js';
import { createHealthRouter } from './routes/health.js';
import { createProjectsRouter } from './routes/projects.js';
import { createAssetsRouter } from './routes/assets.js';
import { createReleasesRouter } from './routes/releases.js';
import { createMediaRouter } from './routes/media.js';
import { createProjectService } from './services/project-service.js';
import { createAssetScanner } from './services/asset-scanner.js';
import { createReleaseService } from './services/release-service.js';
import { createWorkflowQueryService } from './services/workflow-query-service.js';
import { evaluateReleaseReadiness } from './services/release-readiness-policy.js';
import { createPreviewService } from './services/preview-service.js';
import { createMediaService } from './services/media-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ appName, db, projectsRoot, previewRoot }, opts = {}) {
  const app = express();

  const env = nunjucks.configure(path.join(__dirname, 'views'), {
    autoescape: true,
    express: app,
    noCache: true,
  });
  app.set('view engine', 'njk');

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, 'static'), {
    index: false,
  }));

  const projectService = createProjectService(db, projectsRoot);
  const assetScanner = createAssetScanner(db, projectsRoot, { projectService });
  const releaseService = opts.releaseService || createReleaseService({ db, evaluateReleaseReadiness });
  const workflowQueryService = opts.workflowQueryService || createWorkflowQueryService({ db, evaluateReleaseReadiness });

  // Phase 10.1A: preview root is passed explicitly so later services can
  // resolve preview paths without reading the environment or globals.
  app.locals.previewRoot = previewRoot;

  // Phase 10.1C: construct the preview + media services per createApp call
  // (no hidden singleton). Tests may inject stubs via opts.previewService /
  // opts.mediaService to keep createApp testable with temporary roots and
  // stubbed services. Production construction uses the configured
  // PROJECTS_ROOT, configured preview root, project repository, asset
  // repository, storage helper (openAssetFile), and Sharp media processor
  // (via the preview service).
  const previewService =
    opts.previewService ||
    (previewRoot
      ? createPreviewService({ db, projectsRoot, previewRoot })
      : null);

  const mediaService =
    opts.mediaService ||
    (previewService && previewRoot && projectsRoot
      ? createMediaService({ previewService, projectsRoot, previewRoot })
      : null);

  app.locals.previewService = previewService;
  app.locals.mediaService = mediaService;

  app.use('/', createIndexRouter({ appName, workflowQueryService }));
  app.use('/health', createHealthRouter({ db }));
  app.use('/projects', createProjectsRouter({ appName, projectService, workflowQueryService }));

  // Media routes stay before the asset browser/viewer router. The media
  // routes have four path segments under /projects; the viewer route has
  // three, but this ordering protects the media contract from future route
  // broadening.
  if (mediaService) {
    app.use('/projects', createMediaRouter({ mediaService }));
  }

  app.use('/projects', createAssetsRouter({ appName, projectService, assetScanner, workflowQueryService }));

  app.use('/releases', createReleasesRouter({ appName, releaseService, projectService, workflowQueryService }));

  app.use((_req, _res, next) => {
    const err = new Error('Not found');
    err.status = 404;
    next(err);
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) {
      return next(err);
    }

    const status = err.status || err.statusCode || 500;
    const isClientError = status >= 400 && status < 500;

    // Unexpected server errors (5xx) may contain sensitive error-state
    // pages or stack traces. Prevent caching so stale error pages never
    // pollute a client's cache. Controlled domain statuses (4xx) are left
    // untouched — their cache policy is set by the route that handled them.
    if (status >= 500) {
      res.setHeader('Cache-Control', 'no-store');
      res.removeHeader('Content-Type');
      res.removeHeader('Content-Length');
      res.removeHeader('Content-Disposition');
      res.removeHeader('ETag');
      res.removeHeader('X-Content-Type-Options');
    }

    res.status(status);

    if (req.accepts('html')) {
      res.render('error.njk', {
        status,
        message: isClientError ? err.message : 'Something went wrong.',
      });
      return;
    }

    res.json({ status: 'error', message: isClientError ? err.message : 'Internal server error.' });
  });

  return app;
}
