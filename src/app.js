import path from 'node:path';
import express from 'express';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'node:url';
import { createIndexRouter } from './routes/index.js';
import { createHealthRouter } from './routes/health.js';
import { createProjectsRouter } from './routes/projects.js';
import { createAssetsRouter } from './routes/assets.js';
import { createReleasesRouter } from './routes/releases.js';
import { createProjectService } from './services/project-service.js';
import { createAssetScanner } from './services/asset-scanner.js';
import { createReleaseService } from './services/release-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ appName, db, projectsRoot }) {
  const app = express();

  const env = nunjucks.configure(path.join(__dirname, 'views'), {
    autoescape: true,
    express: app,
    noCache: true,
  });
  app.set('view engine', 'njk');

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const projectService = createProjectService(db, projectsRoot);
  const assetScanner = createAssetScanner(db, projectsRoot, { projectService });
  const releaseService = createReleaseService(db);

  app.use('/', createIndexRouter({ appName, projectService, assetScanner, releaseService }));
  app.use('/health', createHealthRouter({ db }));
  app.use('/projects', createProjectsRouter({ appName, projectService }));
  app.use('/projects', createAssetsRouter({ appName, projectService, assetScanner }));
  app.use('/releases', createReleasesRouter({ appName, releaseService, projectService }));

  app.use((_req, _res, next) => {
    const err = new Error('Not found');
    err.status = 404;
    next(err);
  });

  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    const isClientError = status >= 400 && status < 500;

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
