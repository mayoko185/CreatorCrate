import { beginReplacementMaintenance } from '../src/services/managed-upload-tracker.js';
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function pauseNativeBackup(sourceDb) {
  const started = deferred();
  let released = false;
  return {
    db: {
      backup: vi.fn((target) => sourceDb.backup(target, {
        progress({ remainingPages }) {
          started.resolve();
          return released ? remainingPages : 0;
        },
      })),
    },
    started: started.promise,
    release() { released = true; },
  };
}

describe('backup-service', () => {
  let appDataRoot;
  let databasePath;
  let db;
  let service;
  let owner;
  function restoreOwner() {
    const connection = db;
    return owner ??= beginReplacementMaintenance(connection, () => db === connection && connection.open);
  }

  beforeEach(() => {
    owner = null;
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
    owner?.release();
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

    it('gives concurrent same-timestamp backups distinct staging and published paths', async () => {
      const backupDir = resolveBackupDir(appDataRoot);
      const fixedNow = new Date('2026-07-29T19:24:47.000Z');
      const svc = createBackupService({
        appDataRoot,
        databasePath,
        migrationsDir: MIGRATIONS_DIR,
        now: () => fixedNow,
      });
      const firstStarted = deferred();
      const secondStarted = deferred();
      const release = deferred();
      const stagingTargets = [];
      const controlledDb = (started) => ({
        backup: vi.fn(async (target) => {
          stagingTargets.push(target);
          started.resolve();
          await release.promise;
          return db.backup(target);
        }),
      });

      try {
        const firstPromise = svc.createBackup(controlledDb(firstStarted));
        const secondPromise = svc.createBackup(controlledDb(secondStarted));
        await Promise.all([firstStarted.promise, secondStarted.promise]);

        expect(stagingTargets).toHaveLength(2);
        expect(new Set(stagingTargets).size).toBe(2);
        expect(stagingTargets.every((target) => path.dirname(target).startsWith(backupDir))).toBe(true);
        expect(stagingTargets.every((target) => path.basename(target) === 'snapshot.sqlite')).toBe(true);

        release.resolve();
        const [first, second] = await Promise.all([firstPromise, secondPromise]);

        expect([first.filename, second.filename].sort()).toEqual([
          'creatorcrate-2026-07-29T192447Z-1.sqlite',
          'creatorcrate-2026-07-29T192447Z.sqlite',
        ]);
        expect(first.filename).not.toBe(second.filename);
        expect(fs.existsSync(path.join(backupDir, first.filename))).toBe(true);
        expect(fs.existsSync(path.join(backupDir, second.filename))).toBe(true);
        expect(fs.readdirSync(backupDir).sort()).toEqual([first.filename, second.filename].sort());
      } finally {
        release.resolve();
      }
    });

    it('keeps failed concurrent backup cleanup local to its owned staging directory', async () => {
      const backupDir = resolveBackupDir(appDataRoot);
      const fixedNow = new Date('2026-07-29T19:24:47.000Z');
      const svc = createBackupService({
        appDataRoot,
        databasePath,
        migrationsDir: MIGRATIONS_DIR,
        now: () => fixedNow,
      });
      const failedStaged = deferred();
      const successfulStaged = deferred();
      const failNow = deferred();
      const publishNow = deferred();
      let failedTarget;
      let successfulTarget;

      const failingDb = {
        backup: vi.fn(async (target) => {
          failedTarget = target;
          await db.backup(target);
          failedStaged.resolve();
          await failNow.promise;
          throw new Error('simulated concurrent backup failure');
        }),
      };
      const successfulDb = {
        backup: vi.fn(async (target) => {
          successfulTarget = target;
          await db.backup(target);
          successfulStaged.resolve();
          await publishNow.promise;
        }),
      };

      try {
        const failedPromise = svc.createBackup(failingDb);
        const successfulPromise = svc.createBackup(successfulDb);
        await Promise.all([failedStaged.promise, successfulStaged.promise]);

        expect(failedTarget).not.toBe(successfulTarget);
        expect(fs.existsSync(failedTarget)).toBe(true);
        expect(fs.existsSync(successfulTarget)).toBe(true);

        failNow.resolve();
        await expect(failedPromise).rejects.toThrow('Failed to create database backup.');
        expect(fs.existsSync(path.dirname(failedTarget))).toBe(false);
        expect(fs.existsSync(successfulTarget)).toBe(true);

        publishNow.resolve();
        const successful = await successfulPromise;
        expect(successful.filename).toBe('creatorcrate-2026-07-29T192447Z.sqlite');
        expect(fs.existsSync(path.join(backupDir, successful.filename))).toBe(true);
        expect(fs.existsSync(path.dirname(successfulTarget))).toBe(false);
        expect(fs.readdirSync(backupDir)).toEqual([successful.filename]);
      } finally {
        failNow.resolve();
        publishNow.resolve();
      }
    });

    it('rejects restore before closing the source database while a native backup is active', async () => {
      const restoreSource = await service.createBackup(db);
      const controlled = pauseNativeBackup(db);
      const backupPromise = service.createBackup(controlled.db);

      try {
        await controlled.started;
        expect(service.hasActiveBackups()).toBe(true);

        await expect(
          service.restoreBackup(restoreSource.filename, db, restoreOwner())
        ).rejects.toThrow('backup creation is in progress');
        expect(db.open).toBe(true);

        controlled.release();
        await expect(backupPromise).resolves.toEqual(expect.objectContaining({
          filename: expect.stringMatching(/^creatorcrate-.*\.sqlite$/),
        }));
        expect(service.hasActiveBackups()).toBe(false);
        expect(db.open).toBe(true);
      } finally {
        controlled.release();
        await backupPromise.catch(() => {});
      }
    });

    it('blocks restore until every concurrent backup has settled', async () => {
      const restoreSource = await service.createBackup(db);
      const first = pauseNativeBackup(db);
      const second = pauseNativeBackup(db);
      const firstPromise = service.createBackup(first.db);
      const secondPromise = service.createBackup(second.db);

      try {
        await Promise.all([first.started, second.started]);
        expect(service.hasActiveBackups()).toBe(true);
        await expect(
          service.restoreBackup(restoreSource.filename, db, restoreOwner())
        ).rejects.toThrow('backup creation is in progress');

        first.release();
        await firstPromise;
        expect(service.hasActiveBackups()).toBe(true);
        await expect(
          service.restoreBackup(restoreSource.filename, db, restoreOwner())
        ).rejects.toThrow('backup creation is in progress');

        second.release();
        await secondPromise;
        expect(service.hasActiveBackups()).toBe(false);

        const result = await service.restoreBackup(restoreSource.filename, db, restoreOwner());
        db = result.db;
        expect(db.open).toBe(true);
      } finally {
        first.release();
        second.release();
        await Promise.allSettled([firstPromise, secondPromise]);
      }
    });

    it('releases backup activity after failure so restore is admissible again', async () => {
      const restoreSource = await service.createBackup(db);
      const started = deferred();
      const fail = deferred();
      const failingDb = {
        backup: vi.fn(async () => {
          started.resolve();
          await fail.promise;
          throw new Error('simulated active backup failure');
        }),
      };
      const backupPromise = service.createBackup(failingDb);

      await started.promise;
      expect(service.hasActiveBackups()).toBe(true);
      await expect(
        service.restoreBackup(restoreSource.filename, db, restoreOwner())
      ).rejects.toThrow('backup creation is in progress');

      fail.resolve();
      await expect(backupPromise).rejects.toThrow('Failed to create database backup.');
      expect(service.hasActiveBackups()).toBe(false);

      const result = await service.restoreBackup(restoreSource.filename, db, restoreOwner());
      db = result.db;
      expect(db.open).toBe(true);
    });

    it('rejects concurrent backups while a restore is in progress', async () => {
      const svc = createBackupService({ appDataRoot, databasePath, migrationsDir: MIGRATIONS_DIR });
      const backup = await service.createBackup(db);

      const restorePromise = svc.restoreBackup(backup.filename, db, restoreOwner());
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

    it('validates every listed backup and preserves metadata ordering for corrupt entries', async () => {
      const valid = await service.createBackup(db);
      const backupDir = resolveBackupDir(appDataRoot);
      const corruptFilename = 'creatorcrate-2026-07-29T192447Z.sqlite';
      const corruptPath = path.join(backupDir, corruptFilename);
      fs.writeFileSync(corruptPath, 'not a sqlite database');

      const older = new Date('2026-07-29T19:24:47.000Z');
      const newer = new Date('2026-07-29T19:24:48.000Z');
      fs.utimesSync(corruptPath, older, older);
      fs.utimesSync(path.join(backupDir, valid.filename), newer, newer);

      expect(service.listBackups()).toEqual([
        expect.objectContaining({
          filename: valid.filename,
          createdAt: newer.toISOString(),
          sizeBytes: valid.sizeBytes,
          valid: true,
        }),
        {
          filename: corruptFilename,
          createdAt: older.toISOString(),
          sizeBytes: Buffer.byteLength('not a sqlite database'),
          valid: false,
        },
      ]);
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
      const restorePromise = service.restoreBackup(backup.filename, db, restoreOwner());

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

    it('prunes historical backups in metadata order without integrity-checking them', async () => {
      const unpruned = createBackupService({ appDataRoot, databasePath, migrationsDir: MIGRATIONS_DIR });
      const historical = await createNBackups(unpruned, 3);
      const svc = createBackupService({
        appDataRoot,
        databasePath,
        migrationsDir: MIGRATIONS_DIR,
        retentionCount: 2,
      });
      const integrityChecks = [];
      const originalPragma = Database.prototype.pragma;
      const pragmaSpy = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function pragma(sql, options) {
        if (sql === 'integrity_check') integrityChecks.push(this.name);
        return originalPragma.call(this, sql, options);
      });

      let newest;
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        newest = await svc.createBackup(db);
      } finally {
        pragmaSpy.mockRestore();
      }

      expect(newest.pruned).toEqual([historical[1], historical[0]]);
      expect(newest.pruneWarnings).toEqual([]);
      expect(integrityChecks).toHaveLength(1);
      expect(integrityChecks[0]).toContain('.creatorcrate-backup-');
      expect(integrityChecks[0]).toContain('snapshot.sqlite');
      expect(historical.some((filename) => integrityChecks[0].includes(filename))).toBe(false);
      expect(svc.listBackups().map((entry) => entry.filename)).toEqual([newest.filename, historical[2]]);
    });

    it('uses numeric collision suffixes to break equal-timestamp retention ties', () => {
      const svc = createBackupService({
        appDataRoot,
        databasePath,
        migrationsDir: MIGRATIONS_DIR,
        retentionCount: 2,
      });
      const backupDir = resolveBackupDir(appDataRoot);
      const names = [
        'creatorcrate-2026-07-29T192447Z.sqlite',
        'creatorcrate-2026-07-29T192447Z-1.sqlite',
        'creatorcrate-2026-07-29T192447Z-2.sqlite',
      ];
      const tied = new Date('2026-07-29T19:24:47.000Z');
      for (const name of names) {
        const backupPath = path.join(backupDir, name);
        fs.writeFileSync(backupPath, 'metadata-only pruning fixture');
        fs.utimesSync(backupPath, tied, tied);
      }

      expect(svc.pruneBackups(names[2])).toEqual({ deleted: [names[0]], warnings: [] });
      expect(fs.readdirSync(backupDir).sort()).toEqual([names[1], names[2]].sort());
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

      const result = await service.restoreBackup(backup.filename, db, restoreOwner());
      db = result.db;

      expect(result.filename).toBe(backup.filename);
      expect(countProjects(db)).toBe(1);
      expect(db.prepare('SELECT 1 AS ok').get().ok).toBe(1);
    });

    it('rejects traversal filenames without touching the live database', async () => {
      insertProject(db, 'Untouched');
      await expect(service.restoreBackup('../../etc/passwd', db, restoreOwner())).rejects.toThrow(BackupError);
      expect(countProjects(db)).toBe(1);
    });

    it('rejects restoring an invalid backup', async () => {
      const backupDir = resolveBackupDir(appDataRoot);
      const filename = 'creatorcrate-2026-07-29T192447Z.sqlite';
      fs.writeFileSync(path.join(backupDir, filename), 'not sqlite');

      insertProject(db, 'Untouched');
      await expect(service.restoreBackup(filename, db, restoreOwner())).rejects.toThrow(BackupError);
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
        await svc.restoreBackup(backup.filename, db, restoreOwner());
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
      const result = await service.restoreBackup(backup.filename, db, restoreOwner());
      db = result.db;

      const dbDir = path.dirname(databasePath);
      const leftover = fs
        .readdirSync(dbDir)
        .filter((name) => name.includes('.rollback') || name.includes('.restoring-'));
      expect(leftover).toEqual([]);
    });

    it('enforces the maintenance boundary against concurrent restores', async () => {
      const backup = await service.createBackup(db);

      const first = service.restoreBackup(backup.filename, db, restoreOwner());
      await expect(service.restoreBackup(backup.filename, db, restoreOwner())).rejects.toThrow(
        'restore is already in progress'
      );

      const result = await first;
      db = result.db;
    });
  });
});
