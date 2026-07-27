import express from 'express';

export function createIndexRouter({ appName, workflowQueryService }) {
  const router = express.Router();

  router.get('/', (req, res, next) => {
    try {
      const dashboard = workflowQueryService.getDashboardData();

      res.render('index.njk', {
        appName,
        attention: dashboard.releasesNeedingAttention,
        upcomingReleases: dashboard.upcomingReleases,
        summary: dashboard.workflowSummary,
        projectCounts: dashboard.projectCounts,
        recentlyUpdated: dashboard.recentlyUpdated,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
