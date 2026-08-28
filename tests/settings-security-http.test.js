import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { createApplicationContext } from '../src/app-context.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { hashPassword } from '../src/auth/password-hash.js';
import { createManagedCredentialProvider, createStaticCredentialProvider } from '../src/auth/credential-provider.js';
import { createLoginThrottler } from '../src/auth/login-throttle.js';
import { ensureAuthEnablement, enableAuthState, readAuthEnablement } from '../src/auth/auth-state.js';
import { AUTH_CONFIG, TEST_PASSWORD, authenticate, extractCsrfToken } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const NEW_PASSWORD = 'NewCorrectHorseBattery';

function countH1(html) {
  return (html.match(/<h1[\s>]/g) || []).length;
}

function makeAuthConfig(provider) {
  return { ...AUTH_CONFIG, credentialProvider: provider };
}

describe('settings security — password rotation', () => {
  let tmpDir;
  let db;
  let app;
  let provider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-settings-security-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    provider = createStaticCredentialProvider({ username: 'admin', passwordHash: hashPassword(TEST_PASSWORD) });
    app = createApp(
      { appName: 'CreatorCrate', db },
      { authConfig: makeAuthConfig(provider), credentialProvider: provider, loginThrottler: createLoginThrottler({ baseDelayMs: 0, maxDelayMs: 0 }) }
    );
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders an authenticated no-JavaScript security form with visible labels and one h1', async () => {
    const { agent } = await authenticate(app);
    const res = await agent.get('/settings/security').expect(200);
    expect(countH1(res.text)).toBe(1);
    expect(res.text).toContain('Change password');
    expect(res.text).toMatch(/<label[^>]*for="currentPassword"/);
    expect(res.text).toMatch(/autocomplete="current-password"/);
    expect(res.text).toMatch(/<label[^>]*for="newPassword"/);
    expect(res.text).toMatch(/autocomplete="new-password"/);
    expect(res.text).toMatch(/<label[^>]*for="confirmPassword"/);
    expect(res.text).toContain('<script type="module" src="/creatorcrate.js"></script>');
    expect(res.text).not.toMatch(/<script(?![^>]+src=)[^>]*>/);
    expect(res.text).not.toMatch(/type="password"[^>]*value=/);
    expect(res.text).toMatch(/<form method="post" action="\/settings\/security\/password" class="project-form settings-security-form" novalidate>[\s\S]*?<div class="form-actions">\s*<button type="submit" class="button button-primary settings-security-save-action">Save<\/button>/);
    expect(res.text).not.toContain('>Cancel</a>');
    expect(res.text).toMatch(/<div class="destructive-section settings-security-destructive">[\s\S]*?<a href="\/settings\/security\/disable" class="button button-danger">Disable Authentication<\/a>/);
  });

  it('rejects wrong current password generically without changing credentials or echoing passwords', async () => {
    const { agent, csrfToken } = await authenticate(app);
    const res = await agent
      .post('/settings/security/password')
      .type('form')
      .send({ _csrf: csrfToken, currentPassword: 'wrong-current', newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })
      .expect(400);
    expect(res.text).toContain('Current password is incorrect.');
    expect(res.text).not.toContain('wrong-current');
    expect(res.text).not.toContain(NEW_PASSWORD);
    expect(provider.verifyPassword(TEST_PASSWORD)).toBe(true);
  });

  it('shows clear password-policy errors without retaining submitted passwords', async () => {
    const { agent, csrfToken } = await authenticate(app);
    const res = await agent
      .post('/settings/security/password')
      .type('form')
      .send({ _csrf: csrfToken, currentPassword: TEST_PASSWORD, newPassword: 'short', confirmPassword: 'different' })
      .expect(400);
    expect(res.text).toContain('New password must be at least 12 characters.');
    expect(res.text).toContain('New password and confirmation must match.');
    expect(res.text).not.toContain('short');
    expect(res.text).not.toContain('different');
  });

  it('rotates password, revokes current and second sessions, invalidates old CSRF, and requires new login', async () => {
    const first = await authenticate(app);
    const second = await authenticate(app);
    await first.agent.get('/projects').expect(200);
    await second.agent.get('/projects').expect(200);

    const rotate = await first.agent
      .post('/settings/security/password')
      .type('form')
      .send({ _csrf: first.csrfToken, currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })
      .expect(302);
    expect(rotate.headers.location).toBe('/login?notice=password_rotated');
    expect(rotate.headers['set-cookie'].join('\n')).toMatch(/cc_session=;/);

    await first.agent.get('/projects').expect(302);
    await second.agent.get('/projects').expect(302);
    await second.agent.post('/logout').type('form').send({ _csrf: second.csrfToken }).expect(401);

    const oldAgent = request.agent(app);
    const oldLoginPage = await oldAgent.get('/login').expect(200);
    const oldCsrf = extractCsrfToken(oldLoginPage.text);
    await oldAgent
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: TEST_PASSWORD, _csrf: oldCsrf })
      .expect(401);

    const newAgent = request.agent(app);
    const newLoginPage = await newAgent.get('/login').expect(200);
    const newCsrf = extractCsrfToken(newLoginPage.text);
    await newAgent
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: NEW_PASSWORD, _csrf: newCsrf })
      .expect(302);
    await newAgent.get('/projects').expect(200);

    const rows = db.prepare("SELECT event, level, kind, context_json FROM application_logs WHERE event = 'security.password_changed'").all();
    expect(rows).toEqual([expect.objectContaining({
      event: 'security.password_changed', level: 'info', kind: 'activity', context_json: '{}',
    })]);
    expect(JSON.stringify(rows)).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(rows)).not.toContain(TEST_PASSWORD);
  });

  it('requires CSRF for password rotation', async () => {
    const { agent } = await authenticate(app);
    await agent
      .post('/settings/security/password')
      .type('form')
      .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })
      .expect(403);
  });
});

