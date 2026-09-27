/**
 * Filesystem primitives for legacy `project.json` cleanup (PM-2).
 *
 * Only three exact CreatorCrate-owned name families directly inside an
 * already verified project root are ever inspected or removed:
 *   - `project.json` (the legacy manifest, exact lowercase name);
 *   - `.<12 hex>.project.json.tmp` (the legacy writer's temporary file,
 *     see `isManifestTempFile`);
 *   - `.project.json.cleanup-<time>-<18 hex>` (this module's own quarantine
 *     name, left behind only if a removal was interrupted or its moved entry
 *     could not be put back). Such a leftover is removed only when it, too,
 *     is proven redundant; otherwise it is kept where it is, never guessed
 *     back into place.
 * Nothing here decides whether an entry is redundant; the cleanup service
 * does, and passes back the evidence captured when it inspected the entry.
 *
 * Removal is never "compare, then unlink the pathname". The proven entry is
 * atomically renamed to an unpredictable sibling quarantine name, the moved
 * entry is re-inspected and must match the inspected content fingerprint
 * (and, where the filesystem reports a usable one, the operation-local file
 * identity), and only then is the quarantine name unlinked. Anything else
 * that was moved is put back without clobbering (link(2), or an
 * exclusive-create copy where links are unsupported), and anything that
 * cannot be put back is left in quarantine rather than deleted. A restoration
 * copy that was created but not verified is never unlinked by pathname: an
 * identity check followed by unlink(2) is a race another actor can win, so
 * the destination is left exactly as found. File IDs are never persisted; a
 * zero ID (common on SMB) is "unknown", never proof.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LEGACY_MANIFEST_EVIDENCE_MAX_BYTES, MANIFEST_FILENAME, isManifestTempFile } from './manifest.js';

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export const LEGACY_MANIFEST_CLEANUP_QUARANTINE_PREFIX = `.${MANIFEST_FILENAME}.cleanup-`;
const QUARANTINE_RE = /^\.project\.json\.cleanup-[0-9a-z]{1,16}-[0-9a-f]{18}$/;

// Filesystems without link(2) report one of these; restore then falls back
// to an exclusive-create copy.
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EINVAL', 'EMLINK']);

/** @returns {boolean} whether `name` is this module's own quarantine name */
export function isLegacyManifestCleanupQuarantineName(name) {
  return typeof name === 'string' && QUARANTINE_RE.test(name);
}

/**
 * Classify a project-root entry name into a cleanup candidate kind, or null
 * for every other name (which cleanup never touches).
 * @returns {'manifest'|'temp'|'quarantine'|null}
 */
export function legacyManifestCandidateKind(name) {
  if (name === MANIFEST_FILENAME) return 'manifest';
  if (isManifestTempFile(name)) return 'temp';
  if (isLegacyManifestCleanupQuarantineName(name)) return 'quarantine';
  return null;
}

// Same rule as `isKnownDirectoryIdentity` (project-directory-ownership.js):
// a zero ID (SMB) or a numeric ID past 2^53 is "unknown", never proof.
function knownIdentity(identity) {
  if (!identity) return false;
  const { ino } = identity;
  if (typeof ino === 'bigint') return ino > 0n;
  return Number.isSafeInteger(ino) && ino > 0;
}

