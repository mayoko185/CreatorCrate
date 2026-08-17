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

// ─── Disabled-mode CSRF (Phase 13) ─────────────────────────────────────

/**
 * While authentication is disabled there is no session to bind a CSRF
 * secret to, but mutating requests must still be protected. A plain
 * double-submit cookie (the same random value echoed back as both cookie
 * and form field) isn't quite enough here: whoever holds the cookie would
 * also hold the "secret" used to compute the token, so it adds nothing
 * beyond what a bare cookie already provides. Instead, the per-visitor
 * cookie value is only ever the HMAC *input*; the key is `csrfPepper` — a
 * random value generated once and persisted server-side in
 * auth-enablement.json (see auth-state.js), never sent to any client. A
 * forger who can only set/read cookies can never compute a valid token
 * without also reading APP_DATA_ROOT, and the token stays valid across a
 * restart because the pepper is persisted, not regenerated per-process.
 */
const DISABLED_CSRF_COOKIE = 'cc_csrf_anon';
const DISABLED_CSRF_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Exported for test helpers (tests/helpers/auth.js's getDisabledModeCsrf) —
// lets a test independently compute the expected token from the persisted
// pepper + the issued visitor cookie, without depending on any particular
// page happening to render a form.
export function deriveDisabledModeCsrfToken(csrfPepper, visitorSecret) {
  return crypto.createHmac('sha256', csrfPepper).update(visitorSecret).digest('hex');
}

/**
 * Read the submitted CSRF token from a request. Forms submit it as a
 * `_csrf` body field, but that doesn't work for every mutating request:
 * JSON API bodies with a closed field allowlist (e.g. the processing
 * routes) reject an extra `_csrf` key, and multipart uploads haven't been
 * parsed into req.body yet by the time this middleware runs (it sits
 * before the route handler's own multipart parser). The `X-CSRF-Token`
 * header covers both cases without weakening the check — it still has to
 * match the session-bound token.
 */
function extractSubmittedCsrfToken(req) {
  const fromBody = typeof req.body === 'object' && req.body !== null ? req.body._csrf : undefined;
  if (typeof fromBody === 'string') return fromBody;
  const header = req.headers['x-csrf-token'];
  return typeof header === 'string' ? header : undefined;
}

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) {
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
 * @param {object} opts
 * @param {boolean} opts.cookieSecure
 * @param {string} opts.csrfPepper - persistent, server-only HMAC key (see
 *   above). Required — disabled-mode CSRF cannot function without it.
 */
export function createDisabledModeCsrfMiddleware({ cookieSecure, csrfPepper }) {
  function ensureVisitorCookie(req, res) {
    let secret = getCookie(req, DISABLED_CSRF_COOKIE);
    if (!secret) {
      secret = generateCsrfSecret();
      res.cookie(DISABLED_CSRF_COOKIE, secret, {
        httpOnly: true,
        sameSite: 'lax',
        secure: !!cookieSecure,
        path: '/',
        maxAge: DISABLED_CSRF_COOKIE_MAX_AGE_MS,
      });
    }
    return secret;
  }

  function exposeCsrfToken(req, res, next) {
    const secret = ensureVisitorCookie(req, res);
    res.locals._csrf = deriveDisabledModeCsrfToken(csrfPepper, secret);
    next();
  }

  function requireCsrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    const secret = getCookie(req, DISABLED_CSRF_COOKIE);
    const submitted = extractSubmittedCsrfToken(req);

    if (!secret || typeof submitted !== 'string') {
      return res.status(403).json({ status: 'error', message: 'Invalid or missing CSRF token.' });
    }
    const expected = deriveDisabledModeCsrfToken(csrfPepper, secret);
    if (submitted.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(expected))) {
      return res.status(403).json({ status: 'error', message: 'Invalid or missing CSRF token.' });
    }

    next();
  }

  return { exposeCsrfToken, requireCsrf };
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

    const submitted = extractSubmittedCsrfToken(req);

    if (!verifyCsrfToken(submitted, auth.csrfSecret)) {
      return res.status(403).json({ status: 'error', message: 'Invalid or missing CSRF token.' });
    }

    next();
  }

  return { exposeCsrfToken, requireCsrf };
}