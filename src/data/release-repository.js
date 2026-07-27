export const RELEASE_STATUSES = ['idea', 'planned', 'drafting', 'ready', 'published', 'cancelled'];
export const ACTIVE_RELEASE_STATUSES = ['idea', 'planned', 'drafting', 'ready'];
export const RELEASE_ASSET_ROLES = ['primary', 'preview', 'attachment', 'source'];

const COLUMNS = [
  'id',
  'project_id',
  'title',
  'description',
  'notes',
  'status',
  'planned_date',
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

const COLUMNS_WITH_PROJECT = [
  ...COLUMNS.slice(0, 2), // id, project_id
  'projects.title AS project_title',
  ...COLUMNS.slice(2), // title, description, notes, status, planned_date, published_date, patreon_url, created_at, updated_at, archived_at
];

const SELECT_WITH_PROJECT = `SELECT ${COLUMNS_WITH_PROJECT.join(', ')} FROM releases JOIN projects ON projects.id = releases.project_id`;

const SELECT_ALL = `SELECT ${COLUMNS.join(', ')} FROM releases`;

/**
 * Shared WHERE fragment: releases that are not archived and are in the active
 * workflow (idea/planned/drafting/ready). Used by overdue, upcoming, ready,
 * and missing-planned-date queries so the active-set definition stays in one
 * place.
 */
const ACTIVE_UNARCHIVED = `archived_at IS NULL AND status IN ('idea', 'planned', 'drafting', 'ready')`;

/**
 * Shared EXISTS fragment: release belongs to a project that is not archived.
 * Used by every dashboard workflow query so an active release whose parent
 * project has been archived is hidden from attention lists. Archived
 * projects remain readable through the project workspace (historical recent
 * list, status counts) — only the actionable attention lists are filtered.
 *
 * The fragment references `releases.project_id` and assumes the implicit
 * from-table of the surrounding query is `releases`. Queries that alias the
 * table as `r` use {@link ACTIVE_PARENT_PROJECT_R} instead.
 */
const ACTIVE_PARENT_PROJECT = `EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = releases.project_id
    AND projects.archived_at IS NULL
)`;

/**
 * Same as {@link ACTIVE_PARENT_PROJECT} but for queries that alias the
 * releases table as `r` (currently only findReleasesWithMissingSelectedAssets).
 */
const ACTIVE_PARENT_PROJECT_R = `EXISTS (
  SELECT 1 FROM projects
  WHERE projects.id = r.project_id
    AND projects.archived_at IS NULL
)`;

/**
 * Shared full WHERE fragment for the dashboard attention lists: release is
 * not archived, in an active workflow status, and belongs to a non-archived
 * project. Combines {@link ACTIVE_UNARCHIVED} with the parent-project check.
 */
const DASHBOARD_ACTIVE = `${ACTIVE_UNARCHIVED} AND ${ACTIVE_PARENT_PROJECT}`;

/**
 * @typedef {object} ReleaseRecord
 * @property {number} id
 * @property {number} project_id
 * @property {string} title
 * @property {string} description
 * @property {string} notes
 * @property {string} status
 * @property {string|null} planned_date
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
  const findById = db.prepare(`${SELECT_ALL} WHERE id = ?`);
  const insert = db.prepare(`
    INSERT INTO releases (project_id, title, description, notes, status, planned_date, patreon_url, published_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING ${COLUMNS.join(', ')}
  `);
  const update = db.prepare(`
    UPDATE releases
    SET title = ?, description = ?, notes = ?, status = ?,
        planned_date = ?, patreon_url = ?, published_date = ?, updated_at = datetime('now')
    WHERE id = ? AND archived_at IS NULL
    RETURNING ${COLUMNS.join(', ')}
  `);
  const archive = db.prepare(`
    UPDATE releases
    SET archived_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND archived_at IS NULL
    RETURNING ${COLUMNS.join(', ')}
  `);
  const setPublishedDate = db.prepare(`
    UPDATE releases
    SET status = 'published', published_date = ?, updated_at = datetime('now')
    WHERE id = ? AND archived_at IS NULL
    RETURNING ${COLUMNS.join(', ')}
  `);
  const countByStatus = db.prepare(`
    SELECT status, COUNT(*) AS c
    FROM releases
    WHERE archived_at IS NULL
    GROUP BY status
  `);

  // ─── Release Asset Selection ───────────────────────────────────────────

  const raFindByRelease = db.prepare(`
    SELECT ra.release_id, ra.asset_id, ra.role, ra.sort_order, ra.created_at,
           a.project_id, a.relative_path, a.filename, a.extension,
           a.mime_type, a.size_bytes, a.modified_at, a.is_present,
           a.last_seen_at, a.missing_since, a.created_at as asset_created_at,
           a.updated_at as asset_updated_at
    FROM release_assets ra
    JOIN assets a ON a.id = ra.asset_id
    WHERE ra.release_id = ?
    ORDER BY ra.sort_order ASC, ra.asset_id ASC
  `);

  const raCountByRelease = db.prepare(`
    SELECT COUNT(*) AS c FROM release_assets WHERE release_id = ?
  `);

  const raFindByAsset = db.prepare(`
    SELECT ra.release_id, ra.asset_id, ra.role, ra.sort_order, ra.created_at
    FROM release_assets ra
    WHERE ra.asset_id = ?
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

  const replaceReleaseAssetsTx = db.transaction((releaseId, selections) => {
    raDeleteByRelease.run(releaseId);
    for (const sel of selections) {
      raInsert.run(releaseId, sel.assetId, sel.role, sel.sortOrder);
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
     * @param {string} [options.status]
     * @param {boolean} [options.includeArchived]
     * @param {string} [options.sortBy]
     * @param {string} [options.order]
     * @param {string} [options.search]
     * @returns {ReleaseRecord[]}
     */
    findAll(options = {}) {
      const {
        status,
        includeArchived = false,
        sortBy = 'updated',
        order = 'desc',
        search = '',
      } = options;

      const conditions = [];
      const params = [];

      if (!includeArchived) {
        conditions.push('archived_at IS NULL');
      }

      if (status && RELEASE_STATUSES.includes(status)) {
        conditions.push('status = ?');
        params.push(status);
      }

      if (search) {
        conditions.push('title LIKE ?');
        params.push(`%${search}%`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const orderClause = buildOrderClause(sortBy, order);
      const sql = `${SELECT_ALL} ${where} ${orderClause}`;
      const stmt = db.prepare(sql);
      return stmt.all(...params);
    },

    /**
     * @param {number} projectId
     * @param {Object} [options]
     * @param {string} [options.status]
     * @param {boolean} [options.includeArchived]
     * @param {string} [options.sortBy]
     * @param {string} [options.order]
     * @returns {ReleaseRecord[]}
     */
    findByProjectId(projectId, options = {}) {
      const {
        status,
        includeArchived = false,
        sortBy = 'updated',
        order = 'desc',
      } = options;

      const conditions = ['project_id = ?'];
      const params = [projectId];

      if (!includeArchived) {
        conditions.push('archived_at IS NULL');
      }

      if (status && RELEASE_STATUSES.includes(status)) {
        conditions.push('status = ?');
        params.push(status);
      }

      const where = `WHERE ${conditions.join(' AND ')}`;
      const orderClause = buildOrderClause(sortBy, order);
      const sql = `${SELECT_ALL} ${where} ${orderClause}`;
      const stmt = db.prepare(sql);
      return stmt.all(...params);
    },

    /**
     * @param {Object} input
     * @returns {ReleaseRecord}
     */
    create(input) {
      const values = [
        input.projectId,
        input.title,
        input.description,
        input.notes,
        input.status,
        input.plannedDate ?? null,
        input.patreonUrl ?? null,
        input.publishedDate ?? null,
      ];
      return insert.get(...values);
    },

    /**
     * @param {number} id
     * @param {Object} input
     * @returns {ReleaseRecord|undefined}
     */
    update(id, input) {
      const values = [
        input.title,
        input.description,
        input.notes,
        input.status,
        input.plannedDate ?? null,
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
     * @param {number} id
     * @param {string} publishedDate
     * @returns {ReleaseRecord|undefined}
     */
    publish(id, publishedDate) {
      return setPublishedDate.get(publishedDate, id);
    },

    /**
     * @returns {Object.<string, number>}
     */
    countByStatus() {
      const rows = countByStatus.all();
      const counts = Object.fromEntries(RELEASE_STATUSES.map((s) => [s, 0]));
      for (const row of rows) {
        counts[row.status] = row.c;
      }
      return counts;
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
        ${SELECT_ALL}
        WHERE archived_at IS NULL
          AND status IN ('idea', 'planned', 'drafting', 'ready')
          AND planned_date IS NOT NULL
          AND planned_date > ?
          AND ${ACTIVE_PARENT_PROJECT}
        ORDER BY planned_date ASC
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
        ${SELECT_ALL}
        WHERE archived_at IS NULL
          AND status IN ('idea', 'planned', 'drafting', 'ready')
          AND planned_date IS NOT NULL
          AND planned_date < ?
          AND ${ACTIVE_PARENT_PROJECT}
        ORDER BY planned_date ASC
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
        ${SELECT_ALL}
        WHERE ${DASHBOARD_ACTIVE}
          AND planned_date IS NOT NULL
          AND planned_date < ?
        ORDER BY planned_date ASC
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
        ${SELECT_ALL}
        WHERE ${DASHBOARD_ACTIVE}
          AND planned_date IS NOT NULL
          AND planned_date >= ?
        ORDER BY planned_date ASC
        LIMIT ?
      `;
      return db.prepare(sql).all(today, limit);
    },

    /**
     * Releases with status 'ready'. These are waiting to be published.
     * Bounded; ordered by planned_date ascending (NULLs last), then by
     * updated_at descending as a tie-breaker.
     * @param {number} limit
     * @returns {ReleaseRecord[]}
     */
    findReady(limit) {
      const sql = `
        ${SELECT_ALL}
        WHERE ${DASHBOARD_ACTIVE}
          AND status = 'ready'
        ORDER BY (planned_date IS NULL), planned_date ASC, updated_at DESC
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
        ${SELECT_ALL}
        WHERE ${DASHBOARD_ACTIVE}
          AND planned_date IS NULL
        ORDER BY updated_at DESC
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
     * @returns {Array<ReleaseRecord & {missing_asset_count: number}>}
     */
    findReleasesWithMissingSelectedAssets(limit) {
      const sql = `
        SELECT ${COLUMNS.map((c) => `r.${c}`).join(', ')},
               COUNT(a.id) AS missing_asset_count
        FROM releases r
        JOIN release_assets ra ON ra.release_id = r.id
        JOIN assets a ON a.id = ra.asset_id
        WHERE r.archived_at IS NULL
          AND r.status IN ('idea', 'planned', 'drafting', 'ready')
          AND a.is_present = 0
          AND ${ACTIVE_PARENT_PROJECT_R}
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
        ${SELECT_ALL}
        WHERE ${DASHBOARD_ACTIVE}
          AND NOT EXISTS (
            SELECT 1 FROM release_assets ra WHERE ra.release_id = id
          )
        ORDER BY (planned_date IS NULL), planned_date ASC, updated_at DESC
        LIMIT ?
      `;
      return db.prepare(sql).all(limit);
    },

    /**
     * Per-project release status counts (all releases, including archived).
     * Returns an object keyed by status with 0 for missing statuses.
     * @param {number} projectId
     * @returns {Object.<string, number>}
     */
    countByStatusByProjectId(projectId) {
      const rows = db.prepare(`
        SELECT status, COUNT(*) AS c
        FROM releases
        WHERE project_id = ?
        GROUP BY status
      `).all(projectId);
      const counts = Object.fromEntries(RELEASE_STATUSES.map((s) => [s, 0]));
      for (const row of rows) {
        if (counts[row.status] !== undefined) {
          counts[row.status] = row.c;
        }
      }
      return counts;
    },

    /**
     * Active (non-terminal, non-archived) releases for a project, bounded.
     * Ordered by planned_date ascending (NULLs last) then by updated_at DESC.
     * @param {number} projectId
     * @param {number} limit
     * @returns {ReleaseRecord[]}
     */
    findActiveByProjectId(projectId, limit) {
      const sql = `
        ${SELECT_ALL}
        WHERE project_id = ? AND ${ACTIVE_UNARCHIVED}
        ORDER BY (planned_date IS NULL), planned_date ASC, updated_at DESC
        LIMIT ?
      `;
      return db.prepare(sql).all(projectId, limit);
    },

    /**
     * Recently updated releases for a project (any status, including archived).
     * @param {number} projectId
     * @param {number} limit
     * @returns {ReleaseRecord[]}
     */
    findRecentByProjectId(projectId, limit) {
      const sql = `
        ${SELECT_ALL}
        WHERE project_id = ?
        ORDER BY updated_at DESC
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
        JOIN assets a ON a.id = ra.asset_id
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
        JOIN assets a ON a.id = ra.asset_id
        JOIN releases r ON r.id = ra.release_id
        WHERE a.is_present = 0
          AND r.archived_at IS NULL
          AND a.project_id = ?
      `).get(projectId);
      return row.c;
    },

    // ─── Release Asset Selection ─────────────────────────────────────────

    /**
     * List assets selected for a release.
     * Returns full asset rows enriched with release_assets metadata.
     * @param {number} releaseId
     * @returns {Array<{release_id: number, asset_id: number, role: string, sort_order: number, created_at: string, project_id: number, relative_path: string, filename: string, extension: string, mime_type: string, size_bytes: number, modified_at: string|null, is_present: number, last_seen_at: string|null, missing_since: string|null, asset_created_at: string, asset_updated_at: string}>}
     */
    listReleaseAssets(releaseId) {
      return raFindByRelease.all(releaseId);
    },

    /**
     * Count assets selected for a release.
     * @param {number} releaseId
     * @returns {number}
     */
    countReleaseAssets(releaseId) {
      const row = raCountByRelease.get(releaseId);
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
     * @param {number} releaseId
     * @param {number} assetId
     * @param {string} role
     * @param {number} sortOrder
     * @returns {ReleaseAssetRecord}
     * @throws {Error} on duplicate
     */
    addReleaseAsset(releaseId, assetId, role, sortOrder) {
      return raInsert.get(releaseId, assetId, role, sortOrder);
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

    // ─── Phase 6C: Release Planning Views ─────────────────────────────────

    /**
     * Build the WHERE conditions and params for release list queries.
     * Returns { conditions: string[], params: any[] }.
     * @param {Object} filters
     * @param {number|null} filters.projectId
     * @param {string|null} filters.status
     * @param {string|null} filters.schedule - 'overdue'|'today'|'upcoming'|'unscheduled'
     * @param {boolean} filters.includeArchived
     * @param {string} filters.today - ISO date YYYY-MM-DD for schedule classification
     * @param {boolean} filters.activeScheduleFilter - when true, exclude archived parents
     */
    _buildFilterConditions(filters) {
      const conditions = [];
      const params = [];

      if (filters.projectId != null) {
        conditions.push('releases.project_id = ?');
        params.push(filters.projectId);
      }

      if (filters.status && RELEASE_STATUSES.includes(filters.status)) {
        conditions.push('releases.status = ?');
        params.push(filters.status);
      }

      // Schedule filters (overdue, today, upcoming, unscheduled) ALWAYS exclude
      // archived release records — even when includeArchived=1 — because they
      // are active-workflow views. The includeArchived flag only affects
      // schedule=all (no schedule filter).
      const isScheduleFilter = filters.schedule
        && ['overdue', 'today', 'upcoming', 'unscheduled'].includes(filters.schedule);

      if (!filters.includeArchived || isScheduleFilter) {
        conditions.push('releases.archived_at IS NULL');
      }

      // Schedule filters apply to active releases (non-terminal, non-archived).
      // Per Phase 6C: schedule filters ALWAYS exclude archived parent projects
      // because they are used in active workflow views — even when includeArchived=1.
      if (isScheduleFilter) {
        // Always apply active-release predicate for schedule filters
        conditions.push(`releases.status IN ('idea', 'planned', 'drafting', 'ready')`);

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
     * @param {string|null} filters.status
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
        projectId,
        status,
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
        projectId, status, schedule, includeArchived, today, activeScheduleFilter,
      });

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const orderClause = buildOrderClauseWithTable('releases', sortBy, order);

      // Subqueries for asset counts — correlated aggregates avoid duplicate rows
      const selectedCountSubquery = `(SELECT COUNT(*) FROM release_assets WHERE release_id = releases.id)`;
      const missingCountSubquery = `(SELECT COUNT(*) FROM release_assets ra JOIN assets a ON a.id = ra.asset_id WHERE ra.release_id = releases.id AND a.is_present = 0)`;

      const sql = `
        SELECT releases.id, releases.project_id, projects.title AS project_title,
               releases.title, releases.description, releases.notes,
               releases.status, releases.planned_date, releases.published_date,
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
     * @returns {number}
     */
    countFiltered(filters) {
      const {
        projectId,
        status,
        schedule,
        includeArchived = false,
        today,
        activeScheduleFilter = false,
      } = filters;

      const { conditions, params } = this._buildFilterConditions({
        projectId, status, schedule, includeArchived, today, activeScheduleFilter,
      });

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const sql = `SELECT COUNT(*) AS c FROM releases JOIN projects ON projects.id = releases.project_id ${where}`;
      const row = db.prepare(sql).get(...params);
      return row.c;
    },

    /**
     * Board-ready release data grouped by status.
     * Returns flat array — service layer performs the grouping into columns.
     * @param {Object} filters
     * @param {number|null} filters.projectId
     * @param {string|null} filters.status
     * @param {string|null} filters.schedule
     * @param {boolean} filters.includeArchived
     * @param {string} filters.today
     * @param {boolean} filters.activeScheduleFilter
     * @returns {Array<ReleaseRecord & {project_title: string, selected_asset_count: number, missing_asset_count: number}>}
     */
    findBoard(filters) {
      const {
        projectId,
        status,
        schedule,
        includeArchived = false,
        today,
        activeScheduleFilter = true, // Board view excludes archived parent releases by default
      } = filters;

      const { conditions, params } = this._buildFilterConditions({
        projectId, status, schedule, includeArchived, today, activeScheduleFilter,
      });

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const selectedCountSubquery = `(SELECT COUNT(*) FROM release_assets WHERE release_id = releases.id)`;
      const missingCountSubquery = `(SELECT COUNT(*) FROM release_assets ra JOIN assets a ON a.id = ra.asset_id WHERE ra.release_id = releases.id AND a.is_present = 0)`;

      // Board: sort by planned_date ascending (NULLs last), then updated_at desc,
      // then releases.id DESC as the final deterministic tie-breaker.
      const sql = `
        SELECT releases.id, releases.project_id, projects.title AS project_title,
               releases.title, releases.description, releases.notes,
               releases.status, releases.planned_date, releases.published_date,
               releases.patreon_url, releases.created_at, releases.updated_at,
               releases.archived_at,
               ${selectedCountSubquery} AS selected_asset_count,
               ${missingCountSubquery} AS missing_asset_count
        FROM releases
        JOIN projects ON projects.id = releases.project_id
        ${where}
        ORDER BY (releases.planned_date IS NULL), releases.planned_date ASC, releases.updated_at DESC, releases.id DESC
      `;

      return db.prepare(sql).all(...params);
    },

    /**
     * Releases within a bounded calendar range (inclusive start, exclusive end).
     * Uses planned_date for grouping — no in-memory filtering.
     * @param {string} startDate - ISO date YYYY-MM-DD (inclusive)
     * @param {string} endDate - ISO date YYYY-MM-DD (exclusive)
     * @param {Object} filters
     * @param {number|null} filters.projectId
     * @param {boolean} filters.includeArchived
     * @param {boolean} filters.activeScheduleFilter
     * @returns {Array<ReleaseRecord & {project_title: string, selected_asset_count: number, missing_asset_count: number}>}
     */
    findCalendarRange(startDate, endDate, filters) {
      const {
        projectId,
        includeArchived = false,
        activeScheduleFilter = false,
      } = filters;

      const conditions = [];
      const params = [];

      if (projectId != null) {
        conditions.push('releases.project_id = ?');
        params.push(projectId);
      }

      if (!includeArchived) {
        conditions.push('releases.archived_at IS NULL');
      }

      // For calendar: include all releases with planned_date in [startDate, endDate)
      conditions.push('releases.planned_date IS NOT NULL');
      conditions.push('releases.planned_date >= ?');
      params.push(startDate);
      conditions.push('releases.planned_date < ?');
      params.push(endDate);

      if (activeScheduleFilter) {
        conditions.push(ACTIVE_PARENT_PROJECT);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const selectedCountSubquery = `(SELECT COUNT(*) FROM release_assets WHERE release_id = releases.id)`;
      const missingCountSubquery = `(SELECT COUNT(*) FROM release_assets ra JOIN assets a ON a.id = ra.asset_id WHERE ra.release_id = releases.id AND a.is_present = 0)`;

      const sql = `
        SELECT releases.id, releases.project_id, projects.title AS project_title,
               releases.title, releases.description, releases.notes,
               releases.status, releases.planned_date, releases.published_date,
               releases.patreon_url, releases.created_at, releases.updated_at,
               releases.archived_at,
               ${selectedCountSubquery} AS selected_asset_count,
               ${missingCountSubquery} AS missing_asset_count
        FROM releases
        JOIN projects ON projects.id = releases.project_id
        ${where}
        ORDER BY releases.planned_date ASC, releases.updated_at DESC, releases.id DESC
      `;

      return db.prepare(sql).all(...params);
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
  // Always break ties by id for stable ordering
  return `ORDER BY ${sort.column} ${direction}, id DESC`;
}

function buildOrderClauseWithTable(table, sortBy, order) {
  const sort = ALLOWED_SORTS[sortBy] || ALLOWED_SORTS.updated;
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  // Qualify the column with the table name to avoid ambiguity in JOINs
  const col = sort.column.includes('.') ? sort.column : `${table}.${sort.column}`;
  return `ORDER BY ${col} ${direction}, ${table}.id DESC`;
}
