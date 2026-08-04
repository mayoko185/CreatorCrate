const COLUMNS = [
  'id',
  'display_name',
  'normalized_name',
  'created_at',
  'updated_at',
];

const SELECT_ALL = `SELECT ${COLUMNS.join(', ')} FROM tags`;
const PROJECT_TAG_COLUMNS = COLUMNS.map((column) => `t.${column}`).join(', ');
const SELECT_PROJECT_TAGS = `
  SELECT ${PROJECT_TAG_COLUMNS}
  FROM tags t
  JOIN project_tags pt ON pt.tag_id = t.id
`;
const PROJECT_TAG_ORDER = 'ORDER BY t.display_name COLLATE NOCASE ASC, t.normalized_name ASC, t.id ASC';
const SELECT_PROJECT_TAGS_FOR_IDS = `
  SELECT pt.project_id, ${PROJECT_TAG_COLUMNS}
  FROM tags t
  JOIN project_tags pt ON pt.tag_id = t.id
`;
const PROJECT_TAG_BATCH_ORDER = 'ORDER BY pt.project_id ASC, t.display_name COLLATE NOCASE ASC, t.normalized_name ASC, t.id ASC';
const SELECT_ASSET_TAGS = `
  SELECT ${PROJECT_TAG_COLUMNS}
  FROM tags t
  JOIN asset_tags at ON at.tag_id = t.id
`;
const ASSET_TAG_ORDER = PROJECT_TAG_ORDER;
const SELECT_ASSET_TAGS_FOR_IDS = `
  SELECT at.asset_id, ${PROJECT_TAG_COLUMNS}
  FROM tags t
  JOIN asset_tags at ON at.tag_id = t.id
`;
const ASSET_TAG_BATCH_ORDER = 'ORDER BY at.asset_id ASC, t.display_name COLLATE NOCASE ASC, t.normalized_name ASC, t.id ASC';

/**
 * @typedef {Object} TagRecord
 * @property {number} id
 * @property {string} display_name
 * @property {string} normalized_name
 * @property {string} created_at
 * @property {string} updated_at
 */

