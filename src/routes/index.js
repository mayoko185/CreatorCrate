import express from 'express';
import { parseRetainedReleaseIds, renderDashboardPage } from './dashboard-render.js';

export function createIndexRouter({
  appName,
  workflowQueryService,
  pageDefaultsService,
  tagService,
  projectService,
} = {}) {
  if (!pageDefaultsService) {
    throw new Error('createIndexRouter requires a pageDefaultsService dependency.');
  }
  if (!tagService) {
    throw new Error('createIndexRouter requires a tagService dependency.');
  }
  if (!projectService) {
    throw new Error('createIndexRouter requires a projectService dependency.');
  }

  const router = express.Router();

  router.get('/', (req, res, next) => {
    renderDashboardPage(req, res, next, {
      appName,
      workflowQueryService,
      pageDefaultsService,
      tagService,
      projectService,
      retainedReleaseIds: parseRetainedReleaseIds(req.query.retain),
    });
  });

  return router;
}
