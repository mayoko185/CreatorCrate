import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase, closeDatabase, runMigrations } from '../src/db.js';
import { buildRevisionToken, serializeMeta, parseMeta, compareFreshness } from '../src/storage/preview-cache.js';
import { normalizeGeneratedImagePublication } from '../src/data/generated-image-publication-repository.js';

const migrations = fileURLToPath(new URL('../migrations/', import.meta.url));
const migration = '047_add_generated_image_input_fingerprint.sql';
let root, db;
afterEach(() => { if (db) closeDatabase(db); if (root) fs.rmSync(root, { recursive: true, force: true }); db = null; root = null; });
function fixture(legacy = false) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-input-migration-'));
  db = openDatabase(path.join(root, 'test.sqlite'));
  const before = path.join(root, 'migrations'); fs.mkdirSync(before);
  for (const name of fs.readdirSync(migrations)) {
    if (!legacy || name < migration) fs.copyFileSync(path.join(migrations, name), path.join(before, name));
  }
  runMigrations(db, before);
}
it('adds one nullable fingerprint on a fresh install', () => {
  fixture();
  const column = db.prepare('PRAGMA table_info(generated_image_publications)').all().find(column => column.name === 'source_input_fingerprint');
  expect(column).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
  expect(db.pragma('foreign_key_check')).toEqual([]);
});
it('preserves an existing publication, both derivatives and ordinary NULL on upgrade', () => {
  fixture(true);
  db.exec(`INSERT INTO projects(id, title, slug, status, project_type) VALUES(1,'One','one','tbd','images');
    INSERT INTO assets(id, project_id, relative_path, filename) VALUES(1,1,'one.png','one.png');
    INSERT INTO generated_image_publications(asset_id,project_id,directory_name,revision,generated_at,
      cache_schema_version,derivative_config_version,source_relative_path,source_size_bytes,source_mtime,source_generation)
      VALUES(1,1,'r-0123456789abcdef-12345678','0123456789abcdef','2026-11-11',1,1,'one.png',123,'2026-11-11',0);
    INSERT INTO generated_image_derivatives(asset_id,kind,format,width,height,size_bytes)
      VALUES(1,'thumbnail','webp',32,32,123),(1,'preview','png',320,320,1234);`);
  const before = db.prepare('SELECT * FROM generated_image_publications').get();
  const children = db.prepare('SELECT * FROM generated_image_derivatives').all();
  runMigrations(db, migrations); runMigrations(db, migrations);
  expect(db.prepare('SELECT * FROM generated_image_publications').get()).toEqual({ ...before, source_input_fingerprint: null });
  expect(db.prepare('SELECT * FROM generated_image_derivatives').all()).toEqual(children);
  for (const invalid of ['', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) {
    expect(() => db.prepare('UPDATE generated_image_publications SET source_input_fingerprint = ?').run(invalid)).toThrow();
  }
  db.prepare('UPDATE generated_image_publications SET source_input_fingerprint = ?').run('a'.repeat(64));
  expect(db.prepare('SELECT source_input_fingerprint AS value FROM generated_image_publications').get().value).toBe('a'.repeat(64));
  expect(db.pragma('foreign_key_check')).toEqual([]);
});
it('preserves ordinary revision tokens and metadata while binding comic input identity', () => {
  const ctx = { projectId: 1, assetId: 2, relativePath: 'art.png', size: 123, mtime: '2026-11-11', sourceGeneration: 0 };
  const legacy = buildRevisionToken(ctx);
  const oldPayload = { projectId: 1, assetId: 2, relativePath: 'art.png', size: 123, mtime: '2026-11-11', derivativeConfigVersion: 1 };
  expect(legacy).toBe(crypto.createHash('sha256').update(JSON.stringify(oldPayload, Object.keys(oldPayload).sort())).digest('hex').slice(0, 16));
  expect(buildRevisionToken({ ...ctx, inputFingerprint: null })).toBe(legacy);
  const d = { width: 32, height: 32, bytes: 123, format: 'webp' };
  const input = { ...ctx, generatedAt: '2026-11-11', thumbnail: d, preview: d };
  const ordinary = serializeMeta(input);
  expect(serializeMeta({ ...input, inputFingerprint: null })).toEqual(ordinary);
  expect(ordinary.source).not.toHaveProperty('inputFingerprint');
  const hash = 'a'.repeat(64);
  const meta = parseMeta(JSON.stringify(serializeMeta({ ...input, inputFingerprint: hash })));
  expect(meta.source.inputFingerprint).toBe(hash);
  expect(compareFreshness(meta, { ...ctx, inputFingerprint: hash }).fresh).toBe(true);
  expect(compareFreshness(meta, { ...ctx, inputFingerprint: 'b'.repeat(64) }).reasons).toContain('source input changed');
  expect(buildRevisionToken({ ...ctx, inputFingerprint: hash })).not.toBe(legacy);
  expect(() => parseMeta(JSON.stringify({ ...meta, source: { ...meta.source, inputFingerprint: ['a'.repeat(64)] } }))).toThrow();
  expect(() => buildRevisionToken({ ...ctx, inputFingerprint: 'invalid' })).toThrow();
  expect(() => normalizeGeneratedImagePublication({ sourceInputFingerprint: 'invalid' })).toThrow();
});
