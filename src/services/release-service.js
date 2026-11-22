import { createReleaseRepository, RELEASE_ASSET_ROLES } from '../data/release-repository.js';
import { createProjectRepository } from '../data/project-repository.js';
import { createAssetRepository } from '../data/asset-repository.js';
import { createAssetCategoryRepository } from '../data/asset-category-repository.js';
import { createSocialPrepRepository, SocialPrepRepositoryError } from '../data/social-prep-repository.js';
import { AssetCategoryNotFoundError } from './asset-category-service.js';
import { AssetCategoryValidationError } from './asset-category-validation.js';
import { buildReleaseAssetPagePresentation } from './release-asset-presenter.js';
import { createAppMetaRepository } from '../data/app-meta-repository.js';
import { createProjectImageSettingsService } from './project-image-settings-service.js';
import { projectImagePresentationPolicy } from './project-image-policy.js';
import { formatLocalDate, formatLocalTime, getLocalTodayIso } from '../util/date.js';
import { isValidWebUrl } from '../util/url.js';
import { isProjectArchived } from './project-state.js';
import { ProjectValidationError } from './project-service.js';

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

/**
 * Thrown when a schedule change names an expected current schedule that no
 * longer matches the stored one, so a newer edit is never overwritten.
 * `currentSchedule` is the stored schedule observed when the conflict was
 * detected.
 */
export class ReleaseScheduleConflictError extends Error {
  constructor(id, currentSchedule) {
    super(`Release ${id} schedule changed since it was loaded.`);
    this.name = 'ReleaseScheduleConflictError';
    this.status = 409;
    this.code = 'SCHEDULE_CONFLICT';
    this.currentSchedule = currentSchedule;
  }
}

/**
 * Thrown when a Release link change names an expected current link that no
 * longer matches the stored one, so a newer link is never overwritten.
 * `currentReleaseLink` is the stored link observed when the conflict was
 * detected (null when there is none).
 */
