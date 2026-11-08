// A3.3b-2 — Solid comic preparation cache
//
// One application-owned cache of verified one-pass preparations (cbr-cb7-preparation.js) of solid
// CBR/CB7 comics. It is a storage and lifetime owner only: it never authorizes, opens a source,
// decodes or renders. The comic media service does all of that and hands the cache two things:
//   - `schedule(...)`: a request to prepare one comic revision, with a `run` function the service
//     built (admission, authorization, fresh open, revision proof and prepareSolidCbrCb7 are all
//     inside it). The cache owns the job's lifetime (cancellation, deduplication, retry backoff,
//     disk reservation) and publishes the verified result.
//   - `lease(...)`: a request for the published preparation of an exact source identity and
//     revision, held only while one page is read from it.
//
// Ownership
// ---------
//   - Jobs belong to the cache, not to the page request that triggered them: a request that is
//     cancelled or finishes never cancels a preparation (foreground reads never wait on one, so a
//     preparation has no waiting consumers to count). Jobs end by finishing, failing, being
//     superseded by a newer revision of the same comic, or `close()`.
//   - At most one entry and one job per comic (project + asset). A different revision of the
//     same comic retires the older entry and cancels the older job.
//   - A published preparation is disposed (its private directory removed) when it is evicted,
//     expires idle, is found stale or changed, or at close() — but never while a lease is held;
//     the last lease release then disposes it.
//   - Removal failures are remembered ("stranded" directories, still counted against the disk
//     budget) and retried by sweep(), close() and recover(); recover() removes leftovers of
//     earlier runs.
//
// Disk accounting (F2)
// --------------------
// Bytes are counted in exactly one place at a time: a running job's reservation, a published
// (or retiring) entry, or a stranded record. A directory moves between them synchronously, so
// the same bytes are never counted twice and never dropped:
//   - A job learns its staging directory from the preparation itself (onStaging, called as the
//     directory is created) — never from an error. When the job ends without publishing, the
//     cache removes that directory itself (normally already gone); if it remains, its
//     reservation (the most the preparation could have written) becomes a stranded record.
//   - An entry whose disposal fails becomes a stranded record of its exact size.
//   - recover() charges a leftover it cannot remove by its measured size; a leftover it cannot
//     measure (not the A3.2b layout) withholds all new reservations until a later recover().
//     A leftover whose metadata cannot be read (F4: EIO, EACCES, ...) is neither removed nor
//     assumed gone: it keeps an existing record's bound or is recorded unmeasured; only ENOENT
//     beneath the re-verified trusted root counts as disappearance.
//   - A stranded record is released only after its directory is actually gone. Records are
//     bounded (MAX_STRANDED_RECORDS); beyond that, capacity is withheld until recover().
//   - Nothing retries on its own: sweep(), close() and recover() each try every record once.
//
// Storage
// -------
// The root is a private directory of this user in the platform's temporary storage (see
// Location below; tests may name another `stagingRoot`), never a project directory. Its contents
// are derived data: whatever the operating system clears between runs is simply prepared again.
// Only one cache may own a root per process. Preparations create their own
// `comic-prep-XXXXXX` directories under it (A3.2b staging: mkdtemp 0700, one fixed-name file
// 0600/0400); no archive-controlled name ever reaches the filesystem. recover() removes only real
// directories with that exact generated name shape and leaves everything else in the root alone.
// Removal deletes only that layout (the pack file, then the empty directory): a directory with
// anything else in it is never emptied and stays charged (unmeasured: capacity is withheld)
// until someone removes the foreign content.
//
// Physical containment (F3): the cache is built with the `protectedRoots` it must never touch
// (the projects root). The root is resolved physically (realpath of its deepest existing
// ancestor, so junctions, symlinked ancestors and 8.3 names are followed) and its existing
// ancestors are compared by device and inode with each protected root (so bind mounts and other
// aliases are caught too). This is re-checked before every reservation and before every
// removal; a root whose physical location or identity changed since it was trusted is refused
// and nothing is deleted through it (the bytes stay charged).
//
// Mount aliases (F5): on Linux, device and inode identities cannot see a bind mount of a
// directory *inside* a protected root (its ancestors are the alias's, not the project's). The
// cache therefore places every location physically: the mount a directory is reached through
// (from the kernel, /proc/self/fdinfo of an open handle) and that mount's origin within its
// filesystem (/proc/self/mountinfo) give (device, path within the filesystem). The cache root
// must not lie within, or contain, the physical place of a protected root or of any mount
// beneath one; nothing may be mounted beneath the cache root; and a cache root on a network or
// pass-through filesystem (NFS, SMB, 9p, virtiofs, FUSE ...) on a different filesystem from the
// protected storage is refused, because such a filesystem can re-export protected storage under
// another device. Missing or unreadable mount information refuses the root. Windows has no bind
// mounts (junctions, symlinks, subst drives and volume paths resolve through realpath); a cache
// root on a network share (UNC) is refused there. Other platforms without a mount table
// (besides macOS, which has no bind mounts) are refused.
//
// Replaceable ancestors (F6): removal goes by path, so whoever can rename a directory on the
// root's physical path can redirect it. On POSIX every directory from `/` to the root must be a
// real directory owned by root or this user, and any that others can write must be sticky (they
// then cannot rename what they do not own); the root itself must not be writable by others.
// A root failing this is refused for preparation and removal alike. Removal itself is never
// recursive (removeStagingLayout: one fixed-name pack file, then the empty directory), and a
// removal counts only if afterwards the directory is absent from the root that still verifies;
// otherwise it stays charged. Node offers no handle-relative (openat/unlinkat) removal: with a
// trusted chain, only root or this user can make the path change in the instant between the
// final check and the removal (the documented trust boundary).
//
// Replaceable ancestors on Windows (F7): there the same question is decided by access control
// lists, which Node cannot read; windows-directory-trust.js reads them with the system's own
// Windows PowerShell and judges them. No less-trusted principal (anyone but this user, SYSTEM,
// Administrators, TrustedInstaller) may be able both to remove any directory on the root's
// physical path from its parent and to create something in that parent; none may own one, or
// hold any right to change, delete or re-permission the root, effective or inherited by what is
// created in it. Missing parts of the root are created with a protected private ACL in one step
// (CreateDirectory with that security descriptor); an existing directory is never
// re-permissioned. The same check runs before every reservation and every removal (with the
// physical checks above), so the boundary is established before anything is deleted, never
// inferred afterwards. Every check reads fresh ACLs for the complete chain, including the root;
// neither an earlier positive verdict nor directory timestamps authorize a later removal. A
// trusted principal acting in the instant between the final check and the removal remains the
// documented limitation, as on POSIX.
//
// Location: the application does not choose a directory itself. defaultComicPreparationCacheRoot
// (or the `instance` option) places the root in the platform's temporary storage — os.tmpdir(),
// on Linux containers the container's own /tmp, on Windows the user's temporary folder — under
// a stable name derived from the application's data root (and the POSIX user), so abandoned
// directories of earlier runs are recovered and separate installations or users never share a
// root. Nothing about the location is trusted for its name or origin: it passes the same checks.

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CBR_CB7_PREPARATION_LIMITS, removeStagingLayout } from './cbr-cb7-preparation.js';
import {
  assessWindowsDirectoryChain, createPrivateWindowsDirectories, readWindowsDirectorySecurity,
} from './windows-directory-trust.js';

