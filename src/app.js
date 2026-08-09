import path from 'node:path';
import express from 'express';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'node:url';
import { createIndexRouter } from './routes/index.js';
import { createHealthRouter } from './routes/health.js';
import { createProjectsRouter } from './routes/projects.js';
import { createAssetsRouter } from './routes/assets.js';
import { createAssetLibraryRouter } from './routes/asset-library.js';
import { createProjectAssetCategoriesRouter } from './routes/project-asset-categories.js';
import { createProjectTagsRouter } from './routes/project-tags.js';
import { createAssetTagsRouter } from './routes/asset-tags.js';
import { createReleasesRouter } from './routes/releases.js';
import { createReleaseManagementRouter } from './routes/release-management.js';
import { createCalendarRouter } from './routes/calendar.js';
import { createMediaRouter } from './routes/media.js';
import { createSettingsRouter } from './routes/settings.js';
import { createDownloadsRouter } from './routes/downloads.js';
import { createProjectService } from './services/project-service.js';
import { createAssetCategoryRepository } from './data/asset-category-repository.js';
import { createAssetCategoryService } from './services/asset-category-service.js';
import { createAssetBrowserPreferenceRepository } from './data/asset-browser-preference-repository.js';
import { createAppMetaRepository } from './data/app-meta-repository.js';
import { createTagRepository } from './data/tag-repository.js';
import { createProjectPrimaryImageRepository } from './data/project-primary-image-repository.js';
import { createAssetBrowserPreferenceService } from './services/asset-browser-preference-service.js';
import { createPageDefaultsService } from './services/page-defaults-service.js';
import { createOpenLocallySettingsService } from './services/open-locally-settings-service.js';
import { createPreviewCategorySettingsService } from './services/preview-category-settings-service.js';
import { createNsfwFilterSettingsService } from './services/nsfw-filter-settings-service.js';
import { createProjectAssetCategoryService } from './services/project-asset-category-service.js';
import { createAssetScanner } from './services/asset-scanner.js';
import { createAssetActionService } from './services/asset-action-service.js';
import { createAutoRenameService } from './services/auto-rename-service.js';
import { createProjectPrimaryImageService } from './services/project-primary-image-service.js';
import { createProjectOperationCoordinator } from './services/project-operation-coordinator.js';
import { createReleaseService } from './services/release-service.js';
import { createWorkflowQueryService } from './services/workflow-query-service.js';
import { createPreviewService } from './services/preview-service.js';
import { createMediaService } from './services/media-service.js';
import { createBackupService } from './services/backup-service.js';
import { createAuthService } from './services/auth-service.js';
import { createTagService } from './services/tag-service.js';
import { createProjectTagService } from './services/project-tag-service.js';
import { createAssetTagService } from './services/asset-tag-service.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createCsrfMiddleware, createDisabledModeCsrfMiddleware } from './middleware/csrf.js';
import { createSecurityHeadersMiddleware, createCachePolicyMiddleware } from './middleware/security-headers.js';
import { createAuthRouter } from './routes/auth.js';
import { createLoginThrottler } from './auth/login-throttle.js';
import { createAuthTransitionService } from './auth/auth-transition-service.js';
import { buildShellModel } from './shell/navigation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SESSION_COOKIE_NAME = 'cc_session';

