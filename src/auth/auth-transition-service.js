// Phase 13 — the single coordinator for every enable/disable authentication
// transition. Routes and the recovery CLI never touch operator-credential.json
// or auth-enablement.json independently; they always go through here, so the
// staged-write -> invalidate-sessions -> adopt-live-context -> rollback-on-
// failure ordering is enforced in exactly one place.
//
// Ordering discipline (see plan): sessions are invalidated *before* the live
// app context adopts the new auth mode, never after. If adoption then fails,
// the rollback only has to undo cheap file state — the worst outcome is
// "everyone in the previous mode got logged out and can log back in", never
// "auth mode changed but sessions weren't actually revoked".
import fs from 'node:fs';
import {
  credentialFilePathForRoot,
  writeManagedCredential,
  createManagedCredentialProvider,
  validateUsername,
  validateNewPassword,
} from './credential-provider.js';
import { hashPassword } from './password-hash.js';
import {
  readAuthEnablement,
  enableAuthState,
  disableAuthState,
  generateSessionSecret,
  authStateFilePathForRoot,
} from './auth-state.js';
import { invalidateAllSessionsForDb } from '../services/auth-service.js';

function snapshotFile(filePath) {
  try {
    return { existed: true, bytes: fs.readFileSync(filePath) };
  } catch (err) {
    if (err.code === 'ENOENT') return { existed: false, bytes: null };
    throw err;
  }
}

// Rollback-only restore: writes back the exact previous bytes (or removes a
// file that didn't exist before). This intentionally bypasses the atomic
// tmp+rename primitives in auth-state.js/credential-provider.js — those
// govern the primary write path; this only ever runs to undo an already-
// exceptional failure, restoring precisely what was there a moment ago.
function restoreFile(filePath, snapshot) {
  try {
    if (snapshot.existed) {
      fs.writeFileSync(filePath, snapshot.bytes, { mode: 0o600 });
    } else {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Best-effort: there is nothing safer this coordinator can do if the
    // rollback write itself fails.
  }
}

const USERNAME_HELP =
  'Username must be 3-64 characters of lowercase letters, digits, "_", "." or "-", ' +
  'and must not start or end with a separator.';

/**
 * @param {object} opts
 * @param {string} opts.appDataRoot
 * @param {import('better-sqlite3').Database} opts.db - the current live connection
 * @param {(newAuthConfig: object|null) => void} opts.replaceAuthConfig - app-context's
 *   commit-after-verify rebuild hook (throws on failure, never partially applies)
 * @param {object} opts.authSettings - config.auth: sessionTtlHours/cookieSecure/
 *   trustProxy/hstsEnabled/managedCredentialPath, always present regardless of
 *   whether auth is currently enabled
 * @param {string} [opts.csrfPepper] - fallback pepper if somehow not yet on disk
 *   (defensive only — ensureAuthEnablement at startup normally guarantees one)
 * @param {ReturnType<import('../services/auth-service.js').createAuthService>} [opts.authService]
 *   the currently-live auth service, required for `disable()`'s password check;
 *   null/undefined while auth is disabled
 */
export function createAuthTransitionService({
  appDataRoot, db, replaceAuthConfig, assertNoActiveProcessingJobs, authSettings, csrfPepper, authService,
}) {
  let busy = false;

  function refuseWhenProcessingJobsAreActive() {
    try {
      assertNoActiveProcessingJobs?.();
      return null;
    } catch (error) {
      return { ok: false, conflict: true, error };
    }
  }

  function withLock(fn) {
    if (busy) return { ok: false, conflict: true };
    busy = true;
    try {
      return fn();
    } finally {
      busy = false;
    }
  }

  function enable({ username, password, confirmation }) {
    return withLock(() => {
      const errors = [];
      if (!validateUsername(username)) {
        errors.push(USERNAME_HELP);
      }
      errors.push(...validateNewPassword(password, confirmation));
      if (errors.length > 0) {
        return { ok: false, errors };
      }

      let currentState;
      try {
        currentState = readAuthEnablement(appDataRoot);
      } catch (err) {
        return { ok: false, stateReadFailed: true, error: err };
      }
      if (currentState.enabled) {
        return { ok: false, alreadyEnabled: true };
      }

      const processingConflict = refuseWhenProcessingJobsAreActive();
      if (processingConflict) return processingConflict;

      const credentialPath = credentialFilePathForRoot(appDataRoot);
      const authStatePath = authStateFilePathForRoot(appDataRoot);
      const credentialSnapshot = snapshotFile(credentialPath);
      const authStateSnapshot = snapshotFile(authStatePath);

      function rollback() {
        restoreFile(credentialPath, credentialSnapshot);
        restoreFile(authStatePath, authStateSnapshot);
      }

      const passwordHash = hashPassword(password);
      const sessionSecret = generateSessionSecret();
      const pepper = currentState.csrfPepper || csrfPepper || generateSessionSecret();

      try {
        // Always overwrites — never resurrects a stale credential file from
        // a previous enabled period (see writeManagedCredential's contract).
        writeManagedCredential(appDataRoot, { username, passwordHash });
        enableAuthState(appDataRoot, { sessionSecret, csrfPepper: pepper });
      } catch (err) {
        rollback();
        return { ok: false, writeFailed: true, error: err };
      }

      try {
        invalidateAllSessionsForDb(db);
      } catch (err) {
        rollback();
        return { ok: false, sessionInvalidationFailed: true, error: err };
      }

      let credentialProvider;
      try {
        credentialProvider = createManagedCredentialProvider({ appDataRoot });
      } catch (err) {
        rollback();
        return { ok: false, writeFailed: true, error: err };
      }

      try {
        replaceAuthConfig({ ...authSettings, sessionSecret, credentialProvider });
      } catch (err) {
        rollback();
        return { ok: false, rebuildFailed: true, error: err };
      }

      return { ok: true };
    });
  }

  function disable({ username, currentPassword }) {
    return withLock(() => {
      if (!authService) {
        return { ok: false, alreadyDisabled: true };
      }

      let currentState;
      try {
        currentState = readAuthEnablement(appDataRoot);
      } catch (err) {
        return { ok: false, stateReadFailed: true, error: err };
      }
      if (!currentState.enabled) {
        return { ok: false, alreadyDisabled: true };
      }

      if (!authService.verifyCredentials(username, currentPassword)) {
        return { ok: false, currentPasswordError: 'Current password is incorrect.' };
      }

      const processingConflict = refuseWhenProcessingJobsAreActive();
      if (processingConflict) return processingConflict;

      const authStatePath = authStateFilePathForRoot(appDataRoot);
      const authStateSnapshot = snapshotFile(authStatePath);
      const pepper = currentState.csrfPepper || csrfPepper || generateSessionSecret();

      try {
        disableAuthState(appDataRoot, { csrfPepper: pepper });
      } catch (err) {
        return { ok: false, writeFailed: true, error: err };
      }

      try {
        invalidateAllSessionsForDb(db);
      } catch (err) {
        restoreFile(authStatePath, authStateSnapshot);
        return { ok: false, sessionInvalidationFailed: true, error: err };
      }

      try {
        replaceAuthConfig(null);
      } catch (err) {
        restoreFile(authStatePath, authStateSnapshot);
        return { ok: false, rebuildFailed: true, error: err };
      }

      // operator-credential.json is deliberately NOT deleted — it's inert
      // once auth-enablement.json says enabled:false, and a later enable()
      // always overwrites it via writeManagedCredential. See plan §7's
      // credential-file contract.
      return { ok: true };
    });
  }

  return { enable, disable };
}
