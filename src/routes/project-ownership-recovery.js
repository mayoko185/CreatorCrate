import express from 'express';
import { ProjectOwnershipRecoveryError } from '../services/project-ownership-recovery-service.js';

/**
 * Explicit project-directory ownership recovery endpoints (PM-1C2A). The
 * Project Detail dialog (PM-1C2B, static/client/project-ownership-recovery.js)
 * is their only UI caller.
 *
 *   GET  /projects/:id/ownership-recovery  → current public recovery status
 *   POST /projects/:id/ownership-recovery  → recover; body `statusVersion`
 *
 * The GET changes no filesystem state. Its one write is bookkeeping: when it
 * positively verifies healthy ownership (`action: none`, bound + matching
 * marker) it retires a stale attention classification that SQLite still
 * holds — conditionally on the exact value observed — so the Project Detail
 * notice, which reads SQLite only, does not reappear on the next render.
 *
 * Mounted behind the application-wide auth and CSRF middleware. Responses
 * never carry filesystem paths or ownership tokens. A JSON (`Accept:
 * application/json`) POST gets a JSON result; a plain form POST redirects to
 * the project on success and renders the standard error page otherwise.
 */

function parseId(raw) {
  return /^[1-9]\d{0,15}$/.test(String(raw)) ? Number(raw) : null;
}

function isEnhancedRequest(req) {
  return String(req.get?.('Accept') || '').toLowerCase().includes('application/json');
}

function notFound() {
  const err = new Error('Not found');
  err.status = 404;
  return err;
}

export function createProjectOwnershipRecoveryRouter({ projectOwnershipRecoveryService }) {
  if (!projectOwnershipRecoveryService) {
    throw new Error('createProjectOwnershipRecoveryRouter requires projectOwnershipRecoveryService.');
  }
  const router = express.Router();

  router.get('/:id/ownership-recovery', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) return next(notFound());
    let recovery;
    try {
      recovery = projectOwnershipRecoveryService.getRecoveryStatus(id);
    } catch (err) {
      return next(err);
    }
    if (!recovery) return next(notFound());
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'success', recovery });
  });

  router.post('/:id/ownership-recovery', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) return next(notFound());
    const enhanced = isEnhancedRequest(req);
    res.set('Cache-Control', 'no-store');

    let result;
    try {
      result = projectOwnershipRecoveryService.recover(id, { statusVersion: req.body?.statusVersion });
    } catch (err) {
      if (!(err instanceof ProjectOwnershipRecoveryError)) return next(err);
      if (err.code === 'PROJECT_NOT_FOUND') return next(notFound());
      if (err.status === 503) res.set('Retry-After', '60');
      if (!enhanced) return next(err);
      res.status(err.status).json({
        status: 'error',
        code: err.code,
        reason: err.reason,
        message: err.message,
        recovery: err.recovery ?? null,
      });
      return;
    }

    if (!enhanced) {
      res.redirect(`/projects/${id}`);
      return;
    }
    res.json({
      status: 'success',
      outcome: result.outcome,
      message: 'Project directory ownership recovered.',
      recovery: result.recovery,
    });
  });

  return router;
}
