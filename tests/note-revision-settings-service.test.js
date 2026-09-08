import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import {
  createNoteRevisionSettingsService,
  DEFAULT_NOTE_REVISION_RETENTION,
  NOTE_REVISION_RETENTION_KEY,
  NoteRevisionSettingsValidationError,
} from '../src/services/note-revision-settings-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('Note revision settings service', () => {
  let tmpDir;
  let databasePath;
  let db;
  let repository;
  let service;

  function openService() {
    db = openDatabase(databasePath);
    runMigrations(db, MIGRATIONS_DIR);
    repository = createAppMetaRepository(db);
    service = createNoteRevisionSettingsService({ appMetaRepository: repository });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-note-revision-settings-'));
    databasePath = path.join(tmpDir, 'test.db');
    openService();
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the unsaved fallback and exposes that it is the default', () => {
    expect(service.getRevisionRetention()).toBe(DEFAULT_NOTE_REVISION_RETENTION);
    expect(service.getRevisionRetentionSetting()).toEqual({ value: 10, isDefault: true });
    expect(repository.getValue(NOTE_REVISION_RETENTION_KEY)).toBeUndefined();
  });

  it('stores a canonical positive integer and survives service and database reconstruction', () => {
    expect(service.setRevisionRetention('24')).toBe(24);
    expect(repository.getValue(NOTE_REVISION_RETENTION_KEY)).toBe('24');
    expect(createNoteRevisionSettingsService({ appMetaRepository: repository })
      .getRevisionRetentionSetting()).toEqual({ value: 24, isDefault: false });

    closeDatabase(db);
    openService();
    expect(service.getRevisionRetention()).toBe(24);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    '',
    ' ',
    '0',
    '-1',
    '1.5',
    'abc',
    String(Number.MAX_SAFE_INTEGER + 1),
    [],
    {},
  ])('rejects invalid retention %j without overwriting a prior valid value', (value) => {
    service.setRevisionRetention(7);
    expect(() => service.setRevisionRetention(value)).toThrow(NoteRevisionSettingsValidationError);
    expect(repository.getValue(NOTE_REVISION_RETENTION_KEY)).toBe('7');
    expect(service.getRevisionRetention()).toBe(7);
  });

  it('rejects a malformed persisted value rather than silently treating it as the default', () => {
    repository.setValue(NOTE_REVISION_RETENTION_KEY, 'broken');
    expect(() => service.getRevisionRetention()).toThrow(NoteRevisionSettingsValidationError);
  });

  it('requires the app_meta repository contract', () => {
    expect(() => createNoteRevisionSettingsService()).toThrow(
      'createNoteRevisionSettingsService requires an appMetaRepository dependency.',
    );
  });
});
