/**
 * Workflow query service — read-only composition for the dashboard and the
 * project workspace.
 *
 * This is the single read source for the dashboard route and the project
 * detail route. It composes data from the existing repositories so routes
 * never query the database directly and never duplicate SQL aggregation or
 * workflow state.
 *
 * Conventions:
 *   - All composed lists are bounded via the `limits` option so a busy
 *     CreatorCrate does not materialize unbounded result sets.
 *   - "Active" releases mean status in (idea, planned, drafting, ready) and
 *     archived_at IS NULL. Terminal states (published, cancelled, archived)
 *     are not surfaced in attention lists. Releases whose parent project
 *     has been archived are also hidden from the dashboard attention lists
 *     because mutations reject archived parents.
 *   - Today is a single application-local date (YYYY-MM-DD) computed by
 *     `getLocalTodayIso`. The service computes it once and threads the
 *     value through every date-sensitive repository call so the dashboard
 *     cannot classify a release differently across sections (overdue vs
 *     upcoming) due to per-call clock drift or UTC/local disagreement.
 *     Tests and route callers can override the value via the `today` option.
 *   - Methods never throw for empty databases — empty arrays and zero counts
 *     are returned so templates can render safe empty states.
 */

import { createReleaseRepository, RELEASE_STATUSES } from '../data/release-repository.js';
import { createProjectRepository } from '../data/project-repository.js';
import { createAssetRepository } from '../data/asset-repository.js';
import { createAssetCategoryRepository } from '../data/asset-category-repository.js';
import { classifyPreviewable, buildAssetRevisionToken } from './preview-service.js';
import { getLocalTodayIso } from '../util/date.js';

const DEFAULT_LIMITS = Object.freeze({
  // Dashboard sections
  overdue: 5,
  ready: 5,
  missingPlannedDate: 5,
  missingSelectedAssets: 5,
  upcoming: 10,
  recentlyUpdatedProjects: 10,
  // Project workspace sections
  activeReleases: 5,
  recentReleases: 5,
});

const ASSET_BROWSER_DEFAULT_PAGE_SIZE = 25;
const ASSET_BROWSER_MAX_PAGE_SIZE = 100;
const ASSET_BROWSER_SEARCH_MAX_LENGTH = 128;
const ASSET_BROWSER_ORDERING = 'a.filename COLLATE NOCASE ASC, a.id ASC';

/**
 * Canonical asset-browser/viewer query context keys, including `view`
 * (list/grid presentation) so it round-trips through every generated
 * browser/viewer URL exactly like the other filter/sort/pagination fields.
 */
const ASSET_BROWSER_CONTEXT_KEYS = ['category', 'search', 'extension', 'presence', 'usage', 'sort', 'order', 'page', 'pageSize', 'view'];

/**
 * The application-local calendar date used as the default dashboard
 * boundary. Tests and route callers can override this via the `today`
 * option on {@link getDashboardData} so date classification never depends
 * on the system clock or the OS timezone offset.
 */
function defaultToday() {
  return getLocalTodayIso();
}

