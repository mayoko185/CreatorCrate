import express from 'express';
import {
  createReleaseService,
  ReleaseValidationError,
  ReleaseNotFoundError,
  RELEASE_STATUSES,
  ACTIVE_RELEASE_STATUSES,
} from '../services/release-service.js';

const SORT_OPTIONS = ['updated', 'created', 'planned', 'title'];
const PAGE_SIZE = 25;

export function createReleasesRouter({ appName, releaseService, projectService, workflowQueryService }) {
  const router = express.Router();

  // GET /releases — Release list across all projects (list or board view)
  router.get('/', (req, res, next) => {
    try {
      const view = req.query.view === 'board' ? 'board' : 'list';

      if (view === 'board') {
        const { columns, today } = workflowQueryService.getReleaseBoard(req.query);
        const pageUrl = buildPageUrl(req);
        return res.render('releases/index.njk', {
          appName,
          view: 'board',
          columns,
          today,
          query: req.query,
          statuses: RELEASE_STATUSES,
          pageUrl,
        });
      }

      // List view
      const { releases, total, page, pageSize, pageCount, today } = workflowQueryService.getReleaseList(req.query);
      const pageUrl = buildPageUrl(req);

      res.render('releases/index.njk', {
        appName,
        view: 'list',
        releases,
        total,
        page,
        pageSize,
        pageCount,
        today,
        pageUrl,
        query: req.query,
        statuses: RELEASE_STATUSES,
        sortOptions: SORT_OPTIONS,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /releases/calendar — Monthly calendar view
  router.get('/calendar', (req, res, next) => {
    try {
      const month = req.query.month || null;
      const { month: validatedMonth, days, firstDayWeekday, prevMonth, nextMonth, today } = workflowQueryService.getReleaseCalendar(month);
      const pageUrl = buildPageUrl(req);

      res.render('releases/calendar.njk', {
        appName,
        month: validatedMonth,
        days,
        firstDayWeekday,
        prevMonth,
        nextMonth,
        today,
        query: req.query,
        pageUrl,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /releases/new — Create form (requires project selection)
  router.get('/new', (req, res, next) => {
    try {
      const { rows: projects } = projectService.list({ includeArchived: false, limit: 100 });
      if (projects.length === 0) {
        return res.status(422).render('releases/form.njk', {
          appName,
          release: null,
          values: req.query || {},
          errors: { general: 'No active projects found. Create a project first.' },
          statuses: RELEASE_STATUSES,
          activeStatuses: ACTIVE_RELEASE_STATUSES,
          projects: [],
          selectedProjectId: null,
          action: 'Create',
          submitUrl: '/releases',
        });
      }

      res.render('releases/form.njk', {
        appName,
        release: null,
        values: req.query || {},
        errors: {},
        statuses: RELEASE_STATUSES,
        activeStatuses: ACTIVE_RELEASE_STATUSES,
        projects,
        selectedProjectId: req.query.projectId || null,
        action: 'Create',
        submitUrl: '/releases',
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /releases — Create a release
  router.post('/', (req, res, next) => {
    try {
      const projectId = parseStrictInt(req.body.projectId);
      if (projectId === null) {
        throw new ReleaseValidationError({ projectId: 'Project is required.' });
      }

      const input = parseReleaseInput(req.body);
      const release = releaseService.createRelease(projectId, input);
      res.redirect(`/releases/${release.id}`);
    } catch (err) {
      if (err instanceof ReleaseValidationError) {
        const { rows: projects } = projectService.list({ includeArchived: false, limit: 100 });
        res.status(422).render('releases/form.njk', {
          appName,
          release: null,
          values: req.body,
          errors: err.errors,
          statuses: RELEASE_STATUSES,
          activeStatuses: ACTIVE_RELEASE_STATUSES,
          projects,
          selectedProjectId: req.body.projectId || null,
          action: 'Create',
          submitUrl: '/releases',
        });
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

    res.render('releases/detail.njk', {
      appName,
      release,
      project,
      releaseAssets,
      assetCount,
      statuses: RELEASE_STATUSES,
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

    const project = projectService.findById(release.project_id);
    const { rows: projects } = projectService.list({ includeArchived: false, limit: 100 });

    res.render('releases/form.njk', {
      appName,
      release,
      values: releaseToFormValues(release),
      errors: {},
      statuses: RELEASE_STATUSES,
      activeStatuses: ACTIVE_RELEASE_STATUSES,
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
          errors: err.errors,
          statuses: RELEASE_STATUSES,
          activeStatuses: ACTIVE_RELEASE_STATUSES,
          projects,
          selectedProjectId: req.body.projectId || (existing ? existing.project_id : null),
          action: 'Edit',
          submitUrl: `/releases/${id}`,
        });
        return;
      }
      next(err);
    }
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
        res.status(422).render('releases/detail.njk', {
          appName,
          release,
          project,
          releaseAssets,
          assetCount: releaseAssets.length,
          statuses: RELEASE_STATUSES,
          errors: err.errors,
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
        res.status(422).render('releases/detail.njk', {
          appName,
          release,
          project,
          releaseAssets,
          assetCount: releaseAssets.length,
          statuses: RELEASE_STATUSES,
          errors: err.errors,
        });
        return;
      }
      next(err);
    }
  });

  // GET /releases/:id/assets — Asset selection page
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

    // Load all present assets from the release's project
    const assets = releaseService.findProjectAssets(release.project_id);
    const releaseAssets = releaseService.listReleaseAssets(id);

    res.render('releases/assets.njk', {
      appName,
      release,
      project,
      assets,
      releaseAssets,
      statuses: RELEASE_STATUSES,
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
      if (err instanceof ReleaseValidationError) {
        const project = projectService.findById(release.project_id);
        const assets = releaseService.findProjectAssets(release.project_id);
        // Render the SUBMITTED selections so the user does not lose input.
        // Do NOT load persisted releaseAssets here — that would clobber the
        // user's changes after a validation failure.
        const releaseAssets = buildSubmittedReleaseAssets(req);
        res.status(422).render('releases/assets.njk', {
          appName,
          release,
          project,
          assets,
          releaseAssets,
          statuses: RELEASE_STATUSES,
          roles: ['primary', 'preview', 'attachment', 'source'],
          errors: err.errors,
        });
        return;
      }
      next(err);
    }
  });

  return router;
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
    status: body.status,
    plannedDate: body.plannedDate || null,
    publishedDate: body.publishedDate || null,
    patreonUrl: body.patreonUrl || null,
  };
}

function releaseToFormValues(release) {
  return {
    title: release.title,
    description: release.description,
    notes: release.notes,
    status: release.status,
    plannedDate: release.planned_date || '',
    publishedDate: release.published_date || '',
    patreonUrl: release.patreon_url || '',
  };
}

function parseId(value) {
  const id = parseStrictInt(value);
  return id;
}

/**
 * Parse an integer strictly — rejects non-numeric strings, floats, hex, etc.
 * Returns null if the value is not a valid positive integer string.
 * Does NOT use parseInt as validation.
 */
function parseStrictInt(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const str = String(value).trim();
  if (!/^[1-9]\d*$/.test(str)) return null;
  const num = Number(str);
  if (!Number.isInteger(num) || num < 1) return null;
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

function buildPageUrl(req) {
  // Use req.baseUrl + req.path to get the full path for pagination URLs
  // req.path is relative to the router mount point (/), so we need baseUrl (/releases)
  // When req.path is '/', we get a trailing slash which we strip
  const basePath = req.baseUrl + req.path;
  const cleanPath = basePath === '/releases/' ? '/releases' : basePath;
  return function pageUrl(overrides) {
    const query = { ...req.query };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined || value === null || value === '') {
        delete query[key];
      } else {
        query[key] = String(value);
      }
    }
    const search = new URLSearchParams(query).toString();
    return search ? `${cleanPath}?${search}` : cleanPath;
  };
}
