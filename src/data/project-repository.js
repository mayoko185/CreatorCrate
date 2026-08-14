import {
  AssetPickerCursorError,
  decodeAssetPickerCursor,
  encodeAssetPickerCursor,
  normalizeAssetPickerLimit,
  normalizeAssetPickerQuery,
} from './asset-picker-pagination.js';

export const STATUSES = ['tbd', 'planned', 'in-progress', 'ready', 'completed', 'archived'];
export const WORKFLOW_STATUSES = ['tbd', 'planned', 'in-progress', 'ready', 'completed'];

const COLUMNS = [
  'id',
  'title',
  'slug',
  'description',
  'notes',
  'status',
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
      title, slug, description, notes, status,
      planned_date, published_date, patreon_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING ${COLUMNS.join(', ')}
  `);
  const update = db.prepare(`
    UPDATE projects
    SET title = ?, slug = ?, description = ?, notes = ?, status = ?,
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
  const setProjectDirStmt = db.prepare(`
    UPDATE projects
    SET project_dir = ?, updated_at = datetime('now')
    WHERE id = ?
    RETURNING ${COLUMNS.join(', ')}
  `);
  const deleteByIdStmt = db.prepare('DELETE FROM projects WHERE id = ?');
  const countByStatus = db.prepare(`
    SELECT status, COUNT(*) AS c
    FROM projects
    WHERE archived_at IS NULL
    GROUP BY status
  `);
  const countArchived = db.prepare(`
    SELECT COUNT(*) AS c FROM projects WHERE archived_at IS NOT NULL
  `);
  const listActiveAssetFilterOptionsStmt = db.prepare(`
    SELECT id, title
    FROM projects
    WHERE archived_at IS NULL AND status <> 'archived'
    ORDER BY title COLLATE NOCASE ASC, id ASC
  `);
  const findCalendarRangeStmt = db.prepare(`
    SELECT * FROM (
      SELECT ${COLUMNS.join(', ')},
        planned_date AS effective_date
      FROM projects
      WHERE archived_at IS NULL AND status <> 'archived'
    )
    WHERE effective_date IS NOT NULL AND effective_date >= ? AND effective_date < ?
    ORDER BY effective_date ASC, id ASC
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
     * Permanently delete a project record by ID.
     * Used by project creation rollback and the project-service permanent
     * deletion workflow. This is NOT the public archive workflow — it is a
     * hard delete whose child-row behavior remains controlled by the schema.
     * @param {number} id
     * @returns {boolean} true if a row was deleted
     */
    deleteById(id) {
      const result = deleteByIdStmt.run(id);
      return result.changes > 0;
    },

    /**
     * Set the project_dir for a project and return the updated record.
     * Project directories are direct children of PROJECTS_ROOT.
     * @param {number} id
     * @param {string|null} projectDir Project directory name (e.g. "000042-my-project").
     * @returns {ProjectRecord|undefined}
     */
    setProjectDir(id, projectDir) {
      return setProjectDirStmt.get(projectDir, id);
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
     * Return the complete active-project option source for the cross-project
     * asset filter. This is deliberately unpaged and returns only the fields
     * needed by the filter control.
     * @returns {Array<{ id: number, title: string }>}
     */
    listActiveAssetFilterOptions() {
      return listActiveAssetFilterOptionsStmt.all();
    },

    /**
     * Bounded project-title lookup for asset selection. Archived projects are
     * intentionally included because their assets remain eligible for Notes.
     *
     * @param {{ query?: string, limit?: number, cursor?: string }} [options]
     * @returns {{ rows: Array<{id: number, title: string, is_archived: number}>, nextCursor: string|null }}
     */
    searchAssetPickerProjects(options = {}) {
      const query = normalizeAssetPickerQuery(options.query);
      const limit = normalizeAssetPickerLimit(options.limit);
      const cursor = decodeAssetPickerCursor(options.cursor, 'asset-picker-projects');
      const conditions = [];
      const params = [];

      if (query) {
        conditions.push("title COLLATE NOCASE LIKE ? ESCAPE '\\'");
        params.push(`%${escapeLike(query)}%`);
      }

      if (cursor) {
        if (
          cursor.query !== query ||
          typeof cursor.title !== 'string' ||
          !Number.isSafeInteger(cursor.id) ||
          cursor.id <= 0
        ) {
          throw new AssetPickerCursorError();
        }
        conditions.push('(title COLLATE NOCASE > ? OR (title COLLATE NOCASE = ? AND id > ?))');
        params.push(cursor.title, cursor.title, cursor.id);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = db.prepare(`
        SELECT
          id,
          title,
          CASE WHEN archived_at IS NOT NULL OR status = 'archived' THEN 1 ELSE 0 END AS is_archived
        FROM projects
        ${where}
        ORDER BY title COLLATE NOCASE ASC, id ASC
        LIMIT ?
      `).all(...params, limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);

      return {
        rows: page,
        nextCursor: hasMore
          ? encodeAssetPickerCursor({
            scope: 'asset-picker-projects', query, title: last.title, id: last.id,
          })
          : null,
      };
    },

    /**
     * Non-archived projects whose effective calendar date falls within a
     * bounded range (inclusive start, exclusive end). A project is excluded
     * if either archived_at is set or status is 'archived' — the two can
     * disagree transiently, and both must be checked. The effective date is
     * planned_date for every valid workflow status. Projects with no planned
     * date are excluded. Each project appears at most once.
     * @param {string} startDate - ISO date YYYY-MM-DD (inclusive)
     * @param {string} endDate - ISO date YYYY-MM-DD (exclusive)
     * @returns {Array<ProjectRecord & {effective_date: string}>}
     */
    findCalendarRange(startDate, endDate) {
      return findCalendarRangeStmt.all(startDate, endDate);
    },

    /**
     * @param {Object} [options]
     * @param {string|string[]} [options.status]
     * @param {string[]} [options.statuses]
     * @param {string} [options.search]
     * @param {number} [options.tagId]
     * @param {number[]} [options.tagIds]
     * @param {number} [options.projectId]
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
        statuses,
        search,
        tagId,
        tagIds,
        projectId,
        includeArchived = false,
        sortBy = 'updated',
        order = 'desc',
        limit = 25,
        offset = 0,
      } = options;

      const selectedStatuses = normalizeStatusSelection(statuses === undefined ? status : statuses);
      const selectedTagIds = normalizeTagSelection(tagIds === undefined ? tagId : tagIds);

      const conditions = [];
      const params = [];

      if (projectId != null) {
        conditions.push('projects.id = ?');
        params.push(projectId);
      }

      if (!includeArchived) {
        conditions.push('archived_at IS NULL');
      }

      if (selectedStatuses.length > 0) {
        const statusConditions = [];
        const activeStatuses = selectedStatuses.filter((value) => value !== 'archived');

        if (selectedStatuses.includes('archived')) {
          statusConditions.push('archived_at IS NOT NULL');
        }
        if (activeStatuses.length > 0) {
          const placeholders = activeStatuses.map(() => '?').join(',');
          statusConditions.push(`status IN (${placeholders})`);
          params.push(...activeStatuses);
        }

        conditions.push(statusConditions.length === 1
          ? statusConditions[0]
          : `(${statusConditions.join(' OR ')})`);
      }

      if (search && search.trim()) {
        const term = `%${escapeLike(search.trim())}%`;
        conditions.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')");
        params.push(term, term, term);
      }

      if (selectedTagIds.length > 0) {
        const placeholders = selectedTagIds.map(() => '?').join(',');
        conditions.push(
          `EXISTS (SELECT 1 FROM project_tags WHERE project_tags.project_id = projects.id `
          + `AND project_tags.tag_id IN (${placeholders}))`
        );
        params.push(...selectedTagIds);
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

function normalizeStatusSelection(value) {
  const values = new Set(Array.isArray(value) ? value : [value]);
  return STATUSES.filter((status) => values.has(status));
}

function normalizeTagSelection(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.filter((tagId) => Number.isSafeInteger(tagId) && tagId > 0))]
    .sort((left, right) => left - right);
}

const ALLOWED_SORTS = {
  updated: { column: 'updated_at' },
  created: { column: 'created_at' },
  title: { column: 'title COLLATE NOCASE' },
  published: { column: 'published_date', nullsLast: true },
};

function buildOrderClause(sortBy, order) {
  const sort = ALLOWED_SORTS[sortBy] || ALLOWED_SORTS.updated;
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  if (sort.nullsLast) {
    return `ORDER BY (${sort.column} IS NULL) ASC, ${sort.column} ${direction}`;
  }
  return `ORDER BY ${sort.column} ${direction}`;
}
