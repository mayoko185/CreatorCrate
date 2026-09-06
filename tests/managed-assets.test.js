import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';
import { createManagedAssetRepository } from '../src/data/managed-asset-repository.js';
import { createBookPrimaryImageRepository } from '../src/data/book-primary-image-repository.js';

const migrations = fileURLToPath(new URL('../migrations', import.meta.url));
const migration = '029_add_managed_assets.sql';
const record = (overrides = {}) => ({
  id: randomUUID(), storageKey: `book-covers/${randomUUID()}/source.png`,
  namespace: 'book-covers', mimeType: 'image/png', sizeBytes: 123,
  width: 10, height: 20, sha256: 'a'.repeat(64), ...overrides,
});

describe('managed assets foundation', () => {
  let db;
  let tmp;
  beforeEach(() => { db = openDatabase(':memory:'); });
  afterEach(() => {
    closeDatabase(db);
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  function legacyDatabase() {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-managed-assets-'));
    closeDatabase(db);
    db = openDatabase(path.join(tmp, 'existing.db'));
    for (const file of fs.readdirSync(migrations)) {
      if (file.endsWith('.sql') && file < migration) {
        fs.copyFileSync(path.join(migrations, file), path.join(tmp, file));
      }
    }
    runMigrations(db, tmp);
    db.exec(`
      INSERT INTO books (id, title, sort_order) VALUES (1, 'One', 0), (2, 'Two', 1), (3, 'Three', 2);
      INSERT INTO projects (id, title, slug, status) VALUES (1, 'Existing', 'existing', 'ready');
      INSERT INTO assets (id, project_id, relative_path, filename)
        VALUES (1, 1, 'cover.png', 'cover.png'), (2, 1, 'other.png', 'other.png');
      INSERT INTO book_primary_images (book_id, asset_id) VALUES (1, 1), (2, 1), (3, 2);
    `);
  }

  it('upgrades all existing covers unchanged, preserves indexes and legacy repository operations', () => {
    legacyDatabase();
    const covers = db.prepare('SELECT * FROM book_primary_images ORDER BY book_id').all();
    const assets = db.prepare('SELECT * FROM assets ORDER BY id').all();
    const books = db.prepare('SELECT * FROM books ORDER BY id').all();
    closeDatabase(db);
    db = openDatabase(path.join(tmp, 'existing.db'));
    runMigrations(db, migrations);
    expect(db.prepare('SELECT * FROM book_primary_images ORDER BY book_id').all())
      .toEqual(covers.map((row) => ({ ...row, managed_asset_id: null })));
    expect(db.prepare('SELECT * FROM assets ORDER BY id').all()).toEqual(assets);
    expect(db.prepare('SELECT * FROM books ORDER BY id').all()).toEqual(books);
    expect(db.prepare('SELECT * FROM managed_assets').all()).toEqual([]);
    expect(db.pragma('index_list(book_primary_images)').map((row) => row.name))
      .toEqual(expect.arrayContaining(['idx_book_primary_images_asset_id', 'idx_book_primary_images_managed_asset_id']));
    const repo = createBookPrimaryImageRepository(db);
    expect(repo.setPrimaryImage(1, 2)).toEqual({
      book_id: 1, asset_id: 2, managed_asset_id: null, source: { kind: 'project_asset', id: 2 },
    });
    expect(repo.clearPrimaryImageIfMatches(1, 2)).toBe(true);
    db.exec('DELETE FROM assets WHERE id = 1; DELETE FROM books WHERE id = 3;');
    expect(db.prepare('SELECT * FROM book_primary_images').all()).toEqual([]);
    runMigrations(db, migrations);
    expect(db.prepare('SELECT count(*) FROM schema_migrations WHERE filename = ?').pluck().get(migration)).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('rolls back the rebuild when existing references violate FK integrity', () => {
    legacyDatabase();
    db.pragma('foreign_keys = OFF');
    db.exec('UPDATE book_primary_images SET asset_id = 999 WHERE book_id = 1');
    db.pragma('foreign_keys = ON');
    expect(() => runMigrations(db, migrations)).toThrow(/029_add_managed_assets/);
    expect(db.pragma('table_info(book_primary_images)').map((row) => row.name)).toEqual(['book_id', 'asset_id']);
    expect(db.prepare('SELECT count(*) FROM schema_migrations WHERE filename = ?').pluck().get(migration)).toBe(0);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('enforces exactly one source and FKs while retaining unreferenced managed originals', () => {
    legacyDatabase();
    runMigrations(db, migrations);
    const repo = createManagedAssetRepository(db);
    const managed = repo.insertCommitted(record());
    const update = db.prepare('UPDATE book_primary_images SET asset_id = ?, managed_asset_id = ? WHERE book_id = 1');
    expect(() => update.run(null, null)).toThrow(/CHECK/);
    expect(() => update.run(1, managed.id)).toThrow(/CHECK/);
    expect(() => update.run(null, 'missing')).toThrow(/FOREIGN KEY/);
    expect(() => update.run(999, null)).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare('INSERT INTO book_primary_images (book_id, managed_asset_id) VALUES (999, ?)').run(managed.id)).toThrow(/FOREIGN KEY/);
    update.run(null, managed.id);
    expect(repo.isReferenced(managed.id)).toBe(true);
    expect(() => db.prepare('DELETE FROM managed_assets WHERE id = ?').run(managed.id)).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare('INSERT INTO book_primary_images (book_id, asset_id) VALUES (1, 1)').run()).toThrow(/UNIQUE/);
    db.exec('DELETE FROM books WHERE id = 1');
    expect(repo.isReferenced(managed.id)).toBe(false);
    expect(repo.findById(managed.id)).toEqual(managed);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('inserts and reads immutable metadata without any Project and supports caller rollback', () => {
    runMigrations(db, migrations);
    const repo = createManagedAssetRepository(db);
    const input = record();
    const saved = repo.insertCommitted(input);
    expect(saved).toEqual({ id: input.id, storage_key: input.storageKey, namespace: input.namespace,
      mime_type: input.mimeType, size_bytes: input.sizeBytes, width: 10, height: 20,
      sha256: input.sha256, created_at: expect.any(String) });
    expect(repo.findById(input.id)).toEqual(saved);
    expect(repo.findById('missing')).toBeUndefined();
    expect(repo.isReferenced(input.id)).toBe(false);
    expect(db.pragma('foreign_key_list(managed_assets)')).toEqual([]);
    expect(db.pragma('table_info(managed_assets)').map((row) => row.name)).not.toContain('project_id');
    expect(() => repo.insertCommitted(record({ id: input.id }))).toThrow(/UNIQUE/);
    expect(() => repo.insertCommitted(record({ storageKey: input.storageKey }))).toThrow(/UNIQUE/);
    // Equal content hashes do not imply equal identities or storage keys.
    expect(repo.insertCommitted(record()).sha256).toBe(input.sha256);
    const rolledBack = record();
    expect(() => db.transaction(() => { repo.insertCommitted(rolledBack); throw new Error('rollback'); })()).toThrow('rollback');
    expect(repo.findById(rolledBack.id)).toBeUndefined();
    expect(Object.keys(repo).sort()).toEqual(['findById', 'insertCommitted', 'isReferenced', 'rollbackCommitted']);
  });

  it('requires the original insertion result and preserves unrelated records', () => {
    runMigrations(db, migrations);
    const repo = createManagedAssetRepository(db);
    const saved = repo.insertCommitted(record());
    const unrelated = repo.insertCommitted(record());
    for (const wrong of [saved.id, {}, { ...saved }, repo.findById(saved.id), { ...saved, id: unrelated.id }]) {
      expect(repo.rollbackCommitted(wrong)).toBe(false);
    }
    expect(createManagedAssetRepository(db).rollbackCommitted(saved)).toBe(false);
    expect(repo.rollbackCommitted(saved)).toBe(true);
    expect(repo.rollbackCommitted(saved)).toBe(false);
    expect(repo.findById(saved.id)).toBeUndefined();
    expect(repo.findById(unrelated.id)).toEqual(unrelated);
  });

  it.each(['metadata', 'returned identity', 'identical replacement', 'restored metadata'])(
    'refuses rollback after %s changes', (change) => {
      runMigrations(db, migrations);
      const repo = createManagedAssetRepository(db);
      const saved = repo.insertCommitted(record());
      const original = { ...saved };
      if (change === 'returned identity') saved.id = 'other';
      else if (change === 'identical replacement') {
        // Adversarial replacement, not the supported rollback path.
        db.prepare(`INSERT OR REPLACE INTO managed_assets
          SELECT * FROM managed_assets WHERE id = ?`).run(saved.id);
      } else {
        db.prepare('UPDATE managed_assets SET width = width + 1 WHERE id = ?').run(saved.id);
        if (change === 'restored metadata') db.prepare('UPDATE managed_assets SET width = width - 1 WHERE id = ?').run(saved.id);
      }
      expect(repo.rollbackCommitted(saved)).toBe(false);
      expect(repo.findById(original.id)).toBeDefined();
    });

  it('refuses referenced records even when FK enforcement is disabled', () => {
    runMigrations(db, migrations);
    const repo = createManagedAssetRepository(db);
    const saved = repo.insertCommitted(record());
    db.exec("INSERT INTO books (id, title, sort_order) VALUES (1, 'Book', 0)");
    db.prepare('INSERT INTO book_primary_images (book_id, managed_asset_id) VALUES (1, ?)').run(saved.id);
    db.pragma('foreign_keys = OFF');
    expect(repo.rollbackCommitted(saved)).toBe(false);
    expect(repo.findById(saved.id)).toEqual(saved);
    expect(repo.isReferenced(saved.id)).toBe(true);
  });

  it('fails closed after another connection commits a replacement', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-managed-assets-'));
    closeDatabase(db);
    db = openDatabase(path.join(tmp, 'shared.db'));
    runMigrations(db, migrations);
    const repo = createManagedAssetRepository(db);
    const saved = repo.insertCommitted(record());
    const other = openDatabase(path.join(tmp, 'shared.db'));
    try {
      other.prepare('INSERT OR REPLACE INTO managed_assets SELECT * FROM managed_assets WHERE id = ?').run(saved.id);
      expect(repo.rollbackCommitted(saved)).toBe(false);
      expect(repo.findById(saved.id)).toEqual(saved);
    } finally { closeDatabase(other); }
  });

  it('does not authorize a later same-ID insertion using a rolled-back creation result', () => {
    runMigrations(db, migrations);
    const repo = createManagedAssetRepository(db);
    const input = record();
    let abandoned;
    expect(() => db.transaction(() => {
      abandoned = repo.insertCommitted(input);
      throw new Error('rollback');
    })()).toThrow('rollback');
    const saved = repo.insertCommitted(input);
    expect(repo.rollbackCommitted(abandoned)).toBe(false);
    expect(repo.findById(saved.id)).toEqual(saved);
    expect(repo.rollbackCommitted(saved)).toBe(true);
  });

  it.each([
    { storageKey: '../escape' }, { storageKey: '/absolute' }, { storageKey: 'C:/absolute' },
    { storageKey: 'book-covers\\file' }, { storageKey: 'book-covers/./file' },
    { namespace: 'project-assets' }, { sizeBytes: -1 }, { width: 0 }, { height: 1.5 },
    { sha256: 'invalid' }, { mimeType: '' }, { id: '' },
  ])('rejects invalid durable metadata %j', (invalid) => {
    runMigrations(db, migrations);
    expect(() => createManagedAssetRepository(db).insertCommitted(record(invalid))).toThrow(/CHECK/);
  });
});
