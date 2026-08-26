import express from 'express';
import {
  isSafeRedirectTarget,
  getSessionToken,
  setSessionCookie,
  clearSessionCookie,
} from '../middleware/auth.js';
import {
  generateAnonCsrf,
  verifyAnonCsrf,
  getAnonCsrfSecret,
  setAnonCsrfCookie,
  clearAnonCsrfCookie,
} from '../middleware/csrf.js';
import { getClientAddress } from '../auth/login-throttle.js';

/**
 * Validate a next path for safe redirect after login.
 *
 * Accepts local application paths (starting with /) but rejects:
 *   - /login and /logout (would create loops)
 *   - protocol-relative URLs, absolute URLs, backslash variants,
 *     and control characters
 *
 * Exported for testing.
 */
export function isSafeReturnPath(target) {
  if (!isSafeRedirectTarget(target)) return false;
  if (target === '/login' || target.startsWith('/login?') || target === '/logout' || target.startsWith('/logout?')) return false;
  return true;
}

function sanitizeNext(value) {
  return typeof value === 'string' && isSafeReturnPath(value) ? value : '';
}

const LOGIN_NOTICES = {
  password_rotated: { variant: 'success', text: 'Password changed. Sign in again with the new password.' },
  authentication_enabled: { variant: 'success', text: 'Authentication has been enabled. Sign in to continue.' },
};

function resolveLoginNotice(code) {
  return Object.prototype.hasOwnProperty.call(LOGIN_NOTICES, code) ? LOGIN_NOTICES[code] : null;
}

/**
 * Phase 12.2 — login/logout routes with CSRF protection.
 *
 * @param {object} opts
 * @param {string} opts.appName
 * @param {ReturnType<import('../services/auth-service.js').createAuthService>} opts.authService
 * @param {{name: string, path: string, secure: boolean, maxAgeMs: number}} opts.cookieOptions
 */
export function createAuthRouter({
  appName,
  authService,
  cookieOptions,
  loginThrottler,
  trustProxy = false,
  applicationLogger = null,
}) {
  const router = express.Router();

  function logAuth(level, event, kind) {
    try {
      applicationLogger?.[level]?.({
        event,
        kind,
        subsystem: 'authentication',
        message: 'Authentication outcome recorded.',
      });
    } catch {
      // Audit persistence must never alter authentication behavior.
    }
  }

  // GET /login — render login form with anonymous CSRF token
  router.get('/login', (req, res) => {
    if (res.locals.auth && res.locals.auth.authenticated) {
      return res.redirect('/');
    }

    const { secret, token } = generateAnonCsrf();
    setAnonCsrfCookie(res, secret, cookieOptions);

    const nextPath = sanitizeNext(req.query.next);
    res.render('login.njk', { appName, error: null, notice: resolveLoginNotice(req.query.notice), next: nextPath, _csrf: token });
  });

  // POST /login — verify credentials + anonymous CSRF, create session
  router.post('/login', (req, res) => {
    const body = req.body || {};
    const { username, password } = body;
    const nextPath = sanitizeNext(body.next);

    // Verify anonymous CSRF token before processing credentials
    const anonSecret = getAnonCsrfSecret(req);
    const submittedCsrf = body._csrf;
    if (!anonSecret || !submittedCsrf || !verifyAnonCsrf(submittedCsrf, anonSecret)) {
      // Regenerate anonymous CSRF for the re-rendered form
      const { secret, token } = generateAnonCsrf();
      setAnonCsrfCookie(res, secret, cookieOptions);
      res.status(403);
      res.render('login.njk', { appName, error: 'Invalid or expired form submission. Please try again.', notice: null, next: nextPath, _csrf: token });
      return;
    }

    const clientAddress = getClientAddress(req, { trustProxy });
    const throttle = loginThrottler?.check(username, clientAddress) || { limited: false };
    const result =
      !throttle.limited && typeof username === 'string' && typeof password === 'string'
        ? authService.login(username, password)
        : null;

    if (!result) {
      if (!throttle.limited && loginThrottler) {
        loginThrottler.recordFailure(username, clientAddress);
      }
      logAuth('warn', throttle.limited ? 'auth.login.throttled' : 'auth.login.failed', 'diagnostic');
      // Regenerate anonymous CSRF for the re-rendered form
      const { secret, token } = generateAnonCsrf();
      setAnonCsrfCookie(res, secret, cookieOptions);
      // Retain normalized username but never the password
      const retainedUsername = typeof username === 'string' ? username.trim().toLowerCase() : '';
      res.status(401);
      res.render('login.njk', { appName, error: 'Invalid username or password.', notice: null, next: nextPath, _csrf: token, retainedUsername });
      return;
    }

    loginThrottler?.recordSuccess(username, clientAddress);
    // Clear anonymous CSRF cookie now that login succeeded
    clearAnonCsrfCookie(res, cookieOptions);
    setSessionCookie(res, result.token, cookieOptions);
    logAuth('info', 'auth.login.succeeded', 'activity');
    res.redirect(nextPath || '/');
  });

  // POST /logout — revoke session, clear cookie, redirect to login
  router.post('/logout', (req, res) => {
    const token = getSessionToken(req, cookieOptions);
    const loggedOut = token ? authService.logout(token) : false;
    clearSessionCookie(res, cookieOptions);
    if (loggedOut) logAuth('info', 'auth.logout', 'activity');
    res.redirect('/login');
  });

  return router;
}
