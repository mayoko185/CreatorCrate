import express from 'express';
import { buildPageUrl } from './releases.js';
import { buildPageDefaultsDialogModel, handlePageDefaultsPost } from './page-defaults.js';
import { getReleasePlatformChoices, getReleaseSignatureConfiguration } from './release-create-form.js';
import { NSFW_TAG_NAME } from '../services/nsfw-filter-settings-service.js';
import {
  PAGE_DEFAULT_DEFINITIONS,
  PageDefaultsGenerationConflictError,
} from '../services/page-defaults-service.js';
import { isSafeRedirectTarget } from '../middleware/auth.js';

const CALENDAR_DEFAULT_LABELS = Object.freeze({
  fields: { view: 'Desktop view', status: 'Release status', weekStart: 'Week starts on' },
  options: {
    view: { grid: 'Calendar', list: 'List' },
    status: { all: 'All releases', planned: 'Planned', published: 'Published' },
    weekStart: { monday: 'Monday', sunday: 'Sunday' },
  },
});

// WP14a: Calendar's saveable defaults are exactly the page definition's three
// Global settings (Desktop View, Release status, Week start), in its order.
// The displayed month, Projects, Project Types and any navigation or release
// editing state are temporary and never saved. No Global/Project-only scope.
const CALENDAR_PAGE_DEFAULTS = 'calendar';
const CALENDAR_DEFAULT_FIELDS = Object.freeze(Object.keys(PAGE_DEFAULT_DEFINITIONS[CALENDAR_PAGE_DEFAULTS]));
// The reviewed WP9a F6/F7 mutation protocol (as WP12 Releases), on the
// Calendar page key: every Save / Reset defaults request carries the durable
// generation it was prepared from and a client-chosen operation identity.
const CALENDAR_DEFAULTS_GENERATION_FIELD = 'defaultsGeneration';
const CALENDAR_DEFAULTS_OPERATION_FIELD = 'defaultsOperation';
const CALENDAR_DEFAULTS_OPERATION_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const CALENDAR_DEFAULTS_CONFLICT_CODE = 'DEFAULTS_GENERATION_CONFLICT';
const CALENDAR_DEFAULTS_CONFLICT_MESSAGE = 'Calendar defaults changed since this page was loaded. '
  + 'No changes were made. Review the current defaults and try again.';
const CALENDAR_DEFAULTS_SAVED_MESSAGE = 'Calendar defaults saved successfully.';
const CALENDAR_DEFAULTS_INVALID_MESSAGE = 'Calendar defaults were not saved. Check the selected values and try again.';
const CALENDAR_DEFAULTS_RESET_MESSAGE = 'Calendar defaults reset to the application defaults.';
const CALENDAR_NOTICES = Object.freeze({ calendar_defaults_saved: CALENDAR_DEFAULTS_SAVED_MESSAGE });
// A displayable Calendar month (the range workflow-query-service accepts).
const CALENDAR_MONTH_PATTERN = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/;

function parseProjectId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