function sameIdentity(a, b) {
  // An unknown (zero) file ID proves nothing either way: the fingerprint
  // is then the continuity proof. Never use this to authorize deleting a
  // path another actor may now own.
  if (!knownIdentity(a) || !knownIdentity(b)) return true;
  return a.dev === b.dev && a.ino === b.ino;
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
 * Safely read one candidate entry. Never follows a symlink and never throws
 * for filesystem conditions.
 *
 * @returns {{ status: 'missing' }
 *   | { status: 'unsafe', reason: 'symlink'|'not-regular-file'|'changed-during-read' }
 *   | { status: 'unreadable', code: string|null }
 *   | { status: 'file', oversized: boolean, bytes: Buffer,
 *       evidence: { fingerprint: string, identity: { dev: bigint, ino: bigint } } }}
 */
export function inspectLegacyManifestEntry(entryPath) {
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
    if (!opened.isFile() || !sameIdentity(opened, before)
      || (knownIdentity(opened) !== knownIdentity(before))) {
      return { status: 'unsafe', reason: 'changed-during-read' };
    }
    // One byte past the bound so growth after the size check is caught.
    const buffer = Buffer.alloc(LEGACY_MANIFEST_EVIDENCE_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    const bytes = Buffer.from(buffer.subarray(0, length));
    return {
      status: 'file',
      oversized: length > LEGACY_MANIFEST_EVIDENCE_MAX_BYTES,
      bytes,
      evidence: {
        fingerprint: `${length}:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
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

function matchesEvidence(entryPath, evidence) {
  const entry = inspectLegacyManifestEntry(entryPath);
  if (entry.status !== 'file') return { ok: false, entry };
  return {
    ok: entry.evidence.fingerprint === evidence.fingerprint
      && sameIdentity(entry.evidence.identity, evidence.identity),
    entry,
  };
}

function quarantineName() {
  return `${LEGACY_MANIFEST_CLEANUP_QUARANTINE_PREFIX}${Date.now().toString(36)}-${crypto.randomBytes(9).toString('hex')}`;
}

// Put the entry at `fromPath` back at `toPath` without ever replacing an
// entry that now occupies `toPath`. Returns 'restored', 'occupied', 'gone'
// or 'failed'; anything but 'restored'/'gone' leaves `fromPath` in place.
function restoreEntry(fromPath, toPath) {
  try {
    fs.lstatSync(fromPath);
  } catch (err) {
    return err.code === 'ENOENT' ? 'gone' : 'failed';
  }
  try {
    fs.linkSync(fromPath, toPath);
    try { fs.unlinkSync(fromPath); } catch { /* both names hold the same file */ }
    fsyncDirectory(path.dirname(toPath));
    return 'restored';
  } catch (err) {
    if (err.code === 'EEXIST') return 'occupied';
    if (!LINK_UNSUPPORTED.has(err.code)) return 'failed';
  }

  // Without link(2): copy the exact bytes into an O_CREAT|O_EXCL file.
  const source = inspectLegacyManifestEntry(fromPath);
  if (source.status === 'missing') return 'gone';
  if (source.status !== 'file' || source.oversized) return 'failed';
  let fd;
  try {
    fd = fs.openSync(toPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o644);
  } catch (err) {
    return err.code === 'EEXIST' ? 'occupied' : 'failed';
  }
  let identity = null;
  let written = false;
  try {
    identity = fs.fstatSync(fd, { bigint: true });
    let offset = 0;
    while (offset < source.bytes.length) {
      offset += fs.writeSync(fd, source.bytes, offset, source.bytes.length - offset);
    }
    fs.fsyncSync(fd);
    written = true;
  } catch { /* reported below */ }
  try { fs.closeSync(fd); } catch { written = false; }

  if (written) {
    fsyncDirectory(path.dirname(toPath));
    const copy = matchesEvidence(toPath, { fingerprint: source.evidence.fingerprint, identity });
    if (copy.ok) {
      // The original stays unless it is still exactly what was copied.
      const original = matchesEvidence(fromPath, source.evidence);
      if (original.ok) {
        try { fs.unlinkSync(fromPath); } catch { /* a duplicate copy remains */ }
      }
      return 'restored';
    }
  }
  // The copy is now exposed at `toPath` but unverified. It is left exactly
  // as found, never unlinked, renamed over or replaced: no identity check
  // (known file IDs included) can authorize a later pathname unlink, because
  // another actor may replace the entry between the check and the unlink.
  // The quarantined original stays as recovery evidence and the caller
  // reports a retryable failure; a later pass classifies both from scratch.
  return 'failed';
}

/**
 * Remove the entry `name` directly inside `dirPath`, but only if the entry
 * removed is exactly the one inspected (`evidence` from
 * {@link inspectLegacyManifestEntry}). Never throws for filesystem
 * conditions.
 *
 * @returns {{ status: 'removed' }
 *   | { status: 'gone' }         the entry vanished before it could be moved
 *   | { status: 'changed', retained: boolean }  another entry was there; it
 *       was put back (`retained`: it could not be, and stays in quarantine)
 *   | { status: 'unavailable', retained: boolean }  an I/O failure; nothing
 *       unproven was deleted
 *   | { status: 'quarantined' }  proven and moved aside, but the final unlink
 *       failed: a verified duplicate remains under a quarantine name}
 */
export function removeProvenLegacyManifestEntry(dirPath, name, evidence) {
  if (!evidence?.fingerprint || !legacyManifestCandidateKind(name)) {
    throw new Error('A recognized legacy manifest entry and its inspection evidence are required.');
  }
  const entryPath = path.join(dirPath, name);

  let quarantinePath = null;
  for (let attempt = 0; attempt < 8 && !quarantinePath; attempt++) {
    const candidate = path.join(dirPath, quarantineName());
    try {
      fs.lstatSync(candidate);
      continue; // Name in use: never rename onto an existing entry.
    } catch (err) {
      if (err.code !== 'ENOENT') return { status: 'unavailable', retained: false };
    }
    try {
      fs.renameSync(entryPath, candidate);
      quarantinePath = candidate;
    } catch (err) {
      if (err.code === 'EEXIST' || err.code === 'ENOTEMPTY') continue;
      // A failed reply does not prove the rename did not happen (a share can
      // apply it and lose the response): look before concluding.
      let landed = false;
      try { fs.lstatSync(candidate); landed = true; } catch { /* not moved */ }
      if (!landed) return err.code === 'ENOENT' ? { status: 'gone' } : { status: 'unavailable', retained: false };
      const restore = restoreEntry(candidate, entryPath);
      return { status: 'unavailable', retained: restore !== 'restored' && restore !== 'gone' };
    }
  }
  if (!quarantinePath) return { status: 'unavailable', retained: false };
  fsyncDirectory(dirPath);

  const check = matchesEvidence(quarantinePath, evidence);
  if (!check.ok) {
    const restore = restoreEntry(quarantinePath, entryPath);
    const retained = restore !== 'restored' && restore !== 'gone';
    return check.entry.status === 'unreadable'
      ? { status: 'unavailable', retained }
      : { status: 'changed', retained };
  }
  try {
    fs.unlinkSync(quarantinePath);
  } catch (err) {
    if (err.code !== 'ENOENT') return { status: 'quarantined' };
  }
  fsyncDirectory(dirPath);
  return { status: 'removed' };
}
