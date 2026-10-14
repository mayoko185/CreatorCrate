import { NSFW_TAG_NAME } from '../services/nsfw-filter-settings-service.js';
import { isProjectArchived } from '../services/project-state.js';
import { buildNewProjectFormModel } from './project-create-form.js';
import {
  buildProjectOptionPresentation,
  presentProjectOptions,
} from '../services/project-option-presenter.js';

const NSFW_TAG_NORMALIZED_NAME = NSFW_TAG_NAME.toLowerCase();

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Waiting-age thresholds for undated releases, in whole calendar days.
const NEEDS_DATE_WARNING_AGE_DAYS = 7;
const NEEDS_DATE_DANGER_AGE_DAYS = 21;

const PUBLISH_ACTION_GROUPS = new Set(['overdue', 'today']);

function getNsfwFilterSettingsService(req) {
  const service = req.app?.locals?.nsfwFilterSettingsService;
  if (!service) {
    throw new Error('Dashboard requires app.locals.nsfwFilterSettingsService.');
  }
  return service;
}

function isNsfwTag(tag) {
  return [tag?.displayName, tag?.display_name, tag?.normalizedName, tag?.normalized_name].some((value) => (
    typeof value === 'string' && value.trim().toLowerCase() === NSFW_TAG_NORMALIZED_NAME
  ));
}

