/**
 * Asset repository — SQL operations for the assets table.
 *
 * All paths stored are relative to the project directory.
 * No absolute host/container paths are ever stored.
 */

const ASSET_COLUMNS = [
  'id',
  'project_id',
  'relative_path',
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
    INSERT INTO assets (project_id, relative_path, filename, extension, mime_type, size_bytes, modified_at, is_present, last_seen_at, missing_since)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), NULL)
    ON CONFLICT(project_id, relative_path) DO UPDATE SET
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
     * @returns {import('./asset-repository.js').AssetRecord}
     */
    upsert(projectId, relativePath, data) {
      return upsertStmt.get(
        projectId,
        relativePath,
        data.filename,
        data.extension,
        data.mimeType,
        data.sizeBytes,
        data.modifiedAt || null,
      );
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

    /**
     * Get distinct extensions used by a project's assets.
     * @param {number} projectId
     * @returns {string[]}
     */
    getExtensions(projectId) {
      const sql = `
        SELECT DISTINCT extension
        FROM assets
        WHERE project_id = ?
        ORDER BY extension
      `;
      return db.prepare(sql).pluck().all(projectId);
    },

    // ─── Phase 6D: Asset Browser Queries ──────────────────────────────────

    /**
     * Build WHERE conditions and params for asset browser queries.
     * Shared by both findProjectAssetPage and countProjectAssets so they
     * always use identical filter predicates.
     *
     * @param {number} projectId
     * @param {object} filters
     * @param {'all'|'present'|'missing'} [filters.presence]
     * @param {'all'|'used'|'unused'} [filters.usage]
     * @returns {{ conditions: string[], params: any[] }}
     */
    _buildAssetBrowserConditions(projectId, filters) {
      const conditions = ['project_id = ?'];
      const params = [projectId];

      if (filters.presence === 'present') {
        conditions.push('is_present = 1');
      } else if (filters.presence === 'missing') {
        conditions.push('is_present = 0');
      }
      // 'all' = no presence restriction

      if (filters.usage === 'used') {
        conditions.push('EXISTS (SELECT 1 FROM release_assets ra JOIN releases r ON r.id = ra.release_id WHERE ra.asset_id = a.id AND r.project_id = a.project_id)');
      } else if (filters.usage === 'unused') {
        conditions.push('NOT EXISTS (SELECT 1 FROM release_assets ra JOIN releases r ON r.id = ra.release_id WHERE ra.asset_id = a.id AND r.project_id = a.project_id)');
      }
      // 'all' = no usage restriction

      return { conditions, params };
    },

    /**
     * Paginated asset list for the asset browser.
     * Each asset includes a distinct count of releases that reference it.
     * Uses SQL LIMIT/OFFSET for efficient pagination.
     *
     * @param {number} projectId
     * @param {object} [filters]
     * @param {'all'|'present'|'missing'} [filters.presence='all']
     * @param {'all'|'used'|'unused'} [filters.usage='all']
     * @param {number} [filters.page=1]
     * @param {number} [filters.pageSize=25]
     * @returns {Array<{id: number, project_id: number, relative_path: string, filename: string, extension: string, is_present: number, last_seen_at: string|null, missing_since: string|null, release_usage_count: number}>}
     */
    findProjectAssetPage(projectId, filters = {}) {
      const { presence = 'all', usage = 'all', page = 1, pageSize = 25 } = filters;

      const { conditions, params } = this._buildAssetBrowserConditions(projectId, {
        presence,
        usage,
      });

      const offset = (Math.max(1, page) - 1) * Math.max(1, pageSize);

      // Deterministic ordering: filename (case-insensitive), extension, id.
      // Asset ID as final tie-breaker ensures stable order even when
      // filenames and extensions are identical across different files.
      const sql = `
        SELECT
          a.id,
          a.project_id,
          a.relative_path,
          a.filename,
          a.extension,
          a.is_present,
          a.last_seen_at,
          a.missing_since,
          (SELECT COUNT(DISTINCT ra.release_id) FROM release_assets ra JOIN releases r ON r.id = ra.release_id WHERE ra.asset_id = a.id AND r.project_id = a.project_id) AS release_usage_count
        FROM assets a
        WHERE ${conditions.join(' AND ')}
        ORDER BY a.filename COLLATE NOCASE ASC, a.extension ASC, a.id ASC
        LIMIT ? OFFSET ?
      `;

      return db.prepare(sql).all(...params, pageSize, offset);
    },

    /**
     * Count of matching assets for the asset browser.
     * Uses identical filter predicates as findProjectAssetPage.
     *
     * @param {number} projectId
     * @param {object} [filters]
     * @param {'all'|'present'|'missing'} [filters.presence='all']
     * @param {'all'|'used'|'unused'} [filters.usage='all']
     * @returns {number}
     */
    countProjectAssets(projectId, filters = {}) {
      const { presence = 'all', usage = 'all' } = filters;

      const { conditions, params } = this._buildAssetBrowserConditions(projectId, {
        presence,
        usage,
      });

      const sql = `SELECT COUNT(*) AS c FROM assets a WHERE ${conditions.join(' AND ')}`;
      const row = db.prepare(sql).get(...params);
      return row.c;
    },
  };
}

/**
 * @typedef {object} AssetRecord
 * @property {number} id
 * @property {number} project_id
 * @property {string} relative_path
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
