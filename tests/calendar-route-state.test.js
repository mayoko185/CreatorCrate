import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { fileURLToPath } from 'node:url';
import { createCalendarRouter } from '../src/routes/calendar.js';
import { createPageDefaultsService } from '../src/services/page-defaults-service.js';

function createHarness(saved = {}, { counters = false } = {}) {
  const values = new Map(Object.entries(saved));
  const repository = {
    getValue: (key) => values.get(key),
    setValue: (key, value) => values.set(key, value),
  };
  // WP14a: the durable defaults generation the Calendar authority reports.
  if (counters) {
    repository.getCounter = (key) => Number(values.get(key) ?? 0);
    repository.compareAndIncrement = (key, expected) => {
      const current = Number(values.get(key) ?? 0);
      if (expected !== current) return { advanced: false, current };
      values.set(key, String(current + 1));
      return { advanced: true, current: current + 1 };
    };
  }
  const pageDefaultsService = createPageDefaultsService({ appMetaRepository: repository });
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
  // A stand-in for the live Project Type catalogue (stable values only).
  const typeCatalogue = ['images', 'comic', 'animation'];
  workflowQueryService.normalizeProjectTypeSelection = (value) => {
    const list = value === undefined ? [] : [].concat(value);
    return [...new Set(list.filter((entry) => typeCatalogue.includes(entry)))].sort();
  };
  workflowQueryService.getProjectTypeFilterOptions = (selected = []) => typeCatalogue
    .map((value) => ({ value, label: value.toUpperCase(), selected: selected.includes(value) }));
  const projectService = {
    listCalendarFilterOptions: () => [
      { id: 7, title: 'Archived project', status: 'archived', archived_at: '2026-01-01' },
      { id: 12, title: 'Bravo project', status: 'tbd', archived_at: null },
      { id: 3, title: 'Charlie project', status: 'tbd', archived_at: null },
    ],
  };
  const app = express();
  // The shared Edit Release dialog reads signatures and platforms from these.
  app.locals.releaseSignatureSettingsService = { getConfiguration: () => ({ entries: [], defaultId: null }) };
  app.locals.socialPrepSettingsService = { getPlatforms: () => [] };
  app.engine('njk', (_file, locals, callback) => callback(null, JSON.stringify({
    month: locals.month,
    status: locals.status,
    view: locals.view,
    weekStart: locals.weekStart,
    projectId: locals.projectId,
    selectedProject: locals.selectedProject,
    projectOptions: locals.projectOptions,
    projectIds: locals.projectIds,
    selectedProjects: locals.selectedProjects,
    projectTypes: locals.projectTypes,
    projectTypeOptions: locals.projectTypeOptions,
    query: locals.query,
    urls: {
      previous: locals.pageUrl({ month: locals.prevMonth }),
      next: locals.pageUrl({ month: locals.nextMonth }),
      today: locals.pageUrl({ month: null }),
      list: locals.pageUrl({ view: 'list' }),
    },
    resetFiltersUrl: locals.resetFiltersUrl,
    entries: locals.days[0].entries.map(({ id }) => id),
    firstDayWeekday: locals.firstDayWeekday,
    calendarDefaults: locals.calendarDefaults,
    calendarDefaultsAuthority: locals.calendarDefaultsAuthority,
    projectFilterOptions: locals.projectFilterOptions,
    projectFilterSelectedValues: locals.projectFilterSelectedValues,
    carriedProjectIds: locals.carriedProjectIds,
    calendarDefaultsDialogOpen: locals.calendarDefaultsDialogOpen,
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
      month: '2026-09', status: 'all', weekStart: 'monday', view: 'grid',
      query: { month: '2026-09' }, entries: [1, 2],
      resetFiltersUrl: '/calendar?month=2026-09',
    });
    expect(calls[0]).toEqual({ month: '2026-09', options: { projectIds: [], projectTypes: [], weekStart: 'monday' } });
    expect(model.calendarDefaults.fields.map(({ name }) => name)).toEqual(['view', 'status', 'weekStart']);
  });

  it.each([
    [undefined, undefined, 'grid', undefined],
    ['list', undefined, 'list', 'list'],
    ['grid', 'list', 'grid', 'grid'],
    ['invalid', 'list', 'list', undefined],
    ['invalid', undefined, 'grid', undefined],
  ])('resolves explicit view %s over saved view %s', async (explicit, saved, expected, queryView) => {
    const { app } = createHarness(saved ? { 'page_defaults.calendar.view': saved } : {});
    const suffix = explicit === undefined ? '' : `&view=${explicit}`;
    const model = JSON.parse((await request(app).get(`/calendar?month=2026-09${suffix}`).expect(200)).text);
    expect(model.view).toBe(expected);
    expect(model.query.view).toBe(queryView);
    // WP14b: Reset filters restores the saved/effective View, so its
    // destination never carries an explicit view (only the month).
    expect(model.resetFiltersUrl).toBe('/calendar?month=2026-09');
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
    expect(calls[0].options.projectIds).toEqual([7]);

    const invalid = JSON.parse((await request(app).get('/calendar?project=09').expect(200)).text);
    expect(invalid.projectId).toBeNull();
    expect(invalid.query.project).toBeUndefined();
    expect(calls[1].options.projectIds).toEqual([]);
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

  describe('WP13 repeated Project and Project Type selections', () => {
    const get = async (app, url) => JSON.parse((await request(app).get(url).expect(200)).text);

    it('keeps the legacy one-Project URL scalar (A, V)', async () => {
      const { app, calls } = createHarness();
      const model = await get(app, '/calendar?month=2026-09&project=12');
      expect(model).toMatchObject({ projectId: 12, projectIds: [12], query: { month: '2026-09', project: '12' } });
      expect(model.selectedProject.id).toBe(12);
      expect(calls[0].options).toEqual({ projectIds: [12], projectTypes: [], weekStart: 'monday' });
      expect(model.urls.next).toBe('/calendar?month=2026-10&project=12');
    });

    it('normalizes two, duplicate and reordered Project IDs (B, C, D)', async () => {
      const { app, calls } = createHarness();
      const first = await get(app, '/calendar?month=2026-09&project=12&project=7&project=12');
      const second = await get(app, '/calendar?month=2026-09&project=7&project=12');
      for (const model of [first, second]) {
        expect(model.projectIds).toEqual([7, 12]);
        expect(model.projectId).toBeNull();
        expect(model.selectedProject).toBeNull();
        expect(model.selectedProjects.map(({ id }) => id)).toEqual([7, 12]);
        expect(model.query.project).toEqual(['7', '12']);
      }
      expect(calls.map(({ options }) => options.projectIds)).toEqual([[7, 12], [7, 12]]);
    });

    it('drops malformed IDs and keeps unknown and archived Project restrictions', async () => {
      const { app, calls } = createHarness();
      const mixed = await get(app, '/calendar?month=2026-09&project=abc&project=999&project=0&project=7');
      expect(mixed.projectIds).toEqual([7, 999]);
      expect(mixed.selectedProjects).toEqual([expect.objectContaining({ id: 7, status: 'archived' })]);
      expect(mixed.query.project).toEqual(['7', '999']);
      expect(mixed.carriedProjectIds).toEqual([999]);

      const unknown = await get(app, '/calendar?month=2026-09&project=999&project=abc');
      expect(unknown).toMatchObject({
        projectId: 999, projectIds: [999], selectedProject: null, selectedProjects: [],
        query: { project: '999' }, carriedProjectIds: [999],
      });
      expect(calls.map(({ options }) => options.projectIds)).toEqual([[7, 999], [999]]);
    });

    it('normalizes one, several and stale Types against the catalogue (G, H, I)', async () => {
      const { app, calls } = createHarness();
      const one = await get(app, '/calendar?month=2026-09&type=comic');
      expect(one.projectTypes).toEqual(['comic']);
      expect(one.query.type).toBe('comic');
      const many = await get(app, '/calendar?month=2026-09&type=comic&type=stale&type=animation&type=comic&type=Comic');
      expect(many.projectTypes).toEqual(['animation', 'comic']);
      expect(many.query.type).toEqual(['animation', 'comic']);
      expect(many.projectTypeOptions.filter(({ selected }) => selected).map(({ value }) => value))
        .toEqual(['comic', 'animation']);
      const stale = await get(app, '/calendar?month=2026-09&type=stale');
      expect(stale.projectTypes).toEqual([]);
      expect(stale.query.type).toBeUndefined();
      expect(calls.map(({ options }) => options.projectTypes)).toEqual([['comic'], ['animation', 'comic'], []]);
    });

    it('models the combined dialog Projects multi-select from every Calendar Project, archived included (WP14b)', async () => {
      const { app } = createHarness();
      const model = await get(app, '/calendar?month=2026-09&project=12&project=7&project=999');
      expect(model.projectFilterSelectedValues).toEqual(['7', '12', '999']);
      expect(model.carriedProjectIds).toEqual([999]);
      expect(model.projectFilterOptions).toEqual([
        {
          value: '7', label: 'Archived project', selected: true, suffix: 'Archived',
          classes: 'calendar-project-option--archived', attributes: [['data-calendar-archived-project', true]],
        },
        { value: '12', label: 'Bravo project', selected: true },
        { value: '3', label: 'Charlie project', selected: false },
      ]);
      const unrestricted = await get(app, '/calendar?month=2026-09');
      expect(unrestricted.projectFilterSelectedValues).toEqual([]);
      expect(unrestricted.projectFilterOptions.every(({ selected }) => selected === false)).toBe(true);
      expect(unrestricted.calendarDefaultsDialogOpen).toBe(false);
      expect((await get(app, '/calendar?month=2026-09&defaults=1')).calendarDefaultsDialogOpen).toBe(true);
    });

    it('combines Projects, Types and release status (J, K)', async () => {
      const { app, calls } = createHarness();
      const model = await get(app, '/calendar?month=2026-09&status=planned&project=3&project=12&type=images&type=comic');
      expect(calls[0].options).toEqual({ projectIds: [3, 12], projectTypes: ['comic', 'images'], weekStart: 'monday' });
      expect(model.entries).toEqual([1]);
      expect(model.query).toEqual({
        month: '2026-09', status: 'planned', project: ['3', '12'], type: ['comic', 'images'],
      });
    });

    it('carries repeated values through previous, next, Today and View links (O, Q, R)', async () => {
      const { app } = createHarness();
      const model = await get(app,
        '/calendar?month=2026-09&weekStart=sunday&view=list&project=12&project=7&type=comic&type=animation');
      const context = 'weekStart=sunday&view=list&project=7&project=12&type=animation&type=comic';
      expect(model.urls).toEqual({
        previous: `/calendar?month=2026-08&${context}`,
        next: `/calendar?month=2026-10&${context}`,
        today: `/calendar?${context}`,
        list: `/calendar?month=2026-09&${context}`,
      });
      expect(model).toMatchObject({ weekStart: 'sunday', view: 'list', firstDayWeekday: 2 });
    });

    it('resets Projects, Types and the explicit View with the other filters while keeping the month (WP14b)', async () => {
      const { app } = createHarness({}, { counters: true });
      const model = await get(app, '/calendar?month=2026-09&view=list&project=7&project=12&type=comic');
      expect(model.resetFiltersUrl).toBe('/calendar?month=2026-09');
      expect(model.resetFiltersUrl).toBe(model.calendarDefaultsAuthority.resetFiltersUrl);
    });

    it('reports the effective presentation as the Save snapshot and a month-only Reset filters destination (WP14a)', async () => {
      const { app, values } = createHarness({
        'page_defaults.calendar.view': 'list',
        'page_defaults.calendar.status': 'all',
      }, { counters: true });
      const model = await get(app, '/calendar?month=2026-09&status=planned&weekStart=sunday&project=12&project=7&type=comic');
      expect(model.calendarDefaultsAuthority).toMatchObject({
        page: 'calendar',
        defaults: { view: 'list', status: 'all', weekStart: 'monday' },
        savedKeys: ['view', 'status'],
        generation: 0,
        current: { view: 'list', status: 'planned', weekStart: 'sunday' },
        currentUrl: '/calendar?month=2026-09&status=planned&weekStart=sunday&project=7&project=12&type=comic',
        month: '2026-09',
        resetFiltersUrl: '/calendar?month=2026-09',
      });
      // Rendering the authority never writes a key or a generation.
      expect([...values.keys()].sort()).toEqual(['page_defaults.calendar.status', 'page_defaults.calendar.view']);
    });

    it('fails closed without the generation authority while still rendering Calendar (WP14a)', async () => {
      const { app } = createHarness({ 'page_defaults.calendar.view': 'list' });
      const model = await get(app, '/calendar?month=2026-09');
      expect(model.calendarDefaultsAuthority).toBeNull();
      expect(model).toMatchObject({ view: 'list', month: '2026-09' });
    });

    it('never saves Project, Type or month selections as Calendar defaults', async () => {
      const { app, values } = createHarness();
      const model = await get(app, '/calendar?month=2026-09&project=7&project=12&type=comic');
      expect([...values.keys()]).toEqual([]);
      expect(model.calendarDefaults.fields.map(({ name }) => name)).toEqual(['view', 'status', 'weekStart']);
    });
  });
});
