import { createAppMetaRepository } from './app-meta-repository.js';

/**
 * Project ownership adoption lifecycle state (PM-1C1) — `app_meta` records
 * only; no schema of its own.
 *
 * The lifecycle record (`project_ownership.adoption.v1`) is small and bounded:
 * the one-time upgrade pass's phase, its committed cursor over SQLite project
 * IDs, the fixed upper bound captured when the pass started, and outcome
 * counts. It holds no per-project list.
 *
 * Per-project state that cannot be derived from `projects` and
 * `project_directory_ownership` — why an unresolved project is unresolved —
 * lives in one small `app_meta` row per unresolved project
 * (`project_ownership.adoption.v1.project.<id>`), never in one growing blob:
 *   - `retryable`: ownership could not currently be inspected (an unavailable
 *     share, an I/O or permission failure); a later lifecycle run retries it;
 *   - `recovery-required`: ownership is definitively unprovable or
 *     conflicting; it stays quiet until explicit recovery (PM-1C2).
 * Bound and DB-only (`project_dir IS NULL`) projects carry no row: their state
 * is derived. Project IDs are AUTOINCREMENT and never reused; rows of deleted
 * projects are pruned.
 */
export const PROJECT_OWNERSHIP_ADOPTION_KEY = 'project_ownership.adoption.v1';
const PROJECT_KEY_PREFIX = `${PROJECT_OWNERSHIP_ADOPTION_KEY}.project.`;

export const PROJECT_OWNERSHIP_ADOPTION_OUTCOMES = Object.freeze([
  'bound', // already bound with a matching marker (nothing written)
  'adopted', // bound by this lifecycle from matching legacy evidence
  'completed', // an interrupted pending binding was completed
  'notRequired', // no stored project directory: DB-only project
  'retryable', // could not currently inspect; retried later
  'recoveryRequired', // definitively unprovable or conflicting (PM-1C2)
]);
const OUTCOMES = new Set(PROJECT_OWNERSHIP_ADOPTION_OUTCOMES);
export const PROJECT_OWNERSHIP_CLASSIFICATIONS = Object.freeze(['retryable', 'recovery-required']);
const CLASSIFICATIONS = new Set(PROJECT_OWNERSHIP_CLASSIFICATIONS);
const PHASES = new Set(['running', 'completed']);
const REASON_RE = /^[a-z][a-z-]{0,63}$/;

export class InvalidProjectOwnershipAdoptionRecordError extends Error {
  constructor() {
    super('Invalid project ownership adoption record.');
    this.name = 'InvalidProjectOwnershipAdoptionRecordError';
  }
}

const count = (value) => Number.isSafeInteger(value) && value >= 0;

function emptyCounts() {
  return Object.fromEntries(PROJECT_OWNERSHIP_ADOPTION_OUTCOMES.map((outcome) => [outcome, 0]));
}

function trusted(record) {
  return record && typeof record === 'object' && !Array.isArray(record)
    && record.version === 1 && PHASES.has(record.phase)
    && count(record.cursor) && count(record.upperBound) && record.cursor <= record.upperBound
    && record.counts && typeof record.counts === 'object'
    && PROJECT_OWNERSHIP_ADOPTION_OUTCOMES.every((outcome) => count(record.counts[outcome]));
}

function projectKey(projectId) {
  return `${PROJECT_KEY_PREFIX}${projectId}`;
}

function parseClassification(key, raw) {
  const projectId = Number(key.slice(PROJECT_KEY_PREFIX.length));
  if (!Number.isSafeInteger(projectId) || projectId < 1) return null;
  let value;
  try { value = JSON.parse(raw); } catch { value = null; }
  // An untrusted row proves nothing; report it as needing a fresh look.
  if (!value || value.version !== 1 || !CLASSIFICATIONS.has(value.status) || !REASON_RE.test(value.reason ?? '')) {
    return { projectId, status: 'retryable', reason: 'classification-invalid', updatedAt: null };
  }
  return { projectId, status: value.status, reason: value.reason, updatedAt: value.updatedAt ?? null };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ appMetaRepository?: object, now?: () => Date }} [options]
 */
