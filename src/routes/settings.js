import express from 'express';
import { BackupError } from '../services/backup-service.js';
import { invalidateAllSessionsForDb } from '../services/auth-service.js';
import { clearSessionCookie } from '../middleware/auth.js';

function createNotFound() {
  const err = new Error('Not found');
  err.status = 404;
  return err;
}

// Controlled, curated notice text keyed by a fixed code — never the raw
// exception message, so an internal failure detail can never reach a
// rendered page (see BackupError's own message-safety contract).
const NOTICES = {
  backup_created: { variant: 'success', text: 'Backup created successfully.' },
  backup_failed: { variant: 'error', text: 'Backup creation failed. The previous backups are unaffected.' },
  restore_success: { variant: 'success', text: 'Database restored from the selected backup.' },
  restore_failed: { variant: 'error', text: 'Restore failed. The database was left unchanged.' },
  restore_conflict: { variant: 'warning', text: 'A restore is already in progress. Please wait for it to finish.' },
  backup_deleted: { variant: 'success', text: 'Backup deleted.' },
  delete_failed: { variant: 'error', text: 'Could not delete the backup. It may have already been removed.' },
  password_rotated: { variant: 'success', text: 'Password changed. Sign in again with the new password.' },
  backup_created_prune_warning: {
    variant: 'warning',
    text: 'Backup created successfully, but one or more older backups could not be automatically pruned. Check the backup directory permissions.',
  },
};

function resolveNotice(code) {
  return Object.prototype.hasOwnProperty.call(NOTICES, code) ? NOTICES[code] : null;
}

/**
 * Phase 11.2 — server-rendered backup management and guarded restore.
 *
 * @param {object} opts
 * @param {string} opts.appName
 * @param {import('better-sqlite3').Database} opts.db - the app's live connection
 * @param {ReturnType<import('../services/backup-service.js').createBackupService>} opts.backupService
 * @param {{active: boolean}} opts.maintenanceState - shared, mutated in place
 * @param {(newDb: import('better-sqlite3').Database) => void} [opts.onDatabaseReplaced]
 *   Called after a restore (success or a rolled-back failure) leaves the
 *   caller with a new live connection. The caller is responsible for
 *   re-pointing every other service/route at it — this module never touches
 *   any connection but the one it was given.
 */
export function createSettingsRouter({ appName, db, backupService, maintenanceState, authService, cookieOptions, onDatabaseReplaced }) {
  const router = express.Router();
  const replaceDatabase = typeof onDatabaseReplaced === 'function' ? onDatabaseReplaced : () => {};

  router.get('/', (_req, res) => {
    res.render('settings/index.njk', { appName });
  });

  // GET never mutates — listing only reads the managed backup directory.
  router.get('/backups', (req, res) => {
    const backups = backupService.listBackups();
    res.render('settings/backups.njk', {
      appName,
      backups,
      notice: resolveNotice(req.query.notice),
    });
  });

  if (authService) {
    router.get('/security', (req, res) => {
      res.render('settings/security.njk', {
        appName,
        notice: resolveNotice(req.query.notice),
        errors: [],
        currentPasswordError: null,
      });
    });

    router.post('/security/password', (req, res) => {
      const result = authService.rotatePassword({
        currentPassword: req.body?.currentPassword,
        newPassword: req.body?.newPassword,
        confirmation: req.body?.confirmPassword,
      });
      if (!result.ok) {
        res.status(400);
        res.render('settings/security.njk', {
          appName,
          notice: null,
          errors: result.errors || [],
          currentPasswordError: result.currentPasswordError || null,
        });
        return;
      }
      clearSessionCookie(res, cookieOptions);
      res.redirect('/login?notice=password_rotated');
    });
  }

  router.post('/backups', async (req, res) => {
    try {
      const result = await backupService.createBackup(db);
      const notice = result.pruneWarnings && result.pruneWarnings.length > 0
        ? 'backup_created_prune_warning'
        : 'backup_created';
      res.redirect(`/settings/backups?notice=${notice}`);
    } catch {
      // Never surface the internal exception text — createBackup already
      // discards any partial/staging file before rejecting.
      res.redirect('/settings/backups?notice=backup_failed');
    }
  });

  // GET never mutates — this is purely the confirmation view.
  router.get('/backups/:filename/restore', (req, res, next) => {
    const backup = backupService.listBackups().find((entry) => entry.filename === req.params.filename);
    if (!backup) {
      return next(createNotFound());
    }
    res.render('settings/restore-confirm.njk', { appName, backup });
  });

  router.post('/backups/:filename/restore', async (req, res) => {
    // Belt-and-suspenders: the maintenance middleware in app.js already
    // rejects ordinary requests once `maintenanceState.active` is set, but
    // that flag is only set *after* this handler begins running, so two
    // near-simultaneous submissions could both reach here before either
    // flips it. Checking both this flag and the service's own guard closes
    // that window without weakening either boundary.
    if (maintenanceState.active || backupService.isRestoreInProgress()) {
      return res.redirect('/settings/backups?notice=restore_conflict');
    }

    maintenanceState.active = true;
    try {
      // restoreBackup re-resolves and re-validates the filename itself —
      // traversal, symlink, missing, staging/rollback, and invalid-schema
      // backups are all rejected there, never trusted from the URL alone.
      const result = await backupService.restoreBackup(req.params.filename, db);
      // Phase 12.1: a restored database may carry session rows from whenever
      // the backup was taken — potentially long-lived, no longer trustworthy
      // sessions. Wipe them on the connection being adopted, before any
      // request can resolve against it, rather than relying on whichever
      // authService happens to be rebuilt around it. Best-effort: a real
      // restored connection always supports this, but must never block
      // adopting the connection if it somehow doesn't.
      try { invalidateAllSessionsForDb(result.db); } catch { /* best-effort */ }
      replaceDatabase(result.db);
      res.redirect('/settings/backups?notice=restore_success');
    } catch (err) {
      // A BackupError carrying `.db` means the live database was already
      // closed and a recovered connection was reopened before this handler
      // sees the error — the caller must adopt it even though the restore
      // itself failed, or every other route is left holding a closed handle.
      if (err instanceof BackupError && err.db) {
        try { invalidateAllSessionsForDb(err.db); } catch { /* best-effort */ }
        replaceDatabase(err.db);
      }
      res.redirect('/settings/backups?notice=restore_failed');
    } finally {
      maintenanceState.active = false;
    }
  });

  // GET never mutates — this is purely the confirmation view.
  router.get('/backups/:filename/delete', (req, res, next) => {
    const backup = backupService.listBackups().find((entry) => entry.filename === req.params.filename);
    if (!backup) {
      return next(createNotFound());
    }
    res.render('settings/delete-confirm.njk', { appName, backup });
  });

  router.post('/backups/:filename/delete', (req, res) => {
    try {
      // deleteBackup re-resolves and re-checks the filename itself —
      // traversal, symlink, staging/rollback, and unmanaged names are all
      // rejected there, never trusted from the URL alone.
      backupService.deleteBackup(req.params.filename);
      res.redirect('/settings/backups?notice=backup_deleted');
    } catch {
      res.redirect('/settings/backups?notice=delete_failed');
    }
  });

  return router;
}
