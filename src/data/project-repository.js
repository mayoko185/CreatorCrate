export const STATUSES = ['tbd', 'planned', 'in-progress', 'ready', 'published', 'archived'];
export const WORKFLOW_STATUSES = ['tbd', 'planned', 'in-progress', 'ready', 'published'];
export const PRIORITIES = ['low', 'normal', 'high'];

const COLUMNS = [
  'id',
  'title',
  'slug',
  'description',
  'notes',
  'status',
  'priority',
  'planned_date',
  'published_date',
  'patreon_url',
  'created_at',
  'updated_at',
  'archived_at',
  'project_dir',
];

const SELECT_ALL = `SELECT ${COLUMNS.join(', ')} FROM projects`;

/**
 * @typedef {Object} ProjectRecord
 * @property {number} id
 * @property {string} title
 * @property {string} slug
 * @property {string} description
 * @property {string} notes
 * @property {string} status
 * @property {string} priority
 * @property {string|null} planned_date
 * @property {string|null} published_date
 * @property {string|null} patreon_url
 * @property {string} created_at
 * @property {string} updated_at
 * @property {string|null} archived_at
 * @property {string|null} project_dir
 */

export function createProjectRepository(db) {
  const findById = db.prepare(`${SELECT_ALL} WHERE id = ?`);
  const findBySlug = db.prepare(`${SELECT_ALL} WHERE slug = ?`);
  const countBySlug = db.prepare('SELECT COUNT(*) AS c FROM projects WHERE slug = ?');
  const insert = db.prepare(`
    INSERT INTO projects (
      title, slug, description, notes, status, priority,
      planned_date, published_date, patreon_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING ${COLUMNS.join(', ')}
  `);
  const update = db.prepare(`
    UPDATE projects
    SET title = ?, slug = ?, description = ?, notes = ?, status = ?, priority = ?,
        planned_date = ?, published_date = ?, patreon_url = ?,
        updated_at = datetime('now')
    WHERE id = ? AND archived_at IS NULL
    RETURNING ${COLUMNS.join(', ')}
  `);
  const archive = db.prepare(`
    UPDATE projects
    SET status = 'archived', archived_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND archived_at IS NULL
    RETURNING ${COLUMNS.join(', ')}
  `);
  const restoreFromArchive = db.prepare(`
    UPDATE projects
    SET status = ?, archived_at = NULL, project_dir = ?, updated_at = datetime('now')
    WHERE id = ?
    RETURNING ${COLUMNS.join(', ')}
  `);
  const setProjectDirStmt = db.prepare(`
    UPDATE projects
    SET project_dir = ?, updated_at = datetime('now')
    WHERE id = ?
    RETURNING ${COLUMNS.join(', ')}
  `);
  const deleteByIdStmt = db.prepare('DELETE FROM projects WHERE id = ?');
  const findByNullProjectDir = db.prepare(`${SELECT_ALL} WHERE project_dir IS NULL`);
  const countByStatus = db.prepare(`
    SELECT status, COUNT(*) AS c
    FROM projects
    WHERE archived_at IS NULL
    GROUP BY status
  `);
  const countArchived = db.prepare(`
    SELECT COUNT(*) AS c FROM projects WHERE archived_at IS NOT NULL
  `);

  return {
    /**
     * @param {number} id
     * @returns {ProjectRecord|undefined}
     */
    findById(id) {
      return findById.get(id);
    },

    /**
     * @param {string} slug
     * @returns {ProjectRecord|undefined}
     */
    findBySlug(slug) {
      return findBySlug.get(slug);
    },

    /**
     * @param {string} slug
     * @param {object} [options]
     * @param {number} [options.excludeId]
     * @returns {boolean}
     */
    slugExists(slug, { excludeId } = {}) {
      const params = [slug];
      let sql = 'SELECT COUNT(*) AS c FROM projects WHERE slug = ?';
      if (excludeId !== undefined) {
        sql += ' AND id != ?';
        params.push(excludeId);
      }
      const stmt = db.prepare(sql);
      const row = stmt.get(...params);
      return row.c > 0;
    },

    /**
     * @param {Object} input
     * @returns {ProjectRecord}
     */
    create(input) {
      const values = [
        input.title,
        input.slug,
        input.description,
        input.notes,
        input.status,
        input.priority,
        input.plannedDate ?? null,
        input.publishedDate ?? null,
        input.patreonUrl ?? null,
      ];
      return insert.get(...values);
    },

    /**
     * @param {number} id
     * @param {Object} input
     * @returns {ProjectRecord|undefined}
     */
    update(id, input) {
      const values = [
        input.title,
        input.slug,
        input.description,
        input.notes,
        input.status,
        input.priority,
        input.plannedDate ?? null,
        input.publishedDate ?? null,
        input.patreonUrl ?? null,
        id,
      ];
      return update.get(...values);
    },

    /**
     * @param {number} id
     * @returns {ProjectRecord|undefined}
     */
    archive(id) {
      return archive.get(id);
    },

    /**
     * Restore a project from archived state.
     * Used during archive compensation to undo the DB changes.
     * Does NOT filter on archived_at — designed for rollback.
     * @param {number} id
     * @param {string} status - Original status to restore
     * @param {string|null} projectDir - Original project_dir to restore
     * @returns {ProjectRecord|undefined}
     */
    restoreFromArchive(id, status, projectDir) {
      return restoreFromArchive.get(status, projectDir, id);
    },

    /**
     * Permanently delete a project record by ID.
     * Used as rollback when filesystem creation fails after the DB record exists.
     * This is NOT the public archive workflow — it's a hard delete.
     * @param {number} id
     * @returns {boolean} true if a row was deleted
     */
    deleteById(id) {
      const result = deleteByIdStmt.run(id);
      return result.changes > 0;
    },

    /**
     * Set the project_dir for a project and return the updated record.
     * @param {number} id
     * @param {string|null} projectDir Relative path (e.g. "active/my-project").
     * @returns {ProjectRecord|undefined}
     */
    setProjectDir(id, projectDir) {
      return setProjectDirStmt.get(projectDir, id);
    },

    /**
     * Find all projects that have no project_dir set.
     * @returns {ProjectRecord[]}
     */
    findByProjectDirNull() {
      return findByNullProjectDir.all();
    },

    /**
     * @returns {Object.<string, number>}
     */
    countByStatus() {
      const rows = countByStatus.all();
      const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
      for (const row of rows) {
        counts[row.status] = row.c;
      }
      counts.archived = countArchived.pluck().get();
      return counts;
    },

    /**
     * @param {Object} [options]
     * @param {string} [options.status]
     * @param {string} [options.search]
     * @param {boolean} [options.includeArchived]
     * @param {string} [options.sortBy]
     * @param {string} [options.order]
     * @param {number} [options.limit]
     * @param {number} [options.offset]
     * @returns {{ rows: ProjectRecord[], total: number }}
     */
    list(options = {}) {
      const {
        status,
        search,
        includeArchived = false,
        sortBy = 'updated',
        order = 'desc',
        limit = 25,
        offset = 0,
      } = options;

      const conditions = [];
      const params = [];

      if (!includeArchived) {
        conditions.push('archived_at IS NULL');
      }

      if (status && STATUSES.includes(status)) {
        if (status === 'archived') {
          conditions.push('archived_at IS NOT NULL');
        } else {
          conditions.push('status = ?');
          params.push(status);
        }
      }

      if (search && search.trim()) {
        const term = `%${escapeLike(search.trim())}%`;
        conditions.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')");
        params.push(term, term, term);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const orderClause = buildOrderClause(sortBy, order);

      const countSql = `SELECT COUNT(*) AS c FROM projects ${where}`;
      const countStmt = db.prepare(countSql);
      const total = countStmt.get(...params).c;

      const listSql = `${SELECT_ALL} ${where} ${orderClause} LIMIT ? OFFSET ?`;
      const listStmt = db.prepare(listSql);
      const rows = listStmt.all(...params, limit, offset);

      return { rows, total };
    },
  };
}

function escapeLike(value) {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

const ALLOWED_SORTS = {
  updated: { column: 'updated_at' },
  created: { column: 'created_at' },
  title: { column: 'title COLLATE NOCASE' },
};

function buildOrderClause(sortBy, order) {
  const sort = ALLOWED_SORTS[sortBy] || ALLOWED_SORTS.updated;
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${sort.column} ${direction}`;
}