function hasNsfwTag(tags) {
  return Array.isArray(tags) && tags.some(isNsfwTag);
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

// ISO calendar dates are presented without a timezone conversion: they are
// already application-local values.
function parseIsoDate(isoDate) {
  if (typeof isoDate !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(isoDate)) return null;
  const [year, month, day] = isoDate.slice(0, 10).split('-').map(Number);
  return { year, month, day, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

function formatDate(isoDate, style, today) {
  const date = parseIsoDate(isoDate);
  if (!date) return '';
  const otherYear = today && parseIsoDate(today)?.year !== date.year;
  switch (style) {
    case 'weekday-day':
      return `${WEEKDAYS_SHORT[date.weekday]} ${date.day}`;
    case 'long':
      return `${MONTHS_LONG[date.month - 1]} ${date.day}${otherYear ? `, ${date.year}` : ''}`;
    case 'full':
      return `${WEEKDAYS_LONG[date.weekday]}, ${MONTHS_LONG[date.month - 1]} ${date.day}, ${date.year}`;
    case 'short':
    default:
      return `${MONTHS_SHORT[date.month - 1]} ${date.day}${otherYear ? `, ${date.year}` : ''}`;
  }
}

function presentDateBlock(isoDate) {
  const date = parseIsoDate(isoDate);
  if (!date) return null;
  return { month: MONTHS_SHORT[date.month - 1], day: date.day };
}

function buildInitials(title) {
  const words = String(title || '').trim().split(/\s+/).filter(Boolean);
  const letters = (words.length > 1 ? [words[0], words[words.length - 1]] : words)
    .map((word) => Array.from(word)[0] || '')
    .join('');
  return letters.toUpperCase() || '?';
}

function presentThumbnail(primaryImage, title, nsfwBlur) {
  return {
    available: primaryImage?.state === 'available' && Boolean(primaryImage.thumbnailUrl),
    url: primaryImage?.thumbnailUrl || null,
    mediaModifier: primaryImage?.mediaModifier || null,
    initials: buildInitials(title),
    nsfwBlur,
  };
}

function presentAgeTone(ageDays) {
  if (ageDays == null) return 'neutral';
  if (ageDays >= NEEDS_DATE_DANGER_AGE_DAYS) return 'danger';
  if (ageDays >= NEEDS_DATE_WARNING_AGE_DAYS) return 'warning';
  return 'neutral';
}

function presentAgeLabel(ageDays) {
  if (ageDays == null) return 'No date';
  if (ageDays === 0) return 'No date · added today';
  return `No date · ${pluralize(ageDays, 'day')}`;
}

function presentAssetReadiness(release) {
  const selected = release.selected_asset_count ?? 0;
  const missing = release.missing_asset_count ?? 0;
  if (missing > 0) return { tone: 'danger', label: `${missing} missing` };
  if (selected === 0) return { tone: 'danger', label: 'No assets selected' };
  return { tone: 'ok', label: 'Assets selected' };
}

function presentNextRelease(nextRelease, today) {
  const undatedCount = nextRelease?.undatedCount ?? 0;
  const extraUndatedLabel = undatedCount > 0 ? `(+${undatedCount} no date)` : '';
  switch (nextRelease?.state) {
    case 'overdue':
      return {
        state: 'overdue',
        label: `Overdue · ${formatDate(nextRelease.plannedDate, 'short', today)}`,
        plannedTime: null,
        releaseId: nextRelease.releaseId,
        title: nextRelease.title,
        extraUndatedLabel,
      };
    case 'today':
      return {
        state: 'today',
        label: 'Today',
        plannedTime: nextRelease.plannedTime,
        releaseId: nextRelease.releaseId,
        title: nextRelease.title,
        extraUndatedLabel,
      };
    case 'scheduled':
      return {
        state: 'scheduled',
        label: formatDate(nextRelease.plannedDate, 'short', today),
        plannedTime: null,
        releaseId: nextRelease.releaseId,
        title: nextRelease.title,
        extraUndatedLabel,
      };
    case 'undated':
      return { state: 'undated', label: 'No date set', plannedTime: null, releaseId: null, title: null, extraUndatedLabel: '' };
    default:
      return { state: 'none', label: 'None planned', plannedTime: null, releaseId: null, title: null, extraUndatedLabel: '' };
  }
}

/**
 * The Calendar entry shape rendered by partials/calendar-info-card.njk.
 * Dashboard release lists exclude archived releases and releases of archived
 * projects, so every unpublished release here is editable.
 */
function presentReleaseInfoCard(release, nsfwBlur) {
  return {
    id: release.id,
    project_id: release.project_id,
    project_title: release.project_title,
    title: release.title,
    notes: release.notes,
    status: release.published_date ? 'published' : 'planned',
    planned_date: release.planned_date,
    planned_time: release.planned_time,
    published_date: release.published_date,
    platforms: (release.socialPreparation?.targets ?? []).map((target) => target.platformName),
    primaryImage: release.primaryImage,
    nsfwBlur,
    editUrl: release.published_date ? null : `/releases/${release.id}/edit`,
  };
}

function presentStripDay(day, today) {
  const parts = [formatDate(day.date, 'long', today)];
  if (day.isToday) parts.push('today');
  if (day.counts.overdue > 0) parts.push(`${day.counts.overdue} overdue`);
  if (day.counts.scheduled > 0) parts.push(`${day.counts.scheduled} scheduled`);
  if (day.counts.published > 0) parts.push(`${day.counts.published} published`);
  if (day.isOpen) parts.push('open day');
  else if (day.counts.overdue + day.counts.scheduled + day.counts.published === 0) parts.push('no releases');

  const date = parseIsoDate(day.date);
  return {
    ...day,
    weekdayLabel: WEEKDAYS_SHORT[date.weekday],
    dayNumber: date.day,
    accessibleLabel: parts.join(', '),
  };
}

function presentQuickPick(openDay, today) {
  return {
    date: openDay.date,
    inStrip: openDay.inStrip,
    label: formatDate(openDay.date, 'weekday-day', today),
    accessibleDate: formatDate(openDay.date, 'full', today),
  };
}

function buildStatusTabs(projectTable, statusOptions) {
  return [
    {
      value: 'all',
      label: 'All',
      count: projectTable.total,
      href: '/projects?status=all',
      option: null,
    },
    ...statusOptions.map((option) => ({
      value: option.value,
      label: option.label,
      count: projectTable.statusCounts?.[option.value] ?? 0,
      href: `/projects?status=${encodeURIComponent(option.value)}`,
      option,
    })),
  ];
}

/**
 * Release IDs from `?retain=1,2`, sent by the Dashboard refresh for the
 * scheduling confirmations it keeps on screen. Malformed values are ignored.
 * There is deliberately no count cap: confirmations accumulate for the whole
 * page session and each one needs its titles, so dropping IDs would drop
 * confirmations. The request-line size bounds the input, and the repository
 * resolves every ID in one query.
 */
export function parseRetainedReleaseIds(value) {
  if (typeof value !== 'string' || !value) return [];
  const ids = value.split(',')
    .filter((part) => /^[1-9]\d{0,15}$/.test(part))
    .map(Number)
    .filter(Number.isSafeInteger);
  return [...new Set(ids)];
}

export function renderDashboardPage(req, res, next, {
  appName,
  workflowQueryService,
  pageDefaultsService,
  tagService,
  status = 200,
  projectCreateDialogOpen = false,
  projectCreateForm,
  retainedReleaseIds = [],
} = {}) {
  try {
    const effectivePageDefaultsService = pageDefaultsService || req.app?.locals?.pageDefaultsService;
    if (!effectivePageDefaultsService) {
      throw new Error('Dashboard requires a pageDefaultsService.');
    }
    const dashboard = retainedReleaseIds.length
      ? workflowQueryService.getDashboardData({ retainedReleaseIds })
      : workflowQueryService.getDashboardData();
    const { today } = dashboard;
    const nsfwFilterEnabled = getNsfwFilterSettingsService(req).isEnabled();
    const optionPresentation = buildProjectOptionPresentation({
      status: effectivePageDefaultsService.getOptionCatalogue('new_project', 'status'),
      projectType: effectivePageDefaultsService.getOptionCatalogue('projects', 'projectType')
        .filter(({ value }) => value !== 'all'),
    });
    const statusOptions = [...optionPresentation.statusByValue.values()]
      .filter(({ value }) => !isProjectArchived({ status: value }));

    const presentProject = (project) => {
      const nsfwBlur = Boolean(nsfwFilterEnabled && hasNsfwTag(project.tags));
      return {
        ...presentProjectOptions({ ...project, nsfwBlur }, optionPresentation),
        thumbnail: presentThumbnail(project.primaryImage, project.title, nsfwBlur),
        nextReleasePresentation: presentNextRelease(project.nextRelease, today),
        lastPublishedLabel: project.lastPublishedDate ? formatDate(project.lastPublishedDate, 'short', today) : null,
        updatedLabel: formatDate(project.updated_at, 'short', today),
      };
    };

    const presentRelease = (release) => {
      const nsfwBlur = Boolean(nsfwFilterEnabled && hasNsfwTag(release.tags));
      return {
        ...release,
        nsfwBlur,
        thumbnail: presentThumbnail(release.primaryImage, release.project_title, nsfwBlur),
        projectStatusOption: optionPresentation.statusByValue.get(release.project_status) || null,
        assetReadiness: presentAssetReadiness(release),
        infoCard: presentReleaseInfoCard(release, nsfwBlur),
        project: presentProject(release.project),
      };
    };

    const needsDateItems = dashboard.needsDate.items.map((release) => ({
      ...presentRelease(release),
      ageTone: presentAgeTone(release.ageDays),
      ageLabel: presentAgeLabel(release.ageDays),
    }));

    const scheduledGroups = dashboard.scheduled.groups.map((group) => ({
      ...group,
      headingId: `dashboard-schedule-${group.id}-heading`,
      viewAllHref: group.total > group.items.length ? group.viewAllHref : null,
      items: group.items.map((release) => ({
        ...presentRelease(release),
        dateBlock: presentDateBlock(release.planned_date),
        dateLabel: formatDate(release.planned_date, 'long', today),
        action: PUBLISH_ACTION_GROUPS.has(group.id)
          ? { kind: 'publish', label: 'Publish', href: `/releases/${release.id}/publish` }
          : { kind: 'open', label: 'Open', href: `/releases/${release.id}` },
      })),
    }));

    const recentlyPublished = dashboard.recentlyPublished.items.map((release) => ({
      ...presentRelease(release),
      publishedLabel: formatDate(release.published_date, 'short', today),
    }));

    const projectTable = dashboard.projectTable;
    const projectRows = projectTable.rows.map(presentProject);

    res.status(status).render('index.njk', {
      appName,
      nsfwFilterEnabled,
      projectCreateDialogOpen: Boolean(projectCreateDialogOpen),
      projectCreateForm: projectCreateForm || buildNewProjectFormModel({
        tagService,
        pageDefaultsService: effectivePageDefaultsService,
      }),
      dashboard: {
        today,
        todayLabel: formatDate(today, 'full'),
        tiles: dashboard.tiles,
        strip: {
          days: dashboard.strip.days.map((day) => presentStripDay(day, today)),
        },
        quickPicks: dashboard.strip.openDays.map((openDay) => presentQuickPick(openDay, today)),
        needsDate: {
          total: dashboard.needsDate.total,
          items: needsDateItems,
          viewAllHref: dashboard.needsDate.viewAllHref,
        },
        scheduled: { groups: scheduledGroups },
        recentlyPublished,
        retained: retainedReleaseIds.length
          ? { releases: (dashboard.retainedReleases ?? []).map(presentRelease) }
          : null,
        projectTable: {
          complete: projectTable.complete,
          total: projectTable.total,
          shown: projectTable.shown,
          tabs: buildStatusTabs(projectTable, statusOptions),
          rows: projectRows,
        },
      },
    });
  } catch (err) {
    next(err);
  }
}
