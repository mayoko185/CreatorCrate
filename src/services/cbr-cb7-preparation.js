// Bounded one-pass preparation of solid CBR (RAR4/RAR5) and CB7 (7z) comics.
//
// readCbrCb7Page decodes a solid stream from the start of its block up to the requested page
// on every call, so reading a solid comic front to back repeats ever longer prefixes. This
// module instead runs one A1 decoder job (extractOpenedArchiveBatch) that decodes each solid
// stream once and writes every readable page into one private staging file. The caller then
// serves pages from that file by catalog position.
//
// Everything still goes through the qualified A1 decoder and its protections: the job lists the
// archive, this module builds the page catalog from that same listing (exactly as
// readCbrCb7Page does), proves the decoder selects exactly the chosen members, and extracts them
// into a guarded in-memory directory whose files stream straight to the staging descriptor at
// offsets the decoder's parent tracks. Archive member names never reach the host filesystem:
// the only host paths are a generated directory under the caller's staging root and the fixed
// file name `pages.bin` inside it.
//
// A page is published only after this process has read its bytes back from the staging file
// and checked their size, their CRC32 when the archive stores one, and the image itself; the
// SHA-256 of those exact bytes is kept privately and every read() must match it. Any
// failure that leaves page identity or integrity uncertain (limits, protocol violations,
// archive-level decoder diagnostics, disk errors, source changes, timeout, cancellation)
// discards the whole preparation and removes its directory before the promise rejects.
//
// Scope: a primitive for A3.3. It does not authorize, cache across calls, evict, schedule or
// limit concurrency; A3.3 owns the staging root, admission and the prepared result's lifetime.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import {
  ArchiveDecoderError,
  assertOpenedArchiveUnchanged,
  extractOpenedArchiveBatch,
} from './archive-member-decoder.js';
import { CBZ_READER_LIMITS, inspectImage } from './cbz-page-reader.js';
import {
  CBR_CB7_READER_LIMITS,
  buildCatalog,
  catalogResult,
  createGuard,
  decoderFormatOf,
  decoderLimitsOf,
  resolveCbrCb7Limits,
  toReaderError,
} from './cbr-cb7-page-reader.js';

export { ArchiveDecoderError };

const MIB = 1024 * 1024;
const STAGING_PREFIX = 'comic-prep-';
const PACK_NAME = 'pages.bin';
const POSIX = typeof process.getuid === 'function';
const WINDOWS = process.platform === 'win32';

// Reader limits apply unchanged (A1 decoder bounds, page count, image bounds). Preparation adds:
// - maxPreparedBytes: staging disk use per preparation. 1 GiB covers ordinary comics (20-300 MiB)
//   and large lossless volumes (a measured 30-page 1200x1800 PNG comic is 186 MiB).
// - maxPreparedPages: members per preparation, the reader's page ceiling.
// - timeoutMs: one deadline for the whole preparation (decode, read-back, image checks). The
//   measured 186 MiB comic prepares in under 1 s; 120 s leaves room for slow disks and CPUs
//   while still ending runaway jobs. A1's per-read default (30 s) is unchanged.
// A comic over these bounds is refused (PREPARATION_LIMIT_EXCEEDED); it stays readable page by
// page through readCbrCb7Page.
export const CBR_CB7_PREPARATION_LIMITS = Object.freeze({
  ...CBR_CB7_READER_LIMITS,
  timeoutMs: 120_000,
  maxPreparedBytes: 1024 * MIB,
  maxPreparedPages: CBZ_READER_LIMITS.maxPages,
});

const PREPARATION_KEYS = ['maxPreparedBytes', 'maxPreparedPages'];
const SLOT_CODES = new Set(['PAGE_INVALID_IMAGE', 'IMAGE_LIMIT_EXCEEDED']);

function error(code, message, cause) {
  return new ArchiveDecoderError(code, message, { cause });
}

