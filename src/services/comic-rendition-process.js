// One disposable child per admitted comic page or shared derivative. Children receive only bounded
// image bytes and numeric limits, never archive paths, descriptors or authority. The runtime
// owns this supervisor; a single preloaded IPC spare can be claimed by an admitted reader job.
//
// Parent deadlines cover startup, transfers, native work and final validation. Cancellation,
// deadline, closure and protocol failures kill the child. Admission is held until its close
// event confirms exit; a successful kill() call alone never proves native work stopped. The
// child also watches parent disconnect and its own watchdog. A spare has no job or image data,
// and close() retires it along with active jobs before resolving.
//
// Shared derivatives use the accepted reader IPC transport and ordinary image policy
// and independent bounded decode validation after a clean exit. IPC allocates before message
// validation: this trusts the bundled child and does not impose a compromised-child quota or
// an OS memory ceiling.

import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { projectImageGeneratedOutput } from './project-image-policy.js';

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

// The child receives the ordinary effective policy, bounded by the existing settings domain.
export function validComicDerivativePolicy(kind, policy) {
  if (!['thumbnail', 'preview'].includes(kind) || !isPlainObject(policy)
    || !hasExactKeys(policy, ['thumbnail', 'preview'])) return false;
  return ['thumbnail', 'preview'].every((key) => {
    const value = policy[key];
    const range = key === 'thumbnail' ? [64, 512] : [320, 2560];
    return isPlainObject(value) && hasExactKeys(value, ['format', 'maxDimension', 'webpQuality'])
      && (key === 'thumbnail' ? ['webp', 'png'] : ['webp', 'png', 'original']).includes(value.format)
      && Number.isSafeInteger(value.maxDimension)
      && value.maxDimension >= range[0] && value.maxDimension <= range[1]
      && positiveInteger(value.webpQuality) && value.webpQuality <= 95;
  });
}

