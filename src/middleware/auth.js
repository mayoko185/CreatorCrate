// Phase 12.1 — request-level session resolution and route protection.
//
// Exempt paths never require authentication: health checks, the login/logout
// primitives themselves, and static assets (already served and terminated by
// express.static earlier in the middleware chain, so they never reach here).
const EXEMPT_PREFIXES = ['/health', '/login', '/logout'];

export function isExemptPath(pathName) {
  return EXEMPT_PREFIXES.some((prefix) => pathName === prefix || pathName.startsWith(`${prefix}/`));
}

// Only ever redirects to a same-origin, path-absolute location — never a
// scheme-relative ("//evil.com"), absolute-URL ("https://evil.com"), or
// backslash-obfuscated target a browser might still route externally.
// Phase 12.2: also rejects /login and /logout to prevent recursive redirect
// loops, and control characters that could be used in header injection.
const UNSAFE_REDIRECT_PREFIXES = ['/login', '/logout'];

// Phase 12.3: browsers and proxies can normalize percent-encoded (and
// repeatedly percent-encoded) backslashes/slashes before routing a redirect,
// so a target that looks like a safe local path in its raw form can still
// decode into a backslash- or protocol-relative payload. Decode a small
// bounded number of times (never unbounded/recursive) and re-check every
// intermediate value; malformed percent-encoding fails closed.
const MAX_REDIRECT_DECODE_PASSES = 3;

function collectRedirectDecodePasses(target) {
  const passes = [target];
  let current = target;
  for (let i = 0; i < MAX_REDIRECT_DECODE_PASSES; i++) {
    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (decoded === current) break;
    passes.push(decoded);
    current = decoded;
  }
  return passes;
}

export function isSafeRedirectTarget(target) {
  if (typeof target !== 'string' || target.length === 0) return false;
  if (!target.startsWith('/')) return false;
  if (target.startsWith('//')) return false;
  if (target.includes('\\')) return false;
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(target)) return false;
  // Reject control characters (tabs, newlines, null bytes) that could
  // influence header splitting or URL parsing.
  if (/[\x00-\x1f\x7f]/.test(target)) return false;

  // Bounded-decode check: reject a backslash or protocol-relative prefix
  // found at any decoding level, and fail closed on malformed encoding.
  const decodePasses = collectRedirectDecodePasses(target);
  if (!decodePasses) return false;
  for (const pass of decodePasses) {
    if (pass.includes('\\')) return false;
    if (pass.startsWith('//')) return false;
    if (/[\x00-\x1f\x7f]/.test(pass)) return false;
  }

  // Reject paths that would create a redirect loop back to auth pages.
  for (const prefix of UNSAFE_REDIRECT_PREFIXES) {
    if (target === prefix || target.startsWith(prefix + '/') || target.startsWith(prefix + '?')) {
      return false;
    }
  }
  return true;
}

export function parseCookies(header) {
  const result = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    const rawValue = part.slice(idx + 1).trim();
    try {
      result[key] = decodeURIComponent(rawValue);
    } catch {
      result[key] = rawValue;
    }
  }
  return result;
}

export function setSessionCookie(res, token, cookieOptions) {
  res.cookie(cookieOptions.name, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!cookieOptions.secure,
    path: cookieOptions.path,
    maxAge: cookieOptions.maxAgeMs,
  });
}

export function clearSessionCookie(res, cookieOptions) {
  res.clearCookie(cookieOptions.name, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!cookieOptions.secure,
    path: cookieOptions.path,
  });
}

export function getSessionToken(req, cookieOptions) {
  return parseCookies(req.headers.cookie)[cookieOptions.name];
}

/**
 * @param {object} opts
 * @param {ReturnType<import('../services/auth-service.js').createAuthService>} opts.authService
 * @param {{name: string, path: string, secure: boolean, maxAgeMs: number}} opts.cookieOptions
 */
export function createAuthMiddleware({ authService, cookieOptions }) {
  // Resolves the session on every request and exposes safe state via
  // res.locals.auth — never the raw token, never session internals.
  function resolveSession(req, res, next) {
    const token = getSessionToken(req, cookieOptions);
    if (!token) {
      res.locals.auth = { enabled: true, authenticated: false };
      return next();
    }

    const session = authService.getSession(token);
    if (!session) {
      // Covers both "no such session" and "expired" — either way the
      // cookie is stale and should not be sent back by the client again.
      clearSessionCookie(res, cookieOptions);
      res.locals.auth = { enabled: true, authenticated: false };
      return next();
    }

    // Phase 12.2: csrfSecret is exposed to res.locals.auth so the CSRF
    // middleware can derive the per-request token. It must never appear in
    // rendered output — only the derived token (_csrf in res.locals) does.
    res.locals.auth = { enabled: true, authenticated: true, username: session.username, csrfSecret: session.csrfSecret };
    next();
  }

  function requireAuth(req, res, next) {
    if (isExemptPath(req.path)) return next();
    if (res.locals.auth && res.locals.auth.authenticated) return next();

    const wantsHtml = req.method === 'GET' && req.accepts(['html', 'json']) === 'html';
    if (wantsHtml) {
      const nextPath = isSafeRedirectTarget(req.originalUrl) ? req.originalUrl : null;
      const query = nextPath ? `?next=${encodeURIComponent(nextPath)}` : '';
      res.redirect(`/login${query}`);
      return;
    }

    // Mutating requests and API/JSON requests never get an HTML redirect —
    // the mutation is rejected outright, before any handler runs.
    res.status(401).json({ status: 'error', message: 'Authentication required.' });
  }

  return { resolveSession, requireAuth };
}