export function resolvePreparationLimits(overrides = {}) {
  const preparation = {};
  const reader = { timeoutMs: CBR_CB7_PREPARATION_LIMITS.timeoutMs };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (PREPARATION_KEYS.includes(key)) {
      if (!Number.isSafeInteger(value) || value < 1) throw error('INVALID_ARGUMENT', 'Invalid preparation limit: ' + key);
      preparation[key] = value;
    } else {
      reader[key] = value;
    }
  }
  return Object.freeze({
    ...resolveCbrCb7Limits(reader),
    maxPreparedBytes: preparation.maxPreparedBytes ?? CBR_CB7_PREPARATION_LIMITS.maxPreparedBytes,
    maxPreparedPages: preparation.maxPreparedPages ?? CBR_CB7_PREPARATION_LIMITS.maxPreparedPages,
  });
}

// ─── Private staging ─────────────────────────────────────────────────────────────────────

// The staging root is supplied by the caller (A3.3: the preparation cache's private root in the
// platform's temporary storage, never a project directory). It must be an existing real
// directory; on POSIX it must belong to this process's user and not be group/world-writable. Each
// preparation gets its own mkdtemp directory (0700; on Windows it inherits the root's private
// ACL) holding one exclusively created file (0600). Whether other users can redirect the path
// (replaceable ancestors, Windows ACLs) is the owner's check, enforced through
// beforeStagingRemoval before every removal (comic-preparation-cache.js F6/F7).
//
// Owner hooks (A3.3b-2, both optional):
//   onStaging(directory)            called synchronously as soon as the directory exists and
//                                   before anything is written to it, so the owner holds its
//                                   own record of the directory (never one taken from an error);
//                                   throwing refuses the directory.
//   beforeStagingRemoval(directory) awaited before every removal of the directory (failure
//                                   cleanup and dispose()); rejecting skips the removal, which
//                                   then fails with that reason (cleanupError / dispose()).
async function createStaging(stagingRoot, hooks) {
  if (typeof stagingRoot !== 'string' || !path.isAbsolute(stagingRoot)) {
    throw error('INVALID_ARGUMENT', 'An absolute staging root is required.');
  }
  const root = path.resolve(stagingRoot);
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (cause) {
    throw error('STAGING_UNAVAILABLE', 'The staging root is unavailable.', cause);
  }
  if (!rootStat.isDirectory() || (POSIX && (rootStat.uid !== process.getuid() || (rootStat.mode & 0o022) !== 0))) {
    throw error('STAGING_UNAVAILABLE', 'The staging root is not a private directory.');
  }
  let directory;
  try {
    directory = await mkdtemp(path.join(root, STAGING_PREFIX));
  } catch (cause) {
    throw error('STAGING_UNAVAILABLE', 'A staging directory could not be created.', cause);
  }
  let handle = null;
  try {
    hooks.onStaging?.(directory);
    await chmod(directory, 0o700);
    const dirStat = await lstat(directory);
    if (path.dirname(directory) !== root || !dirStat.isDirectory()
      || (POSIX && (dirStat.uid !== process.getuid() || (dirStat.mode & 0o077) !== 0))) {
      throw error('STAGING_UNAVAILABLE', 'The staging directory is not private.');
    }
    const filePath = path.join(directory, PACK_NAME);
    handle = await open(filePath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size !== 0) throw error('STAGING_UNAVAILABLE', 'The staging file is not private.');
    return { directory, filePath, handle, identity: { dev: fileStat.dev, ino: fileStat.ino } };
  } catch (cause) {
    await handle?.close().catch(() => {});
    const failure = cause instanceof ArchiveDecoderError ? cause : error('STAGING_UNAVAILABLE', 'The staging area could not be prepared.', cause);
    try {
      await removeStaging(directory, hooks);
    } catch (cleanupError) {
      failure.cleanupError = cleanupError;
    }
    throw failure;
  }
}

async function removeStaging(directory, hooks) {
  await hooks.beforeStagingRemoval?.(directory);
  await removeStagingLayout(directory);
}

