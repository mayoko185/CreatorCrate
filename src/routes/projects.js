import express from 'express';
import {
  ProjectDeletionError,
  ProjectNotFoundError,
  ProjectValidationError,
} from '../services/project-service.js';
import { ProjectOwnershipError } from '../services/project-directory-ownership.js';
import { NSFW_TAG_NAME } from '../services/nsfw-filter-settings-service.js';
import {
  AssetCategoryValidationError,
  parseEnabledField,
} from '../services/asset-category-validation.js';
import { buildOpenLocallyUri } from '../util/open-locally.js';
import {
  buildProjectOptionPresentation,
  presentProjectOptions,
} from '../services/project-option-presenter.js';
import { buildNewProjectFormModel, buildProjectEditDialogFormModel, createFormValues } from './project-create-form.js';
import { isProjectArchived } from '../services/project-state.js';
import { isSafeRedirectTarget } from '../middleware/auth.js';
import { renderDashboardPage } from './dashboard-render.js';
import { buildProjectRelatedNotesModel } from './project-related-notes.js';
import {
  buildPageDefaultsDialogModel,
  handlePageDefaultsPost,
} from './page-defaults.js';
import {
  PAGE_DEFAULT_DEFINITIONS,
  PageDefaultsGenerationConflictError,
} from '../services/page-defaults-service.js';

const SORT_OPTIONS = ['updated', 'created', 'title'];
const VIEW_OPTIONS = ['grid', 'list'];
const PAGE_SIZE = 25;
const NSFW_TAG_NORMALIZED_NAME = NSFW_TAG_NAME.toLowerCase();
const NOTICES = {
  project_tags_updated: { variant: 'success', text: 'Project tags updated successfully.' },
  projects_defaults_saved: { variant: 'success', text: 'Projects defaults saved successfully.' },
};

const PROJECTS_PAGE_DEFAULTS = 'projects';
// WP10b: the seven saveable Projects settings, in the page definition's
// order. Search and the Project restriction are temporary and never saved.
const PROJECTS_DEFAULT_FIELDS = Object.freeze(Object.keys(PAGE_DEFAULT_DEFINITIONS[PROJECTS_PAGE_DEFAULTS]));
const PROJECTS_MULTI_FIELDS = Object.freeze(PROJECTS_DEFAULT_FIELDS
  .filter((field) => PAGE_DEFAULT_DEFINITIONS[PROJECTS_PAGE_DEFAULTS][field].multi === true));
// Reset filters: a bare /projects request resolves every default-backed
// control from the saved defaults (then the application fallbacks) and
// clears the temporary Search and Project restriction (read-only GET).
const PROJECTS_RESET_FILTERS_URL = '/projects';

// WP10b mutation protocol (the reviewed WP9a F6/F7 contract, on the Projects
// page key). Every Save / Reset defaults request carries the defaults
// generation it was prepared from and a client-chosen operation identity. The
// handler fences the write on the generation inside the write transaction and
// echoes the identity in each JSON answer it produces, so a late or duplicate
// request can never overwrite a newer write and a client can tell this
// handler's answer from an intermediary's.
const PROJECTS_DEFAULTS_GENERATION_FIELD = 'defaultsGeneration';
const PROJECTS_DEFAULTS_OPERATION_FIELD = 'defaultsOperation';
const PROJECTS_DEFAULTS_OPERATION_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const PROJECTS_DEFAULTS_CONFLICT_CODE = 'DEFAULTS_GENERATION_CONFLICT';
const PROJECTS_DEFAULTS_CONFLICT_MESSAGE = 'Projects defaults changed since this page was loaded. '
  + 'No changes were made. Review the current defaults and try again.';
const PROJECTS_DEFAULTS_RESET_MESSAGE = 'Projects defaults reset to the application defaults.';

const PROJECTS_DEFAULT_LABELS = Object.freeze({
  fields: Object.freeze({
    view: 'View',
    gridStyle: 'Grid style',
    sort: 'Sort',
    order: 'Order',
    status: 'Status',
    projectType: 'Project Type',
    tag: 'Tag',
  }),
  options: Object.freeze({
    view: Object.freeze({ grid: 'Grid', list: 'List' }),
    gridStyle: Object.freeze({ uncropped: 'Uncropped', cropped: 'Cropped' }),
    sort: Object.freeze({
      updated: 'Recently updated',
      created: 'Recently created',
      title: 'Title',
    }),
    order: Object.freeze({ asc: 'Ascending', desc: 'Descending' }),
  }),
});

function resolveNotice(code) {
  return Object.prototype.hasOwnProperty.call(NOTICES, code) ? NOTICES[code] : null;
}

function readProjectEditReturnLocation(candidate, projectId) {
  if (!isSafeRedirectTarget(candidate)) return '';

  try {
    const url = new URL(candidate, 'http://creatorcrate.local');
    // Project Assets and the Projects page (whose List information cards
    // invoke Edit Project) are the only hosts the dialog returns to.
    if (url.origin !== 'http://creatorcrate.local'
      || (url.pathname !== `/projects/${projectId}/assets` && url.pathname !== '/projects')) return '';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '';
  }
}

