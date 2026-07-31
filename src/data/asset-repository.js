/**
 * Asset repository — SQL operations for the assets table.
 *
 * All paths stored are relative to the project directory.
 * No absolute host/container paths are ever stored.
 */

const ASSET_COLUMNS = [
  'id',
  'project_id',
  'category_id',
  'relative_path',
  'nested_path',
  'filename',
  'extension',
  'mime_type',
  'size_bytes',
  'modified_at',
  'is_present',
  'last_seen_at',
  'missing_since',
  'created_at',
  'updated_at',
];

const ALLOWED_SORTS = {
  filename: { column: 'filename COLLATE NOCASE' },
  size: { column: 'size_bytes' },
  modified: { column: 'modified_at' },
};

function buildOrderClause(sortBy, order) {
  const sort = ALLOWED_SORTS[sortBy] || ALLOWED_SORTS.filename;
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${sort.column} ${direction}`;
}

/**
 * Canonical asset-browser order clause builder. Explicit sort keys only —
 * no natural sort. Every branch ends with `a.id ASC` as a deterministic
 * tie-breaker. Null placement for modified/size/category is fixed (nulls
 * last) independent of the requested direction, so toggling asc/desc never
 * moves missing-value rows to the top.
 *
 * @param {'filename'|'modified'|'size'|'category'} sortBy
 * @param {'asc'|'desc'} order
 * @returns {string} a full `ORDER BY ...` clause
 */
function buildAssetBrowserOrderClause(sortBy, order) {
  const dir = order === 'desc' ? 'DESC' : 'ASC';

  if (sortBy === 'modified') {
    return `ORDER BY (a.modified_at IS NULL) ASC, a.modified_at ${dir}, a.id ASC`;
  }
  if (sortBy === 'size') {
    return `ORDER BY (a.size_bytes IS NULL) ASC, a.size_bytes ${dir}, a.id ASC`;
  }
  if (sortBy === 'category') {
    return `ORDER BY (a.category_id IS NULL) ASC, c.display_order ${dir}, a.category_id ${dir}, a.nested_path COLLATE NOCASE ${dir}, a.filename COLLATE NOCASE ${dir}, a.id ASC`;
  }
  return `ORDER BY a.filename COLLATE NOCASE ${dir}, a.id ASC`;
}

const CATEGORY_JOIN = 'LEFT JOIN project_asset_categories c ON c.project_id = a.project_id AND c.id = a.category_id';

const ASSET_BROWSER_CATEGORY_COLUMNS = `
          c.display_name AS category_display_name,
          c.enabled AS category_enabled,
          c.display_order AS category_display_order,`;

function escapeLike(value) {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Create an asset repository bound to a database connection.
 * @param {import('better-sqlite3').Database} db
 */
export function createAssetRepository(db) {
  const findByProjectStmt = db.prepare(`
    SELECT ${ASSET_COLUMNS.join(', ')}
    FROM assets
    WHERE project_id = ?
  `);

  const findByIdStmt = db.prepare(`
    SELECT ${ASSET_COLUMNS.join(', ')}
    FROM assets
    WHERE id = ?
  `);

  const findByPathStmt = db.prepare(`
    SELECT ${ASSET_COLUMNS.join(', ')}
    FROM assets
    WHERE project_id = ? AND relative_path = ?
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO assets (project_id, relative_path, category_id, nested_path, filename, extension, mime_type, size_bytes, modified_at, is_present, last_seen_at, missing_since)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), NULL)
    ON CONFLICT(project_id, relative_path) DO UPDATE SET
      category_id = excluded.category_id,
      nested_path = excluded.nested_path,
      filename = excluded.filename,
      extension = excluded.extension,
      mime_type = excluded.mime_type,
      size_bytes = excluded.size_bytes,
      modified_at = excluded.modified_at,
      is_present = 1,
      last_seen_at = datetime('now'),
      missing_since = NULL,
      updated_at = datetime('now')
    RETURNING ${ASSET_COLUMNS.join(', ')}
  `);

  const selectExistingForReconcileStmt = db.prepare(`
    SELECT id, category_id, nested_path, relative_path, filename, extension, mime_type, size_bytes, modified_at, is_present
    FROM assets
    WHERE project_id = ?
  `);

  const insertReconcileStmt = db.prepare(`
    INSERT INTO assets (project_id, relative_path, category_id, nested_path, filename, extension, mime_type, size_bytes, modified_at, is_present, last_seen_at, missing_since)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), NULL)
  `);

  const updateReconcileStmt = db.prepare(`
    UPDATE assets
    SET category_id = ?,
        nested_path = ?,
        filename = ?,
        extension = ?,
        mime_type = ?,
        size_bytes = ?,
        modified_at = ?,
        is_present = 1,
        last_seen_at = datetime('now'),
        missing_since = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `);

  const markMissingNotInReconcileStmt = (presentPaths) => {
    const placeholders = presentPaths.map(() => '?').join(',');
    return db.prepare(`
      UPDATE assets
      SET is_present = 0,
          missing_since = COALESCE(missing_since, datetime('now')),
          updated_at = datetime('now')
      WHERE project_id = ? AND relative_path NOT IN (${placeholders}) AND is_present = 1
    `);
  };

  const markAllMissingReconcileStmt = db.prepare(`
    UPDATE assets
    SET is_present = 0,
        missing_since = COALESCE(missing_since, datetime('now')),
        updated_at = datetime('now')
    WHERE project_id = ? AND is_present = 1
  `);

  /**
   * Atomic scan reconciliation. Takes the complete discovered snapshot for a
   * project (already classified with categoryId/nestedPath) and applies it
   * in one transaction: inserts new paths, restores/updates existing ones
   * (including a path-derived-field-only repair when size/mtime match), and
   * marks undiscovered paths missing. Rolls back entirely on any failure.
   *
   * @param {number} projectId
   * @param {Array<{relativePath: string, filename: string, extension: string, mimeType: string, sizeBytes: number, modifiedAt: string|null, categoryId: number|null, nestedPath: string}>} discovered
   * @returns {{ added: number, updated: number, removed: number, total: number }}
   */
  const reconcileScannedAssetsTx = db.transaction((projectId, discovered) => {
    const existingByPath = new Map(
      selectExistingForReconcileStmt.all(projectId).map((row) => [row.relative_path, row])
    );

    let added = 0;
    let updated = 0;
    const discoveredPaths = [];

    for (const file of discovered) {
      discoveredPaths.push(file.relativePath);
      const categoryId = file.categoryId ?? null;
      const nestedPath = file.nestedPath ?? '';
      const modifiedAt = file.modifiedAt || null;
      const existing = existingByPath.get(file.relativePath);

      if (!existing) {
        insertReconcileStmt.run(
          projectId,
          file.relativePath,
          categoryId,
          nestedPath,
          file.filename,
          file.extension,
          file.mimeType,
          file.sizeBytes,
          modifiedAt,
        );
        added++;
        continue;
      }

      const changed =
        existing.is_present === 0 ||
        existing.category_id !== categoryId ||
        existing.nested_path !== nestedPath ||
        existing.filename !== file.filename ||
        existing.extension !== file.extension ||
        existing.mime_type !== file.mimeType ||
        existing.size_bytes !== file.sizeBytes ||
        existing.modified_at !== modifiedAt;

      if (changed) {
        updateReconcileStmt.run(
          categoryId,
          nestedPath,
          file.filename,
          file.extension,
          file.mimeType,
          file.sizeBytes,
          modifiedAt,
          existing.id,
        );
        updated++;
      }
    }

    const removed =
      discoveredPaths.length === 0
        ? markAllMissingReconcileStmt.run(projectId).changes
        : markMissingNotInReconcileStmt(discoveredPaths).run(projectId, ...discoveredPaths).changes;

    const total = countByProjectStmt.get(projectId).c;

    return { added, updated, removed, total };
  });

  // ─── Phase 2 chunk 2: project-category mutation support ────────────────

  const countAssetsByCategoryStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM assets WHERE project_id = ? AND category_id = ?
  `);

  const deletePathsNotInStmt = db.prepare(`
    DELETE FROM assets
    WHERE project_id = ? AND relative_path NOT IN (?)
  `);

  const deleteByProjectStmt = db.prepare(`
    DELETE FROM assets WHERE project_id = ?
  `);

  const countByProjectStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM assets WHERE project_id = ?
  `);

  const totalCountStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM assets
  `);

  const totalMissingCountStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM assets WHERE is_present = 0
  `);

  const presentCountByProjectStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM assets WHERE project_id = ? AND is_present = 1
  `);

  const missingCountByProjectStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM assets WHERE project_id = ? AND is_present = 0
  `);

  return {
    /**
     * Find an asset by its id.
     * @param {number} id
     * @returns {import('./asset-repository.js').AssetRecord|undefined}
     */
    findById(id) {
      return findByIdStmt.get(id);
    },

    /**
     * Find multiple assets by id in one bounded query. Used by bulk
     * operations (e.g. adding several assets to a release) so validation
     * never issues one lookup per submitted ID. Duplicate IDs are
     * deduplicated before querying; unmatched IDs are simply absent from
     * the result (no error).
     * @param {number[]} ids
     * @returns {import('./asset-repository.js').AssetRecord[]}
     */
    findByIds(ids) {
      if (!Array.isArray(ids) || ids.length === 0) return [];
      const unique = [...new Set(ids)];
      const placeholders = unique.map(() => '?').join(',');
      const sql = `SELECT ${ASSET_COLUMNS.join(', ')} FROM assets WHERE id IN (${placeholders})`;
      return db.prepare(sql).all(...unique);
    },

    /**
     * Find all assets for a project, with optional filtering and sorting.
     * @param {number} projectId
     * @param {object} [options]
     * @param {string} [options.extension] - Filter by file extension (without dot)
     * @param {string} [options.search] - Filename search term
     * @param {string} [options.sortBy] - Column to sort by: filename, size, modified
     * @param {string} [options.order] - asc or desc
     * @returns {import('./asset-repository.js').AssetRecord[]}
     */
    findByProjectId(projectId, options = {}) {
      const { extension, search, sortBy = 'filename', order = 'asc' } = options;

      const conditions = ['project_id = ?'];
      const params = [projectId];

      if (extension) {
        conditions.push('extension = ?');
        params.push(extension);
      }

      if (search && search.trim()) {
        const term = `%${escapeLike(search.trim())}%`;
        conditions.push('filename LIKE ? ESCAPE \'\\\'');
        params.push(term);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const orderClause = buildOrderClause(sortBy, order);
      const sql = `SELECT ${ASSET_COLUMNS.join(', ')} FROM assets ${where} ${orderClause}`;

      return db.prepare(sql).all(...params);
    },

    /**
     * Find a single asset by project and relative path.
     * @param {number} projectId
     * @param {string} relativePath
     * @returns {import('./asset-repository.js').AssetRecord|undefined}
     */
    findByProjectIdAndPath(projectId, relativePath) {
      return findByPathStmt.get(projectId, relativePath);
    },

    /**
     * Upsert an asset record. If a record with the same project_id and
     * relative_path exists, it is updated. Otherwise a new record is created.
     * @param {number} projectId
     * @param {string} relativePath
     * @param {object} data
     * @param {string} data.filename
     * @param {string} data.extension
     * @param {string} data.mimeType
     * @param {number} data.sizeBytes
     * @param {string|null} data.modifiedAt
     * @param {number|null} [data.categoryId]
     * @param {string} [data.nestedPath]
     * @returns {import('./asset-repository.js').AssetRecord}
     */
    upsert(projectId, relativePath, data) {
      return upsertStmt.get(
        projectId,
        relativePath,
        data.categoryId ?? null,
        data.nestedPath ?? '',
        data.filename,
        data.extension,
        data.mimeType,
        data.sizeBytes,
        data.modifiedAt || null,
      );
    },

    /**
     * Atomic scan reconciliation — see {@link reconcileScannedAssetsTx}.
     * @param {number} projectId
     * @param {Array<{relativePath: string, filename: string, extension: string, mimeType: string, sizeBytes: number, modifiedAt: string|null, categoryId: number|null, nestedPath: string}>} discovered
     * @returns {{ added: number, updated: number, removed: number, total: number }}
     */
    reconcileScannedAssets(projectId, discovered) {
      return reconcileScannedAssetsTx(projectId, discovered);
    },

  /**
   * Mark assets as missing for a project whose relative_path is NOT in the given list.
   * Designed for scanner reconciliation — marks records as missing instead of deleting.
   * @param {number} projectId
   * @param {string[]} presentPaths - Array of relative paths that are present on disk
   * @returns {number} Number of marked rows
   */
  markMissingByProjectIdAndPathNotIn(projectId, presentPaths) {
    if (presentPaths.length === 0) {
      // All assets for the project are missing
      return this.markAllMissing(projectId);
    }

    const placeholders = presentPaths.map(() => '?').join(',');
    const sql = `
      UPDATE assets
      SET is_present = 0,
          missing_since = COALESCE(missing_since, datetime('now')),
          updated_at = datetime('now')
      WHERE project_id = ? AND relative_path NOT IN (${placeholders}) AND is_present = 1
    `;
    const result = db.prepare(sql).run(projectId, ...presentPaths);
    return result.changes;
  },

  /**
   * Mark all assets for a project as missing.
   * @param {number} projectId
   * @returns {number} Number of marked rows
   */
  markAllMissing(projectId) {
    const sql = `
      UPDATE assets
      SET is_present = 0,
          missing_since = COALESCE(missing_since, datetime('now')),
          updated_at = datetime('now')
      WHERE project_id = ? AND is_present = 1
    `;
    const result = db.prepare(sql).run(projectId);
    return result.changes;
  },

  /**
   * Restore present assets by marking them as present again.
   * Only affects assets that are currently marked as missing.
   * @param {number} projectId
   * @param {string[]} presentPaths - Array of relative paths that are present on disk
   * @returns {number} Number of restored rows
   */
  restorePresent(projectId, presentPaths) {
    if (presentPaths.length === 0) {
      return 0;
    }

    const placeholders = presentPaths.map(() => '?').join(',');
    const sql = `
      UPDATE assets
      SET is_present = 1,
          last_seen_at = datetime('now'),
          missing_since = NULL,
          updated_at = datetime('now')
      WHERE project_id = ? AND relative_path IN (${placeholders}) AND is_present = 0
    `;
    const result = db.prepare(sql).run(projectId, ...presentPaths);
    return result.changes;
  },

  /**
   * Find missing assets for a project.
   * @param {number} projectId
   * @returns {import('./asset-repository.js').AssetRecord[]}
   */
  findMissingByProjectId(projectId) {
    return db.prepare(`
      SELECT ${ASSET_COLUMNS.join(', ')}
      FROM assets
      WHERE project_id = ? AND is_present = 0
      ORDER BY missing_since DESC
    `).all(projectId);
  },

  /**
   * Find present assets for a project.
   * @param {number} projectId
   * @returns {import('./asset-repository.js').AssetRecord[]}
   */
  findPresentByProjectId(projectId) {
    return db.prepare(`
      SELECT ${ASSET_COLUMNS.join(', ')}
      FROM assets
      WHERE project_id = ? AND is_present = 1
      ORDER BY filename COLLATE NOCASE
    `).all(projectId);
  },

    /**
     * Delete all assets for a project.
     * @param {number} projectId
     * @returns {number} Number of deleted rows
     */
    deleteByProjectId(projectId) {
      const result = deleteByProjectStmt.run(projectId);
      return result.changes;
    },

    /**
     * Count assets for a project.
     * @param {number} projectId
     * @returns {number}
     */
    countByProjectId(projectId) {
      const row = countByProjectStmt.get(projectId);
      return row.c;
    },

    /**
     * Count assets across all projects.
     * @returns {number}
     */
    getTotalCount() {
      const row = totalCountStmt.get();
      return row.c;
    },

    /**
     * Count assets currently marked as missing across all projects.
     * @returns {number}
     */
    getTotalMissingCount() {
      const row = totalMissingCountStmt.get();
      return row.c;
    },

    /**
     * Count present assets for a single project.
     * @param {number} projectId
     * @returns {number}
     */
    countPresentByProjectId(projectId) {
      const row = presentCountByProjectStmt.get(projectId);
      return row.c;
    },

    /**
     * Count missing assets for a single project.
     * @param {number} projectId
     * @returns {number}
     */
    countMissingByProjectId(projectId) {
      const row = missingCountByProjectStmt.get(projectId);
      return row.c;
    },

    // ─── Phase 2 chunk 2: project-category mutation support ──────────────

    /**
     * Count every asset row (present or missing) referencing a project
     * category. Used to decide whether a category can be safely deleted.
     * @param {number} projectId
     * @param {number} categoryId
     * @returns {number}
     */
    countByCategoryId(projectId, categoryId) {
      return countAssetsByCategoryStmt.get(projectId, categoryId).c;
    },

    /**
     * Get distinct extensions used by a project's assets.
     * @param {number} projectId
     * @returns {string[]}
     */
    getExtensions(projectId) {
      const sql = `
        SELECT DISTINCT LOWER(extension) AS extension
        FROM assets
        WHERE project_id = ? AND extension <> ''
        ORDER BY extension COLLATE NOCASE ASC
      `;
      return db.prepare(sql).pluck().all(projectId);
    },

    /**
     * Stable extension choices for a project's asset browser.
     * The list is project-owned only; search, presence, usage, and current
     * extension filters do not affect it, so the filter menu does not collapse
     * while another filter is active.
     * @param {number} projectId
     * @returns {string[]}
     */
    listProjectAssetExtensions(projectId) {
      return this.getExtensions(projectId);
    },

    // ─── Phase 6D: Asset Browser Queries ──────────────────────────────────

    /**
     * Build WHERE conditions and params for asset browser queries.
     * Shared by both findProjectAssetPage and countProjectAssets so they
     * always use identical filter predicates.
     *
     * @param {number} projectId
     * @param {object} filters
     * @param {string|null} [filters.search]
     * @param {string|null} [filters.extension]
     * @param {'all'|'present'|'missing'} [filters.presence]
     * @param {'all'|'used'|'unused'} [filters.usage]
     * @param {'all'|'uncategorized'|number} [filters.category]
     * @returns {{ conditions: string[], params: any[] }}
     */
    _buildAssetBrowserConditions(projectId, filters) {
      const conditions = ['a.project_id = ?'];
      const params = [projectId];

      if (filters.search) {
        conditions.push(`(a.filename COLLATE NOCASE LIKE ? ESCAPE '\\' OR a.relative_path COLLATE NOCASE LIKE ? ESCAPE '\\')`);
        const term = `%${escapeLike(filters.search)}%`;
        params.push(term, term);
      }

      if (filters.extension) {
        conditions.push('LOWER(a.extension) = ?');
        params.push(filters.extension);
      }

      if (filters.presence === 'present') {
        conditions.push('a.is_present = 1');
      } else if (filters.presence === 'missing') {
        conditions.push('a.is_present = 0');
      }
      // 'all' = no presence restriction

      if (filters.usage === 'used') {
        conditions.push('EXISTS (SELECT 1 FROM release_assets ra JOIN releases r ON r.id = ra.release_id WHERE ra.asset_id = a.id AND r.project_id = a.project_id)');
      } else if (filters.usage === 'unused') {
        conditions.push('NOT EXISTS (SELECT 1 FROM release_assets ra JOIN releases r ON r.id = ra.release_id WHERE ra.asset_id = a.id AND r.project_id = a.project_id)');
      }
      // 'all' = no usage restriction

      if (filters.category === 'uncategorized') {
        conditions.push('a.category_id IS NULL');
      } else if (typeof filters.category === 'number') {
        conditions.push('a.category_id = ?');
        params.push(filters.category);
      }
      // 'all' / undefined = no category restriction

      return { conditions, params };
    },

    /**
     * Paginated asset list for the asset browser.
     * Each asset includes a distinct count of releases that reference it.
     * Uses SQL LIMIT/OFFSET for efficient pagination.
     *
     * @param {number} projectId
     * @param {object} [filters]
     * @param {string|null} [filters.search=null]
     * @param {string|null} [filters.extension=null]
     * @param {'all'|'present'|'missing'} [filters.presence='all']
     * @param {'all'|'used'|'unused'} [filters.usage='all']
     * @param {number} [filters.page=1]
     * @param {number} [filters.pageSize=25]
     * @returns {Array<{id: number, project_id: number, relative_path: string, filename: string, extension: string, mime_type: string, size_bytes: number, modified_at: string|null, is_present: number, last_seen_at: string|null, missing_since: string|null, release_usage_count: number}>}
     */
    findProjectAssetPage(projectId, filters = {}) {
      const {
        search = null, extension = null, presence = 'all', usage = 'all', category = 'all',
        sort = 'filename', order = 'asc', page = 1, pageSize = 25,
      } = filters;

      const { conditions, params } = this._buildAssetBrowserConditions(projectId, {
        search,
        extension,
        presence,
        usage,
        category,
      });

      const offset = (Math.max(1, page) - 1) * Math.max(1, pageSize);
      const orderClause = buildAssetBrowserOrderClause(sort, order);

      const sql = `
        SELECT
          a.id,
          a.project_id,
          a.category_id,
          a.relative_path,
          a.nested_path,
          a.filename,
          a.extension,
          a.mime_type,
          a.size_bytes,
          a.modified_at,
          a.is_present,
          a.last_seen_at,
          a.missing_since,${ASSET_BROWSER_CATEGORY_COLUMNS}
          (SELECT COUNT(DISTINCT ra.release_id) FROM release_assets ra JOIN releases r ON r.id = ra.release_id WHERE ra.asset_id = a.id AND r.project_id = a.project_id) AS release_usage_count
        FROM assets a
        ${CATEGORY_JOIN}
        WHERE ${conditions.join(' AND ')}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

      return db.prepare(sql).all(...params, pageSize, offset);
    },

    /**
     * Project-scoped asset viewer context for one asset.
     *
     * The current asset is loaded by project+asset identity, while the
     * adjacent IDs and filtered position are calculated from the complete
     * filtered browser result using the same deterministic ordering as
     * findProjectAssetPage. This keeps query count constant with project size
     * and avoids materializing all matching asset IDs in application memory.
     *
     * If the asset belongs to the project but is excluded by the filters, the
     * asset row is still returned with null position and adjacent IDs.
     * Unknown assets and cross-project assets return undefined.
     *
     * @param {number} projectId
     * @param {number} assetId
     * @param {object} [filters]
     * @param {string|null} [filters.search=null]
     * @param {string|null} [filters.extension=null]
     * @param {'all'|'present'|'missing'} [filters.presence='all']
     * @param {'all'|'used'|'unused'} [filters.usage='all']
     * @returns {undefined | {id: number, project_id: number, relative_path: string, filename: string, extension: string, mime_type: string, size_bytes: number, modified_at: string|null, is_present: number, last_seen_at: string|null, missing_since: string|null, release_usage_count: number, filtered_position: number|null, previous_asset_id: number|null, next_asset_id: number|null, filtered_total: number}}
     */
    findProjectAssetViewerContext(projectId, assetId, filters = {}) {
      const {
        search = null, extension = null, presence = 'all', usage = 'all', category = 'all',
        sort = 'filename', order = 'asc',
      } = filters;

      const { conditions, params } = this._buildAssetBrowserConditions(projectId, {
        search,
        extension,
        presence,
        usage,
        category,
      });

      const orderClause = buildAssetBrowserOrderClause(sort, order);
      const orderBody = orderClause.slice('ORDER BY '.length);

      const sql = `
        WITH filtered AS (
          SELECT
            a.id,
            ROW_NUMBER() OVER (ORDER BY ${orderBody}) AS filtered_position,
            LAG(a.id) OVER (ORDER BY ${orderBody}) AS previous_asset_id,
            LEAD(a.id) OVER (ORDER BY ${orderBody}) AS next_asset_id
          FROM assets a
          ${CATEGORY_JOIN}
          WHERE ${conditions.join(' AND ')}
        ),
        filtered_total AS (
          SELECT COUNT(*) AS total FROM filtered
        )
        SELECT
          a.id,
          a.project_id,
          a.category_id,
          a.relative_path,
          a.nested_path,
          a.filename,
          a.extension,
          a.mime_type,
          a.size_bytes,
          a.modified_at,
          a.is_present,
          a.last_seen_at,
          a.missing_since,${ASSET_BROWSER_CATEGORY_COLUMNS}
          (SELECT COUNT(DISTINCT ra.release_id) FROM release_assets ra JOIN releases r ON r.id = ra.release_id WHERE ra.asset_id = a.id AND r.project_id = a.project_id) AS release_usage_count,
          f.filtered_position,
          f.previous_asset_id,
          f.next_asset_id,
          filtered_total.total AS filtered_total
        FROM assets a
        ${CATEGORY_JOIN}
        CROSS JOIN filtered_total
        LEFT JOIN filtered f ON f.id = a.id
        WHERE a.project_id = ? AND a.id = ?
      `;

      return db.prepare(sql).get(...params, projectId, assetId);
    },

    /**
     * Count of matching assets for the asset browser.
     * Uses identical filter predicates as findProjectAssetPage.
     *
     * @param {number} projectId
     * @param {object} [filters]
     * @param {string|null} [filters.search=null]
     * @param {string|null} [filters.extension=null]
     * @param {'all'|'present'|'missing'} [filters.presence='all']
     * @param {'all'|'used'|'unused'} [filters.usage='all']
     * @returns {number}
     */
    countProjectAssets(projectId, filters = {}) {
      const { search = null, extension = null, presence = 'all', usage = 'all', category = 'all' } = filters;

      const { conditions, params } = this._buildAssetBrowserConditions(projectId, {
        search,
        extension,
        presence,
        usage,
        category,
      });

      const sql = `SELECT COUNT(*) AS c FROM assets a WHERE ${conditions.join(' AND ')}`;
      const row = db.prepare(sql).get(...params);
      return row.c;
    },

    /**
     * Whole-project asset navigation counts for the asset browser: total
     * count, uncategorized count, missing count, and a total-per-category
     * breakdown (present + missing both contribute). Independent of the
     * active browser search/extension/presence/usage/category/pagination
     * filters. One bounded GROUP BY query — never one query per category.
     *
     * @param {number} projectId
     * @returns {{ total: number, uncategorized: number, missing: number, byCategoryId: Object<number, number> }}
     */
    getProjectAssetNavigationCounts(projectId) {
      const rows = db.prepare(`
        SELECT
          category_id,
          COUNT(*) AS total,
          SUM(CASE WHEN is_present = 0 THEN 1 ELSE 0 END) AS missing
        FROM assets
        WHERE project_id = ?
        GROUP BY category_id
      `).all(projectId);

      let total = 0;
      let uncategorized = 0;
      let missing = 0;
      const byCategoryId = {};

      for (const row of rows) {
        total += row.total;
        missing += row.missing;
        if (row.category_id === null) {
          uncategorized = row.total;
        } else {
          byCategoryId[row.category_id] = row.total;
        }
      }

      return { total, uncategorized, missing, byCategoryId };
    },
  };
}

/**
 * @typedef {object} AssetRecord
 * @property {number} id
 * @property {number} project_id
 * @property {number|null} category_id
 * @property {string} relative_path
 * @property {string} nested_path
 * @property {string} filename
 * @property {string} extension
 * @property {string} mime_type
 * @property {number} size_bytes
 * @property {string|null} modified_at
 * @property {number} is_present
 * @property {string|null} last_seen_at
 * @property {string|null} missing_since
 * @property {string} created_at
 * @property {string} updated_at
 */
