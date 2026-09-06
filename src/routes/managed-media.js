import express from 'express';
import { ManagedMediaError } from '../services/managed-media-service.js';

/** Mounted behind the application's existing requireAuth boundary. */
export function createManagedMediaRouter({ managedMediaService }) {
  const router = express.Router();
  for (const kind of ['thumbnail', 'preview']) {
    router.get(`/:id/${kind}`, async (req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      try {
        // Only the ID and fixed variant cross the service boundary. Query
        // parameters cannot select paths, storage keys or other variants.
        const derivative = await managedMediaService.getDerivative(req.params.id, kind);
        res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
        return res.type(derivative.mimeType).send(derivative.bytes);
      } catch (err) {
        if (err instanceof ManagedMediaError) {
          return err.code === 'CACHE_UNAVAILABLE'
            ? res.status(503).type('text/plain').send('Preview unavailable')
            : res.status(404).type('text/plain').send('Not found');
        }
        return next(err);
      }
    });
  }
  return router;
}
