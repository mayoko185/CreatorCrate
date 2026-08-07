import { createReleaseRepository, RELEASE_ASSET_ROLES } from '../data/release-repository.js';
import { createProjectRepository } from '../data/project-repository.js';
import { createAssetRepository } from '../data/asset-repository.js';
import { createAssetCategoryRepository } from '../data/asset-category-repository.js';
import { AssetCategoryNotFoundError } from './asset-category-service.js';
import { AssetCategoryValidationError } from './asset-category-validation.js';
import { buildReleaseAssetPagePresentation } from './release-asset-presenter.js';
import { formatLocalDate, formatLocalTime, getLocalTodayIso } from '../util/date.js';
import { isValidWebUrl } from '../util/url.js';

export class ReleaseValidationError extends Error {
  constructor(errors) {
    super('Release validation failed');
    this.name = 'ReleaseValidationError';
    this.errors = errors;
  }
}

export class ReleaseNotFoundError extends Error {
  constructor(id) {
    super(`Release ${id} not found`);
    this.name = 'ReleaseNotFoundError';
    this.status = 404;
  }
}

export class ReleaseArchivedError extends Error {
  constructor(id) {
    super(`Release ${id} is archived and cannot be modified.`);
    this.name = 'ReleaseArchivedError';
    this.status = 422;
  }
}

/**
 * Thrown when a release mutation is attempted for a release whose parent
 * project has been archived. Archived projects are immutable, so any attempt
 * to update, publish, archive, or mutate asset selection on a release inside
 * an archived project must fail with this error.
 */
export class ReleaseParentArchivedError extends Error {
  constructor(projectId) {
    super(`Project ${projectId} is archived and cannot be modified.`);
    this.name = 'ReleaseParentArchivedError';
    this.status = 422;
  }
}

/**
 * Thrown when a release-asset mutation is attempted on a published release.
 * Published releases have locked asset selections — no additions, removals,
 * role changes, or sort-order changes are permitted. Scans may still update
 * asset presence and metadata.
 */
export class ReleasePublishedError extends Error {
  constructor(id) {
    super(`Release ${id} is published and its asset selection is locked.`);
    this.name = 'ReleasePublishedError';
    this.status = 422;
  }
}

export class AssetNotFoundError extends Error {
  constructor(id) {
    super(`Asset ${id} not found`);
    this.name = 'AssetNotFoundError';
    this.status = 404;
  }
}

