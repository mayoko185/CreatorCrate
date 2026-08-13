import express from 'express';
import {
  ProjectNotFoundError,
  ProjectValidationError,
  STATUSES,
  WORKFLOW_STATUSES,
} from '../services/project-service.js';
import {
  ProjectNotFoundError as ProjectTagProjectNotFoundError,
  ProjectTagValidationError,
  TagNotFoundError as ProjectTagTagNotFoundError,
} from '../services/project-tag-service.js';
import { NSFW_TAG_NAME } from '../services/nsfw-filter-settings-service.js';
import {
  PageDefaultValidationError,
  PAGE_DEFAULT_DEFINITIONS,
} from '../services/page-defaults-service.js';
import {
  AssetCategoryValidationError,
  parseEnabledField,
} from '../services/asset-category-validation.js';
import { buildOpenLocallyUri } from '../util/open-locally.js';

const SORT_OPTIONS = ['updated', 'created', 'title', 'published'];
const VIEW_OPTIONS = ['grid', 'list'];
const PAGE_SIZE = 25;
const NSFW_TAG_NORMALIZED_NAME = NSFW_TAG_NAME.toLowerCase();
const NOTICES = {
  project_tags_updated: { variant: 'success', text: 'Project tags updated successfully.' },
  projects_defaults_saved: { variant: 'success', text: 'Projects defaults saved successfully.' },
};

const PROJECTS_DEFAULT_LABELS = Object.freeze({
  view: Object.freeze({ grid: 'Grid', list: 'List' }),
  sort: Object.freeze({
    updated: 'Recently updated',
    created: 'Recently created',
    title: 'Title',
    published: 'Published',
  }),
  order: Object.freeze({ asc: 'Ascending', desc: 'Descending' }),
});

function resolveNotice(code) {
  return Object.prototype.hasOwnProperty.call(NOTICES, code) ? NOTICES[code] : null;
}

