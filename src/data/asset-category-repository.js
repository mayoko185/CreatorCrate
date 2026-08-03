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
  const shiftDefaultOrdersStmt = db.prepare(`
    UPDATE asset_category_defaults
    SET display_order = display_order + ?
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

  // ─── Phase 2 chunk 2: project-scoped category mutations ─────────────────

  const findProjectCategoryByIdStmt = db.prepare(
    `${SELECT_PROJECT_CATEGORIES} WHERE project_id = ? AND id = ?`
  );
  const findProjectCategoryByIdAnyProjectStmt = db.prepare(
    `${SELECT_PROJECT_CATEGORIES} WHERE id = ?`
  );
  const insertProjectCategoryWithEnabledStmt = db.prepare(`
    INSERT INTO project_asset_categories (project_id, display_name, directory_slug, display_order, enabled)
    VALUES (?, ?, ?, ?, ?)
    RETURNING ${PROJECT_COLUMNS.join(', ')}
  `);
  const updateProjectCategoryDisplayNameStmt = db.prepare(`
    UPDATE project_asset_categories
    SET display_name = ?, updated_at = datetime('now')
    WHERE project_id = ? AND id = ?
    RETURNING ${PROJECT_COLUMNS.join(', ')}
  `);
  const setProjectCategoryEnabledStmt = db.prepare(`
    UPDATE project_asset_categories
    SET enabled = ?, updated_at = datetime('now')
    WHERE project_id = ? AND id = ?
    RETURNING ${PROJECT_COLUMNS.join(', ')}
  `);
  const setProjectCategoryOrderStmt = db.prepare(`
    UPDATE project_asset_categories
    SET display_order = ?, updated_at = datetime('now')
    WHERE project_id = ? AND id = ?
  `);
  const shiftProjectCategoryOrdersStmt = db.prepare(`
    UPDATE project_asset_categories
    SET display_order = display_order + ?
    WHERE project_id = ?
  `);
  const deleteProjectCategoryStmt = db.prepare(
    'DELETE FROM project_asset_categories WHERE project_id = ? AND id = ?'
  );

  const reorderProjectCategoriesTx = db.transaction((projectId, orderedIds) => {
    const current = listProjectCategoriesStmt.all(projectId);
    const currentIds = current.map((row) => row.id);

    if (!Array.isArray(orderedIds)) {
      throw new AssetCategoryError('Project category reorder input must be an array.', { code: 'INVALID_INPUT' });
    }

    if (orderedIds.length !== currentIds.length) {
      throw new AssetCategoryError(
        `Reorder sequence length ${orderedIds.length} does not match current project category count ${currentIds.length}.`,
        { code: 'INVALID_SEQUENCE_LENGTH' }
      );
    }

    const seen = new Set();
    for (const id of orderedIds) {
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new AssetCategoryError(`Invalid project category ID: ${id}.`, { code: 'INVALID_ID' });
      }
      if (seen.has(id)) {
        throw new AssetCategoryError(`Duplicate project category ID: ${id}.`, { code: 'DUPLICATE_ID' });
      }
      seen.add(id);
    }

    const currentSet = new Set(currentIds);
    for (const id of orderedIds) {
      if (!currentSet.has(id)) {
        throw new AssetCategoryError(
          `Project category ID ${id} does not exist for project ${projectId}.`,
          { code: 'UNKNOWN_ID' }
        );
      }
    }

    if (orderedIds.length > 0) {
      // Move every current position outside the final range first. This keeps
      // the operation valid if a future schema adds a unique project/order
      // constraint; direct swaps would otherwise collide during the update.
      const maxDisplayOrder = Math.max(...current.map((row) => row.display_order));
      const temporaryOffset = maxDisplayOrder + current.length + 1;
      const shifted = shiftProjectCategoryOrdersStmt.run(temporaryOffset, projectId);
      if (shifted.changes !== current.length) {
        throw new AssetCategoryError(
          `Reorder preparation affected ${shifted.changes} rows, expected ${current.length}.`,
          { code: 'UPDATE_CHANGES_MISMATCH' }
        );
      }

      const whenClauses = orderedIds.map(() => 'WHEN ? THEN ?').join(' ');
      const setFinalOrderStmt = db.prepare(`
        UPDATE project_asset_categories
        SET display_order = CASE id ${whenClauses} ELSE display_order END
        WHERE project_id = ?
      `);
      const finalOrderParams = [];
      for (let i = 0; i < orderedIds.length; i++) {
        finalOrderParams.push(orderedIds[i], i);
      }
      finalOrderParams.push(projectId);

      const finalized = setFinalOrderStmt.run(...finalOrderParams);
      if (finalized.changes !== current.length) {
        throw new AssetCategoryError(
          `Reorder finalization affected ${finalized.changes} rows, expected ${current.length}.`,
          { code: 'UPDATE_CHANGES_MISMATCH' }
        );
      }
    }

    return listProjectCategoriesStmt.all(projectId);
  });

  const deleteProjectCategoryAndCompactTx = db.transaction((projectId, categoryId) => {
    const result = deleteProjectCategoryStmt.run(projectId, categoryId);
    if (result.changes !== 1) {
      throw new AssetCategoryError(
        `Project category ${categoryId} not found for project ${projectId}.`,
        { code: 'NOT_FOUND' }
      );
    }

    const remaining = listProjectCategoriesStmt.all(projectId);
    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i].display_order !== i) {
        setProjectCategoryOrderStmt.run(i, projectId, remaining[i].id);
      }
    }

    return listProjectCategoriesStmt.all(projectId);
  });

  const reorderDefaultsTx = db.transaction((orderedIds) => {
    const current = listDefaultsStmt.all();
    const currentIds = current.map((row) => row.id);

    if (!Array.isArray(orderedIds)) {
      throw new AssetCategoryError('Global category reorder input must be an array.', { code: 'INVALID_INPUT' });
    }

    if (orderedIds.length !== currentIds.length) {
      throw new AssetCategoryError(
        `Reorder sequence length ${orderedIds.length} does not match current default count ${currentIds.length}.`,
        { code: 'INVALID_SEQUENCE_LENGTH' }
      );
    }

    const seen = new Set();
    for (const id of orderedIds) {
      if (!Number.isSafeInteger(id) || id <= 0) {
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

    if (orderedIds.length > 0) {
      // Move every current position outside the final non-negative range
      // first. This keeps the operation valid if a unique order constraint is
      // added later; direct swaps could otherwise collide mid-update.
      const minDisplayOrder = Math.min(...current.map((row) => row.display_order));
      const temporaryOffset = Math.max(1, current.length + 1 - minDisplayOrder);
      const shifted = shiftDefaultOrdersStmt.run(temporaryOffset);
      if (shifted.changes !== current.length) {
        throw new AssetCategoryError(
          `Reorder preparation affected ${shifted.changes} rows, expected ${current.length}.`,
          { code: 'UPDATE_CHANGES_MISMATCH' }
        );
      }

      const whenClauses = orderedIds.map(() => 'WHEN ? THEN ?').join(' ');
      const idPlaceholders = orderedIds.map(() => '?').join(', ');
      const setFinalOrderStmt = db.prepare(`
        UPDATE asset_category_defaults
        SET display_order = CASE id ${whenClauses} ELSE display_order END
        WHERE id IN (${idPlaceholders})
      `);
      const finalOrderParams = [];
      for (let i = 0; i < orderedIds.length; i++) {
        finalOrderParams.push(orderedIds[i], i);
      }
      finalOrderParams.push(...orderedIds);

      const finalized = setFinalOrderStmt.run(...finalOrderParams);
      if (finalized.changes !== current.length) {
        throw new AssetCategoryError(
          `Reorder finalization affected ${finalized.changes} rows, expected ${current.length}.`,
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

    // ─── Phase 2 chunk 2: project-scoped category mutations ───────────────

    /**
     * Find a project-owned category by both project ID and category ID.
     * A category owned by a different project is indistinguishable from an
     * unknown ID — both return undefined.
     */
    findProjectCategoryById(projectId, categoryId) {
      return findProjectCategoryByIdStmt.get(projectId, categoryId);
    },

    /**
     * Find a project-owned category by its globally unique row ID without
     * applying a project scope. This is read-only ownership diagnostics for
     * callers that must distinguish a missing category from a foreign one.
     */
    findProjectCategoryByIdAnyProject(categoryId) {
      return findProjectCategoryByIdAnyProjectStmt.get(categoryId);
    },

    /**
     * Append a new project-owned category at an explicit display position
     * with an explicit enabled state.
     */
    addProjectCategory({ projectId, displayName, directorySlug, displayOrder, enabled }) {
      return insertProjectCategoryWithEnabledStmt.get(
        projectId, displayName, directorySlug, displayOrder, enabled ? 1 : 0
      );
    },

    /** Update only a project category's display_name. Slug is untouched. */
    updateProjectCategoryDisplayName(projectId, categoryId, displayName) {
      return updateProjectCategoryDisplayNameStmt.get(displayName, projectId, categoryId);
    },

    /** Set only a project category's enabled state. */
    setProjectCategoryEnabled(projectId, categoryId, enabled) {
      return setProjectCategoryEnabledStmt.get(enabled ? 1 : 0, projectId, categoryId);
    },

    /**
     * Persist a complete reorder of one project's categories. `orderedIds`
     * must be an exact permutation of that project's current category IDs;
     * positions are rewritten to contiguous 0..n-1 values in the given
     * order. Never touches another project's categories or global defaults.
     */
    reorderProjectCategories(projectId, orderedIds) {
      return reorderProjectCategoriesTx(projectId, orderedIds);
    },

    /**
     * Delete one project category and compact the remaining categories'
     * positions back to a contiguous 0..n-1 sequence, atomically.
     * @returns {Array} The project's remaining categories, post-compaction.
     */
    deleteProjectCategoryAndCompact(projectId, categoryId) {
      return deleteProjectCategoryAndCompactTx(projectId, categoryId);
    },
  };
}
