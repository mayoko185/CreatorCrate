import express from 'express';
import { handleReleaseListOrBoard } from './releases.js';

// Dedicated release-management route. Reuses the release list/board handler
// while retaining its own page-default namespace and URL surface.
export function createReleaseManagementRouter({ appName, workflowQueryService }) {
  const router = express.Router();

  // GET /release-management — Release-record list or board (view=board)
  router.get('/', (req, res, next) => {
    handleReleaseListOrBoard(req, res, next, { appName, workflowQueryService });
  });

  return router;
}
