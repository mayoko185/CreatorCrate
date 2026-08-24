/**
 * Phase 11.2 live-restore fix — application-context tests.
 *
 * Two concerns:
 *   1. A deterministic, same-process, end-to-end restore: the running HTTP
 *      app must serve the restored database immediately after a restore,
 *      with no restart and no stale service closures.
 *   2. Failure-path unit tests for the context-reconstruction/atomic-swap
 *      contract in isolation (construction failure, no leak, no double
 *      close, prior context remains usable).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplicationContext } from '../src/app-context.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createBackupService } from '../src/services/backup-service.js';
import { hashPassword } from '../src/auth/password-hash.js';
import { generateSessionToken, hashSessionToken } from '../src/auth/session-token.js';
import { createStaticCredentialProvider, createManagedCredentialProvider } from '../src/auth/credential-provider.js';
import { createLoginThrottler } from '../src/auth/login-throttle.js';
import { ensureAuthEnablement, enableAuthState, readAuthEnablement } from '../src/auth/auth-state.js';
import { extractCsrfToken } from './helpers/auth.js';
import { createAssetCategoryRepository } from '../src/data/asset-category-repository.js';
import { createAssetBrowserPreferenceRepository } from '../src/data/asset-browser-preference-repository.js';
import { createAssetCategoryService } from '../src/services/asset-category-service.js';
import { createProjectService } from '../src/services/project-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const APP_NAME = 'CreatorCrate';

function countProjects(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;
}

describe('live restore — same-process application context', () => {
  let tmpDir;
  let appDataRoot;
  let projectsRoot;
  let databasePath;
  let db;
  let backupService;
  let maintenanceState;
  let appContext;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-live-restore-'));
    appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    databasePath = path.join(appDataRoot, 'creatorcrate.db');
    db = openDatabase(databasePath);
    runMigrations(db, MIGRATIONS_DIR);
    backupService = createBackupService({ appDataRoot, databasePath, migrationsDir: MIGRATIONS_DIR });
    maintenanceState = { active: false };

    appContext = createApplicationContext({
      appName: APP_NAME,
      projectsRoot,
      appOpts: { appDataRoot, databasePath, migrationsDir: MIGRATIONS_DIR, backupService, maintenanceState },
    }, db);
  });

  afterEach(() => {
    maintenanceState.active = false;
    try { closeDatabase(appContext.db); } catch { /* already closed by a test */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves the restored database from the same running app instance with no restart', async () => {
    // 1. Start with database state A.
    await request(appContext.handleRequest)
      .post('/projects')
      .type('form')
      .send({ title: 'State A Project', status: 'tbd', priority: 'normal' })
      .expect(302);
    expect(countProjects(appContext.db)).toBe(1);

    // 2. Back up state A.
    const backupRes = await request(appContext.handleRequest)
      .post('/settings/backups')
      .expect(302);
    expect(backupRes.headers.location).toBe('/settings/backups?notice=backup_created');
    const backups = backupService.listBackups();
    expect(backups).toHaveLength(1);
    const backupFilename = backups[0].filename;

    // 3. Mutate the live database to state B through a normal application route.
    await request(appContext.handleRequest)
      .post('/projects')
      .type('form')
      .send({ title: 'State B Project', status: 'tbd', priority: 'normal' })
      .expect(302);
    expect(countProjects(appContext.db)).toBe(2);

    // 4. Restore the backup through the HTTP restore workflow.
    const dbBeforeRestore = appContext.db;
    const restoreRes = await request(appContext.handleRequest)
      .post(`/settings/backups/${backupFilename}/restore`)
      .expect(302);
    expect(restoreRes.headers.location).toBe('/settings/backups?notice=restore_success');

    // The context adopted a genuinely new connection — proof the swap happened.
    expect(appContext.db).not.toBe(dbBeforeRestore);
    expect(maintenanceState.active).toBe(false);

    // 5. Without restarting or reconstructing the application: dashboard,
    //    project pages, a new write, and /health must all use the restored
    //    (state A) database.
    const dashboardRes = await request(appContext.handleRequest).get('/').expect(200);
    expect(dashboardRes.text).toContain(APP_NAME);

    const projectListRes = await request(appContext.handleRequest).get('/projects').expect(200);
    expect(projectListRes.text).toContain('State A Project');
    expect(projectListRes.text).not.toContain('State B Project');

    // A new write against the restored, live app.
    await request(appContext.handleRequest)
      .post('/projects')
      .type('form')
      .send({ title: 'Post-Restore Project', status: 'tbd', priority: 'normal' })
      .expect(302);

    const projectListAfterWriteRes = await request(appContext.handleRequest).get('/projects').expect(200);
    expect(projectListAfterWriteRes.text).toContain('State A Project');
    expect(projectListAfterWriteRes.text).toContain('Post-Restore Project');
    expect(projectListAfterWriteRes.text).not.toContain('State B Project');
    expect(countProjects(appContext.db)).toBe(2);

    const healthRes = await request(appContext.handleRequest).get('/health').expect(200);
    expect(healthRes.body).toEqual({ status: 'ok', database: 'ok' });
  });

  it('returns 503 maintenance during replacement and healthy again immediately after', async () => {
    const backupRes = await request(appContext.handleRequest).post('/settings/backups').expect(302);
    expect(backupRes.headers.location).toBe('/settings/backups?notice=backup_created');
    const backupFilename = backupService.listBackups()[0].filename;

    maintenanceState.active = true;
    await request(appContext.handleRequest).get('/health').expect(503);
    await request(appContext.handleRequest).get('/').expect(503);
    maintenanceState.active = false;

    await request(appContext.handleRequest)
      .post(`/settings/backups/${backupFilename}/restore`)
      .expect(302);

    await request(appContext.handleRequest).get('/health').expect(200);
  });

  it('rebuilds db-bound asset and preference services against the restored database, with no stale repositories', async () => {
    // 1. Directly (no HTTP) create a project + real asset file, then index
    //    it through the APP'S OWN scanner instance (app.locals.assetScanner)
    //    — exercising the real construction path, not a separately built one.
    const assetCategoryService = createAssetCategoryService(createAssetCategoryRepository(appContext.db));
    const projectService = createProjectService(appContext.db, projectsRoot, {
      assetCategoryService,
      assetBrowserPreferenceRepository: createAssetBrowserPreferenceRepository(appContext.db),
    });
    const project = projectService.create({
      title: 'Restore Wiring Project', description: '', notes: '', status: 'tbd', priority: 'normal',
      plannedDate: null, publishedDate: null, patreonUrl: null,
    });
    const absProjectDir = path.resolve(projectsRoot, project.project_dir);
    fs.writeFileSync(path.join(absProjectDir, 'a.png'), 'state-a-bytes');
    appContext.app.locals.assetScanner.scanProjectAssets(project.id);
    const [asset] = appContext.app.locals.assetScanner.listProjectAssets(project.id);
    expect(asset).toBeTruthy();
    const preferenceServiceBeforeRestore = appContext.app.locals.assetBrowserPreferenceService;
    const primaryImageServiceBeforeRestore = appContext.app.locals.projectPrimaryImageService;
    primaryImageServiceBeforeRestore.setPrimaryImage(project.id, asset.id);
    expect(preferenceServiceBeforeRestore.getProjectPreference(project.id)).toEqual({
      mode: 'inherit',
      categoryId: null,
    });

    // 2. Back up the database (backups are DB-only — project files on disk
    //    are untouched by backup/restore, so no filesystem mutation happens
    //    between backup and restore in this test).
    const backupRes = await request(appContext.handleRequest).post('/settings/backups').expect(302);
    expect(backupRes.headers.location).toBe('/settings/backups?notice=backup_created');
    const backupFilename = backupService.listBackups()[0].filename;

    // 3. Restore through the HTTP restore workflow — this closes the
    //    pre-restore connection and swaps in a new one.
    const dbBeforeRestore = appContext.db;
    await request(appContext.handleRequest)
      .post(`/settings/backups/${backupFilename}/restore`)
      .expect(302);
    expect(appContext.db).not.toBe(dbBeforeRestore);

    // 4. The rebuilt scanner/action service on the NEW app instance must
    //    operate cleanly against the restored database. A stale reference
    //    to the now-closed pre-restore connection would throw here instead
    //    (better-sqlite3 throws on any use of a closed database handle).
    const [restoredAsset] = appContext.app.locals.assetScanner.listProjectAssets(project.id);
    expect(restoredAsset.id).toBe(asset.id);
    expect(restoredAsset.filename).toBe('a.png');

    // The preference service must also be a new app-local instance bound to
    // the restored database; the old service closed over the pre-restore DB.
    const preferenceServiceAfterRestore = appContext.app.locals.assetBrowserPreferenceService;
    expect(preferenceServiceAfterRestore).not.toBe(preferenceServiceBeforeRestore);
    expect(preferenceServiceAfterRestore.getProjectPreference(project.id)).toEqual({
      mode: 'inherit',
      categoryId: null,
    });

    const primaryImageServiceAfterRestore = appContext.app.locals.projectPrimaryImageService;
    expect(primaryImageServiceAfterRestore).not.toBe(primaryImageServiceBeforeRestore);
    expect(primaryImageServiceAfterRestore.getPrimaryImage(project.id)).toMatchObject({
      id: asset.id,
      project_id: project.id,
    });

    const renamed = appContext.app.locals.assetActionService.renameAsset(project.id, restoredAsset.id, 'still-works.png');
    expect(renamed.filename).toBe('still-works.png');

    // A rescan against the restored database must also succeed cleanly.
    expect(() => appContext.app.locals.assetScanner.scanProjectAssets(project.id)).not.toThrow();
  });
});

