import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase, closeDatabase, runMigrations } from '../db.js';
import {
  resolveBackupDir,
  resolveBackupFile,
  generateBackupFilename,
  isManagedBackupFilename,
} from '../storage/backup-storage.js';

export class BackupError extends Error {
  constructor(message, { cause, errors, db } = {}) {
    super(message, { cause });
    this.name = 'BackupError';
    // Structured validation errors (no raw paths/stack traces) for callers
    // that need to explain *why* a backup/restore was rejected.
    this.errors = errors || [];
    // Set only on restore failures where the connection was rolled back and
    // reopened — the caller must not be left without a usable database.
    if (db) this.db = db;
  }
}

const REQUIRED_MARKER_MIGRATION = '001_initial.sql';

function removeIfExists(target) {
  try {
    fs.unlinkSync(target);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function renameIfExists(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function walShmPaths(dbPath) {
  return [`${dbPath}-wal`, `${dbPath}-shm`];
}

function listMigrationFilenames(migrationsDir) {
  try {
    return fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'));
  } catch {
    return [];
  }
}

/**
 * Application-level SQLite backup and restore primitives.
 *
 * Not exposed over HTTP by this phase — callers (future routes) are
 * responsible for driving the exclusive-maintenance boundary (see
 * `isRestoreInProgress`) around request handling.
 *
 * @param {object} opts
 * @param {string} opts.appDataRoot - Resolved, existing APP_DATA_ROOT
 * @param {string} opts.databasePath - Resolved, existing live database path
 * @param {string} opts.migrationsDir - Directory of known application migrations
 * @param {number} [opts.retentionCount] - Managed backups to keep after each
 *   successful backup (newest first). 0 or undefined disables automatic
 *   pruning — Phase 11.3 never deletes a backup without an explicit,
 *   positive configured policy.
 */
export function createBackupService({ appDataRoot, databasePath, migrationsDir, retentionCount }) {
  // ─── Exclusive maintenance boundary ────────────────────────────────────
  // Smallest architecture that satisfies the Phase 11.1 contract: a single
  // in-process flag guarding restore. While a restore is in progress:
  //   - a second restore is rejected outright (no concurrent restores);
  //   - backups are rejected (no backup racing a restore's file swap);
  // Ordinary backups otherwise proceed freely (the SQLite online backup API
  // is safe against concurrent readers/writers). A later HTTP layer should
  // use `isRestoreInProgress()` to return 503 for any request that would
  // touch the database while this flag is set.
  let restoreInProgress = false;

  function beginRestore() {
    if (restoreInProgress) {
      throw new BackupError('A restore is already in progress.');
    }
    restoreInProgress = true;
  }

  function endRestore() {
    restoreInProgress = false;
  }

  function validateBackupFile(absPath) {
    const errors = [];
    let stats;
    try {
      stats = fs.lstatSync(absPath);
    } catch {
      return { valid: false, errors: ['Backup file does not exist.'] };
    }

    if (stats.isSymbolicLink()) {
      return { valid: false, errors: ['Backup file is a symbolic link.'] };
    }
    if (!stats.isFile()) {
      return { valid: false, errors: ['Backup path is not a regular file.'] };
    }
    if (stats.size === 0) {
      return { valid: false, errors: ['Backup file is empty.'] };
    }

    let db;
    try {
      db = new Database(absPath, { readonly: true, fileMustExist: true });
    } catch {
      return { valid: false, errors: ['Backup file could not be opened as a SQLite database.'] };
    }

    try {
      const integrity = db.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') {
        errors.push('Backup failed the SQLite integrity check.');
      }

      const hasSchemaMigrations = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get();

      if (!hasSchemaMigrations) {
        errors.push('Backup is missing the CreatorCrate schema migration table.');
      } else {
        const applied = new Set(db.prepare('SELECT filename FROM schema_migrations').pluck().all());

        if (!applied.has(REQUIRED_MARKER_MIGRATION)) {
          errors.push('Backup is missing required CreatorCrate schema markers.');
        }

        const known = new Set(listMigrationFilenames(migrationsDir));
        const unknown = [...applied].filter((filename) => !known.has(filename));
        if (unknown.length > 0) {
          errors.push('Backup schema is newer than this application version supports.');
        }
      }
    } catch {
      errors.push('Backup database could not be validated.');
    } finally {
      db.close();
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Create a consistent snapshot of `db` using SQLite's online backup API
   * (no manual WAL/SHM handling required; normal reads may continue).
   * Written to a staging file first and validated before an atomic rename
   * into the managed backup directory — a failure never leaves a
   * valid-looking partial backup behind.
   *
   * @param {import('better-sqlite3').Database} db - Live, open database connection
   * @returns {Promise<{filename: string, path: string, sizeBytes: number, createdAt: string}>}
   */
  async function createBackup(db) {
    if (restoreInProgress) {
      throw new BackupError('Cannot create a backup while a restore is in progress.');
    }

    const backupDir = resolveBackupDir(appDataRoot);
    const filename = generateBackupFilename(backupDir);
    const finalPath = path.join(backupDir, filename);
    const stagingPath = `${finalPath}.staging`;

    try {
      await db.backup(stagingPath);

      // The live database is in WAL mode, so the online backup API copies
      // that mode into the destination's header too. Switch the standalone
      // backup file to a plain rollback journal so opening it later (for
      // validation, listing, or restore) never spawns -wal/-shm sidecars —
      // a managed backup is always exactly one file.
      const staged = new Database(stagingPath);
      try {
        staged.pragma('journal_mode = DELETE');
      } finally {
        staged.close();
      }
    } catch (err) {
      removeIfExists(stagingPath);
      removeIfExists(`${stagingPath}-wal`);
      removeIfExists(`${stagingPath}-shm`);
      throw new BackupError('Failed to create database backup.', { cause: err });
    }

    removeIfExists(`${stagingPath}-wal`);
    removeIfExists(`${stagingPath}-shm`);

    const validation = validateBackupFile(stagingPath);
    if (!validation.valid) {
      removeIfExists(stagingPath);
      throw new BackupError('Backup produced an invalid snapshot and was discarded.', {
        errors: validation.errors,
      });
    }

    try {
      fs.renameSync(stagingPath, finalPath);
    } catch (err) {
      removeIfExists(stagingPath);
      throw new BackupError('Failed to finalize the backup file.', { cause: err });
    }

    const stats = fs.statSync(finalPath);

    // Phase 11.3: prune only after the new backup is fully validated and
    // atomically installed. A pruning failure is reported but never turns
    // a successful backup into a failed one.
    const pruneResult = pruneBackups(filename);

    return {
      filename,
      // Internal to the service — a bare filename, never an absolute path.
      path: filename,
      sizeBytes: stats.size,
      createdAt: new Date().toISOString(),
      pruned: pruneResult.deleted,
      pruneWarnings: pruneResult.warnings,
    };
  }

  /**
   * Validate a managed backup by filename. Returns structured errors (no
   * raw database paths or stack traces) rather than throwing, so callers
   * can present validation results to users.
   *
   * @param {string} filename
   * @returns {{valid: boolean, errors: string[]}}
   */
  function validateBackup(filename) {
    let absPath;
    try {
      absPath = resolveBackupFile(resolveBackupDir(appDataRoot), filename);
    } catch (err) {
      return { valid: false, errors: [err.message] };
    }
    return validateBackupFile(absPath);
  }

  /**
   * List managed backups, newest first. Ignores staging/rollback/unmanaged
   * files and symlinks; never returns absolute paths.
   *
   * @returns {Array<{filename: string, createdAt: string, sizeBytes: number, valid: boolean}>}
   */
  function listBackups() {
    const backupDir = resolveBackupDir(appDataRoot);

    let entries;
    try {
      entries = fs.readdirSync(backupDir);
    } catch {
      return [];
    }

    const results = [];
    for (const name of entries) {
      if (!isManagedBackupFilename(name)) continue;

      const full = path.join(backupDir, name);
      let stats;
      try {
        stats = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink() || !stats.isFile()) continue;

      const validation = validateBackupFile(full);
      results.push({
        filename: name,
        createdAt: stats.mtime.toISOString(),
        sizeBytes: stats.size,
        valid: validation.valid,
      });
    }

    results.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
      // mtime ties happen routinely when backups complete within the same
      // filesystem timestamp tick. Falling back to a raw string compare of
      // the filename is wrong here: the collision-suffix contract
      // ("<ts>.sqlite" then "<ts>-1.sqlite", "<ts>-2.sqlite", ...) sorts
      // "-1" *before* the un-suffixed base lexicographically ('-' < '.'),
      // which would rank an older, unsuffixed backup as newer than a
      // later-created, suffixed one. Compare the numeric suffix instead
      // (higher suffix = created later = newer).
      const suffixA = Number(a.filename.match(/-(\d+)\.sqlite$/)?.[1] ?? 0);
      const suffixB = Number(b.filename.match(/-(\d+)\.sqlite$/)?.[1] ?? 0);
      if (suffixA !== suffixB) return suffixB - suffixA;
      return b.filename.localeCompare(a.filename);
    });

    return results;
  }

  /**
   * Manually delete a single managed backup by filename.
   *
   * `resolveBackupFile` is the sole gate on what filename this can touch:
   * it requires the application-generated managed shape, rejects path
   * separators/traversal/absolute paths, and rejects any symlinked path
   * component. Staging (`.staging`) and rollback (`.rollback`) files never
   * match that shape, so they can never be targeted here.
   *
   * @param {string} filename - Managed backup filename to delete
   * @returns {{filename: string}}
   * @throws {BackupError}
   */
  function deleteBackup(filename) {
    if (restoreInProgress) {
      throw new BackupError('Cannot delete a backup while a restore is in progress.');
    }

    let absPath;
    try {
      absPath = resolveBackupFile(resolveBackupDir(appDataRoot), filename);
    } catch (err) {
      throw new BackupError('Backup could not be located for deletion.', { cause: err, errors: [err.message] });
    }

    try {
      const stats = fs.lstatSync(absPath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error('Refusing to delete a non-regular-file backup path.');
      }
      fs.unlinkSync(absPath);
    } catch (err) {
      throw new BackupError('Failed to delete the backup file.', { cause: err });
    }

    return { filename };
  }

  /**
   * Delete managed backups older than the configured retention count.
   * Never called before a new backup is successfully installed, never
   * deletes the newly created backup, and only ever removes filenames that
   * `listBackups` itself already classified as managed (never staging,
   * rollback, symlinked, malformed, or unrelated files).
   *
   * Failures to delete an individual backup are collected as warnings and
   * never thrown — a pruning failure must not invalidate the backup that
   * was just completed.
   *
   * @param {string} keepFilename - The filename just created; always retained.
   * @returns {{deleted: string[], warnings: string[]}}
   */
  function pruneBackups(keepFilename) {
    if (!Number.isInteger(retentionCount) || retentionCount <= 0) {
      return { deleted: [], warnings: [] };
    }

    let backupDir;
    let entries;
    try {
      backupDir = resolveBackupDir(appDataRoot);
      entries = listBackups(); // newest first
    } catch (err) {
      return { deleted: [], warnings: ['Could not list backups to apply the retention policy.'] };
    }

    const candidates = entries.slice(retentionCount).filter((entry) => entry.filename !== keepFilename);

    const deleted = [];
    const warnings = [];
    for (const { filename } of candidates) {
      try {
        const absPath = resolveBackupFile(backupDir, filename);
        fs.unlinkSync(absPath);
        deleted.push(filename);
      } catch {
        warnings.push(`Could not prune backup "${filename}".`);
      }
    }

    return { deleted, warnings };
  }

  /**
   * Restore a managed, validated backup over the live database.
   *
   * Contract:
   *   1. only a validated backup selected from the managed directory is
   *      accepted (traversal/symlink inputs rejected by resolveBackupFile);
   *   2. validated again immediately before restore;
   *   3. the backup is copied to a staging file beside the live database
   *      and fsynced;
   *   4. the live database is replaced atomically only while `db` (the
   *      caller's live connection) has already been closed by this call;
   *   5. the database is reopened and normal migrations/health checks rerun;
   *   6. on any failure after the original database was moved aside, the
   *      original is restored and reopened before the error is thrown — the
   *      prior database is never silently discarded.
   *
   * The caller owns the exclusive-maintenance boundary around request
   * handling (see module docs on `isRestoreInProgress`); this function only
   * guards against concurrent backup/restore calls within the service.
   *
   * @param {string} filename - Managed backup filename to restore
   * @param {import('better-sqlite3').Database} db - Currently open live connection
   * @returns {Promise<{db: import('better-sqlite3').Database, filename: string, restoredAt: string}>}
   */
  async function restoreBackup(filename, db) {
    beginRestore();
    // Yield once so the maintenance-boundary flag set above is observable
    // by callers that check `isRestoreInProgress()` or call this function
    // again before the (otherwise fully synchronous) restore work runs.
    await Promise.resolve();

    try {
      const backupDir = resolveBackupDir(appDataRoot);

      let backupPath;
      try {
        backupPath = resolveBackupFile(backupDir, filename);
      } catch (err) {
        throw new BackupError('Backup could not be located for restore.', { cause: err, errors: [err.message] });
      }

      const validation = validateBackupFile(backupPath);
      if (!validation.valid) {
        throw new BackupError('Backup failed validation and cannot be restored.', {
          errors: validation.errors,
        });
      }

      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // Best-effort checkpoint; the reopened original is still correct
        // even if this fails, since SQLite replays the WAL on open.
      }
      closeDatabase(db);

      const [walPath, shmPath] = walShmPaths(databasePath);
      const rollbackPath = `${databasePath}.rollback`;
      const stagingPath = `${databasePath}.restoring-${process.pid}-${Date.now()}`;

      const rollbackToOriginal = () => {
        if (!fs.existsSync(rollbackPath)) return;
        removeIfExists(databasePath);
        removeIfExists(walPath);
        removeIfExists(shmPath);
        fs.renameSync(rollbackPath, databasePath);
        renameIfExists(`${rollbackPath}-wal`, walPath);
        renameIfExists(`${rollbackPath}-shm`, shmPath);
      };

      let newDb;
      try {
        fs.copyFileSync(backupPath, stagingPath);
        const fd = fs.openSync(stagingPath, 'r+');
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }

        // Move the live database aside; install the staged restore in its
        // place. Both are same-filesystem renames (fast, effectively atomic).
        renameIfExists(databasePath, rollbackPath);
        renameIfExists(walPath, `${rollbackPath}-wal`);
        renameIfExists(shmPath, `${rollbackPath}-shm`);
        fs.renameSync(stagingPath, databasePath);

        newDb = openDatabase(databasePath);
        runMigrations(newDb, migrationsDir);
        newDb.prepare('SELECT 1').get(); // health check
      } catch (err) {
        if (newDb) closeDatabase(newDb);
        rollbackToOriginal();
        const recovered = openDatabase(databasePath);
        throw new BackupError(
          'Restore failed verification and was rolled back to the previous database.',
          { cause: err, db: recovered }
        );
      } finally {
        removeIfExists(stagingPath);
      }

      // Success — the prior database is no longer needed.
      removeIfExists(rollbackPath);
      removeIfExists(`${rollbackPath}-wal`);
      removeIfExists(`${rollbackPath}-shm`);

      return { db: newDb, filename, restoredAt: new Date().toISOString() };
    } finally {
      endRestore();
    }
  }

  return {
    createBackup,
    validateBackup,
    listBackups,
    restoreBackup,
    deleteBackup,
    pruneBackups,
    isRestoreInProgress: () => restoreInProgress,
  };
}
