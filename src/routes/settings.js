import express from 'express';
import { BackupError } from '../services/backup-service.js';
import { invalidateAllSessionsForDb } from '../services/auth-service.js';
import { clearSessionCookie } from '../middleware/auth.js';
import { formatRelativeTime } from '../util/date.js';
import {
  AssetCategoryValidationError,
  AssetCategoryNotFoundError,
} from '../services/asset-category-service.js';
import { AssetCategoryValidationError as PreferenceValidationError } from '../services/asset-browser-preference-service.js';
import { buildGlobalAssetBrowserPreferenceModel } from '../services/asset-browser-preference-presenter.js';
import { parseEnabledField } from '../services/asset-category-validation.js';

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
  authentication_disabled: {
    variant: 'warning',
    text: 'Authentication has been disabled. Anyone who can reach this server can access CreatorCrate.',
  },
  auth_already_enabled: { variant: 'error', text: 'Authentication is already enabled.' },
  auth_already_disabled: { variant: 'error', text: 'Authentication is already disabled.' },
  auth_transition_conflict: {
    variant: 'error',
    text: 'Another authentication change is already in progress. Please try again in a moment.',
  },
  auth_transition_failed: {
    variant: 'error',
    text: 'Could not change the authentication setting. The previous configuration is still active.',
  },
  category_added: { variant: 'success', text: 'Asset category default added.' },
  category_updated: { variant: 'success', text: 'Asset category default updated.' },
  category_enabled: { variant: 'success', text: 'Asset category default enabled.' },
  category_disabled: { variant: 'success', text: 'Asset category default disabled.' },
  category_deleted: { variant: 'success', text: 'Asset category default deleted.' },
  category_reordered: { variant: 'success', text: 'Asset category order updated.' },
  category_reorder_invalid: {
    variant: 'error',
    text: 'The submitted category order is invalid. Submit every global category exactly once.',
  },
  category_reorder_failed: {
    variant: 'error',
    text: 'Could not update the order. No changes were made.',
  },
  category_mutation_failed: {
    variant: 'error',
    text: 'Could not save the asset category default. Please try again.',
  },
  global_default_saved: { variant: 'success', text: 'Global asset-browser default saved.' },
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
function transitionFailureNotice(result) {
  if (result.alreadyEnabled) return 'auth_already_enabled';
  if (result.alreadyDisabled) return 'auth_already_disabled';
  if (result.conflict) return 'auth_transition_conflict';
  return 'auth_transition_failed';
}

function parseCategoryId(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id < 1 || String(id) !== String(value)) {
    return null;
  }
  return id;
}

// Directory-slug uniqueness is enforced by a case-insensitive unique index,
// not by the service's own validation — a conflicting insert/update throws
// straight from better-sqlite3 rather than an AssetCategoryValidationError.
function isDuplicateSlugError(err) {
  return (
    err != null &&
    err.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    typeof err.message === 'string' &&
    err.message.includes('asset_category_defaults')
  );
}

/**
 * Parse the batch reorder form contract: one `orderedCategoryIds` field whose
 * value is a comma-separated list of canonical positive integer IDs. An empty
 * string represents the complete empty set; a missing field is invalid.
 */
function parseOrderedCategoryIds(raw) {
  if (raw === undefined || raw === null) {
    throw new AssetCategoryValidationError({
      orderedCategoryIds: 'Submit the complete ordered category ID list.',
    });
  }
  if (Array.isArray(raw) || typeof raw !== 'string') {
    throw new AssetCategoryValidationError({
      orderedCategoryIds: 'Category IDs must be submitted as one comma-separated value.',
    });
  }
  if (raw === '') return [];
  if (!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(raw)) {
    throw new AssetCategoryValidationError({
      orderedCategoryIds: 'Category IDs must be canonical positive integers separated by commas.',
    });
  }

  const ids = raw.split(',').map((value) => Number(value));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new AssetCategoryValidationError({
      orderedCategoryIds: 'Category IDs must be safe positive integers.',
    });
  }
  return ids;
}

