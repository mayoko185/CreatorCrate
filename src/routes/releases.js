import express from 'express';
import { formatLocalDate, formatLocalTime, getLocalTodayIso } from '../util/date.js';
import {
  AssetNotFoundError,
  createReleaseService,
  ReleaseArchivedError,
  ReleaseParentArchivedError,
  ReleasePublishedError,
  ReleaseValidationError,
  ReleaseNotFoundError,
} from '../services/release-service.js';
import { buildReleaseAssetPagePresentation } from '../services/release-asset-presenter.js';
import {
  buildPageDefaultsDialogModel,
  handlePageDefaultsPost,
} from './page-defaults.js';

const SORT_OPTIONS = ['updated', 'created', 'planned', 'title'];
const PAGE_SIZE = 25;
const RELEASES_PAGE_DEFAULTS = 'releases';
const RELEASE_MANAGEMENT_PAGE_DEFAULTS = 'releaseManagement';
const RELEASE_ASSET_DEFAULT_VIEW = 'grid';
const RELEASES_DEFAULT_LABELS = Object.freeze({
  fields: Object.freeze({
    view: 'View',
    sort: 'Sort',
    order: 'Order',
  }),
  options: Object.freeze({
    view: Object.freeze({ list: 'List', board: 'Board' }),
    sort: Object.freeze({
      planned: 'Planned',
      updated: 'Updated',
      created: 'Created',
      title: 'Title',
    }),
    order: Object.freeze({ asc: 'Ascending', desc: 'Descending' }),
  }),
});
const RELEASES_NOTICES = Object.freeze({
  defaultsSaved: 'Releases defaults saved successfully.',
});

export { handleReleaseListOrBoard, buildPageUrl, buildCreateReleaseFormModel };

