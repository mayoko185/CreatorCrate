// Phase 13 — managed auth-enablement state: the authority for *whether*
// authentication is currently on, plus the session secret (while enabled)
// and a persistent CSRF pepper (present in both modes — see
// middleware/csrf.js's disabled-mode CSRF design for why it must survive
// restarts and never be derivable from anything a client can read).
//
// Kept deliberately separate from operator-credential.json
// (credential-provider.js manages username+passwordHash there) — that file
// already has full, passing test coverage for its atomic/symlink-safe
// contract, and merging the two would force-touch a lot of unrelated
// coverage for no functional gain. Together the two files form one logical
// managed-auth-state.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const AUTH_STATE_FILENAME = 'auth-enablement.json';
const HEX64 = /^[0-9a-f]{64}$/;

export class AuthStateError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'AuthStateError';
  }
}

function ensureContained(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function authStateFilePathForRoot(appDataRoot) {
  const root = path.resolve(appDataRoot);
  const filePath = path.resolve(root, AUTH_STATE_FILENAME);
  if (!ensureContained(root, filePath)) {
    throw new AuthStateError('Managed auth-state path escapes APP_DATA_ROOT.');
  }
  return filePath;
}

function assertUsableExistingFile(filePath) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw new AuthStateError('Cannot access managed auth-state file.', { cause: err });
  }
  if (stats.isSymbolicLink()) {
    throw new AuthStateError('Managed auth-state file is a symbolic link. Refusing to use it.');
  }
  if (!stats.isFile()) {
    throw new AuthStateError('Managed auth-state path exists but is not a regular file.');
  }
  return true;
}

function isHex64(value) {
  return typeof value === 'string' && HEX64.test(value);
}

// Validates the shape a record must have to be written or accepted as
// having been read from disk. Note: this is stricter than
// `readAuthEnablement`'s in-memory "file absent" synthetic result, which
// never passes through here.
function validateAuthStateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new AuthStateError('Managed auth-state file is malformed.');
  }
  if (typeof record.enabled !== 'boolean') {
    throw new AuthStateError('Managed auth-state file is malformed.');
  }

  if (record.enabled) {
    const keys = Object.keys(record).sort();
    const expected = ['csrfPepper', 'enabled', 'sessionSecret', 'updatedAt'];
    if (keys.length !== expected.length || expected.some((k, i) => keys[i] !== k)) {
      throw new AuthStateError('Managed auth-state file is malformed.');
    }
    if (!isHex64(record.sessionSecret)) {
      throw new AuthStateError('Managed auth-state file has an invalid session secret.');
    }
    if (!isHex64(record.csrfPepper)) {
      throw new AuthStateError('Managed auth-state file has an invalid CSRF pepper.');
    }
    if (typeof record.updatedAt !== 'string' || Number.isNaN(Date.parse(record.updatedAt))) {
      throw new AuthStateError('Managed auth-state file has an invalid updatedAt.');
    }
    return Object.freeze({
      enabled: true,
      sessionSecret: record.sessionSecret,
      csrfPepper: record.csrfPepper,
      updatedAt: record.updatedAt,
    });
  }

  const keys = Object.keys(record).sort();
  const expected = ['csrfPepper', 'enabled'];
  if (keys.length !== expected.length || expected.some((k, i) => keys[i] !== k)) {
    throw new AuthStateError('Managed auth-state file is malformed.');
  }
  if (!isHex64(record.csrfPepper)) {
    throw new AuthStateError('Managed auth-state file has an invalid CSRF pepper.');
  }
  return Object.freeze({ enabled: false, csrfPepper: record.csrfPepper });
}

function fsyncDirectory(dirPath) {
  try {
    const dirFd = fs.openSync(dirPath, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch {
    // Directory fsync is not supported on every platform/filesystem.
  }
}

/**
 * The sole atomic-write primitive for the managed auth-state file. Never
 * called directly by routes — only by `ensureAuthEnablement`,
 * `enableAuthState`, and `disableAuthState` below.
 */
export function writeAuthEnablementAtomic(appDataRoot, record) {
  const validated = validateAuthStateRecord(record);
  const filePath = authStateFilePathForRoot(appDataRoot);
  const root = path.dirname(filePath);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  const rootStats = fs.lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new AuthStateError('APP_DATA_ROOT is not a usable managed auth-state directory.');
  }
  assertUsableExistingFile(filePath);

  const tmpName = `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const tmpPath = path.join(root, tmpName);
  const data = `${JSON.stringify(validated, null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o600);
    fs.writeFileSync(fd, data, 'utf8');
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } catch (err) {
    try { if (fd !== undefined) fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw new AuthStateError('Cannot write managed auth-state file.', { cause: err });
  }
  fs.closeSync(fd);

  try {
    assertUsableExistingFile(filePath);
    fs.renameSync(tmpPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
    fsyncDirectory(root);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    if (err instanceof AuthStateError) throw err;
    throw new AuthStateError('Cannot publish managed auth-state file.', { cause: err });
  }
  return validated;
}

/**
 * Read-only. Never writes. An absent file means "nothing persisted yet" —
 * returned as `{ enabled: false, csrfPepper: null }`, distinct from a
 * genuine on-disk disabled record (which always carries a real pepper).
 * Callers that need a guaranteed pepper must call `ensureAuthEnablement`
 * explicitly instead.
 */
export function readAuthEnablement(appDataRoot) {
  const filePath = authStateFilePathForRoot(appDataRoot);
  if (!assertUsableExistingFile(filePath)) {
    return { enabled: false, csrfPepper: null };
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new AuthStateError('Cannot read managed auth-state file.', { cause: err });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AuthStateError('Managed auth-state file is malformed.', { cause: err });
  }
  return validateAuthStateRecord(parsed);
}

/**
 * The one place that creates the initial disabled state (with a freshly
 * generated CSRF pepper) when the file is absent. A no-op — returns the
 * existing state unchanged — if the file already exists. Called explicitly
 * once during server startup; never implicitly from `readAuthEnablement`.
 */
export function ensureAuthEnablement(appDataRoot) {
  const state = readAuthEnablement(appDataRoot);
  if (state.csrfPepper) return state;
  const csrfPepper = crypto.randomBytes(32).toString('hex');
  return writeAuthEnablementAtomic(appDataRoot, { enabled: false, csrfPepper });
}

export function generateSessionSecret() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Transitions to enabled, preserving the existing CSRF pepper. Callers
 * (auth-transition-service.js) are responsible for the surrounding
 * snapshot/rollback discipline — this function is just the atomic write.
 */
export function enableAuthState(appDataRoot, { sessionSecret, csrfPepper }) {
  return writeAuthEnablementAtomic(appDataRoot, {
    enabled: true,
    sessionSecret,
    csrfPepper,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Transitions to disabled, preserving the existing CSRF pepper and dropping
 * the session secret. Does not touch the credential file — see
 * auth-transition-service.js's credential-file contract.
 */
export function disableAuthState(appDataRoot, { csrfPepper }) {
  return writeAuthEnablementAtomic(appDataRoot, { enabled: false, csrfPepper });
}
