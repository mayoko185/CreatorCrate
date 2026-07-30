import express from 'express';
import { buildPageUrl } from './releases.js';

// Phase 2D: canonical project-backed calendar route. The handler and the
// underlying workflowQueryService.getProjectCalendar query are not
// duplicated — /releases/calendar (see routes/releases.js) is now a
// compatibility redirect to this route.
export function createCalendarRouter({ appName, workflowQueryService }) {
  const router = express.Router();

  // GET /calendar — Monthly project-backed calendar view
  router.get('/', (req, res, next) => {
    try {
      const month = req.query.month || null;
      const { month: validatedMonth, days, firstDayWeekday, prevMonthDaysCount, prevMonth, nextMonth, today } = workflowQueryService.getProjectCalendar(month);
      // Calendar uses only the month parameter — no raw req.query
      const query = {};
      if (validatedMonth) query.month = validatedMonth;
      const pageUrl = buildPageUrl(req, query);
      const isCurrentMonth = validatedMonth === today.slice(0, 7);

      res.render('releases/calendar.njk', {
        appName,
        month: validatedMonth,
        days,
        firstDayWeekday,
        prevMonthDaysCount,
        prevMonth,
        nextMonth,
        today,
        isCurrentMonth,
        query,
        pageUrl,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