// Windows reports a file held by a scanner, or a directory whose last file's deletion is still
// pending, as busy for a moment; nothing else is retried.
const TRANSIENT_REMOVAL_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
async function removalStep(step) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await step();
      return;
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      if (!WINDOWS || attempt >= 10 || !TRANSIENT_REMOVAL_CODES.has(err?.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/**
 * Removes one staging directory of this layout and nothing else (A3.3b-2 F6): its one
 * fixed-name pack file, then the directory itself, which must then be empty. Never recursive and
 * never through a link in the final components, so a directory holding anything else fails
 * (ENOTEMPTY) without being emptied, and a path redirected elsewhere can at most reach a file
 * named exactly like a pack in a directory named exactly like a staging directory. Only the
 * preparation's own cleanup and the preparation cache (after its physical checks) call it.
 */
export async function removeStagingLayout(directory) {
  const pack = path.join(directory, PACK_NAME);
  if (WINDOWS) {
    // A read-only pack (0400) cannot be unlinked on Windows; only a regular file is made writable.
    const stats = await lstat(pack).catch(() => null);
    if (stats?.isFile()) await chmod(pack, 0o600).catch(() => {});
  }
  await removalStep(() => unlink(pack));
  await removalStep(() => rmdir(directory));
}

async function readExactly(handle, length, position) {
  const bytes = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(bytes, done, length - done, position + done);
    if (bytesRead === 0) throw error('STAGING_FAILED', 'The staging file is shorter than expected.');
    done += bytesRead;
  }
  return bytes;
}

// ─── Preparation ─────────────────────────────────────────────────────────────────────────

/**
 * Prepare every readable page of an opened solid CBR or CB7 in one bounded decoder pass.
 *
 * The caller owns `openFile` (from openAssetFile/openAssetFileAsync) and closes it after the
 * promise settles. The source is re-checked (size, inode, device, mtime) before the result is
 * returned.
 *
 * Ownership: on rejection nothing remains (the staging directory has been removed; if removal
 * itself failed or was refused by `beforeStagingRemoval` the error carries `cleanupError` and the
 * leftover `comic-prep-*` directory stays private under the staging root; an owner that passed
 * `onStaging` already holds its path and must keep accounting for it until it is removed). On success the caller owns the returned preparation and must call dispose()
 * once it is no longer served; until then its directory stays under `stagingRoot`.
 *
 * Non-solid archives are refused with ARCHIVE_NOT_SOLID: readCbrCb7Page already reads their
 * pages without repeated work.
 *
 * @param {{ handle: number|import('node:fs/promises').FileHandle, stat: import('node:fs').Stats }} openFile
 * @param {{ format: 'cbr'|'cb7', stagingRoot: string, signal?: AbortSignal,
 *   limits?: Partial<typeof CBR_CB7_PREPARATION_LIMITS>,
 *   onStaging?: (directory: string) => void,
 *   beforeStagingRemoval?: (directory: string) => Promise<void> }} options
 * @returns {Promise<PreparedComic>} the catalog of inspectCbrCb7 plus:
 *   complete      - true when every catalog page is ready
 *   preparedBytes - size of the staging file
 *   filePath      - the read-only staging file (pages are byte ranges of it)
 *   slots         - one per catalog page, in position order:
 *                   { position, status: 'ready', offset, length, image }
 *                   { position, status: 'error', code } (the code readCbrCb7Page would throw)
 *   read(position)  -> { page, bytes, image } for a ready slot (re-verified), else throws its code
 *   dispose()       -> removes the staging directory; idempotent
 * @throws {ArchiveDecoderError} ARCHIVE_NOT_SOLID, NOTHING_TO_PREPARE, PREPARATION_LIMIT_EXCEEDED,
 *   STAGING_UNAVAILABLE, STAGING_FAILED, OUTPUT_WRITE_FAILED, INPUT_CHANGED, TIMEOUT, CANCELLED,
 *   or any archive-level code from inspectCbrCb7.
 */
export async function prepareSolidCbrCb7(openFile, options = {}) {
  const { format, signal, stagingRoot, onStaging, beforeStagingRemoval } = options;
  const decoderFormat = decoderFormatOf(format);
  const limits = resolvePreparationLimits(options.limits);
  for (const hook of [onStaging, beforeStagingRemoval]) {
    if (hook !== undefined && typeof hook !== 'function') throw error('INVALID_ARGUMENT', 'Staging hooks must be functions.');
  }
  const hooks = Object.freeze({ onStaging, beforeStagingRemoval });
  const guard = createGuard(signal, limits.timeoutMs);
  guard.checkpoint();
  const staging = await createStaging(stagingRoot, hooks);

  // Stops the decoder early when read-back verification fails; the caller's signal still wins.
  const internal = new AbortController();
  const jobSignal = signal ? AbortSignal.any([signal, internal.signal]) : internal.signal;
  let catalog = null;
  let wanted = null;
  const verified = new Map();
  const failed = new Map();
  let verifying = Promise.resolve();
  let fatal = null;

  const select = (listing, checkpoint) => {
    if (!listing.solid) throw error('ARCHIVE_NOT_SOLID', 'The archive is not solid; read its pages individually.');
    catalog = { listing, pages: buildCatalog(listing, limits, checkpoint) };
    wanted = catalog.pages.filter((page) => page.problem === null);
    if (wanted.length === 0) throw error('NOTHING_TO_PREPARE', 'The archive has no readable pages to prepare.');
    const total = wanted.reduce((sum, page) => sum + page.uncompressedSize, 0);
    if (wanted.length > limits.maxPreparedPages || total > limits.maxPreparedBytes) {
      throw error('PREPARATION_LIMIT_EXCEEDED', 'The comic is larger than a preparation may be.');
    }
    return wanted.map((page) => page.member.path);
  };

  // Runs for each produced member, in order, while the decoder continues with later ones.
  // Only one page buffer is held at a time.
  const verifyMember = async ({ index, entry, offset, length }) => {
    guard.checkpoint();
    const page = wanted[index];
    if (!page || entry.index !== page.member.entryIndex || entry.path !== page.member.path) {
      throw error('PROTOCOL_ERROR', 'The decoder returned a different member than the one selected.');
    }
    if (length !== entry.size) {
      failed.set(page.position, 'PAGE_CORRUPT');
      return;
    }
    let bytes;
    try {
      bytes = await readExactly(staging.handle, length, offset);
    } catch (cause) {
      throw cause instanceof ArchiveDecoderError ? cause : error('STAGING_FAILED', 'The staging file could not be read.', cause);
    }
    // Digest of the exact bytes checked below; read() serves only bytes that still match it.
    const sha256 = pageDigest(bytes);
    const crcChecked = entry.crc32 !== null;
    if (crcChecked && crc32(bytes) !== entry.crc32) {
      failed.set(page.position, 'PAGE_CORRUPT');
      return;
    }
    let image;
    try {
      image = await inspectImage(bytes, limits);
    } catch (cause) {
      if (cause instanceof ArchiveDecoderError && SLOT_CODES.has(cause.code)) {
        failed.set(page.position, cause.code);
        return;
      }
      throw cause;
    }
    verified.set(page.position, { offset, length, image, crcChecked, sha256 });
  };

  const onMember = (member) => {
    verifying = verifying
      .then(() => (fatal ? undefined : verifyMember(member)))
      .catch((cause) => {
        fatal ??= cause;
        internal.abort();
      });
  };

  try {
    let outcome;
    try {
      outcome = await extractOpenedArchiveBatch(openFile, {
        select,
        onMember,
        outputFd: staging.handle.fd,
        maxMembers: limits.maxPreparedPages,
        maxBytes: limits.maxPreparedBytes,
      }, {
        format: decoderFormat,
        signal: jobSignal,
        limits: decoderLimitsOf(limits, guard.remainingMs()),
      });
    } catch (cause) {
      // A verification failure aborts the job; report the verification failure, not CANCELLED.
      await verifying;
      throw fatal ?? cause;
    }
    await verifying;
    if (fatal) throw fatal;
    guard.checkpoint();

    // Internal per-page digests, by position; never part of the returned slots.
    const digests = new Map();
    const slots = Object.freeze(catalog.pages.map((page) => {
      const code = page.problem ?? failed.get(page.position) ?? null;
      const ready = verified.get(page.position);
      // Without a clean decoder run only pages this process verified by CRC32 are trusted.
      if (code !== null || !ready || (!outcome.complete && !ready.crcChecked)) {
        return Object.freeze({ position: page.position, status: 'error', code: code ?? 'PAGE_CORRUPT' });
      }
      digests.set(page.position, ready.sha256);
      return Object.freeze({ position: page.position, status: 'ready', offset: ready.offset, length: ready.length, image: ready.image });
    }));

    try {
      await staging.handle.sync();
      await staging.handle.close();
    } catch (cause) {
      throw error('STAGING_FAILED', 'The staging file could not be completed.', cause);
    } finally {
      staging.handle = null;
    }
    await assertOpenedArchiveUnchanged(openFile);
    let fileStat;
    try {
      fileStat = await lstat(staging.filePath);
      await chmod(staging.filePath, 0o400);
    } catch (cause) {
      throw error('STAGING_FAILED', 'The staging file could not be completed.', cause);
    }
    if (!fileStat.isFile() || fileStat.dev !== staging.identity.dev || fileStat.ino !== staging.identity.ino
      || fileStat.size !== outcome.bytes) {
      throw error('STAGING_FAILED', 'The staging file changed during preparation.');
    }
    guard.checkpoint();
    return preparedComic(catalogResult(format, outcome.format, catalog.listing, catalog.pages), slots, digests, staging, outcome.bytes, hooks);
  } catch (cause) {
    // The decoder job has settled (its worker no longer writes) and verification has drained,
    // so nothing else touches the staging directory now.
    const failure = toReaderError(cause);
    await staging.handle?.close().catch(() => {});
    staging.handle = null;
    try {
      await removeStaging(staging.directory, hooks);
    } catch (cleanupError) {
      failure.cleanupError = cleanupError;
    }
    throw failure;
  }
}

function pageDigest(bytes) {
  return createHash('sha256').update(bytes).digest();
}

// Every ready page is checked against the SHA-256 recorded when it was verified, whether or not
// the archive stores a CRC32 (RAR5 may store BLAKE2sp instead, and some archives store none), so
// changed bytes are never served with the image metadata of the bytes that were verified.
function preparedComic(catalog, slots, digests, staging, preparedBytes, hooks) {
  const { filePath, directory, identity } = staging;
  let disposal = null;

  const read = async (position) => {
    if (disposal) throw error('PREPARATION_DISPOSED', 'The preparation has been disposed.');
    const slot = Number.isSafeInteger(position) ? slots[position - 1] : undefined;
    if (!slot) throw error('PAGE_NOT_FOUND', 'The archive has no such page.');
    if (slot.status !== 'ready') throw error(slot.code, 'The page cannot be read: ' + slot.code + '.');
    const page = catalog.pages[position - 1];
    let handle;
    try {
      handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (cause) {
      throw error(disposal ? 'PREPARATION_DISPOSED' : 'PREPARATION_CHANGED', 'The prepared pages are unavailable.', cause);
    }
    try {
      const stat = await handle.stat();
      if (stat.dev !== identity.dev || stat.ino !== identity.ino || stat.size !== preparedBytes) {
        throw error('PREPARATION_CHANGED', 'The prepared pages changed.');
      }
      const bytes = await readExactly(handle, slot.length, slot.offset);
      const digest = digests.get(position);
      if (!digest || !pageDigest(bytes).equals(digest)
        || (page.crc32 !== null && crc32(bytes) !== page.crc32)) {
        throw error('PREPARATION_CHANGED', 'The prepared page changed.');
      }
      return { page, bytes, image: slot.image };
    } catch (cause) {
      throw cause instanceof ArchiveDecoderError ? cause : error('PREPARATION_CHANGED', 'The prepared pages are unavailable.', cause);
    } finally {
      await handle.close().catch(() => {});
    }
  };

  return Object.freeze({
    ...catalog,
    complete: slots.every((slot) => slot.status === 'ready'),
    preparedBytes,
    filePath,
    slots,
    read,
    get disposed() {
      return disposal !== null;
    },
    dispose() {
      disposal ??= removeStaging(directory, hooks);
      return disposal;
    },
  });
}
