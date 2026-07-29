/**
 * Phase 12.2 — session-bound CSRF protection.
 *
 * Design:
 *   - A per-session random CSRF secret is stored in the sessions table.
 *   - The CSRF token is derived from the secret using HMAC-SHA256(secret, "csrf"),
 *     producing one stable token per session.
 *   - Verification uses constant-time comparison (crypto.timingSafeEqual).
 *   - The token is invalidated when the session is revoked (logout, restore,
 *     or natural expiry), because the secret is destroyed with the session row.
 *   - Tokens are never placed in URLs and never logged.
 *
 * Login CSRF:
 *   - A short-lived pre-authentication context is created via an anonymous
 *     cookie (cc_csrf). The cookie holds the secret, and the form token is
 *     derived from it. On POST /login, the cookie secret is read and the
 *     submitted token is verified against it. The cookie is then cleared.
 *   - This prevents cross-site login forgery without exempting the login form.
 *   - The cookie is HttpOnly, SameSite=Lax, scoped to /login, and expires in
 *     5 minutes.
 */
import crypto from 'node:crypto';

const CSRF_PURPOSE = 'csrf';
const ANON_CSRF_PREFIX = 'cc_csrf';
const CSRF_TOKEN_BYTES = 32;

// ─── Core CSRF operations ───────────────────────────────────────────────

/**
 * Derive a CSRF token from a session secret. The token is deterministic
 * for a given secret, so it can be verified without storing it separately.
 *
 * @param {string} secret - Base64url-encoded random bytes from the session row.
 * @returns {string} The CSRF token (hex-encoded HMAC digest).
 */
export function deriveCsrfToken(secret) {
  return crypto.createHmac('sha256', secret).update(CSRF_PURPOSE).digest('hex');
}

/**
 * Verify a submitted CSRF token against the session secret using
 * constant-time comparison.
 *
 * @param {string} token  - The token submitted in the form.
 * @param {string} secret - The session's CSRF secret.
 * @returns {boolean}
 */
export function verifyCsrfToken(token, secret) {
  if (typeof token !== 'string' || typeof secret !== 'string') return false;
  if (token.length === 0 || secret.length === 0) return false;
  const expected = deriveCsrfToken(secret);
  if (token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

/**
 * Generate a new random CSRF secret (base64url-encoded).
 *
 * @returns {string}
 */
export function generateCsrfSecret() {
  return crypto.randomBytes(CSRF_TOKEN_BYTES).toString('base64url');
}

// ─── Anonymous pre-auth CSRF (login form) ──────────────────────────────

/**
 * Generate an anonymous CSRF token/secret pair for the pre-auth login form.
 *
 * @returns {{ secret: string, token: string }}
 */
export function generateAnonCsrf() {
  const secret = generateCsrfSecret();
  const token = deriveCsrfToken(secret);
  return { secret, token };
}

/**
 * Verify an anonymous CSRF token against its secret.
 *
 * @param {string} token
 * @param {string} secret
 * @returns {boolean}
 */
export function verifyAnonCsrf(token, secret) {
  return verifyCsrfToken(token, secret);
}

/**
 * Parse the anonymous CSRF cookie (cc_csrf=<secret>).
 * Returns the secret string or null if missing/malformed.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null}
 */
export function getAnonCsrfSecret(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === ANON_CSRF_PREFIX) {
      const rawValue = part.slice(idx + 1).trim();
      if (rawValue.length === 0) return null;
      try {
        return decodeURIComponent(rawValue);
      } catch {
        return rawValue;
      }
    }
  }
  return null;
}

/**
 * Set the anonymous CSRF cookie on the response. HttpOnly, SameSite=Lax,
 * short maxAge (5 minutes), path=/login only.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {string} secret
 */
export function setAnonCsrfCookie(res, secret) {
  res.cookie(ANON_CSRF_PREFIX, secret, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: false,
    path: '/login',
    maxAge: 5 * 60 * 1000,
  });
}

/**
 * Clear the anonymous CSRF cookie.
 *
 * @param {import('node:http').ServerResponse} res
 */
export function clearAnonCsrfCookie(res) {
  res.clearCookie(ANON_CSRF_PREFIX, { path: '/login' });
}

// ─── Middleware ──────────────────────────────────────────────────────────

/**
 * Create CSRF middleware that:
 * 1. Derives the token from the current session's CSRF secret and exposes
 *    it via res.locals.csrfToken for template rendering.
 * 2. Rejects state-changing requests (POST/PUT/PATCH/DELETE) that lack a
 *    valid _csrf field, unless the request is exempt (login POST verifies
 *    its own anonymous CSRF).
 *
 * @param {object} opts
 * @param {import('../services/auth-service.js').createAuthService} [opts.authService]
 *   Required for authenticated CSRF; null when authConfig is omitted.
 * @param {{name: string, path: string, secure: boolean, maxAgeMs: number}} opts.cookieOptions
 */
export function createCsrfMiddleware({ authService, cookieOptions }) {
  /**
   * Derive and expose the CSRF token for template rendering.
   * For authenticated users: derive from session's csrf_secret column.
   * For unauthenticated users (on /login): use the anonymous CSRF cookie.
   */
  function exposeCsrfToken(req, res, next) {
    const auth = res.locals.auth;
    if (auth && auth.authenticated && auth.csrfSecret) {
      res.locals._csrf = deriveCsrfToken(auth.csrfSecret);
    } else {
      // Anonymous — try the pre-auth CSRF cookie
      const anonSecret = getAnonCsrfSecret(req);
      res.locals._csrf = anonSecret ? deriveCsrfToken(anonSecret) : '';
    }
    next();
  }

  /**
   * Reject state-changing requests without a valid CSRF token.
   * Login POST is exempt — it verifies the anonymous CSRF itself.
   */
  function requireCsrf(req, res, next) {
    // GET/HEAD/OPTIONS are safe methods — no CSRF check.
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    // Exempt login POST: it handles its own anonymous CSRF verification.
    if (req.method === 'POST' && req.path === '/login') {
      return next();
    }

    const auth = res.locals.auth;
    if (!auth || !auth.authenticated || !auth.csrfSecret) {
      // No authenticated session — requireAuth should have caught this, but
      // as a defense-in-depth, reject mutation attempts without auth.
      return res.status(401).json({ status: 'error', message: 'Authentication required.' });
    }

    const submitted = typeof req.body === 'object' && req.body !== null
      ? req.body._csrf
      : undefined;

    if (!verifyCsrfToken(submitted, auth.csrfSecret)) {
      return res.status(403).json({ status: 'error', message: 'Invalid or missing CSRF token.' });
    }

    next();
  }

  return { exposeCsrfToken, requireCsrf };
}