export function createProjectsRouter({ appName, db, projectService, workflowQueryService }) {
  const router = express.Router();

  router.get('/', (req, res, next) => {
    try {
      renderProjectsPage(req, res, {
        appName,
        projectService,
        workflowQueryService,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/defaults', (req, res, next) => {
    const service = getPageDefaultsService(req);
    const submittedValues = readProjectsDefaults(req.body);
    const enhanced = isEnhancedProjectsDefaultsRequest(req);
    let validatedValues;

    try {
      validatedValues = service.validatePageDefaults('projects', submittedValues);
    } catch (err) {
      if (!(err instanceof PageDefaultValidationError)) return next(err);

      if (enhanced) {
        res.status(422).json({
          status: 'error',
          errors: err.errors || {},
          values: submittedValues,
        });
        return;
      }

      renderProjectsPage(req, res, {
        appName,
        projectService,
        workflowQueryService,
        status: 422,
        projectsDefaultsDialogOpen: true,
        projectsDefaultsSubmittedValues: submittedValues,
        projectsDefaultsErrors: err.errors || {},
        allowSavedDefaultsRedirect: false,
        notice: null,
      });
      return;
    }

    try {
      const save = () => {
        for (const option of Object.keys(PAGE_DEFAULT_DEFINITIONS.projects)) {
          service.saveDefault('projects', option, validatedValues[option]);
        }
      };
      if (typeof db?.transaction === 'function') db.transaction(save)();
      else save();
    } catch (err) {
      if (enhanced) {
        res.status(500).json({
          status: 'error',
          message: 'Projects defaults could not be saved. No changes were made.',
        });
        return;
      }
      next(err);
      return;
    }

    if (enhanced) {
      res.json({
        status: 'success',
        message: 'Projects defaults saved successfully.',
        values: validatedValues,
      });
      return;
    }

    const params = new URLSearchParams({
      view: validatedValues.view,
      sort: validatedValues.sort,
      order: validatedValues.order,
      notice: 'projects_defaults_saved',
    });
    res.redirect(`/projects?${params.toString()}`);
  });

  router.post('/nsfw-filter', (req, res, next) => {
    const enhanced = isEnhancedProjectsNsfwRequest(req);
    let enabled;

    try {
      enabled = parseEnabledField(req.body?.enabled, { fieldLabel: 'enabled' });
    } catch (err) {
      if (!(err instanceof AssetCategoryValidationError)) return next(err);

      if (enhanced) {
        res.status(422).json({
          status: 'error',
          errors: err.errors || {},
          message: 'NSFW filter setting is invalid.',
        });
        return;
      }

      renderProjectsPage(req, res, {
        appName,
        projectService,
        workflowQueryService,
        status: 422,
        notice: { variant: 'error', text: 'NSFW filter setting is invalid.' },
        allowSavedDefaultsRedirect: false,
      });
      return;
    }

    try {
      getNsfwFilterSettingsService(req).setEnabled(enabled);
    } catch (err) {
      if (enhanced) {
        res.status(500).json({
          status: 'error',
          message: 'NSFW filter could not be updated. The previous setting was kept.',
        });
        return;
      }
      return next(err);
    }

    if (enhanced) {
      res.json({
        status: 'success',
        enabled,
        message: `NSFW filter ${enabled ? 'enabled' : 'disabled'}.`,
      });
      return;
    }

    res.redirect(readProjectsNsfwReturnUrl(req));
  });

  router.get('/new', (req, res, next) => {
    try {
      const { tags, selectedTagIds } = buildTagFormModel(req);
      res.render('projects/form.njk', {
        appName,
        project: null,
        values: createNewProjectFormValues(req.query || {}, getPageDefaultsService(req)),
        errors: {},
        statuses: WORKFLOW_STATUSES,
        action: 'Create',
        submitUrl: '/projects',
        tags,
        selectedTagIds,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', (req, res, next) => {
    const parsedTags = parseProjectFormTagIds(req.body?.tagIds);

    try {
      validateSubmittedTagsExist(req, parsedTags);
      const input = parseProjectInput(req.body);
      const project = projectService.create(input);
      persistProjectTags(req, project.id, parsedTags);
      res.redirect(`/projects/${project.id}`);
    } catch (err) {
      if (err instanceof ProjectValidationError) {
        res.status(422).render('projects/form.njk', {
          appName,
          project: null,
          values: createFormValues(req.body),
          errors: err.errors,
          statuses: WORKFLOW_STATUSES,
          action: 'Create',
          submitUrl: '/projects',
          tags: loadAvailableTags(req),
          selectedTagIds: buildSubmittedSelectedTagIds(parsedTags),
        });
        return;
      }
      // Filesystem or other error: render form with safe message + preserved values
      res.status(500).render('projects/form.njk', {
        appName,
        project: null,
        values: createFormValues(req.body),
        errors: { general: 'Project creation failed. Please try again.' },
        statuses: WORKFLOW_STATUSES,
        action: 'Create',
        submitUrl: '/projects',
        tags: loadAvailableTags(req),
        selectedTagIds: buildSubmittedSelectedTagIds(parsedTags),
      });
    }
  });

  router.get('/:id', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    const workspace = workflowQueryService.getProjectWorkspace(id);
    if (!workspace) {
      return next(createNotFound());
    }

    const assignedProjectTags = getProjectTagService(req).listProjectTags(id);
    const nsfwFilterEnabled = getNsfwFilterSettingsService(req).isEnabled();
    const projectTags = assignedProjectTags
      .map((tag) => ({ displayName: tag.display_name }));

    res.render('projects/detail.njk', {
      appName,
      project: withNsfwBlur(workspace.project, assignedProjectTags, nsfwFilterEnabled),
      releaseSummary: workspace.releaseSummary,
      assetHealth: workspace.assetHealth,
      projectTags,
      openLocallyUri: buildOpenLocallyUri({
        windowsRoot: getOpenLocallySettingsService(req).getWindowsProjectsPath(),
        projectDir: workspace.project.project_dir,
      }),
      notice: resolveNotice(req.query.notice),
    });
  });

  router.get('/:id/edit', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    const project = projectService.findById(id);
    if (!project) {
      return next(createNotFound());
    }

    // Archived projects are immutable. The edit form would render but POST
    // would still reject archived_at, so block access to the form itself
    // and route the user back to the detail page (read-only workspace).
    if (project.archived_at) {
      return res.redirect(`/projects/${project.id}`);
    }

    try {
      const { tags, selectedTagIds } = buildTagFormModel(req, project.id);
      res.render('projects/form.njk', {
        appName,
        project,
        values: projectToFormValues(project),
        errors: {},
        statuses: WORKFLOW_STATUSES,
        action: 'Edit',
        submitUrl: `/projects/${project.id}`,
        tags,
        selectedTagIds,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    const parsedTags = parseProjectFormTagIds(req.body?.tagIds);

    try {
      validateSubmittedTagsExist(req, parsedTags);
      const input = parseProjectInput(req.body);
      const project = projectService.update(id, input);
      if (!project) {
        return next(createNotFound());
      }
      persistProjectTags(req, project.id, parsedTags);
      res.redirect(`/projects/${project.id}`);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        return next(createNotFound());
      }
      if (err instanceof ProjectValidationError) {
        const existing = projectService.findById(id);
        res.status(422).render('projects/form.njk', {
          appName,
          project: existing || { id },
          values: createFormValues(req.body),
          errors: err.errors,
          statuses: WORKFLOW_STATUSES,
          action: 'Edit',
          submitUrl: `/projects/${id}`,
          tags: loadAvailableTags(req),
          selectedTagIds: buildSubmittedSelectedTagIds(parsedTags),
        });
        return;
      }
      // Filesystem or other error: render form with safe message + preserved values
      const existing = projectService.findById(id);
      res.status(500).render('projects/form.njk', {
        appName,
        project: existing || { id },
        values: createFormValues(req.body),
        errors: { general: 'Project update failed. Please try again.' },
        statuses: WORKFLOW_STATUSES,
        action: 'Edit',
        submitUrl: `/projects/${id}`,
        tags: loadAvailableTags(req),
        selectedTagIds: buildSubmittedSelectedTagIds(parsedTags),
      });
    }
  });

  router.post('/:id/archive', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    try {
      const project = projectService.archive(id);
      if (!project) {
        return next(createNotFound());
      }
      res.redirect('/projects');
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        return next(createNotFound());
      }
      next(err);
    }
  });

  return router;
}

function getPageDefaultsService(req) {
  const service = req.app?.locals?.pageDefaultsService;
  if (!service) {
    throw new Error('Projects list requires app.locals.pageDefaultsService.');
  }
  return service;
}

function renderProjectsPage(req, res, {
  appName,
  projectService,
  workflowQueryService,
  status = 200,
  notice = resolveNotice(req.query.notice),
  projectsDefaultsDialogOpen = req.query.defaults === '1',
  projectsDefaultsSubmittedValues = null,
  projectsDefaultsErrors = {},
  allowSavedDefaultsRedirect = req.query.defaults !== '1',
} = {}) {
  const pageDefaultsService = getPageDefaultsService(req);
  const availableTagOptions = getProjectTagFilterOptions(workflowQueryService);
  const parsedQuery = parseListQuery(req.query, pageDefaultsService, availableTagOptions);
  const tagOptions = availableTagOptions.map((option) => ({
    ...option,
    selected: parsedQuery.tagIds.includes(Number(option.value)),
  }));
  const { total } = projectService.list({ ...parsedQuery, limit: 0 });
  const { total: totalProjects } = projectService.list({ includeArchived: true, limit: 0 });
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(parsedQuery.page, pageCount);
  if (allowSavedDefaultsRedirect && shouldRedirectToSavedDefaults(req.query, parsedQuery, pageDefaultsService)) {
    return res.redirect(buildSavedDefaultsUrl(req, parsedQuery, currentPage, pageDefaultsService));
  }

  const offset = (currentPage - 1) * PAGE_SIZE;
  const nsfwFilterEnabled = getNsfwFilterSettingsService(req).isEnabled();
  const { rows } = workflowQueryService.getProjectList({ ...parsedQuery, offset, limit: PAGE_SIZE });
  const pageUrl = buildPageUrl(req, parsedQuery, currentPage, pageDefaultsService);
  const filtersActive = Boolean(
    parsedQuery.search || parsedQuery.statuses.length > 0 || parsedQuery.tagIds.length > 0 || parsedQuery.projectId != null,
  );
  const projectOptions = workflowQueryService.getProjectsPageFilterOptions();
  const selectedProject = projectOptions.find((project) => project.id === parsedQuery.projectId) || null;

  return res.status(status).render('projects/index.njk', {
    appName,
    projects: rows.map((project) => withNsfwBlur(project, project.tags, nsfwFilterEnabled)),
    total,
    hasAnyProjects: totalProjects > 0,
    filtersActive,
    resetFiltersUrl: '/projects',
    page: currentPage,
    pageSize: PAGE_SIZE,
    pageCount,
    pageUrl,
    preserveViewQuery: shouldPreserveViewQuery(req.query, parsedQuery, pageDefaultsService),
    query: {
      search: parsedQuery.search,
      statuses: parsedQuery.statuses,
      tagIds: parsedQuery.tagIds.map(String),
      projectId: parsedQuery.projectId,
      sort: parsedQuery.sortBy,
      order: parsedQuery.order,
      view: parsedQuery.view,
    },
    view: parsedQuery.view,
    statuses: STATUSES,
    statusOptions: buildStatusFilterOptions(parsedQuery.statuses),
    sortOptions: SORT_OPTIONS,
    tagOptions,
    projectOptions,
    selectedProject,
    notice,
    nsfwFilterEnabled,
    projectsNsfwReturnUrl: pageUrl({}),
    projectsDefaults: buildProjectsDefaultsModel(pageDefaultsService, {
      submittedValues: projectsDefaultsSubmittedValues,
      errors: projectsDefaultsErrors,
    }),
    projectsDefaultsDialogOpen: Boolean(projectsDefaultsDialogOpen),
  });
}

function readProjectsDefaults(body) {
  const rawBody = body && typeof body === 'object' ? body : {};
  return Object.fromEntries(
    Object.keys(PAGE_DEFAULT_DEFINITIONS.projects).map((option) => [option, rawBody[option]])
  );
}

function isEnhancedProjectsDefaultsRequest(req) {
  return String(req.get?.('Accept') || '').toLowerCase().includes('application/json');
}

function isEnhancedProjectsNsfwRequest(req) {
  return String(req.get?.('Accept') || '').toLowerCase().includes('application/json');
}

function readProjectsNsfwReturnUrl(req) {
  const candidate = typeof req.body?.returnTo === 'string' ? req.body.returnTo : '';
  if (!candidate.startsWith('/projects') || candidate.startsWith('//')) return '/projects';

  try {
    const url = new URL(candidate, 'http://creatorcrate.local');
    if (url.pathname !== '/projects') return '/projects';
    url.hash = '';
    return `${url.pathname}${url.search}`;
  } catch {
    return '/projects';
  }
}

function buildProjectsDefaultsModel(service, { submittedValues = null, errors = {} } = {}) {
  const values = submittedValues || service.resolvePageDefaults('projects');
  const fields = Object.keys(PAGE_DEFAULT_DEFINITIONS.projects).map((option) => {
    const definition = PAGE_DEFAULT_DEFINITIONS.projects[option];
    const value = values?.[option];
    const error = errors[option] || null;
    const showSubmittedValue = Boolean(
      error && typeof value === 'string' && !definition.values.includes(value)
    );

    return {
      id: `projects-default-${option}`,
      name: option,
      label: option === 'view' ? 'View' : option === 'sort' ? 'Sort' : 'Order',
      selectedValue: value,
      options: definition.values.map((candidate) => ({
        value: candidate,
        label: PROJECTS_DEFAULT_LABELS[option][candidate],
      })),
      error,
      showSubmittedValue,
      submittedOptionValue: showSubmittedValue ? value : null,
      submittedDisplayValue: showSubmittedValue ? value : null,
    };
  });

  return { fields };
}

function getOpenLocallySettingsService(req) {
  const service = req.app?.locals?.openLocallySettingsService;
  if (!service) {
    throw new Error('Project detail requires app.locals.openLocallySettingsService.');
  }
  return service;
}

function getNsfwFilterSettingsService(req) {
  const service = req.app?.locals?.nsfwFilterSettingsService;
  if (!service) {
    throw new Error('Projects pages require app.locals.nsfwFilterSettingsService.');
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

function getProjectTagFilterOptions(workflowQueryService) {
  if (!workflowQueryService || typeof workflowQueryService.getProjectTagFilterOptions !== 'function') {
    throw new Error('Projects list requires workflowQueryService.getProjectTagFilterOptions.');
  }
  return workflowQueryService.getProjectTagFilterOptions();
}

function buildStatusFilterOptions(selectedStatuses) {
  return STATUSES.map((value) => ({
    value,
    label: value
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' '),
    selected: selectedStatuses.includes(value),
  }));
}

function getTagService(req) {
  const service = req.app?.locals?.tagService;
  if (!service) {
    throw new Error('Project form requires app.locals.tagService.');
  }
  return service;
}

function getProjectTagService(req) {
  const service = req.app?.locals?.projectTagService;
  if (!service) {
    throw new Error('Project detail requires app.locals.projectTagService.');
  }
  return service;
}

function toTagView(tag) {
  return {
    id: tag.id,
    displayName: tag.display_name,
  };
}

function loadAvailableTags(req) {
  return getTagService(req).listTags().map(toTagView);
}

function loadAssignedTagIds(req, projectId) {
  return getProjectTagService(req)
    .listProjectTags(projectId)
    .map((tag) => String(tag.id));
}

function buildTagFormModel(req, projectId) {
  const tags = loadAvailableTags(req);
  const selectedTagIds = projectId === undefined ? [] : loadAssignedTagIds(req, projectId);
  return { tags, selectedTagIds };
}

function normalizeTagIdField(raw) {
  if (raw === undefined) return { valid: true, ids: [] };
  if (raw === null) return { valid: false, ids: [] };
  if (typeof raw === 'string') {
    return raw === '' ? { valid: true, ids: [] } : { valid: true, ids: [raw] };
  }
  if (Array.isArray(raw)) {
    if (raw.some((value) => typeof value !== 'string' && typeof value !== 'number')) {
      return { valid: false, ids: [] };
    }
    return { valid: true, ids: raw.map(String) };
  }
  if (typeof raw === 'object') {
    const keys = Object.keys(raw);
    if (keys.some((key) => !/^\d+$/.test(key))) return { valid: false, ids: [] };
    const values = Object.values(raw);
    if (values.some((value) => typeof value !== 'string' && typeof value !== 'number')) {
      return { valid: false, ids: [] };
    }
    return { valid: true, ids: values.map(String) };
  }
  return { valid: false, ids: [] };
}

function parseProjectFormTagIds(raw) {
  const normalized = normalizeTagIdField(raw);
  if (!normalized.valid) {
    return {
      valid: false,
      tagIds: [],
      submittedTagIds: [],
      error: 'Tag selections must be submitted as a flat list of tag IDs.',
    };
  }

  const tagIds = [];
  for (const rawId of normalized.ids) {
    if (!/^[1-9]\d*$/.test(rawId)) {
      return {
        valid: false,
        tagIds: [],
        submittedTagIds: normalized.ids,
        error: 'Tag selections must contain canonical positive integer IDs.',
      };
    }
    const tagId = Number(rawId);
    if (!Number.isSafeInteger(tagId) || String(tagId) !== rawId) {
      return {
        valid: false,
        tagIds: [],
        submittedTagIds: normalized.ids,
        error: 'Tag selections must contain safe positive integer IDs.',
      };
    }
    tagIds.push(tagId);
  }

  return {
    valid: true,
    tagIds,
    submittedTagIds: normalized.ids,
    error: null,
  };
}

function buildSubmittedSelectedTagIds(parsedTags) {
  return parsedTags.valid ? parsedTags.submittedTagIds : parsedTags.submittedTagIds;
}

function validateSubmittedTagsExist(req, parsedTags) {
  if (!parsedTags.valid || parsedTags.tagIds.length === 0) {
    return;
  }

  const availableTagIds = new Set(getTagService(req).listTags().map((tag) => tag.id));
  if (!parsedTags.tagIds.every((tagId) => availableTagIds.has(tagId))) {
    throw new ProjectValidationError({
      tagIds: 'One or more selected tags no longer exists. Refresh and try again.',
    });
  }
}

function persistProjectTags(req, projectId, parsedTags) {
  if (!parsedTags.valid) {
    return;
  }

  try {
    getProjectTagService(req).replaceProjectTags(projectId, parsedTags.tagIds);
  } catch (err) {
    if (err instanceof ProjectTagProjectNotFoundError) {
      // The project was just created/updated by projectService, so this should
      // not happen in normal operation. Re-throw as a standard 404 path.
      throw createNotFound();
    }
    if (err instanceof ProjectTagTagNotFoundError) {
      // A selected tag was removed between form render and submission. Treat
      // as a stale-selection error without breaking project creation/update.
      throw new ProjectValidationError({
        tagIds: 'One or more selected tags no longer exists. Refresh and try again.',
      });
    }
    if (err instanceof ProjectTagValidationError) {
      throw new ProjectValidationError(err.errors || {
        tagIds: err.message || 'Tag selection is invalid.',
      });
    }
    throw err;
  }
}

function parseListQuery(raw, pageDefaultsService, tagOptions = []) {
  const rawQuery = raw && typeof raw === 'object' ? raw : {};
  const resolvedPresentation = pageDefaultsService.resolvePageDefaults('projects', rawQuery);
  const statuses = parseStatusFilterValues(rawQuery.status);
  const search = typeof rawQuery.search === 'string' ? rawQuery.search.trim() : '';
  const tagIds = parseTagFilterIds(rawQuery.tag, tagOptions);
  const projectId = parseProjectFilterId(rawQuery.project);
  const sortBy = resolvedPresentation.sort;
  const order = resolvedPresentation.order;
  const view = resolvedPresentation.view;

  let page = Number.parseInt(rawQuery.page, 10);
  if (!Number.isInteger(page) || page < 1) {
    page = 1;
  }

  const includeArchived = statuses.includes('archived');

  return {
    status: statuses.length === 1 ? statuses[0] : undefined,
    statuses,
    search,
    tagId: tagIds.length === 1 ? tagIds[0] : undefined,
    tagIds,
    projectId,
    sortBy,
    order,
    view,
    page,
    includeArchived,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  };
}

function parseStatusFilterValues(value) {
  const values = Array.isArray(value) ? value : [value];
  const selected = new Set(values.filter((candidate) => typeof candidate === 'string'));
  return STATUSES.filter((status) => selected.has(status));
}

function parseTagFilterIds(value, tagOptions) {
  const validValues = new Set(
    (Array.isArray(tagOptions) ? tagOptions : []).map((option) => String(option.value))
  );
  const values = Array.isArray(value) ? value : [value];
  const selected = values.reduce((ids, candidate) => {
    if (typeof candidate !== 'string' || !/^[1-9]\d*$/.test(candidate)) return ids;

    const id = Number(candidate);
    if (Number.isSafeInteger(id) && validValues.has(candidate)) ids.add(id);
    return ids;
  }, new Set());

  return [...selected].sort((left, right) => left - right);
}

function parseProjectFilterId(value) {
  if (value === undefined || value === null || value === '') return null;

  const candidate = String(value).trim();
  if (!/^[1-9]\d*$/.test(candidate)) return null;

  const id = Number(candidate);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function hasPresentationQuery(raw) {
  const rawQuery = raw && typeof raw === 'object' ? raw : {};
  return ['view', 'sort', 'order'].some((option) => Object.hasOwn(rawQuery, option));
}

function shouldRedirectToSavedDefaults(raw, parsedQuery, pageDefaultsService) {
  if (hasPresentationQuery(raw)) return false;

  return parsedQuery.view !== pageDefaultsService.getFallback('projects', 'view')
    || parsedQuery.sortBy !== pageDefaultsService.getFallback('projects', 'sort')
    || parsedQuery.order !== pageDefaultsService.getFallback('projects', 'order');
}

function buildSavedDefaultsUrl(req, parsedQuery, currentPage, pageDefaultsService) {
  return buildPageUrlString(req, buildCanonicalPageQuery(req, parsedQuery, currentPage, pageDefaultsService));
}

function parseProjectInput(body) {
  return {
    title: body.title,
    description: body.description,
    notes: body.notes,
    status: body.status,
    plannedDate: body.plannedDate || null,
    publishedDate: body.publishedDate || null,
    patreonUrl: body.patreonUrl || null,
  };
}

function createFormValues(values) {
  const formValues = { ...values };
  delete formValues.priority;
  return formValues;
}

function createNewProjectFormValues(query, pageDefaultsService) {
  return {
    ...createFormValues(query),
    status: pageDefaultsService.resolve('new_project', 'status', query.status),
  };
}

function parseId(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id < 1 || String(id) !== value) {
    return null;
  }
  return id;
}

function createNotFound() {
  const err = new Error('Not found');
  err.status = 404;
  return err;
}

function projectToFormValues(project) {
  return {
    title: project.title,
    description: project.description,
    notes: project.notes,
    status: project.status,
    plannedDate: project.planned_date || '',
    publishedDate: project.published_date || '',
    patreonUrl: project.patreon_url || '',
  };
}

function buildPageUrl(req, parsedQuery, currentPage, pageDefaultsService) {
  const baseQuery = buildCanonicalPageQuery(req, parsedQuery, currentPage, pageDefaultsService);
  const fallbackView = pageDefaultsService.getFallback('projects', 'view');
  const defaultView = pageDefaultsService.resolve('projects', 'view');

  return function pageUrl(overrides) {
    const query = { ...baseQuery };
    for (const [key, value] of Object.entries(overrides)) {
      if (!['search', 'status', 'tag', 'project', 'sort', 'order', 'page', 'view'].includes(key)) continue;
      if (value === undefined || value === null || value === '') {
        delete query[key];
      } else if (Array.isArray(value) && value.length === 0) {
        delete query[key];
      } else if (key === 'view') {
        if (value === 'list') query.view = 'list';
        else if (value === 'grid' && defaultView !== fallbackView) query.view = 'grid';
        else delete query.view;
      } else {
        query[key] = Array.isArray(value) ? value : String(value);
      }
    }
    return buildPageUrlString(req, query);
  };
}

function buildCanonicalPageQuery(req, parsedQuery, currentPage, pageDefaultsService) {
  const rawQuery = req.query && typeof req.query === 'object' ? req.query : {};
  const query = {};
  const fallbackSort = pageDefaultsService.getFallback('projects', 'sort');
  const fallbackOrder = pageDefaultsService.getFallback('projects', 'order');
  const fallbackView = pageDefaultsService.getFallback('projects', 'view');
  const defaultSort = pageDefaultsService.resolve('projects', 'sort');
  const defaultOrder = pageDefaultsService.resolve('projects', 'order');
  const defaultView = pageDefaultsService.resolve('projects', 'view');

  if (parsedQuery.search) query.search = parsedQuery.search;
  if (parsedQuery.statuses.length > 0) query.status = parsedQuery.statuses;
  if (parsedQuery.tagIds.length > 0) query.tag = parsedQuery.tagIds.map(String);
  if (parsedQuery.projectId != null) query.project = String(parsedQuery.projectId);

  if (
    parsedQuery.sortBy !== fallbackSort
    || SORT_OPTIONS.includes(rawQuery.sort)
    || (Object.hasOwn(rawQuery, 'sort') && defaultSort !== fallbackSort)
  ) {
    query.sort = parsedQuery.sortBy;
  }

  if (
    parsedQuery.order !== fallbackOrder
    || rawQuery.order === 'asc'
    || rawQuery.order === 'desc'
    || (Object.hasOwn(rawQuery, 'order') && defaultOrder !== fallbackOrder)
  ) {
    query.order = parsedQuery.order;
  }

  if (
    parsedQuery.view !== fallbackView
    || (Object.hasOwn(rawQuery, 'view') && defaultView !== fallbackView)
  ) {
    query.view = parsedQuery.view;
  }

  if (currentPage > 1) query.page = String(currentPage);
  return query;
}

function buildPageUrlString(req, query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item !== undefined && item !== null && item !== '') {
        params.append(key, String(item));
      }
    }
  }
  const search = params.toString();
  const pathname = req.baseUrl || req.path;
  return search ? `${pathname}?${search}` : pathname;
}

function shouldPreserveViewQuery(raw, parsedQuery, pageDefaultsService) {
  if (parsedQuery.view === 'list') return true;

  const rawQuery = raw && typeof raw === 'object' ? raw : {};
  return Object.hasOwn(rawQuery, 'view')
    && parsedQuery.view === pageDefaultsService.getFallback('projects', 'view')
    && pageDefaultsService.resolve('projects', 'view') !== pageDefaultsService.getFallback('projects', 'view');
}
