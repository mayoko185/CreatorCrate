import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, closeDatabase } from '../src/db.js';
import { createAppMetaRepository } from '../src/data/app-meta-repository.js';
import { PAGE_DEFAULT_DEFINITIONS } from '../src/services/page-defaults-service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

describe('app meta repository for page defaults', () => {
  let tmpDir;
  let db;
  let repository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-page-default-repository-'));
    db = openDatabase(path.join(tmpDir, 'test.db'));
    runMigrations(db, MIGRATIONS_DIR);
    repository = createAppMetaRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined for a missing saved value', () => {
    expect(repository.getValue(PAGE_DEFAULT_DEFINITIONS.projects.view.key)).toBeUndefined();
  });

  it('saves and replaces a value by key', () => {
    const key = PAGE_DEFAULT_DEFINITIONS.projects.view.key;

    expect(repository.setValue(key, 'list')).toBe('list');
    expect(repository.setValue(key, 'grid')).toBe('grid');
    expect(repository.getValue(key)).toBe('grid');
    expect(db.prepare('SELECT COUNT(*) AS count FROM app_meta WHERE key = ?').get(key).count).toBe(1);
  });

  it('leaves unrelated app_meta keys untouched', () => {
    repository.setValue('unrelated.preference', 'preserve-me');

    repository.setValue(PAGE_DEFAULT_DEFINITIONS.publishedWork.sort.key, 'title');

    expect(repository.getValue('unrelated.preference')).toBe('preserve-me');
    expect(repository.getValue('asset_browser.default_category')).toBe('all');
  });
});
