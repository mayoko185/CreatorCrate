import { createReleaseRepository, RELEASE_STATUSES, ACTIVE_RELEASE_STATUSES, RELEASE_ASSET_ROLES } from '../data/release-repository.js';
import { createProjectRepository } from '../data/project-repository.js';
import { createAssetRepository } from '../data/asset-repository.js';
import { getLocalTodayIso } from '../util/date.js';

export { RELEASE_STATUSES, ACTIVE_RELEASE_STATUSES };

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

/**
 * Valid workflow transitions.
 * Keys are current status (or 'new' for initial creation).
 * Values are arrays of allowed next statuses.
 *
 * published is terminal — cannot be set via create/update, only via publishRelease.
 * cancelled is allowed as initial status (historical/imported releases) but
 * once set, cannot transition to any other status.
 */
const WORKFLOW_TRANSITIONS = {
  new: ['idea', 'planned', 'drafting', 'ready', 'cancelled'],
  idea: ['planned', 'drafting', 'ready', 'cancelled'],
  planned: ['idea', 'drafting', 'ready', 'cancelled'],
  drafting: ['idea', 'planned', 'ready', 'cancelled'],
  ready: ['cancelled'], // NOTE: published is NOT here — only publishRelease() can publish
  published: [], // terminal — no transitions out
  cancelled: [], // terminal — no transitions out
};

/**
 * Validate a status transition for create/update operations.
 * publishRelease() has its own internal validation and does NOT use this function.
 * @param {string|null} currentStatus - existing status, or null for new releases
 * @param {string} newStatus - desired new status
 * @throws {ReleaseValidationError} if transition is not allowed
 */
function validateTransition(currentStatus, newStatus) {
  // Same status is a no-op — always allowed
  if (currentStatus !== null && currentStatus === newStatus) {
    return;
  }

  // published is NEVER allowed via create/update — only via publishRelease()
  if (newStatus === 'published') {
    if (currentStatus === null) {
      throw new ReleaseValidationError({
        status: `Cannot create a release with status "published". Use the publish action to publish a release.`,
      });
    }
    throw new ReleaseValidationError({
      status: `Cannot change status from "${currentStatus}" to "published". Use the publish action.`,
    });
  }

  const allowed = WORKFLOW_TRANSITIONS[currentStatus ?? 'new'];
  if (!allowed || !allowed.includes(newStatus)) {
    if (currentStatus === null) {
      throw new ReleaseValidationError({
        status: `Cannot create a release with status "${newStatus}".`,
      });
    }
    throw new ReleaseValidationError({
      status: `Cannot change status from "${currentStatus}" to "${newStatus}".`,
    });
  }
}

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

