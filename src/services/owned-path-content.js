import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveContainedAssetPath } from '../storage/asset-file.js';
import { isKnownDirectoryIdentity } from './project-directory-ownership.js';
import { matchesOwnedIdentity, pathMatchesExactIdentity, sameExactFileIdentity, sameWriteFingerprint } from './owned-file.js';

// Hardened exact-identity content validation of an owned path, shared by the processing
// operations and recovery evidence. The identity → content
// → identity check, its post-hash write fingerprint with the one conditional SMB-settling
// rehash, the metadata-only continuity sweep, and the optional archive validation trace.

function sameIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

// Ownership and content of a path, checked independently: the exact identity, then the
// bytes, then the exact identity again after that fallible read, so matching content can
// never vouch for a path that changed while it was hashed. Returns null when both hold,
// else 'identity' | 'content' | 'unreadable'. The hash proves bytes only.
// `trace` (archive pre-commit validation only) records the values each step decided on.
export function ownedPathContentFailure(projectDir, absPath, identity, { size, sha256 }, trace) {
  if (!tracedPathMatchesExactIdentity(absPath, identity, trace, 'precommit-identity-before-hash')) return 'identity';
  let step = 'precommit-size-check';
  try {
    if (size !== undefined) {
      const observedSize = fs.lstatSync(absPath).size;
      traceValues(trace, { phase: step, size: String(observedSize) });
      if (observedSize !== Number(size)) return 'content';
    }
    step = 'precommit-hash';
    const digest = hashRegularFileInProject(projectDir, absPath);
    traceValues(trace, { phase: step, hashMatch: digest === sha256 });
    if (digest !== sha256) return 'content';
  } catch (err) {
    if (!traceHashTargetRejection(trace, step, err)) traceInspectionFailure(trace, step, err);
    return 'unreadable';
  }
  return tracedPathMatchesExactIdentity(absPath, identity, trace, 'precommit-identity-after-hash') ? null : 'identity';
}

// Archive validation trace (WP4 SMB diagnostics): the scalar stat values an archive
// publication/validation decision actually read, recorded as it reads them and never
// re-read afterwards. Entries hold decimal strings only (no path, bytes or Error), and
// recording is best-effort: it never changes a result. See archiveValidationFailureContext.
export const TRACE_STAT_FIELDS = Object.freeze(['dev', 'ino', 'size', 'birthtimeNs', 'mtimeNs', 'ctimeNs']);

function traceValues(trace, entry) {
  if (!Array.isArray(trace)) return;
  try {
    trace.push(entry);
  } catch {
    // Diagnostics must not alter validation.
  }
}

// How `stats` relates to the owned identity, by the same rules as matchesOwnedIdentity.
function classifyTracedIdentity(stats, identity) {
  if (stats.isSymbolicLink() || !stats.isFile()) return 'not-regular-file';
  if (!sameExactFileIdentity({ dev: stats.dev, ino: stats.ino }, identity)) return 'dev-ino-mismatch';
  if ('birthtimeNs' in identity && !matchesOwnedIdentity(stats, identity)) return 'birthtime-mismatch';
  return 'matched';
}

// Records the bigint stat scalars present on `values` as decimal strings, plus the identity
// relation when an owned identity is supplied.
export function traceStats(trace, phase, values, identity) {
  if (!Array.isArray(trace)) return;
  try {
    const entry = { phase };
    for (const key of TRACE_STAT_FIELDS) {
      if (typeof values[key] === 'bigint') entry[key] = String(values[key]);
    }
    if (identity) entry.identity = classifyTracedIdentity(values, identity);
    trace.push(entry);
  } catch {
    // Diagnostics must not alter validation.
  }
}

