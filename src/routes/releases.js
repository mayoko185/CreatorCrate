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
  RELEASE_STATUSES,
} from '../services/release-service.js';

const SORT_OPTIONS = ['updated', 'created', 'planned', 'title'];
const PAGE_SIZE = 25;
const RELEASES_PAGE_DEFAULTS = 'releases';
const RELEASE_MANAGEMENT_PAGE_DEFAULTS = 'releaseManagement';

export { handleReleaseListOrBoard, buildPageUrl, buildCreateReleaseFormModel };

export function createReleasesRouter({ appName, releaseService, projectService, workflowQueryService }) {
  const router = express.Router();

  // GET /releases — release-record list or board.
  router.get('/', (req, res, next) => {
    handleReleaseListOrBoard(req, res, next, {
      appName,
      workflowQueryService,
      pageDefaultsKey: RELEASES_PAGE_DEFAULTS,
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
    const assetCount = releaseAssets.length;

    // Published releases show a publication summary instead of readiness.
    // Archived releases (or archived-parent) also skip readiness.
    const isPublished = release.status === 'published';
    const isArchived = release.archived_at || (project && project.archived_at);
    const readiness = isPublished || isArchived ? null : workflowQueryService.getReleaseReadiness(id);

    res.render('releases/detail.njk', {
      appName,
      release,
      project,
      releaseAssets,
      assetCount,
      statuses: RELEASE_STATUSES,
      readiness,
    });
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
          values: req.body,
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
        res.status(422).render('releases/detail.njk', {
          appName,
          release: existing,
          project,
          releaseAssets,
          assetCount: releaseAssets.length,
          statuses: RELEASE_STATUSES,
          readiness: null,
          errors: { general: err.message },
        });
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

    // Redirect non-ready lifecycle states to release detail
    if (release.archived_at || (project && project.archived_at)) {
      return res.redirect(`/releases/${id}`);
    }
    if (['tbd', 'planned', 'in-progress', 'published', 'cancelled'].includes(release.status)) {
      return res.redirect(`/releases/${id}`);
    }

    // status is ready — render review page (publishable or blocked-ready)
    const releaseAssets = releaseService.listReleaseAssets(id);
    const readiness = workflowQueryService.getReleaseReadiness(id);

    // Resolve publication date for prefill: persisted date, otherwise local today
    const today = getLocalTodayIso();
    const prefillDate = release.published_date || today;

    res.render('releases/publish.njk', {
      appName,
      release,
      project,
      releaseAssets,
      assetCount: releaseAssets.length,
      statuses: RELEASE_STATUSES,
      readiness,
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
        const readiness = workflowQueryService.getReleaseReadiness(id);

        // Resolve prefill date: submitted value (even if invalid), then persisted, then today
        const today = getLocalTodayIso();
        const prefillDate = submittedDate || release.published_date || today;

        res.status(422).render('releases/publish.njk', {
          appName,
          release,
          project,
          releaseAssets,
          assetCount: releaseAssets.length,
          statuses: RELEASE_STATUSES,
          readiness,
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
        res.status(422).render('releases/detail.njk', {
          appName,
          release,
          project,
          releaseAssets,
          assetCount: releaseAssets.length,
          statuses: RELEASE_STATUSES,
          readiness: null,
          errors: { general: err.message },
        });
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
        const readiness = workflowQueryService.getReleaseReadiness(id);
        res.status(422).render('releases/detail.njk', {
          appName,
          release,
          project,
          releaseAssets,
          assetCount: releaseAssets.length,
          statuses: RELEASE_STATUSES,
          errors: err.errors,
          readiness,
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
        res.status(422).render('releases/detail.njk', {
          appName,
          release,
          project,
          releaseAssets,
          assetCount: releaseAssets.length,
          statuses: RELEASE_STATUSES,
          readiness: null,
          errors: { general: err.message },
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

    // Use the service-composed asset list for the existing bulk-selection form.
    const assets = viewModel.assets;

    // Build candidate page URL that preserves only candidate filters
    const candidateQuery = {};
    if (viewModel.candidateFilters.search) candidateQuery.search = viewModel.candidateFilters.search;
    if (viewModel.candidateFilters.extension) candidateQuery.extension = viewModel.candidateFilters.extension;
    if (viewModel.activeCategoryId !== null) candidateQuery.category = String(viewModel.activeCategoryId);
    if (viewModel.candidatePage > 1) candidateQuery.page = String(viewModel.candidatePage);
    if (viewModel.candidatePageSize !== 25) candidateQuery.pageSize = String(viewModel.candidatePageSize);
    const pageUrl = buildPageUrl(req, candidateQuery);

    res.render('releases/assets.njk', {
      appName,
      release: viewModel.release,
      project: viewModel.project,
      releaseAssets: viewModel.releaseAssets,
      assets,
      categories: viewModel.categories,
      activeCategoryId: viewModel.activeCategoryId,
      candidates: viewModel.candidates,
      candidateTotal: viewModel.candidateTotal,
      candidatePage: viewModel.candidatePage,
      candidatePageSize: viewModel.candidatePageSize,
      candidatePageCount: viewModel.candidatePageCount,
      candidateFilters: viewModel.candidateFilters,
      candidateExtensions: viewModel.candidateExtensions,
      statuses: RELEASE_STATUSES,
      roles: ['primary', 'preview', 'attachment', 'source'],
      pageUrl,
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
      // Parse selections from form: selectedAssetIds[] = assetId, roles[N] = role, sortOrder[N] = sortOrder
      // Note: express urlencoded with extended:true parses foo[1]=bar as object { '1': 'bar' }
      // But for arrays, selectedAssetIds[] becomes ['1', '2', ...] and roles/sortOrder indices are 0-based
      // to match the array position, NOT the asset ID. We use positional matching.
      //
      // When a role or sortOrder field is missing (e.g. disabled in a no-JS browser
      // submission for a newly-checked row), default to safe values rather than
      // rejecting the submission. The browser will not submit disabled controls, so
      // server must treat them as "use default".
      // Normalize to array: handle both single-value (selectedAssetIds=5) and
      // array (selectedAssetIds[]=5&selectedAssetIds[]=6) form submissions.
      const normalized = normalizeSelectedAssetIds(req.body.selectedAssetIds);

      // Reject malformed input shapes — never treat them as an intentional clear.
      if (!normalized.valid) {
        throw new ReleaseValidationError({ general: 'Invalid asset selection format.' });
      }

      // Express parses roles[1]=primary as { '0': 'primary' } (0-indexed to match array position)
      const roles = req.body.roles || {};
      const sortOrders = req.body.sortOrder || {};

      const selections = [];
      for (let i = 0; i < normalized.ids.length; i++) {
        const rawAssetId = normalized.ids[i];

        // Validate asset ID
        const assetId = parseStrictInt(rawAssetId);
        if (assetId === null) {
          throw new ReleaseValidationError({ general: 'Invalid asset selection.' });
        }

        // Get role and sortOrder by positional index. Missing values default to
        // 'attachment' / 0 so a no-JS submission still succeeds.
        const role = typeof roles[i] === 'string' && roles[i].trim() !== ''
          ? roles[i].trim().toLowerCase()
          : 'attachment';
        const sortOrderRaw = sortOrders[i];
        const sortOrder = parseNonNegativeInt(sortOrderRaw) ?? 0;

        selections.push({ assetId, role, sortOrder });
      }

      releaseService.selectAssets(id, selections);
      res.redirect(`/releases/${id}/assets`);
    } catch (err) {
      if (err instanceof ReleaseNotFoundError) {
        return next(createNotFound());
      }
      if (err instanceof ReleaseValidationError || err instanceof ReleasePublishedError) {
        const viewModel = releaseService.getReleaseAssetManagementPage(id, req.query);
        // Render the SUBMITTED selections so the user does not lose input.
        // Do NOT load persisted releaseAssets here — that would clobber the
        // user's changes after a validation failure.
        const submittedAssets = buildSubmittedReleaseAssets(req);
        const assets = viewModel.assets;
        const candidateQuery = {};
        if (viewModel.candidateFilters.search) candidateQuery.search = viewModel.candidateFilters.search;
        if (viewModel.candidateFilters.extension) candidateQuery.extension = viewModel.candidateFilters.extension;
        if (viewModel.activeCategoryId !== null) candidateQuery.category = String(viewModel.activeCategoryId);
        if (viewModel.candidatePage > 1) candidateQuery.page = String(viewModel.candidatePage);
        if (viewModel.candidatePageSize !== 25) candidateQuery.pageSize = String(viewModel.candidatePageSize);
        const pageUrl = buildAssetPageUrl(id, candidateQuery);
        res.status(422).render('releases/assets.njk', {
          appName,
          release: viewModel.release,
          project: viewModel.project,
          releaseAssets: submittedAssets,
          assets,
          categories: viewModel.categories,
          activeCategoryId: viewModel.activeCategoryId,
          candidates: viewModel.candidates,
          candidateTotal: viewModel.candidateTotal,
          candidatePage: viewModel.candidatePage,
          candidatePageSize: viewModel.candidatePageSize,
          candidatePageCount: viewModel.candidatePageCount,
          candidateFilters: viewModel.candidateFilters,
          candidateExtensions: viewModel.candidateExtensions,
          statuses: RELEASE_STATUSES,
          roles: ['primary', 'preview', 'attachment', 'source'],
          errors: err.errors || { general: err.message },
          pageUrl,
        });
        return;
      }
      if (err instanceof ReleaseArchivedError || err instanceof ReleaseParentArchivedError) {
        const viewModel = releaseService.getReleaseAssetManagementPage(id, req.query);
        const assets = viewModel.assets;
        const candidateQuery = {};
        if (viewModel.candidateFilters.search) candidateQuery.search = viewModel.candidateFilters.search;
        if (viewModel.candidateFilters.extension) candidateQuery.extension = viewModel.candidateFilters.extension;
        if (viewModel.activeCategoryId !== null) candidateQuery.category = String(viewModel.activeCategoryId);
        if (viewModel.candidatePage > 1) candidateQuery.page = String(viewModel.candidatePage);
        if (viewModel.candidatePageSize !== 25) candidateQuery.pageSize = String(viewModel.candidatePageSize);
        const pageUrl = buildAssetPageUrl(id, candidateQuery);
        res.status(422).render('releases/assets.njk', {
          appName,
          release: viewModel.release,
          project: viewModel.project,
          releaseAssets: viewModel.releaseAssets,
          assets,
          categories: viewModel.categories,
          activeCategoryId: viewModel.activeCategoryId,
          candidates: viewModel.candidates,
          candidateTotal: viewModel.candidateTotal,
          candidatePage: viewModel.candidatePage,
          candidatePageSize: viewModel.candidatePageSize,
          candidatePageCount: viewModel.candidatePageCount,
          candidateFilters: viewModel.candidateFilters,
          candidateExtensions: viewModel.candidateExtensions,
          statuses: RELEASE_STATUSES,
          roles: ['primary', 'preview', 'attachment', 'source'],
          errors: { general: err.message },
          pageUrl,
        });
        return;
      }
      next(err);
    }
  });

  // POST /releases/:id/assets/:assetId/remove — Remove a single selected asset from a release
  // This is a corrective mutation for missing assets that block readiness.
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
        res.status(422).render('releases/detail.njk', {
          appName,
          release,
          project,
          releaseAssets,
          assetCount: releaseAssets.length,
          statuses: RELEASE_STATUSES,
          errors: { general: err.message },
          readiness: null,
        });
        return;
      }
      if (err instanceof ReleasePublishedError || err instanceof ReleaseValidationError) {
        const project = projectService.findById(release.project_id);
        const releaseAssets = releaseService.listReleaseAssets(id);
        const readiness = workflowQueryService.getReleaseReadiness(id);
        res.status(422).render('releases/detail.njk', {
          appName,
          release,
          project,
          releaseAssets,
          assetCount: releaseAssets.length,
          statuses: RELEASE_STATUSES,
          errors: err.errors || { general: err.message },
          readiness,
        });
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
      res.redirect(buildAssetRedirectUrl(id, viewModel.candidateFilters, viewModel.candidatePage, viewModel.candidatePageSize));
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
      res.redirect(buildAssetRedirectUrl(id, viewModel.candidateFilters, viewModel.candidatePage, viewModel.candidatePageSize));
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
      res.redirect(buildAssetRedirectUrl(id, viewModel.candidateFilters, viewModel.candidatePage, viewModel.candidatePageSize));
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
      res.redirect(buildAssetRedirectUrl(id, viewModel.candidateFilters, viewModel.candidatePage, viewModel.candidatePageSize));
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
      res.redirect(buildAssetRedirectUrl(id, viewModel.candidateFilters, viewModel.candidatePage, viewModel.candidatePageSize));
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
  { appName, workflowQueryService, pageDefaultsKey = RELEASE_MANAGEMENT_PAGE_DEFAULTS },
) {
  try {
    const pageDefaultsService = getReleasePageDefaultsService(req, pageDefaultsKey);
    const rawQuery = req.query && typeof req.query === 'object' ? req.query : {};
    const presentation = resolveReleasePresentation(rawQuery, pageDefaultsService, pageDefaultsKey);
    const effectiveQuery = {
      ...rawQuery,
      sort: presentation.sort,
      order: presentation.order,
    };
    const normalizedFilters = workflowQueryService.normalizeListFilters(effectiveQuery);
    const basePath = req.baseUrl;

    if (presentation.view === 'board') {
      const { columns, today } = workflowQueryService.getReleaseBoard(effectiveQuery);
      const urlQuery = buildReleaseManagementUrlQuery(rawQuery, normalizedFilters, presentation);
      if (shouldRedirectToSavedReleaseManagementDefaults(rawQuery, presentation)) {
        return res.redirect(buildPageUrl(req, urlQuery)({}));
      }
      const pageUrl = buildPageUrl(req, urlQuery);
      const query = buildReleaseManagementRenderQuery(normalizedFilters, presentation);
      const clearUrl = buildPageUrl(
        req,
        buildReleaseManagementUrlQuery(
          rawQuery,
          normalizedFilters,
          presentation,
          normalizedFilters.page,
          { includeImplicitView: false },
        ),
      )(buildReleaseManagementClearOverrides());

      return res.render('releases/index.njk', {
        appName,
        view: 'board',
        columns,
        today,
        query,
        statuses: RELEASE_STATUSES,
        pageUrl,
        clearUrl,
        basePath,
      });
    }

    // List view
    const { releases, total, page, pageSize, pageCount, today, hasAnyReleases } = workflowQueryService.getReleaseList(effectiveQuery);
    const urlQuery = buildReleaseManagementUrlQuery(rawQuery, normalizedFilters, presentation, page);
    if (shouldRedirectToSavedReleaseManagementDefaults(rawQuery, presentation)) {
      return res.redirect(buildPageUrl(req, urlQuery)({}));
    }
    const pageUrl = buildPageUrl(req, urlQuery);
    const query = buildReleaseManagementRenderQuery(normalizedFilters, presentation, page);
    const clearUrl = buildPageUrl(
      req,
      buildReleaseManagementUrlQuery(
        rawQuery,
        normalizedFilters,
        presentation,
        page,
        { includeImplicitView: false },
      ),
    )(buildReleaseManagementClearOverrides());

    res.render('releases/index.njk', {
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
      statuses: RELEASE_STATUSES,
      sortOptions: SORT_OPTIONS,
      basePath,
    });
  } catch (err) {
    next(err);
  }
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
  if (normalizedFilters.status !== null) query.status = normalizedFilters.status;
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
  if (normalizedFilters.readiness !== 'all') query.readiness = normalizedFilters.readiness;

  return query;
}

function buildReleaseManagementRenderQuery(normalizedFilters, presentation, currentPage = normalizedFilters.page) {
  return {
    view: presentation.view,
    search: normalizedFilters.search || undefined,
    project: normalizedFilters.projectId === null ? undefined : String(normalizedFilters.projectId),
    status: normalizedFilters.status || undefined,
    schedule: normalizedFilters.schedule || undefined,
    includeArchived: normalizedFilters.includeArchived ? '1' : undefined,
    sort: presentation.sort,
    order: presentation.order,
    page: currentPage > 1 ? String(currentPage) : undefined,
    pageSize: String(normalizedFilters.pageSize),
    readiness: normalizedFilters.readiness,
  };
}

function buildReleaseManagementClearOverrides() {
  return {
    search: null,
    project: null,
    status: null,
    schedule: null,
    readiness: null,
    includeArchived: null,
    page: null,
  };
}

function hasReleaseManagementPresentationQuery(rawQuery) {
  return ['view', 'sort', 'order'].some((option) => Object.hasOwn(rawQuery, option));
}

function shouldRedirectToSavedReleaseManagementDefaults(rawQuery, presentation) {
  if (hasReleaseManagementPresentationQuery(rawQuery)) return false;

  return ['view', 'sort', 'order'].some((option) => {
    const setting = presentation.options[option];
    return setting.value !== setting.fallback;
  });
}

function buildNewReleaseFormValues(rawQuery) {
  const query = rawQuery && typeof rawQuery === 'object' && !Array.isArray(rawQuery)
    ? rawQuery
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

/**
 * Render the asset management page with an error message.
 * Preserves candidate filter state from the current request.
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
  const assets = viewModel.assets;
  const candidateQuery = {};
  if (viewModel.candidateFilters.search) candidateQuery.search = viewModel.candidateFilters.search;
  if (viewModel.candidateFilters.extension) candidateQuery.extension = viewModel.candidateFilters.extension;
  if (viewModel.activeCategoryId !== null) candidateQuery.category = String(viewModel.activeCategoryId);
  if (viewModel.candidatePage > 1) candidateQuery.page = String(viewModel.candidatePage);
  if (viewModel.candidatePageSize !== 25) candidateQuery.pageSize = String(viewModel.candidatePageSize);
  const pageUrl = buildAssetPageUrl(releaseId, candidateQuery);
  res.status(422).render('releases/assets.njk', {
    appName,
    release: viewModel.release,
    project: viewModel.project,
    releaseAssets: viewModel.releaseAssets,
    assets,
    categories: viewModel.categories,
    activeCategoryId: viewModel.activeCategoryId,
    candidates: viewModel.candidates,
    candidateTotal: viewModel.candidateTotal,
    candidatePage: viewModel.candidatePage,
    candidatePageSize: viewModel.candidatePageSize,
    candidatePageCount: viewModel.candidatePageCount,
    candidateFilters: viewModel.candidateFilters,
    candidateExtensions: viewModel.candidateExtensions,
    statuses: RELEASE_STATUSES,
    roles: ['primary', 'preview', 'attachment', 'source'],
    errors,
    pageUrl,
  });
}

function parseListQuery(raw) {
  const status = RELEASE_STATUSES.includes(raw.status) ? raw.status : undefined;
  const search = typeof raw.search === 'string' ? raw.search.trim() : '';
  const sortBy = SORT_OPTIONS.includes(raw.sort) ? raw.sort : 'updated';
  const order = raw.order === 'asc' ? 'asc' : 'desc';

  let page = Number.parseInt(raw.page, 10);
  if (!Number.isInteger(page) || page < 1) {
    page = 1;
  }

  const includeArchived = raw.includeArchived === '1';

  return {
    status,
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
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined || value === null || value === '' || (key === 'page' && value == 1)) {
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
 * normalized candidate filter state. Only allow-listed parameters are
 * included: search, extension, page, pageSize.
 *
 * page is omitted when it is 1 (the default).
 * Unknown parameters and invalid values are stripped.
 *
 * @param {number} releaseId
 * @param {object} candidateFilters - normalized filters from the view model
 * @param {number} candidatePage
 * @param {number} candidatePageSize
 * @returns {string}
 */
function buildAssetRedirectUrl(releaseId, candidateFilters, candidatePage, candidatePageSize) {
  const query = {};
  if (candidateFilters.search) query.search = candidateFilters.search;
  if (candidateFilters.extension) query.extension = candidateFilters.extension;
  if (candidatePage > 1) query.page = String(candidatePage);
  if (candidatePageSize !== 25) query.pageSize = String(candidatePageSize);
  const search = new URLSearchParams(query).toString();
  return search ? `/releases/${releaseId}/assets?${search}` : `/releases/${releaseId}/assets`;
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
