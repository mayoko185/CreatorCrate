import { verifyPassword } from '../auth/password-hash.js';
import {
  createStaticCredentialProvider,
  normalizeUsername,
  rotateCredentialPassword,
} from '../auth/credential-provider.js';
import { generateSessionToken, hashSessionToken } from '../auth/session-token.js';
import { generateCsrfSecret } from '../middleware/csrf.js';
import { createSessionRepository } from '../data/session-repository.js';

export class AuthError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'AuthError';
  }
}

// Phase 12.1 cleanup addendum — bounded cadence for sweeping expired session
// rows out of the `sessions` table. `getSession` is the production trigger
// (it runs on every request that carries a session cookie, via
// middleware/auth.js's resolveSession); a fixed internal interval keeps that
// sweep to at most once per interval per AuthService instance rather than a
// query on every request. No operator configuration: there is no meaningful
// reason for a single-operator deployment to tune this.
export const SESSION_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Phase 12.1 — single-operator authentication: password verification and
 * server-side session lifecycle. Deliberately narrow: one configured
 * username/password-hash pair, no multi-user model.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} opts.username - already normalized (see config.js)
 * @param {string} opts.passwordHash - encoded scrypt hash (see auth/password-hash.js)
 * @param {string} opts.sessionSecret - HMAC key for session-token hashing
 * @param {number} opts.sessionTtlHours - fixed session lifetime
 * @param {() => number} [opts.now] - injectable clock for the cleanup cadence
 *   gate below (tests only; production always uses the real Date.now).
 */
export function createAuthService({ db, username, passwordHash, credentialProvider, sessionSecret, sessionTtlHours, now = Date.now }) {
  const sessionRepository = createSessionRepository(db);
  const credentials = credentialProvider || createStaticCredentialProvider({ username, passwordHash });

  // 0 means "due immediately" — the first session lookup on a freshly
  // constructed service (including one rebuilt after a live restore, see
  // app-context.js) always runs a sweep rather than waiting a full interval.
  let nextCleanupAt = 0;

  /**
   * Throttled production cleanup trigger. Runs at most once per
   * SESSION_CLEANUP_INTERVAL_MS for this AuthService instance, regardless of
   * how many requests resolve a session inside that window. The next-due
   * timestamp is advanced *before* the delete runs, so a failed sweep still
   * retries only at the next interval rather than on every subsequent
   * request.
   *
   * A sweep failure never surfaces to the caller and never blocks/affects
   * the session lookup that triggered it — expired-session rejection is
   * already enforced independently by the per-row expiry check in
   * `getSession`. Errors are swallowed rather than logged to avoid ever
   * emitting raw SQLite errors (which can include the database path).
   */
  function maybeCleanupExpiredSessions() {
    const t = now();
    if (t < nextCleanupAt) return;
    nextCleanupAt = t + SESSION_CLEANUP_INTERVAL_MS;
    try {
      sessionRepository.deleteExpired(new Date(t).toISOString());
    } catch {
      // Best-effort: retried automatically at the next due interval.
    }
  }

  /**
   * Runs the password hash check unconditionally — even when the username
   * does not match — so response timing never reveals which of the two
   * fields was wrong.
   */
  function verifyCredentials(candidateUsername, candidatePassword) {
    const credential = credentials.getCredential();
    const usernameMatches = normalizeUsername(candidateUsername) === credential.username;
    const passwordMatches =
      typeof candidatePassword === 'string' && verifyPassword(candidatePassword, credential.passwordHash);
    return usernameMatches && passwordMatches;
  }

  function createSession() {
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token, sessionSecret);
    const csrfSecret = generateCsrfSecret();
    const nowMs = Date.now();
    const expiresAt = new Date(nowMs + sessionTtlHours * 60 * 60 * 1000).toISOString();

    try {
      sessionRepository.create({
        id: tokenHash,
        username: credentials.getCredential().username,
        csrfSecret,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt,
      });
    } catch (err) {
      throw new AuthError('Failed to create session.', { cause: err });
    }

    return { token, expiresAt };
  }

  // Generic failure: never distinguishes "unknown username" from "wrong
  // password" — both return null.
  function login(candidateUsername, candidatePassword) {
    if (!verifyCredentials(candidateUsername, candidatePassword)) {
      return null;
    }
    return createSession();
  }

  function getSession(token) {
    if (typeof token !== 'string' || token.length === 0) return null;

    maybeCleanupExpiredSessions();

    let row;
    try {
      row = sessionRepository.findById(hashSessionToken(token, sessionSecret));
    } catch (err) {
      throw new AuthError('Failed to look up session.', { cause: err });
    }
    if (!row) return null;

    if (new Date(row.expiresAt).getTime() <= Date.now()) {
      sessionRepository.deleteById(row.id);
      return null;
    }

    return { username: row.username, csrfSecret: row.csrfSecret, expiresAt: row.expiresAt };
  }

  function logout(token) {
    if (typeof token !== 'string' || token.length === 0) return false;
    return sessionRepository.deleteById(hashSessionToken(token, sessionSecret));
  }

  function invalidateAllSessions() {
    return sessionRepository.deleteAll();
  }

  function rotatePassword({ currentPassword, newPassword, confirmation }) {
    const result = rotateCredentialPassword(credentials, { currentPassword, newPassword, confirmation });
    if (!result.ok) return result;
    invalidateAllSessions();
    return result;
  }

  function cleanupExpiredSessions() {
    return sessionRepository.deleteExpired(new Date().toISOString());
  }

  return {
    verifyCredentials,
    login,
    createSession,
    getSession,
    logout,
    invalidateAllSessions,
    rotatePassword,
    cleanupExpiredSessions,
  };
}

/**
 * Standalone helper for wiping every session on a database handle that has
 * no constructed AuthService yet — used by the restore workflow, which
 * receives a brand-new `db` connection before the surrounding app (and its
 * auth service) has been rebuilt around it. See settings.js.
 */
export function invalidateAllSessionsForDb(db) {
  return createSessionRepository(db).deleteAll();
}
