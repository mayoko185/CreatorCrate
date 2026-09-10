import {
  AssetPickerCursorError,
  decodeAssetPickerCursor,
  encodeAssetPickerCursor,
  normalizeAssetPickerLimit,
  normalizeAssetPickerQuery,
} from './asset-picker-pagination.js';

export const ARCHIVED_PROJECT_STATUS = 'archived';
export const DEFAULT_PROJECT_STATUS = 'tbd';
export const DEFAULT_PROJECT_TYPE = 'images';
const PROJECT_OPTION_VALUE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const DASHBOARD_SORTS = Object.freeze({
  updated: Object.freeze({ column: 'updated_at' }),
  created: Object.freeze({ column: 'created_at' }),
  title: Object.freeze({ column: 'title COLLATE NOCASE' }),
});

const COLUMNS = [
  'id',
  'title',
  'slug',
  'description',
  'notes',
  'status',
  'project_type',
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
 * @property {string} project_type
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
      title, slug, description, notes, status, project_type,
      patreon_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING ${COLUMNS.join(', ')}
  `);
  const update = db.prepare(`
    UPDATE projects
    SET title = ?, slug = ?, description = ?, notes = ?, status = ?,
        project_type = COALESCE(?, project_type),
        patreon_url = ?,
        updated_at = datetime('now')
    WHERE id = ? AND archived_at IS NULL AND status <> ?
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
    WHERE archived_at IS NULL AND status <> 'archived'
    GROUP BY status
  `);
  const countArchived = db.prepare(`
    SELECT COUNT(*) AS c
    FROM projects
    WHERE archived_at IS NOT NULL OR status = 'archived'
  `);
  const hasStatusValueStmt = db.prepare(`
    SELECT EXISTS(SELECT 1 FROM projects WHERE status = ?)
  `);
  const hasProjectTypeValueStmt = db.prepare(`
    SELECT EXISTS(SELECT 1 FROM projects WHERE project_type = ?)
  `);
  const countStatusValueStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM projects WHERE status = ?
  `);
  const countProjectTypeValueStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM projects WHERE project_type = ?
  `);
  const reassignStatusValueStmt = db.prepare(`
    UPDATE projects
    SET status = ?, updated_at = datetime('now')
    WHERE status = ?
  `);
  const reassignProjectTypeValueStmt = db.prepare(`
    UPDATE projects
    SET project_type = ?, updated_at = datetime('now')
    WHERE project_type = ?
  `);
  const listActiveAssetFilterOptionsStmt = db.prepare(`
    SELECT id, title
    FROM projects
    WHERE archived_at IS NULL AND status <> 'archived'
    ORDER BY title COLLATE NOCASE ASC, id ASC
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
      if (typeof input.status !== 'string' || input.status.length === 0) {
        throw new TypeError('Project creation requires an explicit status.');
      }
      if (typeof input.projectType !== 'string' || input.projectType.length === 0) {
        throw new TypeError('Project creation requires an explicit projectType.');
      }
      const values = [
        input.title,
        input.slug,
        input.description,
        input.notes,
        input.status,
        input.projectType,
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
        input.projectType ?? null,
        input.patreonUrl ?? null,
        id,
        ARCHIVED_PROJECT_STATUS,
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
      const counts = {};
      for (const row of rows) {
        counts[row.status] = row.c;
      }
      counts.archived = countArchived.pluck().get();
      return counts;
    },

    hasStatusValue(value) {
      return Boolean(hasStatusValueStmt.pluck().get(value));
    },

    hasProjectTypeValue(value) {
      return Boolean(hasProjectTypeValueStmt.pluck().get(value));
    },

    countStatusValue(value) {
      return countStatusValueStmt.pluck().get(value);
    },

    countProjectTypeValue(value) {
      return countProjectTypeValueStmt.pluck().get(value);
    },

    reassignStatusValue(source, replacement) {
      return reassignStatusValueStmt.run(replacement, source).changes;
    },

    reassignProjectTypeValue(source, replacement) {
      return reassignProjectTypeValueStmt.run(replacement, source).changes;
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
     * Find independently bounded project collections for requested Dashboard
     * statuses with one windowed SQL statement.
     *
     * Invalid or unsupported status limits are ignored. A valid limit is a
     * safe integer from 1 through 25, so malformed input can never create an
     * unbounded query.
     *
     * @param {Object.<string, {limit: number, sort?: string, order?: string}>} configurationByStatus
     * @returns {Array<ProjectRecord & {effective_status: string}>}
     */
    findDashboardProjectsByStatus(configurationByStatus) {
      const requested = normalizeDashboardStatusConfigurations(configurationByStatus);
      if (requested.length === 0) return [];

      const requestedStatusCte = requested.map(() => '(?, ?, ?, ?)').join(', ');
      const params = requested.flatMap(({ status, limit, sort, order }) => [status, limit, sort, order]);
      const projectColumns = COLUMNS.map((column) => `projects.${column}`).join(', ');

      const rows = db.prepare(`
        WITH requested_statuses(status, item_limit, sort_by, sort_order) AS (
          VALUES ${requestedStatusCte}
        ),
        effective_projects AS (
          SELECT ${projectColumns},
            CASE
              WHEN projects.archived_at IS NOT NULL OR projects.status = 'archived'
                THEN 'archived'
              ELSE projects.status
            END AS effective_status
          FROM projects
        ),
        ranked_projects AS (
          SELECT effective_projects.*, requested_statuses.item_limit,
            ROW_NUMBER() OVER (
              PARTITION BY effective_projects.effective_status
              ORDER BY
                CASE WHEN requested_statuses.sort_by = 'updated' AND requested_statuses.sort_order = 'asc' THEN effective_projects.updated_at END ASC,
                CASE WHEN requested_statuses.sort_by = 'updated' AND requested_statuses.sort_order = 'desc' THEN effective_projects.updated_at END DESC,
                CASE WHEN requested_statuses.sort_by = 'created' AND requested_statuses.sort_order = 'asc' THEN effective_projects.created_at END ASC,
                CASE WHEN requested_statuses.sort_by = 'created' AND requested_statuses.sort_order = 'desc' THEN effective_projects.created_at END DESC,
                CASE WHEN requested_statuses.sort_by = 'title' AND requested_statuses.sort_order = 'asc' THEN effective_projects.title END COLLATE NOCASE ASC,
                CASE WHEN requested_statuses.sort_by = 'title' AND requested_statuses.sort_order = 'desc' THEN effective_projects.title END COLLATE NOCASE DESC,
                CASE WHEN requested_statuses.sort_order = 'asc' THEN effective_projects.id END ASC,
                CASE WHEN requested_statuses.sort_order = 'desc' THEN effective_projects.id END DESC
            ) AS status_rank
          FROM effective_projects
          INNER JOIN requested_statuses
            ON requested_statuses.status = effective_projects.effective_status
        )
        SELECT ${COLUMNS.join(', ')}, effective_status
        FROM ranked_projects
        WHERE status_rank <= item_limit
        ORDER BY effective_status ASC, status_rank ASC
      `).all(...params);

      return rows;
    },

    /**
     * @param {Object} [options]
     * @param {string|string[]} [options.status]
     * @param {string[]} [options.statuses]
     * @param {string|string[]} [options.projectType]
     * @param {string[]} [options.projectTypes]
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
        projectType,
        projectTypes,
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
      const selectedProjectTypes = normalizeProjectTypeSelection(projectTypes === undefined ? projectType : projectTypes);
      const selectedTagIds = normalizeTagSelection(tagIds === undefined ? tagId : tagIds);

      const conditions = [];
      const params = [];

      if (projectId != null) {
        conditions.push('projects.id = ?');
        params.push(projectId);
      }

      if (!includeArchived) {
        conditions.push("archived_at IS NULL AND status <> 'archived'");
      }

      if (selectedStatuses.length > 0) {
        const statusConditions = [];
        const activeStatuses = selectedStatuses.filter((value) => value !== 'archived');

        if (selectedStatuses.includes('archived')) {
          statusConditions.push("(archived_at IS NOT NULL OR status = 'archived')");
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

      if (selectedProjectTypes.length > 0) {
        const placeholders = selectedProjectTypes.map(() => '?').join(',');
        conditions.push(`project_type IN (${placeholders})`);
        params.push(...selectedProjectTypes);
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
  return normalizeProjectOptionSelection(value);
}

function normalizeProjectTypeSelection(value) {
  return normalizeProjectOptionSelection(value);
}

function normalizeProjectOptionSelection(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.filter((candidate) => (
    typeof candidate === 'string'
      && candidate !== 'all'
      && PROJECT_OPTION_VALUE_PATTERN.test(candidate)
  )))];
}

function normalizeDashboardStatusConfigurations(configurationByStatus) {
  if (!configurationByStatus || typeof configurationByStatus !== 'object' || Array.isArray(configurationByStatus)) {
    return [];
  }

  return Object.entries(configurationByStatus).flatMap(([status, configuration]) => {
    if (!PROJECT_OPTION_VALUE_PATTERN.test(status)) return [];
    const limit = typeof configuration === 'number' ? configuration : configuration?.limit;
    return Number.isSafeInteger(limit) && limit >= 1 && limit <= 25
      ? [{
        status,
        limit,
        sort: DASHBOARD_SORTS[configuration?.sort] ? configuration.sort : 'updated',
        order: configuration?.order === 'asc' ? 'asc' : 'desc',
      }]
      : [];
  });
}

function normalizeTagSelection(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.filter((tagId) => Number.isSafeInteger(tagId) && tagId > 0))]
    .sort((left, right) => left - right);
}

const ALLOWED_SORTS = Object.freeze({
  updated: DASHBOARD_SORTS.updated,
  created: DASHBOARD_SORTS.created,
  title: DASHBOARD_SORTS.title,
});

function buildOrderClause(sortBy, order) {
  const sort = ALLOWED_SORTS[sortBy] || ALLOWED_SORTS.updated;
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${sort.column} ${direction}`;
}