const MIB = 1024 * 1024;
const POSIX = typeof process.getuid === 'function';
const WINDOWS = process.platform === 'win32';
const LINUX = process.platform === 'linux';
// Platforms whose mount aliases are covered: Linux through its mount table, Windows and macOS
// because they have no bind mounts. Anywhere else (e.g. BSD nullfs) the cache root is refused.
const ALIASES_COVERED = LINUX || WINDOWS || process.platform === 'darwin';
// Filesystems that can expose another filesystem's storage under their own device.
const PASSTHROUGH_FS = new Set(['nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', '9p', 'virtiofs', 'fuse', 'fakeowner', 'drvfs',
  'ceph', 'glusterfs', 'lustre', 'afs', 'davfs', 'sshfs', 'vboxsf', 'vmhgfs', 'prl_fs']);
const isPassthrough = (fstype) => PASSTHROUGH_FS.has(fstype) || fstype.startsWith('fuse.') || fstype.startsWith('nfs');
// Bounded cleanup bookkeeping and path walks.
const MAX_STRANDED_RECORDS = 1024;
const MAX_PATH_DEPTH = 256;
// The A3.2b staging layout: mkdtemp(<root>/comic-prep-) adds six [A-Za-z0-9] characters.
const STAGING_DIR_RE = /^comic-prep-[A-Za-z0-9]{6}$/;
const PACK_NAME = 'pages.bin';

/**
 * Defaults.
 *   maxPreparedBytes      one preparation's staging output: A3.2b's 1 GiB (tighten-only).
 *   maxTotalBytes         all retained preparations plus reservations of running ones: 2 GiB,
 *                         so the largest allowed comic always fits beside ordinary ones (typical
 *                         comics are 20-300 MiB) without the cache becoming a second library.
 *   maxEntries            16 comics retained: a reading session touches a handful.
 *   maxPending            4 jobs in flight (waiting for admission, running or being cancelled);
 *                         the admission's background lane runs one and queues four.
 *   idleMs                10 minutes unused before a preparation is disposed.
 *   settleMs              a source changed less than 5 s ago is not prepared yet: any later write
 *                         then lands on a different timestamp even at FAT's 2 s granularity.
 *   preparationTimeoutMs  A3.2b's 120 s deadline (tighten-only).
 *   retryBaseMs/MaxMs     a failed revision is retried after 1, 2, 4 ... minutes, at most hourly;
 *                         failures inherent to the archive wait the maximum at once.
 *   maxFailureRecords     bounded failure memory (oldest forgotten first).
 */
export const COMIC_PREPARATION_CACHE_DEFAULTS = Object.freeze({
  maxPreparedBytes: CBR_CB7_PREPARATION_LIMITS.maxPreparedBytes,
  maxTotalBytes: 2048 * MIB,
  maxEntries: 16,
  maxPending: 4,
  idleMs: 10 * 60_000,
  settleMs: 5_000,
  preparationTimeoutMs: CBR_CB7_PREPARATION_LIMITS.timeoutMs,
  retryBaseMs: 60_000,
  retryMaxMs: 60 * 60_000,
  maxFailureRecords: 256,
});

const TIGHTEN_ONLY = ['maxPreparedBytes', 'preparationTimeoutMs'];
const ZERO_ALLOWED = ['settleMs'];

// Failures inherent to this revision's bytes or to its currency: retrying soon cannot help.
const PERMANENT_CODES = new Set([
  'ARCHIVE_CORRUPT', 'ARCHIVE_ENCRYPTED', 'ARCHIVE_ENTRY_UNSAFE', 'ENTRY_LIMIT_EXCEEDED',
  'INPUT_LIMIT_EXCEEDED', 'PAGE_LIMIT_EXCEEDED', 'UNSUPPORTED_FORMAT', 'LISTING_LIMIT_EXCEEDED',
  'EXPANSION_LIMIT_EXCEEDED', 'ARCHIVE_NOT_SOLID', 'NOTHING_TO_PREPARE', 'PREPARATION_LIMIT_EXCEEDED',
  'PREPARATION_TOO_LARGE', 'REVISION_STALE', 'SOURCE_CHANGED', 'INPUT_CHANGED', 'ASSET_NOT_FOUND',
  'ASSET_PROJECT_MISMATCH', 'SOURCE_MISSING', 'UNSUPPORTED_COMIC',
]);
// Not failures of the revision: never remembered. MAINTENANCE: the job's application graph was
// paused or retired for database/auth replacement (comic-media-service.js), not a verdict.
const UNRECORDED_CODES = new Set(['SOURCE_UNSETTLED', 'MAINTENANCE']);

// Roots owned by live caches in this process (recover() and disposal assume sole ownership),
// by spelling and, once resolved, by physical path.
const ownedRoots = new Set();
const ownedPhysicalRoots = new Map();

// Path comparison as the filesystem compares: case-insensitive on Windows (drive letters too).
const fold = (value) => (WINDOWS ? value.toLowerCase() : value);
const samePath = (a, b) => fold(path.resolve(a)) === fold(path.resolve(b));
// True when `child` is `parent` or lies beneath it.
function within(child, parent) {
  const relative = path.relative(fold(parent), fold(child));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
// A directory identity usable for comparison, or null where the filesystem reports none.
const identityOf = (stats) => (stats.ino === 0n ? null : `${stats.dev}:${stats.ino}`);

export class ComicPreparationCacheError extends Error {
  /** @param {'CACHE_FULL'|'CACHE_CLOSED'|'CACHE_BUSY'|'CANCELLED'|'SOURCE_UNSETTLED'|'MAINTENANCE'|'PREPARATION_TOO_LARGE'|'PREPARATION_CHANGED'|'STAGING_UNAVAILABLE'|'INVALID_RESULT'} code */
  constructor(code, message) {
    super(message);
    this.name = 'ComicPreparationCacheError';
    this.code = code;
  }
}

const cacheError = (code, message = 'Comic preparation cache: ' + code) => new ComicPreparationCacheError(code, message);

function resolveLimits(overrides) {
  const limits = { ...COMIC_PREPARATION_CACHE_DEFAULTS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(COMIC_PREPARATION_CACHE_DEFAULTS, key)) throw new TypeError(`Unknown preparation cache option: ${key}`);
    const minimum = ZERO_ALLOWED.includes(key) ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum
      || (TIGHTEN_ONLY.includes(key) && value > COMIC_PREPARATION_CACHE_DEFAULTS[key])) {
      throw new TypeError(`Invalid preparation cache option: ${key}`);
    }
    limits[key] = value;
  }
  if (limits.retryBaseMs > limits.retryMaxMs) throw new TypeError('retryBaseMs must not exceed retryMaxMs.');
  return Object.freeze(limits);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// ── Mount topology (F5, Linux) ─────────────────────────────────────────────────────────────

