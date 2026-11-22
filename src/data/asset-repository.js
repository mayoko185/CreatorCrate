import {
  AssetPickerCursorError,
  decodeAssetPickerCursor,
  encodeAssetPickerCursor,
  normalizeAssetPickerLimit,
  normalizeAssetPickerQuery,
} from './asset-picker-pagination.js';
import { pathKey } from '../services/asset-processing-contracts.js';
import { classifyComicAsset } from '../services/asset-metadata.js';
import { JS_LOWER_SQL_FUNCTION, registerSqlFunctions } from '../db.js';

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
  'source_animated',
  'source_generation',
  'is_present',
  'last_seen_at',
  'missing_since',
  'generated_by',
  'generated_source_asset_id',
  'generated_source_relative_path',
  'generated_mode',
  'generated_variant',
  'generated_output_sha256',
  'generated_watermark_id',
  'created_at',
  'updated_at',
];

// ON CONFLICT(project_id, relative_path) for a newly written file: a restored
// row or a changed size/mtime is a new source instance. Re-upserting the same
// observed tuple keeps the generation.
const SOURCE_REPLACED_ON_CONFLICT = `CASE WHEN assets.is_present = 0
  OR assets.size_bytes IS NOT excluded.size_bytes
  OR assets.modified_at IS NOT excluded.modified_at THEN 1 ELSE 0 END`;

