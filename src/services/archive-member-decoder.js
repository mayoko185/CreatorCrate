// Low-level RAR/7z member decoder built on the vendored, patched 7-Zip 26.06 WASM build.
// Each call runs in a disposable worker thread. The parent decides success: a result is
// accepted only after its own validation, and any latch, error, exit, timeout or
// cancellation discards everything the worker produced.
//
// Worker threads share this process. resourceLimits bound the worker's V8 heap and the
// imported WebAssembly.Memory maximum bounds 7-Zip's linear memory, but neither is a
// process RSS cap. Callers must bound concurrency (see estimateJobMemoryBytes).
import { createHash } from 'node:crypto';
import { fstat, read } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { crc32 } from 'node:zlib';
import {
  ArchiveDecoderError,
  assertSafeMemberPath,
  classifyDecoderDiagnostics,
  interpretListing,
} from './archive-member-listing.js';

export { ArchiveDecoderError };

const ARTIFACT_DIR = new URL('../../vendor/7zip-wasm/', import.meta.url);
const GLUE_PATH = fileURLToPath(new URL('7zz.cjs', ARTIFACT_DIR));
const WASM_PATH = fileURLToPath(new URL('7zz.wasm', ARTIFACT_DIR));
const GLUE_SHA256 = '87c0349a3fd1a541bebcc24b27f0bdea631208e2e4ff33bbd2fa4a8d735457ce';
const WASM_SHA256 = 'ed89509f0dca83dcaa301625ca7c62e92cda8ff8bf52df26b0d868ec7539c941';
const WORKER_URL = new URL('./archive-member-decoder-worker.js', import.meta.url);

const MIB = 1024 * 1024;
const WASM_INITIAL_BYTES = 16 * MIB;
const WASM_CEILING_BYTES = 256 * MIB;
const WORKER_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 48,
  maxYoungGenerationSizeMb: 8,
  codeRangeSizeMb: 16,
  stackSizeMb: 4,
});
// Observed baseline of a decoder worker outside its V8 heap and linear memory
// (isolate, compiled code, glue). An estimate, not a measured bound.
const WORKER_OVERHEAD_BYTES = 40 * MIB;

export const DEFAULT_DECODER_LIMITS = Object.freeze({
  maxInputBytes: 2 * 1024 * MIB,
  maxMemoryBytes: 192 * MIB,
  maxMemberBytes: 64 * MIB,
  maxListingBytes: 4 * MIB,
  maxEntries: 10000,
  maxPathLength: 1024,
  maxLogBytes: 64 * 1024,
  timeoutMs: 30000,
});

const SIGNATURES = [
  { type: 'Rar5', format: 'rar5', family: 'rar', bytes: Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]) },
  { type: 'Rar', format: 'rar4', family: 'rar', bytes: Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]) },
  { type: '7z', format: '7z', family: '7z', bytes: Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) },
];

const WORKER_CODES = new Set([
  'MEMORY_LIMIT_EXCEEDED', 'OUTPUT_LIMIT_EXCEEDED', 'LISTING_LIMIT_EXCEEDED',
  'LOG_LIMIT_EXCEEDED', 'DECODER_FAILED', 'PROTOCOL_ERROR', 'OUTPUT_WRITE_FAILED',
]);

// Batch extraction passes member paths to 7-Zip as callMain arguments, which Emscripten
// copies onto 7-Zip's fixed 64 KiB WASM stack: a 4-byte pointer per argument plus each string
// and its terminator, every allocation rounded to 16 bytes. Measured with this build: `l` and
// `x` on 7z, RAR4 and RAR5 still ran with 48 KiB of arguments and corrupted memory
// (out-of-bounds traps, a hang) from about 52 KiB. A run's whole argument vector, counted as
// the stack actually takes it, is kept within 16 KiB, and the worker returns the stack to its
// resting top after every command so runs never add up. A longer selection is split into
// several runs in archive order. The reserve covers the fixed switches and pointer padding.
export const BATCH_ARGV_BYTES = 16 * 1024;
const BATCH_FIXED_ARGV_RESERVE = 1024;
const ARGV_POINTER_BYTES = 4;
const ARGV_STACK_ALIGN = 16;
const argvStringBytes = (text) => Math.ceil((Buffer.byteLength(text) + 1) / ARGV_STACK_ALIGN) * ARGV_STACK_ALIGN;