export function createReleasesRouter({ appName, db, releaseService, projectService, workflowQueryService }) {
  const router = express.Router();

  // GET /releases — release-record list or board.
  router.get('/', (req, res, next) => {
    handleReleaseListOrBoard(req, res, next, {
      appName,
      workflowQueryService,
      pageDefaultsKey: RELEASES_PAGE_DEFAULTS,
    });
  });

  router.post('/defaults', (req, res, next) => {
    handlePageDefaultsPost(req, res, next, {
      db,
      pageDefaultsService: getReleasePageDefaultsService(req, RELEASES_PAGE_DEFAULTS),
      page: RELEASES_PAGE_DEFAULTS,
      successMessage: RELEASES_NOTICES.defaultsSaved,
      saveErrorMessage: 'Releases defaults could not be saved. No changes were made.',
      onValidationError: ({ submittedValues, errors }) => {
        handleReleaseListOrBoard(req, res, next, {
          appName,
          workflowQueryService,
          pageDefaultsKey: RELEASES_PAGE_DEFAULTS,
          status: 422,
          defaultsDialogOpen: true,
          defaultsSubmittedValues: submittedValues,
          defaultsErrors: errors,
          allowSavedDefaultsRedirect: false,
          notice: null,
          pagePath: '/',
        });
      },
      onSuccess: ({ validatedValues }) => {
        const params = new URLSearchParams({
          view: validatedValues.view,
          sort: validatedValues.sort,
          order: validatedValues.order,
          notice: 'releases_defaults_saved',
        });
        res.redirect(`/releases?${params.toString()}`);
      },
    });
  });

  // GET /releases/calendar — Phase 2D: compatibility redirect. The
  // release-backed calendar lives at the canonical /calendar route (see
  // routes/calendar.js); this preserves the full query string (month and any
  // other parameters) exactly, so bookmarked/linked URLs keep working.
  router.get('/calendar', (req, res) => {
    const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(`/calendar${queryString}`);
  });

  // GET /releases/new — Create form (requires project selection)
  router.get('/new', (req, res, next) => {
    try {
      const formModel = buildCreateReleaseFormModel({
        appName,
        projectService,
        values: req.query,
        errors: {},
      });
      if (formModel.projects.length === 0) {
        return res.status(422).render('releases/form.njk', {
          ...formModel,
          errors: { general: 'No active projects found. Create a project first.' },
          projects: [],
          selectedProjectId: null,
        });
      }

      res.render('releases/form.njk', formModel);
    } catch (err) {
      next(err);
    }
  });

  // POST /releases — Create a release
  router.post('/', (req, res, next) => {
    const body = req.body || {};
    const hasSelectedAssetIds = Object.hasOwn(body, 'selectedAssetIds');

    try {
      const projectId = parseStrictInt(body.projectId);
      if (projectId === null) {
        throw new ReleaseValidationError({ projectId: 'Project is required.' });
      }

      const input = parseReleaseInput(body);
      if (hasSelectedAssetIds) {
        const normalizedSelection = normalizeSelectedAssetIds(body.selectedAssetIds);
        if (!normalizedSelection.valid) {
          throw new ReleaseValidationError({ assetIds: 'Invalid asset selection format.' });
        }

        const release = releaseService.createReleaseWithSelectedAssets(
          projectId,
          input,
          normalizedSelection.ids,
        );
        return res.redirect(`/releases/${release.id}/assets`);
      }

      const release = releaseService.createRelease(projectId, input);
      return res.redirect(`/releases/${release.id}`);
    } catch (err) {
      if (err instanceof ReleaseValidationError || (hasSelectedAssetIds && err instanceof AssetNotFoundError)) {
        const errors = err instanceof ReleaseValidationError
          ? { ...err.errors }
          : { assets: err.message };
        const selectedAssetError = errors.assetIds || errors.assets;
        if (hasSelectedAssetIds && selectedAssetError && !errors.general) {
          errors.general = selectedAssetError;
        }

        res.status(422).render('releases/form.njk', buildCreateReleaseFormModel({
          appName,
          projectService,
          values: body,
          errors,
        }));
        return;
      }
      next(err);
    }
  });

  // GET /releases/:id — Release detail
  router.get('/:id', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    const release = releaseService.findRelease(id);
    if (!release) {
      return next(createNotFound());
    }

    const project = projectService.findById(release.project_id);
    const releaseAssets = releaseService.listReleaseAssets(id);

    res.render('releases/detail.njk', buildReleaseDetailRenderModel({
      appName,
      releaseService,
      release,
      project,
      releaseAssets,
      req,
    }));
  });

  // GET /releases/:id/edit — Edit form
  router.get('/:id/edit', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    const release = releaseService.findRelease(id);
    if (!release) {
      return next(createNotFound());
    }

    // Archived releases and releases in archived projects are read-only.
    // Redirect to detail view instead of showing the edit form.
    const project = projectService.findById(release.project_id);
    if (release.archived_at || (project && project.archived_at)) {
      return res.redirect(`/releases/${id}`);
    }

    const { rows: projects } = projectService.list({ includeArchived: false, limit: 100 });

    res.render('releases/form.njk', {
      appName,
      release,
      values: releaseToFormValues(release),
      errors: {},
      projects,
      selectedProjectId: release.project_id,
      action: 'Edit',
      submitUrl: `/releases/${id}`,
    });
  });

  // POST /releases/:id — Update a release
  router.post('/:id', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    try {
      const input = parseReleaseInput(req.body);
      const release = releaseService.updateRelease(id, input);
      if (!release) {
        return next(createNotFound());
      }
      res.redirect(`/releases/${id}`);
    } catch (err) {
      if (err instanceof ReleaseNotFoundError) {
        return next(createNotFound());
      }
      if (err instanceof ReleaseValidationError) {
        const existing = releaseService.findRelease(id);
        const { rows: projects } = projectService.list({ includeArchived: false, limit: 100 });
        res.status(422).render('releases/form.njk', {
          appName,
          release: existing || { id },
          values: omitLegacyStatusField(req.body),
          errors: err.errors || { general: err.message },
          projects,
          selectedProjectId: req.body.projectId || (existing ? existing.project_id : null),
          action: 'Edit',
          submitUrl: `/releases/${id}`,
        });
        return;
      }
      if (err instanceof ReleaseArchivedError || err instanceof ReleaseParentArchivedError) {
        const existing = releaseService.findRelease(id);
        if (!existing) {
          return next(createNotFound());
        }
        const project = projectService.findById(existing.project_id);
        const releaseAssets = releaseService.listReleaseAssets(id);
        res.status(422).render('releases/detail.njk', buildReleaseDetailRenderModel({
          appName,
          releaseService,
          release: existing,
          project,
          releaseAssets,
          req,
          errors: { general: err.message },
        }));
        return;
      }
      next(err);
    }
  });

  // GET /releases/:id/publish — Publication review page (Phase 8-3)
  router.get('/:id/publish', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    const release = releaseService.findRelease(id);
    if (!release) {
      return next(createNotFound());
    }

    const project = projectService.findById(release.project_id);

    // Archived and already-published releases cannot enter publication review.
    if (release.archived_at || (project && project.archived_at)) {
      return res.redirect(`/releases/${id}`);
    }
    if (release.published_date != null) {
      return res.redirect(`/releases/${id}`);
    }

    const releaseAssets = releaseService.listReleaseAssets(id);

    // Resolve publication date for prefill: persisted date, otherwise local today
    const today = getLocalTodayIso();
    const prefillDate = release.published_date || today;

    res.render('releases/publish.njk', {
      appName,
      release,
      project,
      releaseAssets,
      assetCount: releaseAssets.length,
      prefillDate,
      errors: {},
    });
  });

  // POST /releases/:id/publish — Publish a release
  router.post('/:id/publish', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    // Resolve the published date from: explicit form value, then the release's
    // previously edited date, then null (service falls back to today).
    const submittedDate = parsePublishedDateInput(req.body.publishedDate);
    const existingRelease = releaseService.findRelease(id);
    if (!existingRelease) {
      return next(createNotFound());
    }
    const publishedDate = submittedDate || existingRelease.published_date || null;

    try {
      releaseService.publishRelease(id, publishedDate);
      res.redirect(`/releases/${id}`);
    } catch (err) {
      if (err instanceof ReleaseNotFoundError) {
        return next(createNotFound());
      }
      if (err instanceof ReleaseValidationError) {
        const release = releaseService.findRelease(id);
        if (!release) {
          return next(createNotFound());
        }
        const project = projectService.findById(release.project_id);
        const releaseAssets = releaseService.listReleaseAssets(id);
        // Resolve prefill date: submitted value (even if invalid), then persisted, then today
        const today = getLocalTodayIso();
        const prefillDate = submittedDate || release.published_date || today;

        res.status(422).render('releases/publish.njk', {
          appName,
          release,
          project,
          releaseAssets,
          assetCount: releaseAssets.length,
          prefillDate,
          errors: err.errors || { general: err.message },
        });
        return;
      }
      if (err instanceof ReleaseArchivedError || err instanceof ReleaseParentArchivedError) {
        const release = releaseService.findRelease(id);
        if (!release) {
          return next(createNotFound());
        }
        const project = projectService.findById(release.project_id);
        const releaseAssets = releaseService.listReleaseAssets(id);
        res.status(422).render('releases/detail.njk', buildReleaseDetailRenderModel({
          appName,
          releaseService,
          release,
          project,
          releaseAssets,
          req,
          errors: { general: err.message },
        }));
        return;
      }
      next(err);
    }
  });

  // POST /releases/:id/archive — Archive a release
  router.post('/:id/archive', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    try {
      releaseService.archiveRelease(id);
      res.redirect(`/releases/${id}`);
    } catch (err) {
      if (err instanceof ReleaseNotFoundError) {
        return next(createNotFound());
      }
      if (err instanceof ReleaseValidationError) {
        const release = releaseService.findRelease(id);
        if (!release) {
          return next(createNotFound());
        }
        const project = projectService.findById(release.project_id);
        const releaseAssets = releaseService.listReleaseAssets(id);
        res.status(422).render('releases/detail.njk', buildReleaseDetailRenderModel({
          appName,
          releaseService,
          release,
          project,
          releaseAssets,
          req,
          errors: err.errors,
        }));
        return;
      }
      if (err instanceof ReleaseArchivedError || err instanceof ReleaseParentArchivedError) {
        const release = releaseService.findRelease(id);
        if (!release) {
          return next(createNotFound());
        }
        const project = projectService.findById(release.project_id);
        const releaseAssets = releaseService.listReleaseAssets(id);
        res.status(422).render('releases/detail.njk', buildReleaseDetailRenderModel({
          appName,
          releaseService,
          release,
          project,
          releaseAssets,
          req,
          errors: { general: err.message },
        }));
        return;
      }
      next(err);
    }
  });

  // POST /releases/:id/delete — Permanently delete a release
  router.post('/:id/delete', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    try {
      releaseService.deleteRelease(id);
      res.redirect('/releases');
    } catch (err) {
      if (err instanceof ReleaseNotFoundError) {
        return next(createNotFound());
      }
      if (err instanceof ReleaseArchivedError || err instanceof ReleaseParentArchivedError) {
        const existing = releaseService.findRelease(id);
        if (!existing) {
          return next(createNotFound());
        }
        const { rows: projects } = projectService.list({ includeArchived: false, limit: 100 });
        res.status(422).render('releases/form.njk', {
          appName,
          release: existing,
          values: releaseToFormValues(existing),
          errors: { general: err.message },
          projects,
          selectedProjectId: existing.project_id,
          action: 'Edit',
          submitUrl: `/releases/${id}`,
        });
        return;
      }
      next(err);
    }
  });

  // GET /releases/:id/assets — Asset management page (Phase 9-1)
  router.get('/:id/assets', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    const release = releaseService.findRelease(id);
    if (!release) {
      return next(createNotFound());
    }

    const project = projectService.findById(release.project_id);
    if (!project) {
      return next(createNotFound());
    }

    // Compose the full asset-management view-model through the service
    const viewModel = releaseService.getReleaseAssetManagementPage(id, req.query);

    res.render('releases/assets.njk', {
      appName,
      ...buildAssetPageRenderModel(id, req, viewModel),
      roles: ['primary', 'preview', 'attachment', 'source'],
    });
  });

  // POST /releases/:id/assets — Save asset selection
  router.post('/:id/assets', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    const release = releaseService.findRelease(id);
    if (!release) {
      return next(createNotFound());
    }

    try {
      // The unified picker submits only selectedAssetIds[]. Keep accepting the
      // legacy role/order fields for compatibility with older clients and
      // direct integrations, but do not make membership depend on them.
      // Note: express urlencoded with extended:true parses foo[1]=bar as object { '1': 'bar' }
      // But for arrays, selectedAssetIds[] becomes ['1', '2', ...] and roles/sortOrder indices are 0-based
      // to match the array position, NOT the asset ID. We use positional matching.
      //
      // When a role or sortOrder field is missing (e.g. disabled in a no-JS browser
       // submission for a newly-checked row), default to safe values rather than
       // rejecting the submission. The browser will not submit disabled controls, so
       // the server must treat them as "use default".
      // Normalize to array: handle both single-value (selectedAssetIds=5) and
      // array (selectedAssetIds[]=5&selectedAssetIds[]=6) form submissions.
      const normalized = normalizeSelectedAssetIds(req.body.selectedAssetIds);

      // Reject malformed input shapes — never treat them as an intentional clear.
      if (!normalized.valid) {
        throw new ReleaseValidationError({ general: 'Invalid asset selection format.' });
      }

      const selections = [];
      const membershipOnly = req.body.roles === undefined && req.body.sortOrder === undefined;

      if (membershipOnly) {
        for (const rawAssetId of normalized.ids) {
          const assetId = parseStrictInt(rawAssetId);
          if (assetId === null) {
            throw new ReleaseValidationError({ general: 'Invalid asset selection.' });
          }
          selections.push({ assetId });
        }
      } else {
        // Express parses roles[1]=primary as { '0': 'primary' } (0-indexed to
        // match the array position). Legacy submissions retain their explicit
        // role/order behavior.
        const roles = req.body.roles || {};
        const sortOrders = req.body.sortOrder || {};
        for (let i = 0; i < normalized.ids.length; i++) {
          const rawAssetId = normalized.ids[i];
          const assetId = parseStrictInt(rawAssetId);
          if (assetId === null) {
            throw new ReleaseValidationError({ general: 'Invalid asset selection.' });
          }

          const role = typeof roles[i] === 'string' && roles[i].trim() !== ''
            ? roles[i].trim().toLowerCase()
            : 'attachment';
          const sortOrderRaw = sortOrders[i];
          const sortOrder = parseNonNegativeInt(sortOrderRaw) ?? 0;
          selections.push({ assetId, role, sortOrder });
        }
      }

      releaseService.selectAssets(id, selections, { membershipOnly });
      const viewModel = releaseService.getReleaseAssetManagementPage(id, req.query);
      res.redirect(buildAssetRedirectUrl(id, viewModel, req.query));
    } catch (err) {
      if (err instanceof ReleaseNotFoundError) {
        return next(createNotFound());
      }
      if (err instanceof ReleaseValidationError) {
        const viewModel = releaseService.getReleaseAssetManagementPage(id, req.query);
        // Render the SUBMITTED selections so the user does not lose input.
        // Do NOT load persisted releaseAssets here — that would clobber the
        // user's changes after a validation failure.
        const submittedAssets = buildSubmittedReleaseAssets(req);
        res.status(422).render('releases/assets.njk', {
          appName,
          ...buildAssetPageRenderModel(id, req, viewModel, {
            releaseAssets: submittedAssets,
            assetPresentation: buildSubmittedReleaseAssetPresentation(viewModel, submittedAssets),
            errors: err.errors || { general: err.message },
          }),
          roles: ['primary', 'preview', 'attachment', 'source'],
        });
        return;
      }
      if (err instanceof ReleasePublishedError) {
        const viewModel = releaseService.getReleaseAssetManagementPage(id, req.query);
        res.status(422).render('releases/assets.njk', {
          appName,
          ...buildAssetPageRenderModel(id, req, viewModel, {
            errors: { general: err.message },
          }),
          roles: ['primary', 'preview', 'attachment', 'source'],
        });
        return;
      }
      if (err instanceof ReleaseArchivedError || err instanceof ReleaseParentArchivedError) {
        const viewModel = releaseService.getReleaseAssetManagementPage(id, req.query);
        res.status(422).render('releases/assets.njk', {
          appName,
          ...buildAssetPageRenderModel(id, req, viewModel, {
            errors: { general: err.message },
          }),
          roles: ['primary', 'preview', 'attachment', 'source'],
        });
        return;
      }
      next(err);
    }
  });

  // POST /releases/:id/assets/:assetId/remove — Remove a single selected asset from a release
  // This is a corrective mutation for missing selected assets.
  // Only selected assets that are currently missing can be removed through this route.
  router.post('/:id/assets/:assetId/remove', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      return next(createNotFound());
    }

    const assetId = parseId(req.params.assetId);
    if (assetId === null) {
      return next(createNotFound());
    }

    const release = releaseService.findRelease(id);
    if (!release) {
      return next(createNotFound());
    }

    try {
      releaseService.removeAssetFromRelease(id, assetId);
      res.redirect(`/releases/${id}`);
    } catch (err) {
      if (err instanceof ReleaseNotFoundError || err instanceof AssetNotFoundError) {
        return next(createNotFound());
      }
      if (err instanceof ReleaseArchivedError || err instanceof ReleaseParentArchivedError) {
        const project = projectService.findById(release.project_id);
        const releaseAssets = releaseService.listReleaseAssets(id);
        res.status(422).render('releases/detail.njk', buildReleaseDetailRenderModel({
          appName,
          releaseService,
          release,
          project,
          releaseAssets,
          req,
          errors: { general: err.message },
        }));
        return;
      }
      if (err instanceof ReleasePublishedError || err instanceof ReleaseValidationError) {
        const project = projectService.findById(release.project_id);
        const releaseAssets = releaseService.listReleaseAssets(id);
        res.status(422).render('releases/detail.njk', buildReleaseDetailRenderModel({
          appName,
          releaseService,
          release,
          project,
          releaseAssets,
          req,
          errors: err.errors || { general: err.message },
        }));
        return;
      }
      next(err);
    }
  });

  // ─── Phase 9-2: Explicit Release Asset Curation Mutations ─────────────
  //
  // Every POST describes one deliberate mutation and must not affect
  // selections hidden by filtering or pagination. All routes use
  // POST/redirect/GET after successful mutations.
  //
  // Routes do NOT import repositories — all lifecycle and ownership
  // decisions are in the service layer.

  // POST /releases/:id/assets/add — Add one candidate asset
  router.post('/:id/assets/add', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) return next(createNotFound());

    const assetId = parseStrictInt(req.body.assetId);
    if (assetId === null) {
      return renderAssetPageWithError(req, res, id, { general: 'Invalid asset ID.' }, { releaseService, appName });
    }

    try {
      releaseService.addCandidateAsset(id, assetId);
      const viewModel = releaseService.getReleaseAssetManagementPage(id, req.query);
      res.redirect(buildAssetRedirectUrl(id, viewModel, req.query));
    } catch (err) {
      if (err instanceof ReleaseNotFoundError || err instanceof AssetNotFoundError) {
        return next(createNotFound());
      }
      if (err instanceof ReleaseValidationError || err instanceof ReleasePublishedError) {
        return renderAssetPageWithError(req, res, id, err.errors || { general: err.message }, { releaseService, appName });
      }
      if (err instanceof ReleaseArchivedError || err instanceof ReleaseParentArchivedError) {
        return renderAssetPageWithError(req, res, id, { general: err.message }, { releaseService, appName });
      }
      next(err);
    }
  });

  // POST /releases/:id/assets/:assetId/remove-selected — Remove one selected mutable asset
  router.post('/:id/assets/:assetId/remove-selected', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) return next(createNotFound());

    const assetId = parseId(req.params.assetId);
    if (assetId === null) return next(createNotFound());

    try {
      releaseService.removeSelectedAsset(id, assetId);
      const viewModel = releaseService.getReleaseAssetManagementPage(id, req.query);
      res.redirect(buildAssetRedirectUrl(id, viewModel, req.query));
    } catch (err) {
      if (err instanceof ReleaseNotFoundError || err instanceof AssetNotFoundError) {
        return next(createNotFound());
      }
      if (err instanceof ReleaseValidationError || err instanceof ReleasePublishedError) {
        return renderAssetPageWithError(req, res, id, err.errors || { general: err.message }, { releaseService, appName });
      }
      if (err instanceof ReleaseArchivedError || err instanceof ReleaseParentArchivedError) {
        return renderAssetPageWithError(req, res, id, { general: err.message }, { releaseService, appName });
      }
      next(err);
    }
  });

  // POST /releases/:id/assets/:assetId/role — Change one selected asset's role
  router.post('/:id/assets/:assetId/role', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) return next(createNotFound());

    const assetId = parseId(req.params.assetId);
    if (assetId === null) return next(createNotFound());

    const role = typeof req.body.role === 'string' ? req.body.role.trim().toLowerCase() : '';

    try {
      releaseService.updateAssetRole(id, assetId, role);
      const viewModel = releaseService.getReleaseAssetManagementPage(id, req.query);
      res.redirect(buildAssetRedirectUrl(id, viewModel, req.query));
    } catch (err) {
      if (err instanceof ReleaseNotFoundError || err instanceof AssetNotFoundError) {
        return next(createNotFound());
      }
      if (err instanceof ReleaseValidationError || err instanceof ReleasePublishedError) {
        return renderAssetPageWithError(req, res, id, err.errors || { general: err.message }, { releaseService, appName });
      }
      if (err instanceof ReleaseArchivedError || err instanceof ReleaseParentArchivedError) {
        return renderAssetPageWithError(req, res, id, { general: err.message }, { releaseService, appName });
      }
      next(err);
    }
  });

  // POST /releases/:id/assets/:assetId/move-up — Move one selected asset up
  router.post('/:id/assets/:assetId/move-up', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) return next(createNotFound());

    const assetId = parseId(req.params.assetId);
    if (assetId === null) return next(createNotFound());

    try {
      releaseService.moveAssetUp(id, assetId);
      const viewModel = releaseService.getReleaseAssetManagementPage(id, req.query);
      res.redirect(buildAssetRedirectUrl(id, viewModel, req.query));
    } catch (err) {
      if (err instanceof ReleaseNotFoundError || err instanceof AssetNotFoundError) {
        return next(createNotFound());
      }
      if (err instanceof ReleaseValidationError || err instanceof ReleasePublishedError) {
        return renderAssetPageWithError(req, res, id, err.errors || { general: err.message }, { releaseService, appName });
      }
      if (err instanceof ReleaseArchivedError || err instanceof ReleaseParentArchivedError) {
        return renderAssetPageWithError(req, res, id, { general: err.message }, { releaseService, appName });
      }
      next(err);
    }
  });

  // POST /releases/:id/assets/:assetId/move-down — Move one selected asset down
  router.post('/:id/assets/:assetId/move-down', (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) return next(createNotFound());

    const assetId = parseId(req.params.assetId);
    if (assetId === null) return next(createNotFound());

    try {
      releaseService.moveAssetDown(id, assetId);
      const viewModel = releaseService.getReleaseAssetManagementPage(id, req.query);
      res.redirect(buildAssetRedirectUrl(id, viewModel, req.query));
    } catch (err) {
      if (err instanceof ReleaseNotFoundError || err instanceof AssetNotFoundError) {
        return next(createNotFound());
      }
      if (err instanceof ReleaseValidationError || err instanceof ReleasePublishedError) {
        return renderAssetPageWithError(req, res, id, err.errors || { general: err.message }, { releaseService, appName });
      }
      if (err instanceof ReleaseArchivedError || err instanceof ReleaseParentArchivedError) {
        return renderAssetPageWithError(req, res, id, { general: err.message }, { releaseService, appName });
      }
      next(err);
    }
  });

  return router;
}

