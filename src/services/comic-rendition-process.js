// Milestone A F1a — Process-isolated comic page rendition (parent side)
//
// Sharp 0.35.3 cannot interrupt a native operation already handed to libvips (metadata(),
// stats() or a conversion), its `timeout` covers only the output pipeline, and terminating a
// worker thread waits for the running native work. So every comic page rendition runs in its
// own disposable Node.js child process (comic-rendition-child.js), which can be terminated at
// any moment. This module is the only owner of those children.
//
// Contract
// --------
//   - One child per rendition job. It is launched directly with the installed Node executable
//     (no shell, no inherited execArgv or NODE_OPTIONS, not detached, hidden on Windows, no
//     stdio besides the IPC channel) from a fixed module path. It receives only image bytes and
//     numeric bounds: no path, no descriptor, no database, no archive and no authority. It
//     launches nothing.
//   - Protocol (advanced IPC serialization, protocol version 1):
//       child  -> parent  { type: 'ready', v }                      once, after it listens
//       parent -> child   { type: 'job', v, bytes, image, maxInputPixels, limits }   once
//       child  -> parent  { type: 'phase', phase }                  metadata, stats, convert
//       child  -> parent  { type: 'result', ok: true, unchanged: true, mimeType, width, height }
//                       | { type: 'result', ok: true, unchanged: false, bytes, mimeType, width, height }
//                       | { type: 'result', ok: false, code, detail? }   exactly one, terminal
//     Every message is validated (shape, keys, types, bounds, order). Anything else, a second
//     terminal message, a message after the terminal one, an exit without one, a startup or IPC
//     failure, and an output over the job's byte bound fail the job; a partial result is never
//     accepted. Input is bounded before it is sent and output both by the child before sending
//     and by the parent after receiving: the parent checks a result's bytes, MIME type and
//     dimensions (positive safe integers within limits.maxPixels and the source area) itself.
//   - The job settles only after the child is confirmed gone: its 'close' event (process exit
//     observed by the OS watcher, and IPC and stdio closed). child.killed or a true kill() is
//     never taken as proof. On cancellation, deadline, shutdown or any failure the child is
//     killed (SIGKILL; TerminateProcess on Windows) and the job still waits for that
//     confirmation. Callers hold their comic admission until the job settles, so admission is
//     released only after the native work has stopped. If the operating system never reports
//     the exit, the job (and that admission) stays held rather than reporting a cleanup that did
//     not happen; snapshot().terminating shows it.
//   - Deadline: owned by the parent and measured on the monotonic clock from before the launch.
//     It covers startup, input transfer, metadata, stats, conversion, result transfer and the
//     final acceptance after exit; a result received or accepted after it is never a success,
//     even if the timer callback runs late.
//   - Orphans: the child kills itself when its IPC channel disconnects (parent exit or crash)
//     and after its own watchdog (the job's deadline plus a margin).
//
// Preloaded spare (F1b)
// ---------------------
//   - preload() (called only by the application's comic runtime) keeps at most ONE idle spare
//     child: launched ahead of need, it loads Node and Sharp, reports a valid ready message and
//     then waits. It receives nothing (no page bytes, no job) and processes nothing while idle,
//     and it never keeps the application alive (its handle and channel are unreferenced; it
//     exits by itself when the parent's end of the channel goes away).
//   - Only an admitted job claims it, synchronously inside run() (after the job's deadline has
//     started), and only once it is ready: ownership moves to that job, which sends its one job
//     at once. From then on it is an ordinary job child: one job, the same deadline,
//     cancellation, validation and kill-then-confirm rules, never reused. A job that finds no
//     ready spare launches a cold child at once and never waits for a spare.
//   - A claim schedules the next spare (setImmediate). A new spare is launched only while no
//     unclaimed spare exists, including one still being retired, so at most one idle spare
//     process exists at any time and nothing grows into a pool.
//   - A spare that sends anything but one valid ready message, errors, disconnects, exits or is
//     not ready within its own startup timeout is killed, confirmed gone and never claimed.
//     Failures since the last claim are retried after SPARE_RETRY_DELAYS_MS; when those are used
//     up the spare stays disabled for this supervisor and every job uses a cold child.
//   - close() stops replenishment at once, kills the idle spare along with the active children
//     and resolves only after each is confirmed gone.
//
// Ownership: the application's comic runtime owns one supervisor for the process lifetime
// (comic-runtime.js), shared by every app graph; close() refuses new jobs at once, kills the
// active children and resolves after every one of them is confirmed gone. Code without a runtime
// (direct createApp callers, tests) uses one lazily created process-wide default supervisor, so
// no graph or request ever owns children of its own; that supervisor never preloads a spare.

