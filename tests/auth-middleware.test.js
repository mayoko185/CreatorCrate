import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { hashPassword } from '../src/auth/password-hash.js';
import { isExemptPath, isSafeRedirectTarget } from '../src/middleware/auth.js';
import { extractCsrfToken } from './helpers/auth.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Helper: GET /login, extract the pre-auth CSRF token and cookie,
 * then POST /login with valid credentials and the CSRF token.
 * Returns the authenticated agent.
 */
async function loginWithCsrf(app, username, password) {
  const agent = request.agent(app);
  // GET /login to obtain the pre-auth CSRF token and cookie
  const loginPage = await agent.get('/login').expect(200);
  const csrfToken = extractCsrfToken(loginPage.text);

  // POST /login with the CSRF token (supertest agent preserves cookies)
  const loginRes = await agent
    .post('/login')
    .type('form')
    .send({ username, password, _csrf: csrfToken })
    .expect(302);

  return agent;
}

describe('isExemptPath', () => {
  it.each(['/health', '/health/', '/login', '/login/', '/logout'])('exempts %s', (p) => {
    expect(isExemptPath(p)).toBe(true);
  });

  it.each(['/', '/projects', '/settings/backups', '/healthy', '/loginish'])('does not exempt %s', (p) => {
    expect(isExemptPath(p)).toBe(false);
  });
});

describe('isSafeRedirectTarget', () => {
  it.each([
    '/',
    '/projects',
    '/releases?status=ready',
    '/projects/1/assets',
    '/projects/1/assets?view=grid&page=2',
    '/settings/backups',
  ])('accepts %s', (target) => {
    expect(isSafeRedirectTarget(target)).toBe(true);
  });

  it.each([
    '//evil.com',
    'https://evil.com',
    'http://evil.com/path',
    'javascript:alert(1)',
    '\\\\evil.com',
    'evil.com',
    '',
    null,
    undefined,
    42,
  ])('rejects %s', (target) => {
    expect(isSafeRedirectTarget(target)).toBe(false);
  });

  // Phase 12.3: backslash/slash obfuscation must be rejected at every
  // bounded decoding level (literal, single-encoded, uppercase-encoded,
  // and double-encoded), not just in the raw target string.
  it.each([
    ['literal backslash', '/\\evil.test'],
    ['lowercase-encoded backslash', '/%5cevil.test'],
    ['uppercase-encoded backslash', '/%5Cevil.test'],
    ['double lowercase-encoded backslash', '/%255cevil.test'],
    ['double uppercase-encoded backslash', '/%255Cevil.test'],
    ['literal protocol-relative', '//evil.test'],
    ['encoded protocol-relative', '/%2f%2fevil.test'],
    ['double-encoded protocol-relative', '/%252f%252fevil.test'],
    ['malformed percent encoding', '/%zzevil.test'],
  ])('rejects %s (%s)', (_label, target) => {
    expect(isSafeRedirectTarget(target)).toBe(false);
  });
});

