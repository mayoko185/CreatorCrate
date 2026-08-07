/**
 * Tests for the Open locally settings service.
 *
 * The service stores the configured Windows projects root in app_meta and
 * validates its shape only — the app runs in Docker/Linux, so existence on a
 * Windows machine can never be verified here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import {
  createOpenLocallySettingsService,
  OpenLocallySettingsValidationError,
  OPEN_LOCALLY_WINDOWS_PROJECTS_PATH_KEY,
} from '../src/services/open-locally-settings-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('open locally settings service', () => {
  let tmpDir;
  let db;
  let repository;
  let service;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-open-locally-settings-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    repository = createAppMetaRepository(db);
    service = createOpenLocallySettingsService({ appMetaRepository: repository });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no windows projects path is configured', () => {
    expect(service.getWindowsProjectsPath()).toBeNull();
  });

  it('saves and retrieves the windows projects path in app_meta', () => {
    const stored = service.setWindowsProjectsPath('D:\\example');
    expect(stored).toBe('D:\\example');
    expect(repository.getValue(OPEN_LOCALLY_WINDOWS_PROJECTS_PATH_KEY)).toBe('D:\\example');
    expect(service.getWindowsProjectsPath()).toBe('D:\\example');
  });

  it('overwrites an existing value', () => {
    service.setWindowsProjectsPath('D:\\example');
    service.setWindowsProjectsPath('D:\\Proyectos');
    expect(service.getWindowsProjectsPath()).toBe('D:\\Proyectos');
  });

  it('normalizes trailing separators on save and retrieval', () => {
    expect(service.setWindowsProjectsPath('D:\\example\\')).toBe('D:\\example');
    expect(service.setWindowsProjectsPath('D:/example/')).toBe('D:\\example');
    expect(service.getWindowsProjectsPath()).toBe('D:\\example');
  });

  it('clears the mapping', () => {
    service.setWindowsProjectsPath('D:\\example');
    expect(service.clearWindowsProjectsPath()).toBe(true);
    expect(service.getWindowsProjectsPath()).toBeNull();
    expect(service.clearWindowsProjectsPath()).toBe(false);
  });

  it('accepts a lowercase drive letter and unicode path', () => {
    expect(service.setWindowsProjectsPath('n:\\ai project files\\€ Studios')).toBe('n:\\ai project files\\€ Studios');
    expect(service.getWindowsProjectsPath()).toBe('n:\\ai project files\\€ Studios');
  });

  it('rejects empty and non-string values', () => {
    for (const value of ['', '   ', undefined, null, 42, {}]) {
      expect(() => service.setWindowsProjectsPath(value)).toThrow(OpenLocallySettingsValidationError);
    }
  });

  it('rejects relative paths', () => {
    for (const value of ['example', 'foo/bar', '\\foo', '/foo']) {
      expect(() => service.setWindowsProjectsPath(value)).toThrow(OpenLocallySettingsValidationError);
    }
  });

  it('rejects drive-relative paths', () => {
    for (const value of ['C:foo', 'c:foo', 'C:']) {
      expect(() => service.setWindowsProjectsPath(value)).toThrow(OpenLocallySettingsValidationError);
    }
  });

  it('rejects the bare drive root, which would normalize to a non-absolute value', () => {
    // "C:\" passes the drive-letter shape check but normalizes to "C:",
    // which is no longer an absolute Windows path and can never be composed
    // into a valid "Open locally" URI.
    for (const value of ['C:\\', 'C:/', 'c:\\', 'c:/']) {
      expect(() => service.setWindowsProjectsPath(value)).toThrow(OpenLocallySettingsValidationError);
    }
  });

  it('rejects UNC paths', () => {
    for (const value of ['\\\\server\\share', '//server/share', '\\\\server']) {
      expect(() => service.setWindowsProjectsPath(value)).toThrow(OpenLocallySettingsValidationError);
    }
  });

  it('rejects device paths', () => {
    for (const value of ['\\\\?\\C:\\foo', '\\\\.\\C:\\foo', '//?/C:/foo']) {
      expect(() => service.setWindowsProjectsPath(value)).toThrow(OpenLocallySettingsValidationError);
    }
  });

  it('rejects traversal segments', () => {
    for (const value of ['N:\\AI\\..\\Project Files', 'D:\\example\\..', 'N:\\.\\example']) {
      expect(() => service.setWindowsProjectsPath(value)).toThrow(OpenLocallySettingsValidationError);
    }
  });

  it('rejects control characters and null bytes', () => {
    expect(() => service.setWindowsProjectsPath('N:\\AI\u0007Project')).toThrow(OpenLocallySettingsValidationError);
    expect(() => service.setWindowsProjectsPath('N:\\AI\u0000Project')).toThrow(OpenLocallySettingsValidationError);
    expect(() => service.setWindowsProjectsPath('N:\\AI\tProject')).toThrow(OpenLocallySettingsValidationError);
  });

  it('rejects alternate data stream syntax', () => {
    for (const value of ['D:\\example:stream', 'N:\\folder:name\\example']) {
      expect(() => service.setWindowsProjectsPath(value)).toThrow(OpenLocallySettingsValidationError);
    }
  });

  it('requires an appMetaRepository dependency', () => {
    expect(() => createOpenLocallySettingsService({})).toThrow(
      'createOpenLocallySettingsService requires an appMetaRepository dependency.'
    );
  });
});