// A hash-helper rejection decided by its own stat observations (hashTargetRejections):
// records those observations as numeric-stat phases, then the rejection itself. Returns
// false (nothing recorded) for any other failure, which stays an inspection failure.
function traceHashTargetRejection(trace, phase, err) {
  if (!Array.isArray(trace) || phase !== 'precommit-hash') return false;
  try {
    const rejection = err && typeof err === 'object' ? hashTargetRejections.get(err) : undefined;
    if (!rejection) return false;
    const observations = [rejection.baseline, rejection.observed].filter(Boolean);
    // `stat: 'number'`: the helper's non-bigint stats, so IDs past 2^53 are rounded.
    const entries = observations.map(([observation, stats]) => ({
      phase: observation, stat: 'number', dev: String(stats.dev), ino: String(stats.ino), size: String(stats.size),
    }));
    entries.push({
      phase,
      hashRejection: rejection.subcheck,
      bytesRead: rejection.bytesRead,
      ...(observations.length === 2 ? { compared: observations.map(([observation]) => observation) } : {}),
    });
    trace.push(...entries);
    return true;
  } catch {
    return false;
  }
}

function traceInspectionFailure(trace, phase, err) {
  traceValues(trace, {
    phase,
    identity: 'inspection-failed',
    ...(typeof err?.code === 'string' ? { errorCode: err.code } : {}),
  });
}

// pathMatchesExactIdentity, deciding from the one lstat it records when traced.
export function tracedPathMatchesExactIdentity(absPath, identity, trace, phase) {
  if (!Array.isArray(trace)) return pathMatchesExactIdentity(absPath, identity);
  if (!isKnownDirectoryIdentity(identity)) {
    traceValues(trace, { phase, identity: 'expected-unknown' });
    return false;
  }
  try {
    const stats = fs.lstatSync(absPath, { bigint: true });
    traceStats(trace, phase, stats, identity);
    return !stats.isSymbolicLink() && stats.isFile() && matchesOwnedIdentity(stats, identity);
  } catch (err) {
    traceInspectionFailure(trace, phase, err);
    return false;
  }
}

// Content continuity across a multi-object validation (archive boundaries). A hash proves
// bytes only at the moment it is read; a later read of ANOTHER object leaves a window in
// which this one can be rewritten in place under the same identity. Each content check
// therefore captures the path's write metadata {size, mtimeNs, ctimeNs} after a hash it held
// across (ownedPathContentSnapshot); a final metadata sweep (no content read) then proves
// every object of the set still carries both its owned identity and that post-hash
// metadata its verified bytes were read under. The fingerprint is continuity evidence only, never ownership, and
// it cannot see a write that leaves size and both timestamps unchanged (a same-tick write on
// a coarse clock, or a writer that restores them) nor anything after the final sweep.
function ownedPathWriteFingerprint(absPath, identity, trace, phase) {
  if (!isKnownDirectoryIdentity(identity)) {
    traceValues(trace, { phase, identity: 'expected-unknown' });
    return null;
  }
  try {
    const stats = fs.lstatSync(absPath, { bigint: true });
    traceStats(trace, phase, stats, identity);
    if (stats.isSymbolicLink() || !stats.isFile() || !matchesOwnedIdentity(stats, identity)) return null;
    return { size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs };
  } catch (err) {
    traceInspectionFailure(trace, phase, err);
    return null;
  }
}

// ownedPathContentFailure plus the write fingerprint its bytes were verified under:
// { failure: null, fingerprint } or { failure: 'identity' | 'content' | 'unreadable' }.
// The pre-hash write metadata is an observation, not a baseline: opening and reading a file
// can itself settle the metadata a network filesystem reports (SMB reported a post-close
// mtime/ctime before the hash and the creating descriptor's values after it, with identity,
// size and bytes unchanged). The baseline is the POST-hash fingerprint, adopted once a hash
// has been bracketed by it unchanged: when the metadata moved across the first hash, the
// bytes are verified again (identity, content, identity) and the post-hash fingerprint must
// then hold across that second read. A write landing after the first read, before its
// post-hash stat, therefore still meets the second hash (bytes) or its bracket (metadata);
// metadata that moves across both reads is a 'content' failure, marked `unstable` (bytes
// matched each read; only write-metadata continuity failed).
// `trace`: archive pre-commit validation only (see the archive validation trace).
export function ownedPathContentSnapshot(projectDir, absPath, identity, content, trace) {
  let baseline = ownedPathWriteFingerprint(absPath, identity, trace, 'precommit-before-hash');
  if (!baseline) return { failure: 'identity' };
  for (const phase of ['precommit-after-hash', 'precommit-after-rehash']) {
    const failure = ownedPathContentFailure(projectDir, absPath, identity, content, trace);
    if (failure) return { failure };
    const after = ownedPathWriteFingerprint(absPath, identity, trace, phase);
    if (!after) return { failure: 'identity' };
    if (sameWriteFingerprint(baseline, after)) return { failure: null, fingerprint: after };
    baseline = after;
  }
  return { failure: 'content', unstable: true };
}

