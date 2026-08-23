import express from 'express';

// GET /release-management remains a temporary compatibility entry point.
export function createReleaseManagementRouter() {
  const router = express.Router();

  router.get('/', (req, res) => {
    const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(`/releases${queryString}`);
  });

  return router;
}
