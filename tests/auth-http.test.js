/**
 * Phase 12.2 — login/logout UI, route protection, and CSRF protection.
 *
 * Tests authentication HTTP behavior: login page semantics, valid/invalid
 * credentials, session creation, session fixation prevention, logout,
 * protected-route matrix, return-path validation, cookie flags, and
 * no-JavaScript operation.
 */
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
import { AUTH_CONFIG, TEST_PASSWORD, extractCsrfToken, countTotalCsrfInputs } from './helpers/auth.js';
import { createLoginThrottler } from '../src/auth/login-throttle.js';
import { SECURITY_CSP } from '../src/middleware/security-headers.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function countH1(html) {
  return (html.match(/<h1[\s>]/g) || []).length;
}

/**
 * Helper: authenticate through the real login route.
 * GETs /login, extracts CSRF token, POSTs credentials, then
 * GETs an authenticated page to obtain the session CSRF token.
 */
async function loginWithCsrf(app, username = 'admin', password = TEST_PASSWORD) {
  const agent = request.agent(app);
  const loginPage = await agent.get('/login').expect(200);
  const csrfToken = extractCsrfToken(loginPage.text);
  await agent
    .post('/login')
    .type('form')
    .send({ username, password, _csrf: csrfToken })
    .expect(302);
  // Fetch an authenticated page to get the session CSRF token
  const page = await agent.get('/projects').expect(200);
  const sessionCsrf = extractCsrfToken(page.text);
  return { agent, csrfToken: sessionCsrf };
}

describe('isSafeRedirectTarget — Phase 12.2 extensions', () => {
  it.each([
    '/', '/projects', '/releases?status=ready', '/projects/1/assets',
    '/settings', '/settings/backups',
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
    '/projects\t/evil',
    '/projects\n/evil',
    '/\x00evil',
    '/login',
    '/login?next=/projects',
    '/login/',
    '/logout',
    '/logout?foo=bar',
  ])('rejects %s', (target) => {
    expect(isSafeRedirectTarget(target)).toBe(false);
  });
});

