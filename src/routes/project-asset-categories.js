import express from 'express';
import {
  ProjectNotFoundError,
  AssetCategoryNotFoundError,
  AssetCategoryValidationError,
  ProjectArchivedError,
  ProjectAssetCategoryError,
} from '../services/project-asset-category-service.js';
import { StorageError } from '../storage/path-manager.js';
import { buildProjectAssetBrowserPreferenceModel } from '../services/asset-browser-preference-presenter.js';
import { parseEnabledField } from '../services/asset-category-validation.js';

// Controlled, curated notice text keyed by a fixed code — never the raw
// exception message, so an internal failure detail can never reach a
// rendered page.
const NOTICES = {
  category_added: { variant: 'success', text: 'Category added.' },
  category_name_updated: { variant: 'success', text: 'Display name updated.' },
  category_enabled: { variant: 'success', text: 'Category enabled.' },
  category_disabled: { variant: 'success', text: 'Category disabled. Its existing files were not touched.' },
  category_deleted: { variant: 'success', text: 'Category deleted.' },
  category_reordered: { variant: 'success', text: 'Category order updated.' },
  category_reorder_failed: { variant: 'error', text: 'Could not update the order. No changes were made.' },
  category_mutation_failed: { variant: 'error', text: 'Could not save the category. Please try again.' },
  category_archived: { variant: 'warning', text: 'This project is archived and cannot be modified.' },
  category_enable_failed: { variant: 'error', text: "Could not enable the category. Its directory may be inaccessible." },
  category_delete_disable_instead: {
    variant: 'error',
    text: 'This category still has assets or files. Disable it instead of deleting it.',
  },
  category_delete_failed: { variant: 'error', text: 'Could not delete the category. Please try again.' },
  project_default_saved: { variant: 'success', text: 'Project asset default saved.' },
};

function resolveNotice(code) {
  return Object.prototype.hasOwnProperty.call(NOTICES, code) ? NOTICES[code] : null;
}

function createNotFound() {
  const err = new Error('Not found');
  err.status = 404;
  return err;
}

function parseId(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id < 1 || String(id) !== String(value)) {
    return null;
  }
  return id;
}

function isArchivedProject(project) {
  return Boolean(project?.archived_at || project?.status === 'archived');
}

function parseOrderIds(raw) {
  if (raw === undefined || raw === null) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map((v) => Number(v));
}

// Full order array with the given id swapped one position toward `direction`.
// Returns null if the id isn't present; returns the unchanged order if
// already at the boundary (a no-op move).
function buildMovedOrder(categories, id, direction) {
  const ids = categories.map((c) => c.id);
  const index = ids.indexOf(id);
  if (index === -1) return null;
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= ids.length) return ids;
  const reordered = [...ids];
  [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];
  return reordered;
}

/**
 * Create the project-specific asset-category router, mounted at /projects.
 *
 * Routes:
 *   GET  /:projectId/asset-categories
 *   POST /:projectId/asset-categories
 *   POST /:projectId/asset-categories/reorder
 *   POST /:projectId/asset-categories/:categoryId/name
 *   POST /:projectId/asset-categories/:categoryId/enable
 *   POST /:projectId/asset-categories/:categoryId/disable
 *   POST /:projectId/asset-categories/:categoryId/move-up
 *   POST /:projectId/asset-categories/:categoryId/move-down
 *   POST /:projectId/asset-categories/:categoryId/delete
 *
 * Every mutation delegates entirely to the explicitly injected
 * `projectAssetCategoryService` — this router never constructs a repository
 * or service of its own, and never touches the database or filesystem
 * directly. `projectService` is used only for read access to the project
 * record itself (title, archived_at) — the same read-only use assets.js
 * already makes of it.
 *
 * @param {object} deps
 * @param {string} deps.appName
 * @param {import('../services/project-service.js').ProjectService} deps.projectService
 * @param {ReturnType<import('../services/project-asset-category-service.js').createProjectAssetCategoryService>} deps.projectAssetCategoryService
 * @param {ReturnType<import('../services/asset-browser-preference-service.js').createAssetBrowserPreferenceService>} deps.assetBrowserPreferenceService
 */