function mergeLimits(options) {
  return { ...DEFAULT_LIMITS, ...(options?.limits || {}) };
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function totalFromCounts(counts) {
  if (!counts) return 0;
  return Object.values(counts).reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
}

/**
 * Format a byte count into a human-readable string using binary units.
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '\u2014';
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const decimals = value < 10 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[i]}`;
}

function buildPreviewAltText(asset) {
  const filename = typeof asset.filename === 'string' ? asset.filename.trim() : '';
  const identifier = filename || (
    Number.isInteger(asset.id) && asset.id > 0 ? `Asset ${asset.id}` : 'Unnamed asset'
  );
  return `Preview of ${identifier}`;
}

/**
 * Group an ordered list of releases by their planned_date. Returns an array
 * of `{ plannedDate, releases }` objects, preserving the order in which each
 * date first appears. Releases without a planned_date are dropped (this
 * should not happen for the upcoming query, but is a safety net).
 */
function groupByDate(releases) {
  const groups = [];
  const indexByDate = new Map();
  for (const release of releases) {
    if (!release.planned_date) continue;
    let entry = indexByDate.get(release.planned_date);
    if (!entry) {
      entry = { plannedDate: release.planned_date, releases: [] };
      indexByDate.set(release.planned_date, entry);
      groups.push(entry);
    }
    entry.releases.push(release);
  }
  return groups;
}

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {Function} [deps.evaluateReleaseReadiness] — pure readiness policy
 *   function injected for Phase 7A read-service composition. When omitted,
 *   the service still works but getReleaseReadiness will throw a clear error.
 */
export function createWorkflowQueryService({ db, evaluateReleaseReadiness }) {
  const projectRepository = createProjectRepository(db);
  const releaseRepository = createReleaseRepository(db);
  const assetRepository = createAssetRepository(db);
  const assetCategoryRepository = createAssetCategoryRepository(db);

  /**
   * Compose the dashboard view-model. Returns an object with all sections
   * the dashboard template needs; nothing is computed lazily.
   *
   * `today` is computed once and threaded through every date-sensitive
   * repository call so the dashboard cannot classify a release differently
   * across sections (overdue vs upcoming) due to per-call clock drift.
   *
   * @param {object} [options]
   * @param {Partial<typeof DEFAULT_LIMITS>} [options.limits]
   * @param {string} [options.today] ISO date YYYY-MM-DD (defaults to the
   *   service's current date). Tests inject a fixed value to assert
   *   classification without depending on the system clock.
   * @returns {{
   *   releasesNeedingAttention: {
   *     overdue: Array,
   *     ready: Array,
   *     missingPlannedDate: Array,
   *     missingSelectedAssets: Array,
   *     releasesWithoutAssets: Array,
   *     totalCount: number,
   *   },
   *   upcomingReleases: Array,
   *   workflowSummary: {
   *     releaseStatusCounts: Object<string, number>,
   *     totalProjects: number,
   *     totalAssets: number,
   *     missingAssetSummary: { total: number, referencedByReleases: number },
   *   },
   *   projectCounts: Object<string, number>,
   *   recentlyUpdated: Array,
   *   today: string,
   * }}
   */
  function getDashboardData(options = {}) {
    const limits = mergeLimits(options);
    const today = options.today || defaultToday();

    const overdue = releaseRepository.findOverdue(limits.overdue, today);
    const missingPlannedDate = releaseRepository.findActiveWithoutPlannedDate(limits.missingPlannedDate);
    const missingSelectedAssets = releaseRepository.findReleasesWithMissingSelectedAssets(limits.missingSelectedAssets);
    const releasesWithoutAssets = releaseRepository.findReleasesWithoutSelectedAssets(limits.missingSelectedAssets);
    const upcomingRaw = releaseRepository.findUpcoming(limits.upcoming, today);
    const upcoming = groupByDate(upcomingRaw);

    // ── Phase 7B-2: Dashboard Publishability Groups ──────────────────────
    // Batch-load readiness facts for all status=ready releases, then
    // evaluate each through the shared policy. This is a single batch query
    // — no N+1 readiness queries per release.
    const readyFacts = releaseRepository.findReadyDashboardFacts(limits.ready);
    const readyToPublish = [];
    const readyButBlocked = [];

    for (const facts of readyFacts) {
      const result = evaluateReleaseReadiness(facts);
      const release = {
        id: facts.release_id,
        project_id: facts.project_id,
        title: facts.title,
        project_title: facts.project_title,
        planned_date: facts.planned_date,
        updated_at: facts.updated_at,
        status: facts.release_status,
      };

      if (result.publishable) {
        readyToPublish.push(release);
      } else {
        // Collect only the failed blocker keys and their details for
        // concise presentation — no policy logic duplicated here.
        const blockers = result.checks
          .filter((c) => !c.passed)
          .map((c) => ({ key: c.key, details: c.details }));
        readyButBlocked.push({ ...release, blockers });
      }
    }

    const releaseStatusCounts = releaseRepository.countByStatus();
    const projectCounts = projectRepository.countByStatus();
    const totalAssets = assetRepository.getTotalCount();
    const missingTotal = assetRepository.getTotalMissingCount();
    const missingReferenced = releaseRepository.countMissingAssetsReferenced();

    const recentlyUpdated = projectRepository.list({
      sortBy: 'updated',
      order: 'desc',
      limit: limits.recentlyUpdatedProjects,
      includeArchived: false,
    }).rows;

    return {
      releasesNeedingAttention: {
        overdue,
        readyToPublish,
        readyButBlocked,
        missingPlannedDate,
        missingSelectedAssets,
        releasesWithoutAssets,
        totalCount:
          overdue.length
          + readyToPublish.length
          + readyButBlocked.length
          + missingPlannedDate.length
          + missingSelectedAssets.length
          + releasesWithoutAssets.length,
      },
      upcomingReleases: upcoming,
      workflowSummary: {
        releaseStatusCounts,
        totalProjects: totalFromCounts(projectCounts),
        totalAssets,
        missingAssetSummary: {
          total: missingTotal,
          referencedByReleases: missingReferenced,
        },
      },
      projectCounts,
      recentlyUpdated,
      today,
    };
  }

  /**
   * Compose the project workspace view-model. Returns null when the project
   * is not found so the route can render a 404 without an extra lookup.
   *
   * Archived projects: active releases are always empty, even if the
   * underlying release rows are non-terminal and non-archived. Mutations
   * (update, asset selection, publish) reject archived parent projects, so
   * surfacing active workflow for an archived project is misleading. The
   * historical `recent` list and the status counts still reflect every
   * release so published/cancelled information remains visible.
   *
   * @param {number} projectId
   * @param {object} [options]
   * @param {Partial<typeof DEFAULT_LIMITS>} [options.limits]
   * @returns {null | {
   *   project: object,
   *   releaseSummary: {
   *     active: Array,
   *     recent: Array,
   *     statusCounts: Object<string, number>,
   *     hasAnyReleases: boolean,
   *   },
   *   assetHealth: {
   *     total: number,
   *     present: number,
   *     missing: number,
   *     missingByReleases: number,
   *   },
   * }}
   */
  function getProjectWorkspace(projectId, options = {}) {
    const project = projectRepository.findById(projectId);
    if (!project) return null;

    const limits = mergeLimits(options);
    const isArchived = Boolean(project.archived_at);

    // Archived projects: skip the active-release query entirely. Historical
    // and recently updated releases are still surfaced through `recent`.
    const activeReleases = isArchived
      ? []
      : releaseRepository.findActiveByProjectId(projectId, limits.activeReleases);
    const recentReleases = releaseRepository.findRecentByProjectId(projectId, limits.recentReleases);
    const statusCounts = releaseRepository.countByStatusByProjectId(projectId);

    const assetTotal = assetRepository.countByProjectId(projectId);
    const assetPresent = assetRepository.countPresentByProjectId(projectId);
    const assetMissing = assetRepository.countMissingByProjectId(projectId);
    const assetMissingByReleases = releaseRepository.countMissingAssetsReferencedByProjectId(projectId);

    return {
      project,
      releaseSummary: {
        active: activeReleases,
        recent: recentReleases,
        statusCounts,
        hasAnyReleases: totalFromCounts(statusCounts) > 0,
      },
      assetHealth: {
        total: assetTotal,
        present: assetPresent,
        missing: assetMissing,
        missingByReleases: assetMissingByReleases,
      },
    };
  }

  // ─── Phase 6C: Release Planning Views ─────────────────────────────────

  /**
   * Normalize and validate release list filters.
   * Uses strict positive-integer validation for numeric fields to reject
   * malformed values like "1junk", "2.5", "1e2", "+2", "-2", or "0".
   *
   * The validator operates on the ORIGINAL (untrimmed) string. URL decoding
   * converts "+2" to a leading space, and trimming would happily bring it
   * back to "2" — bypassing the strict check. Validating the raw string
   * keeps "+2", leading/trailing whitespace, and other URL-encoded garbage
   * out of the numeric pipeline.
   * @param {Object} raw
   * @returns {Object} normalized filters
   */
  function normalizeListFilters(raw) {
    // Strict positive-integer validation: rejects malformed strings before conversion.
    // parseStrictInt is defined in releases.js and imported at route level; here we
    // use the same regex approach inline to avoid a cross-module call in the service.
    // NOTE: do NOT trim — URL decoding makes "+2" become " 2", and trimming would
    // turn it into a valid "2". The regex below already rejects whitespace inputs.
    function parseStrictPositiveInt(value) {
      if (value == null) return null;
      const str = String(value);
      if (!/^[1-9]\d*$/.test(str)) return null;
      const num = Number(str);
      if (!Number.isInteger(num) || num < 1) return null;
      return num;
    }

    const projectId = parseStrictPositiveInt(raw.project);
    const status = RELEASE_STATUSES.includes(raw.status) ? raw.status : null;
    const schedule = ['overdue', 'today', 'upcoming', 'unscheduled'].includes(raw.schedule)
      ? raw.schedule
      : null;
    const includeArchived = raw.includeArchived === '1';
    const sortBy = ['updated', 'created', 'planned', 'title'].includes(raw.sort) ? raw.sort : 'updated';
    const order = raw.order === 'asc' ? 'asc' : 'desc';

    const pageRaw = parseStrictPositiveInt(raw.page);
    const page = pageRaw !== null ? pageRaw : 1;

    const pageSizeRaw = parseStrictPositiveInt(raw.pageSize);
    let pageSize = pageSizeRaw !== null ? pageSizeRaw : 25;
    if (pageSize > 100) pageSize = 100;

    const readinessValues = ['all', 'publishable', 'blocked-ready'];
    const readiness = readinessValues.includes(raw.readiness) ? raw.readiness : 'all';

    return { projectId, status, schedule, includeArchived, sortBy, order, page, pageSize, readiness };
  }

  /**
   * Paginated release list with project title and asset counts.
   * Computes one local `today` for date-sensitive schedule filters.
   * @param {Object} rawFilters - raw query parameters
   * @param {Object} [options]
   * @param {string} [options.today] - ISO date YYYY-MM-DD override
   * @returns {{ releases: Array, total: number, page: number, pageSize: number, pageCount: number, today: string }}
   */
  function getReleaseList(rawFilters, options = {}) {
    const filters = normalizeListFilters(rawFilters);
    const today = options.today || defaultToday();

    // List view always excludes archived-parent releases per Phase 6C:
    // "Archived parent projects make releases hidden from active workflow views"
    const activeScheduleFilter = true;

    const total = releaseRepository.countFiltered({
      ...filters,
      today,
      activeScheduleFilter,
    });

    // Existence check independent of filters: counts every release (including
    // archived ones) so the list view can distinguish "no releases exist at
    // all" from "releases exist but the current filters return zero".
    // One fixed COUNT(*) query — does not vary with pagination or per-row work.
    // Mirrors the project list's hasAnyProjects pattern.
    const hasAnyReleases = releaseRepository.countFiltered({ includeArchived: true }) > 0;

    const pageCount = Math.max(1, Math.ceil(total / filters.pageSize));
    const page = Math.min(filters.page, pageCount);
    const offset = (page - 1) * filters.pageSize;

    const releases = releaseRepository.findPage({
      ...filters,
      today,
      activeScheduleFilter,
      limit: filters.pageSize,
      offset,
    });

    // ── Phase 7B-3: Compact Release Readiness Indicators ──────────────
    // Batch-attach readiness facts for all status=ready releases on this
    // page — no N+1 readiness queries per release.
    const enhanced = _attachReadiness(releases);

    return { releases: enhanced, total, page, pageSize: filters.pageSize, pageCount, today, hasAnyReleases };
  }

  /**
   * Board-ready release data grouped by status columns.
   * @param {Object} rawFilters - raw query parameters
   * @param {Object} [options]
   * @param {string} [options.today] - ISO date YYYY-MM-DD override
   * @returns {{ columns: Object, today: string }} columns keyed by status
   */
  function getReleaseBoard(rawFilters, options = {}) {
    const filters = normalizeListFilters(rawFilters);
    const today = options.today || defaultToday();

    // Board always excludes archived-parent releases for active workflow view
    const activeScheduleFilter = true;

    const rows = releaseRepository.findBoard({
      ...filters,
      today,
      activeScheduleFilter,
    });

    // ── Phase 7B-3: Compact Release Readiness Indicators ──────────────
    // Batch-attach readiness facts for all status=ready releases on the
    // board — no N+1 readiness queries per release.
    const enhanced = _attachReadiness(rows);

    // Group into columns by status
    const BOARD_STATUSES = ['idea', 'planned', 'drafting', 'ready', 'published', 'cancelled'];
    const columns = Object.fromEntries(BOARD_STATUSES.map((s) => [s, []]));

    for (const release of enhanced) {
      if (columns[release.status]) {
        columns[release.status].push(release);
      }
    }

    return { columns, today };
  }

  /**
   * Validate and parse a YYYY-MM month string.
   * Returns { year, month } or null if invalid.
   * @param {string} month
   * @returns {{ year: number, month: number } | null}
   */
  function parseMonth(month) {
    if (typeof month !== 'string') return null;
    if (!/^\d{4}-\d{2}$/.test(month)) return null;
    const [yearStr, monthStr] = month.split('-');
    const year = parseInt(yearStr, 10);
    const monthNum = parseInt(monthStr, 10);
    if (monthNum < 1 || monthNum > 12) return null;
    if (year < 1000 || year > 9999) return null;
    return { year, month: monthNum };
  }

  /**
   * Compute the previous month string (YYYY-MM).
   * Returns null when the previous month would step outside the supported
   * year range (1000-9999) — calendar navigation must never render an
   * unsupported URL like "999-12" or "10000-01".
   * @param {string} yearMonth
   * @returns {string | null}
   */
  function prevMonth(yearMonth) {
    const parsed = parseMonth(yearMonth);
    if (!parsed) return null;
    const { year, month } = parsed;
    if (month === 1) {
      if (year - 1 < 1000) return null;
      return `${year - 1}-12`;
    }
    return `${year}-${String(month - 1).padStart(2, '0')}`;
  }

  /**
   * Compute the next month string (YYYY-MM).
   * Returns null when the next month would step outside the supported
   * year range (1000-9999) — calendar navigation must never render an
   * unsupported URL like "999-12" or "10000-01".
   * @param {string} yearMonth
   * @returns {string | null}
   */
  function nextMonth(yearMonth) {
    const parsed = parseMonth(yearMonth);
    if (!parsed) return null;
    const { year, month } = parsed;
    if (month === 12) {
      if (year + 1 > 9999) return null;
      return `${year + 1}-01`;
    }
    return `${year}-${String(month + 1).padStart(2, '0')}`;
  }

  /**
   * Project-backed calendar view data for a given month.
   *
   * Calendar entries are project records, not release records: each
   * project appears at most once regardless of how many releases it has.
   * The effective date is planned_date for tbd/planned/in-progress/ready
   * projects, and published_date (falling back to planned_date) for
   * published projects. Archived projects and projects with no applicable
   * date are excluded.
   * @param {string} month - YYYY-MM month string
   * @param {Object} [options]
   * @param {string} [options.today] - ISO date YYYY-MM-DD override
   * @returns {{ month: string, days: Array<{ date: string, entries: Array }>, firstDayWeekday: number, prevMonthDaysCount: number, prevMonth: string, nextMonth: string, today: string }}
   */
  function getProjectCalendar(month, options = {}) {
    const today = options.today || defaultToday();
    const validated = parseMonth(month);

    // Fall back to current month if invalid
    const { year, month: monthNum } = validated || parseMonth(today.slice(0, 7)) || { year: 2026, month: 7 };

    // Calculate inclusive start (first day of month) and exclusive end (first day of next month).
    // Year 9999 is the maximum supported year (see parseMonth), so December 9999 has no real
    // "next month" expressible as a 4-digit-year ISO date — incrementing to 10000-01-01 would
    // produce a 5-digit year that breaks lexicographic string comparison against effective_date
    // (e.g. "10000-01-01" sorts BEFORE "9999-12-31"). For that month only, use month "13" as an
    // exclusive upper bound: it keeps the 4-digit year and still sorts after every real date in
    // December (string comparison decides on the month segment before the day segment).
    const startDate = `${year}-${String(monthNum).padStart(2, '0')}-01`;
    let endYear = year;
    let endMonth = monthNum + 1;
    if (endMonth > 12) {
      if (year + 1 > 9999) {
        endMonth = 13;
      } else {
        endMonth = 1;
        endYear++;
      }
    }
    const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;

    const projects = projectRepository.findCalendarRange(startDate, endDate);

    // Group projects by their effective calendar date
    const byDate = new Map();
    for (const project of projects) {
      const date = project.effective_date;
      if (!byDate.has(date)) {
        byDate.set(date, []);
      }
      byDate.get(date).push(project);
    }

    // Build days array for the month
    const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][monthNum - 1];
    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${year}-${String(monthNum).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      days.push({ date, entries: byDate.get(date) || [] });
    }

    // Compute first day of month weekday (Monday=0, Sunday=6) for calendar grid padding
    const firstDay = new Date(year, monthNum - 1, 1);
    const firstDayWeekday = (firstDay.getDay() + 6) % 7;

    // Leading padding cells show the tail end of the previous month's dates
    // (dimmed, non-interactive) rather than blank cells — needs that month's
    // day count to compute the numbers.
    const prevMonthNum = monthNum === 1 ? 12 : monthNum - 1;
    const prevMonthYear = monthNum === 1 ? year - 1 : year;
    const prevMonthDaysCount = [31, isLeapYear(prevMonthYear) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][prevMonthNum - 1];

    const monthStr = `${year}-${String(monthNum).padStart(2, '0')}`;
    return {
      month: monthStr,
      days,
      firstDayWeekday,
      prevMonthDaysCount,
      prevMonth: prevMonth(monthStr),
      nextMonth: nextMonth(monthStr),
      today,
    };
  }

  // ─── Phase 6D: Asset Browser ───────────────────────────────────────────

  /**
   * Strict positive-integer validator for pagination parameters.
   * Rejects malformed strings like "1junk", "2.5", "1e2", "+2", "-2", or "0".
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

  const ASSET_BROWSER_SORT_VALUES = ['filename', 'modified', 'size', 'category'];
  const ASSET_BROWSER_ORDER_VALUES = ['asc', 'desc'];

  const ASSET_BROWSER_VIEW_VALUES = ['list', 'grid'];

  /**
   * Normalize the `view` query parameter: missing/invalid values fall back
   * to 'list', matching every other filter's fallback-to-default contract.
   * @param {unknown} value
   * @returns {'list'|'grid'}
   */
  function normalizeAssetBrowserView(value) {
    return ASSET_BROWSER_VIEW_VALUES.includes(value) ? value : 'list';
  }

  /**
   * Normalize and validate asset browser query parameters. This is the
   * canonical filter/sort/pagination/presentation contract shared by the
   * browser and viewer.
   *
   * @param {Object} raw
   * @param {string[]} extensionChoices - normalized extensions available in the project scope
   * @param {Array<{id: number}>} projectCategories - the requesting project's own category rows
   * @returns {{ search: string|null, extension: string|null, presence: 'all'|'present'|'missing', usage: 'all'|'used'|'unused', category: 'all'|'uncategorized'|number, sort: 'filename'|'modified'|'size'|'category', order: 'asc'|'desc', page: number, pageSize: number, view: 'list'|'grid' }}
   */
  function normalizeAssetBrowserQuery(raw = {}, extensionChoices = [], projectCategories = []) {
    const presenceValues = ['all', 'present', 'missing'];
    const usageValues = ['all', 'used', 'unused'];

    const presence = presenceValues.includes(raw.presence) ? raw.presence : 'all';
    const usage = usageValues.includes(raw.usage) ? raw.usage : 'all';

    const search = normalizeAssetBrowserSearch(raw.search);
    const extension = normalizeAssetBrowserExtension(raw.extension, extensionChoices);
    const category = normalizeAssetBrowserCategory(raw.category, projectCategories);

    const sort = ASSET_BROWSER_SORT_VALUES.includes(raw.sort) ? raw.sort : 'filename';
    const order = ASSET_BROWSER_ORDER_VALUES.includes(raw.order) ? raw.order : 'asc';

    const pageRaw = parseStrictPositiveInt(raw.page);
    const page = pageRaw !== null ? pageRaw : 1;

    const pageSizeRaw = parseStrictPositiveInt(raw.pageSize);
    let pageSize = pageSizeRaw !== null ? pageSizeRaw : ASSET_BROWSER_DEFAULT_PAGE_SIZE;
    if (pageSize > ASSET_BROWSER_MAX_PAGE_SIZE) pageSize = ASSET_BROWSER_MAX_PAGE_SIZE;

    const view = normalizeAssetBrowserView(raw.view);

    return { search, extension, presence, usage, category, sort, order, page, pageSize, view };
  }

  /**
   * Normalize the `category` query parameter against the contract:
   *   - omitted or 'all' -> 'all' (no restriction)
   *   - 'uncategorized' -> 'uncategorized'
   *   - a canonical positive category ID owned by this project -> that ID
   *   - malformed, missing, or cross-project category ID -> 'all'
   *
   * Ownership is validated here, against the caller-supplied project-owned
   * category rows, before any value reaches SQL.
   *
   * @param {unknown} raw
   * @param {Array<{id: number}>} projectCategories
   * @returns {'all'|'uncategorized'|number}
   */
  function normalizeAssetBrowserCategory(raw, projectCategories) {
    if (raw === undefined || raw === null || raw === '' || raw === 'all') return 'all';
    if (raw === 'uncategorized') return 'uncategorized';

    const id = parseStrictPositiveInt(raw);
    if (id === null) return 'all';

    const owned = projectCategories.some((c) => c.id === id);
    return owned ? id : 'all';
  }

  function normalizeAssetBrowserSearch(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed === '') return null;
    return trimmed.slice(0, ASSET_BROWSER_SEARCH_MAX_LENGTH);
  }

  function normalizeAssetBrowserExtension(value, extensionChoices) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace(/^\./, '').toLowerCase();
    if (normalized === '') return null;
    return extensionChoices.includes(normalized) ? normalized : null;
  }

  function buildPreviewUrls(asset, revision) {
    if (!revision) {
      return { thumbnail: null, preview: null };
    }

    const query = new URLSearchParams({ v: revision }).toString();
    return {
      thumbnail: `/projects/${asset.project_id}/assets/${asset.id}/thumbnail?${query}`,
      preview: `/projects/${asset.project_id}/assets/${asset.id}/preview?${query}`,
    };
  }

  function buildAssetPreviewModel(asset) {
    if (!asset.is_present) {
      return {
        state: 'missing',
        previewable: false,
        sourceMetadataValid: false,
        revision: null,
        urls: { thumbnail: null, preview: null },
      };
    }

    const classification = classifyPreviewable(asset);
    if (!classification.supported) {
      return {
        state: 'unsupported',
        previewable: false,
        sourceMetadataValid: false,
        revision: null,
        urls: { thumbnail: null, preview: null },
      };
    }

    const revision = buildAssetRevisionToken(asset);
    const urls = buildPreviewUrls(asset, revision);
    return {
      state: 'previewable',
      previewable: true,
      sourceMetadataValid: revision !== null,
      revision,
      urls,
    };
  }

  function buildOriginalUrl(asset) {
    if (!asset.is_present) return null;
    const classification = classifyPreviewable(asset);
    if (!classification.supported) return null;
    return `/projects/${asset.project_id}/assets/${asset.id}/original`;
  }

  function appendCanonicalAssetBrowserParam(query, key, value) {
    if (value === undefined || value === null || value === '') return;
    const normalized = String(value);
    if (key === 'category' && normalized === 'all') return;
    if (key === 'presence' && normalized === 'all') return;
    if (key === 'usage' && normalized === 'all') return;
    if (key === 'sort' && normalized === 'filename') return;
    if (key === 'order' && normalized === 'asc') return;
    if (key === 'page' && normalized === '1') return;
    if (key === 'pageSize' && normalized === String(ASSET_BROWSER_DEFAULT_PAGE_SIZE)) return;
    if (key === 'view' && normalized === 'list') return;
    query[key] = normalized;
  }

  function buildAssetBrowserQuery(context, page) {
    const query = {};
    for (const key of ASSET_BROWSER_CONTEXT_KEYS) {
      const value = key === 'page' ? page : context[key];
      appendCanonicalAssetBrowserParam(query, key, value);
    }
    return query;
  }

  function appendQuery(basePath, query) {
    const search = new URLSearchParams(query).toString();
    return search ? `${basePath}?${search}` : basePath;
  }

  function buildProjectAssetsUrl(projectId, context, page) {
    return appendQuery(
      `/projects/${projectId}/assets`,
      buildAssetBrowserQuery(context, page)
    );
  }

  function buildProjectAssetViewerUrl(projectId, assetId, context, page) {
    return appendQuery(
      `/projects/${projectId}/assets/${assetId}`,
      buildAssetBrowserQuery(context, page)
    );
  }

  function pageForPosition(position, pageSize) {
    if (!Number.isInteger(position) || position < 1) return null;
    return Math.ceil(position / pageSize);
  }

  function buildAdjacentAssetLink(projectId, assetId, context, position) {
    if (!assetId || !position) return null;
    const page = pageForPosition(position, context.pageSize);
    return {
      assetId,
      href: buildProjectAssetViewerUrl(projectId, assetId, context, page),
      page,
    };
  }

  /**
   * Build the category presentation fields attached to an asset row/viewer
   * model from the category-joined repository columns. Uncategorized assets
   * (category_id IS NULL, or a join that could not resolve — e.g. a
   * cross-project category_id) return null.
   * @param {object} asset - repository row with category_* joined columns
   * @returns {null | { id: number, displayName: string, enabled: boolean, displayOrder: number }}
   */
  function buildAssetCategoryModel(asset) {
    if (asset.category_id === null || asset.category_id === undefined || asset.category_display_name == null) {
      return null;
    }
    return {
      id: asset.category_id,
      displayName: asset.category_display_name,
      enabled: Boolean(asset.category_enabled),
      displayOrder: asset.category_display_order,
    };
  }

  /**
   * Compose the whole-project category navigation model: every project
   * category (including zero-count ones), split into enabled/disabled and
   * ordered by display_order, each annotated with its whole-project asset
   * count. Counts are independent of the active browser filters.
   *
   * Each navigation destination is a specific canonical (category, presence)
   * pair — All Assets is (category=all, presence=all), a category link is
   * (that category id, presence=all), Missing Assets is (category=all,
   * presence=missing). `isActive`/`allActive`/`uncategorizedActive`/
   * `missingActive` below are computed by exact match against the
   * *normalized* filters, so a composed filter like category=2&presence=missing
   * matches none of the simplified destinations and nothing claims active
   * state — at most one destination can ever be active.
   *
   * @param {Array} projectCategories - all of the project's own category rows
   * @param {{ total: number, uncategorized: number, missing: number, byCategoryId: Object<number, number> }} navCounts
   * @param {{ category: 'all'|'uncategorized'|number, presence: 'all'|'present'|'missing' }} filters - normalized browser filters
   */
  function buildCategoryNavigationModel(projectCategories, navCounts, filters) {
    const items = projectCategories.map((category) => ({
      id: category.id,
      displayName: category.display_name,
      enabled: Boolean(category.enabled),
      displayOrder: category.display_order,
      assetCount: navCounts.byCategoryId[category.id] || 0,
      isActive: filters.category === category.id && filters.presence === 'all',
    }));

    return {
      enabled: items.filter((c) => c.enabled),
      disabled: items.filter((c) => !c.enabled),
      uncategorizedCount: navCounts.uncategorized,
      totalCount: navCounts.total,
      missingCount: navCounts.missing,
      allActive: filters.category === 'all' && filters.presence === 'all',
      uncategorizedActive: filters.category === 'uncategorized' && filters.presence === 'all',
      missingActive: filters.category === 'all' && filters.presence === 'missing',
    };
  }

  /**
   * Render-ready location label for the browser table / viewer, from the
   * chunk-1 `nested_path` + category model. Never parses `relative_path`.
   *
   *   - non-empty nested_path -> the nested_path itself (works for both
   *     categorized nested assets and uncategorized assets under unknown
   *     directories)
   *   - empty nested_path + no category -> "Project root"
   *   - empty nested_path + a category (i.e. sitting at the category root)
   *     -> '' (no useful secondary location beyond the category label
   *     already shown, so the template omits the location element entirely)
   * @param {{ nested_path: string, category_id: number|null }} asset
   * @returns {string}
   */
  function buildAssetLocationLabel(asset) {
    if (asset.nested_path) return asset.nested_path;
    return asset.category_id === null || asset.category_id === undefined ? 'Project root' : '';
  }

  /**
   * Compact, render-ready release-usage summary. `mode` tells the template
   * which of the three required presentations to use without branching on
   * counts itself: 'none' (no releases), 'single' (one release + role),
   * 'multiple' (N releases, rendered inside a <details>).
   * @param {Array} releaseUsage - rows from findReleaseUsageForAssetIds (has role, sort_order)
   */
  function buildReleaseUsageSummary(releaseUsage) {
    const count = releaseUsage.length;
    if (count === 0) return { count: 0, mode: 'none', releases: [] };
    if (count === 1) return { count: 1, mode: 'single', releases: releaseUsage };
    return { count, mode: 'multiple', releases: releaseUsage };
  }

  /**
   * Attach the render-ready presentation fields shared by the browser table
   * rows and the viewer asset model, so neither template branches on raw
   * category/nested_path/release_usage data itself.
   * @param {object} asset - a row already carrying `category`/`nested_path`/`release_usage`
   */
  function buildAssetRowPresentation(asset) {
    const category = asset.category !== undefined ? asset.category : buildAssetCategoryModel(asset);
    const isPresent = Boolean(asset.is_present);
    return {
      categoryLabel: category ? category.displayName : 'Uncategorized',
      categoryDisabled: category ? !category.enabled : false,
      locationLabel: buildAssetLocationLabel(asset),
      typeLabel: asset.extension ? asset.extension.toUpperCase() : 'File',
      presenceLabel: isPresent ? 'Present' : 'Missing at last scan',
      releaseSummary: buildReleaseUsageSummary(asset.release_usage || []),
      viewerUrl: `/projects/${asset.project_id}/assets/${asset.id}`,
    };
  }

  /**
   * Safe, distinct empty-state context for the browser table. Never implies
   * a scan or deletion happened unless it did. Computed entirely from
   * already-fetched data (the bounded whole-project `navCounts` query) — no
   * additional query.
   * @param {object} filters - normalized canonical filters
   * @param {number} total - filtered result count
   * @param {{ total: number }} navCounts - whole-project navigation counts
   * @param {boolean} projectArchived
   */
  function buildAssetBrowserEmptyState(filters, total, navCounts, projectArchived) {
    if (total > 0) return null;

    if (navCounts.total === 0) {
      return projectArchived
        ? {
          kind: 'no-assets-archived',
          heading: 'No assets found',
          description: 'This archived project has no assets on record.',
          showScanAction: false,
        }
        : {
          kind: 'no-assets',
          heading: 'No assets found',
          description: 'Scan the project directory to discover asset files.',
          showScanAction: true,
        };
    }

    if (filters.presence === 'missing') {
      return {
        kind: 'missing-empty',
        heading: 'No missing assets',
        description: 'Every indexed asset was present at the last completed scan. CreatorCrate does not delete files — this reflects scan results only.',
        showScanAction: false,
      };
    }

    if (filters.category !== 'all') {
      return {
        kind: 'category-empty',
        heading: 'No assets in this category',
        description: 'This category currently has no matching assets. Try All Assets or adjust the other filters.',
        showScanAction: false,
      };
    }

    return {
      kind: 'filtered',
      heading: 'No assets match the current filters',
      description: 'Adjust or clear the filters to see all assets.',
      showScanAction: false,
    };
  }

  function summarizeProject(project) {
    return {
      id: project.id,
      title: project.title,
      slug: project.slug,
      status: project.status,
      archived_at: project.archived_at,
    };
  }

  function buildViewerAssetModel(asset, releaseUsage) {
    const preview = buildAssetPreviewModel(asset);
    return {
      id: asset.id,
      project_id: asset.project_id,
      relative_path: asset.relative_path,
      nested_path: asset.nested_path,
      category_id: asset.category_id,
      category: buildAssetCategoryModel(asset),
      filename: asset.filename,
      previewAltText: buildPreviewAltText(asset),
      extension: asset.extension,
      mime_type: asset.mime_type,
      size_bytes: asset.size_bytes,
      modified_at: asset.modified_at,
      is_present: asset.is_present,
      presence_state: asset.is_present ? 'present' : 'missing',
      missing: !asset.is_present,
      last_seen_at: asset.last_seen_at,
      missing_since: asset.missing_since,
      release_usage_count: asset.release_usage_count,
      release_usage: releaseUsage,
      release_usage_summary: {
        count: asset.release_usage_count,
        releases: releaseUsage,
      },
      preview,
      preview_capability: preview.state,
      preview_state: preview.state,
      revision_token: preview.revision,
      preview_revision: preview.revision,
      thumbnail_url: preview.urls.thumbnail,
      preview_url: preview.urls.preview,
      original_url: buildOriginalUrl(asset),
      ...buildAssetRowPresentation({ ...asset, release_usage: releaseUsage }),
    };
  }

  /**
   * Asset browser view-model for a project.
   * Returns paginated assets with release usage details attached.
   * Read-only — does not trigger scanning or any mutation.
   *
   * @param {number} projectId
   * @param {Object} [rawQuery] - raw query parameters
   * @param {string} [rawQuery.search] - filename/relative-path search term
   * @param {string} [rawQuery.extension] - extension filter, with or without leading dot
   * @param {string} [rawQuery.presence] - 'all'|'present'|'missing'
   * @param {string} [rawQuery.usage] - 'all'|'used'|'unused'
   * @param {string} [rawQuery.category] - 'all'|'uncategorized'|<project-owned category id>
   * @param {string} [rawQuery.sort] - 'filename'|'modified'|'size'|'category'
   * @param {string} [rawQuery.order] - 'asc'|'desc'
   * @param {string|number} [rawQuery.page]
   * @param {string|number} [rawQuery.pageSize]
   * @returns {null | {
   *   assets: Array,
   *   total: number,
   *   page: number,
   *   pageSize: number,
   *   pageCount: number,
   *   filters: object,
   *   extensionChoices: Array<{ value: string, label: string, selected: boolean }>,
   *   categoryNavigation: object,
   *   emptyState: object|null,
   *   ordering: string,
   *   searchMaxLength: number,
   * }}
   */
  function getProjectAssetBrowser(projectId, rawQuery = {}) {
    const project = projectRepository.findById(projectId);
    if (!project) return null;

    const projectCategories = assetCategoryRepository.listProjectCategories(projectId);
    const extensions = assetRepository.listProjectAssetExtensions(projectId);
    const navCounts = assetRepository.getProjectAssetNavigationCounts(projectId);

    // Archived projects are read-only — bulk release-association targets are
    // never rendered there, so skip the (otherwise bounded) query entirely.
    const isArchived = Boolean(project.archived_at);
    const releaseTargets = isArchived
      ? []
      : releaseRepository.findEligibleAssetSelectionTargets(projectId).map((release) => ({
        id: release.id,
        title: release.title,
        status: release.status,
      }));

    const filters = normalizeAssetBrowserQuery(rawQuery, extensions, projectCategories);

    const total = assetRepository.countProjectAssets(projectId, filters);

    const pageCount = Math.max(1, Math.ceil(total / filters.pageSize));
    const page = Math.min(filters.page, pageCount);

    const pageResult = assetRepository.findProjectAssetPage(projectId, {
      ...filters,
      page,
      pageSize: filters.pageSize,
    });

    // Attach release usage details for assets on the current page
    const assetIds = pageResult.map((a) => a.id);
    const usageDetails = releaseRepository.findReleaseUsageForAssetIds(projectId, assetIds);

    // Index usage details by asset_id for O(1) lookup during attachment
    const usageByAssetId = new Map();
    for (const detail of usageDetails) {
      if (!usageByAssetId.has(detail.asset_id)) {
        usageByAssetId.set(detail.asset_id, []);
      }
      usageByAssetId.get(detail.asset_id).push(detail);
    }

    const assets = pageResult.map((asset) => ({
      id: asset.id,
      project_id: asset.project_id,
      relative_path: asset.relative_path,
      nested_path: asset.nested_path,
      category_id: asset.category_id,
      category: buildAssetCategoryModel(asset),
      filename: asset.filename,
      extension: asset.extension,
      mime_type: asset.mime_type,
      size_bytes: asset.size_bytes,
      modified_at: asset.modified_at,
      is_present: asset.is_present,
      presence_state: asset.is_present ? 'present' : 'missing',
      last_seen_at: asset.last_seen_at,
      missing_since: asset.missing_since,
      release_usage_count: asset.release_usage_count,
      release_usage: usageByAssetId.get(asset.id) || [],
      preview: buildAssetPreviewModel(asset),
    })).map((asset) => ({
      ...asset,
      preview_state: asset.preview.state,
      preview_revision: asset.preview.revision,
      thumbnail_url: asset.preview.urls.thumbnail,
      preview_url: asset.preview.urls.preview,
    })).map((asset) => ({
      ...asset,
      formattedSize: formatFileSize(asset.size_bytes),
      previewAltText: buildPreviewAltText(asset),
      isPreviewable: asset.preview.previewable,
      hasThumbnail: Boolean(asset.thumbnail_url),
      originalEligible: asset.preview.previewable,
      ...buildAssetRowPresentation(asset),
      // Override buildAssetRowPresentation's bare default with the canonical
      // viewer URL for the browser's own normalized+clamped context — the
      // page a user actually clicked from, not an out-of-range raw page —
      // so Back/Previous/Next in the viewer resume the same filtered,
      // sorted, paginated context instead of silently reverting to defaults.
      viewerUrl: buildProjectAssetViewerUrl(projectId, asset.id, filters, page),
    }));

    return {
      assets,
      total,
      page,
      pageSize: filters.pageSize,
      pageCount,
      filters: {
        search: filters.search,
        extension: filters.extension,
        presence: filters.presence,
        usage: filters.usage,
        category: filters.category,
        sort: filters.sort,
        order: filters.order,
        view: filters.view,
      },
      extensionChoices: extensions.map((extension) => ({
        value: extension,
        label: extension,
        selected: extension === filters.extension,
      })),
      categoryNavigation: buildCategoryNavigationModel(projectCategories, navCounts, filters),
      emptyState: buildAssetBrowserEmptyState(filters, total, navCounts, isArchived),
      isArchived,
      releaseTargets,
      ordering: ASSET_BROWSER_ORDERING,
      searchMaxLength: ASSET_BROWSER_SEARCH_MAX_LENGTH,
    };
  }

  /**
   * Lightweight canonical-context normalizer for the asset browser. Used by
   * routes that need to rebuild a normalized `/projects/:id/assets` URL
   * (manual-scan redirects, the bulk release-association PRG redirect)
   * without paying for the full asset page/count/release-usage queries that
   * `getProjectAssetBrowser` performs. Bounded: one project lookup, one
   * category list, one extension list.
   *
   * @param {number} projectId
   * @param {Object} [rawQuery] - raw query/body fields (same shape as getProjectAssetBrowser)
   * @returns {null | { filters: object }}
   */
  function getProjectAssetBrowserContext(projectId, rawQuery = {}) {
    const project = projectRepository.findById(projectId);
    if (!project) return null;

    const projectCategories = assetCategoryRepository.listProjectCategories(projectId);
    const extensions = assetRepository.listProjectAssetExtensions(projectId);
    const filters = normalizeAssetBrowserQuery(rawQuery, extensions, projectCategories);

    return { filters };
  }

  /**
   * Asset viewer view-model for a single project-owned asset.
   *
   * The asset identity check is project-scoped so unknown and cross-project
   * asset IDs both return null. Adjacent navigation is calculated from the
   * complete normalized browser filter context, not from the supplied page.
   * If the current asset is excluded by the active filters, the asset is still
   * returned but filtered previous/next links are omitted.
   *
   * @param {number} projectId
   * @param {number} assetId
   * @param {Object} [rawQuery]
   * @returns {null | {
   *   project: object,
   *   asset: object,
   *   context: object,
   *   filters: object,
   *   filteredOut: boolean,
   *   filteredPosition: number|null,
   *   filteredTotal: number,
   *   currentPage: number|null,
   *   previousAssetLink: { assetId: number, href: string, page: number }|null,
   *   nextAssetLink: { assetId: number, href: string, page: number }|null,
   *   backToAssetsLink: { href: string, page: number|null },
   * }}
   */
  function getProjectAssetViewer(projectId, assetId, rawQuery = {}) {
    const normalizedAssetId = parseStrictPositiveInt(assetId);
    if (normalizedAssetId === null) return null;

    const project = projectRepository.findById(projectId);
    if (!project) return null;

    const projectCategories = assetCategoryRepository.listProjectCategories(projectId);
    const extensions = assetRepository.listProjectAssetExtensions(projectId);
    const context = normalizeAssetBrowserQuery(rawQuery, extensions, projectCategories);
    const asset = assetRepository.findProjectAssetViewerContext(projectId, normalizedAssetId, context);
    if (!asset) return null;

    const filteredPosition = asset.filtered_position ?? null;
    const filteredTotal = asset.filtered_total ?? 0;
    const filteredOut = filteredPosition === null;
    const currentPage = pageForPosition(filteredPosition, context.pageSize);

    const releaseUsage = releaseRepository.findReleaseUsageForAssetIds(projectId, [asset.id]);
    const previousAssetLink = filteredOut
      ? null
      : buildAdjacentAssetLink(projectId, asset.previous_asset_id, context, filteredPosition - 1);
    const nextAssetLink = filteredOut
      ? null
      : buildAdjacentAssetLink(projectId, asset.next_asset_id, context, filteredPosition + 1);
    const backToAssetsLink = {
      href: buildProjectAssetsUrl(projectId, context, currentPage),
      page: currentPage,
    };

    // Phase: asset actions chunk 4 — rename/move form projections. Only
    // enabled categories are ever valid move destinations; canMutate governs
    // whether the viewer shows the rename/move forms at all (archived
    // project or a missing-at-last-scan asset are both read-only).
    const enabledCategories = projectCategories
      .filter((c) => c.enabled === 1 || c.enabled === true)
      .map((c) => ({ id: c.id, displayName: c.display_name }));
    const canMutate = !project.archived_at && asset.is_present === 1;

    return {
      project: summarizeProject(project),
      asset: buildViewerAssetModel(asset, releaseUsage),
      context,
      filters: {
        search: context.search,
        extension: context.extension,
        presence: context.presence,
        usage: context.usage,
        category: context.category,
        sort: context.sort,
        order: context.order,
        view: context.view,
      },
      extensionChoices: extensions.map((extension) => ({
        value: extension,
        label: extension,
        selected: extension === context.extension,
      })),
      ordering: ASSET_BROWSER_ORDERING,
      searchMaxLength: ASSET_BROWSER_SEARCH_MAX_LENGTH,
      filteredOut,
      filteredPosition,
      filteredTotal,
      currentPage,
      previousAssetLink,
      nextAssetLink,
      backToAssetsLink,
      enabledCategories,
      canMutate,
    };
  }

  // ─── Phase 7B-3: Batch Readiness Attachment ────────────────────────────

  /**
   * Stable mapping from policy blocker key to concise human-readable label
   * for list/board/calendar presentation. No scores, percentages, subjective
   * requirements, or raw policy objects are included.
   */
  const BLOCKER_LABELS = {
    assets_selected: 'No assets selected',
    selected_assets_present: 'Missing selected assets',
    scope_mutable: 'Archived scope',
  };

  /**
   * Batch-attach compact readiness indicators to an array of releases.
   *
   * For status=ready releases, evaluates readiness via the shared policy
   * and attaches a `_readiness` property with:
   *   - publishable: boolean
   *   - blockerCount: number (only when not publishable)
   *   - blockerKeys: string[]  (only when not publishable)
   *   - blockerLabels: string[] (only when not publishable) — concise
   *     human-readable labels derived from stable policy keys, suitable
   *     for list/board/calendar presentation
   *   - correctiveLinks: Array<{ href: string, label: string }> (only
   *     when not publishable and scope is mutable) — links to resolve
   *     asset-related blockers; omitted for archived-scope releases
   *
   * For non-ready releases, no `_readiness` property is attached so
   * templates can distinguish "no claim" from "blocked".
   *
   * This is a single batch query: all readiness facts are loaded in one
   * round-trip, then evaluated through the shared pure policy per release.
   * No N+1 readiness queries.
   *
   * @param {Array} releases — release rows from findPage/findBoard
   * @returns {Array} same releases with optional _readiness attached
   */
  function _attachReadiness(releases) {
    if (typeof evaluateReleaseReadiness !== 'function') return releases;
    if (!Array.isArray(releases) || releases.length === 0) return releases;

    // Collect IDs of status=ready releases
    const readyIds = releases
      .filter((r) => r.status === 'ready')
      .map((r) => r.id);

    if (readyIds.length === 0) return releases;

    // Single batch query — no N+1
    const factsList = releaseRepository.findReadinessFactsByIds(readyIds);

    // Index facts by release_id for O(1) lookup
    const factsByReleaseId = new Map();
    for (const facts of factsList) {
      factsByReleaseId.set(facts.release_id, facts);
    }

    // Index by release_id
    const readinessByReleaseId = new Map();
    for (const facts of factsList) {
      const result = evaluateReleaseReadiness(facts);
      const indicator = { publishable: result.publishable };
      if (!result.publishable) {
        const blockers = result.checks.filter((c) => !c.passed);
        indicator.blockerCount = blockers.length;
        indicator.blockerKeys = blockers.map((c) => c.key);
        indicator.blockerLabels = blockers.map((c) => BLOCKER_LABELS[c.key] || c.key);

        // Corrective links for asset-related blockers on mutable scope
        const scopeMutable = !facts.release_archived_at && !facts.project_archived_at;
        if (scopeMutable) {
          const links = [];
          for (const check of blockers) {
            if (check.key === 'assets_selected') {
              links.push({ href: `/releases/${facts.release_id}/assets`, label: 'Manage assets' });
            } else if (check.key === 'selected_assets_present') {
              links.push({ href: `/projects/${facts.project_id}/assets`, label: 'Asset browser' });
            }
          }
          if (links.length > 0) {
            indicator.correctiveLinks = links;
          }
        }
      }
      readinessByReleaseId.set(facts.release_id, indicator);
    }

    return releases.map((release) => {
      if (release.status !== 'ready') return release;
      const indicator = readinessByReleaseId.get(release.id);
      if (!indicator) return release;
      return { ...release, _readiness: indicator };
    });
  }

  // ─── Phase 7A: Release Readiness ──────────────────────────────────────

  /**
   * Evaluate whether a release is ready to be published.
   *
   * Strictly validates the release ID, loads readiness facts from the
   * release repository, and passes them to the shared pure readiness
   * policy. Returns the policy result unchanged.
   *
   * This is a read-only composition — it does not mutate releases, call
   * publishRelease, call the scanner, access the filesystem, or calculate
   * readiness independently.
   *
   * @param {unknown} releaseId — validated as a strict positive integer
   * @returns {import('./release-readiness-policy.js').ReadinessResult}
   * @throws {Error} with status 404 when the release is not found
   * @throws {Error} when evaluateReleaseReadiness is not wired
   */
  function getReleaseReadiness(releaseId) {
    if (typeof evaluateReleaseReadiness !== 'function') {
      throw new Error(
        'getReleaseReadiness requires evaluateReleaseReadiness to be wired. ' +
        'Pass it as { evaluateReleaseReadiness } to createWorkflowQueryService.'
      );
    }

    const id = parseStrictPositiveInt(releaseId);
    if (id === null) {
      const err = new Error(`Release ${JSON.stringify(releaseId)} not found`);
      err.status = 404;
      throw err;
    }

    const facts = releaseRepository.findReadinessFactsById(id);
    if (!facts) {
      const err = new Error(`Release ${id} not found`);
      err.status = 404;
      throw err;
    }

    return evaluateReleaseReadiness(facts);
  }

  return {
    getDashboardData,
    getProjectWorkspace,
    getReleaseList,
    getReleaseBoard,
    getProjectCalendar,
    getProjectAssetBrowser,
    getProjectAssetBrowserContext,
    getProjectAssetViewer,
    getReleaseReadiness,
    normalizeListFilters,
    // Exposed for tests
    parseMonth,
    prevMonth,
    nextMonth,
    // Exposed for tests and advanced callers that want a single source of
    // truth for the active-set definition. Not intended for route use.
    constants: {
      DEFAULT_LIMITS,
      ACTIVE_RELEASE_STATUSES: ['idea', 'planned', 'drafting', 'ready'],
      RELEASE_STATUSES,
    },
  };
}
