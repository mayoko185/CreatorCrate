import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isKnownDirectoryIdentity } from './project-directory-ownership.js';
import { isDurableBirthtimeNs } from './asset-processing-shared.js';

// Descriptor-rooted file ownership.
//
// A pathname is CreatorCrate-owned only because CreatorCrate created it exclusively
// ('wx'/'wx+') and captured its exact bigint {dev, ino} from the descriptor it opened, before
// any fallible write. Nothing else establishes ownership: not a source's identity, not
// hard-link alias equality, not a hash, size or link count, not a pathname identity first
// observed after creation, and never a rounded Number dev/ino. A different file's identity
// (e.g. the source a copy reads from) is irrelevant to the destination's ownership, so a
// filesystem that gives each path its own inode number (SMB) needs no alias equality.
//
// Content verification (size, SHA-256) is reported separately: it proves bytes only and
// never grants deletion authority over a path.
//
// This module never removes a pathname on its own failure. Callers decide recovery
// semantics (a private stage and a public destination differ); `onOwned` hands them the
// owned exact identity before any write, and removeFileIfExactIdentityMatches is the only
// ownership-authorized unlink. `onCreated` only reports that the exclusive open succeeded
// (a path now exists that this call created): it never means owned, and a caller that sees
// it without `onOwned` holds a created-but-unclaimed path it can neither adopt nor remove.

export const OWNED_FILE_FAILURE = Object.freeze({
  // The exclusively created descriptor exposed no known exact identity (zero/unsafe IDs,
  // non-bigint) or is not a regular file. Nothing is claimed; the path is left as residue.
  identityUnknown: 'identity-unknown',
  // The owned descriptor itself reported a different exact identity after writing.
  descriptorChanged: 'descriptor-identity-changed',
  // Bytes written (or copied) do not match the expected size or SHA-256.
  contentMismatch: 'content-mismatch',
  // After close, the pathname no longer is the descriptor-created object.
  pathnameChanged: 'pathname-changed',
  // The copy source is not a regular file or not the exact object the caller trusted.
  sourceUnsafe: 'source-unsafe',
  // The copy source changed while it was read.
  sourceChanged: 'source-changed',
});

export class OwnedFileError extends Error {
  constructor(reason, message, options) {
    super(message, options);
    this.name = 'OwnedFileError';
    this.reason = reason;
  }
}

const COPY_CHUNK_BYTES = 1024 * 1024;

// Zero (SMB) or unsafe numeric IDs are unknown and never prove identity.
export function sameExactFileIdentity(left, right) {
  return Boolean(isKnownDirectoryIdentity(left) && isKnownDirectoryIdentity(right)
    && typeof left.dev === 'bigint' && typeof left.ino === 'bigint'
    && typeof right.dev === 'bigint' && typeof right.ino === 'bigint'
    && left.dev === right.dev && left.ino === right.ino);
}

function isExactKnownIdentity(identity) {
  return typeof identity?.dev === 'bigint' && typeof identity?.ino === 'bigint'
    && isKnownDirectoryIdentity(identity);
}

// Exact continuity with an owned identity: exact bigint dev/ino and, when the owned
// identity is a full provenance tuple, its exact birth time. A full tuple whose birth
// time is not a durable (nonzero bigint) discriminator fails closed.
export function matchesOwnedIdentity(observed, expected) {
  if (!observed || !sameExactFileIdentity({ dev: observed.dev, ino: observed.ino }, expected)) {
    return false;
  }
  return !('birthtimeNs' in expected)
    || (isDurableBirthtimeNs(expected.birthtimeNs) && observed.birthtimeNs === expected.birthtimeNs);
}

export function pathMatchesExactIdentity(absPath, identity) {
  if (!isKnownDirectoryIdentity(identity)) return false;
  try {
    const stats = fs.lstatSync(absPath, { bigint: true });
    return !stats.isSymbolicLink() && stats.isFile() && matchesOwnedIdentity(stats, identity);
  } catch {
    return false;
  }
}

export function sameWriteFingerprint(left, right) {
  return Boolean(left && right && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs);
}

// Ownership-authorized unlink: only a known exact (bigint) identity may remove a path.
// Unknown identity never proves ownership, so an existing path is left in place.
// `outcome` receives diagnostic evidence only: `failedStep`
// (inspection | ownership | continuity | unlink) and the filesystem error code.
// When a content snapshot is supplied, its write fingerprint must also hold at
// the helper's last inspection, immediately before unlink (including after any
// earlier continuity sweep). Ordinary operation cleanup retains its identity-only contract.
export function removeFileIfExactIdentityMatches(absPath, exactIdentity, outcome, fingerprint) {
  let step = 'inspection';
  try {
    const stats = fs.lstatSync(absPath, { bigint: true });
    if (!isKnownDirectoryIdentity(exactIdentity) || stats.isSymbolicLink() || !stats.isFile()
      || !matchesOwnedIdentity(stats, exactIdentity)) {
      if (outcome) outcome.failedStep = 'ownership';
      return false;
    }
    if (fingerprint !== undefined && !sameWriteFingerprint(stats, fingerprint)) {
      if (outcome) outcome.failedStep = 'continuity';
      return false;
    }
    step = 'unlink';
    fs.unlinkSync(absPath);
    return true;
  } catch (err) {
    if (outcome && err.code !== 'ENOENT') {
      outcome.failedStep = step;
      if (typeof err.code === 'string') outcome.errorCode = err.code;
    }
    return err.code === 'ENOENT';
  }
}

