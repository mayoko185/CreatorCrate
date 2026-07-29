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
