import { randomUUID } from 'node:crypto';
import { createAppMetaRepository } from './app-meta-repository.js';

/**
 * Processing recovery gate — `app_meta` records only; no schema of its own.
 *
 * A processing job that ends with an unresolved rollback (`RECOVERY_REQUIRED`)
 * leaves the project's files in a state the asset index may not describe.
 * One small row per affected project
 * (`processing.recovery_required.v1.project.<id>`) blocks processing
 * Preview/Apply for that project until a successful manual scan of it. The row
 * is durable so a process restart cannot silently reopen processing on
 * uncertain files. Project IDs are AUTOINCREMENT and never reused, so a row
 * left by a deleted project can never gate another one.
 *
 * The row is written ahead: a processing job holds it before touching any file
 * and removes it only once the files are known to be in a consistent state.
 * An unresolved rollback therefore never depends on a later write succeeding;
 * the gate is already durable, and a failed removal or a crash mid-job leaves
 * the project gated rather than open.
 */

const PROJECT_KEY_PREFIX = 'processing.recovery_required.v1.project.';

function projectKey(projectId) {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new TypeError('Processing recovery gate requires a positive integer project ID.');
  }
  return `${PROJECT_KEY_PREFIX}${projectId}`;
}

function recoveryRequiredError() {
  return Object.assign(new Error('Processing recovery is required for this project.'), { code: 'RECOVERY_REQUIRED' });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ appMetaRepository?: object, now?: () => Date }} [options]
 */
export function createProcessingRecoveryGateRepository(db, {
  appMetaRepository = null, now = () => new Date(),
} = {}) {
  const appMeta = appMetaRepository ?? createAppMetaRepository(db);
  const deleteKeyStmt = db.prepare('DELETE FROM app_meta WHERE key = ?');
  const deleteKeyValueStmt = db.prepare('DELETE FROM app_meta WHERE key = ? AND value = ?');
  // Rows written ahead by this process's running jobs, by project. Only the
  // exact row a live job wrote is exempt from gating; after the job settles,
  // or after a restart, the same row gates like any other.
  const heldRows = new Map();

  return {
    markRecoveryRequired(projectId) {
      appMeta.setValue(projectKey(projectId), JSON.stringify({ version: 1, since: now().toISOString() }));
    },
    // Any row, even an unreadable one, keeps the project gated.
    isRecoveryRequired(projectId) {
      const value = appMeta.getValue(projectKey(projectId));
      return value !== undefined && heldRows.get(projectId) !== value;
    },
    /**
     * Durably gate the project for the duration of one processing execution.
     * Throws `RECOVERY_REQUIRED` if the project is already gated, and rethrows
     * a failed write so the caller never touches files without the gate.
     */
    holdForProcessing(projectId) {
      const key = projectKey(projectId);
      if (heldRows.has(projectId) || appMeta.getValue(key) !== undefined) throw recoveryRequiredError();
      const value = JSON.stringify({ version: 1, since: now().toISOString(), hold: randomUUID() });
      appMeta.setValue(key, value);
      heldRows.set(projectId, value);
      let open = true;
      return {
        // Files are in a known state: drop this hold's row. If the delete
        // fails the row stays and the project remains gated.
        release() {
          if (!open) return false;
          open = false;
          try {
            return deleteKeyValueStmt.run(key, value).changes > 0;
          } catch {
            return false;
          } finally {
            heldRows.delete(projectId);
          }
        },
        // Unresolved rollback: keep the already-durable row as the gate.
        retain() {
          if (!open) return;
          open = false;
          heldRows.delete(projectId);
        },
      };
    },
    // A running job's own row is never cleared from under it. A failed delete
    // throws, so no caller can report the gate as cleared.
    clearRecoveryRequired(projectId) {
      const key = projectKey(projectId);
      if (heldRows.has(projectId)) return false;
      return deleteKeyStmt.run(key).changes > 0;
    },
  };
}