function readAt(descriptor, buffer, position) {
  return new Promise((resolve, reject) => {
    fs.read(descriptor, buffer, 0, buffer.length, position, (err, bytesRead) => (
      err ? reject(err) : resolve(bytesRead)
    ));
  });
}

function writeAt(descriptor, buffer, length, position) {
  return new Promise((resolve, reject) => {
    fs.write(descriptor, buffer, 0, length, position, (err, written) => (
      err ? reject(err) : resolve(written)
    ));
  });
}

async function hashDescriptor(descriptor) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let position = 0;
  for (;;) {
    const bytesRead = await readAt(descriptor, buffer, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return { size: BigInt(position), sha256: hash.digest('hex') };
}

function contentMismatch(message) {
  return new OwnedFileError(OWNED_FILE_FAILURE.contentMismatch, message);
}

/**
 * Exclusively creates `absPath` and roots its ownership in the opened descriptor.
 *
 * Sequence: openSync(path, 'wx' | 'wx+', mode) → onCreated() → fstat(fd, bigint) → require a regular file
 * with a known exact bigint identity → onOwned(exactIdentity) → fchmod(mode) → write(fd) →
 * [read back through fd and verify content] → [futimes(fd, times)] → fstat(fd, bigint) must
 * be the same owned object → close → lstat(path, bigint) must still be that exact object.
 *
 * EEXIST (or any open failure) propagates unchanged: the existing path is never adopted,
 * overwritten or removed. Every later failure closes the descriptor, keeps the initiating
 * error, and leaves the path in place for the caller's ownership-gated cleanup.
 *
 * @param {string} absPath
 * @param {(descriptor: number) => (void|Promise<void>)} write
 * @param {{
 *   mode?: number,
 *   onCreated?: () => void,
 *   onOwned?: (exactIdentity: { dev: bigint, ino: bigint }) => void,
 *   expectedContent?: { size?: number|bigint, sha256?: string }
 *     | (() => { size?: number|bigint, sha256?: string }),
 *   times?: { atime: number|Date, mtime: number|Date },
 * }} [options] `onCreated` fires once the exclusive open succeeded, before the descriptor is
 *   inspected: creation only, never ownership (an open failure never fires it). `expectedContent` (or a function resolved after `write`) requests a read-back
 *   verification through the descriptor; the file is then opened 'wx+'. `times` is applied
 *   through the owned descriptor after writing and verification (metadata only; it never
 *   affects ownership).
 * @returns {Promise<{
 *   exactIdentity: { dev: bigint, ino: bigint },
 *   birthtimeNs: bigint,
 *   ctimeNs: bigint,
 *   pathContinuity: 'matched',
 *   content?: { size: bigint, sha256: string },
 * }>} `exactIdentity` is the only ownership authority. `birthtimeNs` is read from the
 *   descriptor after writing: a durable-provenance candidate only (it may be 0n or unstable;
 *   durability is the caller's policy). `ctimeNs` comes from that same descriptor stat, so a
 *   caller can recognize a birth time that merely mirrors ctime. `content` proves bytes only.
 */
export async function createOwnedFile(absPath, write, {
  mode, onCreated, onOwned, expectedContent, times,
} = {}) {
  let descriptor;
  let exactIdentity;
  let birthtimeNs;
  let ctimeNs;
  let content;
  try {
    descriptor = fs.openSync(absPath, expectedContent === undefined ? 'wx' : 'wx+', mode);
    onCreated?.();
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const candidate = { dev: opened.dev, ino: opened.ino };
    if (!opened.isFile() || !isExactKnownIdentity(candidate)) {
      throw new OwnedFileError(OWNED_FILE_FAILURE.identityUnknown,
        'The created file exposed no known exact identity.');
    }
    exactIdentity = candidate;
    onOwned?.(exactIdentity);
    if (mode !== undefined) fs.fchmodSync(descriptor, mode);
    await write(descriptor);
    if (expectedContent !== undefined) {
      const expected = typeof expectedContent === 'function' ? expectedContent() : expectedContent;
      content = await hashDescriptor(descriptor);
      if (expected?.size !== undefined && BigInt(expected.size) !== content.size) {
        throw contentMismatch('The created file does not have the expected size.');
      }
      if (expected?.sha256 !== undefined && expected.sha256 !== content.sha256) {
        throw contentMismatch('The created file does not have the expected content.');
      }
    }
    if (times !== undefined) fs.futimesSync(descriptor, times.atime, times.mtime);
    const written = fs.fstatSync(descriptor, { bigint: true });
    if (!written.isFile() || !matchesOwnedIdentity(written, exactIdentity)) {
      throw new OwnedFileError(OWNED_FILE_FAILURE.descriptorChanged,
        'The created file descriptor identity changed.');
    }
    if (content && written.size !== content.size) {
      throw contentMismatch('The created file changed while it was verified.');
    }
    birthtimeNs = written.birthtimeNs;
    ctimeNs = written.ctimeNs;
  } catch (err) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* the original failure wins */ }
    }
    throw err;
  }
  fs.closeSync(descriptor);
  if (!pathMatchesExactIdentity(absPath, exactIdentity)) {
    throw new OwnedFileError(OWNED_FILE_FAILURE.pathnameChanged,
      'The created file changed before it could be verified.');
  }
  return {
    exactIdentity,
    birthtimeNs,
    ctimeNs,
    pathContinuity: 'matched',
    ...(content ? { content } : {}),
  };
}