// Full order array with the given id swapped one position toward `direction`.
// Returns null if the id isn't present; returns the unchanged order if
// already at the boundary (a no-op move).
function buildMovedOrder(categories, id, direction) {
  const ids = categories.map((c) => c.id);
  const index = ids.indexOf(id);
  if (index === -1) return null;
  const swapWith = direction === 'up' ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= ids.length) return ids;
  const reordered = [...ids];
  [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];
  return reordered;
}

export function createSettingsRouter({
  appName,
  db,
  assetCategoryService,
  backupService,
  maintenanceState,
  authService,
  cookieOptions,
  onDatabaseReplaced,
  authTransitionService,
  projectsRoot,
  databasePath,
  appDataRoot,
  backupRetentionCount,
  authSettings,
  assetBrowserPreferenceService,
} = {}) {
  if (!assetBrowserPreferenceService) {
    throw new Error('createSettingsRouter requires an assetBrowserPreferenceService dependency.');
  }

  const router = express.Router();
  const replaceDatabase = typeof onDatabaseReplaced === 'function' ? onDatabaseReplaced : () => {};

  // GET never mutates — the overview only reads backup listings and
  // deployment-controlled configuration values, never edits them.
  router.get('/', (req, res) => {
    const backups = backupService.listBackups();
    res.render('settings/index.njk', {
      appName,
      authEnabled: Boolean(authService),
      username: res.locals.auth?.username || null,
      latestBackup: backups[0] || null,
      latestBackupRelative: backups[0] ? formatRelativeTime(backups[0].createdAt) : null,
      backupCount: backups.length,
      invalidBackupCount: backups.filter((b) => !b.valid).length,
      retentionCount: backupRetentionCount,
      paths: { projectsRoot, databasePath, appDataRoot },
      session: authSettings
        ? {
            ttlHours: authSettings.sessionTtlHours,
            cookieSecure: authSettings.cookieSecure,
            trustProxy: authSettings.trustProxy,
            hstsEnabled: authSettings.hstsEnabled,
          }
        : null,
    });
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

    // Phase 13 — guarded disable-authentication workflow. Only reachable
    // while authentication is enabled (requireAuth already protects it like
    // any other route; authTransitionService.disable() also independently
    // refuses if it somehow finds auth already disabled).
    router.get('/security/disable', (_req, res) => {
      res.render('settings/disable-confirm.njk', {
        appName,
        currentPasswordError: null,
      });
    });

    router.post('/security/disable', (req, res) => {
      const result = authTransitionService.disable({
        username: res.locals.auth?.username,
        currentPassword: req.body?.currentPassword,
      });
      if (!result.ok) {
        if (result.currentPasswordError) {
          res.status(400);
          res.render('settings/disable-confirm.njk', {
            appName,
            currentPasswordError: result.currentPasswordError,
          });
          return;
        }
        res.redirect(`/settings/security?notice=${transitionFailureNotice(result)}`);
        return;
      }
      clearSessionCookie(res, cookieOptions);
      res.redirect('/settings/security?notice=authentication_disabled');
    });
  } else {
    // Phase 13 — browser-based enable-authentication workflow. Available
    // only while authentication is disabled; the app has no session/auth
    // wall at all in this mode, so CSRF here is the disabled-mode anonymous
    // pepper-derived token (see middleware/csrf.js), not session-bound.
    router.get('/security', (req, res) => {
      res.render('settings/security-disabled.njk', {
        appName,
        notice: resolveNotice(req.query.notice),
        errors: [],
        retainedUsername: '',
      });
    });

    router.post('/security/enable', (req, res) => {
      const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
      const result = authTransitionService.enable({
        username,
        password: req.body?.password,
        confirmation: req.body?.confirmPassword,
      });
      if (!result.ok) {
        if (result.errors) {
          res.status(400);
          res.render('settings/security-disabled.njk', {
            appName,
            notice: null,
            errors: result.errors,
            retainedUsername: username,
          });
          return;
        }
        res.redirect(`/settings/security?notice=${transitionFailureNotice(result)}`);
        return;
      }
      res.redirect('/login?notice=authentication_enabled');
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

  // ─── Asset category defaults (Phase 1) ────────────────────────────────
  //
  // Database-only: every handler below talks exclusively to
  // assetCategoryService (already-constructed, injected explicitly — see
  // app.js). None of these routes touch project-storage, manifests, or the
  // filesystem. These are global *defaults* copied into new projects at
  // creation time; editing/disabling/deleting a default never reaches back
  // into project-owned categories already copied from it.

  function renderCategoriesPage(res, {
    status = 200,
    notice = null,
    editingId = null,
    editValues = null,
    editErrors = {},
    addValues = { enabled: true },
    addErrors = {},
    preferenceSubmittedValue,
    preferenceError = null,
    enabledControl = null,
  } = {}) {
    const categories = assetCategoryService.listDefaults();
    const assetBrowserPreference = buildGlobalAssetBrowserPreferenceModel({
      preferenceService: assetBrowserPreferenceService,
      categories,
      submittedValue: preferenceSubmittedValue,
      error: preferenceError,
    });
    res.status(status).render('settings/asset-categories.njk', {
      appName,
      categories,
      assetBrowserPreference,
      notice,
      editingId,
      editValues,
      editErrors,
      addValues,
      addErrors,
      enabledControl,
    });
  }

  router.get('/asset-categories', (req, res) => {
    const editingId = parseCategoryId(req.query.edit);
    let editValues = null;
    if (editingId !== null) {
      const found = assetCategoryService.listDefaults().find((c) => c.id === editingId);
      if (found) {
        editValues = { displayName: found.display_name, directorySlug: found.directory_slug };
      }
    }
    renderCategoriesPage(res, {
      notice: resolveNotice(req.query.notice),
      editingId: editValues ? editingId : null,
      editValues,
    });
  });

  router.post('/asset-categories/browser-default', (req, res) => {
    const submittedValue = typeof req.body?.defaultCategory === 'string' ? req.body.defaultCategory : '';
    try {
      assetBrowserPreferenceService.setGlobalPreference(submittedValue);
      res.redirect('/settings/asset-categories?notice=global_default_saved');
    } catch (err) {
      if (err instanceof PreferenceValidationError) {
        renderCategoriesPage(res, {
          status: 422,
          preferenceSubmittedValue: submittedValue,
          preferenceError: err,
        });
        return;
      }
      renderCategoriesPage(res, { status: 500 });
    }
  });

  router.post('/asset-categories', (req, res) => {
    const addValues = { displayName: req.body?.displayName, directorySlug: req.body?.directorySlug, enabled: true };
    try {
      addValues.enabled = parseEnabledField(req.body?.enabled, { defaultValue: true });
      assetCategoryService.addDefault({
        displayName: req.body?.displayName,
        directorySlug: req.body?.directorySlug,
        enabled: addValues.enabled,
      });
      res.redirect('/settings/asset-categories?notice=category_added');
    } catch (err) {
      if (err instanceof AssetCategoryValidationError) {
        renderCategoriesPage(res, { status: 422, addValues, addErrors: err.errors });
        return;
      }
      if (isDuplicateSlugError(err)) {
        renderCategoriesPage(res, {
          status: 422,
          addValues,
          addErrors: { directorySlug: 'A category with this directory slug already exists.' },
        });
        return;
      }
      renderCategoriesPage(res, { status: 500, addValues, notice: resolveNotice('category_mutation_failed') });
    }
  });

  // Complete-set reorder mutation. Registered before the generic
  // '/asset-categories/:id' route below so the literal "reorder" segment is
  // never captured as an :id param. The existing Move Up/Move Down routes
  // below use the same service operation after building their full order.
  router.post('/asset-categories/reorder', (req, res) => {
    try {
      const orderedIds = parseOrderedCategoryIds(req.body?.orderedCategoryIds);
      assetCategoryService.reorderDefaults(orderedIds);
      res.redirect('/settings/asset-categories?notice=category_reordered');
    } catch (err) {
      if (err instanceof AssetCategoryValidationError) {
        return renderCategoriesPage(res, {
          status: 422,
          notice: resolveNotice('category_reorder_invalid'),
        });
      }
      res.redirect('/settings/asset-categories?notice=category_reorder_failed');
    }
  });

  router.post('/asset-categories/:id', (req, res, next) => {
    const id = parseCategoryId(req.params.id);
    if (id === null) return next(createNotFound());

    const editValues = { displayName: req.body?.displayName, directorySlug: req.body?.directorySlug };
    try {
      assetCategoryService.editDefault(id, editValues);
      res.redirect('/settings/asset-categories?notice=category_updated');
    } catch (err) {
      if (err instanceof AssetCategoryNotFoundError) {
        return next(createNotFound());
      }
      if (err instanceof AssetCategoryValidationError) {
        renderCategoriesPage(res, { status: 422, editingId: id, editValues, editErrors: err.errors });
        return;
      }
      if (isDuplicateSlugError(err)) {
        renderCategoriesPage(res, {
          status: 422,
          editingId: id,
          editValues,
          editErrors: { directorySlug: 'A category with this directory slug already exists.' },
        });
        return;
      }
      renderCategoriesPage(res, { status: 500, editingId: id, editValues, notice: resolveNotice('category_mutation_failed') });
    }
  });

  router.post('/asset-categories/:id/enable', (req, res, next) => {
    const id = parseCategoryId(req.params.id);
    if (id === null) return next(createNotFound());
    try {
      assetCategoryService.setDefaultEnabled(id, true);
      res.redirect('/settings/asset-categories?notice=category_enabled');
    } catch (err) {
      if (err instanceof AssetCategoryNotFoundError) return next(createNotFound());
      next(err);
    }
  });

  router.post('/asset-categories/:id/enabled', (req, res, next) => {
    const id = parseCategoryId(req.params.id);
    if (id === null) return next(createNotFound());

    let enabled;
    try {
      enabled = parseEnabledField(req.body?.enabled);
    } catch (err) {
      if (err instanceof AssetCategoryValidationError) {
        return renderCategoriesPage(res, {
          status: 422,
          enabledControl: {
            categoryId: id,
            submitted: null,
            errorMessage: err.errors.enabled || err.message,
          },
        });
      }
      return next(err);
    }

    try {
      assetCategoryService.setDefaultEnabled(id, enabled);
      const notice = enabled ? 'category_enabled' : 'category_disabled';
      res.redirect(`/settings/asset-categories?notice=${notice}`);
    } catch (err) {
      if (err instanceof AssetCategoryNotFoundError) return next(createNotFound());
      next(err);
    }
  });

  router.post('/asset-categories/:id/disable', (req, res, next) => {
    const id = parseCategoryId(req.params.id);
    if (id === null) return next(createNotFound());
    try {
      assetCategoryService.setDefaultEnabled(id, false);
      res.redirect('/settings/asset-categories?notice=category_disabled');
    } catch (err) {
      if (err instanceof AssetCategoryNotFoundError) return next(createNotFound());
      next(err);
    }
  });

  router.post('/asset-categories/:id/delete', (req, res, next) => {
    const id = parseCategoryId(req.params.id);
    if (id === null) return next(createNotFound());
    try {
      assetCategoryService.deleteDefault(id);
      res.redirect('/settings/asset-categories?notice=category_deleted');
    } catch (err) {
      if (err instanceof AssetCategoryNotFoundError) return next(createNotFound());
      next(err);
    }
  });

  router.post('/asset-categories/:id/move-up', (req, res, next) => {
    const id = parseCategoryId(req.params.id);
    if (id === null) return next(createNotFound());
    const categories = assetCategoryService.listDefaults();
    const orderedIds = buildMovedOrder(categories, id, 'up');
    if (!orderedIds) return next(createNotFound());
    try {
      assetCategoryService.reorderDefaults(orderedIds);
      res.redirect('/settings/asset-categories?notice=category_reordered');
    } catch {
      res.redirect('/settings/asset-categories?notice=category_reorder_failed');
    }
  });

  router.post('/asset-categories/:id/move-down', (req, res, next) => {
    const id = parseCategoryId(req.params.id);
    if (id === null) return next(createNotFound());
    const categories = assetCategoryService.listDefaults();
    const orderedIds = buildMovedOrder(categories, id, 'down');
    if (!orderedIds) return next(createNotFound());
    try {
      assetCategoryService.reorderDefaults(orderedIds);
      res.redirect('/settings/asset-categories?notice=category_reordered');
    } catch {
      res.redirect('/settings/asset-categories?notice=category_reorder_failed');
    }
  });

  return router;
}
