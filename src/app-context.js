import { createApp } from './app.js';
import { closeDatabase } from './db.js';
import { createProjectOperationCoordinator } from './services/project-operation-coordinator.js';

/**
 * Phase 11.2 live-restore fix — the mutable application context that owns
 * the currently active database connection and the Express app built from
 * it.
 *
 * Every route/service/repository in this application resolves its `db` at
 * `createApp` construction time (none of them are per-request lazy), so the
 * only way to make a restored connection actually reach requests is to
 * rebuild the whole service graph against it and swap which built app
 * instance answers requests — swapping the raw `db` reference alone would
 * leave every already-constructed repository/service closed over the old,
 * closed connection.
 *
 * Connection ownership: this module never closes a database connection the
 * caller has not already finished with. `backup-service` owns closing the
 * previous live connection and opening/verifying the restored one (see
 * `restoreBackup`); this module only ever closes a *new* connection it was
 * just handed, and only when building the new app around it throws, so
 * that connection is never leaked. The previous connection is not touched
 * here, successfully or otherwise.
 *
 * @param {object} deps
 * @param {string} deps.appName
 * @param {string} [deps.projectsRoot]
 * @param {string} [deps.previewRoot]
 * @param {object} [deps.appOpts] - forwarded to every `createApp` call
 *   (appDataRoot, databasePath, migrationsDir, backupService,
 *   maintenanceState, etc). `onDatabaseReplaced` is always overridden with
 *   this context's own `replaceDatabase`, so a restore always adopts into
 *   the same context that served the request that triggered it.
 * @param {import('better-sqlite3').Database} initialDb
 * @param {typeof createApp} [appFactory] - injectable for tests
 */
export function createApplicationContext(
  { appName, projectsRoot, previewRoot, appOpts = {} },
  initialDb,
  appFactory = createApp
) {
  // Phase 13: mutable so a runtime auth enable/disable (replaceAuthConfig)
  // can update just the `authConfig` slice without losing whatever else a
  // prior rebuild (e.g. a live restore) already carried forward. Never
  // mutated directly — always replaced wholesale by a candidate object only
  // after that candidate has already been proven to build successfully.
  let activeAppOpts = { ...appOpts };

  // Phase: asset actions chunk 3 — constructed exactly once per application
  // context (i.e. once per process, since server.js creates exactly one
  // context) and threaded through every buildApp call below, including
  // replaceDatabase and replaceAuthConfig rebuilds. This is what makes the
  // scanner and the asset action service share one lock across a live
  // database restore: buildApp always places it after `...opts`, so even a
  // stray same-named key in `opts` can never shadow the shared instance
  // with an independent one — exactly like onDatabaseReplaced/
  // onAuthConfigReplaced below.
  const projectOperationCoordinator = createProjectOperationCoordinator();

  function buildApp(db, opts) {
    return appFactory(
      { appName, db, projectsRoot, previewRoot },
      { ...opts, projectOperationCoordinator, onDatabaseReplaced: replaceDatabase, onAuthConfigReplaced: replaceAuthConfig }
    );
  }

  let current = { db: initialDb, app: buildApp(initialDb, activeAppOpts) };

  /**
   * Reconstruct every db-bound repository/service/route against `newDb` and
   * atomically swap the active context to it.
   *
   * On success: the new app becomes active in a single reference
   * assignment, so any request already resolving `current` before the swap
   * completes finishes against whichever context it read — there is no
   * window where a request sees a half-swapped context.
   *
   * On failure: `current` is left untouched (the previous context, if its
   * connection is still open, remains fully usable) and `newDb` is closed
   * here so it is never leaked.
   */
  function replaceDatabase(newDb) {
    let newApp;
    try {
      newApp = buildApp(newDb, activeAppOpts);
    } catch (err) {
      try { closeDatabase(newDb); } catch { /* best-effort */ }
      throw err;
    }
    current = { db: newDb, app: newApp };
  }

  /**
   * Phase 13 — swap just the auth configuration (enable/disable/rebuild
   * auth) against the *current* database, with no restart. Builds against a
   * candidate options object first; `activeAppOpts` and `current` are only
   * committed after `buildApp` returns successfully, so a failed rebuild
   * (e.g. a malformed authConfig) never leaves the live context out of sync
   * with what it's supposed to be running — the caller (auth-transition-
   * service.js) sees the thrown error and is responsible for rolling back
   * whatever managed-state files it had already written.
   */
  function replaceAuthConfig(newAuthConfig) {
    const candidateOpts = { ...activeAppOpts, authConfig: newAuthConfig };
    const newApp = buildApp(current.db, candidateOpts);
    activeAppOpts = candidateOpts;
    current = { db: current.db, app: newApp };
  }

  return {
    get db() {
      return current.db;
    },
    get app() {
      return current.app;
    },
    replaceDatabase,
    replaceAuthConfig,
    handleRequest(req, res) {
      current.app(req, res);
    },
  };
}
