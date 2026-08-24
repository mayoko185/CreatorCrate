/**
 * Phase 13 — deterministic failure-injection tests for the coordinated
 * enable/disable transition service. These are what actually prove the
 * rollback design (staged writes -> invalidate sessions -> adopt live
 * context -> roll back on any failure), not just the happy path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuthTransitionService } from '../src/auth/auth-transition-service.js';
import { readAuthEnablement, ensureAuthEnablement, enableAuthState } from '../src/auth/auth-state.js';
import { credentialFilePathForRoot, createManagedCredentialProvider } from '../src/auth/credential-provider.js';
import * as authServiceModule from '../src/services/auth-service.js';

const USERNAME = 'admin';
const PASSWORD = 'CorrectHorseBatteryStaple';
const OTHER_PASSWORD = 'AnotherStrongPassphrase1';

const AUTH_SETTINGS = Object.freeze({
  sessionTtlHours: 24,
  cookieSecure: false,
  trustProxy: false,
  hstsEnabled: false,
});

function credentialFileExists(appDataRoot) {
  try {
    fs.accessSync(credentialFilePathForRoot(appDataRoot));
    return true;
  } catch {
    return false;
  }
}

describe('auth-transition-service', () => {
  let tmpDir;
  let appDataRoot;
  let invalidateSpy;

  // A minimal stand-in for the real session repository's SQL surface —
  // invalidateAllSessionsForDb just needs `db.prepare(sql).run()` to succeed.
  function fakeDb() {
    return { prepare: () => ({ run: () => ({ changes: 0 }) }) };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-auth-transition-'));
    appDataRoot = path.join(tmpDir, 'app');
    fs.mkdirSync(appDataRoot, { recursive: true });
    // Matches production: server.js always calls ensureAuthEnablement at
    // startup, so a real CSRF pepper is on disk before any transition runs.
    ensureAuthEnablement(appDataRoot);
    invalidateSpy = vi.spyOn(authServiceModule, 'invalidateAllSessionsForDb');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildService({ replaceAuthConfig = vi.fn(), assertNoActiveProcessingJobs, authService = null } = {}) {
    return {
      replaceAuthConfig,
      service: createAuthTransitionService({
        appDataRoot,
        db: fakeDb(),
        replaceAuthConfig,
        assertNoActiveProcessingJobs,
        authSettings: AUTH_SETTINGS,
        authService,
      }),
    };
  }

  // ─── enable() ───────────────────────────────────────────────────────

  it('enable() writes both managed files, invalidates sessions, and adopts the new context', () => {
    const { service, replaceAuthConfig } = buildService();

    const result = service.enable({ username: USERNAME, password: PASSWORD, confirmation: PASSWORD });

    expect(result).toEqual({ ok: true });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(replaceAuthConfig).toHaveBeenCalledTimes(1);
    const passedConfig = replaceAuthConfig.mock.calls[0][0];
    expect(passedConfig.sessionTtlHours).toBe(24);
    expect(typeof passedConfig.sessionSecret).toBe('string');
    expect(passedConfig.credentialProvider.getCredential().username).toBe(USERNAME);

    const state = readAuthEnablement(appDataRoot);
    expect(state.enabled).toBe(true);
    expect(state.sessionSecret).toBe(passedConfig.sessionSecret);
    expect(credentialFileExists(appDataRoot)).toBe(true);
  });

  it('enable() rejects invalid input before touching disk', () => {
    const { service, replaceAuthConfig } = buildService();

    const result = service.enable({ username: 'a b!', password: 'short', confirmation: 'nope' });

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(replaceAuthConfig).not.toHaveBeenCalled();
    expect(credentialFileExists(appDataRoot)).toBe(false);
    expect(readAuthEnablement(appDataRoot)).toEqual({ enabled: false, csrfPepper: expect.any(String) });
  });

  it('enable() refuses to run when already enabled, without touching state', () => {
    const pepper = ensureAuthEnablement(appDataRoot).csrfPepper;
    enableAuthState(appDataRoot, { sessionSecret: 'a'.repeat(64).slice(0, 64), csrfPepper: pepper });
    const { service, replaceAuthConfig } = buildService();

    const result = service.enable({ username: USERNAME, password: PASSWORD, confirmation: PASSWORD });

    expect(result).toEqual({ ok: false, alreadyEnabled: true });
    expect(replaceAuthConfig).not.toHaveBeenCalled();
    expect(credentialFileExists(appDataRoot)).toBe(false);
  });

  it('enable() rolls back both files when session invalidation fails, before adoption is ever attempted', () => {
    invalidateSpy.mockImplementationOnce(() => {
      throw new Error('simulated session-invalidation failure');
    });
    const { service, replaceAuthConfig } = buildService();

    const result = service.enable({ username: USERNAME, password: PASSWORD, confirmation: PASSWORD });

    expect(result).toEqual({ ok: false, sessionInvalidationFailed: true, error: expect.any(Error) });
    expect(replaceAuthConfig).not.toHaveBeenCalled();
    expect(credentialFileExists(appDataRoot)).toBe(false);
    expect(readAuthEnablement(appDataRoot)).toEqual({ enabled: false, csrfPepper: expect.any(String) });
  });

  it('enable() rolls back both files when context adoption fails (sessions already invalidated is acceptable)', () => {
    const replaceAuthConfig = vi.fn(() => {
      throw new Error('simulated rebuild failure');
    });
    const { service } = buildService({ replaceAuthConfig });

    const result = service.enable({ username: USERNAME, password: PASSWORD, confirmation: PASSWORD });

    expect(result).toEqual({ ok: false, rebuildFailed: true, error: expect.any(Error) });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(credentialFileExists(appDataRoot)).toBe(false);
    expect(readAuthEnablement(appDataRoot)).toEqual({ enabled: false, csrfPepper: expect.any(String) });
  });

  it('refuses enable and disable before auth files, sessions, or context can change when maintenance is blocked', () => {
    const activeProcessingError = new Error('Cannot replace the application context while processing jobs are active.');
    const assertNoActiveProcessingJobs = vi.fn(() => { throw activeProcessingError; });
    const replaceAuthConfig = vi.fn();
    const { service } = buildService({
      replaceAuthConfig,
      assertNoActiveProcessingJobs,
      authService: fakeAuthService(PASSWORD),
    });
    const disabledBefore = readAuthEnablement(appDataRoot);

    expect(service.enable({ username: USERNAME, password: PASSWORD, confirmation: PASSWORD }))
      .toEqual({ ok: false, conflict: true, error: activeProcessingError });
    expect(readAuthEnablement(appDataRoot)).toEqual(disabledBefore);
    expect(credentialFileExists(appDataRoot)).toBe(false);
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(replaceAuthConfig).not.toHaveBeenCalled();

    assertNoActiveProcessingJobs.mockImplementation(() => {});
    expect(service.enable({ username: USERNAME, password: PASSWORD, confirmation: PASSWORD })).toEqual({ ok: true });
    invalidateSpy.mockClear();
    replaceAuthConfig.mockClear();
    const enabledBefore = readAuthEnablement(appDataRoot);
    assertNoActiveProcessingJobs.mockImplementation(() => { throw activeProcessingError; });

    expect(service.disable({ username: USERNAME, currentPassword: PASSWORD }))
      .toEqual({ ok: false, conflict: true, error: activeProcessingError });
    expect(readAuthEnablement(appDataRoot)).toEqual(enabledBefore);
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(replaceAuthConfig).not.toHaveBeenCalled();

    assertNoActiveProcessingJobs.mockImplementation(() => {});
    expect(service.disable({ username: USERNAME, currentPassword: PASSWORD })).toEqual({ ok: true });
  });

  it('enable() always overwrites a stale leftover credential file from a previous enabled period', () => {
    const { service: first } = buildService();
    first.enable({ username: USERNAME, password: PASSWORD, confirmation: PASSWORD });
    expect(credentialFileExists(appDataRoot)).toBe(true);

    // Simulate "disabled, file left inert" without deleting it (matches the
    // credential-file contract — disable() never deletes it either).
    const state = readAuthEnablement(appDataRoot);
    // Directly flip back to disabled on disk (as disable() would, minus the
    // parts already covered by other tests).
    fs.writeFileSync(
      path.join(appDataRoot, 'auth-enablement.json'),
      JSON.stringify({ enabled: false, csrfPepper: state.csrfPepper }, null, 2) + '\n'
    );

    const { service: second } = buildService();
    const result = second.enable({ username: 'newadmin', password: OTHER_PASSWORD, confirmation: OTHER_PASSWORD });

    expect(result.ok).toBe(true);
    const provider = createManagedCredentialProvider({ appDataRoot });
    expect(provider.getCredential().username).toBe('newadmin');
    expect(provider.verifyPassword(OTHER_PASSWORD)).toBe(true);
    expect(provider.verifyPassword(PASSWORD)).toBe(false);
  });

  it('a reentrant enable() call while one is already in flight is rejected as a conflict, never interleaved', () => {
    let reentrantResult;
    const replaceAuthConfig = vi.fn(() => {
      reentrantResult = service.enable({ username: 'someone-else', password: OTHER_PASSWORD, confirmation: OTHER_PASSWORD });
    });
    const { service } = buildService({ replaceAuthConfig });

    const result = service.enable({ username: USERNAME, password: PASSWORD, confirmation: PASSWORD });

    expect(reentrantResult).toEqual({ ok: false, conflict: true });
    expect(result.ok).toBe(true);
    // The reentrant call never wrote its own credentials.
    const provider = createManagedCredentialProvider({ appDataRoot });
    expect(provider.getCredential().username).toBe(USERNAME);
  });

  // ─── disable() ──────────────────────────────────────────────────────

  function enableFor(service) {
    return service.enable({ username: USERNAME, password: PASSWORD, confirmation: PASSWORD });
  }

  function fakeAuthService(passwordThatMatches) {
    return {
      verifyCredentials: (candidateUsername, candidatePassword) =>
        candidateUsername === USERNAME && candidatePassword === passwordThatMatches,
    };
  }

  it('disable() invalidates sessions, adopts the disabled context, and leaves the credential file inert (not deleted)', () => {
    const replaceAuthConfig = vi.fn();
    const { service } = buildService({ replaceAuthConfig, authService: fakeAuthService(PASSWORD) });
    enableFor(service);
    invalidateSpy.mockClear();
    replaceAuthConfig.mockClear();

    const result = service.disable({ username: USERNAME, currentPassword: PASSWORD });

    expect(result).toEqual({ ok: true });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(replaceAuthConfig).toHaveBeenCalledWith(null);
    expect(readAuthEnablement(appDataRoot).enabled).toBe(false);
    expect(credentialFileExists(appDataRoot)).toBe(true);
  });

  it('disable() rejects the wrong current password without writing anything', () => {
    const replaceAuthConfig = vi.fn();
    const { service } = buildService({ replaceAuthConfig, authService: fakeAuthService(PASSWORD) });
    enableFor(service);
    replaceAuthConfig.mockClear();

    const result = service.disable({ username: USERNAME, currentPassword: 'wrong-password' });

    expect(result).toEqual({ ok: false, currentPasswordError: 'Current password is incorrect.' });
    expect(replaceAuthConfig).not.toHaveBeenCalled();
    expect(readAuthEnablement(appDataRoot).enabled).toBe(true);
  });

  it('disable() refuses when there is no live authService (already disabled)', () => {
    const { service } = buildService({ authService: null });

    const result = service.disable({ username: USERNAME, currentPassword: PASSWORD });

    expect(result).toEqual({ ok: false, alreadyDisabled: true });
  });

  it('disable() rolls back the enablement state when session invalidation fails; auth stays enabled', () => {
    const replaceAuthConfig = vi.fn();
    const { service } = buildService({ replaceAuthConfig, authService: fakeAuthService(PASSWORD) });
    enableFor(service);
    const stateBefore = readAuthEnablement(appDataRoot);
    replaceAuthConfig.mockClear();
    invalidateSpy.mockImplementationOnce(() => {
      throw new Error('simulated session-invalidation failure');
    });

    const result = service.disable({ username: USERNAME, currentPassword: PASSWORD });

    expect(result).toEqual({ ok: false, sessionInvalidationFailed: true, error: expect.any(Error) });
    expect(replaceAuthConfig).not.toHaveBeenCalled();
    expect(readAuthEnablement(appDataRoot)).toEqual(stateBefore);
  });

  it('disable() rolls back the enablement state when context adoption fails; credential file untouched throughout', () => {
    const replaceAuthConfig = vi.fn();
    const { service } = buildService({ replaceAuthConfig, authService: fakeAuthService(PASSWORD) });
    enableFor(service);
    const stateBefore = readAuthEnablement(appDataRoot);
    replaceAuthConfig.mockClear();
    replaceAuthConfig.mockImplementationOnce(() => {
      throw new Error('simulated rebuild failure');
    });

    const result = service.disable({ username: USERNAME, currentPassword: PASSWORD });

    expect(result).toEqual({ ok: false, rebuildFailed: true, error: expect.any(Error) });
    expect(readAuthEnablement(appDataRoot)).toEqual(stateBefore);
    expect(credentialFileExists(appDataRoot)).toBe(true);
  });

  // ─── restart-observability ──────────────────────────────────────────

  it('a committed enable/disable transition leaves no half-transition observable across a fresh state read (simulated restart)', () => {
    const { service } = buildService();
    service.enable({ username: USERNAME, password: PASSWORD, confirmation: PASSWORD });

    // Simulate a restart: a brand-new, independent read of the same files.
    const restartState = readAuthEnablement(appDataRoot);
    expect(restartState.enabled).toBe(true);
    expect(typeof restartState.sessionSecret).toBe('string');

    const provider = createManagedCredentialProvider({ appDataRoot });
    expect(provider.getCredential().username).toBe(USERNAME);
    expect(provider.verifyPassword(PASSWORD)).toBe(true);
  });
});