function decoderError(code, message, cause) {
  return new ArchiveDecoderError(code, message, { cause });
}

export function resolveDecoderLimits(overrides = {}) {
  const limits = { ...DEFAULT_DECODER_LIMITS };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!(key in limits)) throw decoderError('INVALID_ARGUMENT', 'Unknown decoder limit: ' + key);
    if (!Number.isSafeInteger(value) || value < 1) throw decoderError('INVALID_ARGUMENT', 'Invalid decoder limit: ' + key);
    limits[key] = value;
  }
  if (limits.maxMemoryBytes < WASM_INITIAL_BYTES || limits.maxMemoryBytes > WASM_CEILING_BYTES) {
    throw decoderError('INVALID_ARGUMENT', 'maxMemoryBytes must be between 16 MiB and 256 MiB.');
  }
  return limits;
}

// Rough per-job memory budget for scheduling: linear memory, member buffer (held once in the
// worker and handed over without copying), listing text in both threads, V8 heap and worker
// overhead. Not enforced by the OS; use it to size concurrency, not as a guarantee.
export function estimateJobMemoryBytes(overrides = {}) {
  const limits = resolveDecoderLimits(overrides);
  const heap = (WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb + WORKER_RESOURCE_LIMITS.maxYoungGenerationSizeMb) * MIB;
  return limits.maxMemoryBytes + limits.maxMemberBytes + 3 * limits.maxListingBytes + heap + WORKER_OVERHEAD_BYTES;
}

let runtimePromise = null;

async function verifiedBytes(path, expected) {
  const bytes = await readFile(path);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error('Checksum mismatch for ' + path);
  return bytes;
}

function loadRuntime() {
  runtimePromise ??= (async () => {
    await verifiedBytes(GLUE_PATH, GLUE_SHA256);
    const wasm = await verifiedBytes(WASM_PATH, WASM_SHA256);
    return { wasmModule: await WebAssembly.compile(wasm) };
  })().catch((cause) => {
    runtimePromise = null;
    throw decoderError('DECODER_UNAVAILABLE', 'The bundled archive decoder could not be loaded.', cause);
  });
  return runtimePromise;
}

// Positional reads and fstat through the callback API, so a caller's descriptor is never
// wrapped, moved or closed here.
function readHead(fd, length) {
  return new Promise((resolve, reject) => {
    const buffer = Buffer.alloc(length);
    read(fd, buffer, 0, length, 0, (error, bytesRead) => (error ? reject(error) : resolve({ buffer, bytesRead })));
  });
}

function fstatOf(fd) {
  return new Promise((resolve, reject) => {
    fstat(fd, (error, stat) => (error ? reject(error) : resolve(stat)));
  });
}

async function detectArchiveType(fd, size, format) {
  const { buffer: head, bytesRead } = await readHead(fd, 8);
  const signature = SIGNATURES.find(({ bytes }) => bytesRead >= bytes.length && head.subarray(0, bytes.length).equals(bytes));
  if (!signature || signature.family !== format || size <= signature.bytes.length) {
    throw decoderError('UNSUPPORTED_FORMAT', 'The file is not a ' + format + ' archive.');
  }
  return signature;
}

function toResultEntries(entries) {
  return entries.map((entry) => Object.freeze({ ...entry }));
}

function selectMember(listing, memberPath, limits) {
  const entry = listing.entries.find((candidate) => candidate.path === memberPath);
  if (!entry || entry.type !== 'file') throw decoderError('MEMBER_NOT_FOUND', 'The archive has no such file member.');
  if (entry.size > limits.maxMemberBytes) {
    throw decoderError('MEMBER_LIMIT_EXCEEDED', 'The archive member is larger than allowed.');
  }
  return entry;
}

