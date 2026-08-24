/**
 * Process-local, per-project mutual exclusion for asset filesystem
 * operations (rename/move, in a later chunk). Guards against two
 * overlapping mutations racing on the same project's directory tree within
 * a single process. It is not a distributed lock, does not persist across
 * restarts, and does not coordinate across multiple processes/workers.
 *
 * Synchronous callers use `run` and fail fast if the project is active.
 * Asynchronous callers use `runAsync`, which queues same-project operations
 * while allowing different projects to proceed independently.
 */

export class ProjectOperationError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'ProjectOperationError';
    this.code = code;
  }
}

/**
 * @returns {{ run<T>(projectId: number, callback: () => T): T, runAsync<T>(projectId: number, callback: () => Promise<T> | T): Promise<T>, isActive(projectId: number): boolean }}
 */
export function createProjectOperationCoordinator() {
  const activeProjectIds = new Set();
  const asyncQueueTails = new Map();

  return {
    /**
     * Run `callback` exclusively for `projectId`. Rejects re-entrant calls
     * for the same project ID while one is already running; calls for a
     * different project ID proceed independently. The project ID is always
     * released — in `finally` — whether `callback` returns or throws.
     *
     * @param {number} projectId
     * @param {() => any} callback
     * @returns {any} whatever `callback` returns
     * @throws {ProjectOperationError} if `projectId` is not a positive
     *   integer, or if an operation for `projectId` is already in progress
     */
    run(projectId, callback) {
      if (!Number.isInteger(projectId) || projectId <= 0) {
        throw new ProjectOperationError(
          `Project operation requires a positive integer project ID, got ${JSON.stringify(projectId)}.`,
          { code: 'INVALID_PROJECT_ID' }
        );
      }

      if (activeProjectIds.has(projectId)) {
        throw new ProjectOperationError(
          `An operation is already in progress for project ${projectId}.`,
          { code: 'PROJECT_OPERATION_IN_PROGRESS' }
        );
      }

      activeProjectIds.add(projectId);
      try {
        return callback();
      } finally {
        activeProjectIds.delete(projectId);
      }
    },

    /**
     * Queue an asynchronous callback exclusively for `projectId`. Same-project
     * callbacks run in submission order; a rejected callback does not block
     * the next queued callback. The project remains active until its queue
     * drains, including while callbacks are suspended at an await.
     *
     * @param {number} projectId
     * @param {() => Promise<any> | any} callback
     * @returns {Promise<any>} whatever `callback` resolves to
     * @throws {ProjectOperationError} if `projectId` is not a positive integer
     */
    runAsync(projectId, callback) {
      if (!Number.isInteger(projectId) || projectId <= 0) {
        return Promise.reject(
          new ProjectOperationError(
            `Project operation requires a positive integer project ID, got ${JSON.stringify(projectId)}.`,
            { code: 'INVALID_PROJECT_ID' }
          )
        );
      }

      // `run` is deliberately synchronous: it cannot hand its lock to the
      // promise queue after its callback returns. Reject an async contender
      // rather than starting it inside a synchronous owner.
      if (activeProjectIds.has(projectId) && !asyncQueueTails.has(projectId)) {
        return Promise.reject(
          new ProjectOperationError(
            `An operation is already in progress for project ${projectId}.`,
            { code: 'PROJECT_OPERATION_IN_PROGRESS' }
          )
        );
      }

      activeProjectIds.add(projectId);
      const previousTail = asyncQueueTails.get(projectId) ?? Promise.resolve();
      const executeCallback = () => callback();
      let operation;

      if (asyncQueueTails.has(projectId)) {
        operation = previousTail.then(executeCallback, executeCallback);
      } else {
        try {
          operation = Promise.resolve(executeCallback());
        } catch (err) {
          operation = Promise.reject(err);
        }
      }
      const queueTail = operation.then(
        () => undefined,
        () => undefined
      );

      asyncQueueTails.set(projectId, queueTail);
      queueTail.then(() => {
        if (asyncQueueTails.get(projectId) === queueTail) {
          asyncQueueTails.delete(projectId);
          activeProjectIds.delete(projectId);
        }
      });

      return operation;
    },

    /**
     * @param {number} projectId
     * @returns {boolean} whether an operation is running or queued for `projectId`
     */
    isActive(projectId) {
      return activeProjectIds.has(projectId);
    },
  };
}
