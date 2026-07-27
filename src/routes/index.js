import express from 'express';

export function createIndexRouter({ appName, projectService, assetScanner, releaseService }) {
  const router = express.Router();

  router.get('/', (req, res, next) => {
    try {
      const counts = projectService.countByStatus();
      const { rows: recentlyUpdated } = projectService.list({
        sortBy: 'updated',
        order: 'desc',
        limit: 10,
      });

      const totalAssets = assetScanner ? assetScanner.getTotalAssetCount() : 0;

      // Release dashboard data
      const upcomingReleases = releaseService ? releaseService.upcomingReleases().slice(0, 5) : [];
      const overdueReleases = releaseService ? releaseService.overdueReleases().slice(0, 5) : [];
      const releaseStatusCounts = releaseService ? releaseService.countByStatus() : {};

      res.render('index.njk', {
        appName,
        counts,
        recentlyUpdated,
        totalAssets,
        upcomingReleases,
        overdueReleases,
        releaseStatusCounts,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
