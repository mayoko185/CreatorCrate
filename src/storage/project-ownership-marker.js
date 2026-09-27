/**
 * Project-directory ownership marker primitives.
 *
 * The marker is a tiny CreatorCrate-internal file that witnesses which
 * logical project a directory belongs to. It carries only a format version
 * and the opaque ownership token also persisted in SQLite
 * (`project_directory_ownership`). It holds no business metadata and is not
 * a replacement for the legacy `project.json` manifest.
 *
 * On-disk format (version 1), exactly 86 bytes of ASCII:
 *
 *     creatorcrate-owner/1 <token>\n
 *
 * where <token> is 64 lowercase hex characters, separated from the version
 * by one space and followed by one LF. Nothing else is accepted: no BOM, no
 * CR, no extra whitespace, lines, or fields.
 *
 * The marker represents logical ownership, not physical directory identity.
 * It travels with the project tree, so a moved (or marker-preserving copied)
 * directory still carries the same token. No inode/file-ID is recorded.
 *
 * Nothing here decides policy: callers compare results against SQLite and
 * decide what to do. Nothing here repairs or rebinds a marker on its own. The
 * only way an existing marker is ever set aside is the quarantine primitives
 * at the end of this module, which explicit operator recovery (PM-1C2) uses;
 * no automatic path calls them.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PROJECT_OWNERSHIP_MARKER_FILENAME = '.creatorcrate-owner';
export const PROJECT_OWNERSHIP_MARKER_VERSION = 1;

const TOKEN_BYTES = 32;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const MARKER_PREFIX = `creatorcrate-owner/${PROJECT_OWNERSHIP_MARKER_VERSION} `;
const MARKER_RE = /^creatorcrate-owner\/1 ([0-9a-f]{64})\n$/;

/** Exact size of a valid version-1 marker. */
export const PROJECT_OWNERSHIP_MARKER_SIZE = MARKER_PREFIX.length + 64 + 1;
/** Larger files are rejected without being fully read. */
export const PROJECT_OWNERSHIP_MARKER_MAX_BYTES = 256;

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export class ProjectOwnershipMarkerError extends Error {
  constructor(message, { code, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ProjectOwnershipMarkerError';
    this.code = code;
  }
}

// ─── Token ──────────────────────────────────────────────────────────────

/** @returns {string} a new 64-character lowercase-hex ownership token */
export function generateProjectOwnershipToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/** @returns {boolean} whether `value` is a well-formed ownership token */
export function isValidProjectOwnershipToken(value) {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

function requireToken(value) {
  if (!isValidProjectOwnershipToken(value)) {
    throw new ProjectOwnershipMarkerError('Ownership token is invalid.', { code: 'INVALID_TOKEN' });
  }
  return value;
}

// ─── Format ─────────────────────────────────────────────────────────────

/** @returns {string} the exact version-1 marker content for `token` */
export function serializeProjectOwnershipMarker(token) {
  return `${MARKER_PREFIX}${requireToken(token)}\n`;
}

/**
 * Strictly parse marker bytes.
 * @param {Buffer} buffer
 * @returns {string|null} the token, or null when the bytes are not exactly
 *   one valid version-1 marker
 */
export function parseProjectOwnershipMarker(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== PROJECT_OWNERSHIP_MARKER_SIZE) return null;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return null;
  }
  const match = MARKER_RE.exec(text);
  return match ? match[1] : null;
}

/**
 * Whether a single path segment names the reserved marker. Case-insensitive,
 * because on case-insensitive filesystems any casing resolves to the marker.
 */
export function isProjectOwnershipMarkerName(name) {
  return typeof name === 'string' && name.toLowerCase() === PROJECT_OWNERSHIP_MARKER_FILENAME;
}

// ─── Paths ──────────────────────────────────────────────────────────────

/**
 * The marker is always a direct child of the project directory. Callers pass
 * a project directory already resolved by the project-path safety checks;
 * the marker location itself is never caller-supplied.
 */
