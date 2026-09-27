import { createAppMetaRepository } from './app-meta-repository.js';
import { PREVIEWABLE_ASSET_SQL } from './generated-image-rebuild-repository.js';

/**
 * Generated-image publication lifecycle state — the versioned `app_meta`
 * record that says whether the normalized publication tables are a
 * trustworthy runtime authority yet, and why.
 *
 * `mode` distinguishes how the tables came to be (never inferred from them):
 *   - 'upgrade': an existing install reached migration 041 and its legacy
 *     filesystem cache is imported once, driven by SQLite assets in stable
 *     ID order up to the `upperBound` captured when the pass started.
 *   - 'restore': an explicit database restore reset the derived publication
 *     state in the staged database; nothing is imported from the filesystem
 *     and every asset is regenerated through the rebuild machinery.
 *   - 'reset': the record itself was untrusted; handled like 'restore'
 *     (regenerate, never import) without discarding committed rows.
 *
 * `phase` is 'running' only for an unfinished upgrade import; 'completed'
 * means the tables are the publication index (GI-4 may read them).
 * `repairRequired` durably records that some asset has no trustworthy
 * committed publication and a rebuild pass must still be admitted.
 *
 * Progress (`cursor`, `counts`) advances in the same transaction that
 * installs the imported snapshot or records the decided per-asset outcome.
 */
export const GENERATED_IMAGE_PUBLICATION_LIFECYCLE_KEY = 'images.publication_lifecycle.v1';

const MODES = new Set(['upgrade', 'restore', 'reset']);
const PHASES = new Set(['running', 'completed']);

/** Per-asset backfill outcomes; every one except `imported` leaves no new row. */
export const BACKFILL_OUTCOMES = Object.freeze([
  'imported', // valid legacy publication installed
  'alreadyPublished', // a committed publication already existed (e.g. the writer's)
  'recoveryPending', // an unresolved intent owns the asset; recovery decides it
  'gone', // asset deleted while the pass ran
  'missing', // no current.json (never generated, or cache deleted)
  'malformed', // current.json unparsable/unsupported schema
  'unreadable', // current.json or cache path unreadable/unsafe
  'invalid', // generation directory or meta.json invalid / not corresponding
  'incomplete', // thumbnail/preview pair incomplete or not matching meta.json
  'stale', // valid pair for a source/config that is no longer the asset's
  'unnormalizable', // meta.json cannot be expressed by the publication contract
]);
const OUTCOMES = new Set(BACKFILL_OUTCOMES);
// Outcomes that leave an asset without a trustworthy committed publication.
const REPAIR_OUTCOMES = new Set(['missing', 'malformed', 'unreadable', 'invalid', 'incomplete', 'stale',
  'unnormalizable']);

export class InvalidGeneratedImagePublicationLifecycleRecordError extends Error {
  constructor() {
    super('Invalid generated-image publication lifecycle record.');
    this.name = 'InvalidGeneratedImagePublicationLifecycleRecordError';
  }
}

const count = (value) => Number.isSafeInteger(value) && value >= 0;

function emptyCounts() {
  return Object.fromEntries(BACKFILL_OUTCOMES.map((outcome) => [outcome, 0]));
}

function trusted(record) {
  return record && typeof record === 'object' && !Array.isArray(record)
    && record.version === 1 && MODES.has(record.mode) && PHASES.has(record.phase)
    && count(record.cursor) && count(record.upperBound) && record.cursor <= record.upperBound
    && typeof record.repairRequired === 'boolean'
    && record.counts && typeof record.counts === 'object'
    && BACKFILL_OUTCOMES.every((outcome) => count(record.counts[outcome]))
    && (record.mode === 'upgrade' || record.phase === 'completed');
}

/** The completed, import-free record a restore (or untrusted state) leaves. */
function regenerationRecord(mode, now) {
  return {
    version: 1, mode, phase: 'completed', cursor: 0, upperBound: 0,
    repairRequired: true, counts: emptyCounts(), updatedAt: now,
  };
}

/**
 * Reset the derived publication index of a staged restore database before it
 * is adopted: remove every committed publication, derivative, and intent, and
 * mark the database for regeneration (never for the legacy-cache import).
 * One transaction; the generated cache directories are not touched.
 *
 * @param {import('better-sqlite3').Database} db - the staged, migrated restore DB
 */
export function resetGeneratedImagePublicationsForRestore(db, { now = () => new Date() } = {}) {
  const appMeta = createAppMetaRepository(db);
  db.transaction(() => {
    db.prepare('DELETE FROM generated_image_derivatives').run();
    db.prepare('DELETE FROM generated_image_publications').run();
    db.prepare('DELETE FROM generated_image_publication_intents').run();
    appMeta.setValue(GENERATED_IMAGE_PUBLICATION_LIFECYCLE_KEY,
      JSON.stringify(regenerationRecord('restore', now().toISOString())));
  })();
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ now?: () => Date }} [options]
 */
