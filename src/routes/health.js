import express from 'express';

export function createHealthRouter({ db }) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    let database = 'ok';
    try {
      db.prepare('SELECT 1').get();
    } catch (err) {
      database = 'error';
    }

    const status = database === 'ok' ? 200 : 503;
    res.status(status).json({ status: database === 'ok' ? 'ok' : 'error', database });
  });

  return router;
}
