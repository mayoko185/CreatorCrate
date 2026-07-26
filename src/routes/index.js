import express from 'express';

export function createIndexRouter({ appName }) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.render('index.njk', { appName });
  });

  return router;
}