// Metadata-only continuity with a snapshot: null, 'identity' (not the owned object) or
// 'content' (the owned object was written since its bytes were verified). Reads no bytes.
export function ownedPathContinuityFailure(absPath, identity, fingerprint, trace) {
  const current = ownedPathWriteFingerprint(absPath, identity, trace, 'precommit-final-sweep');
  if (!current) return 'identity';
  return sameWriteFingerprint(current, fingerprint) ? null : 'content';
}

// Diagnostics only (WP4 archive validation trace): why hashRegularFileInProject rejected a
// target it could inspect, keyed by the Error it threw, with the helper's own (numeric) stat
// observations that decided it. Built lazily from values already read, best-effort, and never
// part of the error's public shape; a propagated fs error (true I/O failure) has no entry.
const hashTargetRejections = new WeakMap();

function hashTargetRejection(message, describe) {
  const error = new Error(message);
  try {
    hashTargetRejections.set(error, describe());
  } catch {
    // Diagnostics must not alter validation.
  }
  return error;
}

export function hashRegularFileInProject(projectDir, absPath) {
  const relative = path.relative(projectDir, absPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Hash target is outside the project directory.');
  }
  const validatedPath = resolveContainedAssetPath(projectDir, relative, { checkFinalSymlink: false });

  const before = fs.lstatSync(validatedPath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw hashTargetRejection('Hash target is not a regular file.', () => ({
      subcheck: 'hash-not-regular-file', bytesRead: false, observed: ['hash-before-lstat', before],
    }));
  }

  let descriptor;
  try {
    descriptor = fs.openSync(validatedPath, 'r');
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw hashTargetRejection('Hash target changed before it could be read.', () => ({
        subcheck: opened.isFile() ? 'hash-identity-mismatch' : 'hash-not-regular-file',
        bytesRead: false,
        baseline: ['hash-before-lstat', before],
        observed: ['hash-opened-fstat', opened],
      }));
    }

    const digest = createHash('sha256')
      .update(fs.readFileSync(descriptor))
      .digest('hex');
    const after = fs.lstatSync(validatedPath);
    const afterDescriptor = fs.fstatSync(descriptor);
    if (after.isSymbolicLink()
      || !after.isFile()
      || !sameIdentity(after, before)
      || !sameIdentity(afterDescriptor, opened)
      || after.size !== before.size
      || afterDescriptor.size !== opened.size) {
      throw hashTargetRejection('Hash target changed while it was read.', () => {
        // The first failing condition above, in its order, from the values it compared.
        const pathname = { baseline: ['hash-before-lstat', before], observed: ['hash-after-lstat', after] };
        const descriptorPair = { baseline: ['hash-opened-fstat', opened], observed: ['hash-after-fstat', afterDescriptor] };
        if (after.isSymbolicLink() || !after.isFile()) {
          return { subcheck: 'hash-not-regular-file', bytesRead: true, ...pathname };
        }
        if (!sameIdentity(after, before)) return { subcheck: 'hash-identity-mismatch', bytesRead: true, ...pathname };
        if (!sameIdentity(afterDescriptor, opened)) {
          return { subcheck: 'hash-identity-mismatch', bytesRead: true, ...descriptorPair };
        }
        if (after.size !== before.size) return { subcheck: 'hash-size-mismatch', bytesRead: true, ...pathname };
        return { subcheck: 'hash-size-mismatch', bytesRead: true, ...descriptorPair };
      });
    }
    return digest;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
