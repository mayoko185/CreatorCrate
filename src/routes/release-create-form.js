import { formatLocalDate, formatLocalTime } from '../util/date.js';
import { SOCIAL_PREP_SUPPORTED_PLATFORMS } from '../services/social-prep-settings-service.js';
import { isProjectArchived } from '../services/project-state.js';

// New Release form-model construction, shared by every page that hosts the
// New Release form or dialog (the Releases routes and the Dashboard renderer)
// so they render identical defaults, project options and catalogues.

const NO_SET_RELEASE_DATE_VALUE = '1';
const RETAINED_SCHEDULE_FIELDS = Object.freeze({
  plannedDate: 'retainedPlannedDate',
  plannedTime: 'retainedPlannedTime',
});
const RETAINED_SCHEDULE_MAX_LENGTH = 32;

export function isNoSetReleaseDateSelected(source) {
  return source?.noSetReleaseDate === NO_SET_RELEASE_DATE_VALUE;
}

// The schedule the client set aside when "No set release date" was checked.
// It is form state only: echoed back on a checked validation rerender so
// unchecking can restore it, and never read when creating a release. A draft
// exists only when both fields arrive as strings; either may be blank.
function readRetainedScheduleDraft(source) {
  const plannedDate = source?.[RETAINED_SCHEDULE_FIELDS.plannedDate];
  const plannedTime = source?.[RETAINED_SCHEDULE_FIELDS.plannedTime];
  if (typeof plannedDate !== 'string' || typeof plannedTime !== 'string') return null;
  return {
    plannedDate: plannedDate.slice(0, RETAINED_SCHEDULE_MAX_LENGTH),
    plannedTime: plannedTime.slice(0, RETAINED_SCHEDULE_MAX_LENGTH),
  };
}

// Schedule fields that were supplied (query prefill or submitted draft) are
// kept exactly as sent, including intentional blanks; only fields that were
// never supplied fall back to defaults.
function buildNewReleaseFormValues(rawQuery, { isFreshCreate = true } = {}) {
  const query = rawQuery && typeof rawQuery === 'object' && !Array.isArray(rawQuery)
    ? omitLegacyStatusField(rawQuery)
    : {};
  // Raw retained fields never pass through as ordinary form values.
  Object.values(RETAINED_SCHEDULE_FIELDS).forEach((field) => delete query[field]);
  const now = new Date();
  const noSetReleaseDate = isNoSetReleaseDateSelected(query);
  const scheduleValue = (field, fallback) => {
    if (noSetReleaseDate) return '';
    if (Object.hasOwn(query, field)) return query[field] ?? '';
    return fallback;
  };

  const values = {
    ...query,
    selectedPlatforms: readSubmittedSocialPlatforms(query.selectedPlatforms),
    noSetReleaseDate,
    retainedSchedule: noSetReleaseDate && !isFreshCreate ? readRetainedScheduleDraft(rawQuery) : null,
    plannedDate: scheduleValue('plannedDate', formatLocalDate(now)),
    plannedTime: scheduleValue('plannedTime', formatLocalTime(now)),
  };

  if (Object.hasOwn(query, 'selectedAssetIds')) {
    const normalized = normalizeSelectedAssetIds(query.selectedAssetIds);
    values.selectedAssetIds = normalized.valid ? normalized.ids : [];
  }

  return values;
}

function hasOwnField(source, field) {
  return Boolean(source) && typeof source === 'object' && Object.hasOwn(source, field);
}

export function omitLegacyStatusField(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'status'));
}

export function buildCreateReleaseFormModel({
  appName,
  projectService,
  values = {},
  errors = {},
  selectedAssetsFlow = false,
  selectedAssetsReturnTo = '',
  selectedAssetsInvalid = false,
  selectedAssetsRecoveryUrl = null,
  invocationReturnTo = '',
  isFreshCreate = true,
}) {
  const formValues = buildNewReleaseFormValues(values, { isFreshCreate });
  const context = buildReleaseFormProjectContext(formValues.projectId, projectService);

  return {
    appName,
    release: null,
    values: formValues,
    resetValues: isFreshCreate ? null : buildNewReleaseFormValues(selectedAssetsFlow
      ? {
        projectId: formValues.projectId,
        title: context.projects.find((project) => project.id === context.selectedProjectId)?.title || '',
        selectedAssetIds: formValues.selectedAssetIds,
      }
      : {}),
    errors,
    projects: context.projects,
    selectedProjectId: context.selectedProjectId,
    action: 'Create',
    submitUrl: '/releases',
    selectedAssetsFlow,
    selectedAssetsReturnTo,
    selectedAssetsInvalid,
    selectedAssetsRecoveryUrl,
    invocationReturnTo,
    isFreshCreate,
    noSetReleaseDate: formValues.noSetReleaseDate,
    // The client replaces placeholder schedule defaults with browser-local
    // time; explicit prefills (even blank ones) and validation drafts are left
    // untouched, so presence, not truthiness, decides.
    scheduleDefaulted: isFreshCreate && !formValues.noSetReleaseDate
      && !hasOwnField(values, 'plannedDate') && !hasOwnField(values, 'plannedTime'),
  };
}

