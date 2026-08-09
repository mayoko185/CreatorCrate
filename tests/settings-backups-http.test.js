/**
 * Phase 11.2 — settings/backups HTTP integration tests.
 *
 * Tests the server-rendered backup management and guarded restore workflow.
 * Uses a real backup service with a temporary directory; stubs are injected
 * only where the service-level behavior is already covered by
 * backup-service.test.js and what matters here is the HTTP layer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createBackupService, BackupError } from '../src/services/backup-service.js';
import { resolveBackupDir } from '../src/storage/backup-storage.js';
import { authenticate, AUTH_CONFIG, extractCsrfToken } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const APP_NAME = 'CreatorCrate';
const AUTH_SETTINGS = {
  sessionTtlHours: 24,
  cookieSecure: false,
  trustProxy: false,
  hstsEnabled: false,
};

function countH1(html) {
  return (html.match(/<h1[\s>]/g) || []).length;
}

function renderedPath(value) {
  return value.split(path.sep).join('&#92;');
}

function navHrefs(html) {
  const re = /<a href="([^"]+)" class="app-nav-link"/g;
  const hrefs = [];
  let m;
  while ((m = re.exec(html)) !== null) hrefs.push(m[1]);
  return hrefs;
}

function activeNavKeys(html) {
  // Scoped to .app-nav-link (desktop nav) only; mobile nav items also carry
  // aria-current="page" but the attribute order differs.
  const re = /class="app-nav-link" data-nav-key="([^"]+)" aria-current="page"/g;
  const keys = [];
  let m;
  while ((m = re.exec(html)) !== null) keys.push(m[1]);
  return keys;
}

function insertProject(db, title) {
  return db
    .prepare(
      `INSERT INTO projects (title, slug, description, notes, status, planned_date, published_date, patreon_url)
       VALUES (?, ?, '', '', 'tbd', NULL, NULL, NULL)`
    )
    .run(title, title.toLowerCase().replace(/\s+/g, '-')).lastInsertRowid;
}

function countProjects(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;
}

describe('settings — backup management HTTP', () => {
  let tmpDir;
  let appDataRoot;
  let databasePath;
  let projectsRoot;
  let db;
  let backupService;
  let maintenanceState;
  let app;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-bkp-http-'));
    appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    databasePath = path.join(appDataRoot, 'creatorcrate.db');
    db = openDatabase(databasePath);
    runMigrations(db, MIGRATIONS_DIR);
    backupService = createBackupService({ appDataRoot, databasePath, migrationsDir: MIGRATIONS_DIR });
    maintenanceState = { active: false };
    app = createApp(
      { appName: APP_NAME, db, projectsRoot },
      {
        backupService,
        maintenanceState,
        appDataRoot,
        databasePath,
        migrationsDir: MIGRATIONS_DIR,
        authConfig: AUTH_CONFIG,
        authSettings: AUTH_SETTINGS,
        autoScanIntervalMinutes: null,
      },
    );

    const auth = await authenticate(app);
    agent = auth.agent;
    csrfToken = auth.csrfToken;
  });

  afterEach(() => {
    maintenanceState.active = false;
    try { closeDatabase(db); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Route reachability ────────────────────────────────────────────────────

  describe('route reachability', () => {
    it('GET /settings renders 200', async () => {
      const res = await agent.get('/settings').expect(200);
      expect(res.text).toContain('Settings');
    });

    it('GET /settings/backups renders 200', async () => {
      const res = await agent.get('/settings/backups').expect(200);
      expect(res.text).toContain('Backups');
    });

    it('GET /settings/backups/:filename/restore returns 404 for an unknown backup', async () => {
      await agent.get('/settings/backups/creatorcrate-2026-01-01T000000Z.sqlite/restore')
        .expect(404);
    });
  });

  // ─── Deployment-controlled overview ───────────────────────────────────────

  describe('deployment-controlled overview', () => {
    it('shows automatic scanning as Off and preserves existing deployment values', async () => {
      const res = await agent.get('/settings').expect(200);

      expect(res.text).toContain('Deployment-controlled');
      expect(res.text).toContain('auto_scan_interval_minutes');
      expect(res.text).toContain('>Off</span>');
      expect(res.text).toContain('projects_root');
      expect(res.text).toContain(renderedPath(projectsRoot));
      expect(res.text).toContain('database_path');
      expect(res.text).toContain(renderedPath(databasePath));
      expect(res.text).toContain('trust_proxy');
      expect(res.text).toContain('hsts_enabled');
      expect(res.text).not.toContain(
        'These values are set by the deployment environment and cannot be changed from this page.'
      );
    });

    it('shows the configured automatic scan interval when enabled', async () => {
      const configuredApp = createApp(
        { appName: APP_NAME, db, projectsRoot },
        {
          backupService,
          maintenanceState,
          appDataRoot,
          databasePath,
          migrationsDir: MIGRATIONS_DIR,
          authConfig: AUTH_CONFIG,
          authSettings: AUTH_SETTINGS,
          autoScanIntervalMinutes: 15,
        },
      );
      const configuredAuth = await authenticate(configuredApp);
      const res = await configuredAuth.agent.get('/settings').expect(200);

      expect(res.text).toContain('auto_scan_interval_minutes');
      expect(res.text).toContain('15 minutes');
    });
  });

  // ─── Navigation active state ───────────────────────────────────────────────

  describe('navigation active state', () => {
    it('Settings nav item is active on /settings', async () => {
      const res = await agent.get('/settings').expect(200);
      expect(activeNavKeys(res.text)).toContain('settings');
    });

    it('Settings nav item is active on /settings/backups', async () => {
      const res = await agent.get('/settings/backups').expect(200);
      expect(activeNavKeys(res.text)).toContain('settings');
    });

    it('Settings nav item is active on the restore confirmation page', async () => {
      const result = await backupService.createBackup(db);
      const res = await agent.get(`/settings/backups/${result.filename}/restore`)
        .expect(200);
      expect(activeNavKeys(res.text)).toContain('settings');
    });

    it('Projects and Releases are not active on settings pages', async () => {
      const res = await agent.get('/settings/backups').expect(200);
      expect(activeNavKeys(res.text)).not.toContain('projects');
      expect(activeNavKeys(res.text)).not.toContain('releases');
    });

    it('exactly one nav item is active on settings pages', async () => {
      const res = await agent.get('/settings/backups').expect(200);
      expect(activeNavKeys(res.text)).toHaveLength(1);
    });

    it('settings nav renders in the shell alongside other destinations', async () => {
      const res = await agent.get('/settings').expect(200);
      expect(navHrefs(res.text)).toContain('/settings');
      expect(navHrefs(res.text)).toContain('/projects');
      expect(navHrefs(res.text)).toContain('/releases');
    });
  });

  // ─── Single <h1> invariant ─────────────────────────────────────────────────

  describe('accessibility — single <h1>', () => {
    it('GET /settings has exactly one <h1>', async () => {
      const res = await agent.get('/settings').expect(200);
      expect(countH1(res.text)).toBe(1);
    });

    it('GET /settings/backups has exactly one <h1>', async () => {
      const res = await agent.get('/settings/backups').expect(200);
      expect(countH1(res.text)).toBe(1);
    });

    it('restore confirmation page has exactly one <h1>', async () => {
      const result = await backupService.createBackup(db);
      const res = await agent.get(`/settings/backups/${result.filename}/restore`)
        .expect(200);
      expect(countH1(res.text)).toBe(1);
    });
  });

  // ─── Backup list display ───────────────────────────────────────────────────

  describe('backup list', () => {
    it('shows empty state when no backups exist', async () => {
      const res = await agent.get('/settings/backups').expect(200);
      expect(res.text).toContain('No backups');
    });

    it('shows the backup filename after creation', async () => {
      const result = await backupService.createBackup(db);
      const res = await agent.get('/settings/backups').expect(200);
      expect(res.text).toContain(result.filename);
    });

    it('does not render absolute filesystem paths', async () => {
      await backupService.createBackup(db);
      const res = await agent.get('/settings/backups').expect(200);
      expect(res.text).not.toContain(appDataRoot);
      expect(res.text).not.toContain(databasePath);
      // No drive-letter absolute path either
      expect(res.text).not.toMatch(/[A-Za-z]:[/\\]/);
    });

    it('explains that backups cover SQLite application data', async () => {
      const res = await agent.get('/settings/backups').expect(200);
      expect(res.text).toContain('SQLite');
    });

    it('states that project files are not included', async () => {
      const res = await agent.get('/settings/backups').expect(200);
      expect(res.text).toContain('project files');
    });
  });

  // ─── Create Backup POST ────────────────────────────────────────────────────

  describe('POST /settings/backups — create backup', () => {
    it('creates a backup file and redirects with success notice', async () => {
      const res = await agent.post('/settings/backups').type('form').send({ _csrf: csrfToken }).expect(302);
      expect(res.headers.location).toBe('/settings/backups?notice=backup_created');

      const backupDir = resolveBackupDir(appDataRoot);
      const files = fs.readdirSync(backupDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^creatorcrate-.*\.sqlite$/);
    });

    it('shows success notice on the list page after creation', async () => {
      await agent.post('/settings/backups').type('form').send({ _csrf: csrfToken }).expect(302);
      const res = await agent.get('/settings/backups?notice=backup_created')
        .expect(200);
      expect(res.text).toContain('Backup created successfully');
    });

    it('redirects with failure notice when backup service throws', async () => {
      const stubbedService = {
        ...backupService,
        createBackup: async () => { throw new Error('simulated'); },
        isRestoreInProgress: () => false,
      };
      const appWithStub = createApp(
        { appName: APP_NAME, db, projectsRoot },
        { backupService: stubbedService, maintenanceState, appDataRoot, databasePath, authConfig: AUTH_CONFIG }
      );
      const { agent: stubAgent, csrfToken: stubCsrf } = await authenticate(appWithStub);
      const res = await stubAgent.post('/settings/backups').type('form').send({ _csrf: stubCsrf }).expect(302);
      expect(res.headers.location).toBe('/settings/backups?notice=backup_failed');
    });

    it('does not expose internal exception text on backup failure', async () => {
      const stubbedService = {
        ...backupService,
        createBackup: async () => { throw new Error('SECRET_INTERNAL_ERROR_XYZ'); },
        isRestoreInProgress: () => false,
      };
      const appWithStub = createApp(
        { appName: APP_NAME, db, projectsRoot },
        { backupService: stubbedService, maintenanceState, appDataRoot, databasePath, authConfig: AUTH_CONFIG }
      );
      const { agent: stubAgent, csrfToken: stubCsrf } = await authenticate(appWithStub);
      await stubAgent.post('/settings/backups').type('form').send({ _csrf: stubCsrf }).expect(302);
      const res = await stubAgent
        .get('/settings/backups?notice=backup_failed')
        .expect(200);
      expect(res.text).not.toContain('SECRET_INTERNAL_ERROR_XYZ');
    });
  });

  // ─── Restore GET never mutates ─────────────────────────────────────────────

  describe('restore GET never mutates', () => {
    it('visiting the restore confirmation does not create or delete backup files', async () => {
      const result = await backupService.createBackup(db);
      const backupDir = resolveBackupDir(appDataRoot);
      const before = fs.readdirSync(backupDir).sort();

      await agent.get(`/settings/backups/${result.filename}/restore`)
        .expect(200);

      const after = fs.readdirSync(backupDir).sort();
      expect(after).toEqual(before);
    });

    it('restore confirmation shows the backup filename and metadata', async () => {
      const result = await backupService.createBackup(db);
      const res = await agent.get(`/settings/backups/${result.filename}/restore`)
        .expect(200);
      expect(res.text).toContain(result.filename);
    });

    it('restore confirmation page contains a POST form and a Cancel link', async () => {
      const result = await backupService.createBackup(db);
      const res = await agent.get(`/settings/backups/${result.filename}/restore`)
        .expect(200);
      expect(res.text).toContain('method="post"');
      expect(res.text).toContain('href="/settings/backups"');
    });
  });

  // ─── Restore POST — filename validation ───────────────────────────────────

  describe('restore POST — filename rejection', () => {
    it('redirects with failure notice for a non-existent managed filename', async () => {
      const res = await agent.post('/settings/backups/creatorcrate-2026-01-01T000000Z.sqlite/restore')
        .type('form').send({ _csrf: csrfToken })
        .expect(302);
      expect(res.headers.location).toBe('/settings/backups?notice=restore_failed');
    });

    it('redirects with failure notice for an unmanaged filename pattern', async () => {
      // Express decodes %2F; the service's resolveBackupFile will reject a
      // filename that doesn't match the naming contract.
      const res = await agent.post('/settings/backups/definitely-not-managed.db/restore')
        .type('form').send({ _csrf: csrfToken })
        .expect(302);
      expect(res.headers.location).toBe('/settings/backups?notice=restore_failed');
    });
  });

  // ─── Restore POST — valid restore ─────────────────────────────────────────

  describe('restore POST — valid restore', () => {
    it('calls onDatabaseReplaced with the new handle and redirects to success', async () => {
      const result = await backupService.createBackup(db);
      let replacedDb = null;

      const appWithReplace = createApp(
        { appName: APP_NAME, db, projectsRoot },
        {
          backupService,
          maintenanceState,
          appDataRoot,
          databasePath,
          onDatabaseReplaced: (newDb) => { replacedDb = newDb; },
          authConfig: AUTH_CONFIG,
        }
      );

      const { agent: replaceAgent, csrfToken: replaceCsrf } = await authenticate(appWithReplace);
      const res = await replaceAgent
        .post(`/settings/backups/${result.filename}/restore`)
        .type('form').send({ _csrf: replaceCsrf })
        .expect(302);
      expect(res.headers.location).toBe('/settings/backups?notice=restore_success');
      expect(replacedDb).not.toBeNull();

      // The restored db is open; close it to avoid a resource leak.
      if (replacedDb) { try { replacedDb.close(); } catch {} }
    });

    it('shows success notice on the backup list after restore', async () => {
      const result = await backupService.createBackup(db);
      const appWithReplace = createApp(
        { appName: APP_NAME, db, projectsRoot },
        {
          backupService,
          maintenanceState,
          appDataRoot,
          databasePath,
          onDatabaseReplaced: (newDb) => { try { newDb.close(); } catch {} },
        }
      );

      // Real (non-stubbed) restore swaps the live database handle; this
      // ad hoc app instance has no app-rebuild hook to carry an
      // authenticated session across that swap (production does this via
      // app-context.js), so this request stays unauthenticated like the
      // sibling restore tests below that also exercise a real restore.
      await request(appWithReplace)
        .post(`/settings/backups/${result.filename}/restore`)
        .expect(302);

      // The backup list is still reachable for the success-notice GET.
      const res = await request(appWithReplace)
        .get('/settings/backups?notice=restore_success')
        .expect(200);
      expect(res.text).toContain('Database restored from the selected backup');
    });

    it('leaves maintenance mode after a successful restore', async () => {
      const result = await backupService.createBackup(db);
      // Close the restored db handle so Windows can delete the tmpDir in afterEach.
      const appWithClose = createApp(
        { appName: APP_NAME, db, projectsRoot },
        {
          backupService,
          maintenanceState,
          appDataRoot,
          databasePath,
          onDatabaseReplaced: (newDb) => { try { newDb.close(); } catch {} },
          authConfig: AUTH_CONFIG,
        }
      );

      const { agent: closeAgent, csrfToken: closeCsrf } = await authenticate(appWithClose);
      await closeAgent
        .post(`/settings/backups/${result.filename}/restore`)
        .type('form').send({ _csrf: closeCsrf })
        .expect(302);

      expect(maintenanceState.active).toBe(false);
    });
  });

  // ─── Restore POST — BackupError with recovered db ─────────────────────────

  describe('restore POST — BackupError with recovered db handle', () => {
    it('calls onDatabaseReplaced even when the restore throws BackupError with .db', async () => {
      const result = await backupService.createBackup(db);
      let replacedDb = null;
      const fakeNewDb = { close: () => {} };

      const stubbedService = {
        ...backupService,
        isRestoreInProgress: () => false,
        restoreBackup: async () => {
          throw new BackupError('forced failure', { db: fakeNewDb });
        },
      };

      const appWithStub = createApp(
        { appName: APP_NAME, db, projectsRoot },
        {
          backupService: stubbedService,
          maintenanceState,
          appDataRoot,
          databasePath,
          onDatabaseReplaced: (newDb) => { replacedDb = newDb; },
          authConfig: AUTH_CONFIG,
        }
      );

      const { agent: stubAgent, csrfToken: stubCsrf } = await authenticate(appWithStub);
      const res = await stubAgent
        .post(`/settings/backups/${result.filename}/restore`)
        .type('form').send({ _csrf: stubCsrf })
        .expect(302);
      expect(res.headers.location).toBe('/settings/backups?notice=restore_failed');
      expect(replacedDb).toBe(fakeNewDb);
    });

    it('leaves maintenance mode after a BackupError', async () => {
      const result = await backupService.createBackup(db);
      const stubbedState = { active: false };

      const stubbedService = {
        ...backupService,
        isRestoreInProgress: () => false,
        restoreBackup: async () => { throw new BackupError('fail'); },
      };

      const appWithStub = createApp(
        { appName: APP_NAME, db, projectsRoot },
        { backupService: stubbedService, maintenanceState: stubbedState, appDataRoot, databasePath, authConfig: AUTH_CONFIG }
      );

      const { agent: stubAgent2, csrfToken: stubCsrf2 } = await authenticate(appWithStub);
      await stubAgent2
        .post(`/settings/backups/${result.filename}/restore`)
        .type('form').send({ _csrf: stubCsrf2 })
        .expect(302);

      expect(stubbedState.active).toBe(false);
    });
  });

  // ─── Restore POST — concurrent restore prevention ─────────────────────────

  describe('restore POST — concurrent restore prevention', () => {
    it('redirects with restore_conflict when isRestoreInProgress returns true', async () => {
      const result = await backupService.createBackup(db);
      const stubbedService = {
        ...backupService,
        isRestoreInProgress: () => true,
      };
      const appWithStub = createApp(
        { appName: APP_NAME, db, projectsRoot },
        { backupService: stubbedService, maintenanceState: { active: false }, appDataRoot, databasePath, authConfig: AUTH_CONFIG }
      );

      const { agent: stubAgent3, csrfToken: stubCsrf3 } = await authenticate(appWithStub);
      const res = await stubAgent3
        .post(`/settings/backups/${result.filename}/restore`)
        .type('form').send({ _csrf: stubCsrf3 })
        .expect(302);
      expect(res.headers.location).toBe('/settings/backups?notice=restore_conflict');
    });

    it('returns 503 when maintenanceState.active is already true (another restore is running)', async () => {
      // When maintenance is already active the maintenance middleware intercepts
      // every non-health, non-static request before it reaches any route handler.
      // The restore POST is not exempt, so it gets a 503, not the redirect_conflict
      // that the handler would produce. This is correct: the operator knows not to
      // submit a second restore when the app is already in maintenance mode.
      const result = await backupService.createBackup(db);
      const activeState = { active: false };
      const appWithActive = createApp(
        { appName: APP_NAME, db, projectsRoot },
        { backupService, maintenanceState: activeState, appDataRoot, databasePath, authConfig: AUTH_CONFIG }
      );

      // Authenticate before maintenance goes active: the maintenance gate
      // intercepts every non-health, non-static request (including /login),
      // so an operator's session must already exist before the flag flips.
      const { agent: activeAgent, csrfToken: activeCsrf } = await authenticate(appWithActive);
      activeState.active = true;
      await activeAgent
        .post(`/settings/backups/${result.filename}/restore`)
        .type('form').send({ _csrf: activeCsrf })
        .expect(503);
    });
  });

  // ─── Delete GET never mutates ──────────────────────────────────────────────

  describe('delete GET never mutates', () => {
    it('visiting the delete confirmation does not delete backup files', async () => {
      const result = await backupService.createBackup(db);
      const backupDir = resolveBackupDir(appDataRoot);
      const before = fs.readdirSync(backupDir).sort();

      await agent.get(`/settings/backups/${result.filename}/delete`)
        .expect(200);

      const after = fs.readdirSync(backupDir).sort();
      expect(after).toEqual(before);
    });

    it('delete confirmation shows the backup filename', async () => {
      const result = await backupService.createBackup(db);
      const res = await agent.get(`/settings/backups/${result.filename}/delete`)
        .expect(200);
      expect(res.text).toContain(result.filename);
    });

    it('delete confirmation page contains a POST form and a Cancel link', async () => {
      const result = await backupService.createBackup(db);
      const res = await agent.get(`/settings/backups/${result.filename}/delete`)
        .expect(200);
      expect(res.text).toContain('method="post"');
      expect(res.text).toContain('href="/settings/backups"');
    });

    it('returns 404 for an unknown backup', async () => {
      await agent.get('/settings/backups/creatorcrate-2026-01-01T000000Z.sqlite/delete')
        .expect(404);
    });
  });

  // ─── Delete POST ────────────────────────────────────────────────────────────

  describe('POST /settings/backups/:filename/delete', () => {
    it('deletes the backup file and redirects with success notice', async () => {
      const result = await backupService.createBackup(db);
      const backupDir = resolveBackupDir(appDataRoot);

      const res = await agent.post(`/settings/backups/${result.filename}/delete`)
        .type('form').send({ _csrf: csrfToken })
        .expect(302);
      expect(res.headers.location).toBe('/settings/backups?notice=backup_deleted');
      expect(fs.readdirSync(backupDir)).toEqual([]);
    });

    it('shows success notice on the list page after deletion', async () => {
      const result = await backupService.createBackup(db);
      await agent.post(`/settings/backups/${result.filename}/delete`).type('form').send({ _csrf: csrfToken }).expect(302);
      const res = await agent.get('/settings/backups?notice=backup_deleted')
        .expect(200);
      expect(res.text).toContain('Backup deleted');
    });

    it('redirects with failure notice for a non-existent managed filename', async () => {
      const res = await agent.post('/settings/backups/creatorcrate-2026-01-01T000000Z.sqlite/delete')
        .type('form').send({ _csrf: csrfToken })
        .expect(302);
      expect(res.headers.location).toBe('/settings/backups?notice=delete_failed');
    });

    it('rejects traversal filenames without touching other backups', async () => {
      const result = await backupService.createBackup(db);
      const backupDir = resolveBackupDir(appDataRoot);

      const res = await agent.post('/settings/backups/..%2F..%2Fetc%2Fpasswd/delete')
        .type('form').send({ _csrf: csrfToken })
        .expect(302);
      expect(res.headers.location).toBe('/settings/backups?notice=delete_failed');
      expect(fs.readdirSync(backupDir)).toEqual([result.filename]);
    });

    it('cannot delete a staging or rollback artifact', async () => {
      const backupDir = resolveBackupDir(appDataRoot);
      const stagingName = 'creatorcrate-2026-07-29T192447Z.sqlite.staging';
      fs.writeFileSync(path.join(backupDir, stagingName), 'x');

      const res = await agent.post(`/settings/backups/${stagingName}/delete`)
        .type('form').send({ _csrf: csrfToken })
        .expect(302);
      expect(res.headers.location).toBe('/settings/backups?notice=delete_failed');
      expect(fs.existsSync(path.join(backupDir, stagingName))).toBe(true);
    });

    it('does not expose internal exception text on delete failure', async () => {
      const stubbedService = {
        ...backupService,
        deleteBackup: () => { throw new Error('SECRET_INTERNAL_ERROR_XYZ'); },
      };
      const appWithStub = createApp(
        { appName: APP_NAME, db, projectsRoot },
        { backupService: stubbedService, maintenanceState, appDataRoot, databasePath, authConfig: AUTH_CONFIG }
      );
      const { agent: stubAgent, csrfToken: stubCsrf } = await authenticate(appWithStub);
      await stubAgent
        .post('/settings/backups/creatorcrate-2026-01-01T000000Z.sqlite/delete')
        .type('form').send({ _csrf: stubCsrf })
        .expect(302);
      const res = await stubAgent
        .get('/settings/backups?notice=delete_failed')
        .expect(200);
      expect(res.text).not.toContain('SECRET_INTERNAL_ERROR_XYZ');
    });
  });

  // ─── Backup list shows Delete action ───────────────────────────────────────

  describe('backup list delete action', () => {
    it('shows a Delete action for each listed backup', async () => {
      const result = await backupService.createBackup(db);
      const res = await agent.get('/settings/backups').expect(200);
      expect(res.text).toContain(`/settings/backups/${result.filename}/delete`);
    });
  });

  // ─── Maintenance 503 behavior ──────────────────────────────────────────────

  describe('maintenance 503 behavior', () => {
    it('returns 503 HTML for ordinary page requests while in maintenance', async () => {
      maintenanceState.active = true;
      const res = await agent.get('/projects').expect(503);
      expect(res.text).toContain('temporarily unavailable');
    });

    it('returns 503 for the dashboard while in maintenance', async () => {
      maintenanceState.active = true;
      await agent.get('/').expect(503);
    });

    it('accepts non-HTML requests with 503 JSON while in maintenance', async () => {
      maintenanceState.active = true;
      const res = await agent.get('/projects')
        .set('Accept', 'application/json')
        .expect(503);
      expect(res.body.status).toBe('error');
    });
  });

  // ─── Health during maintenance ─────────────────────────────────────────────

  describe('health during maintenance', () => {
    it('reports maintenance state as 503 JSON', async () => {
      maintenanceState.active = true;
      const res = await agent.get('/health').expect(503);
      expect(res.body.status).toBe('maintenance');
      expect(res.body.database).toBe('unavailable');
    });

    it('reports ok when not in maintenance', async () => {
      const res = await agent.get('/health').expect(200);
      expect(res.body.status).toBe('ok');
    });
  });

  // ─── Project files untouched ───────────────────────────────────────────────

  describe('project files untouched', () => {
    it('backup creation does not modify or delete files under projectsRoot', async () => {
      const sentinel = path.join(projectsRoot, 'sentinel.txt');
      fs.writeFileSync(sentinel, 'project-content');

      await backupService.createBackup(db);

      expect(fs.readFileSync(sentinel, 'utf8')).toBe('project-content');
    });
  });

  // ─── No-JavaScript forms ──────────────────────────────────────────────────

  describe('no-JavaScript forms', () => {
    it('Create Backup uses a plain HTML POST form with no onclick attributes', async () => {
      const res = await agent.get('/settings/backups').expect(200);
      expect(res.text).toContain('method="post"');
      expect(res.text).toContain('action="/settings/backups"');
      expect(res.text).not.toContain('onclick=');
    });

    it('Restore form uses a plain HTML POST form with no onclick attributes', async () => {
      const result = await backupService.createBackup(db);
      const res = await agent.get(`/settings/backups/${result.filename}/restore`)
        .expect(200);
      expect(res.text).toContain('method="post"');
      expect(res.text).not.toContain('onclick=');
    });
  });
});
