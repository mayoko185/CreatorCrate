// A3.3b-1 — Comic resource admission
//
// One application-owned admission state bounds every comic operation that decodes archive
// data or renders pages: manifest listing (ZIP central directory, or a 7-Zip WASM worker for
// CBR/CB7), page extraction (ZIP inflate or a WASM worker), Sharp decoding and rendition, and,
// from A3.3b-2, one-pass solid preparation. An operation runs only while it holds an admission;
// the admission is released when the operation settles, whatever the outcome.
//
// Why not the shared processing pool (processing-concurrency-service.js)
// ----------------------------------------------------------------------
// That pool is the reviewed admission for processing jobs and derivative generation, and it
// stays unchanged. It cannot bound interactive comic reads without changing its contract:
//   - its pending queue is unbounded and cannot refuse work when full;
//   - a queued task cannot be withdrawn: a cancelled request would stay queued (retaining its
//     closure) until a permit frees, then start;
//   - waiting has no deadline;
//   - it counts tasks, not memory, so a 7-Zip worker and a tiny CBZ listing weigh the same;
//   - its permits are held for whole processing items (watermarking, archive generation), so
//     page reads queued behind a batch would wait for it, and comic reads holding its permits
//     would slow processing jobs and derivative generation that share it today.
// So comic admission is a separate, small, bounded state. The two budgets are additive: this
// module does not create a process-wide limit across subsystems (see Limits below).
//
// Policy
// ------
//   - At most `maxActive` operations run, and their summed estimated memory (`weightBytes`)
//     stays within `memoryBudgetBytes`. A weight above the budget is clamped to it, so such an
//     operation runs alone rather than never.
//   - At most `maxDecoderActive` of them run a 7-Zip WASM decoder (the caller flags such an
//     operation with `decoder: true`; F1b-P3, see Memory estimates).
//   - Foreground (interactive) requests wait in FIFO order; the head is never overtaken by a
//     later foreground request, so a heavy request cannot be starved by light ones.
//   - Background requests (A3.3b-2 preparation) are admitted only while no foreground request
//     is waiting, at most `maxBackgroundActive` at once, and only if that leaves one active slot
//     and `foregroundReserveBytes` of budget free. A preparation therefore never holds the last
//     slot or the memory a foreground page read needs; foreground progress never waits on a
//     preparation finishing. Background work may be delayed while foreground load continues;
//     its own wait deadline bounds that.
//   - Each lane's waiting list is bounded (`maxQueued`, `maxBackgroundQueued`); a request that
//     cannot be admitted or queued is refused at once (QUEUE_FULL).
//   - Waiting is bounded by a deadline (ADMISSION_TIMEOUT) and by the caller's AbortSignal
//     (CANCELLED). A refused, timed-out or cancelled request is removed from the queue
//     immediately, holds nothing, and never starts.
//   - Admission reserves no resources other than the counters: callers open descriptors only
//     inside the admitted task, so nothing is held while waiting.
//
// Deadlines: the signal is the carrier of a caller's overall deadline (A3.3c: request close or
// AbortSignal.timeout). It is honoured while waiting, checked again on admission before the task
// starts, and passed by the task to the readers. The readers' own `timeoutMs` and the Sharp
// timeout then bound the admitted work; they start only after admission, never for a request
// whose wait already ended, so an expired wait is never followed by a fresh decoder timeout.
//
// Memory estimates
// ----------------
// Weights come from A1's `estimateJobMemoryBytes` (WASM linear memory ceiling + member buffer +
// listing text + worker V8 heap + worker overhead: 364 MiB at the default limits) and from a
// measured Sharp rendition reserve. A decoder worker is disposed before its page is rendered, so
// a CBR/CB7 page read peaks at the larger of the two phases, not their sum. A CBZ page holds its
// inflated member while Sharp decodes it.
//
// F1a: the rendition runs in a disposable child process (comic-rendition-process.js). A page's
// rendition share is therefore the member the parent keeps (for an unchanged page) plus the
// child: its Node + Sharp baseline, its own copy of the member, the measured Sharp reserve, and
// one output-sized IPC copy for the result the parent receives while the child still holds it.
// The admission is held until the child is confirmed gone, so this share is never released
// while the child's memory could still be in use.
//
// F1b (measured, Node 24.19, Sharp 0.35.3; Windows 11 x64 and Debian 12 glibc in Docker):
//   - an idle child (cold or the preloaded spare) holds 52 MiB on Windows and 70 MiB on Linux;
//   - the 96 MP worst case peaks at 399 MiB (Windows) and 473 MiB (Linux) in the child;
//   - receiving a result holds the output's IPC copy, counted below.
//
// F1b-P3 (independent review, re-measured): the F1b note that the parent's send copies "do not
// stack on the decode reserve" was wrong. Node 24's advanced serialization
// (internal/child_process/serialization.js, writeChannelMessage) serializes the whole job into
// one member-sized buffer and, because a large write to the pipe completes asynchronously,
// keeps it on the write request until the write ends; it is then garbage that V8 has not
// collected by the time the child reaches its decode peak. Measured on Linux (Debian 12 glibc,
// Node 24.19, Sharp 0.35.3, cold child, parent+child RSS sampled every 2 ms from a separate
// thread, growth over the parent's RSS before the member was read), 12000 x 8000 JPEG to the
// 25 MP bound (14.5 MiB output), four runs each:
//     52.4 MiB member: 576.0 MiB on the first run, 568.5-569.1 MiB after (the reviewer's 568-570);
//     62.3 MiB member: 615.5 MiB on the first run, 607.7-608.0 MiB after;
//   at the sum's peak the parent held about 2.15 x member (member + serialized copy), the child
//   peaked at 463 / 483 MiB. Extrapolated to the 64 MiB member bound: about 615 MiB (622 MiB on a
//   first run). The old 544 MiB formula counted the member only twice (parent bytes and the
//   child's copy); it now counts the parent's serialized copy too, plus an explicit margin
//   (COMIC_RENDITION_MARGIN_BYTES) for first-run parent heap growth (+7 MiB measured), the
//   result's transient receive buffers (chunks, concatenation, deserialized copy: each at most
//   the 32 MiB output bound, one of them already counted) and allocator variance:
//     page = 3 x 64 (parent, serialized copy, child) + 72 + 312 + 32 + 64 margin = 672 MiB,
//   about 50-57 MiB (8-9%) above the extrapolated peak and 61-68 MiB above both measurements.
// The budget is two such page reads, 1344 MiB. That budget would also fit three decoder-only
// operations (3 x 364 = 1092 MiB), which 1088 MiB never did; so the decoder concurrency the
// old budget imposed implicitly is now explicit and unchanged: `maxDecoderActive` (2) bounds
// the operations that run a 7-Zip WASM decoder (CBR/CB7 manifests, pages and preparations,
// flagged by the caller with `decoder: true`). No combination that was refused before is
// admitted now, and none that was admitted is refused.
//
// The preloaded spare (F1b, comic-rendition-process.js) is one idle child outside every
// admitted operation: a claimed spare becomes the child its page's estimate already counts, and
// its replacement is the one standing cost, COMIC_RENDITION_SPARE_BYTES. It is not weighted in
// this admission (it is never more than one, and it does no work while idle); the comic
// subsystem's scheduled total is therefore memoryBudgetBytes + COMIC_RENDITION_SPARE_BYTES
// (1416 MiB at the defaults) when the application's runtime preloads it. These are scheduling
// allowances, not measured peaks and not limits.
//
// Limits (not claimed): estimates size the schedule; they are not an OS-enforced ceiling. The
// process has no RSS limit, the processing pool, derivative generation, Krita previews and
// Sharp's own cache (sharp-runtime.js) consume memory outside this budget, and libvips may
// retain freed memory in its allocator. Page renditions run in a disposable child process
// (F1a), which makes their native work terminable and returns its memory at exit, but no
// memory limit is imposed on that child: its estimate, like every other, is not a ceiling.

