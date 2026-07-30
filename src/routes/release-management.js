import express from 'express';
import { handleReleaseListOrBoard } from './releases.js';

// Phase 2A: dedicated release-management route. Reuses the exact same list/
// board handler as /releases (see handleReleaseListOrBoard in releases.js) so
// filtering, sorting, pagination, board grouping, readiness, and project
// filtering behave identically — only the mount point differs. Phase 2B will
// replace this with the published-project listing once verified; until then
// GET /releases keeps rendering unchanged and this route is purely additive.
export function createReleaseManagementRouter({ appName, workflowQueryService }) {
  const router = express.Router();

  // GET /release-management — Release-record list or board (view=board)
  router.get('/', (req, res, next) => {
    handleReleaseListOrBoard(req, res, next, { appName, workflowQueryService });
  });

  return router;
}
