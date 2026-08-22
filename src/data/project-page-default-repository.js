const PAGE_OPTION_COLUMNS = [
  'project_id',
  'page_key',
  'option_key',
  'value',
  'created_at',
  'updated_at',
];

const SELECT_PAGE_OPTIONS = `
  SELECT ${PAGE_OPTION_COLUMNS.join(', ')}
  FROM project_page_defaults
`;

/**
 * Persistence boundary for project-scoped page-default overrides.
 *
 * Validation of supported pages, options, and values belongs to the caller's
 * domain service. This repository only stores complete page option values.
 */
export function createProjectPageDefaultRepository(db) {
  const getOptionStmt = db.prepare(`
    ${SELECT_PAGE_OPTIONS}
    WHERE project_id = ?
      AND page_key = ?
      AND option_key = ?
  `);
  const getPageOptionsStmt = db.prepare(`
    ${SELECT_PAGE_OPTIONS}
    WHERE project_id = ?
      AND page_key = ?
    ORDER BY option_key
  `);
  const upsertOptionStmt = db.prepare(`
    INSERT INTO project_page_defaults (project_id, page_key, option_key, value)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, page_key, option_key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
    RETURNING ${PAGE_OPTION_COLUMNS.join(', ')}
  `);
  const deletePageOptionsStmt = db.prepare(`
    DELETE FROM project_page_defaults
    WHERE project_id = ?
      AND page_key = ?
  `);
  const hasPageOptionsStmt = db.prepare(`
    SELECT EXISTS(
      SELECT 1
      FROM project_page_defaults
      WHERE project_id = ?
        AND page_key = ?
    )
  `);

  return {
    getOption(projectId, pageKey, optionKey) {
      return getOptionStmt.get(projectId, pageKey, optionKey)?.value;
    },

    getPageOptions(projectId, pageKey) {
      return Object.fromEntries(
        getPageOptionsStmt
          .all(projectId, pageKey)
          .map(({ option_key, value }) => [option_key, value])
      );
    },

    /**
     * No transaction wrapper is used so callers can atomically save a whole
     * page or clear it with related work in their own transaction.
     */
    setOption(projectId, pageKey, optionKey, value) {
      return upsertOptionStmt.get(projectId, pageKey, optionKey, value).value;
    },

    deletePageOptions(projectId, pageKey) {
      return deletePageOptionsStmt.run(projectId, pageKey).changes > 0;
    },

    hasPageOptions(projectId, pageKey) {
      return Boolean(hasPageOptionsStmt.pluck().get(projectId, pageKey));
    },
  };
}
