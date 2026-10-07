import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDatabase, openDatabase, runMigrations } from '../src/db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
const MIGRATION = '045_add_processing_recovery_evidence.sql';

function createPreMigrationsDir(parentDir) {
  const legacyDir = path.join(parentDir, 'pre-045-migrations');
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

function insertAsset(db, projectId, relativePath) {
  return Number(db.prepare(`
    INSERT INTO assets (project_id, relative_path, filename) VALUES (?, ?, ?)
  `).run(projectId, relativePath, path.posix.basename(relativePath)).lastInsertRowid);
}

function insertGroup(db, groupId, projectId, overrides = {}) {
  const row = {
    group_id: groupId, project_id: projectId, operation: 'watermark', run_id: 'run-1', item_key: null,
    checkpoint: null, checkpoint_at: null, created_at: 't', updated_at: 't', ...overrides,
  };
  db.prepare(`
    INSERT INTO processing_recovery_mutation_groups
      (group_id, project_id, operation, run_id, item_key, checkpoint, checkpoint_at, created_at, updated_at)
    VALUES (@group_id, @project_id, @operation, @run_id, @item_key, @checkpoint, @checkpoint_at, @created_at, @updated_at)
  `).run(row);
}

function insertEvidence(db, evidenceId, groupId, projectId, overrides = {}) {
  const row = {
    evidence_id: evidenceId, project_id: projectId, mutation_group_id: groupId, asset_id: null,
    artifact_role: 'staged-output', retention_reason: 'rollback-unresolved',
    artifact_path: '.creatorcrate-watermark-staging/abc.out.png', source_path: null, destination_path: null,
    identity_dev: null, identity_ino: null, identity_birthtime_ns: null,
    expected_size: null, expected_sha256: null, lifecycle: 'intent', observation: 'unchecked',
    observed_at: null, created_at: 't', updated_at: 't', ...overrides,
  };
  db.prepare(`
    INSERT INTO processing_recovery_evidence (
      evidence_id, project_id, mutation_group_id, asset_id, artifact_role, retention_reason,
      artifact_path, source_path, destination_path, identity_dev, identity_ino, identity_birthtime_ns,
      expected_size, expected_sha256, lifecycle, observation, observed_at, created_at, updated_at
    ) VALUES (
      @evidence_id, @project_id, @mutation_group_id, @asset_id, @artifact_role, @retention_reason,
      @artifact_path, @source_path, @destination_path, @identity_dev, @identity_ino, @identity_birthtime_ns,
      @expected_size, @expected_sha256, @lifecycle, @observation, @observed_at, @created_at, @updated_at
    )
  `).run(row);
}

describe('processing recovery evidence migration', () => {
  let db;
  let tmpDir;

  afterEach(() => {
    closeDatabase(db);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds empty tables to an existing 044 database without touching existing rows', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-evidence-migration-'));
    db = openDatabase(path.join(tmpDir, 'legacy.sqlite'));
    const legacyDir = createPreMigrationsDir(tmpDir);
    runMigrations(db, legacyDir);
    expect(db.prepare('SELECT MAX(filename) FROM schema_migrations').pluck().get())
      .toBe('044_add_generated_output_provenance.sql');

    const projectId = insertProject(db, 'existing-project');
    const assetId = insertAsset(db, projectId, 'art/cover.png');
    const assetBefore = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId);

    runMigrations(db, MIGRATIONS_DIR);
    runMigrations(db, MIGRATIONS_DIR);

    expect(db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId)).toEqual(assetBefore);
    expect(db.prepare('SELECT COUNT(*) FROM processing_recovery_mutation_groups').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM processing_recovery_evidence').pluck().get()).toBe(0);
    expect(db.prepare('SELECT filename FROM schema_migrations WHERE filename = ?').pluck().get(MIGRATION))
      .toBe(MIGRATION);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('creates the expected columns, keys, and indexes on a fresh database', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-evidence-migration-'));
    db = openDatabase(path.join(tmpDir, 'test.sqlite'));
    runMigrations(db, MIGRATIONS_DIR);

    const shape = (table) => db.prepare(`PRAGMA table_info(${table})`).all()
      .map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }));
    expect(shape('processing_recovery_mutation_groups')).toEqual([
      { name: 'group_id', type: 'TEXT', notnull: 0, pk: 1 },
      { name: 'project_id', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'operation', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'run_id', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'item_key', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'checkpoint', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'checkpoint_at', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'created_at', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'updated_at', type: 'TEXT', notnull: 1, pk: 0 },
    ]);
    expect(shape('processing_recovery_evidence')).toEqual([
      { name: 'evidence_id', type: 'TEXT', notnull: 0, pk: 1 },
      { name: 'project_id', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'mutation_group_id', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'asset_id', type: 'INTEGER', notnull: 0, pk: 0 },
      { name: 'artifact_role', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'retention_reason', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'artifact_path', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'source_path', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'destination_path', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'identity_dev', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'identity_ino', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'identity_birthtime_ns', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'expected_size', type: 'INTEGER', notnull: 0, pk: 0 },
      { name: 'expected_sha256', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'lifecycle', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'observation', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'observed_at', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'created_at', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'updated_at', type: 'TEXT', notnull: 1, pk: 0 },
    ]);

    const foreignKeys = (table) => db.prepare(`PRAGMA foreign_key_list(${table})`).all()
      .map(({ table: parent, from, to, on_delete: onDelete }) => ({ parent, from, to, onDelete }))
      .sort((a, b) => a.from.localeCompare(b.from));
    expect(foreignKeys('processing_recovery_mutation_groups')).toEqual([
      { parent: 'projects', from: 'project_id', to: 'id', onDelete: 'CASCADE' },
    ]);
    expect(foreignKeys('processing_recovery_evidence')).toEqual([
      { parent: 'assets', from: 'asset_id', to: 'id', onDelete: 'SET NULL' },
      { parent: 'processing_recovery_mutation_groups', from: 'mutation_group_id', to: 'group_id', onDelete: 'NO ACTION' },
      { parent: 'processing_recovery_mutation_groups', from: 'project_id', to: 'project_id', onDelete: 'NO ACTION' },
      { parent: 'projects', from: 'project_id', to: 'id', onDelete: 'CASCADE' },
    ]);

    const indexes = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name LIKE 'processing_recovery_%' AND name NOT LIKE 'sqlite_autoindex_%'
      ORDER BY name
    `).pluck().all();
    expect(indexes).toEqual([
      'idx_processing_recovery_evidence_asset',
      'idx_processing_recovery_evidence_group',
      'idx_processing_recovery_evidence_project',
      'idx_processing_recovery_mutation_groups_run',
    ]);
  });

  it('enforces controlled values, exact-identity text, and project-consistent groups', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-evidence-migration-'));
    db = openDatabase(path.join(tmpDir, 'test.sqlite'));
    runMigrations(db, MIGRATIONS_DIR);
    const first = insertProject(db, 'first');
    const second = insertProject(db, 'second');

    expect(() => insertGroup(db, 'g-bad', first, { operation: 'cbz' })).toThrow(/CHECK/);
    expect(() => insertGroup(db, 'g-bad', first, { checkpoint: 'replace' })).toThrow(/CHECK/);
    expect(() => insertGroup(db, 'g-bad', first, { checkpoint: 'delete', checkpoint_at: 't' })).toThrow(/CHECK/);
    insertGroup(db, 'g1', first);

    expect(() => insertEvidence(db, 'e-bad', 'g1', first, { lifecycle: 'cleaned' })).toThrow(/CHECK/);
    expect(() => insertEvidence(db, 'e-bad', 'g1', first, { observation: 'gone', observed_at: 't' })).toThrow(/CHECK/);
    expect(() => insertEvidence(db, 'e-bad', 'g1', first, { observation: 'present' })).toThrow(/CHECK/);
    expect(() => insertEvidence(db, 'e-bad', 'g1', first, { identity_dev: '1' })).toThrow(/CHECK/);
    expect(() => insertEvidence(db, 'e-bad', 'g1', first, { identity_birthtime_ns: '1' })).toThrow(/CHECK/);
    expect(() => insertEvidence(db, 'e-bad', 'g1', first, { identity_dev: '-1', identity_ino: '1' })).toThrow(/CHECK/);
    expect(() => insertEvidence(db, 'e-bad', 'g1', first, { identity_dev: '1.5', identity_ino: '1' })).toThrow(/CHECK/);
    expect(() => insertEvidence(db, 'e-bad', 'g1', first, { expected_sha256: 'A'.repeat(64) })).toThrow(/CHECK/);
    // A group can only carry evidence of its own project.
    expect(() => insertEvidence(db, 'e-bad', 'g1', second)).toThrow(/FOREIGN KEY/);
    expect(() => insertEvidence(db, 'e-bad', 'missing', first)).toThrow(/FOREIGN KEY/);

    insertEvidence(db, 'e1', 'g1', first, {
      identity_dev: '18446744073709551615', identity_ino: '9007199254740993', identity_birthtime_ns: '1700000000123456789',
    });
    expect(db.prepare(`
      SELECT identity_dev, identity_ino, identity_birthtime_ns, typeof(identity_dev) AS kind
      FROM processing_recovery_evidence WHERE evidence_id = 'e1'
    `).get()).toEqual({
      identity_dev: '18446744073709551615', identity_ino: '9007199254740993',
      identity_birthtime_ns: '1700000000123456789', kind: 'text',
    });
  });

  it('keeps evidence on asset deletion, blocks deleting a referenced group, and cascades with the project', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-evidence-migration-'));
    db = openDatabase(path.join(tmpDir, 'test.sqlite'));
    runMigrations(db, MIGRATIONS_DIR);
    const first = insertProject(db, 'first');
    const second = insertProject(db, 'second');
    const assetId = insertAsset(db, first, 'art/cover.png');
    insertGroup(db, 'g1', first);
    insertGroup(db, 'g2', second);
    insertEvidence(db, 'e1', 'g1', first, { asset_id: assetId });
    insertEvidence(db, 'e2', 'g2', second);

    db.prepare('DELETE FROM assets WHERE id = ?').run(assetId);
    expect(db.prepare("SELECT asset_id FROM processing_recovery_evidence WHERE evidence_id = 'e1'").get())
      .toEqual({ asset_id: null });

    expect(() => db.prepare("DELETE FROM processing_recovery_mutation_groups WHERE group_id = 'g1'").run())
      .toThrow(/FOREIGN KEY/);

    db.prepare('DELETE FROM projects WHERE id = ?').run(first);
    expect(db.prepare('SELECT evidence_id FROM processing_recovery_evidence').pluck().all()).toEqual(['e2']);
    expect(db.prepare('SELECT group_id FROM processing_recovery_mutation_groups').pluck().all()).toEqual(['g2']);
  });
});