// Express parses a repeated query key into an array; a single key stays a
// scalar. Either form becomes a flat value list (absent → []).
function toQueryValueList(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// A valid ID is a restriction even when its Project is absent from the option catalogue.
function normalizeCalendarProjectIds(value) {
  return [...new Set(toQueryValueList(value).map(parseProjectId).filter((id) => id !== null))]
    .sort((left, right) => left - right);
}

// One selection keeps the legacy scalar URL form; several serialize as
// repeated values (never comma-joined) in normalized order.
function toScalarOrRepeated(values) {
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : [...values];
}

/**
 * WP14b: the Projects multi-select options. Values are the stable Project IDs
 * (strings, as the URL carries them); an archived Project stays selectable and
 * reads "Archived" beside its title (presentation only).
 */
function buildCalendarProjectFilterOptions(projectOptions, selectedProjectIds) {
  const selected = new Set(selectedProjectIds);
  return projectOptions.map((project) => ({
    value: String(project.id),
    label: project.title,
    selected: selected.has(project.id),
    ...(project.archived_at ? {
      suffix: 'Archived',
      classes: 'calendar-project-option--archived',
      attributes: [['data-calendar-archived-project', true]],
    } : {}),
  }));
}

function isEnhancedCalendarDefaultsRequest(req) {
  return String(req.get?.('Accept') || '').toLowerCase().includes('application/json');
}

function readCalendarDefaultsMutationRequest(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const generation = body[CALENDAR_DEFAULTS_GENERATION_FIELD];
  const operation = body[CALENDAR_DEFAULTS_OPERATION_FIELD];
  const parsedGeneration = typeof generation === 'string' && /^(0|[1-9]\d*)$/.test(generation)
    ? Number(generation)
    : Number.NaN;
  return {
    // Missing or malformed: null, which never matches the stored generation.
    expectedGeneration: Number.isSafeInteger(parsedGeneration) ? parsedGeneration : null,
    operationId: typeof operation === 'string' && CALENDAR_DEFAULTS_OPERATION_PATTERN.test(operation)
      ? operation
      : null,
  };
}

// The request-correlated acknowledgement. `generation` is the stored
// generation this answer establishes: the new one after a commit, the current
// one on a conflict, and null when the handler made no claim about it.
function calendarDefaultsOperationAcknowledgement(kind, mutation, { result, generation = null }) {
  return {
    operation: {
      id: mutation.operationId,
      kind,
      result,
      committed: result === 'committed',
      expectedGeneration: mutation.expectedGeneration,
      generation,
    },
  };
}

// A URLSearchParams as an Express-style query object: a repeated key becomes
// an array, a single key a scalar.
function queryFromSearchParams(params) {
  const query = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    query[key] = values.length === 1 ? values[0] : values;
  }
  return query;
}

// The Calendar location a defaults mutation was made from (`returnTo`), as a
// raw query object; null unless it is a same-origin /calendar address.
function readCalendarReturnQuery(req) {
  const candidate = req.body?.returnTo;
  if (typeof candidate !== 'string' || !isSafeRedirectTarget(candidate)) return null;
  try {
    const url = new URL(candidate, 'http://creatorcrate.local');
    if (url.origin !== 'http://creatorcrate.local' || url.pathname !== '/calendar') return null;
    return queryFromSearchParams(url.searchParams);
  } catch {
    return null;
  }
}