/**
 * Shared GET / handler for the release list/board view. Reused by both the
 * /releases router and the /release-management router so the filtering,
 * sorting, pagination, and board-grouping contract stays identical across
 * both mount points — only the mount point and page-default key differ.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @param {object} deps - { appName, workflowQueryService, pageDefaultsKey }
 */
function handleReleaseListOrBoard(
  req,
  res,
  next,
  {
    appName,
    workflowQueryService,
    pageDefaultsKey = RELEASE_MANAGEMENT_PAGE_DEFAULTS,
    status = 200,
    defaultsDialogOpen = pageDefaultsKey === RELEASES_PAGE_DEFAULTS && req.query?.defaults === '1',
    defaultsSubmittedValues = null,
    defaultsErrors = {},
    allowSavedDefaultsRedirect = pageDefaultsKey !== RELEASES_PAGE_DEFAULTS || req.query?.defaults !== '1',
    notice = pageDefaultsKey === RELEASES_PAGE_DEFAULTS ? resolveReleasesNotice(req.query?.notice) : null,
    pagePath = req.path,
  },
) {
  try {
    const pageDefaultsService = getReleasePageDefaultsService(req, pageDefaultsKey);
    const rawQuery = req.query && typeof req.query === 'object' ? req.query : {};
    const normalizedRawQuery = omitLegacyStatusField(rawQuery);
    const presentation = resolveReleasePresentation(normalizedRawQuery, pageDefaultsService, pageDefaultsKey);
    const effectiveQuery = {
      ...normalizedRawQuery,
      sort: presentation.sort,
      order: presentation.order,
    };
    const normalizedFilters = workflowQueryService.normalizeListFilters(effectiveQuery);
    const basePath = req.baseUrl;
    const pageUrlRequest = pagePath === req.path ? req : { baseUrl: req.baseUrl, path: pagePath };

    if (presentation.view === 'board') {
      const { columns, today } = workflowQueryService.getReleaseBoard(effectiveQuery);
      const urlQuery = buildReleaseManagementUrlQuery(normalizedRawQuery, normalizedFilters, presentation);
      if (allowSavedDefaultsRedirect && shouldRedirectToSavedReleaseManagementDefaults(
        normalizedRawQuery,
        presentation,
        { preserveDefaultsDialog: pageDefaultsKey === RELEASES_PAGE_DEFAULTS },
      )) {
        return res.redirect(buildPageUrl(pageUrlRequest, urlQuery)({}));
      }
      const pageUrl = buildPageUrl(pageUrlRequest, urlQuery);
      const query = buildReleaseManagementRenderQuery(normalizedFilters, presentation);
      const clearUrl = buildPageUrl(
        pageUrlRequest,
        buildReleaseManagementUrlQuery(
          normalizedRawQuery,
          normalizedFilters,
          presentation,
          normalizedFilters.page,
          { includeImplicitView: false },
        ),
      )(buildReleaseManagementClearOverrides());

      return res.status(status).render('releases/index.njk', {
        appName,
        view: 'board',
        columns,
        today,
        query,
        pageUrl,
        clearUrl,
        basePath,
        releasesSurface: pageDefaultsKey === RELEASES_PAGE_DEFAULTS,
        ...buildReleasesRenderExtras({
          pageDefaultsService,
          pageDefaultsKey,
          defaultsDialogOpen,
          defaultsSubmittedValues,
          defaultsErrors,
          notice,
        }),
      });
    }

    // List view
    const { releases, total, page, pageSize, pageCount, today, hasAnyReleases } = workflowQueryService.getReleaseList(effectiveQuery);
    const urlQuery = buildReleaseManagementUrlQuery(normalizedRawQuery, normalizedFilters, presentation, page);
    if (allowSavedDefaultsRedirect && shouldRedirectToSavedReleaseManagementDefaults(
      normalizedRawQuery,
      presentation,
      { preserveDefaultsDialog: pageDefaultsKey === RELEASES_PAGE_DEFAULTS },
    )) {
      return res.redirect(buildPageUrl(pageUrlRequest, urlQuery)({}));
    }
    const pageUrl = buildPageUrl(pageUrlRequest, urlQuery);
    const query = buildReleaseManagementRenderQuery(normalizedFilters, presentation, page);
    const clearUrl = buildPageUrl(
      pageUrlRequest,
      buildReleaseManagementUrlQuery(
        normalizedRawQuery,
        normalizedFilters,
        presentation,
        page,
        { includeImplicitView: false },
      ),
    )(buildReleaseManagementClearOverrides());

    res.status(status).render('releases/index.njk', {
      appName,
      view: 'list',
      releases,
      total,
      page,
      pageSize,
      pageCount,
      today,
      hasAnyReleases,
      pageUrl,
      clearUrl,
      query,
      sortOptions: SORT_OPTIONS,
      basePath,
      releasesSurface: pageDefaultsKey === RELEASES_PAGE_DEFAULTS,
      ...buildReleasesRenderExtras({
        pageDefaultsService,
        pageDefaultsKey,
        defaultsDialogOpen,
        defaultsSubmittedValues,
        defaultsErrors,
        notice,
      }),
    });
  } catch (err) {
    next(err);
  }
}

