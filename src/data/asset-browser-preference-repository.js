import { createAppMetaRepository } from './app-meta-repository.js';

export const PROJECT_PREFERENCE_MODES = Object.freeze(['inherit', 'all', 'category']);
export const GLOBAL_DEFAULT_KEY = 'asset_browser.default_category';

const PROJECT_PREFERENCE_COLUMNS = [
  'project_id',
  'default_category_mode',
  'default_category_id',
  'created_at',
  'updated_at',
];

const SELECT_PROJECT_PREFERENCE = `
  SELECT ${PROJECT_PREFERENCE_COLUMNS.join(', ')}
  FROM project_asset_browser_preferences
`;

/**
 * Persistence boundary for asset-browser defaults.
 *
 * Project category ownership and enabled-state validation intentionally stay
 * in the domain service. The preference table has no category foreign key so
 * a disabled reference can be retained and a later category deletion can be
 * reset explicitly in the caller's transaction.
 */
export function createAssetBrowserPreferenceRepository(db, { appMetaRepository } = {}) {
  const findProjectPreferenceStmt = db.prepare(
    `${SELECT_PROJECT_PREFERENCE} WHERE project_id = ?`
  );
  const ensureProjectPreferenceStmt = db.prepare(`
    INSERT INTO project_asset_browser_preferences (project_id, default_category_mode, default_category_id)
    VALUES (?, 'inherit', NULL)
    ON CONFLICT(project_id) DO NOTHING
  `);
  const upsertProjectPreferenceStmt = db.prepare(`
    INSERT INTO project_asset_browser_preferences (
      project_id, default_category_mode, default_category_id
    ) VALUES (?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      default_category_mode = excluded.default_category_mode,
      default_category_id = excluded.default_category_id,
      updated_at = datetime('now')
    RETURNING ${PROJECT_PREFERENCE_COLUMNS.join(', ')}
  `);
  const resetProjectPreferenceStmt = db.prepare(`
    UPDATE project_asset_browser_preferences
    SET default_category_mode = 'inherit',
        default_category_id = NULL,
        updated_at = datetime('now')
    WHERE project_id = ?
      AND default_category_mode = 'category'
      AND default_category_id = ?
  `);
  const sharedAppMetaRepository = appMetaRepository ?? createAppMetaRepository(db);

  return {
    /** @returns {object|undefined} */
    findProjectPreference(projectId) {
      return findProjectPreferenceStmt.get(projectId);
    },

    /**
     * Create the explicit inherit row when absent, without changing an
     * existing preference. This method deliberately has no transaction
     * wrapper so callers may invoke it inside a larger transaction.
     */
    ensureProjectPreference(projectId) {
      ensureProjectPreferenceStmt.run(projectId);
      return findProjectPreferenceStmt.get(projectId);
    },

    /**
     * Persist a complete preference value. SQLite's mode and shape CHECK
     * constraints remain the final invariant guard for direct repository use.
     */
    upsertProjectPreference(projectId, mode, categoryId = null) {
      return upsertProjectPreferenceStmt.get(projectId, mode, categoryId);
    },

    /**
     * Reset only a category preference that points at the deleted category.
     * No nested transaction is used; the caller can place this statement in
     * the same transaction as category deletion.
     */
    resetProjectPreferenceIfCategory(projectId, categoryId) {
      return resetProjectPreferenceStmt.run(projectId, categoryId).changes > 0;
    },

    /**
     * Return the raw stored metadata value. Missing metadata means `all`, but
     * malformed values are returned unchanged for service-level resolution.
     */
    getGlobalDefault() {
      return sharedAppMetaRepository.getValue(GLOBAL_DEFAULT_KEY) ?? 'all';
    },

    setGlobalDefault(value) {
      return sharedAppMetaRepository.setValue(GLOBAL_DEFAULT_KEY, value);
    },

    setGlobalDefaultWithOutcome(value) {
      return sharedAppMetaRepository.setValueWithOutcome(GLOBAL_DEFAULT_KEY, value, {
        fallbackValue: 'all',
      });
    },
  };
}
