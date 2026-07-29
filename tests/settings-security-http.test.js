import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { hashPassword } from '../src/auth/password-hash.js';
import { createManagedCredentialProvider, createStaticCredentialProvider } from '../src/auth/credential-provider.js';
import { createLoginThrottler } from '../src/auth/login-throttle.js';
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