export class ReleaseLinkConflictError extends Error {
  constructor(id, currentReleaseLink) {
    super(`Release ${id} link changed since it was loaded.`);
    this.name = 'ReleaseLinkConflictError';
    this.status = 409;
    this.code = 'RELEASE_LINK_CONFLICT';
    this.currentReleaseLink = currentReleaseLink;
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

const RELEASE_LINK_MESSAGE = 'Release link must be a valid absolute HTTP or HTTPS URL.';
const RELEASE_LINK_EXPECTATION_MESSAGE = 'This form could not confirm which Release link it loaded. Close and reopen Edit Release, then try again.';

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

/** Stored schedule pair with blank values read as null (date-only/undated). */
function readSchedule(release) {
  return {
    plannedDate: release.planned_date || null,
    plannedTime: release.planned_time || null,
  };
}

function isBlankScheduleValue(value) {
  return value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * Validate the quick-schedule input. Every field except `plannedTime` must be
 * present: omission is a client error, while null/blank intentionally means
 * "no date" or "no time".
 */
function normalizeScheduleInput(input) {
  const errors = {};
  const source = input !== null && typeof input === 'object' ? input : {};

  const readDate = (field, label) => {
    if (!Object.hasOwn(source, field)) {
      errors[field] = `${label} is required (use null for no date).`;
      return null;
    }
    const value = source[field];
    if (isBlankScheduleValue(value)) return null;
    if (typeof value !== 'string' || !isValidDate(value.trim())) {
      errors[field] = `${label} must be a valid date (YYYY-MM-DD) or null.`;
      return null;
    }
    return value.trim();
  };

  const plannedDate = readDate('plannedDate', 'Planned date');
  const expectedPlannedDate = readDate('expectedPlannedDate', 'Expected planned date');

  let expectedPlannedTime = null;
  if (!Object.hasOwn(source, 'expectedPlannedTime')) {
    errors.expectedPlannedTime = 'Expected planned time is required (use null for no time).';
  } else if (!isBlankScheduleValue(source.expectedPlannedTime)) {
    const value = source.expectedPlannedTime;
    if (typeof value !== 'string' || !isValidTime(value.trim())) {
      errors.expectedPlannedTime = 'Expected planned time must be a valid time (HH:MM) or null.';
    } else {
      expectedPlannedTime = value.trim();
    }
  }

  if (Object.hasOwn(source, 'plannedTime') && source.plannedTime !== undefined
    && !isBlankScheduleValue(source.plannedTime)) {
    errors.plannedTime = 'Quick scheduling sets a date only; planned time must be empty.';
  }

  if (Object.keys(errors).length > 0) {
    throw new ReleaseValidationError(errors);
  }

  return {
    schedule: { plannedDate, plannedTime: null },
    expected: { plannedDate: expectedPlannedDate, plannedTime: expectedPlannedTime },
  };
}

function isSameSchedule(a, b) {
  return a.plannedDate === b.plannedDate && a.plannedTime === b.plannedTime;
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

/**
 * Manage Assets page-size catalogue (WP16): the exact values both page-size
 * controls offer. 'all' is View All.
 */
const RELEASE_ASSET_PAGE_SIZE_VALUES = Object.freeze([10, 25, 50, 100, 150, 200, 'all']);
const RELEASE_ASSET_DEFAULT_PAGE_SIZE = 25;
const RELEASE_ASSET_PAGE_SIZE_TEXT = new Map(RELEASE_ASSET_PAGE_SIZE_VALUES.map((value) => [String(value), value]));

/**
 * P3-C4: the one effective Manage Assets page size. A value is honoured only
 * when it is exactly one supported catalogue string; anything else (an
 * unsupported or oversized number, zero, negative, decimal, leading-zero,
 * malformed or differently-cased All, empty, missing or repeated) is the
 * default 25 — never rounded to a neighbouring size and never View All.
 * @param {unknown} value
 * @returns {number|'all'}
 */
function normalizeReleaseAssetPageSize(value) {
  if (typeof value !== 'string') return RELEASE_ASSET_DEFAULT_PAGE_SIZE;
  return RELEASE_ASSET_PAGE_SIZE_TEXT.has(value)
    ? RELEASE_ASSET_PAGE_SIZE_TEXT.get(value)
    : RELEASE_ASSET_DEFAULT_PAGE_SIZE;
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

/**
 * Batch size for the project-scoped metadata lookup of submitted off-page
 * asset IDs (Save validation recovery). Keeps every statement well under
 * SQLite's bound-parameter limit without one query per ID.
 */
const SUBMITTED_ASSET_LOOKUP_CHUNK_SIZE = 500;

/**
 * Manage Assets is read-only for published or archived releases and for any
 * release under an archived project — the same rule the template applies.
 */
function isReleaseAssetManagementReadOnly(release, project) {
  return Boolean(release?.published_date) || Boolean(release?.archived_at) || isProjectArchived(project);
}

export function createReleaseService({
  db, applicationLogger = null, socialPrepSettingsService = null, projectImageSettingsService = null,
  onReleaseNotificationStateChanged = null, projectService = null,
}) {
  const imageSettings = projectImageSettingsService ?? createProjectImageSettingsService({
    appMetaRepository: createAppMetaRepository(db),
  });
  const imageFingerprint = () => imageSettings.getPresentationPolicy?.()
    ?? projectImagePresentationPolicy(imageSettings.getPolicy());
  const repository = createReleaseRepository(db);
  const socialPrepRepository = createSocialPrepRepository(db);
  const projectRepository = createProjectRepository(db);
  const assetRepository = createAssetRepository(db);
  const assetCategoryRepository = createAssetCategoryRepository(db);

  /**
   * Pure presentation of one Manage Assets snapshot (no database access).
   * Visible cards come only from the bounded SQL page rows; saved role and
   * order come from the complete persisted membership of the same snapshot.
   */
  function buildReleaseAssetManagementViewModel(snapshot, clockFormat = '24h') {
    const {
      release, project, readOnly, categories, activeCategoryId, assetFilters,
      releaseAssets, aggregates, pageResult, assetExtensions,
    } = snapshot;
    const assetPage = pageResult.rows;
    const savedIds = new Set(releaseAssets.map((member) => member.asset_id));
    const pageCandidates = assetPage.filter((row) => !savedIds.has(row.id));

    let selectedAssets = releaseAssets;
    if (!readOnly) {
      const pageRowsById = new Map(assetPage.map((row) => [row.id, row]));
      selectedAssets = releaseAssets
        .filter((member) => pageRowsById.has(member.asset_id))
        .map((member) => ({
          ...pageRowsById.get(member.asset_id),
          asset_id: member.asset_id,
          role: member.role,
          sort_order: member.sort_order,
        }));
    }

    const assetPresentation = buildReleaseAssetPagePresentation({
      policyFingerprint: imageFingerprint(),
      selectedAssets,
      assets: assetPage,
      candidateAssets: pageCandidates,
      categories,
      clockFormat,
    });

    return {
      release,
      project,
      readOnly,
      releaseAssets,
      categories,
      categoryNavigation: aggregates.categoryNavigation,
      activeCategoryId,
      assetPage,
      assetTotal: pageResult.total,
      assetPageNumber: pageResult.page,
      assetPageSize: pageResult.pageSize,
      assetPageCount: pageResult.pageCount,
      assetFilters: {
        search: assetFilters.search,
        extension: assetFilters.extension,
        selection: pageResult.selection,
      },
      assetExtensions,
      candidates: pageCandidates,
      candidateTotal: pageResult.candidateTotal,
      candidatePage: pageResult.page,
      candidatePageSize: pageResult.pageSize,
      candidatePageCount: pageResult.pageCount,
      candidateFilters: {
        search: assetFilters.search,
        extension: assetFilters.extension,
      },
      candidateExtensions: assetExtensions,
      eligibleAssetCount: aggregates.eligibleAssetCount,
      eligibleCandidateCount: aggregates.eligibleCandidateCount,
      assetPresentation,
    };
  }

  function validateSelectedPlatforms(input, releaseId = null) {
    if (!Object.hasOwn(input, 'selectedPlatforms')) return null;
    const platforms = input.selectedPlatforms;
    const allowed = new Set(socialPrepSettingsService?.getPlatforms?.() || []);
    if (releaseId !== null) {
      for (const row of socialPrepRepository.listPlatformsByReleaseId(releaseId)) {
        if (row.is_selected === 1) allowed.add(row.platform);
      }
    }
    if (!Array.isArray(platforms) || platforms.some((platform) => typeof platform !== 'string' || !allowed.has(platform))
      || new Set(platforms).size !== platforms.length) {
      throw new ReleaseValidationError({ selectedPlatforms: 'Select valid configured platforms.' });
    }
    return platforms;
  }

  function replacePlatformSelection(releaseId, platforms) {
    try {
      socialPrepRepository.replaceSelectedPlatforms(releaseId, platforms);
    } catch (err) {
      if (err instanceof SocialPrepRepositoryError && err.code === 'PLATFORM_SELECTION_IN_PROGRESS') {
        throw new ReleaseValidationError({
          selectedPlatforms: 'Cannot deselect a platform while its preparation session is active.',
        });
      }
      throw err;
    }
  }

  function logActivity(event, release, context = {}) {
    try {
      applicationLogger?.info?.({
        event,
        kind: 'activity',
        subsystem: 'releases',
        message: 'Release activity completed.',
        projectId: release.project_id,
        context: {
          releaseId: release.id,
          ...context,
        },
      });
    } catch {
      // Activity logging must never alter the completed release operation.
    }
  }

  /**
   * Let release notifications cancel now-stale queued work after a committed
   * schedule/publication/archive change. Correctness never depends on it (the
   * notification core revalidates before every send), so it must not fail
   * the mutation.
   */
  function notifyReleaseNotificationState(releaseId) {
    try {
      onReleaseNotificationStateChanged?.(releaseId);
    } catch {
      // Best-effort prompt invalidation only.
    }
  }

  function getAssetCountContext(releaseId) {
    try {
      return { assetCount: repository.countReleaseAssets(releaseId) };
    } catch {
      return {};
    }
  }

  /**
   * Apply a publication-requested Project status change through the shared
   * Project update path. The Project is read server-side inside the caller's
   * transaction, so every other editable field (and tags, by omission) is
   * resubmitted unchanged and only `status` differs.
   */
  function updateProjectStatusForPublication(projectId, status) {
    if (typeof projectService?.update !== 'function') {
      throw new Error('Release publication with a Project status update requires a projectService dependency.');
    }
    const project = projectRepository.findById(projectId);
    if (!project) {
      throw new ReleaseValidationError({ general: 'The parent project no longer exists.' });
    }
    try {
      projectService.update(project.id, {
        title: project.title,
        description: project.description,
        notes: project.notes,
        status,
        projectType: project.project_type,
        patreonUrl: project.patreon_url,
      });
    } catch (err) {
      if (err instanceof ProjectValidationError) {
        const errors = err.errors || {};
        if (errors.status) {
          throw new ReleaseValidationError({
            projectStatus: 'The selected project status is no longer available. Choose another status.',
          });
        }
        const [message] = Object.values(errors);
        throw new ReleaseValidationError({
          general: errors.general || `The project status could not be updated: ${message || 'validation failed.'}`,
        });
      }
      throw err;
    }
  }

  function logMembershipChanges(release, before, after) {
    const beforeByAssetId = new Map(before.map((row) => [row.asset_id, row]));
    const afterByAssetId = new Map(after.map((row) => [row.asset_id, row]));
    const addedCount = [...afterByAssetId.keys()].filter((assetId) => !beforeByAssetId.has(assetId)).length;
    const removedCount = [...beforeByAssetId.keys()].filter((assetId) => !afterByAssetId.has(assetId)).length;

    if (addedCount > 0) logActivity('release.assets.added', release, { affectedCount: addedCount });
    if (removedCount > 0) logActivity('release.assets.removed', release, { affectedCount: removedCount });

    const changedRoleCounts = new Map();
    for (const [assetId, afterRow] of afterByAssetId) {
      const beforeRow = beforeByAssetId.get(assetId);
      if (beforeRow && beforeRow.role !== afterRow.role) {
        changedRoleCounts.set(afterRow.role, (changedRoleCounts.get(afterRow.role) || 0) + 1);
      }
    }
    for (const [role, affectedCount] of changedRoleCounts) {
      logActivity('release.asset_role.changed', release, { role, affectedCount });
    }
  }

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
      errors.patreonUrl = RELEASE_LINK_MESSAGE;
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
    if (isProjectArchived(project)) {
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
    if (isProjectArchived(parent)) {
      throw new ReleaseParentArchivedError(projectId);
    }
  }

  /**
   * Release-link guard: the release exists, is not archived, and its parent
   * project is not archived. Publication does not lock the link.
   */
  function guardReleaseLinkEditable(release, id) {
    if (!release) throw new ReleaseNotFoundError(id);
    guardParentProjectNotArchived(release.project_id);
    guardReleaseNotArchived(release);
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
      const selectedPlatforms = validateSelectedPlatforms(input);
      const created = selectedPlatforms === null
        ? repository.create({ projectId, ...normalized })
        : db.transaction(() => {
          const release = repository.create({ projectId, ...normalized });
          replacePlatformSelection(release.id, selectedPlatforms);
          return release;
        }).immediate();
      logActivity('release.created', created, { assetCount: 0 });
      return created;
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
      const selectedPlatforms = validateSelectedPlatforms(input);

      const selections = normalizedAssetIds.map((assetId, sortOrder) => ({
        assetId,
        role: 'attachment',
        sortOrder,
      }));

      const create = () => repository.createWithAssetSelections(
        { projectId: project.id, ...normalized }, selections,
      );
      const created = selectedPlatforms === null ? create() : db.transaction(() => {
        const release = create();
        replacePlatformSelection(release.id, selectedPlatforms);
        return release;
      }).immediate();
      logActivity('release.created', created, { assetCount: selections.length });
      return created;
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

      const created = repository.createWithAssetSelections(
        { projectId: project.id, ...normalized },
        selections,
      );
      logActivity('release.created', created, { assetCount: selections.length });
      return created;
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

      const created = repository.createWithAssetSelections(
        { projectId: project.id, ...normalized },
        selections,
      );
      logActivity('release.created', created, { assetCount: selections.length });
      return created;
    },

    /**
     * When `input` carries `expectedPatreonUrl` (the Release link the editor
     * loaded), the whole update applies only while the stored link still
     * equals it, so a newer link saved elsewhere (for example by the Posting
     * Helper) is never overwritten. The value is compared exactly; only an
     * empty string is equivalent to no link.
     *
     * @param {number} id
     * @param {Object} input
     * @returns {ReleaseRecord}
     * @throws {ReleaseLinkConflictError} when the expected link is stale;
     *   nothing is written
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

      const { expectedPatreonUrl } = input;
      const guardLink = Object.hasOwn(input, 'expectedPatreonUrl');
      if (guardLink && expectedPatreonUrl !== null && typeof expectedPatreonUrl !== 'string') {
        throw new ReleaseValidationError({ general: RELEASE_LINK_EXPECTATION_MESSAGE });
      }
      const expectedLink = guardLink ? expectedPatreonUrl || null : undefined;
      if (guardLink && (release.patreon_url || null) !== expectedLink) {
        throw new ReleaseLinkConflictError(id, release.patreon_url || null);
      }

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
      const selectedPlatforms = validateSelectedPlatforms(input, id);
      const changed = release.title !== normalized.title
        || release.description !== normalized.description
        || release.notes !== normalized.notes
        || release.planned_date !== normalized.plannedDate
        || release.planned_time !== normalized.plannedTime
        || release.published_date !== normalized.publishedDate
        || release.patreon_url !== normalized.patreonUrl;
      // The link guard is part of the UPDATE's WHERE clause, and platform
      // selection is replaced only after that row write succeeded inside the
      // same transaction, so a stale link changes nothing.
      const save = () => repository.update(id, normalized,
        guardLink ? { expectedPatreonUrl: expectedLink } : undefined);
      const updated = selectedPlatforms === null ? save() : db.transaction(() => {
        const result = save();
        if (result) replacePlatformSelection(id, selectedPlatforms);
        return result;
      }).immediate();
      if (!updated) {
        // The row changed after the read above; report the current reason
        // rather than treating the unapplied write as success.
        const current = repository.findById(id);
        if (!current) throw new ReleaseNotFoundError(id);
        guardParentProjectNotArchived(current.project_id);
        guardReleaseNotArchived(current);
        if (guardLink && (current.patreon_url || null) !== expectedLink) {
          throw new ReleaseLinkConflictError(id, current.patreon_url || null);
        }
        throw new ReleaseNotFoundError(id);
      }
      if (changed) logActivity('release.updated', updated);
      if (release.planned_date !== normalized.plannedDate
        || release.planned_time !== normalized.plannedTime
        || release.published_date !== normalized.publishedDate) {
        notifyReleaseNotificationState(id);
      }
      return updated;
    },

    /**
     * Date-only quick schedule (or Undo to undated) guarded by the caller's
     * view of the current schedule. Only planned_date, planned_time, and
     * updated_at change; the resulting planned_time is always null.
     *
     * @param {number} id
     * @param {{ plannedDate: string|null, expectedPlannedDate: string|null,
     *   expectedPlannedTime: string|null, plannedTime?: null|'' }} input
     *   all fields but `plannedTime` must be present; null/blank means none
     * @returns {{ release: ReleaseRecord, changed: boolean,
     *   previousSchedule: { plannedDate: string|null, plannedTime: string|null },
     *   schedule: { plannedDate: string|null, plannedTime: string|null } }}
     * @throws {ReleaseNotFoundError|ReleaseParentArchivedError|ReleaseArchivedError|
     *   ReleaseValidationError|ReleaseScheduleConflictError}
     */
    scheduleRelease(id, input) {
      const guardSchedulable = (release) => {
        if (!release) throw new ReleaseNotFoundError(id);
        guardParentProjectNotArchived(release.project_id);
        guardReleaseNotArchived(release);
        if (release.published_date != null) {
          throw new ReleaseValidationError({ plannedDate: 'Published releases cannot be rescheduled here.' });
        }
      };

      const release = repository.findById(id);
      guardSchedulable(release);
      const { schedule, expected } = normalizeScheduleInput(input);

      const previousSchedule = readSchedule(release);
      if (!isSameSchedule(previousSchedule, expected)) {
        throw new ReleaseScheduleConflictError(id, previousSchedule);
      }
      if (isSameSchedule(previousSchedule, schedule)) {
        return { release, changed: false, previousSchedule, schedule: previousSchedule };
      }

      const updated = repository.updateSchedule(id, schedule, expected);
      if (!updated) {
        // The row changed after the read above; report the current reason
        // rather than treating the unapplied write as success.
        const current = repository.findById(id);
        guardSchedulable(current);
        throw new ReleaseScheduleConflictError(id, readSchedule(current));
      }

      logActivity('release.updated', updated);
      notifyReleaseNotificationState(id);
      return { release: updated, changed: true, previousSchedule, schedule: readSchedule(updated) };
    },

    /**
     * Read the stored Release link of a release whose link may be edited
     * (active release inside a non-archived project). Blank is reported as null.
     *
     * @param {number} id
     * @returns {string|null}
     * @throws {ReleaseNotFoundError|ReleaseParentArchivedError|ReleaseArchivedError}
     */
    getEditableReleaseLink(id) {
      const release = repository.findById(id);
      guardReleaseLinkEditable(release, id);
      return release.patreon_url || null;
    },

    /**
     * Release link change guarded by the caller's view of the current link.
     * Only patreon_url and updated_at change; scheduling, publication, assets,
     * and platform selection are untouched. A blank link clears it. When the
     * stored link already equals the requested one the call is an idempotent
     * no-op, whatever the expected value was.
     *
     * @param {number} id
     * @param {{ releaseLink: string|null, expectedReleaseLink: string|null }} input
     *   null/blank means no link
     * @returns {{ release: ReleaseRecord, changed: boolean, releaseLink: string|null }}
     * @throws {ReleaseNotFoundError|ReleaseParentArchivedError|ReleaseArchivedError|
     *   ReleaseValidationError|ReleaseLinkConflictError}
     */
    updateReleaseLink(id, { releaseLink, expectedReleaseLink }) {
      const normalize = (value) => (typeof value === 'string' ? value.trim() : value) || null;

      const release = repository.findById(id);
      guardReleaseLinkEditable(release, id);
      const nextLink = normalize(releaseLink);
      if (!isValidWebUrl(nextLink)) throw new ReleaseValidationError({ patreonUrl: RELEASE_LINK_MESSAGE });
      // The expected value is an opaque snapshot of the stored link: compare it
      // exactly. Only an empty string is equivalent to no link.
      const expected = expectedReleaseLink || null;

      const currentLink = release.patreon_url || null;
      if (currentLink === nextLink) return { release, changed: false, releaseLink: currentLink };
      if (currentLink !== expected) throw new ReleaseLinkConflictError(id, currentLink);

      const updated = repository.updateReleaseLink(id, nextLink, expected);
      if (!updated) {
        // The row changed after the read above; report the current reason
        // rather than treating the unapplied write as success.
        const current = repository.findById(id);
        guardReleaseLinkEditable(current, id);
        throw new ReleaseLinkConflictError(id, current.patreon_url || null);
      }

      logActivity('release.updated', updated);
      return { release: updated, changed: true, releaseLink: updated.patreon_url || null };
    },

    /**
     * Publish a release. Sets published_date to today if not provided.
     * Publication is independent of project workflow status and asset
     * selection state unless the caller requests an optional Project status
     * change, which commits atomically with the publication.
     * @param {number} id
     * @param {string} [publishedDate] - ISO date string YYYY-MM-DD, defaults to today
     * @param {object} [options]
     * @param {string|null} [options.projectStatus] - Optional target Project
     *   status; null/undefined keeps the current status.
     * @returns {ReleaseRecord}
     */
    publishRelease(id, publishedDate = null, { projectStatus = null } = {}) {
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

      const date = publishedDate || getLocalTodayIso();
      if (!isValidDate(date)) {
        throw new ReleaseValidationError({ publishedDate: 'Published date must be a valid date (YYYY-MM-DD).' });
      }

      if (projectStatus !== null && projectStatus !== undefined && typeof projectStatus !== 'string') {
        throw new ReleaseValidationError({ projectStatus: 'Choose a valid project status.' });
      }
      const requestedProjectStatus = projectStatus || null;

      const publish = () => {
        const published = repository.publish(id, date);
        if (!published) {
          throw new ReleaseNotFoundError(id);
        }
        // The Project update runs last inside the publication transaction so
        // its savepoint is the final write before commit.
        if (requestedProjectStatus !== null) {
          updateProjectStatusForPublication(release.project_id, requestedProjectStatus);
        }
        return published;
      };
      const updated = requestedProjectStatus === null ? publish() : db.transaction(publish)();
      logActivity('release.published', updated, getAssetCountContext(id));
      notifyReleaseNotificationState(id);
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
      logActivity('release.archived', archived);
      notifyReleaseNotificationState(id);
      return archived;
    },

    /**
     * Permanently delete a release and its release-assets associations.
     * The existing release_assets foreign key uses ON DELETE CASCADE, so
     * junction rows are removed automatically; underlying project assets
     * are left intact. Deleting a published release is allowed when it is
     * not archived and the parent project is not archived.
     * @param {number} id
     * @returns {boolean} true when the release was deleted
     */
    deleteRelease(id) {
      const release = repository.findById(id);
      if (!release) {
        throw new ReleaseNotFoundError(id);
      }

      // Reject mutations when the parent project has been archived.
      // Archived projects are immutable.
      guardParentProjectNotArchived(release.project_id);

      if (release.archived_at) {
        throw new ReleaseArchivedError(id);
      }

      const assetCountContext = getAssetCountContext(id);
      const deleted = repository.delete(id);
      if (deleted) logActivity('release.deleted', release, assetCountContext);
      return deleted;
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
    getReleaseAssetPresentation(releaseId, selectedAssets = null, clockFormat = '24h') {
      const release = repository.findById(releaseId);
      if (!release) {
        throw new ReleaseNotFoundError(releaseId);
      }

      const rows = Array.isArray(selectedAssets)
        ? selectedAssets
        : repository.listReleaseAssets(releaseId);
      const categories = assetCategoryRepository.listProjectCategories(release.project_id);

      return buildReleaseAssetPagePresentation({
        policyFingerprint: imageFingerprint(),
        selectedAssets: rows,
        assets: [],
        candidateAssets: [],
        categories,
        clockFormat,
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

      // Read ownership/presence for every submitted ID in bounded batches
      // (one statement per SUBMITTED_ASSET_LOOKUP_CHUNK_SIZE IDs, never one
      // per ID). validateSelections has already rejected malformed and
      // duplicate IDs, so every lookup ID is a positive integer bound as a
      // parameter. Rows are keyed by ID; the check below walks the submitted
      // sequence, so error precedence never depends on SQL row order.
      const assetStateById = new Map();
      const lookupIds = [...new Set(assetIds)];
      for (let i = 0; i < lookupIds.length; i += SUBMITTED_ASSET_LOOKUP_CHUNK_SIZE) {
        const batch = lookupIds.slice(i, i + SUBMITTED_ASSET_LOOKUP_CHUNK_SIZE);
        for (const row of assetRepository.findSelectionStatesByIds(batch)) {
          assetStateById.set(row.id, row);
        }
      }

      // Single pass: verify ownership, presence, and gather errors
      // Allow re-selecting already-selected missing assets (for preservation), but reject new missing assets
      const errors = {};
      for (const { assetId } of cleaned) {
        const asset = assetStateById.get(assetId);
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
      const updated = repository.listReleaseAssets(releaseId);
      logMembershipChanges(release, existingReleaseAssets, updated);
      return updated;
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

      const added = repository.addReleaseAsset(releaseId, assetId, role, sortOrder);
      if (added) logActivity('release.assets.added', release, { affectedCount: 1 });
      return added;
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

      const removed = repository.removeReleaseAsset(releaseId, assetId);
      if (removed) logActivity('release.assets.removed', release, { affectedCount: 1 });
      return removed;
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

      const added = repository.insertReleaseAsset(releaseId, assetId, 'attachment', nextOrder);
      if (added) logActivity('release.assets.added', release, { affectedCount: 1 });
      return added;
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

      const removed = repository.removeAndReindexReleaseAsset(releaseId, assetId);
      if (removed) logActivity('release.assets.removed', release, { affectedCount: 1 });
      return removed;
    },

    /**
     * Update the role of one selected asset.
     *
     * Allowed roles: primary, preview, attachment.
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

      const existingSelection = existing.find((row) => row.asset_id === assetId);
      const updated = repository.updateReleaseAssetRole(releaseId, assetId, normalizedRole);
      if (updated && existingSelection.role !== normalizedRole) {
        logActivity('release.asset_role.changed', release, { role: normalizedRole, affectedCount: 1 });
      }
      return updated;
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
     * @returns {{ search: string|null, extension: string|null, selection: 'selected'|'all', page: number, pageSize: number|'all' }}
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

      // P3-C4: only the sizes both page-size controls offer are honoured; any
      // other value (unsupported number, malformed, repeated) falls back to
      // the default 25 so the query, pagination and controls agree on one size.
      const pageSize = normalizeReleaseAssetPageSize(raw.pageSize);

      // Selection: saved selected assets by default; only an explicit 'all'
      // shows the whole eligible project collection.
      const selection = raw.selection === 'all' ? 'all' : 'selected';

      return { search, extension, selection, page, pageSize };
    },

    /**
     * Read every database fact one Manage Assets page model needs inside ONE
     * short synchronous read transaction on the shared connection, so the
     * release, parent project, category catalogue, extension choices, saved
     * membership, whole-project aggregates and the filtered COUNT + page rows
     * all come from the same snapshot. The repository page read nests as a
     * savepoint inside this transaction. No presentation work happens here.
     *
     * Raw request values are normalized HERE (the service is the input
     * authority) before any repository call; the repository only receives
     * normalized values.
     *
     * Editable releases read the complete saved membership through the
     * lightweight membership API (IDs, roles, order, presence — no asset
     * metadata) and only the bounded SQL page of asset metadata rows. Read-only
     * releases additionally need the complete saved collection WITH metadata
     * for display, so they read the existing complete saved-asset API (bounded
     * by the release's membership, never by the project's asset count).
     *
     * `hydrateAssetIds` (Save validation recovery only) are submitted asset
     * IDs whose metadata is needed; those not already on the page are looked
     * up project-scoped and in batches, so a foreign ID never yields metadata.
     *
     * @param {number} releaseId
     * @param {Object} rawQuery
     * @param {{ hydrateAssetIds?: number[] }} [options]
     */
    readReleaseAssetManagementSnapshot(releaseId, rawQuery = {}, { hydrateAssetIds = [] } = {}) {
      const read = db.transaction(() => {
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

        // Invalid category syntax is 422; a well-formed ID that is unknown or
        // owned by another project is 404. Category access is never widened.
        const activeCategoryId = normalizeOptionalCategoryId(readCategoryFilter(rawQuery));
        const categories = assetCategoryRepository.listProjectCategories(release.project_id);
        if (
          activeCategoryId !== null
          && !assetCategoryRepository.findProjectCategoryById(release.project_id, activeCategoryId)
        ) {
          throw new AssetCategoryNotFoundError(activeCategoryId);
        }

        const assetFilters = this.normalizeCandidateQuery(rawQuery);
        const readOnly = isReleaseAssetManagementReadOnly(release, project);

        // Complete saved membership in stored order (sort_order, asset_id),
        // including missing and off-page members.
        const releaseAssets = readOnly
          ? repository.listReleaseAssets(releaseId)
          : repository.listReleaseAssetMembership(releaseId, { projectId: release.project_id });

        const aggregates = assetRepository.getManageAssetsAggregates({
          releaseId,
          projectId: release.project_id,
        });

        // Editable: the one authoritative filtered predicate, COUNT and
        // bounded page (LIMIT/OFFSET; only the exact normalized 'all' is View
        // All). Read-only (B-F1): the display is the complete saved collection
        // above and the template renders no editable page, page count, total
        // or pagination, so the editable page is never queried. The empty
        // page is one unpaginated page carrying the normalized size and
        // selection for URL preservation; filtered totals are not computed
        // (null) rather than replaced with invented values.
        const pageResult = readOnly
          ? {
            rows: [],
            total: null,
            candidateTotal: null,
            page: 1,
            pageCount: 1,
            pageSize: assetFilters.pageSize,
            selection: assetFilters.selection,
          }
          : assetRepository.getManageAssetsPage({
            releaseId,
            projectId: release.project_id,
            search: assetFilters.search,
            extension: assetFilters.extension,
            categoryId: activeCategoryId,
            selection: assetFilters.selection,
            page: assetFilters.page,
            pageSize: assetFilters.pageSize,
          });

        const assetExtensions = assetRepository.getExtensions(release.project_id);

        const knownIds = new Set(pageResult.rows.map((row) => row.id));
        if (readOnly) {
          for (const row of releaseAssets) knownIds.add(row.asset_id);
        }
        // Read-only pages display only the persisted saved collection, so a
        // rejected Save's submitted IDs are never hydrated there (B-F4).
        const lookupIds = readOnly ? [] : [...new Set((Array.isArray(hydrateAssetIds) ? hydrateAssetIds : [])
          .filter((id) => Number.isSafeInteger(id) && id > 0 && !knownIds.has(id)))];
        const hydratedAssets = [];
        for (let i = 0; i < lookupIds.length; i += SUBMITTED_ASSET_LOOKUP_CHUNK_SIZE) {
          hydratedAssets.push(...assetRepository.findProjectAssetsByIdsInBrowserOrder(
            release.project_id,
            lookupIds.slice(i, i + SUBMITTED_ASSET_LOOKUP_CHUNK_SIZE),
          ));
        }

        return {
          release,
          project,
          readOnly,
          categories,
          activeCategoryId,
          assetFilters,
          releaseAssets,
          aggregates,
          pageResult,
          assetExtensions,
          hydratedAssets,
        };
      });
      return read();
    },

    /**
     * Compose the release asset-management page view-model.
     *
     * Returns:
     *   - release
     *   - project
     *   - readOnly — published/archived release or archived parent project
     *   - releaseAssets — complete saved membership in stored order, including
     *     missing and off-page members. Editable: lightweight records
     *     { asset_id, role, sort_order, is_present }. Read-only: complete saved
     *     asset rows with metadata (the read-only display collection).
     *   - categories — all project-owned categories for the filter control
     *   - categoryNavigation — whole-project category counts for the disclosure
     *   - activeCategoryId — selected project category ID, or null
     *   - assetPage — current filtered page rows (SQL LIMIT/OFFSET; every
     *     filtered row only for explicit View All)
     *   - assetTotal — total filtered project asset collection
     *   - assetPageNumber — clamped page number
     *   - assetPageSize — effective page size (a supported number or 'all')
     *   - assetPageCount — total pages
     *   - assetFilters — normalized filter values; selection is 'selected'
     *     (saved membership, the default) or 'all'
     *   - assetExtensions — available project extension values
     *   - candidateTotal — filtered rows that are not saved members
     *     Read-only: the editable page is not queried, so assetPage and
     *     candidates are empty, page/pageCount are 1, the size and selection
     *     are the normalized request values and assetTotal/candidateTotal
     *     are null (not computed; the read-only page renders none of them).
     *   - eligibleAssetCount — present project assets, selected or not
     *   - eligibleCandidateCount — present project assets not selected
     *   - assetPresentation — `assets` (page cards merged with saved
     *     role/order), `candidates` (page non-members) and `selected`.
     *     Read-only: `selected` is the complete saved collection (the
     *     display). Editable: `selected` holds only the saved members on the
     *     current page, in saved order; the complete saved base is
     *     `releaseAssets`.
     *
     * There is no whole-project asset array: no consumer may assume one.
     *
     * @param {number} releaseId
     * @param {Object} rawQuery - raw query parameters for candidate filters
     * @param {'12h'|'24h'} [clockFormat]
     */
    getReleaseAssetManagementPage(releaseId, rawQuery = {}, clockFormat = '24h') {
      const snapshot = this.readReleaseAssetManagementSnapshot(releaseId, rawQuery);
      return buildReleaseAssetManagementViewModel(snapshot, clockFormat);
    },

    /**
     * Manage Assets view-model for a rejected Save (422). The page, counts
     * and persisted membership are the same snapshot as a normal GET; the
     * SUBMITTED selection (IDs, roles, relative order — including off-page
     * additions/removals and hidden selections) is kept separate from the
     * persisted membership and presented with metadata from the visible page
     * rows plus one batched, project-scoped lookup of the remaining submitted
     * IDs. A foreign or unknown submitted ID keeps only its submitted fields.
     *
     * @param {number} releaseId
     * @param {Object} rawQuery
     * @param {Array<{ asset_id: number, role: string, sort_order: number }>} submittedAssets
     * @param {'12h'|'24h'} [clockFormat]
     */
    getReleaseAssetSaveErrorPage(releaseId, rawQuery = {}, submittedAssets = [], clockFormat = '24h') {
      const submitted = Array.isArray(submittedAssets) ? submittedAssets : [];
      const snapshot = this.readReleaseAssetManagementSnapshot(releaseId, rawQuery, {
        hydrateAssetIds: submitted.map((entry) => entry?.asset_id),
      });
      const viewModel = buildReleaseAssetManagementViewModel(snapshot, clockFormat);

      const sourceById = new Map();
      const projectId = snapshot.release.project_id;
      for (const row of [
        ...snapshot.pageResult.rows,
        ...(snapshot.readOnly ? snapshot.releaseAssets : []),
        ...snapshot.hydratedAssets,
      ]) {
        const id = row?.asset_id ?? row?.id;
        // Defence in depth: only same-project rows may supply metadata.
        if (id !== undefined && id !== null && row.project_id === projectId) sourceById.set(String(id), row);
      }

      const selectedAssets = submitted.map((entry) => {
        const source = sourceById.get(String(entry.asset_id));
        return source
          ? { ...source, asset_id: entry.asset_id, role: entry.role, sort_order: entry.sort_order }
          : entry;
      });
      const selectedIds = new Set(selectedAssets.map((asset) => String(asset.asset_id)));
      const assetPage = snapshot.pageResult.rows;

      return {
        ...viewModel,
        submittedReleaseAssets: submitted,
        submittedAssetPresentation: buildReleaseAssetPagePresentation({
          policyFingerprint: imageFingerprint(),
          selectedAssets,
          assets: assetPage,
          candidateAssets: assetPage.filter((asset) => !selectedIds.has(String(asset.id))),
          categories: snapshot.categories,
          clockFormat,
        }),
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

      const outcome = repository.appendAssetsToRelease(normalizedReleaseId, normalizedAssetIds);
      if (outcome.added > 0) {
        logActivity('release.assets.added', release, { affectedCount: outcome.added });
      }
      return outcome;
    },
  };
}