// True when POSIX path `child` is `parent` or lies beneath it.
function posixWithin(child, parent) {
  const relative = path.posix.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative));
}

// mountinfo escapes space, tab, newline and backslash as \ooo octal of the path's bytes.
const unescapeMountField = (field) => Buffer.from(
  field.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8))), 'latin1',
).toString('utf8');

// The mount table this process sees: mount id -> { device, root, mountPoint, fstype }. `root` is
// the directory of the mounted filesystem that appears at `mountPoint` (not "/" for a bind mount).
// Anything unparsable refuses: an incomplete table cannot establish separation.
async function readMountTable() {
  const text = await readFile('/proc/self/mountinfo', 'latin1');
  const mounts = new Map();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const fields = line.split(' ');
    const separator = fields.indexOf('-', 6);
    if (separator < 0 || separator + 1 >= fields.length || !/^\d+$/.test(fields[0]) || !/^\d+:\d+$/.test(fields[2])) {
      throw new Error('Unparsable mount table.');
    }
    const root = unescapeMountField(fields[3]);
    const mountPoint = unescapeMountField(fields[4]);
    if (!root.startsWith('/') || !mountPoint.startsWith('/')) throw new Error('Unparsable mount table.');
    mounts.set(fields[0], { device: fields[2], root, mountPoint, fstype: unescapeMountField(fields[separator + 1]) });
  }
  if (mounts.size === 0) throw new Error('Empty mount table.');
  return mounts;
}

