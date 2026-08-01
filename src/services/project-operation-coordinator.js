/**
 * Process-local, per-project mutual exclusion for asset filesystem
 * operations (rename/move, in a later chunk). Guards against two
 * overlapping mutations racing on the same project's directory tree within
 * a single process. It is not a distributed lock, does not persist across
 * restarts, and does not coordinate across multiple processes/workers.
 *
 * The current execution model is fully synchronous (better-sqlite3 + sync
 * fs calls), so `run` takes a synchronous callback and returns its result
 * synchronously. There is no queueing: a second call for the same project
 * while the first is still running is rejected immediately rather than
 * waiting.
 */

export class ProjectOperationError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'ProjectOperationError';
    this.code = code;
  }
}

/**
 * @returns {{ run<T>(projectId: number, callback: () => T): T, isActive(projectId: number): boolean }}
 */
export function createProjectOperationCoordinator() {
  const activeProjectIds = new Set();

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
     * @param {number} projectId
     * @returns {boolean} whether an operation is currently in progress for `projectId`
     */
    isActive(projectId) {
      return activeProjectIds.has(projectId);
    },
  };
}
