import express from 'express';
import {
  ProjectNotFoundError,
  ProjectValidationError,
  STATUSES,
  WORKFLOW_STATUSES,
  PRIORITIES,
  DEFAULT_PRIORITY,
} from '../services/project-service.js';

const SORT_OPTIONS = ['updated', 'created', 'title'];
const VIEW_OPTIONS = ['grid', 'list'];
const PAGE_SIZE = 25;

export function createProjectsRouter({ appName, projectService, workflowQueryService }) {
  const router = express.Router();

  router.get('/', (req, res, next) => {
    try {
      const parsedQuery = parseListQuery(req.query);
      const { total } = projectService.list({ ...parsedQuery, limit: 0 });
      const { total: totalProjects } = projectService.list({ includeArchived: true, limit: 0 });
      const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const currentPage = Math.min(parsedQuery.page, pageCount);
      const offset = (currentPage - 1) * PAGE_SIZE;
      const { rows } = workflowQueryService.getProjectList({ ...parsedQuery, offset, limit: PAGE_SIZE });
      const pageUrl = buildPageUrl(req, parsedQuery, currentPage);
      const filtersActive = Boolean(parsedQuery.search || parsedQuery.status);

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
        query: {
          search: parsedQuery.search,
          status: parsedQuery.status,
          sort: parsedQuery.sortBy,
          order: parsedQuery.order,
          view: parsedQuery.view,
        },
        view: parsedQuery.view,
        statuses: STATUSES,
        priorities: PRIORITIES,
        sortOptions: SORT_OPTIONS,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/new', (req, res) => {
    res.render('projects/form.njk', {
      appName,
      project: null,
      values: createFormValues(req.query || {}),
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

    res.render('projects/detail.njk', {
      appName,
      project: workspace.project,
      releaseSummary: workspace.releaseSummary,
      assetHealth: workspace.assetHealth,
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

function parseListQuery(raw) {
  const status = STATUSES.includes(raw.status) ? raw.status : undefined;
  const search = typeof raw.search === 'string' ? raw.search.trim() : '';
  const sortBy = SORT_OPTIONS.includes(raw.sort) ? raw.sort : 'created';
  const order = raw.order === 'asc' ? 'asc' : 'desc';
  const view = VIEW_OPTIONS.includes(raw.view) ? raw.view : 'grid';

  let page = Number.parseInt(raw.page, 10);
  if (!Number.isInteger(page) || page < 1) {
    page = 1;
  }

  const includeArchived = status === 'archived';

  return {
    status,
    search,
    sortBy,
    order,
    view,
    page,
    includeArchived,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  };
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

function buildPageUrl(req, parsedQuery, currentPage) {
  const baseQuery = {};
  if (parsedQuery.search) baseQuery.search = parsedQuery.search;
  if (parsedQuery.status) baseQuery.status = parsedQuery.status;
  if (SORT_OPTIONS.includes(req.query.sort)) baseQuery.sort = parsedQuery.sortBy;
  if (req.query.order === 'asc' || req.query.order === 'desc') baseQuery.order = parsedQuery.order;
  if (parsedQuery.view === 'list') baseQuery.view = 'list';
  if (currentPage > 1) baseQuery.page = String(currentPage);

  return function pageUrl(overrides) {
    const query = { ...baseQuery };
    for (const [key, value] of Object.entries(overrides)) {
      if (!['search', 'status', 'sort', 'order', 'page', 'view'].includes(key)) continue;
      if (value === undefined || value === null || value === '') {
        delete query[key];
      } else if (key === 'view') {
        if (value === 'list') query.view = 'list';
        else delete query.view;
      } else {
        query[key] = String(value);
      }
    }
    const search = new URLSearchParams(query).toString();
    const pathname = req.baseUrl || req.path;
    return search ? `${pathname}?${search}` : pathname;
  };
}
