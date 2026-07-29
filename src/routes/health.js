import express from 'express';

export function createHealthRouter({ db, maintenanceState }) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    // Phase 11.2: report maintenance accurately instead of touching a
    // connection that a live restore may be mid-close/mid-reopen on.
    if (maintenanceState && maintenanceState.active) {
      res.status(503).json({ status: 'maintenance', database: 'unavailable' });
      return;
    }

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