// The physical place of an existing directory: the mount the kernel reached it through (the
// mnt_id of an open handle, so overmounts and nested mounts are never guessed from strings) and
// its path within that mount's filesystem. Throws when any part cannot be established, or when
// the mount's origin was deleted (its path within the filesystem is then unknown).
async function mountRegion(directory, mounts) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await readFile(`/proc/self/fdinfo/${handle.fd}`, 'latin1');
    const mount = mounts.get(/^mnt_id:\s*(\d+)\s*$/m.exec(info)?.[1]);
    if (!mount || mount.root.endsWith('//deleted') || !posixWithin(directory, mount.mountPoint)) {
      throw new Error('Mount of ' + directory + ' unknown.');
    }
    return {
      device: mount.device,
      fsPath: path.posix.join(mount.root, path.posix.relative(mount.mountPoint, directory)),
      fstype: mount.fstype,
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

// Bytes held by an abandoned staging directory of the A3.2b layout (nothing, or one regular
// `pages.bin`), reading at most two directory entries; null when it is anything else.
async function measureLeftover(directory) {
  try {
    const dir = await opendir(directory);
    let bytes = 0;
    let count = 0;
    for await (const dirent of dir) {
      count += 1;
      if (count > 1 || dirent.name !== PACK_NAME || !dirent.isFile()) return null;
      bytes = (await lstat(path.join(directory, PACK_NAME))).size;
    }
    return Number.isSafeInteger(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * The cache root an application instance uses: a directory of this user in the platform's
 * temporary storage (os.tmpdir()), named from the instance's absolute data root so the same
 * installation finds its abandoned preparations again at the next start, while other
 * installations (and, on POSIX, other users sharing the temporary directory) get their own.
 * The path is only a proposal: recover() creates it privately and refuses it unless it passes
 * every physical and ancestor check.
 *
 * @param {string} instance - the application's data root (A3.3c: APP_DATA_ROOT), absolute
 */
export function defaultComicPreparationCacheRoot(instance) {
  if (typeof instance !== 'string' || !path.isAbsolute(instance)) {
    throw new TypeError('An absolute instance data root is required.');
  }
  const base = os.tmpdir();
  if (typeof base !== 'string' || !path.isAbsolute(base)) throw new TypeError('The temporary directory is not an absolute path.');
  const digest = createHash('sha256').update(fold(path.resolve(instance)), 'utf8').digest('hex').slice(0, 16);
  const user = POSIX ? `${process.getuid()}-` : '';
  return path.join(path.resolve(base), `creatorcrate-comic-prep-${user}${digest}`);
}

/**
 * Create the application's preparation cache. Construct once per application (A3.3c), call
 * `recover()` before serving, pass it to every comic media service, and `close()` at shutdown.
 *
 * @param {({ instance: string } | { stagingRoot: string }) & { protectedRoots: string[] }
 *   & Partial<typeof COMIC_PREPARATION_CACHE_DEFAULTS>} options
 *   instance       - the application's data root: the cache root is then
 *                    defaultComicPreparationCacheRoot(instance) (A3.3c uses this).
 *   stagingRoot    - an explicit root instead (tests); exactly one of the two.
 *   protectedRoots - directories the cache root must never be inside, contain or alias,
 *   physically (A3.3c: the projects root). Every service using the cache must name one of them
 *   as its projectsRoot.
 */
export function createComicPreparationCache(options = {}) {
  const { stagingRoot: explicitRoot, instance, protectedRoots: protectedOption, _now, ...overrides } = options;
  if ((explicitRoot === undefined) === (instance === undefined)) {
    throw new TypeError('Exactly one of instance and stagingRoot is required.');
  }
  const stagingRoot = explicitRoot ?? defaultComicPreparationCacheRoot(instance);
  if (typeof stagingRoot !== 'string' || !path.isAbsolute(stagingRoot)) {
    throw new TypeError('An absolute stagingRoot is required.');
  }
  if (!Array.isArray(protectedOption) || protectedOption.length === 0
    || !protectedOption.every((entry) => typeof entry === 'string' && path.isAbsolute(entry))) {
    throw new TypeError('protectedRoots must list the absolute roots the cache must stay out of.');
  }
  const limits = resolveLimits(overrides);
  const root = path.resolve(stagingRoot);
  const protectedRoots = Object.freeze(protectedOption.map((entry) => path.resolve(entry)));
  for (const protectedRoot of protectedRoots) {
    if (within(root, protectedRoot) || within(protectedRoot, root)) {
      throw new TypeError('The preparation cache root must be outside every protected root.');
    }
  }
  const rootKey = fold(root);
  if (ownedRoots.has(rootKey)) throw new TypeError('Another preparation cache already owns this staging root.');
  ownedRoots.add(rootKey);
  const owner = Symbol('comic preparation cache');
  const now = typeof _now === 'function' ? _now : Date.now;

  let state = 'open'; // 'open' -> 'closing' -> 'closed'
  let recovering = false;
  let closing = null;
  let timer = null;
  const entries = new Map(); // comic key -> servable entry
  const retiring = new Set(); // entries out of the index, not yet removed
  const jobs = new Map(); // comic key -> current job
  const aborting = new Set(); // superseded or cancelled jobs still settling
  const discards = new Set(); // removals of preparations that were never published
  const failures = new Map(); // comic key -> { revision, count, until }
  // directory -> { bytes } (bytes null: unmeasurable) for directories whose removal failed or
  // was refused; charged until they are gone.
  const stranded = new Map();
  // Leftovers that could not be recorded (record bound reached, or a staging directory the
  // cache refused to attribute): capacity is withheld until recover() rescans the root.
  let untracked = 0;
  let reservedBytes = 0;
  // The physically resolved root this cache trusts ({ path, id }), set by recover() or the first
  // reservation; every removal requires the root to still resolve to exactly this.
  let trusted = null;

  const keyOf = ({ projectId, assetId }) => `${projectId}:${assetId}`;

  function strandedBytes() {
    let total = 0;
    for (const record of stranded.values()) total += record.bytes ?? 0;
    return total;
  }

  function usedBytes() {
    let total = reservedBytes + strandedBytes();
    for (const entry of entries.values()) total += entry.bytes;
    for (const entry of retiring) total += entry.bytes;
    return total;
  }

  // No new reservation while leftovers exist whose size is unknown.
  function capacityWithheld() {
    if (untracked > 0) return true;
    for (const record of stranded.values()) if (record.bytes === null) return true;
    return false;
  }

  // Charges a directory that could not be removed. Keyed by directory, so a repeated failure
  // never charges twice; a known bound is kept, an unknown one withholds capacity.
  function strand(directory, bytes) {
    const record = stranded.get(directory);
    if (record) {
      if (record.bytes !== null) record.bytes = bytes === null ? null : Math.max(record.bytes, bytes);
      return;
    }
    if (stranded.size >= MAX_STRANDED_RECORDS) {
      untracked += 1;
      return;
    }
    stranded.set(directory, { bytes });
  }

  // ── Physical root (F3) ───────────────────────────────────────────────────────────────────

  const unavailable = (message) => cacheError('STAGING_UNAVAILABLE', message);

  // Physical path and identity of every protected root and, on Linux, the mount table and the
  // physical places (device, path within the filesystem) of each protected root and of every
  // mount beneath one. Fails closed if any of it cannot be established.
  async function protectedIdentities() {
    if (!ALIASES_COVERED) throw unavailable('Mount aliases of protected roots cannot be ruled out on this platform.');
    const guards = [];
    for (const protectedRoot of protectedRoots) {
      try {
        const physical = await realpath(protectedRoot);
        guards.push({ physical, id: identityOf(await stat(physical, { bigint: true })) });
      } catch {
        throw unavailable('A protected root cannot be resolved; nothing is prepared or removed.');
      }
    }
    if (!LINUX) return { guards, mounts: null, regions: [] };
    try {
      const mounts = await readMountTable();
      const regions = [];
      for (const guard of guards) {
        regions.push(await mountRegion(guard.physical, mounts));
        for (const mount of mounts.values()) {
          if (mount.mountPoint !== guard.physical && within(mount.mountPoint, guard.physical)) {
            if (mount.root.endsWith('//deleted')) throw new Error('Deleted mount origin.');
            regions.push({ device: mount.device, fsPath: mount.root, fstype: mount.fstype });
          }
        }
      }
      return { guards, mounts, regions };
    } catch {
      throw unavailable('The mount topology of the protected roots cannot be established; nothing is prepared or removed.');
    }
  }

  // Refuses a physical location that is, contains or lies within a protected root: by path, by
  // the identity of every existing ancestor (catching aliases realpath cannot see) and, on Linux,
  // by physical place within its filesystem (catching bind mounts of protected subdirectories).
  async function assertOutsideProtected(candidate, { guards, mounts, regions }) {
    const into = () => unavailable('The preparation cache root resolves into a protected root.');
    for (const guard of guards) {
      if (within(candidate, guard.physical) || within(guard.physical, candidate)) throw into();
    }
    if (WINDOWS && candidate.startsWith('\\\\')) {
      // A share can expose protected storage under a name no local identity check relates to it.
      throw unavailable('The preparation cache root is on a network share.');
    }
    let current = candidate;
    let deepest = null;
    const missing = [];
    for (let depth = 0; depth < MAX_PATH_DEPTH; depth += 1) {
      let stats = null;
      try {
        stats = await stat(current, { bigint: true });
      } catch (err) {
        if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw unavailable('The preparation cache root cannot be resolved.');
      }
      if (stats && deepest === null) deepest = current;
      else if (!stats && deepest === null) missing.unshift(path.basename(current));
      const id = stats && identityOf(stats);
      if (id !== null && guards.some((guard) => guard.id === id)) throw into();
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (current !== path.dirname(current) || deepest === null) throw unavailable('The preparation cache root cannot be resolved.');
    if (!LINUX) return;
    let place;
    try {
      const region = await mountRegion(deepest, mounts);
      place = { ...region, fsPath: path.posix.join(region.fsPath, ...missing) };
    } catch {
      throw unavailable('The mount topology of the preparation cache root cannot be established.');
    }
    for (const region of regions) {
      if (region.device === place.device && (posixWithin(place.fsPath, region.fsPath) || posixWithin(region.fsPath, place.fsPath))) {
        throw into();
      }
    }
    // Separation by device is proof only for filesystems that cannot re-export another's storage.
    if (isPassthrough(place.fstype) && regions.some((region) => region.device !== place.device)) {
      throw unavailable('The preparation cache root is on a network or pass-through filesystem separate from the protected roots.');
    }
    // Nothing (in particular no alias of project storage) may be mounted beneath the root.
    for (const mount of mounts.values()) {
      if (mount.mountPoint !== candidate && within(mount.mountPoint, candidate)) {
        throw unavailable('A filesystem is mounted beneath the preparation cache root.');
      }
    }
  }

  // F6 (POSIX): no less-trusted user may be able to rename or replace any directory on the
  // root's physical path, nor the staging directories in it. Every directory from the root up to
  // `/` must be a real directory owned by root or this user; a directory others can write must be
  // sticky (others then rename only what they own, and everything on the path is owned by a
  // trusted user); the root itself must not be writable by others at all. `leaf` is false for
  // an existing ancestor checked before the missing part of the root is created beneath it.
  async function assertTrustedChain(physical, { leaf = true } = {}) {
    if (WINDOWS) return assertWindowsChain(physical, { leaf });
    if (!POSIX) throw unavailable('Replaceable ancestors cannot be ruled out on this platform.');
    const uid = BigInt(process.getuid());
    let current = physical;
    for (let depth = 0; depth < MAX_PATH_DEPTH; depth += 1) {
      let stats;
      try {
        stats = await lstat(current, { bigint: true });
      } catch {
        throw unavailable('The preparation cache path cannot be inspected.');
      }
      const othersWrite = (stats.mode & 0o022n) !== 0n;
      if (!stats.isDirectory() || (stats.uid !== 0n && stats.uid !== uid)
        || (othersWrite && ((leaf && depth === 0) || (stats.mode & 0o1000n) === 0n))) {
        throw unavailable('A directory on the preparation cache path can be replaced by another user.');
      }
      const parent = path.dirname(current);
      if (parent === current) return;
      current = parent;
    }
    throw unavailable('The preparation cache path cannot be inspected.');
  }

  // The physical path from `directory` up to its drive root, each a real directory
  // (never a link) with its identity.
  async function windowsChain(directory) {
    const chain = [];
    let current = directory;
    for (let depth = 0; depth < MAX_PATH_DEPTH; depth += 1) {
      let stats;
      try {
        stats = await lstat(current, { bigint: true });
      } catch {
        throw unavailable('The preparation cache path cannot be inspected.');
      }
      const id = identityOf(stats);
      if (!stats.isDirectory() || stats.isSymbolicLink() || id === null) {
        throw unavailable('A directory on the preparation cache path cannot be identified.');
      }
      chain.push({ path: current, id });
      const parent = path.dirname(current);
      if (parent === current) return chain;
      current = parent;
    }
    throw unavailable('The preparation cache path cannot be inspected.');
  }

  // Fresh ACLs are required even when identities and timestamps match: they cannot prove that
  // permissions are unchanged. The reading must still describe the same physical directories.
  async function assertWindowsChain(physical, { leaf }) {
    const before = await windowsChain(physical);
    let security;
    try {
      security = await readWindowsDirectorySecurity(before.map((entry) => entry.path));
    } catch {
      throw unavailable('The permissions of the preparation cache path cannot be read.');
    }
    const after = await windowsChain(physical);
    if (after.length !== before.length || after.some((entry, index) => entry.id !== before[index].id)) {
      throw unavailable('The preparation cache path changed while it was inspected.');
    }
    const problem = assessWindowsDirectoryChain(security, { leaf });
    if (problem !== null) throw unavailable(problem);
  }

  // Resolves the root physically: the deepest existing ancestor through realpath, checked
  // against the protected roots before anything is created; then (creating the missing part
  // beneath the resolved ancestor, when asked) the root itself must be a real private directory
  // resolving to that same place. Returns { path, id }.
  async function resolveRoot({ create }) {
    const protection = await protectedIdentities();
    let existing = root;
    const missing = [];
    for (;;) {
      try {
        await lstat(existing);
        break;
      } catch (err) {
        const parent = path.dirname(existing);
        if (err?.code !== 'ENOENT' || parent === existing || missing.length >= MAX_PATH_DEPTH) {
          throw unavailable('The preparation cache root is unavailable.');
        }
        missing.unshift(path.basename(existing));
        existing = parent;
      }
    }
    if (missing.length > 0 && !create) throw unavailable('The preparation cache root is unavailable.');
    let intended;
    let existingPhysical;
    try {
      existingPhysical = await realpath(existing);
      intended = path.join(existingPhysical, ...missing);
    } catch {
      throw unavailable('The preparation cache root cannot be resolved.');
    }
    await assertOutsideProtected(intended, protection);
    if (missing.length > 0) {
      // Nothing is created beneath a directory another user could replace (F6).
      await assertTrustedChain(existingPhysical, { leaf: false });
      try {
        // Windows (F7): each missing directory is created private in one step, so no other
        // principal ever holds access to it (Windows keeps access granted at open).
        if (WINDOWS) await createPrivateWindowsDirectories(missing.map((_, index) => path.join(existingPhysical, ...missing.slice(0, index + 1))));
        else await mkdir(intended, { recursive: true, mode: 0o700 });
      } catch {
        throw unavailable('The preparation cache root is unavailable.');
      }
    }
    let rootStats;
    let physical;
    let physicalStats;
    try {
      rootStats = await lstat(root, { bigint: true });
      physical = await realpath(root);
      physicalStats = await lstat(physical, { bigint: true });
    } catch {
      throw unavailable('The preparation cache root is unavailable.');
    }
    // The root itself is never a link, belongs to this user and is where it was checked to be.
    if (!rootStats.isDirectory() || (POSIX && rootStats.uid !== BigInt(process.getuid()))
      || !physicalStats.isDirectory() || physicalStats.dev !== rootStats.dev || physicalStats.ino !== rootStats.ino
      || !samePath(physical, intended)) {
      throw unavailable('The preparation cache root is not a private directory.');
    }
    // Recovery makes this user's root private (0700) before the chain is judged.
    if (create && POSIX && (rootStats.mode & 0o077n) !== 0n) {
      try {
        await chmod(physical, 0o700);
      } catch {
        throw unavailable('The preparation cache root cannot be made private.');
      }
    }
    await assertOutsideProtected(physical, protection);
    await assertTrustedChain(physical);
    return { path: physical, id: `${rootStats.dev}:${rootStats.ino}` };
  }

  function claimPhysicalRoot(resolved) {
    const key = fold(resolved.path);
    const holder = ownedPhysicalRoots.get(key);
    if (holder !== undefined && holder !== owner) throw unavailable('Another preparation cache already owns this staging root.');
    if (trusted && fold(trusted.path) !== key && ownedPhysicalRoots.get(fold(trusted.path)) === owner) {
      ownedPhysicalRoots.delete(fold(trusted.path));
    }
    ownedPhysicalRoots.set(key, owner);
    trusted = resolved;
  }

  // The trusted root, re-resolved now. Before trust is established (no recover() yet) the
  // first reservation establishes it; afterwards any change of location or identity is refused.
  async function currentRoot({ establish = false } = {}) {
    const resolved = await resolveRoot({ create: false });
    if (trusted === null && establish) claimPhysicalRoot(resolved);
    if (trusted === null || !samePath(resolved.path, trusted.path) || resolved.id !== trusted.id) {
      throw unavailable('The preparation cache root changed; nothing is removed through it.');
    }
    return resolved;
  }

  // The only way the cache deletes anything: a direct child of the trusted root with the
  // generated staging name, re-checked physically, that is a real directory of this user.
  async function assertRemovable(directory) {
    const current = await currentRoot();
    if (typeof directory !== 'string' || !samePath(path.dirname(directory), current.path)
      || !STAGING_DIR_RE.test(path.basename(directory))) {
      throw unavailable('Not a staging directory of this cache.');
    }
  }

  // Settles only on proof (F6): the directory is absent, and the root it was absent from still
  // verifies (same physical place and identity, trusted chain, outside every protected root). A
  // path redirected during the removal therefore never counts as removed.
  async function assertGone(directory) {
    try {
      await lstat(directory);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        await assertRemovable(directory);
        return;
      }
      throw unavailable('The staging directory cannot be inspected.');
    }
    throw unavailable('The staging directory was not removed.');
  }

  async function removeOwned(directory, prepared = null) {
    await assertRemovable(directory);
    let stats;
    try {
      stats = await lstat(directory);
    } catch (err) {
      if (err?.code === 'ENOENT') return assertGone(directory);
      throw err;
    }
    if (!stats.isDirectory() || (POSIX && stats.uid !== process.getuid())) {
      throw unavailable('Not a private staging directory.');
    }
    // A preparation's own dispose() runs the same check again (beforeStagingRemoval); both remove
    // only the fixed staging layout (removeStagingLayout), never recursively.
    if (prepared && !prepared.disposed) await prepared.dispose();
    else await removeStagingLayout(directory);
    await assertGone(directory);
  }

  // ── Disposal ─────────────────────────────────────────────────────────────────────────────

  // Settles a removal: the directory is either gone or charged as stranded, in one step.
  const removed = (removal) => removal.then(() => true, () => false);

  function startDispose(entry) {
    if (entry.disposing) return;
    entry.disposing = removed(removeOwned(entry.directory, entry.prepared)).then((gone) => {
      if (gone) stranded.delete(entry.directory);
      else strand(entry.directory, entry.bytes);
      retiring.delete(entry);
      entry.gone.resolve();
    });
  }

  // Takes an entry out of service. Its directory is removed once no read holds it.
  function retire(entry) {
    if (entry.retired) return;
    entry.retired = true;
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    retiring.add(entry);
    if (entry.readers === 0) startDispose(entry);
  }

  // Removes a preparation a job obtained but does not publish. The job's own staging directory
  // stays charged to the job's reservation, which settleJobStaging() turns into a stranded
  // record if the directory remains; any other directory is charged here.
  function discardPrepared(job, prepared) {
    const directory = typeof prepared?.filePath === 'string' ? path.dirname(prepared.filePath) : null;
    const removal = removed(removeOwned(directory, prepared)).then((gone) => {
      if (gone || directory === null) return;
      if (job.staging === null || !samePath(directory, job.staging)) {
        strand(directory, Number.isSafeInteger(prepared.preparedBytes) ? prepared.preparedBytes : null);
      }
    }).finally(() => discards.delete(removal));
    discards.add(removal);
    return removal;
  }

  function idleByAge() {
    return [...entries.values()].filter((entry) => entry.readers === 0).sort((a, b) => a.lastUsed - b.lastUsed);
  }

  // ── Failures ─────────────────────────────────────────────────────────────────────────────

  function recordFailure(key, revision, err) {
    const code = err?.code;
    if (UNRECORDED_CODES.has(code)) return;
    const previous = failures.get(key);
    const count = previous?.revision === revision ? previous.count + 1 : 1;
    const delay = PERMANENT_CODES.has(code)
      ? limits.retryMaxMs
      : Math.min(limits.retryMaxMs, limits.retryBaseMs * 2 ** Math.min(count - 1, 30));
    failures.delete(key);
    failures.set(key, { revision, count, until: now() + delay, code: typeof code === 'string' ? code : 'INTERNAL' });
    while (failures.size > limits.maxFailureRecords) failures.delete(failures.keys().next().value);
  }

  // ── Jobs ─────────────────────────────────────────────────────────────────────────────────

  function supersede(job) {
    if (jobs.get(job.key) === job) jobs.delete(job.key);
    aborting.add(job);
    job.controller.abort();
  }

  // Reserves disk for one preparation before it starts writing, evicting idle entries (least
  // recently used first) when the total would exceed maxTotalBytes. Called by the job once it
  // holds its admission, so a waiting job reserves nothing and evicts nothing.
  async function reserve(job, bytes) {
    for (;;) {
      if (state !== 'open' || job.controller.signal.aborted) throw cacheError('CANCELLED');
      if (job.reserved > 0) throw cacheError('INVALID_RESULT', 'A preparation reserves once.');
      // The root is re-resolved physically before every reservation (F3).
      const current = await currentRoot({ establish: true });
      if (state !== 'open' || job.controller.signal.aborted) throw cacheError('CANCELLED');
      if (job.reserved > 0) throw cacheError('INVALID_RESULT', 'A preparation reserves once.');
      if (capacityWithheld()) throw cacheError('CACHE_FULL', 'Unresolved staging leftovers withhold cache capacity.');
      const deficit = usedBytes() + bytes - limits.maxTotalBytes;
      if (deficit <= 0) {
        job.reserved = bytes;
        reservedBytes += bytes;
        return Object.freeze({
          stagingRoot: current.path,
          maxPreparedBytes: bytes,
          timeoutMs: limits.preparationTimeoutMs,
          onStaging: (directory) => claimStaging(job, current.path, directory),
          beforeStagingRemoval: (directory) => assertRemovable(directory),
        });
      }
      const victims = [];
      let freed = 0;
      for (const entry of idleByAge()) {
        if (freed >= deficit) break;
        victims.push(entry);
        freed += entry.bytes;
      }
      let releasing = 0;
      for (const entry of retiring) releasing += entry.bytes;
      if (freed + releasing < deficit) throw cacheError('CACHE_FULL', 'The preparation cache is full.');
      for (const entry of victims) retire(entry);
      await Promise.all([...retiring].map((entry) => entry.gone.promise));
    }
  }

  async function publish(job, result) {
    const prepared = result?.prepared;
    if (!prepared || typeof prepared.read !== 'function' || typeof prepared.dispose !== 'function') {
      recordFailure(job.key, job.revision, cacheError('INVALID_RESULT'));
      return;
    }
    const current = state === 'open' && !job.controller.signal.aborted && jobs.get(job.key) === job;
    // The published directory must be the one the job claimed, so no claimed directory is left
    // outside the accounting.
    const valid = typeof result.identityKey === 'string' && Number.isSafeInteger(prepared.preparedBytes)
      && prepared.preparedBytes <= job.reserved && Array.isArray(prepared.slots)
      && job.staging !== null && typeof prepared.filePath === 'string' && samePath(path.dirname(prepared.filePath), job.staging);
    if (!current || !valid) {
      if (current) recordFailure(job.key, job.revision, cacheError('INVALID_RESULT'));
      await discardPrepared(job, prepared);
      return;
    }
    while (entries.size >= limits.maxEntries) {
      const [victim] = idleByAge();
      if (!victim) {
        recordFailure(job.key, job.revision, cacheError('CACHE_FULL'));
        await discardPrepared(job, prepared);
        return;
      }
      retire(victim);
    }
    const existing = entries.get(job.key);
    if (existing) retire(existing);
    // From here the entry owns the staging directory and its bytes.
    job.published = true;
    entries.set(job.key, {
      key: job.key,
      revision: job.revision,
      identityKey: result.identityKey,
      prepared,
      directory: path.dirname(prepared.filePath),
      bytes: prepared.preparedBytes,
      readers: 0,
      lastUsed: now(),
      retired: false,
      disposing: null,
      gone: deferred(),
    });
    failures.delete(job.key);
    armTimer();
  }

  // Records the staging directory a job's preparation just created (A3.2b onStaging). Only a
  // generated direct child of the root the reservation handed out is accepted; anything else
  // is refused and, being unattributable, withholds capacity until recover().
  function claimStaging(job, stagingRoot, directory) {
    if (job.staging !== null || job.reserved === 0 || typeof directory !== 'string'
      || !samePath(path.dirname(directory), stagingRoot) || !STAGING_DIR_RE.test(path.basename(directory))) {
      untracked += 1;
      throw unavailable('Unexpected staging directory.');
    }
    job.staging = directory;
  }

  // After a job that did not publish: its staging directory (normally already removed by the
  // preparation) is removed by the cache, or its reservation becomes a stranded record of the
  // same bytes — in the same step that releases the reservation.
  async function settleJobStaging(job) {
    if (job.staging === null || job.published) return;
    const gone = await removed(removeOwned(job.staging));
    if (gone) stranded.delete(job.staging);
    else strand(job.staging, job.reserved);
    reservedBytes -= job.reserved;
    job.reserved = 0;
  }

  function startJob(key, request) {
    const job = {
      key, revision: request.revision, controller: new AbortController(), reserved: 0, staging: null, published: false, promise: null,
    };
    jobs.set(key, job);
    const context = Object.freeze({
      signal: job.controller.signal,
      reserve: () => reserve(job, request.expectedBytes),
      // For a preparation the run obtained but will not return (it failed a later check).
      discard: (prepared) => discardPrepared(job, prepared),
      isSettled,
    });
    job.promise = (async () => {
      let result;
      try {
        result = await request.run(context);
      } catch (err) {
        if (!job.controller.signal.aborted) recordFailure(key, job.revision, err);
        return;
      }
      await publish(job, result);
    })().catch(() => {}).then(() => settleJobStaging(job)).catch(() => {}).finally(() => {
      // A published reservation becomes the entry's bytes (counted from publication on); an
      // unpublished one was settled above (removed, or moved to a stranded record).
      reservedBytes -= job.reserved;
      job.reserved = 0;
      if (jobs.get(key) === job) jobs.delete(key);
      aborting.delete(job);
    });
  }

  function isSettled(changedAtMs) {
    return Number.isFinite(changedAtMs) && now() - changedAtMs >= limits.settleMs;
  }

  /**
   * Ask for one comic revision to be prepared. Never waits and never throws for cache state;
   * returns what happened:
   *   'ready'      already prepared       'preparing'  the same revision is already in flight
   *   'scheduled'  a job was started      'backoff'    this revision failed recently
   *   'too-large'  over the size limits   'unsettled'  the source changed too recently
   *   'busy'       maxPending reached     'empty'      nothing to prepare   'closed'
   *
   * @param {{ projectId: number, assetId: number, revision: string, expectedBytes: number,
   *   changedAtMs: number, run: (context: { signal: AbortSignal, reserve: () => Promise<{
   *   stagingRoot: string, maxPreparedBytes: number, timeoutMs: number }>, discard: Function,
   *   isSettled: Function }) => Promise<{ prepared: object, identityKey: string }> }} request
   */
  function schedule(request) {
    const { revision, expectedBytes, changedAtMs, run } = request ?? {};
    if (typeof revision !== 'string' || typeof run !== 'function') throw new TypeError('Invalid preparation request.');
    if (state !== 'open') return 'closed';
    if (recovering) return 'busy';
    const key = keyOf(request);
    const entry = entries.get(key);
    if (entry) {
      if (entry.revision === revision) return 'ready';
      retire(entry);
    }
    const job = jobs.get(key);
    if (job) {
      if (job.revision === revision) return 'preparing';
      supersede(job);
    }
    const failure = failures.get(key);
    if (failure) {
      if (failure.revision !== revision) failures.delete(key);
      else if (now() < failure.until) return 'backoff';
    }
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1) return 'empty';
    if (expectedBytes > Math.min(limits.maxPreparedBytes, limits.maxTotalBytes)) {
      recordFailure(key, revision, cacheError('PREPARATION_TOO_LARGE'));
      return 'too-large';
    }
    if (!isSettled(changedAtMs)) return 'unsettled';
    if (jobs.size + aborting.size >= limits.maxPending) return 'busy';
    startJob(key, request);
    return 'scheduled';
  }

  // ── Reads ────────────────────────────────────────────────────────────────────────────────

  /**
   * Lease the published preparation of exactly this comic, revision and source identity, or
   * null. An entry for the comic whose identity differs is retired. The lease must be released
   * (in finally) as soon as the page bytes have been read; `discard()` additionally retires the
   * entry when its output proved changed.
   */
  function lease({ projectId, assetId, revision, identityKey }) {
    if (state !== 'open') return null;
    const entry = entries.get(keyOf({ projectId, assetId }));
    if (!entry || entry.revision !== revision) return null;
    if (entry.identityKey !== identityKey) {
      retire(entry);
      return null;
    }
    entry.readers += 1;
    entry.lastUsed = now();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.readers -= 1;
      entry.lastUsed = now();
      if (entry.retired && entry.readers === 0) startDispose(entry);
      else armTimer();
    };
    return Object.freeze({
      prepared: entry.prepared,
      release,
      discard() {
        recordFailure(entry.key, entry.revision, cacheError('PREPARATION_CHANGED'));
        retire(entry);
        release();
      },
    });
  }

  /** 'ready' | 'preparing' | null for a comic revision. */
  function stateOf(comic, revision) {
    const key = keyOf(comic);
    if (entries.get(key)?.revision === revision) return 'ready';
    if (jobs.get(key)?.revision === revision) return 'preparing';
    return null;
  }

  /**
   * Retire what no longer describes the current source of a comic: an entry whose revision or
   * identity differs, and (when the current revision is known) a job for another revision.
   */
  function invalidate(comic, { revision, identityKey } = {}) {
    const key = keyOf(comic);
    const entry = entries.get(key);
    if (entry && ((revision !== undefined && entry.revision !== revision)
      || (identityKey !== undefined && entry.identityKey !== identityKey))) {
      retire(entry);
    }
    const job = jobs.get(key);
    if (job && revision !== undefined && job.revision !== revision) supersede(job);
  }

  // ── Maintenance ──────────────────────────────────────────────────────────────────────────

  function armTimer() {
    clearTimeout(timer);
    timer = null;
    if (state !== 'open') return;
    let next = Infinity;
    for (const entry of entries.values()) if (entry.readers === 0) next = Math.min(next, entry.lastUsed + limits.idleMs);
    if (next === Infinity) return;
    timer = setTimeout(() => {
      timer = null;
      sweep().catch(() => {});
    }, Math.max(0, Math.min(next - now(), 2 ** 31 - 1)));
    timer.unref?.();
  }

  // One removal attempt per stranded record; a record is released only once its directory is
  // gone (exactly once: the record is deleted with it).
  async function removeStranded() {
    for (const [directory, record] of [...stranded]) {
      if (await removed(removeOwned(directory))) {
        if (stranded.get(directory) === record) stranded.delete(directory);
      }
      // Otherwise it stays stranded (and charged) until a later sweep, close() or recover().
    }
  }

  /** Expire idle entries and failure records, retry stranded removals. Safe at any time. */
  async function sweep() {
    const time = now();
    for (const entry of [...entries.values()]) {
      if (entry.readers === 0 && time - entry.lastUsed >= limits.idleMs) retire(entry);
    }
    for (const [key, failure] of [...failures]) if (time >= failure.until) failures.delete(key);
    await removeStranded();
    await Promise.all([...retiring].filter((entry) => entry.disposing).map((entry) => entry.disposing));
    armTimer();
  }

  /**
   * Startup recovery (A3.3c calls it before serving): resolves the root physically (creating it
   * privately if missing, never inside a protected root), and removes leftover
   * `comic-prep-XXXXXX` directories of earlier runs. A leftover that cannot be removed stays
   * charged (by its measured size, or withholding capacity when it cannot be measured) and is
   * retried by sweep(), close() and the next recover(). Refused while preparations are in
   * flight; directories of this cache's own entries are kept.
   */
  async function recover() {
    if (state !== 'open') throw cacheError('CACHE_CLOSED');
    if (recovering || jobs.size > 0 || aborting.size > 0) throw cacheError('CACHE_BUSY', 'Recovery cannot run while preparations are in flight.');
    recovering = true;
    try {
      const resolved = await resolveRoot({ create: true });
      // A root that moved or was replaced while preparations are published is not re-trusted:
      // their directories are where the old root was.
      if (trusted !== null && (!samePath(resolved.path, trusted.path) || resolved.id !== trusted.id)
        && (entries.size > 0 || retiring.size > 0)) {
        throw unavailable('The preparation cache root changed while preparations are published.');
      }
      claimPhysicalRoot(resolved);
      const live = new Set([...entries.values(), ...retiring].map((entry) => fold(entry.directory)));
      // This scan accounts for everything in the root again.
      untracked = 0;
      let removedCount = 0;
      let failed = 0;
      // Leftovers whose metadata could not be read (F4): never assumed gone, never removed.
      let uninspected = 0;
      const present = new Set();
      let names;
      try {
        names = await readdir(resolved.path);
      } catch {
        throw unavailable('The preparation cache root cannot be read.');
      }
      for (const name of names) {
        if (!STAGING_DIR_RE.test(name)) continue;
        const directory = path.join(resolved.path, name);
        present.add(fold(directory));
        if (live.has(fold(directory))) continue;
        const known = [...stranded.keys()].find((key) => samePath(key, directory)) ?? directory;
        let stats;
        try {
          stats = await lstat(directory);
        } catch (err) {
          // F4: a failure to inspect is not evidence of deletion. Only ENOENT for a listed
          // generated child of the still-trusted root counts as gone (its record, if any, is then
          // resolved below); anything else stays charged — a record keeps its known bound, a new
          // leftover is unmeasured and withholds capacity — and is retried by sweep(), close()
          // and the next recover(). Nothing is removed on the strength of its name alone.
          if (err?.code === 'ENOENT' && await assertRemovable(directory).then(() => true, () => false)) {
            present.delete(fold(directory));
            continue;
          }
          failed += 1;
          uninspected += 1;
          if (!stranded.has(known)) strand(directory, null);
          continue;
        }
        // Symlinks and files are never followed or removed; nor is anything another user owns.
        if (!stats.isDirectory() || (POSIX && stats.uid !== process.getuid())) continue;
        if (await removed(removeOwned(directory))) {
          stranded.delete(known);
          removedCount += 1;
        } else {
          failed += 1;
          // A record from this run keeps its known bound; an earlier run's leftover is measured,
          // and so is one recorded unmeasured (F4: its metadata was unreadable before).
          const record = stranded.get(known);
          if (!record) {
            strand(directory, await measureLeftover(directory));
          } else if (record.bytes === null) {
            const bytes = await measureLeftover(directory);
            if (bytes !== null && stranded.get(known) === record) record.bytes = bytes;
          }
        }
      }
      // Records of this root whose directories no longer exist are resolved.
      for (const directory of [...stranded.keys()]) {
        if (samePath(path.dirname(directory), resolved.path) && !present.has(fold(directory))) stranded.delete(directory);
      }
      return Object.freeze({ removed: removedCount, failed, uninspected });
    } finally {
      recovering = false;
    }
  }

  /** Resolves once no job, disposal or removal is in flight (tests and shutdown diagnostics). */
  async function whenIdle() {
    for (;;) {
      const pending = [
        ...[...jobs.values(), ...aborting].map((job) => job.promise),
        ...discards,
        ...[...retiring].filter((entry) => entry.disposing).map((entry) => entry.disposing),
      ];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  /**
   * Shutdown: stop accepting work, cancel waiting and running preparations (their staging is
   * removed by A3.2b before they settle), retire every entry (removed once in-flight reads
   * release them) and await all of it. Idempotent; resolves with what remains on disk because
   * its removal failed or was refused (left for recover() at the next start): `stranded`
   * directories (including unrecorded ones), `strandedBytes` charged for them, and `unmeasured`
   * directories of unknown size.
   */
  function close() {
    closing ??= (async () => {
      state = 'closing';
      clearTimeout(timer);
      timer = null;
      for (const job of [...jobs.values()]) supersede(job);
      await Promise.allSettled([...aborting].map((job) => job.promise));
      for (const entry of [...entries.values()]) retire(entry);
      await Promise.all([...retiring].map((entry) => entry.gone.promise));
      await Promise.allSettled([...discards]);
      await removeStranded();
      failures.clear();
      state = 'closed';
      ownedRoots.delete(rootKey);
      if (trusted && ownedPhysicalRoots.get(fold(trusted.path)) === owner) ownedPhysicalRoots.delete(fold(trusted.path));
      return Object.freeze({ stranded: stranded.size + untracked, strandedBytes: strandedBytes(), unmeasured: unmeasured() });
    })();
    return closing;
  }

  function unmeasured() {
    let count = untracked;
    for (const record of stranded.values()) if (record.bytes === null) count += 1;
    return count;
  }

  /** Whether `projectsRoot` is one of the roots this cache was built to stay out of. */
  function protects(projectsRoot) {
    return typeof projectsRoot === 'string' && protectedRoots.some((entry) => samePath(entry, projectsRoot));
  }

  /** Counters only: no paths, revisions or request objects. */
  function snapshot() {
    let readers = 0;
    let retainedBytes = 0;
    for (const entry of entries.values()) {
      readers += entry.readers;
      retainedBytes += entry.bytes;
    }
    for (const entry of retiring) readers += entry.readers;
    return Object.freeze({
      state,
      entries: entries.size,
      retainedBytes,
      reservedBytes,
      usedBytes: usedBytes(),
      retiring: retiring.size,
      pending: jobs.size,
      aborting: aborting.size,
      readers,
      failures: failures.size,
      stranded: stranded.size + untracked,
      strandedBytes: strandedBytes(),
      unmeasured: unmeasured(),
      capacityWithheld: capacityWithheld(),
    });
  }

  return Object.freeze({
    stagingRoot: root,
    limits,
    protects,
    schedule,
    lease,
    state: stateOf,
    invalidate,
    isSettled,
    sweep,
    recover,
    whenIdle,
    close,
    snapshot,
  });
}
