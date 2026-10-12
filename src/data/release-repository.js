export const RELEASE_ASSET_ROLES = ['primary', 'preview', 'attachment'];

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
const RECENT_RELEASE_ORDER = 'releases.updated_at DESC';

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
export const ACTIVE_UNPUBLISHED = `releases.archived_at IS NULL AND releases.published_date IS NULL`;

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
export const ACTIVE_PARENT_PROJECT = `EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = releases.project_id
    AND projects.archived_at IS NULL
    AND projects.status <> 'archived'
)`;

/**
 * Shared full WHERE fragment for the dashboard attention lists: release is
 * active and unpublished, and belongs to a non-archived project. Combines
 * {@link ACTIVE_UNPUBLISHED} with the parent-project check.
 */
const DASHBOARD_ACTIVE = `${ACTIVE_UNPUBLISHED} AND ${ACTIVE_PARENT_PROJECT}`;

/**
 * Correlated selected/missing asset counts for the release in the
 * surrounding query (from-table `releases`). The project guard keeps
 * malformed cross-project junction rows out of both counts.
 */
const SELECTED_ASSET_COUNT_SQL = `(SELECT COUNT(DISTINCT a.id) FROM release_assets ra JOIN assets a ON a.id = ra.asset_id AND a.project_id = releases.project_id WHERE ra.release_id = releases.id)`;
const MISSING_ASSET_COUNT_SQL = `(SELECT COUNT(DISTINCT a.id) FROM release_assets ra JOIN assets a ON a.id = ra.asset_id AND a.project_id = releases.project_id WHERE ra.release_id = releases.id AND a.is_present = 0)`;

/**
 * Dashboard release row: release columns plus parent project display fields
 * and asset counts. Expects `releases JOIN projects` in the FROM clause.
 */
const DASHBOARD_RELEASE_SELECT = `${QUALIFIED_RELEASE_COLUMNS},
  projects.title AS project_title,
  projects.status AS project_status,
  ${SELECTED_ASSET_COUNT_SQL} AS selected_asset_count,
  ${MISSING_ASSET_COUNT_SQL} AS missing_asset_count`;

/**
 * Dated dashboard order: earliest date first; within a date, timed releases
 * precede date-only releases. Blank stored times are treated as date-only,
 * matching the Calendar order.
 */
const DASHBOARD_DATED_ORDER = `releases.planned_date ASC,
  (NULLIF(releases.planned_time, '') IS NULL) ASC,
  NULLIF(releases.planned_time, '') ASC,
  releases.created_at ASC,
  releases.id ASC`;

/** Release date used by the Calendar: publication date once published. */
const EFFECTIVE_RELEASE_DATE = 'CASE WHEN releases.published_date IS NOT NULL THEN releases.published_date ELSE releases.planned_date END';

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Date boundaries are application-local values supplied by the caller. An
// absent boundary would bind NULL and silently classify nothing, so reject it.
function requireIsoDate(value, name) {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) {
    throw new TypeError(`${name} must be an ISO date string (YYYY-MM-DD).`);
  }
  return value;
}

