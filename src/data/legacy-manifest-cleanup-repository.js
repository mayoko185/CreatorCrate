import { createAppMetaRepository } from './app-meta-repository.js';

/**
 * Legacy `project.json` cleanup lifecycle state (PM-2) — `app_meta` records
 * only; no schema of its own. Same shape as the PM-1C1 adoption lifecycle.
 *
 * The lifecycle record (`legacy_manifest_cleanup.v1`) is small and bounded:
 * the one-time pass's phase, its committed cursor over SQLite project IDs,
 * the fixed upper bound captured when the pass started (projects created
 * later never get a manifest), and cumulative counts. It holds no
 * per-project list.
 *
 * Per-project state lives in one small `app_meta` row per project that still
 * has something to report (`legacy_manifest_cleanup.v1.project.<id>`):
 *   - `retryable`: could not currently inspect or remove (an unavailable
 *     share, an I/O failure, a busy project, a file that changed); retried;
 *   - `ownership-not-ready`: ownership is not bound and verified (or
 *     adoption/recovery still has it); reconsidered on later runs;
 *   - `retained`: a legacy file was kept on purpose (divergent, invalid,
 *     unsafe); terminal — never deleted automatically.
 * `reasons` are short codes only; no manifest content or path is stored.
 * Projects whose manifests were removed, or that never had one, carry no row.
 * Project IDs are AUTOINCREMENT and never reused; rows of deleted projects
 * are pruned.
 */
export const LEGACY_MANIFEST_CLEANUP_KEY = 'legacy_manifest_cleanup.v1';
const PROJECT_KEY_PREFIX = `${LEGACY_MANIFEST_CLEANUP_KEY}.project.`;

/** Cumulative counts: files removed, and projects classified by the pass. */
export const LEGACY_MANIFEST_CLEANUP_COUNTS = Object.freeze([
  'removed', // project.json files removed as proven duplicates
  'tempRemoved', // legacy temp files / interrupted-removal quarantines removed
  'noManifest', // pass: bound project with no legacy file at all
  'notRequired', // pass: DB-only project (no stored directory)
]);
export const LEGACY_MANIFEST_CLEANUP_STATUSES = Object.freeze(['retryable', 'ownership-not-ready', 'retained']);
const STATUSES = new Set(LEGACY_MANIFEST_CLEANUP_STATUSES);
const PHASES = new Set(['running', 'completed']);
const REASON_RE = /^[a-z][a-z-]{0,63}$/;
const MAX_REASONS = 16;

export class InvalidLegacyManifestCleanupRecordError extends Error {
  constructor() {
    super('Invalid legacy manifest cleanup record.');
    this.name = 'InvalidLegacyManifestCleanupRecordError';
  }
}

const count = (value) => Number.isSafeInteger(value) && value >= 0;

function emptyCounts() {
  return Object.fromEntries(LEGACY_MANIFEST_CLEANUP_COUNTS.map((name) => [name, 0]));
}

function trusted(record) {
  return record && typeof record === 'object' && !Array.isArray(record)
    && record.version === 1 && PHASES.has(record.phase)
    && count(record.cursor) && count(record.upperBound) && record.cursor <= record.upperBound
    && record.counts && typeof record.counts === 'object'
    && LEGACY_MANIFEST_CLEANUP_COUNTS.every((name) => count(record.counts[name]));
}

function projectKey(projectId) {
  return `${PROJECT_KEY_PREFIX}${projectId}`;
}

function validReasons(reasons) {
  return Array.isArray(reasons) && reasons.length > 0 && reasons.length <= MAX_REASONS
    && reasons.every((reason) => typeof reason === 'string' && REASON_RE.test(reason));
}

function parseEntry(key, raw) {
  const projectId = Number(key.slice(PROJECT_KEY_PREFIX.length));
  if (!Number.isSafeInteger(projectId) || projectId < 1) return null;
  let value;
  try { value = JSON.parse(raw); } catch { value = null; }
  // An untrusted row proves nothing: report it as needing a fresh look.
  if (!value || value.version !== 1 || !STATUSES.has(value.status) || !validReasons(value.reasons)) {
    return { projectId, status: 'retryable', reasons: ['classification-invalid'], updatedAt: null };
  }
  return { projectId, status: value.status, reasons: [...value.reasons], updatedAt: value.updatedAt ?? null };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ appMetaRepository?: object, now?: () => Date }} [options]
 */
