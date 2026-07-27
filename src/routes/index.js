import express from 'express';

export function createIndexRouter({ appName, projectService, assetScanner }) {
  const router = express.Router();

  router.get('/', (req, res, next) => {
    try {
      const counts = projectService.countByStatus();
      const { rows: recentlyUpdated } = projectService.list({
        sortBy: 'updated',
        order: 'desc',
        limit: 10,
      });

      const totalAssets = assetScanner ? assetScanner.repository.getTotalCount() : 0;

      res.render('index.njk', {
        appName,
        counts,
        recentlyUpdated,
        totalAssets,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