function resolveReleasesNotice(code) {
  return code === 'releases_defaults_saved' ? RELEASES_NOTICES.defaultsSaved : null;
}

function buildReleasesRenderExtras({
  pageDefaultsService,
  pageDefaultsKey,
  defaultsDialogOpen,
  defaultsSubmittedValues,
  defaultsErrors,
  notice,
}) {
  if (pageDefaultsKey !== RELEASES_PAGE_DEFAULTS) return {};

  return {
    releasesDefaults: buildPageDefaultsDialogModel({
      pageDefaultsService,
      page: RELEASES_PAGE_DEFAULTS,
      labels: RELEASES_DEFAULT_LABELS,
      submittedValues: defaultsSubmittedValues,
      errors: defaultsErrors,
    }),
    releasesDefaultsDialogOpen: Boolean(defaultsDialogOpen),
    releasesDefaultsNotice: notice,
  };
}

function getReleasePageDefaultsService(req, pageDefaultsKey) {
  const service = req.app?.locals?.pageDefaultsService;
  if (!service) {
    throw new Error(`Release page "${pageDefaultsKey}" requires app.locals.pageDefaultsService.`);
  }
  return service;
}

function resolveReleasePresentation(rawQuery, pageDefaultsService, pageDefaultsKey) {
  const query = rawQuery && typeof rawQuery === 'object' ? rawQuery : {};
  const presentation = {};

  for (const option of ['view', 'sort', 'order']) {
    const fallback = pageDefaultsService.getFallback(pageDefaultsKey, option);
    const savedValue = pageDefaultsService.resolve(pageDefaultsKey, option);
    const explicit = Object.hasOwn(query, option);
    const explicitValue = query[option] === undefined ? null : query[option];
    const value = explicit
      ? pageDefaultsService.resolve(pageDefaultsKey, option, explicitValue)
      : savedValue;

    presentation[option] = {
      value,
      fallback,
      savedValue,
      explicit,
    };
  }

  return {
    view: presentation.view.value,
    sort: presentation.sort.value,
    order: presentation.order.value,
    options: presentation,
  };
}

