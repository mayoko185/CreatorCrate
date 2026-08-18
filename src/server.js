import 'dotenv/config';

import http from 'node:http';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConfig, ConfigError } from './config.js';
import { validateMounts, FilesystemError } from './filesystem.js';
import { ensurePreviewRoot, StorageError } from './storage/path-manager.js';
import { openDatabase, runMigrations, closeDatabase, DatabaseError } from './db.js';
import { createBackupService } from './services/backup-service.js';
import { createAutomaticProjectScanScheduler } from './services/automatic-project-scan-scheduler.js';
import { createApplicationContext } from './app-context.js';
import { ASSET_MODES, resolveAssetMode } from './app.js';
import { createManagedCredentialProvider, CredentialError } from './auth/credential-provider.js';
import { ensureAuthEnablement, AuthStateError } from './auth/auth-state.js';
import {
  AssetManifestError,
  createAssetManifest,
  VITE_ENTRY_KEY,
} from './asset-manifest.js';

export function loadProductionAssetManifest(options = {}) {
  return createAssetManifest({
    ...options,
    requiredEntries: [VITE_ENTRY_KEY],
  });
}

export async function createDevelopmentViteServer({
  nodeEnv,
  parentServer,
  loadVite = () => import('vite'),
} = {}) {
  if (resolveAssetMode(nodeEnv) !== ASSET_MODES.DEVELOPMENT) return null;
  if (!parentServer) {
    throw new TypeError('createDevelopmentViteServer requires a parent HTTP server.');
  }
  if (typeof loadVite !== 'function') {
    throw new TypeError('createDevelopmentViteServer requires a Vite module loader.');
  }

  const vite = await loadVite();
  if (!vite || typeof vite.createServer !== 'function') {
    throw new TypeError('The Vite module must expose createServer().');
  }

  return vite.createServer({
    configFile: false,
    server: {
      hmr: { server: parentServer },
      middlewareMode: { server: parentServer },
    },
    appType: 'custom',
  });
}

export function createApplicationRequestHandler(appContext, viteServer = null) {
  if (!appContext || typeof appContext.handleRequest !== 'function') {
    throw new TypeError('createApplicationRequestHandler requires an application context.');
  }
  if (viteServer && typeof viteServer.middlewares !== 'function') {
    throw new TypeError('createApplicationRequestHandler requires Vite middlewares().');
  }

  if (!viteServer) {
    return (req, res) => appContext.handleRequest(req, res);
  }

  return (req, res) => viteServer.middlewares(req, res, () => appContext.handleRequest(req, res));
}

