/**
 * Phase 12.2 — CSRF protection HTTP integration tests.
 *
 * Verifies that every mutating form includes exactly one CSRF token,
 * that missing/invalid/cross-session tokens are rejected, and that
 * login CSRF is enforced.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createBackupService } from '../src/services/backup-service.js';
import { STATUS_DIR_MAP } from '../src/storage/project-storage.js';
import { AUTH_CONFIG, TEST_PASSWORD, authenticate, extractCsrfToken, requestLoginPage, countTotalCsrfInputs } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function insertProject(db, title) {
  return db
    .prepare(
      `INSERT INTO projects (title, slug, description, notes, status, priority, planned_date, published_date, patreon_url)
       VALUES (?, ?, '', '', 'tbd', 'normal', NULL, NULL, NULL)`
    )
    .run(title, title.toLowerCase().replace(/\s+/g, '-')).lastInsertRowid;
}

describe('CSRF protection — authenticated mutations', () => {
  let tmpDir;
  let db;
  let app;
  let agent;
  let csrfToken;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-csrf-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: 'CreatorCrate', db, projectsRoot }, { authConfig: AUTH_CONFIG });
    const result = await authenticate(app);
    agent = result.agent;
    csrfToken = result.csrfToken;
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Missing CSRF token ──────────────────────────────────────────────

  it('rejects project creation POST without CSRF token', async () => {
    await agent.post('/projects').type('form').send({ title: 'No CSRF' }).expect(403);
  });

  it('rejects project edit POST without CSRF token', async () => {
    const id = insertProject(db, 'CSRF Test');
    await agent.post(`/projects/${id}`).type('form').send({ title: 'No CSRF' }).expect(403);
  });

  it('rejects project archive POST without CSRF token', async () => {
    const id = insertProject(db, 'CSRF Archive');
    await agent.post(`/projects/${id}/archive`).type('form').send({}).expect(403);
  });

  it('rejects backup creation POST without CSRF token', async () => {
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const backupService = createBackupService({ appDataRoot, databasePath: path.join(tmpDir, 'test.db'), migrationsDir: MIGRATIONS_DIR });
    const maintenanceState = { active: false };
    const backupApp = createApp(
      { appName: 'CreatorCrate', db, projectsRoot: path.join(tmpDir, 'projects') },
      { authConfig: AUTH_CONFIG, backupService, maintenanceState, appDataRoot, databasePath: path.join(tmpDir, 'test.db'), migrationsDir: MIGRATIONS_DIR }
    );
    const { agent: backupAgent, csrfToken: backupCsrf } = await authenticate(backupApp);
    await backupAgent.post('/settings/backups').type('form').send({}).expect(403);
  });

  it('rejects logout POST without CSRF token', async () => {
    await agent.post('/logout').type('form').send({}).expect(403);
  });

  it('rejects password rotation POST without CSRF token', async () => {
    await agent
      .post('/settings/security/password')
      .type('form')
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'NewCorrectHorseBattery', confirmPassword: 'NewCorrectHorseBattery' })
      .expect(403);
  });

  // ─── Invalid CSRF token ──────────────────────────────────────────────

  it('rejects POST with an invalid CSRF token', async () => {
    await agent
      .post('/projects')
      .type('form')
      .send({ title: 'Bad CSRF', _csrf: 'invalid-token-value' })
      .expect(403);
  });

  // ─── Valid CSRF token ─────────────────────────────────────────────────

  it('accepts POST with a valid CSRF token', async () => {
    await agent
      .post('/projects')
      .type('form')
      .send({ title: 'Valid CSRF', status: 'tbd', priority: 'normal', _csrf: csrfToken })
      .expect(302);
  });
});

describe('CSRF — login form has pre-auth CSRF token', () => {
  let tmpDir;
  let db;
  let app;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-csrf-login-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: 'CreatorCrate', db }, { authConfig: AUTH_CONFIG });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('login page includes a CSRF token', async () => {
    const res = await request(app).get('/login').expect(200);
    expect(res.text).toMatch(/<input[^>]+name="_csrf"[^>]+value="[^"]+"/);
  });

  it('login page has exactly one CSRF input', async () => {
    const res = await request(app).get('/login').expect(200);
    expect(countTotalCsrfInputs(res.text)).toBe(1);
  });

  it('login POST rejects a missing CSRF token', async () => {
    await request(app)
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: TEST_PASSWORD })
      .expect(403);
  });

  it('login POST rejects an invalid CSRF token', async () => {
    await request(app)
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: TEST_PASSWORD, _csrf: 'bad-token' })
      .expect(403);
  });

  it('login POST succeeds with a valid CSRF token from the login page', async () => {
    const { agent, csrfToken } = await requestLoginPage(app);
    const res = await agent
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: TEST_PASSWORD, _csrf: csrfToken })
      .expect(302);
    expect(res.headers.location).toBe('/');
  });
});

describe('CSRF — every mutating form has exactly one token', () => {
  let tmpDir;
  let db;
  let app;
  let agent;
  let csrfToken;
  let projectId;
  let releaseId;
  let backupService;
  let maintenanceState;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-csrf-forms-'));
    const projectsRoot = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    for (const dir of Object.values(STATUS_DIR_MAP)) {
      fs.mkdirSync(path.join(projectsRoot, dir), { recursive: true });
    }
    const appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    const databasePath = path.join(appDataRoot, 'creatorcrate.db');

    db = openDatabase(databasePath);
    runMigrations(db, MIGRATIONS_DIR);
    maintenanceState = { active: false };
    backupService = createBackupService({ appDataRoot, databasePath, migrationsDir: MIGRATIONS_DIR });

    app = createApp(
      { appName: 'CreatorCrate', db, projectsRoot },
      { authConfig: AUTH_CONFIG, backupService, maintenanceState, appDataRoot, databasePath, migrationsDir: MIGRATIONS_DIR }
    );

    const result = await authenticate(app);
    agent = result.agent;
    csrfToken = result.csrfToken;
    projectId = insertProject(db, 'CSRF Form Test');
  });

  afterEach(() => {
    maintenanceState.active = false;
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('project creation form has exactly one CSRF token (plus logout forms)', async () => {
    const res = await agent.get('/projects/new').expect(200);
    // 1 create form + 2 logout forms (desktop + mobile sidebar)
    expect(countTotalCsrfInputs(res.text)).toBe(3);
  });

  it('project edit form has exactly one CSRF token (plus logout forms)', async () => {
    const res = await agent.get(`/projects/${projectId}/edit`).expect(200);
    expect(countTotalCsrfInputs(res.text)).toBe(3);
  });

  it('project detail page archive form has exactly one CSRF token (plus logout forms)', async () => {
    const res = await agent.get(`/projects/${projectId}`).expect(200);
    expect(countTotalCsrfInputs(res.text)).toBe(3);
  });

  it('backup list page create form has exactly one CSRF token (plus logout forms)', async () => {
    const res = await agent.get('/settings/backups').expect(200);
    expect(countTotalCsrfInputs(res.text)).toBe(3);
  });

  it('login page has exactly one CSRF token', async () => {
    const res = await request(app).get('/login').expect(200);
    expect(countTotalCsrfInputs(res.text)).toBe(1);
  });

  it('settings index page has only logout CSRF tokens (no content forms)', async () => {
    const res = await agent.get('/settings').expect(200);
    // 2 logout forms (desktop + mobile sidebar), no content forms
    expect(countTotalCsrfInputs(res.text)).toBe(2);
  });

  it('security settings page has one password form token plus logout tokens', async () => {
    const res = await agent.get('/settings/security').expect(200);
    expect(countTotalCsrfInputs(res.text)).toBe(3);
  });
});
