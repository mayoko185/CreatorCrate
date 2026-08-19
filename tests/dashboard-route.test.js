/**
 * Route-level tests for the Dashboard route view-model composition.
 * The services are stubbed and res.render is intercepted, so these tests
 * deliberately do not depend on the staged index.njk template.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createIndexRouter } from '../src/routes/index.js';
import { DASHBOARD_SECTION_REGISTRY } from '../src/services/dashboard-defaults-service.js';

const SECTION_IDS = DASHBOARD_SECTION_REGISTRY.map(({ id }) => id);

function buildProject(overrides = {}) {
  return { id: 1, title: 'Project', tags: [], ...overrides };
}

function buildDefaults({ order = SECTION_IDS, sections = {} } = {}) {
  return {
    version: 1,
    order,
    sections: Object.fromEntries(SECTION_IDS.map((id) => [
      id,
      { visible: true, itemCount: 8, ...sections[id] },
    ])),
  };
}

function emptyDashboard(sections = {}) {
  return {
    sections: Object.fromEntries(SECTION_IDS.map((id) => [id, sections[id] || []])),
    workflowSummary: {
      totalProjects: 0,
      totalAssets: 0,
      totalReleases: 0,
      missingAssetSummary: { total: 0 },
    },
    today: '2026-01-01',
  };
}

function createTestApp({
  dashboard = emptyDashboard(),
  dashboardDefaults = buildDefaults(),
  nsfwEnabled = false,
  withNsfwService = true,
  withDashboardDefaultsService = true,
} = {}) {
  const app = express();
  let captured = null;

  if (withNsfwService) {
    app.locals.nsfwFilterSettingsService = { isEnabled: () => nsfwEnabled };
  }
  const dashboardDefaultsService = { getDefaults: vi.fn(() => dashboardDefaults) };
  if (withDashboardDefaultsService) {
    app.locals.dashboardDefaultsService = dashboardDefaultsService;
  }

  app.use((req, res, next) => {
    res.render = (view, locals) => {
      captured = { view, locals };
      res.status(200).json({ ok: true });
    };
    next();
  });

  const workflowQueryService = { getDashboardData: vi.fn(() => dashboard) };
  app.use('/', createIndexRouter({ appName: 'Test App', workflowQueryService }));

  return { app, dashboardDefaultsService, getCaptured: () => captured, workflowQueryService };
}

describe('dashboard route wiring', () => {
  it('resolves normalized defaults once, passes them to the query service, and preserves Dashboard locals', async () => {
    const dashboard = emptyDashboard();
    const dashboardDefaults = buildDefaults();
    const {
      app,
      dashboardDefaultsService,
      getCaptured,
      workflowQueryService,
    } = createTestApp({ dashboard, dashboardDefaults });

    await request(app).get('/').expect(200);

    const { view, locals } = getCaptured();
    expect(view).toBe('index.njk');
    expect(dashboardDefaultsService.getDefaults).toHaveBeenCalledOnce();
    expect(workflowQueryService.getDashboardData).toHaveBeenCalledWith({ dashboardDefaults });
    expect(locals).toMatchObject({
      appName: 'Test App',
      summary: dashboard.workflowSummary,
      nsfwFilterEnabled: false,
      dashboardDefaults,
      dashboardSectionRegistry: DASHBOARD_SECTION_REGISTRY,
      assetsUrl: '/assets',
      missingAssetsUrl: '/assets?presence=missing',
    });
    expect(locals).not.toHaveProperty('projectCounts');
  });

  it('builds ordered visible section view-models with canonical labels and independent counts', async () => {
    const customFirst = ['status:ready', 'overdue', 'status:planned', 'recently-updated'];
    const dashboardDefaults = buildDefaults({
      order: [...customFirst, ...SECTION_IDS.filter((id) => !customFirst.includes(id))],
      sections: {
        'status:ready': { itemCount: 3 },
        overdue: { itemCount: 5 },
        'status:planned': { itemCount: 7 },
        'recently-updated': { itemCount: 9 },
        upcoming: { visible: false },
      },
    });
    const { app, getCaptured } = createTestApp({
      dashboardDefaults,
      dashboard: emptyDashboard({
        'status:ready': [buildProject({ id: 1 })],
        overdue: [buildProject({ id: 2 })],
        'status:planned': [buildProject({ id: 3 })],
        'recently-updated': [buildProject({ id: 4 })],
        upcoming: [buildProject({ id: 5 })],
      }),
    });

    await request(app).get('/').expect(200);

    const { dashboardSections, overdue, recentlyUpdated } = getCaptured().locals;
    expect(dashboardSections.map(({ id }) => id)).toEqual(dashboardDefaults.order.filter(
      (id) => id !== 'upcoming'
    ));
    expect(dashboardSections.slice(0, 4)).toEqual([
      { id: 'status:ready', label: 'Ready', visible: true, itemCount: 3, projects: [expect.objectContaining({ id: 1 })] },
      { id: 'overdue', label: 'Overdue', visible: true, itemCount: 5, projects: [expect.objectContaining({ id: 2 })] },
      { id: 'status:planned', label: 'Planned', visible: true, itemCount: 7, projects: [expect.objectContaining({ id: 3 })] },
      { id: 'recently-updated', label: 'Recently updated projects', visible: true, itemCount: 9, projects: [expect.objectContaining({ id: 4 })] },
    ]);
    expect(dashboardSections).not.toContainEqual(expect.objectContaining({ id: 'upcoming' }));
    expect(overdue).toBe(dashboardSections.find(({ id }) => id === 'overdue').projects);
    expect(recentlyUpdated).toBe(dashboardSections.find(({ id }) => id === 'recently-updated').projects);
  });

  it('uses the canonical static and status labels for visible sections', async () => {
    const { app, getCaptured } = createTestApp();

    await request(app).get('/').expect(200);

    expect(getCaptured().locals.dashboardSections.map(({ id, label }) => ({ id, label }))).toEqual(expect.arrayContaining([
      { id: 'upcoming', label: 'Upcoming releases' },
      { id: 'recently-updated', label: 'Recently updated projects' },
      { id: 'status:tbd', label: 'TBD' },
      { id: 'status:in-progress', label: 'In progress' },
      { id: 'status:archived', label: 'Archived' },
    ]));
  });

  it('applies NSFW presentation state to every visible static and status section only', async () => {
    const dashboardDefaults = buildDefaults({ sections: { 'status:archived': { visible: false } } });
    const dashboard = emptyDashboard({
      overdue: [buildProject({ id: 1, tags: [{ displayName: 'NSFW' }] })],
      'status:ready': [buildProject({ id: 2, tags: [{ display_name: 'nsfw' }] })],
      'status:archived': [buildProject({ id: 3, tags: [{ displayName: 'NSFW' }] })],
    });
    const { app, getCaptured } = createTestApp({ dashboard, dashboardDefaults, nsfwEnabled: true });

    await request(app).get('/').expect(200);

    const { dashboardSections, overdue } = getCaptured().locals;
    expect(overdue[0].nsfwBlur).toBe(true);
    expect(dashboardSections.find(({ id }) => id === 'status:ready').projects[0].nsfwBlur).toBe(true);
    expect(dashboardSections).not.toContainEqual(expect.objectContaining({ id: 'status:archived' }));
  });

  it('does not blur qualifying status-section projects when the filter is disabled', async () => {
    const { app, getCaptured } = createTestApp({
      dashboard: emptyDashboard({
        'status:ready': [buildProject({ tags: [{ displayName: 'NSFW' }] })],
      }),
    });

    await request(app).get('/').expect(200);

    expect(getCaptured().locals.dashboardSections.find(({ id }) => id === 'status:ready').projects[0].nsfwBlur).toBe(false);
  });

  it('returns a 500 when a required Dashboard service is missing', async () => {
    const { app: withoutDefaults } = createTestApp({ withDashboardDefaultsService: false });
    const { app: withoutNsfw } = createTestApp({ withNsfwService: false });

    await request(withoutDefaults).get('/').expect(500);
    await request(withoutNsfw).get('/').expect(500);
  });
});