export async function runInitialWatermarkScan(appContext, logger = console) {
  const watermarkService = appContext?.app?.locals?.watermarkService;
  if (!watermarkService || typeof watermarkService.scanWatermarks !== 'function') {
    throw new TypeError('Initial startup scan requires a global Watermark service.');
  }

  try {
    const scan = await watermarkService.scanWatermarks();
    logger.log(
      `[CreatorCrate] Initial global Watermark scan completed: ` +
      `${scan.total} present, ${scan.added} added, ${scan.updated} updated, ` +
      `${scan.restored} restored, ${scan.removed} removed, ${scan.failed || 0} failed.`
    );
    return scan;
  } catch (err) {
    logger.error(`[CreatorCrate] Initial global Watermark scan failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function main() {
  let config;
  try {
    config = createConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  try {
    validateMounts(config);
  } catch (err) {
    if (err instanceof FilesystemError) {
      console.error(`Filesystem error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // Phase 10.1A: ensure the derived preview root exists before serving.
  try {
    ensurePreviewRoot(config.previewRoot);
  } catch (err) {
    if (err instanceof StorageError) {
      console.error(`Storage error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  let assetManifest;
  if (config.nodeEnv === 'production') {
    try {
      assetManifest = loadProductionAssetManifest();
    } catch (err) {
      if (err instanceof AssetManifestError) {
        console.error(`Asset manifest error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  const db = openDatabase(config.databasePath);

  try {
    runMigrations(db, fileURLToPath(new URL('../migrations', import.meta.url)));
  } catch (err) {
    closeDatabase(db);
    if (err instanceof DatabaseError) {
      console.error(`Database error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // Phase 11.2: shared maintenance boundary so the 503 middleware, health
  // endpoint, and settings router all see the same flag.
  const maintenanceState = { active: false };

  const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

  // Built once and reused across every restore: backupService holds no
  // reference to a `db` connection (callers pass one to createBackup/
  // restoreBackup per call), so there is nothing to rebuild here.
  const backupService = createBackupService({
    appDataRoot: config.appDataRoot,
    databasePath: config.databasePath,
    migrationsDir,
    retentionCount: config.backupRetentionCount,
  });

  // Phase 13: authentication is optional and browser-managed. The managed
  // auth-enablement file is the sole authority for whether login is
  // required; an absent file means "never enabled yet" and is lazily
  // created as an explicit disabled state (with a fresh CSRF pepper) rather
  // than silently defaulting anything auth-identity-related.
  let authState;
  try {
    authState = ensureAuthEnablement(config.appDataRoot);
  } catch (err) {
    if (err instanceof AuthStateError) {
      closeDatabase(db);
      console.error(`Auth-state error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  let authConfig = null;
  if (authState.enabled) {
    let credentialProvider;
    try {
      // No bootstrap: an enabled managed state without a credential file is
      // a malformed/incomplete configuration and must fail startup safely,
      // never silently create a default credential.
      credentialProvider = createManagedCredentialProvider({ appDataRoot: config.appDataRoot });
    } catch (err) {
      if (err instanceof CredentialError) {
        closeDatabase(db);
        console.error(`Credential error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
    authConfig = { ...config.auth, sessionSecret: authState.sessionSecret, credentialProvider };
  }

  // Phase 11.2 (fixed): the application context owns the currently active
  // `db` and the Express app built from it. A live restore rebuilds every
  // db-bound repository/service/route against the restored connection and
  // atomically swaps the active app in-process — no supervisor restart.
  // See app-context.js for the reconstruction/swap/ownership contract.
  const appContext = createApplicationContext({
    appName: config.appName,
    projectsRoot: config.projectsRoot,
    previewRoot: config.previewRoot,
    appOpts: {
      appDataRoot: config.appDataRoot,
      databasePath: config.databasePath,
      migrationsDir,
      backupService,
      backupRetentionCount: config.backupRetentionCount,
      autoScanIntervalMinutes: config.autoScanIntervalMinutes,
      maintenanceState,
      authConfig,
      authSettings: config.auth,
      authState: { csrfPepper: authState.csrfPepper },
      assetManifest,
      assetMode: resolveAssetMode(config.nodeEnv),
    },
  }, db);

  await runInitialWatermarkScan(appContext);

  const server = http.createServer();
  let viteServer;
  try {
    viteServer = await createDevelopmentViteServer({
      nodeEnv: config.nodeEnv,
      parentServer: server,
    });
  } catch (err) {
    closeDatabase(appContext.db);
    throw err;
  }

  const automaticProjectScanScheduler = createAutomaticProjectScanScheduler({
    intervalMinutes: config.autoScanIntervalMinutes,
    getScanDependencies: () => ({
      projectService: appContext.app.locals.projectService,
      assetScanner: appContext.app.locals.assetScanner,
      appMetaRepository: appContext.app.locals.appMetaRepository,
      watermarkService: appContext.app.locals.watermarkService,
    }),
  });

  server.on('request', createApplicationRequestHandler(appContext, viteServer));
  server.listen(config.port, () => {
    console.log(`${config.appName} listening on port ${config.port} in ${config.nodeEnv} mode`);
    automaticProjectScanScheduler.start();
  });

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    automaticProjectScanScheduler.stop();
    try {
      await viteServer?.close();
    } finally {
      await new Promise((resolve) => server.close(resolve));
      // Close whichever connection is currently active — a live restore may
      // have replaced the startup handle with a new one by now.
      closeDatabase(appContext.db);
      process.exit(0);
    }
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