export function createApp({ appName, db, projectsRoot, previewRoot }, opts = {}) {
  const app = express();
  // Phase 12.1: forwarded via `opts` (like databasePath/backupService/etc.)
  // rather than the first positional arg, so app-context.js's replaceDatabase
  // rebuild path (which threads appOpts straight through) carries it too.
  const authConfig = opts.authConfig;
  if (authConfig && authConfig.trustProxy) {
    app.set('trust proxy', true);
  }

  const env = nunjucks.configure(path.join(__dirname, 'views'), {
    autoescape: true,
    express: app,
    noCache: true,
  });
  app.set('view engine', 'njk');

  // Phase 11.2: exclusive maintenance boundary. While a restore owns this
  // flag, ordinary requests must not reach a route that could touch a
  // closing/reopening database connection. Health reporting and static
  // assets remain reachable; this is the very first middleware so no other
  // work (body parsing, static lookup, routing) happens for a blocked
  // request. The object is shared (by reference) with the settings router
  // and, in production, across app rebuilds triggered by a live restore —
  // it is never reassigned, only mutated.
  const maintenanceState = opts.maintenanceState || { active: false };
  app.use((req, res, next) => {
    if (!maintenanceState.active) return next();
    if (req.path === '/health') return next();
    // Static assets have a file extension; application routes never do.
    if (req.method === 'GET' && /\.[A-Za-z0-9]+$/.test(req.path)) return next();

    res.status(503);
    if (req.accepts('html')) {
      res
        .type('html')
        .send(
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Maintenance</title></head>' +
          '<body><main><h1>Service temporarily unavailable</h1>' +
          '<p>CreatorCrate is restoring the database from a backup. Please try again in a moment.</p>' +
          '</main></body></html>'
        );
      return;
    }
    res.json({ status: 'error', message: 'Service temporarily unavailable for maintenance.' });
  });

  app.use(createSecurityHeadersMiddleware({ hstsEnabled: authConfig ? authConfig.hstsEnabled : false }));

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, 'static'), {
    index: false,
  }));

  // Phase 1 (asset categories): dependencies are constructed once here and
  // threaded explicitly — the repository receives the database, the service
  // receives the repository, and projectService receives the already-built
  // service. Nothing downstream constructs its own repository. The same
  // instance is passed to the Settings router too.
  const appMetaRepository = opts.appMetaRepository || createAppMetaRepository(db);
  app.locals.appMetaRepository = appMetaRepository;
  const assetCategoryRepository = opts.assetCategoryRepository || createAssetCategoryRepository(db);
  const assetCategoryService = opts.assetCategoryService || createAssetCategoryService(assetCategoryRepository);
  const assetBrowserPreferenceRepository =
    opts.assetBrowserPreferenceRepository || createAssetBrowserPreferenceRepository(db, { appMetaRepository });
  const previewCategorySettingsService =
    opts.previewCategorySettingsService || createPreviewCategorySettingsService({
      appMetaRepository,
      assetCategoryService,
    });
  app.locals.previewCategorySettingsService = previewCategorySettingsService;

  const pageDefaultsService =
    opts.pageDefaultsService || createPageDefaultsService({ appMetaRepository });
  app.locals.pageDefaultsService = pageDefaultsService;

  // Phase: Open locally v2 — one app-scoped settings service over the shared
  // app-meta repository. Owns the configured Windows projects root used to
  // build v2 "Open locally" URIs; the Settings UI is a later phase.
  const openLocallySettingsService =
    opts.openLocallySettingsService || createOpenLocallySettingsService({ appMetaRepository });
  app.locals.openLocallySettingsService = openLocallySettingsService;

  const projectService = createProjectService(db, projectsRoot, {
    assetCategoryService,
    assetBrowserPreferenceRepository,
  });
  app.locals.projectService = projectService;

  const assetBrowserPreferenceService =
    opts.assetBrowserPreferenceService ||
    createAssetBrowserPreferenceService({
      preferenceRepository: assetBrowserPreferenceRepository,
      projectRepository: projectService.repository,
      assetCategoryRepository,
    });
  app.locals.assetBrowserPreferenceService = assetBrowserPreferenceService;

  // Phase: asset actions chunk 3 — one process-local coordinator shared by
  // the scanner and the asset action service so a scan and a rename/move
  // can never interleave for the same project. app-context.js supplies this
  // via opts on every rebuild (including live-restore) so the SAME instance
  // survives reconstruction; this fallback only matters for callers (tests,
  // ad-hoc scripts) that construct createApp directly without app-context.
  const projectOperationCoordinator = opts.projectOperationCoordinator || createProjectOperationCoordinator();

  const projectPrimaryImageRepository = createProjectPrimaryImageRepository(db);
  const assetScanner = createAssetScanner(db, projectsRoot, {
    projectService,
    assetCategoryService,
    projectOperationCoordinator,
    previewCategorySettingsService,
    projectPrimaryImageRepository,
  });
  app.locals.assetScanner = assetScanner;

  const tagRepository = opts.tagRepository || createTagRepository(db);
  const tagService = opts.tagService || createTagService({ tagRepository });
  const projectTagService = opts.projectTagService || createProjectTagService({
    tagRepository,
    projectRepository: projectService.repository,
  });
  const assetTagService = opts.assetTagService || createAssetTagService({
    tagRepository,
    assetRepository: assetScanner.repository,
  });
  app.locals.tagService = tagService;
  app.locals.projectTagService = projectTagService;
  app.locals.assetTagService = assetTagService;
  const nsfwFilterSettingsService = opts.nsfwFilterSettingsService || createNsfwFilterSettingsService({
    appMetaRepository,
    tagService,
  });
  app.locals.nsfwFilterSettingsService = nsfwFilterSettingsService;

  // Phase 2 chunk 2: project-specific category mutations. Reuses the
  // project repository (via projectService.repository) and the asset
  // repository (via assetScanner.repository) rather than constructing
  // duplicates. The router mounted below (Phase 2 chunk 3) receives this
  // service explicitly.
  const projectAssetCategoryService = opts.projectAssetCategoryService || (projectsRoot
    ? createProjectAssetCategoryService({
      db,
      projectRepository: projectService.repository,
      assetCategoryRepository,
      assetRepository: assetScanner.repository,
      assetBrowserPreferenceRepository,
      projectsRoot,
    })
    : null);
  app.locals.projectAssetCategoryService = projectAssetCategoryService;

  // Phase: asset actions chunk 3 — rename/move filesystem action service.
  // Shares projectService.repository / assetScanner.repository (no
  // duplicate repository construction) and the same coordinator instance
  // as assetScanner, so a scan and a rename/move for one project can never
  // interleave. Wired into the asset browser/viewer routes below.
  const assetActionService = opts.assetActionService || (projectsRoot
    ? createAssetActionService({
      projectRepository: projectService.repository,
      assetRepository: assetScanner.repository,
      assetCategoryRepository,
      projectsRoot,
      projectOperationCoordinator,
    })
    : null);
  app.locals.assetActionService = assetActionService;

  // Phase H3: Auto Rename is one application-scoped service per rooted app
  // build. It reuses the already-constructed project repository, asset
  // repository, and operation coordinator; no database connection or lock is
  // created here. app-context.js supplies one signing key across rebuilds so
  // a live database replacement does not invalidate an otherwise active
  // application context. Direct createApp callers may inject either the
  // service or a deterministic signing key for tests.
  const autoRenameService = projectsRoot
    ? (opts.autoRenameService || createAutoRenameService({
      projectRepository: projectService.repository,
      assetRepository: assetScanner.repository,
      assetCategoryRepository,
      projectsRoot,
      projectOperationCoordinator,
      signingKey: opts.autoRenameSigningKey,
    }))
    : null;
  app.locals.autoRenameService = autoRenameService;

  // Phase 10.1C: construct one app-scoped preview service before primary-image
  // dependencies so KRA eligibility probes share its descriptor safety and
  // per-asset lock state. Rootless applications keep the probe unavailable.
  const previewService =
    opts.previewService ||
    (previewRoot
      ? createPreviewService({ db, projectsRoot, previewRoot })
      : null);

  app.locals.previewRoot = previewRoot;
  app.locals.previewService = previewService;

  const projectPrimaryImageService = createProjectPrimaryImageService({
    db,
    projectRepository: projectService.repository,
    assetRepository: assetScanner.repository,
    projectPrimaryImageRepository,
    previewProbe: previewService?.inspectKritaPreviewSource,
  });
  app.locals.projectPrimaryImageRepository = projectPrimaryImageRepository;
  app.locals.projectPrimaryImageService = projectPrimaryImageService;

  const releaseService = opts.releaseService || createReleaseService({ db });
  const workflowQueryService = opts.workflowQueryService || createWorkflowQueryService({
    db,
    projectPrimaryImageRepository,
    assetBrowserPreferenceService,
    tagRepository,
  });

  // Phase 10.1C: media service reuses the exact preview service instance
  // above, including its locks and cache state.
  const mediaService =
    opts.mediaService ||
    (previewService && previewRoot && projectsRoot
      ? createMediaService({ previewService, projectsRoot, previewRoot })
      : null);

  app.locals.mediaService = mediaService;

  // Phase 11.2: backup/restore. `databasePath`/`appDataRoot` default to the
  // live connection's own file path (better-sqlite3 exposes it as `db.name`)
  // so callers that already have an open `db` never need to repeat the path.
  // migrationsDir defaults to the application's real migrations directory.
  const databasePath = opts.databasePath || db.name;
  const appDataRoot = opts.appDataRoot || path.dirname(databasePath);
  const migrationsDir = opts.migrationsDir || path.join(__dirname, '..', 'migrations');
  const backupService =
    opts.backupService ||
    createBackupService({ appDataRoot, databasePath, migrationsDir, retentionCount: opts.backupRetentionCount });

  // Phase 12.1: single-operator authentication foundation. Deliberately
  // opt-in via `authConfig` — omitting it (as every pre-Phase-12.1 test and
  // caller does) reproduces the exact prior behavior with no login wall and
  // no cookies set, so this never changes project/release/asset/media/backup
  // domain behavior on its own. Real startup (server.js) always supplies
  // `authConfig` from validated env, where missing configuration already
  // fails at createConfig() time.
  const credentialProvider = opts.credentialProvider || authConfig?.credentialProvider;
  const authService = opts.authService || (authConfig ? createAuthService({ db, ...authConfig, credentialProvider }) : null);
  const loginThrottler = opts.loginThrottler || createLoginThrottler({ now: opts.now || Date.now });

  const cookieOptions = {
    name: SESSION_COOKIE_NAME,
    path: '/',
    secure: authConfig ? authConfig.cookieSecure : false,
    maxAgeMs: authConfig ? authConfig.sessionTtlHours * 60 * 60 * 1000 : undefined,
  };

  let resolveSession = (_req, res, next) => {
    res.locals.auth = { enabled: false, authenticated: false };
    next();
  };
  let requireAuth = (_req, _res, next) => next();
  let exposeCsrfToken = (_req, _res, next) => next();
  let requireCsrf = (_req, _res, next) => next();

  if (authService) {
    const authMiddleware = createAuthMiddleware({ authService, cookieOptions });
    resolveSession = authMiddleware.resolveSession;
    requireAuth = authMiddleware.requireAuth;
    const csrfMiddleware = createCsrfMiddleware({ authService, cookieOptions });
    exposeCsrfToken = csrfMiddleware.exposeCsrfToken;
    requireCsrf = csrfMiddleware.requireCsrf;
  } else if (opts.authState?.csrfPepper) {
    // Phase 13: CSRF still protects state-changing forms while authentication
    // is disabled — see middleware/csrf.js for why this needs a persistent,
    // server-only pepper rather than a plain double-submit cookie. Tests that
    // build createApp with neither authConfig nor authState (the vast
    // majority of pre-Phase-13 fixtures) keep today's no-op behavior, which
    // is intentional — see createAuthTransitionService below for the one
    // place production code always supplies a pepper.
    const disabledCsrf = createDisabledModeCsrfMiddleware({
      cookieSecure: authConfig ? authConfig.cookieSecure : false,
      csrfPepper: opts.authState.csrfPepper,
    });
    exposeCsrfToken = disabledCsrf.exposeCsrfToken;
    requireCsrf = disabledCsrf.requireCsrf;
  }

  // Phase 13: coordinates every enable/disable transition (see
  // auth-transition-service.js for the staged-write/rollback contract). Built
  // fresh per createApp call so it always closes over the current `db` and
  // the current `onAuthConfigReplaced` rebuild hook.
  const authTransitionService = createAuthTransitionService({
    appDataRoot,
    db,
    replaceAuthConfig: opts.onAuthConfigReplaced || (() => {}),
    authSettings: opts.authSettings || {},
    csrfPepper: opts.authState?.csrfPepper,
    authService,
  });

  app.use(resolveSession);
  app.use(createCachePolicyMiddleware());

  // Phase 12.2: expose CSRF token for template rendering on every request.
  // This must run after resolveSession (so auth.csrfSecret is available) but
  // before any route handler that renders a form.
  app.use(exposeCsrfToken);

  // Phase 12.2: CSRF protection for all state-changing requests. This must
  // run after resolveSession + exposeCsrfToken so authenticated-session
  // context is available for token verification, but BEFORE the auth router
  // so POST /logout is also CSRF-protected. Login POST is exempt (it verifies
  // its own anonymous CSRF token). GET/HEAD/OPTIONS are always exempt.
  app.use(requireCsrf);

  if (authService) {
    app.use(createAuthRouter({ appName, authService, cookieOptions, loginThrottler, trustProxy: !!authConfig?.trustProxy }));
  } else {
    // Phase 13: authentication is disabled, so there is no session/CSRF
    // machinery for a real login form. Point visitors at the one place they
    // can actually do something: Settings > Security's enable-authentication
    // workflow.
    app.get('/login', (_req, res) => res.redirect('/settings/security'));
  }

  // Phase 10.4A: shared application-shell context. Computed once per request
  // from req.path so every rendered page — and the centralized error handler
  // — receives one navigation model with correct active states. Individual
  // routes never assemble the navigation array themselves.
  app.use((req, res, next) => {
    res.locals.shell = buildShellModel({ appName, path: req.path });
    next();
  });

  // Protects everything mounted below. requireAuth internally exempts
  // /health and /login|/logout regardless of mount order; static assets are
  // already fully handled above and never reach this middleware.
  app.use(requireAuth);

  app.use('/', createIndexRouter({ appName, workflowQueryService }));
  app.use('/health', createHealthRouter({ db, maintenanceState }));
  app.use('/projects', createProjectsRouter({ appName, projectService, workflowQueryService }));
  app.use('/assets', createAssetLibraryRouter({ appName, workflowQueryService }));

  // Media routes stay before the asset browser/viewer router. The media
  // routes have four path segments under /projects; the viewer route has
  // three, but this ordering protects the media contract from future route
  // broadening.
  if (mediaService) {
    app.use('/projects', createMediaRouter({ mediaService }));
  }

  // The Assets router combines database-backed browser queries with
  // filesystem-backed scanning and mutation handlers. Rootless applications
  // intentionally do not construct those filesystem services, so omit the
  // complete router instead of mounting handlers that would receive null
  // dependencies and fail at request time.
  if (projectsRoot) {
    app.use('/projects', createAssetsRouter({
      appName,
      projectService,
      assetScanner,
      workflowQueryService,
      releaseService,
      assetActionService,
      assetBrowserPreferenceService,
      autoRenameService,
      projectPrimaryImageService,
      previewProbe: previewService?.inspectKritaPreviewSource,
    }));

    if (typeof workflowQueryService.getProjectAssetViewer === 'function') {
      app.use('/projects', createAssetTagsRouter({ appName, workflowQueryService }));
    }
  }

  // Phase 2 chunk 3: project-specific category routes. The router receives
  // the already-constructed `projectAssetCategoryService` explicitly — it
  // never constructs a repository or service of its own.
  if (projectAssetCategoryService) {
    app.use('/projects', createProjectAssetCategoriesRouter({
      appName,
      projectService,
      projectAssetCategoryService,
      assetBrowserPreferenceService,
      releaseService,
    }));
  }

  app.use('/projects', createProjectTagsRouter({ appName, projectService }));

  // Phase: Open locally installer — serves the fixed Windows setup artifact
  // from the application-controlled downloads/ directory. Mounted before the
  // catch-all 404 so the download route is always reachable.
  app.use('/downloads', createDownloadsRouter({ downloadsRoot: opts.downloadsRoot }));

  app.use('/releases', createReleasesRouter({ appName, releaseService, projectService, workflowQueryService }));

  // Phase 2A: dedicated release-management route, reusing the release-record
  // list/board handler unchanged. Mounted after /releases so route order
  // does not affect either — the two mount points do not overlap.
  app.use('/release-management', createReleaseManagementRouter({ appName, workflowQueryService }));

  // Phase 2D: canonical project-backed calendar route. Mounted after
  // /releases so /releases/calendar's compatibility redirect and this route
  // never overlap.
  app.use('/calendar', createCalendarRouter({ appName, workflowQueryService }));

  app.use('/settings', createSettingsRouter({
    appName,
    db,
    assetCategoryService,
    backupService,
    maintenanceState,
    authService,
    cookieOptions,
    onDatabaseReplaced: opts.onDatabaseReplaced,
    authTransitionService,
    // Phase 13.4: read-only overview values — deployment-controlled, never
    // user-editable from the Settings UI.
    projectsRoot,
    databasePath,
    appDataRoot,
    backupRetentionCount: opts.backupRetentionCount,
    autoScanIntervalMinutes: opts.autoScanIntervalMinutes,
    appMetaRepository,
    authSettings: opts.authSettings,
    assetBrowserPreferenceService,
    previewCategorySettingsService,
  }));

  app.use((_req, _res, next) => {
    const err = new Error('Not found');
    err.status = 404;
    next(err);
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) {
      return next(err);
    }

    const status = err.status || err.statusCode || 500;
    const isClientError = status >= 400 && status < 500;

    // Unexpected server errors (5xx) may contain sensitive error-state
    // pages or stack traces. Prevent caching so stale error pages never
    // pollute a client's cache. Controlled domain statuses (4xx) are left
    // untouched — their cache policy is set by the route that handled them.
    if (status >= 500) {
      res.setHeader('Cache-Control', 'no-store');
      res.removeHeader('Content-Type');
      res.removeHeader('Content-Length');
      res.removeHeader('Content-Disposition');
      res.removeHeader('ETag');
      res.removeHeader('X-Content-Type-Options');
    }

    res.status(status);

    if (req.accepts('html')) {
      // Controlled error / not-found pages render with no active nav item so
      // a missing record never highlights a section the request never reached.
      res.render('error.njk', {
        status,
        message: isClientError ? err.message : 'Something went wrong.',
        shell: buildShellModel({ appName, path: req.path, noActive: true }),
      });
      return;
    }

    res.json({ status: 'error', message: isClientError ? err.message : 'Internal server error.' });
  });

  return app;
}