function shouldIncludeReleaseManagementOption(rawQuery, presentation, option) {
  const setting = presentation.options[option];
  const explicitValue = rawQuery[option];
  return setting.value !== setting.fallback
    || (setting.explicit && setting.savedValue !== setting.fallback)
    || (option === 'view' && setting.explicit && explicitValue === setting.value);
}

function buildReleaseManagementUrlQuery(
  rawQuery,
  normalizedFilters,
  presentation,
  currentPage = normalizedFilters.page,
  { includeImplicitView = true } = {},
) {
  const query = {};

  if (normalizedFilters.search) query.search = normalizedFilters.search;
  if (normalizedFilters.projectId !== null) query.project = String(normalizedFilters.projectId);
  if (normalizedFilters.schedule !== null) query.schedule = normalizedFilters.schedule;
  if (normalizedFilters.includeArchived) query.includeArchived = '1';
  if (includeImplicitView || shouldIncludeReleaseManagementOption(rawQuery, presentation, 'view')) {
    query.view = presentation.view;
  }
  if (shouldIncludeReleaseManagementOption(rawQuery, presentation, 'sort')) {
    query.sort = presentation.sort;
  }
  if (shouldIncludeReleaseManagementOption(rawQuery, presentation, 'order')) {
    query.order = presentation.order;
  }
  if (currentPage > 1) query.page = String(currentPage);
  if (normalizedFilters.pageSize !== PAGE_SIZE) query.pageSize = String(normalizedFilters.pageSize);
  return query;
}

function buildReleaseManagementRenderQuery(normalizedFilters, presentation, currentPage = normalizedFilters.page) {
  return {
    view: presentation.view,
    search: normalizedFilters.search || undefined,
    project: normalizedFilters.projectId === null ? undefined : String(normalizedFilters.projectId),
    schedule: normalizedFilters.schedule || undefined,
    includeArchived: normalizedFilters.includeArchived ? '1' : undefined,
    sort: presentation.sort,
    order: presentation.order,
    page: currentPage > 1 ? String(currentPage) : undefined,
    pageSize: String(normalizedFilters.pageSize),
  };
}

function buildReleaseManagementClearOverrides() {
  return {
    search: null,
    project: null,
    schedule: null,
    includeArchived: null,
    page: null,
  };
}

function hasReleaseManagementPresentationQuery(rawQuery) {
  return ['view', 'sort', 'order'].some((option) => Object.hasOwn(rawQuery, option));
}

