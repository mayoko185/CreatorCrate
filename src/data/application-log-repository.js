const COLUMNS = [
  'id',
  'occurred_at_ms',
  'level',
  'kind',
  'subsystem',
  'event',
  'message',
  'project_id',
  'correlation_id',
  'context_json',
];
const SELECT_ALL = `SELECT ${COLUMNS.join(', ')} FROM application_logs`;

export const APPLICATION_LOG_DEFAULT_PAGE_SIZE = 50;
export const APPLICATION_LOG_MAX_PAGE_SIZE = 100;
export const APPLICATION_LOG_RETENTION_DAYS = 90;
export const APPLICATION_LOG_MAX_RECORDS = 50_000;
export const APPLICATION_LOG_MAX_CONTEXT_JSON_BYTES = 16_384;

export class ApplicationLogRepositoryError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'ApplicationLogRepositoryError';
    this.code = code;
  }
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function requireText(value, field, maximumBytes) {
  if (typeof value !== 'string' || value.trim().length === 0 || byteLength(value) > maximumBytes) {
    throw new ApplicationLogRepositoryError(`Application log ${field} is invalid or too large.`, {
      code: 'INVALID_INPUT',
    });
  }
  return value;
}

function optionalText(value, field, maximumBytes) {
  if (value === null || value === undefined) return null;
  return requireText(value, field, maximumBytes);
}

function requireSafePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApplicationLogRepositoryError(`Application log ${field} must be a non-negative safe integer.`, {
      code: 'INVALID_INPUT',
    });
  }
  return value;
}

function requireOptionalProjectId(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ApplicationLogRepositoryError('Application log projectId must be a positive safe integer or null.', {
      code: 'INVALID_INPUT',
    });
  }
  return value;
}

function serializeContext(value) {
  if (value === undefined) return '{}';
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new ApplicationLogRepositoryError('Application log context must be a JSON object.', {
      code: 'INVALID_CONTEXT',
    });
  }

  let contextJson;
  try {
    contextJson = JSON.stringify(value);
  } catch (err) {
    throw new ApplicationLogRepositoryError('Application log context must be JSON-serializable.', {
      code: 'INVALID_CONTEXT',
    });
  }

  if (typeof contextJson !== 'string' || byteLength(contextJson) > APPLICATION_LOG_MAX_CONTEXT_JSON_BYTES) {
    throw new ApplicationLogRepositoryError('Application log context is too large.', {
      code: 'INVALID_CONTEXT',
    });
  }

  try {
    const parsed = JSON.parse(contextJson);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('Context is not an object.');
    }
  } catch (err) {
    throw new ApplicationLogRepositoryError('Application log context must serialize to a JSON object.', {
      code: 'INVALID_CONTEXT',
    });
  }

  return contextJson;
}

function normalizePage(value) {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApplicationLogRepositoryError('Application log page must be a positive safe integer.', {
      code: 'INVALID_PAGINATION',
    });
  }
  return value;
}

function normalizePageSize(value) {
  if (value === undefined) return APPLICATION_LOG_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApplicationLogRepositoryError('Application log pageSize must be a positive safe integer.', {
      code: 'INVALID_PAGINATION',
    });
  }
  return Math.min(value, APPLICATION_LOG_MAX_PAGE_SIZE);
}