import {
  estimateJobMemoryBytes,
} from './archive-member-decoder.js';
import { CBZ_READER_LIMITS } from './cbz-page-reader.js';
import { decoderLimitsOf, resolveCbrCb7Limits } from './cbr-cb7-page-reader.js';
import { resolvePreparationLimits } from './cbr-cb7-preparation.js';
import { COMIC_RENDITION_PROTOCOL } from './comic-rendition-process.js';

const MIB = 1024 * 1024;

// Peak RSS growth measured for renderComicPageStill (Sharp 0.35.3, concurrency 1, Node 24,
// Windows x64): 77 MiB for a 25 MP JPEG decoded unchanged, 123 MiB for a 1200x60000 strip
// downscaled, 279 MiB for a 96 MP JPEG downscaled to the 25 MP rendition bound. The readers
// accept up to 100 MP, so the reserve covers the measured worst case with a small margin.
// F1b: in the Linux (glibc) child the same 96 MP downscale needs about 332 MiB beyond the
// child's baseline and input copy (473 MiB peak - 70 MiB - 57 MiB, 13.7 MiB output included);
// raised from 288 MiB to cover it together with the output share below.
export const COMIC_RENDITION_RESERVE_BYTES = 312 * MIB;
// F1a: a rendition child's resident memory once Node and Sharp are loaded, measured at 53 MiB
// (Node 24, Sharp 0.35.3, Windows x64). F1b: 70 MiB on Linux (Debian 12, glibc), so 72 MiB.
// Measured whole-child peak for the 96 MP worst case above: 399 MiB on Windows and 473 MiB on
// Linux with a 57 MiB input, within the child's share below (72 + member + 312 + 32).
export const COMIC_RENDITION_PROCESS_BYTES = 72 * MIB;
// F1b: the one idle preloaded spare child's standing cost (see above): one idle child.
export const COMIC_RENDITION_SPARE_BYTES = COMIC_RENDITION_PROCESS_BYTES;
// A CBZ manifest parses at most maxEntries central-directory records (no member is inflated).
export const CBZ_CATALOG_RESERVE_BYTES = 32 * MIB;