export function createProjectAssetCategoriesRouter({
  appName,
  projectService,
  projectAssetCategoryService,
  assetBrowserPreferenceService,
} = {}) {
  if (!assetBrowserPreferenceService) {
    throw new Error('createProjectAssetCategoriesRouter requires an assetBrowserPreferenceService dependency.');
  }

  const router = express.Router();

  function renderPage(res, project, {
    status = 200,
    notice = null,
    addValues = { enabled: true },
    addErrors = {},
    nameEdit = null,
    preferenceSubmittedValue,
    preferenceError = null,
    enabledControl = null,
  } = {}) {
    const categories = projectAssetCategoryService.list(project.id);
    const preference = buildProjectAssetBrowserPreferenceModel({
      projectId: project.id,
      preferenceService: assetBrowserPreferenceService,
      categories,
      submittedValue: preferenceSubmittedValue,
      error: preferenceError,
    });
    res.status(status).render('projects/asset-categories.njk', {
      appName,
      project,
      categories,
      assetBrowserPreference: preference,
      notice,
      addValues,
      addErrors,
      nameEdit,
      enabledControl,
    });
  }

  function loadProjectOr404(req, res, next) {
    const projectId = parseId(req.params.projectId);
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

  // GET never mutates — reads the project and its categories only.
  router.get('/:projectId/asset-categories', (req, res, next) => {
    const project = loadProjectOr404(req, res, next);
    if (!project) return;
    try {
      renderPage(res, project, { notice: resolveNotice(req.query.notice) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:projectId/asset-categories/default', (req, res, next) => {
    const project = loadProjectOr404(req, res, next);
    if (!project) return;

    const submittedValue = typeof req.body?.defaultCategory === 'string' ? req.body.defaultCategory : '';

    if (isArchivedProject(project)) {
      return renderPage(res, project, { status: 409 });
    }

    try {
      assetBrowserPreferenceService.setProjectPreference(project.id, submittedValue);
      res.redirect(`/projects/${project.id}/asset-categories?notice=project_default_saved`);
    } catch (err) {
      if (err instanceof AssetCategoryValidationError) {
        return renderPage(res, project, {
          status: 422,
          preferenceSubmittedValue: submittedValue,
          preferenceError: err,
        });
      }
      if (err instanceof ProjectNotFoundError) return next(createNotFound());
      next(err);
    }
  });

  router.post('/:projectId/asset-categories', (req, res, next) => {
    const project = loadProjectOr404(req, res, next);
    if (!project) return;

    const addValues = {
      displayName: req.body?.displayName,
      directorySlug: req.body?.directorySlug,
      enabled: true,
    };

    try {
      addValues.enabled = parseEnabledField(req.body?.enabled, { defaultValue: true });
      projectAssetCategoryService.add(project.id, {
        displayName: req.body?.displayName,
        directorySlug: req.body?.directorySlug,
        enabled: addValues.enabled,
      });
      res.redirect(`/projects/${project.id}/asset-categories?notice=category_added`);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) return next(createNotFound());
      if (err instanceof ProjectArchivedError) {
        return renderPage(res, project, { status: 409, notice: resolveNotice('category_archived') });
      }
      if (err instanceof AssetCategoryValidationError) {
        return renderPage(res, project, { status: 422, addValues, addErrors: err.errors });
      }
      if (err instanceof ProjectAssetCategoryError && err.code === 'SLUG_CONFLICT') {
        return renderPage(res, project, {
          status: 422,
          addValues,
          addErrors: { directorySlug: 'A category with this directory slug already exists in this project.' },
        });
      }
      if (err instanceof StorageError) {
        return renderPage(res, project, {
          status: 422,
          addValues,
          addErrors: { directorySlug: 'That directory slug conflicts with an existing item in the project folder.' },
        });
      }
      return renderPage(res, project, { status: 500, addValues, notice: resolveNotice('category_mutation_failed') });
    }
  });

  // Registered before the '/:categoryId/...' routes below so the literal
  // "reorder" segment is never captured as a dynamic category ID.
  router.post('/:projectId/asset-categories/reorder', (req, res, next) => {
    const project = loadProjectOr404(req, res, next);
    if (!project) return;

    try {
      const orderedIds = parseOrderIds(req.body?.order);
      projectAssetCategoryService.reorder(project.id, orderedIds);
      res.redirect(`/projects/${project.id}/asset-categories?notice=category_reordered`);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) return next(createNotFound());
      if (err instanceof ProjectArchivedError) {
        return renderPage(res, project, { status: 409, notice: resolveNotice('category_archived') });
      }
      res.redirect(`/projects/${project.id}/asset-categories?notice=category_reorder_failed`);
    }
  });

  router.post('/:projectId/asset-categories/:categoryId/name', (req, res, next) => {
    const project = loadProjectOr404(req, res, next);
    if (!project) return;
    const categoryId = parseId(req.params.categoryId);
    if (categoryId === null) return next(createNotFound());

    const nameValues = { displayName: req.body?.displayName };

    try {
      projectAssetCategoryService.editDisplayName(project.id, categoryId, { displayName: req.body?.displayName });
      res.redirect(`/projects/${project.id}/asset-categories?notice=category_name_updated`);
    } catch (err) {
      if (err instanceof ProjectNotFoundError || err instanceof AssetCategoryNotFoundError) return next(createNotFound());
      if (err instanceof ProjectArchivedError) {
        return renderPage(res, project, { status: 409, notice: resolveNotice('category_archived') });
      }
      if (err instanceof AssetCategoryValidationError) {
        return renderPage(res, project, {
          status: 422,
          nameEdit: { categoryId, values: nameValues, errors: err.errors },
        });
      }
      return renderPage(res, project, { status: 500, notice: resolveNotice('category_mutation_failed') });
    }
  });

  function handleSetEnabled(req, res, next, enabled, { project: suppliedProject = null, categoryId: suppliedCategoryId = null } = {}) {
    const project = suppliedProject || loadProjectOr404(req, res, next);
    if (!project) return;
    const categoryId = suppliedCategoryId || parseId(req.params.categoryId);
    if (categoryId === null) return next(createNotFound());

    try {
      projectAssetCategoryService.setEnabled(project.id, categoryId, enabled);
      const notice = enabled ? 'category_enabled' : 'category_disabled';
      res.redirect(`/projects/${project.id}/asset-categories?notice=${notice}`);
    } catch (err) {
      if (err instanceof ProjectNotFoundError || err instanceof AssetCategoryNotFoundError) return next(createNotFound());
      if (err instanceof ProjectArchivedError) {
        return renderPage(res, project, { status: 409, notice: resolveNotice('category_archived') });
      }
      res.redirect(`/projects/${project.id}/asset-categories?notice=category_enable_failed`);
    }
  }

  router.post('/:projectId/asset-categories/:categoryId/enabled', (req, res, next) => {
    const project = loadProjectOr404(req, res, next);
    if (!project) return;
    const categoryId = parseId(req.params.categoryId);
    if (categoryId === null) return next(createNotFound());

    let enabled;
    try {
      enabled = parseEnabledField(req.body?.enabled);
    } catch (err) {
      if (err instanceof AssetCategoryValidationError) {
        return renderPage(res, project, {
          status: 422,
          enabledControl: {
            categoryId,
            submitted: null,
            errorMessage: err.errors.enabled || err.message,
          },
        });
      }
      return next(err);
    }

    return handleSetEnabled(req, res, next, enabled, { project, categoryId });
  });

  router.post('/:projectId/asset-categories/:categoryId/enable', (req, res, next) => handleSetEnabled(req, res, next, true));
  router.post('/:projectId/asset-categories/:categoryId/disable', (req, res, next) => handleSetEnabled(req, res, next, false));

  function handleMove(req, res, next, direction) {
    const project = loadProjectOr404(req, res, next);
    if (!project) return;
    const categoryId = parseId(req.params.categoryId);
    if (categoryId === null) return next(createNotFound());

    let categories;
    try {
      categories = projectAssetCategoryService.list(project.id);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) return next(createNotFound());
      return next(err);
    }

    const orderedIds = buildMovedOrder(categories, categoryId, direction);
    if (!orderedIds) return next(createNotFound());

    try {
      projectAssetCategoryService.reorder(project.id, orderedIds);
      res.redirect(`/projects/${project.id}/asset-categories?notice=category_reordered`);
    } catch (err) {
      if (err instanceof ProjectArchivedError) {
        return renderPage(res, project, { status: 409, notice: resolveNotice('category_archived') });
      }
      res.redirect(`/projects/${project.id}/asset-categories?notice=category_reorder_failed`);
    }
  }

  router.post('/:projectId/asset-categories/:categoryId/move-up', (req, res, next) => handleMove(req, res, next, 'up'));
  router.post('/:projectId/asset-categories/:categoryId/move-down', (req, res, next) => handleMove(req, res, next, 'down'));

  router.post('/:projectId/asset-categories/:categoryId/delete', (req, res, next) => {
    const project = loadProjectOr404(req, res, next);
    if (!project) return;
    const categoryId = parseId(req.params.categoryId);
    if (categoryId === null) return next(createNotFound());

    try {
      projectAssetCategoryService.delete(project.id, categoryId);
      res.redirect(`/projects/${project.id}/asset-categories?notice=category_deleted`);
    } catch (err) {
      if (err instanceof ProjectNotFoundError || err instanceof AssetCategoryNotFoundError) return next(createNotFound());
      if (err instanceof ProjectArchivedError) {
        return renderPage(res, project, { status: 409, notice: resolveNotice('category_archived') });
      }
      if (err instanceof ProjectAssetCategoryError && (err.code === 'HAS_ASSETS' || err.code === 'NOT_EMPTY')) {
        return res.redirect(`/projects/${project.id}/asset-categories?notice=category_delete_disable_instead`);
      }
      res.redirect(`/projects/${project.id}/asset-categories?notice=category_delete_failed`);
    }
  });

  return router;
}
