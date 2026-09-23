import express from 'express';
import { buildPageUrl } from './releases.js';
import { buildPageDefaultsDialogModel } from './page-defaults.js';
import { NSFW_TAG_NAME } from '../services/nsfw-filter-settings-service.js';

const CALENDAR_DEFAULT_LABELS = Object.freeze({
  fields: { status: 'Release status', weekStart: 'Week starts on' },
  options: {
    status: { all: 'All releases', planned: 'Planned', published: 'Published' },
    weekStart: { monday: 'Monday', sunday: 'Sunday' },
  },
});

function parseProjectId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export function createCalendarRouter({ appName, workflowQueryService, pageDefaultsService, projectService,
  projectTagService, nsfwFilterSettingsService }) {
  const router = express.Router();

  // GET /calendar — Monthly release-backed calendar view
  router.get('/', (req, res, next) => {
    try {
      const month = req.query.month || null;
      const status = ['all', 'planned', 'published'].includes(req.query.status) ? req.query.status : undefined;
      const weekStart = ['monday', 'sunday'].includes(req.query.weekStart) ? req.query.weekStart : undefined;
      const defaults = pageDefaultsService.resolvePageDefaults('calendar', {
        status,
        weekStart,
      });
      const projectOptions = projectService.listCalendarFilterOptions();
      const requestedProjectId = parseProjectId(req.query.project);
      const selectedProject = projectOptions.find(({ id }) => id === requestedProjectId) || null;
      const projectId = selectedProject?.id ?? null;
      const calendar = workflowQueryService.getReleaseCalendar(month, {
        projectId,
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
      const days = filteredDays.map((day) => ({
        ...day,
        entries: day.entries.map((entry) => ({ ...entry, nsfwBlur: nsfwProjectIds.has(entry.project_id) })),
      }));
      const monthHeading = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })
        .format(new Date(`${validatedMonth}-01T00:00:00Z`));
      const releaseCount = days.reduce((count, day) => count + day.entries.length, 0);
      const query = {};
      if (validatedMonth) query.month = validatedMonth;
      if (status !== undefined) query.status = status;
      if (weekStart !== undefined) query.weekStart = weekStart;
      if (projectId !== null) query.project = String(projectId);
      const pageUrl = buildPageUrl(req, query);
      const isCurrentMonth = validatedMonth === today.slice(0, 7);

      res.render('releases/calendar.njk', {
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
        weekStart: defaults.weekStart,
        projectId,
        selectedProject,
        projectOptions,
        resetFiltersUrl: pageUrl({ status: null, weekStart: null, project: null }),
        calendarDefaults: buildPageDefaultsDialogModel({
          pageDefaultsService,
          page: 'calendar',
          labels: CALENDAR_DEFAULT_LABELS,
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
