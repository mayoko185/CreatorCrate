import { describe, it, expect } from 'vitest';
import { createConfig, ConfigError } from '../src/config.js';
import { hashPassword } from '../src/auth/password-hash.js';
import path from 'node:path';

// Fixed valid auth values shared across tests that are not themselves
// exercising auth validation — generated the same way an operator would via
// `pnpm auth:hash`.
const VALID_PASSWORD_HASH = hashPassword('CorrectHorseBatteryStaple');
const VALID_SESSION_SECRET = 'a'.repeat(32);

function env(overrides = {}) {
  return {
    NODE_ENV: 'development',
    PORT: '3000',
    APP_NAME: 'CreatorCrate',
    APP_DATA_ROOT: './data/app',
    PROJECTS_ROOT: './data/projects',
    DATABASE_PATH: './data/app/creatorcrate.db',
    CREATORCRATE_USERNAME: 'admin',
    CREATORCRATE_PASSWORD_HASH: VALID_PASSWORD_HASH,
    SESSION_SECRET: VALID_SESSION_SECRET,
    ...overrides,
  };
}

describe('createConfig', () => {
  it('uses defaults when environment supplies only required auth fields', () => {
    const config = createConfig({
      CREATORCRATE_USERNAME: 'admin',
      CREATORCRATE_PASSWORD_HASH: VALID_PASSWORD_HASH,
      SESSION_SECRET: VALID_SESSION_SECRET,
    });
    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.appName).toBe('CreatorCrate');
    expect(config.appDataRoot).toBe(path.resolve('./data/app'));
    expect(config.projectsRoot).toBe(path.resolve('./data/projects'));
    expect(config.databasePath).toBe(path.resolve('./data/app/creatorcrate.db'));
  });

  it('fails startup when no authentication configuration is provided', () => {
    expect(() => createConfig({})).toThrow(ConfigError);
  });

  it('applies environment overrides', () => {
    const config = createConfig(
      env({
        PORT: '8080',
        APP_NAME: 'Test Crate',
        APP_DATA_ROOT: '/tmp/app',
        PROJECTS_ROOT: '/tmp/projects',
        DATABASE_PATH: '/tmp/app/test.db',
      })
    );
    expect(config.port).toBe(8080);
    expect(config.appName).toBe('Test Crate');
    expect(config.appDataRoot).toBe(path.resolve('/tmp/app'));
    expect(config.projectsRoot).toBe(path.resolve('/tmp/projects'));
    expect(config.databasePath).toBe(path.resolve('/tmp/app/test.db'));
  });

  it.each(['0', '-1', '70000', 'abc'])('rejects invalid port %s', (port) => {
    expect(() => createConfig(env({ PORT: port }))).toThrow(ConfigError);
  });

  it('rejects database path outside app data root', () => {
    expect(() =>
      createConfig(
        env({
          APP_DATA_ROOT: '/tmp/app',
          DATABASE_PATH: '/tmp/other/db.db',
        })
      )
    ).toThrow(ConfigError);
  });

  it('rejects database path equal to app data root', () => {
    expect(() =>
      createConfig(
        env({
          APP_DATA_ROOT: '/tmp/app',
          DATABASE_PATH: '/tmp/app',
        })
      )
    ).toThrow(ConfigError);
  });

  it('accepts relative database path resolved within app data root', () => {
    const config = createConfig(
      env({
        APP_DATA_ROOT: '/tmp/app',
        DATABASE_PATH: '/tmp/app/sub/creatorcrate.db',
      })
    );
    expect(config.databasePath).toBe(path.resolve('/tmp/app/sub/creatorcrate.db'));
  });

  // ─── Preview root (Phase 10.1A) ───────────────────────────────────────

  it('derives previewRoot as APP_DATA_ROOT/previews by default', () => {
    const config = createConfig(
      env({ APP_DATA_ROOT: '/tmp/app', DATABASE_PATH: '/tmp/app/creatorcrate.db' })
    );
    expect(config.previewRoot).toBe(path.resolve('/tmp/app', 'previews'));
  });

  it('derives previewRoot from a custom APP_DATA_ROOT', () => {
    const config = createConfig(
      env({
        APP_DATA_ROOT: '/var/creatorcrate/data',
        DATABASE_PATH: '/var/creatorcrate/data/creatorcrate.db',
      })
    );
    expect(config.previewRoot).toBe(path.resolve('/var/creatorcrate/data', 'previews'));
  });

  it('previewRoot is always nested under appDataRoot, not directly configurable', () => {
    // Even when PROJECTS_ROOT points elsewhere, previewRoot stays under
    // APP_DATA_ROOT — it is a derived, owned directory.
    const config = createConfig(
      env({
        APP_DATA_ROOT: '/tmp/app',
        PROJECTS_ROOT: '/tmp/elsewhere',
        DATABASE_PATH: '/tmp/app/creatorcrate.db',
      })
    );
    expect(config.previewRoot).toBe(path.join(config.appDataRoot, 'previews'));
    expect(config.previewRoot).not.toBe(config.projectsRoot);
  });

  it('config object is frozen and previewRoot is a string', () => {
    const config = createConfig(
      env({ APP_DATA_ROOT: '/tmp/app', DATABASE_PATH: '/tmp/app/creatorcrate.db' })
    );
    expect(Object.isFrozen(config)).toBe(true);
    expect(typeof config.previewRoot).toBe('string');
    expect(config.previewRoot.length).toBeGreaterThan(0);
  });

  // ─── Backup directory (Phase 11.1) ────────────────────────────────────

  it('derives backupDir as APP_DATA_ROOT/backups by default', () => {
    const config = createConfig(
      env({ APP_DATA_ROOT: '/tmp/app', DATABASE_PATH: '/tmp/app/creatorcrate.db' })
    );
    expect(config.backupDir).toBe(path.resolve('/tmp/app', 'backups'));
  });

  it('backupDir is always nested under appDataRoot, not directly configurable', () => {
    const config = createConfig(
      env({
        APP_DATA_ROOT: '/tmp/app',
        PROJECTS_ROOT: '/tmp/elsewhere',
        DATABASE_PATH: '/tmp/app/creatorcrate.db',
      })
    );
    expect(config.backupDir).toBe(path.join(config.appDataRoot, 'backups'));
    expect(config.backupDir).not.toBe(config.projectsRoot);
    expect(config.backupDir).not.toBe(config.previewRoot);
  });

  // ─── Backup retention (Phase 11.3) ────────────────────────────────────

  it('defaults backupRetentionCount to 10 when unset', () => {
    const config = createConfig(env());
    expect(config.backupRetentionCount).toBe(10);
  });

  it('applies a custom BACKUP_RETENTION_COUNT', () => {
    const config = createConfig(env({ BACKUP_RETENTION_COUNT: '25' }));
    expect(config.backupRetentionCount).toBe(25);
  });

  it('treats BACKUP_RETENTION_COUNT=0 as disabling automatic pruning, not an error', () => {
    const config = createConfig(env({ BACKUP_RETENTION_COUNT: '0' }));
    expect(config.backupRetentionCount).toBe(0);
  });

  it.each(['-1', '1.5', 'abc'])('rejects invalid BACKUP_RETENTION_COUNT %s', (value) => {
    expect(() => createConfig(env({ BACKUP_RETENTION_COUNT: value }))).toThrow(ConfigError);
  });

  // ─── Authentication configuration (Phase 12.1) ─────────────────────────

  it('parses valid auth configuration with conservative defaults', () => {
    const config = createConfig(env());
    expect(config.auth.username).toBe('admin');
    expect(config.auth.passwordHash).toBe(VALID_PASSWORD_HASH);
    expect(config.auth.sessionSecret).toBe(VALID_SESSION_SECRET);
    expect(config.auth.sessionTtlHours).toBe(24);
    expect(config.auth.cookieSecure).toBe(false);
    expect(config.auth.trustProxy).toBe(false);
    expect(config.auth.hstsEnabled).toBe(false);
    expect(config.auth.managedCredentialPath).toBe(path.join(config.appDataRoot, 'operator-credential.json'));
    expect(Object.isFrozen(config.auth)).toBe(true);
  });

  it('normalizes CREATORCRATE_USERNAME to lowercase and trims whitespace', () => {
    const config = createConfig(env({ CREATORCRATE_USERNAME: '  Admin  ' }));
    expect(config.auth.username).toBe('admin');
  });

  it('rejects a missing CREATORCRATE_USERNAME', () => {
    expect(() => createConfig(env({ CREATORCRATE_USERNAME: '' }))).toThrow(ConfigError);
  });

  it.each(['ab', 'a'.repeat(65), '-admin', 'admin-', 'Admin User', 'admin!'])(
    'rejects invalid CREATORCRATE_USERNAME %s',
    (value) => {
      expect(() => createConfig(env({ CREATORCRATE_USERNAME: value }))).toThrow(ConfigError);
    }
  );

  it('rejects a missing CREATORCRATE_PASSWORD_HASH', () => {
    expect(() => createConfig(env({ CREATORCRATE_PASSWORD_HASH: '' }))).toThrow(ConfigError);
  });

  it.each(['plaintext-password', 'bcrypt$10$abc', 'scrypt$notanumber$8$1$c2FsdA==$aGFzaA=='])(
    'rejects an invalid/unrecognized CREATORCRATE_PASSWORD_HASH %s',
    (value) => {
      expect(() => createConfig(env({ CREATORCRATE_PASSWORD_HASH: value }))).toThrow(ConfigError);
    }
  );

  it('never accepts a plaintext password in place of a hash', () => {
    expect(() => createConfig(env({ CREATORCRATE_PASSWORD_HASH: 'CorrectHorseBatteryStaple' }))).toThrow(
      ConfigError
    );
  });

  it('rejects a missing SESSION_SECRET', () => {
    expect(() => createConfig(env({ SESSION_SECRET: '' }))).toThrow(ConfigError);
  });

  it('rejects a SESSION_SECRET below the minimum length', () => {
    expect(() => createConfig(env({ SESSION_SECRET: 'short-secret' }))).toThrow(ConfigError);
  });

  it('accepts a SESSION_SECRET at exactly the minimum length', () => {
    const config = createConfig(env({ SESSION_SECRET: 'b'.repeat(32) }));
    expect(config.auth.sessionSecret).toBe('b'.repeat(32));
  });

  it('defaults SESSION_TTL_HOURS to 24 when unset', () => {
    const config = createConfig(env());
    expect(config.auth.sessionTtlHours).toBe(24);
  });

  it('applies a custom SESSION_TTL_HOURS', () => {
    const config = createConfig(env({ SESSION_TTL_HOURS: '48' }));
    expect(config.auth.sessionTtlHours).toBe(48);
  });

  it.each(['0', '-1', '1.5', 'abc', '721'])('rejects invalid SESSION_TTL_HOURS %s', (value) => {
    expect(() => createConfig(env({ SESSION_TTL_HOURS: value }))).toThrow(ConfigError);
  });

  it('defaults COOKIE_SECURE to false when unset', () => {
    const config = createConfig(env());
    expect(config.auth.cookieSecure).toBe(false);
  });

  it('parses COOKIE_SECURE=true', () => {
    const config = createConfig(env({ COOKIE_SECURE: 'true' }));
    expect(config.auth.cookieSecure).toBe(true);
  });

  it.each(['yes', '1', 'TRUE-ish', 'nope'])('rejects an ambiguous COOKIE_SECURE %s', (value) => {
    expect(() => createConfig(env({ COOKIE_SECURE: value }))).toThrow(ConfigError);
  });

  it('parses TRUST_PROXY=true', () => {
    const config = createConfig(env({ TRUST_PROXY: 'true' }));
    expect(config.auth.trustProxy).toBe(true);
  });

  it.each(['yes', '1', 'proxy'])('rejects ambiguous TRUST_PROXY %s', (value) => {
    expect(() => createConfig(env({ TRUST_PROXY: value }))).toThrow(ConfigError);
  });

  it('parses HSTS_ENABLED=true independently of COOKIE_SECURE', () => {
    const config = createConfig(env({ HSTS_ENABLED: 'true', COOKIE_SECURE: 'false' }));
    expect(config.auth.hstsEnabled).toBe(true);
    expect(config.auth.cookieSecure).toBe(false);
  });

  it.each(['yes', '1', 'always'])('rejects ambiguous HSTS_ENABLED %s', (value) => {
    expect(() => createConfig(env({ HSTS_ENABLED: value }))).toThrow(ConfigError);
  });

  it('never leaks the configured secrets in the ConfigError message', () => {
    try {
      createConfig(env({ SESSION_SECRET: 'short' }));
      throw new Error('expected ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message).not.toContain('short');
      expect(err.message).not.toContain(VALID_PASSWORD_HASH);
    }
  });
});
