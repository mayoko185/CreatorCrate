/**
 * Project primary-image repository — SQL operations for retained project
 * selections. Eligibility, presence, project mutability, and filesystem
 * policy belong to the service layer, not this repository.
 */

const REFERENCE_COLUMNS = ['project_id', 'asset_id'];
const SELECT_REFERENCES = `SELECT ${REFERENCE_COLUMNS.join(', ')} FROM project_primary_images`;

/**
 * Create a project primary-image repository bound to an existing database
 * handle. Methods intentionally do not create transactions so callers can
 * compose them inside a larger transaction.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function createProjectPrimaryImageRepository(db) {
  const findByProjectStmt = db.prepare(`${SELECT_REFERENCES} WHERE project_id = ?`);
  const upsertStmt = db.prepare(`
    INSERT INTO project_primary_images (project_id, asset_id)
    VALUES (?, ?)
    ON CONFLICT(project_id) DO UPDATE SET asset_id = excluded.asset_id
    RETURNING ${REFERENCE_COLUMNS.join(', ')}
  `);
  const clearIfMatchesStmt = db.prepare(`
    DELETE FROM project_primary_images
    WHERE project_id = ? AND asset_id = ?
  `);

  return {
    /**
     * Find a project's retained primary-image reference.
     * @param {number} projectId
     * @returns {{project_id: number, asset_id: number}|undefined}
     */
    findByProjectId(projectId) {
      return findByProjectStmt.get(projectId);
    },

    /**
     * Find retained references for several projects in one query.
     * @param {number[]} projectIds
     * @returns {Array<{project_id: number, asset_id: number}>}
     */
    findByProjectIds(projectIds) {
      if (!Array.isArray(projectIds) || projectIds.length === 0) return [];

      const uniqueProjectIds = [...new Set(projectIds)];
      const placeholders = uniqueProjectIds.map(() => '?').join(', ');
      return db.prepare(`${SELECT_REFERENCES}
        WHERE project_id IN (${placeholders})
        ORDER BY project_id ASC`).all(...uniqueProjectIds);
    },

    /**
     * Set or replace the one selected reference for a project.
     * @param {number} projectId
     * @param {number} assetId
     * @returns {{project_id: number, asset_id: number}}
     */
    setPrimaryImage(projectId, assetId) {
      return upsertStmt.get(projectId, assetId);
    },

    /**
     * Remove a selection only when it still points at the expected asset.
     * @param {number} projectId
     * @param {number} expectedAssetId
     * @returns {boolean} whether a matching row was removed
     */
    clearPrimaryImageIfMatches(projectId, expectedAssetId) {
      return clearIfMatchesStmt.run(projectId, expectedAssetId).changes === 1;
    },
  };
}