describe('authenticated app integration', () => {
  let tmpDir;
  let db;
  let app;
  const PASSWORD = 'CorrectHorseBatteryStaple';
  const AUTH_CONFIG = {
    username: 'admin',
    passwordHash: hashPassword(PASSWORD),
    sessionSecret: 'a'.repeat(32),
    sessionTtlHours: 24,
    cookieSecure: false,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-auth-mw-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: 'CreatorCrate', db }, { authConfig: AUTH_CONFIG });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function loginAgent() {
    return loginWithCsrf(app, 'admin', PASSWORD);
  }

  it('redirects an unauthenticated browser GET to /login with a safe return path', async () => {
    const res = await request(app).get('/projects').expect(302);
    expect(res.headers.location).toBe('/login?next=%2Fprojects');
  });

  it('redirects an unauthenticated browser GET to /login without return path for root', async () => {
    const res = await request(app).get('/').expect(302);
    expect(res.headers.location).toBe('/login?next=%2F');
  });

  it('rejects an unauthenticated mutating POST with 401 JSON and performs no mutation', async () => {
    const res = await request(app)
      .post('/projects')
      .type('form')
      .send({ title: 'Should not be created', status: 'tbd', priority: 'normal' })
      .expect(401);
    expect(res.body).toEqual({ status: 'error', message: 'Authentication required.' });
    expect(db.prepare('SELECT COUNT(*) AS c FROM projects').get().c).toBe(0);
  });

  it('leaves /health reachable without authentication', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', database: 'ok' });
  });

  it('leaves /login reachable without authentication', async () => {
    const res = await request(app).get('/login').expect(200);
    expect(res.text).toContain('Log in');
  });

  it('leaves static assets reachable without authentication', async () => {
    await request(app).get('/creatorcrate.js').expect(200);
  });

  it('rejects login with an incorrect password using one generic message', async () => {
    const agent = request.agent(app);
    const loginPage = await agent.get('/login').expect(200);
    const csrfToken = extractCsrfToken(loginPage.text);
    const res = await agent
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: 'wrong', _csrf: csrfToken })
      .expect(401);
    expect(res.text).toContain('Invalid username or password.');
  });

  it('rejects login with an unknown username using the same generic message', async () => {
    const agent = request.agent(app);
    const loginPage = await agent.get('/login').expect(200);
    const csrfToken = extractCsrfToken(loginPage.text);
    const res = await agent
      .post('/login')
      .type('form')
      .send({ username: 'nobody', password: PASSWORD, _csrf: csrfToken })
      .expect(401);
    expect(res.text).toContain('Invalid username or password.');
  });

  it('logs in, sets a session cookie with the required attributes, and grants access', async () => {
    const agent = request.agent(app);
    const loginPage = await agent.get('/login').expect(200);
    const csrfToken = extractCsrfToken(loginPage.text);
    const res = await agent
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: PASSWORD, _csrf: csrfToken })
      .expect(302);

    expect(res.headers.location).toBe('/');
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookie = setCookie.find((c) => c.startsWith('cc_session='));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).not.toMatch(/Secure/i);

    // The anonymous CSRF cookie should be cleared after successful login
    const csrfCookie = setCookie.find((c) => c.startsWith('cc_csrf='));
    if (csrfCookie) {
      expect(csrfCookie).toMatch(/Expires=Thu, 01 Jan 1970/i);
    }

    // Agent should now have access
    await agent.get('/projects').expect(200);
  });

  it('sets the Secure cookie attribute when cookieSecure is true', async () => {
    const secureApp = createApp(
      { appName: 'CreatorCrate', db },
      { authConfig: { ...AUTH_CONFIG, cookieSecure: true } }
    );
    const agent = request.agent(secureApp);
    const loginPage = await agent.get('/login').expect(200);
    const csrfToken = extractCsrfToken(loginPage.text);
    const res = await agent
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: PASSWORD, _csrf: csrfToken })
      .expect(302);
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('cc_session='));
    expect(cookie).toMatch(/Secure/i);
  });

  it('honors a safe next redirect target after login', async () => {
    const agent = request.agent(app);
    const loginPage = await agent.get('/login?next=/releases').expect(200);
    const csrfToken = extractCsrfToken(loginPage.text);
    const res = await agent
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: PASSWORD, _csrf: csrfToken, next: '/releases' })
      .expect(302);
    expect(res.headers.location).toBe('/releases');
  });

  it('ignores an unsafe next redirect target after login (open-redirect rejection)', async () => {
    const agent = request.agent(app);
    const loginPage = await agent.get('/login').expect(200);
    const csrfToken = extractCsrfToken(loginPage.text);
    const res = await agent
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: PASSWORD, _csrf: csrfToken, next: 'https://evil.com' })
      .expect(302);
    expect(res.headers.location).toBe('/');
  });

  it('allows access to protected pages after login and blocks again after logout', async () => {
    const agent = await loginAgent();
    await agent.get('/projects').expect(200);

    // Get a CSRF token from an authenticated page for the logout form
    const page = await agent.get('/projects').expect(200);
    const logoutCsrf = extractCsrfToken(page.text);
    await agent.post('/logout').type('form').send({ _csrf: logoutCsrf }).expect(302);
    await agent.get('/projects').expect(302);
  });

  it('logout clears the session cookie', async () => {
    const agent = await loginAgent();
    const page = await agent.get('/projects').expect(200);
    const logoutCsrf = extractCsrfToken(page.text);
    const res = await agent.post('/logout').type('form').send({ _csrf: logoutCsrf }).expect(302);
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('cc_session='));
    expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/i);
  });

  it('clears an invalid/expired cookie instead of trusting it', async () => {
    const agent = request.agent(app);
    agent.jar.setCookie('cc_session=not-a-real-token; Path=/');

    const res = await agent.get('/projects').expect(302);
    const clearing = res.headers['set-cookie'].find((c) => c.startsWith('cc_session='));
    expect(clearing).toMatch(/Expires=Thu, 01 Jan 1970/i);
  });

  it('does not leak the session secret or password hash in a rendered error page', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.text).not.toContain(AUTH_CONFIG.sessionSecret);
    expect(res.text).not.toContain(AUTH_CONFIG.passwordHash);
  });

  it('does not leak secrets in the health response', async () => {
    const res = await request(app).get('/health');
    expect(JSON.stringify(res.body)).not.toContain(AUTH_CONFIG.sessionSecret);
    expect(JSON.stringify(res.body)).not.toContain(AUTH_CONFIG.passwordHash);
  });
});

describe('unauthenticated app (no authConfig) — Phase 12.1 backward compatibility', () => {
  let tmpDir;
  let db;
  let app;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-noauth-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: 'CreatorCrate', db });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves protected pages with no login wall when authConfig is omitted', async () => {
    await request(app).get('/').expect(200);
    await request(app).get('/projects').expect(200);
  });

  it('sets no session cookie', async () => {
    const res = await request(app).get('/');
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