describe('settings security — managed credential restart persistence', () => {
  it('retains the rotated managed credential across app reconstruction and ignores the old environment hash', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-managed-restart-'));
    const db = openDatabase(path.join(tmpDir, 'test.db'));
    try {
      runMigrations(db, MIGRATIONS_DIR);
      const appDataRoot = path.join(tmpDir, 'app');
      fs.mkdirSync(appDataRoot, { recursive: true });
      const provider = createManagedCredentialProvider({
        appDataRoot,
        bootstrapUsername: 'admin',
        bootstrapPasswordHash: hashPassword(TEST_PASSWORD),
      });
      let app = createApp(
        { appName: 'CreatorCrate', db },
        { authConfig: makeAuthConfig(provider), credentialProvider: provider, loginThrottler: createLoginThrottler({ baseDelayMs: 0, maxDelayMs: 0 }) }
      );
      const { agent, csrfToken } = await authenticate(app);
      await agent
        .post('/settings/security/password')
        .type('form')
        .send({ _csrf: csrfToken, currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })
        .expect(302);

      const restartedProvider = createManagedCredentialProvider({
        appDataRoot,
        bootstrapUsername: 'admin',
        bootstrapPasswordHash: hashPassword('OldEnvironmentPassword123'),
      });
      app = createApp(
        { appName: 'CreatorCrate', db },
        { authConfig: makeAuthConfig(restartedProvider), credentialProvider: restartedProvider, loginThrottler: createLoginThrottler({ baseDelayMs: 0, maxDelayMs: 0 }) }
      );

      const oldAgent = request.agent(app);
      const oldLogin = await oldAgent.get('/login').expect(200);
      await oldAgent
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: TEST_PASSWORD, _csrf: extractCsrfToken(oldLogin.text) })
        .expect(401);

      const newAgent = request.agent(app);
      const newLogin = await newAgent.get('/login').expect(200);
      await newAgent
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: NEW_PASSWORD, _csrf: extractCsrfToken(newLogin.text) })
        .expect(302);
    } finally {
      closeDatabase(db);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

const AUTH_SETTINGS = Object.freeze({ sessionTtlHours: 24, cookieSecure: false, trustProxy: false, hstsEnabled: false });
const NEW_USERNAME = 'newadmin';

// ─── Phase 13: browser enable/disable authentication workflow ─────────
describe('settings security — enable authentication workflow', () => {
  let tmpDir;
  let appDataRoot;
  let db;
  let appContext;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-enable-auth-'));
    appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    db = openDatabase(path.join(appDataRoot, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    ensureAuthEnablement(appDataRoot);

    appContext = createApplicationContext(
      {
        appName: 'CreatorCrate',
        appOpts: {
          appDataRoot,
          authConfig: null,
          authSettings: AUTH_SETTINGS,
          authState: { csrfPepper: ensureAuthEnablement(appDataRoot).csrfPepper },
        },
      },
      db
    );
  });

  afterEach(() => {
    closeDatabase(appContext.db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function getEnableForm() {
    const agent = request.agent(appContext.handleRequest);
    const page = await agent.get('/settings/security').expect(200);
    return { agent, csrfToken: extractCsrfToken(page.text) };
  }

  it('renders the enable action in the page heading and associates it with the disabled-state form', async () => {
    const { agent } = await getEnableForm();
    const res = await agent.get('/settings/security').expect(200);
    expect(res.text).toContain('Enable authentication');
    expect(res.text).toContain('Anyone who can reach this server can currently access CreatorCrate');
    expect(res.text).not.toContain('Change password');
    expect(res.text).toMatch(/<div class="page-heading-actions">[\s\S]*?<button type="submit" class="button button-primary settings-security-enable-action" form="enable-authentication-form">Enable Authentication<\/button>/);
    expect(res.text).toMatch(/<form id="enable-authentication-form" method="post" action="\/settings\/security\/enable" class="project-form settings-security-form" novalidate>/);
    expect(res.text).not.toMatch(/<div class="form-actions settings-enable-action-row">[\s\S]*?Enable Authentication/);
    expect(res.text).not.toContain('>Cancel</a>');
  });

  it('rejects a mismatched confirmation without writing any managed state', async () => {
    const { agent, csrfToken } = await getEnableForm();
    const res = await agent
      .post('/settings/security/enable')
      .type('form')
      .send({ _csrf: csrfToken, username: NEW_USERNAME, password: 'CorrectHorseBattery1', confirmPassword: 'Different1234567' })
      .expect(400);
    expect(res.text).toContain('Enable authentication');
    expect(readAuthEnablement(appDataRoot).enabled).toBe(false);
  });

  it('enables authentication immediately, with no restart, and the chosen credentials work right away', async () => {
    const { agent, csrfToken } = await getEnableForm();
    const password = 'CorrectHorseBattery1';
    const res = await agent
      .post('/settings/security/enable')
      .type('form')
      .send({ _csrf: csrfToken, username: NEW_USERNAME, password, confirmPassword: password })
      .expect(302);
    expect(res.headers.location).toBe('/login?notice=authentication_enabled');

    expect(readAuthEnablement(appDataRoot).enabled).toBe(true);

    // Same appContext, no restart: protected routes now require login.
    await request(appContext.handleRequest).get('/projects').expect(302);

    const loginAgent = request.agent(appContext.handleRequest);
    const loginPage = await loginAgent.get('/login').expect(200);
    await loginAgent
      .post('/login')
      .type('form')
      .send({ username: NEW_USERNAME, password, _csrf: extractCsrfToken(loginPage.text) })
      .expect(302);
    await loginAgent.get('/projects').expect(200);
    expect(appContext.db.prepare("SELECT event FROM application_logs WHERE event = 'security.enabled'").all())
      .toEqual([{ event: 'security.enabled' }]);
  });

  it('CSRF is required for the enable form', async () => {
    const { agent } = await getEnableForm();
    const password = 'CorrectHorseBattery1';
    await agent
      .post('/settings/security/enable')
      .type('form')
      .send({ username: NEW_USERNAME, password, confirmPassword: password })
      .expect(403);
    expect(readAuthEnablement(appDataRoot).enabled).toBe(false);
  });
});

describe('settings security — disable authentication workflow', () => {
  let tmpDir;
  let appDataRoot;
  let db;
  let appContext;
  let provider;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-disable-auth-'));
    appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    db = openDatabase(path.join(appDataRoot, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    provider = createManagedCredentialProvider({
      appDataRoot,
      bootstrapUsername: 'admin',
      bootstrapPasswordHash: hashPassword(TEST_PASSWORD),
    });
    const sessionSecret = 'c'.repeat(64);
    // Persist the matching on-disk "enabled" state — the disable workflow
    // reads auth-enablement.json directly, so the fixture's in-memory
    // authConfig and the on-disk managed state must agree.
    const pepper = ensureAuthEnablement(appDataRoot).csrfPepper;
    const authEnablementState = enableAuthState(appDataRoot, { sessionSecret, csrfPepper: pepper });

    appContext = createApplicationContext(
      {
        appName: 'CreatorCrate',
        appOpts: {
          appDataRoot,
          authConfig: { ...AUTH_SETTINGS, sessionSecret, credentialProvider: provider },
          authSettings: AUTH_SETTINGS,
          authState: { csrfPepper: authEnablementState.csrfPepper },
          loginThrottler: createLoginThrottler({ baseDelayMs: 0, maxDelayMs: 0 }),
        },
      },
      db
    );
  });

  afterEach(() => {
    closeDatabase(appContext.db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects disable with the wrong current password, leaving auth enabled', async () => {
    const { agent } = await authenticate(appContext.handleRequest);
    const page = await agent.get('/settings/security/disable').expect(200);
    const res = await agent
      .post('/settings/security/disable')
      .type('form')
      .send({ _csrf: extractCsrfToken(page.text), currentPassword: 'totally-wrong' })
      .expect(400);
    expect(res.text).toContain('Current password is incorrect.');
    await request(appContext.handleRequest).get('/projects').expect(302);
  });

  it('disables authentication immediately: sessions revoked, cookie cleared, routes public with no restart', async () => {
    const { agent } = await authenticate(appContext.handleRequest);
    const page = await agent.get('/settings/security/disable').expect(200);
    const res = await agent
      .post('/settings/security/disable')
      .type('form')
      .send({ _csrf: extractCsrfToken(page.text), currentPassword: TEST_PASSWORD })
      .expect(302);
    expect(res.headers.location).toBe('/settings/security?notice=authentication_disabled');
    expect(res.headers['set-cookie'].join('\n')).toMatch(/cc_session=;/);

    // Same appContext, no restart: the old session cookie no longer applies
    // (there is no auth wall at all now, so the point is moot, but the
    // cookie itself must be gone), and routes are public immediately.
    await agent.get('/projects').expect(200);
    await request(appContext.handleRequest).get('/projects').expect(200);

    expect(readAuthEnablement(appDataRoot).enabled).toBe(false);
    // The old login no longer applies at all: /login has nothing to log
    // into anymore and just redirects to Settings > Security.
    const res2 = await request(appContext.handleRequest).get('/login');
    expect(res2.status).toBe(302);
    expect(res2.headers.location).toBe('/settings/security');
    expect(appContext.db.prepare("SELECT event FROM application_logs WHERE event = 'security.disabled'").all())
      .toEqual([{ event: 'security.disabled' }]);
  });

  it('requires CSRF for the disable form', async () => {
    const { agent } = await authenticate(appContext.handleRequest);
    await agent.get('/settings/security/disable').expect(200);
    await agent
      .post('/settings/security/disable')
      .type('form')
      .send({ currentPassword: TEST_PASSWORD })
      .expect(403);
    await request(appContext.handleRequest).get('/projects').expect(302);
  });
});
