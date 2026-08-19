import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { hashPassword, verifyPassword, isValidPasswordHash } from '../src/auth/password-hash.js';
import { generateSessionToken, hashSessionToken } from '../src/auth/session-token.js';
import { createSessionRepository } from '../src/data/session-repository.js';
import {
  createManagedCredentialProvider,
  createStaticCredentialProvider,
  credentialFilePathForRoot,
  CredentialError,
} from '../src/auth/credential-provider.js';
import { createLoginThrottler, getClientAddress } from '../src/auth/login-throttle.js';
import {
  createAuthService,
  invalidateAllSessionsForDb,
  AuthError,
  SESSION_CLEANUP_INTERVAL_MS,
} from '../src/services/auth-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Counts `.get()`/`.all()`/`.run()` executions across every statement
 * `db.prepare()` produces from this point on — including statements a
 * repository prepares once at construction and reuses across many calls
 * (as session-repository.js does), which a prepare-call count alone would
 * miss.
 */
function instrumentStatementExecution(db) {
  const originalPrepare = db.prepare.bind(db);
  let executions = 0;

  function wrapStatement(statement) {
    return new Proxy(statement, {
      get(target, prop, receiver) {
        if (prop === 'get' || prop === 'all' || prop === 'run') {
          return (...args) => {
            executions++;
            return target[prop](...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  db.prepare = (...args) => wrapStatement(originalPrepare(...args));

  return {
    reset() {
      executions = 0;
    },
    count() {
      return executions;
    },
  };
}

/** A db wrapper whose expired-session sweep statement always throws, so tests
 * can exercise the cleanup-failure path without corrupting the real
 * connection used for setup/assertions. */
function wrapDbFailingCleanup(db) {
  const originalPrepare = db.prepare.bind(db);
  return {
    prepare(sql) {
      if (sql.startsWith('DELETE FROM sessions WHERE expires_at')) {
        return {
          run() {
            throw new Error('SQLITE_BUSY: database is locked');
          },
        };
      }
      return originalPrepare(sql);
    },
  };
}

describe('password-hash', () => {
  it('hashes and verifies a matching password', () => {
    const hash = hashPassword('CorrectHorseBatteryStaple');
    expect(verifyPassword('CorrectHorseBatteryStaple', hash)).toBe(true);
  });

  it('rejects a non-matching password', () => {
    const hash = hashPassword('CorrectHorseBatteryStaple');
    expect(verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('produces a different salt (and therefore hash) each time', () => {
    const a = hashPassword('same-password');
    const b = hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(verifyPassword('same-password', a)).toBe(true);
    expect(verifyPassword('same-password', b)).toBe(true);
  });

  it('never invents a custom algorithm tag', () => {
    const hash = hashPassword('x');
    expect(hash.split('$')[0]).toBe('scrypt');
  });

  it.each([
    'plain-text',
    'bcrypt$10$abc$def',
    'scrypt$abc$8$1$c2FsdA==$aGFzaA==',
    'scrypt$16384$8$1$$aGFzaA==',
    '',
    null,
    undefined,
    42,
  ])('isValidPasswordHash rejects %s', (value) => {
    expect(isValidPasswordHash(value)).toBe(false);
  });

  it('isValidPasswordHash accepts a freshly generated hash', () => {
    expect(isValidPasswordHash(hashPassword('anything'))).toBe(true);
  });

  it('verifyPassword returns false (never throws) for a malformed encoded hash', () => {
    expect(verifyPassword('whatever', 'not-a-real-hash')).toBe(false);
  });
});

describe('login throttling', () => {
  it('applies progressive bounded delays and expires stale records with a deterministic clock', () => {
    let clock = 1000;
    const throttler = createLoginThrottler({ now: () => clock, baseDelayMs: 100, maxDelayMs: 250, windowMs: 1000, maxEntries: 4 });
    expect(throttler.check(' Admin ', '127.0.0.1').limited).toBe(false);
    expect(throttler.recordFailure(' Admin ', '127.0.0.1').delayMs).toBe(100);
    expect(throttler.check('admin', '127.0.0.1')).toEqual({ limited: true, retryAfterMs: 100 });
    clock += 101;
    expect(throttler.check('admin', '127.0.0.1').limited).toBe(false);
    expect(throttler.recordFailure('admin', '127.0.0.1').delayMs).toBe(200);
    clock += 201;
    expect(throttler.recordFailure('admin', '127.0.0.1').delayMs).toBe(250);
    clock += 1001;
    expect(throttler.size()).toBe(0);
  });

  it('keeps a recently updated record when evicting entries at capacity', () => {
    let clock = 1000;
    const throttler = createLoginThrottler({ now: () => clock, baseDelayMs: 100, maxDelayMs: 250, windowMs: 1000, maxEntries: 3 });
    throttler.recordFailure('target', '127.0.0.1');
    throttler.recordFailure('other-a', '127.0.0.2');
    throttler.recordFailure('other-b', '127.0.0.3');

    clock += 101;
    expect(throttler.recordFailure('target', '127.0.0.1')).toEqual({ delayMs: 200, failures: 2 });
    throttler.recordFailure('other-c', '127.0.0.4');

    expect(throttler.recordFailure('other-a', '127.0.0.2')).toEqual({ delayMs: 100, failures: 1 });

    expect(throttler.check('target', '127.0.0.1')).toEqual({ limited: true, retryAfterMs: 200 });
  });

  it('resets counters on successful login and bounds memory entries', () => {
    let clock = 1;
    const throttler = createLoginThrottler({ now: () => clock, maxEntries: 2 });
    throttler.recordFailure('a', '127.0.0.1');
    throttler.recordFailure('b', '127.0.0.2');
    throttler.recordFailure('c', '127.0.0.3');
    expect(throttler.size()).toBe(2);
    throttler.recordFailure('admin', '127.0.0.4');
    throttler.recordSuccess('admin', '127.0.0.4');
    expect(throttler.check('admin', '127.0.0.4').limited).toBe(false);
    clock += 1;
  });

  it('uses forwarding headers only when trustProxy is enabled and handles malformed addresses safely', () => {
    const req = { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
    expect(getClientAddress(req, { trustProxy: false })).toBe('127.0.0.1');
    expect(getClientAddress(req, { trustProxy: true })).toBe('203.0.113.7');
    expect(getClientAddress({ headers: { 'x-forwarded-for': 'not an ip' }, socket: { remoteAddress: 'also bad' } }, { trustProxy: true })).toBe('unknown');
  });
});

describe('session-token', () => {
  it('generates high-entropy, URL-safe tokens', () => {
    const token = generateSessionToken();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates distinct tokens across calls', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateSessionToken()));
    expect(tokens.size).toBe(20);
  });

  it('hashes deterministically for the same token/secret', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token, 'secret-a')).toBe(hashSessionToken(token, 'secret-a'));
  });

  it('produces a different hash when the secret changes (secret-rotation invalidation)', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token, 'secret-a')).not.toBe(hashSessionToken(token, 'secret-b'));
  });

  it('the stored token hash never equals the raw token itself', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token, 'secret')).not.toBe(token);
  });
});

describe('session repository + auth service (real SQLite)', () => {
  let tmpDir;
  let db;
  const PASSWORD = 'CorrectHorseBatteryStaple';
  const PASSWORD_HASH = hashPassword(PASSWORD);
  const SECRET = 'a'.repeat(32);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-auth-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeService(overrides = {}) {
    return createAuthService({
      db,
      username: 'admin',
      passwordHash: PASSWORD_HASH,
      sessionSecret: SECRET,
      sessionTtlHours: 24,
      ...overrides,
    });
  }

  describe('credential provider and password rotation', () => {
    it('rotates the live provider credential and revokes existing sessions', () => {
      const provider = createStaticCredentialProvider({ username: 'admin', passwordHash: PASSWORD_HASH });
      const service = makeService({ credentialProvider: provider });
      const oldSession = service.login('admin', PASSWORD);
      expect(oldSession).not.toBeNull();

      const result = service.rotatePassword({
        currentPassword: PASSWORD,
        newPassword: 'NewCorrectHorseBattery',
        confirmation: 'NewCorrectHorseBattery',
      });
      expect(result).toEqual({ ok: true });
      expect(service.getSession(oldSession.token)).toBeNull();
      expect(service.login('admin', PASSWORD)).toBeNull();
      expect(service.login('admin', 'NewCorrectHorseBattery')).not.toBeNull();
    });

    it('rejects current-password failures generically and preserves the existing credential', () => {
      const provider = createStaticCredentialProvider({ username: 'admin', passwordHash: PASSWORD_HASH });
      const service = makeService({ credentialProvider: provider });
      const result = service.rotatePassword({
        currentPassword: 'wrong-password',
        newPassword: 'NewCorrectHorseBattery',
        confirmation: 'NewCorrectHorseBattery',
      });
      expect(result.ok).toBe(false);
      expect(result.currentPasswordError).toBe('Current password is incorrect.');
      expect(service.login('admin', PASSWORD)).not.toBeNull();
      expect(service.login('admin', 'NewCorrectHorseBattery')).toBeNull();
    });

    it('reports clear password-policy errors before updating the provider', () => {
      const provider = createStaticCredentialProvider({ username: 'admin', passwordHash: PASSWORD_HASH });
      const service = makeService({ credentialProvider: provider });
      const result = service.rotatePassword({
        currentPassword: PASSWORD,
        newPassword: 'short',
        confirmation: 'different',
      });
      expect(result.ok).toBe(false);
      expect(result.errors).toContain('New password must be at least 12 characters.');
      expect(result.errors).toContain('New password and confirmation must match.');
      expect(service.login('admin', PASSWORD)).not.toBeNull();
    });
  });

  describe('managed credential storage', () => {
    it('bootstraps a managed credential file and uses it as authoritative afterward', () => {
      const root = path.join(tmpDir, 'managed');
      fs.mkdirSync(root, { recursive: true });
      const first = createManagedCredentialProvider({
        appDataRoot: root,
        bootstrapUsername: 'admin',
        bootstrapPasswordHash: PASSWORD_HASH,
      });
      const managedPath = credentialFilePathForRoot(root);
      expect(fs.existsSync(managedPath)).toBe(true);
      first.updatePasswordHash(hashPassword('ManagedPassword123'));

      const second = createManagedCredentialProvider({
        appDataRoot: root,
        bootstrapUsername: 'admin',
        bootstrapPasswordHash: hashPassword('EnvironmentPassword123'),
      });
      expect(verifyPassword('ManagedPassword123', second.getCredential().passwordHash)).toBe(true);
      expect(verifyPassword('EnvironmentPassword123', second.getCredential().passwordHash)).toBe(false);
    });

    it('stores only username and encoded password hash with restrictive mode where supported', () => {
      const root = path.join(tmpDir, 'managed-mode');
      const provider = createManagedCredentialProvider({
        appDataRoot: root,
        bootstrapUsername: 'admin',
        bootstrapPasswordHash: PASSWORD_HASH,
      });
      const raw = fs.readFileSync(provider.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      expect(Object.keys(parsed).sort()).toEqual(['passwordHash', 'username']);
      expect(raw).not.toContain(PASSWORD);
      expect(isValidPasswordHash(parsed.passwordHash)).toBe(true);
      if (process.platform !== 'win32') {
        expect((fs.statSync(provider.filePath).mode & 0o777).toString(8)).toBe('600');
      }
    });

    it('fails safely for malformed managed credential JSON', () => {
      const root = path.join(tmpDir, 'managed-malformed');
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(credentialFilePathForRoot(root), '{ bad json');
      expect(() => createManagedCredentialProvider({
        appDataRoot: root,
        bootstrapUsername: 'admin',
        bootstrapPasswordHash: PASSWORD_HASH,
      })).toThrow(CredentialError);
    });

    it('rejects a symlinked managed credential file when symlinks are available', () => {
      const root = path.join(tmpDir, 'managed-symlink');
      fs.mkdirSync(root, { recursive: true });
      const outside = path.join(tmpDir, 'outside.json');
      fs.writeFileSync(outside, JSON.stringify({ username: 'admin', passwordHash: PASSWORD_HASH }));
      try {
        fs.symlinkSync(outside, credentialFilePathForRoot(root));
      } catch {
        return;
      }
      expect(() => createManagedCredentialProvider({
        appDataRoot: root,
        bootstrapUsername: 'admin',
        bootstrapPasswordHash: PASSWORD_HASH,
      })).toThrow(CredentialError);
    });
  });

  it('only ever stores the HMAC token hash, never the raw token', () => {
    const service = makeService();
    const { token } = service.login('admin', PASSWORD);
    const row = createSessionRepository(db)
      .findById(hashSessionToken(token, SECRET));
    expect(row).not.toBeNull();

    const all = db.prepare('SELECT id FROM sessions').all();
    expect(all.map((r) => r.id)).not.toContain(token);
  });

  it('login succeeds with correct username/password', () => {
    const service = makeService();
    const result = service.login('admin', PASSWORD);
    expect(result).not.toBeNull();
    expect(typeof result.token).toBe('string');
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('login normalizes username case/whitespace', () => {
    const service = makeService();
    expect(service.login('  Admin  ', PASSWORD)).not.toBeNull();
  });

  it('returns the same generic failure for a wrong username and a wrong password', () => {
    const service = makeService();
    expect(service.login('nobody', PASSWORD)).toBeNull();
    expect(service.login('admin', 'wrong-password')).toBeNull();
  });

  it('does not leak which of username/password was wrong via verifyCredentials', () => {
    const service = makeService();
    expect(service.verifyCredentials('nobody', PASSWORD)).toBe(false);
    expect(service.verifyCredentials('admin', 'wrong')).toBe(false);
  });

  it('creates and looks up a session', () => {
    const service = makeService();
    const { token } = service.createSession();
    const session = service.getSession(token);
    expect(session).toEqual({ username: 'admin', csrfSecret: expect.any(String), expiresAt: expect.any(String) });
  });

  it('returns null for an unknown session token', () => {
    const service = makeService();
    expect(service.getSession('does-not-exist')).toBeNull();
  });

  it('rejects and removes an expired session', () => {
    const service = makeService({ sessionTtlHours: 24 });
    const { token } = service.createSession();
    const tokenHash = hashSessionToken(token, SECRET);

    // Force the row into the past directly, bypassing the service's own TTL math.
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      tokenHash
    );

    expect(service.getSession(token)).toBeNull();
    expect(createSessionRepository(db).findById(tokenHash)).toBeNull();
  });

  it('logout revokes the session server-side', () => {
    const service = makeService();
    const { token } = service.createSession();
    expect(service.getSession(token)).not.toBeNull();

    service.logout(token);
    expect(service.getSession(token)).toBeNull();
  });

  it('logout on an unknown token is a safe no-op', () => {
    const service = makeService();
    expect(() => service.logout('nope')).not.toThrow();
  });

  it('cleanupExpiredSessions removes only expired rows', () => {
    const service = makeService();
    const live = service.createSession();
    const expiring = service.createSession();
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      hashSessionToken(expiring.token, SECRET)
    );

    const removed = service.cleanupExpiredSessions();
    expect(removed).toBe(1);
    expect(service.getSession(live.token)).not.toBeNull();
  });

  it('invalidateAllSessions clears every session regardless of expiry', () => {
    const service = makeService();
    const a = service.createSession();
    const b = service.createSession();

    const removed = service.invalidateAllSessions();
    expect(removed).toBe(2);
    expect(service.getSession(a.token)).toBeNull();
    expect(service.getSession(b.token)).toBeNull();
  });

  it('wraps unexpected repository failures in AuthError rather than leaking raw SQLite errors', () => {
    const brokenDb = {
      prepare() {
        // Statements are prepared eagerly at repository construction time;
        // the failure this test cares about happens when a prepared
        // statement actually runs against a broken connection.
        return {
          run() {
            throw new Error('SQLITE_IOERR: disk I/O error');
          },
          get() {
            return null;
          },
          all() {
            return [];
          },
        };
      },
    };
    const service = createAuthService({
      db: brokenDb,
      username: 'admin',
      passwordHash: PASSWORD_HASH,
      sessionSecret: SECRET,
      sessionTtlHours: 24,
    });

    expect(() => service.createSession()).toThrow(AuthError);
    try {
      service.createSession();
    } catch (err) {
      expect(err.message).not.toContain('SQLITE_IOERR');
    }
  });

  describe('invalidateAllSessionsForDb (restore contract)', () => {
    it('wipes sessions on a bare db handle with no constructed AuthService', () => {
      const service = makeService();
      service.createSession();
      service.createSession();
      expect(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c).toBe(2);

      const removed = invalidateAllSessionsForDb(db);
      expect(removed).toBe(2);
      expect(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c).toBe(0);
    });
  });

  // Phase 12.1 cleanup addendum: production cleanup trigger wired into
  // getSession (the same call middleware/auth.js's resolveSession makes on
  // every request that carries a session cookie), throttled to at most once
  // per SESSION_CLEANUP_INTERVAL_MS per AuthService instance.
  describe('expired-session cleanup cadence (production trigger: getSession)', () => {
    it('a real getSession lookup performs the first eligible cleanup sweep, removes only expired rows, and throttles subsequent sweeps until the interval elapses', () => {
      let clock = 1_700_000_000_000;
      // Instrumentation must wrap db.prepare BEFORE the service (and its
      // session repository) is constructed: the repository prepares and
      // binds its statements once at construction time, so a service built
      // beforehand would keep using unwrapped statement objects forever.
      const instr = instrumentStatementExecution(db);
      const service = makeService({ now: () => clock });

      const active = service.createSession();
      const expired = service.createSession();
      db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(
        new Date(clock - 1000).toISOString(),
        hashSessionToken(expired.token, SECRET)
      );

      // First lookup: cleanup is due (fresh service) -> one lookup statement
      // execution plus exactly one cleanup-sweep statement execution.
      instr.reset();
      expect(service.getSession(active.token)).not.toBeNull();
      expect(instr.count()).toBe(2);
      expect(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c).toBe(1);
      expect(createSessionRepository(db).findById(hashSessionToken(expired.token, SECRET))).toBeNull();

      // Repeated lookups inside the interval: no repeated cleanup statement,
      // only the ordinary lookup statement.
      instr.reset();
      expect(service.getSession(active.token)).not.toBeNull();
      expect(instr.count()).toBe(1);
      instr.reset();
      expect(service.getSession(active.token)).not.toBeNull();
      expect(instr.count()).toBe(1);

      // Advancing the injected clock past the cadence runs the sweep again.
      clock += SESSION_CLEANUP_INTERVAL_MS + 1;
      instr.reset();
      expect(service.getSession(active.token)).not.toBeNull();
      expect(instr.count()).toBe(2);
    });

    it('a cleanup-sweep failure does not authenticate an expired session, does not remove active sessions, and does not surface a raw SQLite error', () => {
      let clock = 1_700_000_000_000;
      const failingDb = wrapDbFailingCleanup(db);
      const service = createAuthService({
        db: failingDb,
        username: 'admin',
        passwordHash: PASSWORD_HASH,
        sessionSecret: SECRET,
        sessionTtlHours: 24,
        now: () => clock,
      });

      const active = service.createSession();
      const expired = service.createSession();
      db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(
        new Date(clock - 1000).toISOString(),
        hashSessionToken(expired.token, SECRET)
      );

      // The sweep is due and throws internally; getSession must not throw,
      // must not authenticate the expired session, and must leave the
      // active row untouched (the sweep never ran to completion).
      expect(() => service.getSession(active.token)).not.toThrow();
      const session = service.getSession(active.token);
      expect(session).toEqual({ username: 'admin', csrfSecret: expect.any(String), expiresAt: expect.any(String) });
      expect(service.getSession(expired.token)).toBeNull();
      expect(db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c).toBeGreaterThanOrEqual(1);
      expect(createSessionRepository(db).findById(hashSessionToken(active.token, SECRET))).not.toBeNull();
    });

    it('cleanup resumes on a later interval after a failed sweep', () => {
      let clock = 1_700_000_000_000;
      let shouldFail = true;
      const originalPrepare = db.prepare.bind(db);
      const flakyDb = {
        prepare(sql) {
          const real = originalPrepare(sql);
          if (sql.startsWith('DELETE FROM sessions WHERE expires_at')) {
            // `shouldFail` is read at CALL time (not prepare time) since the
            // repository binds this statement once at construction and
            // reuses that same object for every sweep.
            return {
              run(...args) {
                if (shouldFail) throw new Error('SQLITE_BUSY: database is locked');
                return real.run(...args);
              },
            };
          }
          return real;
        },
      };
      const service = createAuthService({
        db: flakyDb,
        username: 'admin',
        passwordHash: PASSWORD_HASH,
        sessionSecret: SECRET,
        sessionTtlHours: 24,
        now: () => clock,
      });

      const active = service.createSession();
      const expired = service.createSession();
      const expiredHash = hashSessionToken(expired.token, SECRET);
      db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(
        new Date(clock - 1000).toISOString(),
        expiredHash
      );

      // First sweep fails; expired row survives.
      service.getSession(active.token);
      expect(createSessionRepository(db).findById(expiredHash)).not.toBeNull();

      // Once the interval elapses, cleanup is retried and now succeeds.
      shouldFail = false;
      clock += SESSION_CLEANUP_INTERVAL_MS + 1;
      service.getSession(active.token);
      expect(createSessionRepository(db).findById(expiredHash)).toBeNull();
    });

    it('never logs or throws a message containing the session secret or a token hash on sweep failure', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        let clock = 1_700_000_000_000;
        const failingDb = wrapDbFailingCleanup(db);
        const service = createAuthService({
          db: failingDb,
          username: 'admin',
          passwordHash: PASSWORD_HASH,
          sessionSecret: SECRET,
          sessionTtlHours: 24,
          now: () => clock,
        });
        const { token } = service.createSession();
        const tokenHash = hashSessionToken(token, SECRET);

        expect(() => service.getSession(token)).not.toThrow();
        // Nothing thrown/returned/logged exposes the secret or the stored id.
        const session = service.getSession(token);
        expect(JSON.stringify(session)).not.toContain(SECRET);
        expect(JSON.stringify(session)).not.toContain(tokenHash);
        expect(errorSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it('a fresh AuthService instance (as constructed on every app rebuild — see app-context.js) starts with its own cleanup state, due immediately', () => {
      let clock = 1_700_000_000_000;
      // Instrumentation must wrap db.prepare BEFORE `first` is constructed —
      // session-repository.js binds its statements once at construction, so
      // instrumenting afterward would miss every call `first` makes.
      const instrFirst = instrumentStatementExecution(db);
      const first = makeService({ now: () => clock });
      const { token: firstActiveToken } = first.createSession();

      // Exhaust the first instance's "due" sweep so its own next lookup
      // would NOT trigger another cleanup statement.
      first.getSession(firstActiveToken);
      instrFirst.reset();
      expect(first.getSession(firstActiveToken)).not.toBeNull();
      expect(instrFirst.count()).toBe(1); // lookup only — `first` is not due again yet

      // Construct a brand-new instance against the same db, simulating
      // app-context.js's per-rebuild `createAuthService` call, and give it a
      // fresh expired row to sweep. Statement instrumentation must be
      // installed BEFORE construction: session-repository.js prepares its
      // statements once at construction time, so only prepares made after
      // this point are wrapped.
      const instrSecond = instrumentStatementExecution(db);
      const second = makeService({ now: () => clock });
      const stale = second.createSession();
      const staleHash = hashSessionToken(stale.token, SECRET);
      db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(
        new Date(clock - 1000).toISOString(),
        staleHash
      );

      instrSecond.reset();
      // The new instance's very first lookup is due for its own sweep,
      // independent of `first`'s already-advanced cleanup state.
      expect(second.getSession(stale.token)).toBeNull(); // expired -> rejected, and swept
      expect(instrSecond.count()).toBe(2); // lookup + due sweep
      expect(createSessionRepository(db).findById(staleHash)).toBeNull();
    });
  });
});