function fingerprintCalendarDefaults(text) {
  // FNV-1a (32-bit): a compact revision token, not a security boundary.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * WP14a authoritative Calendar defaults metadata. Saved status is stored key
 * presence (describeSavedDefaults), never a comparison with the fallback, so
 * an explicitly saved fallback-equal value still reports saved. Calendar
 * defaults are Global only. `extra` adds the rendered page's own state
 * (`current`, `currentUrl`, `month`, its Reset filters destination).
 */
export function buildCalendarDefaultsAuthority(pageDefaultsService, extra = {}) {
  const description = pageDefaultsService.describeSavedDefaults(CALENDAR_PAGE_DEFAULTS);
  const defaults = pageDefaultsService.resolveGlobalPageDefaults(CALENDAR_PAGE_DEFAULTS);
  const fallbacks = Object.fromEntries(CALENDAR_DEFAULT_FIELDS.map((field) => [
    field,
    pageDefaultsService.getFallback(CALENDAR_PAGE_DEFAULTS, field),
  ]));
  const saved = Object.fromEntries(CALENDAR_DEFAULT_FIELDS.map((field) => [field, {
    stored: description.options[field].global.stored,
    valid: description.options[field].global.valid,
  }]));
  const savedKeys = CALENDAR_DEFAULT_FIELDS.filter((field) => saved[field].stored);
  return {
    page: CALENDAR_PAGE_DEFAULTS,
    fields: [...CALENDAR_DEFAULT_FIELDS],
    multiFields: [],
    fallbacks,
    defaults,
    saved,
    savedKeys,
    hasSavedDefaults: savedKeys.length > 0,
    generation: pageDefaultsService.getMutationGeneration(CALENDAR_PAGE_DEFAULTS),
    revision: fingerprintCalendarDefaults(JSON.stringify({ defaults, saved })),
    resetFiltersUrl: '/calendar',
    ...extra,
  };
}

function serializeCalendarAuthorityJson(authority) {
  return JSON.stringify(authority).replace(/</g, '\\u003c');
}

export function createCalendarRouter({ appName, db, workflowQueryService, pageDefaultsService, projectService,
  projectTagService, nsfwFilterSettingsService }) {
  const router = express.Router();

  // Every Calendar URL is built against the canonical /calendar path, also
  // when a defaults POST renders or redirects.
  function calendarUrlRequest(req) {
    return { baseUrl: req.baseUrl || '/calendar', path: '/' };
  }

  /**
   * The temporary Calendar context of a raw query, canonical: the displayed
   * month, the repeated Project and Project Type selections (validated as the
   * GET does) and, when `presentation` is set, the explicit View / status /
   * week start. Repeated values stay repeated, never String(array).
   */
  function calendarContextUrl(req, rawQuery, { presentation = false } = {}) {
    const source = rawQuery && typeof rawQuery === 'object' ? rawQuery : {};
    const query = {};
    if (typeof source.month === 'string' && CALENDAR_MONTH_PATTERN.test(source.month)) query.month = source.month;
    if (presentation) {
      if (['all', 'planned', 'published'].includes(source.status)) query.status = source.status;
      if (['monday', 'sunday'].includes(source.weekStart)) query.weekStart = source.weekStart;
      if (['grid', 'list'].includes(source.view)) query.view = source.view;
    }
    const projectIds = normalizeCalendarProjectIds(source.project);
    const projectQuery = toScalarOrRepeated(projectIds.map(String));
    if (projectQuery !== undefined) query.project = projectQuery;
    const typeQuery = toScalarOrRepeated(workflowQueryService.normalizeProjectTypeSelection(source.type));
    if (typeQuery !== undefined) query.type = typeQuery;
    return buildPageUrl(calendarUrlRequest(req), query)({});
  }

  function renderCalendar(req, res, next, { status: httpStatus = 200, rawQuery = req.query, notice = null } = {}) {
    try {
      const source = rawQuery && typeof rawQuery === 'object' ? rawQuery : {};
      const month = source.month || null;
      const status = ['all', 'planned', 'published'].includes(source.status) ? source.status : undefined;
      const weekStart = ['monday', 'sunday'].includes(source.weekStart) ? source.weekStart : undefined;
      const view = ['grid', 'list'].includes(source.view) ? source.view : undefined;
      const defaults = pageDefaultsService.resolvePageDefaults('calendar', {
        view,
        status,
        weekStart,
      });
      const projectOptions = projectService.listCalendarFilterOptions();
      const projectIds = normalizeCalendarProjectIds(source.project);
      // Stable catalogue values only; unknown or stale Types are dropped. Types
      // are temporary filters and never saved defaults.
      const projectTypes = workflowQueryService.normalizeProjectTypeSelection(source.type);
      const selectedProjects = projectOptions.filter(({ id }) => projectIds.includes(id));
      const resolvedProjectIds = new Set(selectedProjects.map(({ id }) => id));
      const carriedProjectIds = projectIds.filter((id) => !resolvedProjectIds.has(id));
      const projectId = projectIds.length === 1 ? projectIds[0] : null;
      const selectedProject = projectId === null ? null : selectedProjects[0] ?? null;
      const calendar = workflowQueryService.getReleaseCalendar(month, {
        projectIds,
        projectTypes,
        weekStart: defaults.weekStart,
      });
      const { month: validatedMonth, firstDayWeekday, prevMonthDaysCount, prevMonth, nextMonth, today } = calendar;
      const filteredDays = defaults.status === 'all' ? calendar.days : calendar.days.map((day) => ({
        ...day,
        entries: day.entries.filter((entry) => entry.status === defaults.status),
      }));
      const nsfwProjectIds = new Set();
      if (nsfwFilterSettingsService?.isEnabled()) {
        const projectIds = new Set(filteredDays.flatMap((day) => day.entries.map((entry) => entry.project_id)));
        for (const id of projectIds) {
          if (projectTagService.listProjectTags(id).some((tag) =>
            [tag.displayName, tag.display_name, tag.normalizedName, tag.normalized_name]
              .some((name) => typeof name === 'string' && name.trim().toLowerCase() === NSFW_TAG_NAME.toLowerCase()))) {
            nsfwProjectIds.add(id);
          }
        }
      }
      const monthHeading = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })
        .format(new Date(`${validatedMonth}-01T00:00:00Z`));
      const releaseCount = filteredDays.reduce((count, day) => count + day.entries.length, 0);
      const query = {};
      if (validatedMonth) query.month = validatedMonth;
      if (status !== undefined) query.status = status;
      if (weekStart !== undefined) query.weekStart = weekStart;
      if (view !== undefined) query.view = view;
      const projectQuery = toScalarOrRepeated(projectIds.map(String));
      if (projectQuery !== undefined) query.project = projectQuery;
      const typeQuery = toScalarOrRepeated(projectTypes);
      if (typeQuery !== undefined) query.type = typeQuery;
      const pageUrl = buildPageUrl(calendarUrlRequest(req), query);
      const days = filteredDays.map((day) => ({
        ...day,
        entries: day.entries.map((entry) => ({
          ...entry,
          nsfwBlur: nsfwProjectIds.has(entry.project_id),
          // The canonical Release Detail deep link, for modified clicks and
          // copied links; a plain click edits in place (release-edit-dialog.js).
          editUrl: entry.canEdit ? `/releases/${entry.id}?edit=1` : null,
        })),
      }));
      const isCurrentMonth = validatedMonth === today.slice(0, 7);
      // WP14a: the authority of this rendered page — the effective View,
      // status and week start it shows (`current`, the one coherent Save
      // snapshot), saved-key presence, fallbacks and the durable generation.
      // Its Reset filters destination keeps only the displayed month: View,
      // status and week start resolve from the saved defaults (then the
      // fallbacks) and Projects / Project Types are cleared. A read failure
      // fails closed: no authority, so nothing can be saved from this page.
      let calendarDefaultsAuthority = null;
      try {
        calendarDefaultsAuthority = buildCalendarDefaultsAuthority(pageDefaultsService, {
          current: { view: defaults.view, status: defaults.status, weekStart: defaults.weekStart },
          currentUrl: pageUrl({}),
          month: validatedMonth,
          resetFiltersUrl: pageUrl({ status: null, weekStart: null, view: null, project: null, type: null }),
        });
      } catch {
        calendarDefaultsAuthority = null;
      }

      res.status(httpStatus).render('releases/calendar.njk', {
        appName,
        month: validatedMonth,
        monthHeading,
        releaseCount,
        days,
        firstDayWeekday,
        prevMonthDaysCount,
        prevMonth,
        nextMonth,
        today,
        isCurrentMonth,
        query,
        pageUrl,
        status: defaults.status,
        view: defaults.view,
        weekStart: defaults.weekStart,
        projectId,
        selectedProject,
        projectOptions,
        // WP13 multi-select state for the WP14b combined dialog: every
        // Calendar Project option and every catalogue Project Type, never
        // derived from the current month's entries.
        projectIds,
        selectedProjects,
        projectTypes,
        projectTypeOptions: workflowQueryService.getProjectTypeFilterOptions(projectTypes),
        // WP14b: the combined dialog's searchable Projects multi-select. Every
        // Calendar Project option (archived ones included and marked), in the
        // option source's order; selections are the normalized IDs.
        projectFilterOptions: buildCalendarProjectFilterOptions(projectOptions, projectIds),
        projectFilterSelectedValues: projectIds.map(String),
        carriedProjectIds,
        // Reset filters is the authority's destination (the displayed month
        // only): View, status and week start resolve from the saved defaults.
        resetFiltersUrl: calendarDefaultsAuthority?.resetFiltersUrl
          ?? pageUrl({ status: null, weekStart: null, view: null, project: null, type: null }),
        calendarDefaultsAuthority,
        // GET /calendar/defaults sends a typed (non-JSON) visit here.
        calendarDefaultsDialogOpen: source.defaults === '1',
        calendarDefaultsAuthorityJson: calendarDefaultsAuthority
          ? serializeCalendarAuthorityJson(calendarDefaultsAuthority)
          : '',
        calendarDefaultsNotice: notice,
        calendarDefaults: buildPageDefaultsDialogModel({
          pageDefaultsService,
          page: 'calendar',
          labels: CALENDAR_DEFAULT_LABELS,
        }),
        // For the shared Edit Release dialog, which loads each release's own
        // values and platform choices when an Edit action opens it.
        releaseSignatureConfiguration: getReleaseSignatureConfiguration(req),
        platformChoices: getReleasePlatformChoices(req),
      });
    } catch (err) {
      next(err);
    }
  }

  // GET /calendar — Monthly release-backed calendar view
  router.get('/', (req, res, next) => {
    renderCalendar(req, res, next, {
      notice: Object.hasOwn(CALENDAR_NOTICES, String(req.query.notice)) ? CALENDAR_NOTICES[req.query.notice] : null,
    });
  });

  // WP14a read-only authority: the current saved-state metadata, for
  // reopening Filters & Defaults or reconciling an uncertain Save / Reset
  // defaults outcome. It never writes. A non-JSON request (a typed URL) opens
  // Calendar instead.
  router.get('/defaults', (req, res, next) => {
    if (!isEnhancedCalendarDefaultsRequest(req)) {
      res.redirect('/calendar?defaults=1');
      return;
    }
    try {
      res.set('Cache-Control', 'no-store');
      res.json({ status: 'success', authority: buildCalendarDefaultsAuthority(pageDefaultsService) });
    } catch (err) {
      next(err);
    }
  });

  // A stale or missing generation: nothing was written (the fence threw inside
  // the write transaction, which rolled back). JSON clients get a correlated
  // 409 with the current authority when it can be read; a native post
  // re-renders Calendar (its month and temporary filters) with the conflict.
  function respondCalendarDefaultsConflict(req, res, next, { kind, mutation, err, enhanced }) {
    if (enhanced) {
      let authority = null;
      try {
        authority = buildCalendarDefaultsAuthority(pageDefaultsService);
      } catch {
        authority = null;
      }
      res.status(409).json({
        ...calendarDefaultsOperationAcknowledgement(kind, mutation, {
          result: 'conflict', generation: err.currentGeneration,
        }),
        status: 'error',
        code: CALENDAR_DEFAULTS_CONFLICT_CODE,
        message: CALENDAR_DEFAULTS_CONFLICT_MESSAGE,
        ...(authority && authority.generation === err.currentGeneration ? { authority } : {}),
      });
      return;
    }
    renderCalendar(req, res, next, {
      status: 409,
      rawQuery: readCalendarReturnQuery(req) ?? {},
      notice: CALENDAR_DEFAULTS_CONFLICT_MESSAGE,
    });
  }

  // WP14a explicit Save: one transaction writes exactly the three Calendar
  // keys, fenced by the Calendar defaults generation. The displayed month and
  // temporary Projects / Project Types are never saved and never changed.
  router.post('/defaults', (req, res, next) => {
    const mutation = readCalendarDefaultsMutationRequest(req);
    handlePageDefaultsPost(req, res, next, {
      db,
      pageDefaultsService,
      page: CALENDAR_PAGE_DEFAULTS,
      successMessage: CALENDAR_DEFAULTS_SAVED_MESSAGE,
      saveErrorMessage: 'Calendar defaults could not be saved. No changes were made.',
      validateSubmission: () => ({ generation: null }),
      // The fence runs inside the same transaction as the three writes; a
      // stale generation throws before anything is written, and any later
      // failure rolls the generation back with the writes.
      saveValidatedValues: ({ validatedValues, submission }) => {
        submission.generation = pageDefaultsService.advanceMutationGeneration(
          CALENDAR_PAGE_DEFAULTS, mutation.expectedGeneration,
        );
        for (const option of CALENDAR_DEFAULT_FIELDS) {
          pageDefaultsService.saveDefault(CALENDAR_PAGE_DEFAULTS, option, validatedValues[option]);
        }
      },
      enhancedOperationPayload: ({ outcome, submission }) => calendarDefaultsOperationAcknowledgement('save', mutation, {
        result: outcome,
        generation: outcome === 'committed' ? submission?.generation ?? null : null,
      }),
      handleSaveError: ({ err, enhanced }) => {
        if (!(err instanceof PageDefaultsGenerationConflictError)) return false;
        respondCalendarDefaultsConflict(req, res, next, { kind: 'save', mutation, err, enhanced });
        return true;
      },
      // The JSON acknowledgement carries the post-commit authority so the
      // client updates the saved baseline without a second request.
      enhancedSuccessPayload: () => ({ authority: buildCalendarDefaultsAuthority(pageDefaultsService) }),
      onValidationError: () => {
        renderCalendar(req, res, next, {
          status: 422,
          rawQuery: readCalendarReturnQuery(req) ?? {},
          notice: CALENDAR_DEFAULTS_INVALID_MESSAGE,
        });
      },
      onSuccess: () => {
        let destination;
        try {
          // The saved values apply to the same month and temporary filters.
          destination = calendarContextUrl(req, readCalendarReturnQuery(req));
        } catch (err) {
          next(err);
          return;
        }
        const separator = destination.includes('?') ? '&' : '?';
        res.redirect(`${destination}${separator}notice=calendar_defaults_saved`);
      },
    });
  });

  // WP14a Reset defaults: deletes only the three Calendar keys (from
  // PAGE_DEFAULT_DEFINITIONS, never the request); every other page's defaults
  // and app settings stay. The refresh destination keeps the displayed month
  // and the temporary Projects / Project Types of `returnTo`, and lets View,
  // status and week start resolve to their application fallbacks.
  router.post('/defaults/reset', (req, res, next) => {
    const enhanced = isEnhancedCalendarDefaultsRequest(req);
    let refreshUrl;
    try {
      refreshUrl = calendarContextUrl(req, readCalendarReturnQuery(req));
    } catch (err) {
      next(err);
      return;
    }
    const mutation = readCalendarDefaultsMutationRequest(req);

    let reset;
    let generation = null;
    try {
      // Fence and deletion in one transaction. A no-op Reset (no saved keys)
      // still advances the generation, so an older request prepared before it
      // is rejected as stale.
      const write = () => {
        generation = pageDefaultsService.advanceMutationGeneration(
          CALENDAR_PAGE_DEFAULTS, mutation.expectedGeneration,
        );
        return pageDefaultsService.resetGlobalPageDefaults(CALENDAR_PAGE_DEFAULTS);
      };
      reset = typeof db?.transaction === 'function' ? db.transaction(write)() : write();
    } catch (err) {
      if (err instanceof PageDefaultsGenerationConflictError) {
        respondCalendarDefaultsConflict(req, res, next, { kind: 'resetDefaults', mutation, err, enhanced });
        return;
      }
      if (enhanced) {
        res.status(500).json({
          ...calendarDefaultsOperationAcknowledgement('resetDefaults', mutation, { result: 'failed' }),
          status: 'error',
          message: 'Calendar defaults could not be reset. No changes were made.',
        });
        return;
      }
      next(err);
      return;
    }

    if (!enhanced) {
      res.redirect(refreshUrl);
      return;
    }

    try {
      res.json({
        ...calendarDefaultsOperationAcknowledgement('resetDefaults', mutation, { result: 'committed', generation }),
        status: 'success',
        message: CALENDAR_DEFAULTS_RESET_MESSAGE,
        reset,
        refreshUrl,
        authority: buildCalendarDefaultsAuthority(pageDefaultsService),
      });
    } catch {
      // The deletion committed; only the follow-up read failed. Say so rather
      // than claiming nothing changed, so the client never repeats it.
      res.status(500).json({
        ...calendarDefaultsOperationAcknowledgement('resetDefaults', mutation, { result: 'committed', generation }),
        status: 'error',
        committed: true,
        message: 'Calendar defaults were reset, but the updated defaults could not be read. Reload the page.',
        reset,
        refreshUrl,
      });
    }
  });

  return router;
}
