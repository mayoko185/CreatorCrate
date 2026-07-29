import path from 'node:path';
import process from 'node:process';

const DEFAULTS = {
  NODE_ENV: 'development',
  PORT: '3000',
  APP_NAME: 'CreatorCrate',
  APP_DATA_ROOT: './data/app',
  PROJECTS_ROOT: './data/projects',
  DATABASE_PATH: './data/app/creatorcrate.db',
  // Phase 11.3: keep the 10 most recent managed backups after each
  // successful backup; set to "0" to disable automatic pruning entirely.
  BACKUP_RETENTION_COUNT: '10',
};

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function getEnv(rawEnv, key) {
  const value = rawEnv[key];
  return value === undefined || value === '' ? DEFAULTS[key] : value;
}

export function createConfig(rawEnv = process.env) {
  const nodeEnv = getEnv(rawEnv, 'NODE_ENV');
  const appName = getEnv(rawEnv, 'APP_NAME');

  const portRaw = getEnv(rawEnv, 'PORT');
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`Invalid PORT "${portRaw}". Expected an integer between 1 and 65535.`);
  }

  const appDataRoot = path.resolve(getEnv(rawEnv, 'APP_DATA_ROOT'));
  const projectsRoot = path.resolve(getEnv(rawEnv, 'PROJECTS_ROOT'));
  const databasePath = path.resolve(getEnv(rawEnv, 'DATABASE_PATH'));

  const relativeDb = path.relative(appDataRoot, databasePath);
  if (
    relativeDb === '' ||
    relativeDb.startsWith('..') ||
    path.isAbsolute(relativeDb)
  ) {
    throw new ConfigError(
      `DATABASE_PATH "${databasePath}" must be located within APP_DATA_ROOT "${appDataRoot}".`
    );
  }

  // Phase 10.1A: preview root derives from APP_DATA_ROOT/previews.
  // Not directly configurable — it is a derived, owned directory of the app.
  const previewRoot = path.join(appDataRoot, 'previews');

  // Phase 11.1: backup directory derives from APP_DATA_ROOT/backups.
  // Not directly configurable — it is a derived, owned directory of the app.
  // Contains SQLite application-data backups only; PROJECTS_ROOT media files
  // are never included.
  const backupDir = path.join(appDataRoot, 'backups');

  // Phase 11.3: number of managed backups to retain after each successful
  // backup. Must be a non-negative integer; 0 disables automatic pruning
  // (all managed backups are kept indefinitely) rather than being treated
  // as invalid, so operators have an explicit opt-out.
  const retentionRaw = getEnv(rawEnv, 'BACKUP_RETENTION_COUNT');
  const backupRetentionCount = Number(retentionRaw);
  if (!Number.isInteger(backupRetentionCount) || backupRetentionCount < 0) {
    throw new ConfigError(
      `Invalid BACKUP_RETENTION_COUNT "${retentionRaw}". Expected a non-negative integer (0 disables automatic pruning).`
    );
  }

  return Object.freeze({
    nodeEnv,
    port,
    appName,
    appDataRoot,
    projectsRoot,
    databasePath,
    previewRoot,
    backupDir,
    backupRetentionCount,
  });
}
