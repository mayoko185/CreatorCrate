import path from 'node:path';
import express from 'express';
import nunjucks from 'nunjucks';
import { fileURLToPath } from 'node:url';
import { createIndexRouter } from './routes/index.js';
import { createHealthRouter } from './routes/health.js';
import { createProjectsRouter } from './routes/projects.js';
import { createAssetsRouter } from './routes/assets.js';
import { createProjectAssetCategoriesRouter } from './routes/project-asset-categories.js';
import { createReleasesRouter } from './routes/releases.js';
import { createReleaseManagementRouter } from './routes/release-management.js';
import { createCalendarRouter } from './routes/calendar.js';
import { createMediaRouter } from './routes/media.js';
import { createSettingsRouter } from './routes/settings.js';
import { createProjectService } from './services/project-service.js';
import { createAssetCategoryRepository } from './data/asset-category-repository.js';
import { createAssetCategoryService } from './services/asset-category-service.js';
import { createProjectAssetCategoryService } from './services/project-asset-category-service.js';
import { createAssetScanner } from './services/asset-scanner.js';
import { createReleaseService } from './services/release-service.js';
import { createWorkflowQueryService } from './services/workflow-query-service.js';
import { evaluateReleaseReadiness } from './services/release-readiness-policy.js';
import { createPreviewService } from './services/preview-service.js';
import { createMediaService } from './services/media-service.js';
import { createBackupService } from './services/backup-service.js';
import { createAuthService } from './services/auth-service.js';
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
  // instance is what a future Settings router will receive too.
  const assetCategoryRepository = opts.assetCategoryRepository || createAssetCategoryRepository(db);
  const assetCategoryService = opts.assetCategoryService || createAssetCategoryService(assetCategoryRepository);

  const projectService = createProjectService(db, projectsRoot, { assetCategoryService });
  const assetScanner = createAssetScanner(db, projectsRoot, { projectService, assetCategoryService });

  // Phase 2 chunk 2: project-specific category mutations. Reuses the
  // project repository (via projectService.repository) and the asset
  // repository (via assetScanner.repository) rather than constructing
  // duplicates. The router mounted below (Phase 2 chunk 3) receives this
  // service explicitly.
  const projectAssetCategoryService = opts.projectAssetCategoryService || createProjectAssetCategoryService({
    db,
    projectRepository: projectService.repository,
    assetCategoryRepository,
    assetRepository: assetScanner.repository,
    projectsRoot,
  });
  app.locals.projectAssetCategoryService = projectAssetCategoryService;

  const releaseService = opts.releaseService || createReleaseService({ db, evaluateReleaseReadiness });
  const workflowQueryService = opts.workflowQueryService || createWorkflowQueryService({ db, evaluateReleaseReadiness });

  // Phase 10.1A: preview root is passed explicitly so later services can
  // resolve preview paths without reading the environment or globals.
  app.locals.previewRoot = previewRoot;

  // Phase 10.1C: construct the preview + media services per createApp call
  // (no hidden singleton). Tests may inject stubs via opts.previewService /
  // opts.mediaService to keep createApp testable with temporary roots and
  // stubbed services. Production construction uses the configured
  // PROJECTS_ROOT, configured preview root, project repository, asset
  // repository, storage helper (openAssetFile), and Sharp media processor
  // (via the preview service).
  const previewService =
    opts.previewService ||
    (previewRoot
      ? createPreviewService({ db, projectsRoot, previewRoot })
      : null);

  const mediaService =
    opts.mediaService ||
    (previewService && previewRoot && projectsRoot
      ? createMediaService({ previewService, projectsRoot, previewRoot })
      : null);

  app.locals.previewService = previewService;
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

  // Media routes stay before the asset browser/viewer router. The media
  // routes have four path segments under /projects; the viewer route has
  // three, but this ordering protects the media contract from future route
  // broadening.
  if (mediaService) {
    app.use('/projects', createMediaRouter({ mediaService }));
  }

  app.use('/projects', createAssetsRouter({ appName, projectService, assetScanner, workflowQueryService, releaseService }));

  // Phase 2 chunk 3: project-specific category routes. The router receives
  // the already-constructed `projectAssetCategoryService` explicitly — it
  // never constructs a repository or service of its own.
  app.use('/projects', createProjectAssetCategoriesRouter({ appName, projectService, projectAssetCategoryService }));

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
    authSettings: opts.authSettings,
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
