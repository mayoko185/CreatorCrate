import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { fileURLToPath } from 'node:url';
import { createCalendarRouter } from '../src/routes/calendar.js';
import { createPageDefaultsService } from '../src/services/page-defaults-service.js';

function createHarness(saved = {}) {
  const values = new Map(Object.entries(saved));
  const pageDefaultsService = createPageDefaultsService({
    appMetaRepository: {
      getValue: (key) => values.get(key),
      setValue: (key, value) => values.set(key, value),
    },
  });
  const calls = [];
  const workflowQueryService = {
    getReleaseCalendar(month, options) {
      calls.push({ month, options });
      return {
        month: month || '2026-09',
        days: [{ date: '2026-09-10', entries: [
          { id: 1, status: 'planned' },
          { id: 2, status: 'published' },
        ] }],
        firstDayWeekday: options.weekStart === 'sunday' ? 2 : 1,
        prevMonthDaysCount: 31,
        prevMonth: '2026-08',
        nextMonth: '2026-10',
        today: '2026-09-10',
      };
    },
  };
  const projectService = {
    listCalendarFilterOptions: () => [
      { id: 7, title: 'Archived project', status: 'archived', archived_at: '2026-01-01' },
    ],
  };
  const app = express();
  app.engine('njk', (_file, locals, callback) => callback(null, JSON.stringify({
    month: locals.month,
    status: locals.status,
    weekStart: locals.weekStart,
    projectId: locals.projectId,
    selectedProject: locals.selectedProject,
    projectOptions: locals.projectOptions,
    query: locals.query,
    resetFiltersUrl: locals.resetFiltersUrl,
    entries: locals.days[0].entries.map(({ id }) => id),
    firstDayWeekday: locals.firstDayWeekday,
    calendarDefaults: locals.calendarDefaults,
  })));
  app.set('view engine', 'njk');
  app.set('views', fileURLToPath(new URL('../src/views', import.meta.url)));
  app.use('/calendar', createCalendarRouter({
    appName: 'CreatorCrate', workflowQueryService, pageDefaultsService, projectService,
  }));
  return { app, calls, values };
}

describe('Calendar route state', () => {
  it('uses hardcoded fallbacks without saved defaults and keeps month as URL state', async () => {
    const { app, calls } = createHarness();
    const response = await request(app).get('/calendar?month=2026-09').expect(200);
    const model = JSON.parse(response.text);
    expect(model).toMatchObject({
      month: '2026-09', status: 'all', weekStart: 'monday',
      query: { month: '2026-09' }, entries: [1, 2],
      resetFiltersUrl: '/calendar?month=2026-09',
    });
    expect(calls[0]).toEqual({ month: '2026-09', options: { projectId: null, weekStart: 'monday' } });
    expect(model.calendarDefaults.fields.map(({ name }) => name)).toEqual(['status', 'weekStart']);
  });

  it.each(['planned', 'published'])('applies saved %s when status is absent', async (status) => {
    const { app } = createHarness({ 'page_defaults.calendar.status': status });
    const model = JSON.parse((await request(app).get('/calendar?month=2026-09').expect(200)).text);
    expect(model.status).toBe(status);
    expect(model.entries).toEqual(status === 'planned' ? [1] : [2]);
    expect(model.query).toEqual({ month: '2026-09' });
  });

  it.each([
    ['all', 'planned', [1, 2]],
    ['planned', 'published', [1]],
    ['published', 'planned', [2]],
  ])('preserves explicit status %s over saved %s', async (status, saved, entries) => {
    const { app } = createHarness({ 'page_defaults.calendar.status': saved });
    const model = JSON.parse((await request(app).get(`/calendar?month=2026-09&status=${status}`).expect(200)).text);
    expect(model.status).toBe(status);
    expect(model.entries).toEqual(entries);
    expect(model.query.status).toBe(status);
  });

  it.each([
    ['published', 'published', [2]],
    ['planned', 'planned', [1]],
    [undefined, 'all', [1, 2]],
  ])('uses saved status %s for invalid explicit status', async (saved, expected, entries) => {
    const { app, values } = createHarness(saved
      ? { 'page_defaults.calendar.status': saved } : {});
    const model = JSON.parse((await request(app).get('/calendar?status=invalid').expect(200)).text);
    expect(model.status).toBe(expected);
    expect(model.entries).toEqual(entries);
    expect(model.query.status).toBeUndefined();
    expect(values.get('page_defaults.calendar.status')).toBe(saved);
  });

  it.each([
    ['sunday', undefined, 'sunday'],
    ['sunday', 'monday', 'monday'],
    ['monday', 'sunday', 'sunday'],
    ['sunday', 'invalid', 'sunday'],
    ['monday', 'invalid', 'monday'],
    [undefined, 'invalid', 'monday'],
  ])('resolves week start from saved %s and explicit %s', async (saved, explicit, expected) => {
    const { app, calls } = createHarness(saved
      ? { 'page_defaults.calendar.week_start': saved } : {});
    const suffix = explicit === undefined ? '' : `?weekStart=${explicit}`;
    const model = JSON.parse((await request(app).get(`/calendar${suffix}`).expect(200)).text);
    expect(model.weekStart).toBe(expected);
    expect(calls[0].options.weekStart).toBe(expected);
    expect(model.query.weekStart).toBe(['monday', 'sunday'].includes(explicit) ? explicit : undefined);
  });

  it('passes archived parent projects to C1 and clears invalid project state', async () => {
    const { app, calls } = createHarness();
    const selected = JSON.parse((await request(app).get('/calendar?month=2026-09&project=7').expect(200)).text);
    expect(selected.projectId).toBe(7);
    expect(selected.selectedProject.id).toBe(7);
    expect(selected.projectOptions[0].status).toBe('archived');
    expect(selected.query.project).toBe('7');
    expect(selected.resetFiltersUrl).toBe('/calendar?month=2026-09');
    expect(calls[0].options.projectId).toBe(7);

    const invalid = JSON.parse((await request(app).get('/calendar?project=999').expect(200)).text);
    expect(invalid.projectId).toBeNull();
    expect(invalid.query.project).toBeUndefined();
    expect(calls[1].options.projectId).toBeNull();
  });

  it('reapplies saved defaults through the Reset URL while retaining the month', async () => {
    const { app } = createHarness({
      'page_defaults.calendar.status': 'published',
      'page_defaults.calendar.week_start': 'sunday',
    });
    const filtered = JSON.parse((await request(app)
      .get('/calendar?month=2026-09&status=all&project=7&weekStart=monday').expect(200)).text);
    expect(filtered.resetFiltersUrl).toBe('/calendar?month=2026-09');
    const reset = JSON.parse((await request(app).get(filtered.resetFiltersUrl).expect(200)).text);
    expect(reset).toMatchObject({
      month: '2026-09', status: 'published', weekStart: 'sunday', projectId: null,
      query: { month: '2026-09' },
    });
  });
});
