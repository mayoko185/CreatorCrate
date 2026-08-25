import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATION_FILENAME = '025_add_book_primary_images.sql';

function createPrePrimaryImageMigrationsDir(parentDir) {
  const legacyDir = path.join(parentDir, 'pre-book-primary-image-migrations');
  fs.mkdirSync(legacyDir);
  for (const filename of fs.readdirSync(MIGRATIONS_DIR)) {
    if (filename.endsWith('.sql') && filename.localeCompare(MIGRATION_FILENAME) < 0) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(legacyDir, filename));
    }
  }
  return legacyDir;
}

function insertBook(db, title, sortOrder) {
  return Number(db.prepare(`
    INSERT INTO books (title, sort_order)
    VALUES (?, ?)
  `).run(title, sortOrder).lastInsertRowid);
}

function insertAsset(db, relativePath) {
  const projectId = Number(db.prepare(`
    INSERT INTO projects (title, slug, status)
    VALUES (?, ?, 'ready')
  `).run(`Project for ${relativePath}`, `project-for-${relativePath.replaceAll('/', '-')}`).lastInsertRowid);
  const filename = path.basename(relativePath);
  return Number(db.prepare(`
    INSERT INTO assets (project_id, relative_path, filename)
    VALUES (?, ?, ?)
  `).run(projectId, relativePath, filename).lastInsertRowid);
}

describe('book primary-image migration (025_add_book_primary_images)', () => {
  let tmpDir;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-book-primary-image-migration-'));
  });

  afterEach(() => {
    closeDatabase(db);
    db = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds an empty reference-only table after migrations 001–024 without changing existing books or assets', () => {
    db = openDatabase(path.join(tmpDir, 'upgrade.db'));
    runMigrations(db, createPrePrimaryImageMigrationsDir(tmpDir));
    const firstBookId = insertBook(db, 'Existing First Book', 0);
    const secondBookId = insertBook(db, 'Existing Second Book', 1);
    const firstAssetId = insertAsset(db, 'existing/first.png');
    const secondAssetId = insertAsset(db, 'existing/second.png');
    const before = {
      books: db.prepare('SELECT * FROM books ORDER BY id').all(),
      assets: db.prepare('SELECT * FROM assets ORDER BY id').all(),
    };

    runMigrations(db, MIGRATIONS_DIR);

    expect(db.pragma("table_info('book_primary_images')")).toEqual([
      { cid: 0, name: 'book_id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
      { cid: 1, name: 'asset_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    ]);
    expect(db.pragma("foreign_key_list('book_primary_images')")).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'book_id', table: 'books', to: 'id', on_delete: 'CASCADE' }),
      expect.objectContaining({ from: 'asset_id', table: 'assets', to: 'id', on_delete: 'CASCADE' }),
    ]));
    expect(db.pragma("index_list('book_primary_images')")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'idx_book_primary_images_asset_id', unique: 0 }),
    ]));
    expect(db.prepare('SELECT * FROM book_primary_images').all()).toEqual([]);
    expect({
      books: db.prepare('SELECT * FROM books ORDER BY id').all(),
      assets: db.prepare('SELECT * FROM assets ORDER BY id').all(),
    }).toEqual(before);
    expect(db.prepare(`
      SELECT filename FROM schema_migrations WHERE filename = ?
    `).pluck().all(MIGRATION_FILENAME)).toEqual([MIGRATION_FILENAME]);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    expect(firstBookId).toBeGreaterThan(0);
    expect(secondBookId).toBeGreaterThan(0);
    expect(firstAssetId).toBeGreaterThan(0);
    expect(secondAssetId).toBeGreaterThan(0);
  });

  it('cascades hard deletes and the migration runner records 025 only once', () => {
    db = openDatabase(path.join(tmpDir, 'cascade.db'));
    runMigrations(db, MIGRATIONS_DIR);
    const firstBookId = insertBook(db, 'First Book', 0);
    const secondBookId = insertBook(db, 'Second Book', 1);
    const firstAssetId = insertAsset(db, 'covers/first.png');
    const secondAssetId = insertAsset(db, 'covers/second.png');
    const insertPrimaryImage = db.prepare(`
      INSERT INTO book_primary_images (book_id, asset_id)
      VALUES (?, ?)
    `);

    insertPrimaryImage.run(firstBookId, firstAssetId);
    insertPrimaryImage.run(secondBookId, firstAssetId);
    expect(db.prepare(`
      SELECT book_id, asset_id FROM book_primary_images ORDER BY book_id
    `).all()).toEqual([
      { book_id: firstBookId, asset_id: firstAssetId },
      { book_id: secondBookId, asset_id: firstAssetId },
    ]);

    db.prepare('DELETE FROM assets WHERE id = ?').run(firstAssetId);
    expect(db.prepare('SELECT COUNT(*) FROM book_primary_images').pluck().get()).toBe(0);

    insertPrimaryImage.run(firstBookId, secondAssetId);
    db.prepare('DELETE FROM books WHERE id = ?').run(firstBookId);
    expect(db.prepare(`
      SELECT COUNT(*) FROM book_primary_images WHERE book_id = ?
    `).pluck().get(firstBookId)).toBe(0);

    const recordedBeforeRerun = db.prepare(`
      SELECT filename, applied_at
      FROM schema_migrations
      WHERE filename = ?
    `).all(MIGRATION_FILENAME);
    runMigrations(db, MIGRATIONS_DIR);
    expect(db.prepare(`
      SELECT filename, applied_at
      FROM schema_migrations
      WHERE filename = ?
    `).all(MIGRATION_FILENAME)).toEqual(recordedBeforeRerun);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