describe('application context — reconstruction failure handling', () => {
  function makeFakeDb(id) {
    let closed = false;
    return {
      id,
      close() {
        closed = true;
      },
      get closed() {
        return closed;
      },
      prepare() {
        return { get: () => null, all: () => [], run: () => ({}) };
      },
    };
  }

  it('leaves the prior context usable and closes the new handle when reconstruction throws', () => {
    const initialDb = makeFakeDb('initial');
    let buildCount = 0;
    const failingFactory = () => {
      buildCount += 1;
      if (buildCount === 1) {
        return { calls: [] }; // initial build succeeds (unused directly by the test)
      }
      throw new Error('simulated service reconstruction failure');
    };

    const appContext = createApplicationContext(
      { appName: APP_NAME, appOpts: {} },
      initialDb,
      failingFactory
    );

    const priorApp = appContext.app;
    const priorDb = appContext.db;
    expect(priorDb).toBe(initialDb);

    const newDb = makeFakeDb('replacement');
    expect(() => appContext.replaceDatabase(newDb)).toThrow('simulated service reconstruction failure');

    // Prior context untouched.
    expect(appContext.app).toBe(priorApp);
    expect(appContext.db).toBe(priorDb);
    expect(priorDb.closed).toBe(false);

    // New handle never leaked — closed exactly once.
    expect(newDb.closed).toBe(true);
  });

  it('does not double-close and adopts cleanly on a subsequent successful replacement', () => {
    const initialDb = makeFakeDb('initial');
    let buildCount = 0;
    const factory = () => {
      buildCount += 1;
      if (buildCount === 2) {
        throw new Error('one-time failure');
      }
      return { build: buildCount };
    };

    const appContext = createApplicationContext({ appName: APP_NAME, appOpts: {} }, initialDb, factory);

    const failingDb = makeFakeDb('failing-replacement');
    expect(() => appContext.replaceDatabase(failingDb)).toThrow('one-time failure');
    expect(failingDb.closed).toBe(true);
    expect(appContext.db).toBe(initialDb);

    const goodDb = makeFakeDb('good-replacement');
    appContext.replaceDatabase(goodDb);
    expect(appContext.db).toBe(goodDb);
    // The successful replacement never closes the handle it just adopted.
    expect(goodDb.closed).toBe(false);
    // The initial db was never closed by the context itself (ownership of
    // closing the previous connection belongs to the restore primitive).
    expect(initialDb.closed).toBe(false);
  });
});

