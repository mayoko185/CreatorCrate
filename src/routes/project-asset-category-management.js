import express from 'express';
import { ProjectNotFoundError } from '../services/project-service.js';
import {
  AssetCategoryNotFoundError,
  ProjectArchivedError,
  ProjectAssetCategoryError,
} from '../services/project-asset-category-service.js';
import {
  AssetCategoryValidationError,
  parseEnabledField,
} from '../services/asset-category-validation.js';
import { StorageError } from '../storage/path-manager.js';
import { buildProjectAssetBrowserPreferenceModel } from '../services/asset-browser-preference-presenter.js';
import {
  PROJECT_ASSET_CATEGORY_NOTICES,
  buildAssetsRedirectUrl,
  buildProjectAssetCategoryManagementModel,
  createNotFound,
  getPageDefaultsService,
  isEnhancedAssetRequest,
  parseId,
  readProjectAssetsReturnQuery,
  renderProjectAssetsPage,
  resolveProjectAssetCategoryNotice,
} from './project-assets-shared.js';

export function createProjectAssetCategoryManagementRouter({
  appName,
  projectService,
  workflowQueryService,
  releaseService,
  projectAssetCategoryService,
  assetBrowserPreferenceService,
} = {}) {
  if (!assetBrowserPreferenceService || typeof assetBrowserPreferenceService.resolveEffectiveCategory !== 'function') {
    throw new Error('createProjectAssetCategoryManagementRouter requires an assetBrowserPreferenceService dependency.');
  }
  if (!projectAssetCategoryService || typeof projectAssetCategoryService.list !== 'function') {
    throw new Error('createProjectAssetCategoryManagementRouter requires a projectAssetCategoryService dependency.');
  }

  const router = express.Router({ mergeParams: true });
function loadCategoryProject(req, next) {
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

function readCategoryAssetsContext(req, projectId) {
  if (typeof req.body?.returnTo === 'string') {
    return readProjectAssetsReturnQuery(req, projectId);
  }
  return req.body && typeof req.body === 'object' ? req.body : {};
}

function buildCategoryAssetsRedirect(req, projectId, notice) {
  return buildAssetsRedirectUrl(
    workflowQueryService,
    projectId,
    readCategoryAssetsContext(req, projectId),
    { manage_categories: '1', notice },
    getPageDefaultsService(req),
  );
}

function renderCategoryAssetsPage(req, res, next, project, {
  status = 200,
  notice = null,
  addValues = { enabled: true },
  addErrors = {},
  nameEdit = null,
  preferenceSubmittedValue,
  preferenceError = null,
  enabledControl = null,
} = {}) {
  return renderProjectAssetsPage(req, res, {
    appName,
    projectService,
    workflowQueryService,
    assetBrowserPreferenceService,
    projectAssetCategoryService,
    projectId: project.id,
    status,
    rawQuery: readCategoryAssetsContext(req, project.id),
    categoryManagementDialogOpen: true,
    categoryManagementNotice: notice,
    categoryManagementAddValues: addValues,
    categoryManagementAddErrors: addErrors,
    categoryManagementNameEdit: nameEdit,
    categoryManagementPreferenceSubmittedValue: preferenceSubmittedValue,
    categoryManagementPreferenceError: preferenceError,
    categoryManagementEnabledControl: enabledControl,
    allowSavedDefaultsRedirect: false,
    next,
  });
}

function sendEnhancedCategoryManagementResponse(req, res, next, project, {
  status = 200,
  message,
  notice = null,
  addValues = { enabled: true },
  addErrors = {},
  nameEdit = null,
  preferenceSubmittedValue,
  preferenceError = null,
  enabledControl = null,
  errors,
  values,
  categoryId,
  focus,
} = {}) {
  let categoryManagement;
  let categoryManagementReturnUrl;
  try {
    categoryManagement = buildProjectAssetCategoryManagementModel({
      projectId: project.id,
      projectAssetCategoryService,
      assetBrowserPreferenceService,
      notice,
      addValues,
      addErrors,
      nameEdit,
      preferenceSubmittedValue,
      preferenceError,
      enabledControl,
    });
    categoryManagementReturnUrl = buildAssetsRedirectUrl(
      workflowQueryService,
      project.id,
      readCategoryAssetsContext(req, project.id),
      {},
      getPageDefaultsService(req),
    );
  } catch (err) {
    return next(err);
  }

  return res.render('partials/project-asset-category-management.njk', {
    project,
    categoryManagement,
    categoryManagementReturnUrl,
    _csrf: res.locals._csrf,
  }, (renderError, html) => {
    if (renderError) return next(renderError);

    const response = {
      status: status >= 400 ? 'error' : 'success',
      message,
      html,
    };
    if (errors) response.errors = errors;
    if (values) response.values = values;
    if (categoryId !== undefined) response.categoryId = categoryId;
    if (focus !== undefined) response.focus = focus;
    return res.status(status).json(response);
  });
}

router.post('/:projectId/asset-categories/default', (req, res, next) => {
  const project = loadCategoryProject(req, next);
  if (!project) return;

  const submittedValue = typeof req.body?.defaultCategory === 'string' ? req.body.defaultCategory : '';
  const enhanced = isEnhancedAssetRequest(req);

  if (isArchivedProject(project)) {
    if (enhanced) {
      return res.status(409).json({
        status: 'error',
        message: 'This project is archived and cannot be modified.',
      });
    }
    return renderCategoryAssetsPage(req, res, next, project, { status: 409 });
  }

  try {
    assetBrowserPreferenceService.setProjectPreference(project.id, submittedValue);
    if (enhanced) {
      const preference = buildProjectAssetBrowserPreferenceModel({
        projectId: project.id,
        preferenceService: assetBrowserPreferenceService,
        categories: projectAssetCategoryService.list(project.id),
      });
      return res.json({
        status: 'success',
        message: PROJECT_ASSET_CATEGORY_NOTICES.project_default_saved.text,
        values: { defaultCategory: preference.storedValue },
        fallbackExplanation: preference.fallbackExplanation,
      });
    }
    return res.redirect(buildCategoryAssetsRedirect(req, project.id, 'project_default_saved'));
  } catch (err) {
    if (err instanceof AssetCategoryValidationError) {
      if (enhanced) {
        return res.status(422).json({
          status: 'error',
          message: 'Project asset browser default could not be saved.',
          errors: err.errors || {},
          values: { defaultCategory: submittedValue },
        });
      }
      return renderCategoryAssetsPage(req, res, next, project, {
        status: 422,
        preferenceSubmittedValue: submittedValue,
        preferenceError: err,
      });
    }
    if (err instanceof ProjectNotFoundError) return next(createNotFound());
    if (enhanced) {
      return res.status(500).json({
        status: 'error',
        message: 'Could not save the project asset browser default. The previous setting was kept.',
      });
    }
    return next(err);
  }
});



router.post('/:projectId/asset-categories', (req, res, next) => {
  const project = loadCategoryProject(req, next);
  if (!project) return;
  const enhanced = isEnhancedAssetRequest(req);

  const addValues = {
    displayName: req.body?.displayName,
    directorySlug: req.body?.directorySlug,
    enabled: true,
  };

  try {
    addValues.enabled = parseEnabledField(req.body?.enabled, { defaultValue: true });
    const addedCategory = projectAssetCategoryService.add(project.id, {
      displayName: req.body?.displayName,
      directorySlug: req.body?.directorySlug,
      enabled: addValues.enabled,
    });
    if (enhanced) {
      return sendEnhancedCategoryManagementResponse(req, res, next, project, {
        message: PROJECT_ASSET_CATEGORY_NOTICES.category_added.text,
        categoryId: addedCategory?.id,
        focus: 'add-displayName',
      });
    }
    return res.redirect(buildCategoryAssetsRedirect(req, project.id, 'category_added'));
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return next(createNotFound());
    if (err instanceof ProjectArchivedError) {
      if (enhanced) {
        return sendEnhancedCategoryManagementResponse(req, res, next, project, {
          status: 409,
          message: PROJECT_ASSET_CATEGORY_NOTICES.category_archived.text,
          notice: resolveProjectAssetCategoryNotice('category_archived'),
        });
      }
      return renderCategoryAssetsPage(req, res, next, project, {
        status: 409,
        notice: resolveProjectAssetCategoryNotice('category_archived'),
      });
    }
    if (err instanceof AssetCategoryValidationError) {
      if (enhanced) {
        return sendEnhancedCategoryManagementResponse(req, res, next, project, {
          status: 422,
          message: 'Could not add the category. Fix the fields below and try again.',
          addValues,
          addErrors: err.errors,
          errors: err.errors,
          values: addValues,
          focus: 'add-displayName',
        });
      }
      return renderCategoryAssetsPage(req, res, next, project, { status: 422, addValues, addErrors: err.errors });
    }
    if (err instanceof ProjectAssetCategoryError && err.code === 'SLUG_CONFLICT') {
      const addErrors = { directorySlug: 'A category with this directory slug already exists in this project.' };
      if (enhanced) {
        return sendEnhancedCategoryManagementResponse(req, res, next, project, {
          status: 422,
          message: 'Could not add the category. Fix the fields below and try again.',
          addValues,
          addErrors,
          errors: addErrors,
          values: addValues,
          focus: 'add-directorySlug',
        });
      }
      return renderCategoryAssetsPage(req, res, next, project, {
        status: 422,
        addValues,
        addErrors,
      });
    }
    if (err instanceof StorageError) {
      const addErrors = { directorySlug: 'That directory slug conflicts with an existing item in the project folder.' };
      if (enhanced) {
        return sendEnhancedCategoryManagementResponse(req, res, next, project, {
          status: 422,
          message: 'Could not add the category. Fix the fields below and try again.',
          addValues,
          addErrors,
          errors: addErrors,
          values: addValues,
          focus: 'add-directorySlug',
        });
      }
      return renderCategoryAssetsPage(req, res, next, project, {
        status: 422,
        addValues,
        addErrors,
      });
    }
    if (enhanced) {
      return sendEnhancedCategoryManagementResponse(req, res, next, project, {
        status: 500,
        message: PROJECT_ASSET_CATEGORY_NOTICES.category_mutation_failed.text,
        notice: resolveProjectAssetCategoryNotice('category_mutation_failed'),
        addValues,
        focus: 'add-displayName',
      });
    }
    return renderCategoryAssetsPage(req, res, next, project, {
      status: 500,
      addValues,
      notice: resolveProjectAssetCategoryNotice('category_mutation_failed'),
    });
  }
});

// Registered before the '/:categoryId/...' routes below so the literal
// "reorder" segment is never captured as a dynamic category ID.
router.post('/:projectId/asset-categories/reorder', (req, res, next) => {
  const project = loadCategoryProject(req, next);
  if (!project) return;
  if (isArchivedProject(project)) {
    return renderCategoryAssetsPage(req, res, next, project, {
      status: 409,
      notice: resolveProjectAssetCategoryNotice('category_archived'),
    });
  }

  try {
    const orderedIds = parseOrderedCategoryIds(req.body?.orderedCategoryIds);
    projectAssetCategoryService.reorder(project.id, orderedIds);
    return res.redirect(buildCategoryAssetsRedirect(req, project.id, 'category_reordered'));
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return next(createNotFound());
    if (err instanceof ProjectArchivedError) {
      return renderCategoryAssetsPage(req, res, next, project, {
        status: 409,
        notice: resolveProjectAssetCategoryNotice('category_archived'),
      });
    }
    if (err instanceof AssetCategoryValidationError) {
      return renderCategoryAssetsPage(req, res, next, project, {
        status: 422,
        notice: resolveProjectAssetCategoryNotice('category_reorder_invalid'),
      });
    }
    return res.redirect(buildCategoryAssetsRedirect(req, project.id, 'category_reorder_failed'));
  }
});

router.post('/:projectId/asset-categories/:categoryId/create-release', (req, res, next) => {
  const project = loadCategoryProject(req, next);
  if (!project) return;
  const categoryId = parseId(req.params.categoryId);
  if (categoryId === null) return next(createNotFound());

  if (isArchivedProject(project)) {
    return renderCategoryAssetsPage(req, res, next, project, {
      status: 409,
      notice: resolveProjectAssetCategoryNotice('category_archived'),
    });
  }

  try {
    const release = releaseService.createReleaseFromCategory(project.id, categoryId);
    return res.redirect(`/releases/${release.id}/assets`);
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof AssetCategoryNotFoundError) {
      return next(createNotFound());
    }
    return next(err);
  }
});

router.post('/:projectId/asset-categories/:categoryId/name', (req, res, next) => {
  const project = loadCategoryProject(req, next);
  if (!project) return;
  const categoryId = parseId(req.params.categoryId);
  if (categoryId === null) return next(createNotFound());
  const enhanced = isEnhancedAssetRequest(req);

  const nameValues = { displayName: req.body?.displayName };

  try {
    projectAssetCategoryService.editDisplayName(project.id, categoryId, { displayName: req.body?.displayName });
    if (enhanced) {
      return sendEnhancedCategoryManagementResponse(req, res, next, project, {
        message: PROJECT_ASSET_CATEGORY_NOTICES.category_name_updated.text,
        categoryId,
        focus: `name-${categoryId}`,
      });
    }
    return res.redirect(buildCategoryAssetsRedirect(req, project.id, 'category_name_updated'));
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof AssetCategoryNotFoundError) return next(createNotFound());
    if (err instanceof ProjectArchivedError) {
      if (enhanced) {
        return sendEnhancedCategoryManagementResponse(req, res, next, project, {
          status: 409,
          message: PROJECT_ASSET_CATEGORY_NOTICES.category_archived.text,
          notice: resolveProjectAssetCategoryNotice('category_archived'),
          categoryId,
        });
      }
      return renderCategoryAssetsPage(req, res, next, project, {
        status: 409,
        notice: resolveProjectAssetCategoryNotice('category_archived'),
      });
    }
    if (err instanceof AssetCategoryValidationError) {
      const nameEdit = { categoryId, values: nameValues, errors: err.errors };
      if (enhanced) {
        return sendEnhancedCategoryManagementResponse(req, res, next, project, {
          status: 422,
          message: 'Could not update the display name. Fix the field below and try again.',
          nameEdit,
          errors: err.errors,
          values: nameValues,
          categoryId,
          focus: `name-${categoryId}`,
        });
      }
      return renderCategoryAssetsPage(req, res, next, project, {
        status: 422,
        nameEdit,
      });
    }
    if (enhanced) {
      return sendEnhancedCategoryManagementResponse(req, res, next, project, {
        status: 500,
        message: PROJECT_ASSET_CATEGORY_NOTICES.category_mutation_failed.text,
        notice: resolveProjectAssetCategoryNotice('category_mutation_failed'),
        categoryId,
      });
    }
    return renderCategoryAssetsPage(req, res, next, project, {
      status: 500,
      notice: resolveProjectAssetCategoryNotice('category_mutation_failed'),
    });
  }
});

