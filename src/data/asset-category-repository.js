/**
 * Phase 1: configurable asset categories.
 *
 * Two independent tables — global defaults (asset_category_defaults) and
 * project-owned categories (project_asset_categories). Copying defaults into
 * a project produces independent rows; there is no live relationship back to
 * the defaults afterward, so later edits/reorders/deletes of a default never
 * affect already-copied project categories.
 */

const DEFAULT_COLUMNS = ['id', 'display_name', 'directory_slug', 'display_order', 'enabled', 'created_at', 'updated_at'];
const PROJECT_COLUMNS = ['id', 'project_id', 'display_name', 'directory_slug', 'display_order', 'enabled', 'created_at', 'updated_at'];

const SELECT_DEFAULTS = `SELECT ${DEFAULT_COLUMNS.join(', ')} FROM asset_category_defaults`;
const SELECT_PROJECT_CATEGORIES = `SELECT ${PROJECT_COLUMNS.join(', ')} FROM project_asset_categories`;

export class AssetCategoryError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'AssetCategoryError';
    this.code = code;
  }
}

export function createAssetCategoryRepository(db) {
  const listDefaultsStmt = db.prepare(`${SELECT_DEFAULTS} ORDER BY display_order ASC, id ASC`);
  const insertDefaultStmt = db.prepare(`
    INSERT INTO asset_category_defaults (display_name, directory_slug, display_order, enabled)
    VALUES (?, ?, ?, ?)
    RETURNING ${DEFAULT_COLUMNS.join(', ')}
  `);
  const updateDefaultNameSlugStmt = db.prepare(`
    UPDATE asset_category_defaults
    SET display_name = ?, directory_slug = ?, updated_at = datetime('now')
    WHERE id = ?
    RETURNING ${DEFAULT_COLUMNS.join(', ')}
  `);
  const setDefaultEnabledStmt = db.prepare(`
    UPDATE asset_category_defaults
    SET enabled = ?, updated_at = datetime('now')
    WHERE id = ?
    RETURNING ${DEFAULT_COLUMNS.join(', ')}
  `);
  const setDefaultOrderStmt = db.prepare(`
    UPDATE asset_category_defaults
    SET display_order = ?, updated_at = datetime('now')
    WHERE id = ?
  `);
  const deleteDefaultStmt = db.prepare('DELETE FROM asset_category_defaults WHERE id = ?');
  const findDefaultByIdStmt = db.prepare(`${SELECT_DEFAULTS} WHERE id = ?`);
  const listEnabledDefaultsOrderedStmt = db.prepare(
    `${SELECT_DEFAULTS} WHERE enabled = 1 ORDER BY display_order ASC, id ASC`
  );

  const listProjectCategoriesStmt = db.prepare(
    `${SELECT_PROJECT_CATEGORIES} WHERE project_id = ? ORDER BY display_order ASC, id ASC`
  );
  const insertProjectCategoryStmt = db.prepare(`
    INSERT INTO project_asset_categories (project_id, display_name, directory_slug, display_order, enabled)
    VALUES (?, ?, ?, ?, 1)
    RETURNING ${PROJECT_COLUMNS.join(', ')}
  `);

  const reorderDefaultsTx = db.transaction((orderedIds) => {
    const current = listDefaultsStmt.all();
    const currentIds = current.map((row) => row.id);

    if (orderedIds.length !== currentIds.length) {
      throw new AssetCategoryError(
        `Reorder sequence length ${orderedIds.length} does not match current default count ${currentIds.length}.`,
        { code: 'INVALID_SEQUENCE_LENGTH' }
      );
    }

    const seen = new Set();
    for (const id of orderedIds) {
      if (!Number.isInteger(id)) {
        throw new AssetCategoryError(`Invalid default category ID: ${id}.`, { code: 'INVALID_ID' });
      }
      if (seen.has(id)) {
        throw new AssetCategoryError(`Duplicate default category ID: ${id}.`, { code: 'DUPLICATE_ID' });
      }
      seen.add(id);
    }

    const currentSet = new Set(currentIds);
    for (const id of orderedIds) {
      if (!currentSet.has(id)) {
        throw new AssetCategoryError(`Default category ID ${id} does not exist.`, { code: 'UNKNOWN_ID' });
      }
    }

    for (let i = 0; i < orderedIds.length; i++) {
      const result = setDefaultOrderStmt.run(i, orderedIds[i]);
      if (result.changes !== 1) {
        throw new AssetCategoryError(
          `Reorder update for default ${orderedIds[i]} affected ${result.changes} rows, expected 1.`,
          { code: 'UPDATE_CHANGES_MISMATCH' }
        );
      }
    }

    return listDefaultsStmt.all();
  });

  const copyEnabledDefaultsTx = db.transaction((projectId) => {
    const enabledDefaults = listEnabledDefaultsOrderedStmt.all();
    const inserted = [];
    for (let i = 0; i < enabledDefaults.length; i++) {
      const def = enabledDefaults[i];
      inserted.push(insertProjectCategoryStmt.get(projectId, def.display_name, def.directory_slug, i));
    }
    return inserted;
  });

  return {
    listDefaults() {
      return listDefaultsStmt.all();
    },

    findDefaultById(id) {
      return findDefaultByIdStmt.get(id);
    },

    addDefault({ displayName, directorySlug, displayOrder, enabled }) {
      return insertDefaultStmt.get(displayName, directorySlug, displayOrder, enabled ? 1 : 0);
    },

    updateDefaultNameSlug(id, { displayName, directorySlug }) {
      return updateDefaultNameSlugStmt.get(displayName, directorySlug, id);
    },

    setDefaultEnabled(id, enabled) {
      return setDefaultEnabledStmt.get(enabled ? 1 : 0, id);
    },

    /**
     * Persist a complete reorder of global defaults. `orderedIds` must be
     * an exact permutation of the current default IDs; positions are
     * rewritten to contiguous 0..n-1 values in the given order.
     */
    reorderDefaults(orderedIds) {
      return reorderDefaultsTx(orderedIds);
    },

    deleteDefault(id) {
      return deleteDefaultStmt.run(id).changes > 0;
    },

    listProjectCategories(projectId) {
      return listProjectCategoriesStmt.all(projectId);
    },

    /**
     * Copy currently enabled defaults into independent project-owned
     * category rows, in deterministic default order, with contiguous
     * project-local display_order starting at 0 and enabled = true.
     * Returns an empty array (inserting nothing) when no defaults are
     * enabled.
     */
    copyEnabledDefaultsForProject(projectId) {
      return copyEnabledDefaultsTx(projectId);
    },
  };
}