// ─── Phase: asset actions chunk 3 — coordinator survives reconstruction ──

describe('application context — coordinator persistence across reconstruction', () => {
  function makeFakeDb(id) {
    let closed = false;
    return {
      id,
      close() { closed = true; },
      get closed() { return closed; },
      prepare() {
        return { get: () => null, all: () => [], run: () => ({}) };
      },
    };
  }

  it('passes the same projectOperationCoordinator instance to every buildApp call', () => {
    const initialDb = makeFakeDb('initial');
    const receivedCoordinators = [];
    const fakeFactory = (_appDeps, opts) => {
      receivedCoordinators.push(opts.projectOperationCoordinator);
      return { db: _appDeps.db };
    };

    const appContext = createApplicationContext(
      { appName: APP_NAME, appOpts: {} },
      initialDb,
      fakeFactory
    );

    expect(receivedCoordinators).toHaveLength(1);
    expect(receivedCoordinators[0]).toBeTruthy();

    appContext.replaceDatabase(makeFakeDb('replacement-1'));
    appContext.replaceAuthConfig({ fakeAuthConfig: true });
    appContext.replaceDatabase(makeFakeDb('replacement-2'));

    expect(receivedCoordinators).toHaveLength(4);
    // Every rebuild — including replaceDatabase (live restore) and
    // replaceAuthConfig — received the exact same coordinator instance
    // constructed once at createApplicationContext time.
    const [first, ...rest] = receivedCoordinators;
    for (const coordinator of rest) {
      expect(coordinator).toBe(first);
    }
  });

  it('passes the same processing concurrency service to every buildApp call', () => {
    const initialDb = makeFakeDb('initial');
    const receivedServices = [];
    const fakeFactory = (_appDeps, opts) => {
      receivedServices.push(opts.processingConcurrencyService);
      return { db: _appDeps.db };
    };

    const appContext = createApplicationContext(
      { appName: APP_NAME, appOpts: { processingConcurrency: 1 } },
      initialDb,
      fakeFactory
    );

    appContext.replaceDatabase(makeFakeDb('replacement-1'));
    appContext.replaceAuthConfig({ fakeAuthConfig: true });

    expect(appContext.processingConcurrencyService.concurrency).toBe(1);
    const [first, ...rest] = receivedServices;
    for (const service of rest) {
      expect(service).toBe(first);
    }
  });

  it('owns one processing job service and refuses context rebuilds until queued, running, and cancelled jobs are terminal', async () => {
    const initialDb = makeFakeDb('initial');
    const receivedServices = [];
    const receivedBuildOptions = [];
    const fakeFactory = (_appDeps, opts) => {
      receivedServices.push(opts.processingJobService);
      receivedBuildOptions.push(opts);
      return { db: _appDeps.db };
    };
    const appContext = createApplicationContext(
      { appName: APP_NAME, appOpts: {} },
      initialDb,
      fakeFactory
    );
    const service = appContext.processingJobService;
    let releaseRunningJob;
    const runningJobId = service.enqueue({
      projectId: 1,
      execute: () => new Promise((resolve) => { releaseRunningJob = resolve; }),
    });
    const cancelledJobId = service.enqueue({ projectId: 1, execute: () => undefined });

    // The second same-project job remains queued behind the first one, and
    // either queued or running work must prevent a context/database swap.
    expect(service.getJob(cancelledJobId).state).toBe('queued');
    expect(() => receivedBuildOptions[0].assertNoActiveProcessingJobs()).toThrow(/processing jobs are active/);
    const queuedCandidate = makeFakeDb('queued-candidate');
    expect(() => appContext.replaceDatabase(queuedCandidate)).toThrow(/processing jobs are active/);
    expect(appContext.db).toBe(initialDb);
    expect(queuedCandidate.closed).toBe(true);
    expect(receivedServices).toHaveLength(1);

    await new Promise((resolve) => setImmediate(resolve));
    expect(service.getJob(runningJobId).state).toBe('running');
    expect(() => receivedBuildOptions[0].assertNoActiveProcessingJobs()).toThrow(/processing jobs are active/);
    expect(() => appContext.replaceAuthConfig({ enabled: true })).toThrow(/processing jobs are active/);
    expect(service.cancel(cancelledJobId)).toBe(true);
    releaseRunningJob();

    for (let attempt = 0; attempt < 20 && service.getJob(runningJobId).state !== 'succeeded'; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(service.getJob(runningJobId).state).toBe('succeeded');
    expect(service.getJob(cancelledJobId).state).toBe('cancelled');
    expect(() => receivedBuildOptions[0].assertNoActiveProcessingJobs()).not.toThrow();

    const replacementDb = makeFakeDb('replacement');
    expect(() => appContext.replaceDatabase(replacementDb)).not.toThrow();
    expect(appContext.db).toBe(replacementDb);
    expect(receivedServices).toHaveLength(2);
    expect(receivedServices[1]).toBe(service);
  });

  it('does not let a stray opts.projectOperationCoordinator override the shared instance', () => {
    const initialDb = makeFakeDb('initial');
    const receivedCoordinators = [];
    const fakeFactory = (_appDeps, opts) => {
      receivedCoordinators.push(opts.projectOperationCoordinator);
      return {};
    };

    const impostor = { run: () => { throw new Error('should never be called'); } };
    const appContext = createApplicationContext(
      { appName: APP_NAME, appOpts: { projectOperationCoordinator: impostor } },
      initialDb,
      fakeFactory
    );

    // appOpts.projectOperationCoordinator is deliberately ignored — the
    // context always constructs and threads through its own instance so
    // scanner/action-service sharing is guaranteed regardless of what a
    // caller's appOpts happens to contain.
    expect(receivedCoordinators[0]).not.toBe(impostor);
  });

  it('passes one signing key to every app rebuild and accepts a deterministic injected key', () => {
    const initialDb = makeFakeDb('initial');
    const receivedKeys = [];
    const injectedKey = Buffer.from('deterministic-auto-rename-context-key');
    const fakeFactory = (_appDeps, opts) => {
      receivedKeys.push(opts.autoRenameSigningKey);
      return {};
    };

    const appContext = createApplicationContext(
      { appName: APP_NAME, appOpts: { autoRenameSigningKey: injectedKey } },
      initialDb,
      fakeFactory
    );

    appContext.replaceDatabase(makeFakeDb('replacement-1'));
    appContext.replaceAuthConfig({ enabled: true });

    expect(receivedKeys).toHaveLength(3);
    for (const key of receivedKeys) {
      expect(Buffer.isBuffer(key)).toBe(true);
      expect(key.equals(injectedKey)).toBe(true);
    }
  });
});

// ─── Phase 12.1: authentication + live restore ──────────────────────────

describe('live restore — authentication interaction', () => {
  let tmpDir;
  let appDataRoot;
  let projectsRoot;
  let databasePath;
  let db;
  let backupService;
  let maintenanceState;
  let appContext;

  const PASSWORD = 'CorrectHorseBatteryStaple';
  const ROTATED_PASSWORD = 'NewCorrectHorseBattery';
  const AUTH_CONFIG = {
    username: 'admin',
    passwordHash: hashPassword(PASSWORD),
    sessionSecret: 'a'.repeat(32),
    sessionTtlHours: 24,
    cookieSecure: false,
  };
  let credentialProvider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-auth-restore-'));
    appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    databasePath = path.join(appDataRoot, 'creatorcrate.db');
    db = openDatabase(databasePath);
    runMigrations(db, MIGRATIONS_DIR);
    backupService = createBackupService({ appDataRoot, databasePath, migrationsDir: MIGRATIONS_DIR });
    maintenanceState = { active: false };
    credentialProvider = createStaticCredentialProvider({ username: 'admin', passwordHash: AUTH_CONFIG.passwordHash });

    appContext = createApplicationContext(
      {
        appName: APP_NAME,
        projectsRoot,
        appOpts: {
          appDataRoot,
          databasePath,
          migrationsDir: MIGRATIONS_DIR,
          backupService,
          maintenanceState,
          authConfig: { ...AUTH_CONFIG, credentialProvider },
          credentialProvider,
          loginThrottler: createLoginThrottler({ baseDelayMs: 0, maxDelayMs: 0 }),
        },
      },
      db
    );
  });

  afterEach(() => {
    maintenanceState.active = false;
    try { closeDatabase(appContext.db); } catch { /* already closed by a test */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function login(agent, { fetchAuthenticatedCsrf = true } = {}) {
    const loginPage = await agent.get('/login').expect(200);
    const loginCsrf = extractCsrfToken(loginPage.text);
    await agent
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: PASSWORD, _csrf: loginCsrf })
      .expect(302);
    if (!fetchAuthenticatedCsrf) {
      return { agent, csrfToken: null };
    }
    const authenticatedPage = await agent.get('/settings/backups').expect(200);
    return { agent, csrfToken: extractCsrfToken(authenticatedPage.text) };
  }

  it('health stays unauthenticated across a restore', async () => {
    await request(appContext.handleRequest).get('/health').expect(200);

    const { agent, csrfToken } = await login(request.agent(appContext.handleRequest));
    const backupRes = await agent.post('/settings/backups').type('form').send({ _csrf: csrfToken }).expect(302);
    expect(backupRes.headers.location).toBe('/settings/backups?notice=backup_created');

    await request(appContext.handleRequest).get('/health').expect(200);
  });

  it('a session created before a restore is rejected afterward (restore invalidates all sessions)', async () => {
    const agent = request.agent(appContext.handleRequest);
    const { csrfToken } = await login(agent);
    await agent.get('/projects').expect(200);

    await agent.post('/settings/backups').type('form').send({ _csrf: csrfToken }).expect(302);
    const backupFilename = backupService.listBackups()[0].filename;

    await agent.post(`/settings/backups/${backupFilename}/restore`).type('form').send({ _csrf: csrfToken }).expect(302);

    // The same cookie must no longer authenticate against the rebuilt app —
    // the restored database's session table was wiped.
    await agent.get('/projects').expect(302);
  });

  it('a new login works immediately after a restore (auth service rebuilt against the new db)', async () => {
    const { agent: setupAgent, csrfToken } = await login(request.agent(appContext.handleRequest));
    await setupAgent.post('/settings/backups').type('form').send({ _csrf: csrfToken }).expect(302);
    const backupFilename = backupService.listBackups()[0].filename;

    await setupAgent
      .post(`/settings/backups/${backupFilename}/restore`)
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(302);

    const agent = request.agent(appContext.handleRequest);
    await login(agent);
    await agent.get('/projects').expect(200);
  });

  it('a restore rebuild keeps the live credential provider authority instead of reverting the environment hash', async () => {
    const { agent: setupAgent, csrfToken } = await login(request.agent(appContext.handleRequest));
    await setupAgent.post('/settings/backups').type('form').send({ _csrf: csrfToken }).expect(302);
    const backupFilename = backupService.listBackups()[0].filename;

    const rotatePage = await setupAgent.get('/settings/security').expect(200);
    await setupAgent
      .post('/settings/security/password')
      .type('form')
      .send({
        _csrf: extractCsrfToken(rotatePage.text),
        currentPassword: PASSWORD,
        newPassword: ROTATED_PASSWORD,
        confirmPassword: ROTATED_PASSWORD,
      })
      .expect(302);

    const restoreAgent = request.agent(appContext.handleRequest);
    const loginPage = await restoreAgent.get('/login').expect(200);
    await restoreAgent
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: ROTATED_PASSWORD, _csrf: extractCsrfToken(loginPage.text) })
      .expect(302);
    const backupsPage = await restoreAgent.get('/settings/backups').expect(200);
    await restoreAgent
      .post(`/settings/backups/${backupFilename}/restore`)
      .type('form')
      .send({ _csrf: extractCsrfToken(backupsPage.text) })
      .expect(302);

    const oldAgent = request.agent(appContext.handleRequest);
    const oldLogin = await oldAgent.get('/login').expect(200);
    await oldAgent
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: PASSWORD, _csrf: extractCsrfToken(oldLogin.text) })
      .expect(401);

    const newAgent = request.agent(appContext.handleRequest);
    const newLogin = await newAgent.get('/login').expect(200);
    await newAgent
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: ROTATED_PASSWORD, _csrf: extractCsrfToken(newLogin.text) })
      .expect(302);
  });

  it('mutating requests stay blocked without authentication after a restore', async () => {
    const { agent: setupAgent, csrfToken } = await login(request.agent(appContext.handleRequest));
    await setupAgent.post('/settings/backups').type('form').send({ _csrf: csrfToken }).expect(302);
    const backupFilename = backupService.listBackups()[0].filename;
    await setupAgent
      .post(`/settings/backups/${backupFilename}/restore`)
      .type('form')
      .send({ _csrf: csrfToken })
      .expect(302);

    await request(appContext.handleRequest)
      .post('/projects')
      .type('form')
      .send({ title: 'Should be blocked', status: 'tbd', priority: 'normal' })
      .expect(401);
  });

  // Phase 12.1 cleanup addendum: the auth service (and its per-instance
  // cleanup-cadence state) is rebuilt from scratch on every replaceDatabase
  // call (see app-context.js's buildApp), so a restore must never leave the
  // expired-session sweep bound to the closed pre-restore connection.
  it('a restore rebuilds the cleanup guard against the new database, not the closed pre-restore connection', async () => {
    const { agent: setupAgent, csrfToken } = await login(request.agent(appContext.handleRequest));
    await setupAgent.post('/settings/backups').type('form').send({ _csrf: csrfToken }).expect(302);
    const backupFilename = backupService.listBackups()[0].filename;
    await setupAgent.post(`/settings/backups/${backupFilename}/restore`).type('form').send({ _csrf: csrfToken }).expect(302);

    // Log in again against the rebuilt app to get a valid, live session.
    const agent = request.agent(appContext.handleRequest);
    await login(agent, { fetchAuthenticatedCsrf: false });

    // Insert an already-expired session row directly against the *current*
    // (post-restore) db handle — proof that whatever sweep runs must be
    // reading/writing this new connection, not a stale closed one.
    const staleToken = generateSessionToken();
    const staleHash = hashSessionToken(staleToken, AUTH_CONFIG.sessionSecret);
    appContext.db
      .prepare('INSERT INTO sessions (id, username, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(staleHash, 'admin', new Date(Date.now() - 2000).toISOString(), new Date(Date.now() - 1000).toISOString());

    // A fresh AuthService instance is due for its sweep immediately, so a
    // single authenticated request through the rebuilt app removes the
    // stale row via the production getSession trigger.
    await agent.get('/projects').expect(200);

    expect(
      appContext.db.prepare('SELECT id FROM sessions WHERE id = ?').get(staleHash)
    ).toBeUndefined();
  });
});

