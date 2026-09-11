import express from 'express';

// GET /assets remains a compatibility entry point for the Asset Viewer.
export function createAssetLibraryCompatibilityRouter() {
  const router = express.Router();

  router.get('/', (req, res) => {
    const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(`/asset-viewer${queryString}`);
  });

  return router;
}