function buildFilterQuery(filters) {
  if (filters === null || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new ApplicationLogRepositoryError('Application log filters must be an object.', {
      code: 'INVALID_INPUT',
    });
  }

  const conditions = [];
  const params = [];
  for (const [field, maximumBytes] of [['level', 16], ['kind', 64], ['subsystem', 64]]) {
    if (filters[field] !== undefined) {
      conditions.push(`${field} = ?`);
      params.push(requireText(filters[field], field, maximumBytes));
    }
  }
  if (filters.sinceMs !== undefined) {
    conditions.push('occurred_at_ms >= ?');
    params.push(requireSafePositiveInteger(filters.sinceMs, 'sinceMs'));
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/**
 * Persistence boundary for application diagnostics. Event naming, level
 * selection, redaction, and pruning scheduling belong to the logger service.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function createApplicationLogRepository(db) {
  const insertStmt = db.prepare(`
    INSERT INTO application_logs (
      occurred_at_ms, level, kind, subsystem, event, message,
      project_id, correlation_id, context_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING ${COLUMNS.join(', ')}
  `);
  const clearStmt = db.prepare('DELETE FROM application_logs');
  const deleteOlderThanStmt = db.prepare('DELETE FROM application_logs WHERE occurred_at_ms < ?');
  const countStmt = db.prepare('SELECT COUNT(*) AS count FROM application_logs');
  const deleteOldestStmt = db.prepare(`
    DELETE FROM application_logs
    WHERE id IN (
      SELECT id
      FROM application_logs
      ORDER BY occurred_at_ms ASC, id ASC
      LIMIT ?
    )
  `);
  const clear = db.transaction(() => clearStmt.run().changes);
  const prune = db.transaction((cutoffMs) => {
    const ageDeleted = deleteOlderThanStmt.run(cutoffMs).changes;
    const excess = Math.max(0, countStmt.get().count - APPLICATION_LOG_MAX_RECORDS);
    const countDeleted = excess > 0 ? deleteOldestStmt.run(excess).changes : 0;
    return { ageDeleted, countDeleted, deletedCount: ageDeleted + countDeleted };
  });

  return {
    /**
     * @param {{occurredAtMs: number, level: string, kind: string, subsystem: string, event: string, message: string, projectId?: number|null, correlationId?: string|null, context?: object}} input
     */
    insert(input) {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw new ApplicationLogRepositoryError('Application log input must be an object.', {
          code: 'INVALID_INPUT',
        });
      }

      return insertStmt.get(
        requireSafePositiveInteger(input.occurredAtMs, 'occurredAtMs'),
        requireText(input.level, 'level', 16),
        requireText(input.kind, 'kind', 64),
        requireText(input.subsystem, 'subsystem', 64),
        requireText(input.event, 'event', 128),
        requireText(input.message, 'message', 4096),
        requireOptionalProjectId(input.projectId),
        optionalText(input.correlationId, 'correlationId', 128),
        serializeContext(input.context)
      );
    },

    /**
     * @param {{level?: string, kind?: string, subsystem?: string, page?: number, pageSize?: number}} [filters]
     * @returns {Array<{id: number, occurred_at_ms: number, level: string, kind: string, subsystem: string, event: string, message: string, project_id: number|null, correlation_id: string|null, context_json: string}>}
     */
    findPage(filters = {}) {
      const page = normalizePage(filters.page);
      const pageSize = normalizePageSize(filters.pageSize);
      const offset = (page - 1) * pageSize;
      if (!Number.isSafeInteger(offset)) {
        throw new ApplicationLogRepositoryError('Application log pagination offset is too large.', {
          code: 'INVALID_PAGINATION',
        });
      }

      const { where, params } = buildFilterQuery(filters);
      return db.prepare(`
        ${SELECT_ALL}
        ${where}
        ORDER BY occurred_at_ms DESC, id DESC
        LIMIT ? OFFSET ?
      `).all(...params, pageSize, offset);
    },

    /** @param {{level?: string, kind?: string, subsystem?: string}} [filters] */
    count(filters = {}) {
      const { where, params } = buildFilterQuery(filters);
      return db.prepare(`SELECT COUNT(*) AS count FROM application_logs ${where}`).get(...params).count;
    },

    /** @returns {{levels: string[], kinds: string[], subsystems: string[]}} */
    listFilterOptions() {
      const valuesFor = (column) => db.prepare(`
        SELECT DISTINCT ${column} AS value
        FROM application_logs
        WHERE ${column} IS NOT NULL AND ${column} <> ''
        ORDER BY ${column} ASC
        LIMIT ?
      `).pluck().all(100);
      return {
        levels: valuesFor('level'),
        kinds: valuesFor('kind'),
        subsystems: valuesFor('subsystem'),
      };
    },

    /** @returns {number} number of deleted records */
    clear() {
      return clear();
    },

    /**
     * Remove records older than 90 days, then retain the newest 50,000 rows.
     * @param {{nowMs?: number}} [options]
     * @returns {{ageDeleted: number, countDeleted: number, deletedCount: number}}
     */
    prune({ nowMs = Date.now() } = {}) {
      requireSafePositiveInteger(nowMs, 'nowMs');
      return prune(nowMs - APPLICATION_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    },
  };
}