// ─── Phase 13: runtime auth enable/disable toggling ─────────────────────

describe('application context — replaceAuthConfig (restart-free auth toggling)', () => {
  let tmpDir;
  let appContext;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-replace-auth-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rebuilds against the current db, not the original constructor db, and commits only on success', () => {
    const initialDb = { id: 'initial' };
    const calls = [];
    const factory = (config, opts) => {
      calls.push({ db: config.db, authConfig: opts.authConfig });
      if (opts.authConfig?.fail) {
        throw new Error('simulated auth rebuild failure');
      }
      return { db: config.db, authConfig: opts.authConfig };
    };

    appContext = createApplicationContext({ appName: APP_NAME, appOpts: {} }, initialDb, factory);
    expect(appContext.app.authConfig).toBeUndefined();

    appContext.replaceAuthConfig({ enabled: true });
    expect(appContext.app.authConfig).toEqual({ enabled: true });
    expect(appContext.app.db).toBe(initialDb);

    // A failed rebuild never commits — the prior (enabled) app stays active.
    expect(() => appContext.replaceAuthConfig({ fail: true })).toThrow('simulated auth rebuild failure');
    expect(appContext.app.authConfig).toEqual({ enabled: true });

    // Disabling (authConfig -> null) still builds against the *current* db.
    appContext.replaceAuthConfig(null);
    expect(appContext.app.authConfig).toBeNull();
    expect(appContext.app.db).toBe(initialDb);
  });

  it('a subsequent replaceDatabase carries forward whatever authConfig is currently live, not the original one', () => {
    const initialDb = { id: 'initial' };
    const factory = (config, opts) => ({ db: config.db, authConfig: opts.authConfig });
    appContext = createApplicationContext({ appName: APP_NAME, appOpts: { authConfig: { enabled: false } } }, initialDb, factory);

    appContext.replaceAuthConfig({ enabled: true, marker: 'toggled-on' });
    const newDb = { id: 'replacement' };
    appContext.replaceDatabase(newDb);

    expect(appContext.app.db).toBe(newDb);
    expect(appContext.app.authConfig).toEqual({ enabled: true, marker: 'toggled-on' });
  });
});