function normalizeLimit(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
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
  // Compare-and-set: the expected schedule and every lifecycle guard are part
  // of the WHERE clause so a concurrent edit, publication, or archive between
  // the caller's read and this write makes it affect no row. Blank stored
  // values are treated as NULL, matching the date-only convention.
  const updateScheduleStmt = db.prepare(`
    UPDATE releases
    SET planned_date = @plannedDate, planned_time = @plannedTime, updated_at = datetime('now')
    WHERE id = @id
      AND ${ACTIVE_UNPUBLISHED}
      AND ${ACTIVE_PARENT_PROJECT}
      AND NULLIF(planned_date, '') IS @expectedPlannedDate
      AND NULLIF(planned_time, '') IS @expectedPlannedTime
    RETURNING ${COLUMNS.join(', ')}
  `);

  const findCalendarRangeStmt = db.prepare(`
    SELECT
      r.id,
      r.project_id,
      p.title AS project_title,
      p.status AS project_status,
      p.archived_at AS project_archived_at,
      r.title,
      r.notes,
      r.planned_date,
      r.planned_time,
      r.published_date,
      r.archived_at
    FROM releases r
    JOIN projects p ON p.id = r.project_id
    WHERE r.archived_at IS NULL
      AND (CASE WHEN r.published_date IS NOT NULL THEN r.published_date ELSE r.planned_date END) >= ?
      AND (CASE WHEN r.published_date IS NOT NULL THEN r.published_date ELSE r.planned_date END) < ?
      AND (? IS NULL OR r.project_id = ?)
    ORDER BY
      CASE WHEN r.published_date IS NOT NULL THEN r.published_date ELSE r.planned_date END ASC,
      (NULLIF(r.planned_time, '') IS NULL) ASC,
      NULLIF(r.planned_time, '') ASC,
      r.id ASC
  `);

  // ─── Dashboard Projections ─────────────────────────────────────────────

  // Each comparison yields 0/1 (NULL for undated rows, which SUM ignores), so
  // the bucket counts are exact regardless of any display cap.
  const dashboardScheduleSummaryStmt = db.prepare(`
    SELECT
      COALESCE(SUM(releases.planned_date < @today), 0) AS overdue,
      COALESCE(SUM(releases.planned_date = @today), 0) AS today,
      COALESCE(SUM(releases.planned_date > @today AND releases.planned_date <= @weekEnd), 0) AS next7,
      COALESCE(SUM(releases.planned_date > @weekEnd), 0) AS later,
      COALESCE(SUM(releases.planned_date IS NULL), 0) AS undated,
      MIN(CASE WHEN releases.planned_date IS NULL THEN releases.created_at END) AS oldest_undated_created_at
    FROM releases
    WHERE ${DASHBOARD_ACTIVE}
  `);

  // Overdue, Today, and Next 7 days are uncapped; only Later is ranked and cut.
  // Asset counts are computed in the outer query so cut Later rows cost nothing.
  const dashboardScheduledStmt = db.prepare(`
    WITH dated AS (
      SELECT releases.id,
        CASE
          WHEN releases.planned_date < @today THEN 'overdue'
          WHEN releases.planned_date = @today THEN 'today'
          WHEN releases.planned_date <= @weekEnd THEN 'next7'
          ELSE 'later'
        END AS schedule_group,
        ROW_NUMBER() OVER (
          PARTITION BY (releases.planned_date > @weekEnd)
          ORDER BY ${DASHBOARD_DATED_ORDER}
        ) AS group_rank
      FROM releases
      WHERE ${DASHBOARD_ACTIVE}
        AND releases.planned_date IS NOT NULL
    )
    SELECT ${DASHBOARD_RELEASE_SELECT}, dated.schedule_group
    FROM dated
    JOIN releases ON releases.id = dated.id
    JOIN projects ON projects.id = releases.project_id
    WHERE dated.schedule_group <> 'later' OR dated.group_rank <= @laterLimit
    ORDER BY ${DASHBOARD_DATED_ORDER}
  `);

  const dashboardUndatedStmt = db.prepare(`
    SELECT ${DASHBOARD_RELEASE_SELECT}
    FROM releases
    JOIN projects ON projects.id = releases.project_id
    WHERE ${DASHBOARD_ACTIVE}
      AND releases.planned_date IS NULL
    ORDER BY releases.created_at ASC, releases.id ASC
    LIMIT ?
  `);

  const recentlyPublishedStmt = db.prepare(`
    SELECT ${DASHBOARD_RELEASE_SELECT}
    FROM releases
    JOIN projects ON projects.id = releases.project_id
    WHERE releases.archived_at IS NULL
      AND releases.published_date IS NOT NULL
      AND ${ACTIVE_PARENT_PROJECT}
    ORDER BY releases.published_date DESC, releases.updated_at DESC, releases.id DESC
    LIMIT ?
  `);

  const dashboardCalendarDaysStmt = db.prepare(`
    SELECT effective_date AS date,
      SUM(published_date IS NOT NULL) AS published,
      SUM(published_date IS NULL AND effective_date >= @today) AS scheduled,
      SUM(published_date IS NULL AND effective_date < @today) AS overdue
    FROM (
      SELECT ${EFFECTIVE_RELEASE_DATE} AS effective_date, releases.published_date
      FROM releases
      WHERE releases.archived_at IS NULL
        AND ${ACTIVE_PARENT_PROJECT}
    )
    WHERE effective_date >= @startDate AND effective_date < @endDate
    GROUP BY effective_date
    ORDER BY effective_date ASC
  `);

  // Among the first (occupied + count) days from the start date at most
  // `occupied` days can be taken, so the generated range always contains
  // `count` open days. This bounds the recursion without scanning ahead day by
  // day in application code.
  const openDaysStmt = db.prepare(`
    WITH RECURSIVE occupied(day) AS (
      SELECT DISTINCT ${EFFECTIVE_RELEASE_DATE}
      FROM releases
      WHERE releases.archived_at IS NULL
        AND ${ACTIVE_PARENT_PROJECT}
        AND ${EFFECTIVE_RELEASE_DATE} >= @startDate
    ),
    candidate(day, day_index) AS (
      SELECT date(@startDate), 0
      UNION ALL
      SELECT date(day, '+1 day'), day_index + 1
      FROM candidate
      WHERE day_index + 1 < (SELECT COUNT(*) FROM occupied) + @count
    )
    SELECT day FROM candidate
    WHERE day NOT IN (SELECT day FROM occupied)
    ORDER BY day ASC
    LIMIT @count
  `);

  const countActiveReleasesWithMissingSelectedAssetsStmt = db.prepare(`
    SELECT COUNT(DISTINCT releases.id) AS c
    FROM releases
    JOIN release_assets ra ON ra.release_id = releases.id
    JOIN assets a ON a.id = ra.asset_id AND a.project_id = releases.project_id
    WHERE ${DASHBOARD_ACTIVE}
      AND a.is_present = 0
  `);

  // ─── Release Asset Selection ───────────────────────────────────────────

  const raFindByRelease = db.prepare(`
    SELECT ra.release_id, ra.asset_id, ra.role, ra.sort_order, ra.created_at,
           a.project_id, a.category_id, a.relative_path, a.nested_path, a.filename, a.extension,
           a.mime_type, a.size_bytes, a.modified_at, a.source_animated, a.source_generation, a.is_present,
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
     * Set only planned_date, planned_time, and updated_at, provided the stored
     * schedule still equals the expected one and the release is active,
     * unpublished, and inside a non-archived project. No other release column
     * or associated row is touched.
     *
     * @param {number} id
     * @param {{ plannedDate: string|null, plannedTime: string|null }} schedule
     * @param {{ plannedDate: string|null, plannedTime: string|null }} expected
     *   stored schedule the caller observed; blank stored values match null
     * @returns {ReleaseRecord|undefined} the updated row, or undefined when the
     *   release is missing, ineligible, or its schedule no longer matches
     */
    updateSchedule(id, schedule, expected) {
      return updateScheduleStmt.get({
        id,
        plannedDate: schedule.plannedDate ?? null,
        plannedTime: schedule.plannedTime ?? null,
        expectedPlannedDate: expected.plannedDate ?? null,
        expectedPlannedTime: expected.plannedTime ?? null,
      });
    },

    /**
     * Non-archived releases whose effective Calendar date falls within a
     * bounded range. Published releases use publication date; others use
     * planned date. Archived parent projects remain included.
     *
     * @param {string} startDate - ISO date YYYY-MM-DD (inclusive)
     * @param {string} endDate - ISO date YYYY-MM-DD (exclusive)
     * @param {number|null} projectId - optional Calendar-only project filter
     * @returns {Array<ReleaseRecord & {project_title: string, notes: string, published_date: string|null}>}
     */
    findCalendarRange(startDate, endDate, projectId = null) {
      return findCalendarRangeStmt.all(startDate, endDate, projectId, projectId);
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
          AND p.status <> 'archived'
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
        ORDER BY ${RECENT_RELEASE_ORDER}
        LIMIT ?
      `;
      return db.prepare(sql).all(projectId, limit);
    },

    /**
     * Up to five recently updated releases per supplied project, including
     * every publication and archive state.
     * @param {number[]} projectIds
     * @returns {ReleaseRecord[]}
     */
    findRecentByProjectIds(projectIds) {
      const uniqueProjectIds = [...new Set(projectIds)];
      if (uniqueProjectIds.length === 0) return [];

      const placeholders = uniqueProjectIds.map(() => '?').join(', ');
      const rankedColumns = COLUMNS.map((column) => `ranked.${column}`).join(', ');
      const sql = `
        SELECT ${rankedColumns}, ranked.project_status
        FROM (
          SELECT ${QUALIFIED_RELEASE_COLUMNS}, projects.status AS project_status,
                 ROW_NUMBER() OVER (
                   PARTITION BY releases.project_id
                   ORDER BY ${RECENT_RELEASE_ORDER}
                 ) AS recent_rank
          FROM releases
          JOIN projects ON projects.id = releases.project_id
          WHERE releases.project_id IN (${placeholders})
        ) AS ranked
        WHERE ranked.recent_rank <= 5
        ORDER BY ranked.project_id ASC, ranked.updated_at DESC
      `;
      return db.prepare(sql).all(...uniqueProjectIds);
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

    // ─── Dashboard Projections ───────────────────────────────────────────

    /**
     * Exact schedule bucket counts over every active release (unpublished,
     * unarchived, parent project not archived by either indicator). Buckets:
     * overdue `< today`, today `= today`, next7 `today < d <= weekEnd`,
     * later `> weekEnd`, undated `IS NULL`. Independent of any display cap.
     *
     * @param {{ today: string, weekEnd: string }} boundaries application-local
     *   ISO dates; `weekEnd` is normally today + 7 days
     * @returns {{ overdue: number, today: number, next7: number, later: number,
     *   undated: number, oldestUndatedCreatedAt: string|null }}
     */
    getDashboardScheduleSummary({ today, weekEnd } = {}) {
      const row = dashboardScheduleSummaryStmt.get({
        today: requireIsoDate(today, 'today'),
        weekEnd: requireIsoDate(weekEnd, 'weekEnd'),
      });
      return {
        overdue: row.overdue,
        today: row.today,
        next7: row.next7,
        later: row.later,
        undated: row.undated,
        oldestUndatedCreatedAt: row.oldest_undated_created_at,
      };
    },

    /**
     * Dated active releases for the Dashboard schedule, tagged with
     * `schedule_group` ('overdue'|'today'|'next7'|'later'). Overdue, today,
     * and next7 rows are uncapped; at most `laterLimit` later rows are
     * returned. Ordered by planned date, timed before date-only, then
     * created_at and id. Totals come from {@link getDashboardScheduleSummary}.
     *
     * @param {{ today: string, weekEnd: string, laterLimit?: number }} options
     * @returns {Array<ReleaseRecord & {project_title: string, project_status: string,
     *   selected_asset_count: number, missing_asset_count: number,
     *   schedule_group: 'overdue'|'today'|'next7'|'later'}>}
     */
    findDashboardScheduledReleases({ today, weekEnd, laterLimit = 5 } = {}) {
      return dashboardScheduledStmt.all({
        today: requireIsoDate(today, 'today'),
        weekEnd: requireIsoDate(weekEnd, 'weekEnd'),
        laterLimit: normalizeLimit(laterLimit, 5),
      });
    },

    /**
     * Oldest active releases without a planned date, ordered by created_at
     * then id. The undated total and oldest timestamp come from
     * {@link getDashboardScheduleSummary}.
     *
     * @param {number} [limit=10]
     * @returns {Array<ReleaseRecord & {project_title: string, project_status: string,
     *   selected_asset_count: number, missing_asset_count: number}>}
     */
    findDashboardUndatedReleases(limit = 10) {
      return dashboardUndatedStmt.all(normalizeLimit(limit, 10));
    },

    /**
     * Most recently published non-archived releases whose parent project is
     * not archived, ordered by published_date, updated_at, then id (all DESC).
     *
     * @param {number} [limit=4]
     * @returns {Array<ReleaseRecord & {project_title: string, project_status: string,
     *   selected_asset_count: number, missing_asset_count: number}>}
     */
    findRecentlyPublished(limit = 4) {
      return recentlyPublishedStmt.all(normalizeLimit(limit, 4));
    },

    /**
     * Per-day release counts for the Dashboard strip, keyed by effective date
     * (published_date once published, otherwise planned_date). Unlike
     * {@link findCalendarRange}, releases of archived projects are excluded.
     * Unpublished releases dated before `today` count as overdue, others as
     * scheduled. Days without releases are omitted.
     *
     * @param {{ startDate: string, endDate: string, today: string }} range
     *   `startDate` inclusive, `endDate` exclusive
     * @returns {Array<{date: string, published: number, scheduled: number, overdue: number}>}
     */
    countDashboardCalendarDays({ startDate, endDate, today } = {}) {
      return dashboardCalendarDaysStmt.all({
        startDate: requireIsoDate(startDate, 'startDate'),
        endDate: requireIsoDate(endDate, 'endDate'),
        today: requireIsoDate(today, 'today'),
      });
    },

    /**
     * The first `count` days on or after `startDate` with no eligible release
     * (non-archived release of a non-archived project, scheduled or published
     * on that effective date). May extend past any display range. Advisory
     * only: several releases can still share a date.
     *
     * @param {string} startDate ISO date, normally tomorrow
     * @param {number} [count=3]
     * @returns {string[]} ISO dates in ascending order
     */
    findOpenDays(startDate, count = 3) {
      return openDaysStmt.pluck().all({
        startDate: requireIsoDate(startDate, 'startDate'),
        count: normalizeLimit(count, 3),
      });
    },

    /**
     * Distinct active releases that select at least one missing asset of
     * their own project. Same predicate as
     * {@link findReleasesWithMissingSelectedAssets}, without a limit.
     *
     * @returns {number}
     */
    countActiveReleasesWithMissingSelectedAssets() {
      return countActiveReleasesWithMissingSelectedAssetsStmt.get().c;
    },

    /**
     * One row per existing supplied project: its next dated active release
     * (earliest planned date, overdue included; timed before date-only, then
     * created_at and id), the number of undated active releases, and the
     * latest published_date among its non-archived releases. Projects with no
     * releases yield null/zero fields, as do archived projects (no active
     * releases and no publication date). Returns [] for empty input without
     * querying.
     *
     * @param {number[]} projectIds
     * @returns {Array<{project_id: number, next_release_id: number|null,
     *   next_release_title: string|null, next_planned_date: string|null,
     *   next_planned_time: string|null, undated_count: number,
     *   last_published_date: string|null}>}
     */
    findReleaseScheduleSummaryByProjectIds(projectIds) {
      const uniqueProjectIds = [...new Set(projectIds)];
      if (uniqueProjectIds.length === 0) return [];

      const placeholders = uniqueProjectIds.map(() => '?').join(', ');
      const sql = `
        WITH requested AS (
          SELECT id FROM projects WHERE id IN (${placeholders})
        ),
        ranked_dated AS (
          SELECT releases.project_id, releases.id, releases.title,
                 releases.planned_date, NULLIF(releases.planned_time, '') AS planned_time,
                 ROW_NUMBER() OVER (
                   PARTITION BY releases.project_id
                   ORDER BY ${DASHBOARD_DATED_ORDER}
                 ) AS date_rank
          FROM releases
          JOIN requested ON requested.id = releases.project_id
          WHERE ${DASHBOARD_ACTIVE}
            AND releases.planned_date IS NOT NULL
        ),
        undated AS (
          SELECT releases.project_id, COUNT(*) AS undated_count
          FROM releases
          JOIN requested ON requested.id = releases.project_id
          WHERE ${DASHBOARD_ACTIVE}
            AND releases.planned_date IS NULL
          GROUP BY releases.project_id
        ),
        published AS (
          SELECT releases.project_id, MAX(releases.published_date) AS last_published_date
          FROM releases
          JOIN requested ON requested.id = releases.project_id
          WHERE releases.archived_at IS NULL
            AND releases.published_date IS NOT NULL
            AND ${ACTIVE_PARENT_PROJECT}
          GROUP BY releases.project_id
        )
        SELECT requested.id AS project_id,
               ranked_dated.id AS next_release_id,
               ranked_dated.title AS next_release_title,
               ranked_dated.planned_date AS next_planned_date,
               ranked_dated.planned_time AS next_planned_time,
               COALESCE(undated.undated_count, 0) AS undated_count,
               published.last_published_date
        FROM requested
        LEFT JOIN ranked_dated
          ON ranked_dated.project_id = requested.id AND ranked_dated.date_rank = 1
        LEFT JOIN undated ON undated.project_id = requested.id
        LEFT JOIN published ON published.project_id = requested.id
        ORDER BY requested.id ASC
      `;
      return db.prepare(sql).all(...uniqueProjectIds);
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
            a.source_animated,
            a.source_generation,
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
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const orderClause = buildOrderClauseWithTable('releases', sortBy, order);

      const sql = `
        SELECT releases.id, releases.project_id, projects.title AS project_title,
               projects.status AS project_status,
               releases.title, releases.description, releases.notes,
               releases.planned_date, releases.planned_time, releases.published_date,
               releases.patreon_url, releases.created_at, releases.updated_at,
               releases.archived_at,
               ${SELECTED_ASSET_COUNT_SQL} AS selected_asset_count,
               ${MISSING_ASSET_COUNT_SQL} AS missing_asset_count
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
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const sql = `SELECT COUNT(*) AS c FROM releases JOIN projects ON projects.id = releases.project_id ${where}`;
      const row = db.prepare(sql).get(...params);
      return row.c;
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

      const unique = [...new Set(assetIds)].sort((a, b) => a - b);
      const CHUNK_SIZE = 500;
      const results = [];

      for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
        const chunk = unique.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(',');
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

        results.push(...db.prepare(sql).all(...chunk));
      }

      return results;
    },

    findReleaseUsageForAssetIds(projectId, assetIds) {
      if (!Array.isArray(assetIds) || assetIds.length === 0) {
        return [];
      }

      const unique = [...new Set(assetIds)].sort((a, b) => a - b);
      const CHUNK_SIZE = 500;
      const results = [];

      for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
        const chunk = unique.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(',');
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

        results.push(...db.prepare(sql).all(...chunk, projectId, projectId));
      }

      return results;
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
