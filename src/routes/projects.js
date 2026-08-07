import express from 'express';
import {
  ProjectNotFoundError,
  ProjectValidationError,
  STATUSES,
  WORKFLOW_STATUSES,
  PRIORITIES,
  DEFAULT_PRIORITY,
} from '../services/project-service.js';
import { buildOpenLocallyUri } from '../util/open-locally.js';

const SORT_OPTIONS = ['updated', 'created', 'title'];
const VIEW_OPTIONS = ['grid', 'list'];
const PAGE_SIZE = 25;
const NOTICES = {
  project_tags_updated: { variant: 'success', text: 'Project tags updated successfully.' },
};

function resolveNotice(code) {
  return Object.prototype.hasOwnProperty.call(NOTICES, code) ? NOTICES[code] : null;
}

export function createProjectsRouter({ appName, projectService, workflowQueryService }) {
  const router = express.Router();

  router.get('/', (req, res, next) => {
    try {
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
      if (shouldRedirectToSavedDefaults(req.query, parsedQuery, pageDefaultsService)) {
        return res.redirect(buildSavedDefaultsUrl(req, parsedQuery, currentPage, pageDefaultsService));
      }

      const offset = (currentPage - 1) * PAGE_SIZE;
      const { rows } = workflowQueryService.getProjectList({ ...parsedQuery, offset, limit: PAGE_SIZE });
      const pageUrl = buildPageUrl(req, parsedQuery, currentPage, pageDefaultsService);
      const filtersActive = Boolean(
        parsedQuery.search || parsedQuery.statuses.length > 0 || parsedQuery.tagIds.length > 0,
      );

      res.render('projects/index.njk', {
        appName,
        projects: rows,
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
          sort: parsedQuery.sortBy,
          order: parsedQuery.order,
          view: parsedQuery.view,
        },
        view: parsedQuery.view,
        statuses: STATUSES,
        statusOptions: buildStatusFilterOptions(parsedQuery.statuses),
        priorities: PRIORITIES,
        sortOptions: SORT_OPTIONS,
        tagOptions,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/new', (req, res) => {
    res.render('projects/form.njk', {
      appName,
      project: null,
      values: createNewProjectFormValues(req.query || {}, getPageDefaultsService(req)),
      errors: {},
      statuses: WORKFLOW_STATUSES,
      priorities: PRIORITIES,
      action: 'Create',
      submitUrl: '/projects',
    });
  });

  router.post('/', (req, res, next) => {
    try {
      const input = parseProjectInput(req.body);
      const project = projectService.create(input);
      res.redirect(`/projects/${project.id}`);
    } catch (err) {
      if (err instanceof ProjectValidationError) {
        res.status(422).render('projects/form.njk', {
          appName,
          project: null,
          values: createFormValues(req.body),
          errors: err.errors,
          statuses: WORKFLOW_STATUSES,
          priorities: PRIORITIES,
          action: 'Create',
          submitUrl: '/projects',
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
        priorities: PRIORITIES,
        action: 'Create',
        submitUrl: '/projects',
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

    const projectTags = getProjectTagService(req)
      .listProjectTags(id)
      .map((tag) => ({ displayName: tag.display_name }));

    res.render('projects/detail.njk', {
      appName,
      project: workspace.project,
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

    res.render('projects/form.njk', {
      appName,
      project,
      values: projectToFormValues(project),
      errors: {},
      statuses: WORKFLOW_STATUSES,
      priorities: PRIORITIES,
      action: 'Edit',
      submitUrl: `/projects/${project.id}`,
    });
  });

  router.post('/:id', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    try {
      const input = parseProjectInput(req.body);
      const project = projectService.update(id, input);
      if (!project) {
        return next(createNotFound());
      }
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
          values: req.body,
          errors: err.errors,
          statuses: WORKFLOW_STATUSES,
          priorities: PRIORITIES,
          action: 'Edit',
          submitUrl: `/projects/${id}`,
        });
        return;
      }
      // Filesystem or other error: render form with safe message + preserved values
      const existing = projectService.findById(id);
      res.status(500).render('projects/form.njk', {
        appName,
        project: existing || { id },
        values: req.body,
        errors: { general: 'Project update failed. Please try again.' },
        statuses: WORKFLOW_STATUSES,
        priorities: PRIORITIES,
        action: 'Edit',
        submitUrl: `/projects/${id}`,
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

function getOpenLocallySettingsService(req) {
  const service = req.app?.locals?.openLocallySettingsService;
  if (!service) {
    throw new Error('Project detail requires app.locals.openLocallySettingsService.');
  }
  return service;
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

function getProjectTagService(req) {
  const service = req.app?.locals?.projectTagService;
  if (!service) {
    throw new Error('Project detail requires app.locals.projectTagService.');
  }
  return service;
}

function parseListQuery(raw, pageDefaultsService, tagOptions = []) {
  const rawQuery = raw && typeof raw === 'object' ? raw : {};
  const resolvedPresentation = pageDefaultsService.resolvePageDefaults('projects', rawQuery);
  const statuses = parseStatusFilterValues(rawQuery.status);
  const search = typeof rawQuery.search === 'string' ? rawQuery.search.trim() : '';
  const tagIds = parseTagFilterIds(rawQuery.tag, tagOptions);
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
    priority: body.priority,
    plannedDate: body.plannedDate || null,
    publishedDate: body.publishedDate || null,
    patreonUrl: body.patreonUrl || null,
  };
}

function createFormValues(values) {
  return {
    ...values,
    priority: values.priority === undefined ? DEFAULT_PRIORITY : values.priority,
  };
}

// New-project initial values only. Saved New Project status/priority defaults
// seed the first render; a saved value that is missing, invalid, or obsolete
// falls back to the service's application fallback. Any status/priority carried
// on the query string takes precedence over the saved default. This path is
// never used for submission re-rendering, so submitted values are unaffected.
function createNewProjectFormValues(query, pageDefaultsService) {
  return {
    ...createFormValues(query),
    status: pageDefaultsService.resolve('new_project', 'status', query.status),
    priority: pageDefaultsService.resolve('new_project', 'priority', query.priority),
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
    priority: project.priority,
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
      if (!['search', 'status', 'tag', 'sort', 'order', 'page', 'view'].includes(key)) continue;
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