function shouldRedirectToSavedReleaseManagementDefaults(
  rawQuery,
  presentation,
  { preserveDefaultsDialog = false } = {},
) {
  if (preserveDefaultsDialog && rawQuery.defaults === '1') return false;
  if (hasReleaseManagementPresentationQuery(rawQuery)) return false;

  return ['view', 'sort', 'order'].some((option) => {
    const setting = presentation.options[option];
    return setting.value !== setting.fallback;
  });
}

function buildNewReleaseFormValues(rawQuery) {
  const query = rawQuery && typeof rawQuery === 'object' && !Array.isArray(rawQuery)
    ? omitLegacyStatusField(rawQuery)
    : {};
  const now = new Date();

  const values = {
    ...query,
    plannedDate: query.plannedDate || formatLocalDate(now),
    plannedTime: query.plannedTime || formatLocalTime(now),
  };

  if (Object.hasOwn(query, 'selectedAssetIds')) {
    const normalized = normalizeSelectedAssetIds(query.selectedAssetIds);
    values.selectedAssetIds = normalized.valid ? normalized.ids : [];
  }

  return values;
}

function omitLegacyStatusField(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'status'));
}

function buildCreateReleaseFormModel({ appName, projectService, values = {}, errors = {} }) {
  const formValues = buildNewReleaseFormValues(values);
  const context = buildReleaseFormProjectContext(formValues.projectId, projectService);

  return {
    appName,
    release: null,
    values: formValues,
    errors,
    projects: context.projects,
    selectedProjectId: context.selectedProjectId,
    action: 'Create',
    submitUrl: '/releases',
  };
}

function resolveReleaseAssetView(rawQuery) {
  return rawQuery && rawQuery.view === 'list' ? 'list' : RELEASE_ASSET_DEFAULT_VIEW;
}

function buildReleaseDetailPageUrl(releaseId, rawQuery = {}) {
  const currentView = rawQuery && (rawQuery.view === 'grid' || rawQuery.view === 'list')
    ? rawQuery.view
    : null;

  return function pageUrl(overrides = {}) {
    const query = {};
    if (currentView === 'list') query.view = currentView;

    for (const [key, value] of Object.entries(overrides)) {
      if (key !== 'view') continue;
      if (value === 'list') {
        query.view = value;
      } else if (value === 'grid') {
        delete query.view;
      }
    }

    const search = new URLSearchParams(query).toString();
    return search ? `/releases/${releaseId}?${search}` : `/releases/${releaseId}`;
  };
}

function buildReleaseDetailRenderModel({
  appName,
  releaseService,
  release,
  project,
  releaseAssets,
  req,
  errors = {},
}) {
  const selectedAssets = Array.isArray(releaseAssets) ? releaseAssets : [];
  return {
    appName,
    release,
    project,
    releaseAssets: selectedAssets,
    assetCount: selectedAssets.length,
    assetPresentation: releaseService.getReleaseAssetPresentation(release.id, selectedAssets),
    view: resolveReleaseAssetView(req?.query),
    pageUrl: buildReleaseDetailPageUrl(release.id, req?.query),
    errors,
  };
}

function buildReleaseAssetPageQuery(viewModel, rawQuery = {}) {
  const filters = viewModel.assetFilters || viewModel.candidateFilters || {};
  const page = viewModel.assetPageNumber ?? viewModel.candidatePage ?? 1;
  const pageSize = viewModel.assetPageSize ?? viewModel.candidatePageSize ?? 25;
  const query = {};
  if (filters.search) query.search = filters.search;
  if (filters.extension) query.extension = filters.extension;
  if (viewModel.activeCategoryId !== null) query.category = String(viewModel.activeCategoryId);
  if (page > 1) query.page = String(page);
  if (pageSize !== 25) query.pageSize = String(pageSize);
  if (rawQuery && (rawQuery.view === 'grid' || rawQuery.view === 'list')) query.view = rawQuery.view;
  return query;
}

function buildOffPageSelectedAssetIds(releaseAssets, assetPresentation) {
  const visibleIds = new Set(
    (Array.isArray(assetPresentation?.assets) ? assetPresentation.assets : [])
      .map((asset) => String(asset.id)),
  );
  return (Array.isArray(releaseAssets) ? releaseAssets : [])
    .map((asset) => asset?.asset_id)
    .filter((assetId) => assetId !== undefined && assetId !== null && !visibleIds.has(String(assetId)));
}

function buildAssetPageRenderModel(
  releaseId,
  req,
  viewModel,
  { releaseAssets = viewModel.releaseAssets, assetPresentation = viewModel.assetPresentation, errors = {} } = {},
) {
  const pagePresentation = assetPresentation || {};
  return {
    release: viewModel.release,
    project: viewModel.project,
    releaseAssets,
    assetPresentation: pagePresentation,
    assets: viewModel.assets,
    categories: viewModel.categories,
    categoryNavigation: viewModel.categoryNavigation,
    categoryFilterOptions: buildCategoryFilterOptions(viewModel.categories, viewModel.categoryNavigation),
    activeCategoryId: viewModel.activeCategoryId,
    assetPage: viewModel.assetPage,
    assetTotal: viewModel.assetTotal,
    assetPageNumber: viewModel.assetPageNumber,
    assetPageSize: viewModel.assetPageSize,
    assetPageCount: viewModel.assetPageCount,
    assetFilters: viewModel.assetFilters,
    assetExtensions: viewModel.assetExtensions,
    candidates: viewModel.candidates,
    candidateTotal: viewModel.candidateTotal,
    candidatePage: viewModel.candidatePage,
    candidatePageSize: viewModel.candidatePageSize,
    candidatePageCount: viewModel.candidatePageCount,
    candidateFilters: viewModel.candidateFilters,
    candidateExtensions: viewModel.candidateExtensions,
    eligibleAssetCount: viewModel.eligibleAssetCount,
    eligibleCandidateCount: viewModel.eligibleCandidateCount,
    offPageSelectedAssetIds: buildOffPageSelectedAssetIds(releaseAssets, pagePresentation),
    view: resolveReleaseAssetView(req.query),
    errors,
    pageUrl: buildAssetPageUrl(releaseId, buildReleaseAssetPageQuery(viewModel, req.query)),
    releaseAssetActionUrl: (assetId, action) => buildReleaseAssetActionUrl(
      releaseId,
      viewModel,
      req.query,
      assetId,
      action,
    ),
  };
}

function buildSubmittedReleaseAssetPresentation(viewModel, submittedAssets) {
  const sourceById = new Map();
  for (const row of [
    ...(Array.isArray(viewModel.assets) ? viewModel.assets : []),
    ...(Array.isArray(viewModel.releaseAssets) ? viewModel.releaseAssets : []),
  ]) {
    const id = row?.asset_id ?? row?.id;
    if (id !== undefined && id !== null) sourceById.set(String(id), row);
  }

  const selectedAssets = (Array.isArray(submittedAssets) ? submittedAssets : []).map((submitted) => {
    const source = sourceById.get(String(submitted.asset_id));
    return source
      ? { ...source, asset_id: submitted.asset_id, role: submitted.role, sort_order: submitted.sort_order }
      : submitted;
  });

  const selectedIds = new Set(selectedAssets.map((asset) => String(asset.asset_id)));
  const assetPage = Array.isArray(viewModel.assetPage)
    ? viewModel.assetPage
    : (Array.isArray(viewModel.assets) ? viewModel.assets : []);
  return buildReleaseAssetPagePresentation({
    selectedAssets,
    assets: assetPage,
    candidateAssets: assetPage.filter((asset) => !selectedIds.has(String(asset.id))),
    categories: viewModel.categories,
  });
}