export function createLegacyManifestCleanupRepository(db, {
  appMetaRepository = null, now = () => new Date(),
} = {}) {
  const appMeta = appMetaRepository ?? createAppMetaRepository(db);
  const upperBoundStmt = db.prepare('SELECT COALESCE(MAX(id), 0) AS upperBound FROM projects');
  // Driven by SQLite projects (archived included), never by directory
  // enumeration: a directory without a DB project is never touched.
  const PROJECT_COLUMNS = 'id, title, slug, description, notes, patreon_url, created_at, updated_at, project_dir';
  const pageStmt = db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects
    WHERE id > ? AND id <= ? ORDER BY id ASC LIMIT ?`);
  const findProjectStmt = db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`);
  // Exactly what the legacy writer passed to serializeManifest.
  const categoriesStmt = db.prepare(`SELECT display_name, directory_slug, display_order, enabled
    FROM project_asset_categories WHERE project_id = ? ORDER BY display_order ASC, id ASC`);
  const listEntriesStmt = db.prepare('SELECT key, value FROM app_meta WHERE key GLOB ?');
  const deleteKeyStmt = db.prepare('DELETE FROM app_meta WHERE key = ?');
  const pruneStmt = db.prepare(`DELETE FROM app_meta WHERE key GLOB ?
    AND CAST(substr(key, ?) AS INTEGER) NOT IN (SELECT id FROM projects)`);
  const prefixGlob = `${PROJECT_KEY_PREFIX}*`;

  function read() {
    const raw = appMeta.getValue(LEGACY_MANIFEST_CLEANUP_KEY);
    if (raw === undefined) return null;
    let record;
    try { record = JSON.parse(raw); } catch { throw new InvalidLegacyManifestCleanupRecordError(); }
    if (!trusted(record)) throw new InvalidLegacyManifestCleanupRecordError();
    return record;
  }

  function save(record) {
    const next = { ...record, updatedAt: now().toISOString() };
    appMeta.setValue(LEGACY_MANIFEST_CLEANUP_KEY, JSON.stringify(next));
    return next;
  }

  function writeEntry(projectId, entry) {
    if (!entry) {
      deleteKeyStmt.run(projectKey(projectId));
      return;
    }
    const reasons = [...new Set(entry.reasons ?? [])].slice(0, MAX_REASONS);
    if (!STATUSES.has(entry.status) || !validReasons(reasons)) {
      throw new Error('Invalid legacy manifest cleanup classification.');
    }
    appMeta.setValue(projectKey(projectId), JSON.stringify({
      version: 1, status: entry.status, reasons, updatedAt: now().toISOString(),
    }));
  }

  function addCounts(record, delta = {}) {
    const counts = { ...record.counts };
    for (const [name, value] of Object.entries(delta)) {
      if (!Object.prototype.hasOwnProperty.call(counts, name) || !count(value)) {
        throw new Error(`Invalid legacy manifest cleanup count "${name}".`);
      }
      counts[name] += value;
    }
    return counts;
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
      if (!(error instanceof InvalidLegacyManifestCleanupRecordError)) throw error;
      // Untrusted progress: re-run the pass. Every step is idempotent.
      return save(freshPass());
    }
    return record ?? save(freshPass());
  });

  const commitStepTx = db.transaction((projectId, delta, entry) => {
    const record = read();
    if (!record || record.phase !== 'running' || projectId <= record.cursor || projectId > record.upperBound) {
      return null;
    }
    writeEntry(projectId, entry);
    return save({ ...record, cursor: projectId, counts: addCounts(record, delta) });
  });

  const commitRetryTx = db.transaction((projectId, delta, entry) => {
    writeEntry(projectId, entry);
    const record = read();
    return record ? save({ ...record, counts: addCounts(record, delta) }) : null;
  });

  const completeTx = db.transaction(() => {
    const record = read();
    if (!record || record.phase === 'completed') return record;
    return save({ ...record, phase: 'completed', cursor: record.upperBound });
  });

  return {
    /** @returns {object|null} @throws {InvalidLegacyManifestCleanupRecordError} */
    get: read,

    /** Return the durable record, starting the one-time pass when none exists. */
    initialize: () => initializeTx(),

    /** Next projects of the pass, in stable ID order. */
    page: (cursor, upperBound, limit = 32) => pageStmt.all(cursor, upperBound, limit),

    /** @returns {object|null} the current project row (legacy-relevant columns) */
    findProject: (projectId) => findProjectStmt.get(projectId) ?? null,

    /** The project-owned categories in the legacy writer's order. */
    listCategories: (projectId) => categoriesStmt.all(projectId),

    /**
     * Record one project's pass result (count deltas and its entry; null
     * clears it) and advance the cursor to it, in one transaction. Returns
     * the new record, or null when the pass no longer expects this project.
     */
    commitStep: (projectId, delta = {}, entry = null) => commitStepTx(projectId, delta, entry),

    /** Record a later run's result for one project outside the pass. */
    commitRetry: (projectId, delta = {}, entry = null) => commitRetryTx(projectId, delta, entry),

    /** Mark the pass complete (idempotent). */
    complete: () => completeTx(),

    /** @returns {{ projectId, status, reasons, updatedAt }|null} */
    getEntry(projectId) {
      const raw = appMeta.getValue(projectKey(projectId));
      return raw === undefined ? null : parseEntry(projectKey(projectId), raw);
    },

    /** Every project with something to report, in project-ID order. */
    listEntries() {
      return listEntriesStmt.all(prefixGlob)
        .map((row) => parseEntry(row.key, row.value))
        .filter(Boolean)
        .sort((a, b) => a.projectId - b.projectId);
    },

    /** Remove entries of projects that no longer exist. */
    pruneDeleted: () => pruneStmt.run(prefixGlob, PROJECT_KEY_PREFIX.length + 1).changes,
  };
}
