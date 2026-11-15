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

const PAGE_SCOPE_COLUMNS = [
  'project_id',
  'page_key',
  'active_scope',
  'created_at',
  'updated_at',
];

const SELECT_PAGE_SCOPES = `
  SELECT ${PAGE_SCOPE_COLUMNS.join(', ')}
  FROM project_page_default_scopes
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
  const hasOptionValueStmt = db.prepare(`
    SELECT EXISTS(
      SELECT 1
      FROM project_page_defaults
      WHERE page_key = ?
        AND option_key = ?
        AND value = ?
    )
  `);
  // A reference is a stored scalar equal to the value, or (WP2 multivalue
  // defaults) a stored JSON array of selections containing it. Malformed or
  // non-array JSON is never parsed as a selection, so it only matches exactly.
  // JSON whitespace before the '[' is valid, so the array is recognized by
  // json_type, not by its first character. Nested CASE guarantees json_type
  // and json_each only ever see text json_valid accepted (SQLite does not
  // promise AND short-circuit order, and both raise on malformed JSON).
  const listOptionValueReferencesStmt = db.prepare(`
    SELECT project_id
    FROM project_page_defaults
    WHERE page_key = @pageKey
      AND option_key = @optionKey
      AND (
        value = @value
        OR CASE
          WHEN json_valid(value) THEN CASE
            WHEN json_type(value) = 'array' THEN EXISTS (
              SELECT 1
              FROM json_each(project_page_defaults.value) AS selection
              WHERE selection.type = 'text'
                AND selection.value = @value
            )
            ELSE 0
          END
          ELSE 0
        END
      )
    ORDER BY project_id
  `);
  const getPageScopeStmt = db.prepare(`
    ${SELECT_PAGE_SCOPES}
    WHERE project_id = ?
      AND page_key = ?
  `);
  const upsertPageScopeStmt = db.prepare(`
    INSERT INTO project_page_default_scopes (project_id, page_key, active_scope)
    VALUES (?, ?, ?)
    ON CONFLICT(project_id, page_key) DO UPDATE SET
      active_scope = excluded.active_scope,
      updated_at = datetime('now')
    RETURNING ${PAGE_SCOPE_COLUMNS.join(', ')}
  `);

  // Project-only reset: remove this project's page overrides and make Global
  // the active scope in one transaction (a savepoint when nested).
  const resetPageToGlobalTx = db.transaction((projectId, pageKey) => {
    const deletedOptions = getPageOptionsStmt
      .all(projectId, pageKey)
      .map(({ option_key }) => option_key);
    const previousScope = getPageScopeStmt.get(projectId, pageKey)?.active_scope;
    deletePageOptionsStmt.run(projectId, pageKey);
    // A missing scope row already resolves as Global; only rewrite a row that
    // names another scope so a reset with nothing to undo writes nothing.
    if (previousScope !== undefined && previousScope !== 'global') {
      upsertPageScopeStmt.get(projectId, pageKey, 'global');
    }
    return { deletedOptions, previousScope };
  });

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

    hasOptionValue(pageKey, optionKey, value) {
      return Boolean(hasOptionValueStmt.pluck().get(pageKey, optionKey, value));
    },

    listOptionValueReferences(pageKey, optionKey, value) {
      return listOptionValueReferencesStmt.all({ pageKey, optionKey, value });
    },

    getPageScope(projectId, pageKey) {
      return getPageScopeStmt.get(projectId, pageKey)?.active_scope;
    },

    setPageScope(projectId, pageKey, activeScope) {
      return upsertPageScopeStmt.get(projectId, pageKey, activeScope).active_scope;
    },

    resetPageToGlobal(projectId, pageKey) {
      return resetPageToGlobalTx(projectId, pageKey);
    },
  };
}
