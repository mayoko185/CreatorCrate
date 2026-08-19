import { NSFW_TAG_NAME } from '../services/nsfw-filter-settings-service.js';
import { DASHBOARD_SECTION_REGISTRY } from '../services/dashboard-defaults-service.js';
import { buildAssetLibraryUrl } from './asset-library-query.js';
import { buildNewProjectFormModel } from './project-create-form.js';

const NSFW_TAG_NORMALIZED_NAME = NSFW_TAG_NAME.toLowerCase();

function getNsfwFilterSettingsService(req) {
  const service = req.app?.locals?.nsfwFilterSettingsService;
  if (!service) {
    throw new Error('Dashboard requires app.locals.nsfwFilterSettingsService.');
  }
  return service;
}

function getDashboardDefaultsService(req) {
  const service = req.app?.locals?.dashboardDefaultsService;
  if (!service) {
    throw new Error('Dashboard requires app.locals.dashboardDefaultsService.');
  }
  return service;
}

function isNsfwTag(tag) {
  return [tag?.displayName, tag?.display_name, tag?.normalizedName, tag?.normalized_name].some((value) => (
    typeof value === 'string' && value.trim().toLowerCase() === NSFW_TAG_NORMALIZED_NAME
  ));
}

function withNsfwBlur(project, tags, filterEnabled) {
  return {
    ...project,
    nsfwBlur: Boolean(filterEnabled && Array.isArray(tags) && tags.some(isNsfwTag)),
  };
}

export function renderDashboardPage(req, res, next, {
  appName,
  workflowQueryService,
  pageDefaultsService,
  tagService,
  status = 200,
  dashboardDefaultsDialogOpen = req.query.defaults === '1',
  dashboardDefaultsFormState = {},
  projectCreateDialogOpen = false,
  projectCreateForm,
} = {}) {
  try {
    const dashboardDefaults = getDashboardDefaultsService(req).getDefaults();
    const dashboard = workflowQueryService.getDashboardData({ dashboardDefaults });
    const nsfwFilterEnabled = getNsfwFilterSettingsService(req).isEnabled();
    const blurProjects = (projects) => projects.map(
      (project) => withNsfwBlur(project, project.tags, nsfwFilterEnabled)
    );
    const sectionMetadataById = new Map(
      DASHBOARD_SECTION_REGISTRY.map((section) => [section.id, section])
    );
    const dashboardSections = dashboardDefaults.order.flatMap((sectionId) => {
      const sectionDefaults = dashboardDefaults.sections[sectionId];
      if (!sectionDefaults.visible) return [];

      const section = sectionMetadataById.get(sectionId);
      return [{
        id: section.id,
        label: section.label,
        visible: true,
        itemCount: sectionDefaults.itemCount,
        projects: blurProjects(dashboard.sections[sectionId]),
      }];
    });
    const sectionProjectsById = Object.fromEntries(
      dashboardSections.map(({ id, projects }) => [id, projects])
    );

    res.status(status).render('index.njk', {
      appName,
      overdue: sectionProjectsById.overdue || [],
      upcoming: sectionProjectsById.upcoming || [],
      recentlyUpdated: sectionProjectsById['recently-updated'] || [],
      dashboardSections,
      dashboardDefaults,
      dashboardSectionRegistry: DASHBOARD_SECTION_REGISTRY,
      dashboardDefaultsDialogOpen,
      dashboardDefaultsFormState,
      projectCreateDialogOpen: Boolean(projectCreateDialogOpen),
      projectCreateForm: projectCreateForm || buildNewProjectFormModel({
        tagService,
        pageDefaultsService,
      }),
      summary: dashboard.workflowSummary,
      nsfwFilterEnabled,
      assetsUrl: buildAssetLibraryUrl(),
      missingAssetsUrl: buildAssetLibraryUrl({}, { presence: 'missing' }),
    });
  } catch (err) {
    next(err);
  }
}