export function createGeneratedImagePublicationLifecycleRepository(db, { now = () => new Date() } = {}) {
  const appMeta = createAppMetaRepository(db);
  const upperBoundStmt = db.prepare(`SELECT COALESCE(MAX(a.id), 0) AS upperBound
    FROM assets a JOIN projects p ON p.id = a.project_id WHERE ${PREVIEWABLE_ASSET_SQL}`);
  // Every DB-owned previewable asset, whatever its project's status or its
  // presence: an archived project's (or a temporarily missing source's)
  // published cache is still that asset's generation. Cache directories
  // without a DB-owned asset are never visited.
  const pageStmt = db.prepare(`SELECT a.id, a.project_id
    FROM assets a JOIN projects p ON p.id = a.project_id
    WHERE ${PREVIEWABLE_ASSET_SQL} AND a.id > ? AND a.id <= ?
    ORDER BY a.id ASC LIMIT ?`);

  function read() {
    const raw = appMeta.getValue(GENERATED_IMAGE_PUBLICATION_LIFECYCLE_KEY);
    if (raw === undefined) return null;
    let record;
    try { record = JSON.parse(raw); } catch { throw new InvalidGeneratedImagePublicationLifecycleRecordError(); }
    if (!trusted(record)) throw new InvalidGeneratedImagePublicationLifecycleRecordError();
    return record;
  }

  function save(record) {
    const next = { ...record, updatedAt: now().toISOString() };
    appMeta.setValue(GENERATED_IMAGE_PUBLICATION_LIFECYCLE_KEY, JSON.stringify(next));
    return next;
  }

  const initializeTx = db.transaction(() => {
    let record;
    try { record = read(); } catch (error) {
      if (!(error instanceof InvalidGeneratedImagePublicationLifecycleRecordError)) throw error;
      // Untrusted progress proves nothing about what was imported: never
      // (re)import legacy JSON on its word; regenerate what lacks a row.
      return save(regenerationRecord('reset'));
    }
    if (record) return record;
    // First start on the normalized schema (existing install or fresh one):
    // capture a fixed upper bound so the pass cannot chase new assets, whose
    // publications the journaling writer records itself.
    return save({
      version: 1, mode: 'upgrade', phase: 'running', cursor: 0,
      upperBound: upperBoundStmt.get().upperBound,
      repairRequired: false, counts: emptyCounts(),
    });
  });

  const commitStepTx = db.transaction((assetId, outcome, install) => {
    const record = read();
    if (!record || record.mode !== 'upgrade' || record.phase !== 'running'
      || assetId <= record.cursor || assetId > record.upperBound) return null;
    let decided = outcome;
    if (decided === 'imported') {
      const installed = install();
      decided = {
        installed: 'imported', 'already-published': 'alreadyPublished',
        'intent-pending': 'recoveryPending', gone: 'gone',
      }[installed];
    }
    if (!OUTCOMES.has(decided)) throw new Error(`Unknown backfill outcome "${decided}".`);
    return save({
      ...record, cursor: assetId,
      repairRequired: record.repairRequired || REPAIR_OUTCOMES.has(decided),
      counts: { ...record.counts, [decided]: record.counts[decided] + 1 },
    });
  });

  const completeTx = db.transaction(() => {
    const record = read();
    if (!record || record.phase === 'completed') return record;
    return save({ ...record, phase: 'completed', cursor: record.upperBound });
  });

  const setRepairRequiredTx = db.transaction((value) => {
    const record = read();
    if (!record || record.repairRequired === value) return record;
    return save({ ...record, repairRequired: value });
  });

  return {
    /** @returns {object|null} @throws {InvalidGeneratedImagePublicationLifecycleRecordError} */
    get: read,

    /**
     * Return the durable record, creating the one-time upgrade pass when none
     * exists and replacing an untrusted record with a regeneration record.
     */
    initialize: () => initializeTx(),

    /** True once the normalized tables are the publication index. */
    isPublicationIndexReady() {
      try { return read()?.phase === 'completed'; } catch { return false; }
    },

    /** Next assets of the upgrade pass, in stable ID order. */
    page: (cursor, upperBound, limit = 32) => pageStmt.all(cursor, upperBound, limit),

    /**
     * Record one asset's decided backfill outcome and advance the cursor to
     * it, atomically with `install()` when the outcome is 'imported' (the
     * install result may downgrade it). Returns the new record, or null when
     * the pass no longer expects this asset (already committed, or ended).
     */
    commitStep: (assetId, outcome, install = null) => commitStepTx(assetId, outcome, install),

    /** Mark the upgrade pass complete (idempotent). */
    complete: () => completeTx(),

    markRepairRequired: () => setRepairRequiredTx(true),
    clearRepairRequired: () => setRepairRequiredTx(false),

    /** Run `fn` in one transaction (a savepoint when nested). */
    transaction: (fn) => db.transaction(fn)(),
  };
}
