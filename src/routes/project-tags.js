import express from 'express';
import {
  ProjectNotFoundError,
  ProjectTagValidationError,
  TagNotFoundError,
} from '../services/project-tag-service.js';

function createNotFound() {
  const err = new Error('Not found');
  err.status = 404;
  return err;
}

function parseProjectId(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id < 1 || String(id) !== String(value)) {
    return null;
  }
  return id;
}

function isArchivedProject(project) {
  return Boolean(project?.archived_at || project?.status === 'archived');
}

function getTagService(req) {
  const service = req.app?.locals?.tagService;
  if (!service) {
    throw new Error('Project Tags requires app.locals.tagService.');
  }
  return service;
}

function getProjectTagService(req) {
  const service = req.app?.locals?.projectTagService;
  if (!service) {
    throw new Error('Project Tags requires app.locals.projectTagService.');
  }
  return service;
}

function toProjectView(project) {
  return {
    id: project.id,
    title: project.title,
    status: project.status,
    archived_at: project.archived_at,
  };
}

function toTagView(tag) {
  return {
    id: tag.id,
    displayName: tag.display_name,
  };
}

function loadPageData(req, project) {
  const tags = getTagService(req).listTags().map(toTagView);
  const assignedTags = getProjectTagService(req).listProjectTags(project.id).map(toTagView);
  return { tags, assignedTags };
}

function renderTagPage(req, res, project, {
  appName,
  status = 200,
  errors = {},
  submittedTagIds,
} = {}) {
  const { tags, assignedTags } = loadPageData(req, project);
  const selectedTagIds = submittedTagIds === undefined
    ? assignedTags.map((tag) => String(tag.id))
    : submittedTagIds;

  res.status(status).render('projects/tags.njk', {
    appName,
    project: toProjectView(project),
    tags,
    assignedTags,
    selectedTagIds,
    errors,
    errorMessages: Object.values(errors),
  });
}

function renderTagPageOrNext(req, res, next, project, options = {}) {
  try {
    renderTagPage(req, res, project, options);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return next(createNotFound());
    }
    return next(err);
  }
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

function parseSubmittedTagIds(raw) {
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

/**
 * Create the project-specific tag assignment router, mounted at /projects.
 *
 * Routes:
 *   GET  /:projectId/tags
 *   POST /:projectId/tags
 *
 * Tag catalog and assignment mutations are delegated to application-scoped
 * services exposed through req.app.locals. This router never opens a database
 * connection or accesses a tag repository.
 */
export function createProjectTagsRouter({ appName, projectService } = {}) {
  if (!projectService) {
    throw new Error('createProjectTagsRouter requires a projectService dependency.');
  }

  const router = express.Router();

  function loadProjectOr404(req, next) {
    const projectId = parseProjectId(req.params.projectId);
    if (projectId === null) {
      next(createNotFound());
      return null;
    }

    const project = projectService.findById(projectId);
    if (!project) {
      next(createNotFound());
      return null;
    }
    return project;
  }

  function renderProjectTagsPage(req, res, next, project, options = {}) {
    return renderTagPageOrNext(req, res, next, project, { appName, ...options });
  }

  router.get('/:projectId/tags', (req, res, next) => {
    const project = loadProjectOr404(req, next);
    if (!project) return;

    renderProjectTagsPage(req, res, next, project);
  });

  router.post('/:projectId/tags', (req, res, next) => {
    const project = loadProjectOr404(req, next);
    if (!project) return;

    if (isArchivedProject(project)) {
      return renderProjectTagsPage(req, res, next, project, { status: 409 });
    }

    const parsed = parseSubmittedTagIds(req.body?.tagIds);
    if (!parsed.valid) {
      return renderProjectTagsPage(req, res, next, project, {
        status: 422,
        submittedTagIds: parsed.submittedTagIds,
        errors: { tagIds: parsed.error },
      });
    }

    try {
      getProjectTagService(req).replaceProjectTags(project.id, parsed.tagIds);
      return res.redirect(`/projects/${project.id}?notice=project_tags_updated`);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        return next(createNotFound());
      }
      if (err instanceof TagNotFoundError) {
        return renderProjectTagsPage(req, res, next, project, {
          status: 422,
          submittedTagIds: parsed.submittedTagIds,
          errors: { tagIds: 'One or more selected tags no longer exists. Refresh and try again.' },
        });
      }
      if (err instanceof ProjectTagValidationError) {
        return renderProjectTagsPage(req, res, next, project, {
          status: 422,
          submittedTagIds: parsed.submittedTagIds,
          errors: err.errors || { tagIds: err.message },
        });
      }
      return next(err);
    }
  });

  return router;
}