// F1b-P3: scheduling margin on every page rendition (see "F1b-P3" above): the first-run parent
// heap growth, the result's transient receive copies beyond the one counted, allocator variance.
export const COMIC_RENDITION_MARGIN_BYTES = 64 * MIB;

// Memory of one page rendition beyond the member the parent already holds (see F1a, F1b-P3
// above): the parent's serialized job message (one member-sized copy, retained past the child's
// decode peak), the child (baseline, its own member copy, the Sharp reserve), one output-sized
// IPC copy and the margin.
function renditionShareBytes(memberBytes) {
  const member = Math.min(memberBytes, COMIC_RENDITION_PROTOCOL.maxInputBytes);
  return member + COMIC_RENDITION_PROCESS_BYTES + member + COMIC_RENDITION_RESERVE_BYTES
    + COMIC_RENDITION_PROTOCOL.maxOutputBytes + COMIC_RENDITION_MARGIN_BYTES;
}

/**
 * Estimated peak memory of one comic operation, for admission weighting only.
 *
 * @param {'manifest'|'page'|'preparation'} operation
 * @param {'cbz'|'cbr'|'cb7'} format
 * @param {object} [limits] - the (tighten-only) reader or preparation limits the operation uses.
 */
export function estimateComicOperationBytes(operation, format, limits = {}) {
  if (format === 'cbz') {
    if (operation === 'manifest') return CBZ_CATALOG_RESERVE_BYTES;
    if (operation === 'page') {
      const { maxMemberBytes } = { ...CBZ_READER_LIMITS, ...limits };
      return maxMemberBytes + renditionShareBytes(maxMemberBytes);
    }
    throw new TypeError('CBZ archives are never prepared.');
  }
  if (format !== 'cbr' && format !== 'cb7') throw new TypeError('Unknown comic format: ' + format);
  if (operation === 'preparation') {
    // The worker writes pages to staging; the parent then reads each page back (one member
    // buffer) to verify it. Both phases can overlap only by one page.
    const resolved = resolvePreparationLimits(limits);
    return estimateJobMemoryBytes(decoderLimitsOf(resolved, resolved.timeoutMs)) + resolved.maxMemberBytes;
  }
  const resolved = resolveCbrCb7Limits(limits);
  const decoder = estimateJobMemoryBytes(decoderLimitsOf(resolved, resolved.timeoutMs));
  if (operation === 'manifest') return decoder;
  if (operation === 'page') return Math.max(decoder, resolved.maxMemberBytes + renditionShareBytes(resolved.maxMemberBytes));
  throw new TypeError('Unknown comic operation: ' + operation);
}

// Two default-limit page reads (2 x 672 MiB since F1b-P3; decoder-only operations 364 MiB) fit
// together; at most two decoder operations run at once (maxDecoderActive, the bound 1088 MiB
// imposed implicitly before F1b-P3); a preparation (428 MiB) fits only while foreground use
// leaves the reserve free.
export const COMIC_ADMISSION_DEFAULTS = Object.freeze({
  maxActive: 3,
  memoryBudgetBytes: 1344 * MIB,
  maxDecoderActive: 2,
  maxQueued: 32,
  queueTimeoutMs: 15_000,
  maxBackgroundActive: 1,
  maxBackgroundQueued: 4,
  backgroundQueueTimeoutMs: 60_000,
  // The heaviest default foreground operation (a CBR/CB7 page or manifest).
  foregroundReserveBytes: Math.max(
    estimateComicOperationBytes('page', 'cbr'),
    estimateComicOperationBytes('page', 'cbz'),
  ),
});

