import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword, isValidPasswordHash, verifyPassword } from './password-hash.js';

const CREDENTIAL_FILENAME = 'operator-credential.json';
const MIN_PASSWORD_LENGTH = 12;
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_.-]{1,62}[a-z0-9])?$/;

export class CredentialError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'CredentialError';
  }
}

export function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function validateUsername(value) {
  return USERNAME_PATTERN.test(normalizeUsername(value));
}

function ensureContained(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function credentialFilePathForRoot(appDataRoot) {
  const root = path.resolve(appDataRoot);
  const filePath = path.resolve(root, CREDENTIAL_FILENAME);
  if (!ensureContained(root, filePath)) {
    throw new CredentialError('Managed credential path escapes APP_DATA_ROOT.');
  }
  return filePath;
}

function validateCredentialRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new CredentialError('Managed credential file is malformed.');
  }
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'passwordHash' || keys[1] !== 'username') {
    throw new CredentialError('Managed credential file is malformed.');
  }
  const username = normalizeUsername(record.username);
  if (!validateUsername(username) || username !== record.username) {
    throw new CredentialError('Managed credential file has an invalid username.');
  }
  if (!isValidPasswordHash(record.passwordHash)) {
    throw new CredentialError('Managed credential file has an invalid password hash.');
  }
  return Object.freeze({ username, passwordHash: record.passwordHash });
}

function assertUsableExistingFile(filePath) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw new CredentialError('Cannot access managed credential file.', { cause: err });
  }
  if (stats.isSymbolicLink()) {
    throw new CredentialError('Managed credential file is a symbolic link. Refusing to use it.');
  }
  if (!stats.isFile()) {
    throw new CredentialError('Managed credential path exists but is not a regular file.');
  }
  return true;
}

function readCredentialFile(filePath) {
  assertUsableExistingFile(filePath);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new CredentialError('Cannot read managed credential file.', { cause: err });
  }
  try {
    return validateCredentialRecord(JSON.parse(raw));
  } catch (err) {
    if (err instanceof CredentialError) throw err;
    throw new CredentialError('Managed credential file is malformed.', { cause: err });
  }
}

function fsyncDirectory(dirPath) {
  try {
    const dirFd = fs.openSync(dirPath, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch {
    // Directory fsync is not supported on every platform/filesystem.
  }
}

function writeCredentialFile(filePath, record) {
  const credential = validateCredentialRecord(record);
  const dirPath = path.dirname(filePath);
  const root = path.resolve(dirPath);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  const rootStats = fs.lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new CredentialError('APP_DATA_ROOT is not a usable managed credential directory.');
  }
  if (assertUsableExistingFile(filePath)) {
    // Existing target already verified as a regular, non-symlink file.
  }

  const tmpName = `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const tmpPath = path.join(root, tmpName);
  const data = `${JSON.stringify(credential, null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o600);
    fs.writeFileSync(fd, data, 'utf8');
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } catch (err) {
    try { if (fd !== undefined) fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw new CredentialError('Cannot write managed credential file.', { cause: err });
  }
  fs.closeSync(fd);

  try {
    assertUsableExistingFile(filePath);
    fs.renameSync(tmpPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
    fsyncDirectory(root);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    if (err instanceof CredentialError) throw err;
    throw new CredentialError('Cannot publish managed credential file.', { cause: err });
  }
  return credential;
}

export function validateNewPassword(password, confirmation) {
  const errors = [];
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    errors.push(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (typeof password === 'string' && /^\s|\s$/.test(password)) {
    errors.push('New password must not start or end with whitespace.');
  }
  if (password !== confirmation) {
    errors.push('New password and confirmation must match.');
  }
  return errors;
}

export function createStaticCredentialProvider({ username, passwordHash }) {
  let credential = validateCredentialRecord({ username: normalizeUsername(username), passwordHash });
  return {
    getCredential() {
      return credential;
    },
    updatePasswordHash(nextHash) {
      credential = validateCredentialRecord({ username: credential.username, passwordHash: nextHash });
      return credential;
    },
    verifyPassword(candidatePassword) {
      return verifyPassword(candidatePassword, credential.passwordHash);
    },
  };
}

export function createManagedCredentialProvider({ appDataRoot, bootstrapUsername, bootstrapPasswordHash }) {
  const filePath = credentialFilePathForRoot(appDataRoot);
  let credential;
  if (assertUsableExistingFile(filePath)) {
    credential = readCredentialFile(filePath);
  } else {
    credential = writeCredentialFile(filePath, {
      username: normalizeUsername(bootstrapUsername),
      passwordHash: bootstrapPasswordHash,
    });
  }

  return {
    filePath,
    getCredential() {
      return credential;
    },
    updatePasswordHash(nextHash) {
      credential = writeCredentialFile(filePath, { username: credential.username, passwordHash: nextHash });
      return credential;
    },
    verifyPassword(candidatePassword) {
      return verifyPassword(candidatePassword, credential.passwordHash);
    },
  };
}

export function rotateCredentialPassword(provider, { currentPassword, newPassword, confirmation }) {
  const credential = provider.getCredential();
  if (!verifyPassword(currentPassword, credential.passwordHash)) {
    return { ok: false, currentPasswordError: 'Current password is incorrect.', errors: [] };
  }
  const errors = validateNewPassword(newPassword, confirmation);
  if (errors.length > 0) {
    return { ok: false, currentPasswordError: null, errors };
  }
  const passwordHash = hashPassword(newPassword);
  provider.updatePasswordHash(passwordHash);
  return { ok: true };
}
