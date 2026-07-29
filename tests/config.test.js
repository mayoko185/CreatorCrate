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
  it('uses defaults when environment is empty', () => {
    const config = createConfig({});
    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.appName).toBe('CreatorCrate');
    expect(config.appDataRoot).toBe(path.resolve('./data/app'));
    expect(config.projectsRoot).toBe(path.resolve('./data/projects'));
    expect(config.databasePath).toBe(path.resolve('./data/app/creatorcrate.db'));
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
});
