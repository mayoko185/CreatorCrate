import { describe, it, expect } from 'vitest';
import { createConfig, ConfigError } from '../src/config.js';
import path from 'node:path';

function env(overrides = {}) {
  return {
    NODE_ENV: 'development',
    PORT: '3000',
    APP_NAME: 'CreatorCrate',
    APP_DATA_ROOT: './data/app',
    PROJECTS_ROOT: './data/projects',
    DATABASE_PATH: './data/app/creatorcrate.db',
    ...overrides,
  };
}

describe('createConfig', () => {
  it('uses defaults when environment is otherwise empty', () => {
    const config = createConfig({});
    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.appName).toBe('CreatorCrate');
    expect(config.appDataRoot).toBe(path.resolve('./data/app'));
    expect(config.projectsRoot).toBe(path.resolve('./data/projects'));
    expect(config.databasePath).toBe(path.resolve('./data/app/creatorcrate.db'));
  });

  // Phase 13: authentication is optional and browser-managed — an empty
  // environment (no CREATORCRATE_USERNAME/CREATORCRATE_PASSWORD_HASH/
  // SESSION_SECRET, all removed as normal settings) must start successfully,
  // not fail. This replaces the old "fails startup when no authentication
  // configuration is provided" contract, which asserted the obsolete
  // mandatory-environment-auth requirement.
  it('starts successfully with no authentication configuration provided', () => {
    expect(() => createConfig({})).not.toThrow();
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

  // ─── Automatic scan interval (deployment-controlled, scheduler deferred) ──

  it('disables automatic scanning when AUTO_SCAN_INTERVAL_MINUTES is absent', () => {
    const config = createConfig(env());
    expect(config.autoScanIntervalMinutes).toBeNull();
  });

  it('disables automatic scanning when AUTO_SCAN_INTERVAL_MINUTES is empty', () => {
    const config = createConfig(env({ AUTO_SCAN_INTERVAL_MINUTES: '' }));
    expect(config.autoScanIntervalMinutes).toBeNull();
  });

  it('parses a positive AUTO_SCAN_INTERVAL_MINUTES value as a number', () => {
    const config = createConfig(env({ AUTO_SCAN_INTERVAL_MINUTES: '15' }));
    expect(config.autoScanIntervalMinutes).toBe(15);
  });

  it('accepts the largest AUTO_SCAN_INTERVAL_MINUTES value within Node timer limits', () => {
    const config = createConfig(env({ AUTO_SCAN_INTERVAL_MINUTES: '35791' }));
    expect(config.autoScanIntervalMinutes).toBe(35791);
  });

  it('rejects AUTO_SCAN_INTERVAL_MINUTES above Node timer limits', () => {
    expect(() => createConfig(env({ AUTO_SCAN_INTERVAL_MINUTES: '35792' }))).toThrow(ConfigError);
  });

  it.each(['0', '-1', '1.5', 'abc', '01', '+15', ' 15', '15 '])(
    'rejects invalid AUTO_SCAN_INTERVAL_MINUTES %s',
    (value) => {
      expect(() => createConfig(env({ AUTO_SCAN_INTERVAL_MINUTES: value }))).toThrow(ConfigError);
    }
  );

  // ─── Authentication settings (Phase 13: optional, browser-managed) ────
  // Identity (username/password hash) and the session secret are no longer
  // environment configuration at all — see src/auth/auth-state.js and
  // src/auth/credential-provider.js. config.auth is settings-only.

  it('parses auth settings with conservative defaults and no identity fields', () => {
    const config = createConfig(env());
    expect(config.auth.sessionTtlHours).toBe(24);
    expect(config.auth.cookieSecure).toBe(false);
    expect(config.auth.trustProxy).toBe(false);
    expect(config.auth.hstsEnabled).toBe(false);
    expect(config.auth.managedCredentialPath).toBe(path.join(config.appDataRoot, 'operator-credential.json'));
    expect(Object.isFrozen(config.auth)).toBe(true);
    expect(config.auth.username).toBeUndefined();
    expect(config.auth.passwordHash).toBeUndefined();
    expect(config.auth.sessionSecret).toBeUndefined();
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

  // The old "never leaks configured secrets in the ConfigError message" test
  // is removed, not just updated: it existed only because
  // CREATORCRATE_PASSWORD_HASH/SESSION_SECRET used to pass through
  // createConfig. Neither does anymore (Phase 13) — there is no longer a
  // secret for this module to leak.
});
