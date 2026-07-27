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

const SELECT_ALL = `SELECT ${COLUMNS.join(', ')} FROM releases`;

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
     * @returns {ReleaseRecord[]}
     */
    upcomingReleases() {
      const today = new Date().toISOString().split('T')[0];
      const sql = `
        ${SELECT_ALL}
        WHERE archived_at IS NULL
          AND status IN ('idea', 'planned', 'drafting', 'ready')
          AND planned_date IS NOT NULL
          AND planned_date > ?
        ORDER BY planned_date ASC
      `;
      return db.prepare(sql).all(today);
    },

    /**
     * @returns {ReleaseRecord[]}
     */
    overdueReleases() {
      const today = new Date().toISOString().split('T')[0];
      const sql = `
        ${SELECT_ALL}
        WHERE archived_at IS NULL
          AND status IN ('idea', 'planned', 'drafting', 'ready')
          AND planned_date IS NOT NULL
          AND planned_date < ?
        ORDER BY planned_date ASC
      `;
      return db.prepare(sql).all(today);
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
