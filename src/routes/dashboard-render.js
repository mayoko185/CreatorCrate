import { NSFW_TAG_NAME } from '../services/nsfw-filter-settings-service.js';
import { buildAssetLibraryUrl } from './asset-library-query.js';
import { buildNewProjectFormModel } from './project-create-form.js';
import {
  buildProjectOptionPresentation,
  presentProjectOptions,
} from '../services/project-option-presenter.js';

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
    const effectivePageDefaultsService = pageDefaultsService || req.app?.locals?.pageDefaultsService;
    if (!effectivePageDefaultsService) {
      throw new Error('Dashboard requires a pageDefaultsService.');
    }
    const dashboardConfiguration = getDashboardDefaultsService(req).getConfiguration();
    const dashboardDefaults = dashboardConfiguration.defaults;
    const dashboardSectionRegistry = dashboardConfiguration.sectionRegistry;
    const dashboard = workflowQueryService.getDashboardData({
      dashboardDefaults,
      dashboardSectionRegistry,
    });
    const nsfwFilterEnabled = getNsfwFilterSettingsService(req).isEnabled();
    const optionPresentation = buildProjectOptionPresentation({
      status: effectivePageDefaultsService.getOptionCatalogue('new_project', 'status'),
      projectType: effectivePageDefaultsService.getOptionCatalogue('projects', 'projectType')
        .filter(({ value }) => value !== 'all'),
    });
    const blurProjects = (projects) => projects.map(
      (project) => presentProjectOptions(
        withNsfwBlur(project, project.tags, nsfwFilterEnabled),
        optionPresentation,
      )
    );
    const sectionMetadataById = new Map(
      dashboardSectionRegistry.map((section) => [section.id, section])
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
      recentlyUpdated: sectionProjectsById['recently-updated'] || [],
      dashboardSections,
      dashboardDefaults,
      dashboardSectionRegistry,
      dashboardDefaultsDialogOpen,
      dashboardDefaultsFormState,
      projectCreateDialogOpen: Boolean(projectCreateDialogOpen),
      projectCreateForm: projectCreateForm || buildNewProjectFormModel({
        tagService,
        pageDefaultsService: effectivePageDefaultsService,
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
