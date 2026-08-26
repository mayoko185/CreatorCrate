import { randomUUID } from 'node:crypto';

export const PROCESSING_JOB_STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const PROCESSING_FAILURE = Object.freeze({
  code: 'PROCESSING_FAILED',
  message: 'Processing failed.',
});

function assertPositiveProjectId(projectId) {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new TypeError('Processing jobs require a positive integer project ID.');
  }
}

function assertProgress(progress) {
  if (!progress || typeof progress !== 'object') {
    throw new TypeError('Processing job progress must provide completed and total counts.');
  }
  const { completed, total } = progress;
  if (
    !Number.isSafeInteger(completed)
    || !Number.isSafeInteger(total)
    || completed < 0
    || total < 0
    || completed > total
  ) {
    throw new TypeError('Processing job progress must have non-negative completed and total counts.');
  }
  return { completed, total };
}

function snapshot(job) {
  return {
    id: job.id,
    projectId: job.projectId,
    state: job.state,
    progress: job.progress ? { ...job.progress } : null,
    result: job.state === PROCESSING_JOB_STATES.SUCCEEDED ? job.result : null,
    error: job.state === PROCESSING_JOB_STATES.FAILED ? { ...PROCESSING_FAILURE } : null,
  };
}

const SAFE_RESULT_COUNT_FIELDS = Object.freeze([
  'convertedCount',
  'requestedCount',
  'generatedCount',
  'changedCount',
  'unchangedCount',
  'sourceCount',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function safeResultSummary(result) {
  const source = isPlainObject(result?.result) ? result.result : result;
  if (!isPlainObject(source)) return null;
  const summary = {};
  for (const field of SAFE_RESULT_COUNT_FIELDS) {
    if (Number.isSafeInteger(source[field]) && source[field] >= 0) summary[field] = source[field];
  }
  return Object.keys(summary).length > 0 ? summary : null;
}

function errorForLog(error) {
  if (error && typeof error === 'object') return error;
  return {
    name: 'Error',
    message: typeof error === 'string' ? error : 'Unknown processing failure.',
  };
}

/**
 * Process-local lifecycle registry for later background processing execution.
 * Scheduling is delegated to the B1 coordinator, which remains the sole owner
 * of same-project serialization.
 *
 * @param {{ projectOperationCoordinator: { runAsync(projectId: number, callback: () => Promise<any> | any): Promise<any> }, applicationLogger?: object }} deps
 * @returns {{ reserveSubmission(projectId: number): { projectId: number, release(): boolean }, enqueue(input: { projectId: number, operation?: string, assetCount?: number, execute(context: { jobId: string, updateProgress(progress: { completed: number, total: number }): boolean }): Promise<any> | any, reservation?: object }): string, getJob(jobId: string): object | null, updateProgress(jobId: string, progress: { completed: number, total: number }): boolean, cancel(jobId: string): boolean, hasActiveJobs(): boolean }}
 */
export function createProcessingJobService({
  projectOperationCoordinator,
  applicationLogger = null,
  now = Date.now,
  terminalJobTtlMs = 5 * 60 * 1000,
  maxTerminalJobs = 100,
} = {}) {
  if (!projectOperationCoordinator || typeof projectOperationCoordinator.runAsync !== 'function') {
    throw new Error('createProcessingJobService requires a projectOperationCoordinator dependency.');
  }
  if (typeof now !== 'function') {
    throw new Error('createProcessingJobService requires a now function.');
  }
  if (!Number.isSafeInteger(terminalJobTtlMs) || terminalJobTtlMs <= 0) {
    throw new Error('terminalJobTtlMs must be a positive integer.');
  }
  if (!Number.isSafeInteger(maxTerminalJobs) || maxTerminalJobs <= 0) {
    throw new Error('maxTerminalJobs must be a positive integer.');
  }

  const pendingSubmissionReservations = new Set();

  const jobs = new Map();
  const activeJobIds = new Set();
  const terminalJobIds = new Map();

  function logLifecycle(level, event, job, { error, resultSummary } = {}) {
    if (!applicationLogger || typeof applicationLogger[level] !== 'function') return;
    try {
      applicationLogger[level]({
        kind: 'activity',
        subsystem: 'processing',
        event,
        message: `Processing job ${event.slice('processing.job.'.length).replaceAll('_', ' ')}.`,
        projectId: job.projectId,
        correlationId: job.id,
        context: {
          ...(job.operation ? { operation: job.operation } : {}),
          ...(job.assetCount !== null ? { assetCount: job.assetCount } : {}),
          ...(resultSummary ? { resultSummary } : {}),
        },
        ...(error ? { error: errorForLog(error) } : {}),
      });
    } catch {
      // Lifecycle logging is diagnostic only; processing state remains authoritative.
    }
  }

  function cleanupTerminalJobs() {
    const cutoff = now() - terminalJobTtlMs;
    for (const [jobId, completedAt] of terminalJobIds) {
      if (completedAt > cutoff) break;
      terminalJobIds.delete(jobId);
      jobs.delete(jobId);
    }
    while (terminalJobIds.size > maxTerminalJobs) {
      const oldestJobId = terminalJobIds.keys().next().value;
      terminalJobIds.delete(oldestJobId);
      jobs.delete(oldestJobId);
    }
  }

  function completeJob(job, state) {
    job.state = state;
    activeJobIds.delete(job.id);
    terminalJobIds.set(job.id, now());
    cleanupTerminalJobs();
  }

  function updateProgress(jobId, progress) {
    const job = jobs.get(jobId);
    if (!job || job.state !== PROCESSING_JOB_STATES.RUNNING) return false;
    const nextProgress = assertProgress(progress);
    if (job.progress && nextProgress.completed < job.progress.completed) return false;
    job.progress = nextProgress;
    return true;
  }

  function cancel(jobId) {
    const job = jobs.get(jobId);
    if (!job || job.state !== PROCESSING_JOB_STATES.QUEUED) {
      if (job?.state === PROCESSING_JOB_STATES.RUNNING && !job.cancelRejectedLogged) {
        job.cancelRejectedLogged = true;
        logLifecycle('warn', 'processing.job.cancel_rejected', job);
      }
      return false;
    }
    completeJob(job, PROCESSING_JOB_STATES.CANCELLED);
    logLifecycle('info', 'processing.job.cancelled', job);
    return true;
  }

  function reserveSubmission(projectId) {
    assertPositiveProjectId(projectId);
    const reservation = Object.freeze({
      projectId,
      release() {
        return pendingSubmissionReservations.delete(reservation);
      },
    });
    pendingSubmissionReservations.add(reservation);
    return reservation;
  }

  function enqueue({ projectId, operation, assetCount, execute, reservation } = {}) {
    if (reservation !== undefined) {
      assertPositiveProjectId(projectId);
      if (!pendingSubmissionReservations.has(reservation) || reservation.projectId !== projectId) {
        throw new TypeError('reservation must be an active submission reservation for projectId.');
      }
    }
    assertPositiveProjectId(projectId);
    if (typeof execute !== 'function') {
      throw new Error('enqueue requires an execute function.');
    }

    const job = {
      id: randomUUID(),
      projectId,
      operation: typeof operation === 'string' && operation.length > 0 ? operation : null,
      assetCount: Number.isSafeInteger(assetCount) && assetCount >= 0 ? assetCount : null,
      state: PROCESSING_JOB_STATES.QUEUED,
      progress: null,
      result: null,
    };
    jobs.set(job.id, job);
    activeJobIds.add(job.id);
    logLifecycle('info', 'processing.job.queued', job);

    if (reservation) pendingSubmissionReservations.delete(reservation);

    const executeJob = async () => {
      if (job.state === PROCESSING_JOB_STATES.CANCELLED) return;
      job.state = PROCESSING_JOB_STATES.RUNNING;
      logLifecycle('info', 'processing.job.started', job);
      try {
        job.result = await execute({
          jobId: job.id,
          updateProgress: (progress) => updateProgress(job.id, progress),
        });
        completeJob(job, PROCESSING_JOB_STATES.SUCCEEDED);
        logLifecycle('info', 'processing.job.succeeded', job, { resultSummary: safeResultSummary(job.result) });
      } catch (error) {
        completeJob(job, PROCESSING_JOB_STATES.FAILED);
        logLifecycle('error', 'processing.job.failed', job, { error });
      }
    };

    try {
      Promise.resolve(projectOperationCoordinator.runAsync(projectId, executeJob)).catch((error) => {
        if (job.state === PROCESSING_JOB_STATES.QUEUED) {
          completeJob(job, PROCESSING_JOB_STATES.FAILED);
          logLifecycle('error', 'processing.job.failed', job, { error });
        }
      });
    } catch (error) {
      completeJob(job, PROCESSING_JOB_STATES.FAILED);
      logLifecycle('error', 'processing.job.failed', job, { error });
    }

    return job.id;
  }

  return {
    enqueue,
    reserveSubmission(projectId) {
      return reserveSubmission(projectId);
    },
    getJob(jobId) {
      cleanupTerminalJobs();
      const job = jobs.get(jobId);
      return job ? snapshot(job) : null;
    },
    updateProgress,
    cancel,
    hasActiveJobs() {
      if (pendingSubmissionReservations.size > 0) return true;
      return activeJobIds.size > 0;
    },
  };
}