function buildProjectEditDialogUrl(projectId, returnLocation) {
  const query = new URLSearchParams({ edit: '1' });
  if (returnLocation) query.set('returnTo', returnLocation);
  return `/projects/${projectId}?${query}`;
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

  // WP10b read-only authority: the current saved-state metadata, for
  // reopening Filters & Defaults or reconciling an uncertain Save / Reset
  // defaults outcome. It never writes. A non-JSON request (a typed URL) opens
  // Projects with the dialog instead.
  router.get('/defaults', (req, res, next) => {
    if (!isEnhancedProjectsNsfwRequest(req)) {
      res.redirect('/projects?defaults=1');
      return;
    }
    try {
      const pageDefaultsService = getPageDefaultsService(req);
      res.set('Cache-Control', 'no-store');
      res.json({
        status: 'success',
        authority: buildProjectsDefaultsAuthority(
          pageDefaultsService,
          buildProjectsDefaultOptionCatalogues(pageDefaultsService, getProjectTagFilterOptions(workflowQueryService)),
        ),
      });
    } catch (err) {
      next(err);
    }
  });

  // A stale or missing generation: nothing was written (the fence threw
  // inside the write transaction, which rolled back). JSON clients get a
  // correlated 409 with the current authority when it can be read; a native
  // post re-renders Projects with the conflict, never a success redirect.
  function respondProjectsDefaultsConflict(req, res, { kind, mutation, err, enhanced, optionCatalogues }) {
    if (enhanced) {
      let authority = null;
      try {
        authority = buildProjectsDefaultsAuthority(getPageDefaultsService(req), optionCatalogues);
      } catch {
        authority = null;
      }
      res.status(409).json({
        ...projectsDefaultsOperationAcknowledgement(kind, mutation, {
          result: 'conflict', generation: err.currentGeneration,
        }),
        status: 'error',
        code: PROJECTS_DEFAULTS_CONFLICT_CODE,
        message: PROJECTS_DEFAULTS_CONFLICT_MESSAGE,
        ...(authority && authority.generation === err.currentGeneration ? { authority } : {}),
      });
      return;
    }
    renderProjectsPage(req, res, {
      appName,
      projectService,
      workflowQueryService,
      status: 409,
      projectsDefaultsDialogOpen: true,
      allowSavedDefaultsRedirect: false,
      listQuery: readProjectsReturnQuery(req),
      notice: { variant: 'error', text: PROJECTS_DEFAULTS_CONFLICT_MESSAGE },
    });
  }

  router.post('/defaults', (req, res, next) => {
    const pageDefaultsService = getPageDefaultsService(req);
    const optionCatalogues = buildProjectsDefaultOptionCatalogues(
      pageDefaultsService,
      getProjectTagFilterOptions(workflowQueryService),
    );
    const mutation = readProjectsDefaultsMutationRequest(req);
    handlePageDefaultsPost(req, res, next, {
      db,
      pageDefaultsService,
      page: PROJECTS_PAGE_DEFAULTS,
      successMessage: NOTICES.projects_defaults_saved.text,
      saveErrorMessage: 'Projects defaults could not be saved. No changes were made.',
      validateSubmission: () => ({ generation: null }),
      // The generation fence runs inside the same transaction as the seven
      // writes; a stale generation throws before anything is written, and any
      // later failure rolls the generation back with the writes.
      saveValidatedValues: ({ validatedValues, submission }) => {
        submission.generation = pageDefaultsService.advanceMutationGeneration(
          PROJECTS_PAGE_DEFAULTS, mutation.expectedGeneration,
        );
        for (const option of PROJECTS_DEFAULT_FIELDS) {
          const optionCatalogue = optionCatalogues?.[option];
          if (optionCatalogue !== undefined) {
            pageDefaultsService.saveDefault(PROJECTS_PAGE_DEFAULTS, option, validatedValues[option], optionCatalogue);
          } else {
            pageDefaultsService.saveDefault(PROJECTS_PAGE_DEFAULTS, option, validatedValues[option]);
          }
        }
      },
      enhancedOperationPayload: ({ outcome, submission }) => projectsDefaultsOperationAcknowledgement('save', mutation, {
        result: outcome,
        generation: outcome === 'committed' ? submission?.generation ?? null : null,
      }),
      handleSaveError: ({ err, enhanced }) => {
        if (!(err instanceof PageDefaultsGenerationConflictError)) return false;
        respondProjectsDefaultsConflict(req, res, { kind: 'save', mutation, err, enhanced, optionCatalogues });
        return true;
      },
      // The JSON acknowledgement carries the post-commit authority so the
      // client updates the saved-state indicator without a second request.
      enhancedSuccessPayload: () => ({
        authority: buildProjectsDefaultsAuthority(getPageDefaultsService(req), optionCatalogues),
      }),
      onValidationError: ({ submittedValues, errors }) => {
        renderProjectsPage(req, res, {
          appName,
          projectService,
          workflowQueryService,
          status: 422,
          projectsDefaultsDialogOpen: true,
          projectsDefaultsSubmittedValues: submittedValues,
          projectsDefaultsErrors: errors,
          allowSavedDefaultsRedirect: false,
          listQuery: readProjectsReturnQuery(req),
          notice: null,
        });
      },
      optionCatalogues,
      onSuccess: ({ validatedValues }) => {
        res.redirect(buildProjectsDefaultsSuccessUrl(validatedValues, readProjectsReturnQuery(req)));
      },
    });
  });

  // WP10b Reset defaults: deletes only the allowlisted Projects keys (the
  // list comes from PAGE_DEFAULT_DEFINITIONS, never the request). Every other
  // page's defaults, Project Assets scoped defaults and app settings stay.
  // The refresh destination keeps the temporary context (repeated Projects,
  // Search) and lets every default-backed control resolve to its application
  // fallback, page 1.
  router.post('/defaults/reset', (req, res, next) => {
    const enhanced = isEnhancedProjectsNsfwRequest(req);
    const pageDefaultsService = getPageDefaultsService(req);
    const refreshUrl = buildProjectsTemporaryContextUrl(readProjectsReturnQuery(req));
    const mutation = readProjectsDefaultsMutationRequest(req);
    const optionCatalogues = () => buildProjectsDefaultOptionCatalogues(
      pageDefaultsService,
      getProjectTagFilterOptions(workflowQueryService),
    );

    let reset;
    let generation = null;
    try {
      // Fence and deletion in one transaction. A no-op Reset (no saved keys)
      // still advances the generation, so an older request prepared before
      // it is rejected as stale.
      reset = db.transaction(() => {
        generation = pageDefaultsService.advanceMutationGeneration(
          PROJECTS_PAGE_DEFAULTS, mutation.expectedGeneration,
        );
        return pageDefaultsService.resetGlobalPageDefaults(PROJECTS_PAGE_DEFAULTS);
      })();
    } catch (err) {
      if (err instanceof PageDefaultsGenerationConflictError) {
        let catalogues = {};
        try {
          catalogues = optionCatalogues();
        } catch {
          catalogues = {};
        }
        respondProjectsDefaultsConflict(req, res, {
          kind: 'resetDefaults', mutation, err, enhanced, optionCatalogues: catalogues,
        });
        return;
      }
      if (enhanced) {
        res.status(500).json({
          ...projectsDefaultsOperationAcknowledgement('resetDefaults', mutation, { result: 'failed' }),
          status: 'error',
          message: 'Projects defaults could not be reset. No changes were made.',
        });
        return;
      }
      next(err);
      return;
    }

    if (!enhanced) {
      res.redirect(refreshUrl);
      return;
    }

    try {
      res.json({
        ...projectsDefaultsOperationAcknowledgement('resetDefaults', mutation, { result: 'committed', generation }),
        status: 'success',
        message: PROJECTS_DEFAULTS_RESET_MESSAGE,
        reset,
        refreshUrl,
        authority: buildProjectsDefaultsAuthority(pageDefaultsService, optionCatalogues()),
      });
    } catch {
      // The deletion committed; only the follow-up read failed. Say so rather
      // than claiming nothing changed, so the client never repeats it.
      res.status(500).json({
        ...projectsDefaultsOperationAcknowledgement('resetDefaults', mutation, { result: 'committed', generation }),
        status: 'error',
        committed: true,
        message: 'Projects defaults were reset, but the updated defaults could not be read. Reload the page.',
        reset,
        refreshUrl,
      });
    }
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
      res.render('projects/form.njk', {
        appName,
        project: null,
        ...buildNewProjectFormModel({
          tagService: getTagService(req),
          pageDefaultsService: getPageDefaultsService(req),
          query: req.query || {},
        }),
        action: 'Create',
        submitUrl: '/projects',
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', (req, res, next) => {
    const parsedTags = parseProjectFormTagIds(req.body?.tagIds);

    try {
      if (!parsedTags.valid) {
        throw new ProjectValidationError({ tagIds: parsedTags.error });
      }
      validateSubmittedTagsExist(req, parsedTags);
      const input = parseProjectInput(req.body);
      const project = projectService.create(input, { tagIds: parsedTags.tagIds });
      if (isEnhancedProjectCreateRequest(req)) {
        // The New Project dialog stays on its host page; the next open starts
        // from the page's fresh New Project defaults again.
        res.status(201).json({
          status: 'success',
          message: `Project “${project.title}” created.`,
          project: { id: project.id, title: project.title, url: `/projects/${project.id}` },
          values: buildProjectCreateResetValues(req),
        });
        return;
      }
      res.redirect(`/projects/${project.id}`);
    } catch (err) {
      if (isEnhancedProjectCreateRequest(req)) {
        const validation = err instanceof ProjectValidationError;
        res.status(validation ? 422 : 500).json({
          status: 'error',
          message: validation
            ? (err.errors?.general || 'Fix the highlighted fields and try again.')
            : 'Project creation failed. Please try again.',
          errors: validation ? err.errors : {},
        });
        return;
      }
      if (err instanceof ProjectValidationError) {
        renderProjectCreateError(req, res, next, {
          appName,
          projectService,
          workflowQueryService,
          status: 422,
          errors: err.errors,
          parsedTags,
        });
        return;
      }
      // Filesystem or other error: render form with safe message + preserved values
      renderProjectCreateError(req, res, next, {
        appName,
        projectService,
        workflowQueryService,
        status: 500,
        errors: { general: 'Project creation failed. Please try again.' },
        parsedTags,
      });
    }
  });

  router.get('/:id', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    if (!renderProjectDetailPage(req, res, {
      appName,
      workflowQueryService,
      id,
      projectEditDialogOpen: req.query.edit === '1',
      projectEditReturnTo: readProjectEditReturnLocation(req.query.returnTo, id),
    })) {
      return next(createNotFound());
    }
  });

  router.get('/:id/edit', (req, res, next) => {
    // The Edit Project dialog asks with Accept: application/json for the
    // authoritative edit model; other requests keep the deep-link redirect.
    const json = isEnhancedProjectEditRequest(req);
    if (json) {
      res.vary('Accept');
      res.set('Cache-Control', 'no-store');
    }
    const id = parseId(req.params.id);
    if (id === null) {
      return json ? sendProjectNotFoundJson(res) : next(createNotFound());
    }

    const project = projectService.findById(id);
    if (!project) {
      return json ? sendProjectNotFoundJson(res) : next(createNotFound());
    }

    // Archived projects are immutable. The edit form would render but POST
    // would still reject archived_at, so block access to the form itself
    // and route the user back to the detail page (read-only workspace).
    if (isProjectArchived(project)) {
      return json
        ? sendProjectEditJsonError(res, 409, 'PROJECT_ARCHIVED', 'Archived projects are read-only.')
        : res.redirect(`/projects/${project.id}`);
    }

    if (json) {
      return res.json({ status: 'success', ...buildProjectEditModel(req, project) });
    }

    const returnLocation = readProjectEditReturnLocation(req.query.returnTo, project.id);
    return res.redirect(buildProjectEditDialogUrl(project.id, returnLocation));
  });

  router.post('/:id', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    const parsedTags = parseProjectFormTagIds(req.body?.tagIds);
    const projectEditReturnTo = readProjectEditReturnLocation(req.body?.returnTo, id);
    const json = isEnhancedProjectEditRequest(req);

    try {
      if (!parsedTags.valid) {
        throw new ProjectValidationError({ tagIds: parsedTags.error });
      }
      validateSubmittedTagsExist(req, parsedTags);
      const input = parseProjectInput(req.body);
      const project = projectService.update(id, input, { tagIds: parsedTags.tagIds });
      if (!project) {
        return json ? sendProjectNotFoundJson(res) : next(createNotFound());
      }
      if (json) {
        // The Edit Project dialog stays on its host page and adopts the saved
        // model as its baseline; the host refreshes its own project content.
        return res.json({
          status: 'success',
          message: 'Project updated.',
          ...buildProjectEditModel(req, project),
        });
      }
      res.redirect(projectEditReturnTo || `/projects/${project.id}`);
    } catch (err) {
      if (json) {
        return sendProjectUpdateJsonError(res, err);
      }
      if (err instanceof ProjectNotFoundError) {
        return next(createNotFound());
      }
      if (err instanceof ProjectValidationError) {
        if (!renderProjectDetailPage(req, res, {
          appName,
          workflowQueryService,
          id,
          status: 422,
          projectEditDialogOpen: true,
          projectEditReturnTo,
          projectEditForm: {
            values: createFormValues(req.body),
            errors: err.errors,
            statuses: getProjectFormStatusOptions(req),
            projectTypes: getProjectFormTypeOptions(req),
            tags: loadAvailableTags(req),
            selectedTagIds: buildSubmittedSelectedTagIds(parsedTags),
          },
        })) {
          return next(createNotFound());
        }
        return;
      }
      // A known ownership refusal (e.g. renaming an unrecovered project's
      // folder) is a state conflict reported with its path-free message via
      // the error's own status; anything else is an internal failure. Either
      // way, render the detail dialog with a safe message and preserved values.
      const ownershipRefused = err instanceof ProjectOwnershipError;
      const existing = projectService.findById(id);
      if (!existing || !renderProjectDetailPage(req, res, {
        appName,
        workflowQueryService,
        id,
        status: ownershipRefused ? err.status : 500,
        projectEditDialogOpen: true,
        projectEditReturnTo,
        projectEditForm: {
          values: createFormValues(req.body),
          errors: { general: ownershipRefused ? err.message : 'Project update failed. Please try again.' },
          statuses: getProjectFormStatusOptions(req),
          projectTypes: getProjectFormTypeOptions(req),
          tags: loadAvailableTags(req),
          selectedTagIds: buildSubmittedSelectedTagIds(parsedTags),
        },
      })) {
        return next(createNotFound());
      }
    }
  });

  router.post('/:id/archive', (req, res, next) => {
    const id = parseId(req.params.id);
    // The Edit Project dialog archives in place (Accept: application/json);
    // any other request keeps the native redirect and error pages below.
    if (isEnhancedProjectEditRequest(req)) {
      return handleProjectArchiveJson(res, projectService, id);
    }
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

  router.post('/:id/delete', (req, res, next) => {
    const id = parseId(req.params.id);
    // The Edit Project dialog deletes in place (Accept: application/json);
    // any other request keeps the native redirect and error pages below.
    if (isEnhancedProjectEditRequest(req)) {
      return handleProjectDeleteJson(res, projectService, id);
    }
    if (id === null) {
      return next(createNotFound());
    }

    try {
      projectService.deleteProject(id);
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

function renderProjectDetailPage(req, res, {
  appName,
  workflowQueryService,
  id,
  status = 200,
  projectEditDialogOpen = false,
  projectEditReturnTo = '',
  projectEditForm: submittedProjectEditForm = null,
} = {}) {
  const workspace = workflowQueryService.getProjectWorkspace(id);
  if (!workspace) return false;

  const assignedProjectTags = getProjectTagService(req).listProjectTags(id);
  const nsfwFilterEnabled = getNsfwFilterSettingsService(req).isEnabled();
  const optionPresentation = getProjectOptionPresentation(req);
  const projectTags = assignedProjectTags
    .map((tag) => ({ displayName: tag.display_name }));
  const projectArchived = isProjectArchived(workspace.project);
  const projectEditForm = projectArchived
    ? null
    : submittedProjectEditForm || {
      values: projectToFormValues(workspace.project),
      errors: {},
      statuses: getProjectFormStatusOptions(req),
      projectTypes: getProjectFormTypeOptions(req),
      tags: loadAvailableTags(req),
      selectedTagIds: assignedProjectTags.map((tag) => String(tag.id)),
    };
  if (submittedProjectEditForm && projectEditForm) {
    projectEditForm.resetValues = {
      ...projectToFormValues(workspace.project),
      'tagIds[]': assignedProjectTags.map((tag) => String(tag.id)),
    };
  }

  const project = presentProjectOptions(
    withNsfwBlur(workspace.project, assignedProjectTags, nsfwFilterEnabled),
    optionPresentation,
  );

  res.status(status).render('projects/detail.njk', {
    appName,
    project,
    relatedNotes: buildProjectRelatedNotes(req, workflowQueryService, id, {
      projectNsfw: project.nsfwBlur,
      nsfwFilterEnabled,
    }),
    releaseSummary: workspace.releaseSummary,
    assetHealth: workspace.assetHealth,
    projectTags,
    projectEditForm,
    projectEditDialogOpen: Boolean(!projectArchived && projectEditDialogOpen),
    projectEditReturnTo,
    openLocallyUri: buildOpenLocallyUri({
      windowsRoot: getOpenLocallySettingsService(req).getWindowsProjectsPath(),
      projectDir: workspace.project.project_dir,
    }),
    notice: resolveNotice(req.query.notice),
    ownershipNotice: getProjectOwnershipAttention(req, id),
  });
  return true;
}

// Related Notes on Project Detail. A failed read becomes an inline
// "unavailable" state (never an empty section) and is logged without
// exposing its detail to the page. NSFW blur follows the Notes asset policy:
// the asset's own tags or this Project's tags.
function buildProjectRelatedNotes(req, workflowQueryService, projectId, { projectNsfw, nsfwFilterEnabled }) {
  const locals = req.app?.locals ?? {};
  return buildProjectRelatedNotesModel({
    projectId,
    noteService: locals.noteService,
    markdownRenderer: locals.markdownRenderer,
    workflowQueryService,
    isNsfwAsset: (asset) => Boolean(nsfwFilterEnabled && (projectNsfw
      || (Array.isArray(asset.tags) && asset.tags.some(isNsfwTag)))),
    logError: (error) => {
      try {
        locals.applicationLogger?.error?.({
          kind: 'diagnostic',
          subsystem: 'projects',
          event: 'project_detail.related_notes_failed',
          message: 'Project Detail could not read its related Notes.',
          error,
        });
      } catch {
        // Diagnostic logging must never replace the rendered page.
      }
    },
  });
}

// PM-1C2B: SQLite-only ownership hint; never reads the project folder.
function getProjectOwnershipAttention(req, projectId) {
  return req.app?.locals?.projectOwnershipRecoveryService?.getAttentionHint?.(projectId) ?? null;
}

function getPageDefaultsService(req) {
  const service = req.app?.locals?.pageDefaultsService;
  if (!service) {
    throw new Error('Projects list requires app.locals.pageDefaultsService.');
  }
  return service;
}

function queryFromSearchParams(searchParams) {
  const query = {};
  for (const [key, value] of searchParams) {
    if (!Object.hasOwn(query, key)) {
      query[key] = value;
    } else if (Array.isArray(query[key])) {
      query[key].push(value);
    } else {
      query[key] = [query[key], value];
    }
  }
  return query;
}

function readProjectCreateDialogContext(body) {
  const candidate = body?.returnTo;
  if (candidate === '/') return { host: '/', invocationReturnTo: '', listQuery: null };
  if (!isSafeRedirectTarget(candidate)) return null;

  try {
    const url = new URL(candidate, 'http://creatorcrate.local');
    if (url.origin !== 'http://creatorcrate.local' || url.pathname !== '/projects') return null;
    return {
      host: '/projects',
      invocationReturnTo: `${url.pathname}${url.search}${url.hash}`,
      listQuery: queryFromSearchParams(url.searchParams),
    };
  } catch {
    return null;
  }
}

function renderProjectCreateError(req, res, next, {
  appName,
  projectService,
  workflowQueryService,
  status,
  errors,
  parsedTags,
}) {
  const createDialogContext = readProjectCreateDialogContext(req.body);
  const projectCreateForm = {
    ...buildNewProjectFormModel({
      tagService: getTagService(req),
      pageDefaultsService: getPageDefaultsService(req),
      values: req.body,
      errors,
      selectedTagIds: buildSubmittedSelectedTagIds(parsedTags),
    }),
    invocationReturnTo: createDialogContext?.invocationReturnTo || '',
  };

  switch (createDialogContext?.host) {
    case '/':
      renderDashboardPage(req, res, next, {
        appName,
        workflowQueryService,
        projectService,
        status,
        projectCreateDialogOpen: true,
        projectCreateForm,
      });
      return;
    case '/projects':
      renderProjectsPage(req, res, {
        appName,
        projectService,
        workflowQueryService,
        status,
        notice: null,
        projectCreateDialogOpen: true,
        projectCreateForm,
        allowSavedDefaultsRedirect: false,
        listQuery: createDialogContext.listQuery,
      });
      return;
    default:
      res.status(status).render('projects/form.njk', {
        appName,
        project: null,
        ...projectCreateForm,
        action: 'Create',
        submitUrl: '/projects',
      });
  }
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
  projectCreateDialogOpen = false,
  projectCreateForm,
  allowSavedDefaultsRedirect = req.query.defaults !== '1',
  listQuery = req.query,
} = {}) {
  const pageDefaultsService = getPageDefaultsService(req);
  const availableTagOptions = getProjectTagFilterOptions(workflowQueryService);
  const projectsDefaultOptionCatalogues = buildProjectsDefaultOptionCatalogues(
    pageDefaultsService,
    availableTagOptions,
  );
  const parsedQuery = parseListQuery(
    listQuery,
    pageDefaultsService,
    availableTagOptions,
    projectsDefaultOptionCatalogues,
  );
  const tagOptions = availableTagOptions.map((option) => ({
    ...option,
    selected: parsedQuery.tagIds.includes(Number(option.value)),
  }));
  const projectTypeOptions = buildProjectTypeFilterOptions(
    projectsDefaultOptionCatalogues.projectType,
    parsedQuery.projectTypes,
  );
  const projectListOptions = { ...parsedQuery };
  const { total } = projectService.list({ ...projectListOptions, limit: 0 });
  const { total: totalProjects } = projectService.list({ includeArchived: true, limit: 0 });
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(parsedQuery.page, pageCount);
  if (allowSavedDefaultsRedirect && shouldRedirectToSavedDefaults(listQuery, parsedQuery, pageDefaultsService)) {
    return res.redirect(buildSavedDefaultsUrl(req, parsedQuery, currentPage, pageDefaultsService));
  }

  const offset = (currentPage - 1) * PAGE_SIZE;
  const nsfwFilterEnabled = getNsfwFilterSettingsService(req).isEnabled();
  const { rows } = workflowQueryService.getProjectList({
    ...projectListOptions,
    offset,
    limit: PAGE_SIZE,
    knownTotal: total,
    includeGridInformation: true,
  });
  const optionPresentation = getProjectOptionPresentation(req);
  const pageUrl = buildPageUrl(req, parsedQuery, currentPage, pageDefaultsService, listQuery);
  const filtersActive = Boolean(
    parsedQuery.search || parsedQuery.statuses.length > 0 || parsedQuery.projectTypes.length > 0
      || parsedQuery.tagIds.length > 0 || parsedQuery.projectIds.length > 0,
  );
  const projectOptions = workflowQueryService.getProjectsPageFilterOptions();
  // Legacy single-select state: only a single selected active Project.
  const selectedProject = projectOptions.find((project) => project.id === parsedQuery.projectId) || null;
  const projectFilter = buildProjectFilterModel(projectService, projectOptions, parsedQuery.projectIds);
  const gridStyle = pageDefaultsService.resolve('projects', 'gridStyle');
  // WP10b: the authority JSON of this rendered page (saved-key presence,
  // generation, effective current values of the seven saveable settings).
  // A read failure fails closed: the dialog cannot save without it.
  let projectsDefaultsAuthority = null;
  try {
    projectsDefaultsAuthority = buildProjectsDefaultsAuthority(pageDefaultsService, projectsDefaultOptionCatalogues, {
      current: {
        view: parsedQuery.view,
        gridStyle,
        sort: parsedQuery.sortBy,
        order: parsedQuery.order,
        status: toProjectsDefaultsMultiValue(parsedQuery.statuses),
        projectType: toProjectsDefaultsMultiValue(parsedQuery.projectTypes),
        tag: toProjectsDefaultsMultiValue(parsedQuery.tagIds),
      },
      currentUrl: pageUrl({}),
    });
  } catch {
    projectsDefaultsAuthority = null;
  }

  return res.status(status).render('projects/index.njk', {
    appName,
    projects: rows.map((project) => presentProjectOptions(
      withNsfwBlur(project, project.tags, nsfwFilterEnabled),
      optionPresentation,
    )),
    total,
    hasAnyProjects: totalProjects > 0,
    filtersActive,
    resetFiltersUrl: '/projects',
    page: currentPage,
    pageSize: PAGE_SIZE,
    pageCount,
    pageUrl,
    preserveViewQuery: shouldPreserveViewQuery(listQuery, parsedQuery, pageDefaultsService),
    query: {
      search: parsedQuery.search,
      statuses: parsedQuery.statuses,
      projectTypes: parsedQuery.projectTypes,
      tagIds: parsedQuery.tagIds.map(String),
      projectId: parsedQuery.projectId,
      projectIds: parsedQuery.projectIds.map(String),
      sort: parsedQuery.sortBy,
      order: parsedQuery.order,
      view: parsedQuery.view,
    },
    view: parsedQuery.view,
    gridStyle,
    projectsDefaultsAuthority,
    projectsDefaultsAuthorityJson: projectsDefaultsAuthority
      ? serializeProjectsAuthorityJson(projectsDefaultsAuthority)
      : '',
    statuses: projectsDefaultOptionCatalogues.status
      .map(({ value }) => value)
      .filter((value) => value !== 'all'),
    statusOptions: buildStatusFilterOptions(
      projectsDefaultOptionCatalogues.status,
      parsedQuery.statuses,
    ),
    projectTypeOptions,
    sortOptions: SORT_OPTIONS,
    tagOptions,
    projectOptions,
    selectedProject,
    projectFilterOptions: projectFilter.options,
    projectFilterSelectedValues: projectFilter.selectedValues,
    projectFilterUnavailableValues: projectFilter.unavailableValues,
    notice,
    nsfwFilterEnabled,
    projectsNsfwReturnUrl: pageUrl({}),
    projectsDefaults: buildPageDefaultsDialogModel({
      pageDefaultsService,
      page: 'projects',
      labels: PROJECTS_DEFAULT_LABELS,
      submittedValues: projectsDefaultsSubmittedValues,
      errors: projectsDefaultsErrors,
      optionCatalogues: projectsDefaultOptionCatalogues,
    }),
    projectsDefaultsDialogOpen: Boolean(projectsDefaultsDialogOpen),
    projectCreateDialogOpen: Boolean(projectCreateDialogOpen),
    projectCreateForm: projectCreateForm || buildNewProjectFormModel({
      tagService: getTagService(req),
      pageDefaultsService,
    }),
    projectEditForm: buildProjectEditDialogFormModel({
      tagService: getTagService(req),
      pageDefaultsService,
    }),
  });
}

function isEnhancedProjectCreateRequest(req) {
  return String(req.get?.('Accept') || '').toLowerCase().includes('application/json');
}

// Every user-editable New Project control, so a dialog reopened after a
// successful create starts blank with the saved New Project defaults.
function buildProjectCreateResetValues(req) {
  const { values } = buildNewProjectFormModel({
    tagService: getTagService(req),
    pageDefaultsService: getPageDefaultsService(req),
  });
  return {
    title: '',
    description: '',
    notes: '',
    patreonUrl: '',
    status: values.status,
    projectType: values.projectType,
    'tagIds[]': [],
  };
}

function isEnhancedProjectEditRequest(req) {
  return String(req.get?.('Accept') || '').toLowerCase().includes('application/json');
}

/**
 * Authoritative state for populating an Edit Project dialog on any host.
 * values holds every editable field (tags included), since a save sends the
 * whole form; tagOptions lists every tag, so a tag assigned elsewhere after
 * the host rendered stays selectable and is never dropped by a save.
 */
function buildProjectEditModel(req, project) {
  const values = projectToFormValues(project);
  return {
    project: { id: project.id, title: project.title, url: `/projects/${project.id}` },
    values: {
      title: values.title ?? '',
      description: values.description ?? '',
      notes: values.notes ?? '',
      patreonUrl: values.patreonUrl,
      status: values.status ?? '',
      projectType: values.projectType ?? '',
      'tagIds[]': loadAssignedTagIds(req, project.id),
    },
    tagOptions: loadAvailableTags(req).map((tag) => ({ value: String(tag.id), label: tag.displayName })),
    actions: {
      update: `/projects/${project.id}`,
      archive: `/projects/${project.id}/archive`,
      delete: `/projects/${project.id}/delete`,
    },
  };
}

function sendProjectEditJsonError(res, status, code, message, extra = {}) {
  return res.status(status).json({ status: 'error', code, message, ...extra });
}

function sendProjectNotFoundJson(res) {
  return sendProjectEditJsonError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
}

// The confirmed archive state of a project record, for the Archive JSON
// answers; nothing beyond what the record itself holds.
function presentArchivedProject(project) {
  return {
    id: project.id,
    title: project.title,
    url: `/projects/${project.id}`,
    archived: isProjectArchived(project),
    archivedAt: project.archived_at ?? null,
    status: project.status,
  };
}

/**
 * The enhanced Archive (Edit Project dialog). The service, its rules and its
 * activity log are unchanged; this only says what happened:
 * - 200 outcome 'archived': this request archived the project.
 * - 409 PROJECT_ALREADY_ARCHIVED, outcome 'refused': it was archived before
 *   this request (the service refuses a second archive); nothing changed.
 * - 404 PROJECT_NOT_FOUND, outcome 'refused': no such project.
 * - 500 PROJECT_ARCHIVE_FAILED, outcome 'failed': the service failed and the
 *   record, read again in the same synchronous request, is still active, so
 *   nothing was archived.
 * - 500 PROJECT_ARCHIVE_UNKNOWN, outcome 'unknown': the service failed and
 *   the record could not be shown to be unchanged.
 * Messages never carry backend detail.
 */
function handleProjectArchiveJson(res, projectService, id) {
  res.set('Cache-Control', 'no-store');
  const refuse = (status, code, message, extra = {}) => sendProjectEditJsonError(res, status, code, message, {
    outcome: 'refused', ...extra,
  });
  if (id === null) return refuse(404, 'PROJECT_NOT_FOUND', 'Project not found.');

  let existing;
  try {
    existing = projectService.findById(id);
  } catch {
    // Nothing has been attempted yet.
    return sendProjectEditJsonError(res, 500, 'PROJECT_ARCHIVE_FAILED', 'Project archive failed. Please try again.', { outcome: 'failed' });
  }
  if (!existing) return refuse(404, 'PROJECT_NOT_FOUND', 'Project not found.');
  if (isProjectArchived(existing)) {
    return refuse(409, 'PROJECT_ALREADY_ARCHIVED', 'This project was already archived. Nothing was changed.', {
      projectId: existing.id,
      project: presentArchivedProject(existing),
    });
  }

  try {
    const archived = projectService.archive(id);
    if (!archived || !isProjectArchived(archived)) throw new Error('Archive returned no archived record.');
    return res.json({
      status: 'success',
      outcome: 'archived',
      message: `Project “${archived.title}” archived.`,
      projectId: archived.id,
      project: presentArchivedProject(archived),
      urls: { project: `/projects/${archived.id}`, projects: '/projects' },
      refreshRequired: true,
    });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return refuse(404, 'PROJECT_NOT_FOUND', 'Project not found.');
    // The service and its database are synchronous, so no other request ran
    // between its failure and this read: a still-active record proves that
    // nothing was archived. Anything else is not proof either way.
    let current = null;
    try { current = projectService.findById(id); } catch { current = null; }
    if (current && !isProjectArchived(current)) {
      return sendProjectEditJsonError(res, 500, 'PROJECT_ARCHIVE_FAILED',
        'Project archive failed. Nothing was archived. Please try again.', { outcome: 'failed', projectId: current.id });
    }
    return sendProjectEditJsonError(res, 500, 'PROJECT_ARCHIVE_UNKNOWN',
      'Could not confirm whether the project was archived.', { outcome: 'unknown', projectId: id });
  }
}

// WP11A-2: the enhanced Project Delete (Edit Project dialog). The service,
// its rules (any existing project, archived or not; its releases go with it;
// the folder only through the ownership-verified quarantine) and its activity
// log are unchanged. `outcome` says only what the service established, never
// what an HTTP status alone suggests:
//   deleted                     200 — the project row (and its releases)
//                                     committed as deleted and the staged folder
//                                     was removed (cleanup 'complete').
//   refused                     404 PROJECT_NOT_FOUND / 409 PROJECT_OWNERSHIP —
//                                     refused before anything was deleted; an
//                                     ownership refusal leaves the folder where
//                                     it was (or puts it back).
//   failed                      500 PROJECT_DELETE_FAILED — nothing was
//                                     deleted: staging failed before any move,
//                                     or the folder was put back and the
//                                     database deletion rolled back.
//   deleted-cleanup-incomplete  500 PROJECT_DELETE_CLEANUP_INCOMPLETE — the
//                                     project is deleted, but its staged folder
//                                     could not be removed (recoveryRequired).
//   recovery-required           500 PROJECT_DELETE_RECOVERY_REQUIRED — the
//                                     project was not deleted, but its staged
//                                     folder could not be put back.
//   unknown                     500 PROJECT_DELETE_UNKNOWN — anything else.
// Each service outcome is cross-checked against the project row, read again in
// the same synchronous request (the service and the database are synchronous,
// so no other request runs in between); a contradiction is 'unknown'.
// Messages are fixed: no path, staging name, SQL or stack is ever sent.
const PROJECT_DELETE_DESTINATION = '/projects';
const PROJECT_DELETE_JSON_MESSAGES = Object.freeze({
  missing: 'This project no longer exists. Nothing was deleted by this request.',
  failed: 'The project could not be deleted. Nothing was deleted, and its folder is where it was. Please try again.',
  cleanupIncomplete: 'was deleted, but its folder could not be fully removed from the projects folder. '
    + 'It needs recovery: check the projects folder for a hidden leftover folder. Nothing will be retried automatically.',
  recoveryRequired: 'The project was not deleted, but its folder could not be put back where it was after the deletion failed. '
    + 'It needs recovery before this project can be changed. Nothing will be retried automatically.',
  unknown: 'Could not confirm whether the project was deleted.',
});

/** 'present' | 'absent' | 'unknown' — a read-only observation of one project row. */
function readProjectRowPresence(projectService, id) {
  try {
    return projectService.findById(id) ? 'present' : 'absent';
  } catch {
    return 'unknown';
  }
}

function handleProjectDeleteJson(res, projectService, id) {
  res.set('Cache-Control', 'no-store');
  const send = (status, code, outcome, message, extra = {}) => sendProjectEditJsonError(res, status, code, message, {
    outcome, ...extra,
  });
  const missing = () => send(404, 'PROJECT_NOT_FOUND', 'refused', PROJECT_DELETE_JSON_MESSAGES.missing);
  if (id === null) return missing();

  let existing;
  try {
    existing = projectService.findById(id);
  } catch {
    // Nothing has been attempted yet.
    return send(500, 'PROJECT_DELETE_FAILED', 'failed', PROJECT_DELETE_JSON_MESSAGES.failed, { projectId: id });
  }
  if (!existing) return missing();
  const title = existing.title;
  const deletedProject = { id: existing.id, title, deleted: true };
  const terminal = {
    projectId: existing.id,
    project: deletedProject,
    // The project's own pages (Project Detail, Project Assets) no longer
    // exist; this is the native Delete's own destination.
    projectPagesRemain: false,
    redirect: PROJECT_DELETE_DESTINATION,
  };

  try {
    projectService.deleteProject(id);
  } catch (err) {
    const row = readProjectRowPresence(projectService, id);
    const unknown = () => send(500, 'PROJECT_DELETE_UNKNOWN', 'unknown', PROJECT_DELETE_JSON_MESSAGES.unknown, { projectId: existing.id });
    if (err instanceof ProjectNotFoundError) return row === 'absent' ? missing() : unknown();
    if (err instanceof ProjectOwnershipError) {
      return row === 'present'
        ? send(err.status || 409, 'PROJECT_OWNERSHIP', 'refused', `${err.message} Nothing was deleted.`, { projectId: existing.id })
        : unknown();
    }
    if (err instanceof ProjectDeletionError) {
      if (err.outcome === 'cleanup_incomplete' && row === 'absent') {
        return send(500, 'PROJECT_DELETE_CLEANUP_INCOMPLETE', 'deleted-cleanup-incomplete',
          `Project “${title}” ${PROJECT_DELETE_JSON_MESSAGES.cleanupIncomplete}`, {
            ...terminal, recoveryRequired: true, cleanup: 'incomplete',
          });
      }
      if (err.outcome === 'recovery_required' && row === 'present') {
        return send(500, 'PROJECT_DELETE_RECOVERY_REQUIRED', 'recovery-required',
          PROJECT_DELETE_JSON_MESSAGES.recoveryRequired, { projectId: existing.id, recoveryRequired: true });
      }
      if ((err.outcome === 'restored' || err.outcome === 'not_changed') && row === 'present') {
        return send(500, 'PROJECT_DELETE_FAILED', 'failed', PROJECT_DELETE_JSON_MESSAGES.failed, { projectId: existing.id });
      }
    }
    return unknown();
  }

  // The service returned normally only after the database deletion committed
  // and any staged folder was removed.
  if (readProjectRowPresence(projectService, id) !== 'absent') {
    return send(500, 'PROJECT_DELETE_UNKNOWN', 'unknown', PROJECT_DELETE_JSON_MESSAGES.unknown, { projectId: existing.id });
  }
  return res.json({
    status: 'success',
    outcome: 'deleted',
    message: `Project “${title}” deleted.`,
    cleanup: 'complete',
    ...terminal,
  });
}

// Validation (including the archived-project refusal) keeps its field and
// general messages; an ownership refusal keeps its path-free message and
// status; anything else is reported without backend detail. Every failure
// leaves the project as it was (the service compensates folder renames).
function sendProjectUpdateJsonError(res, err) {
  if (err instanceof ProjectNotFoundError) return sendProjectNotFoundJson(res);
  if (err instanceof ProjectValidationError) {
    return sendProjectEditJsonError(res, 422, 'PROJECT_INVALID',
      err.errors?.general || 'Fix the highlighted fields and try again.', { errors: err.errors || {} });
  }
  if (err instanceof ProjectOwnershipError) {
    return sendProjectEditJsonError(res, err.status || 409, 'PROJECT_OWNERSHIP', err.message, { errors: {} });
  }
  return sendProjectEditJsonError(res, 500, 'PROJECT_UPDATE_FAILED', 'Project update failed. Please try again.', { errors: {} });
}

function isEnhancedProjectsNsfwRequest(req) {
  return String(req.get?.('Accept') || '').toLowerCase().includes('application/json');
}

function readProjectsNsfwReturnUrl(req) {
  const candidate = typeof req.body?.returnTo === 'string' ? req.body.returnTo : '';
  if (candidate === '/') return '/';
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

// The Projects list query a defaults post returns to (its `returnTo`), as a
// parsed query object with repeated values kept as arrays.
function readProjectsReturnQuery(req) {
  const returnTo = readProjectsNsfwReturnUrl(req);
  try {
    return queryFromSearchParams(new URL(returnTo, 'http://creatorcrate.local').searchParams);
  } catch {
    return {};
  }
}

// The temporary (never saved) context of a Projects query: the repeated
// Project restriction and Search, in canonical form. Everything default-backed
// is left to resolve from the defaults, page 1.
function buildProjectsTemporaryContextUrl(rawQuery) {
  const query = rawQuery && typeof rawQuery === 'object' ? rawQuery : {};
  const params = new URLSearchParams();
  parseProjectFilterIds(query.project).forEach((id) => params.append('project', String(id)));
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) params.set('search', search);
  const text = params.toString();
  return text ? `/projects?${text}` : '/projects';
}

function readProjectsDefaultsMutationRequest(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const generation = body[PROJECTS_DEFAULTS_GENERATION_FIELD];
  const operation = body[PROJECTS_DEFAULTS_OPERATION_FIELD];
  const parsedGeneration = typeof generation === 'string' && /^(0|[1-9]\d*)$/.test(generation)
    ? Number(generation)
    : Number.NaN;
  return {
    // Missing or malformed: null, which never matches the stored generation.
    expectedGeneration: Number.isSafeInteger(parsedGeneration) ? parsedGeneration : null,
    operationId: typeof operation === 'string' && PROJECTS_DEFAULTS_OPERATION_PATTERN.test(operation)
      ? operation
      : null,
  };
}

// The request-correlated acknowledgement. `generation` is the stored
// generation this answer establishes: the new one after a commit, the current
// one on a conflict, and null when the handler made no claim about it.
function projectsDefaultsOperationAcknowledgement(kind, mutation, { result, generation = null }) {
  return {
    operation: {
      id: mutation.operationId,
      kind,
      result,
      committed: result === 'committed',
      expectedGeneration: mutation.expectedGeneration,
      generation,
    },
  };
}

function fingerprintText(text) {
  // FNV-1a (32-bit): a compact revision token, not a security boundary.
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function toProjectsDefaultsMultiValue(values) {
  return Array.isArray(values) && values.length > 0 ? values.map(String) : 'all';
}

/**
 * WP10b authoritative Projects defaults metadata. Saved status is stored key
 * presence (describeSavedDefaults), never a comparison with the fallback, so
 * an explicitly saved fallback-equal value still reports saved. Projects
 * defaults are Global only: there is no Project scope here.
 */
function buildProjectsDefaultsAuthority(pageDefaultsService, optionCatalogues, extra = {}) {
  const description = pageDefaultsService.describeSavedDefaults(PROJECTS_PAGE_DEFAULTS, optionCatalogues);
  const defaults = pageDefaultsService.resolveGlobalPageDefaults(PROJECTS_PAGE_DEFAULTS, optionCatalogues);
  const fallbacks = Object.fromEntries(PROJECTS_DEFAULT_FIELDS.map((field) => [
    field,
    pageDefaultsService.getFallback(PROJECTS_PAGE_DEFAULTS, field),
  ]));
  const saved = Object.fromEntries(PROJECTS_DEFAULT_FIELDS.map((field) => [field, {
    stored: description.options[field].global.stored,
    valid: description.options[field].global.valid,
  }]));
  const savedKeys = PROJECTS_DEFAULT_FIELDS.filter((field) => saved[field].stored);
  return {
    page: PROJECTS_PAGE_DEFAULTS,
    fields: [...PROJECTS_DEFAULT_FIELDS],
    multiFields: [...PROJECTS_MULTI_FIELDS],
    fallbacks,
    defaults,
    saved,
    savedKeys,
    hasSavedDefaults: savedKeys.length > 0,
    generation: pageDefaultsService.getMutationGeneration(PROJECTS_PAGE_DEFAULTS),
    revision: fingerprintText(JSON.stringify({ defaults, saved })),
    resetFiltersUrl: PROJECTS_RESET_FILTERS_URL,
    ...extra,
  };
}

function serializeProjectsAuthorityJson(authority) {
  return JSON.stringify(authority).replace(/</g, '\\u003c');
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

function buildProjectsDefaultOptionCatalogues(pageDefaultsService, tagOptions) {
  return {
    status: pageDefaultsService.getOptionCatalogue('projects', 'status'),
    projectType: pageDefaultsService.getOptionCatalogue('projects', 'projectType'),
    tag: [
      { value: 'all', label: 'All tags' },
      ...(Array.isArray(tagOptions) ? tagOptions : []).map(({ value, label, displayName }) => ({
        value,
        label: label ?? displayName,
      })),
    ],
  };
}

function buildProjectsDefaultsSuccessUrl(validatedValues, returnQuery = {}) {
  const params = new URLSearchParams();
  // The temporary context of the page the Save came from is kept as it was
  // (repeated Projects, Search) and is never persisted.
  const temporary = new URL(buildProjectsTemporaryContextUrl(returnQuery), 'http://creatorcrate.local').searchParams;
  for (const [key, value] of temporary) params.append(key, value);
  // Multivalue defaults: every saved selection becomes one repeated canonical
  // parameter (status=a&status=b), matching the filter form's own encoding.
  const appendSelection = (name, value) => {
    if (value === 'all') return;
    for (const item of Array.isArray(value) ? value : [value]) params.append(name, item);
  };
  appendSelection('status', validatedValues.status);
  appendSelection('type', validatedValues.projectType);
  appendSelection('tag', validatedValues.tag);
  params.set('sort', validatedValues.sort);
  params.set('order', validatedValues.order);
  params.set('view', validatedValues.view);
  params.set('notice', 'projects_defaults_saved');
  return `/projects?${params.toString()}`;
}

// The multi-select Project choices: every active Project from the unpaged
// option catalogue, plus each selected ID missing from it. A selected
// archived Project keeps its title (archived Projects are viewable on this
// page); an unknown or deleted ID stays a checked, ID-labelled unavailable
// choice. Selection never depends on the current 25-row page.
function buildProjectFilterModel(projectService, projectOptions, selectedProjectIds) {
  const selectedValues = selectedProjectIds.map(String);
  const activeValues = new Set(projectOptions.map((project) => String(project.id)));
  const missingOptions = selectedProjectIds
    .filter((id) => !activeValues.has(String(id)))
    .map((id) => {
      const project = projectService.findById(id);
      if (project) {
        const archived = isProjectArchived(project);
        return {
          value: String(id),
          label: project.title,
          selected: true,
          archived,
          // WP10b presentation only: the archived state reads beside the
          // title; the summary and value keep the real title and ID.
          ...(archived ? {
            suffix: 'Archived',
            classes: 'projects-project-option--archived',
            attributes: [['data-projects-archived-project', true]],
          } : {}),
        };
      }
      return {
        value: String(id),
        label: `Unavailable project (ID ${id})`,
        selected: true,
        unavailable: true,
        classes: 'projects-project-option--unavailable',
        attributes: [['data-projects-unavailable-project', true]],
      };
    });
  const options = [
    ...missingOptions,
    ...projectOptions.map((project) => ({
      value: String(project.id),
      label: project.title,
      selected: selectedValues.includes(String(project.id)),
    })),
  ];
  return {
    options,
    selectedValues,
    unavailableValues: options.filter((option) => option.unavailable).map((option) => option.value),
  };
}

function buildStatusFilterOptions(catalogue, selectedStatuses) {
  return catalogue
    .filter(({ value }) => value !== 'all')
    .map((option) => ({
      ...option,
      selected: selectedStatuses.includes(option.value),
    }));
}

function buildProjectTypeFilterOptions(catalogue, selectedProjectTypes) {
  return catalogue
    .filter(({ value }) => value !== 'all')
    .map((option) => ({
      ...option,
      selected: selectedProjectTypes.includes(option.value),
    }));
}

function getProjectFormStatusOptions(req) {
  return getPageDefaultsService(req).getOptionCatalogue('new_project', 'status');
}

function getProjectFormTypeOptions(req) {
  return getPageDefaultsService(req).getOptionCatalogue('projects', 'projectType')
    .filter(({ value }) => value !== 'all');
}

function getProjectOptionPresentation(req) {
  const pageDefaultsService = getPageDefaultsService(req);
  return buildProjectOptionPresentation({
    status: pageDefaultsService.getOptionCatalogue('new_project', 'status'),
    projectType: pageDefaultsService.getOptionCatalogue('projects', 'projectType')
      .filter(({ value }) => value !== 'all'),
  });
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

function parseListQuery(raw, pageDefaultsService, tagOptions = [], optionCatalogues = {}) {
  const rawQuery = raw && typeof raw === 'object' ? raw : {};
  const resolvedPresentation = {
    view: pageDefaultsService.resolve('projects', 'view', rawQuery.view),
    sort: pageDefaultsService.resolve('projects', 'sort', rawQuery.sort),
    order: pageDefaultsService.resolve('projects', 'order', rawQuery.order),
  };
  const useSavedFilterDefaults = isProjectsDefaultNavigation(rawQuery);
  const resolvedFilters = useSavedFilterDefaults
    ? pageDefaultsService.resolvePageDefaults('projects', {}, optionCatalogues)
    : null;
  const statuses = parseStatusFilterValues(
    useSavedFilterDefaults && resolvedFilters.status !== 'all'
      ? resolvedFilters.status
      : rawQuery.status,
    optionCatalogues.status,
  );
  const projectTypes = parseProjectTypeFilterValues(
    useSavedFilterDefaults && resolvedFilters.projectType !== 'all'
      ? resolvedFilters.projectType
      : rawQuery.type,
    optionCatalogues.projectType,
  );
  const search = typeof rawQuery.search === 'string' ? rawQuery.search.trim() : '';
  const tagIds = parseTagFilterIds(
    useSavedFilterDefaults && resolvedFilters.tag !== 'all' ? resolvedFilters.tag : rawQuery.tag,
    tagOptions,
  );
  // Temporary multi-Project restriction (never a saved default). Repeated
  // `project` values are OR-ed; each value is validated on its own.
  const projectIds = parseProjectFilterIds(rawQuery.project);
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
    projectType: projectTypes.length === 1 ? projectTypes[0] : undefined,
    projectTypes,
    search,
    tagId: tagIds.length === 1 ? tagIds[0] : undefined,
    tagIds,
    // Legacy single-Project alias, set only when exactly one Project is
    // selected; `projectIds` is the authority for filtering and URLs.
    projectId: projectIds.length === 1 ? projectIds[0] : null,
    projectIds,
    sortBy,
    order,
    view,
    page,
    includeArchived,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  };
}

function parseStatusFilterValues(value, catalogue) {
  return parseProjectOptionFilterValues(value, catalogue);
}

function parseProjectTypeFilterValues(value, catalogue) {
  return parseProjectOptionFilterValues(value, catalogue);
}

function parseProjectOptionFilterValues(value, catalogue = []) {
  const values = Array.isArray(value) ? value : [value];
  const selected = new Set(values.filter((candidate) => typeof candidate === 'string'));
  return catalogue
    .map(({ value: candidate }) => candidate)
    .filter((candidate) => candidate !== 'all' && selected.has(candidate));
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

// Repeated `project` parameters (project=7&project=12), plus the legacy
// singleton form. Each value must be a strict positive safe integer string;
// malformed values (including comma-joined lists, decimals, negatives and
// unsafe integers) are discarded individually, matching the Tag filter and
// the Asset Library Project filter. Valid IDs are de-duplicated and sorted
// ascending. Unknown or archived IDs are kept: they still restrict the list.
// `all` is the explicit unrestricted value and is not an ID.
export function parseProjectFilterIds(value) {
  const values = Array.isArray(value) ? value : [value];
  const selected = new Set();
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const candidate = raw.trim();
    if (!/^[1-9]\d*$/.test(candidate)) continue;
    const id = Number(candidate);
    if (Number.isSafeInteger(id)) selected.add(id);
  }
  return [...selected].sort((left, right) => left - right);
}

function hasPresentationQuery(raw) {
  const rawQuery = raw && typeof raw === 'object' ? raw : {};
  return ['view', 'sort', 'order'].some((option) => Object.hasOwn(rawQuery, option));
}

function isProjectsDefaultNavigation(raw) {
  const rawQuery = raw && typeof raw === 'object' ? raw : {};
  return !['search', 'status', 'type', 'tag', 'project', 'sort', 'order', 'view', 'page']
    .some((option) => Object.hasOwn(rawQuery, option));
}

function isExplicitAllFilterValue(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.length === 1 && values[0] === 'all';
}

function shouldRedirectToSavedDefaults(raw, parsedQuery, pageDefaultsService) {
  if (hasPresentationQuery(raw)) return false;

  return parsedQuery.view !== pageDefaultsService.getFallback('projects', 'view')
    || parsedQuery.sortBy !== pageDefaultsService.getFallback('projects', 'sort')
    || parsedQuery.order !== pageDefaultsService.getFallback('projects', 'order')
    || (isProjectsDefaultNavigation(raw) && (
      parsedQuery.statuses.length > 0
      || parsedQuery.projectTypes.length > 0
      || parsedQuery.tagIds.length > 0
    ));
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
    projectType: body.projectType,
    patreonUrl: body.patreonUrl || null,
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
    projectType: project.project_type,
    patreonUrl: project.patreon_url || '',
  };
}

function buildPageUrl(req, parsedQuery, currentPage, pageDefaultsService, listQuery = req.query) {
  const baseQuery = buildCanonicalPageQuery(req, parsedQuery, currentPage, pageDefaultsService, listQuery);
  const fallbackView = pageDefaultsService.getFallback('projects', 'view');
  const defaultView = pageDefaultsService.resolve('projects', 'view');

  return function pageUrl(overrides) {
    const query = { ...baseQuery };
    for (const [key, value] of Object.entries(overrides)) {
      if (!['search', 'status', 'type', 'tag', 'project', 'sort', 'order', 'page', 'view'].includes(key)) continue;
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

function buildCanonicalPageQuery(req, parsedQuery, currentPage, pageDefaultsService, rawListQuery = req.query) {
  const rawQuery = rawListQuery && typeof rawListQuery === 'object' ? rawListQuery : {};
  const query = {};
  const fallbackSort = pageDefaultsService.getFallback('projects', 'sort');
  const fallbackOrder = pageDefaultsService.getFallback('projects', 'order');
  const fallbackView = pageDefaultsService.getFallback('projects', 'view');
  const defaultSort = pageDefaultsService.resolve('projects', 'sort');
  const defaultOrder = pageDefaultsService.resolve('projects', 'order');
  const defaultView = pageDefaultsService.resolve('projects', 'view');

  if (parsedQuery.search) query.search = parsedQuery.search;
  if (parsedQuery.statuses.length > 0) query.status = parsedQuery.statuses;
  else if (isExplicitAllFilterValue(rawQuery.status)) query.status = 'all';
  if (parsedQuery.projectTypes.length > 0) query.type = parsedQuery.projectTypes;
  else if (isExplicitAllFilterValue(rawQuery.type)) query.type = 'all';
  if (parsedQuery.tagIds.length > 0) query.tag = parsedQuery.tagIds.map(String);
  else if (isExplicitAllFilterValue(rawQuery.tag)) query.tag = 'all';
  if (parsedQuery.projectIds.length > 0) query.project = parsedQuery.projectIds.map(String);
  else if (isExplicitAllFilterValue(rawQuery.project)) query.project = 'all';

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