function sourceSnapshot(stats) {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs };
}

function sameSourceSnapshot(left, right) {
  const identityKnown = isExactKnownIdentity(left) || isExactKnownIdentity(right);
  return (!identityKnown || sameExactFileIdentity(left, right))
    && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function sourceUnsafe(message) {
  return new OwnedFileError(OWNED_FILE_FAILURE.sourceUnsafe, message);
}

function sourceChanged() {
  return new OwnedFileError(OWNED_FILE_FAILURE.sourceChanged, 'The copy source changed while it was read.');
}

// The source is a trusted content input, never an ownership claim: its identity only pins
// continuity while it is read.
function inspectTrustedSource(sourcePath) {
  const stats = fs.lstatSync(sourcePath, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isFile()) throw sourceUnsafe('The copy source is not a regular file.');
  return sourceSnapshot(stats);
}

/**
 * Copies a caller-trusted source into a newly, exclusively created owned destination.
 *
 * Roles stay separate: the SOURCE is trusted input whose bytes are copied and whose
 * continuity is checked; it is never claimed. The DESTINATION is owned only because
 * createOwnedFile created it exclusively; its identity is never compared with the source's.
 *
 * Source contract: lstat path (regular file, no symlink) → open 'r' → fstat must match the
 * path snapshot (exact identity when known, size, mtime) and, when given,
 * `sourceExactIdentity` exactly → copy → descriptor and path must still match that snapshot
 * and the copied byte count must equal the source size. `expectedSha256` / `expectedSize`
 * pin the source content; the destination is then read back and must hash to the copied
 * bytes. Hashes prove content only.
 *
 * @returns same result as createOwnedFile; `content` is always present.
 */
export async function copyTrustedFileToOwnedFile({
  sourcePath,
  sourceExactIdentity,
  destinationPath,
  expectedSha256,
  expectedSize,
  mode,
  onCreated,
  onOwned,
  times,
}) {
  if (sourceExactIdentity !== undefined && !isExactKnownIdentity(sourceExactIdentity)) {
    throw sourceUnsafe('The trusted copy source identity is unknown.');
  }
  const before = inspectTrustedSource(sourcePath);
  let source;
  try {
    source = fs.openSync(sourcePath, 'r');
    const opened = fs.fstatSync(source, { bigint: true });
    if (!opened.isFile() || !sameSourceSnapshot(before, sourceSnapshot(opened))) {
      throw sourceChanged();
    }
    if (sourceExactIdentity !== undefined && !sameExactFileIdentity(opened, sourceExactIdentity)) {
      throw sourceUnsafe('The copy source is not the trusted file.');
    }
    if (expectedSize !== undefined && BigInt(expectedSize) !== opened.size) {
      throw contentMismatch('The copy source does not have the expected size.');
    }
    let copied;
    return await createOwnedFile(destinationPath, async (destination) => {
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      let position = 0;
      for (;;) {
        const bytesRead = await readAt(source, buffer, position);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        let offset = 0;
        while (offset < bytesRead) {
          offset += await writeAt(destination, buffer.subarray(offset), bytesRead - offset, position + offset);
        }
        position += bytesRead;
      }
      copied = { size: BigInt(position), sha256: hash.digest('hex') };
      const after = fs.fstatSync(source, { bigint: true });
      let afterPath;
      try {
        afterPath = inspectTrustedSource(sourcePath);
      } catch {
        throw sourceChanged();
      }
      const snapshot = sourceSnapshot(opened);
      if (!after.isFile() || !sameSourceSnapshot(snapshot, sourceSnapshot(after))
        || !sameSourceSnapshot(snapshot, afterPath) || copied.size !== opened.size) {
        throw sourceChanged();
      }
      if (expectedSha256 !== undefined && copied.sha256 !== expectedSha256) {
        throw contentMismatch('The copy source does not have the expected content.');
      }
    }, { mode, onCreated, onOwned, times, expectedContent: () => copied });
  } finally {
    if (source !== undefined) {
      try { fs.closeSync(source); } catch { /* a read-only source close never changes the result */ }
    }
  }
}
