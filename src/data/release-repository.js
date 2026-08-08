export const RELEASE_ASSET_ROLES = ['primary', 'preview', 'attachment', 'source'];

const COLUMNS = [
  'id',
  'project_id',
  'title',
  'description',
  'notes',
  'planned_date',
  'planned_time',
  'published_date',
  'patreon_url',
  'created_at',
  'updated_at',
  'archived_at',
];

const RELEASE_ASSET_COLUMNS = [
  'release_id',
  'asset_id',
  'role',
  'sort_order',
  'created_at',
];

const QUALIFIED_RELEASE_COLUMNS = COLUMNS.map((column) => `releases.${column}`).join(', ');
const SELECT_ALL_WITH_PROJECT = `SELECT ${QUALIFIED_RELEASE_COLUMNS}, projects.status AS project_status FROM releases JOIN projects ON projects.id = releases.project_id`;
const RELEASE_COLUMNS_WITH_ALIAS = (alias) => COLUMNS.map((column) => `${alias}.${column}`).join(', ');

function buildReleaseInsertValues(input) {
  return [
    input.projectId,
    input.title,
    input.description,
    input.notes,
    input.plannedDate ?? null,
    input.plannedTime ?? null,
    input.patreonUrl ?? null,
    input.publishedDate ?? null,
  ];
}

/**
 * Shared WHERE fragment: releases that are active and unpublished. Used by
 * overdue, upcoming, and missing-planned-date queries so the active-set
 * definition stays in one place.
 */
const ACTIVE_UNPUBLISHED = `releases.archived_at IS NULL AND releases.published_date IS NULL`;

/**
 * Shared EXISTS fragment: release belongs to a project that is not archived.
 * Used by every dashboard workflow query so an active release whose parent
 * project has been archived is hidden from attention lists. Archived
 * projects remain readable through the project workspace (historical recent
 * list) — only the actionable attention lists are filtered.
 *
 * The fragment references `releases.project_id` and assumes the implicit
 * from-table of the surrounding query is `releases`.
 */
const ACTIVE_PARENT_PROJECT = `EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = releases.project_id
    AND projects.archived_at IS NULL
)`;

/**
 * Shared full WHERE fragment for the dashboard attention lists: release is
 * active and unpublished, and belongs to a non-archived project. Combines
 * {@link ACTIVE_UNPUBLISHED} with the parent-project check.
 */
const DASHBOARD_ACTIVE = `${ACTIVE_UNPUBLISHED} AND ${ACTIVE_PARENT_PROJECT}`;

// ─── Phase 7D-1: Readiness classification projection ────────────────────
//
// The shared readiness policy (`evaluateReleaseReadiness`) is the single
// source of truth for what "publishable" means. The conditions below are a
// narrow, repository-only SQL projection of that policy so list/board
// pagination can filter in the database instead of loading every release.
//
// Keep the projection in sync with the policy's material blockers:
//   - the owning project must have status 'ready'
//   - release must not be archived
//   - parent project must not be archived (enforced by activeScheduleFilter)
//   - at least one selected asset must exist
//   - no selected asset may be missing
//
// UI indicators still come from `_attachReadiness` calling the policy.

const READINESS_VALUES = Object.freeze(['all', 'publishable', 'blocked-ready']);

function selectedAssetCountSubquery(table = 'releases') {
  return `(SELECT COUNT(DISTINCT a.id) FROM release_assets ra JOIN assets a ON a.id = ra.asset_id AND a.project_id = ${table}.project_id WHERE ra.release_id = ${table}.id)`;
}

function missingAssetCountSubquery(table = 'releases') {
  return `(SELECT COUNT(DISTINCT a.id) FROM release_assets ra JOIN assets a ON a.id = ra.asset_id AND a.project_id = ${table}.project_id WHERE ra.release_id = ${table}.id AND a.is_present = 0)`;
}

/**
 * @typedef {object} ReleaseRecord
 * @property {number} id
 * @property {number} project_id
 * @property {string} title
 * @property {string} description
 * @property {string} notes
 * @property {string|null} planned_date
 * @property {string|null} planned_time
 * @property {string|null} published_date
 * @property {string|null} patreon_url
 * @property {string} created_at
 * @property {string} updated_at
 * @property {string|null} archived_at
 */

/**
 * @typedef {object} ReleaseAssetRecord
 * @property {number} release_id
 * @property {number} asset_id
 * @property {string} role
 * @property {number} sort_order
 * @property {string} created_at
 */