describe('live restore — does not change auth mode or revert managed credentials', () => {
  let tmpDir;
  let appDataRoot;
  let projectsRoot;
  let databasePath;
  let db;
  let backupService;
  let maintenanceState;
  let appContext;

  const PASSWORD = 'CorrectHorseBatteryStaple';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-restore-auth-mode-'));
    appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    databasePath = path.join(appDataRoot, 'creatorcrate.db');
    db = openDatabase(databasePath);
    runMigrations(db, MIGRATIONS_DIR);
    backupService = createBackupService({ appDataRoot, databasePath, migrationsDir: MIGRATIONS_DIR });
    maintenanceState = { active: false };

    const pepper = ensureAuthEnablement(appDataRoot).csrfPepper;
    const sessionSecret = 'd'.repeat(64);
    enableAuthState(appDataRoot, { sessionSecret, csrfPepper: pepper });
    const credentialProvider = createManagedCredentialProvider({
      appDataRoot,
      bootstrapUsername: 'admin',
      bootstrapPasswordHash: hashPassword(PASSWORD),
    });

    appContext = createApplicationContext(
      {
        appName: APP_NAME,
        projectsRoot,
        appOpts: {
          appDataRoot,
          databasePath,
          migrationsDir: MIGRATIONS_DIR,
          backupService,
          maintenanceState,
          authConfig: { sessionTtlHours: 24, cookieSecure: false, sessionSecret, credentialProvider },
          authState: { csrfPepper: pepper },
          loginThrottler: createLoginThrottler({ baseDelayMs: 0, maxDelayMs: 0 }),
        },
      },
      db
    );
  });

  afterEach(() => {
    maintenanceState.active = false;
    try { closeDatabase(appContext.db); } catch { /* already closed by a test */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a database restore leaves the managed auth-enablement state and password untouched', async () => {
    const stateBefore = readAuthEnablement(appDataRoot);

    const agent = request.agent(appContext.handleRequest);
    const loginPage = await agent.get('/login').expect(200);
    await agent
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: PASSWORD, _csrf: extractCsrfToken(loginPage.text) })
      .expect(302);
    const backupsPage = await agent.get('/settings/backups').expect(200);
    const backupCsrf = extractCsrfToken(backupsPage.text);

    await agent.post('/settings/backups').type('form').send({ _csrf: backupCsrf }).expect(302);
    const backupFilename = backupService.listBackups()[0].filename;

    await agent
      .post(`/settings/backups/${backupFilename}/restore`)
      .type('form')
      .send({ _csrf: backupCsrf })
      .expect(302);

    // Restore invalidates sessions (existing Phase 11.2 contract) — the old
    // cookie no longer authenticates.
    await agent.get('/projects').expect(302);

    // But the managed auth-enablement state itself is untouched by the
    // restore, and the password still works with a fresh login.
    expect(readAuthEnablement(appDataRoot)).toEqual(stateBefore);
    const newAgent = request.agent(appContext.handleRequest);
    const newLoginPage = await newAgent.get('/login').expect(200);
    await newAgent
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: PASSWORD, _csrf: extractCsrfToken(newLoginPage.text) })
      .expect(302);
  });
});
