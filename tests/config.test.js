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
});