/**
 * Render the asset management page with an error message.
 * Preserves candidate filter and explicit view state from the current request.
 * Pagination URLs always target the GET route (/releases/:id/assets),
 * never the POST mutation path.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} releaseId
 * @param {object} errors
 * @param {object} deps - { releaseService, appName }
 */
function renderAssetPageWithError(req, res, releaseId, errors, deps = {}) {
  const { releaseService, appName } = deps;
  const viewModel = releaseService.getReleaseAssetManagementPage(releaseId, req.query);
  res.status(422).render('releases/assets.njk', {
    appName,
    ...buildAssetPageRenderModel(releaseId, req, viewModel, { errors }),
    roles: ['primary', 'preview', 'attachment', 'source'],
  });
}

function parseListQuery(raw) {
  const search = typeof raw.search === 'string' ? raw.search.trim() : '';
  const sortBy = SORT_OPTIONS.includes(raw.sort) ? raw.sort : 'updated';
  const order = raw.order === 'asc' ? 'asc' : 'desc';

  let page = Number.parseInt(raw.page, 10);
  if (!Number.isInteger(page) || page < 1) {
    page = 1;
  }

  const includeArchived = raw.includeArchived === '1';

  return {
    search,
    sortBy,
    order,
    page,
    includeArchived,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  };
}

function parseReleaseInput(body) {
  return {
    title: body.title,
    description: body.description,
    notes: body.notes,
    plannedDate: body.plannedDate || null,
    plannedTime: body.plannedTime || null,
    publishedDate: body.publishedDate || null,
    patreonUrl: body.patreonUrl || null,
  };
}

function plannedDateTimeToFormValues(release) {
  if (!release.planned_date) {
    return { plannedDate: '', plannedTime: '' };
  }

  const dateStr = String(release.planned_date);
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return { plannedDate: dateStr, plannedTime: release.planned_time || '' };
  }

  const match = dateStr.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2}):\d{2}$/);
  if (match) {
    return { plannedDate: match[1], plannedTime: `${match[2]}:${match[3]}` };
  }

  return { plannedDate: dateStr, plannedTime: release.planned_time || '' };
}

function releaseToFormValues(release) {
  const { plannedDate, plannedTime } = plannedDateTimeToFormValues(release);

  return {
    title: release.title,
    description: release.description,
    notes: release.notes,
    plannedDate,
    plannedTime,
    publishedDate: release.published_date || '',
    patreonUrl: release.patreon_url || '',
  };
}

function parseId(value) {
  const id = parseStrictInt(value);
  return id;
}

/**
 * A project is active release-create context only when neither archive
 * indicator is set. Rows can disagree (status='archived' with a NULL
 * archived_at, or vice versa) so both must be checked directly on the
 * project object regardless of which lookup path produced it.
 */
function isActiveProject(project) {
  return !project.archived_at && project.status !== 'archived';
}

/**
 * Resolve a GET /releases/new `projectId` query value against the loaded
 * project options, returning the options to render (possibly extended) and
 * the trusted, normalized selected project id (or null when the context
 * should be treated as absent: malformed, nonexistent, or archived).
 * `parseStrictInt` rejects non-string/non-number input outright, so repeated
 * query params (which Express returns as an array) are already excluded.
 *
 * `projects` is the already-locally-filtered (active-only) project page for
 * the selector; checking membership there avoids a second query in the
 * common case. Because local filtering can shrink the array independent of
 * whether the original repository page was full, completeness must not be
 * inferred from `projects.length` — the caller passes `originalPageWasFull`
 * (computed from the unfiltered page, before local filtering) explicitly.
 * Only when the original page was full (and could therefore be missing a
 * valid project beyond the cap) does this fall back to a direct lookup — and
 * when that lookup finds a valid active project not already present, it is
 * appended to the returned options so the selector can render it as selected.
 *
 * @returns {{ projects: object[], selectedProjectId: number|null }}
 */
/**
 * Load and locally filter the project options for a release form, then
 * resolve the given raw projectId against them via resolveReleaseFormContext.
 * Shared by GET /releases/new and the POST /releases validation-error
 * re-render so both paths apply identical archive, paging, and lookup rules.
 */
function buildReleaseFormProjectContext(rawProjectId, projectService) {
  const { rows: originalProjects } = projectService.list({ includeArchived: false, limit: 100 });
  const originalPageWasFull = originalProjects.length === 100;
  const activeProjects = originalProjects.filter(isActiveProject);
  return resolveReleaseFormContext(rawProjectId, activeProjects, projectService, { originalPageWasFull });
}

function resolveReleaseFormContext(rawProjectId, projects, projectService, { originalPageWasFull }) {
  const id = parseStrictInt(rawProjectId);
  if (id === null) return { projects, selectedProjectId: null };

  const existing = projects.find((project) => project.id === id);
  if (existing) {
    return { projects, selectedProjectId: id };
  }

  if (!originalPageWasFull) return { projects, selectedProjectId: null };

  const project = projectService.findById(id);
  if (!project || !isActiveProject(project)) {
    return { projects, selectedProjectId: null };
  }

  return { projects: [...projects, project], selectedProjectId: id };
}

/**
 * Parse an integer strictly — rejects non-numeric strings, floats, hex,
 * leading zeros, values above Number.MAX_SAFE_INTEGER, and any value
 * Number() would silently round (e.g. digit strings beyond the range
 * doubles can represent exactly). Returns null unless the value is a
 * canonical positive safe integer. Does NOT use parseInt as validation.
 */
function parseStrictInt(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const str = String(value).trim();
  if (!/^[1-9]\d*$/.test(str)) return null;
  const num = Number(str);
  if (!Number.isSafeInteger(num) || num < 1) return null;
  if (String(num) !== str) return null;
  return num;
}

/**
 * Parse a non-negative integer (>= 0) strictly.
 * Returns null if the value is not valid.
 */
function parseNonNegativeInt(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const str = String(value).trim();
  if (!/^\d+$/.test(str)) return null;
  const num = Number(str);
  if (!Number.isInteger(num) || num < 0) return null;
  return num;
}

