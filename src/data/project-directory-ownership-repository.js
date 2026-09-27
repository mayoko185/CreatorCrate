import { isValidProjectOwnershipToken } from '../storage/project-ownership-marker.js';

/**
 * Project-directory ownership repository — the SQLite half of the project
 * ownership witness. A row binds a project to the opaque token its
 * `.creatorcrate-owner` marker must carry.
 *
 * States support a restart-safe protocol owned by later callers:
 *
 *     persist pending token → create/verify marker → mark bound
 *
 * No row means unbound. Every transition is conditional on the exact
 * (project, token) identity, so a stale operation can never bind or remove
 * another operation's row. No filesystem work happens here.
 */

export const PROJECT_OWNERSHIP_STATES = Object.freeze(['pending', 'bound']);

export class InvalidProjectOwnershipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidProjectOwnershipError';
  }
}

export class ProjectOwnershipTokenConflictError extends Error {
  constructor() {
    super('Ownership token is already bound to another project.');
    this.name = 'ProjectOwnershipTokenConflictError';
  }
}

function requireProjectId(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidProjectOwnershipError('projectId must be a positive integer.');
  }
  return value;
}

function requireToken(value) {
  if (!isValidProjectOwnershipToken(value)) {
    throw new InvalidProjectOwnershipError('Ownership token is invalid.');
  }
  return value;
}

function mapRow(row) {
  if (!row) return null;
  return { projectId: row.project_id, token: row.token, state: row.state };
}

const SELECT = 'SELECT project_id, token, state FROM project_directory_ownership';

/**
 * @param {import('better-sqlite3').Database} db
 */
export function createProjectDirectoryOwnershipRepository(db) {
  const findStmt = db.prepare(`${SELECT} WHERE project_id = ?`);
  const findByTokenStmt = db.prepare(`${SELECT} WHERE token = ?`);
  const listPendingStmt = db.prepare(`${SELECT} WHERE state = 'pending' ORDER BY project_id ASC`);
  // Targets only the project key: an existing binding is left untouched and
  // reported as null, while a token collision still raises UNIQUE.
  const insertPendingStmt = db.prepare(`
    INSERT INTO project_directory_ownership (project_id, token, state)
    VALUES (?, ?, 'pending')
    ON CONFLICT(project_id) DO NOTHING
    RETURNING project_id, token, state
  `);
  const markBoundStmt = db.prepare(`
    UPDATE project_directory_ownership SET state = 'bound'
    WHERE project_id = ? AND token = ? AND state = 'pending'
  `);
  const deletePendingStmt = db.prepare(`
    DELETE FROM project_directory_ownership
    WHERE project_id = ? AND token = ? AND state = 'pending'
  `);

  return {
    /** @returns {{ projectId: number, token: string, state: 'pending'|'bound' }|null} */
    findByProjectId(projectId) {
      return mapRow(findStmt.get(requireProjectId(projectId)));
    },

    /**
     * The row (pending or bound, any project) holding `token`, so explicit
     * recovery can refuse a marker whose token another project owns.
     * @returns {{ projectId: number, token: string, state: 'pending'|'bound' }|null}
     */
    findByToken(token) {
      return mapRow(findByTokenStmt.get(requireToken(token)));
    },

    /**
     * Unresolved pending bindings, for restart recovery.
     * @returns {Array<{ projectId: number, token: string, state: 'pending' }>}
     */
    listPending() {
      return listPendingStmt.all().map(mapRow);
    },

    /**
     * Persist `token` as the project's pending binding. Returns null, leaving
     * the existing row untouched, when the project already has a binding
     * (pending or bound). The project must exist (foreign key).
     * @returns {{ projectId: number, token: string, state: 'pending' }|null}
     * @throws {InvalidProjectOwnershipError}
     * @throws {ProjectOwnershipTokenConflictError} when the token is in use
     */
    createPending(projectId, token) {
      requireProjectId(projectId);
      requireToken(token);
      try {
        return mapRow(insertPendingStmt.get(projectId, token));
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ProjectOwnershipTokenConflictError();
        throw err;
      }
    },

    /**
     * Transition pending(token) → bound(token) for exactly this project and
     * token. A bound row, another token, or another project is unaffected.
     * @returns {boolean} whether the row was bound by this call
     */
    markBound(projectId, token) {
      return markBoundStmt.run(requireProjectId(projectId), requireToken(token)).changes === 1;
    },

    /**
     * Remove an operation-owned pending row by exact project/token identity.
     * Never removes a bound row, another token, or another project's row.
     * @returns {boolean} whether the pending row was removed
     */
    deletePending(projectId, token) {
      return deletePendingStmt.run(requireProjectId(projectId), requireToken(token)).changes === 1;
    },
  };
}
