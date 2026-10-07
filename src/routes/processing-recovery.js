import express from 'express';
import {
  listProjectRecoveryDetails,
  ProcessingRecoveryEvidenceNotFoundError,
  ProcessingRecoveryEvidencePersistenceError,
} from '../services/processing-recovery-evidence-service.js';
import { ProjectOperationError } from '../services/project-operation-coordinator.js';
import { isProjectArchived } from '../services/project-state.js';

// Match the repository's opaque ID contract. The global JSON parser also caps body bytes.
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_EVIDENCE_IDS = 1000;

class RecoveryRequestError extends Error {
  constructor(message, field) {
    super(message);
    this.field = field;
  }
}

function sendError(res, status, code, message, field) {
  return res.status(status).json({ ok: false, error: { code, message, ...(field ? { field } : {}) } });
}

function projectId(value) {
  if (/^[1-9]\d*$/.exec(value)?.[0] !== value || !Number.isSafeInteger(Number(value))) {
    throw new RecoveryRequestError('projectId must be a positive integer.', 'projectId');
  }
  return Number(value);
}

function evidenceIds(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => key !== 'evidenceIds')) {
    throw new RecoveryRequestError('body must be a JSON object containing only evidenceIds.', 'body');
  }
  if (!Array.isArray(body.evidenceIds) || body.evidenceIds.length === 0 || body.evidenceIds.length > MAX_EVIDENCE_IDS) {
    throw new RecoveryRequestError(`evidenceIds must contain between 1 and ${MAX_EVIDENCE_IDS} IDs.`, 'evidenceIds');
  }
  if (body.evidenceIds.some((id) => typeof id !== 'string' || EVIDENCE_ID.exec(id)?.[0] !== id)) {
    throw new RecoveryRequestError('evidenceIds must contain valid evidence IDs.', 'evidenceIds');
  }
  return [...new Set(body.evidenceIds)];
}

function handleError(error, res) {
  if (error instanceof RecoveryRequestError) {
    return sendError(res, 400, 'INVALID_REQUEST', error.message, error.field);
  }
  if (error instanceof ProcessingRecoveryEvidenceNotFoundError) {
    return sendError(res, 404, error.code, 'Processing recovery evidence not found.');
  }
  if (error instanceof ProcessingRecoveryEvidencePersistenceError) {
    return sendError(res, 500, error.code, 'Recovery evidence metadata could not be saved. Retry cleanup to reconcile missing files.');
  }
  if (error instanceof ProjectOperationError && error.code === 'PROJECT_OPERATION_IN_PROGRESS') {
    return sendError(res, 409, error.code, 'An operation is already in progress for this project.');
  }
  return sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error.');
}

/** Mounted behind the application's shared authentication and CSRF middleware. */
export function createProcessingRecoveryRouter({
  projectService, processingRecoveryEvidenceRepository, processingRecoveryGate,
  processingRecoveryEvidenceService = null,
}) {
  const router = express.Router();
  const base = '/:id/assets/processing/recovery';

  router.get(base, (req, res) => {
    try {
      const id = projectId(req.params.id);
      if (!projectService.findById(id)) return sendError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      return res.json({
        ok: true,
        recoveryRequired: processingRecoveryGate.isRecoveryRequired(id),
        entries: listProjectRecoveryDetails(processingRecoveryEvidenceRepository, id),
      });
    } catch (error) {
      return handleError(error, res);
    }
  });

  for (const [action, method] of [['refresh', 'refreshEvidence'], ['cleanup', 'cleanupEvidence']]) {
    router.post(`${base}/${action}`, async (req, res) => {
      try {
        const id = projectId(req.params.id);
        const project = projectService.findById(id);
        if (!project) return sendError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
        if (isProjectArchived(project)) {
          return sendError(res, 409, 'PROJECT_ARCHIVED', 'This project is archived and read-only.');
        }
        const ids = evidenceIds(req.body);
        if (!processingRecoveryEvidenceService) {
          return sendError(res, 503, 'PROCESSING_RECOVERY_UNAVAILABLE', 'Recovery filesystem services are unavailable.');
        }
        // Refresh is advisory and unlocked. Cleanup owns shared coordinator acquisition and fresh proof.
        const results = await processingRecoveryEvidenceService[method](id, ids);
        return res.json({ ok: true, results });
      } catch (error) {
        return handleError(error, res);
      }
    });
  }
  return router;
}