describe('authenticated app — login/logout/CSRF/routes', () => {
  let tmpDir;
  let db;
  let app;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-auth-http-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    app = createApp({ appName: 'CreatorCrate', db }, { authConfig: AUTH_CONFIG });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Login page semantics ──────────────────────────────────────────────

  describe('GET /login', () => {
    it('renders the login page with exactly one <h1>', async () => {
      const res = await request(app).get('/login').expect(200);
      expect(countH1(res.text)).toBe(1);
      expect(res.text).toContain('<title>CreatorCrate — Log in</title>');
      expect(res.text).toContain('Log in');
    });

    it('includes visible username/password labels with autocomplete attributes', async () => {
      const res = await request(app).get('/login').expect(200);
      expect(res.text).toMatch(/<label[^>]*for="username"/);
      expect(res.text).toMatch(/autocomplete="username"/);
      expect(res.text).toMatch(/<label[^>]*for="password"/);
      expect(res.text).toMatch(/autocomplete="current-password"/);
    });

    it('includes a CSRF token in the form', async () => {
      const res = await request(app).get('/login').expect(200);
      expect(res.text).toMatch(/<input[^>]+name="_csrf"[^>]+value="[^"]+"/);
    });

    it('includes exactly one CSRF input', async () => {
      const res = await request(app).get('/login').expect(200);
      expect(countTotalCsrfInputs(res.text)).toBe(1);
    });

    it('sets a pre-authentication CSRF cookie', async () => {
      const res = await request(app).get('/login').expect(200);
      const cookie = res.headers['set-cookie'].find((c) => c.startsWith('cc_csrf='));
      expect(cookie).toBeDefined();
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
    });

    it('never retains the password in the rendered form', async () => {
      const res = await request(app).get('/login').expect(200);
      expect(res.text).not.toMatch(/type="password"[^>]*value="[^"]+"/);
    });

    it('has no sidebar navigation (login page is isolated)', async () => {
      const res = await request(app).get('/login').expect(200);
      expect(res.text).not.toMatch(/class="app-sidebar"/);
    });

    it('has no logout form on the login page', async () => {
      const res = await request(app).get('/login').expect(200);
      expect(res.text).not.toContain('action="/logout"');
    });

    it('redirects to / if already authenticated', async () => {
      const { agent } = await loginWithCsrf(app);
      const res = await agent.get('/login').expect(302);
      expect(res.headers.location).toBe('/');
    });
  });

  // ─── Login POST ────────────────────────────────────────────────────────

  describe('POST /login', () => {
    it('logs in with correct credentials and redirects to /', async () => {
      const { agent, csrfToken } = await loginWithCsrf(app);
      // The login already succeeded (302 redirect)
      // Verify access to a protected page
      await agent.get('/projects').expect(200);
    });

    it('sets a session cookie on successful login', async () => {
      const agent = request.agent(app);
      const loginPage = await agent.get('/login').expect(200);
      const csrfToken = extractCsrfToken(loginPage.text);
      const res = await agent
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: TEST_PASSWORD, _csrf: csrfToken })
        .expect(302);

      const setCookie = res.headers['set-cookie'];
      const sessionCookie = setCookie.find((c) => c.startsWith('cc_session='));
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie).toMatch(/HttpOnly/i);
      expect(sessionCookie).toMatch(/SameSite=Lax/i);
      expect(sessionCookie).toMatch(/Path=\//i);
    });

    it('rejects incorrect password with a generic message', async () => {
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

    it('rejects unknown username with the same generic message', async () => {
      const agent = request.agent(app);
      const loginPage = await agent.get('/login').expect(200);
      const csrfToken = extractCsrfToken(loginPage.text);
      const res = await agent
        .post('/login')
        .type('form')
        .send({ username: 'nobody', password: TEST_PASSWORD, _csrf: csrfToken })
        .expect(401);
      expect(res.text).toContain('Invalid username or password.');
    });

    it('never reveals which credential failed', async () => {
      const agent1 = request.agent(app);
      const agent2 = request.agent(app);
      const csrf1 = extractCsrfToken((await agent1.get('/login')).text);
      const csrf2 = extractCsrfToken((await agent2.get('/login')).text);
      const wrongUser = await agent1.post('/login').type('form').send({ username: 'nobody', password: TEST_PASSWORD, _csrf: csrf1 }).expect(401);
      const wrongPass = await agent2.post('/login').type('form').send({ username: 'admin', password: 'wrong', _csrf: csrf2 }).expect(401);
      expect(wrongUser.text).toContain('Invalid username or password.');
      expect(wrongPass.text).toContain('Invalid username or password.');
    });

    it('rejects login with missing CSRF token', async () => {
      const agent = request.agent(app);
      await agent.get('/login').expect(200);
      const res = await agent
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: TEST_PASSWORD })
        .expect(403);
      expect(res.text).toContain('Invalid or expired');
    });

    it('rejects login with an invalid CSRF token', async () => {
      const agent = request.agent(app);
      await agent.get('/login').expect(200);
      const res = await agent
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: TEST_PASSWORD, _csrf: 'invalid-token' })
        .expect(403);
      expect(res.text).toContain('Invalid or expired');
    });

    it('honors a safe next redirect target after login', async () => {
      const agent = request.agent(app);
      const loginPage = await agent.get('/login?next=/releases').expect(200);
      const csrfToken = extractCsrfToken(loginPage.text);
      const res = await agent
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: TEST_PASSWORD, _csrf: csrfToken, next: '/releases' })
        .expect(302);
      expect(res.headers.location).toBe('/releases');
    });

    it('rejects an unsafe next redirect target and redirects to /', async () => {
      const agent = request.agent(app);
      const loginPage = await agent.get('/login').expect(200);
      const csrfToken = extractCsrfToken(loginPage.text);
      const res = await agent
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: TEST_PASSWORD, _csrf: csrfToken, next: 'https://evil.com' })
        .expect(302);
      expect(res.headers.location).toBe('/');
    });

    it('rejects a /login return path to prevent loops', async () => {
      const agent = request.agent(app);
      const loginPage = await agent.get('/login').expect(200);
      const csrfToken = extractCsrfToken(loginPage.text);
      const res = await agent
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: TEST_PASSWORD, _csrf: csrfToken, next: '/login' })
        .expect(302);
      expect(res.headers.location).toBe('/');
    });

    it('does not create a session on failed login', async () => {
      const agent = request.agent(app);
      const loginPage = await agent.get('/login').expect(200);
      const csrfToken = extractCsrfToken(loginPage.text);
      await agent
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: 'wrong', _csrf: csrfToken })
        .expect(401);
      await agent.get('/projects').expect(302);
    });

    it('password field is never retained in the re-rendered form on failure', async () => {
      const agent = request.agent(app);
      const loginPage = await agent.get('/login').expect(200);
      const csrfToken = extractCsrfToken(loginPage.text);
      const res = await agent
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: 'wrong', _csrf: csrfToken })
        .expect(401);
      expect(res.text).not.toContain('value="wrong"');
      expect(res.text).not.toContain(`value="${TEST_PASSWORD}"`);
    });
  });

  describe('login throttling', () => {
    it('throttles repeated failed login attempts without creating a permanent lockout', async () => {
      let clock = 10_000;
      const throttledApp = createApp(
        { appName: 'CreatorCrate', db },
        {
          authConfig: AUTH_CONFIG,
          loginThrottler: createLoginThrottler({ now: () => clock, baseDelayMs: 500, maxDelayMs: 500, windowMs: 2000 }),
        }
      );
      const agent = request.agent(throttledApp);
      let page = await agent.get('/login').expect(200);
      await agent
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: 'wrong', _csrf: extractCsrfToken(page.text) })
        .expect(401);

      page = await agent.get('/login').expect(200);
      await agent
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: TEST_PASSWORD, _csrf: extractCsrfToken(page.text) })
        .expect(401);

      clock += 501;
      page = await agent.get('/login').expect(200);
      await agent
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: TEST_PASSWORD, _csrf: extractCsrfToken(page.text) })
        .expect(302);
    });

    it('uses x-forwarded-for only when TRUST_PROXY is enabled', async () => {
      let clock = 20_000;
      const throttler = createLoginThrottler({ now: () => clock, baseDelayMs: 1000, maxDelayMs: 1000 });
      const proxiedApp = createApp(
        { appName: 'CreatorCrate', db },
        { authConfig: { ...AUTH_CONFIG, trustProxy: true }, loginThrottler: throttler }
      );
      const first = request.agent(proxiedApp);
      let page = await first.get('/login').set('X-Forwarded-For', '203.0.113.10').expect(200);
      await first.post('/login').set('X-Forwarded-For', '203.0.113.10').type('form').send({ username: 'admin', password: 'wrong', _csrf: extractCsrfToken(page.text) }).expect(401);

      const second = request.agent(proxiedApp);
      page = await second.get('/login').set('X-Forwarded-For', '203.0.113.11').expect(200);
      await second.post('/login').set('X-Forwarded-For', '203.0.113.11').type('form').send({ username: 'admin', password: TEST_PASSWORD, _csrf: extractCsrfToken(page.text) }).expect(302);
    });
  });

  // ─── Logout ────────────────────────────────────────────────────────────

  describe('POST /logout', () => {
    it('logs out and redirects to /login', async () => {
      const { agent, csrfToken } = await loginWithCsrf(app);
      const res = await agent
        .post('/logout')
        .type('form')
        .send({ _csrf: csrfToken })
        .expect(302);
      expect(res.headers.location).toBe('/login');
    });

    it('clears the session cookie', async () => {
      const { agent, csrfToken } = await loginWithCsrf(app);
      const res = await agent
        .post('/logout')
        .type('form')
        .send({ _csrf: csrfToken })
        .expect(302);
      const cookie = res.headers['set-cookie'].find((c) => c.startsWith('cc_session='));
      expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/i);
    });

    it('requires a valid CSRF token for logout', async () => {
      const { agent } = await loginWithCsrf(app);
      const res = await agent.post('/logout').type('form').send({});
      expect(res.status).toBe(403);
    });

    it('clears a stale cookie safely (idempotent)', async () => {
      const agent = request.agent(app);
      agent.jar.setCookie('cc_session=not-a-real-token; Path=/');
      const res = await agent.post('/logout').type('form').send({});
      // Unauthenticated POST gets 401 from CSRF middleware (defense in depth)
      expect(res.status).toBe(401);
    });
  });

  describe('GET /logout (must not exist)', () => {
    it('does not provide a GET logout route', async () => {
      const { agent } = await loginWithCsrf(app);
      await agent.get('/logout').expect(404);
    });
  });

  // ─── Route protection matrix ───────────────────────────────────────────

  describe('route protection matrix', () => {
    it('redirects unauthenticated browser GET to /login with next path', async () => {
      const res = await request(app).get('/projects').expect(302);
      expect(res.headers.location).toBe('/login?next=%2Fprojects');
    });

    it('redirects unauthenticated browser GET for settings', async () => {
      const res = await request(app).get('/settings/backups').expect(302);
      expect(res.headers.location).toBe('/login?next=%2Fsettings%2Fbackups');
    });

    it('rejects unauthenticated POST with 401 JSON', async () => {
      const res = await request(app)
        .post('/projects')
        .type('form')
        .send({ title: 'Test' })
        .expect(401);
      expect(res.body).toEqual({ status: 'error', message: 'Authentication required.' });
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

    it('protects the dashboard', async () => {
      await request(app).get('/').expect(302);
    });

    it('protects project creation', async () => {
      await request(app).post('/projects').type('form').send({ title: 'x' }).expect(401);
    });

    it('protects backup creation', async () => {
      await request(app).post('/settings/backups').type('form').send({}).expect(401);
    });

    it('grants access after authentication', async () => {
      const { agent } = await loginWithCsrf(app);
      await agent.get('/').expect(200);
      await agent.get('/projects').expect(200);
      await agent.get('/settings').expect(200);
    });
  });

  // ─── Media protection boundary ──────────────────────────────────────────

  describe('media protection boundary', () => {
    it('redirects unauthenticated media requests to /login', async () => {
      await request(app).get('/projects/1/assets/1/thumbnail').expect(302);
      await request(app).get('/projects/1/assets/1/preview').expect(302);
      await request(app).get('/projects/1/assets/1/original').expect(302);
    });
  });

  // ─── Cookie flags ──────────────────────────────────────────────────────

  describe('cookie flags', () => {
    it('sets HttpOnly, SameSite=Lax, and Path=/ on the session cookie', async () => {
      const agent = request.agent(app);
      const loginPage = await agent.get('/login').expect(200);
      const csrfToken = extractCsrfToken(loginPage.text);
      const res = await agent
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: TEST_PASSWORD, _csrf: csrfToken })
        .expect(302);

      const sessionCookie = res.headers['set-cookie'].find((c) => c.startsWith('cc_session='));
      expect(sessionCookie).toMatch(/HttpOnly/i);
      expect(sessionCookie).toMatch(/SameSite=Lax/i);
      expect(sessionCookie).toMatch(/Path=\//i);
    });

    it('does not set Secure flag when cookieSecure is false', async () => {
      const agent = request.agent(app);
      const loginPage = await agent.get('/login').expect(200);
      const csrfToken = extractCsrfToken(loginPage.text);
      const res = await agent
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: TEST_PASSWORD, _csrf: csrfToken })
        .expect(302);

      const sessionCookie = res.headers['set-cookie'].find((c) => c.startsWith('cc_session='));
      expect(sessionCookie).not.toMatch(/Secure/i);
    });

    it('sets Secure flag when cookieSecure is true', async () => {
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
        .send({ username: 'admin', password: TEST_PASSWORD, _csrf: csrfToken })
        .expect(302);

      const sessionCookie = res.headers['set-cookie'].find((c) => c.startsWith('cc_session='));
      expect(sessionCookie).toMatch(/Secure/i);
    });
  });

  describe('security and cache headers', () => {
    it('sets strict security headers and CSP on HTML responses without HSTS by default', async () => {
      const res = await request(app).get('/login').expect(200);
      expect(res.headers['content-security-policy']).toBe(SECURITY_CSP);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('same-origin');
      expect(res.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(res.headers['strict-transport-security']).toBeUndefined();
    });

    it('sets HSTS only when explicitly configured', async () => {
      const hstsApp = createApp({ appName: 'CreatorCrate', db }, { authConfig: { ...AUTH_CONFIG, hstsEnabled: true } });
      const res = await request(hstsApp).get('/login').expect(200);
      expect(res.headers['strict-transport-security']).toBe('max-age=15552000; includeSubDomains');
    });

    it('marks login and authenticated HTML no-store while keeping static assets cacheable by static middleware', async () => {
      const login = await request(app).get('/login').expect(200);
      expect(login.headers['cache-control']).toBe('private, no-store');
      const failed = await request(app).post('/login').type('form').send({ username: 'admin', password: 'wrong' }).expect(403);
      expect(failed.headers['cache-control']).toBe('private, no-store');
      const { agent } = await loginWithCsrf(app);
      const projects = await agent.get('/projects').expect(200);
      expect(projects.headers['cache-control']).toBe('private, no-store');
      const security = await agent.get('/settings/security').expect(200);
      expect(security.headers['cache-control']).toBe('private, no-store');
      const js = await request(app).get('/creatorcrate.js').expect(200);
      expect(js.headers['cache-control']).not.toBe('private, no-store');
    });
  });

  // ─── Shell integration ─────────────────────────────────────────────────

  describe('authenticated shell', () => {
    it('shows the operator identity in the sidebar', async () => {
      const { agent } = await loginWithCsrf(app);
      const res = await agent.get('/projects').expect(200);
      expect(res.text).toContain('admin');
    });

    it('contains a logout form with a CSRF field', async () => {
      const { agent } = await loginWithCsrf(app);
      const res = await agent.get('/projects').expect(200);
      expect(res.text).toContain('action="/logout"');
      expect(countTotalCsrfInputs(res.text)).toBeGreaterThanOrEqual(1);
    });

    it('authenticated pages have exactly one <h1>', async () => {
      const { agent } = await loginWithCsrf(app);
      const res = await agent.get('/projects').expect(200);
      expect(countH1(res.text)).toBe(1);
    });
  });

  // ─── No-JavaScript forms ───────────────────────────────────────────────

  describe('no-JavaScript operation', () => {
    it('login form works without JavaScript (standard HTML form)', async () => {
      const res = await request(app).get('/login').expect(200);
      expect(res.text).toMatch(/<form[^>]+method="post"[^>]+action="\/login"/);
      expect(res.text).not.toContain('javascript:');
    });
  });

  // ─── Session fixation prevention ───────────────────────────────────────

  describe('session fixation prevention', () => {
    it('creates a fresh session on login (pre-auth cookie is separate)', async () => {
      const agent = request.agent(app);
      const loginPage = await agent.get('/login').expect(200);
      const csrfToken = extractCsrfToken(loginPage.text);
      const res = await agent
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: TEST_PASSWORD, _csrf: csrfToken })
        .expect(302);

      const sessionCookie = res.headers['set-cookie'].find((c) => c.startsWith('cc_session='));
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie).toMatch(/HttpOnly/i);
    });
  });

  // ─── Secrets not leaked ──────────────────────────────────────────────

  describe('secret leak prevention', () => {
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
});

describe('unauthenticated app (no authConfig) — backward compatibility', () => {
  let tmpDir;
  let db;
  let app;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-noauth-12b-'));
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
