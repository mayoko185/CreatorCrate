import path from 'node:path';
import process from 'node:process';
import { credentialFilePathForRoot } from './auth/credential-provider.js';

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
  // Phase 12.1: fixed (non-rolling) session lifetime and default to
  // non-HTTPS-only cookies so a bare `pnpm start` behind plain HTTP still
  // works out of the box; operators terminating HTTPS at a reverse proxy
  // must opt into COOKIE_SECURE=true explicitly (see docs).
  SESSION_TTL_HOURS: '24',
  COOKIE_SECURE: 'false',
  TRUST_PROXY: 'false',
  HSTS_ENABLED: 'false',
  PERSIST_DEBUG_LOGS: 'false',
};

const MAX_SESSION_TTL_HOURS = 720; // 30 days
const MINUTE_IN_MILLISECONDS = 60 * 1000;
const MAX_NODE_TIMER_DELAY_MILLISECONDS = 2_147_483_647;
const MAX_AUTO_SCAN_INTERVAL_MINUTES = Math.floor(
  MAX_NODE_TIMER_DELAY_MILLISECONDS / MINUTE_IN_MILLISECONDS
);

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

function parseCanonicalInteger(rawValue) {
  if (typeof rawValue !== 'string' || !/^(?:0|[1-9]\d*)$/.test(rawValue)) {
    return null;
  }

  const value = Number(rawValue);
  return Number.isSafeInteger(value) ? value : null;
}

function parseOptionalPositiveIntegerEnv(rawEnv, key) {
  const rawValue = rawEnv[key];
  if (rawValue === undefined || rawValue === '') return null;

  if (typeof rawValue !== 'string' || !/^[1-9]\d*$/.test(rawValue)) {
    throw new ConfigError(
      `Invalid ${key} "${rawValue}". Expected a positive integer number of minutes, or an empty value to disable automatic scanning.`
    );
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value)) {
    throw new ConfigError(
      `Invalid ${key} "${rawValue}". Expected a positive integer number of minutes, or an empty value to disable automatic scanning.`
    );
  }

  return value;
}

export function createConfig(rawEnv = process.env) {
  const nodeEnv = getEnv(rawEnv, 'NODE_ENV');
  const appName = getEnv(rawEnv, 'APP_NAME');

  const portRaw = getEnv(rawEnv, 'PORT');
  const port = parseCanonicalInteger(portRaw);
  if (port === null || port < 1 || port > 65535) {
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
  const backupRetentionCount = parseCanonicalInteger(retentionRaw);
  if (backupRetentionCount === null || backupRetentionCount < 0) {
    throw new ConfigError(
      `Invalid BACKUP_RETENTION_COUNT "${retentionRaw}". Expected a non-negative integer (0 disables automatic pruning).`
    );
  }

  // Deployment-controlled setting only. An absent or empty value disables
  // automatic scanning; src/server.js owns the recurring scheduler lifecycle.
  const autoScanIntervalMinutes = parseOptionalPositiveIntegerEnv(
    rawEnv,
    'AUTO_SCAN_INTERVAL_MINUTES'
  );
  if (
    autoScanIntervalMinutes !== null &&
    autoScanIntervalMinutes > MAX_AUTO_SCAN_INTERVAL_MINUTES
  ) {
    throw new ConfigError(
      `Invalid AUTO_SCAN_INTERVAL_MINUTES "${rawEnv.AUTO_SCAN_INTERVAL_MINUTES}". Expected a positive integer number of minutes no greater than ${MAX_AUTO_SCAN_INTERVAL_MINUTES}, or an empty value to disable automatic scanning.`
    );
  }

  // ─── Phase 13: authentication settings (identity is managed, not env) ──
  // Authentication is optional and browser-managed (see src/auth/auth-state.js
  // and src/auth/auth-transition-service.js) — username, password hash, and
  // session secret are never read from the environment. Only genuinely
  // deployment-level settings live here, and they apply regardless of
  // whether authentication is currently enabled.

  const sessionTtlRaw = getEnv(rawEnv, 'SESSION_TTL_HOURS');
  const sessionTtlHours = Number(sessionTtlRaw);
  if (!Number.isInteger(sessionTtlHours) || sessionTtlHours < 1 || sessionTtlHours > MAX_SESSION_TTL_HOURS) {
    throw new ConfigError(
      `Invalid SESSION_TTL_HOURS "${sessionTtlRaw}". Expected an integer between 1 and ${MAX_SESSION_TTL_HOURS}.`
    );
  }

  const cookieSecureRaw = getEnv(rawEnv, 'COOKIE_SECURE').trim().toLowerCase();
  if (cookieSecureRaw !== 'true' && cookieSecureRaw !== 'false') {
    throw new ConfigError(`Invalid COOKIE_SECURE "${cookieSecureRaw}". Expected "true" or "false".`);
  }
  // Deployments terminating HTTPS at a reverse proxy must set this to
  // "true" explicitly; it is never inferred from forwarding headers, which
  // are untrusted unless proxy trust is separately configured.
  const cookieSecure = cookieSecureRaw === 'true';

  const trustProxyRaw = getEnv(rawEnv, 'TRUST_PROXY').trim().toLowerCase();
  if (trustProxyRaw !== 'true' && trustProxyRaw !== 'false') {
    throw new ConfigError(`Invalid TRUST_PROXY "${trustProxyRaw}". Expected "true" or "false".`);
  }
  const trustProxy = trustProxyRaw === 'true';

  const hstsEnabledRaw = getEnv(rawEnv, 'HSTS_ENABLED').trim().toLowerCase();
  if (hstsEnabledRaw !== 'true' && hstsEnabledRaw !== 'false') {
    throw new ConfigError(`Invalid HSTS_ENABLED "${hstsEnabledRaw}". Expected "true" or "false".`);
  }
  const hstsEnabled = hstsEnabledRaw === 'true';

  const persistDebugLogsRaw = getEnv(rawEnv, 'PERSIST_DEBUG_LOGS').trim().toLowerCase();
  if (persistDebugLogsRaw !== 'true' && persistDebugLogsRaw !== 'false') {
    throw new ConfigError(`Invalid PERSIST_DEBUG_LOGS "${persistDebugLogsRaw}". Expected "true" or "false".`);
  }
  const persistDebugLogs = persistDebugLogsRaw === 'true';

  const managedCredentialPath = credentialFilePathForRoot(appDataRoot);

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
    autoScanIntervalMinutes,
    persistDebugLogs,
    auth: Object.freeze({
      sessionTtlHours,
      cookieSecure,
      trustProxy,
      hstsEnabled,
      managedCredentialPath,
    }),
  });
}