const NOTE_ASSOCIATION_ASSET_SELECT = `
  SELECT
    a.id,
    a.project_id,
    a.relative_path,
    a.filename,
    a.is_present,
    p.title AS project_title,
    CASE WHEN p.archived_at IS NOT NULL OR p.status = 'archived' THEN 1 ELSE 0 END AS project_is_archived
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

const ASSET_PROCESSING_SCOPE_ORDER = 'ORDER BY filename COLLATE NOCASE ASC, id ASC';

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
    'a.source_animated',
    'a.source_generation',
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

// ─── Release Manage Assets bounded pagination ───────────────────────────

/** Numeric Manage Assets page sizes (WP16 catalogue); 'all' is View All. */
export const MANAGE_ASSETS_PAGE_SIZES = Object.freeze([10, 25, 50, 100, 150, 200]);
export const MANAGE_ASSETS_DEFAULT_PAGE_SIZE = 25;
const MANAGE_ASSETS_PAGE_SIZE_TEXT = new Map([
  ...MANAGE_ASSETS_PAGE_SIZES.map((size) => [String(size), size]),
  ['all', 'all'],
]);

/**
 * One effective Manage Assets page size. Only an exact supported number, its
 * exact decimal string, or the exact string 'all' is honoured; anything else
 * (unsupported/oversized/negative/decimal numbers, 'ALL', repeated arrays,
 * missing) is the default 25 — never a custom size and never View All.
 * @param {unknown} value
 * @returns {number|'all'}
 */
export function normalizeManageAssetsPageSize(value) {
  if (typeof value === 'number') {
    return MANAGE_ASSETS_PAGE_SIZES.includes(value) ? value : MANAGE_ASSETS_DEFAULT_PAGE_SIZE;
  }
  if (typeof value === 'string' && MANAGE_ASSETS_PAGE_SIZE_TEXT.has(value)) {
    return MANAGE_ASSETS_PAGE_SIZE_TEXT.get(value);
  }
  return MANAGE_ASSETS_DEFAULT_PAGE_SIZE;
}

/**
 * Requested page number before clamping. Malformed values are page 1; a
 * well-formed positive integer beyond the safe-integer range saturates so it
 * clamps to the last page rather than overflowing the OFFSET arithmetic.
 * @param {unknown} value
 * @returns {number}
 */
function normalizeManageAssetsRequestedPage(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1) return 1;
    return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const page = Number(value);
    return Number.isSafeInteger(page) ? page : Number.MAX_SAFE_INTEGER;
  }
  return 1;
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Normalize the Manage Assets filter input with the existing service rules:
 * Search is a trimmed scalar string (blank/non-string is unrestricted);
 * Extension is a trimmed, lowercased scalar matching [a-z0-9._-]+ (anything
 * else is unrestricted); Selection is 'all' only for the exact scalar 'all'.
 * Category must already be validated by the service: null/undefined means all
 * categories, a positive safe integer restricts, anything else is a caller
 * error (never silently widened to all categories).
 */
function normalizeManageAssetsQuery(options) {
  const {
    releaseId, projectId, search, extension, categoryId, selection, page, pageSize,
  } = options ?? {};

  let normalizedCategoryId = null;
  if (categoryId !== undefined && categoryId !== null) {
    if (!isPositiveSafeInteger(categoryId)) {
      throw new TypeError('Manage Assets categoryId must be null or a positive safe integer.');
    }
    normalizedCategoryId = categoryId;
  }

  let normalizedExtension = null;
  if (typeof extension === 'string' && extension.trim() !== '') {
    const trimmed = extension.trim().toLowerCase();
    if (/^[a-z0-9._-]+$/.test(trimmed)) normalizedExtension = trimmed;
  }

  return {
    valid: isPositiveSafeInteger(releaseId) && isPositiveSafeInteger(projectId),
    releaseId,
    projectId,
    search: typeof search === 'string' && search.trim() !== '' ? search.trim() : null,
    extension: normalizedExtension,
    categoryId: normalizedCategoryId,
    selection: selection === 'all' ? 'all' : 'selected',
    requestedPage: normalizeManageAssetsRequestedPage(page),
    pageSize: normalizeManageAssetsPageSize(pageSize),
  };
}

/**
 * Fixed Manage Assets row source. The release row is joined by ID AND by the
 * caller's project ID, and assets are joined through the release's own
 * project, so a foreign or mismatched release/project pair yields no rows.
 * The membership join is on the (release_id, asset_id) primary key, so it can
 * match at most one row per asset and never duplicates an asset.
 */
const MANAGE_ASSETS_FROM = `
  FROM releases r
  JOIN assets a ON a.project_id = r.project_id
  LEFT JOIN release_assets ra ON ra.release_id = r.id AND ra.asset_id = a.id`;

const MANAGE_ASSETS_SCOPE = 'r.id = ? AND r.project_id = ? AND a.project_id = ?';

const MANAGE_ASSETS_ORDER = 'ORDER BY a.filename COLLATE NOCASE ASC, a.id ASC';

/**
 * The one authoritative Manage Assets predicate, shared by the filtered count
 * and the page/View All row reads. Only fixed internal fragments are composed;
 * every external value is a bound parameter.
 *
 * - Selected mode keeps saved members only (saved membership, not a draft).
 * - A saved member whose is_present is not 1 is always included (it can be
 *   retained or removed) even when Search/Category/Extension do not match.
 * - Every other row must be present AND satisfy every active filter, so a
 *   missing non-member is always excluded.
 * - Search is a literal, case-insensitive filename substring: the lowered
 *   term is compared with instr() against the JavaScript-lowercased filename
 *   (no LIKE, so %, _ and backslash are literal).
 *
 * @returns {{ where: string, params: Array<number|string> }}
 */
function buildManageAssetsPredicate(query) {
  const conditions = [MANAGE_ASSETS_SCOPE];
  const params = [query.releaseId, query.projectId, query.projectId];

  if (query.selection === 'selected') {
    conditions.push('ra.asset_id IS NOT NULL');
  }

  const presentFilters = ['a.is_present = 1'];
  if (query.categoryId !== null) {
    presentFilters.push('a.category_id = ?');
    params.push(query.categoryId);
  }
  if (query.extension !== null) {
    presentFilters.push(`${JS_LOWER_SQL_FUNCTION}(a.extension) = ?`);
    params.push(query.extension);
  }
  if (query.search !== null) {
    presentFilters.push(`instr(${JS_LOWER_SQL_FUNCTION}(a.filename), ?) > 0`);
    params.push(query.search.toLowerCase());
  }

  conditions.push(
    `((ra.asset_id IS NOT NULL AND a.is_present IS NOT 1) OR (${presentFilters.join(' AND ')}))`,
  );

  return { where: conditions.join(' AND '), params };
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
    const values = Array.isArray(filters.extension) ? filters.extension : [filters.extension];
    const selected = [...new Set(values
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim().replace(/^\./, '').toLowerCase())
      .filter((value) => value !== '' && !value.startsWith('.')))]
      .sort();
    if (selected.length > 0) {
      const placeholders = selected.map(() => '?').join(',');
      conditions.push(`LOWER(a.extension) IN (${placeholders})`);
      params.push(...selected);
    }
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
  // Same direct-or-inherited project-tag predicate as the Asset Library, so
  // filtering agrees with the "Inherited from Project" tag presentation.
  appendGlobalAssetTagCondition(conditions, params, filters.tags ?? filters.tag);
  return { conditions, params };
}

function readGlobalAssetSelection(filters, pluralKey, ...legacyKeys) {
  if (Object.hasOwn(filters, pluralKey) && filters[pluralKey] !== undefined) {
    return filters[pluralKey];
  }
  for (const key of legacyKeys) {
    if (filters[key] !== undefined && filters[key] !== null) return filters[key];
  }
  return undefined;
}

/**
 * Cross-project owning-Project restrictions shared by every Asset Library
 * query surface (page, count, slideshow and extension choices).
 *
 * - `projectIds` (legacy scalar `projectId`): asset belongs to any listed
 *   Project (OR within the dimension).
 * - `projectTypes`: owning Project's current `project_type` is any listed
 *   stable catalogue value (OR within the dimension).
 *
 * Dimensions are AND-ed with each other and with every other filter. An
 * omitted, null or empty selection imposes no restriction, so no empty IN()
 * is ever produced. A non-empty selection with no usable value fails closed
 * rather than silently meaning "all".
 */
function appendGlobalAssetProjectConditions(conditions, params, filters = {}) {
  const projectSelection = readGlobalAssetSelection(filters, 'projectIds', 'projectId', 'project_id');
  if (projectSelection !== undefined && projectSelection !== null) {
    const values = Array.isArray(projectSelection) ? projectSelection : [projectSelection];
    const ids = [...new Set(values
      .map((value) => (typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value))
      .filter((value) => Number.isSafeInteger(value) && value > 0))]
      .sort((left, right) => left - right);
    if (ids.length > 0) {
      conditions.push(`a.project_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    } else if (values.length > 0) {
      conditions.push('1 = 0');
    }
  }

  const typeSelection = readGlobalAssetSelection(filters, 'projectTypes', 'projectType');
  if (typeSelection !== undefined && typeSelection !== null) {
    const values = Array.isArray(typeSelection) ? typeSelection : [typeSelection];
    const types = [...new Set(values.filter((value) => typeof value === 'string' && value !== ''))].sort();
    if (types.length > 0) {
      conditions.push(`p.project_type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    } else if (values.length > 0) {
      conditions.push('1 = 0');
    }
  }
}

function buildAllAssetBrowserConditions(filters = {}) {
  const { conditions, params } = buildSharedAssetBrowserConditions({
    ...filters,
    extension: undefined,
  });

  // Active project browsing excludes either archive indicator. Normal archive
  // operations set both; checking both also avoids exposing transient
  // status-only archived rows in a read-only active browser.
  conditions.push('p.archived_at IS NULL', 'p.status <> ?');
  params.push('archived');

  appendGlobalAssetProjectConditions(conditions, params, filters);

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

function isGeneratedArtifactPathUniqueConstraintError(err) {
  return (
    err != null
    && err.code === 'SQLITE_CONSTRAINT_UNIQUE'
    && typeof err.message === 'string'
    && err.message.includes('generated_artifacts.project_id, generated_artifacts.relative_path')
  );
}

/**
 * Create an asset repository bound to a database connection.
 * @param {import('better-sqlite3').Database} db
 */
export function createAssetRepository(db) {
  // Manage Assets Search needs JavaScript-identical lowercasing; ensure the
  // function exists on this connection even when it was not opened through
  // openDatabase(). Idempotent per connection.
  registerSqlFunctions(db);

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

  const setSourceAnimationIfUnknownStmt = db.prepare(`
    UPDATE assets SET source_animated = ?
    WHERE id = ? AND project_id = ? AND relative_path = ?
      AND extension = ? AND size_bytes = ? AND modified_at IS ?
      AND is_present = 1 AND source_animated IS NULL
    RETURNING ${ASSET_COLUMNS.join(', ')}
  `);
  // Request-time source reconciliation: the WHERE clause pins the old
  // authoritative row (path/extension/size/mtime/animation/source generation),
  // SET writes the newly observed tuple and, in the same statement, advances
  // the source generation when a new source instance was established. A row a
  // scan or another request already moved on no longer matches and is left
  // untouched, so one observed transition never increments twice.
  const reconcileSourceStmt = db.prepare(`
    UPDATE assets SET size_bytes = ?, modified_at = ?, source_animated = ?,
      source_generation = source_generation + ?
    WHERE id = ? AND project_id = ? AND relative_path = ?
      AND extension = ? AND size_bytes = ? AND modified_at IS ?
      AND is_present = 1 AND source_animated IS ? AND source_generation = ?
    RETURNING ${ASSET_COLUMNS.join(', ')}
  `);

  const findAllForNoteAssociationStmt = db.prepare(
    `${NOTE_ASSOCIATION_ASSET_SELECT}${NOTE_ASSOCIATION_ASSET_ORDER}`
  );

  const findByPathStmt = db.prepare(`
    SELECT ${ASSET_COLUMNS.join(', ')}
    FROM assets
    WHERE project_id = ? AND relative_path = ?
  `);

  // Durable provenance of a generated output is internal ownership state for
  // processing, so it is read separately and never included in ASSET_COLUMNS.
  const findGeneratedOutputProvenanceStmt = db.prepare(`
    SELECT generated_output_provenance
    FROM assets
    WHERE project_id = ? AND id = ?
  `).pluck();
  // A rolled-back replacement restores the prior output's bytes as a new file, so the row's
  // provenance must describe that restored object. Compare-and-set against the provenance
  // and content the row held when processing began; nothing else about the row changes.
  const reconcileGeneratedOutputProvenanceStmt = db.prepare(`
    UPDATE assets
    SET generated_output_provenance = ?
    WHERE project_id = ?
      AND id = ?
      AND relative_path = ?
      AND generated_by = 'watermark'
      AND generated_output_sha256 IS ?
      AND generated_output_provenance IS ?
    RETURNING id
  `).pluck();
  const reconcileGeneratedOutputProvenanceTx = db.transaction((projectId, updates) => {
    if (!Array.isArray(updates)) {
      throw new TypeError('Generated output provenance reconciliation requires an array.');
    }
    for (const update of updates) {
      const reconciled = reconcileGeneratedOutputProvenanceStmt.get(
        update.provenance ?? null,
        projectId,
        update.assetId,
        update.expectedRelativePath,
        update.expectedGeneratedOutputSha256 ?? null,
        update.expectedProvenance ?? null,
      );
      if (reconciled === undefined) {
        const error = new Error('Generated output provenance did not match the expected database state.');
        error.code = 'STALE_STATE';
        throw error;
      }
    }
    return updates.length;
  });
  // The generated-artifact counterpart: a rolled-back archive replacement restores the prior
  // archive's bytes as a new file. Compare-and-set against the path, hash and provenance the
  // row held when processing began; nothing else about the row changes.
  const reconcileGeneratedArtifactProvenanceStmt = db.prepare(`
    UPDATE generated_artifacts
    SET output_provenance = ?
    WHERE project_id = ?
      AND id = ?
      AND relative_path = ?
      AND sha256 = ?
      AND output_provenance IS ?
    RETURNING id
  `).pluck();
  const reconcileGeneratedArtifactProvenanceTx = db.transaction((projectId, updates) => {
    if (!Array.isArray(updates)) {
      throw new TypeError('Generated artifact provenance reconciliation requires an array.');
    }
    for (const update of updates) {
      const reconciled = reconcileGeneratedArtifactProvenanceStmt.get(
        update.provenance ?? null,
        projectId,
        update.artifactId,
        update.expectedRelativePath,
        update.expectedSha256,
        update.expectedProvenance ?? null,
      );
      if (reconciled === undefined) {
        const error = new Error('Generated artifact provenance did not match the expected database state.');
        error.code = 'STALE_STATE';
        throw error;
      }
    }
    return updates.length;
  });

  const insertGeneratedArtifactStmt = db.prepare(`
    INSERT INTO generated_artifacts (
      project_id, relative_path, kind, generated_by, generated_mode, generated_watermark_id, sha256, size_bytes,
      output_provenance
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id, project_id, relative_path, kind, generated_by, generated_mode, generated_watermark_id, sha256, size_bytes, output_provenance, created_at, updated_at
  `);
  // output_provenance is always rewritten: a replacement records the new output's
  // provenance, or NULL when its publication was not strictly proven.
  const updateGeneratedArtifactStmt = db.prepare(`
    UPDATE generated_artifacts
    SET sha256 = ?, size_bytes = ?, generated_by = ?, generated_mode = ?, generated_watermark_id = ?,
        output_provenance = ?, updated_at = datetime('now')
    WHERE project_id = ? AND id = ? AND relative_path = ? AND kind = ? AND sha256 = ? AND generated_watermark_id IS ?
      AND output_provenance IS ?
    RETURNING id, project_id, relative_path, kind, generated_by, generated_mode, generated_watermark_id, sha256, size_bytes, output_provenance, created_at, updated_at
  `);

  const findPresentProjectAssetsStmt = db.prepare(`
    SELECT ${ASSET_COLUMNS.join(', ')}
    FROM assets
    WHERE project_id = ? AND is_present = 1
    ${ASSET_PROCESSING_SCOPE_ORDER}
  `);

  const findPresentProjectRootAssetsStmt = db.prepare(`
    SELECT ${ASSET_COLUMNS.join(', ')}
    FROM assets
    WHERE project_id = ?
      AND is_present = 1
      AND instr(relative_path, '/') = 0
    ${ASSET_PROCESSING_SCOPE_ORDER}
  `);

  const findPresentProjectDirectoryAssetsStmt = db.prepare(`
    SELECT ${ASSET_COLUMNS.join(', ')}
    FROM assets
    WHERE project_id = ?
      AND is_present = 1
      AND substr(relative_path, 1, length(?)) = ?
    ${ASSET_PROCESSING_SCOPE_ORDER}
  `);

  const findPresentProjectImmediateDirectoryAssetsStmt = db.prepare(`
    SELECT ${ASSET_COLUMNS.join(', ')}
    FROM assets
    WHERE project_id = ?
      AND is_present = 1
      AND substr(relative_path, 1, length(?)) = ?
      AND instr(substr(relative_path, length(?) + 1), '/') = 0
    ${ASSET_PROCESSING_SCOPE_ORDER}
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
    INSERT INTO assets (project_id, relative_path, category_id, nested_path, filename, extension, mime_type, size_bytes, modified_at, source_animated, is_present, last_seen_at, missing_since)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), NULL)
    ON CONFLICT(project_id, relative_path) DO UPDATE SET
      source_generation = assets.source_generation + (${SOURCE_REPLACED_ON_CONFLICT}),
      category_id = excluded.category_id,
      nested_path = excluded.nested_path,
      filename = excluded.filename,
      extension = excluded.extension,
      mime_type = excluded.mime_type,
      size_bytes = excluded.size_bytes,
      modified_at = excluded.modified_at,
      source_animated = excluded.source_animated,
      is_present = 1,
      last_seen_at = datetime('now'),
      missing_since = NULL,
      updated_at = datetime('now')
    RETURNING ${ASSET_COLUMNS.join(', ')}
  `);

  const insertConversionOutputStmt = db.prepare(`
    INSERT INTO assets (project_id, relative_path, category_id, nested_path, filename, extension, mime_type, size_bytes, modified_at, is_present, last_seen_at, missing_since)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), NULL)
    RETURNING ${ASSET_COLUMNS.join(', ')}
  `);

  const insertWatermarkOutputStmt = db.prepare(`
    INSERT INTO assets (project_id, relative_path, category_id, nested_path, filename, extension, mime_type, size_bytes, modified_at, is_present, last_seen_at, missing_since, generated_by, generated_source_asset_id, generated_source_relative_path, generated_mode, generated_variant, generated_output_sha256, generated_watermark_id, generated_output_provenance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), NULL, 'watermark', ?, ?, ?, ?, ?, ?, ?)
    RETURNING ${ASSET_COLUMNS.join(', ')}
  `);

  // Recreating a generated output is one new source instance: its tuple,
  // animation classification and generation advance land together. The WHERE
  // clause pins both the generated ownership and the source authority
  // (extension/size/mtime/presence/animation/source generation) captured
  // before rendering, so a scan or request-time reconciliation that
  // established newer authority meanwhile leaves this stale write unmatched.
  const updateWatermarkOutputStmt = db.prepare(`
    UPDATE assets
    SET relative_path = ?,
        filename = ?,
        extension = ?,
        mime_type = ?,
        category_id = ?,
        nested_path = ?,
        size_bytes = ?,
        modified_at = ?,
        source_animated = ?,
        is_present = 1,
        last_seen_at = datetime('now'),
        missing_since = NULL,
        generated_by = 'watermark',
        generated_source_asset_id = ?,
        generated_source_relative_path = ?,
        generated_mode = ?,
        generated_variant = ?,
        generated_output_sha256 = ?,
        generated_watermark_id = ?,
        generated_output_provenance = ?,
        source_generation = source_generation + 1,
        updated_at = datetime('now')
    WHERE project_id = ?
      AND id = ?
      AND relative_path = ?
      AND generated_by = 'watermark'
      AND generated_source_asset_id IS ?
      AND generated_source_relative_path IS ?
      AND generated_mode IS ?
      AND generated_variant IS ?
      AND generated_output_sha256 IS ?
      AND generated_watermark_id IS ?
      AND generated_output_provenance IS ?
      AND extension IS ?
      AND size_bytes IS ?
      AND modified_at IS ?
      AND is_present = ?
      AND source_animated IS ?
      AND source_generation = ?
      RETURNING ${ASSET_COLUMNS.join(', ')}
  `);

  // A validated publication is a new source even when size and mtime match.
  // Compare the captured source authority without changing catalogue ownership.
  const updateComicSourceStmt = db.prepare(`
    UPDATE assets
    SET size_bytes = ?, modified_at = ?, source_animated = NULL,
        source_generation = source_generation + 1,
        is_present = 1, last_seen_at = datetime('now'), missing_since = NULL,
        updated_at = datetime('now')
    WHERE project_id = ? AND id = ? AND relative_path = ?
      AND extension = ? AND size_bytes = ? AND modified_at IS ?
      AND is_present = ? AND source_animated IS ? AND source_generation = ?
    RETURNING ${ASSET_COLUMNS.join(', ')}
  `);

  // An in-place re-encode is one new source instance: the new tuple, the new
  // bytes' animation classification and the generation advance land together
  // so a later scan or Preview reconciliation finds nothing left to correct.
  const updateConversionReencodeStmt = db.prepare(`
    UPDATE assets
    SET size_bytes = ?,
        modified_at = ?,
        source_animated = ?,
        source_generation = source_generation + 1,
        is_present = 1,
        last_seen_at = datetime('now'),
        missing_since = NULL,
        updated_at = datetime('now')
    WHERE project_id = ?
      AND id = ?
      AND relative_path = ?
      AND size_bytes = ?
      AND modified_at IS ?
      AND is_present = 1
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
      data.sourceAnimated == null ? null : Number(data.sourceAnimated),
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

  const deleteMissingAssetStmt = db.prepare(`
    DELETE FROM assets
    WHERE project_id = ? AND id = ? AND relative_path = ? AND is_present = 0
    RETURNING ${ASSET_COLUMNS.join(', ')}
  `);

  const deleteMissingManyTx = db.transaction((projectId, expectedAssets) => {
    if (!Array.isArray(expectedAssets)) {
      throw new TypeError('Missing asset delete input must be an array.');
    }

    const deleted = [];
    for (const expected of expectedAssets) {
      const asset = deleteMissingAssetStmt.get(projectId, expected.assetId, expected.relativePath);
      if (!asset) {
        const error = new Error('Missing asset delete did not match the expected database state.');
        error.code = 'NOT_FOUND';
        throw error;
      }
      deleted.push(asset);
    }
    return deleted;
  });

  const selectExistingForReconcileStmt = db.prepare(`
    SELECT id, category_id, nested_path, relative_path, filename, extension, mime_type, size_bytes, modified_at, source_animated, is_present
    FROM assets
    WHERE project_id = ?
  `);

  const insertReconcileStmt = db.prepare(`
    INSERT INTO assets (project_id, relative_path, category_id, nested_path, filename, extension, mime_type, size_bytes, modified_at, source_animated, is_present, last_seen_at, missing_since)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), NULL)
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
        source_animated = ?,
        source_generation = source_generation + ?,
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

  const selectGeneratedArtifactPathsForReconcileStmt = db.prepare(`
    SELECT relative_path FROM generated_artifacts WHERE project_id = ?
  `);

  /**
   * Atomic scan reconciliation. Takes the complete discovered snapshot for a
   * project (already classified with categoryId/nestedPath) and applies it
   * in one transaction: inserts new paths, restores/updates existing ones
   * (including a path-derived-field-only repair when size/mtime match), and
   * marks undiscovered paths missing. Rolls back entirely on any failure.
   *
   * Supported comics may have both a catalogue row and generated-artifact
   * provenance; catalogue visibility does not grant replacement authority.
   * Other new artifact-owned paths remain excluded, matching the processing
   * planner's platform path key. Existing asset rows reconcile normally.
   *
   * @param {number} projectId
   * @param {Array<{relativePath: string, filename: string, extension: string, mimeType: string, sizeBytes: number, modifiedAt: string|null, categoryId: number|null, nestedPath: string}>} discovered
   * @returns {{ added: number, updated: number, removed: number, total: number }}
   */
  const reconcileScannedAssetsTx = db.transaction((projectId, discovered) => {
    const existingByPath = new Map(
      selectExistingForReconcileStmt.all(projectId).map((row) => [row.relative_path, row])
    );
    const generatedArtifactPathKeys = new Set(
      selectGeneratedArtifactPathsForReconcileStmt.all(projectId).map((row) => pathKey(row.relative_path))
    );

    let added = 0;
    let updated = 0;
    const discoveredPaths = [];

    for (const file of discovered) {
      const existing = existingByPath.get(file.relativePath);
      if (!existing && generatedArtifactPathKeys.has(pathKey(file.relativePath))
        && !classifyComicAsset(file).comic) continue;
      discoveredPaths.push(file.relativePath);
      const categoryId = file.categoryId ?? null;
      const nestedPath = file.nestedPath ?? '';
      const modifiedAt = file.modifiedAt || null;

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
          file.sourceAnimated == null ? null : Number(file.sourceAnimated),
        );
        added++;
        continue;
      }

      const sourceAnimated = file.sourceAnimated == null ? null : Number(file.sourceAnimated);
      // A restored row or a changed observed source is a new source instance;
      // path-derived repairs and first-time animation classification are not.
      const newSourceInstance =
        existing.is_present === 0 ||
        existing.size_bytes !== file.sizeBytes ||
        existing.modified_at !== modifiedAt ||
        (existing.source_animated != null && sourceAnimated != null
          && existing.source_animated !== sourceAnimated);
      const changed =
        newSourceInstance ||
        existing.category_id !== categoryId ||
        existing.nested_path !== nestedPath ||
        existing.filename !== file.filename ||
        existing.extension !== file.extension ||
        existing.mime_type !== file.mimeType ||
        existing.source_animated !== sourceAnimated;

      if (changed) {
        updateReconcileStmt.run(
          categoryId,
          nestedPath,
          file.filename,
          file.extension,
          file.mimeType,
          file.sizeBytes,
          modifiedAt,
          sourceAnimated,
          newSourceInstance ? 1 : 0,
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

  const applyAssetConversionsTx = db.transaction((projectId, {
    moves = [],
    deletes = [],
    outputs = [],
    reencodes = [],
  } = {}) => {
    if (!Array.isArray(moves) || !Array.isArray(deletes)
      || !Array.isArray(outputs) || !Array.isArray(reencodes)) {
      throw new TypeError('Asset conversion mutation input must contain arrays.');
    }

    const moved = moves.map((move) => executeAssetLocationUpdate(
      projectId,
      move.assetId,
      move.expectedOldRelativePath,
      move.data,
    ));

    const deleted = [];
    for (const expected of deletes) {
      const asset = deleteAssetStmt.get(projectId, expected.assetId, expected.relativePath);
      if (!asset) {
        const error = new Error('Asset conversion delete did not match the expected database state.');
        error.code = 'NOT_FOUND';
        throw error;
      }
      deleted.push(asset);
    }

    const reencoded = [];
    for (const update of reencodes) {
      const asset = updateConversionReencodeStmt.get(
        update.sizeBytes,
        update.modifiedAt || null,
        update.sourceAnimated == null ? null : Number(update.sourceAnimated),
        projectId,
        update.assetId,
        update.expectedRelativePath,
        update.expectedSizeBytes,
        update.expectedModifiedAt || null,
      );
      if (!asset) {
        const error = new Error('Asset conversion re-encode did not match the expected database state.');
        error.code = 'STALE_STATE';
        throw error;
      }
      reencoded.push(asset);
    }

    const inserted = [];
    for (const output of outputs) {
      try {
        inserted.push(insertConversionOutputStmt.get(
          projectId,
          output.relativePath,
          output.categoryId ?? null,
          output.nestedPath ?? '',
          output.filename,
          output.extension,
          output.mimeType,
          output.sizeBytes,
          output.modifiedAt || null,
        ));
      } catch (err) {
        if (isAssetPathUniqueConstraintError(err)) {
          const conflict = new Error('Asset conversion output destination conflicts with another row.');
          conflict.code = 'DESTINATION_CONFLICT';
          throw conflict;
        }
        throw err;
      }
    }

    return { moved, deleted, reencoded, outputs: inserted };
  });

  const applyAssetWatermarksTx = db.transaction((projectId, {
    replacements = [],
    deletes = [],
    outputs = [],
    artifactReplacements = [],
    artifactOutputs = [],
    comicSourceUpdates = [],
  } = {}) => {
    if (![replacements, deletes, outputs, artifactReplacements, artifactOutputs, comicSourceUpdates].every(Array.isArray)) {
      throw new TypeError('Asset watermark mutation input must contain arrays.');
    }

    const comicAssetIds = new Set();
    const comicPaths = new Set();
    for (const update of comicSourceUpdates) {
      const relativePath = update?.relativePath;
      const extension = update?.expectedExtension;
      if (!Number.isSafeInteger(update?.assetId) || update.assetId <= 0
        || typeof relativePath !== 'string' || /[\\:\u0000-\u001f\u007f]/.test(relativePath)
        || relativePath.split('/').some((part) => !part || part === '.' || part === '..')
        || typeof extension !== 'string' || !['cbz', 'cbr', 'cb7'].includes(extension.toLowerCase())
        || !relativePath.toLowerCase().endsWith(`.${extension.toLowerCase()}`)
        || !Number.isSafeInteger(update.expectedSourceGeneration) || update.expectedSourceGeneration < 0
        || update.expectedSourceGeneration >= Number.MAX_SAFE_INTEGER
        || !Number.isSafeInteger(update.expectedSizeBytes) || update.expectedSizeBytes < 0
        || !(update.expectedModifiedAt === null || typeof update.expectedModifiedAt === 'string')
        || ![0, 1, false, true].includes(update.expectedIsPresent)
        || ![null, 0, 1, false, true].includes(update.expectedSourceAnimated)
        || !Number.isSafeInteger(update.data?.sizeBytes) || update.data.sizeBytes < 0
        || typeof update.data?.modifiedAt !== 'string' || !Number.isFinite(Date.parse(update.data.modifiedAt))) {
        throw new TypeError('Comic source update requires a canonical comic path and captured source state.');
      }
      // Only a destination in this publication batch can change its indexed source.
      // This binding adds no replacement authority; artifact CAS checks still apply.
      const artifacts = [...artifactReplacements, ...artifactOutputs]
        .filter((artifact) => pathKey(artifact.relativePath) === pathKey(relativePath));
      if (artifacts.length !== 1 || artifacts[0].relativePath !== relativePath
        || artifacts[0].sizeBytes !== update.data.sizeBytes
        || comicAssetIds.has(update.assetId) || comicPaths.has(pathKey(relativePath))
        || [...replacements, ...deletes].some((entry) => entry.assetId === update.assetId)
        || [...outputs, ...replacements.map((entry) => entry.data), ...deletes]
          .some((entry) => pathKey(entry.relativePath) === pathKey(relativePath))) {
        const error = new Error('Comic source update conflicts with its publication destination.');
        error.code = 'DESTINATION_CONFLICT';
        throw error;
      }
      comicAssetIds.add(update.assetId);
      comicPaths.add(pathKey(relativePath));
    }

    const replaced = [];
    for (const replacement of replacements) {
      if (!Number.isSafeInteger(replacement.expectedSourceGeneration)) {
        throw new TypeError('Asset watermark replacement requires the expected source generation.');
      }
      const data = replacement.data;
      const asset = updateWatermarkOutputStmt.get(
        data.relativePath,
        data.filename,
        data.extension,
        data.mimeType,
        data.categoryId ?? null,
        data.nestedPath ?? '',
        data.sizeBytes,
        data.modifiedAt || null,
        data.sourceAnimated == null ? null : Number(data.sourceAnimated),
        replacement.generatedSourceAssetId,
        replacement.generatedSourceRelativePath ?? null,
        replacement.generatedMode,
        replacement.generatedVariant ?? null,
        replacement.generatedOutputSha256,
        replacement.generatedWatermarkId ?? null,
        replacement.generatedOutputProvenance ?? null,
        projectId,
        replacement.assetId,
        replacement.expectedOldRelativePath,
        replacement.expectedGeneratedSourceAssetId ?? null,
        replacement.expectedGeneratedSourceRelativePath ?? null,
        replacement.expectedGeneratedMode ?? null,
        replacement.expectedGeneratedVariant ?? null,
        replacement.expectedGeneratedOutputSha256 ?? null,
        replacement.expectedGeneratedWatermarkId ?? null,
        replacement.expectedGeneratedOutputProvenance ?? null,
        replacement.expectedExtension ?? null,
        replacement.expectedSizeBytes ?? null,
        replacement.expectedModifiedAt ?? null,
        replacement.expectedIsPresent ? 1 : 0,
        replacement.expectedSourceAnimated == null ? null : Number(replacement.expectedSourceAnimated),
        replacement.expectedSourceGeneration,
      );
      if (!asset) {
        const error = new Error('Asset watermark replacement did not match the expected database state.');
        error.code = 'STALE_STATE';
        throw error;
      }
      replaced.push(asset);
    }

    const deleted = [];
    for (const expected of deletes) {
      const asset = deleteAssetStmt.get(projectId, expected.assetId, expected.relativePath);
      if (!asset) {
        const error = new Error('Asset watermark delete did not match the expected database state.');
        error.code = 'NOT_FOUND';
        throw error;
      }
      deleted.push(asset);
    }

    const inserted = [];
    for (const output of outputs) {
      try {
        inserted.push(insertWatermarkOutputStmt.get(
          projectId,
          output.relativePath,
          output.categoryId ?? null,
          output.nestedPath ?? '',
          output.filename,
          output.extension,
          output.mimeType,
          output.sizeBytes,
          output.modifiedAt || null,
          output.generatedSourceAssetId,
          output.generatedSourceRelativePath ?? null,
          output.generatedMode,
          output.generatedVariant ?? null,
          output.generatedOutputSha256,
          output.generatedWatermarkId ?? null,
          output.generatedOutputProvenance ?? null,
        ));
      } catch (err) {
        if (isGeneratedArtifactPathUniqueConstraintError(err)) {
          const conflict = new Error('Asset watermark output destination conflicts with another row.');
          conflict.code = 'DESTINATION_CONFLICT';
          throw conflict;
        }
        throw err;
      }
    }

    const comicSourceUpdated = [];
    for (const update of comicSourceUpdates) {
      const asset = updateComicSourceStmt.get(
        update.data.sizeBytes,
        update.data.modifiedAt,
        projectId,
        update.assetId,
        update.relativePath,
        update.expectedExtension,
        update.expectedSizeBytes,
        update.expectedModifiedAt,
        Number(update.expectedIsPresent),
        update.expectedSourceAnimated === null ? null : Number(update.expectedSourceAnimated),
        update.expectedSourceGeneration,
      );
      if (!asset) {
        const error = new Error('Comic source update did not match the expected database state.');
        error.code = 'STALE_STATE';
        throw error;
      }
      comicSourceUpdated.push(asset);
    }

    const artifactReplaced = [];
    for (const artifact of artifactReplacements) {
      const updated = updateGeneratedArtifactStmt.get(
        artifact.sha256,
        artifact.sizeBytes,
        artifact.generatedBy,
        artifact.generatedMode ?? null,
        artifact.generatedWatermarkId ?? null,
        artifact.outputProvenance ?? null,
        projectId,
        artifact.id,
        artifact.relativePath,
        artifact.kind,
        artifact.expectedSha256,
        artifact.expectedGeneratedWatermarkId ?? null,
        artifact.expectedOutputProvenance ?? null,
      );
      if (!updated) {
        const error = new Error('Generated artifact replacement did not match the expected database state.');
        error.code = 'STALE_STATE';
        throw error;
      }
      artifactReplaced.push(updated);
    }
    const artifactInserted = [];
    for (const artifact of artifactOutputs) {
      try {
        artifactInserted.push(insertGeneratedArtifactStmt.get(
          projectId,
          artifact.relativePath,
          artifact.kind,
          artifact.generatedBy,
          artifact.generatedMode ?? null,
          artifact.generatedWatermarkId ?? null,
          artifact.sha256,
          artifact.sizeBytes,
          artifact.outputProvenance ?? null,
        ));
      } catch (err) {
        if (isGeneratedArtifactPathUniqueConstraintError(err)) {
          const conflict = new Error('Generated artifact destination conflicts with another row.');
          conflict.code = 'DESTINATION_CONFLICT';
          throw conflict;
        }
        throw err;
      }
    }

    return {
      replaced,
      deleted,
      outputs: inserted,
      artifactReplaced,
      artifactOutputs: artifactInserted,
      comicSourceUpdated,
    };
  });

  const updateAssetPromptMetadataStmt = db.prepare(`
    UPDATE assets
    SET size_bytes = ?,
        modified_at = ?,
        source_generation = source_generation + 1,
        is_present = 1,
        last_seen_at = datetime('now'),
        missing_since = NULL,
        updated_at = datetime('now')
    WHERE project_id = ?
      AND id = ?
      AND relative_path = ?
      AND size_bytes = ?
      AND modified_at IS ?
      AND is_present = 1
    RETURNING ${ASSET_COLUMNS.join(', ')}
  `);

  const applyAssetPromptEditsTx = db.transaction((projectId, updates) => {
    if (!Array.isArray(updates)) {
      throw new TypeError('Asset prompt edit input must be an array.');
    }

    const updated = [];
    for (const update of updates) {
      const asset = updateAssetPromptMetadataStmt.get(
        update.sizeBytes,
        update.modifiedAt || null,
        projectId,
        update.assetId,
        update.expectedRelativePath,
        update.expectedSizeBytes,
        update.expectedModifiedAt || null,
      );
      if (!asset) {
        const error = new Error('Asset prompt edit did not match the expected database state.');
        error.code = 'STALE_STATE';
        throw error;
      }
      updated.push(asset);
    }
    return updated;
  });

  const totalCountStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM assets
  `);

  const totalMissingCountStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM assets WHERE is_present = 0
  `);

  const activeProjectMissingCountStmt = db.prepare(`
    SELECT COUNT(*) AS c
    FROM assets
    JOIN projects ON projects.id = assets.project_id
    WHERE assets.is_present = 0
      AND projects.archived_at IS NULL
      AND projects.status <> 'archived'
  `);

  const presentCountByProjectStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM assets WHERE project_id = ? AND is_present = 1
  `);

  const assetIdsByProjectStmt = db.prepare('SELECT id FROM assets WHERE project_id = ? ORDER BY id');

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

    setSourceAnimationIfUnknown(asset, animated) {
      return setSourceAnimationIfUnknownStmt.get(
        animated, asset.id, asset.project_id, asset.relative_path,
        asset.extension, asset.size_bytes, asset.modified_at,
      );
    },

    /**
     * Conditionally replace an asset's source tuple (size/mtime and, for
     * GIF/WebP, `source_animated`) with a newly observed one. `source.animated`
     * undefined keeps the stored animation value (PNG/JPEG). Returns the
     * updated row, or undefined when `asset` is no longer the stored row.
     */
    reconcileSource(asset, source, { replaced = false } = {}) {
      const animated = source.animated === undefined
        ? asset.source_animated
        : Number(source.animated);
      // `replaced` is the caller's descriptor/path proof of a new file instance
      // even when the tuple compares equal; a known animation state flipping is
      // equally a different file. Learning an unknown animation state is not.
      const newSourceInstance = replaced
        || source.size !== asset.size_bytes
        || source.mtime !== asset.modified_at
        || (asset.source_animated != null && animated != null && animated !== asset.source_animated);
      return reconcileSourceStmt.get(
        source.size, source.mtime, animated, newSourceInstance ? 1 : 0,
        asset.id, asset.project_id, asset.relative_path,
        asset.extension, asset.size_bytes, asset.modified_at, asset.source_animated,
        asset.source_generation ?? 0,
      );
    },

    reconcileSourceAnimation(asset, source, animated) {
      return this.reconcileSource(asset, { size: source.size, mtime: source.mtime, animated });
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
     * Release Save validation lookup: only the ownership and presence columns
     * for the given IDs, in one bound-parameter statement. Returns no file
     * metadata, so classifying a foreign-project ID never loads that
     * project's asset details. Rows come back in no particular order and
     * unmatched IDs are absent; callers correlate by `id` and bound `ids`
     * (the release service batches at 500).
     * @param {number[]} ids
     * @returns {Array<{id: number, project_id: number, is_present: number}>}
     */
    findSelectionStatesByIds(ids) {
      if (!Array.isArray(ids) || ids.length === 0) return [];
      const unique = [...new Set(ids)];
      const placeholders = unique.map(() => '?').join(',');
      const sql = `SELECT id, project_id, is_present FROM assets WHERE id IN (${placeholders})`;
      return db.prepare(sql).all(...unique);
    },

    /**
     * Find indexed assets with the project context required by the Notes
     * association picker and detail page. Omitting ids returns every indexed
     * asset, including rows in archived projects and rows marked missing;
     * supplying ids restricts the same read model to those asset IDs.
     *
     * @param {number[]} [ids]
     * @returns {Array<{id: number, project_id: number, relative_path: string, filename: string, is_present: number, project_title: string, project_is_archived: number}>}
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
     * Bounded project-scoped asset lookup for asset selection. Missing assets
     * and assets in archived projects remain eligible by design.
     *
     * @param {{ projectId: number, query?: string, limit?: number, cursor?: string }} options
     * @returns {{ rows: Array<{id: number, project_id: number, filename: string, relative_path: string, is_present: number}>, nextCursor: string|null }}
     */
    searchAssetsForPicker(options = {}) {
      const { projectId } = options;
      if (!Number.isSafeInteger(projectId) || projectId <= 0) {
        throw new TypeError('Asset picker project ID must be a positive safe integer.');
      }

      const query = normalizeAssetPickerQuery(options.query);
      const limit = normalizeAssetPickerLimit(options.limit);
      const cursor = decodeAssetPickerCursor(options.cursor, 'asset-picker-assets');
      const conditions = ['a.project_id = ?'];
      const params = [projectId];

      if (query) {
        const term = `%${escapeLike(query)}%`;
        conditions.push("(a.filename COLLATE NOCASE LIKE ? ESCAPE '\\' OR a.relative_path COLLATE NOCASE LIKE ? ESCAPE '\\')");
        params.push(term, term);
      }

      if (cursor) {
        if (
          cursor.projectId !== projectId ||
          cursor.query !== query ||
          typeof cursor.filename !== 'string' ||
          !Number.isSafeInteger(cursor.id) ||
          cursor.id <= 0
        ) {
          throw new AssetPickerCursorError();
        }
        conditions.push('(a.filename COLLATE NOCASE > ? OR (a.filename COLLATE NOCASE = ? AND a.id > ?))');
        params.push(cursor.filename, cursor.filename, cursor.id);
      }

      const rows = db.prepare(`
        SELECT a.id, a.project_id, a.filename, a.relative_path, a.is_present
        FROM assets a
        WHERE ${conditions.join(' AND ')}
        ORDER BY a.filename COLLATE NOCASE ASC, a.id ASC
        LIMIT ?
      `).all(...params, limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);

      return {
        rows: page,
        nextCursor: hasMore
          ? encodeAssetPickerCursor({
            scope: 'asset-picker-assets', projectId, query, filename: last.filename, id: last.id,
          })
          : null,
      };
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
     * Assets-browser order (canonical filename ascending by default). This
     * intentionally has no filters, LIMIT, or OFFSET: Auto Rename must
     * receive the complete category membership rather than a browser subset.
     * The optional sort/order reuse the browser page's order clause, so a
     * filtered or paginated browser page is always a subsequence of this
     * complete order.
     *
     * @param {number} projectId
     * @param {number} categoryId
     * @param {{ sort?: string, order?: string }} [options] - active browser sort/direction
     * @returns {import('./asset-repository.js').AssetRecord[]}
     */
    findProjectAssetsByCategoryInBrowserOrder(projectId, categoryId, { sort = 'filename', order = 'asc' } = {}) {
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
        ${buildAssetBrowserOrderClause(sort, order)}
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
     * Find present assets beneath one project-relative directory. Directory
     * membership is determined from the stored relative_path boundary rather
     * than from category_id or filesystem traversal.
     *
     * @param {number} projectId
     * @param {string} relativeDirectory - Canonical project-relative directory; empty is root
     * @param {{ recursive?: boolean }} [options]
     * @returns {import('./asset-repository.js').AssetRecord[]}
     */
    findPresentProjectAssetsByDirectory(projectId, relativeDirectory, { recursive = false } = {}) {
      if (!Number.isSafeInteger(projectId) || projectId <= 0) return [];
      if (typeof relativeDirectory !== 'string' || typeof recursive !== 'boolean') return [];

      if (relativeDirectory === '') {
        return recursive
          ? findPresentProjectAssetsStmt.all(projectId)
          : findPresentProjectRootAssetsStmt.all(projectId);
      }

      const prefix = `${relativeDirectory}/`;
      if (recursive) {
        return findPresentProjectDirectoryAssetsStmt.all(
          projectId,
          prefix,
          prefix,
        );
      }

      return findPresentProjectImmediateDirectoryAssetsStmt.all(
        projectId,
        prefix,
        prefix,
        prefix,
      );
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
     * The persisted publication provenance of a generated output, or null when
     * none was recorded (legacy row, or a publication without strict proof).
     * @returns {string|null}
     */
    findGeneratedOutputProvenance(projectId, assetId) {
      return findGeneratedOutputProvenanceStmt.get(projectId, assetId) ?? null;
    },

    /**
     * Atomically rewrites the provenance of generated outputs whose prior bytes a rolled-back
     * processing run restored as new files. Every row must still hold the expected path,
     * output hash and provenance, or nothing changes (STALE_STATE).
     * @param {number} projectId
     * @param {Array<{assetId: number, expectedRelativePath: string, expectedGeneratedOutputSha256: string, expectedProvenance: string|null, provenance: string|null}>} updates
     * @returns {number} rows reconciled
     */
    reconcileGeneratedOutputProvenance(projectId, updates) {
      return reconcileGeneratedOutputProvenanceTx(projectId, updates);
    },

    /**
     * Atomically rewrites the provenance of generated artifacts (archives) whose prior bytes a
     * rolled-back processing run restored as new files. Every row must still hold the expected
     * path, hash and provenance, or nothing changes (STALE_STATE).
     * @param {number} projectId
     * @param {Array<{artifactId: number, expectedRelativePath: string, expectedSha256: string, expectedProvenance: string|null, provenance: string|null}>} updates
     * @returns {number} rows reconciled
     */
    reconcileGeneratedArtifactProvenance(projectId, updates) {
      return reconcileGeneratedArtifactProvenanceTx(projectId, updates);
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
        data.sourceAnimated == null ? null : Number(data.sourceAnimated),
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
     * Apply one already-completed conversion batch atomically. Filesystem
     * work is intentionally performed by the asset-processing service before
     * this method is called; this transaction only keeps the indexed rows
     * coherent when move/delete/insert/in-place re-encode changes are committed together.
     *
     * @param {number} projectId
     * @param {{moves?: Array, deletes?: Array, outputs?: Array, reencodes?: Array}} changes
     * @returns {{moved: Array, deleted: Array, outputs: Array, reencoded: Array}}
     */
    applyAssetConversions(projectId, changes) {
      return applyAssetConversionsTx(projectId, changes);
    },

    /**
     * Apply an already-completed watermark batch atomically. Generated rows
     * carry provenance so an explicit overwrite can never claim an unrelated
     * destination merely because its path matches the naming convention.
     *
     * Optional comicSourceUpdates refresh existing catalogue rows only. Each entry
     * binds assetId + projectId to the exact canonical relativePath of one artifact
     * output/replacement in this batch, with the same published sizeBytes. Capture
     * expected source fields before publication; data must come from the validated
     * public output, without new filesystem reads after final validation. Artifact
     * ownership and filesystem publication/rollback remain the caller's responsibility.
     * Every conditional mismatch throws STALE_STATE and rolls back the entire batch.
     *
     * @param {number} projectId
     * @param {object} changes
     * @param {Array<{assetId: number, relativePath: string, expectedExtension: string,
     *   expectedSizeBytes: number, expectedModifiedAt: string|null,
     *   expectedIsPresent: number|boolean, expectedSourceAnimated: number|boolean|null,
     *   expectedSourceGeneration: number, data: {sizeBytes: number, modifiedAt: string}}>}
     *   [changes.comicSourceUpdates]
     * @returns {{replaced: Array, deleted: Array, outputs: Array,
     *   artifactReplaced: Array, artifactOutputs: Array, comicSourceUpdated: Array}}
     */
    applyAssetWatermarks(projectId, changes) {
      return applyAssetWatermarksTx(projectId, changes);
    },

    /**
     * Update filesystem-derived metadata after an in-place prompt edit. The
     * expected row values make a stale caller fail without changing the asset
     * identity, path, category, or associations.
     *
     * @param {number} projectId
     * @param {Array<{assetId: number, expectedRelativePath: string, expectedSizeBytes: number, expectedModifiedAt: string|null, sizeBytes: number, modifiedAt: string|null}>} updates
     * @returns {import('./asset-repository.js').AssetRecord[]}
     */
    applyAssetPromptEdits(projectId, updates) {
      return applyAssetPromptEditsTx(projectId, updates);
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
     * Permanently delete several project-owned asset rows that are currently
     * marked missing. Each expected relative path is matched with its ID, and
     * the presence predicate is part of the DELETE so a present row can never
     * be removed through this operation. Foreign-key cascades remove asset
     * references according to the schema.
     * @param {number} projectId
     * @param {Array<{assetId: number, relativePath: string}>} expectedAssets
     * @returns {import('./asset-repository.js').AssetRecord[]}
     */
    deleteMissingMany(projectId, expectedAssets) {
      return deleteMissingManyTx(projectId, expectedAssets);
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
          source_generation = source_generation + 1,
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
     * Count assets for multiple projects in one query. Existing projects with
     * no assets are returned with zero counts. `missing_asset_count` counts
     * assets currently marked missing (is_present = 0).
     * @param {number[]} projectIds
     * @returns {Array<{project_id: number, asset_count: number, missing_asset_count: number}>}
     */
    countByProjectIds(projectIds) {
      const uniqueProjectIds = [...new Set(projectIds)];
      if (uniqueProjectIds.length === 0) return [];

      const placeholders = uniqueProjectIds.map(() => '?').join(', ');
      return db.prepare(`
        SELECT projects.id AS project_id,
               COUNT(assets.id) AS asset_count,
               COUNT(CASE WHEN assets.is_present = 0 THEN 1 END) AS missing_asset_count
        FROM projects
        LEFT JOIN assets ON assets.project_id = projects.id
        WHERE projects.id IN (${placeholders})
        GROUP BY projects.id
        ORDER BY projects.id ASC
      `).all(...uniqueProjectIds);
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
     * Count missing assets belonging to projects that are not archived by
     * either indicator (archived_at or the legacy 'archived' status).
     * @returns {number}
     */
    countMissingInActiveProjects() {
      return activeProjectMissingCountStmt.get().c;
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
     * Every asset id in a project (present or missing), regardless of any
     * browser filter or page.
     * @param {number} projectId
     * @returns {number[]}
     */
    findAssetIdsByProjectId(projectId) {
      return assetIdsByProjectStmt.all(projectId).map((row) => row.id);
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
     * optional Project / Project Type scope uses the same owning-Project
     * predicate as findAllAssets, while the unscoped form covers every
     * active project. Other asset filters deliberately do not narrow the
     * choices.
     * @param {{ projectId?: number|null, projectIds?: number[], projectTypes?: string[], includeArchived?: boolean }} [filters]
     * @returns {string[]}
     */
    listAllAssetExtensions({ includeArchived = false, ...scope } = {}) {
      const conditions = ['a.extension <> ?'];
      const params = [''];

      if (!includeArchived) {
        conditions.unshift('p.archived_at IS NULL', 'p.status <> ?');
        params.unshift('archived');
      }

      appendGlobalAssetProjectConditions(conditions, params, scope);

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
     * Uses SQL LIMIT/OFFSET for finite pagination and omits both for explicit
     * `pageSize: 'all'` requests.
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
     * @param {number|'all'} [filters.pageSize=25]
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

      const showAll = pageSize === 'all';
      const offset = showAll ? 0 : (Math.max(1, page) - 1) * Math.max(1, pageSize);
      const orderClause = buildAssetBrowserOrderClause(sort, order);
      const paginationClause = showAll ? '' : 'LIMIT ? OFFSET ?';

      const sql = `
        SELECT
          ${buildAssetBrowserSelectColumns()}
        FROM assets a
        ${CATEGORY_JOIN}
        WHERE ${conditions.join(' AND ')}
        ${orderClause}
        ${paginationClause}
      `;

      return showAll
        ? db.prepare(sql).all(...params)
        : db.prepare(sql).all(...params, pageSize, offset);
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
     * @param {number|null} [filters.limit=25] - null explicitly disables pagination
     * @param {number} [filters.offset=0]
     * @returns {Array}
     */
    findAllAssets(filters = {}) {
      const sort = filters.sort ?? filters.sortBy ?? 'filename';
      const order = filters.order ?? 'asc';
      const limit = Object.hasOwn(filters, 'limit') && filters.limit === null
        ? null
        : (filters.limit ?? 25);
      const offset = filters.offset ?? 0;
      const { conditions, params } = buildAllAssetBrowserConditions(filters);
      const paginationClause = limit === null ? '' : 'LIMIT ? OFFSET ?';

      const sql = `
        SELECT
          ${buildAssetBrowserSelectColumns({ includeCategorySlug: true })},
          p.title AS project_title,
          p.status AS project_status,
          p.project_type AS project_type,
          p.project_dir AS project_dir
        FROM assets a
        JOIN projects p ON p.id = a.project_id
        ${CATEGORY_JOIN}
        WHERE ${conditions.join(' AND ')}
        ${buildAssetBrowserOrderClause(sort, order, { includeProjectSort: true })}
        ${paginationClause}
      `;

      return limit === null
        ? db.prepare(sql).all(...params)
        : db.prepare(sql).all(...params, limit, offset);
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
          ${buildAssetBrowserSelectColumns({ includeCategorySlug: true })},
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
        SELECT a.id, a.project_id, a.relative_path, a.filename, a.extension, a.mime_type, a.is_present, a.size_bytes, a.modified_at, a.source_animated, a.source_generation
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
        SELECT a.id, a.project_id, a.relative_path, a.filename, a.extension, a.mime_type, a.is_present, a.size_bytes, a.modified_at, a.source_animated, a.source_generation
        FROM assets a
        JOIN projects p ON p.id = a.project_id
        ${CATEGORY_JOIN}
        WHERE ${conditions.join(' AND ')}
        ${buildAssetBrowserOrderClause(sort, order, { includeProjectSort: true })}
      `;
      return db.prepare(sql).all(...params);
    },

    /**
     * Bounded Release Manage Assets collection read.
     *
     * Issues one filtered COUNT statement and, when anything matched, one row
     * statement built from the same predicate. A numeric page reads at most
     * `pageSize` asset rows through SQL LIMIT/OFFSET after clamping the
     * requested page to `max(1, ceil(total / pageSize))`; only the exact
     * string 'all' is View All, which returns every matching row as page 1
     * of 1. Rows are ordered by filename (NOCASE) then asset ID.
     *
     * Both statements run inside one `db.transaction`, so they share a read
     * snapshot; inside a caller's outer transaction this nests as a
     * savepoint and joins the caller's snapshot.
     *
     * The caller (service) still owns release authorization, raw query
     * normalization and category existence/ownership validation; this read
     * re-enforces the release/project relationship in SQL regardless.
     *
     * @param {object} options
     * @param {number} options.releaseId
     * @param {number} options.projectId - must be the release's project
     * @param {string|null} [options.search]
     * @param {string|null} [options.extension]
     * @param {number|null} [options.categoryId] - validated project category ID
     * @param {'selected'|'all'|unknown} [options.selection] - exact 'all' only
     * @param {number|string} [options.page]
     * @param {number|string} [options.pageSize]
     * @returns {{
     *   rows: Array<AssetRecord & { is_saved_member: 0|1 }>,
     *   total: number,
     *   candidateTotal: number,
     *   page: number,
     *   pageCount: number,
     *   pageSize: number|'all',
     *   selection: 'selected'|'all',
     * }}
     */
    getManageAssetsPage(options = {}) {
      const query = normalizeManageAssetsQuery(options);
      const empty = {
        rows: [], total: 0, candidateTotal: 0, page: 1, pageCount: 1,
        pageSize: query.pageSize, selection: query.selection,
      };
      if (!query.valid) return empty;

      const { where, params } = buildManageAssetsPredicate(query);
      const read = db.transaction(() => {
        // candidateTotal: matching rows that are not saved members. Missing
        // non-members never match, so these are present eligible candidates.
        const counts = db.prepare(`
          SELECT
            COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN ra.asset_id IS NULL THEN 1 ELSE 0 END), 0) AS candidate_total
          ${MANAGE_ASSETS_FROM}
          WHERE ${where}
        `).get(...params);

        const total = counts.total;
        if (total === 0) return empty;

        const columns = `${ASSET_COLUMNS.map((column) => `a.${column}`).join(', ')},
          CASE WHEN ra.asset_id IS NULL THEN 0 ELSE 1 END AS is_saved_member`;

        if (query.pageSize === 'all') {
          const rows = db.prepare(`
            SELECT ${columns}
            ${MANAGE_ASSETS_FROM}
            WHERE ${where}
            ${MANAGE_ASSETS_ORDER}
          `).all(...params);
          return {
            rows, total, candidateTotal: counts.candidate_total, page: 1, pageCount: 1,
            pageSize: 'all', selection: query.selection,
          };
        }

        const pageCount = Math.max(1, Math.ceil(total / query.pageSize));
        const page = Math.min(query.requestedPage, pageCount);
        const offset = (page - 1) * query.pageSize;
        const rows = db.prepare(`
          SELECT ${columns}
          ${MANAGE_ASSETS_FROM}
          WHERE ${where}
          ${MANAGE_ASSETS_ORDER}
          LIMIT ? OFFSET ?
        `).all(...params, query.pageSize, offset);

        return {
          rows, total, candidateTotal: counts.candidate_total, page, pageCount,
          pageSize: query.pageSize, selection: query.selection,
        };
      });
      return read();
    },

    /**
     * Whole-project Manage Assets aggregates in one grouped statement:
     * category navigation counts (present and missing assets both count, as
     * on the project asset browser; uncategorized is its own bucket) and the
     * eligible present-asset totals. Independent of Search/Extension/
     * Category/Selection/page. Zero-count catalogue categories are absent
     * from `byCategoryId`; callers render them from the category catalogue
     * with 0. A mismatched release/project pair contributes nothing.
     *
     * @param {{ releaseId: number, projectId: number }} options
     * @returns {{
     *   categoryNavigation: { totalCount: number, uncategorizedCount: number, byCategoryId: Object<number, number> },
     *   eligibleAssetCount: number,
     *   eligibleCandidateCount: number,
     * }}
     */
    getManageAssetsAggregates({ releaseId, projectId } = {}) {
      const result = {
        categoryNavigation: { totalCount: 0, uncategorizedCount: 0, byCategoryId: {} },
        eligibleAssetCount: 0,
        eligibleCandidateCount: 0,
      };
      if (!isPositiveSafeInteger(releaseId) || !isPositiveSafeInteger(projectId)) return result;

      const rows = db.prepare(`
        SELECT
          a.category_id AS category_id,
          COUNT(*) AS total,
          SUM(CASE WHEN a.is_present = 1 THEN 1 ELSE 0 END) AS present,
          SUM(CASE WHEN a.is_present = 1 AND ra.asset_id IS NULL THEN 1 ELSE 0 END) AS present_candidates
        ${MANAGE_ASSETS_FROM}
        WHERE ${MANAGE_ASSETS_SCOPE}
        GROUP BY a.category_id
      `).all(releaseId, projectId, projectId);

      for (const row of rows) {
        result.categoryNavigation.totalCount += row.total;
        result.eligibleAssetCount += row.present;
        result.eligibleCandidateCount += row.present_candidates;
        if (row.category_id === null) {
          result.categoryNavigation.uncategorizedCount = row.total;
        } else {
          result.categoryNavigation.byCategoryId[row.category_id] = row.total;
        }
      }
      return result;
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