export function projectOwnershipMarkerPath(projectDir) {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) {
    throw new ProjectOwnershipMarkerError('Project directory must be an absolute path.', {
      code: 'INVALID_PROJECT_DIRECTORY',
    });
  }
  return path.join(path.resolve(projectDir), PROJECT_OWNERSHIP_MARKER_FILENAME);
}

function sameObject(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

// A marker inside a symlinked or non-directory "project directory" is not
// inside the validated project directory.
function inspectProjectDir(projectDir) {
  let stats;
  try {
    stats = fs.lstatSync(projectDir, { bigint: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return { status: 'unsafe', reason: 'project-directory-missing' };
    return { status: 'unreadable', code: err.code ?? null };
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return { status: 'unsafe', reason: 'project-directory-not-directory' };
  }
  return null;
}

// ─── Read / verify ──────────────────────────────────────────────────────

/**
 * Safely read the ownership marker of an already validated project directory.
 *
 * Result classes:
 * - `{ status: 'valid', token }` — a regular file containing exactly one
 *   version-1 marker.
 * - `{ status: 'missing' }` — no marker entry exists.
 * - `{ status: 'malformed', reason }` — a regular file whose content is not
 *   a valid marker (`'oversized'`, `'invalid-format'`).
 * - `{ status: 'unsafe', reason }` — the marker (or project directory) is a
 *   symlink, directory, or other non-regular entry, or changed while it was
 *   being read.
 * - `{ status: 'unreadable', code }` — an I/O or permission failure. This is
 *   uncertainty, never evidence of a mismatch.
 *
 * Never throws for filesystem conditions; throws only for an invalid
 * `projectDir` argument.
 */
export function readProjectOwnershipMarker(projectDir) {
  const markerPath = projectOwnershipMarkerPath(projectDir);
  const dirProblem = inspectProjectDir(path.dirname(markerPath));
  if (dirProblem) return dirProblem;

  let before;
  try {
    before = fs.lstatSync(markerPath, { bigint: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable', code: err.code ?? null };
  }
  if (before.isSymbolicLink()) return { status: 'unsafe', reason: 'symlink' };
  if (!before.isFile()) return { status: 'unsafe', reason: 'not-regular-file' };
  if (before.size > BigInt(PROJECT_OWNERSHIP_MARKER_MAX_BYTES)) {
    return { status: 'malformed', reason: 'oversized' };
  }

  let fd;
  try {
    try {
      fd = fs.openSync(markerPath, fs.constants.O_RDONLY | O_NOFOLLOW);
    } catch (err) {
      if (err.code === 'ENOENT') return { status: 'missing' };
      if (err.code === 'ELOOP') return { status: 'unsafe', reason: 'symlink' };
      return { status: 'unreadable', code: err.code ?? null };
    }
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameObject(opened, before)) {
      return { status: 'unsafe', reason: 'changed-during-read' };
    }
    // Read one byte past the bound so growth after the size check is caught.
    const buffer = Buffer.alloc(PROJECT_OWNERSHIP_MARKER_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    if (length > PROJECT_OWNERSHIP_MARKER_MAX_BYTES) return { status: 'malformed', reason: 'oversized' };
    const token = parseProjectOwnershipMarker(buffer.subarray(0, length));
    return token === null ? { status: 'malformed', reason: 'invalid-format' } : { status: 'valid', token };
  } catch (err) {
    return { status: 'unreadable', code: err.code ?? null };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* read already complete or failed */ }
    }
  }
}

/**
 * Compare the marker against an expected token. No repair is attempted.
 *
 * @returns {{ status: 'match' } | { status: 'mismatch' }
 *   | Exclude<ReturnType<typeof readProjectOwnershipMarker>, { status: 'valid' }>}
 */
export function verifyProjectOwnershipMarker(projectDir, expectedToken) {
  requireToken(expectedToken);
  const result = readProjectOwnershipMarker(projectDir);
  if (result.status !== 'valid') return result;
  return { status: result.token === expectedToken ? 'match' : 'mismatch' };
}

// ─── Create ─────────────────────────────────────────────────────────────

function fsyncDirectory(dirPath) {
  try {
    const dirFd = fs.openSync(dirPath, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch {
    // Directory fsync is not supported on every platform/filesystem.
  }
}

/**
 * Exclusively create the ownership marker for `token`, then read it back and
 * confirm it before reporting success.
 *
 * The file is opened with O_CREAT|O_EXCL, so an existing entry of any kind
 * (marker, symlink, directory) is never overwritten or followed. The content
 * is written in place and fsynced; the parent directory is fsynced where the
 * platform allows. A crash mid-write can leave a partial marker, which later
 * reads report as `malformed`.
 *
 * Once the exclusive create succeeds the marker pathname is public, and any
 * later failure (write, fsync, close, read-back, token check, final stat)
 * leaves whatever occupies it exactly as found. The entry may be this
 * operation's partial or unverified marker or a foreign replacement; no
 * pathname check can prove which without a window before the unlink, so it
 * is never removed, renamed, truncated, or reopened. The caller receives
 * `RECOVERY_REQUIRED` and must route the directory through ownership
 * recovery.
 *
 * @returns {{ status: 'created' } | { status: 'exists' }} `exists` means an
 *   entry was already present and was left untouched; callers verify it.
 * @throws {ProjectOwnershipMarkerError} code `INVALID_TOKEN`,
 *   `PROJECT_DIRECTORY_UNSAFE`, `PROJECT_DIRECTORY_UNREADABLE`, or
 *   `WRITE_FAILED` when nothing was created; `RECOVERY_REQUIRED` (with the
 *   `WRITE_FAILED` or `VERIFY_FAILED` failure as `cause`) when the marker
 *   pathname was exposed and then could not be confirmed.
 */
export function createProjectOwnershipMarker(projectDir, token) {
  const content = Buffer.from(serializeProjectOwnershipMarker(token), 'ascii');
  const markerPath = projectOwnershipMarkerPath(projectDir);
  const dirPath = path.dirname(markerPath);
  const dirProblem = inspectProjectDir(dirPath);
  if (dirProblem) {
    throw new ProjectOwnershipMarkerError('Project directory cannot hold an ownership marker.', {
      code: dirProblem.status === 'unsafe' ? 'PROJECT_DIRECTORY_UNSAFE' : 'PROJECT_DIRECTORY_UNREADABLE',
    });
  }

  let fd;
  try {
    fd = fs.openSync(markerPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o644);
  } catch (err) {
    if (err.code === 'EEXIST') return { status: 'exists' };
    throw new ProjectOwnershipMarkerError('Cannot create ownership marker.', { code: 'WRITE_FAILED', cause: err });
  }

  let identity = null;
  let failure;
  try {
    identity = fs.fstatSync(fd, { bigint: true });
    let written = 0;
    while (written < content.length) {
      written += fs.writeSync(fd, content, written, content.length - written);
    }
    fs.fsyncSync(fd);
  } catch (err) {
    failure = new ProjectOwnershipMarkerError('Cannot write ownership marker.', { code: 'WRITE_FAILED', cause: err });
  }
  try {
    fs.closeSync(fd);
  } catch (err) {
    failure ??= new ProjectOwnershipMarkerError('Cannot write ownership marker.', { code: 'WRITE_FAILED', cause: err });
  }

  if (!failure) {
    fsyncDirectory(dirPath);
    const check = readProjectOwnershipMarker(dirPath);
    let current = null;
    try { current = fs.lstatSync(markerPath, { bigint: true }); } catch { /* reported below */ }
    if (check.status === 'valid' && check.token === token && current && sameObject(current, identity)) {
      return { status: 'created' };
    }
    failure = new ProjectOwnershipMarkerError('Ownership marker did not verify after creation.', {
      code: 'VERIFY_FAILED',
    });
  }

  // The public entry is retained as evidence: see the note above.
  throw new ProjectOwnershipMarkerError('Ownership marker recovery required.', {
    code: 'RECOVERY_REQUIRED',
    cause: failure,
  });
}

// ─── Explicit-recovery quarantine (PM-1C2) ──────────────────────────────
//
// Replacing a marker is never unlink-then-create. Explicit operator recovery
// instead: inspects the entry and captures operation-local evidence (content
// fingerprint plus, where the filesystem reports one, dev/ino); atomically
// renames it to an unpredictable sibling quarantine name; proves the entry it
// moved is the one it inspected (restoring it otherwise); creates the new
// marker exclusively; and discards the quarantined entry only after the
// binding committed. Nothing here is persisted across requests, and a zero
// file ID (common on network shares) simply leaves the fingerprint as proof.

/** Basename prefix of a marker set aside by explicit recovery. */
export const PROJECT_OWNERSHIP_MARKER_QUARANTINE_PREFIX = `${PROJECT_OWNERSHIP_MARKER_FILENAME}.quarantine-`;

// Filesystems without link(2) support report one of these; restore then
// falls back to an exclusive-create copy (never check-then-rename, which can
// replace a marker that appears between the check and the rename).
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL', 'EMLINK']);

function sameEvidenceIdentity(a, b) {
  // A zero file ID is "unknown", not an identity: rely on the fingerprint.
  if (!a || !b || a.ino === 0n || b.ino === 0n) return true;
  return a.dev === b.dev && a.ino === b.ino;
}

// Open one regular, non-symlink file and fingerprint at most MAX_BYTES + 1
// bytes of it. Never follows a symlink.
function fingerprintEntry(entryPath) {
  let before;
  try {
    before = fs.lstatSync(entryPath, { bigint: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable', code: err.code ?? null };
  }
  if (before.isSymbolicLink()) return { status: 'unsafe', reason: 'symlink' };
  if (!before.isFile()) return { status: 'unsafe', reason: 'not-regular-file' };
  let fd;
  try {
    try {
      fd = fs.openSync(entryPath, fs.constants.O_RDONLY | O_NOFOLLOW);
    } catch (err) {
      if (err.code === 'ENOENT') return { status: 'missing' };
      if (err.code === 'ELOOP') return { status: 'unsafe', reason: 'symlink' };
      return { status: 'unreadable', code: err.code ?? null };
    }
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameObject(opened, before)) {
      return { status: 'unsafe', reason: 'changed-during-read' };
    }
    const buffer = Buffer.alloc(PROJECT_OWNERSHIP_MARKER_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    const bytes = buffer.subarray(0, length);
    const oversized = length > PROJECT_OWNERSHIP_MARKER_MAX_BYTES;
    const token = oversized ? null : parseProjectOwnershipMarker(bytes);
    return {
      status: 'file',
      token,
      reason: token ? null : (oversized ? 'oversized' : 'invalid-format'),
      oversized,
      bytes,
      evidence: {
        fingerprint: `${opened.size}:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
        identity: { dev: opened.dev, ino: opened.ino },
      },
    };
  } catch (err) {
    return { status: 'unreadable', code: err.code ?? null };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* read already complete or failed */ }
    }
  }
}

/**
 * Inspect the marker of an already validated project directory for explicit
 * recovery. Same classes as {@link readProjectOwnershipMarker}; `valid` and
 * `malformed` results additionally carry operation-local `evidence`
 * ({ fingerprint, identity }) that {@link quarantineProjectOwnershipMarker}
 * requires. Evidence is meaningful only within the current recovery attempt.
 */
export function inspectProjectOwnershipMarker(projectDir) {
  const markerPath = projectOwnershipMarkerPath(projectDir);
  const dirProblem = inspectProjectDir(path.dirname(markerPath));
  if (dirProblem) return dirProblem;
  const entry = fingerprintEntry(markerPath);
  if (entry.status !== 'file') return entry;
  return entry.token
    ? { status: 'valid', token: entry.token, evidence: entry.evidence }
    : { status: 'malformed', reason: entry.reason, evidence: entry.evidence };
}

function quarantineName() {
  return `${PROJECT_OWNERSHIP_MARKER_QUARANTINE_PREFIX}${Date.now().toString(36)}-${crypto.randomBytes(9).toString('hex')}`;
}

function matchesEvidence(entryPath, evidence) {
  const entry = fingerprintEntry(entryPath);
  if (entry.status !== 'file') return { ok: false, entry };
  return {
    ok: entry.evidence.fingerprint === evidence.fingerprint
      && sameEvidenceIdentity(entry.evidence.identity, evidence.identity),
    entry,
  };
}

const retainedAfter = (restore) => restore !== 'restored' && restore !== 'gone';

// Without link(2): copy the quarantined bytes into a marker opened with
// O_CREAT|O_EXCL, so an entry that appeared at the marker path is never
// replaced. The quarantine is copied only while it is still the entry this
// attempt set aside, and discarded only after the copy verifies. Once the
// copy is visible at the marker path, a restore that does not verify leaves
// both the public entry and the quarantine exactly as found: any pathname
// cleanup could delete a marker that replaced the copy after it was observed.
function restoreByExclusiveCopy(markerPath, quarantine) {
  const source = matchesEvidence(quarantine.path, quarantine.evidence ?? {});
  if (source.entry.status === 'missing') return 'gone';
  if (!source.ok || source.entry.oversized) return 'failed';
  const { bytes, evidence } = source.entry;

  let fd;
  try {
    fd = fs.openSync(markerPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o644);
  } catch (err) {
    return err.code === 'EEXIST' ? 'occupied' : 'failed';
  }
  let identity = null;
  let written = false;
  try {
    identity = fs.fstatSync(fd, { bigint: true });
    let offset = 0;
    while (offset < bytes.length) {
      offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    }
    fs.fsyncSync(fd);
    written = true;
  } catch { /* reported below */ }
  try {
    fs.closeSync(fd);
  } catch {
    written = false;
  }

  if (written) {
    fsyncDirectory(path.dirname(markerPath));
    const copy = fingerprintEntry(markerPath);
    if (copy.status === 'file' && copy.evidence.fingerprint === evidence.fingerprint
      && sameEvidenceIdentity(copy.evidence.identity, identity)) {
      return discardQuarantinedProjectOwnershipMarker({ path: quarantine.path, evidence }) ? 'restored' : 'restored-retained';
    }
  }
  return 'failed';
}

/**
 * Put a quarantined marker back at the marker path, never replacing whatever
 * occupies it now. Uses link(2), which fails rather than clobbers, where the
 * filesystem supports it; otherwise an exclusive-create copy of the exact
 * quarantined bytes. Anything short of a verified restore keeps the
 * quarantine as evidence.
 *
 * @returns {'restored'|'restored-retained'|'occupied'|'gone'|'failed'}
 *   `restored-retained`: restored, but the quarantine could not be removed.
 */
export function restoreQuarantinedProjectOwnershipMarker(projectDir, quarantine) {
  const markerPath = projectOwnershipMarkerPath(projectDir);
  try {
    fs.lstatSync(quarantine.path);
  } catch (err) {
    return err.code === 'ENOENT' ? 'gone' : 'failed';
  }
  try {
    fs.linkSync(quarantine.path, markerPath);
    try { fs.unlinkSync(quarantine.path); } catch { /* both names hold the same file */ }
    fsyncDirectory(path.dirname(markerPath));
    return 'restored';
  } catch (err) {
    if (err.code === 'EEXIST') return 'occupied';
    if (!LINK_UNSUPPORTED.has(err.code)) return 'failed';
  }
  return restoreByExclusiveCopy(markerPath, quarantine);
}

/**
 * Atomically move the marker entry aside to an operation-owned quarantine
 * name in the same project directory, then prove the moved entry is the one
 * inspected (`evidence` from {@link inspectProjectOwnershipMarker}). A moved
 * entry that does not match is restored without clobbering.
 *
 * @returns {{ status: 'quarantined', quarantine: { path: string, evidence: object } }
 *   | { status: 'changed', retained: boolean }} `changed`: the marker vanished
 *   or was not the inspected entry. `retained`: an entry was left quarantined
 *   because it could not be restored.
 * @throws {ProjectOwnershipMarkerError} code `QUARANTINE_FAILED` on an I/O
 *   failure (with `retained` as above).
 */
export function quarantineProjectOwnershipMarker(projectDir, evidence) {
  const markerPath = projectOwnershipMarkerPath(projectDir);
  const dirPath = path.dirname(markerPath);
  if (!evidence?.fingerprint) {
    throw new ProjectOwnershipMarkerError('Marker evidence is required.', { code: 'INVALID_EVIDENCE' });
  }
  const quarantineFailed = (cause, retained = false) => Object.assign(
    new ProjectOwnershipMarkerError('Cannot quarantine ownership marker.', { code: 'QUARANTINE_FAILED', cause }),
    { retained },
  );

  let quarantinePath = null;
  for (let attempt = 0; attempt < 8 && !quarantinePath; attempt++) {
    const candidate = path.join(dirPath, quarantineName());
    try {
      fs.lstatSync(candidate);
      continue; // Name in use: never rename onto an existing entry.
    } catch (err) {
      if (err.code !== 'ENOENT') throw quarantineFailed(err);
    }
    try {
      fs.renameSync(markerPath, candidate);
      quarantinePath = candidate;
    } catch (err) {
      if (err.code === 'EEXIST' || err.code === 'ENOTEMPTY') continue;
      // A failed reply does not prove the rename did not happen (a share can
      // apply it and lose the response): look before concluding.
      let landed = false;
      try { fs.lstatSync(candidate); landed = true; } catch { /* not moved */ }
      if (err.code === 'ENOENT' && !landed) return { status: 'changed', retained: false };
      if (!landed) throw quarantineFailed(err);
      const restore = restoreQuarantinedProjectOwnershipMarker(projectDir, { path: candidate, evidence });
      throw quarantineFailed(err, retainedAfter(restore));
    }
  }
  if (!quarantinePath) throw quarantineFailed();
  fsyncDirectory(dirPath);

  const quarantine = { path: quarantinePath, evidence };
  const check = matchesEvidence(quarantinePath, evidence);
  if (!check.ok) {
    // Put back what was actually moved, as observed just now.
    const moved = check.entry.status === 'file' ? { path: quarantinePath, evidence: check.entry.evidence } : quarantine;
    const restore = restoreQuarantinedProjectOwnershipMarker(projectDir, moved);
    if (check.entry.status === 'unreadable') throw quarantineFailed(null, retainedAfter(restore));
    return { status: 'changed', retained: retainedAfter(restore) };
  }
  return { status: 'quarantined', quarantine };
}

/**
 * Remove a quarantined marker once the replacement binding committed, only
 * while it is still exactly the quarantined entry.
 *
 * @returns {boolean} whether no quarantined entry remains
 */
export function discardQuarantinedProjectOwnershipMarker(quarantine) {
  const check = matchesEvidence(quarantine.path, quarantine.evidence);
  if (!check.ok) return check.entry.status === 'missing';
  try {
    fs.unlinkSync(quarantine.path);
    return true;
  } catch (err) {
    return err.code === 'ENOENT';
  }
}
