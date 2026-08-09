/**
 * Asset repository — SQL operations for the assets table.
 *
 * All paths stored are relative to the project directory.
 * No absolute host/container paths are ever stored.
 */

const ASSET_COLUMNS = [
  'id',
  'project_id',
  'category_id',
  'relative_path',
  'nested_path',
  'filename',
  'extension',
  'mime_type',
  'size_bytes',
  'modified_at',
  'is_present',
  'last_seen_at',
  'missing_since',
  'created_at',
  'updated_at',
];

const NOTE_ASSOCIATION_ASSET_SELECT = `
  SELECT
    a.id,
    a.project_id,
    a.relative_path,
    a.filename,
    a.is_present,
    p.title AS project_title
  FROM assets a
  JOIN projects p ON p.id = a.project_id
`;
const NOTE_ASSOCIATION_ASSET_ORDER = `
  ORDER BY
    p.title COLLATE NOCASE ASC,
    p.id ASC,
    a.filename COLLATE NOCASE ASC,
    a.relative_path COLLATE NOCASE ASC,
    a.id ASC
`;

const ALLOWED_SORTS = {
  filename: { column: 'filename COLLATE NOCASE' },
  size: { column: 'size_bytes' },
  modified: { column: 'modified_at' },
};

function buildOrderClause(sortBy, order) {
  const sort = ALLOWED_SORTS[sortBy] || ALLOWED_SORTS.filename;
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${sort.column} ${direction}`;
}

/**
 * Canonical asset-browser order clause builder. Explicit sort keys only —
 * no natural sort. Every branch ends with `a.id ASC` as a deterministic
 * tie-breaker. Null placement for modified/size/category is fixed (nulls
 * last) independent of the requested direction, so toggling asc/desc never
 * moves missing-value rows to the top.
 *
 * The project sort is opt-in for the cross-project browser. Keeping it out of
 * the default helper path preserves the existing project-scoped fallback for
 * unknown sort values.
 *
 * @param {'filename'|'modified'|'size'|'category'|'project'} sortBy
 * @param {'asc'|'desc'} order
 * @param {object} [options]
 * @param {boolean} [options.includeProjectSort]
 * @returns {string} a full `ORDER BY ...` clause
 */
function buildAssetBrowserOrderClause(sortBy, order, { includeProjectSort = false } = {}) {
  const dir = order === 'desc' ? 'DESC' : 'ASC';

  if (includeProjectSort && sortBy === 'project') {
    return `ORDER BY p.title COLLATE NOCASE ${dir}, p.id ASC, a.id ASC`;
  }
  if (sortBy === 'modified') {
    return `ORDER BY (a.modified_at IS NULL) ASC, a.modified_at ${dir}, a.id ASC`;
  }
  if (sortBy === 'size') {
    return `ORDER BY (a.size_bytes IS NULL) ASC, a.size_bytes ${dir}, a.id ASC`;
  }
  if (sortBy === 'category') {
    return `ORDER BY (a.category_id IS NULL) ASC, c.display_order ${dir}, a.category_id ${dir}, a.nested_path COLLATE NOCASE ${dir}, a.filename COLLATE NOCASE ${dir}, a.id ASC`;
  }
  return `ORDER BY a.filename COLLATE NOCASE ${dir}, a.id ASC`;
}

const CATEGORY_JOIN = 'LEFT JOIN project_asset_categories c ON c.project_id = a.project_id AND c.id = a.category_id';

function buildAssetBrowserSelectColumns({ includeCategorySlug = false } = {}) {
  return [
    'a.id',
    'a.project_id',
    'a.category_id',
    'a.relative_path',
    'a.nested_path',
    'a.filename',
    'a.extension',
    'a.mime_type',
    'a.size_bytes',
    'a.modified_at',
    'a.is_present',
    'a.last_seen_at',
    'a.missing_since',
    'c.display_name AS category_display_name',
    ...(includeCategorySlug ? ['c.directory_slug AS category_directory_slug'] : []),
    'c.enabled AS category_enabled',
    'c.display_order AS category_display_order',
    '(SELECT COUNT(DISTINCT ra.release_id) FROM release_assets ra JOIN releases r ON r.id = ra.release_id WHERE ra.asset_id = a.id AND r.project_id = a.project_id) AS release_usage_count',
  ].join(',\n          ');
}

const QUALIFIED_ASSET_COLUMNS = ASSET_COLUMNS.map((column) => `a.${column}`).join(', ');
const AUTO_RENAME_CATEGORY_COLUMNS = [
  'c.id AS category_record_id',
  'c.project_id AS category_project_id',
  'c.display_name AS category_display_name',
  'c.directory_slug AS category_directory_slug',
  'c.display_order AS category_display_order',
  'c.enabled AS category_enabled',
].join(', ');

function escapeLike(value) {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function buildSharedAssetBrowserConditions(filters = {}) {
  const conditions = [];
  const params = [];

  if (filters.search) {
    conditions.push(`(a.filename COLLATE NOCASE LIKE ? ESCAPE '\\' OR a.relative_path COLLATE NOCASE LIKE ? ESCAPE '\\')`);
    const term = `%${escapeLike(filters.search)}%`;
    params.push(term, term);
  }

  if (filters.extension) {
    conditions.push('LOWER(a.extension) = ?');
    params.push(filters.extension);
  }

  if (filters.presence === 'present') {
    conditions.push('a.is_present = 1');
  } else if (filters.presence === 'missing') {
    conditions.push('a.is_present = 0');
  }
  // 'all' = no presence restriction

  if (filters.usage === 'used') {
    conditions.push('EXISTS (SELECT 1 FROM release_assets ra JOIN releases r ON r.id = ra.release_id WHERE ra.asset_id = a.id AND r.project_id = a.project_id)');
  } else if (filters.usage === 'unused') {
    conditions.push('NOT EXISTS (SELECT 1 FROM release_assets ra JOIN releases r ON r.id = ra.release_id WHERE ra.asset_id = a.id AND r.project_id = a.project_id)');
  }
  // 'all' = no usage restriction

  return { conditions, params };
}

function appendProjectAssetCategoryCondition(conditions, params, category) {
  if (category === 'uncategorized') {
    conditions.push('a.category_id IS NULL');
  } else if (typeof category === 'number') {
    conditions.push('a.category_id = ?');
    params.push(category);
  }
  // 'all' / undefined = no category restriction
}

function appendProjectAssetTagCondition(conditions, params, tag) {
  if (tag === undefined || tag === null || tag === '') return;

  const values = Array.isArray(tag) ? tag : [tag];
  const selected = [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))]
    .sort((left, right) => left - right);
  if (selected.length === 0) return;

  const placeholders = selected.map(() => '?').join(',');
  conditions.push(`EXISTS (
    SELECT 1
    FROM asset_tags asset_tag_filter
    WHERE asset_tag_filter.asset_id = a.id
      AND asset_tag_filter.tag_id IN (${placeholders})
  )`);
  params.push(...selected);
}

function appendGlobalAssetTagCondition(conditions, params, tag) {
  if (tag === undefined || tag === null || tag === '') return;

  const values = Array.isArray(tag) ? tag : [tag];
  const selected = [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))]
    .sort((left, right) => left - right);
  if (selected.length === 0) return;

  const placeholders = selected.map(() => '?').join(',');
  conditions.push(`(
    EXISTS (
      SELECT 1
      FROM asset_tags asset_tag_filter
      WHERE asset_tag_filter.asset_id = a.id
        AND asset_tag_filter.tag_id IN (${placeholders})
    ) OR EXISTS (
      SELECT 1
      FROM project_tags project_tag_filter
      WHERE project_tag_filter.project_id = a.project_id
        AND project_tag_filter.tag_id IN (${placeholders})
    )
  )`);
  params.push(...selected, ...selected);
}

function appendGlobalAssetCategoryCondition(conditions, params, category) {
  if (category === undefined || category === null || category === '') return;

  const values = Array.isArray(category) ? category : [category];
  const selected = [...new Set(values.filter((value) => (
    typeof value === 'string' && value !== '' && value !== 'all'
  )))].sort();
  if (selected.length === 0) {
    if (values.every((value) => value === 'all' || value === '')) return;
    // Numeric project-local category IDs are not a stable cross-project
    // identity. An unsupported category value must not silently mean "all".
    conditions.push('1 = 0');
    return;
  }

  const clauses = [];
  if (selected.includes('uncategorized')) {
    clauses.push('a.category_id IS NULL');
  }

  const slugs = selected.filter((value) => value !== 'uncategorized');
  if (slugs.length > 0) {
    const placeholders = slugs.map(() => '?').join(',');
    clauses.push(`EXISTS (
      SELECT 1
      FROM project_asset_categories category_filter
      WHERE category_filter.project_id = a.project_id
        AND category_filter.id = a.category_id
        AND category_filter.directory_slug COLLATE NOCASE IN (${placeholders})
    )`);
    params.push(...slugs);
  }

  conditions.push(`(${clauses.join(' OR ')})`);
}

function appendGlobalAssetExtensionCondition(conditions, params, extension) {
  if (extension === undefined || extension === null || extension === '') return;

  const values = Array.isArray(extension) ? extension : [extension];
  const selected = [...new Set(values
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim().replace(/^\./, '').toLowerCase())
    .filter((value) => value !== '' && !value.startsWith('.')))]
    .sort();
  if (selected.length === 0) return;

  const placeholders = selected.map(() => '?').join(',');
  conditions.push(`LOWER(a.extension) IN (${placeholders})`);
  params.push(...selected);
}

function buildProjectAssetBrowserConditions(projectId, filters = {}) {
  const { conditions, params } = buildSharedAssetBrowserConditions(filters);
  conditions.unshift('a.project_id = ?');
  params.unshift(projectId);
  appendProjectAssetCategoryCondition(conditions, params, filters.category);
  appendProjectAssetTagCondition(conditions, params, filters.tags ?? filters.tag);
  return { conditions, params };
}

function buildAllAssetBrowserConditions(filters = {}) {
  // Project-scoped browser predicates remain direct asset-tag predicates; the
  // global browser additionally includes inherited project-tag assignments.
  const { conditions, params } = buildSharedAssetBrowserConditions({
    ...filters,
    extension: undefined,
  });
  const projectId = filters.projectId ?? filters.project_id;

  // Active project browsing excludes either archive indicator. Normal archive
  // operations set both; checking both also avoids exposing transient
  // status-only archived rows in a read-only active browser.
  conditions.push('p.archived_at IS NULL', 'p.status <> ?');
  params.push('archived');

  if (projectId !== undefined && projectId !== null) {
    conditions.push('a.project_id = ?');
    params.push(projectId);
  }

  appendGlobalAssetCategoryCondition(conditions, params, filters.categories ?? filters.category);
  appendGlobalAssetTagCondition(conditions, params, filters.tags ?? filters.tag);
  appendGlobalAssetExtensionCondition(conditions, params, filters.extensions ?? filters.extension);
  return { conditions, params };
}

// Detects a UNIQUE(project_id, relative_path) violation (idx_assets_project_path)
// from updateAssetLocationStmt specifically, so an unrelated constraint
// failure is never mistaken for a destination-path conflict.
function isAssetPathUniqueConstraintError(err) {
  return (
    err != null &&
    err.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    typeof err.message === 'string' &&
    err.message.includes('assets.project_id, assets.relative_path')
  );
}

/**
 * Create an asset repository bound to a database connection.
 * @param {import('better-sqlite3').Database} db
 */
export function createAssetRepository(db) {
  const findByProjectStmt = db.prepare(`
    SELECT ${ASSET_COLUMNS.join(', ')}
    FROM assets
    WHERE project_id = ?
  `);

  const findByIdStmt = db.prepare(`
    SELECT ${ASSET_COLUMNS.join(', ')}
    FROM assets
    WHERE id = ?
  `);

  const findAllForNoteAssociationStmt = db.prepare(
    `${NOTE_ASSOCIATION_ASSET_SELECT}${NOTE_ASSOCIATION_ASSET_ORDER}`
  );

  const findByPathStmt = db.prepare(`
    SELECT ${ASSET_COLUMNS.join(', ')}
    FROM assets
    WHERE project_id = ? AND relative_path = ?
  `);

  // Same-ID location update for asset rename/move (Phase: asset actions
  // chunk 1). Identifies the row by project_id + id + the caller-supplied
  // expected old relative_path so a stale/racing caller updates nothing.
  // The UNIQUE(project_id, relative_path) index (idx_assets_project_path)
  // makes a destination already owned by another row fail this statement
  // with a SQLITE_CONSTRAINT_UNIQUE error rather than silently overwriting
  // it; the wrapping method below translates that into a conflict result.
  const updateAssetLocationStmt = db.prepare(`
    UPDATE assets
    SET relative_path = ?,
        filename = ?,
        extension = ?,
        mime_type = ?,
        category_id = ?,
        nested_path = ?,
        size_bytes = ?,
        modified_at = ?,
        is_present = 1,
        last_seen_at = datetime('now'),
        missing_since = NULL,
        updated_at = datetime('now')
    WHERE project_id = ? AND id = ? AND relative_path = ?
    RETURNING ${ASSET_COLUMNS.join(', ')}
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO assets (project_id, relative_path, category_id, nested_path, filename, extension, mime_type, size_bytes, modified_at, is_present, last_seen_at, missing_since)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), NULL)
    ON CONFLICT(project_id, relative_path) DO UPDATE SET
      category_id = excluded.category_id,
      nested_path = excluded.nested_path,
      filename = excluded.filename,
      extension = excluded.extension,
      mime_type = excluded.mime_type,
      size_bytes = excluded.size_bytes,
      modified_at = excluded.modified_at,
      is_present = 1,
      last_seen_at = datetime('now'),
      missing_since = NULL,
      updated_at = datetime('now')
    RETURNING ${ASSET_COLUMNS.join(', ')}
  `);

  const upsertManyTx = db.transaction((projectId, assets) => {
    if (!Array.isArray(assets)) {
      throw new TypeError('Asset upsert input must be an array.');
    }

    return assets.map((data) => upsertStmt.get(
      projectId,
      data.relativePath,
      data.categoryId ?? null,
      data.nestedPath ?? '',
      data.filename,
      data.extension,
      data.mimeType,
      data.sizeBytes,
      data.modifiedAt || null,
    ));
  });

  const deleteAssetStmt = db.prepare(`
    DELETE FROM assets
    WHERE project_id = ? AND id = ? AND relative_path = ?
    RETURNING ${ASSET_COLUMNS.join(', ')}
  `);

  const deleteManyTx = db.transaction((projectId, expectedAssets) => {
    if (!Array.isArray(expectedAssets)) {
      throw new TypeError('Asset delete input must be an array.');
    }

    const deleted = [];
    for (const expected of expectedAssets) {
      const asset = deleteAssetStmt.get(projectId, expected.assetId, expected.relativePath);
      if (!asset) {
        const error = new Error('Asset delete did not match the expected database state.');
        error.code = 'NOT_FOUND';
        throw error;
      }
      deleted.push(asset);
    }
    return deleted;
  });

  const selectExistingForReconcileStmt = db.prepare(`
    SELECT id, category_id, nested_path, relative_path, filename, extension, mime_type, size_bytes, modified_at, is_present
    FROM assets
    WHERE project_id = ?
  `);

  const insertReconcileStmt = db.prepare(`
    INSERT INTO assets (project_id, relative_path, category_id, nested_path, filename, extension, mime_type, size_bytes, modified_at, is_present, last_seen_at, missing_since)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), NULL)
  `);

  const updateReconcileStmt = db.prepare(`
    UPDATE assets
    SET category_id = ?,
        nested_path = ?,
        filename = ?,
        extension = ?,
        mime_type = ?,
        size_bytes = ?,
        modified_at = ?,
        is_present = 1,
        last_seen_at = datetime('now'),
        missing_since = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `);

  const markMissingNotInReconcileStmt = (presentPaths) => {
    const placeholders = presentPaths.map(() => '?').join(',');
    return db.prepare(`
      UPDATE assets
      SET is_present = 0,
          missing_since = COALESCE(missing_since, datetime('now')),
          updated_at = datetime('now')
      WHERE project_id = ? AND relative_path NOT IN (${placeholders}) AND is_present = 1
    `);
  };

  const markAllMissingReconcileStmt = db.prepare(`
    UPDATE assets
    SET is_present = 0,
        missing_since = COALESCE(missing_since, datetime('now')),
        updated_at = datetime('now')
    WHERE project_id = ? AND is_present = 1
  `);

  /**
   * Atomic scan reconciliation. Takes the complete discovered snapshot for a
   * project (already classified with categoryId/nestedPath) and applies it
   * in one transaction: inserts new paths, restores/updates existing ones
   * (including a path-derived-field-only repair when size/mtime match), and
   * marks undiscovered paths missing. Rolls back entirely on any failure.
   *
   * @param {number} projectId
   * @param {Array<{relativePath: string, filename: string, extension: string, mimeType: string, sizeBytes: number, modifiedAt: string|null, categoryId: number|null, nestedPath: string}>} discovered
   * @returns {{ added: number, updated: number, removed: number, total: number }}
   */
  const reconcileScannedAssetsTx = db.transaction((projectId, discovered) => {
    const existingByPath = new Map(
      selectExistingForReconcileStmt.all(projectId).map((row) => [row.relative_path, row])
    );

    let added = 0;
    let updated = 0;
    const discoveredPaths = [];

    for (const file of discovered) {
      discoveredPaths.push(file.relativePath);
      const categoryId = file.categoryId ?? null;
      const nestedPath = file.nestedPath ?? '';
      const modifiedAt = file.modifiedAt || null;
      const existing = existingByPath.get(file.relativePath);

      if (!existing) {
        insertReconcileStmt.run(
          projectId,
          file.relativePath,
          categoryId,
          nestedPath,
          file.filename,
          file.extension,
          file.mimeType,
          file.sizeBytes,
          modifiedAt,
        );
        added++;
        continue;
      }

      const changed =
        existing.is_present === 0 ||
        existing.category_id !== categoryId ||
        existing.nested_path !== nestedPath ||
        existing.filename !== file.filename ||
        existing.extension !== file.extension ||
        existing.mime_type !== file.mimeType ||
        existing.size_bytes !== file.sizeBytes ||
        existing.modified_at !== modifiedAt;

      if (changed) {
        updateReconcileStmt.run(
          categoryId,
          nestedPath,
          file.filename,
          file.extension,
          file.mimeType,
          file.sizeBytes,
          modifiedAt,
          existing.id,
        );
        updated++;
      }
    }

    const removed =
      discoveredPaths.length === 0
        ? markAllMissingReconcileStmt.run(projectId).changes
        : markMissingNotInReconcileStmt(discoveredPaths).run(projectId, ...discoveredPaths).changes;

    const total = countByProjectStmt.get(projectId).c;

    return { added, updated, removed, total };
  });

  // ─── Phase 2 chunk 2: project-category mutation support ────────────────

  const countAssetsByCategoryStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM assets WHERE project_id = ? AND category_id = ?
  `);

  const deletePathsNotInStmt = db.prepare(`
    DELETE FROM assets
    WHERE project_id = ? AND relative_path NOT IN (?)
  `);

  const deleteByProjectStmt = db.prepare(`
    DELETE FROM assets WHERE project_id = ?
  `);

  const countByProjectStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM assets WHERE project_id = ?
  `);

  function executeAssetLocationUpdate(projectId, assetId, expectedOldRelativePath, data) {
    let updated;
    try {
      updated = updateAssetLocationStmt.get(
        data.relativePath,
        data.filename,
        data.extension,
        data.mimeType,
        data.categoryId ?? null,
        data.nestedPath ?? '',
        data.sizeBytes,
        data.modifiedAt || null,
        projectId,
        assetId,
        expectedOldRelativePath,
      );
    } catch (err) {
      if (isAssetPathUniqueConstraintError(err)) {
        const conflict = new Error('Asset location update destination conflicts with another row.');
        conflict.code = 'DESTINATION_CONFLICT';
        throw conflict;
      }
      throw err;
    }

    if (!updated) {
      const missing = new Error('Asset location update did not match the expected row.');
      missing.code = 'NOT_FOUND';
      throw missing;
    }

    return updated;
  }

  // SQLite checks the UNIQUE(project_id, relative_path) index immediately.
  // Stage every changed row through a unique temporary path first so swaps and
  // cycles can commit as one transaction without exposing an intermediate
  // database state to callers.
  const updateAssetLocationsTx = db.transaction((projectId, updates) => {
    if (!Array.isArray(updates)) {
      throw new TypeError('Asset location updates must be an array.');
    }

    for (const update of updates) {
      if (update.expectedDatabaseFilename === undefined) continue;
      const current = findByIdStmt.get(update.assetId);
      const matches = current
        && current.project_id === projectId
        && current.relative_path === update.expectedOldRelativePath
        && current.filename === update.expectedDatabaseFilename
        && current.category_id === (update.expectedDatabaseCategoryId ?? null)
        && (current.nested_path ?? '') === (update.expectedDatabaseNestedPath ?? '')
        && current.size_bytes === update.expectedDatabaseSizeBytes
        && current.modified_at === (update.expectedDatabaseModifiedAt || null)
        && (current.is_present === 1 || current.is_present === true) === Boolean(update.expectedDatabasePresent);
      if (!matches) {
        const stale = new Error('Asset database state no longer matches the signed plan.');
        stale.code = 'STALE_STATE';
        throw stale;
      }
    }

    for (const update of updates) {
      executeAssetLocationUpdate(
        projectId,
        update.assetId,
        update.expectedOldRelativePath,
        {
          relativePath: update.temporaryRelativePath,
          filename: update.temporaryFilename,
          extension: update.temporaryExtension,
          mimeType: update.temporaryMimeType,
          categoryId: update.categoryId,
          nestedPath: update.temporaryNestedPath,
          sizeBytes: update.sizeBytes,
          modifiedAt: update.modifiedAt,
        },
      );
    }

    return updates.map((update) => executeAssetLocationUpdate(
      projectId,
      update.assetId,
      update.temporaryRelativePath,
      {
        relativePath: update.relativePath,
        filename: update.filename,
        extension: update.extension,
        mimeType: update.mimeType,
        categoryId: update.categoryId,
        nestedPath: update.nestedPath,
        sizeBytes: update.sizeBytes,
        modifiedAt: update.modifiedAt,
      },
    ));
  });

  const totalCountStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM assets
  `);

  const totalMissingCountStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM assets WHERE is_present = 0
  `);

  const presentCountByProjectStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM assets WHERE project_id = ? AND is_present = 1
  `);

  const missingCountByProjectStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM assets WHERE project_id = ? AND is_present = 0
  `);

  return {
    /**
     * Find an asset by its id.
     * @param {number} id
     * @returns {import('./asset-repository.js').AssetRecord|undefined}
     */
    findById(id) {
      return findByIdStmt.get(id);
    },

    /**
     * Find multiple assets by id in one bounded query. Used by bulk
     * operations (e.g. adding several assets to a release) so validation
     * never issues one lookup per submitted ID. Duplicate IDs are
     * deduplicated before querying; unmatched IDs are simply absent from
     * the result (no error).
     * @param {number[]} ids
     * @returns {import('./asset-repository.js').AssetRecord[]}
     */
    findByIds(ids) {
      if (!Array.isArray(ids) || ids.length === 0) return [];
      const unique = [...new Set(ids)];
      const placeholders = unique.map(() => '?').join(',');
      const sql = `SELECT ${ASSET_COLUMNS.join(', ')} FROM assets WHERE id IN (${placeholders})`;
      return db.prepare(sql).all(...unique);
    },

    /**
     * Find indexed assets with the project context required by the Notes
     * association picker and detail page. Omitting ids returns every indexed
     * asset, including rows in archived projects and rows marked missing;
     * supplying ids restricts the same read model to those asset IDs.
     *
     * @param {number[]} [ids]
     * @returns {Array<{id: number, project_id: number, relative_path: string, filename: string, is_present: number, project_title: string}>}
     */
    findAssetsForNoteAssociation(ids) {
      if (ids === undefined) return findAllForNoteAssociationStmt.all();
      if (!Array.isArray(ids) || ids.length === 0) return [];

      const unique = [...new Set(ids)];
      const placeholders = unique.map(() => '?').join(',');
      const sql = `${NOTE_ASSOCIATION_ASSET_SELECT}
    WHERE a.id IN (${placeholders})
    ${NOTE_ASSOCIATION_ASSET_ORDER}`;
      return db.prepare(sql).all(...unique);
    },

    /**
     * Find selected project-owned assets associated with a published release.
     * Used by permanent deletion preflight so published-release references are
     * protected while unpublished release associations may still cascade.
     * @param {number} projectId
     * @param {number[]} ids
     * @returns {number[]}
     */
    findPublishedReleaseAssetIds(projectId, ids) {
      if (!Array.isArray(ids) || ids.length === 0) return [];
      const unique = [...new Set(ids)];
      const placeholders = unique.map(() => '?').join(',');
      const sql = `
        SELECT DISTINCT ra.asset_id
        FROM release_assets ra
        JOIN releases r ON r.id = ra.release_id
        JOIN assets a ON a.id = ra.asset_id
        WHERE a.project_id = ?
          AND ra.asset_id IN (${placeholders})
          AND r.published_date IS NOT NULL
        ORDER BY ra.asset_id
      `;
      return db.prepare(sql).all(projectId, ...unique).map(({ asset_id }) => asset_id);
    },

    /**
     * Find the selected assets for one project in the exact default order used
     * by the asset browser. The order expression is deliberately shared with
     * the browser page/viewer queries rather than reproduced by a service.
     *
     * @param {number} projectId
     * @param {number[]} ids
     * @returns {import('./asset-repository.js').AssetRecord[]}
     */
    findProjectAssetsByIdsInBrowserOrder(projectId, ids) {
      if (!Array.isArray(ids) || ids.length === 0) return [];
      const unique = [...new Set(ids)];
      const placeholders = unique.map(() => '?').join(',');
      const sql = `
        SELECT ${QUALIFIED_ASSET_COLUMNS}, ${AUTO_RENAME_CATEGORY_COLUMNS}
        FROM assets a
        ${CATEGORY_JOIN}
        WHERE a.project_id = ? AND a.id IN (${placeholders})
        ${buildAssetBrowserOrderClause('filename', 'asc')}
      `;
      return db.prepare(sql).all(projectId, ...unique);
    },

    /**
     * Find every indexed asset in one exact project-owned category, in the
     * canonical default Assets-browser order. This intentionally has no
     * filters, LIMIT, or OFFSET: Auto Rename must receive the complete
     * category membership rather than a browser subset.
     *
     * @param {number} projectId
     * @param {number} categoryId
     * @returns {import('./asset-repository.js').AssetRecord[]}
     */
    findProjectAssetsByCategoryInBrowserOrder(projectId, categoryId) {
      if (
        !Number.isSafeInteger(projectId)
        || projectId <= 0
        || !Number.isSafeInteger(categoryId)
        || categoryId <= 0
      ) return [];

      const sql = `
        SELECT
          ${QUALIFIED_ASSET_COLUMNS},
          ${AUTO_RENAME_CATEGORY_COLUMNS},
          (SELECT COUNT(DISTINCT ra.release_id)
           FROM release_assets ra
           JOIN releases r ON r.id = ra.release_id
           WHERE ra.asset_id = a.id AND r.project_id = a.project_id) AS release_usage_count
        FROM assets a
        ${CATEGORY_JOIN}
        WHERE a.project_id = ? AND a.category_id = ?
        ${buildAssetBrowserOrderClause('filename', 'asc')}
      `;
      return db.prepare(sql).all(projectId, categoryId);
    },

    /**
     * Find all assets for a project, with optional filtering and sorting.
     * @param {number} projectId
     * @param {object} [options]
     * @param {string} [options.extension] - Filter by file extension (without dot)
     * @param {string} [options.search] - Filename search term
     * @param {number} [options.categoryId] - Filter by project-owned category ID
     * @param {string} [options.sortBy] - Column to sort by: filename, size, modified
     * @param {string} [options.order] - asc or desc
     * @returns {import('./asset-repository.js').AssetRecord[]}
     */
    findByProjectId(projectId, options = {}) {
      const {
        extension,
        search,
        categoryId,
        sortBy = 'filename',
        order = 'asc',
      } = options;

      const conditions = ['project_id = ?'];
      const params = [projectId];

      if (extension) {
        conditions.push('extension = ?');
        params.push(extension);
      }

      if (search && search.trim()) {
        const term = `%${escapeLike(search.trim())}%`;
        conditions.push('filename LIKE ? ESCAPE \'\\\'');
        params.push(term);
      }

      if (categoryId !== undefined && categoryId !== null) {
        conditions.push('category_id = ?');
        params.push(categoryId);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const orderClause = buildOrderClause(sortBy, order);
      const sql = `SELECT ${ASSET_COLUMNS.join(', ')} FROM assets ${where} ${orderClause}`;

      return db.prepare(sql).all(...params);
    },

    /**
     * Find a single asset by project and relative path.
     * @param {number} projectId
     * @param {string} relativePath
     * @returns {import('./asset-repository.js').AssetRecord|undefined}
     */
    findByProjectIdAndPath(projectId, relativePath) {
      return findByPathStmt.get(projectId, relativePath);
    },

    /**
     * Update an existing asset's location and derived metadata in place,
     * preserving its id. Used by asset rename/move (Phase: asset actions
     * chunk 1) after the filesystem move succeeds. This method performs no
     * filesystem operation itself.
     *
     * The row is identified by project_id + id + `expectedOldRelativePath`
     * (the caller's last-known relative_path) so a stale caller — or one
     * racing another mutation on the same row — updates nothing instead of
     * clobbering a path it no longer matches. `id`, `project_id`, and
     * `created_at` are never modified, and release_assets rows (associations,
     * roles, sort_order) are untouched since they reference the unchanged
     * asset id.
     *
     * @param {number} projectId
     * @param {number} assetId
     * @param {string} expectedOldRelativePath
     * @param {object} data
     * @param {string} data.relativePath - new relative_path
     * @param {string} data.filename
     * @param {string} data.extension
     * @param {string} data.mimeType
     * @param {number|null} [data.categoryId]
     * @param {string} [data.nestedPath]
     * @param {number} data.sizeBytes
     * @param {string|null} data.modifiedAt
     * @returns {{ ok: true, asset: import('./asset-repository.js').AssetRecord } | { ok: false, reason: 'NOT_FOUND' | 'DESTINATION_CONFLICT' }}
     */
    updateAssetLocation(projectId, assetId, expectedOldRelativePath, data) {
      let updated;
      try {
        updated = updateAssetLocationStmt.get(
          data.relativePath,
          data.filename,
          data.extension,
          data.mimeType,
          data.categoryId ?? null,
          data.nestedPath ?? '',
          data.sizeBytes,
          data.modifiedAt || null,
          projectId,
          assetId,
          expectedOldRelativePath,
        );
      } catch (err) {
        if (isAssetPathUniqueConstraintError(err)) {
          return { ok: false, reason: 'DESTINATION_CONFLICT' };
        }
        throw err;
      }

      if (!updated) {
        return { ok: false, reason: 'NOT_FOUND' };
      }

      return { ok: true, asset: updated };
    },

    /**
     * Update several asset locations atomically, staging through temporary
     * relative paths so selected-source swaps and cycles do not violate the
     * immediate UNIQUE(project_id, relative_path) index.
     *
     * @param {number} projectId
     * @param {Array<{
     *   assetId: number,
     *   expectedOldRelativePath: string,
     *   temporaryRelativePath: string,
     *   temporaryFilename: string,
     *   temporaryExtension: string,
     *   temporaryMimeType: string,
     *   temporaryNestedPath: string,
     *   relativePath: string,
     *   filename: string,
     *   extension: string,
     *   mimeType: string,
     *   categoryId: number|null,
     *   nestedPath: string,
     *   sizeBytes: number,
     *   modifiedAt: string|null,
     *   expectedDatabaseFilename: string,
     *   expectedDatabaseCategoryId: number|null,
     *   expectedDatabaseNestedPath: string,
     *   expectedDatabaseSizeBytes: number,
     *   expectedDatabaseModifiedAt: string|null,
     *   expectedDatabasePresent: boolean,
     * }>} updates
     * @returns {import('./asset-repository.js').AssetRecord[]}
     */
    updateAssetLocations(projectId, updates) {
      return updateAssetLocationsTx(projectId, updates);
    },

    /**
     * Upsert an asset record. If a record with the same project_id and
     * relative_path exists, it is updated. Otherwise a new record is created.
     * @param {number} projectId
     * @param {string} relativePath
     * @param {object} data
     * @param {string} data.filename
     * @param {string} data.extension
     * @param {string} data.mimeType
     * @param {number} data.sizeBytes
     * @param {string|null} data.modifiedAt
     * @param {number|null} [data.categoryId]
     * @param {string} [data.nestedPath]
     * @returns {import('./asset-repository.js').AssetRecord}
     */
    upsert(projectId, relativePath, data) {
      return upsertStmt.get(
        projectId,
        relativePath,
        data.categoryId ?? null,
        data.nestedPath ?? '',
        data.filename,
        data.extension,
        data.mimeType,
        data.sizeBytes,
        data.modifiedAt || null,
      );
    },

    /**
     * Upsert several asset records atomically. Used after a batch filesystem
     * copy has completed so a database failure cannot leave only part of the
     * copied batch indexed.
     * @param {number} projectId
     * @param {Array<object>} assets
     * @returns {import('./asset-repository.js').AssetRecord[]}
     */
    upsertMany(projectId, assets) {
      return upsertManyTx(projectId, assets);
    },

    /**
     * Permanently delete several project-owned asset rows atomically. Each
     * expected relative path is matched with its ID so stale callers cannot
     * delete a row after its location has changed. Foreign-key cascades remove
     * release, primary-image, and tag references according to the schema.
     * @param {number} projectId
     * @param {Array<{assetId: number, relativePath: string}>} expectedAssets
     * @returns {import('./asset-repository.js').AssetRecord[]}
     */
    deleteMany(projectId, expectedAssets) {
      return deleteManyTx(projectId, expectedAssets);
    },

    /**
     * Atomic scan reconciliation — see {@link reconcileScannedAssetsTx}.
     * @param {number} projectId
     * @param {Array<{relativePath: string, filename: string, extension: string, mimeType: string, sizeBytes: number, modifiedAt: string|null, categoryId: number|null, nestedPath: string}>} discovered
     * @returns {{ added: number, updated: number, removed: number, total: number }}
     */
    reconcileScannedAssets(projectId, discovered) {
      return reconcileScannedAssetsTx(projectId, discovered);
    },

  /**
   * Mark assets as missing for a project whose relative_path is NOT in the given list.
   * Designed for scanner reconciliation — marks records as missing instead of deleting.
   * @param {number} projectId
   * @param {string[]} presentPaths - Array of relative paths that are present on disk
   * @returns {number} Number of marked rows
   */
  markMissingByProjectIdAndPathNotIn(projectId, presentPaths) {
    if (presentPaths.length === 0) {
      // All assets for the project are missing
      return this.markAllMissing(projectId);
    }

    const placeholders = presentPaths.map(() => '?').join(',');
    const sql = `
      UPDATE assets
      SET is_present = 0,
          missing_since = COALESCE(missing_since, datetime('now')),
          updated_at = datetime('now')
      WHERE project_id = ? AND relative_path NOT IN (${placeholders}) AND is_present = 1
    `;
    const result = db.prepare(sql).run(projectId, ...presentPaths);
    return result.changes;
  },

  /**
   * Mark all assets for a project as missing.
   * @param {number} projectId
   * @returns {number} Number of marked rows
   */
  markAllMissing(projectId) {
    const sql = `
      UPDATE assets
      SET is_present = 0,
          missing_since = COALESCE(missing_since, datetime('now')),
          updated_at = datetime('now')
      WHERE project_id = ? AND is_present = 1
    `;
    const result = db.prepare(sql).run(projectId);
    return result.changes;
  },

  /**
   * Restore present assets by marking them as present again.
   * Only affects assets that are currently marked as missing.
   * @param {number} projectId
   * @param {string[]} presentPaths - Array of relative paths that are present on disk
   * @returns {number} Number of restored rows
   */
  restorePresent(projectId, presentPaths) {
    if (presentPaths.length === 0) {
      return 0;
    }

    const placeholders = presentPaths.map(() => '?').join(',');
    const sql = `
      UPDATE assets
      SET is_present = 1,
          last_seen_at = datetime('now'),
          missing_since = NULL,
          updated_at = datetime('now')
      WHERE project_id = ? AND relative_path IN (${placeholders}) AND is_present = 0
    `;
    const result = db.prepare(sql).run(projectId, ...presentPaths);
    return result.changes;
  },

  /**
   * Find missing assets for a project.
   * @param {number} projectId
   * @returns {import('./asset-repository.js').AssetRecord[]}
   */
  findMissingByProjectId(projectId) {
    return db.prepare(`
      SELECT ${ASSET_COLUMNS.join(', ')}
      FROM assets
      WHERE project_id = ? AND is_present = 0
      ORDER BY missing_since DESC
    `).all(projectId);
  },

  /**
   * Find present assets for a project.
   * @param {number} projectId
   * @returns {import('./asset-repository.js').AssetRecord[]}
   */
  findPresentByProjectId(projectId) {
    return db.prepare(`
      SELECT ${ASSET_COLUMNS.join(', ')}
      FROM assets
      WHERE project_id = ? AND is_present = 1
      ORDER BY filename COLLATE NOCASE
    `).all(projectId);
  },

    /**
     * Delete all assets for a project.
     * @param {number} projectId
     * @returns {number} Number of deleted rows
     */
    deleteByProjectId(projectId) {
      const result = deleteByProjectStmt.run(projectId);
      return result.changes;
    },

    /**
     * Count assets for a project.
     * @param {number} projectId
     * @returns {number}
     */
    countByProjectId(projectId) {
      const row = countByProjectStmt.get(projectId);
      return row.c;
    },

    /**
     * Count assets across all projects.
     * @returns {number}
     */
    getTotalCount() {
      const row = totalCountStmt.get();
      return row.c;
    },

    /**
     * Count assets currently marked as missing across all projects.
     * @returns {number}
     */
    getTotalMissingCount() {
      const row = totalMissingCountStmt.get();
      return row.c;
    },

    /**
     * Count present assets for a single project.
     * @param {number} projectId
     * @returns {number}
     */
    countPresentByProjectId(projectId) {
      const row = presentCountByProjectStmt.get(projectId);
      return row.c;
    },

    /**
     * Count missing assets for a single project.
     * @param {number} projectId
     * @returns {number}
     */
    countMissingByProjectId(projectId) {
      const row = missingCountByProjectStmt.get(projectId);
      return row.c;
    },

    // ─── Phase 2 chunk 2: project-category mutation support ──────────────

    /**
     * Count every asset row (present or missing) referencing a project
     * category. Used to decide whether a category can be safely deleted.
     * @param {number} projectId
     * @param {number} categoryId
     * @returns {number}
     */
    countByCategoryId(projectId, categoryId) {
      return countAssetsByCategoryStmt.get(projectId, categoryId).c;
    },

    /**
     * Get distinct extensions used by a project's assets.
     * @param {number} projectId
     * @returns {string[]}
     */
    getExtensions(projectId) {
      const sql = `
        SELECT DISTINCT LOWER(extension) AS extension
        FROM assets
        WHERE project_id = ? AND extension <> ''
        ORDER BY extension COLLATE NOCASE ASC
      `;
      return db.prepare(sql).pluck().all(projectId);
    },

    /**
     * Stable extension choices for a project's asset browser.
     * The list is project-owned only; search, presence, usage, and current
     * extension filters do not affect it, so the filter menu does not collapse
     * while another filter is active.
     * @param {number} projectId
     * @returns {string[]}
     */
    listProjectAssetExtensions(projectId) {
      return this.getExtensions(projectId);
    },

    /**
     * Stable extension choices for the cross-project asset browser. The
     * optional project scope follows the same active-project semantics as
     * findAllAssets, while the unscoped form covers every active project.
     * @param {{ projectId?: number|null }} [filters]
     * @returns {string[]}
     */
    listAllAssetExtensions({ projectId } = {}) {
      const conditions = ['p.archived_at IS NULL', 'p.status <> ?', 'a.extension <> ?'];
      const params = ['archived', ''];

      if (projectId !== undefined && projectId !== null) {
        conditions.push('a.project_id = ?');
        params.push(projectId);
      }

      const sql = `
        SELECT DISTINCT LOWER(a.extension) AS extension
        FROM assets a
        JOIN projects p ON p.id = a.project_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY extension COLLATE NOCASE ASC
      `;
      return db.prepare(sql).pluck().all(...params);
    },

    // ─── Phase 6D: Asset Browser Queries ──────────────────────────────────

    /**
     * Build WHERE conditions and params for asset browser queries.
     * Shared by both findProjectAssetPage and countProjectAssets so they
     * always use identical filter predicates.
     *
     * @param {number} projectId
     * @param {object} filters
     * @param {string|null} [filters.search]
     * @param {string|null} [filters.extension]
     * @param {'all'|'present'|'missing'} [filters.presence]
     * @param {'all'|'used'|'unused'} [filters.usage]
     * @param {'all'|'uncategorized'|number} [filters.category]
     * @param {number|number[]} [filters.tag]
     * @param {number[]} [filters.tags]
     * @returns {{ conditions: string[], params: any[] }}
     */
     _buildAssetBrowserConditions(projectId, filters) {
      return buildProjectAssetBrowserConditions(projectId, filters);
    },

    /**
     * Paginated asset list for the asset browser.
     * Each asset includes a distinct count of releases that reference it.
     * Uses SQL LIMIT/OFFSET for efficient pagination.
     *
     * @param {number} projectId
     * @param {object} [filters]
     * @param {string|null} [filters.search=null]
     * @param {string|null} [filters.extension=null]
     * @param {'all'|'present'|'missing'} [filters.presence='all']
     * @param {'all'|'used'|'unused'} [filters.usage='all']
     * @param {number|number[]|null} [filters.tag=null]
     * @param {number[]} [filters.tags]
     * @param {number} [filters.page=1]
     * @param {number} [filters.pageSize=25]
     * @returns {Array<{id: number, project_id: number, relative_path: string, filename: string, extension: string, mime_type: string, size_bytes: number, modified_at: string|null, is_present: number, last_seen_at: string|null, missing_since: string|null, release_usage_count: number}>}
     */
    findProjectAssetPage(projectId, filters = {}) {
      const {
        search = null, extension = null, presence = 'all', usage = 'all', category = 'all', tag = null, tags,
        sort = 'filename', order = 'asc', page = 1, pageSize = 25,
      } = filters;

      const { conditions, params } = this._buildAssetBrowserConditions(projectId, {
        search,
        extension,
        presence,
        usage,
        category,
        tag: tags ?? tag,
      });

      const offset = (Math.max(1, page) - 1) * Math.max(1, pageSize);
      const orderClause = buildAssetBrowserOrderClause(sort, order);

      const sql = `
        SELECT
          ${buildAssetBrowserSelectColumns()}
        FROM assets a
        ${CATEGORY_JOIN}
        WHERE ${conditions.join(' AND ')}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

      return db.prepare(sql).all(...params, pageSize, offset);
    },

    /**
     * Paginated asset list across active projects for the future global asset
     * browser. Category filters use project-category directory slugs, not
     * project-local numeric category IDs.
     *
     * @param {object} [filters]
     * @param {number} [filters.projectId]
     * @param {string|null} [filters.search]
     * @param {string|null} [filters.extension] - legacy scalar alias
     * @param {string[]} [filters.extensions]
     * @param {'all'|'present'|'missing'} [filters.presence='all']
     * @param {'all'|'used'|'unused'} [filters.usage='all']
     * @param {'all'|'uncategorized'|string} [filters.category='all'] - legacy scalar alias
     * @param {string[]} [filters.categories]
     * @param {number|null} [filters.tag] - legacy scalar alias
     * @param {number[]} [filters.tags]
     * @param {'filename'|'modified'|'size'|'category'|'project'} [filters.sort='filename']
     * @param {'asc'|'desc'} [filters.order='asc']
     * @param {number} [filters.limit=25]
     * @param {number} [filters.offset=0]
     * @returns {Array}
     */
    findAllAssets(filters = {}) {
      const sort = filters.sort ?? filters.sortBy ?? 'filename';
      const order = filters.order ?? 'asc';
      const limit = filters.limit ?? 25;
      const offset = filters.offset ?? 0;
      const { conditions, params } = buildAllAssetBrowserConditions(filters);

      const sql = `
        SELECT
          ${buildAssetBrowserSelectColumns({ includeCategorySlug: true })},
          p.title AS project_title
        FROM assets a
        JOIN projects p ON p.id = a.project_id
        ${CATEGORY_JOIN}
        WHERE ${conditions.join(' AND ')}
        ${buildAssetBrowserOrderClause(sort, order, { includeProjectSort: true })}
        LIMIT ? OFFSET ?
      `;

      return db.prepare(sql).all(...params, limit, offset);
    },

    /**
     * Count assets using the exact filtering predicates as findAllAssets.
     * Active-project scope and category/usage predicates are expressed
     * without multiplying rows, so the count cannot inflate from joins.
     *
     * @param {object} [filters]
     * @param {number|null} [filters.tag] - legacy scalar alias
     * @param {number[]} [filters.tags]
     * @returns {number}
     */
    countAllAssets(filters = {}) {
      const { conditions, params } = buildAllAssetBrowserConditions(filters);
      const sql = `
        SELECT COUNT(*) AS c
        FROM assets a
        JOIN projects p ON p.id = a.project_id
        WHERE ${conditions.join(' AND ')}
      `;
      return db.prepare(sql).get(...params).c;
    },

    /**
     * Project-scoped asset viewer context for one asset.
     *
     * The current asset is loaded by project+asset identity, while the
     * adjacent IDs and filtered position are calculated from the complete
     * filtered browser result using the same deterministic ordering as
     * findProjectAssetPage. This keeps query count constant with project size
     * and avoids materializing all matching asset IDs in application memory.
     *
     * If the asset belongs to the project but is excluded by the filters, the
     * asset row is still returned with null position and adjacent IDs.
     * Unknown assets and cross-project assets return undefined.
     *
     * @param {number} projectId
     * @param {number} assetId
     * @param {object} [filters]
     * @param {string|null} [filters.search=null]
     * @param {string|null} [filters.extension=null]
     * @param {'all'|'present'|'missing'} [filters.presence='all']
     * @param {'all'|'used'|'unused'} [filters.usage='all']
     * @returns {undefined | {id: number, project_id: number, relative_path: string, filename: string, extension: string, mime_type: string, size_bytes: number, modified_at: string|null, is_present: number, last_seen_at: string|null, missing_since: string|null, release_usage_count: number, filtered_position: number|null, previous_asset_id: number|null, next_asset_id: number|null, filtered_total: number}}
     */
    findProjectAssetViewerContext(projectId, assetId, filters = {}) {
      const {
        search = null, extension = null, presence = 'all', usage = 'all', category = 'all',
        sort = 'filename', order = 'asc',
      } = filters;

      const { conditions, params } = this._buildAssetBrowserConditions(projectId, {
        search,
        extension,
        presence,
        usage,
        category,
      });

      const orderClause = buildAssetBrowserOrderClause(sort, order);
      const orderBody = orderClause.slice('ORDER BY '.length);

      const sql = `
        WITH filtered AS (
          SELECT
            a.id,
            ROW_NUMBER() OVER (ORDER BY ${orderBody}) AS filtered_position,
            LAG(a.id) OVER (ORDER BY ${orderBody}) AS previous_asset_id,
            LEAD(a.id) OVER (ORDER BY ${orderBody}) AS next_asset_id
          FROM assets a
          ${CATEGORY_JOIN}
          WHERE ${conditions.join(' AND ')}
        ),
        filtered_total AS (
          SELECT COUNT(*) AS total FROM filtered
        )
        SELECT
          ${buildAssetBrowserSelectColumns()},
          f.filtered_position,
          f.previous_asset_id,
          f.next_asset_id,
          filtered_total.total AS filtered_total
        FROM assets a
        ${CATEGORY_JOIN}
        CROSS JOIN filtered_total
        LEFT JOIN filtered f ON f.id = a.id
        WHERE a.project_id = ? AND a.id = ?
      `;

      return db.prepare(sql).get(...params, projectId, assetId);
    },

    /**
     * Count of matching assets for the asset browser.
     * Uses identical filter predicates as findProjectAssetPage.
     *
     * @param {number} projectId
     * @param {object} [filters]
     * @param {string|null} [filters.search=null]
     * @param {string|null} [filters.extension=null]
     * @param {'all'|'present'|'missing'} [filters.presence='all']
     * @param {'all'|'used'|'unused'} [filters.usage='all']
     * @param {number|number[]|null} [filters.tag=null]
     * @param {number[]} [filters.tags]
     * @returns {number}
     */
    countProjectAssets(projectId, filters = {}) {
      const {
        search = null,
        extension = null,
        presence = 'all',
        usage = 'all',
        category = 'all',
        tag = null,
        tags,
      } = filters;

      const { conditions, params } = this._buildAssetBrowserConditions(projectId, {
        search,
        extension,
        presence,
        usage,
        category,
        tag: tags ?? tag,
      });

      const sql = `SELECT COUNT(*) AS c FROM assets a WHERE ${conditions.join(' AND ')}`;
      const row = db.prepare(sql).get(...params);
      return row.c;
    },

    /**
     * Whole-project asset navigation counts for the asset browser: total
     * count, uncategorized count, missing count, and a total-per-category
     * breakdown (present + missing both contribute). Independent of the
     * active browser search/extension/presence/usage/category/pagination
     * filters. One bounded GROUP BY query — never one query per category.
     *
     * @param {number} projectId
     * @returns {{ total: number, uncategorized: number, missing: number, byCategoryId: Object<number, number> }}
     */
    getProjectAssetNavigationCounts(projectId) {
      const rows = db.prepare(`
        SELECT
          category_id,
          COUNT(*) AS total,
          SUM(CASE WHEN is_present = 0 THEN 1 ELSE 0 END) AS missing
        FROM assets
        WHERE project_id = ?
        GROUP BY category_id
      `).all(projectId);

      let total = 0;
      let uncategorized = 0;
      let missing = 0;
      const byCategoryId = {};

      for (const row of rows) {
        total += row.total;
        missing += row.missing;
        if (row.category_id === null) {
          uncategorized = row.total;
        } else {
          byCategoryId[row.category_id] = row.total;
        }
      }

      return { total, uncategorized, missing, byCategoryId };
    },

    /**
     * Minimal ordered asset rows for the project-scoped slideshow sequence.
     * Uses identical filter predicates and ordering as findProjectAssetPage
     * but fetches the complete matching set (no LIMIT/OFFSET) and only the
     * columns required to build preview URLs.
     *
     * @param {number} projectId
     * @param {object} [filters]
     * @returns {Array<{id: number, project_id: number, relative_path: string, filename: string, extension: string, mime_type: string, is_present: number, size_bytes: number, modified_at: string|null}>}
     */
    findProjectAssetSlideshowSequence(projectId, filters = {}) {
      const {
        search = null, extension = null, presence = 'all', usage = 'all', category = 'all',
        tag = null, tags, sort = 'filename', order = 'asc',
      } = filters;

      const { conditions, params } = this._buildAssetBrowserConditions(projectId, {
        search, extension, presence, usage, category, tag: tags ?? tag,
      });

      const orderClause = buildAssetBrowserOrderClause(sort, order);
      const sql = `
        SELECT a.id, a.project_id, a.relative_path, a.filename, a.extension, a.mime_type, a.is_present, a.size_bytes, a.modified_at
        FROM assets a
        ${CATEGORY_JOIN}
        WHERE ${conditions.join(' AND ')}
        ${orderClause}
      `;
      return db.prepare(sql).all(...params);
    },

    /**
     * Minimal ordered asset rows for the cross-project slideshow sequence.
     * Uses identical filter predicates and ordering as findAllAssets but
     * fetches the complete matching set (no LIMIT/OFFSET) and only the
     * columns required to build preview URLs.
     *
     * @param {object} [filters]
     * @returns {Array<{id: number, project_id: number, relative_path: string, filename: string, extension: string, mime_type: string, is_present: number, size_bytes: number, modified_at: string|null}>}
     */
    findAllAssetsSlideshowSequence(filters = {}) {
      const sort = filters.sort ?? filters.sortBy ?? 'filename';
      const order = filters.order ?? 'asc';
      const { conditions, params } = buildAllAssetBrowserConditions(filters);

      const sql = `
        SELECT a.id, a.project_id, a.relative_path, a.filename, a.extension, a.mime_type, a.is_present, a.size_bytes, a.modified_at
        FROM assets a
        JOIN projects p ON p.id = a.project_id
        ${CATEGORY_JOIN}
        WHERE ${conditions.join(' AND ')}
        ${buildAssetBrowserOrderClause(sort, order, { includeProjectSort: true })}
      `;
      return db.prepare(sql).all(...params);
    },
  };
}

/**
 * @typedef {object} AssetRecord
 * @property {number} id
 * @property {number} project_id
 * @property {number|null} category_id
 * @property {number|null} [category_record_id]
 * @property {number|null} [category_project_id]
 * @property {string|null} [category_display_name]
 * @property {string|null} [category_directory_slug]
 * @property {number|null} [category_display_order]
 * @property {number|null} [category_enabled]
 * @property {string} relative_path
 * @property {string} nested_path
 * @property {string} filename
 * @property {string} extension
 * @property {string} mime_type
 * @property {number} size_bytes
 * @property {string|null} modified_at
 * @property {number} is_present
 * @property {string|null} last_seen_at
 * @property {string|null} missing_since
 * @property {string} created_at
 * @property {string} updated_at
 */