// 7-Zip prints some stored names differently from how its member selector matches them
// (control characters print as "_"), and selecting a name that matches nothing still exits 0
// with no output. The worker therefore lists the archive again with the exact selector used
// for extraction; it must select exactly the one entry the parent chose. A member whose
// identity cannot be shown this way is refused, whatever its declared size.
function verifySelection(selection, entry, context) {
  if (!(selection?.stdout instanceof Uint8Array) || typeof selection.stderr !== 'string') {
    throw decoderError('PROTOCOL_ERROR', 'The decoder returned an invalid result.');
  }
  const { entries } = interpretListing({
    exitCode: selection.exitCode,
    stdout: new TextDecoder('utf-8', { fatal: true }).decode(selection.stdout),
    stderr: selection.stderr,
  }, context);
  const [selected] = entries;
  if (entries.length !== 1 || selected.path !== entry.path || selected.type !== 'file'
    || selected.size !== entry.size || selected.crc32 !== entry.crc32) {
    throw decoderError('EXTRACTION_FAILED', 'The archive member could not be selected unambiguously by the decoder.');
  }
}

function verifyExtraction(message, entry, context) {
  if (typeof message.stderr !== 'string') throw decoderError('PROTOCOL_ERROR', 'The decoder returned an invalid result.');
  verifySelection(message.selection, entry, context);
  if (message.exitCode !== 0 || message.stderr.trim() !== '') {
    const diagnosed = classifyDecoderDiagnostics(message.stderr);
    throw decoderError(diagnosed?.[0] ?? 'EXTRACTION_FAILED', diagnosed?.[1] ?? 'The archive member could not be decoded.');
  }
  if (!(message.output instanceof Uint8Array) || message.length !== entry.size || message.output.length !== entry.size) {
    throw decoderError('EXTRACTION_FAILED', 'The decoded member size did not match the archive.');
  }
  if (entry.crc32 !== null && crc32(message.output) !== entry.crc32) {
    throw decoderError('EXTRACTION_FAILED', 'The decoded member failed its CRC check.');
  }
  return Buffer.from(message.output.buffer, message.output.byteOffset, message.output.length);
}

// The member a job extracts: a fixed path, or a parent-side choice made from this job's own
// validated listing (so a catalog position maps to a member of exactly the bytes being decoded).
// The choice is an ordinary member path and then goes through the same selection checks.
function chooseMember(memberPath, listing, validation) {
  if (typeof memberPath !== 'function') return memberPath;
  const chosen = memberPath(
    Object.freeze({ solid: listing.solid, entries: Object.freeze(toResultEntries(listing.entries)) }),
    validation.checkpoint,
  );
  assertSafeMemberPath(chosen, validation.maxPathLength);
  return chosen;
}

// ─── Batch extraction ─────────────────────────────────────────────────────────────────────
//
// The batch choice comes from the job's own validated listing, like chooseMember. Each chosen
// path must name a distinct listed file within maxMemberBytes; the members are put in archive
// order and split into runs whose argument vectors fit BATCH_ARGV_BYTES. Worker member
// indexes refer to that archive-ordered list; results are reported in the caller's order.
function planBatch(listing, batch, limits, validation) {
  const paths = batch.select(
    Object.freeze({ solid: listing.solid, entries: Object.freeze(toResultEntries(listing.entries)) }),
    validation.checkpoint,
  );
  if (!Array.isArray(paths) || paths.length === 0) throw decoderError('INVALID_ARGUMENT', 'A batch needs at least one member.');
  if (paths.length > batch.maxMembers) throw decoderError('BATCH_LIMIT_EXCEEDED', 'The batch selects more members than allowed.');
  const byPath = new Map();
  for (const candidate of listing.entries) byPath.set(candidate.path, candidate);
  const chosen = new Set();
  let total = 0;
  const items = paths.map((path, index) => {
    validation.checkpoint();
    assertSafeMemberPath(path, validation.maxPathLength);
    if (chosen.has(path)) throw decoderError('INVALID_ARGUMENT', 'A batch selects the same member twice.');
    chosen.add(path);
    const selected = byPath.get(path);
    if (!selected || selected.type !== 'file') throw decoderError('MEMBER_NOT_FOUND', 'The archive has no such file member.');
    if (selected.size > limits.maxMemberBytes) throw decoderError('MEMBER_LIMIT_EXCEEDED', 'The archive member is larger than allowed.');
    total += selected.size;
    return { index, entry: Object.freeze({ ...selected }), run: -1, offset: null, length: null };
  });
  if (total > batch.maxBytes) throw decoderError('BATCH_LIMIT_EXCEEDED', 'The batch selects more data than allowed.');

  const flat = [...items].sort((a, b) => a.entry.index - b.entry.index);
  const runs = [];
  const budget = BATCH_ARGV_BYTES - BATCH_FIXED_ARGV_RESERVE;
  let current = [];
  let used = 0;
  for (const item of flat) {
    const cost = argvStringBytes(item.entry.path) + ARGV_POINTER_BYTES;
    if (current.length > 0 && used + cost > budget) {
      runs.push(current);
      current = [];
      used = 0;
    }
    item.run = runs.length;
    current.push(item);
    used += cost;
  }
  runs.push(current);
  return { items, flat, runs, verified: 0, done: 0, offset: 0, clean: true, diagnostics: [] };
}

