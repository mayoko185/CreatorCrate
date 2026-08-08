import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openDatabase, closeDatabase, runMigrations } from '../src/db.js';
import { createBackupService, BackupError } from '../src/services/backup-service.js';
import { resolveBackupDir } from '../src/storage/backup-storage.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

function insertProject(db, title) {
  return db
    .prepare(
      `INSERT INTO projects (title, slug, description, notes, status, planned_date, published_date, patreon_url)
       VALUES (?, ?, '', '', 'tbd', NULL, NULL, NULL)`
    )
    .run(title, title.toLowerCase().replace(/\s+/g, '-')).lastInsertRowid;
}

function countProjects(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;
}

describe('backup-service', () => {
  let appDataRoot;
  let databasePath;
  let db;
  let service;

  beforeEach(() => {
    appDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-backup-svc-'));
    databasePath = path.join(appDataRoot, 'creatorcrate.db');
    db = openDatabase(databasePath);
    runMigrations(db, MIGRATIONS_DIR);
    service = createBackupService({ appDataRoot, databasePath, migrationsDir: MIGRATIONS_DIR });
  });

  afterEach(() => {
    try {
      closeDatabase(db);
    } catch {
      // already closed by a restore in the test
    }
    fs.rmSync(appDataRoot, { recursive: true, force: true });
  });

  // ─── Backup ────────────────────────────────────────────────────────────

  describe('createBackup', () => {
    it('produces a consistent snapshot that reflects data at backup time', async () => {
      insertProject(db, 'Alpha');
      const result = await service.createBackup(db);

      insertProject(db, 'Beta'); // written after the backup completed

      expect(result.filename).toMatch(/^creatorcrate-.*\.sqlite$/);
      expect(result.sizeBytes).toBeGreaterThan(0);
      expect(typeof result.createdAt).toBe('string');

      const backupDir = resolveBackupDir(appDataRoot);
      const snapshot = new Database(path.join(backupDir, result.filename), { readonly: true });
      try {
        expect(countProjects(snapshot)).toBe(1);
      } finally {
        snapshot.close();
      }
      expect(countProjects(db)).toBe(2);
    });

    it('does not leak absolute paths in the returned metadata', async () => {
      const result = await service.createBackup(db);
      expect(result.path).toBe(result.filename);
      expect(result.path).not.toContain(appDataRoot);
      expect(result.path).not.toMatch(/^[A-Za-z]:[\\/]/);
      expect(result.path).not.toMatch(/^\//);
    });

    it('writes to a staging file and atomically renames into place', async () => {
      const backupDir = resolveBackupDir(appDataRoot);
      const before = fs.readdirSync(backupDir);
      expect(before).toEqual([]);

      const result = await service.createBackup(db);

      const after = fs.readdirSync(backupDir);
      expect(after).toEqual([result.filename]);
      expect(after.some((name) => name.includes('.staging'))).toBe(false);
    });

    it('removes the staging file and throws when the backup would be invalid', async () => {
      const backupDir = resolveBackupDir(appDataRoot);
      const brokenDb = {
        backup: async () => {
          throw new Error('simulated backup failure');
        },
      };
      const svc = createBackupService({ appDataRoot, databasePath, migrationsDir: MIGRATIONS_DIR });

      await expect(svc.createBackup(brokenDb)).rejects.toThrow(BackupError);
      expect(fs.readdirSync(backupDir)).toEqual([]);
    });

    it('rejects concurrent backups while a restore is in progress', async () => {
      const svc = createBackupService({ appDataRoot, databasePath, migrationsDir: MIGRATIONS_DIR });
      const backup = await service.createBackup(db);

      const restorePromise = svc.restoreBackup(backup.filename, db);
      await expect(svc.createBackup({ backup: async () => {} })).rejects.toThrow(
        'restore is in progress'
      );

      const { db: restored } = await restorePromise;
      db = restored;
    });
  });

  // ─── Validation ────────────────────────────────────────────────────────

  describe('validateBackup', () => {
    it('validates a well-formed backup', async () => {
      const result = await service.createBackup(db);
      const validation = service.validateBackup(result.filename);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);
    });

    it('rejects a non-existent managed filename without leaking a stack trace', () => {
      const validation = service.validateBackup('creatorcrate-2020-01-01T000000Z.sqlite');
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
      expect(validation.errors.every((msg) => typeof msg === 'string')).toBe(true);
    });

    it('rejects traversal filenames', () => {
      const validation = service.validateBackup('../../etc/passwd');
      expect(validation.valid).toBe(false);
    });

    it('rejects a non-CreatorCrate SQLite database', () => {
      const backupDir = resolveBackupDir(appDataRoot);
      const filename = 'creatorcrate-2026-07-29T192447Z.sqlite';
      const foreign = new Database(path.join(backupDir, filename));
      foreign.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
      foreign.close();

      const validation = service.validateBackup(filename);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((msg) => msg.includes('schema'))).toBe(true);
    });

    it('rejects a backup whose schema is newer than the application supports', () => {
      const backupDir = resolveBackupDir(appDataRoot);
      const filename = 'creatorcrate-2026-07-29T192447Z.sqlite';
      const future = new Database(path.join(backupDir, filename));
      runMigrations(future, MIGRATIONS_DIR);
      future
        .prepare("INSERT INTO schema_migrations (filename, applied_at) VALUES (?, datetime('now'))")
        .run('999_from_the_future.sql');
      future.close();

      const validation = service.validateBackup(filename);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((msg) => msg.includes('newer'))).toBe(true);
    });

    it('rejects a corrupted backup file that fails the integrity check', () => {
      const backupDir = resolveBackupDir(appDataRoot);
      const filename = 'creatorcrate-2026-07-29T192447Z.sqlite';
      fs.writeFileSync(path.join(backupDir, filename), 'not a real sqlite file, but non-empty');

      const validation = service.validateBackup(filename);
      expect(validation.valid).toBe(false);
    });
  });

  // ─── Listing ───────────────────────────────────────────────────────────

  describe('listBackups', () => {
    it('lists managed backups newest first with safe metadata', async () => {
      const first = await service.createBackup(db);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await service.createBackup(db);

      const list = service.listBackups();
      expect(list.map((b) => b.filename)).toEqual([second.filename, first.filename]);
      for (const entry of list) {
        expect(entry).toHaveProperty('filename');
        expect(entry).toHaveProperty('createdAt');
        expect(entry).toHaveProperty('sizeBytes');
        expect(entry).toHaveProperty('valid', true);
        expect(Object.values(entry).every((v) => typeof v !== 'string' || !v.includes(appDataRoot))).toBe(
          true
        );
      }
    });

    it('ignores staging, rollback, and unmanaged files', async () => {
      const backupDir = resolveBackupDir(appDataRoot);
      fs.writeFileSync(path.join(backupDir, 'creatorcrate-2026-07-29T192447Z.sqlite.staging'), 'x');
      fs.writeFileSync(path.join(backupDir, 'creatorcrate.db.rollback'), 'x');
      fs.writeFileSync(path.join(backupDir, 'notes.txt'), 'x');

      expect(service.listBackups()).toEqual([]);
    });

    it('handles malformed filenames safely', () => {
      const backupDir = resolveBackupDir(appDataRoot);
      fs.writeFileSync(path.join(backupDir, 'creatorcrate-not-a-timestamp.sqlite'), 'x');
      expect(() => service.listBackups()).not.toThrow();
      expect(service.listBackups()).toEqual([]);
    });

    it('excludes symlinked backup entries', () => {
      const backupDir = resolveBackupDir(appDataRoot);
      const real = path.join(appDataRoot, 'real.sqlite');
      fs.writeFileSync(real, 'x');
      try {
        fs.symlinkSync(real, path.join(backupDir, 'creatorcrate-2026-07-29T192447Z.sqlite'), 'file');
      } catch {
        return; // symlinks unsupported on this platform/permission set
      }
      expect(service.listBackups()).toEqual([]);
    });

    it('returns an empty list when no backup directory exists yet', () => {
      // resolveBackupDir creates it lazily; a fresh service on an unused root
      // should still list safely.
      const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-backup-empty-'));
      const svc = createBackupService({ appDataRoot: freshRoot, databasePath, migrationsDir: MIGRATIONS_DIR });
      expect(svc.listBackups()).toEqual([]);
      fs.rmSync(freshRoot, { recursive: true, force: true });
    });
  });

  // ─── Manual deletion (Phase 11.3) ─────────────────────────────────────────

  describe('deleteBackup', () => {
    it('deletes a managed backup by filename', async () => {
      const backupDir = resolveBackupDir(appDataRoot);
      const result = await service.createBackup(db);

      const outcome = service.deleteBackup(result.filename);
      expect(outcome).toEqual({ filename: result.filename });
      expect(fs.existsSync(path.join(backupDir, result.filename))).toBe(false);
    });

    it('rejects a non-existent managed filename', async () => {
      expect(() => service.deleteBackup('creatorcrate-2020-01-01T000000Z.sqlite')).toThrow(BackupError);
    });

    it('rejects traversal filenames', () => {
      expect(() => service.deleteBackup('../../etc/passwd')).toThrow(BackupError);
    });

    it('rejects deleting a staging file', async () => {
      const backupDir = resolveBackupDir(appDataRoot);
      const stagingName = 'creatorcrate-2026-07-29T192447Z.sqlite.staging';
      fs.writeFileSync(path.join(backupDir, stagingName), 'x');

      expect(() => service.deleteBackup(stagingName)).toThrow(BackupError);
      expect(fs.existsSync(path.join(backupDir, stagingName))).toBe(true);
    });

    it('rejects deleting a rollback file', async () => {
      const dbDir = path.dirname(databasePath);
      const rollbackName = `${path.basename(databasePath)}.rollback`;
      fs.writeFileSync(path.join(dbDir, rollbackName), 'x');

      expect(() => service.deleteBackup(rollbackName)).toThrow(BackupError);
    });

    it('rejects deleting a symlinked backup entry', async () => {
      const backupDir = resolveBackupDir(appDataRoot);
      const real = path.join(appDataRoot, 'real.sqlite');
      fs.writeFileSync(real, 'x');
      const linkName = 'creatorcrate-2026-07-29T192447Z.sqlite';
      try {
        fs.symlinkSync(real, path.join(backupDir, linkName), 'file');
      } catch {
        return; // symlinks unsupported on this platform/permission set
      }

      expect(() => service.deleteBackup(linkName)).toThrow(BackupError);
      expect(fs.existsSync(real)).toBe(true);
    });

    it('does not affect other backups when deleting one', async () => {
      const first = await service.createBackup(db);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await service.createBackup(db);

      service.deleteBackup(first.filename);

      const remaining = service.listBackups().map((b) => b.filename);
      expect(remaining).toEqual([second.filename]);
    });

    it('rejects deleting while a restore is in progress', async () => {
      const backup = await service.createBackup(db);
      const restorePromise = service.restoreBackup(backup.filename, db);

      expect(() => service.deleteBackup(backup.filename)).toThrow('restore is in progress');

      const { db: restored } = await restorePromise;
      db = restored;
    });
  });

  // ─── Retention pruning (Phase 11.3) ──────────────────────────────────────

  describe('retention pruning', () => {
    // Filenames are only second-resolution (see formatBackupTimestamp), so
    // real backups created milliseconds apart can collide on the same
    // timestamp and fall back to the "-1", "-2", ... collision suffix. If an
    // older, unsuffixed backup is then pruned, a later call's suffix search
    // can legitimately reuse that exact freed-up filename string — which
    // would make a same-string filename check meaningless for this test.
    // Faking only the `Date` global spaces each generated filename a full
    // fake second apart (no collisions, no reused names) while the real
    // filesystem clock (used for listBackups' mtime-based ordering) still
    // advances in real time via the actual `await`.
    async function createNBackups(svc, n) {
      const names = [];
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        let fakeNow = new Date('2026-07-29T12:00:00.000Z');
        vi.setSystemTime(fakeNow);
        for (let i = 0; i < n; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          const result = await svc.createBackup(db);
          names.push(result.filename);
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, 10));
          fakeNow = new Date(fakeNow.getTime() + 2000);
          vi.setSystemTime(fakeNow);
        }
      } finally {
        vi.useRealTimers();
      }
      return names;
    }

    it('does not prune when retentionCount is undefined (disabled by default)', async () => {
      const svc = createBackupService({ appDataRoot, databasePath, migrationsDir: MIGRATIONS_DIR });
      const names = await createNBackups(svc, 3);
      const list = svc.listBackups().map((b) => b.filename);
      expect(list.sort()).toEqual(names.sort());
    });

    it('does not prune when retentionCount is 0 (explicitly disabled)', async () => {
      const svc = createBackupService({
        appDataRoot,
        databasePath,
        migrationsDir: MIGRATIONS_DIR,
        retentionCount: 0,
      });
      await createNBackups(svc, 3);
      expect(svc.listBackups()).toHaveLength(3);
    });

    it('retains exactly the configured count, deleting only the oldest', async () => {
      const svc = createBackupService({
        appDataRoot,
        databasePath,
        migrationsDir: MIGRATIONS_DIR,
        retentionCount: 2,
      });
      const names = await createNBackups(svc, 4);
      const [oldest1, oldest2, keep2, keep1] = names;

      const remaining = svc.listBackups().map((b) => b.filename);
      expect(remaining.sort()).toEqual([keep1, keep2].sort());
      expect(remaining).not.toContain(oldest1);
      expect(remaining).not.toContain(oldest2);
    });

    it('never deletes the newly created backup even at retentionCount 1', async () => {
      const svc = createBackupService({
        appDataRoot,
        databasePath,
        migrationsDir: MIGRATIONS_DIR,
        retentionCount: 1,
      });
      const names = await createNBackups(svc, 3);
      const newest = names[names.length - 1];

      const remaining = svc.listBackups().map((b) => b.filename);
      expect(remaining).toEqual([newest]);
    });

    it('reports pruned filenames on the createBackup result', async () => {
      const svc = createBackupService({
        appDataRoot,
        databasePath,
        migrationsDir: MIGRATIONS_DIR,
        retentionCount: 1,
      });
      const first = await svc.createBackup(db);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await svc.createBackup(db);

      expect(second.pruned).toEqual([first.filename]);
      expect(second.pruneWarnings).toEqual([]);
    });

    it('never deletes staging, rollback, or unmanaged files while pruning', async () => {
      const svc = createBackupService({
        appDataRoot,
        databasePath,
        migrationsDir: MIGRATIONS_DIR,
        retentionCount: 1,
      });
      const backupDir = resolveBackupDir(appDataRoot);
      fs.writeFileSync(path.join(backupDir, 'creatorcrate-2020-01-01T000000Z.sqlite.staging'), 'x');
      fs.writeFileSync(path.join(backupDir, 'creatorcrate.db.rollback'), 'x');
      fs.writeFileSync(path.join(backupDir, 'notes.txt'), 'x');

      await createNBackups(svc, 2);

      const dirEntries = fs.readdirSync(backupDir);
      expect(dirEntries).toContain('creatorcrate-2020-01-01T000000Z.sqlite.staging');
      expect(dirEntries).toContain('creatorcrate.db.rollback');
      expect(dirEntries).toContain('notes.txt');
    });

    it('does not invalidate a successful backup when pruning fails, and reports a warning', async () => {
      const svc = createBackupService({
        appDataRoot,
        databasePath,
        migrationsDir: MIGRATIONS_DIR,
        retentionCount: 1,
      });
      const first = await svc.createBackup(db);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Force the prune step's delete to fail deterministically (cross-platform)
      // without touching the createBackup/validation path itself.
      const backupDir = resolveBackupDir(appDataRoot);
      const oldPath = path.join(backupDir, first.filename);
      const realUnlinkSync = fs.unlinkSync.bind(fs);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
        if (target === oldPath) {
          throw Object.assign(new Error('simulated permission failure'), { code: 'EPERM' });
        }
        return realUnlinkSync(target);
      });

      let second;
      try {
        second = await svc.createBackup(db);
      } finally {
        unlinkSpy.mockRestore();
      }

      expect(second.filename).toMatch(/^creatorcrate-.*\.sqlite$/);
      expect(fs.existsSync(path.join(backupDir, second.filename))).toBe(true);
      expect(second.pruned).toEqual([]);
      expect(second.pruneWarnings).toEqual([`Could not prune backup "${first.filename}".`]);
      expect(fs.existsSync(oldPath)).toBe(true);
    });
  });

  // ─── Restore ───────────────────────────────────────────────────────────

  describe('restoreBackup', () => {
    it('replaces the live database and reopens a working connection', async () => {
      insertProject(db, 'Before Backup');
      const backup = await service.createBackup(db);
      insertProject(db, 'After Backup');
      expect(countProjects(db)).toBe(2);

      const result = await service.restoreBackup(backup.filename, db);
      db = result.db;

      expect(result.filename).toBe(backup.filename);
      expect(countProjects(db)).toBe(1);
      expect(db.prepare('SELECT 1 AS ok').get().ok).toBe(1);
    });

    it('rejects traversal filenames without touching the live database', async () => {
      insertProject(db, 'Untouched');
      await expect(service.restoreBackup('../../etc/passwd', db)).rejects.toThrow(BackupError);
      expect(countProjects(db)).toBe(1);
    });

    it('rejects restoring an invalid backup', async () => {
      const backupDir = resolveBackupDir(appDataRoot);
      const filename = 'creatorcrate-2026-07-29T192447Z.sqlite';
      fs.writeFileSync(path.join(backupDir, filename), 'not sqlite');

      insertProject(db, 'Untouched');
      await expect(service.restoreBackup(filename, db)).rejects.toThrow(BackupError);
      expect(countProjects(db)).toBe(1);
    });

    it('rolls back to the previous database when post-restore verification fails', async () => {
      insertProject(db, 'Original');
      const backup = await service.createBackup(db);

      // Simulate a forced post-restore verification failure by pointing
      // migrationsDir at a directory with one additional, not-yet-applied
      // migration containing invalid SQL — runMigrations will attempt it
      // during the reopen step and fail.
      const badMigrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creatorcrate-bad-migrations-'));
      for (const name of fs.readdirSync(MIGRATIONS_DIR)) {
        fs.copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(badMigrationsDir, name));
      }
      fs.writeFileSync(path.join(badMigrationsDir, '999_broken.sql'), 'THIS IS NOT VALID SQL;;;');

      const svc = createBackupService({
        appDataRoot,
        databasePath,
        migrationsDir: badMigrationsDir,
      });

      // The rejection carries a reopened, working connection to the
      // original (rolled-back) database — the caller is never left without
      // a usable handle.
      let caught;
      try {
        await svc.restoreBackup(backup.filename, db);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BackupError);
      db = caught.db;
      expect(countProjects(db)).toBe(1);
      expect(db.prepare('SELECT 1 AS ok').get().ok).toBe(1);

      fs.rmSync(badMigrationsDir, { recursive: true, force: true });
    });

    it('leaves no rollback or staging artifacts after a successful restore', async () => {
      const backup = await service.createBackup(db);
      const result = await service.restoreBackup(backup.filename, db);
      db = result.db;

      const dbDir = path.dirname(databasePath);
      const leftover = fs
        .readdirSync(dbDir)
        .filter((name) => name.includes('.rollback') || name.includes('.restoring-'));
      expect(leftover).toEqual([]);
    });

    it('enforces the maintenance boundary against concurrent restores', async () => {
      const backup = await service.createBackup(db);

      const first = service.restoreBackup(backup.filename, db);
      await expect(service.restoreBackup(backup.filename, db)).rejects.toThrow(
        'restore is already in progress'
      );

      const result = await first;
      db = result.db;
    });
  });
});