function isValidPatreonUrl(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /^([^.]+\.)?patreon\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export function createReleaseService({ db, evaluateReleaseReadiness }) {
  const repository = createReleaseRepository(db);
  const projectRepository = createProjectRepository(db);
  const assetRepository = createAssetRepository(db);

  function validate(input, options = {}) {
    const { existingId } = options;
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

    const status = input.status;
    if (!RELEASE_STATUSES.includes(status)) {
      errors.status = `Status must be one of: ${RELEASE_STATUSES.join(', ')}.`;
    }

    const plannedDate = input.plannedDate || null;
    if (!isValidDate(plannedDate)) {
      errors.plannedDate = 'Planned date must be a valid date (YYYY-MM-DD).';
    }

    const publishedDate = input.publishedDate || null;
    if (!isValidDate(publishedDate)) {
      errors.publishedDate = 'Published date must be a valid date (YYYY-MM-DD).';
    }

    if (status === 'published' && !publishedDate) {
      errors.publishedDate = 'Published date is required when status is published.';
    }

    const patreonUrl = input.patreonUrl || null;
    if (!isValidPatreonUrl(patreonUrl)) {
      errors.patreonUrl = 'Patreon URL must be a valid https://patreon.com link.';
    }

    if (Object.keys(errors).length > 0) {
      throw new ReleaseValidationError(errors);
    }

    return {
      title,
      description,
      notes,
      status,
      plannedDate,
      publishedDate,
      patreonUrl,
    };
  }

  function validateProjectExists(projectId) {
    const project = projectRepository.findById(projectId);
    if (!project) {
      throw new ReleaseValidationError({ projectId: 'Project not found.' });
    }
    if (project.archived_at) {
      throw new ReleaseValidationError({ projectId: 'Cannot create release for archived project.' });
    }
    return project;
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

  return {
    RELEASE_STATUSES,
    ACTIVE_RELEASE_STATUSES,

    repository,

    /**
     * @param {number} projectId
     * @param {Object} input
     * @returns {ReleaseRecord}
     */
    createRelease(projectId, input) {
      validateProjectExists(projectId);
      const normalized = validate(input);
      // Enforce lifecycle: published and cancelled are terminal states
      validateTransition(null, normalized.status);
      return repository.create({ projectId, ...normalized });
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

      // Validate project still exists and is not archived
      validateProjectExists(release.project_id);

      const normalized = validate(input, { existingId: id });
      // Enforce lifecycle transitions
      validateTransition(release.status, normalized.status);
      const updated = repository.update(id, normalized);
      if (!updated) {
        throw new ReleaseNotFoundError(id);
      }
      return updated;
    },

    /**
     * Publish a release. Sets published_date to today if not provided.
     * Only ready releases can be published.
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
        throw new ReleaseValidationError({ general: 'Cannot publish an archived release.' });
      }

      if (release.status === 'published') {
        throw new ReleaseValidationError({ general: 'Release is already published.' });
      }

      if (release.status !== 'ready') {
        throw new ReleaseValidationError({ general: 'Only releases with status "ready" can be published.' });
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
     * Archive a release. Sets archived_at but does not change status.
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
        throw new ReleaseValidationError({ general: 'Release is already archived.' });
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
     * @param {string} [options.status]
     * @param {boolean} [options.includeArchived]
     * @param {string} [options.sortBy]
     * @param {string} [options.order]
     * @returns {ReleaseRecord[]}
     */
    listReleases(projectId, options) {
      return repository.findByProjectId(projectId, options);
    },

    /**
     * @returns {Object.<string, number>}
     */
    countByStatus() {
      return repository.countByStatus();
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
    selectAssets(releaseId, selections) {
      const release = repository.findById(releaseId);
      if (!release) {
        throw new ReleaseNotFoundError(releaseId);
      }
      guardReleaseNotArchived(release);
      // Reject mutations when the parent project has been archived.
      guardParentProjectNotArchived(release.project_id);

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

      // Preserve existing selections for missing assets that were not re-selected in the form.
      // This prevents silent removal of selections when a missing asset is unchecked in the form.
      const selectedAssetIdSet = new Set(assetIds);
      const preservedSelections = [];

      for (const existing of existingReleaseAssets) {
        if (existing.is_present === 0 && !selectedAssetIdSet.has(existing.asset_id)) {
          // This existing selection is for a missing asset and was not re-selected in the form.
          // Preserve it to maintain release history.
          preservedSelections.push({
            assetId: existing.asset_id,
            role: existing.role,
            sortOrder: existing.sort_order,
          });
        }
      }

      const finalSelections = [...cleaned, ...preservedSelections];
      repository.replaceReleaseAssets(releaseId, finalSelections);
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
     * @returns {Array}
     */
    findProjectAssets(projectId) {
      return assetRepository.findByProjectId(projectId, { sortBy: 'filename', order: 'asc' });
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
     * @param {string} [options.status]
     * @param {boolean} [options.includeArchived]
     * @param {string} [options.sortBy]
     * @param {string} [options.order]
     * @param {string} [options.search]
     * @returns {ReleaseRecord[]}
     */
    listAllReleases(options = {}) {
      return repository.findAll(options);
    },
  };
}
