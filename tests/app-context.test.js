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
import { STATUS_DIR_MAP } from '../src/storage/project-storage.js';
import { hashPassword } from '../src/auth/password-hash.js';
import { generateSessionToken, hashSessionToken } from '../src/auth/session-token.js';
import { createStaticCredentialProvider, createManagedCredentialProvider } from '../src/auth/credential-provider.js';
import { createLoginThrottler } from '../src/auth/login-throttle.js';
import { ensureAuthEnablement, enableAuthState, readAuthEnablement } from '../src/auth/auth-state.js';
import { extractCsrfToken } from './helpers/auth.js';

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
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
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
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
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
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
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