export function createReleaseRepository(db) {
  const findById = db.prepare(`${SELECT_ALL_WITH_PROJECT} WHERE releases.id = ?`);
  const insert = db.prepare(`
    INSERT INTO releases (project_id, title, description, notes, planned_date, planned_time, patreon_url, published_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING ${COLUMNS.join(', ')}
  `);
  const update = db.prepare(`
    UPDATE releases
    SET title = ?, description = ?, notes = ?,
        planned_date = ?, planned_time = ?, patreon_url = ?, published_date = ?, updated_at = datetime('now')
    WHERE id = ? AND archived_at IS NULL
    RETURNING ${COLUMNS.join(', ')}
  `);
  const archive = db.prepare(`
    UPDATE releases
    SET archived_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND archived_at IS NULL
    RETURNING ${COLUMNS.join(', ')}
  `);
  const deleteRelease = db.prepare(`
    DELETE FROM releases
    WHERE id = ?
  `);
  const setPublishedDate = db.prepare(`
    UPDATE releases
    SET published_date = ?, updated_at = datetime('now')
    WHERE id = ? AND archived_at IS NULL
    RETURNING ${COLUMNS.join(', ')}
  `);

  const findCalendarRangeStmt = db.prepare(`
    SELECT
      r.id,
      r.project_id,
      p.title AS project_title,
      p.status AS project_status,
      r.title,
      r.notes,
      r.planned_date,
      r.planned_time,
      r.published_date,
      r.archived_at
    FROM releases r
    JOIN projects p ON p.id = r.project_id
    WHERE r.archived_at IS NULL
      AND r.planned_date IS NOT NULL
      AND r.planned_date >= ?
      AND r.planned_date < ?
    ORDER BY
      r.planned_date ASC,
      (NULLIF(r.planned_time, '') IS NULL) ASC,
      NULLIF(r.planned_time, '') ASC,
      r.id ASC
  `);

  // ─── Release Asset Selection ───────────────────────────────────────────

  const raFindByRelease = db.prepare(`
    SELECT ra.release_id, ra.asset_id, ra.role, ra.sort_order, ra.created_at,
           a.project_id, a.category_id, a.relative_path, a.nested_path, a.filename, a.extension,
           a.mime_type, a.size_bytes, a.modified_at, a.is_present,
           a.last_seen_at, a.missing_since, a.created_at as asset_created_at,
           a.updated_at as asset_updated_at
    FROM release_assets ra
    JOIN assets a ON a.id = ra.asset_id
    WHERE ra.release_id = ?
      AND a.project_id = (SELECT project_id FROM releases WHERE id = ?)
    ORDER BY ra.sort_order ASC, ra.asset_id ASC
  `);

  const raCountByRelease = db.prepare(`
    SELECT COUNT(*) AS c FROM release_assets ra
    JOIN assets a ON a.id = ra.asset_id AND a.project_id = (SELECT project_id FROM releases WHERE id = ?)
    WHERE ra.release_id = ?
  `);

  const readinessFactsById = db.prepare(`
    SELECT
      r.id AS release_id,
      r.project_id,
      p.status AS project_status,
      r.archived_at AS release_archived_at,
      p.archived_at AS project_archived_at,
      COUNT(DISTINCT CASE WHEN a.id IS NOT NULL THEN a.id END) AS selected_asset_count,
      COUNT(DISTINCT CASE WHEN a.is_present = 1 THEN a.id END) AS present_selected_asset_count,
      COUNT(DISTINCT CASE WHEN a.is_present = 0 THEN a.id END) AS missing_selected_asset_count,
      COUNT(DISTINCT CASE WHEN a.id IS NOT NULL AND ra.role = 'primary' THEN a.id END) AS primary_role_count,
      COUNT(DISTINCT CASE WHEN a.id IS NOT NULL AND ra.role = 'preview' THEN a.id END) AS preview_role_count,
      COUNT(DISTINCT CASE WHEN a.id IS NOT NULL AND ra.role = 'attachment' THEN a.id END) AS attachment_role_count,
      COUNT(DISTINCT CASE WHEN a.id IS NOT NULL AND ra.role = 'source' THEN a.id END) AS source_role_count
    FROM releases r
    JOIN projects p ON p.id = r.project_id
    LEFT JOIN release_assets ra ON ra.release_id = r.id
    LEFT JOIN assets a ON a.id = ra.asset_id AND a.project_id = r.project_id
    WHERE r.id = ?
    GROUP BY r.id
  `);

  const raFindByAsset = db.prepare(`
    SELECT ra.release_id, ra.asset_id, ra.role, ra.sort_order, ra.created_at
    FROM release_assets ra
    WHERE ra.asset_id = ?
  `);

  /**
   * Ownership-aware insert: only inserts a release_assets row when the asset
   * belongs to the same project as the release. This is a repository-level
   * guard that prevents malformed cross-project junction rows even if the
   * service layer's validation is bypassed.
   *
   * Returns the inserted row on success, undefined on project mismatch.
   * Does NOT throw — the caller (service layer) is responsible for domain
   * validation and error messages.
   *
   * @type {import('better-sqlite3').Statement}
   */
  const raInsertOwnershipGuarded = db.prepare(`
    INSERT INTO release_assets (release_id, asset_id, role, sort_order)
    SELECT ?, ?, ?, ?
    WHERE (SELECT project_id FROM releases WHERE id = ?) = (SELECT project_id FROM assets WHERE id = ?)
    RETURNING release_id, asset_id, role, sort_order, created_at
  `);

  const raInsert = db.prepare(`
    INSERT INTO release_assets (release_id, asset_id, role, sort_order)
    VALUES (?, ?, ?, ?)
    RETURNING release_id, asset_id, role, sort_order, created_at
  `);

  const raDeleteOne = db.prepare(`
    DELETE FROM release_assets WHERE release_id = ? AND asset_id = ?
  `);

  const raDeleteByRelease = db.prepare(`
    DELETE FROM release_assets WHERE release_id = ?
  `);

  const raUpdateRole = db.prepare(`
    UPDATE release_assets SET role = ? WHERE release_id = ? AND asset_id = ?
  `);

  const raUpdateSortOrder = db.prepare(`
    UPDATE release_assets SET sort_order = ? WHERE release_id = ? AND asset_id = ?
  `);

  const replaceReleaseAssetsTx = db.transaction((releaseId, selections) => {
    raDeleteByRelease.run(releaseId);
    for (const sel of selections) {
      const row = raInsertOwnershipGuarded.get(releaseId, sel.assetId, sel.role, sel.sortOrder, releaseId, sel.assetId);
      // Ownership-guarded insert returns undefined when the asset does not
      // belong to the same project. This must throw so the transaction rolls
      // back — the caller is responsible for mapping this to a domain error.
      if (!row) {
        const err = new Error(`Asset ${sel.assetId} does not belong to the same project as release ${releaseId}`);
        err.code = 'CROSS_PROJECT_ASSET';
        throw err;
      }
    }
  });

  /**
   * Create a release and its initial asset selections atomically. The caller
   * supplies selections in the desired manual order; ownership is still
   * enforced by the guarded insert for every row.
   *
   * @param {Object} input
   * @param {Array<{assetId: number, role: string, sortOrder: number}>} selections
   * @returns {ReleaseRecord}
   */
  const createWithAssetSelectionsTx = db.transaction((input, selections) => {
    const release = insert.get(...buildReleaseInsertValues(input));

    for (const sel of selections) {
      const row = raInsertOwnershipGuarded.get(
        release.id,
        sel.assetId,
        sel.role,
        sel.sortOrder,
        release.id,
        sel.assetId,
      );
      if (!row) {
        const err = new Error(`Asset ${sel.assetId} does not belong to the same project as release ${release.id}`);
        err.code = 'CROSS_PROJECT_ASSET';
        throw err;
      }
    }

    return release;
  });

  const raExistingByReleaseStmt = db.prepare(`
    SELECT asset_id, sort_order FROM release_assets WHERE release_id = ?
  `);

  /**
   * Transactional bulk append: adds multiple assets to a release with role
   * 'attachment', appended contiguously after the current last manual-order
   * item. Already-associated asset IDs are skipped (not an error). Duplicate
   * IDs within the submitted array are deduplicated before insertion — they
   * never consume more than one order slot. Existing rows (asset IDs, roles,
   * sort_order) are never touched.
   *
   * One synchronous transaction — either every new row is appended or none
   * are (e.g. an ownership mismatch rolls back the entire append).
   *
   * @param {number} releaseId
   * @param {number[]} assetIds - pre-validated positive integers, in the
   *   desired append order (e.g. the visible-page order the caller built)
   * @returns {{ added: number, alreadyAssociated: number }}
   */
  const appendAssetsToReleaseTx = db.transaction((releaseId, assetIds) => {
    const existingRows = raExistingByReleaseStmt.all(releaseId);
    const existingIds = new Set(existingRows.map((r) => r.asset_id));
    let nextOrder = existingRows.length > 0
      ? Math.max(...existingRows.map((r) => r.sort_order)) + 1
      : 0;

    let added = 0;
    let alreadyAssociated = 0;
    const seen = new Set();

    for (const assetId of assetIds) {
      // Deduplicate the submission itself — a repeated ID must not consume
      // an extra order slot or attempt a second insert.
      if (seen.has(assetId)) continue;
      seen.add(assetId);

      if (existingIds.has(assetId)) {
        alreadyAssociated++;
        continue;
      }

      const row = raInsertOwnershipGuarded.get(releaseId, assetId, 'attachment', nextOrder, releaseId, assetId);
      if (!row) {
        const err = new Error(`Asset ${assetId} does not belong to the same project as release ${releaseId}`);
        err.code = 'CROSS_PROJECT_ASSET';
        throw err;
      }

      existingIds.add(assetId);
      nextOrder += 1;
      added += 1;
    }

    return { added, alreadyAssociated };
  });

  /**
   * Transactional reindex: read all rows for a release in deterministic order
   * (sort_order ASC, asset_id ASC) and assign contiguous sort_order values
   * 0..n-1. This normalizes legacy gaps or duplicates after any curation
   * mutation.
   */
  const reindexReleaseAssetsTx = db.transaction((releaseId) => {
    const rows = db.prepare(`
      SELECT asset_id FROM release_assets
      WHERE release_id = ?
      ORDER BY sort_order ASC, asset_id ASC
    `).all(releaseId);
    for (let i = 0; i < rows.length; i++) {
      raUpdateSortOrder.run(i, releaseId, rows[i].asset_id);
    }
  });

  /**
   * Transactional remove-and-reindex: deletes exactly one (release_id, asset_id)
   * junction row, reads the remaining rows in deterministic order
   * (sort_order ASC, asset_id ASC), and reindexes them to contiguous 0..n-1.
   *
   * Every step commits or rolls back together.
   *
   * @type {import('better-sqlite3').Transaction}
   */
  const removeAndReindexReleaseAssetTx = db.transaction((releaseId, assetId) => {
    const result = raDeleteOne.run(releaseId, assetId);
    if (result.changes === 0) return false;

    const rows = db.prepare(`
      SELECT asset_id FROM release_assets
      WHERE release_id = ?
      ORDER BY sort_order ASC, asset_id ASC
    `).all(releaseId);

    for (let i = 0; i < rows.length; i++) {
      raUpdateSortOrder.run(i, releaseId, rows[i].asset_id);
    }
    return true;
  });

  /**
   * Transactional reorder: given a release ID and an array of asset_ids in the
   * desired order, rewrites sort_order to contiguous 0..n-1.
   *
   * Before writing, loads the current selected asset IDs in deterministic order
   * and validates the supplied sequence is a complete, exact match:
   *   - same length
   *   - no duplicates
   *   - no missing IDs
   *   - no extra IDs
   *   - no foreign-release IDs
   *   - no nonexistent IDs
   *
   * Every UPDATE asserts result.changes === 1. Any validation or update failure
   * rolls back the complete transaction.
   *
   * @type {import('better-sqlite3').Transaction}
   */
  const reorderReleaseAssetsTx = db.transaction((releaseId, assetIds) => {
    const currentRows = db.prepare(`
      SELECT asset_id FROM release_assets
      WHERE release_id = ?
      ORDER BY sort_order ASC, asset_id ASC
    `).all(releaseId);

    const currentIds = currentRows.map((r) => r.asset_id);

    if (assetIds.length !== currentIds.length) {
      const err = new Error(
        `Sequence length ${assetIds.length} does not match current selection length ${currentIds.length}`
      );
      err.code = 'INVALID_SEQUENCE_LENGTH';
      throw err;
    }

    const seen = new Set();
    for (let i = 0; i < assetIds.length; i++) {
      const id = assetIds[i];
      if (!Number.isInteger(id) || id < 1) {
        const err = new Error(`Invalid asset ID at position ${i}: ${id}`);
        err.code = 'INVALID_ASSET_ID';
        throw err;
      }
      if (seen.has(id)) {
        const err = new Error(`Duplicate asset ID at position ${i}: ${id}`);
        err.code = 'DUPLICATE_ASSET_ID';
        throw err;
      }
      seen.add(id);
    }

    // Check that every supplied ID exists in the current set (no extra, no foreign)
    const currentSet = new Set(currentIds);
    for (const id of assetIds) {
      if (!currentSet.has(id)) {
        const err = new Error(`Asset ID ${id} is not in the current selection`);
        err.code = 'FOREIGN_ASSET_ID';
        throw err;
      }
    }

    for (let i = 0; i < assetIds.length; i++) {
      const result = raUpdateSortOrder.run(i, releaseId, assetIds[i]);
      if (result.changes !== 1) {
        const err = new Error(
          `Sort-order update for asset ${assetIds[i]} at position ${i} affected ${result.changes} rows, expected 1`
        );
        err.code = 'UPDATE_CHANGES_MISMATCH';
        throw err;
      }
    }
  });

  return {
    /**
     * @param {number} id
     * @returns {ReleaseRecord|undefined}
     */
    findById(id) {
      return findById.get(id);
    },

    /**
     * Find all releases across all projects.
     * @param {Object} [options]
     * @param {boolean} [options.includeArchived]
     * @param {string} [options.sortBy]
     * @param {string} [options.order]
     * @param {string} [options.search]
     * @returns {ReleaseRecord[]}
     */
    findAll(options = {}) {
      const {
        includeArchived = false,
        sortBy = 'updated',
        order = 'desc',
        search = '',
      } = options;

      const conditions = [];
      const params = [];

      if (!includeArchived) {
        conditions.push('releases.archived_at IS NULL');
      }

      if (search) {
        conditions.push('releases.title LIKE ?');
        params.push(`%${search}%`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const orderClause = buildOrderClauseWithTable('releases', sortBy, order);
      const sql = `${SELECT_ALL_WITH_PROJECT} ${where} ${orderClause}`;
      const stmt = db.prepare(sql);
      return stmt.all(...params);
    },

    /**
     * @param {number} projectId
     * @param {Object} [options]
     * @param {boolean} [options.includeArchived]
     * @param {string} [options.sortBy]
     * @param {string} [options.order]
     * @returns {ReleaseRecord[]}
     */
    findByProjectId(projectId, options = {}) {
      const {
        includeArchived = false,
        sortBy = 'updated',
        order = 'desc',
      } = options;

      const conditions = ['releases.project_id = ?'];
      const params = [projectId];

      if (!includeArchived) {
        conditions.push('releases.archived_at IS NULL');
      }

      const where = `WHERE ${conditions.join(' AND ')}`;
      const orderClause = buildOrderClauseWithTable('releases', sortBy, order);
      const sql = `${SELECT_ALL_WITH_PROJECT} ${where} ${orderClause}`;
      const stmt = db.prepare(sql);
      return stmt.all(...params);
    },

    /**
     * @param {Object} input
     * @returns {ReleaseRecord}
     */
    create(input) {
      return insert.get(...buildReleaseInsertValues(input));
    },

    /**
     * Create a release and assign its initial assets in one transaction.
     * @param {Object} input
     * @param {Array<{assetId: number, role: string, sortOrder: number}>} selections
     * @returns {ReleaseRecord}
     */
    createWithAssetSelections(input, selections) {
      return createWithAssetSelectionsTx(input, selections);
    },

    /**
     * @param {number} id
     * @param {Object} input
     * @returns {ReleaseRecord|undefined}
     */
    update(id, input) {
      const plannedDate = input.plannedDate;
      const plannedTime = input.plannedTime;
      const values = [
        input.title,
        input.description,
        input.notes,
        plannedDate ?? null,
        plannedTime ?? null,
        input.patreonUrl ?? null,
        input.publishedDate ?? null,
        id,
      ];
      return update.get(...values);
    },

    /**
     * @param {number} id
     * @returns {ReleaseRecord|undefined}
     */
    archive(id) {
      return archive.get(id);
    },

    /**
     * Hard-delete a release by id. Associated release_assets rows are removed
     * by the existing ON DELETE CASCADE foreign key; project assets are not
     * affected.
     * @param {number} id
     * @returns {boolean} true when a row was deleted, false otherwise
     */
    delete(id) {
      const result = deleteRelease.run(id);
      return result.changes > 0;
    },

    /**
     * @param {number} id
     * @param {string} publishedDate
     * @returns {ReleaseRecord|undefined}
     */
    publish(id, publishedDate) {
      return setPublishedDate.get(publishedDate, id);
    },

    /**
     * Scheduled, non-archived releases whose planned date falls within a
     * bounded range. Publication state is deliberately not filtered here: the
     * calendar is a historical and future schedule view, not an active
     * workflow view.
     *
     * @param {string} startDate - ISO date YYYY-MM-DD (inclusive)
     * @param {string} endDate - ISO date YYYY-MM-DD (exclusive)
     * @returns {Array<ReleaseRecord & {project_title: string, project_status: string, notes: string, published_date: string|null}>}
     */
    findCalendarRange(startDate, endDate) {
      return findCalendarRangeStmt.all(startDate, endDate);
    },

    /**
     * Active, non-archived releases whose planned_date is strictly after the
     * supplied `today`. Releases whose parent project has been archived are
     * excluded — the project workspace surfaces them, but date classification
     * lists only include actionable work. The caller is expected to inject
     * `today` so every consumer shares a single application-local date
     * snapshot — this method must not call `new Date()` itself.
     * @param {string} today ISO date string YYYY-MM-DD
     * @returns {ReleaseRecord[]}
     */
    upcomingReleases(today) {
      const sql = `
        ${SELECT_ALL_WITH_PROJECT}
        WHERE ${ACTIVE_UNPUBLISHED}
          AND releases.planned_date IS NOT NULL
          AND date(releases.planned_date) > ?
          AND ${ACTIVE_PARENT_PROJECT}
        ORDER BY date(releases.planned_date) ASC, releases.planned_time ASC
      `;
      return db.prepare(sql).all(today);
    },

    /**
     * Active, non-archived releases whose planned_date is strictly before the
     * supplied `today`. Releases whose parent project has been archived are
     * excluded — the project workspace surfaces them, but date classification
     * lists only include actionable work. The caller is expected to inject
     * `today` so every consumer shares a single application-local date
     * snapshot — this method must not call `new Date()` itself.
     * @param {string} today ISO date string YYYY-MM-DD
     * @returns {ReleaseRecord[]}
     */
    overdueReleases(today) {
      const sql = `
        ${SELECT_ALL_WITH_PROJECT}
        WHERE ${ACTIVE_UNPUBLISHED}
          AND releases.planned_date IS NOT NULL
          AND date(releases.planned_date) < ?
          AND ${ACTIVE_PARENT_PROJECT}
        ORDER BY date(releases.planned_date) ASC, releases.planned_time ASC
      `;
      return db.prepare(sql).all(today);
    },

    /**
     * Overdue releases with a bounded limit. Ordered by planned_date ascending
     * (most overdue first). Active, non-archived only. The caller is expected
     * to inject `today` so the dashboard and other consumers share a single
     * date snapshot — this method must not call `new Date()` itself.
     * Overdue means planned_date strictly before today.
     * @param {number} limit
     * @param {string} today ISO date string YYYY-MM-DD
     * @returns {ReleaseRecord[]}
     */
    findOverdue(limit, today) {
      const sql = `
        ${SELECT_ALL_WITH_PROJECT}
        WHERE ${DASHBOARD_ACTIVE}
          AND releases.planned_date IS NOT NULL
          AND date(releases.planned_date) < ?
        ORDER BY date(releases.planned_date) ASC, releases.planned_time ASC
        LIMIT ?
      `;
      return db.prepare(sql).all(today, limit);
    },

    /**
     * Upcoming releases with a bounded limit. Ordered by planned_date
     * ascending (soonest first). Active, non-archived only. The caller is
     * expected to inject `today` so the dashboard and other consumers share
     * a single date snapshot — this method must not call `new Date()` itself.
     * Upcoming includes today: planned_date >= today.
     * @param {number} limit
     * @param {string} today ISO date string YYYY-MM-DD
     * @returns {ReleaseRecord[]}
     */
    findUpcoming(limit, today) {
      const sql = `
        ${SELECT_ALL_WITH_PROJECT}
        WHERE ${DASHBOARD_ACTIVE}
          AND releases.planned_date IS NOT NULL
          AND date(releases.planned_date) >= ?
        ORDER BY date(releases.planned_date) ASC, releases.planned_time ASC
        LIMIT ?
      `;
      return db.prepare(sql).all(today, limit);
    },

    /**
     * Unpublished releases whose owning project is ready. These are waiting
     * to be published.
     * Bounded; ordered by planned_date ascending (NULLs last), then by
     * updated_at descending as a tie-breaker.
     * @param {number} limit
     * @returns {ReleaseRecord[]}
     */
    findReady(limit) {
      const sql = `
        SELECT ${RELEASE_COLUMNS_WITH_ALIAS('r')}, p.status AS project_status
        FROM releases r
        JOIN projects p ON p.id = r.project_id
        WHERE r.archived_at IS NULL
          AND r.published_date IS NULL
          AND p.archived_at IS NULL
          AND p.status = 'ready'
        ORDER BY (r.planned_date IS NULL), r.planned_date ASC, r.updated_at DESC
        LIMIT ?
      `;
      return db.prepare(sql).all(limit);
    },

    /**
     * Batch readiness facts for all releases under ready projects on the dashboard.
     * Returns one row per ready release with the same fact columns as
     * findReadinessFactsById, plus display fields (title, planned_date,
     * updated_at, project_title). Excludes archived releases and releases
     * under archived parent projects. Bounded; deterministic ordering.
     *
     * This is the single batch query that prevents N+1 readiness evaluation
     * in the dashboard — the service layer calls evaluateReleaseReadiness
     * on each returned fact row without additional per-release queries.
     *
     * @param {number} limit
     * @returns {Array<{
     *   release_id: number,
     *   project_id: number,
     *   title: string,
     *   project_status: string,
     *   planned_date: string|null,
     *   updated_at: string,
     *   release_archived_at: string|null,
     *   project_title: string,
     *   project_archived_at: string|null,
     *   selected_asset_count: number,
     *   present_selected_asset_count: number,
     *   missing_selected_asset_count: number,
     *   primary_role_count: number,
     *   preview_role_count: number,
     *   attachment_role_count: number,
     *   source_role_count: number,
     * }>}
     */
    findReadyDashboardFacts(limit) {
      const sql = `
        SELECT
          r.id AS release_id,
          r.project_id,
          r.title,
          p.status AS project_status,
          r.planned_date,
          r.updated_at,
          r.archived_at AS release_archived_at,
          p.title AS project_title,
          p.archived_at AS project_archived_at,
          COUNT(DISTINCT CASE WHEN a.id IS NOT NULL THEN a.id END) AS selected_asset_count,
          COUNT(DISTINCT CASE WHEN a.is_present = 1 THEN a.id END) AS present_selected_asset_count,
          COUNT(DISTINCT CASE WHEN a.is_present = 0 THEN a.id END) AS missing_selected_asset_count,
          COUNT(DISTINCT CASE WHEN a.id IS NOT NULL AND ra.role = 'primary' THEN a.id END) AS primary_role_count,
          COUNT(DISTINCT CASE WHEN a.id IS NOT NULL AND ra.role = 'preview' THEN a.id END) AS preview_role_count,
          COUNT(DISTINCT CASE WHEN a.id IS NOT NULL AND ra.role = 'attachment' THEN a.id END) AS attachment_role_count,
          COUNT(DISTINCT CASE WHEN a.id IS NOT NULL AND ra.role = 'source' THEN a.id END) AS source_role_count
        FROM releases r
        JOIN projects p ON p.id = r.project_id
        LEFT JOIN release_assets ra ON ra.release_id = r.id
        LEFT JOIN assets a ON a.id = ra.asset_id AND a.project_id = r.project_id
         WHERE p.status = 'ready'
           AND r.published_date IS NULL
           AND r.archived_at IS NULL
          AND p.archived_at IS NULL
        GROUP BY r.id
        ORDER BY (r.planned_date IS NULL), r.planned_date ASC, r.updated_at DESC, r.id DESC
        LIMIT ?
      `;
      return db.prepare(sql).all(limit);
    },

    /**
     * Active releases with no planned date. These need scheduling attention.
     * Bounded; ordered by updated_at descending (most recently touched first).
     * @param {number} limit
     * @returns {ReleaseRecord[]}
     */
    findActiveWithoutPlannedDate(limit) {
      const sql = `
        ${SELECT_ALL_WITH_PROJECT}
        WHERE ${DASHBOARD_ACTIVE}
          AND releases.planned_date IS NULL
        ORDER BY releases.updated_at DESC
        LIMIT ?
      `;
      return db.prepare(sql).all(limit);
    },

    /**
     * Active releases that have at least one selected asset currently marked
     * as missing (is_present = 0). The result is enriched with a synthetic
     * `missing_asset_count` field for display. Ordered by planned_date
     * ascending (NULLs last) so the most urgent surface first.
     * @param {number} limit
     * @returns {Array<ReleaseRecord & {project_status: string, missing_asset_count: number}>}
     */
    findReleasesWithMissingSelectedAssets(limit) {
      const sql = `
        SELECT ${RELEASE_COLUMNS_WITH_ALIAS('r')},
               p.status AS project_status,
               COUNT(a.id) AS missing_asset_count
        FROM releases r
        JOIN projects p ON p.id = r.project_id
        JOIN release_assets ra ON ra.release_id = r.id
        JOIN assets a ON a.id = ra.asset_id AND a.project_id = r.project_id
        WHERE r.archived_at IS NULL
          AND r.published_date IS NULL
          AND p.archived_at IS NULL
          AND a.is_present = 0
        GROUP BY r.id
        ORDER BY (r.planned_date IS NULL), r.planned_date ASC, r.updated_at DESC
        LIMIT ?
      `;
      return db.prepare(sql).all(limit);
    },

    /**
     * Active releases that have NO selected assets at all. This is distinct
     * from findReleasesWithMissingSelectedAssets (which requires at least one
     * selected asset that is physically missing). A release with zero
     * release_assets rows has nothing to publish and needs asset-selection
     * attention. Ordered by planned_date ascending (NULLs last) so the most
     * urgent surface first.
     * @param {number} limit
     * @returns {ReleaseRecord[]}
     */
    findReleasesWithoutSelectedAssets(limit) {
      const sql = `
        ${SELECT_ALL_WITH_PROJECT}
        WHERE ${DASHBOARD_ACTIVE}
          AND NOT EXISTS (
            SELECT 1 FROM release_assets ra
            JOIN assets a ON a.id = ra.asset_id AND a.project_id = releases.project_id
            WHERE ra.release_id = releases.id
          )
        ORDER BY (releases.planned_date IS NULL), releases.planned_date ASC, releases.updated_at DESC
        LIMIT ?
      `;
      return db.prepare(sql).all(limit);
    },

    /**
     * Active, unpublished releases for a project, bounded.
     * Ordered by planned_date ascending (NULLs last) then by updated_at DESC.
     * @param {number} projectId
     * @param {number} limit
     * @returns {ReleaseRecord[]}
     */
    findActiveByProjectId(projectId, limit) {
      const sql = `
        ${SELECT_ALL_WITH_PROJECT}
        WHERE releases.project_id = ? AND ${ACTIVE_UNPUBLISHED}
        ORDER BY (releases.planned_date IS NULL), releases.planned_date ASC, releases.updated_at DESC
        LIMIT ?
      `;
      return db.prepare(sql).all(projectId, limit);
    },

    /**
     * Recently updated releases for a project (any publication/archive state).
     * @param {number} projectId
     * @param {number} limit
     * @returns {ReleaseRecord[]}
     */
    findRecentByProjectId(projectId, limit) {
      const sql = `
        ${SELECT_ALL_WITH_PROJECT}
        WHERE releases.project_id = ?
        ORDER BY releases.updated_at DESC
        LIMIT ?
      `;
      return db.prepare(sql).all(projectId, limit);
    },

    /**
     * Count of distinct assets that are currently missing and are referenced
     * by at least one non-archived release. Global scope.
     * @returns {number}
     */
    countMissingAssetsReferenced() {
      const row = db.prepare(`
        SELECT COUNT(DISTINCT a.id) AS c
        FROM release_assets ra
        JOIN assets a ON a.id = ra.asset_id AND a.project_id = (SELECT project_id FROM releases WHERE id = ra.release_id)
        JOIN releases r ON r.id = ra.release_id
        WHERE a.is_present = 0
          AND r.archived_at IS NULL
      `).get();
      return row.c;
    },

    /**
     * Count of distinct assets for a given project that are currently missing
     * and are referenced by at least one non-archived release of that same
     * project.
     * @param {number} projectId
     * @returns {number}
     */
    countMissingAssetsReferencedByProjectId(projectId) {
      const row = db.prepare(`
        SELECT COUNT(DISTINCT a.id) AS c
        FROM release_assets ra
        JOIN assets a ON a.id = ra.asset_id AND a.project_id = ?
        JOIN releases r ON r.id = ra.release_id AND r.project_id = ?
        WHERE a.is_present = 0
          AND r.archived_at IS NULL
      `).get(projectId, projectId);
      return row.c;
    },

    // ─── Release Asset Selection ─────────────────────────────────────────

    /**
     * List assets selected for a release.
     * Returns full asset rows enriched with release_assets metadata.
     * @param {number} releaseId
     * @returns {Array<{release_id: number, asset_id: number, role: string, sort_order: number, created_at: string, project_id: number, category_id: number|null, relative_path: string, nested_path: string, filename: string, extension: string, mime_type: string, size_bytes: number, modified_at: string|null, is_present: number, last_seen_at: string|null, missing_since: string|null, asset_created_at: string, asset_updated_at: string}>}
     */
    listReleaseAssets(releaseId) {
      return raFindByRelease.all(releaseId, releaseId);
    },

    /**
     * List selected asset metadata for multiple releases in one or more
     * bounded queries. Rows are ordered by release ID, then the release's
     * manual asset order, with asset ID as the deterministic tie-breaker.
     * Missing or cross-project asset rows are retained with null asset
     * metadata so callers can continue to the next selected asset.
     *
     * @param {number[]} releaseIds
     * @returns {Array<{
     *   release_id: number,
     *   selected_asset_id: number,
     *   sort_order: number,
     *   release_project_id: number,
     *   asset_id: number|null,
     *   asset_project_id: number|null,
     *   relative_path: string|null,
     *   filename: string|null,
     *   extension: string|null,
     *   mime_type: string|null,
     *   size_bytes: number|null,
     *   modified_at: string|null,
     *   is_present: number|null,
     * }>}
     */
    findReleaseAssetsByReleaseIds(releaseIds) {
      if (!Array.isArray(releaseIds) || releaseIds.length === 0) return [];

      const unique = [...new Set(releaseIds.filter((id) => Number.isInteger(id) && id > 0))];
      if (unique.length === 0) return [];
      unique.sort((a, b) => a - b);

      const CHUNK_SIZE = 500;
      const results = [];

      for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
        const chunk = unique.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(',');
        const sql = `
          SELECT
            ra.release_id,
            ra.asset_id AS selected_asset_id,
            ra.sort_order,
            r.project_id AS release_project_id,
            a.id AS asset_id,
            a.project_id AS asset_project_id,
            a.relative_path,
            a.filename,
            a.extension,
            a.mime_type,
            a.size_bytes,
            a.modified_at,
            a.is_present
          FROM release_assets ra
          JOIN releases r ON r.id = ra.release_id
          LEFT JOIN assets a ON a.id = ra.asset_id AND a.project_id = r.project_id
          WHERE ra.release_id IN (${placeholders})
          ORDER BY ra.release_id ASC, ra.sort_order ASC, ra.asset_id ASC
        `;
        results.push(...db.prepare(sql).all(...chunk));
      }

      return results;
    },

    /**
     * Count assets selected for a release.
     * @param {number} releaseId
     * @returns {number}
     */
    countReleaseAssets(releaseId) {
      const row = raCountByRelease.get(releaseId, releaseId);
      return row.c;
    },

    /**
     * Repository-level readiness facts for a release. Returns factual data
     * only — no policy decisions, labels, scores, or UI text. Returns
     * undefined when the release does not exist.
     *
     * @param {number} releaseId
     * @returns {{
     *   release_id: number,
     *   project_id: number,
     *   project_status: string,
     *   release_archived_at: string|null,
     *   project_archived_at: string|null,
     *   selected_asset_count: number,
     *   present_selected_asset_count: number,
     *   missing_selected_asset_count: number,
     *   primary_role_count: number,
     *   preview_role_count: number,
     *   attachment_role_count: number,
     *   source_role_count: number,
     * }|undefined}
     */
    findReadinessFactsById(releaseId) {
      return readinessFactsById.get(releaseId);
    },

    /**
     * Batch readiness facts for an array of release IDs.
     * Returns one row per release with the same fact columns as
     * findReadinessFactsById. Releases with no release_assets rows still
     * appear with zero counts (LEFT JOIN). Cross-project corrupt junction
     * rows are ignored via the asset project_id guard.
     *
     * This is the single batch query that prevents N+1 readiness evaluation
     * in planning views — the service layer calls evaluateReleaseReadiness
     * on each returned fact row.
     *
     * IDs are deduplicated and processed in bounded chunks to stay below
     * SQLite's variable limit (~999 per query). Results are combined and
     * returned in deterministic order (r.id ASC).
     *
     * @param {number[]} ids — release IDs (empty array returns [])
     * @returns {Array<{
     *   release_id: number,
     *   project_id: number,
     *   project_status: string,
     *   release_archived_at: string|null,
     *   project_archived_at: string|null,
     *   selected_asset_count: number,
     *   present_selected_asset_count: number,
     *   missing_selected_asset_count: number,
     *   primary_role_count: number,
     *   preview_role_count: number,
     *   attachment_role_count: number,
     *   source_role_count: number,
     * }>}
     */
    findReadinessFactsByIds(ids) {
      if (!Array.isArray(ids) || ids.length === 0) return [];

      // Deduplicate and keep only valid positive integers
      const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
      if (unique.length === 0) return [];

      // Sort numerically so chunk boundaries produce globally ordered results
      // when each chunk sorts internally by r.id ASC. Without this, insertion
      // order from Set iteration can place high IDs in early chunks and low
      // IDs in later chunks, breaking the release_id ASC contract.
      unique.sort((a, b) => a - b);

      const CHUNK_SIZE = 500;
      const results = [];

      for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
        const chunk = unique.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(',');
        const sql = `
          SELECT
            r.id AS release_id,
            r.project_id,
            p.status AS project_status,
            r.archived_at AS release_archived_at,
            p.archived_at AS project_archived_at,
            COUNT(DISTINCT CASE WHEN a.id IS NOT NULL THEN a.id END) AS selected_asset_count,
            COUNT(DISTINCT CASE WHEN a.is_present = 1 THEN a.id END) AS present_selected_asset_count,
            COUNT(DISTINCT CASE WHEN a.is_present = 0 THEN a.id END) AS missing_selected_asset_count,
            COUNT(DISTINCT CASE WHEN a.id IS NOT NULL AND ra.role = 'primary' THEN a.id END) AS primary_role_count,
            COUNT(DISTINCT CASE WHEN a.id IS NOT NULL AND ra.role = 'preview' THEN a.id END) AS preview_role_count,
            COUNT(DISTINCT CASE WHEN a.id IS NOT NULL AND ra.role = 'attachment' THEN a.id END) AS attachment_role_count,
            COUNT(DISTINCT CASE WHEN a.id IS NOT NULL AND ra.role = 'source' THEN a.id END) AS source_role_count
          FROM releases r
          JOIN projects p ON p.id = r.project_id
          LEFT JOIN release_assets ra ON ra.release_id = r.id
          LEFT JOIN assets a ON a.id = ra.asset_id AND a.project_id = r.project_id
          WHERE r.id IN (${placeholders})
          GROUP BY r.id
          ORDER BY r.id ASC
        `;
        const chunkResults = db.prepare(sql).all(...chunk);
        results.push(...chunkResults);
      }

      // Defensive: ensure globally sorted even if chunk boundaries shift
      results.sort((a, b) => a.release_id - b.release_id);

      return results;
    },

    /**
     * Find releases that use a given asset.
     * @param {number} assetId
     * @returns {ReleaseAssetRecord[]}
     */
    findReleasesByAsset(assetId) {
      return raFindByAsset.all(assetId);
    },

    /**
     * Add an asset selection to a release.
     *
     * Uses an ownership-guarded insert that only succeeds when the asset
     * belongs to the same project as the release. Returns undefined when
     * the project IDs do not match — the caller (service layer) is
     * responsible for domain validation and error messages.
     *
     * @param {number} releaseId
     * @param {number} assetId
     * @param {string} role
     * @param {number} sortOrder
     * @returns {ReleaseAssetRecord|undefined}
     * @throws {Error} on duplicate (same release_id + asset_id)
     */
    addReleaseAsset(releaseId, assetId, role, sortOrder) {
      return raInsertOwnershipGuarded.get(releaseId, assetId, role, sortOrder, releaseId, assetId);
    },

    /**
     * Remove a single asset selection from a release.
     * @param {number} releaseId
     * @param {number} assetId
     * @returns {boolean} true if a row was deleted
     */
    removeReleaseAsset(releaseId, assetId) {
      const result = raDeleteOne.run(releaseId, assetId);
      return result.changes > 0;
    },

    /**
     * Remove all asset selections for a release.
     * @param {number} releaseId
     * @returns {number} number of rows deleted
     */
    removeAllReleaseAssets(releaseId) {
      const result = raDeleteByRelease.run(releaseId);
      return result.changes;
    },

    /**
     * Replace all asset selections for a release transactionally.
     * Removes existing selections then inserts new ones.
     * @param {number} releaseId
     * @param {Array<{assetId: number, role: string, sortOrder: number}>} selections
     */
    replaceReleaseAssets(releaseId, selections) {
      replaceReleaseAssetsTx(releaseId, selections);
    },

    /**
     * Bulk-append multiple assets to a release in one transaction — see
     * {@link appendAssetsToReleaseTx}.
     * @param {number} releaseId
     * @param {number[]} assetIds - pre-validated positive integers
     * @returns {{ added: number, alreadyAssociated: number }}
     */
    appendAssetsToRelease(releaseId, assetIds) {
      return appendAssetsToReleaseTx(releaseId, assetIds);
    },

    /**
     * Releases in one project that are valid targets for adding new asset
     * associations: archived_at IS NULL and published_date IS NULL. The
     * owning project's workflow status is included for display; publication is
     * represented by published_date rather than a release-owned status.
     * One bounded query, render-ready id/title/project_status only.
     * @param {number} projectId
      * @returns {Array<{id: number, title: string, project_status: string}>}
     */
    findEligibleAssetSelectionTargets(projectId) {
      return db.prepare(`
        SELECT r.id, r.title, p.status AS project_status
        FROM releases r
        JOIN projects p ON p.id = r.project_id
        WHERE r.project_id = ? AND r.archived_at IS NULL AND r.published_date IS NULL
        ORDER BY r.title COLLATE NOCASE ASC, r.id ASC
      `).all(projectId);
    },

    /**
     * Insert a single asset selection.
     *
     * Uses an ownership-guarded insert that only succeeds when the asset
     * belongs to the same project as the release. Returns undefined when
     * the project IDs do not match — the caller (service layer) is
     * responsible for domain validation and error messages.
     *
     * @param {number} releaseId
     * @param {number} assetId
     * @param {string} role
     * @param {number} sortOrder
     * @returns {ReleaseAssetRecord|undefined}
     */
    insertReleaseAsset(releaseId, assetId, role, sortOrder) {
      return raInsertOwnershipGuarded.get(releaseId, assetId, role, sortOrder, releaseId, assetId);
    },

    /**
     * Delete a single asset selection.
     * @param {number} releaseId
     * @param {number} assetId
     * @returns {boolean} true if a row was deleted
     */
    deleteReleaseAsset(releaseId, assetId) {
      const result = raDeleteOne.run(releaseId, assetId);
      return result.changes > 0;
    },

    /**
     * Update the role of a single selected asset.
     * @param {number} releaseId
     * @param {number} assetId
     * @param {string} role
     * @returns {boolean} true if a row was updated
     */
    updateReleaseAssetRole(releaseId, assetId, role) {
      const result = raUpdateRole.run(role, releaseId, assetId);
      return result.changes > 0;
    },

    /**
     * Reindex all rows for a release to contiguous sort_order 0..n-1.
     * Uses the deterministic order sort_order ASC, asset_id ASC.
     * This normalizes legacy gaps or duplicates after curation mutations.
     * @param {number} releaseId
     */
    reindexReleaseAssets(releaseId) {
      reindexReleaseAssetsTx(releaseId);
    },

    /**
     * Transactional remove-and-reindex: deletes exactly one (release_id, asset_id)
     * junction row, reads the remaining rows in deterministic order
     * (sort_order ASC, asset_id ASC), and reindexes them to contiguous 0..n-1.
     *
     * Every step commits or rolls back together.
     *
     * @param {number} releaseId
     * @param {number} assetId
     * @returns {boolean} true if a row was deleted and reindexed
     */
    removeAndReindexReleaseAsset: removeAndReindexReleaseAssetTx,

    /**
     * Transactional reorder: given a release ID and an array of asset_ids in the
     * desired order, rewrites sort_order to contiguous 0..n-1.
     *
     * The caller (service layer) is responsible for computing the desired sequence.
     * This method only writes — it does not read, validate, or compute ordering.
     *
     * @param {number} releaseId
     * @param {number[]} assetIds - asset IDs in the desired order
     */
    reorderReleaseAssets: reorderReleaseAssetsTx,

    // ─── Phase 6C: Release Planning Views ─────────────────────────────────

    /**
     * Apply a narrow SQL readiness classification to an existing set of
     * WHERE conditions. This is the repository-side projection of the
     * shared readiness policy used only for list/board filtering; the JS
     * policy remains authoritative for publishing and UI indicators.
     *
     * Unknown readiness values are ignored (treated as 'all').
     *
     * @param {string[]} conditions
     * @param {Object} filters
     * @param {string} [filters.readiness] - 'all'|'publishable'|'blocked-ready'
     */
    _applyReadinessFilter(conditions, filters) {
      if (!['publishable', 'blocked-ready'].includes(filters.readiness)) return;

      const selected = selectedAssetCountSubquery('releases');
      const missing = missingAssetCountSubquery('releases');

      conditions.push("projects.status = 'ready'");
      conditions.push('releases.archived_at IS NULL');
      conditions.push('releases.published_date IS NULL');
      conditions.push(ACTIVE_PARENT_PROJECT);

      if (filters.readiness === 'publishable') {
        conditions.push(`${selected} > 0`);
        conditions.push(`${missing} = 0`);
      } else {
        conditions.push(`(${selected} = 0 OR ${missing} > 0)`);
      }
    },

    /**
     * Build the WHERE conditions and params for release list queries.
     * Returns { conditions: string[], params: any[] }.
     * @param {Object} filters
     * @param {number|null} filters.projectId
     * @param {string|null} filters.schedule - 'overdue'|'today'|'upcoming'|'unscheduled'
     * @param {boolean} filters.includeArchived
     * @param {string} filters.today - ISO date string YYYY-MM-DD for schedule classification
     * @param {boolean} filters.activeScheduleFilter - when true, exclude archived parents
     */
    _buildFilterConditions(filters) {
      const conditions = [];
      const params = [];

      if (filters.search && filters.search.trim()) {
        const term = `%${escapeLike(filters.search.trim())}%`;
        conditions.push(
          "(releases.title LIKE ? ESCAPE '\\' OR releases.description LIKE ? ESCAPE '\\' " +
          "OR releases.notes LIKE ? ESCAPE '\\' OR projects.title LIKE ? ESCAPE '\\')"
        );
        params.push(term, term, term, term);
      }

      if (filters.projectId != null) {
        conditions.push('releases.project_id = ?');
        params.push(filters.projectId);
      }

      // Schedule filters (overdue, today, upcoming, unscheduled) ALWAYS exclude
      // archived and published release records — even when includeArchived=1 —
      // because they are active-workflow views. The includeArchived flag affects
      // schedule=all (no schedule filter).
      const isScheduleFilter = filters.schedule
        && ['overdue', 'today', 'upcoming', 'unscheduled'].includes(filters.schedule);

      if (!filters.includeArchived || isScheduleFilter) {
        conditions.push('releases.archived_at IS NULL');
      }

      // Schedule filters apply to active, unpublished releases.
      // Per Phase 6C: schedule filters ALWAYS exclude archived parent projects
      // because they are used in active workflow views — even when includeArchived=1.
      if (isScheduleFilter) {
        // Always apply the active-unpublished predicate for schedule filters.
        conditions.push('releases.published_date IS NULL');

        // Always exclude archived parent projects for schedule filters
        conditions.push(ACTIVE_PARENT_PROJECT);

        if (filters.schedule === 'overdue') {
          conditions.push('releases.planned_date IS NOT NULL');
          conditions.push('releases.planned_date < ?');
          params.push(filters.today);
        } else if (filters.schedule === 'today') {
          conditions.push('releases.planned_date IS NOT NULL');
          conditions.push('releases.planned_date = ?');
          params.push(filters.today);
        } else if (filters.schedule === 'upcoming') {
          conditions.push('releases.planned_date IS NOT NULL');
          conditions.push('releases.planned_date > ?');
          params.push(filters.today);
        } else if (filters.schedule === 'unscheduled') {
          conditions.push('releases.planned_date IS NULL');
        }
      } else if (filters.activeScheduleFilter) {
        // Default: when activeScheduleFilter is set, exclude archived parents
        conditions.push(ACTIVE_PARENT_PROJECT);
      }

      return { conditions, params };
    },

    /**
     * Paginated release list with project title and asset counts.
     * Uses SQL LIMIT/OFFSET for pagination — no in-memory slicing.
     * @param {Object} filters
     * @param {number|null} filters.projectId
     * @param {string|null} filters.schedule
     * @param {boolean} filters.includeArchived
     * @param {string} filters.today
     * @param {boolean} filters.activeScheduleFilter
     * @param {'all'|'publishable'|'blocked-ready'} [filters.readiness]
     * @param {string} [filters.sortBy='updated']
     * @param {string} [filters.order='desc']
     * @param {number} [filters.limit=25]
     * @param {number} [filters.offset=0]
     * @returns {Array<ReleaseRecord & {project_title: string, selected_asset_count: number, missing_asset_count: number}>}
     */
    findPage(filters) {
      const {
        search,
        projectId,
        schedule,
        includeArchived = false,
        today,
        activeScheduleFilter = false,
        sortBy = 'updated',
        order = 'desc',
        limit = 25,
        offset = 0,
      } = filters;

      const { conditions, params } = this._buildFilterConditions({
        search, projectId, schedule, includeArchived, today, activeScheduleFilter,
      });
      this._applyReadinessFilter(conditions, filters);

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const orderClause = buildOrderClauseWithTable('releases', sortBy, order);

      // Subqueries for asset counts — correlated aggregates avoid duplicate rows
      // Both subqueries include a project guard (a.project_id = releases.project_id)
      // to prevent malformed cross-project junction rows from affecting counts.
      const selectedCountSubquery = `(SELECT COUNT(DISTINCT a.id) FROM release_assets ra JOIN assets a ON a.id = ra.asset_id AND a.project_id = releases.project_id WHERE ra.release_id = releases.id)`;
      const missingCountSubquery = `(SELECT COUNT(DISTINCT a.id) FROM release_assets ra JOIN assets a ON a.id = ra.asset_id AND a.project_id = releases.project_id WHERE ra.release_id = releases.id AND a.is_present = 0)`;

      const sql = `
        SELECT releases.id, releases.project_id, projects.title AS project_title,
               projects.status AS project_status,
               releases.title, releases.description, releases.notes,
               releases.planned_date, releases.planned_time, releases.published_date,
               releases.patreon_url, releases.created_at, releases.updated_at,
               releases.archived_at,
               ${selectedCountSubquery} AS selected_asset_count,
               ${missingCountSubquery} AS missing_asset_count
        FROM releases
        JOIN projects ON projects.id = releases.project_id
        ${where}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

      return db.prepare(sql).all(...params, limit, offset);
    },

    /**
     * Count of matching releases for pagination metadata.
     * Uses the same filter conditions as findPage but without LIMIT/OFFSET.
     * @param {Object} filters - same shape as findPage (without limit/offset/sort)
     * @param {'all'|'publishable'|'blocked-ready'} [filters.readiness]
     * @returns {number}
     */
    countFiltered(filters) {
      const {
        search,
        projectId,
        schedule,
        includeArchived = false,
        today,
        activeScheduleFilter = false,
      } = filters;

      const { conditions, params } = this._buildFilterConditions({
        search, projectId, schedule, includeArchived, today, activeScheduleFilter,
      });
      this._applyReadinessFilter(conditions, filters);

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const sql = `SELECT COUNT(*) AS c FROM releases JOIN projects ON projects.id = releases.project_id ${where}`;
      const row = db.prepare(sql).get(...params);
      return row.c;
    },

    /**
     * Board-ready release data grouped by project workflow status.
     * Returns flat array — service layer performs the grouping into columns.
     * @param {Object} filters
     * @param {number|null} filters.projectId
     * @param {string|null} filters.schedule
     * @param {boolean} filters.includeArchived
     * @param {string} filters.today
     * @param {boolean} filters.activeScheduleFilter
     * @param {'all'|'publishable'|'blocked-ready'} [filters.readiness]
     * @returns {Array<ReleaseRecord & {project_title: string, selected_asset_count: number, missing_asset_count: number}>}
     */
    findBoard(filters) {
      const {
        search,
        projectId,
        schedule,
        includeArchived = false,
        today,
        activeScheduleFilter = true, // Board view excludes archived parent releases by default
      } = filters;

      const { conditions, params } = this._buildFilterConditions({
        search, projectId, schedule, includeArchived, today, activeScheduleFilter,
      });
      this._applyReadinessFilter(conditions, filters);

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const selectedCountSubquery = `(SELECT COUNT(DISTINCT a.id) FROM release_assets ra JOIN assets a ON a.id = ra.asset_id AND a.project_id = releases.project_id WHERE ra.release_id = releases.id)`;
      const missingCountSubquery = `(SELECT COUNT(DISTINCT a.id) FROM release_assets ra JOIN assets a ON a.id = ra.asset_id AND a.project_id = releases.project_id WHERE ra.release_id = releases.id AND a.is_present = 0)`;

      // Board: sort by planned_date ascending (NULLs last), then updated_at desc,
      // then releases.id DESC as the final deterministic tie-breaker.
      const sql = `
        SELECT releases.id, releases.project_id, projects.title AS project_title,
               projects.status AS project_status,
               releases.title, releases.description, releases.notes,
               releases.planned_date, releases.planned_time, releases.published_date,
               releases.patreon_url, releases.created_at, releases.updated_at,
               releases.archived_at,
               ${selectedCountSubquery} AS selected_asset_count,
               ${missingCountSubquery} AS missing_asset_count
        FROM releases
        JOIN projects ON projects.id = releases.project_id
        ${where}
        ORDER BY (releases.planned_date IS NULL) ASC,
                 date(releases.planned_date) ASC,
                 (releases.planned_time IS NULL) ASC,
                 releases.planned_time ASC,
                 releases.updated_at DESC,
                 releases.id DESC
      `;

      return db.prepare(sql).all(...params);
    },

    // ─── Phase 6D: Asset Browser Queries ─────────────────────────────────

    /**
     * Release usage details for a batch of asset IDs, scoped to a project.
     * Returns one row per (asset, release) pair, enriched with release title,
     * publication/archive state, and parent project workflow/archive state for
     * display policy.
     * Both the asset and the release must belong to the given projectId to
     * prevent corrupt cross-project junction rows from leaking data.
     * Historical and archived releases are included — the browser shows what
     * releases reference which assets, regardless of lifecycle state.
     *
     * @param {number} projectId - scope: both asset and release must belong here
     * @param {number[]} assetIds - array of asset IDs (empty array returns [])
     * @returns {Array<{asset_id: number, release_id: number, title: string, published_date: string|null, project_status: string, release_archived_at: string|null, project_archived_at: string|null}>}
     */
    // ─── Phase 9-1: Release Asset Candidate Discovery ──────────────────────

    /**
     * Build WHERE conditions and params for release candidate queries.
     * Shared by both findReleaseCandidatePage and countReleaseCandidates so
     * they always use identical filter predicates.
     *
     * A candidate is an asset that:
     *   - belongs to the same project as the release
     *   - is currently present (is_present = 1)
     *   - is NOT already selected by the release
     *
     * @param {number} releaseId
     * @param {number} projectId
     * @param {object} filters
     * @param {string} [filters.search] - filename search term (LIKE)
     * @param {string} [filters.extension] - exact extension filter
     * @param {number} [filters.categoryId] - exact project-owned category ID
     * @returns {{ conditions: string[], params: any[] }}
     */
    _buildCandidateConditions(releaseId, projectId, filters) {
      const conditions = [];
      const params = [];

      // Same-project ownership
      conditions.push('a.project_id = ?');
      params.push(projectId);

      // Currently present
      conditions.push('a.is_present = 1');

      // Not already selected by this release
      conditions.push('NOT EXISTS (SELECT 1 FROM release_assets ra WHERE ra.release_id = ? AND ra.asset_id = a.id)');
      params.push(releaseId);

      if (filters.search && filters.search.trim()) {
        const escaped = filters.search.trim().replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
        conditions.push('a.filename LIKE ? ESCAPE \'\\\'');
        params.push(`%${escaped}%`);
      }

      if (filters.extension) {
        conditions.push('a.extension = ?');
        params.push(filters.extension);
      }

      if (filters.categoryId !== undefined && filters.categoryId !== null) {
        conditions.push('a.category_id = ?');
        params.push(filters.categoryId);
      }

      return { conditions, params };
    },

    /**
     * Paginated release candidate page.
     *
     * Ordering contract (deterministic):
     *   1. filename COLLATE NOCASE ASC  — case-insensitive filename comparison
     *   2. extension ASC                — exact extension tie-break
     *   3. a.id ASC                     — asset ID as final tie-breaker
     *
     * @param {number} releaseId
     * @param {number} projectId
     * @param {object} [filters]
     * @param {string} [filters.search] - filename search term
     * @param {string} [filters.extension] - exact extension filter
     * @param {number} [filters.categoryId] - exact project-owned category ID
     * @param {number} [filters.page=1]
     * @param {number} [filters.pageSize=25]
     * @returns {Array<{id: number, project_id: number, category_id: number|null, relative_path: string, nested_path: string, filename: string, extension: string, mime_type: string, size_bytes: number, is_present: number}>}
     */
    findReleaseCandidatePage(releaseId, projectId, filters = {}) {
      const { page = 1, pageSize = 25 } = filters;
      const { conditions, params } = this._buildCandidateConditions(releaseId, projectId, filters);

      const offset = (Math.max(1, page) - 1) * Math.max(1, pageSize);

      const sql = `
        SELECT a.id, a.project_id, a.category_id, a.relative_path, a.nested_path, a.filename, a.extension,
               a.mime_type, a.size_bytes, a.is_present
        FROM assets a
        WHERE ${conditions.join(' AND ')}
        ORDER BY a.filename COLLATE NOCASE ASC, a.extension ASC, a.id ASC
        LIMIT ? OFFSET ?
      `;

      return db.prepare(sql).all(...params, pageSize, offset);
    },

    /**
     * Count of matching release candidates.
     * Uses identical filter predicates as findReleaseCandidatePage.
     *
     * @param {number} releaseId
     * @param {number} projectId
     * @param {object} [filters]
     * @param {string} [filters.search] - filename search term
     * @param {string} [filters.extension] - exact extension filter
     * @param {number} [filters.categoryId] - exact project-owned category ID
     * @returns {number}
     */
    countReleaseCandidates(releaseId, projectId, filters = {}) {
      const { conditions, params } = this._buildCandidateConditions(releaseId, projectId, filters);

      const sql = `SELECT COUNT(*) AS c FROM assets a WHERE ${conditions.join(' AND ')}`;
      const row = db.prepare(sql).get(...params);
      return row.c;
    },

    /**
     * Get distinct extension values for available candidates.
     * Returns extensions that exist on present, unselected assets
     * belonging to the release's project.
     *
     * @param {number} releaseId
     * @param {number} projectId
     * @param {{categoryId?: number}} [filters]
     * @returns {string[]}
     */
    getReleaseCandidateExtensions(releaseId, projectId, filters = {}) {
      const conditions = [
        'a.project_id = ?',
        'a.is_present = 1',
        'NOT EXISTS (SELECT 1 FROM release_assets ra WHERE ra.release_id = ? AND ra.asset_id = a.id)',
      ];
      const params = [projectId, releaseId];

      if (filters.categoryId !== undefined && filters.categoryId !== null) {
        conditions.push('a.category_id = ?');
        params.push(filters.categoryId);
      }

      const sql = `
        SELECT DISTINCT a.extension
        FROM assets a
        WHERE ${conditions.join(' AND ')}
        ORDER BY a.extension
      `;
      return db.prepare(sql).pluck().all(...params);
    },

    // ─── Phase 9-3: Integrity Diagnostics ────────────────────────────────

    /**
     * Detect malformed cross-project release-asset junction rows.
     *
     * A malformed row is a release_assets entry where the asset's project_id
     * does not match the release's project_id. Such rows can arise from
     * direct database manipulation, legacy data, or bugs in earlier versions.
     *
     * Uses LEFT JOIN so that malformed rows are reported even when a parent
     * row (release or asset) is missing — e.g. FK-disabled corruption.
     *
     * This method is READ-ONLY — it performs no mutation, no deletion, and
     * no schema changes. It returns deterministic output suitable for
     * diagnostics, monitoring, or manual remediation.
     *
     * Returns an array of objects, each describing one malformed row:
     *   { release_id, asset_id, release_project_id, asset_project_id, reason }
     *
     * Returns an empty array when no malformed rows exist.
     *
     * @returns {Array<{release_id: number, asset_id: number, release_project_id: number|null, asset_project_id: number|null, reason: string}>}
     */
    findCrossProjectReleaseAssets() {
      const sql = `
        SELECT
          ra.release_id,
          ra.asset_id,
          r.project_id AS release_project_id,
          a.project_id AS asset_project_id,
          CASE
            WHEN r.id IS NULL AND a.id IS NULL THEN 'both parents missing'
            WHEN r.id IS NULL THEN 'missing release'
            WHEN a.id IS NULL THEN 'missing asset'
            WHEN r.project_id != a.project_id THEN 'cross-project'
            ELSE 'unknown'
          END AS reason
        FROM release_assets ra
        LEFT JOIN releases r ON r.id = ra.release_id
        LEFT JOIN assets a ON a.id = ra.asset_id
        WHERE r.id IS NULL
           OR a.id IS NULL
           OR r.project_id != a.project_id
        ORDER BY ra.release_id ASC, ra.asset_id ASC
      `;
      return db.prepare(sql).all();
    },

    /**
     * Release title projections for a batch of assets across all projects.
     * Only valid same-project release/asset associations are returned; this
     * deliberately does not reuse the project-scoped usage query above.
     *
     * @param {number[]} assetIds - asset IDs from the current page
     * @returns {Array<{asset_id: number, release_id: number, title: string}>}
     */
    findReleaseTitlesForAssetIds(assetIds) {
      if (!Array.isArray(assetIds) || assetIds.length === 0) {
        return [];
      }

      const placeholders = assetIds.map(() => '?').join(',');
      const sql = `
        SELECT DISTINCT
          ra.asset_id,
          r.id AS release_id,
          r.title
        FROM release_assets ra
        JOIN releases r ON r.id = ra.release_id
        JOIN assets a ON a.id = ra.asset_id
        WHERE ra.asset_id IN (${placeholders})
          AND r.project_id = a.project_id
        ORDER BY ra.asset_id ASC, r.title COLLATE NOCASE ASC, r.id ASC
      `;

      return db.prepare(sql).all(...assetIds);
    },

    findReleaseUsageForAssetIds(projectId, assetIds) {
      if (!Array.isArray(assetIds) || assetIds.length === 0) {
        return [];
      }

      const placeholders = assetIds.map(() => '?').join(',');
      const sql = `
        SELECT
          ra.asset_id,
          r.id AS release_id,
          r.title,
          r.published_date,
          p.status AS project_status,
          r.archived_at AS release_archived_at,
          p.archived_at AS project_archived_at,
          ra.role,
          ra.sort_order
        FROM release_assets ra
        JOIN releases r ON r.id = ra.release_id
        JOIN projects p ON p.id = r.project_id
        JOIN assets a ON a.id = ra.asset_id
        WHERE ra.asset_id IN (${placeholders})
          AND a.project_id = ?
          AND r.project_id = ?
        ORDER BY ra.asset_id ASC, r.title COLLATE NOCASE ASC, r.id ASC
      `;

      return db.prepare(sql).all(...assetIds, projectId, projectId);
    },
  };
}

const ALLOWED_SORTS = {
  updated: { column: 'updated_at' },
  created: { column: 'created_at' },
  planned: { column: 'planned_date' },
  title: { column: 'title COLLATE NOCASE' },
};

function buildOrderClause(sortBy, order) {
  const sort = ALLOWED_SORTS[sortBy] || ALLOWED_SORTS.updated;
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  if (sortBy === 'planned') {
    return `ORDER BY (planned_date IS NULL) ASC, date(planned_date) ${direction}, (planned_time IS NULL) ASC, planned_time ${direction}, updated_at DESC, id DESC`;
  }
  // Always break ties by id for stable ordering
  return `ORDER BY ${sort.column} ${direction}, id DESC`;
}

function buildOrderClauseWithTable(table, sortBy, order) {
  const sort = ALLOWED_SORTS[sortBy] || ALLOWED_SORTS.updated;
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  if (sortBy === 'planned') {
    return `ORDER BY (${table}.planned_date IS NULL) ASC, date(${table}.planned_date) ${direction}, (${table}.planned_time IS NULL) ASC, ${table}.planned_time ${direction}, ${table}.updated_at DESC, ${table}.id DESC`;
  }
  // Qualify the column with the table name to avoid ambiguity in JOINs
  const col = sort.column.includes('.') ? sort.column : `${table}.${sort.column}`;
  return `ORDER BY ${col} ${direction}, ${table}.id DESC`;
}

function escapeLike(value) {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
