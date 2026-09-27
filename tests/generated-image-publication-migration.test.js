import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATION = '041_add_generated_image_publications.sql';
const TABLES = [
  'generated_image_publications',
  'generated_image_derivatives',
  'generated_image_publication_intents',
];

function createPreMigrationsDir(parentDir) {
  const legacyDir = path.join(parentDir, 'pre-041-migrations');
  fs.mkdirSync(legacyDir);
  for (const filename of fs.readdirSync(MIGRATIONS_DIR)) {
    if (filename < MIGRATION) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(legacyDir, filename));
    }
  }
  return legacyDir;
}

describe('generated-image publication migration', () => {
  let db;
  let tmpDir;

  afterEach(() => {
    closeDatabase(db);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds empty publication tables to an existing database without touching assets', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-generated-publication-'));
    db = openDatabase(path.join(tmpDir, 'legacy.sqlite'));
    runMigrations(db, createPreMigrationsDir(tmpDir));

    const projectId = Number(db.prepare(`
      INSERT INTO projects (title, slug, description, notes, status, project_type)
      VALUES ('Migration project', 'migration-project', '', '', 'tbd', 'images')
    `).run().lastInsertRowid);
    const assetId = Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename, extension, mime_type, size_bytes, modified_at)
      VALUES (?, 'art.png', 'art.png', 'png', 'image/png', 4096, '2026-07-28T12:00:00.000Z')
    `).run(projectId).lastInsertRowid);
    const projectBefore = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    const assetBefore = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);

    // No preview/project roots exist here: the migration must not need them.
    runMigrations(db, MIGRATIONS_DIR);
    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)).toEqual(projectBefore);
    expect(db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId)).toEqual(assetBefore);
    for (const table of TABLES) {
      expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0);
    }
    expect(db.prepare('SELECT filename FROM schema_migrations WHERE filename = ?').pluck().get(MIGRATION))
      .toBe(MIGRATION);
  });

  it('creates keys, ownership foreign keys, and value constraints', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-generated-publication-'));
    db = openDatabase(path.join(tmpDir, 'test.sqlite'));
    runMigrations(db, MIGRATIONS_DIR);

    const keys = (table) => db.prepare(`PRAGMA table_info(${table})`).all()
      .filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    expect(keys('generated_image_publications')).toEqual(['asset_id']);
    expect(keys('generated_image_derivatives')).toEqual(['asset_id', 'kind']);
    expect(keys('generated_image_publication_intents')).toEqual(['asset_id']);

    const foreignKeys = (table) => db.prepare(`PRAGMA foreign_key_list(${table})`).all()
      .map(({ table: parent, from, to, on_delete: onDelete }) => ({ parent, from, to, onDelete }));
    expect(foreignKeys('generated_image_publications')).toEqual(expect.arrayContaining([
      { parent: 'assets', from: 'project_id', to: 'project_id', onDelete: 'CASCADE' },
      { parent: 'assets', from: 'asset_id', to: 'id', onDelete: 'CASCADE' },
    ]));
    expect(foreignKeys('generated_image_derivatives')).toEqual([
      { parent: 'generated_image_publications', from: 'asset_id', to: 'asset_id', onDelete: 'CASCADE' },
    ]);
    expect(foreignKeys('generated_image_publication_intents')).toEqual(expect.arrayContaining([
      { parent: 'assets', from: 'project_id', to: 'project_id', onDelete: 'CASCADE' },
      { parent: 'assets', from: 'asset_id', to: 'id', onDelete: 'CASCADE' },
    ]));

    const projectId = Number(db.prepare(`
      INSERT INTO projects (title, slug, status, project_type) VALUES ('Constraint project', 'constraint-project', 'tbd', 'images')
    `).run().lastInsertRowid);
    const assetId = Number(db.prepare(`
      INSERT INTO assets (project_id, relative_path, filename) VALUES (?, 'a.png', 'a.png')
    `).run(projectId).lastInsertRowid);
    const insertPublication = (overrides = {}) => {
      const row = {
        asset_id: assetId, project_id: projectId, directory_name: 'r-0123456789abcdef-a1b2c3d4',
        revision: '0123456789abcdef', generated_at: '2026-09-26T00:00:00.000Z',
        cache_schema_version: 1, derivative_config_version: 1, source_relative_path: 'a.png',
        source_size_bytes: 10, source_mtime: '2026-09-26T00:00:00.000Z', source_generation: 0,
        ...overrides,
      };
      const columns = Object.keys(row);
      return db.prepare(`INSERT INTO generated_image_publications (${columns.join(', ')})
        VALUES (${columns.map((column) => `@${column}`).join(', ')})`).run(row);
    };
    expect(() => insertPublication({ directory_name: 'r-fedcba9876543210-a1b2c3d4' })).toThrow(/CHECK/);
    expect(() => insertPublication({ directory_name: '../r-0123456789abcdef-a1' })).toThrow(/CHECK/);
    expect(() => insertPublication({ source_generation: -1 })).toThrow(/CHECK/);
    expect(() => insertPublication({ animated: 2 })).toThrow(/CHECK/);
    expect(() => insertPublication({ source_preview_quality: 'full' })).toThrow(/CHECK/);
    expect(() => insertPublication({ project_id: projectId + 1 })).toThrow(/FOREIGN KEY/);
    insertPublication();

    const insertDerivative = (kind, overrides = {}) => db.prepare(`
      INSERT INTO generated_image_derivatives (asset_id, kind, format, width, height, size_bytes)
      VALUES (@asset_id, @kind, @format, @width, @height, @size_bytes)
    `).run({ asset_id: assetId, kind, format: 'webp', width: 10, height: 10, size_bytes: 1, ...overrides });
    expect(() => insertDerivative('original')).toThrow(/CHECK/);
    expect(() => insertDerivative('thumbnail', { format: 'jpeg' })).toThrow(/CHECK/);
    expect(() => insertDerivative('thumbnail', { width: 0 })).toThrow(/CHECK/);
    expect(() => insertDerivative('thumbnail', { size_bytes: -1 })).toThrow(/CHECK/);
    insertDerivative('thumbnail');
    expect(() => insertDerivative('thumbnail')).toThrow(/UNIQUE|PRIMARY KEY/);
  });
});