/**
 * Normalize a form's selectedAssetIds value to a structured result.
 *
 * Express urlencoded parsing produces:
 *   - `selectedAssetIds=5`          → string "5"
 *   - `selectedAssetIds[]=5`        → ["5"]
 *   - `selectedAssetIds[]=5&selectedAssetIds[]=6` → ["5", "6"]
 *   - `selectedAssetIds[0]=5`       → { "0": "5" }
 *   - missing                       → undefined
 *
 * Returns `{ valid, ids }` so the caller can distinguish:
 *   - field absent (`undefined`) or intentionally empty (`''`) → `{ valid: true, ids: [] }`
 *   - malformed shape (including `null`)                      → `{ valid: false, ids: [] }`
 *
 * Accepted shapes:
 *   - absent (undefined) — intentional clear
 *   - empty string '' — intentional clear
 *   - one scalar string ID
 *   - a flat array of scalar string/number IDs
 *   - a flat object with numeric keys whose values are scalar string/number IDs
 *
 * Rejected shapes:
 *   - null, nested arrays, nested objects, objects with non-numeric keys,
 *     mixed nested/scalar values, booleans, arbitrary object shapes
 *
 * @param {*} raw - the raw req.body.selectedAssetIds value
 * @returns {{ valid: boolean, ids: string[] }}
 */
function normalizeSelectedAssetIds(raw) {
  if (raw === undefined) return { valid: true, ids: [] };
  if (raw === null) return { valid: false, ids: [] };
  if (typeof raw === 'string') {
    if (raw === '') return { valid: true, ids: [] };
    return { valid: true, ids: [raw] };
  }
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (typeof v !== 'string' && typeof v !== 'number') return { valid: false, ids: [] };
    }
    return { valid: true, ids: raw.map(String) };
  }
  // Object-shaped (numeric keys from extended parsing) — flatten values
  if (typeof raw === 'object' && raw !== null) {
    const keys = Object.keys(raw);
    for (const key of keys) {
      if (!/^\d+$/.test(key)) return { valid: false, ids: [] };
    }
    const values = Object.values(raw);
    for (const v of values) {
      if (typeof v !== 'string' && typeof v !== 'number') return { valid: false, ids: [] };
    }
    return { valid: true, ids: values.map(String) };
  }
  return { valid: false, ids: [] };
}

/**
 * Build a releaseAssets-shaped array from the raw form body.
 * Used on validation failure so the form can re-render the user's actual input
 * rather than the persisted selections from the database.
 *
 * Each entry has the fields the template reads: asset_id, role, sort_order.
 * Invalid asset IDs are skipped (the route will have already errored on them).
 */
function buildSubmittedReleaseAssets(req) {
  const normalized = normalizeSelectedAssetIds(req.body.selectedAssetIds);
  // If malformed, return empty — the route will have already thrown 422
  // before reaching this function, but guard defensively.
  if (!normalized.valid) return [];
  const roles = req.body.roles || {};
  const sortOrders = req.body.sortOrder || {};

  const submitted = [];
  for (let i = 0; i < normalized.ids.length; i++) {
    const assetId = parseStrictInt(normalized.ids[i]);
    if (assetId === null) continue;
    const role = typeof roles[i] === 'string' && roles[i].trim() !== ''
      ? roles[i].trim().toLowerCase()
      : 'attachment';
    const sortOrder = parseNonNegativeInt(sortOrders[i]) ?? 0;
    submitted.push({ asset_id: assetId, role, sort_order: sortOrder });
  }
  return submitted;
}

/**
 * Parse a published-date form value.
 * Returns null for missing/empty input (so the caller can fall back), or the
 * trimmed string when present. Validation of the date format itself is left to
 * the service layer so the same rules apply regardless of entry point.
 */
function parsePublishedDateInput(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function createNotFound() {
  const err = new Error('Not found');
  err.status = 404;
  return err;
}

/**
 * Build a pagination URL function for the asset-management GET page.
 * Always targets /releases/:id/assets regardless of the current req.path
 * (which may be a POST mutation endpoint).
 *
 * @param {number} releaseId
 * @param {object} baseQuery - allow-listed candidate query parameters
 * @returns {function} pageUrl(overrides) -> string
 */
function buildAssetPageUrl(releaseId, baseQuery) {
  const basePath = `/releases/${releaseId}/assets`;
  return function pageUrl(overrides) {
    const query = { ...baseQuery };
    if (overrides.view !== undefined) {
      delete query.page;
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined || value === null || value === '' || (key === 'page' && value == 1)) {
        delete query[key];
      } else if (key === 'view' && value === RELEASE_ASSET_DEFAULT_VIEW) {
        delete query[key];
      } else {
        query[key] = String(value);
      }
    }
    const search = new URLSearchParams(query).toString();
    return search ? `${basePath}?${search}` : basePath;
  };
}

/**
 * Build a redirect URL for the asset-management GET page that preserves
 * normalized candidate filter and explicit view state. Only allow-listed
 * parameters are included: search, extension, page, pageSize, view.
 *
 * page is omitted when it is 1 (the default).
 * Unknown parameters and invalid values are stripped.
 *
 * @param {number} releaseId
 * @param {object} viewModel - normalized release asset page model
 * @param {object} [rawQuery]
 * @returns {string}
 */
function buildAssetRedirectUrl(releaseId, viewModel, rawQuery = {}) {
  const query = buildReleaseAssetPageQuery(viewModel, rawQuery);
  const search = new URLSearchParams(query).toString();
  return search ? `/releases/${releaseId}/assets?${search}` : `/releases/${releaseId}/assets`;
}

function buildReleaseAssetActionUrl(releaseId, viewModel, rawQuery, assetId, action) {
  const query = buildReleaseAssetPageQuery(viewModel, rawQuery);
  const search = new URLSearchParams(query).toString();
  const path = `/releases/${releaseId}/assets/${assetId}/${action}`;
  return search ? `${path}?${search}` : path;
}

function buildPageUrl(req, baseQuery = req.query) {
  // Use req.baseUrl + req.path to get the full path for pagination URLs.
  // req.path is relative to the router mount point, so we need baseUrl (e.g.
  // /releases or /release-management). When req.path is '/', we get a
  // trailing slash which we strip — this must work for any mount point, not
  // just /releases, since this handler is shared with /release-management.
  const rawPath = req.baseUrl + req.path;
  const cleanPath = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  return function pageUrl(overrides) {
    const query = { ...baseQuery };

    // When switching views, clear page state — pagination is view-specific
    if (overrides.view !== undefined) {
      delete query.page;
    }

    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined || value === null || value === '' || (key === 'page' && value == 1)) {
        delete query[key];
      } else {
        query[key] = String(value);
      }
    }
    const search = new URLSearchParams(query).toString();
    return search ? `${cleanPath}?${search}` : cleanPath;
  };
}

/**
 * Build the render-ready Category disclosure option model for the release
 * asset-management page. Each project category carries its whole-project
 * asset count (present + missing, independent of the active filters),
 * matching the project asset browser's navigation semantics.
 *
 * @param {Array} categories - project-owned category rows
 * @param {{ byCategoryId?: Object<number, number>, totalCount?: number, uncategorizedCount?: number }} [categoryNavigation]
 * @returns {Array<{ id: number, displayName: string, assetCount: number }>}
 */
function buildCategoryFilterOptions(categories, categoryNavigation = {}) {
  const byCategoryId = categoryNavigation && typeof categoryNavigation.byCategoryId === 'object'
    ? categoryNavigation.byCategoryId
    : {};
  return (Array.isArray(categories) ? categories : []).map((category) => ({
    id: category.id,
    displayName: category.display_name,
    assetCount: byCategoryId[category.id] || 0,
  }));
}