export function createProjectOwnershipAdoptionRepository(db, {
  appMetaRepository = null, now = () => new Date(),
} = {}) {
  const appMeta = appMetaRepository ?? createAppMetaRepository(db);
  const upperBoundStmt = db.prepare('SELECT COALESCE(MAX(id), 0) AS upperBound FROM projects');
  // Driven by SQLite projects (archived included), never by directory
  // enumeration: a directory without a DB project is never adopted.
  const pageStmt = db.prepare(`SELECT id, project_dir FROM projects
    WHERE id > ? AND id <= ? ORDER BY id ASC LIMIT ?`);
  const findProjectStmt = db.prepare('SELECT id, project_dir FROM projects WHERE id = ?');
  const listClassificationsStmt = db.prepare('SELECT key, value FROM app_meta WHERE key GLOB ?');
  const deleteKeyStmt = db.prepare('DELETE FROM app_meta WHERE key = ?');
  // Compare-and-delete: only the exact stored value that was observed, and
  // only while the project is still bound to the token observed healthy.
  const retireStmt = db.prepare(`DELETE FROM app_meta WHERE key = ? AND value = ?
    AND EXISTS (SELECT 1 FROM project_directory_ownership
      WHERE project_id = ? AND state = 'bound' AND token = ?)`);
  const pruneStmt = db.prepare(`DELETE FROM app_meta WHERE key GLOB ?
    AND CAST(substr(key, ?) AS INTEGER) NOT IN (SELECT id FROM projects)`);
  const prefixGlob = `${PROJECT_KEY_PREFIX}*`;

  function read() {
    const raw = appMeta.getValue(PROJECT_OWNERSHIP_ADOPTION_KEY);
    if (raw === undefined) return null;
    let record;
    try { record = JSON.parse(raw); } catch { throw new InvalidProjectOwnershipAdoptionRecordError(); }
    if (!trusted(record)) throw new InvalidProjectOwnershipAdoptionRecordError();
    return record;
  }

  function save(record) {
    const next = { ...record, updatedAt: now().toISOString() };
    appMeta.setValue(PROJECT_OWNERSHIP_ADOPTION_KEY, JSON.stringify(next));
    return next;
  }

  function writeClassification(projectId, classification) {
    if (!classification) {
      deleteKeyStmt.run(projectKey(projectId));
      return;
    }
    if (!CLASSIFICATIONS.has(classification.status) || !REASON_RE.test(classification.reason ?? '')) {
      throw new Error('Invalid project ownership adoption classification.');
    }
    appMeta.setValue(projectKey(projectId), JSON.stringify({
      version: 1, status: classification.status, reason: classification.reason,
      updatedAt: now().toISOString(),
    }));
  }

  function freshPass() {
    return {
      version: 1, phase: 'running', cursor: 0,
      upperBound: upperBoundStmt.get().upperBound, counts: emptyCounts(),
    };
  }

  const initializeTx = db.transaction(() => {
    let record;
    try { record = read(); } catch (error) {
      if (!(error instanceof InvalidProjectOwnershipAdoptionRecordError)) throw error;
      // Untrusted progress: re-run the pass. Every step is idempotent and an
      // already bound project costs no legacy read.
      return save(freshPass());
    }
    // First start with PM-1C1 (existing install, fresh install, or a restored
    // database that predates it): the fixed bound keeps the pass from chasing
    // projects created meanwhile, which bind themselves at creation.
    return record ?? save(freshPass());
  });

  const commitStepTx = db.transaction((projectId, outcome, classification) => {
    const record = read();
    if (!record || record.phase !== 'running' || projectId <= record.cursor || projectId > record.upperBound) {
      return null;
    }
    if (!OUTCOMES.has(outcome)) throw new Error(`Unknown adoption outcome "${outcome}".`);
    writeClassification(projectId, classification);
    return save({
      ...record, cursor: projectId,
      counts: { ...record.counts, [outcome]: record.counts[outcome] + 1 },
    });
  });

  const completeTx = db.transaction(() => {
    const record = read();
    if (!record || record.phase === 'completed') return record;
    return save({ ...record, phase: 'completed', cursor: record.upperBound });
  });

  return {
    /** @returns {object|null} @throws {InvalidProjectOwnershipAdoptionRecordError} */
    get: read,

    /** Return the durable record, starting the one-time pass when none exists. */
    initialize: () => initializeTx(),

    /** True once every project up to the pass's upper bound was classified. */
    isInitialPassComplete() {
      try { return read()?.phase === 'completed'; } catch { return false; }
    },

    /** Next projects of the pass, in stable ID order. */
    page: (cursor, upperBound, limit = 32) => pageStmt.all(cursor, upperBound, limit),

    /** @returns {{ id: number, project_dir: string|null }|null} */
    findProject: (projectId) => findProjectStmt.get(projectId) ?? null,

    /**
     * Record one project's pass outcome and its classification (null clears
     * it), and advance the cursor to it, in one transaction. Returns the new
     * record, or null when the pass no longer expects this project.
     */
    commitStep: (projectId, outcome, classification = null) => commitStepTx(projectId, outcome, classification),

    /** Mark the pass complete (idempotent). */
    complete: () => completeTx(),

    /** @returns {{ projectId, status, reason, updatedAt }|null} */
    getClassification(projectId) {
      const raw = appMeta.getValue(projectKey(projectId));
      return raw === undefined ? null : parseClassification(projectKey(projectId), raw);
    },

    /**
     * The classification plus an opaque `revision` (its exact stored value),
     * for a later `retireClassification` guard.
     * @returns {{ classification: object, revision: string }|null}
     */
    readClassification(projectId) {
      const raw = appMeta.getValue(projectKey(projectId));
      return raw === undefined ? null : { classification: parseClassification(projectKey(projectId), raw), revision: raw };
    },

    /**
     * Retire a classification that a fresh inspection proved obsolete (bound
     * row, matching marker). One conditional statement: it deletes only when
     * the stored value is still exactly `revision` and the project is still
     * bound to `token`, so it never erases a classification written since.
     * @returns {boolean} whether the row was removed
     */
    retireClassification: (projectId, { revision, token }) => (
      typeof revision === 'string' && typeof token === 'string'
        && retireStmt.run(projectKey(projectId), revision, projectId, token).changes === 1
    ),

    /** Set (or with null, clear) one project's classification outside the pass. */
    setClassification: (projectId, classification) => writeClassification(projectId, classification),

    /** Every unresolved project's classification, in project-ID order. */
    listClassifications() {
      return listClassificationsStmt.all(prefixGlob)
        .map((row) => parseClassification(row.key, row.value))
        .filter(Boolean)
        .sort((a, b) => a.projectId - b.projectId);
    },

    /** Remove classifications of projects that no longer exist. */
    pruneDeleted: () => pruneStmt.run(prefixGlob, PROJECT_KEY_PREFIX.length + 1).changes,
  };
}