function batchProtocolError() {
  return decoderError('PROTOCOL_ERROR', 'The decoder sent an unexpected batch message.');
}

// The worker lists each run with the exact selectors it will extract with; the listing must
// show exactly the run's members, or nothing of the run is extracted.
function verifyBatchSelection(message, plan, context) {
  if (message.run !== plan.verified || plan.verified !== plan.done
    || !(message.stdout instanceof Uint8Array) || typeof message.stderr !== 'string') throw batchProtocolError();
  const { entries } = interpretListing({
    exitCode: message.exitCode,
    stdout: new TextDecoder('utf-8', { fatal: true }).decode(message.stdout),
    stderr: message.stderr,
  }, context);
  const run = plan.runs[message.run];
  const expected = new Map(run.map((item) => [item.entry.path, item.entry]));
  for (const selected of entries) {
    const wanted = expected.get(selected.path);
    if (!wanted || selected.type !== 'file' || selected.size !== wanted.size || selected.crc32 !== wanted.crc32) {
      throw decoderError('EXTRACTION_FAILED', 'The archive members could not be selected unambiguously by the decoder.');
    }
    expected.delete(selected.path);
  }
  if (expected.size !== 0 || entries.length !== run.length) {
    throw decoderError('EXTRACTION_FAILED', 'The archive members could not be selected unambiguously by the decoder.');
  }
  plan.verified += 1;
}

// Offsets are tracked here, not taken from the worker: members must arrive once each, from
// the run being extracted, contiguously, and no longer than their declared sizes.
function acceptBatchMember(message, plan, batch) {
  const item = Number.isSafeInteger(message.index) ? plan.flat[message.index] : undefined;
  if (plan.verified !== plan.done + 1 || !item || item.run !== plan.done || item.length !== null
    || message.offset !== plan.offset || !Number.isSafeInteger(message.length)
    || message.length < 0 || message.length > item.entry.size) throw batchProtocolError();
  item.offset = plan.offset;
  item.length = message.length;
  plan.offset += message.length;
  batch.onMember?.(Object.freeze({ index: item.index, entry: item.entry, offset: item.offset, length: item.length }));
}

// Returns the outcome after the last run. complete: every run exited 0 with no diagnostics and
// every member was produced at its declared size. Otherwise archive-level diagnostics fail the
// job, and the caller may keep only members it can verify itself (see extractOpenedArchiveBatch).
function acceptBatchRun(message, plan) {
  if (message.run !== plan.done || plan.verified !== plan.done + 1
    || typeof message.stderr !== 'string' || !Number.isSafeInteger(message.stdoutLength)) throw batchProtocolError();
  if (message.exitCode !== 0 || message.stderr.trim() !== '' || message.stdoutLength !== 0) {
    plan.clean = false;
    plan.diagnostics.push(message.stderr);
  }
  plan.done += 1;
  if (plan.done < plan.runs.length) return null;
  if (!plan.clean) {
    const diagnosed = classifyDecoderDiagnostics(plan.diagnostics.join('\n'));
    if (diagnosed) throw decoderError(...diagnosed);
  } else if (plan.items.some((item) => item.length !== item.entry.size)) {
    throw decoderError('EXTRACTION_FAILED', 'The decoder did not produce every selected member.');
  }
  return {
    complete: plan.clean,
    bytes: plan.offset,
    members: Object.freeze(plan.items.map((item) => Object.freeze({
      index: item.index, entry: item.entry, offset: item.offset, length: item.length,
    }))),
  };
}

