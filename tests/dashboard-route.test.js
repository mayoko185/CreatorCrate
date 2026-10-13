/**
 * Route-level tests for the Dashboard presentation model. The query service
 * is stubbed with the release-first Dashboard contract and res.render is
 * intercepted, so these tests do not depend on index.njk.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createIndexRouter } from '../src/routes/index.js';

const STATUS_CATALOGUE = [
  { value: 'tbd', label: 'Tbd', color: '#64748B' },
  { value: 'planned', label: 'Planned', color: '#3B82F6' },
  { value: 'editorial-review', label: 'Editorial Review', color: '#123456' },
  { value: 'ready', label: 'Ready', color: '#22C55E' },
  { value: 'archived', label: 'Archived', color: '#475569' },
];
const PROJECT_TYPE_CATALOGUE = [
  { value: 'images', label: 'Images', color: '#64748B' },
];
const NSFW_TAGS = [{ displayName: 'NSFW' }];
const AVAILABLE_IMAGE = { state: 'available', thumbnailUrl: '/thumb.webp', alt: 'Cover' };

function buildRelease(overrides = {}) {
  const release = {
    id: 1,
    title: 'Release',
    project_id: 10,
    project_title: 'Moon Garden',
    project_status: 'ready',
    planned_date: null,
    planned_time: null,
    published_date: null,
    created_at: '2026-10-01 10:00:00',
    selected_asset_count: 2,
    missing_asset_count: 0,
    primaryImage: { state: 'none' },
    tags: [],
    socialPreparation: { targets: [] },
    ...overrides,
  };
  // The service attaches the parent project's summary from the same
  // enrichment as the release, so it shares the release's image and tags.
  return {
    project: buildProjectRow({
      id: release.project_id,
      title: release.project_title,
      status: release.project_status,
      primaryImage: release.primaryImage,
      tags: release.tags,
    }),
    ...release,
  };
}

function buildProjectRow(overrides = {}) {
  return {
    id: 10,
    title: 'Moon Garden',
    status: 'ready',
    project_type: 'images',
    updated_at: '2026-10-11 09:30:00',
    archived_at: null,
    primaryImage: { state: 'none' },
    tags: [],
    assetCount: 4,
    missingAssetCount: 0,
    nextRelease: {
      state: 'none', releaseId: null, title: null, plannedDate: null, plannedTime: null, daysLate: null, undatedCount: 0,
    },
    undatedReleaseCount: 0,
    lastPublishedDate: null,
    ...overrides,
  };
}

function buildStripDays(today = '2026-10-12') {
  const start = Date.UTC(2026, 9, 12);
  return Array.from({ length: 14 }, (_, index) => {
    const date = new Date(start + index * 86400000).toISOString().slice(0, 10);
    return {
      date,
      isToday: date === today,
      isPast: date < today,
      isOpen: date > today,
      counts: { overdue: 0, scheduled: 0, published: 0 },
      calendarHref: `/calendar?month=${date.slice(0, 7)}`,
    };
  });
}

function buildDashboard(overrides = {}) {
  return {
    today: '2026-10-12',
    weekStart: 'monday',
    tiles: {
      overdue: { count: 0, href: '/releases?schedule=overdue' },
      needsDate: { count: 0, oldestAgeDays: null, href: '#needs-date' },
      dueToday: { count: 0, firstRelease: null, href: '/releases?schedule=today' },
      next7Days: { count: 0, throughDate: '2026-10-19', href: '/releases?schedule=upcoming' },
      missingAssets: { count: 0, affectedReleaseCount: 0, href: '/asset-viewer?presence=missing' },
    },
    strip: {
      startDate: '2026-10-12',
      endDateExclusive: '2026-10-26',
      days: buildStripDays(),
      openDays: [
        { date: '2026-10-13', inStrip: true, calendarHref: '/calendar?month=2026-10' },
        { date: '2026-10-14', inStrip: true, calendarHref: '/calendar?month=2026-10' },
        { date: '2026-10-27', inStrip: false, calendarHref: '/calendar?month=2026-10' },
      ],
    },
    needsDate: { total: 0, items: [], viewAllHref: null },
    scheduled: { groups: [] },
    recentlyPublished: { items: [] },
    projectTable: {
      total: 0, shown: 0, complete: true, statusCounts: {}, rows: [],
    },
    ...overrides,
  };
}

function createTestApp({
  dashboard = buildDashboard(),
  nsfwEnabled = false,
  withNsfwService = true,
} = {}) {
  const app = express();
  let captured = null;

  if (withNsfwService) {
    app.locals.nsfwFilterSettingsService = { isEnabled: () => nsfwEnabled };
  }
  const pageDefaultsService = {
    resolve: vi.fn((_page, _field, value) => value || 'tbd'),
    getSavedDefault: vi.fn((_page, field) => (field === 'status' ? 'tbd' : 'images')),
    getOptionCatalogue: vi.fn((page, field) => {
      if (page === 'new_project' && field === 'status') return STATUS_CATALOGUE;
      if (page === 'new_project' && field === 'projectType') return PROJECT_TYPE_CATALOGUE;
      if (page === 'projects' && field === 'projectType') {
        return [{ value: 'all', label: 'All types' }, ...PROJECT_TYPE_CATALOGUE];
      }
      throw new Error(`Unexpected Page Defaults catalogue request: ${page}.${field}`);
    }),
  };
  const tagService = { listTags: vi.fn(() => []) };

  app.use((req, res, next) => {
    res.render = (view, locals) => {
      captured = { view, locals };
      res.status(200).json({ ok: true });
    };
    next();
  });

  const workflowQueryService = { getDashboardData: vi.fn(() => dashboard) };
  app.use('/', createIndexRouter({
    appName: 'Test App',
    workflowQueryService,
    pageDefaultsService,
    tagService,
  }));

  return {
    app,
    getCaptured: () => captured,
    pageDefaultsService,
    tagService,
    workflowQueryService,
  };
}

async function renderLocals(options) {
  const testApp = createTestApp(options);
  await request(testApp.app).get('/').expect(200);
  return testApp.getCaptured().locals;
}

describe('dashboard route wiring', () => {
  it('requests the Dashboard model without retired section defaults and preserves the New Project form', async () => {
    const {
      app,
      getCaptured,
      pageDefaultsService,
      tagService,
      workflowQueryService,
    } = createTestApp();

    await request(app).get('/').expect(200);

    const { view, locals } = getCaptured();
    expect(view).toBe('index.njk');
    expect(workflowQueryService.getDashboardData).toHaveBeenCalledOnce();
    expect(workflowQueryService.getDashboardData).toHaveBeenCalledWith();
    expect(pageDefaultsService.getSavedDefault).toHaveBeenCalledWith('new_project', 'status');
    expect(pageDefaultsService.getSavedDefault).toHaveBeenCalledWith('new_project', 'projectType');
    expect(tagService.listTags).toHaveBeenCalledOnce();
    expect(locals).toMatchObject({
      appName: 'Test App',
      nsfwFilterEnabled: false,
      projectCreateDialogOpen: false,
    });
    for (const retired of ['dashboardSections', 'dashboardDefaults', 'dashboardSectionRegistry', 'summary', 'recentlyUpdated']) {
      expect(locals).not.toHaveProperty(retired);
    }
    expect(locals.projectCreateForm).toMatchObject({
      values: { status: 'tbd' },
      tags: [],
      selectedTagIds: [],
    });
    expect(locals.dashboard).toMatchObject({ today: '2026-10-12', todayLabel: 'Monday, October 12, 2026' });
  });

  it('declares the New Project form services at router composition time', () => {
    const workflowQueryService = { getDashboardData: vi.fn() };
    const pageDefaultsService = { resolve: vi.fn() };
    const tagService = { listTags: vi.fn() };

    expect(() => createIndexRouter({ appName: 'Test App', workflowQueryService, tagService }))
      .toThrow('createIndexRouter requires a pageDefaultsService dependency.');
    expect(() => createIndexRouter({ appName: 'Test App', workflowQueryService, pageDefaultsService }))
      .toThrow('createIndexRouter requires a tagService dependency.');
  });

  it('does not depend on the retired Dashboard defaults service', async () => {
    const { app } = createTestApp();
    expect(app.locals.dashboardDefaultsService).toBeUndefined();
    await request(app).get('/').expect(200);
  });

  it('returns a 500 when the NSFW filter service is missing', async () => {
    const { app } = createTestApp({ withNsfwService: false });
    await request(app).get('/').expect(500);
  });
});

describe('dashboard attention tile presentation', () => {
  it('describes zero-value tiles', async () => {
    const { tiles } = (await renderLocals()).dashboard;

    expect(tiles.overdue).toMatchObject({ count: 0, context: 'Nothing overdue', href: '/releases?schedule=overdue' });
    expect(tiles.needsDate).toMatchObject({ count: 0, context: 'All releases have dates', href: '#needs-date' });
    expect(tiles.dueToday).toMatchObject({ count: 0, context: 'Nothing today', firstRelease: null });
    expect(tiles.next7Days).toMatchObject({ count: 0, context: 'Through Mon, Oct 19' });
    expect(tiles.missingAssets).toMatchObject({ count: 0, context: 'No missing files', href: '/asset-viewer?presence=missing' });
  });

  it('carries counts and secondary context from the service model', async () => {
    const dashboard = buildDashboard();
    dashboard.tiles = {
      overdue: { count: 2, href: '/releases?schedule=overdue' },
      needsDate: { count: 14, oldestAgeDays: 23, href: '#needs-date' },
      dueToday: {
        count: 1,
        firstRelease: buildRelease({ title: 'Evening drop', planned_date: '2026-10-12', planned_time: '18:00' }),
        href: '/releases?schedule=today',
      },
      next7Days: { count: 5, throughDate: '2026-10-19', href: '/releases?schedule=upcoming' },
      missingAssets: { count: 7, affectedReleaseCount: 1, href: '/asset-viewer?presence=missing' },
    };

    const { tiles } = (await renderLocals({ dashboard })).dashboard;

    expect(tiles.overdue).toMatchObject({ count: 2, context: 'Unpublished, date passed' });
    expect(tiles.needsDate).toMatchObject({ count: 14, context: 'Oldest waiting 23 days' });
    expect(tiles.dueToday).toMatchObject({
      count: 1,
      context: null,
      firstRelease: {
        id: 1,
        title: 'Evening drop',
        plannedTime: '18:00',
        infoCard: { id: 1, title: 'Evening drop', planned_date: '2026-10-12', planned_time: '18:00', editUrl: '/releases/1/edit' },
      },
    });
    expect(tiles.next7Days).toMatchObject({ count: 5, context: 'Through Mon, Oct 19' });
    expect(tiles.missingAssets).toMatchObject({ count: 7, context: '1 release affected' });
  });

  it('presents the Due today release card from the shown release with NSFW blur', async () => {
    const dashboard = buildDashboard();
    dashboard.tiles.dueToday = {
      count: 2,
      firstRelease: buildRelease({
        id: 42, title: 'Shown first', planned_date: '2026-10-12', primaryImage: AVAILABLE_IMAGE, tags: NSFW_TAGS,
      }),
      href: '/releases?schedule=today',
    };

    const enabled = (await renderLocals({ dashboard, nsfwEnabled: true })).dashboard.tiles.dueToday;
    expect(enabled.firstRelease).toMatchObject({ id: 42, title: 'Shown first', plannedTime: null });
    expect(enabled.firstRelease.infoCard).toMatchObject({
      id: 42, title: 'Shown first', primaryImage: AVAILABLE_IMAGE, nsfwBlur: true, status: 'planned',
    });

    const disabled = (await renderLocals({ dashboard, nsfwEnabled: false })).dashboard.tiles.dueToday;
    expect(disabled.firstRelease.infoCard.nsfwBlur).toBe(false);
  });
});

describe('dashboard strip and quick-pick presentation', () => {
  it('labels all fourteen days accessibly and presents open-day quick picks', async () => {
    const dashboard = buildDashboard();
    dashboard.strip.days[0].isOpen = false;
    dashboard.strip.days[0].counts = { overdue: 0, scheduled: 1, published: 0 };
    dashboard.strip.days[2].isOpen = false;
    dashboard.strip.days[2].counts = { overdue: 1, scheduled: 0, published: 2 };

    const { strip, quickPicks } = (await renderLocals({ dashboard })).dashboard;

    expect(strip.days).toHaveLength(14);
    expect(strip.days[0]).toMatchObject({
      weekdayLabel: 'Mon',
      dayNumber: 12,
      isToday: true,
      accessibleLabel: 'October 12, today, 1 scheduled',
      calendarHref: '/calendar?month=2026-10',
    });
    expect(strip.days[1].accessibleLabel).toBe('October 13, open day');
    expect(strip.days[2].accessibleLabel).toBe('October 14, 1 overdue, 2 published');
    expect(quickPicks).toEqual([
      { date: '2026-10-13', inStrip: true, label: 'Tue 13', accessibleDate: 'Tuesday, October 13, 2026' },
      { date: '2026-10-14', inStrip: true, label: 'Wed 14', accessibleDate: 'Wednesday, October 14, 2026' },
      { date: '2026-10-27', inStrip: false, label: 'Tue 27', accessibleDate: 'Tuesday, October 27, 2026' },
    ]);
  });
});

describe('dashboard release presentation', () => {
  it('classifies needs-date age and readiness without inventing social states', async () => {
    const items = [
      buildRelease({ id: 1, ageDays: 0 }),
      buildRelease({ id: 2, ageDays: 6 }),
      buildRelease({ id: 3, ageDays: 7, selected_asset_count: 0 }),
      buildRelease({ id: 4, ageDays: 20, missing_asset_count: 3 }),
      buildRelease({ id: 5, ageDays: 21 }),
    ];
    const dashboard = buildDashboard({
      needsDate: { total: 12, items, viewAllHref: '/releases?schedule=unscheduled' },
    });

    const { needsDate } = (await renderLocals({ dashboard })).dashboard;

    expect(needsDate.total).toBe(12);
    expect(needsDate.viewAllHref).toBe('/releases?schedule=unscheduled');
    expect(needsDate.items.map(({ ageTone, ageLabel }) => [ageTone, ageLabel])).toEqual([
      ['neutral', 'No date · added today'],
      ['neutral', 'No date · 6 days'],
      ['warning', 'No date · 7 days'],
      ['warning', 'No date · 20 days'],
      ['danger', 'No date · 21 days'],
    ]);
    expect(needsDate.items.map(({ assetReadiness }) => assetReadiness)).toEqual([
      { tone: 'ok', label: 'Assets selected' },
      { tone: 'ok', label: 'Assets selected' },
      { tone: 'danger', label: 'No assets selected' },
      { tone: 'danger', label: '3 missing' },
      { tone: 'ok', label: 'Assets selected' },
    ]);
    expect(needsDate.items[0].socialPreparation).toBe(items[0].socialPreparation);
    expect(needsDate.items[0].thumbnail).toMatchObject({ available: false, initials: 'MG' });
  });

  it('chooses Publish for overdue and today rows and keeps true group totals', async () => {
    const dashboard = buildDashboard({
      scheduled: {
        groups: [
          {
            id: 'overdue', label: 'Overdue', total: 1, viewAllHref: '/releases?schedule=overdue',
            items: [buildRelease({ id: 7, planned_date: '2026-10-08', daysLate: 4 })],
          },
          {
            id: 'today', label: 'Today', total: 1, viewAllHref: '/releases?schedule=today',
            items: [buildRelease({ id: 8, planned_date: '2026-10-12', planned_time: '18:00' })],
          },
          {
            id: 'later', label: 'Later', total: 9, viewAllHref: '/releases?schedule=upcoming',
            items: [buildRelease({ id: 9, planned_date: '2027-01-04' })],
          },
        ],
      },
    });

    const { scheduled } = (await renderLocals({ dashboard })).dashboard;
    const [overdue, today, later] = scheduled.groups;

    expect(overdue.viewAllHref).toBeNull();
    expect(overdue.items[0]).toMatchObject({
      daysLate: 4,
      dateBlock: { month: 'Oct', day: 8 },
      action: { kind: 'publish', label: 'Publish', href: '/releases/7/publish' },
    });
    expect(today.items[0].action).toEqual({ kind: 'publish', label: 'Publish', href: '/releases/8/publish' });
    expect(later).toMatchObject({ total: 9, viewAllHref: '/releases?schedule=upcoming' });
    expect(later.items[0]).toMatchObject({
      dateLabel: 'January 4, 2027',
      action: { kind: 'open', label: 'Open', href: '/releases/9' },
    });
  });

  it('applies NSFW blur to every release and project thumbnail only while the filter is enabled', async () => {
    const dashboard = buildDashboard({
      needsDate: { total: 1, items: [buildRelease({ id: 1, primaryImage: AVAILABLE_IMAGE, tags: NSFW_TAGS })], viewAllHref: null },
      scheduled: {
        groups: [{
          id: 'next7', label: 'Next 7 days', total: 1, viewAllHref: '/releases?schedule=upcoming',
          items: [buildRelease({ id: 2, planned_date: '2026-10-14', tags: [{ display_name: 'nsfw' }] })],
        }],
      },
      recentlyPublished: { items: [buildRelease({ id: 3, published_date: '2026-10-10', tags: NSFW_TAGS })] },
      projectTable: {
        total: 2, shown: 2, complete: true, statusCounts: { ready: 2 },
        rows: [
          buildProjectRow({ id: 10, primaryImage: AVAILABLE_IMAGE, tags: NSFW_TAGS }),
          buildProjectRow({ id: 11, title: 'Safe' }),
        ],
      },
    });

    const enabled = (await renderLocals({ dashboard, nsfwEnabled: true })).dashboard;
    expect(enabled.needsDate.items[0].thumbnail).toMatchObject({ available: true, url: '/thumb.webp', nsfwBlur: true });
    expect(enabled.scheduled.groups[0].items[0].thumbnail.nsfwBlur).toBe(true);
    expect(enabled.recentlyPublished[0].thumbnail.nsfwBlur).toBe(true);
    expect(enabled.projectTable.rows.map(({ thumbnail }) => thumbnail.nsfwBlur)).toEqual([true, false]);
    expect(enabled.needsDate.items[0].infoCard).toMatchObject({ nsfwBlur: true, status: 'planned', editUrl: '/releases/1/edit' });
    expect(enabled.needsDate.items[0].project).toMatchObject({ id: 10, nsfwBlur: true });
    expect(enabled.recentlyPublished[0].infoCard).toMatchObject({ nsfwBlur: true, status: 'published', editUrl: null });

    const disabled = (await renderLocals({ dashboard, nsfwEnabled: false })).dashboard;
    expect(disabled.needsDate.items[0].thumbnail.nsfwBlur).toBe(false);
    expect(disabled.projectTable.rows[0].thumbnail.nsfwBlur).toBe(false);
    expect(disabled.needsDate.items[0].infoCard.nsfwBlur).toBe(false);
    expect(disabled.needsDate.items[0].project.nsfwBlur).toBe(false);
  });
});

describe('dashboard project table presentation', () => {
  it('builds catalogue-ordered non-archived status tabs including zero counts', async () => {
    const dashboard = buildDashboard({
      projectTable: {
        total: 60,
        shown: 50,
        complete: false,
        statusCounts: { ready: 58, 'editorial-review': 2 },
        rows: [buildProjectRow()],
      },
    });

    const { projectTable } = (await renderLocals({ dashboard })).dashboard;

    expect(projectTable).toMatchObject({ complete: false, total: 60, shown: 50 });
    expect(projectTable.tabs.map(({ value, label, count, href }) => ({ value, label, count, href }))).toEqual([
      { value: 'all', label: 'All', count: 60, href: '/projects?status=all' },
      { value: 'tbd', label: 'Tbd', count: 0, href: '/projects?status=tbd' },
      { value: 'planned', label: 'Planned', count: 0, href: '/projects?status=planned' },
      { value: 'editorial-review', label: 'Editorial Review', count: 2, href: '/projects?status=editorial-review' },
      { value: 'ready', label: 'Ready', count: 58, href: '/projects?status=ready' },
    ]);
    expect(projectTable.tabs[3].option).toMatchObject({ color: '#123456', foregroundColor: '#8495A7' });
  });

  it('presents status/type options and every Next release state', async () => {
    const next = (state, extra = {}) => ({
      state, releaseId: null, title: null, plannedDate: null, plannedTime: null, daysLate: null, undatedCount: 0, ...extra,
    });
    const dashboard = buildDashboard({
      projectTable: {
        total: 5, shown: 5, complete: true, statusCounts: { ready: 5 },
        rows: [
          buildProjectRow({ id: 1, nextRelease: next('overdue', { releaseId: 21, title: 'Late', plannedDate: '2026-10-08', undatedCount: 2 }) }),
          buildProjectRow({ id: 2, nextRelease: next('today', { releaseId: 22, title: 'Now', plannedDate: '2026-10-12', plannedTime: '18:00' }) }),
          buildProjectRow({ id: 3, nextRelease: next('scheduled', { releaseId: 23, title: 'Soon', plannedDate: '2026-10-24' }) }),
          buildProjectRow({ id: 4, nextRelease: next('undated', { undatedCount: 1 }) }),
          buildProjectRow({ id: 5, lastPublishedDate: '2026-09-30' }),
        ],
      },
    });

    const { rows } = (await renderLocals({ dashboard })).dashboard.projectTable;

    expect(rows[0]).toMatchObject({
      projectStatusOption: { value: 'ready', label: 'Ready' },
      projectTypeOption: { value: 'images', label: 'Images' },
      updatedLabel: 'Oct 11',
    });
    expect(rows.map(({ nextReleasePresentation: { state, label, extraUndatedLabel } }) => [state, label, extraUndatedLabel])).toEqual([
      ['overdue', 'Overdue · Oct 8', '(+2 no date)'],
      ['today', 'Today', ''],
      ['scheduled', 'Oct 24', ''],
      ['undated', 'No date set', ''],
      ['none', 'None planned', ''],
    ]);
    expect(rows[1].nextReleasePresentation.plannedTime).toBe('18:00');
    expect(rows[4].lastPublishedLabel).toBe('Sep 30');
  });
});