import { fork } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const MIB = 1024 * 1024;

export const COMIC_RENDITION_PROTOCOL = Object.freeze({
  version: 1,
  // Under the readers' 64 MiB member limit and the 32 MiB rendition output limit.
  maxInputBytes: 64 * MIB,
  maxOutputBytes: 32 * MIB,
  phases: Object.freeze(['metadata', 'stats', 'convert']),
  formats: Object.freeze(['jpeg', 'png', 'webp', 'gif']),
  // Failures the child itself may report.
  childFailureCodes: Object.freeze(['PAGE_INVALID_IMAGE', 'RENDITION_LIMIT_EXCEEDED', 'JOB_INVALID', 'INTERNAL']),
  maxDetailLength: 200,
  // The child's own watchdog fires this long after the job's deadline.
  watchdogMarginMs: 5_000,
});

// Delivered MIME type per source format: unchanged pages keep their type; a converted GIF
// (animated, or too large) becomes a lossless PNG still.
export const COMIC_RENDITION_MIME = Object.freeze({
  unchanged: Object.freeze({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }),
  converted: Object.freeze({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/png' }),
});

const CHILD_MODULE = fileURLToPath(new URL('./comic-rendition-child.js', import.meta.url));

export class ComicRenditionProcessError extends Error {
  /**
   * @param {'CANCELLED'|'TIMEOUT'|'CLOSED'|'STARTUP_FAILED'|'CHILD_EXITED'|'PROTOCOL_ERROR'|
   *   'IPC_FAILED'|'INPUT_LIMIT_EXCEEDED'|'OUTPUT_LIMIT_EXCEEDED'|'PAGE_INVALID_IMAGE'|
   *   'RENDITION_LIMIT_EXCEEDED'|'JOB_INVALID'|'INTERNAL'} code
   */
  constructor(code, message, { cause, detail } = {}) {
    super(message);
    this.name = 'ComicRenditionProcessError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
    if (cause !== undefined) this.cause = cause;
  }
}

const failure = (code, message, extra) => new ComicRenditionProcessError(code, message, extra);

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

// width × height ≤ maxPixels for positive safe integers, without forming the product (so no
// precision loss or overflow can make an oversized pair look in bounds).
function withinPixels(width, height, maxPixels) {
  return positiveInteger(width) && positiveInteger(height) && positiveInteger(maxPixels)
    && width <= Math.floor(maxPixels / height);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, required, optional = []) {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** Validates a job before anything is launched; returns the normalized message to send. */
function jobMessage(job) {
  if (!isPlainObject(job)) throw new TypeError('A comic rendition job is required.');
  const bytes = asBuffer(job.bytes);
  if (!bytes || bytes.length === 0) throw new TypeError('A comic rendition job requires image bytes.');
  if (bytes.length > COMIC_RENDITION_PROTOCOL.maxInputBytes) {
    throw failure('INPUT_LIMIT_EXCEEDED', 'The page is larger than a rendition accepts.');
  }
  const { image, limits, maxInputPixels } = job;
  if (!isPlainObject(image) || !COMIC_RENDITION_PROTOCOL.formats.includes(image.format)
    || !positiveInteger(image.width) || !positiveInteger(image.height) || typeof image.animated !== 'boolean') {
    throw new TypeError('A comic rendition job requires the inspected image header.');
  }
  if (!positiveInteger(maxInputPixels)) throw new TypeError('A comic rendition job requires maxInputPixels.');
  if (!isPlainObject(limits)) throw new TypeError('A comic rendition job requires limits.');
  for (const key of ['maxPixels', 'maxOutputBytes', 'maxWebpDimension', 'timeoutSeconds']) {
    if (!positiveInteger(limits[key])) throw new TypeError(`Invalid comic rendition limit: ${key}`);
  }
  if (limits.maxOutputBytes > COMIC_RENDITION_PROTOCOL.maxOutputBytes) {
    throw new TypeError('maxOutputBytes is above the rendition protocol bound.');
  }
  return {
    type: 'job',
    v: COMIC_RENDITION_PROTOCOL.version,
    bytes,
    image: { format: image.format, width: image.width, height: image.height, animated: image.animated },
    maxInputPixels,
    limits: {
      maxPixels: limits.maxPixels,
      maxOutputBytes: limits.maxOutputBytes,
      maxWebpDimension: limits.maxWebpDimension,
      timeoutSeconds: limits.timeoutSeconds,
    },
  };
}

/**
 * Validates a terminal 'result' message against the job it answers. Returns the accepted
 * result or throws a ComicRenditionProcessError (protocol error, child-reported failure or
 * oversized output). Never returns a partial result.
 */
function acceptResult(message, job) {
  const protocolError = (why) => failure('PROTOCOL_ERROR', `Invalid rendition result: ${why}.`);
  if (message.ok === false) {
    if (!hasExactKeys(message, ['type', 'ok', 'code'], ['detail'])
      || !COMIC_RENDITION_PROTOCOL.childFailureCodes.includes(message.code)
      || (message.detail !== undefined && (typeof message.detail !== 'string'
        || message.detail.length > COMIC_RENDITION_PROTOCOL.maxDetailLength))) {
      throw protocolError('malformed failure');
    }
    throw failure(message.code, 'The rendition child reported a failure.', {
      ...(message.detail !== undefined ? { detail: message.detail } : {}),
    });
  }
  if (message.ok !== true || typeof message.unchanged !== 'boolean') throw protocolError('malformed success');
  const { image, limits } = job;
  const { width, height } = message;
  if (!positiveInteger(width) || !positiveInteger(height)) throw protocolError('dimensions');
  if (message.unchanged) {
    if (!hasExactKeys(message, ['type', 'ok', 'unchanged', 'mimeType', 'width', 'height'])) {
      throw protocolError('unchanged keys');
    }
    // Only a static page within every bound may be returned as the bytes the parent holds.
    const sameSize = (width === image.width && height === image.height) || (width === image.height && height === image.width);
    if (image.animated || !sameSize || width * height > limits.maxPixels
      || job.bytes.length > limits.maxOutputBytes
      || message.mimeType !== COMIC_RENDITION_MIME.unchanged[image.format]) {
      throw protocolError('unchanged page outside its bounds');
    }
    return { unchanged: true, mimeType: message.mimeType, width, height };
  }
  if (!hasExactKeys(message, ['type', 'ok', 'unchanged', 'bytes', 'mimeType', 'width', 'height'])) {
    throw protocolError('converted keys');
  }
  const bytes = asBuffer(message.bytes);
  if (!bytes || bytes.length === 0) throw protocolError('converted bytes');
  if (bytes.length > limits.maxOutputBytes) {
    throw failure('OUTPUT_LIMIT_EXCEEDED', 'The rendition is larger than allowed.');
  }
  // P3-A: the parent enforces the job's pixel bound itself; a child's claim to have downscaled
  // is not trusted. The source-area bound below still applies on top of it.
  if (!withinPixels(width, height, limits.maxPixels)) {
    throw protocolError('converted page over the pixel limit');
  }
  if (message.mimeType !== COMIC_RENDITION_MIME.converted[image.format]
    || width * height > image.width * image.height
    || (message.mimeType === 'image/webp' && Math.max(width, height) > limits.maxWebpDimension)) {
    throw protocolError('converted page outside its bounds');
  }
  return { unchanged: false, bytes, mimeType: message.mimeType, width, height };
}

// F1b: an idle spare is retired as failed if it is not ready within this long.
const SPARE_READY_TIMEOUT_MS = 30_000;
// F1b: delays before relaunching after consecutive spare failures; once they are used up the
// spare stays disabled for this supervisor (cold children remain available).
const SPARE_RETRY_DELAYS_MS = Object.freeze([1_000, 10_000]);
// Marks a spare child (no pre-job watchdog: it may stay idle for the application's lifetime).
const SPARE_ENV = 'CREATORCRATE_RENDITION_SPARE';

function nonNegativeIntegers(value) {
  return Array.isArray(value) && value.every((item) => Number.isSafeInteger(item) && item >= 0);
}

/**
 * @param {object} [options]
 * @param {string} [options.childModule] - test-only: the module launched as the child.
 * @param {string[]} [options.childArgs] - test-only: arguments for that module.
 * @param {object} [options.hooks] - test-only observers: { spawned({ pid, spare }), exited({ pid, code, signal }) }.
 * @param {number} [options.spareReadyTimeoutMs] - test-only: how long a spare may take to be ready.
 * @param {number[]} [options.spareRetryDelaysMs] - test-only: relaunch delays after spare failures.
 */
export function createComicRenditionSupervisor({
  childModule = CHILD_MODULE, childArgs = [], hooks = {},
  spareReadyTimeoutMs = SPARE_READY_TIMEOUT_MS, spareRetryDelaysMs = SPARE_RETRY_DELAYS_MS,
} = {}) {
  if (typeof childModule !== 'string' || !Array.isArray(childArgs) || !childArgs.every((arg) => typeof arg === 'string')
    || !positiveInteger(spareReadyTimeoutMs) || !nonNegativeIntegers(spareRetryDelaysMs)) {
    throw new TypeError('Invalid comic rendition supervisor options.');
  }
  const retryDelays = Object.freeze([...spareRetryDelaysMs]);
  const jobs = new Set();
  let state = 'open';
  let closing = null;
  let launched = 0;
  let exited = 0;

  // F1b spare state. At most one unclaimed spare child exists at any time, including one that
  // is being retired: `spare` is cleared only when it is claimed or confirmed gone, and a new one
  // is launched only while `spare` is null.
  let spareEnabled = false;
  let spare = null;
  let spareRetry = null; // pending relaunch timer
  let spareFailures = 0; // consecutive
  let spareDisabled = false;
  let spareLaunched = 0;
  let spareClaimed = 0;
  let spareFailed = 0;

  function childEnvironment(isSpare) {
    const env = { ...process.env };
    // No preloads or flags reach the child (NODE_OPTIONS may carry --require/--import).
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'NODE_OPTIONS' || key.toUpperCase() === SPARE_ENV) delete env[key];
    }
    if (isSpare) env[SPARE_ENV] = '1';
    return env;
  }

  function launch(isSpare) {
    const child = fork(childModule, childArgs, {
      execPath: process.execPath,
      execArgv: [],
      env: childEnvironment(isSpare),
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
      detached: false,
    });
    launched += 1;
    if (child.pid !== undefined) {
      try {
        hooks.spawned?.({ pid: child.pid, spare: isSpare });
      } catch {
        // Observers never change the outcome.
      }
    }
    return child;
  }

  function observeExit(pid, exitInfo) {
    exited += 1;
    try {
      hooks.exited?.({ pid, code: exitInfo?.code ?? null, signal: exitInfo?.signal ?? null });
    } catch {
      // Observers never change the outcome.
    }
  }

  // ─── Spare (F1b) ──────────────────────────────────────────────────────────────────────

  function scheduleSpare(delayMs) {
    if (!spareEnabled || spareDisabled || state !== 'open' || spare || spareRetry) return;
    spareRetry = setTimeout(() => {
      spareRetry = null;
      launchSpare();
    }, delayMs);
    spareRetry.unref?.();
  }

  function spareFailure() {
    spareFailed += 1;
    spareFailures += 1;
    if (spareFailures > retryDelays.length) {
      spareDisabled = true;
      return;
    }
    scheduleSpare(retryDelays[spareFailures - 1]);
  }

  /**
   * Launch the one idle spare. It loads Node and Sharp, reports ready and then waits; it is
   * sent nothing until an admitted job claims it. Any deviation (an invalid or late ready
   * message, an error, a disconnect or an exit before it is claimed) retires it as a failure:
   * a failed spare is never claimed.
   */
  function launchSpare() {
    if (!spareEnabled || spareDisabled || state !== 'open' || spare) return;
    let child;
    try {
      child = launch(true);
    } catch {
      spareFailure();
      return;
    }
    spareLaunched += 1;
    const record = {
      child,
      pid: child.pid ?? null,
      ready: false,
      retiring: false,
      failed: false,
      gone: false,
      exitInfo: null,
      readyTimer: null,
      settled: null,
      handlers: null,
    };
    let confirmGone;
    record.settled = new Promise((resolve) => { confirmGone = resolve; });

    const retire = (failed) => {
      if (record.gone) return;
      if (failed && !record.failed) record.failed = true;
      clearTimeout(record.readyTimer);
      if (record.retiring) return;
      record.retiring = true;
      if (record.exitInfo) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // Confirmation still comes only from 'close'.
      }
    };
    const gone = () => {
      if (record.gone) return;
      record.gone = true;
      clearTimeout(record.readyTimer);
      child.removeAllListeners();
      child.on('error', () => {});
      if (record.pid !== null) observeExit(record.pid, record.exitInfo);
      if (spare === record) spare = null;
      confirmGone();
      // Unless close() stopped it, an unclaimed spare only ever ends as a failure.
      if (state === 'open' && spareEnabled) spareFailure();
    };
    record.handlers = {
      message(received) {
        if (record.retiring) return;
        if (!record.ready && isPlainObject(received) && received.type === 'ready'
          && hasExactKeys(received, ['type', 'v']) && received.v === COMIC_RENDITION_PROTOCOL.version) {
          record.ready = true;
          clearTimeout(record.readyTimer);
          return;
        }
        // Malformed, wrong version, a second ready or anything else from an idle child.
        retire(true);
      },
      error() {
        if (child.pid === undefined) {
          record.failed = true;
          gone();
          return;
        }
        retire(true);
      },
      disconnect() {
        retire(true);
      },
      exit(code, signal) {
        record.exitInfo = { code, signal };
        if (!record.retiring) retire(true);
      },
      close(code, signal) {
        record.exitInfo ??= { code, signal };
        gone();
      },
    };
    for (const [event, handler] of Object.entries(record.handlers)) child.on(event, handler);
    // An idle spare never keeps the application alive; the child exits on its own when the
    // parent's end of the channel goes away.
    child.unref();
    child.channel?.unref?.();
    record.readyTimer = setTimeout(() => retire(true), spareReadyTimeoutMs);
    record.readyTimer.unref?.();
    spare = record;
  }

  /**
   * Hand the ready spare to an admitted job, or null when none is ready (the job then launches
   * a cold child). Synchronous: no message can be delivered between the check and the transfer.
   */
  function claimSpare() {
    const record = spare;
    if (!record || !record.ready || record.retiring || record.gone || record.exitInfo) return null;
    const { child } = record;
    if (!child.connected || child.exitCode !== null || child.signalCode !== null) return null;
    spare = null;
    clearTimeout(record.readyTimer);
    for (const [event, handler] of Object.entries(record.handlers)) child.removeListener(event, handler);
    child.ref();
    child.channel?.ref?.();
    spareClaimed += 1;
    // Only a spare that reached a job ends a run of failures: one that becomes ready and then
    // dies while idle keeps counting, so it cannot relaunch forever.
    spareFailures = 0;
    // Replenish after this job has its child: never more than one idle spare.
    setImmediate(launchSpare);
    return child;
  }

  // ─── Jobs ─────────────────────────────────────────────────────────────────────────────

  function execute(message, { signal, deadlineMs, onPhase }, startedAt) {
    const expired = () => performance.now() - startedAt > deadlineMs;
    const entry = { pid: null, stop: null, terminating: false, settled: null, spare: false };

    const promise = new Promise((resolve, reject) => {
      let child = null;
      let phase = 'starting'; // starting -> running -> finishing -> done
      let verdict = null; // { value } | { error }: the first decided outcome
      let acceptedResult = false;
      let timer = null;
      let exitInfo = null;
      let phasesSeen = 0;

      const decide = (outcome) => {
        if (verdict === null) verdict = outcome;
      };
      const terminate = () => {
        if (phase !== 'done') phase = 'finishing';
        if (!child || exitInfo || entry.terminating) return;
        entry.terminating = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // Confirmation still comes only from 'close'.
        }
      };
      const fail = (error) => {
        decide({ error });
        terminate();
      };
      const onAbort = () => fail(failure('CANCELLED', 'The rendition was cancelled.'));
      entry.stop = () => fail(failure('CLOSED', 'Comic renditions are shut down.'));

      const finish = () => {
        if (phase === 'done') return;
        phase = 'done';
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        jobs.delete(entry);
        if (child) {
          child.removeAllListeners();
          child.on('error', () => {});
          observeExit(entry.pid, exitInfo);
        }
        if (verdict === null) {
          decide({ error: failure('CHILD_EXITED', 'The rendition child exited without a result.', { cause: exitInfo }) });
        }
        // Final acceptance: after the deadline or a cancellation, nothing is a success.
        if (verdict.error === undefined) {
          if (expired()) verdict = { error: failure('TIMEOUT', 'The rendition deadline passed.') };
          else if (signal?.aborted) verdict = { error: failure('CANCELLED', 'The rendition was cancelled.') };
        }
        if (verdict.error !== undefined) reject(verdict.error);
        else resolve(verdict.value);
      };

      const sendJob = () => {
        phase = 'running';
        try {
          child.send(message, (err) => {
            if (err) fail(failure('IPC_FAILED', 'The rendition job could not be sent.', { cause: err }));
          });
        } catch (err) {
          fail(failure('IPC_FAILED', 'The rendition job could not be sent.', { cause: err }));
        }
      };

      const onMessage = (received) => {
        if (phase === 'done') return;
        if (phase === 'finishing') {
          // A message after the terminal result: the result is not accepted.
          if (acceptedResult) verdict = { error: failure('PROTOCOL_ERROR', 'The rendition child sent more than one result.') };
          return;
        }
        if (!isPlainObject(received) || typeof received.type !== 'string') {
          fail(failure('PROTOCOL_ERROR', 'Invalid rendition message.'));
          return;
        }
        if (received.type === 'ready' && phase === 'starting') {
          if (!hasExactKeys(received, ['type', 'v']) || received.v !== COMIC_RENDITION_PROTOCOL.version) {
            fail(failure('PROTOCOL_ERROR', 'Unexpected rendition protocol.'));
            return;
          }
          sendJob();
          return;
        }
        if (received.type === 'phase' && phase === 'running') {
          const index = COMIC_RENDITION_PROTOCOL.phases.indexOf(received.phase);
          if (!hasExactKeys(received, ['type', 'phase']) || index < phasesSeen) {
            fail(failure('PROTOCOL_ERROR', 'Invalid rendition phase.'));
            return;
          }
          phasesSeen = index + 1;
          try {
            onPhase?.(received.phase);
          } catch {
            // Observers never change the outcome.
          }
          return;
        }
        if (received.type === 'result' && phase === 'running') {
          if (expired()) {
            fail(failure('TIMEOUT', 'The rendition deadline passed.'));
            return;
          }
          try {
            decide({ value: acceptResult(received, message) });
            acceptedResult = true;
          } catch (err) {
            decide({ error: err });
          }
          terminate();
          return;
        }
        fail(failure('PROTOCOL_ERROR', 'Unexpected rendition message.'));
      };

      // F1b: a ready spare already reported a valid ready message; it gets the job at once.
      // Otherwise a cold child is launched and the job is sent when it reports ready.
      child = claimSpare();
      entry.spare = child !== null;
      if (!child) {
        try {
          child = launch(false);
        } catch (err) {
          reject(failure('STARTUP_FAILED', 'The rendition child could not be started.', { cause: err }));
          return;
        }
      }
      entry.pid = child.pid ?? null;
      jobs.add(entry);

      child.on('message', onMessage);
      child.on('error', (err) => {
        // A spawn failure leaves no process to wait for.
        if (child.pid === undefined) {
          decide({ error: failure('STARTUP_FAILED', 'The rendition child could not be started.', { cause: err }) });
          finish();
          return;
        }
        fail(failure(phase === 'starting' ? 'STARTUP_FAILED' : 'IPC_FAILED', 'The rendition child failed.', { cause: err }));
      });
      child.on('disconnect', () => {
        if (phase === 'starting' || phase === 'running') {
          fail(failure(phase === 'starting' ? 'STARTUP_FAILED' : 'CHILD_EXITED',
            'The rendition child closed its channel without a result.'));
        }
      });
      child.on('exit', (code, exitSignal) => {
        exitInfo = { code, signal: exitSignal };
        if (phase === 'starting' || phase === 'running') {
          decide({ error: failure(phase === 'starting' ? 'STARTUP_FAILED' : 'CHILD_EXITED',
            'The rendition child exited without a result.', { cause: exitInfo }) });
          phase = 'finishing';
        }
      });
      // Exit observed and IPC/stdio closed: the only confirmation the child is gone.
      child.on('close', (code, exitSignal) => {
        exitInfo ??= { code, signal: exitSignal };
        finish();
      });

      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      const remaining = Math.max(0, deadlineMs - (performance.now() - startedAt));
      timer = setTimeout(() => fail(failure('TIMEOUT', 'The rendition deadline passed.')), remaining);
      if (state !== 'open') entry.stop();
      else if (entry.spare && phase === 'starting') {
        if (expired()) fail(failure('TIMEOUT', 'The rendition deadline passed.'));
        else sendJob();
      }
    });
    entry.settled = promise.then(() => {}, () => {});
    return promise;
  }

  /**
   * Render one page in a child that processes this job only: the ready spare when there is
   * one, otherwise a fresh child. Resolves with { unchanged: true, mimeType, width, height }
   * (the caller keeps its own bytes) or { unchanged: false, bytes, mimeType, width, height };
   * rejects with a ComicRenditionProcessError. Settles only after the child is confirmed gone.
   *
   * @param {{ bytes: Buffer, image: object, maxInputPixels: number, limits: object }} job
   * @param {{ signal?: AbortSignal, deadlineMs?: number, onPhase?: (phase: string) => void }} [options]
   */
  async function run(job, { signal, deadlineMs, onPhase } = {}) {
    // The deadline is measured from here: before validation, claiming or launching a child.
    const startedAt = performance.now();
    const message = jobMessage(job);
    const deadline = deadlineMs ?? message.limits.timeoutSeconds * 1000;
    if (!positiveInteger(deadline)) throw new TypeError('Invalid rendition deadline.');
    if (state !== 'open') throw failure('CLOSED', 'Comic renditions are shut down.');
    // Already cancelled: no child is started or claimed.
    if (signal?.aborted) throw failure('CANCELLED', 'The rendition was cancelled.');
    return execute(message, { signal, deadlineMs: deadline, onPhase }, startedAt);
  }

  /**
   * F1b: keep one idle, preloaded spare child from now on (the application's comic runtime
   * calls this once it has started). Idempotent; no-op once closing.
   */
  function preload() {
    if (state !== 'open' || spareEnabled) return;
    spareEnabled = true;
    launchSpare();
  }

  /**
   * Refuse new jobs, stop replenishing the spare, kill the spare and the active children and
   * resolve once each is confirmed gone. Idempotent.
   */
  function close() {
    closing ??= (async () => {
      state = 'closing';
      spareEnabled = false;
      clearTimeout(spareRetry);
      spareRetry = null;
      const pending = [...jobs];
      for (const entry of pending) entry.stop();
      const idle = spare;
      if (idle) {
        // The parent keeps waiting for its exit: re-reference it until it is confirmed gone.
        idle.child.ref?.();
        if (!idle.gone && !idle.exitInfo) {
          idle.retiring = true;
          clearTimeout(idle.readyTimer);
          try {
            idle.child.kill('SIGKILL');
          } catch {
            // Confirmation still comes only from 'close'.
          }
        }
      }
      await Promise.all([...pending.map((entry) => entry.settled), ...(idle ? [idle.settled] : [])]);
      state = 'closed';
    })();
    return closing;
  }

  function spareState() {
    if (spare) return spare.retiring ? 'retiring' : spare.ready ? 'ready' : 'starting';
    if (spareDisabled) return 'disabled';
    if (!spareEnabled) return 'off';
    return spareRetry ? 'retrying' : 'none';
  }

  return Object.freeze({
    run,
    preload,
    close,
    get state() {
      return state;
    },
    /** Counters only. */
    snapshot: () => Object.freeze({
      state,
      active: jobs.size,
      terminating: [...jobs].filter((entry) => entry.terminating).length,
      launched,
      exited,
      spare: Object.freeze({
        state: spareState(),
        launched: spareLaunched,
        claimed: spareClaimed,
        failed: spareFailed,
      }),
    }),
  });
}

let defaultSupervisor = null;

/**
 * The process-wide supervisor for code without an application comic runtime (direct createApp
 * callers, tests). Created on first use; it never preloads a spare, and its children are each
 * disposable, so it holds no process while idle.
 */
export function defaultComicRenditionSupervisor() {
  defaultSupervisor ??= createComicRenditionSupervisor();
  return defaultSupervisor;
}
