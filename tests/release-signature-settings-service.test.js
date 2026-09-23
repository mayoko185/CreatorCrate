import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import {
  createReleaseSignatureSettingsService,
  RELEASE_SIGNATURES_KEY,
  ReleaseSignatureIntegrityError,
  ReleaseSignatureValidationError,
} from '../src/services/release-signature-settings-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('release signature settings service', () => {
  let dir;
  let db;
  let repository;
  let service;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-signatures-'));
    db = openDatabase(path.join(dir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    repository = createAppMetaRepository(db);
    service = createReleaseSignatureSettingsService({ db, appMetaRepository: repository });
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty and persists additions, stable edits, and authoritative order', () => {
    expect(service.getConfiguration()).toEqual({ version: 1, entries: [], defaultId: null });
    const first = service.add({ name: ' Standard ', body: '  line one\r\nline two  ' });
    expect(first.defaultId).toBeNull();
    const firstId = first.entries[0].id;
    const second = service.add({ name: 'Short', body: '' });
    const secondId = second.entries[1].id;
    expect(second.entries.map(({ id }) => id)).toEqual([firstId, secondId]);
    service.edit(firstId, { name: 'Revised', body: '  revised\n' });
    service.reorder([secondId, firstId]);
    expect(createReleaseSignatureSettingsService({ db, appMetaRepository: repository }).getConfiguration())
      .toEqual({ version: 1, entries: [
        { id: secondId, name: 'Short', body: '' },
        { id: firstId, name: 'Revised', body: '  revised\n' },
      ], defaultId: null });
  });

  it('sets and clears default, and deletion clears only the selected default', () => {
    const firstId = service.add({ name: 'First', body: 'one' }).entries[0].id;
    const secondId = service.add({ name: 'Second', body: 'two' }).entries[1].id;
    expect(service.setDefault(firstId).defaultId).toBe(firstId);
    expect(service.delete(secondId).defaultId).toBe(firstId);
    expect(service.delete(firstId).defaultId).toBeNull();
    const thirdId = service.add({ name: 'Third', body: 'three' }).entries[0].id;
    expect(service.setDefault(thirdId).defaultId).toBe(thirdId);
    expect(service.setDefault(null).defaultId).toBeNull();
  });

  it('rejects invalid mutations without replacing the stored document', () => {
    const ids = [service.add({ name: 'First', body: 'one' }).entries[0].id];
    ids.push(service.add({ name: 'Second', body: 'two' }).entries[1].id);
    const stored = repository.getValue(RELEASE_SIGNATURES_KEY);
    for (const order of [[ids[0]], [ids[0], ids[0]], [ids[0], 'unknown']]) {
      expect(() => service.reorder(order)).toThrow(ReleaseSignatureValidationError);
    }
    expect(() => service.setDefault('00000000-0000-4000-8000-000000000000'))
      .toThrow(ReleaseSignatureValidationError);
    expect(() => service.edit(ids[0], { name: 'Changed', body: 123 }))
      .toThrow(ReleaseSignatureValidationError);
    expect(() => service.add({ name: ' ', body: 'bad' })).toThrow(ReleaseSignatureValidationError);
    expect(() => service.add({ name: 'Too long', body: 'x'.repeat(4001) }))
      .toThrow(ReleaseSignatureValidationError);
    expect(repository.getValue(RELEASE_SIGNATURES_KEY)).toBe(stored);
  });

  it('rejects malformed stored documents without silently resetting them', () => {
    const malformed = [
      '{bad',
      JSON.stringify({ version: 2, entries: [], defaultId: null }),
      JSON.stringify({ version: 1, entries: [{ id: 'bad', name: 'Bad', body: '' }], defaultId: null }),
      JSON.stringify({ version: 1, entries: [
        { id: '00000000-0000-4000-8000-000000000000', name: 'One', body: '' },
        { id: '00000000-0000-4000-8000-000000000000', name: 'Two', body: '' },
      ], defaultId: null }),
      JSON.stringify({ version: 1, entries: [], defaultId: '00000000-0000-4000-8000-000000000000' }),
    ];
    for (const value of malformed) {
      repository.setValue(RELEASE_SIGNATURES_KEY, value);
      expect(() => service.getConfiguration()).toThrow(ReleaseSignatureIntegrityError);
      expect(() => service.add({ name: 'Valid', body: '' })).toThrow(ReleaseSignatureIntegrityError);
      expect(repository.getValue(RELEASE_SIGNATURES_KEY)).toBe(value);
    }
  });
});