export function readSubmittedSocialPlatforms(value) {
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

/**
 * Resolve a GET /releases/new `projectId` query value against the loaded
 * project options, returning the options to render (possibly extended) and
 * the trusted, normalized selected project id (or null when the context
 * should be treated as absent: malformed, nonexistent, or archived).
 * `parseStrictInt` rejects non-string/non-number input outright, so repeated
 * query params (which Express returns as an array) are already excluded.
 *
 * `projects` is the already-locally-filtered (active-only) project page for
 * the selector; checking membership there avoids a second query in the
 * common case. Because local filtering can shrink the array independent of
 * whether the original repository page was full, completeness must not be
 * inferred from `projects.length` — the caller passes `originalPageWasFull`
 * (computed from the unfiltered page, before local filtering) explicitly.
 * Only when the original page was full (and could therefore be missing a
 * valid project beyond the cap) does this fall back to a direct lookup — and
 * when that lookup finds a valid active project not already present, it is
 * appended to the returned options so the selector can render it as selected.
 *
 * @returns {{ projects: object[], selectedProjectId: number|null }}
 */
/**
 * Load and locally filter the project options for a release form, then
 * resolve the given raw projectId against them via resolveReleaseFormContext.
 * Shared by GET /releases/new and the POST /releases validation-error
 * re-render so both paths apply identical archive, paging, and lookup rules.
 */
function buildReleaseFormProjectContext(rawProjectId, projectService) {
  const { rows: originalProjects } = projectService.list({ includeArchived: false, limit: 100 });
  const originalPageWasFull = originalProjects.length === 100;
  const activeProjects = originalProjects.filter((project) => !isProjectArchived(project));
  return resolveReleaseFormContext(rawProjectId, activeProjects, projectService, { originalPageWasFull });
}

function resolveReleaseFormContext(rawProjectId, projects, projectService, { originalPageWasFull }) {
  const id = parseStrictInt(rawProjectId);
  if (id === null) return { projects, selectedProjectId: null };

  const existing = projects.find((project) => project.id === id);
  if (existing) {
    return { projects, selectedProjectId: id };
  }

  if (!originalPageWasFull) return { projects, selectedProjectId: null };

  const project = projectService.findById(id);
  if (!project || isProjectArchived(project)) {
    return { projects, selectedProjectId: null };
  }

  return { projects: [...projects, project], selectedProjectId: id };
}

/**
 * Parse an integer strictly — rejects non-numeric strings, floats, hex,
 * leading zeros, values above Number.MAX_SAFE_INTEGER, and any value
 * Number() would silently round (e.g. digit strings beyond the range
 * doubles can represent exactly). Returns null unless the value is a
 * canonical positive safe integer. Does NOT use parseInt as validation.
 */
export function parseStrictInt(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const str = String(value).trim();
  if (!/^[1-9]\d*$/.test(str)) return null;
  const num = Number(str);
  if (!Number.isSafeInteger(num) || num < 1) return null;
  if (String(num) !== str) return null;
  return num;
}

/**
 * Normalize a form's selectedAssetIds value to a structured result.
 *
 * Express urlencoded parsing produces:
 *   - `selectedAssetIds=5`          → string "5"
 *   - `selectedAssetIds[]=5`        → ["5"]
 *   - `selectedAssetIds[]=5&selectedAssetIds[]=6` → ["5", "6"]
 *   - `selectedAssetIds[0]=5`       → { "0": "5" }
 *   - missing                       → undefined
 *
 * Returns `{ valid, ids }` so the caller can distinguish:
 *   - field absent (`undefined`) or intentionally empty (`''`) → `{ valid: true, ids: [] }`
 *   - malformed shape (including `null`)                      → `{ valid: false, ids: [] }`
 *
 * Accepted shapes:
 *   - absent (undefined) — intentional clear
 *   - empty string '' — intentional clear
 *   - one scalar string ID
 *   - a flat array of scalar string/number IDs
 *   - a flat object with numeric keys whose values are scalar string/number IDs
 *
 * Rejected shapes:
 *   - null, nested arrays, nested objects, objects with non-numeric keys,
 *     mixed nested/scalar values, booleans, arbitrary object shapes
 *
 * @param {*} raw - the raw req.body.selectedAssetIds value
 * @returns {{ valid: boolean, ids: string[] }}
 */
export function normalizeSelectedAssetIds(raw) {
  if (raw === undefined) return { valid: true, ids: [] };
  if (raw === null) return { valid: false, ids: [] };
  if (typeof raw === 'string') {
    if (raw === '') return { valid: true, ids: [] };
    return { valid: true, ids: [raw] };
  }
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (typeof v !== 'string' && typeof v !== 'number') return { valid: false, ids: [] };
    }
    return { valid: true, ids: raw.map(String) };
  }
  // Object-shaped (numeric keys from extended parsing) — flatten values
  if (typeof raw === 'object' && raw !== null) {
    const keys = Object.keys(raw);
    for (const key of keys) {
      if (!/^\d+$/.test(key)) return { valid: false, ids: [] };
    }
    const values = Object.values(raw);
    for (const v of values) {
      if (typeof v !== 'string' && typeof v !== 'number') return { valid: false, ids: [] };
    }
    return { valid: true, ids: values.map(String) };
  }
  return { valid: false, ids: [] };
}

export function getReleaseSignatureConfiguration(req) {
  return req.app.locals.releaseSignatureSettingsService.getConfiguration();
}

export function getReleasePlatformChoices(req, savedPlatforms = []) {
  const configured = req.app.locals.socialPrepSettingsService.getPlatforms();
  return SOCIAL_PREP_SUPPORTED_PLATFORMS.filter((platform) => configured.includes(platform) || savedPlatforms.includes(platform))
    .map((platform) => ({ value: platform, label: platform === 'x' ? 'X' : platform === 'bluesky' ? 'Bluesky' : 'Patreon' }));
}
