import 'dotenv/config';

import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createConfig, ConfigError } from './config.js';
import { validateMounts, FilesystemError } from './filesystem.js';
import { ensureStatusDirs, StorageError } from './storage/path-manager.js';
import { openDatabase, runMigrations, closeDatabase, DatabaseError } from './db.js';
import { createProjectService } from './services/project-service.js';
import { createApp } from './app.js';

async function main() {
  let config;
  try {
    config = createConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  try {
    validateMounts(config);
  } catch (err) {
    if (err instanceof FilesystemError) {
      console.error(`Filesystem error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  try {
    ensureStatusDirs(config.projectsRoot);
  } catch (err) {
    if (err instanceof StorageError) {
      console.error(`Storage error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const db = openDatabase(config.databasePath);

  try {
    runMigrations(db, fileURLToPath(new URL('../migrations', import.meta.url)));
  } catch (err) {
    closeDatabase(db);
    if (err instanceof DatabaseError) {
      console.error(`Database error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // Backfill project directories for existing Phase 2 records with no path
  const backfillService = createProjectService(db, config.projectsRoot);
  const backfillResults = backfillService.backfillProjectDirs();
  if (backfillResults.errors.length > 0) {
    console.error(
      `[CreatorCrate] Backfill completed with ${backfillResults.errors.length} error(s). ` +
      `Check logs above for details.`
    );
  }

  const app = createApp({ appName: config.appName, db, projectsRoot: config.projectsRoot });

  const server = app.listen(config.port, () => {
    console.log(`${config.appName} listening on port ${config.port} in ${config.nodeEnv} mode`);
  });

  function shutdown() {
    server.close(() => {
      closeDatabase(db);
      process.exit(0);
    });
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
