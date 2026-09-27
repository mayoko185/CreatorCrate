import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATION = '042_add_project_directory_ownership.sql';
const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

function createPreMigrationsDir(parentDir) {
  const legacyDir = path.join(parentDir, 'pre-042-migrations');
  fs.mkdirSync(legacyDir);
  for (const filename of fs.readdirSync(MIGRATIONS_DIR)) {
    if (filename < MIGRATION) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, filename), path.join(legacyDir, filename));
    }
  }
  return legacyDir;
}

function insertProject(db, slug) {
  return Number(db.prepare(`
    INSERT INTO projects (title, slug, status, project_type) VALUES (?, ?, 'tbd', 'images')
  `).run(slug, slug).lastInsertRowid);
}

describe('project directory ownership migration', () => {
  let db;
  let tmpDir;

  afterEach(() => {
    closeDatabase(db);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds an empty table to an existing database without filesystem work or backfill', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-ownership-migration-'));
    db = openDatabase(path.join(tmpDir, 'legacy.sqlite'));
    runMigrations(db, createPreMigrationsDir(tmpDir));

    const projectId = insertProject(db, 'existing-project');
    // A project_dir that does not exist: the migration must not touch it.
    db.prepare('UPDATE projects SET project_dir = ? WHERE id = ?').run('000001-existing-project', projectId);
    const projectBefore = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);

    runMigrations(db, MIGRATIONS_DIR);
    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId)).toEqual(projectBefore);
    expect(db.prepare('SELECT COUNT(*) FROM project_directory_ownership').pluck().get()).toBe(0);
    expect(db.prepare('SELECT filename FROM schema_migrations WHERE filename = ?').pluck().get(MIGRATION))
      .toBe(MIGRATION);
    expect(fs.readdirSync(tmpDir).filter((name) => !name.startsWith('legacy.sqlite')))
      .toEqual(['pre-042-migrations']);
  });

  it('creates the key, cascading foreign key, and value constraints', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-ownership-migration-'));
    db = openDatabase(path.join(tmpDir, 'test.sqlite'));
    runMigrations(db, MIGRATIONS_DIR);

    const columns = db.prepare('PRAGMA table_info(project_directory_ownership)').all();
    expect(columns.map(({ name, pk, notnull }) => ({ name, pk, notnull }))).toEqual([
      { name: 'project_id', pk: 1, notnull: 0 },
      { name: 'token', pk: 0, notnull: 1 },
      { name: 'state', pk: 0, notnull: 1 },
    ]);
    expect(db.prepare('PRAGMA foreign_key_list(project_directory_ownership)').all()
      .map(({ table, from, to, on_delete: onDelete }) => ({ table, from, to, onDelete })))
      .toEqual([{ table: 'projects', from: 'project_id', to: 'id', onDelete: 'CASCADE' }]);

    const first = insertProject(db, 'first');
    const second = insertProject(db, 'second');
    const insert = (projectId, token, state) => db.prepare(`
      INSERT INTO project_directory_ownership (project_id, token, state) VALUES (?, ?, ?)
    `).run(projectId, token, state);

    expect(() => insert(first, TOKEN_A, 'adopted')).toThrow(/CHECK/);
    expect(() => insert(first, 'A'.repeat(64), 'pending')).toThrow(/CHECK/);
    expect(() => insert(first, 'a'.repeat(63), 'pending')).toThrow(/CHECK/);
    expect(() => insert(first, `${'a'.repeat(63)}g`, 'pending')).toThrow(/CHECK/);
    expect(() => insert(first + 100, TOKEN_A, 'pending')).toThrow(/FOREIGN KEY/);

    insert(first, TOKEN_A, 'pending');
    insert(second, TOKEN_B, 'bound');
    expect(() => insert(first, TOKEN_B.replace(/^b/, 'c'), 'bound')).toThrow(/UNIQUE|PRIMARY KEY/);
    const third = insertProject(db, 'third');
    expect(() => insert(third, TOKEN_A, 'pending')).toThrow(/UNIQUE/);

    db.prepare('DELETE FROM projects WHERE id = ?').run(first);
    expect(db.prepare('SELECT project_id FROM project_directory_ownership ORDER BY project_id').pluck().all())
      .toEqual([second]);
  });
});
