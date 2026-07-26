import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfig } from '../src/config.js';
import { validateMounts, FilesystemError } from '../src/filesystem.js';

function makeConfig(tmpDir, overrides = {}) {
  const appRoot = path.join(tmpDir, 'app');
  const projectsRoot = path.join(tmpDir, 'projects');
  const dbDir = path.join(appRoot, 'db');
  return createConfig({
    APP_DATA_ROOT: appRoot,
    PROJECTS_ROOT: projectsRoot,
    DATABASE_PATH: path.join(dbDir, 'creatorcrate.db'),
    ...overrides,
  });
}

describe('validateMounts', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes for valid writable directories', () => {
    const config = makeConfig(tmpDir);
    fs.mkdirSync(path.join(config.appDataRoot), { recursive: true });
    fs.mkdirSync(path.join(config.projectsRoot), { recursive: true });
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
    expect(() => validateMounts(config)).not.toThrow();
  });

  it('fails when app data root is missing', () => {
    const config = makeConfig(tmpDir);
    fs.mkdirSync(config.projectsRoot, { recursive: true });
    expect(() => validateMounts(config)).toThrow(FilesystemError);
  });

  it('fails when app data root is a file', () => {
    const config = makeConfig(tmpDir);
    fs.mkdirSync(config.projectsRoot, { recursive: true });
    fs.writeFileSync(config.appDataRoot, 'not a directory');
    expect(() => validateMounts(config)).toThrow(FilesystemError);
  });

  it('fails when projects root is missing', () => {
    const config = makeConfig(tmpDir);
    fs.mkdirSync(config.appDataRoot, { recursive: true });
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
    expect(() => validateMounts(config)).toThrow(FilesystemError);
  });

  it('fails when database parent is missing', () => {
    const config = makeConfig(tmpDir);
    fs.mkdirSync(config.appDataRoot, { recursive: true });
    fs.mkdirSync(config.projectsRoot, { recursive: true });
    expect(() => validateMounts(config)).toThrow(FilesystemError);
  });

  it('fails when database parent is a file', () => {
    const config = makeConfig(tmpDir);
    fs.mkdirSync(config.appDataRoot, { recursive: true });
    fs.mkdirSync(config.projectsRoot, { recursive: true });
    fs.writeFileSync(path.dirname(config.databasePath), 'not a directory');
    expect(() => validateMounts(config)).toThrow(FilesystemError);
  });

  it('fails for unwritable directory when the test environment supports it', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      // Permission checks are unreliable as root and on Windows.
      return;
    }
    const config = makeConfig(tmpDir);
    fs.mkdirSync(config.appDataRoot, { recursive: true, mode: 0o555 });
    fs.mkdirSync(config.projectsRoot, { recursive: true });
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
    expect(() => validateMounts(config)).toThrow(FilesystemError);
  });
});
