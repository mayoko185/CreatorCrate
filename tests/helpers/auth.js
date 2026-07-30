/**
 * Phase 12.2 — shared test helpers for authentication and CSRF.
 *
 * These helpers authenticate through the real login route, extract CSRF tokens
 * from rendered HTML, and preserve cookie jars — never bypassing production
 * security. Integration tests use them; unit tests targeting session internals
 * may inject directly.
 */
import request from 'supertest';
import { hashPassword } from '../../src/auth/password-hash.js';
import { ensureAuthEnablement } from '../../src/auth/auth-state.js';
import { deriveDisabledModeCsrfToken } from '../../src/middleware/csrf.js';

const TEST_PASSWORD = 'CorrectHorseBatteryStaple';
const TEST_USERNAME = 'admin';

export const AUTH_CONFIG = {
  username: TEST_USERNAME,
  passwordHash: hashPassword(TEST_PASSWORD),
  sessionSecret: 'a'.repeat(32),
  sessionTtlHours: 24,
  cookieSecure: false,
};

export { TEST_PASSWORD, TEST_USERNAME };

/**
 * Extract the CSRF token value from a rendered HTML page.
 * Looks for `<input type="hidden" name="_csrf" value="...">`.
 */
export function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  if (!match) {
    const match2 = html.match(/value="([^"]+)"[^>]+name="_csrf"/);
    if (!match2) {
      throw new Error('Could not extract CSRF token from HTML. Page may not contain a form with _csrf.');
    }
    return match2[1];
  }
  return match[1];
}

/**
 * Extract the anonymous CSRF cookie value from Set-Cookie headers.
 */
export function extractAnonCsrfCookie(setCookieHeaders) {
  if (!setCookieHeaders) return null;
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const header of headers) {
    if (header.startsWith('cc_csrf=')) {
      const value = header.split(';')[0].split('=')[1];
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

/**
 * Request the login page, extract its CSRF token and anonymous CSRF cookie.
 * Returns { agent, csrfToken }.
 */
export async function requestLoginPage(app) {
  const agent = request.agent(app);
  const res = await agent.get('/login').expect(200);
  const csrfToken = extractCsrfToken(res.text);
  return { agent, csrfToken };
}

/**
 * Authenticate through the real login route.
 * Returns an authenticated supertest agent with a valid session cookie
 * and the current CSRF token available from the session.
 *
 * Usage:
 *   const { agent, csrfToken } = await authenticate(app);
 *   // agent now has a valid session cookie
 *   // csrfToken can be used in form submissions
 */
export async function authenticate(app, username = TEST_USERNAME, password = TEST_PASSWORD) {
  const agent = request.agent(app);
  const loginPage = await agent.get('/login').expect(200);
  const csrfToken = extractCsrfToken(loginPage.text);

  await agent
    .post('/login')
    .type('form')
    .send({ username, password, _csrf: csrfToken })
    .expect(302);

  // After successful login, fetch any authenticated page that has a form to
  // get a fresh CSRF token from the session. Use /projects/new as it always
  // renders a form with a CSRF field.
  const pageRes = await agent.get('/projects/new').expect(200);
  const authenticatedCsrf = extractCsrfToken(pageRes.text);
  return { agent, csrfToken: authenticatedCsrf };
}

/**
 * Authenticate and submit a form with a valid CSRF token.
 * The agent is already authenticated; the csrfToken comes from the session.
 */
export async function submitAuthenticatedForm(agent, csrfToken, method, path, fields = {}) {
  return agent[method](path)
    .type('form')
    .send({ ...fields, _csrf: csrfToken });
}

/**
 * Phase 13 — disabled-mode CSRF (no authConfig / no session at all). Any
 * response sets the anonymous `cc_csrf_anon` cookie (see
 * middleware/csrf.js's createDisabledModeCsrfMiddleware); the expected token
 * is computed independently from that cookie value and the same
 * `csrfPepper` the app was built with — this does NOT depend on any page
 * happening to render a form field, unlike the authenticated-session helpers
 * above.
 *
 * Requires the app to have been created with
 * `{ appDataRoot, authState: { csrfPepper } }` in its opts (same
 * `appDataRoot` passed here), matching how server.js wires it in production.
 *
 * Usage:
 *   const { agent, csrfToken } = await getDisabledModeCsrf(app, appDataRoot);
 *   await agent.post('/projects').type('form').send({ ..., _csrf: csrfToken });
 */
export async function getDisabledModeCsrf(app, appDataRoot, path = '/health') {
  const agent = request.agent(app);
  const res = await agent.get(path);
  const setCookie = res.headers['set-cookie'] || [];
  const cookieHeader = setCookie.find((c) => c.startsWith('cc_csrf_anon='));
  if (!cookieHeader) {
    throw new Error(`No cc_csrf_anon cookie was set by GET ${path}. Did createApp get authState.csrfPepper?`);
  }
  const rawSecret = cookieHeader.split(';')[0].split('=')[1];
  const cookieSecret = decodeURIComponent(rawSecret);
  const { csrfPepper } = ensureAuthEnablement(appDataRoot);
  const csrfToken = deriveDisabledModeCsrfToken(csrfPepper, cookieSecret);
  return { agent, csrfToken };
}

/**
 * Count the number of _csrf hidden inputs in rendered HTML.
 * Used to verify exactly one CSRF token per form.
 */
export function countCsrfInputs(html) {
  return (html.match(/<input[^>]+name="_csrf"[^>]*>/g) || []).length;
}

/**
 * Count total _csrf inputs across all forms in the page.
 */
export function countTotalCsrfInputs(html) {
  return (html.match(/name="_csrf"/g) || []).length;
}