/**
 * Create a repository for the global tag catalog.
 *
 * The caller supplies the display and normalized values. This repository does
 * not normalize, trim, validate, or otherwise alter either value.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function createTagRepository(db) {
  const findByIdStmt = db.prepare(`${SELECT_ALL} WHERE id = ?`);
  const findByNormalizedNameStmt = db.prepare(`${SELECT_ALL} WHERE normalized_name = ?`);
  const listStmt = db.prepare(`
    ${SELECT_ALL}
    ORDER BY display_name COLLATE NOCASE ASC, normalized_name ASC, id ASC
  `);
  const insertStmt = db.prepare(`
    INSERT INTO tags (display_name, normalized_name)
    VALUES (?, ?)
    RETURNING ${COLUMNS.join(', ')}
  `);
  const updateStmt = db.prepare(`
    UPDATE tags
    SET display_name = ?,
        normalized_name = ?,
        updated_at = datetime('now')
    WHERE id = ?
    RETURNING ${COLUMNS.join(', ')}
  `);
  const deleteByIdStmt = db.prepare('DELETE FROM tags WHERE id = ?');
  const findProjectStmt = db.prepare('SELECT id FROM projects WHERE id = ?');
  const findAssetStmt = db.prepare('SELECT id FROM assets WHERE id = ?');
  const assignToProjectStmt = db.prepare(`
    INSERT INTO project_tags (project_id, tag_id)
    VALUES (?, ?)
    ON CONFLICT(project_id, tag_id) DO NOTHING
    RETURNING project_id, tag_id
  `);
  const removeFromProjectStmt = db.prepare(
    'DELETE FROM project_tags WHERE project_id = ? AND tag_id = ?'
  );
  const listProjectTagIdsStmt = db.prepare(
    'SELECT tag_id FROM project_tags WHERE project_id = ?'
  );
  const listForProjectStmt = db.prepare(`
    ${SELECT_PROJECT_TAGS}
    WHERE pt.project_id = ?
    ${PROJECT_TAG_ORDER}
  `);
  const assignToAssetStmt = db.prepare(`
    INSERT INTO asset_tags (asset_id, tag_id)
    VALUES (?, ?)
    ON CONFLICT(asset_id, tag_id) DO NOTHING
    RETURNING asset_id, tag_id
  `);
  const removeFromAssetStmt = db.prepare(
    'DELETE FROM asset_tags WHERE asset_id = ? AND tag_id = ?'
  );
  const listAssetTagIdsStmt = db.prepare(
    'SELECT tag_id FROM asset_tags WHERE asset_id = ?'
  );
  const listForAssetStmt = db.prepare(`
    ${SELECT_ASSET_TAGS}
    WHERE at.asset_id = ?
    ${ASSET_TAG_ORDER}
  `);

  const replaceForProjectTx = db.transaction((projectId, tagIds) => {
    if (!Array.isArray(tagIds)) {
      throw new TypeError('Project tag IDs must be an array.');
    }

    if (!findProjectStmt.get(projectId)) {
      return undefined;
    }

    const desiredTagIds = [...new Set(tagIds)];
    const currentTagIds = listProjectTagIdsStmt.all(projectId).map((row) => row.tag_id);
    const currentTagIdSet = new Set(currentTagIds);
    const desiredTagIdSet = new Set(desiredTagIds);

    for (const tagId of currentTagIds) {
      if (!desiredTagIdSet.has(tagId)) {
        removeFromProjectStmt.run(projectId, tagId);
      }
    }

    for (const tagId of desiredTagIds) {
      if (!currentTagIdSet.has(tagId)) {
        assignToProjectStmt.get(projectId, tagId);
      }
    }

    return listForProjectStmt.all(projectId);
  });

  const replaceForAssetTx = db.transaction((assetId, tagIds) => {
    if (!Array.isArray(tagIds)) {
      throw new TypeError('Asset tag IDs must be an array.');
    }

    if (!findAssetStmt.get(assetId)) {
      return undefined;
    }

    const desiredTagIds = [...new Set(tagIds)];
    const currentTagIds = listAssetTagIdsStmt.all(assetId).map((row) => row.tag_id);
    const currentTagIdSet = new Set(currentTagIds);
    const desiredTagIdSet = new Set(desiredTagIds);

    for (const tagId of currentTagIds) {
      if (!desiredTagIdSet.has(tagId)) {
        removeFromAssetStmt.run(assetId, tagId);
      }
    }

    for (const tagId of desiredTagIds) {
      if (!currentTagIdSet.has(tagId)) {
        assignToAssetStmt.get(assetId, tagId);
      }
    }

    return listForAssetStmt.all(assetId);
  });

  return {
    /**
     * @param {{displayName: string, normalizedName: string}} input
     * @returns {TagRecord}
     */
    create({ displayName, normalizedName }) {
      return insertStmt.get(displayName, normalizedName);
    },

    /**
     * @param {number} id
     * @returns {TagRecord|undefined}
     */
    findById(id) {
      return findByIdStmt.get(id);
    },

    /**
     * Match the exact stored normalized value; normalization belongs to the
     * service boundary rather than this repository.
     *
     * @param {string} normalizedName
     * @returns {TagRecord|undefined}
     */
    findByNormalizedName(normalizedName) {
      return findByNormalizedNameStmt.get(normalizedName);
    },

    /**
     * @returns {TagRecord[]}
     */
    list() {
      return listStmt.all();
    },

    /**
     * @param {number} id
     * @param {{displayName: string, normalizedName: string}} input
     * @returns {TagRecord|undefined}
     */
    update(id, { displayName, normalizedName }) {
      return updateStmt.get(displayName, normalizedName, id);
    },

    /**
     * @param {number} id
     * @returns {boolean} true when a tag row was deleted
     */
    deleteById(id) {
      return deleteByIdStmt.run(id).changes > 0;
    },

    /**
     * Assign an existing tag to an existing project.
     *
     * The composite primary key makes the operation idempotent. Foreign-key
     * violations are intentionally left to SQLite.
     *
     * @param {number} projectId
     * @param {number} tagId
     * @returns {boolean} true when a row was inserted, false when it existed
     */
    assignToProject(projectId, tagId) {
      return Boolean(assignToProjectStmt.get(projectId, tagId));
    },

    /**
     * Remove one project/tag assignment.
     *
     * @param {number} projectId
     * @param {number} tagId
     * @returns {boolean} true when an assignment was removed
     */
    removeFromProject(projectId, tagId) {
      return removeFromProjectStmt.run(projectId, tagId).changes > 0;
    },

    /**
     * List the tags assigned to one project in the same deterministic order as
     * the global tag catalog.
     *
     * @param {number} projectId
     * @returns {TagRecord[]}
     */
    listForProject(projectId) {
      return listForProjectStmt.all(projectId);
    },

    /**
     * List tags for a bounded set of projects in one query.
     *
     * @param {number[]} projectIds
     * @returns {Array<TagRecord & {project_id: number}>}
     */
    listForProjectIds(projectIds) {
      if (!Array.isArray(projectIds)) {
        throw new TypeError('Project IDs must be an array.');
      }

      const uniqueProjectIds = [...new Set(projectIds)];
      if (uniqueProjectIds.length === 0) return [];

      const placeholders = uniqueProjectIds.map(() => '?').join(', ');
      const stmt = db.prepare(`
        ${SELECT_PROJECT_TAGS_FOR_IDS}
        WHERE pt.project_id IN (${placeholders})
        ${PROJECT_TAG_BATCH_ORDER}
      `);
      return stmt.all(...uniqueProjectIds);
    },

    /**
     * Replace a project's complete tag set atomically. Existing assignments
     * that remain desired are not rewritten; foreign-key errors roll back the
     * complete transaction.
     *
     * @param {number} projectId
     * @param {number[]} tagIds
     * @returns {TagRecord[]|undefined} resulting tags, or undefined if missing
     */
    replaceForProject(projectId, tagIds) {
      return replaceForProjectTx(projectId, tagIds);
    },

    /**
     * Assign an existing tag to an asset row, whether the asset is currently
     * present on disk or marked missing.
     *
     * The composite primary key makes the operation idempotent. Foreign-key
     * violations are intentionally left to SQLite.
     *
     * @param {number} assetId
     * @param {number} tagId
     * @returns {boolean} true when a row was inserted, false when it existed
     */
    assignToAsset(assetId, tagId) {
      return Boolean(assignToAssetStmt.get(assetId, tagId));
    },

    /**
     * Remove one asset/tag assignment.
     *
     * @param {number} assetId
     * @param {number} tagId
     * @returns {boolean} true when an assignment was removed
     */
    removeFromAsset(assetId, tagId) {
      return removeFromAssetStmt.run(assetId, tagId).changes > 0;
    },

    /**
     * List the tags assigned to one asset in the same deterministic order as
     * the global tag catalog and project tag lists.
     *
     * @param {number} assetId
     * @returns {TagRecord[]}
     */
    listForAsset(assetId) {
      return listForAssetStmt.all(assetId);
    },

    /**
     * List tags for a bounded set of assets in one query.
     *
     * @param {number[]} assetIds
     * @returns {Array<TagRecord & {asset_id: number}>}
     */
    listForAssetIds(assetIds) {
      if (!Array.isArray(assetIds)) {
        throw new TypeError('Asset IDs must be an array.');
      }

      const uniqueAssetIds = [...new Set(assetIds)];
      if (uniqueAssetIds.length === 0) return [];

      const placeholders = uniqueAssetIds.map(() => '?').join(', ');
      const stmt = db.prepare(`
        ${SELECT_ASSET_TAGS_FOR_IDS}
        WHERE at.asset_id IN (${placeholders})
        ${ASSET_TAG_BATCH_ORDER}
      `);
      return stmt.all(...uniqueAssetIds);
    },

    /**
     * Replace an asset's complete tag set atomically. Existing assignments
     * that remain desired are not rewritten; foreign-key errors roll back the
     * complete transaction.
     *
     * @param {number} assetId
     * @param {number[]} tagIds
     * @returns {TagRecord[]|undefined} resulting tags, or undefined if missing
     */
    replaceForAsset(assetId, tagIds) {
      return replaceForAssetTx(assetId, tagIds);
    },
  };
}