export class ComicAdmissionError extends Error {
  /** @param {'QUEUE_FULL'|'ADMISSION_TIMEOUT'|'CANCELLED'} code */
  constructor(code, message) {
    super(message);
    this.name = 'ComicAdmissionError';
    this.code = code;
  }
}

const queueFull = () => new ComicAdmissionError('QUEUE_FULL', 'Comic admission queue is full.');
const timedOut = () => new ComicAdmissionError('ADMISSION_TIMEOUT', 'Comic admission wait timed out.');
const cancelledError = () => new ComicAdmissionError('CANCELLED', 'Comic admission was cancelled.');

function positiveInteger(value, name, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`Invalid comic admission option: ${name}`);
  }
  return value;
}

/**
 * Create the shared comic admission state. The application creates one and passes it to every
 * comic media service (A3.3c wiring); it is never created per request.
 */
export function createComicAdmission(options = {}) {
  for (const key of Object.keys(options)) {
    if (!Object.hasOwn(COMIC_ADMISSION_DEFAULTS, key)) throw new TypeError(`Unknown comic admission option: ${key}`);
  }
  const config = { ...COMIC_ADMISSION_DEFAULTS, ...options };
  // A single-slot admission has no slot to spare for background work unless asked explicitly.
  if (!Object.hasOwn(options, 'maxBackgroundActive') && Number.isSafeInteger(config.maxActive)) {
    config.maxBackgroundActive = Math.min(config.maxBackgroundActive, Math.max(0, config.maxActive - 1));
  }
  const maxActive = positiveInteger(config.maxActive, 'maxActive');
  const budget = positiveInteger(config.memoryBudgetBytes, 'memoryBudgetBytes');
  const maxQueued = positiveInteger(config.maxQueued, 'maxQueued', { allowZero: true });
  const queueTimeoutMs = positiveInteger(config.queueTimeoutMs, 'queueTimeoutMs');
  const maxBackgroundActive = positiveInteger(config.maxBackgroundActive, 'maxBackgroundActive', { allowZero: true });
  const maxBackgroundQueued = positiveInteger(config.maxBackgroundQueued, 'maxBackgroundQueued', { allowZero: true });
  const backgroundQueueTimeoutMs = positiveInteger(config.backgroundQueueTimeoutMs, 'backgroundQueueTimeoutMs');
  const foregroundReserveBytes = positiveInteger(config.foregroundReserveBytes, 'foregroundReserveBytes', { allowZero: true });
  const maxDecoderActive = positiveInteger(config.maxDecoderActive, 'maxDecoderActive');
  // Background work must always leave one slot and the reserve to the foreground.
  if (maxBackgroundActive >= maxActive) throw new TypeError('maxBackgroundActive must be below maxActive.');
  if (maxBackgroundActive > 0 && foregroundReserveBytes >= budget) {
    throw new TypeError('foregroundReserveBytes must leave budget for background work.');
  }

  let active = 0;
  let activeBackground = 0;
  let activeDecoder = 0;
  let reservedBytes = 0;
  // Bounded by maxQueued + maxBackgroundQueued; entries are removed the moment they settle.
  const queue = [];
  let queuedForeground = 0;
  let queuedBackground = 0;

  function fits(entry) {
    if (active >= maxActive || reservedBytes + entry.weight > budget) return false;
    if (entry.decoder && activeDecoder >= maxDecoderActive) return false;
    if (entry.lane === 'foreground') return true;
    return queuedForeground === 0
      && activeBackground < maxBackgroundActive
      && active + 1 < maxActive
      // Background decoder work also leaves a decoder slot to the foreground.
      && (!entry.decoder || activeDecoder + 1 < maxDecoderActive)
      && reservedBytes + entry.weight <= budget - foregroundReserveBytes;
  }

  function unqueue(entry) {
    const index = queue.indexOf(entry);
    if (index === -1) return false;
    queue.splice(index, 1);
    if (entry.lane === 'foreground') queuedForeground -= 1;
    else queuedBackground -= 1;
    return true;
  }

  function settleWaiting(entry) {
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    entry.timer = null;
    entry.onAbort = null;
  }

  function grant(entry) {
    active += 1;
    reservedBytes += entry.weight;
    if (entry.lane === 'background') activeBackground += 1;
    if (entry.decoder) activeDecoder += 1;
    let released = false;
    entry.resolve(() => {
      if (released) return;
      released = true;
      active -= 1;
      reservedBytes -= entry.weight;
      if (entry.lane === 'background') activeBackground -= 1;
      if (entry.decoder) activeDecoder -= 1;
      pump();
    });
  }

  function pump() {
    for (let index = 0; index < queue.length;) {
      const entry = queue[index];
      if (fits(entry)) {
        unqueue(entry);
        settleWaiting(entry);
        grant(entry);
        // Admitting can change what fits for entries already passed; restart from the head.
        index = 0;
        continue;
      }
      // The foreground head is never overtaken by later foreground work. Background entries
      // that do not fit are passed over; they never hold up anything behind them.
      if (entry.lane === 'foreground') break;
      index += 1;
    }
  }

  // Resolves with a release function once admitted.
  function acquire({ lane, weight, decoder, signal, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const entry = { lane, weight, decoder, signal, resolve, timer: null, onAbort: null };
      const fail = (error) => {
        if (!unqueue(entry)) return;
        settleWaiting(entry);
        reject(error);
        // A removed head may let others proceed.
        pump();
      };
      queue.push(entry);
      if (lane === 'foreground') queuedForeground += 1;
      else queuedBackground += 1;
      pump();
      if (!queue.includes(entry)) return;
      const limit = lane === 'foreground' ? maxQueued : maxBackgroundQueued;
      if ((lane === 'foreground' ? queuedForeground : queuedBackground) > limit) {
        fail(queueFull());
        return;
      }
      entry.onAbort = () => fail(cancelledError());
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      entry.timer = setTimeout(() => fail(timedOut()), timeoutMs);
    });
  }

  /**
   * Run `task` once admitted. The admission is released when the task settles (fulfilled or
   * rejected, including a synchronous throw); the task's result or error is passed through.
   *
   * @template T
   * @param {() => Promise<T>|T} task - opens its own resources only after it is called.
   * @param {{ signal?: AbortSignal, lane?: 'foreground'|'background', weightBytes: number,
   *   decoder?: boolean, queueTimeoutMs?: number }} options - decoder: the task runs a 7-Zip WASM
   *   decoder (counted against maxDecoderActive); queueTimeoutMs can only shorten the lane's wait bound.
   * @returns {Promise<T>}
   */
  async function run(task, { signal, lane = 'foreground', weightBytes, decoder = false, queueTimeoutMs: waitMs } = {}) {
    if (typeof task !== 'function') throw new TypeError('run requires a task function.');
    if (lane !== 'foreground' && lane !== 'background') throw new TypeError('Unknown comic admission lane.');
    if (typeof decoder !== 'boolean') throw new TypeError('decoder must be a boolean.');
    positiveInteger(weightBytes, 'weightBytes');
    const laneTimeout = lane === 'foreground' ? queueTimeoutMs : backgroundQueueTimeoutMs;
    const timeoutMs = waitMs === undefined ? laneTimeout : Math.min(positiveInteger(waitMs, 'queueTimeoutMs'), laneTimeout);
    const weight = Math.min(weightBytes, budget);
    if (lane === 'background' && (maxBackgroundActive === 0 || weight > budget - foregroundReserveBytes
      || (decoder && maxDecoderActive < 2))) {
      throw new TypeError('Background work does not fit the comic admission budget.');
    }
    if (signal?.aborted) throw cancelledError();

    const release = await acquire({ lane, weight, decoder, signal, timeoutMs });
    try {
      // Cancelled between admission and start: never begin the work.
      if (signal?.aborted) throw cancelledError();
      return await task();
    } finally {
      release();
    }
  }

  return Object.freeze({
    run,
    limits: Object.freeze({
      maxActive, memoryBudgetBytes: budget, maxDecoderActive, maxQueued, queueTimeoutMs, maxBackgroundActive,
      maxBackgroundQueued, backgroundQueueTimeoutMs, foregroundReserveBytes,
    }),
    /** Counters for diagnostics and tests; holds no request objects. */
    snapshot: () => Object.freeze({ active, activeBackground, reservedBytes, queued: queuedForeground, queuedBackground }),
  });
}