// Drives one worker through list (and optionally extract). Exported for protocol tests;
// production callers use listArchiveEntries/extractArchiveMember and their opened-file variants.
// memberPath is a path, or select(listing, checkpoint) returning one (it may throw an
// ArchiveDecoderError to end the job). deadline is a performance.now() time; it defaults to
// timeoutMs from now.
export function runDecoderJob(worker, {
  context, memberPath, batch, limits, signal, deadline = performance.now() + limits.timeoutMs,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let listing = null;
    let entry = null;
    let plan = null;
    // The timer cannot fire while validation runs synchronously, so validation also checks the
    // deadline itself and no outcome is accepted once it has passed.
    const timer = setTimeout(
      () => finish(decoderError('TIMEOUT', 'Archive decoding timed out.')),
      Math.max(0, deadline - performance.now()),
    );
    const onAbort = () => finish(decoderError('CANCELLED', 'Archive decoding was cancelled.'));
    const interruption = () => {
      if (signal?.aborted) return decoderError('CANCELLED', 'Archive decoding was cancelled.');
      if (performance.now() >= deadline) return decoderError('TIMEOUT', 'Archive decoding timed out.');
      return null;
    };
    const checkpoint = () => {
      const error = interruption();
      if (error) throw error;
    };
    const validation = { ...context, checkpoint };

    function finish(error, value) {
      if (settled) return;
      const late = interruption();
      if (late) error = late;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // The 'error' listener stays attached (and inert) so a late worker error cannot become
      // an unhandled 'error' event before the caller terminates the worker.
      worker.off('message', onMessage);
      worker.off('exit', onExit);
      worker.off('messageerror', onMessageError);
      if (error) reject(error);
      else resolve(value);
    }

    function onMessage(message) {
      if (settled) return;
      try {
        if (message?.type === 'failed') {
          const code = WORKER_CODES.has(message.code) ? message.code : 'DECODER_FAILED';
          finish(decoderError(code, typeof message.message === 'string' ? message.message : 'Archive decoding failed.'));
        } else if (message?.type === 'listed' && listing === null) {
          if (!(message.stdout instanceof Uint8Array) || typeof message.stderr !== 'string') {
            throw decoderError('PROTOCOL_ERROR', 'The decoder returned an invalid listing.');
          }
          listing = interpretListing({
            exitCode: message.exitCode,
            stdout: new TextDecoder('utf-8', { fatal: true }).decode(message.stdout),
            stderr: message.stderr,
          }, validation);
          if (batch) {
            plan = planBatch(listing, batch, limits, validation);
            worker.postMessage({
              type: 'extractBatch',
              runs: plan.runs.map((run) => run.map((item) => ({ path: item.entry.path, size: item.entry.size }))),
            });
            return;
          }
          if (memberPath === undefined) {
            finish(null, { listing });
            return;
          }
          entry = selectMember(listing, chooseMember(memberPath, listing, validation), limits);
          worker.postMessage({ type: 'extract', member: entry.path, size: entry.size });
        } else if (message?.type === 'extracted' && entry !== null) {
          finish(null, { listing, entry, data: verifyExtraction(message, entry, validation) });
        } else if (plan !== null && message?.type === 'selected') {
          verifyBatchSelection(message, plan, validation);
          worker.postMessage({ type: 'proceed', run: message.run });
        } else if (plan !== null && message?.type === 'member') {
          acceptBatchMember(message, plan, batch);
        } else if (plan !== null && message?.type === 'ran') {
          const outcome = acceptBatchRun(message, plan);
          if (outcome) finish(null, { listing, ...outcome });
        } else {
          throw decoderError('PROTOCOL_ERROR', 'The decoder sent an unexpected message.');
        }
      } catch (error) {
        finish(error instanceof ArchiveDecoderError
          ? error
          : decoderError('ARCHIVE_CORRUPT', 'The decoder output was invalid.', error));
      }
    }

    function onError(error) {
      const code = error?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'MEMORY_LIMIT_EXCEEDED' : 'DECODER_FAILED';
      finish(decoderError(code, 'The decoder worker failed.', error));
    }

    function onExit(code) {
      finish(decoderError('DECODER_FAILED', 'The decoder worker exited unexpectedly (' + code + ').'));
    }

    function onMessageError(error) {
      finish(decoderError('PROTOCOL_ERROR', 'The decoder sent an unreadable message.', error));
    }

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    worker.on('messageerror', onMessageError);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function prepare(memberPath, options = {}) {
  const { format, signal, limits: overrides } = options;
  if (format !== 'rar' && format !== '7z') throw decoderError('INVALID_ARGUMENT', 'format must be "rar" or "7z".');
  const limits = resolveDecoderLimits(overrides);
  // timeoutMs covers the whole call, including runtime load and opening the input.
  const deadline = performance.now() + limits.timeoutMs;
  if (memberPath !== undefined && typeof memberPath !== 'function') {
    assertSafeMemberPath(memberPath, limits.maxPathLength);
  }
  if (signal?.aborted) throw decoderError('CANCELLED', 'Archive decoding was cancelled.');
  return { format, signal, limits, deadline };
}

async function decode(archivePath, memberPath, options = {}) {
  if (typeof archivePath !== 'string' || archivePath.length === 0) {
    throw decoderError('INVALID_ARGUMENT', 'An archive path is required.');
  }
  const job = prepare(memberPath, options);
  const { wasmModule } = await loadRuntime();
  let handle;
  try {
    handle = await open(archivePath, 'r');
  } catch (cause) {
    throw decoderError('INPUT_UNAVAILABLE', 'The archive could not be opened.', cause);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw decoderError('INPUT_UNAVAILABLE', 'The archive is not a regular file.');
    return await decodeDescriptor(handle.fd, stat.size, memberPath, job, wasmModule);
  } finally {
    // decodeDescriptor returns only after its worker has fully stopped reading the descriptor.
    await handle.close().catch(() => {});
  }
}

// Accepts the { handle, stat } shape returned by openAssetFile/openAssetFileAsync. The caller
// keeps ownership of the descriptor and may close it once the returned promise settles. The
// descriptor is re-checked with fstat: it must still be a regular file with the size (and,
// when the caller's stat carries them, the inode and mtime) the caller opened and authorized.
function openedDescriptor(openFile) {
  const handle = openFile?.handle;
  const fd = typeof handle === 'number' ? handle : handle?.fd;
  const expected = openFile?.stat;
  if (!Number.isInteger(fd) || fd < 0 || !Number.isSafeInteger(expected?.size) || expected.size < 0) {
    throw decoderError('INVALID_ARGUMENT', 'An opened regular archive file is required.');
  }
  return { fd, expected };
}

async function checkOpenedSource(fd, expected) {
  let stat;
  try {
    stat = await fstatOf(fd);
  } catch (cause) {
    throw decoderError('INPUT_UNAVAILABLE', 'The archive could not be opened.', cause);
  }
  if (!stat.isFile()) throw decoderError('INPUT_UNAVAILABLE', 'The archive is not a regular file.');
  const same = (key) => typeof expected[key] !== 'number' || expected[key] === stat[key];
  if (stat.size !== expected.size || !same('ino') || !same('dev') || !same('mtimeMs')) {
    throw decoderError('INPUT_CHANGED', 'The archive changed after it was opened.');
  }
  return stat;
}

async function decodeOpened(openFile, memberPath, options = {}, batch = null) {
  const { fd, expected } = openedDescriptor(openFile);
  const job = prepare(memberPath, options);
  const { wasmModule } = await loadRuntime();
  const stat = await checkOpenedSource(fd, expected);
  return decodeDescriptor(fd, stat.size, memberPath, job, wasmModule, batch);
}

async function decodeDescriptor(fd, size, memberPath, { format, signal, limits, deadline }, wasmModule, batch = null) {
  let worker = null;
  try {
    if (size > limits.maxInputBytes) throw decoderError('INPUT_LIMIT_EXCEEDED', 'The archive is larger than allowed.');
    const signature = await detectArchiveType(fd, size, format);
    if (signal?.aborted) throw decoderError('CANCELLED', 'Archive decoding was cancelled.');
    if (performance.now() >= deadline) throw decoderError('TIMEOUT', 'Archive decoding timed out.');

    worker = new Worker(WORKER_URL, {
      workerData: {
        gluePath: GLUE_PATH,
        wasmModule,
        fd,
        inputSize: size,
        archiveType: signature.type,
        limits: {
          maxMemoryBytes: limits.maxMemoryBytes,
          maxMemberBytes: limits.maxMemberBytes,
          maxListingBytes: limits.maxListingBytes,
          maxLogBytes: limits.maxLogBytes,
        },
        // Only batch workers receive an output descriptor (see the worker's batch section).
        ...(batch ? {
          outputFd: batch.outputFd,
          batchLimits: { maxMembers: batch.maxMembers, maxBytes: batch.maxBytes, maxArgvBytes: BATCH_ARGV_BYTES },
        } : {}),
      },
      resourceLimits: WORKER_RESOURCE_LIMITS,
      env: {},
      argv: [],
      execArgv: [],
    });
    const result = await runDecoderJob(worker, {
      context: {
        expectedType: signature.type,
        inputSize: size,
        maxEntries: limits.maxEntries,
        maxPathLength: limits.maxPathLength,
      },
      memberPath,
      batch,
      limits,
      signal,
      deadline,
    });
    return { ...result, format: signature.format };
  } finally {
    // Settles only after the worker that reads the descriptor has fully stopped, so the
    // descriptor can be closed (by decode or by the caller) as soon as this returns.
    if (worker) await worker.terminate().catch(() => {});
  }
}

/**
 * Lists a RAR (4/5) or 7z archive.
 * @param {string} archivePath
 * @param {{ format: 'rar'|'7z', signal?: AbortSignal, limits?: Partial<typeof DEFAULT_DECODER_LIMITS> }} options
 * @returns {Promise<{ format: 'rar4'|'rar5'|'7z', solid: boolean, entries: ReadonlyArray<object> }>}
 *   entries keep archive order: { index, path, type: 'file'|'directory'|'unsupported', size,
 *   packedSize, crc32, modified }. Only 'file' entries can be extracted.
 */
export async function listArchiveEntries(archivePath, options) {
  const { format, listing } = await decode(archivePath, undefined, options);
  return Object.freeze({ format, solid: listing.solid, entries: Object.freeze(toResultEntries(listing.entries)) });
}

/**
 * Extracts exactly one listed file member, re-validating the archive in the same job.
 * @returns {Promise<{ format: string, entry: object, data: Buffer }>}
 */
export async function extractArchiveMember(archivePath, memberPath, options) {
  if (memberPath === undefined || typeof memberPath === 'function') {
    throw decoderError('INVALID_ARGUMENT', 'A member path is required.');
  }
  const { format, entry, data } = await decode(archivePath, memberPath, options);
  return { format, entry: Object.freeze({ ...entry }), data };
}

/**
 * listArchiveEntries for an archive the caller already opened through the secure asset-file
 * path ({ handle, stat } from openAssetFile/openAssetFileAsync). The caller owns and closes
 * the descriptor after the promise settles. Fails with INPUT_CHANGED when the descriptor no
 * longer matches the caller's stat.
 */
export async function listOpenedArchive(openFile, options) {
  const { format, listing } = await decodeOpened(openFile, undefined, options);
  return Object.freeze({ format, solid: listing.solid, entries: Object.freeze(toResultEntries(listing.entries)) });
}

/**
 * extractArchiveMember for an opened archive. `select` is a member path, or a function
 * select({ solid, entries }, checkpoint) that picks the member from this job's own validated
 * listing and returns its path (or throws an ArchiveDecoderError). Listing, choice, selection
 * proof and extraction all happen in one worker on the same descriptor.
 * @returns {Promise<{ format: string, solid: boolean, entry: object, data: Buffer }>}
 */
export async function extractOpenedArchiveMember(openFile, select, options) {
  if (select === undefined) throw decoderError('INVALID_ARGUMENT', 'A member path is required.');
  const { format, listing, entry, data } = await decodeOpened(openFile, select, options);
  return { format, solid: listing.solid, entry: Object.freeze({ ...entry }), data };
}

/**
 * Re-checks an opened archive against the caller's stat (regular file, size, and inode/device/
 * mtime when the stat carries them), as every opened-file decode does on entry. Use it before
 * publishing results derived from the archive. Fails with INPUT_CHANGED or INPUT_UNAVAILABLE.
 */
export async function assertOpenedArchiveUnchanged(openFile) {
  const { fd, expected } = openedDescriptor(openFile);
  await checkOpenedSource(fd, expected);
}

/**
 * Extracts several listed file members of an opened archive in one worker, writing them to a
 * caller-owned output descriptor. Used for solid-archive preparation: 7-Zip decodes each
 * solid stream once per run instead of once per member.
 *
 * batch.select({ solid, entries }, checkpoint) chooses member paths from this job's own
 * validated listing (or throws an ArchiveDecoderError). The members are extracted in archive
 * order; each run is first listed with its exact selectors and must select exactly its members.
 * Member bytes are written contiguously to batch.outputFd (opened for writing by the caller,
 * initially empty) starting at offset 0, never past a member's declared size; nothing else is
 * written there. batch.onMember({ index, entry, offset, length }) is called as each member is
 * closed, index referring to the select() order; it must not throw unless the job should fail.
 *
 * Resolves only after the worker has stopped (the output descriptor is no longer written):
 *   { format, solid, complete, bytes, members: [{ index, entry, offset, length } with
 *     offset/length null for members never produced] }
 * complete is true only when every run exited cleanly and every member has its declared size.
 * When false, the decoder reported member-level failures: produced bytes are not vouched for
 * by 7-Zip, and the caller must verify any member it keeps itself (size and CRC32). Limits,
 * protocol violations, archive-level diagnostics, timeout and cancellation reject instead;
 * the caller must then discard everything written to the output descriptor.
 *
 * @param {{ handle: number|import('node:fs/promises').FileHandle, stat: import('node:fs').Stats }} openFile
 * @param {{ select: Function, outputFd: number, maxMembers: number, maxBytes: number, onMember?: Function }} batch
 */
export async function extractOpenedArchiveBatch(openFile, batch, options) {
  if (typeof batch?.select !== 'function' || !Number.isInteger(batch.outputFd) || batch.outputFd < 0
    || !Number.isSafeInteger(batch.maxMembers) || batch.maxMembers < 1
    || !Number.isSafeInteger(batch.maxBytes) || batch.maxBytes < 1
    || (batch.onMember !== undefined && typeof batch.onMember !== 'function')) {
    throw decoderError('INVALID_ARGUMENT', 'A valid batch is required.');
  }
  const { fd } = openedDescriptor(openFile);
  if (batch.outputFd === fd) throw decoderError('INVALID_ARGUMENT', 'The output descriptor must differ from the archive.');
  let output;
  try {
    output = await fstatOf(batch.outputFd);
  } catch (cause) {
    throw decoderError('INVALID_ARGUMENT', 'The output descriptor is not usable.', cause);
  }
  if (!output.isFile() || output.size !== 0) throw decoderError('INVALID_ARGUMENT', 'The output must be an empty regular file.');
  const { format, listing, complete, bytes, members } = await decodeOpened(openFile, undefined, options, {
    select: batch.select,
    onMember: batch.onMember,
    outputFd: batch.outputFd,
    maxMembers: batch.maxMembers,
    maxBytes: batch.maxBytes,
  });
  return { format, solid: listing.solid, complete, bytes, members };
}