function handleSetCategoryEnabled(req, res, next, enabled, { project, categoryId }) {
  try {
    projectAssetCategoryService.setEnabled(project.id, categoryId, enabled);
    const notice = enabled ? 'category_enabled' : 'category_disabled';
    return res.redirect(buildCategoryAssetsRedirect(req, project.id, notice));
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof AssetCategoryNotFoundError) return next(createNotFound());
    if (err instanceof ProjectArchivedError) {
      return renderCategoryAssetsPage(req, res, next, project, {
        status: 409,
        notice: resolveProjectAssetCategoryNotice('category_archived'),
      });
    }
    return res.redirect(buildCategoryAssetsRedirect(req, project.id, 'category_enable_failed'));
  }
}

router.post('/:projectId/asset-categories/:categoryId/enabled', (req, res, next) => {
  const project = loadCategoryProject(req, next);
  if (!project) return;
  const categoryId = parseId(req.params.categoryId);
  if (categoryId === null) return next(createNotFound());

  let enabled;
  try {
    enabled = parseEnabledField(req.body?.enabled);
  } catch (err) {
    if (err instanceof AssetCategoryValidationError) {
      return renderCategoryAssetsPage(req, res, next, project, {
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

  return handleSetCategoryEnabled(req, res, next, enabled, { project, categoryId });
});

function handleMoveCategory(req, res, next, direction) {
  const project = loadCategoryProject(req, next);
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
    return res.redirect(buildCategoryAssetsRedirect(req, project.id, 'category_reordered'));
  } catch (err) {
    if (err instanceof ProjectArchivedError) {
      return renderCategoryAssetsPage(req, res, next, project, {
        status: 409,
        notice: resolveProjectAssetCategoryNotice('category_archived'),
      });
    }
    return res.redirect(buildCategoryAssetsRedirect(req, project.id, 'category_reorder_failed'));
  }
}

router.post('/:projectId/asset-categories/:categoryId/move-up', (req, res, next) => (
  handleMoveCategory(req, res, next, 'up')
));
router.post('/:projectId/asset-categories/:categoryId/move-down', (req, res, next) => (
  handleMoveCategory(req, res, next, 'down')
));

router.post('/:projectId/asset-categories/:categoryId/delete', (req, res, next) => {
  const project = loadCategoryProject(req, next);
  if (!project) return;
  const categoryId = parseId(req.params.categoryId);
  if (categoryId === null) return next(createNotFound());
  const enhanced = isEnhancedAssetRequest(req);

  try {
    projectAssetCategoryService.delete(project.id, categoryId);
    if (enhanced) {
      return sendEnhancedCategoryManagementResponse(req, res, next, project, {
        message: PROJECT_ASSET_CATEGORY_NOTICES.category_deleted.text,
        categoryId,
      });
    }
    return res.redirect(buildCategoryAssetsRedirect(req, project.id, 'category_deleted'));
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof AssetCategoryNotFoundError) return next(createNotFound());
    if (err instanceof ProjectArchivedError) {
      if (enhanced) {
        return sendEnhancedCategoryManagementResponse(req, res, next, project, {
          status: 409,
          message: PROJECT_ASSET_CATEGORY_NOTICES.category_archived.text,
          notice: resolveProjectAssetCategoryNotice('category_archived'),
          categoryId,
        });
      }
      return renderCategoryAssetsPage(req, res, next, project, {
        status: 409,
        notice: resolveProjectAssetCategoryNotice('category_archived'),
      });
    }
    if (err instanceof ProjectAssetCategoryError && (err.code === 'HAS_ASSETS' || err.code === 'NOT_EMPTY')) {
      if (enhanced) {
        return sendEnhancedCategoryManagementResponse(req, res, next, project, {
          status: 409,
          message: PROJECT_ASSET_CATEGORY_NOTICES.category_delete_disable_instead.text,
          notice: resolveProjectAssetCategoryNotice('category_delete_disable_instead'),
          categoryId,
        });
      }
      return res.redirect(buildCategoryAssetsRedirect(req, project.id, 'category_delete_disable_instead'));
    }
    if (enhanced) {
      return sendEnhancedCategoryManagementResponse(req, res, next, project, {
        status: 500,
        message: PROJECT_ASSET_CATEGORY_NOTICES.category_delete_failed.text,
        notice: resolveProjectAssetCategoryNotice('category_delete_failed'),
        categoryId,
      });
    }
    return res.redirect(buildCategoryAssetsRedirect(req, project.id, 'category_delete_failed'));
  }
});

function isArchivedProject(project) {
  return Boolean(project?.archived_at || project?.status === 'archived');
}
/**
 * Parse the batch reorder form contract: one `orderedCategoryIds` field whose
 * value is a comma-separated list of canonical positive integer IDs. An empty
 * string represents the complete empty set; a missing field is invalid.
 */
function parseOrderedCategoryIds(raw) {
  if (raw === undefined || raw === null) {
    throw new AssetCategoryValidationError({
      orderedCategoryIds: 'Submit the complete ordered category ID list.',
    });
  }
  if (Array.isArray(raw) || typeof raw !== 'string') {
    throw new AssetCategoryValidationError({
      orderedCategoryIds: 'Category IDs must be submitted as one comma-separated value.',
    });
  }
  if (raw === '') return [];
  if (!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(raw)) {
    throw new AssetCategoryValidationError({
      orderedCategoryIds: 'Category IDs must be canonical positive integers separated by commas.',
    });
  }

  const ids = raw.split(',').map((value) => Number(value));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new AssetCategoryValidationError({
      orderedCategoryIds: 'Category IDs must be safe positive integers.',
    });
  }
  return ids;
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

  return router;
}
