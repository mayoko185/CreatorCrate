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

function totalFromCounts(counts) {
  if (!counts) return 0;
  return Object.values(counts).reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
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
 */
export function createWorkflowQueryService({ db }) {
  const projectRepository = createProjectRepository(db);
  const releaseRepository = createReleaseRepository(db);
  const assetRepository = createAssetRepository(db);

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
    const ready = releaseRepository.findReady(limits.ready);
    const missingPlannedDate = releaseRepository.findActiveWithoutPlannedDate(limits.missingPlannedDate);
    const missingSelectedAssets = releaseRepository.findReleasesWithMissingSelectedAssets(limits.missingSelectedAssets);
    const releasesWithoutAssets = releaseRepository.findReleasesWithoutSelectedAssets(limits.missingSelectedAssets);
    const upcomingRaw = releaseRepository.findUpcoming(limits.upcoming, today);
    const upcoming = groupByDate(upcomingRaw);

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
        ready,
        missingPlannedDate,
        missingSelectedAssets,
        releasesWithoutAssets,
        totalCount:
          overdue.length
          + ready.length
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

  return {
    getDashboardData,
    getProjectWorkspace,
    // Exposed for tests and advanced callers that want a single source of
    // truth for the active-set definition. Not intended for route use.
    constants: {
      DEFAULT_LIMITS,
      ACTIVE_RELEASE_STATUSES: ['idea', 'planned', 'drafting', 'ready'],
      RELEASE_STATUSES,
    },
  };
}