const TITLE_MIN = 1;
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 4000;
const NOTES_MAX = 10000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isValidDate(value) {
  if (!value) return true;
  if (!DATE_RE.test(value)) return false;
  const [yearStr, monthStr, dayStr] = value.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function isValidTime(value) {
  if (!value) return true;
  if (!TIME_RE.test(value)) return false;
  const [hourStr, minuteStr] = value.split(':');
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return false;
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

/**
 * Strict positive-integer validator. Rejects malformed strings like "1junk",
 * "2.5", "1e2", "+2", "-2", or "0". Returns null for invalid values.
 * @param {unknown} value
 * @returns {number|null}
 */
function parseStrictPositiveInt(value) {
  if (value == null) return null;
  const str = String(value);
  if (!/^[1-9]\d*$/.test(str)) return null;
  const num = Number(str);
  if (!Number.isInteger(num) || num < 1) return null;
  return num;
}

function normalizeOptionalCategoryId(value) {
  if (value === undefined || value === null || value === '') return null;

  const text = typeof value === 'string' ? value.trim() : String(value);
  if (!/^[1-9]\d*$/.test(text)) {
    const error = new AssetCategoryValidationError({ categoryId: 'categoryId must be a positive integer.' });
    error.status = 422;
    throw error;
  }

  const id = Number(text);
  if (!Number.isSafeInteger(id) || id <= 0) {
    const error = new AssetCategoryValidationError({ categoryId: 'categoryId must be a positive integer.' });
    error.status = 422;
    throw error;
  }
  return id;
}

function normalizeRequiredCategoryId(value) {
  const id = normalizeOptionalCategoryId(value);
  if (id !== null) return id;

  const error = new AssetCategoryValidationError({ categoryId: 'categoryId must be a positive integer.' });
  error.status = 422;
  throw error;
}

function readCategoryFilter(rawQuery) {
  if (!rawQuery || typeof rawQuery !== 'object' || Array.isArray(rawQuery)) return undefined;
  if (Object.hasOwn(rawQuery, 'categoryId')) return rawQuery.categoryId;
  if (Object.hasOwn(rawQuery, 'category')) return rawQuery.category;
  return undefined;
}

function matchesReleaseAssetFilters(asset, filters, categoryId) {
  if (categoryId !== null && asset.category_id !== categoryId) return false;

  if (filters.extension && String(asset.extension || '').toLowerCase() !== filters.extension) {
    return false;
  }

  if (filters.search && !String(asset.filename || '').toLowerCase().includes(filters.search.toLowerCase())) {
    return false;
  }

  return true;
}

export function createReleaseService({ db, evaluateReleaseReadiness }) {
  const repository = createReleaseRepository(db);
  const projectRepository = createProjectRepository(db);
  const assetRepository = createAssetRepository(db);
  const assetCategoryRepository = createAssetCategoryRepository(db);

  function validate(input) {
    const errors = {};

    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (title.length < TITLE_MIN) {
      errors.title = 'Title is required.';
    } else if (title.length > TITLE_MAX) {
      errors.title = `Title must be ${TITLE_MAX} characters or fewer.`;
    }

    const description = typeof input.description === 'string' ? input.description : '';
    if (description.length > DESCRIPTION_MAX) {
      errors.description = `Description must be ${DESCRIPTION_MAX} characters or fewer.`;
    }

    const notes = typeof input.notes === 'string' ? input.notes : '';
    if (notes.length > NOTES_MAX) {
      errors.notes = `Notes must be ${NOTES_MAX} characters or fewer.`;
    }

    const plannedDate = input.plannedDate || null;
    const submittedPlannedTime = input.plannedTime || null;
    if (!isValidDate(plannedDate)) {
      errors.plannedDate = 'Planned date must be a valid date (YYYY-MM-DD).';
    }
    if (submittedPlannedTime != null && !isValidTime(submittedPlannedTime)) {
      errors.plannedTime = 'Planned time must be a valid time (HH:MM).';
    }
    const plannedTime = plannedDate ? submittedPlannedTime : null;

    const publishedDate = input.publishedDate || null;
    if (!isValidDate(publishedDate)) {
      errors.publishedDate = 'Published date must be a valid date (YYYY-MM-DD).';
    }

    const patreonUrl = input.patreonUrl || null;
    if (!isValidWebUrl(patreonUrl)) {
      errors.patreonUrl = 'Release link must be a valid absolute HTTP or HTTPS URL.';
    }

    if (Object.keys(errors).length > 0) {
      throw new ReleaseValidationError(errors);
    }

    return {
      title,
      description,
      notes,
      plannedDate,
      plannedTime,
      publishedDate,
      patreonUrl,
    };
  }

  function validateProjectExists(projectId) {
    const project = projectRepository.findById(projectId);
    if (!project) {
      throw new ReleaseValidationError({ projectId: 'Project not found.' });
    }
    // Both archive indicators must be checked — a row can disagree (e.g.
    // status='archived' with a NULL archived_at), and either one means the
    // project is not valid release-create context.
    if (project.archived_at || project.status === 'archived') {
      throw new ReleaseValidationError({ projectId: 'Cannot create release for archived project.' });
    }
    return project;
  }

  /**
   * Validate and normalize an ordered asset selection without mutating any
   * release state. The create-from-assets flow reuses this contract before
   * building its release and junction rows.
   *
   * @param {number|string} projectId
   * @param {Array<number|string>} assetIds
   * @returns {{ project: object, assetIds: number[] }}
   */
  function validateAndNormalizeSelectedAssetIds(projectId, assetIds) {
    const normalizedProjectId = parseStrictPositiveInt(projectId);
    if (normalizedProjectId === null) {
      throw new ReleaseValidationError({ projectId: 'projectId must be a positive integer.' });
    }

    const project = validateProjectExists(normalizedProjectId);
    if (!Array.isArray(assetIds) || assetIds.length === 0) {
      throw new ReleaseValidationError({ assetIds: 'At least one asset must be selected.' });
    }

    const normalizedAssetIds = [];
    const seen = new Set();
    for (const raw of assetIds) {
      const id = parseStrictPositiveInt(raw);
      if (id === null) {
        throw new ReleaseValidationError({ assetIds: 'Asset IDs must be positive integers.' });
      }
      if (seen.has(id)) continue;
      seen.add(id);
      normalizedAssetIds.push(id);
    }

    const assets = assetRepository.findByIds(normalizedAssetIds);
    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    for (const id of normalizedAssetIds) {
      const asset = assetsById.get(id);
      if (!asset) {
        throw new AssetNotFoundError(id);
      }
      if (asset.project_id !== project.id) {
        throw new ReleaseValidationError({
          assets: `Asset ${id} does not belong to the specified project.`,
        });
      }
      if (asset.is_present !== 1) {
        throw new ReleaseValidationError({
          assets: `Asset ${id} is currently missing and cannot be selected.`,
        });
      }
    }

    return { project, assetIds: normalizedAssetIds };
  }

  /**
   * Guard against operating on an archived release.
   * @param {ReleaseRecord} release
   * @throws {ReleaseArchivedError}
   */
  function guardReleaseNotArchived(release) {
    if (release.archived_at) {
      throw new ReleaseArchivedError(release.id);
    }
  }

  /**
   * Shared guard: reject a release mutation when the parent project has been
   * archived. Archived projects are immutable, so any update, publish,
   * archive, or asset-selection mutation on a release inside such a project
   * must fail with {@link ReleaseParentArchivedError}. Read operations are
   * unaffected — the project remains queryable through findRelease,
   * listReleaseAssets, etc.
   *
   * @param {number} projectId
   * @throws {ReleaseParentArchivedError} when the project is archived
   */
  function guardParentProjectNotArchived(projectId) {
    const parent = projectRepository.findById(projectId);
    if (parent && parent.archived_at) {
      throw new ReleaseParentArchivedError(projectId);
    }
  }

  /**
   * Shared guard: reject a release-asset mutation when publication data exists.
   * Published releases have locked asset selections — the junction table rows
   * (asset_id, role, sort_order) are immutable. Scans may still
   * update asset presence and metadata on the assets table, but the
   * release_assets rows themselves must not change.
   *
   * This guard runs before any junction-table mutation in every public
   * release-asset mutation method.
   *
   * @param {ReleaseRecord} release
   * @throws {ReleasePublishedError}
   */
  function guardReleaseNotPublished(release) {
    if (release.published_date != null) {
      throw new ReleasePublishedError(release.id);
    }
  }

  return {
    repository,

    /**
     * @param {number} projectId
     * @param {Object} input
     * @returns {ReleaseRecord}
     */
    createRelease(projectId, input) {
      validateProjectExists(projectId);
      const normalized = validate(input);
      return repository.create({ projectId, ...normalized });
    },

    /**
     * Create a release from normal release-form metadata and a submitted set
     * of selected project assets. Asset validation completes before the
     * repository transaction creates anything; the repository then inserts
     * the release and all attachment rows atomically.
     *
     * @param {number|string} projectId
     * @param {Object} input
     * @param {Array<number|string>} assetIds
     * @returns {ReleaseRecord}
     */
    createReleaseWithSelectedAssets(projectId, input, assetIds) {
      const { project, assetIds: normalizedAssetIds } = validateAndNormalizeSelectedAssetIds(projectId, assetIds);
      const normalized = validate(input);

      const selections = normalizedAssetIds.map((assetId, sortOrder) => ({
        assetId,
        role: 'attachment',
        sortOrder,
      }));

      return repository.createWithAssetSelections(
        { projectId: project.id, ...normalized },
        selections,
      );
    },

    /**
     * Validate and normalize a selected project-owned asset set without
     * creating a release or changing any asset association.
     *
     * @param {number|string} projectId
     * @param {Array<number|string>} assetIds
     * @returns {number[]}
     */
    validateAndNormalizeSelectedAssetIds(projectId, assetIds) {
      return validateAndNormalizeSelectedAssetIds(projectId, assetIds).assetIds;
    },

    /**
     * Create a release from the currently present assets in one project-owned
     * category. The returned release ID is sufficient for a caller to build
     * the existing release edit or asset-management URL.
     *
     * @param {number|string} projectId
     * @param {number|string} categoryId
     * @returns {ReleaseRecord}
     */
    createReleaseFromCategory(projectId, categoryId) {
      const normalizedProjectId = parseStrictPositiveInt(projectId);
      if (normalizedProjectId === null) {
        throw new ReleaseValidationError({ projectId: 'projectId must be a positive integer.' });
      }

      const project = validateProjectExists(normalizedProjectId);
      const normalizedCategoryId = normalizeRequiredCategoryId(categoryId);
      const category = assetCategoryRepository.findProjectCategoryById(
        project.id,
        normalizedCategoryId,
      );
      if (!category) {
        throw new AssetCategoryNotFoundError(normalizedCategoryId);
      }

      const now = new Date();
      const normalized = validate({
        title: category.display_name,
        description: '',
        notes: '',
        plannedDate: formatLocalDate(now),
        plannedTime: formatLocalTime(now),
        publishedDate: null,
        patreonUrl: null,
      });
      const selections = assetRepository
        .findProjectAssetsByCategoryInBrowserOrder(project.id, category.id)
        .filter((asset) => asset.is_present === 1)
        .map((asset, sortOrder) => ({
          assetId: asset.id,
          role: 'attachment',
          sortOrder,
        }));

      return repository.createWithAssetSelections(
        { projectId: project.id, ...normalized },
        selections,
      );
    },

    /**
     * Create a release from a selected, ordered set of present project assets.
     *
     * @param {number|string} projectId
     * @param {Array<number|string>} assetIds
     * @returns {ReleaseRecord}
     */
    createReleaseFromAssets(projectId, assetIds) {
      const { project, assetIds: normalizedAssetIds } = validateAndNormalizeSelectedAssetIds(projectId, assetIds);

      const now = new Date();
      const normalized = validate({
        title: project.title,
        description: '',
        notes: '',
        plannedDate: formatLocalDate(now),
        plannedTime: formatLocalTime(now),
        publishedDate: null,
        patreonUrl: null,
      });
      const selections = normalizedAssetIds.map((assetId, sortOrder) => ({
        assetId,
        role: 'attachment',
        sortOrder,
      }));

      return repository.createWithAssetSelections(
        { projectId: project.id, ...normalized },
        selections,
      );
    },

    /**
     * @param {number} id
     * @param {Object} input
     * @returns {ReleaseRecord}
     */
    updateRelease(id, input) {
      const release = repository.findById(id);
      if (!release) {
        throw new ReleaseNotFoundError(id);
      }

      // Reject mutations when the parent project has been archived. Archived
      // projects are immutable — releases inside them are read-only.
      guardParentProjectNotArchived(release.project_id);

      // Reject mutations when the release itself is archived.
      guardReleaseNotArchived(release);

      // Validate project still exists and is not archived
      validateProjectExists(release.project_id);

      // Default missing metadata and scheduling values to the existing release
      // values so the edit form can omit those fields without clearing them.
      const inputWithDefaults = {
        title: input.title ?? release.title,
        description: input.description ?? release.description,
        notes: input.notes ?? release.notes,
        plannedDate: input.plannedDate ?? release.planned_date,
        plannedTime: input.plannedTime ?? release.planned_time,
        publishedDate: input.publishedDate ?? release.published_date,
        patreonUrl: input.patreonUrl ?? release.patreon_url,
        ...input,
      };
      const normalized = validate(inputWithDefaults);
      const updated = repository.update(id, normalized);
      if (!updated) {
        throw new ReleaseNotFoundError(id);
      }
      return updated;
    },

    /**
     * Publish a release. Sets published_date to today if not provided.
     * Only releases whose owning project is ready can be published.
     * Enforces the shared readiness policy before publishing.
     * @param {number} id
     * @param {string} [publishedDate] - ISO date string YYYY-MM-DD, defaults to today
     * @returns {ReleaseRecord}
     */
    publishRelease(id, publishedDate = null) {
      const release = repository.findById(id);
      if (!release) {
        throw new ReleaseNotFoundError(id);
      }

      // Reject mutations when the parent project has been archived. Archived
      // projects are immutable — releases inside them cannot be published.
      guardParentProjectNotArchived(release.project_id);

      if (release.archived_at) {
        throw new ReleaseArchivedError(id);
      }

      if (release.published_date != null) {
        throw new ReleaseValidationError({ general: 'Release is already published.' });
      }

      if (release.project_status !== 'ready') {
        throw new ReleaseValidationError({ general: 'Only releases whose project status is "ready" can be published.' });
      }

      // ── Phase 7C-1: Enforce release readiness ──────────────────────────
      // Load readiness facts through the repository and evaluate them
      // through the shared readiness policy. No policy logic is duplicated
      // here — publishRelease only interprets the result.
      const facts = repository.findReadinessFactsById(id);
      if (!facts) {
        throw new ReleaseNotFoundError(id);
      }

      const readiness = evaluateReleaseReadiness(facts);
      if (!readiness.publishable) {
        const errors = {};
        for (const check of readiness.checks) {
          if (!check.passed) {
            errors[check.key] = check.details;
          }
        }
        throw new ReleaseValidationError({ readiness: errors });
      }

      const date = publishedDate || getLocalTodayIso();
      if (!isValidDate(date)) {
        throw new ReleaseValidationError({ publishedDate: 'Published date must be a valid date (YYYY-MM-DD).' });
      }

      const updated = repository.publish(id, date);
      if (!updated) {
        throw new ReleaseNotFoundError(id);
      }
      return updated;
    },

    /**
     * Archive a release by setting archived_at.
     * @param {number} id
     * @returns {ReleaseRecord}
     */
    archiveRelease(id) {
      const release = repository.findById(id);
      if (!release) {
        throw new ReleaseNotFoundError(id);
      }

      // Reject mutations when the parent project has been archived. The
      // release is already inside an archived project; archiving the
      // release itself adds no information and the operation must be
      // rejected.
      guardParentProjectNotArchived(release.project_id);

      if (release.archived_at) {
        throw new ReleaseArchivedError(id);
      }

      const archived = repository.archive(id);
      if (!archived) {
        throw new ReleaseNotFoundError(id);
      }
      return archived;
    },

    /**
     * @param {number} id
     * @returns {ReleaseRecord|undefined}
     */
    findRelease(id) {
      return repository.findById(id);
    },

    /**
     * @param {number} projectId
     * @param {Object} [options]
     * @param {boolean} [options.includeArchived]
     * @param {string} [options.sortBy]
     * @param {string} [options.order]
     * @returns {ReleaseRecord[]}
     */
    listReleases(projectId, options) {
      return repository.findByProjectId(projectId, options);
    },

    /**
     * The repository must not compute `today` itself — callers must inject
     * a single application-local date boundary so all dashboard sections
     * stay consistent.
     * @param {string} today ISO date string YYYY-MM-DD
     * @returns {ReleaseRecord[]}
     */
    upcomingReleases(today) {
      return repository.upcomingReleases(today);
    },

    /**
     * The repository must not compute `today` itself — callers must inject
     * a single application-local date boundary so all dashboard sections
     * stay consistent.
     * @param {string} today ISO date string YYYY-MM-DD
     * @returns {ReleaseRecord[]}
     */
    overdueReleases(today) {
      return repository.overdueReleases(today);
    },

    // ─── Release Asset Selection ───────────────────────────────────────────

    /**
     * List assets selected for a release.
     * @param {number} releaseId
     * @returns {Array}
     */
    listReleaseAssets(releaseId) {
      const release = repository.findById(releaseId);
      if (!release) {
        throw new ReleaseNotFoundError(releaseId);
      }
      return repository.listReleaseAssets(releaseId);
    },

    /**
     * Build the normalized, selected-only asset presentation for the release
     * detail page. The editable asset-management collection is intentionally
     * not loaded here.
     *
     * @param {number} releaseId
     * @param {Array} [selectedAssets]
     * @returns {{ selected: Array, candidates: Array, assets: Array }}
     */
    getReleaseAssetPresentation(releaseId, selectedAssets = null) {
      const release = repository.findById(releaseId);
      if (!release) {
        throw new ReleaseNotFoundError(releaseId);
      }

      const rows = Array.isArray(selectedAssets)
        ? selectedAssets
        : repository.listReleaseAssets(releaseId);
      const categories = assetCategoryRepository.listProjectCategories(release.project_id);

      return buildReleaseAssetPagePresentation({
        selectedAssets: rows,
        assets: [],
        candidateAssets: [],
        categories,
      });
    },

    /**
     * Validate selection input.
     * @param {Array<{assetId: number, role?: string, sortOrder?: number}>} selections
     * @param {number} releaseId
     * @throws {ReleaseValidationError}
     * @returns {{ assetIds: number[], cleaned: Array<{assetId: number, role: string, sortOrder: number}> }}
     */
    validateSelections(selections, releaseId) {
      const errors = {};
      const assetIds = [];

      if (!Array.isArray(selections)) {
        errors.selections = 'Selections must be an array.';
        throw new ReleaseValidationError(errors);
      }

      if (selections.length === 0) {
        return { assetIds: [], cleaned: [] };
      }

      const cleaned = [];

      for (let i = 0; i < selections.length; i++) {
        const sel = selections[i];

        if (typeof sel.assetId !== 'number' || !Number.isInteger(sel.assetId) || sel.assetId < 1) {
          errors[`selections[${i}].assetId`] = 'assetId must be a positive integer.';
        } else {
          assetIds.push(sel.assetId);
        }

        const role = typeof sel.role === 'string' ? sel.role.trim().toLowerCase() : 'attachment';
        if (!RELEASE_ASSET_ROLES.includes(role)) {
          errors[`selections[${i}].role`] = `Role must be one of: ${RELEASE_ASSET_ROLES.join(', ')}.`;
        }

        const sortOrder = typeof sel.sortOrder === 'number' && Number.isInteger(sel.sortOrder) ? sel.sortOrder : 0;
        if (sortOrder < 0) {
          errors[`selections[${i}].sortOrder`] = 'sortOrder cannot be negative.';
        }

        cleaned.push({ assetId: sel.assetId, role, sortOrder });
      }

      // Reject duplicate asset IDs — they would cause a composite PK violation
      // in the junction table and produce HTTP 500 instead of a clean 422.
      if (assetIds.length !== new Set(assetIds).size) {
        errors.assets = 'Duplicate asset IDs are not allowed.';
      }

      if (Object.keys(errors).length > 0) {
        throw new ReleaseValidationError(errors);
      }

      return { assetIds, cleaned };
    },

    /**
     * Select assets for a release.
     * Validates: release exists, assets belong to same project as release.
     * Missing assets are rejected for new selections.
     * Existing selections for missing assets are preserved.
     * @param {number} releaseId
     * @param {Array<{assetId: number, role?: string, sortOrder?: number}>} selections
     * @returns {Array}
     */
    selectAssets(releaseId, selections, { membershipOnly = false } = {}) {
      const release = repository.findById(releaseId);
      if (!release) {
        throw new ReleaseNotFoundError(releaseId);
      }
      guardReleaseNotArchived(release);
      // Reject mutations when the parent project has been archived.
      guardParentProjectNotArchived(release.project_id);
      // Reject mutations when the release is published — asset selection is locked.
      guardReleaseNotPublished(release);

      const { assetIds, cleaned } = this.validateSelections(selections, releaseId);

      // Get existing selections to know which missing assets are already selected
      const existingReleaseAssets = repository.listReleaseAssets(releaseId);
      const existingMissingAssetIds = new Set(
        existingReleaseAssets.filter((e) => e.is_present === 0).map((e) => e.asset_id)
      );

      // Single pass: verify ownership, presence, and gather errors
      // Allow re-selecting already-selected missing assets (for preservation), but reject new missing assets
      const errors = {};
      for (const { assetId } of cleaned) {
        const asset = assetRepository.findById(assetId);
        if (!asset) {
          throw new AssetNotFoundError(assetId);
        }
        if (asset.project_id !== release.project_id) {
          errors[`assets`] = `Asset ${assetId} does not belong to the release's project.`;
        }
        if (asset.is_present === 0 && !existingMissingAssetIds.has(assetId)) {
          errors[`assets`] = `Asset ${assetId} is currently missing and cannot be selected.`;
        }
      }

      if (Object.keys(errors).length > 0) {
        throw new ReleaseValidationError(errors);
      }

      const selectedAssetIdSet = new Set(assetIds);
      let finalSelections;

      if (membershipOnly) {
        // The unified picker submits membership only. Existing selected rows
        // retain their server-owned role and relative order; newly submitted
        // IDs append in the order received with the default attachment role.
        // Omitting an existing missing row is an explicit removal, unlike the
        // legacy metadata form below.
        const existingIds = new Set(existingReleaseAssets.map((row) => row.asset_id));
        finalSelections = existingReleaseAssets
          .filter((existing) => selectedAssetIdSet.has(existing.asset_id))
          .map((existing, sortOrder) => ({
            assetId: existing.asset_id,
            role: existing.role,
            sortOrder,
          }));

        for (const { assetId } of cleaned) {
          if (existingIds.has(assetId)) continue;
          finalSelections.push({
            assetId,
            role: 'attachment',
            sortOrder: finalSelections.length,
          });
        }
      } else {
        // Legacy metadata submissions preserve existing missing selections so
        // older clients cannot silently discard release history.
        const preservedSelections = [];
        for (const existing of existingReleaseAssets) {
          if (existing.is_present === 0 && !selectedAssetIdSet.has(existing.asset_id)) {
            preservedSelections.push({
              assetId: existing.asset_id,
              role: existing.role,
              sortOrder: existing.sort_order,
            });
          }
        }
        finalSelections = [...cleaned, ...preservedSelections];
      }

      try {
        repository.replaceReleaseAssets(releaseId, finalSelections);
      } catch (err) {
        if (err.code === 'CROSS_PROJECT_ASSET') {
          throw new ReleaseValidationError({ assets: err.message });
        }
        throw err;
      }
      return repository.listReleaseAssets(releaseId);
    },

    /**
     * Add a single asset to a release.
     * @param {number} releaseId
     * @param {number} assetId
     * @param {string} [role='attachment']
     * @param {number} [sortOrder=0]
     * @returns {Object}
     */
    addAssetToRelease(releaseId, assetId, role = 'attachment', sortOrder = 0) {
      const release = repository.findById(releaseId);
      if (!release) {
        throw new ReleaseNotFoundError(releaseId);
      }
      guardReleaseNotArchived(release);
      // Reject mutations when the parent project has been archived.
      guardParentProjectNotArchived(release.project_id);
      // Reject mutations when the release is published — asset selection is locked.
      guardReleaseNotPublished(release);

      // Validate role
      if (!RELEASE_ASSET_ROLES.includes(role)) {
        throw new ReleaseValidationError({
          role: `Role must be one of: ${RELEASE_ASSET_ROLES.join(', ')}.`,
        });
      }

      // Validate sortOrder
      if (!Number.isInteger(sortOrder) || sortOrder < 0) {
        throw new ReleaseValidationError({
          sortOrder: 'sortOrder must be a non-negative integer.',
        });
      }

      // Validate asset ownership
      const asset = assetRepository.findById(assetId);
      if (!asset) {
        throw new AssetNotFoundError(assetId);
      }
      if (asset.project_id !== release.project_id) {
        throw new ReleaseValidationError({
          assets: `Asset ${assetId} does not belong to the release's project.`,
        });
      }

      // Check for missing asset
      if (asset.is_present === 0) {
        throw new ReleaseValidationError({
          assets: `Asset ${assetId} is currently missing and cannot be selected.`,
        });
      }

      // Check for duplicate
      const existing = repository.listReleaseAssets(releaseId);
      if (existing.some((a) => a.asset_id === assetId)) {
        throw new ReleaseValidationError({
          assets: `Asset ${assetId} is already selected for this release.`,
        });
      }

      return repository.addReleaseAsset(releaseId, assetId, role, sortOrder);
    },

    /**
     * Remove a single asset from a release.
     * Verifies the release exists, the asset belongs to the release's project,
     * and the selection exists. Rejects archived release/project scope.
     * @param {number} releaseId
     * @param {number} assetId
     * @returns {boolean}
     */
    removeAssetFromRelease(releaseId, assetId) {
      const release = repository.findById(releaseId);
      if (!release) {
        throw new ReleaseNotFoundError(releaseId);
      }
      guardReleaseNotArchived(release);
      // Reject mutations when the parent project has been archived.
      guardParentProjectNotArchived(release.project_id);
      // Reject mutations when the release is published — asset selection is locked.
      guardReleaseNotPublished(release);

      // Verify the asset exists and belongs to the release's project
      const asset = assetRepository.findById(assetId);
      if (!asset) {
        throw new AssetNotFoundError(assetId);
      }
      if (asset.project_id !== release.project_id) {
        throw new ReleaseValidationError({
          assets: `Asset ${assetId} does not belong to the release's project.`,
        });
      }

      // Verify the selection actually exists
      const existing = repository.listReleaseAssets(releaseId);
      if (!existing.some((a) => a.asset_id === assetId)) {
        throw new ReleaseValidationError({
          assets: `Asset ${assetId} is not selected for this release.`,
        });
      }

      if (asset.is_present !== 0) {
        throw new ReleaseValidationError({
          assets: `Asset ${assetId} is currently present and cannot be removed.`,
        });
      }

      return repository.removeReleaseAsset(releaseId, assetId);
    },

    // ─── Phase 9-2: Explicit Release Asset Curation Mutations ────────────

    /**
     * Add one candidate asset to a release.
     *
     * Validates:
     *   - release exists and is mutable (not published, not archived, parent not archived)
     *   - asset exists and belongs to the same project
     *   - asset is present (is_present = 1)
     *   - asset is not already selected
     *
     * Assigns default role 'attachment' and appends after the current last
     * selection with contiguous sort_order. Does NOT accept client-submitted
     * sort order.
     *
     * @param {number} releaseId
     * @param {number} assetId
     * @returns {ReleaseAssetRecord}
     */
    addCandidateAsset(releaseId, assetId) {
      const release = repository.findById(releaseId);
      if (!release) {
        throw new ReleaseNotFoundError(releaseId);
      }
      guardReleaseNotArchived(release);
      guardParentProjectNotArchived(release.project_id);
      guardReleaseNotPublished(release);

      // Validate asset ownership and presence
      const asset = assetRepository.findById(assetId);
      if (!asset) {
        throw new AssetNotFoundError(assetId);
      }
      if (asset.project_id !== release.project_id) {
        throw new ReleaseValidationError({
          assets: `Asset ${assetId} does not belong to the release's project.`,
        });
      }
      if (asset.is_present === 0) {
        throw new ReleaseValidationError({
          assets: `Asset ${assetId} is currently missing and cannot be selected.`,
        });
      }

      // Reject if already selected
      const existing = repository.listReleaseAssets(releaseId);
      if (existing.some((a) => a.asset_id === assetId)) {
        throw new ReleaseValidationError({
          assets: `Asset ${assetId} is already selected for this release.`,
        });
      }

      // Compute next sort_order: max existing + 1, or 0 if none
      const nextOrder = existing.length > 0
        ? Math.max(...existing.map((a) => a.sort_order)) + 1
        : 0;

      return repository.insertReleaseAsset(releaseId, assetId, 'attachment', nextOrder);
    },

    /**
     * Remove one selected mutable asset from a release.
     *
     * Unlike removeAssetFromRelease (which is a corrective route for missing
     * assets only), this operation allows removing ANY selected asset from a
     * mutable release. After removal, remaining selections are reindexed to
     * contiguous sort_order 0..n-1.
     *
     * Asset records and filesystem are untouched.
     *
     * @param {number} releaseId
     * @param {number} assetId
     * @returns {boolean}
     */
    removeSelectedAsset(releaseId, assetId) {
      const release = repository.findById(releaseId);
      if (!release) {
        throw new ReleaseNotFoundError(releaseId);
      }
      guardReleaseNotArchived(release);
      guardParentProjectNotArchived(release.project_id);
      guardReleaseNotPublished(release);

      // Verify the asset belongs to the release's project
      const asset = assetRepository.findById(assetId);
      if (!asset) {
        throw new AssetNotFoundError(assetId);
      }
      if (asset.project_id !== release.project_id) {
        throw new ReleaseValidationError({
          assets: `Asset ${assetId} does not belong to the release's project.`,
        });
      }

      // Verify the selection exists
      const existing = repository.listReleaseAssets(releaseId);
      if (!existing.some((a) => a.asset_id === assetId)) {
        throw new ReleaseValidationError({
          assets: `Asset ${assetId} is not selected for this release.`,
        });
      }

      return repository.removeAndReindexReleaseAsset(releaseId, assetId);
    },

    /**
     * Update the role of one selected asset.
     *
     * Allowed roles: primary, preview, attachment, source.
     * Only the requested row is updated — asset identity and relative
     * sequence are preserved. No role cardinality rules are enforced.
     *
     * @param {number} releaseId
     * @param {number} assetId
     * @param {string} role
     * @returns {boolean}
     */
    updateAssetRole(releaseId, assetId, role) {
      const release = repository.findById(releaseId);
      if (!release) {
        throw new ReleaseNotFoundError(releaseId);
      }
      guardReleaseNotArchived(release);
      guardParentProjectNotArchived(release.project_id);
      guardReleaseNotPublished(release);

      // Validate role
      const normalizedRole = typeof role === 'string' ? role.trim().toLowerCase() : '';
      if (!RELEASE_ASSET_ROLES.includes(normalizedRole)) {
        throw new ReleaseValidationError({
          role: `Role must be one of: ${RELEASE_ASSET_ROLES.join(', ')}.`,
        });
      }

      // Verify the asset belongs to the release's project
      const asset = assetRepository.findById(assetId);
      if (!asset) {
        throw new AssetNotFoundError(assetId);
      }
      if (asset.project_id !== release.project_id) {
        throw new ReleaseValidationError({
          assets: `Asset ${assetId} does not belong to the release's project.`,
        });
      }

      // Verify the selection exists
      const existing = repository.listReleaseAssets(releaseId);
      if (!existing.some((a) => a.asset_id === assetId)) {
        throw new ReleaseValidationError({
          assets: `Asset ${assetId} is not selected for this release.`,
        });
      }

      return repository.updateReleaseAssetRole(releaseId, assetId, normalizedRole);
    },

    /**
     * Move one selected asset up in the ordering.
     *
     * Selected rows are interpreted in persisted sort_order ASC, asset_id ASC.
     * The target swaps sort_order with the immediately preceding row.
     * First-item Move Up is a controlled no-op (returns false).
     * After the mutation, persisted mutable ordering is reindexed to
     * contiguous 0..n-1.
     *
     * @param {number} releaseId
     * @param {number} assetId
     * @returns {boolean} true if a swap occurred
     */
    moveAssetUp(releaseId, assetId) {
      const release = repository.findById(releaseId);
      if (!release) {
        throw new ReleaseNotFoundError(releaseId);
      }
      guardReleaseNotArchived(release);
      guardParentProjectNotArchived(release.project_id);
      guardReleaseNotPublished(release);

      // Verify the asset belongs to the release's project
      const asset = assetRepository.findById(assetId);
      if (!asset) {
        throw new AssetNotFoundError(assetId);
      }
      if (asset.project_id !== release.project_id) {
        throw new ReleaseValidationError({
          assets: `Asset ${assetId} does not belong to the release's project.`,
        });
      }

      // Load all rows in deterministic order
      const rows = repository.listReleaseAssets(releaseId);
      const idx = rows.findIndex((a) => a.asset_id === assetId);
      if (idx === -1) {
        throw new ReleaseValidationError({
          assets: `Asset ${assetId} is not selected for this release.`,
        });
      }

      // First item — no-op
      if (idx === 0) return false;

      // Compute the desired asset_id sequence in memory: swap target with predecessor
      const assetIds = rows.map((r) => r.asset_id);
      // Swap positions idx and idx - 1
      const tmp = assetIds[idx];
      assetIds[idx] = assetIds[idx - 1];
      assetIds[idx - 1] = tmp;

      // Rewrite sort_order atomically to contiguous 0..n-1
      repository.reorderReleaseAssets(releaseId, assetIds);
      return true;
    },

    /**
     * Move one selected asset down in the ordering.
     *
     * Selected rows are interpreted in persisted sort_order ASC, asset_id ASC.
     * The target swaps sort_order with the immediately following row.
     * Last-item Move Down is a controlled no-op (returns false).
     * After the mutation, persisted mutable ordering is reindexed to
     * contiguous 0..n-1.
     *
     * @param {number} releaseId
     * @param {number} assetId
     * @returns {boolean} true if a swap occurred
     */
    moveAssetDown(releaseId, assetId) {
      const release = repository.findById(releaseId);
      if (!release) {
        throw new ReleaseNotFoundError(releaseId);
      }
      guardReleaseNotArchived(release);
      guardParentProjectNotArchived(release.project_id);
      guardReleaseNotPublished(release);

      // Verify the asset belongs to the release's project
      const asset = assetRepository.findById(assetId);
      if (!asset) {
        throw new AssetNotFoundError(assetId);
      }
      if (asset.project_id !== release.project_id) {
        throw new ReleaseValidationError({
          assets: `Asset ${assetId} does not belong to the release's project.`,
        });
      }

      // Load all rows in deterministic order
      const rows = repository.listReleaseAssets(releaseId);
      const idx = rows.findIndex((a) => a.asset_id === assetId);
      if (idx === -1) {
        throw new ReleaseValidationError({
          assets: `Asset ${assetId} is not selected for this release.`,
        });
      }

      // Last item — no-op
      if (idx === rows.length - 1) return false;

      // Compute the desired asset_id sequence in memory: swap target with successor
      const assetIds = rows.map((r) => r.asset_id);
      // Swap positions idx and idx + 1
      const tmp = assetIds[idx];
      assetIds[idx] = assetIds[idx + 1];
      assetIds[idx + 1] = tmp;

      // Rewrite sort_order atomically to contiguous 0..n-1
      repository.reorderReleaseAssets(releaseId, assetIds);
      return true;
    },

    /**
     * Find releases that use a given asset.
     * @param {number} assetId
     * @returns {Array}
     */
    findReleasesByAsset(assetId) {
      return repository.findReleasesByAsset(assetId);
    },

    /**
     * Get all assets for a project (for asset selection UI).
     * @param {number} projectId
     * @param {number|null} [categoryId] - optional project-owned category ID
     * @returns {Array}
     */
    findProjectAssets(projectId, categoryId = null) {
      const normalizedCategoryId = normalizeOptionalCategoryId(categoryId);
      return assetRepository.findByProjectId(projectId, {
        sortBy: 'filename',
        order: 'asc',
        categoryId: normalizedCategoryId,
      });
    },

    // ─── Phase 9-1: Release Asset Candidate Discovery ─────────────────────

    /**
     * Normalize and validate release candidate query parameters.
     *
     * @param {Object} raw - raw query parameters
     * @returns {{ search: string|null, extension: string|null, page: number, pageSize: number }}
     */
    normalizeCandidateQuery(raw) {
      const search = typeof raw.search === 'string' && raw.search.trim() !== ''
        ? raw.search.trim()
        : null;

      // Extension: allow-list via simple safe check — only alphanumeric and dots
      let extension = null;
      if (typeof raw.extension === 'string' && raw.extension.trim() !== '') {
        const trimmed = raw.extension.trim().toLowerCase();
        // Allow only safe characters: letters, digits, dots, hyphens, underscores
        if (/^[a-z0-9._-]+$/.test(trimmed)) {
          extension = trimmed;
        }
      }

      const pageRaw = parseStrictPositiveInt(raw.page);
      const page = pageRaw !== null ? pageRaw : 1;

      const pageSizeRaw = parseStrictPositiveInt(raw.pageSize);
      let pageSize = pageSizeRaw !== null ? pageSizeRaw : 25;
      if (pageSize > 100) pageSize = 100;

      return { search, extension, page, pageSize };
    },

    /**
     * Compose the release asset-management page view-model.
     *
     * Returns:
     *   - release
     *   - project
     *   - releaseAssets — complete selected assets (unpaginated, includes missing)
     *   - assets — complete project asset list used for eligibility states
     *   - categories — all project-owned categories for the filter control
     *   - categoryNavigation — whole-project category counts for the disclosure
     *   - activeCategoryId — selected project category ID, or null
     *   - assetPage — current filtered/page project asset collection
     *   - assetTotal — total filtered project asset collection
     *   - assetPage — current page number
     *   - assetPageSize — page size
     *   - assetPageCount — total pages
     *   - assetFilters — normalized filter values
     *   - assetExtensions — available project extension values
     *   - eligibleAssetCount — present project assets, selected or not
     *   - eligibleCandidateCount — present project assets not selected
     *   - assetPresentation — selected assets plus merged page asset views
     *
     * @param {number} releaseId
     * @param {Object} rawQuery - raw query parameters for candidate filters
     * @returns {{
     *   release: object,
     *   project: object,
     *   releaseAssets: Array,
     *   assets: Array,
     *   categories: Array,
     *   activeCategoryId: number|null,
     *   assetPage: Array,
     *   assetTotal: number,
     *   assetPageNumber: number,
     *   assetPageSize: number,
     *   assetPageCount: number,
     *   assetFilters: { search: string|null, extension: string|null },
     *   assetExtensions: string[],
     *   assetPresentation: { selected: Array, candidates: Array, assets: Array },
     * }}
     */
    getReleaseAssetManagementPage(releaseId, rawQuery = {}) {
      const release = repository.findById(releaseId);
      if (!release) {
        throw new ReleaseNotFoundError(releaseId);
      }

      const project = projectRepository.findById(release.project_id);
      if (!project) {
        const err = new Error(`Project ${release.project_id} not found`);
        err.status = 404;
        throw err;
      }

       // Complete selected assets (unpaginated, includes missing).
       const releaseAssets = repository.listReleaseAssets(releaseId);

      const activeCategoryId = normalizeOptionalCategoryId(readCategoryFilter(rawQuery));
      const categories = assetCategoryRepository.listProjectCategories(release.project_id);
      if (
        activeCategoryId !== null
        && !assetCategoryRepository.findProjectCategoryById(release.project_id, activeCategoryId)
      ) {
        throw new AssetCategoryNotFoundError(activeCategoryId);
      }

      const assets = this.findProjectAssets(release.project_id);

      // Whole-project category counts for the filter disclosure, computed from
      // the already-loaded complete project asset collection — never one query
      // per category. Present and missing assets both contribute, matching the
      // project asset browser's navigation semantics. Zero-count categories
      // render with 0, as on the reference page.
      const categoryCounts = {};
      let uncategorizedCount = 0;
      for (const asset of assets) {
        if (asset.category_id === null || asset.category_id === undefined) {
          uncategorizedCount += 1;
        } else {
          categoryCounts[asset.category_id] = (categoryCounts[asset.category_id] || 0) + 1;
        }
      }
      const categoryNavigation = {
        totalCount: assets.length,
        uncategorizedCount,
        byCategoryId: categoryCounts,
      };
      const selectedAssetIds = new Set(releaseAssets.map((asset) => asset.asset_id));
      const eligibleAssetCount = assets.filter((asset) => asset.is_present === 1).length;
      const eligibleCandidateCount = assets.filter(
        (asset) => asset.is_present === 1 && !selectedAssetIds.has(asset.id),
      ).length;

      // The editable page is one project-asset collection. Present assets are
      // eligible for selection; selected missing assets remain in the same
      // collection as an explicit exception so they can be retained or removed.
      const assetFilters = this.normalizeCandidateQuery(rawQuery);
      const filteredAssets = assets.filter((asset) => {
        const selectedMissing = selectedAssetIds.has(asset.id) && asset.is_present !== 1;
        return selectedMissing || (asset.is_present === 1
          && matchesReleaseAssetFilters(asset, assetFilters, activeCategoryId));
      });
      const assetTotal = filteredAssets.length;
      const assetPageCount = Math.max(1, Math.ceil(assetTotal / assetFilters.pageSize));
      const assetPageNumber = Math.min(assetFilters.page, assetPageCount);
      const assetPage = filteredAssets.slice(
        (assetPageNumber - 1) * assetFilters.pageSize,
        assetPageNumber * assetFilters.pageSize,
      );
      const pageCandidates = assetPage.filter((asset) => !selectedAssetIds.has(asset.id));
      const candidateTotal = filteredAssets.filter((asset) => !selectedAssetIds.has(asset.id)).length;
      const assetExtensions = assetRepository.getExtensions(release.project_id);
      const assetPresentation = buildReleaseAssetPagePresentation({
        selectedAssets: releaseAssets,
        assets: assetPage,
        candidateAssets: pageCandidates,
        categories,
      });

      return {
        release,
        project,
         releaseAssets,
         assets,
         categories,
         categoryNavigation,
         activeCategoryId,
         assetPage,
         assetTotal,
         assetPageNumber,
         assetPageSize: assetFilters.pageSize,
         assetPageCount,
         assetFilters: {
           search: assetFilters.search,
           extension: assetFilters.extension,
         },
         assetExtensions,
         candidates: pageCandidates,
         candidateTotal,
         candidatePage: assetPageNumber,
         candidatePageSize: assetFilters.pageSize,
         candidatePageCount: assetPageCount,
         candidateFilters: {
           search: assetFilters.search,
           extension: assetFilters.extension,
         },
         candidateExtensions: assetExtensions,
         eligibleAssetCount,
         eligibleCandidateCount,
         assetPresentation,
      };
    },

    /**
     * List releases for a specific project.
     * @param {number} projectId
     * @param {Object} [options]
     * @returns {ReleaseRecord[]}
     */
    listReleases(projectId, options = {}) {
      return repository.findByProjectId(projectId, options);
    },

    /**
     * List releases across all projects (global list for routes).
     * @param {Object} [options]
     * @param {boolean} [options.includeArchived]
     * @param {string} [options.sortBy]
     * @param {string} [options.order]
     * @param {string} [options.search]
     * @returns {ReleaseRecord[]}
     */
    listAllReleases(options = {}) {
      return repository.findAll(options);
    },

    // ─── Phase 3 chunk 3: Bulk asset-browser release association ─────────

    /**
     * Transactionally add multiple present, same-project assets to one
     * mutable release. Assigns role 'attachment' and appends contiguously
     * after the release's current last manual-order item; existing
     * associations, roles, and order are never touched.
     *
     * All input validation happens before any repository access — a single
     * bounded lookup loads every submitted asset so this never issues one
     * query per ID. The actual append is delegated to one repository
     * transaction (`appendAssetsToRelease`); this method does not loop over
     * a single-asset add and cannot partially mutate on its own.
     *
     * Already-associated submitted assets are not an error — they are
     * skipped and reported via `alreadyAssociated`.
     *
     * @param {number} releaseId
     * @param {number} projectId - the project the browser page belongs to;
     *   the release must belong to this same project
     * @param {Array<number|string>} assetIds - candidate asset IDs, any order
     * @returns {{ added: number, alreadyAssociated: number }}
     * @throws {ReleaseValidationError} malformed/empty/duplicate input, an
     *   asset outside the project, or a missing (not present) asset
     * @throws {ReleaseNotFoundError} unknown release, or a release that
     *   belongs to a different project than `projectId`
     * @throws {ReleaseArchivedError} the release itself is archived
     * @throws {ReleaseParentArchivedError} the parent project is archived
     * @throws {ReleasePublishedError} the release is published (locked)
     * @throws {AssetNotFoundError} an unknown asset ID was submitted
     */
    addAssetsToRelease(releaseId, projectId, assetIds) {
      const normalizedProjectId = parseStrictPositiveInt(projectId);
      if (normalizedProjectId === null) {
        throw new ReleaseValidationError({ projectId: 'projectId must be a positive integer.' });
      }

      const normalizedReleaseId = parseStrictPositiveInt(releaseId);
      if (normalizedReleaseId === null) {
        throw new ReleaseValidationError({ releaseId: 'releaseId must be a positive integer.' });
      }

      if (!Array.isArray(assetIds) || assetIds.length === 0) {
        throw new ReleaseValidationError({ assetIds: 'At least one asset must be selected.' });
      }

      const normalizedAssetIds = [];
      const seen = new Set();
      for (const raw of assetIds) {
        const id = parseStrictPositiveInt(raw);
        if (id === null) {
          throw new ReleaseValidationError({ assetIds: 'Asset IDs must be positive integers.' });
        }
        if (seen.has(id)) {
          throw new ReleaseValidationError({ assetIds: 'Duplicate asset IDs are not allowed.' });
        }
        seen.add(id);
        normalizedAssetIds.push(id);
      }

      const release = repository.findById(normalizedReleaseId);
      if (!release) {
        throw new ReleaseNotFoundError(normalizedReleaseId);
      }
      // A release that exists but belongs to a different project is treated
      // identically to an unknown release — existence must not leak across
      // projects.
      if (release.project_id !== normalizedProjectId) {
        throw new ReleaseNotFoundError(normalizedReleaseId);
      }

      guardParentProjectNotArchived(release.project_id);
      guardReleaseNotArchived(release);
      guardReleaseNotPublished(release);

      // One bounded lookup for every submitted asset — never one query per ID.
      const assets = assetRepository.findByIds(normalizedAssetIds);
      const assetsById = new Map(assets.map((a) => [a.id, a]));

      for (const id of normalizedAssetIds) {
        const asset = assetsById.get(id);
        if (!asset) {
          throw new AssetNotFoundError(id);
        }
        if (asset.project_id !== release.project_id) {
          throw new ReleaseValidationError({
            assets: `Asset ${id} does not belong to the release's project.`,
          });
        }
        if (asset.is_present === 0) {
          throw new ReleaseValidationError({
            assets: `Asset ${id} is currently missing and cannot be added.`,
          });
        }
      }

      return repository.appendAssetsToRelease(normalizedReleaseId, normalizedAssetIds);
    },
  };
}