async function validateDerivativeBytes(result, job) {
  const invalid = () => failure('PROTOCOL_ERROR', 'Invalid shared derivative image.');
  const bytes = result.buffer;
  const format = projectImageGeneratedOutput(job.policy, false)[job.kind].format;
  if (format === 'webp') {
    if (bytes.length < 20 || bytes.toString('latin1', 0, 4) !== 'RIFF'
      || bytes.toString('latin1', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) !== bytes.length - 8) throw invalid();
  } else {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw invalid();
    let end = false;
    for (let offset = 8; offset < bytes.length;) {
      if (offset + 12 > bytes.length || end) throw invalid();
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString('latin1', offset + 4, offset + 8);
      if (!['IHDR', 'PLTE', 'tRNS', 'pHYs', 'IDAT', 'IEND'].includes(type)
        || offset + 12 + length > bytes.length) throw invalid();
      end = type === 'IEND';
      if (end && length !== 0) throw invalid();
      offset += 12 + length;
    }
    if (!end) throw invalid();
  }
  try {
    const options = { failOn: 'warning', limitInputPixels: job.limits.maxPixels, pages: 1 };
    const metadata = await sharp(bytes, options).metadata();
    if (metadata.format !== format || (metadata.pages ?? 1) !== 1
      || metadata.width !== result.width || metadata.height !== result.height
      || metadata.orientation !== undefined || metadata.exif || metadata.icc || metadata.xmp) throw invalid();
    await sharp(bytes, options).timeout({ seconds: 1 }).stats();
  } catch { throw invalid(); }
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
  const derivative = job.purpose === 'image-derivative';
  if (job.purpose !== undefined && !derivative) throw new TypeError('Unknown rendition purpose.');
  if (derivative && (!withinPixels(image.width, image.height, Math.min(maxInputPixels, 100_000_000))
    || maxInputPixels > 100_000_000 || Math.max(image.width, image.height) > 65_535 || limits.timeoutSeconds > 30)) {
    throw failure('INPUT_LIMIT_EXCEEDED', 'Derivative input exceeds the reader bounds.');
  }
  if (derivative && (!hasExactKeys(job, ['purpose', 'bytes', 'image', 'maxInputPixels', 'limits', 'kind', 'policy'])
    || !validComicDerivativePolicy(job.kind, job.policy)
    || limits.maxPixels > 25_000_000 || limits.maxWebpDimension > 16_383)) {
    throw new TypeError('Invalid shared derivative job.');
  }
  return {
    ...(derivative ? { purpose: job.purpose, jobId: randomUUID() } : {}),
    ...(derivative ? { kind: job.kind, policy: { thumbnail: { ...job.policy.thumbnail }, preview: { ...job.policy.preview } } } : {}),
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
  if (job.purpose === 'image-derivative') return acceptDerivativeResult(message, job);
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
  // The parent enforces the job's pixel bound itself; a child's claim to have downscaled
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

function acceptDerivativeResult(message, job) {
  const invalid = () => failure('PROTOCOL_ERROR', 'Invalid shared derivative result.');
  const output = projectImageGeneratedOutput(job.policy, false)[job.kind];
  const identity = ['type', 'purpose', 'jobId', 'ok'];
  if (message.purpose !== job.purpose || message.jobId !== job.jobId) throw invalid();
  if (message.ok === false) {
    if (!hasExactKeys(message, [...identity, 'code'], ['detail'])
      || !COMIC_RENDITION_PROTOCOL.childFailureCodes.includes(message.code)
      || (message.detail !== undefined && (typeof message.detail !== 'string'
        || message.detail.length > COMIC_RENDITION_PROTOCOL.maxDetailLength))) throw invalid();
    throw failure(message.code, 'Shared derivative encoding failed.');
  }
  if (message.ok !== true || !hasExactKeys(message, [...identity, 'buffer', 'width', 'height',
    'animated', 'frameCount', 'format', 'filename'])) throw invalid();
  const buffer = asBuffer(message.buffer);
  if (!buffer || buffer.length === 0) throw invalid();
  if (buffer.length > job.limits.maxOutputBytes) throw failure('OUTPUT_LIMIT_EXCEEDED', 'Derivative output exceeds its byte limit.');
  if (message.format !== output.format || message.filename !== `${job.kind}.${output.format}`
    || message.animated !== false || message.frameCount !== 1
    || (message.format === 'webp' && Math.max(message.width, message.height) > job.limits.maxWebpDimension)
    || !withinPixels(message.width, message.height, job.limits.maxPixels)) throw invalid();
  const fits = (width, height) => {
    const scale = Math.min(1, output.maxDimension / Math.max(width, height));
    return message.width === Math.max(1, Math.round(width * scale))
      && message.height === Math.max(1, Math.round(height * scale));
  };
  if (!fits(job.image.width, job.image.height) && !fits(job.image.height, job.image.width)) throw invalid();
  return { buffer, width: message.width, height: message.height, animated: false, frameCount: 1,
    format: message.format, filename: message.filename };
}

// An idle spare must become ready before it can be claimed.
const SPARE_READY_TIMEOUT_MS = 30_000;
// Exhausted retries disable the spare; cold children remain available.
const SPARE_RETRY_DELAYS_MS = Object.freeze([1_000, 10_000]);
const SPARE_ENV = 'CREATORCRATE_RENDITION_SPARE';

function nonNegativeIntegers(value) {
  return Array.isArray(value) && value.every((item) => Number.isSafeInteger(item) && item >= 0);
}

/**
 * @param {object} [options]
 * @param {string} [options.childModule] - test-only: the module launched as the child.
 * @param {string[]} [options.childArgs] - test-only: arguments for that module.
 * @param {object} [options.hooks] - test-only spawned and exited observers.
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

  // At most one unclaimed spare child exists at any time, including one that
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
      if (['NODE_OPTIONS', SPARE_ENV].includes(key.toUpperCase())) delete env[key];
    }
    if (isSpare) env[SPARE_ENV] = '1';
    return env;
  }

  function launch(isSpare) {
    const options = {
      execPath: process.execPath,
      execArgv: [],
      env: childEnvironment(isSpare),
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
      detached: false,
    };
    const child = fork(childModule, childArgs, options);
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
        if (message.purpose && acceptedResult) verdict = { error };
        decide({ error });
        terminate();
      };
      const onAbort = () => fail(failure('CANCELLED', 'The rendition was cancelled.'));
      entry.stop = () => fail(failure('CLOSED', 'Comic renditions are shut down.'));

      const finish = async () => {
        if (phase === 'done') return;
        phase = 'done';
        if (message.purpose === 'image-derivative' && verdict?.value) {
          try {
            if (exitInfo?.code !== 0 || exitInfo?.signal) throw failure('CHILD_EXITED', 'Derivative child did not exit successfully.');
            await validateDerivativeBytes(verdict.value, message);
          } catch (error) { verdict = { error }; }
        }
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        jobs.delete(entry);
        if (child) {
          child.stdout?.removeAllListeners();
          child.stdin?.removeAllListeners();
          child.stdout?.on('error', () => {});
          child.stdin?.on('error', () => {});
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
          const sent = (err) => {
            if (err) fail(failure('IPC_FAILED', 'The rendition job could not be sent.', { cause: err }));
          };
          child.send(message, sent);
        } catch (err) {
          fail(failure('IPC_FAILED', 'The rendition job could not be sent.', { cause: err }));
        }
      };

      const onMessage = (received) => {
        if (phase === 'done') return;
        if (phase === 'finishing') {
          // A message after the terminal result: the result is not accepted.
          if (acceptedResult) {
            verdict = { error: failure('PROTOCOL_ERROR', 'The rendition child sent more than one result.') };
            if (message.purpose) terminate();
          }
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
            fail(err);
            return;
          }
          if (!message.purpose || verdict.error !== undefined) terminate();
          else phase = 'finishing';
          return;
        }
        fail(failure('PROTOCOL_ERROR', 'Unexpected rendition message.'));
      };

      // A ready spare already reported a valid ready message; it gets the job at once.
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
        // A clean exit can precede queued IPC delivery; keep the protocol live until close.
        if ((code !== 0 || exitSignal) && (phase === 'starting' || phase === 'running')) {
          decide({ error: failure(phase === 'starting' ? 'STARTUP_FAILED' : 'CHILD_EXITED',
            'The rendition child exited without a result.', { cause: exitInfo }) });
          phase = 'finishing';
        }
      });
      // Exit observed and IPC/stdio closed: the only confirmation the child is gone.
      child.on('close', (code, exitSignal) => {
        exitInfo ??= { code, signal: exitSignal };
        if (phase === 'starting' || phase === 'running') {
          decide({ error: failure(phase === 'starting' ? 'STARTUP_FAILED' : 'CHILD_EXITED',
            'The rendition child exited without a result.', { cause: exitInfo }) });
        }
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
    if (message.purpose === 'image-derivative' && deadline > message.limits.timeoutSeconds * 1000) {
      throw new TypeError('Derivative deadline exceeds the native execution bound.');
    }
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
